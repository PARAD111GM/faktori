import { createHash } from 'node:crypto';

/**
 * The Factory GM has no coordinator authority.  The host supplies durable
 * storage and (optionally) a provider turn; this module only turns bounded
 * health observations into owner-visible factory concerns.
 */

export type GMHealthSignal =
  | {
      kind: 'repeated_handoff_failure';
      factoryId: string;
      productId?: string;
      podId?: string;
      handoffKey: string;
      sourceEventId?: string;
      observedAt: string;
      summary: string;
    }
  | {
      kind: 'merge_wait_bottleneck';
      factoryId: string;
      productId?: string;
      podId?: string;
      mergeKey: string;
      sourceEventId?: string;
      observedAt: string;
      waitingMinutes: number;
      summary: string;
    };

export type GMRoutineAction =
  | 'refresh_projection'
  | 'reconcile_unresolved_operations'
  | 'prune_expired_console_commands';

export type GMRecommendationKind =
  | 'routine_maintenance'
  | 'factory_improvement'
  | 'product_requirement_change'
  | 'merge_authority_change'
  | 'policy_change'
  | 'unknown';

export interface GMRecommendation {
  kind: GMRecommendationKind;
  detail: string;
  action?: GMRoutineAction;
}

export interface GMFinding {
  format: 'faktori.gm-finding/v1';
  findingId: string;
  findingKey: string;
  factoryId: string;
  category: GMHealthSignal['kind'];
  productId?: string;
  podId?: string;
  occurrenceCount: number;
  openedAt: string;
  updatedAt: string;
  latestSummary: string;
  ownerAttention: 'none' | 'owner_once';
  /** Durable timestamp for the single owner-inbox transition. */
  ownerAlertedAt?: string;
  diagnosis: {
    state: 'not_needed' | 'requested' | 'completed' | 'failed';
    summary?: string;
    requestedAt?: string;
    completedAt?: string;
  };
  recommendations: GMRecommendation[];
  rejectedRecommendations: Array<{ kind: GMRecommendationKind; detail: string; reason: string }>;
  maintenance: Array<{ action: GMRoutineAction; status: 'completed' | 'failed' | 'not_configured'; observedAt: string }>;
  /** Exact coordinator events already incorporated, for restart-safe observation dedupe. */
  sourceEventIds?: string[];
}

export interface GMImprovementProposal {
  format: 'faktori.gm-improvement/v1';
  proposalId: string;
  findingId: string;
  createdAt: string;
  detail: string;
  status: 'proposed';
  /** GM improvements require the normal approved delivery path. */
  authority: 'requires_approval';
}

/** Durable storage is host-owned: an in-memory implementation is not a production adapter. */
export interface DurableGMStore {
  findingByKey(key: string): Promise<GMFinding | undefined>;
  upsertFinding(finding: GMFinding): Promise<void>;
  appendImprovement(proposal: GMImprovementProposal): Promise<void>;
}

export interface GMProviderDiagnosisPort {
  /** The return value is untrusted model output and is parsed at this boundary. */
  diagnose(request: GMDiagnosisRequest): Promise<unknown>;
}

export interface GMDiagnosisRequest {
  findingId: string;
  findingKey: string;
  instructionRevision: string;
  instructions: string;
  category: GMHealthSignal['kind'];
  occurrenceCount: number;
  latestSummary: string;
  /** The provider must keep its result within this bound. */
  maxOutputCharacters: number;
}

/** A fixed port means GM output cannot become a shell command or a policy write. */
export interface RoutineMaintenancePort {
  execute(action: GMRoutineAction, finding: Readonly<GMFinding>): Promise<void>;
}

export interface FactoryGMOptions {
  factoryId: string;
  instructions: { revision: string; content: string };
  store: DurableGMStore;
  diagnosis?: GMProviderDiagnosisPort;
  maintenance?: RoutineMaintenancePort;
  /** Only this explicit allowlist may be executed through the maintenance port. */
  configuredRoutineActions?: readonly GMRoutineAction[];
  mergeWaitAttentionMinutes?: number;
  now?: () => Date;
}

export interface GMObservationResult {
  finding: GMFinding;
  diagnosisInvoked: boolean;
  ownerAttentionNewlyRequired: boolean;
}

const ROUTINE_ACTIONS = new Set<GMRoutineAction>([
  'refresh_projection',
  'reconcile_unresolved_operations',
  'prune_expired_console_commands',
]);
const PRIVILEGED_KINDS = new Set<GMRecommendationKind>([
  'product_requirement_change', 'merge_authority_change', 'policy_change',
]);
const MAX_SUMMARY = 2_000;
const MAX_INSTRUCTIONS = 12_000;
const MAX_DIAGNOSIS = 6_000;

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function optionalBoundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function id(prefix: string, key: string): string {
  return `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function signalSubject(signal: GMHealthSignal): string {
  return signal.kind === 'repeated_handoff_failure' ? signal.handoffKey : signal.mergeKey;
}

function findingKey(signal: GMHealthSignal): string {
  return `${signal.factoryId}:${signal.kind}:${signalSubject(signal)}`;
}

function validateSignal(signal: GMHealthSignal, factoryId: string): void {
  if (signal.factoryId !== factoryId) throw new Error('GM health signal belongs to a different factory');
  boundedText(signal.observedAt, 'observedAt', 128);
  boundedText(signal.summary, 'summary', MAX_SUMMARY);
  boundedText(signalSubject(signal), 'signal subject', 512);
  if (signal.productId !== undefined) boundedText(signal.productId, 'productId', 256);
  if (signal.podId !== undefined) boundedText(signal.podId, 'podId', 256);
  if (signal.sourceEventId !== undefined) boundedText(signal.sourceEventId, 'sourceEventId', 256);
  if (signal.kind === 'merge_wait_bottleneck' && (!Number.isFinite(signal.waitingMinutes) || signal.waitingMinutes < 0)) {
    throw new Error('waitingMinutes must be a finite non-negative number');
  }
}

function diagnosisNeeded(signal: GMHealthSignal): boolean {
  // Waiting for a human merge is observable without interpretation; a repeated
  // handoff failure benefits from a bounded diagnostic turn.
  return signal.kind === 'repeated_handoff_failure';
}

function parseRecommendations(value: unknown): GMRecommendation[] {
  const response = object(value);
  if (!Array.isArray(response?.recommendations)) return [];
  return response.recommendations.slice(0, 12).flatMap((candidate): GMRecommendation[] => {
    const item = object(candidate);
    const rawKind = optionalBoundedText(item?.kind, 64);
    const detail = optionalBoundedText(item?.detail, 1_000);
    if (!rawKind || !detail) return [];
    const kind: GMRecommendationKind = [
      'routine_maintenance', 'factory_improvement', 'product_requirement_change', 'merge_authority_change', 'policy_change',
    ].includes(rawKind) ? rawKind as GMRecommendationKind : 'unknown';
    const action = optionalBoundedText(item?.action, 96);
    return [{ kind, detail, ...(action !== undefined && ROUTINE_ACTIONS.has(action as GMRoutineAction) ? { action: action as GMRoutineAction } : {}) }];
  });
}

function diagnosisSummary(value: unknown): string | undefined {
  return optionalBoundedText(object(value)?.summary, MAX_DIAGNOSIS);
}

/**
 * Event-driven Factory GM. Calls are serialized so repeated health events
 * deterministically update one durable concern instead of producing alert spam.
 */
export class FactoryGM {
  readonly #options: Required<Pick<FactoryGMOptions, 'factoryId' | 'instructions' | 'store'>> & FactoryGMOptions;
  readonly #configuredActions: ReadonlySet<GMRoutineAction>;
  readonly #mergeWaitAttentionMinutes: number;
  readonly #now: () => Date;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: FactoryGMOptions) {
    boundedText(options.factoryId, 'factoryId', 256);
    boundedText(options.instructions.revision, 'instructions.revision', 256);
    boundedText(options.instructions.content, 'instructions.content', MAX_INSTRUCTIONS);
    if (!Number.isFinite(options.mergeWaitAttentionMinutes ?? 120) || (options.mergeWaitAttentionMinutes ?? 120) < 1) {
      throw new Error('mergeWaitAttentionMinutes must be a positive finite number');
    }
    this.#options = options;
    this.#configuredActions = new Set(options.configuredRoutineActions ?? []);
    this.#mergeWaitAttentionMinutes = options.mergeWaitAttentionMinutes ?? 120;
    this.#now = options.now ?? (() => new Date());
  }

  observe(signal: GMHealthSignal): Promise<GMObservationResult> {
    const run = (): Promise<GMObservationResult> => this.observeExclusive(signal);
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  private async observeExclusive(signal: GMHealthSignal): Promise<GMObservationResult> {
    validateSignal(signal, this.#options.factoryId);
    const key = findingKey(signal);
    const previous = await this.#options.store.findingByKey(key);
    if (signal.sourceEventId !== undefined && previous?.sourceEventIds?.includes(signal.sourceEventId)) {
      return { finding: previous, diagnosisInvoked: false, ownerAttentionNewlyRequired: false };
    }
    const wasAttentionRequired = previous?.ownerAttention === 'owner_once';
    const attention = signal.kind === 'merge_wait_bottleneck' && signal.waitingMinutes >= this.#mergeWaitAttentionMinutes
      ? 'owner_once' : previous?.ownerAttention ?? 'none';
    let finding: GMFinding = previous === undefined ? {
      format: 'faktori.gm-finding/v1', findingId: id('finding', key), findingKey: key, factoryId: signal.factoryId,
      category: signal.kind, ...(signal.productId === undefined ? {} : { productId: signal.productId }), ...(signal.podId === undefined ? {} : { podId: signal.podId }),
      occurrenceCount: 1, openedAt: signal.observedAt, updatedAt: signal.observedAt, latestSummary: signal.summary,
      ownerAttention: attention, ...(attention === 'owner_once' ? { ownerAlertedAt: signal.observedAt } : {}),
      diagnosis: { state: diagnosisNeeded(signal) ? 'requested' : 'not_needed', ...(diagnosisNeeded(signal) ? { requestedAt: signal.observedAt } : {}) },
      recommendations: [], rejectedRecommendations: [], maintenance: [],
      ...(signal.sourceEventId === undefined ? {} : { sourceEventIds: [signal.sourceEventId] }),
    } : {
      ...previous, occurrenceCount: previous.occurrenceCount + 1, updatedAt: signal.observedAt, latestSummary: signal.summary,
      ownerAttention: attention, ...(attention === 'owner_once' && previous.ownerAlertedAt === undefined ? { ownerAlertedAt: signal.observedAt } : {}),
      ...(signal.sourceEventId === undefined ? {} : { sourceEventIds: [...(previous.sourceEventIds ?? []), signal.sourceEventId] }),
    };
    await this.#options.store.upsertFinding(finding);

    const shouldDiagnose = previous === undefined && diagnosisNeeded(signal) && this.#options.diagnosis !== undefined;
    if (shouldDiagnose) finding = await this.applyDiagnosis(finding, signal.observedAt);
    return { finding, diagnosisInvoked: shouldDiagnose, ownerAttentionNewlyRequired: !wasAttentionRequired && finding.ownerAttention === 'owner_once' };
  }

  private async applyDiagnosis(finding: GMFinding, observedAt: string): Promise<GMFinding> {
    let response: unknown;
    try {
      response = await this.#options.diagnosis!.diagnose({
        findingId: finding.findingId, findingKey: finding.findingKey, instructionRevision: this.#options.instructions.revision, instructions: this.#options.instructions.content,
        category: finding.category, occurrenceCount: finding.occurrenceCount, latestSummary: finding.latestSummary, maxOutputCharacters: MAX_DIAGNOSIS,
      });
    } catch {
      const failed = { ...finding, diagnosis: { ...finding.diagnosis, state: 'failed' as const, completedAt: observedAt } };
      await this.#options.store.upsertFinding(failed);
      return failed;
    }
    const recommendations = parseRecommendations(response);
    const rejectedRecommendations: GMFinding['rejectedRecommendations'] = [];
    const maintenance: GMFinding['maintenance'] = [];
    for (const recommendation of recommendations) {
      if (PRIVILEGED_KINDS.has(recommendation.kind)) {
        rejectedRecommendations.push({ kind: recommendation.kind, detail: recommendation.detail, reason: 'factory_gm_has_no_product_merge_or_policy_authority' });
        continue;
      }
      if (recommendation.kind === 'factory_improvement') {
        await this.#options.store.appendImprovement({
          format: 'faktori.gm-improvement/v1', proposalId: id('improvement', `${finding.findingId}:${recommendation.detail}`),
          findingId: finding.findingId, createdAt: observedAt, detail: recommendation.detail, status: 'proposed', authority: 'requires_approval',
        });
        continue;
      }
      if (recommendation.kind !== 'routine_maintenance' || recommendation.action === undefined || !this.#configuredActions.has(recommendation.action) || this.#options.maintenance === undefined) {
        rejectedRecommendations.push({ kind: recommendation.kind, detail: recommendation.detail, reason: 'routine_action_not_explicitly_configured' });
        if (recommendation.action !== undefined) maintenance.push({ action: recommendation.action, status: 'not_configured', observedAt });
        continue;
      }
      try {
        await this.#options.maintenance.execute(recommendation.action, finding);
        maintenance.push({ action: recommendation.action, status: 'completed', observedAt });
      } catch {
        maintenance.push({ action: recommendation.action, status: 'failed', observedAt });
      }
    }
    const completed: GMFinding = {
      ...finding,
      diagnosis: { ...finding.diagnosis, state: 'completed', completedAt: observedAt, ...(diagnosisSummary(response) === undefined ? {} : { summary: diagnosisSummary(response) }) },
      recommendations, rejectedRecommendations, maintenance,
    };
    await this.#options.store.upsertFinding(completed);
    return completed;
  }
}

export * from './coordinator-store.ts';
export * from './health-observer.ts';
