import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export interface ManagerLoopSource {
  id: string;
  artifactsDirectory: string;
  productId?: string;
  podId?: string;
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
  };
}

function projection(source: ManagerLoopSource, value: unknown, modifiedAtMs: number, nowMs: number, staleAfterMs: number): ManagerLoopSummary | undefined {
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
    ...(reason === undefined ? {} : { reason }),
  };
}

async function readSource(source: ManagerLoopSource, nowMs: number, staleAfterMs: number): Promise<ManagerLoopSummary> {
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
    return projection(source, parsed, details.mtimeMs, nowMs, staleAfterMs) ?? unavailable(source, 'state_malformed', modifiedAt);
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
  readonly #sources: readonly ManagerLoopSource[];
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
    return this.#summaries.map((summary) => ({ ...summary, completedPhases: [...summary.completedPhases], stages: summary.stages.map((item) => ({ ...item })), ...(summary.currentStage === undefined ? {} : { currentStage: { ...summary.currentStage } }) }));
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
