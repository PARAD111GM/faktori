import { createHash } from 'node:crypto';
import type { FactoryEfficiencyMetrics } from './metrics.ts';
import type { GMFinding } from './index.ts';

export interface GMOwnerDecision { id: string; decidedAt: string; summary: string }
export interface GMNightlySchedule { enabled: boolean; timezone: string; localTime: string }
export interface GMNightlyRecommendation {
  priority: 'high' | 'medium' | 'low';
  findingId?: string;
  recommendation: string;
  expectedBenefit: string;
  evidence: string[];
  nextAction: string;
  authority: 'proposal_only';
}
export interface GMNightlyResult {
  findingActions: Array<{ findingId: string; action: 'retain' | 'propose_resolve'; evidence: string }>;
  recommendations: GMNightlyRecommendation[];
}
export interface GMNightlyAttempt {
  format: 'faktori.gm-nightly-attempt/v1';
  attemptId: string;
  trigger: 'scheduled' | 'owner_requested';
  scheduledDay?: string;
  requestId?: string;
  inputDigest: string;
  /** Compact active-finding fingerprints used only to bound the next review packet. */
  findingDigests?: Record<string, string>;
  intendedAt: string;
  status: 'intended' | 'completed' | 'failed' | 'skipped_unchanged';
  completedAt?: string;
  failure?: 'provider_failed_or_uncertain' | 'provider_result_invalid';
  result?: GMNightlyResult;
}
export interface GMNightlyState {
  configured: boolean;
  supervision: 'not_configured' | 'monitoring' | 'degraded';
  schedule?: GMNightlySchedule;
  lastEvaluation?: GMNightlyAttempt;
  lastSuccessfulReview?: GMNightlyAttempt;
}
export interface GMNightlyStore {
  attempts(): Promise<GMNightlyAttempt[]>;
  append(attempt: GMNightlyAttempt): Promise<void>;
}
export interface GMNightlyReviewPort { review(input: { prompt: string; attemptId: string; maxOutputCharacters: number }): Promise<unknown> }
export interface GMNightlyOptions {
  schedule: GMNightlySchedule;
  instructions: { revision: string; content: string };
  store: GMNightlyStore;
  review: GMNightlyReviewPort;
  snapshot: () => Promise<{ findings: GMFinding[]; metrics: FactoryEfficiencyMetrics }>;
  ownerDecisions?: GMOwnerDecision[];
  now?: () => Date;
}

function digest(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function text(value: unknown, maximum: number): string | undefined { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value : undefined; }
function exact(value: Record<string, unknown> | undefined, keys: string[]): boolean { return value !== undefined && Object.keys(value).every((key) => keys.includes(key)); }
function localParts(now: Date, timezone: string): { day: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
function scheduleMinutes(value: string): number { const [hour, minute] = value.split(':').map(Number); return (hour ?? 0) * 60 + (minute ?? 0); }

function parseResult(value: unknown, findingIds: ReadonlySet<string>): GMNightlyResult | undefined {
  const input = object(value);
  if (!input || !exact(input, ['findingActions', 'recommendations']) || !Array.isArray(input.findingActions) || !Array.isArray(input.recommendations) || input.findingActions.length > 100 || input.recommendations.length > 12) return undefined;
  const findingActions = input.findingActions.flatMap((raw) => {
    const item = object(raw), findingId = text(item?.findingId, 128), evidence = text(item?.evidence, 1_000);
    if (!exact(item, ['findingId', 'action', 'evidence']) || !findingId || !findingIds.has(findingId) || !['retain', 'propose_resolve'].includes(String(item?.action)) || !evidence) return [];
    return [{ findingId, action: item!.action as 'retain' | 'propose_resolve', evidence }];
  });
  const recommendations = input.recommendations.flatMap((raw): GMNightlyRecommendation[] => {
    const item = object(raw), recommendation = text(item?.recommendation, 1_000), expectedBenefit = text(item?.expectedBenefit, 1_000), nextAction = text(item?.nextAction, 1_000);
    const priority = item?.priority, findingId = item?.findingId === undefined ? undefined : text(item.findingId, 128);
    const evidence = Array.isArray(item?.evidence) ? item.evidence.map((entry) => text(entry, 512)).filter((entry): entry is string => Boolean(entry)).slice(0, 12) : [];
    if (!exact(item, ['priority', 'findingId', 'recommendation', 'expectedBenefit', 'evidence', 'nextAction']) || !recommendation || !expectedBenefit || !nextAction || !['high', 'medium', 'low'].includes(String(priority)) || evidence.length === 0 || (findingId !== undefined && !findingIds.has(findingId))) return [];
    return [{ priority: priority as GMNightlyRecommendation['priority'], ...(findingId ? { findingId } : {}), recommendation, expectedBenefit, evidence, nextAction, authority: 'proposal_only' }];
  });
  if (findingActions.length !== input.findingActions.length || recommendations.length !== input.recommendations.length) return undefined;
  return { findingActions, recommendations };
}

export function projectGMNightlyState(attempts: GMNightlyAttempt[], schedule?: GMNightlySchedule, now = new Date()): GMNightlyState {
  if (!schedule) return { configured: false, supervision: 'not_configured' };
  const terminal = attempts.filter((attempt) => attempt.status !== 'intended').at(-1);
  const intended = attempts.filter((attempt) => attempt.status === 'intended').at(-1);
  const last = intended && (!terminal || intended.intendedAt > (terminal.completedAt ?? terminal.intendedAt)) ? intended : terminal;
  const successful = [...attempts].reverse().find((attempt) => attempt.status === 'completed');
  const local = localParts(now, schedule.timezone);
  const scheduled = attempts.filter((attempt) => attempt.trigger === 'scheduled');
  const expectedToday = local.minutes >= scheduleMinutes(schedule.localTime);
  const latestScheduled = scheduled.at(-1);
  const stale = expectedToday ? !scheduled.some((attempt) => attempt.scheduledDay === local.day) : latestScheduled === undefined;
  return { configured: true, supervision: !schedule.enabled ? 'not_configured' : stale || last?.status === 'failed' || last?.status === 'intended' || last === undefined ? 'degraded' : 'monitoring', schedule, ...(last ? { lastEvaluation: last } : {}), ...(successful ? { lastSuccessfulReview: successful } : {}) };
}

/** Durable single-attempt nightly review. The intent is appended before provider invocation; failures are terminal. */
export class NightlyGM {
  readonly #options: GMNightlyOptions;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(options: GMNightlyOptions) { this.#options = options; localParts(new Date(), options.schedule.timezone); }
  run(trigger: { type: 'scheduled' } | { type: 'owner_requested'; requestId: string }): Promise<GMNightlyAttempt> {
    const operation = () => this.runExclusive(trigger);
    const next = this.#tail.then(operation, operation); this.#tail = next.catch(() => undefined); return next;
  }
  private async runExclusive(trigger: { type: 'scheduled' } | { type: 'owner_requested'; requestId: string }): Promise<GMNightlyAttempt> {
    const now = (this.#options.now ?? (() => new Date()))();
    const local = localParts(now, this.#options.schedule.timezone);
    if (trigger.type === 'scheduled' && (!this.#options.schedule.enabled || local.minutes < scheduleMinutes(this.#options.schedule.localTime))) throw new Error('gm_scheduled_review_not_due');
    const attemptId = trigger.type === 'scheduled' ? `scheduled:${local.day}` : `owner:${trigger.requestId}`;
    const attempts = await this.#options.store.attempts();
    const existing = attempts.filter((attempt) => attempt.attemptId === attemptId).at(-1);
    if (existing) return existing;
    const snapshot = await this.#options.snapshot();
    const previous = [...attempts].reverse().find((attempt) => attempt.status === 'completed');
    const findings = snapshot.findings.map((finding) => ({ findingId: finding.findingId, category: finding.category, status: finding.status ?? 'active', classification: finding.classification, latestSummary: finding.latestSummary, evidence: finding.evidence, affectedWork: finding.affectedWork, accountableRole: finding.accountableRole, nextAction: finding.nextAction }));
    const findingDigests = Object.fromEntries(findings.map((finding) => [finding.findingId, digest(finding)]));
    const changedFindings = findings.filter((finding) => previous?.findingDigests?.[finding.findingId] !== findingDigests[finding.findingId]);
    const resolvedFindingIds = Object.keys(previous?.findingDigests ?? {}).filter((findingId) => findingDigests[findingId] === undefined);
    const { gmReview: _gmReview, ...materialOverhead } = snapshot.metrics.overhead;
    const fingerprintMetrics = { ...snapshot.metrics, overhead: materialOverhead };
    const materialInput = {
      instructionRevision: this.#options.instructions.revision,
      findings,
      metrics: fingerprintMetrics,
      ownerDecisions: this.#options.ownerDecisions ?? [],
    };
    const inputDigest = digest(materialInput);
    if (previous?.inputDigest === inputDigest) {
      const skipped: GMNightlyAttempt = { format: 'faktori.gm-nightly-attempt/v1', attemptId, trigger: trigger.type, ...(trigger.type === 'scheduled' ? { scheduledDay: local.day } : { requestId: trigger.requestId }), inputDigest, findingDigests, intendedAt: now.toISOString(), completedAt: now.toISOString(), status: 'skipped_unchanged' };
      await this.#options.store.append(skipped); return skipped;
    }
    const intended: GMNightlyAttempt = { format: 'faktori.gm-nightly-attempt/v1', attemptId, trigger: trigger.type, ...(trigger.type === 'scheduled' ? { scheduledDay: local.day } : { requestId: trigger.requestId }), inputDigest, findingDigests, intendedAt: now.toISOString(), status: 'intended' };
    await this.#options.store.append(intended);
    const exampleFindingId = changedFindings[0]?.findingId ?? findings[0]?.findingId;
    const outputExample = { findingActions: exampleFindingId ? [{ findingId: exampleFindingId, action: 'retain', evidence: 'The cited deterministic evidence still supports this active finding.' }] : [], recommendations: [{ priority: 'high', ...(exampleFindingId ? { findingId: exampleFindingId } : {}), recommendation: 'Take one bounded owner-approved corrective step.', expectedBenefit: 'Reduce the observed operational cost or delay without widening authority.', evidence: ['Use a safe evidence identifier from changedFindings or metrics.'], nextAction: 'Name the accountable role and the next existing control or evidence link.' }] };
    const prompt = JSON.stringify({ task: 'faktori_consolidated_factory_review', instructions: this.#options.instructions.content, reviewInput: { changedFindings, resolvedFindingIds, metrics: snapshot.metrics, ownerDecisions: this.#options.ownerDecisions ?? [] }, priorRecommendations: previous?.result?.recommendations ?? [], outputContract: { strictJson: true, maxCharacters: 6000, onlyKeys: ['findingActions', 'recommendations'], findingActionFields: { findingId: 'an active findingId from changedFindings/current findings', action: ['retain', 'propose_resolve'], evidence: 'one bounded string' }, recommendationFields: { priority: ['high', 'medium', 'low'], findingId: 'optional active findingId', recommendation: 'bounded string', expectedBenefit: 'bounded string', evidence: 'non-empty array of bounded strings', nextAction: 'bounded string' }, authority: 'proposal_only', example: outputExample } });
    try {
      const response = await this.#options.review.review({ prompt, attemptId, maxOutputCharacters: 6_000 });
      const result = parseResult(response, new Set(snapshot.findings.map((finding) => finding.findingId)));
      if (!result) throw new Error('provider_result_invalid');
      const completed: GMNightlyAttempt = { ...intended, status: 'completed', completedAt: (this.#options.now ?? (() => new Date()))().toISOString(), result };
      await this.#options.store.append(completed); return completed;
    } catch (error) {
      const failed: GMNightlyAttempt = { ...intended, status: 'failed', completedAt: (this.#options.now ?? (() => new Date()))().toISOString(), failure: error instanceof Error && error.message === 'provider_result_invalid' ? 'provider_result_invalid' : 'provider_failed_or_uncertain' };
      await this.#options.store.append(failed); return failed;
    }
  }
}
