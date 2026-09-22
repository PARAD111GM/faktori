import { createHash } from 'node:crypto';
import type { DurableCoordinator } from '../runtime/coordinator.ts';
import type { QueueAssignment, LaunchInspection, WorkflowEvent } from '../workflow/index.ts';
import type { ManagerConnectedStore } from '../manager-connected/index.ts';
import type { JiraObserver } from './jira-observer.ts';
import type { LocalConsoleRuntimeConfiguration } from './startup.ts';
import type { ConsoleOwnerActions } from './service.ts';
import { ConsoleWorkflowRuntime, type WorkflowRuntimeConfiguration } from './workflow-runtime.ts';
import { deliveryJournal } from './delivery-journal.ts';

/** Binds the derived queue to existing provider delivery, never a second worker launcher. */
export class ConsoleQueueBridge {
  readonly runtime: ConsoleWorkflowRuntime;
  readonly #coordinator: DurableCoordinator;
  readonly #journal;
  #running = false;
  #closed = false;
  #mode: 'shadow' | 'attended' | 'automatic' = 'shadow';
  #nextPollAt = 0;
  #nextEvaluationAt = 0;
  readonly #idleWaiters: Array<() => void> = [];
  constructor(options: { coordinator: DurableCoordinator; configuration: WorkflowRuntimeConfiguration; workItems: LocalConsoleRuntimeConfiguration['workItems']; actions: ConsoleOwnerActions; jira: JiraObserver; manager?: ManagerConnectedStore }) {
    this.#coordinator = options.coordinator;
    this.#journal = deliveryJournal<WorkflowEvent>(options.coordinator, 'workflow');
    const entries = new Map(options.workItems.map(item => [item.workItemId, item]));
    const inspect = async (assignment: QueueAssignment): Promise<LaunchInspection> => {
      const state = options.coordinator.snapshot(assignment.runtime.runId);
      if (!state) return { status: 'not_found', reason: 'no_durable_run_observed' };
      if (state.state === 'succeeded') return { status: 'completed', workerId: state.intent.runId };
      if (state.state === 'failed' || state.state === 'cancelled') return { status: 'failed', reason: state.state };
      if (state.state === 'blocked') return { status: 'blocked', reason: state.providerResult?.outcome ?? 'coordinator_blocked' };
      if (state.state === 'reconciling' || state.state === 'interrupted_uncertain') return { status: 'uncertain', reason: 'worker_identity_requires_reconciliation' };
      if (!state.worker) return { status: 'uncertain', reason: 'admitted_task_not_yet_observed' };
      return { status: 'running', workerId: state.intent.runId };
    };
    this.runtime = new ConsoleWorkflowRuntime({ coordinator: options.coordinator, configuration: options.configuration, workItems: options.workItems,
      executor: {
        inspect,
        launch: async assignment => {
          if (this.#closed || this.#mode === 'shadow') return { status: 'blocked', reason: 'queue_execution_not_enabled' };
          const entry = entries.get(assignment.runtime.workItemId);
          if (!entry || entry.intent.runId !== assignment.runtime.runId || entry.intent.workItem.revision !== assignment.candidateRevision
            || (entry.intent.workItem.role ?? 'builder') !== assignment.role) return { status: 'blocked', reason: 'queue_runtime_role_or_revision_mismatch' };
          if (options.manager?.isSprintWork(entry.intent.workItem.id)) return { status: 'blocked', reason: 'visible_goal_task_requires_foreman_relay' };
          if (!options.actions.startWork) return { status: 'blocked', reason: 'provider_execution_not_configured' };
          // Coordinator admission + delivery effect identity already make an
          // existing candidate replay-safe; a new queue identity cannot change it.
          await options.actions.startWork(entry.workItemId);
          const observed = await inspect(assignment);
          if (observed.status === 'running' || observed.status === 'completed' || observed.status === 'blocked' || observed.status === 'failed' || observed.status === 'uncertain') return observed;
          return { status: 'uncertain', reason: observed.reason };
        },
      },
      authority: { observe: async source => {
        const boards = options.jira.snapshot();
        const candidates = source.candidates.flatMap(candidate => {
          const board = boards.find(board => candidate.workItemId.startsWith(`${board.projectKey}-`));
          // Local tickets use the versioned owner-owned source. A configured Jira
          // project must never fall back to stale local facts when disconnected.
          if (!board) return [candidate];
          const issue = board.issues.find(issue => issue.key === candidate.workItemId);
          if (board.status !== 'connected' || board.truncated || !board.lastSyncedAt || Date.now() - Date.parse(board.lastSyncedAt) > 120_000
            || !issue?.statusId || issue.statusId !== candidate.trackerStatusId || issue.updatedAt !== candidate.revision) return [];
          return [{ ...candidate, trackerStatusId: issue.statusId }];
        });
        return { revision: createHash('sha256').update(JSON.stringify({ source: source.revision, candidates })).digest('hex'), candidates };
      } },
    });
  }
  async evaluate(mode: 'shadow' | 'attended' | 'automatic') {
    if (this.#closed) throw new Error('workflow_closed');
    // Actual native-goal/idle-wake-up proof is not supplied by CLI transports.
    // The core automatically reports those missing capabilities, not fake success.
    // Switching back to shadow revokes replenishment before any async reads.
    this.#mode = mode;
    const result = await this.runtime.evaluate({ mode });
    this.#nextEvaluationAt = Date.now() + 5_000;
    return result;
  }
  async poll(): Promise<void> {
    if (this.#running || this.#closed || Date.now() < this.#nextPollAt) return;
    this.#nextPollAt = Date.now() + 1_000;
    this.#running = true;
    try {
      const events = this.#journal.events();
      const receipted = new Set(events.filter(event => event.kind === 'worker_receipt').map(event => (event.data.receipt as { assignmentId?: string })?.assignmentId));
      let changed = false;
      for (const event of events) {
        if (event.kind !== 'launch_intended') continue;
        const assignment = event.data.assignment as QueueAssignment;
        if (!assignment || receipted.has(assignment.assignmentId)) continue;
        const run = this.#coordinator.snapshot(assignment.runtime.runId);
        if (!run || !['succeeded', 'failed', 'cancelled', 'blocked'].includes(run.state)) continue;
        const receipt = await this.runtime.receipt({ assignmentId: assignment.assignmentId, candidateRevision: assignment.candidateRevision,
          evidenceRevision: assignment.candidateRevision, sequence: 1, status: run.state === 'succeeded' ? 'completed' : run.state === 'blocked' ? 'blocked' : 'failed', detail: `coordinator:${run.state}` });
        changed ||= receipt.applied;
        // A stale callback cannot advance the ticket, but a current terminal
        // coordinator observation can safely release its old worker's hold.
        if (!receipt.applied && receipt.reason === 'receipt_not_current_authority_state') {
          await this.runtime.reconcile(); changed = true;
        }
      }
      // Observe changed tracker/private-source inputs without an LLM heartbeat.
      // The controller caches unchanged decisions and never replays a launch.
      if (changed || Date.now() >= this.#nextEvaluationAt) {
        this.#nextEvaluationAt = Date.now() + 5_000;
        await this.runtime.evaluate({ mode: this.#mode });
      }
    } finally { this.#running = false; for (const resolve of this.#idleWaiters.splice(0)) resolve(); }
  }
  async close(): Promise<void> { this.#closed = true; this.#mode = 'shadow'; if (this.#running) await new Promise<void>(resolve => this.#idleWaiters.push(resolve)); }
}
