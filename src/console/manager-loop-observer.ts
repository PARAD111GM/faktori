import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { projectLoopDelivery, readDeliveryRecord, type LoopDeliverySummary } from '../loop/delivery.ts';
import { summarizeOutcomeCohorts, summarizeUsage } from '../runtime/usage-accounting.mjs';

export interface ManagerLoopReferences {
  ticket?: string;
  feature?: string;
  candidate?: string;
  pullRequest?: string;
  pullRequestMerged?: boolean;
  deploymentAccepted?: boolean;
  shared?: boolean;
  workInProgress?: boolean;
}

export interface ManagerLoopSource {
  id: string;
  artifactsDirectory: string;
  productId?: string;
  podId?: string;
  /** Owner-registered JSONL only; the observer never scans adjacent files. */
  usageExportPath?: string;
  references?: ManagerLoopReferences;
  /** Internal root seal installed by the persisted registry; never projected. */
  observationRoot?: string;
}

export type ManagerLoopStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'interrupted_uncertain' | 'unavailable';

export interface ManagerLoopStageSummary {
  phaseId: string;
  kind: 'manager_brief' | 'implement' | 'repair' | 'review' | 'manager_accept';
  round: number;
  outcome: string;
  completedAt: string;
  decision?: 'ready' | 'implemented' | 'blocked' | 'pass' | 'repair' | 'accepted' | 'rejected';
  verification?: 'passed' | 'failed';
  usage: { availability: 'reported' | 'partially_reported' | 'unavailable'; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningTokens?: number };
}

export interface ManagerLoopSummary {
  id: string;
  productId?: string;
  podId?: string;
  status: ManagerLoopStatus;
  stale: boolean;
  updatedAt?: string;
  completedPhases: string[];
  currentStage?: { phaseId: string; kind: ManagerLoopStageSummary['kind']; round: number };
  stages: ManagerLoopStageSummary[];
  reason?: string;
  delivery?: LoopDeliverySummary;
  usage?: ReturnType<typeof summarizeUsage>['actual'] & { unknownMeasurements: number };
  outcomes?: ReturnType<typeof summarizeOutcomeCohorts>;
}

export interface ManagerLoopObserverOptions {
  sources: readonly ManagerLoopSource[];
  pollIntervalMs?: number;
  staleAfterMs?: number;
  now?: () => Date;
}

type Listener = () => void;
type RecordValue = Record<string, unknown>;

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_USAGE_EXPORT_BYTES = 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const STAGE_KINDS = new Set<ManagerLoopStageSummary['kind']>(['manager_brief', 'implement', 'repair', 'review', 'manager_accept']);
const STATUSES = new Set<Exclude<ManagerLoopStatus, 'unavailable'>>(['running', 'succeeded', 'failed', 'blocked', 'interrupted_uncertain']);
const OUTCOMES = new Set(['completed', 'unchanged_verified', 'denied', 'authentication_required', 'quota_exhausted', 'failed', 'cancelled', 'interrupted_uncertain', 'unavailable']);
const REASON_CODES = [
  'stage_receipt_missing_manual_reconciliation_required', 'repair_session_unavailable',
  'provider_response_invalid', 'provider_response_schema_invalid', 'provider_response_missing',
  'provider_response_not_strict_json', 'provider_response_must_be_object',
  'provider_denied', 'provider_authentication_required', 'provider_quota_exhausted',
  'provider_failed', 'provider_cancelled', 'provider_interrupted_uncertain', 'provider_unavailable',
  'read_only_role_changed_workspace', 'manager_brief_blocked', 'implementer_blocked',
  'configured_verification_failed', 'repair_blocked', 'review_evidence_mismatch',
  'invalid_review_verdict', 'repair_limit_exceeded', 'review_not_passed',
  'manager_acceptance_invalid',
] as const;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && ID.test(value) ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function reasonCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return REASON_CODES.find((code) => value === code || value.endsWith(`:${code}`) || value.startsWith(`${code}:`));
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function references(value: unknown): ManagerLoopReferences | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  const output: ManagerLoopReferences = {};
  for (const key of ['ticket', 'feature', 'candidate', 'pullRequest'] as const) {
    if (typeof input[key] === 'string' && ID.test(input[key] as string)) output[key] = input[key] as string;
  }
  for (const key of ['pullRequestMerged', 'deploymentAccepted', 'shared', 'workInProgress'] as const) if (typeof input[key] === 'boolean') output[key] = input[key] as boolean;
  return Object.keys(output).length === 0 ? undefined : output;
}

function usage(value: unknown): ManagerLoopStageSummary['usage'] {
  const input = record(value);
  const availability = input?.availability;
  if (availability !== 'reported' && availability !== 'partially_reported') return { availability: 'unavailable' };
  const output: ManagerLoopStageSummary['usage'] = { availability };
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'] as const) {
    const measured = nonNegative(input?.[key]);
    if (measured !== undefined) output[key] = measured;
  }
  return output;
}

function measuredCounters(value: RecordValue): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const key of ['input', 'output', 'cached', 'reasoning', 'total']) {
    const measured = nonNegative(value[key]);
    if (measured !== undefined) counters[key] = measured;
  }
  return counters;
}

function unavailable(source: ManagerLoopSource, reason: string, updatedAt?: string): ManagerLoopSummary {
  return {
    id: source.id,
    ...(source.productId === undefined ? {} : { productId: source.productId }),
    ...(source.podId === undefined ? {} : { podId: source.podId }),
    status: 'unavailable',
    stale: true,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    completedPhases: [],
    stages: [],
    reason,
  };
}

function stage(value: unknown): ManagerLoopStageSummary | undefined {
  const input = record(value);
  const phaseId = identifier(input?.phaseId);
  const kind = input?.kind;
  const round = input?.round;
  const outcome = input?.outcome;
  const completedAt = timestamp(input?.completedAt);
  if (phaseId === undefined || typeof kind !== 'string' || !STAGE_KINDS.has(kind as ManagerLoopStageSummary['kind'])
    || !Number.isInteger(round) || Number(round) < 0 || typeof outcome !== 'string' || !OUTCOMES.has(outcome) || completedAt === undefined) return undefined;
  const response = record(input?.response);
  let decision: ManagerLoopStageSummary['decision'];
  if (kind === 'manager_brief' && (response?.status === 'ready' || response?.status === 'blocked')) decision = response.status;
  else if ((kind === 'implement' || kind === 'repair') && (response?.status === 'implemented' || response?.status === 'blocked')) decision = response.status;
  else if (kind === 'review' && (response?.verdict === 'pass' || response?.verdict === 'repair')) decision = response.verdict;
  else if (kind === 'manager_accept' && typeof response?.accepted === 'boolean') decision = response.accepted ? 'accepted' : 'rejected';
  const verification = Array.isArray(input?.verification) && input.verification.length > 0
    && input.verification.every((item) => typeof record(item)?.passed === 'boolean')
    ? input.verification.every((item) => record(item)?.passed === true) ? 'passed' : 'failed'
    : undefined;
  return {
    phaseId,
    kind: kind as ManagerLoopStageSummary['kind'],
    round: Number(round),
    outcome,
    completedAt,
    ...(decision === undefined ? {} : { decision }),
    ...(verification === undefined ? {} : { verification }),
    usage: usage(input?.usage),
  };
}

function stageUsageRecords(source: ManagerLoopSource, rawStages: unknown[], current?: RecordValue): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const raw of rawStages) {
    const input = record(raw);
    const stageId = identifier(input?.stageId);
    const phaseId = identifier(input?.phaseId);
    const completedAt = timestamp(input?.completedAt);
    if (stageId === undefined || phaseId === undefined || completedAt === undefined) continue;
    const telemetry = usage(input?.usage);
    const counters = telemetry.availability === 'unavailable' ? undefined : {
      ...(telemetry.inputTokens === undefined ? {} : { input: telemetry.inputTokens }),
      ...(telemetry.cachedInputTokens === undefined ? {} : { cached: telemetry.cachedInputTokens }),
      ...(telemetry.outputTokens === undefined ? {} : { output: telemetry.outputTokens }),
      ...(telemetry.reasoningTokens === undefined ? {} : { reasoning: telemetry.reasoningTokens }),
      // Provider adapters expose categories rather than an independent billable
      // total; total is known only when input and output are both reported.
      ...(telemetry.inputTokens === undefined || telemetry.outputTokens === undefined ? {} : { total: telemetry.inputTokens + telemetry.outputTokens }),
    };
    result.push({
      phase: phaseId, ticket: source.references?.ticket ?? 'unknown', source: `loop:${source.id}`,
      agentId: `${source.id}:${stageId}`, sessionId: typeof input?.sessionId === 'string' ? input.sessionId : stageId,
      registeredSessionId: `${source.id}:${typeof input?.sessionId === 'string' ? input.sessionId : stageId}`,
      at: completedAt, cumulative: true, coverageScope: 'exclusive', responseId: stageId,
      ...(counters === undefined ? { telemetry: 'unknown' } : { counters }),
      ...(source.references === undefined ? {} : { references: source.references }),
      ...(typeof input?.outcome === 'string' ? { attemptOutcome: input.outcome } : {}),
    });
  }
  const currentStageId = identifier(current?.stageId);
  const currentPhaseId = identifier(current?.phaseId);
  if (currentStageId !== undefined && currentPhaseId !== undefined) {
    // A current stage is a registered participating session with unknown
    // telemetry until it emits a terminal receipt. Counting it keeps coverage
    // truthful without inventing in-flight usage.
    result.push({
      phase: currentPhaseId, ticket: source.references?.ticket ?? 'unknown', source: `loop:${source.id}`,
      agentId: `${source.id}:${currentStageId}`, sessionId: currentStageId, registeredSessionId: `${source.id}:${currentStageId}`,
      at: timestamp(current?.intendedAt) ?? new Date(0).toISOString(), cumulative: true, telemetry: 'unknown', attemptOutcome: 'running',
      ...(source.references === undefined ? {} : { references: source.references }),
    });
  }
  return result;
}

function observedOutcomeSource(source: ManagerLoopSource, delivery: LoopDeliverySummary | undefined): ManagerLoopSource {
  const references = source.references;
  if (references === undefined || delivery === undefined) return source;
  const gates = new Map(delivery.gates.map((gate) => [gate.id, gate.status]));
  const { pullRequestMerged: _requestedMerge, deploymentAccepted: _requestedAcceptance, ...base } = references;
  return {
    ...source,
    references: {
      ...base,
      ...(references.pullRequest !== undefined && gates.get('merge') === 'passed' ? { pullRequestMerged: true } : {}),
      // A deployment receipt alone is not product acceptance. Both the
      // deployment and staging-verification receipts must be independently
      // observed before a feature enters this denominator.
      ...(references.feature !== undefined && gates.get('deployment') === 'passed' && gates.get('staging_verification') === 'passed' ? { deploymentAccepted: true } : {}),
    },
  };
}

function projection(source: ManagerLoopSource, value: unknown, modifiedAtMs: number, nowMs: number, staleAfterMs: number, externalRecords: Record<string, unknown>[] = [], delivery?: LoopDeliverySummary): ManagerLoopSummary | undefined {
  const input = record(value);
  const status = input?.status;
  const updatedAt = timestamp(input?.updatedAt);
  const completedPhases = input?.completedPhases;
  const rawStages = input?.stages;
  if (input?.format !== 'faktori.manager-loop-state/v1' || input.loopId !== source.id || typeof status !== 'string'
    || !STATUSES.has(status as Exclude<ManagerLoopStatus, 'unavailable'>) || updatedAt === undefined
    || !Array.isArray(completedPhases) || completedPhases.some((item) => identifier(item) === undefined)
    || !Array.isArray(rawStages)) return undefined;
  const stages = rawStages.map(stage);
  if (stages.some((item) => item === undefined)) return undefined;
  const current = input.currentStage === undefined ? undefined : record(input.currentStage);
  if (input.currentStage !== undefined && current === undefined) return undefined;
  const currentPhaseId = identifier(current?.phaseId);
  const currentKind = current?.kind;
  const currentRound = current?.round;
  if (current !== undefined && (currentPhaseId === undefined || typeof currentKind !== 'string'
    || !STAGE_KINDS.has(currentKind as ManagerLoopStageSummary['kind']) || !Number.isInteger(currentRound) || Number(currentRound) < 0)) return undefined;
  const reason = reasonCode(input.reason);
  const observedSource = observedOutcomeSource(source, delivery);
  const outcomeSource: ManagerLoopSource = status === 'running'
    ? { ...observedSource, references: { ...(observedSource.references ?? {}), workInProgress: true } }
    : observedSource;
  const usageRecords = [
    ...stageUsageRecords(outcomeSource, rawStages, current),
    ...externalRecords.map((entry) => ({ ...entry, ...(outcomeSource.references === undefined ? {} : { references: outcomeSource.references }) })),
  ];
  const normalizedUsage = summarizeUsage(usageRecords, 0);
  return {
    id: source.id,
    ...(source.productId === undefined ? {} : { productId: source.productId }),
    ...(source.podId === undefined ? {} : { podId: source.podId }),
    status: status as Exclude<ManagerLoopStatus, 'unavailable'>,
    // A persisted `running` value is recorded activity, not a process-liveness claim.
    stale: status === 'running' && nowMs - modifiedAtMs > staleAfterMs,
    updatedAt,
    completedPhases: [...new Set(completedPhases as string[])],
    ...(current === undefined ? {} : { currentStage: { phaseId: currentPhaseId as string, kind: currentKind as ManagerLoopStageSummary['kind'], round: Number(currentRound) } }),
    stages: stages as ManagerLoopStageSummary[],
    usage: { ...normalizedUsage.actual, unknownMeasurements: normalizedUsage.unknown.length },
    outcomes: summarizeOutcomeCohorts(usageRecords),
    ...(delivery === undefined ? {} : { delivery }),
    ...(reason === undefined ? {} : { reason }),
  };
}

async function externalUsageRecords(source: ManagerLoopSource): Promise<Record<string, unknown>[]> {
  if (source.usageExportPath === undefined) return [];
  let handle;
  try {
    if (source.observationRoot !== undefined) {
      const details = await lstat(source.usageExportPath);
      if (!details.isFile() || !inside(source.observationRoot, await realpath(source.usageExportPath))) throw new Error('usage_export_outside_allowlisted_root');
    }
    handle = await open(source.usageExportPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_USAGE_EXPORT_BYTES) throw new Error('usage_export_invalid');
    const raw = (await handle.readFile({ encoding: 'utf8' })).split(/\r?\n/).filter(Boolean);
    return raw.map((line, index) => {
      let entry: RecordValue | undefined;
      try { entry = record(JSON.parse(line) as unknown); } catch { entry = undefined; }
      if (entry === undefined) return { ticket: source.references?.ticket ?? 'unknown', source: `external:${source.id}`, agentId: `${source.id}:invalid-${index}`, sessionId: `invalid-${index}`, registeredSessionId: `${source.id}:invalid-${index}`, telemetry: 'unknown', references: source.references };
      const counters = record(entry.counters);
      return {
        phase: typeof entry.phase === 'string' ? entry.phase : undefined, ticket: typeof entry.ticket === 'string' ? entry.ticket : source.references?.ticket ?? 'unknown',
        source: `external:${source.id}:${typeof entry.source === 'string' && ID.test(entry.source) ? entry.source : 'registered'}`,
        agentId: typeof entry.agentId === 'string' ? entry.agentId : `${source.id}:external-${index}`,
        sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : `${source.id}:external-${index}`,
        registeredSessionId: `${source.id}:${typeof entry.sessionId === 'string' ? entry.sessionId : `external-${index}`}`,
        at: timestamp(entry.at) ?? new Date(0).toISOString(), cumulative: entry.cumulative === true,
        ...(typeof entry.responseId === 'string' ? { responseId: entry.responseId } : typeof entry.responseIdentity === 'string' ? { responseIdentity: entry.responseIdentity } : {}),
        ...(entry.telemetry === 'unknown' ? { telemetry: 'unknown' } : {}),
        ...(counters === undefined ? {} : { counters: measuredCounters(counters) }),
        ...(entry.childScope === 'inclusive' || entry.childScope === 'exclusive' || entry.childScope === 'unknown' ? { childScope: entry.childScope } : {}),
        ...(entry.coverageScope === 'exclusive' || entry.coverageScope === 'unknown' ? { coverageScope: entry.coverageScope } : {}),
        ...(typeof entry.coverageGroup === 'string' ? { coverageGroup: entry.coverageGroup } : {}),
        ...(typeof entry.parentAgentId === 'string' ? { parentAgentId: entry.parentAgentId } : {}),
        ...(entry.phaseAttribution === 'unknown' ? { phaseAttribution: 'unknown' } : {}),
        ...(source.references === undefined ? {} : { references: source.references }),
        ...(typeof entry.attemptOutcome === 'string' ? { attemptOutcome: entry.attemptOutcome } : {}),
      };
    });
  } catch {
    return [{ ticket: source.references?.ticket ?? 'unknown', source: `external:${source.id}`, agentId: `${source.id}:export`, sessionId: `${source.id}:export`, registeredSessionId: `${source.id}:export`, telemetry: 'unknown', references: source.references }];
  } finally { await handle?.close(); }
}

async function readSource(source: ManagerLoopSource, nowMs: number, staleAfterMs: number): Promise<ManagerLoopSummary> {
  try {
    const artifacts = await lstat(source.artifactsDirectory);
    if (!artifacts.isDirectory()) return unavailable(source, 'artifacts_not_directory');
    if (source.observationRoot !== undefined && !inside(source.observationRoot, await realpath(source.artifactsDirectory))) return unavailable(source, 'artifacts_root_escape');
  } catch (error) {
    // Static configured sources historically surface a missing state file as
    // `state_missing`; retain that compatibility. Registered sources carry a
    // root seal and fail closed before any path below the root is opened.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || source.observationRoot !== undefined) return unavailable(source, 'artifacts_unreadable');
  }
  const statePath = join(source.artifactsDirectory, 'state.json');
  let handle;
  try {
    handle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const details = await handle.stat();
    const modifiedAt = new Date(details.mtimeMs).toISOString();
    if (!details.isFile() || details.size > MAX_STATE_BYTES) return unavailable(source, 'state_not_regular_file', modifiedAt);
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_STATE_BYTES) return unavailable(source, 'state_too_large', modifiedAt);
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(content) as unknown; } catch { return unavailable(source, 'state_malformed', modifiedAt); }
    let delivery: LoopDeliverySummary;
    try {
      const publication = await readDeliveryRecord(join(source.artifactsDirectory, 'publication.json'));
      const receipt = await readDeliveryRecord(join(source.artifactsDirectory, 'delivery.json'));
      delivery = projectLoopDelivery(parsed, publication, receipt);
    } catch { delivery = projectLoopDelivery(parsed, undefined, undefined, true); }
    const outcomeSource = observedOutcomeSource(source, delivery);
    const summary = projection(source, parsed, details.mtimeMs, nowMs, staleAfterMs, await externalUsageRecords(outcomeSource), delivery);
    if (!summary) return unavailable(source, 'state_malformed', modifiedAt);
    return summary;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return unavailable(source, code === 'ENOENT' ? 'state_missing' : code === 'ELOOP' ? 'state_symlink_rejected' : 'state_unreadable');
  } finally {
    await handle?.close();
  }
}

/**
 * Polls only owner-allowlisted Manager Loop artifact directories. The browser
 * receives the cached summaries and cannot choose paths or request file reads.
 */
export class ManagerLoopObserver {
  #sources: ManagerLoopSource[];
  readonly #pollIntervalMs: number;
  readonly #staleAfterMs: number;
  readonly #now: () => Date;
  readonly #listeners = new Set<Listener>();
  #summaries: ManagerLoopSummary[];
  #timer?: ReturnType<typeof setInterval>;
  #polling = false;

  constructor(options: ManagerLoopObserverOptions) {
    this.#sources = options.sources.map((source) => ({ ...source }));
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.#now = options.now ?? (() => new Date());
    this.#summaries = this.#sources.map((source) => unavailable(source, 'state_not_observed'));
  }

  summaries(): ManagerLoopSummary[] {
    return structuredClone(this.#summaries);
  }

  sources(): ManagerLoopSource[] { return structuredClone(this.#sources); }

  /** Registration changes the cached source set; it never starts or controls a loop worker. */
  async register(source: ManagerLoopSource): Promise<boolean> {
    const sameId = this.#sources.find((item) => item.id === source.id);
    const sameDirectory = this.#sources.find((item) => item.artifactsDirectory === source.artifactsDirectory);
    if (sameId || sameDirectory) {
      if (sameId?.artifactsDirectory === source.artifactsDirectory && sameDirectory?.id === source.id) return false;
      throw new Error('manager_loop_registration_conflict');
    }
    this.#sources = [...this.#sources, structuredClone(source)];
    this.#summaries = [...this.#summaries, unavailable(source, 'state_not_observed')];
    await this.poll();
    return true;
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const nowMs = this.#now().getTime();
      const next = await Promise.all(this.#sources.map((source) => readSource(source, nowMs, this.#staleAfterMs)));
      if (JSON.stringify(next) === JSON.stringify(this.#summaries)) return;
      this.#summaries = next;
      for (const listener of this.#listeners) listener();
    } finally { this.#polling = false; }
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => { void this.poll(); }, this.#pollIntervalMs);
    this.#timer.unref();
    void this.poll();
  }

  close(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#listeners.clear();
  }
}
