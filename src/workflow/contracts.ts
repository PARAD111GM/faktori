/**
 * Provider-neutral execution projection. Tracker status is source authority;
 * queue activity is a separate controller concern and is reconstructed from
 * the durable journal below.
 */
export const ROLE_QUEUE_STAGES = [
  'needs_specification', 'ready_to_build', 'ready_for_review', 'human_review',
  'ready_to_release', 'staging_acceptance', 'done',
] as const;

export type RoleQueueStageId = typeof ROLE_QUEUE_STAGES[number];
export type RoleQueueActivity = 'queued' | 'active' | 'waiting' | 'blocked';
export type QueueMode = 'shadow' | 'attended' | 'automatic';
export type WorkflowRole = 'planner' | 'builder' | 'reviewer' | 'human' | 'release' | 'acceptance';

export interface StagePolicy {
  /** Stable logical ID, independent from a tracker display name or column. */
  stageId: RoleQueueStageId;
  role: WorkflowRole;
  /** Stable tracker status IDs. Several IDs may deliberately aggregate here. */
  statusIds: readonly string[];
  /** Source-observed evidence IDs bound to the candidate's current revision. */
  entryGuards: readonly string[];
  /** Maximum active assignments for this stage. */
  maxWip: number;
  /** A failed worker returns to this policy only through a new source revision. */
  failureStageId?: RoleQueueStageId;
}

export interface RoleQueuePolicy {
  format: 'faktori.role-queue-policy/v1';
  /** Changes to mapping/limits are an explicit new deterministic revision. */
  revision: string;
  stages: readonly StagePolicy[];
}

export interface EntryGuardEvidence {
  guardId: string;
  /** Evidence must be current for the candidate, not merely true in a config file. */
  revision: string;
  observedAt: string;
}

export interface QueueDependency {
  workItemId: string;
  state: 'satisfied' | 'unsatisfied' | 'unknown';
  evidenceRevision?: string;
}

export interface RuntimeWorkReference {
  /** Preconfigured runtime work item supplied by the trusted root controller. */
  workItemId: string;
  /** Stable run identity used by the existing DurableCoordinator delivery path. */
  runId: string;
}

export interface AuthoritativeWorkCandidate {
  workItemId: string;
  executionScope: string;
  trackerStatusId: string;
  /** New evidence/candidate output must advance this revision to create a repair attempt. */
  revision: string;
  rank: number;
  /** Source-observed queue time lets deterministic selection age low-ranked work. */
  queuedAt: string;
  dependencies: readonly QueueDependency[];
  entryEvidence: readonly EntryGuardEvidence[];
  runtime: RuntimeWorkReference;
  /** Optional key used by source policy to represent account-pool limits. */
  accountPoolId?: string;
  /** Optional shared-file serialization key already determined by the source authority. */
  sharedFileKey?: string;
}

export interface QueueReadiness {
  authorityRevision: string;
  observedAt: string;
  /** The source/controller, not a tracker status, attests these capabilities. */
  automatic: { ready: boolean; blockers: readonly string[] };
  transport: { ready: boolean; blockers: readonly string[] };
  witness: { ready: boolean; blockers: readonly string[] };
}

/** Capability attestations are short-lived, never perpetual launch authority. */
export const QUEUE_READINESS_MAX_AGE_MS = 120_000;
export function queueReadinessIsFresh(readiness: Pick<QueueReadiness, 'observedAt'>, now: Date): boolean {
  const age = now.getTime() - Date.parse(readiness.observedAt);
  return Number.isFinite(age) && age >= 0 && age < QUEUE_READINESS_MAX_AGE_MS;
}

export interface AuthoritativeQueueSnapshot {
  format: 'faktori.role-queue-source/v1';
  revision: string;
  candidates: readonly AuthoritativeWorkCandidate[];
  readiness: QueueReadiness;
}

export interface QueueSource {
  observe(): Promise<AuthoritativeQueueSnapshot>;
}

export type WorkflowEventKind = 'claim' | 'launch_intended' | 'launch_observed' | 'worker_receipt';

export interface WorkflowEvent {
  format: 'faktori.workflow-event/v1';
  eventId: string;
  occurredAt: string;
  kind: WorkflowEventKind;
  data: Record<string, unknown>;
}

/** Root adapts this to the existing DurableCoordinator journal; this module owns no store. */
export interface WorkflowJournalPort {
  events(): readonly WorkflowEvent[];
  append(record: WorkflowEvent): Promise<void>;
}

export interface QueueAssignment {
  /** Retain ownership even when the source moves or removes the ticket. */
  sharedFileKey?: string;
  assignmentId: string;
  operationId: string;
  workItemId: string;
  executionScope: string;
  stageId: RoleQueueStageId;
  role: WorkflowRole;
  attempt: number;
  candidateRevision: string;
  sourceRevision: string;
  policyRevision: string;
  runtime: RuntimeWorkReference;
  /** A repair may resume this observed builder when the trusted executor can prove it is safe. */
  preferredWorkerId?: string;
}

export type LaunchObservation =
  | { status: 'running'; workerId: string }
  | { status: 'completed'; workerId?: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'uncertain'; reason: string };

export type LaunchInspection = LaunchObservation | { status: 'not_found' | 'unknown'; reason: string };

export interface QueueExecutor {
  launch(assignment: QueueAssignment): Promise<LaunchObservation>;
  /** Used exclusively for an intent that survived without an observed receipt. */
  inspect(assignment: QueueAssignment): Promise<LaunchInspection>;
}

export interface WorkerReceipt {
  assignmentId: string;
  candidateRevision: string;
  sequence: number;
  status: 'completed' | 'waiting' | 'blocked' | 'failed';
  evidenceRevision: string;
  detail?: string;
}

export interface QueueItem {
  workItemId: string;
  stageId: RoleQueueStageId;
  role: WorkflowRole;
  trackerStatusId: string;
  activity: RoleQueueActivity;
  rank: number;
  candidateRevision: string;
  assignmentId?: string;
  blocker?: string;
}

export interface QueueBlocker {
  workItemId?: string;
  code: string;
  detail: string;
}

export interface QueueEvaluation {
  changed: boolean;
  sourceRevision: string;
  queue: readonly QueueItem[];
  launches: readonly QueueAssignment[];
  blockers: readonly QueueBlocker[];
}

export interface ReceiptResult { applied: boolean; reason?: string; }
