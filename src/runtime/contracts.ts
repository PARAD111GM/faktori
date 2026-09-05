import type { Authority, ExecutionProfile } from '../config/index.ts';

export type RunState =
  | 'queued'
  | 'admitted'
  | 'launching'
  | 'running'
  | 'cancelling'
  | 'reconciling'
  | 'succeeded'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'interrupted_uncertain';

export type ProviderOutcome =
  | 'completed'
  | 'unchanged_verified'
  | 'denied'
  | 'authentication_required'
  | 'quota_exhausted'
  | 'failed'
  | 'cancelled'
  | 'interrupted_uncertain'
  | 'unavailable';

export interface RunTarget {
  factoryId: string;
  productId: string;
  podId?: string;
  repository: string;
  branch: string;
  baseRevision: string;
  expectedRevision: string;
}

export interface RunWorkItem {
  id: string;
  revision: string;
}

export interface RunContextReference {
  packetRevision: string;
  digest: string;
}

export interface BudgetReservation {
  reservationId: string;
  maxRuntimeMinutes: number;
  estimatedTokens: number;
  status: 'held' | 'released' | 'consumed' | 'uncertain';
}

export type UsageTelemetry =
  | {
      availability: 'unavailable';
      unavailableReason: string;
    }
  | {
      availability: 'reported' | 'partially_reported';
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      reportedBy?: string;
      unavailableReason?: string;
    };

export interface AuthoritySnapshot {
  authorityRevision: string;
  epoch: number;
  scopeDigest: string;
  policy: Authority;
}

export interface RunExecutionRequest {
  profile: ExecutionProfile;
  workspaceId: string;
  /** Private operational path. It must be redacted from public evidence. */
  workspacePath: string;
  providerId: string;
  model: string;
  approvedInputDigests: string[];
}

export interface RunIntent {
  format: 'faktori.run-intent/v1';
  runId: string;
  admissionKey: string;
  workItem: RunWorkItem;
  target: RunTarget;
  context: RunContextReference;
  execution: RunExecutionRequest;
  budget: BudgetReservation;
  authority: AuthoritySnapshot;
  attempt: number;
  createdAt: string;
}

export interface CoordinatorIdentity {
  instanceId: string;
  pid: number;
  processStartedAt: string;
  processGroupId?: number;
  executableDigest?: string;
}

export interface NativeWorkerIdentity {
  kind: 'native';
  pid: number;
  processStartedAt: string;
  processGroupId: number;
  runNonce: string;
}

export interface ContainerWorkerIdentity {
  kind: 'container';
  containerId: string;
  containerStartedAt: string;
  runNonce: string;
}

export type WorkerIdentity = NativeWorkerIdentity | ContainerWorkerIdentity;

export interface QueuedMessage {
  messageId: string;
  runId: string;
  createdAt: string;
  delivery: 'next_turn';
  body: string;
}

export type DurableEffectKind =
  | 'worker.launch'
  | 'worker.resume'
  | 'worker.terminate'
  | 'action.execute';

export interface DurableEffectIntent {
  operationId: string;
  kind: DurableEffectKind;
  identityKey: string;
  requestedAt: string;
  requestDigest: string;
}

export interface DurableEffectReceipt {
  operationId: string;
  observedAt: string;
  outcome: 'completed' | 'safe_noop' | 'blocked' | 'failed' | 'uncertain';
  detail?: string;
}

export type RunEventKind =
  | 'coordinator.claimed'
  | 'coordinator.heartbeat'
  | 'coordinator.released'
  | 'run.admitted'
  | 'message.queued'
  | 'effect.intended'
  | 'effect.receipt'
  | 'effect.unresolved'
  | 'worker.started'
  | 'provider.event'
  | 'provider.final'
  | 'usage.observed'
  | 'authority.revoked'
  | 'worker.termination.intended'
  | 'worker.termination.observed'
  | 'action.intended'
  | 'action.receipt'
  | 'reservation.released';

export interface RunEvent {
  format: 'faktori.run-event/v1';
  eventId: string;
  runId: string;
  occurredAt: string;
  kind: RunEventKind;
  data: Record<string, unknown>;
}

export interface ProviderFinalResult {
  outcome: ProviderOutcome;
  sessionId?: string;
  summary?: string;
  revision?: string;
  verification?: string[];
  usage: UsageTelemetry;
  nativeCancellationReceipt: boolean;
}

export interface ActionScope {
  kind: string;
  repository: string;
  branch: string;
  baseRevision: string;
  expectedRevision: string;
  allowedOperation: string;
  scopeRevision: string;
}

export interface ActionCallerProof {
  grantId: string;
  nonce: string;
  authenticationTag: string;
}

export interface ActionRequest {
  format: 'faktori.action-request/v1';
  actionId: string;
  idempotencyKey: string;
  runId: string;
  scope: ActionScope;
  authorityEpoch: number;
  requestDigest: string;
  proof: ActionCallerProof;
  requestedAt: string;
}

export interface ActionReceipt {
  format: 'faktori.action-receipt/v1';
  actionId: string;
  idempotencyKey: string;
  runId: string;
  operationId: string;
  outcome: 'accepted' | 'completed' | 'duplicate' | 'denied' | 'failed' | 'uncertain';
  observedAt: string;
  detail?: string;
}

export interface RunSnapshot {
  intent: RunIntent;
  state: RunState;
  worker?: WorkerIdentity;
  providerResult?: ProviderFinalResult;
  reservation: BudgetReservation;
  authorityEpoch: number;
  authorityRevoked: boolean;
  unresolvedEffects: DurableEffectIntent[];
  messages: QueuedMessage[];
}

export function isTerminalRunState(state: RunState): boolean {
  return ['succeeded', 'blocked', 'failed', 'cancelled', 'interrupted_uncertain'].includes(state);
}
