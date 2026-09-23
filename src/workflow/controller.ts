import { createHash, randomUUID } from 'node:crypto';

import {
  ROLE_QUEUE_STAGES,
  queueReadinessIsFresh,
  type AuthoritativeQueueSnapshot,
  type AuthoritativeWorkCandidate,
  type LaunchInspection,
  type LaunchObservation,
  type QueueAssignment,
  type QueueBlocker,
  type QueueEvaluation,
  type QueueExecutor,
  type QueueItem,
  type QueueMode,
  type ReceiptResult,
  type RoleQueueActivity,
  type RoleQueuePolicy,
  type RoleQueueStageId,
  type StagePolicy,
  type WorkerReceipt,
  type WorkflowEvent,
  type WorkflowJournalPort,
  type QueueSource,
} from './contracts.ts';

interface AssignmentState {
  assignment: QueueAssignment;
  launchIntended: boolean;
  launch?: LaunchObservation;
  receipt?: WorkerReceipt;
}

export interface RoleQueueControllerOptions {
  policy: RoleQueuePolicy;
  source: QueueSource;
  journal: WorkflowJournalPort;
  executor: QueueExecutor;
  now?: () => Date;
  eventId?: () => string;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const input = value as Record<string, unknown>;
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stable(input[key])}`).join(',')}}`;
}

function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function timestamp(value: unknown): boolean { return text(value) && Number.isFinite(Date.parse(value)); }

function isStageId(value: unknown): value is RoleQueueStageId {
  return typeof value === 'string' && (ROLE_QUEUE_STAGES as readonly string[]).includes(value);
}

function launch(value: unknown): value is LaunchObservation {
  if (value === null || typeof value !== 'object') return false;
  const observed = value as Partial<LaunchObservation>;
  return observed.status === 'running' ? text(observed.workerId) : (observed.status === 'completed'
    || observed.status === 'blocked' || observed.status === 'failed' || observed.status === 'uncertain');
}

function launchObservation(value: LaunchInspection): value is LaunchObservation {
  return ['running', 'completed', 'blocked', 'failed', 'uncertain'].includes(value.status);
}

function runningWorkerId(value: LaunchObservation | undefined): string | undefined {
  return value?.status === 'running' ? value.workerId : undefined;
}

function assignment(value: unknown): value is QueueAssignment {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Partial<QueueAssignment>;
  return text(item.assignmentId) && text(item.operationId) && text(item.workItemId) && text(item.executionScope)
    && isStageId(item.stageId) && text(item.role) && Number.isInteger(item.attempt) && Number(item.attempt) > 0
    && text(item.candidateRevision) && text(item.sourceRevision) && text(item.policyRevision)
    && item.runtime !== undefined && text(item.runtime.workItemId) && text(item.runtime.runId);
}

function receipt(value: unknown): value is WorkerReceipt {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Partial<WorkerReceipt>;
  return text(item.assignmentId) && text(item.candidateRevision) && Number.isInteger(item.sequence)
    && Number(item.sequence) > 0 && ['completed', 'waiting', 'blocked', 'failed'].includes(String(item.status))
    && text(item.evidenceRevision);
}

function workflowEvent(value: unknown): value is WorkflowEvent {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Partial<WorkflowEvent>;
  return event.format === 'faktori.workflow-event/v1' && text(event.eventId) && timestamp(event.occurredAt)
    && ['claim', 'launch_intended', 'launch_observed', 'worker_receipt'].includes(String(event.kind))
    && event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data);
}

function validatePolicy(policy: RoleQueuePolicy): Map<string, StagePolicy> {
  if (policy.format !== 'faktori.role-queue-policy/v1' || !text(policy.revision)) throw new Error('role_queue_policy_invalid');
  const byStatus = new Map<string, StagePolicy>();
  const stages = new Set<RoleQueueStageId>();
  for (const stage of policy.stages) {
    if (!isStageId(stage.stageId) || stages.has(stage.stageId) || !text(stage.role) || !Number.isInteger(stage.maxWip) || stage.maxWip < 0
      || !Array.isArray(stage.statusIds) || stage.statusIds.length === 0 || stage.statusIds.some((id) => !text(id))
      || !Array.isArray(stage.entryGuards) || stage.entryGuards.some((guard) => !text(guard))) throw new Error('role_queue_stage_policy_invalid');
    if (stage.role === 'builder' && stage.maxWip > 3) throw new Error('role_queue_builder_wip_limit_exceeded');
    stages.add(stage.stageId);
    for (const statusId of stage.statusIds) {
      if (byStatus.has(statusId)) throw new Error('role_queue_status_mapping_ambiguous');
      byStatus.set(statusId, stage);
    }
  }
  if (stages.size !== ROLE_QUEUE_STAGES.length || ROLE_QUEUE_STAGES.some((stage) => !stages.has(stage))) throw new Error('role_queue_stage_policy_incomplete');
  return byStatus;
}

function validateSnapshot(snapshot: AuthoritativeQueueSnapshot): void {
  if (snapshot.format !== 'faktori.role-queue-source/v1' || !text(snapshot.revision) || !timestamp(snapshot.readiness.observedAt)
    || !text(snapshot.readiness.authorityRevision) || !Array.isArray(snapshot.candidates)) throw new Error('role_queue_source_invalid');
  const ids = new Set<string>();
  for (const candidate of snapshot.candidates) {
    if (!text(candidate.workItemId) || ids.has(candidate.workItemId) || !text(candidate.executionScope) || !text(candidate.trackerStatusId)
      || !text(candidate.revision) || !Number.isInteger(candidate.rank) || candidate.rank < 0 || !text(candidate.runtime.workItemId)
      || !text(candidate.runtime.runId) || !timestamp(candidate.queuedAt)) throw new Error('role_queue_candidate_invalid');
    ids.add(candidate.workItemId);
    if (candidate.dependencies.some((dependency: { workItemId: string; state: string }) => !text(dependency.workItemId) || !['satisfied', 'unsatisfied', 'unknown'].includes(dependency.state))) throw new Error('role_queue_dependency_invalid');
    if (candidate.entryEvidence.some((evidence: { guardId: string; revision: string; observedAt: string }) => !text(evidence.guardId) || !text(evidence.revision) || !timestamp(evidence.observedAt))) throw new Error('role_queue_guard_evidence_invalid');
  }
}

function stateActivity(state: AssignmentState): RoleQueueActivity {
  if (state.receipt?.status === 'completed' || state.launch?.status === 'completed') return 'waiting';
  if (state.receipt?.status === 'waiting') return 'waiting';
  if (state.receipt?.status === 'blocked' || state.receipt?.status === 'failed' || state.launch?.status === 'blocked'
    || state.launch?.status === 'failed' || state.launch?.status === 'uncertain') return 'blocked';
  return 'active';
}

function isActive(state: AssignmentState): boolean {
  if (state.receipt && ['completed', 'failed', 'blocked'].includes(state.receipt.status)) return false;
  return !state.launch || !['completed', 'failed', 'blocked'].includes(state.launch.status);
}

/**
 * A small deterministic controller over an existing graph/controller. It does
 * not own tracker state, a database, or a scheduler: source observation is
 * authoritative and the supplied durable journal is replayed for claims.
 */
export class RoleQueueController {
  readonly #policy: RoleQueuePolicy;
  readonly #statusPolicy: Map<string, StagePolicy>;
  readonly #source: QueueSource;
  readonly #journal: WorkflowJournalPort;
  readonly #executor: QueueExecutor;
  readonly #now: () => Date;
  readonly #eventId: () => string;
  #lastEvaluationKey?: string;
  #lastEvaluation?: QueueEvaluation;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: RoleQueueControllerOptions) {
    this.#policy = options.policy;
    this.#statusPolicy = validatePolicy(options.policy);
    this.#source = options.source;
    this.#journal = options.journal;
    this.#executor = options.executor;
    this.#now = options.now ?? (() => new Date());
    this.#eventId = options.eventId ?? randomUUID;
  }

  /** Reconcile only durable launch intents lacking a durable observed receipt. Never relaunch. */
  async reconcile(): Promise<readonly QueueBlocker[]> {
    return this.#serialized(async () => {
      const states = this.#states();
      const blockers: QueueBlocker[] = [];
      for (const state of states.values()) {
        if (!state.launchIntended || !isActive(state)) continue;
        let inspected: LaunchInspection;
        try { inspected = await this.#executor.inspect(state.assignment); }
        catch (error) { inspected = { status: 'unknown', reason: error instanceof Error ? error.message : 'inspection_failed' }; }
        let observed: LaunchObservation;
        if (launchObservation(inspected)) {
          observed = inspected;
        } else {
          observed = { status: 'uncertain', reason: `restart_${inspected.status}:${inspected.reason}` };
        }
        if (stable(observed) === stable(state.launch)) continue;
        await this.#append('launch_observed', { assignmentId: state.assignment.assignmentId, observation: observed });
        blockers.push({ workItemId: state.assignment.workItemId, code: 'launch_reconciled_without_relaunch', detail: observed.status });
      }
      if (blockers.length > 0) { this.#lastEvaluationKey = undefined; this.#lastEvaluation = undefined; }
      return blockers;
    });
  }

  async evaluate(options: { mode: QueueMode; excludedScopes?: readonly string[] }): Promise<QueueEvaluation> {
    return this.#serialized(async () => {
      const snapshot = await this.#source.observe();
      validateSnapshot(snapshot);
      const states = this.#states();
      const excludedScopes = [...new Set(options.excludedScopes ?? [])].sort();
      const initialKey = this.#evaluationKey(snapshot, options.mode, excludedScopes, states);
      if (initialKey === this.#lastEvaluationKey && this.#lastEvaluation !== undefined) {
        return { ...this.#lastEvaluation, changed: false, launches: [] };
      }
      const blockers: QueueBlocker[] = [];
      const queue = this.#queue(snapshot, states, blockers);
      const launches: QueueAssignment[] = [];
      const excluded = new Set(excludedScopes);
    const automaticBlocked = options.mode === 'automatic' && !this.#automaticReady(snapshot, blockers);
    const activeByStage = new Map<RoleQueueStageId, number>();
    const activeSharedFiles = new Set<string>();
    for (const state of states.values()) if (isActive(state)) {
      const item = state.assignment;
      activeByStage.set(item.stageId, (activeByStage.get(item.stageId) ?? 0) + 1);
      const key = item.sharedFileKey ?? snapshot.candidates.find(candidate => candidate.workItemId === item.workItemId)?.sharedFileKey;
      if (key !== undefined) activeSharedFiles.add(key);
      if (!snapshot.candidates.some(candidate => candidate.workItemId === item.workItemId && candidate.revision === item.candidateRevision)) blockers.push({ workItemId: item.workItemId, code: 'prior_worker_requires_reconciliation', detail: item.runtime.runId });
    }

      for (const item of queue) {
        const stage = this.#statusPolicy.get(item.trackerStatusId)!;
        if (item.activity !== 'queued') continue;
        if (options.mode === 'shadow') continue;
        if (stage.role === 'human' || stage.role === 'release' || ['human_review', 'ready_to_release', 'done'].includes(stage.stageId)) {
          blockers.push({ workItemId: item.workItemId, code: 'human_or_release_authority_required', detail: stage.stageId });
          continue;
        }
        if (automaticBlocked || (options.mode === 'automatic' && !this.#automaticReady(snapshot, blockers))) continue;
        if (excluded.has(this.#candidate(snapshot, item.workItemId).executionScope)) {
          blockers.push({ workItemId: item.workItemId, code: 'execution_scope_owned_by_legacy_dispatch', detail: this.#candidate(snapshot, item.workItemId).executionScope });
          continue;
        }
        if ((activeByStage.get(stage.stageId) ?? 0) >= stage.maxWip) {
          blockers.push({ workItemId: item.workItemId, code: 'stage_wip_limit', detail: stage.stageId });
          continue;
        }
        const candidate = this.#candidate(snapshot, item.workItemId);
        if (candidate.sharedFileKey !== undefined && activeSharedFiles.has(candidate.sharedFileKey)) {
          blockers.push({ workItemId: item.workItemId, code: 'shared_file_serialization', detail: candidate.sharedFileKey });
          continue;
        }
        const attempt = this.#nextAttempt(states, candidate);
        if (stage.role === 'builder' && this.#downstreamBackpressure(queue, stage.stageId)) {
          blockers.push({ workItemId: item.workItemId, code: 'downstream_wip_backpressure', detail: stage.stageId });
          continue;
        }
        const next = this.#assignment(snapshot, candidate, stage, attempt, states);
        await this.#append('claim', { assignment: next });
        await this.#append('launch_intended', { assignmentId: next.assignmentId, operationId: next.operationId, assignment: next });
        let observation: LaunchObservation;
        try {
          observation = options.mode === 'automatic' && !queueReadinessIsFresh(snapshot.readiness, this.#now())
            ? { status: 'blocked', reason: 'automatic_readiness_stale_or_future' }
            : await this.#executor.launch(next);
        }
        catch (error) { observation = { status: 'uncertain', reason: error instanceof Error ? error.message : 'launch_failed_without_receipt' }; }
        await this.#append('launch_observed', { assignmentId: next.assignmentId, observation });
        states.set(next.assignmentId, { assignment: next, launchIntended: true, launch: observation });
        activeByStage.set(stage.stageId, (activeByStage.get(stage.stageId) ?? 0) + (isActive(states.get(next.assignmentId)!) ? 1 : 0));
        if (candidate.sharedFileKey !== undefined && isActive(states.get(next.assignmentId)!)) activeSharedFiles.add(candidate.sharedFileKey);
        launches.push(next);
      }
      const result: QueueEvaluation = { changed: true, sourceRevision: snapshot.revision, queue: this.#queue(snapshot, states, blockers), launches, blockers };
      this.#lastEvaluationKey = this.#evaluationKey(snapshot, options.mode, excludedScopes, states);
      this.#lastEvaluation = result;
      return result;
    });
  }

  /** Applies only a current, monotonic receipt; stale callbacks cannot move a new candidate. */
  async recordReceipt(input: WorkerReceipt): Promise<ReceiptResult> {
    return this.#serialized(async () => {
      if (!receipt(input)) return { applied: false, reason: 'receipt_invalid' };
      const states = this.#states();
      const state = states.get(input.assignmentId);
      if (state === undefined) return { applied: false, reason: 'assignment_unknown' };
      if (state.assignment.candidateRevision !== input.candidateRevision) return { applied: false, reason: 'stale_candidate_revision' };
      if ((state.receipt?.sequence ?? 0) >= input.sequence) return { applied: false, reason: 'duplicate_or_out_of_order_receipt' };
      const snapshot = await this.#source.observe();
      validateSnapshot(snapshot);
      const current = snapshot.candidates.find((candidate) => candidate.workItemId === state.assignment.workItemId);
      const currentStage = current === undefined ? undefined : this.#statusPolicy.get(current.trackerStatusId)?.stageId;
      if (current === undefined || current.revision !== input.candidateRevision || input.evidenceRevision !== current.revision || currentStage !== state.assignment.stageId) return { applied: false, reason: 'receipt_not_current_authority_state' };
      await this.#append('worker_receipt', { receipt: input });
      this.#lastEvaluationKey = undefined;
      this.#lastEvaluation = undefined;
      return { applied: true };
    });
  }

  #candidate(snapshot: AuthoritativeQueueSnapshot, workItemId: string): AuthoritativeWorkCandidate {
    const candidate = snapshot.candidates.find((item) => item.workItemId === workItemId);
    if (!candidate) throw new Error('role_queue_candidate_missing');
    return candidate;
  }

  #evaluationKey(snapshot: AuthoritativeQueueSnapshot, mode: QueueMode, excludedScopes: readonly string[], states: Map<string, AssignmentState>): string {
    const durableStates = [...states.values()].sort((left, right) => left.assignment.assignmentId.localeCompare(right.assignment.assignmentId)).map((state) => ({
      assignment: state.assignment, launchIntended: state.launchIntended, launch: state.launch, receipt: state.receipt,
    }));
    return digest({ sourceRevision: snapshot.revision, candidates: snapshot.candidates, readiness: snapshot.readiness, readinessFresh: queueReadinessIsFresh(snapshot.readiness, this.#now()), mode, excludedScopes, durableStates });
  }

  #queue(snapshot: AuthoritativeQueueSnapshot, states: Map<string, AssignmentState>, blockers: QueueBlocker[]): QueueItem[] {
    const items: QueueItem[] = [];
    const ageRank = (candidate: AuthoritativeWorkCandidate): number => candidate.rank - Math.max(0, Math.floor((this.#now().getTime() - Date.parse(candidate.queuedAt)) / 86_400_000));
    for (const candidate of [...snapshot.candidates].sort((left, right) => ageRank(left) - ageRank(right) || left.queuedAt.localeCompare(right.queuedAt) || left.workItemId.localeCompare(right.workItemId))) {
      const stage = this.#statusPolicy.get(candidate.trackerStatusId);
      if (stage === undefined) {
        blockers.push({ workItemId: candidate.workItemId, code: 'tracker_status_unmapped', detail: candidate.trackerStatusId });
        continue;
      }
      const matching = [...states.values()].filter((state) => state.assignment.workItemId === candidate.workItemId && state.assignment.candidateRevision === candidate.revision && state.assignment.stageId === stage.stageId)
        .sort((left, right) => right.assignment.attempt - left.assignment.attempt)[0];
      const priorActive = [...states.values()].find(state => state.assignment.workItemId === candidate.workItemId && state !== matching && isActive(state));
      const missingDependency = candidate.dependencies.find((dependency) => dependency.state !== 'satisfied' || (dependency.evidenceRevision !== undefined && dependency.evidenceRevision !== candidate.revision));
      const missingGuard = stage.entryGuards.find((guard) => !candidate.entryEvidence.some((evidence) => evidence.guardId === guard && evidence.revision === candidate.revision));
      const terminal = matching?.receipt?.status === 'completed';
      if (priorActive) {
        const detail = 'prior_worker_requires_reconciliation';
        blockers.push({ workItemId: candidate.workItemId, code: detail, detail: priorActive.assignment.runtime.runId });
        items.push({ workItemId: candidate.workItemId, stageId: stage.stageId, role: stage.role, trackerStatusId: candidate.trackerStatusId, activity: 'blocked', rank: candidate.rank, candidateRevision: candidate.revision, blocker: detail });
      } else if (terminal) {
        items.push({ workItemId: candidate.workItemId, stageId: stage.stageId, role: stage.role, trackerStatusId: candidate.trackerStatusId, activity: 'waiting', rank: candidate.rank, candidateRevision: candidate.revision, assignmentId: matching.assignment.assignmentId, blocker: 'tracker_transition_or_new_revision_required' });
      } else if (matching !== undefined) {
        items.push({ workItemId: candidate.workItemId, stageId: stage.stageId, role: stage.role, trackerStatusId: candidate.trackerStatusId, activity: stateActivity(matching), rank: candidate.rank, candidateRevision: candidate.revision, assignmentId: matching.assignment.assignmentId });
      } else if (missingDependency !== undefined) {
        const detail = `dependency:${missingDependency.workItemId}:${missingDependency.state}`;
        blockers.push({ workItemId: candidate.workItemId, code: 'dependency_not_ready', detail });
        items.push({ workItemId: candidate.workItemId, stageId: stage.stageId, role: stage.role, trackerStatusId: candidate.trackerStatusId, activity: 'blocked', rank: candidate.rank, candidateRevision: candidate.revision, blocker: detail });
      } else if (missingGuard !== undefined) {
        const detail = `entry_guard_missing_or_stale:${missingGuard}`;
        blockers.push({ workItemId: candidate.workItemId, code: 'entry_guard_missing_or_stale', detail });
        items.push({ workItemId: candidate.workItemId, stageId: stage.stageId, role: stage.role, trackerStatusId: candidate.trackerStatusId, activity: 'blocked', rank: candidate.rank, candidateRevision: candidate.revision, blocker: detail });
      } else {
        items.push({ workItemId: candidate.workItemId, stageId: stage.stageId, role: stage.role, trackerStatusId: candidate.trackerStatusId, activity: 'queued', rank: candidate.rank, candidateRevision: candidate.revision });
      }
    }
    return items;
  }

  #automaticReady(snapshot: AuthoritativeQueueSnapshot, blockers: QueueBlocker[]): boolean {
    if (!queueReadinessIsFresh(snapshot.readiness, this.#now())) {
      blockers.push({ code: 'automatic_readiness_stale_or_future', detail: snapshot.readiness.authorityRevision });
      return false;
    }
    const facets: Array<[string, { ready: boolean; blockers: readonly string[] }]> = [
      ['automatic', snapshot.readiness.automatic], ['transport', snapshot.readiness.transport], ['witness', snapshot.readiness.witness],
    ];
    let ready = true;
    for (const [name, facet] of facets) if (!facet.ready) {
      ready = false;
      blockers.push({ code: `automatic_${name}_capability_missing`, detail: facet.blockers.join(',') || snapshot.readiness.authorityRevision });
    }
    return ready;
  }

  #nextAttempt(states: Map<string, AssignmentState>, candidate: AuthoritativeWorkCandidate): number {
    return states.size === 0 ? 1 : Math.max(0, ...[...states.values()]
      .filter((state) => state.assignment.workItemId === candidate.workItemId)
      .map((state) => state.assignment.attempt)) + 1;
  }

  #downstreamBackpressure(queue: readonly QueueItem[], stageId: RoleQueueStageId): boolean {
    const position = ROLE_QUEUE_STAGES.indexOf(stageId);
    return queue.some((item) => {
      const downstream = item.stageId !== 'done' && ROLE_QUEUE_STAGES.indexOf(item.stageId) > position;
      if (!downstream || item.activity === 'blocked') return false;
      const policy = this.#statusPolicy.get(item.trackerStatusId)!;
      const count = queue.filter((candidate) => candidate.stageId === item.stageId && candidate.activity !== 'blocked').length;
      return policy.maxWip === 0 ? count > 0 : count >= policy.maxWip;
    });
  }

  #assignment(snapshot: AuthoritativeQueueSnapshot, candidate: AuthoritativeWorkCandidate, stage: StagePolicy, attempt: number, states: Map<string, AssignmentState>): QueueAssignment {
    const identity = { workItemId: candidate.workItemId, candidateRevision: candidate.revision, stageId: stage.stageId, attempt, policyRevision: this.#policy.revision };
    const assignmentId = `queue-${digest(identity).slice(0, 40)}`;
    const preferredWorkerId = [...states.values()].filter((state) => state.assignment.workItemId === candidate.workItemId && state.assignment.role === 'builder')
      .sort((left, right) => right.assignment.attempt - left.assignment.attempt).map((state) => runningWorkerId(state.launch)).find((workerId) => workerId !== undefined);
    return { assignmentId, operationId: `queue-launch-${digest({ assignmentId, sourceRevision: snapshot.revision }).slice(0, 40)}`,
      workItemId: candidate.workItemId, executionScope: candidate.executionScope, stageId: stage.stageId, role: stage.role, attempt,
      candidateRevision: candidate.revision, sourceRevision: snapshot.revision, policyRevision: this.#policy.revision, runtime: { ...candidate.runtime },
      ...(candidate.sharedFileKey === undefined ? {} : { sharedFileKey: candidate.sharedFileKey }),
      ...(preferredWorkerId === undefined ? {} : { preferredWorkerId }) };
  }

  #states(): Map<string, AssignmentState> {
    const states = new Map<string, AssignmentState>();
    for (const event of this.#journal.events()) {
      if (!workflowEvent(event)) continue;
      if (event.kind === 'claim' && assignment(event.data.assignment)) {
        const existing = states.get(event.data.assignment.assignmentId);
        if (existing === undefined) states.set(event.data.assignment.assignmentId, { assignment: event.data.assignment, launchIntended: false });
      } else if (event.kind === 'launch_intended' && text(event.data.assignmentId)) {
        const state = states.get(event.data.assignmentId); if (state) state.launchIntended = true;
      } else if (event.kind === 'launch_observed' && text(event.data.assignmentId) && launch(event.data.observation)) {
        const state = states.get(event.data.assignmentId); if (state && (state.launch === undefined || isActive(state))) state.launch = event.data.observation;
      } else if (event.kind === 'worker_receipt' && receipt(event.data.receipt)) {
        const state = states.get(event.data.receipt.assignmentId);
        if (state && state.assignment.candidateRevision === event.data.receipt.candidateRevision && (state.receipt?.sequence ?? 0) < event.data.receipt.sequence) state.receipt = event.data.receipt;
      }
    }
    return states;
  }

  async #append(kind: WorkflowEvent['kind'], data: Record<string, unknown>): Promise<void> {
    await this.#journal.append({ format: 'faktori.workflow-event/v1', eventId: this.#eventId(), occurredAt: this.#now().toISOString(), kind, data });
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
