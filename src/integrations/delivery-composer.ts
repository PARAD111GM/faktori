import { createHash } from 'node:crypto';

import { ControllerActionAdmission, type AuthorizedAction, type ActionControllerOptions } from '../actions/index.ts';
import type { ActionRequest, ActionScope } from '../runtime/contracts.ts';
import { JiraRestActionExecutor, type JiraOperation, type JiraTransition, type JiraRestExecutorOptions } from './jira.ts';
import {
  executePlannedDeliveryTransitions,
  planDeliverySynchronization,
  type DeliverySyncInstruction,
  type DeliverySyncPlan,
  type DeliverySyncPolicy,
  type DiscoveredJiraTransition,
  type RegisteredDelivery,
  type SignedDeliveryTransition,
  type DeliveryTransitionExecution,
} from './delivery-sync.ts';

/** A controller-owned read. Unknown observations must be represented as a plan no-op. */
export interface TrustedDeliveryObservation {
  deliveries: readonly RegisteredDelivery[];
  transitionsByTicket: Readonly<Record<string, readonly DiscoveredJiraTransition[] | undefined>>;
  /** Controller observation failures remain visible rather than becoming a quiet empty sync. */
  unavailable?: readonly { ticketKey: string; reason: string }[];
}

/**
 * The capability stays behind this callback. The composer never mints a grant,
 * reads a verifier secret, or accepts a browser-supplied action request.
 */
export interface ExistingDeliveryActionSigner {
  sign(input: Omit<ActionRequest, 'proof' | 'requestDigest'>): Promise<unknown>;
}

/** Explicitly connects one owner-approved, already-current action scope to one ticket. */
export interface DeliveryActionBinding {
  ticketKey: string;
  repository: string;
  runId: string;
  scope: ActionScope;
  authorityEpoch: number;
  /** Controller-retained request identity; it is stable across restart recovery. */
  requestedAt: string;
  signer: ExistingDeliveryActionSigner;
}

interface ResolvedOperation {
  runId: string;
  scope: ActionScope;
  authorityEpoch: number;
  operation: Extract<JiraOperation, { kind: 'issue.transition' }>;
  transition: JiraTransition;
  idempotencyKey: string;
}

interface SealedTransition {
  key: string;
  binding: DeliveryActionBinding;
  instruction: Extract<DeliverySyncInstruction, { kind: 'transition' }>;
}

function scopeEqual(left: ActionScope, right: ActionScope): boolean {
  return left.kind === right.kind && left.repository === right.repository && left.branch === right.branch
    && left.baseRevision === right.baseRevision && left.expectedRevision === right.expectedRevision
    && left.allowedOperation === right.allowedOperation && left.scopeRevision === right.scopeRevision;
}

function requestMatches(request: unknown, expected: Omit<ActionRequest, 'proof' | 'requestDigest'>): boolean {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return false;
  const item = request as Record<string, unknown>;
  return item.format === 'faktori.action-request/v1'
    && item.actionId === expected.actionId
    && item.idempotencyKey === expected.idempotencyKey
    && item.runId === expected.runId
    && item.authorityEpoch === expected.authorityEpoch
    && item.requestedAt === expected.requestedAt
    && item.scope !== null && typeof item.scope === 'object' && !Array.isArray(item.scope)
    && scopeEqual(item.scope as ActionScope, expected.scope);
}

function observedPullRequest(entry: RegisteredDelivery): RegisteredDelivery['pullRequest'] | undefined {
  const values = [...(entry.pullRequest === undefined ? [] : [entry.pullRequest]), ...(entry.pullRequests ?? [])];
  return values.length === 1 ? values[0] : undefined;
}

function candidateRevision(instruction: Extract<DeliverySyncInstruction, { kind: 'transition' }>, entry: RegisteredDelivery): string | undefined {
  const pullRequest = observedPullRequest(entry);
  if (pullRequest === undefined) return undefined;
  return instruction.reason === 'exact_head_ready_for_human_merge' ? pullRequest.headCommit : pullRequest.mergeCommit;
}

function instructionKey(instruction: Extract<DeliverySyncInstruction, { kind: 'transition' }>, revision: string, pullRequest: number): string {
  return JSON.stringify({ id: instruction.id, ticketKey: instruction.ticketKey, repository: instruction.repository, fromStatus: instruction.fromStatus, toStatus: instruction.toStatus, transitionId: instruction.transitionId, reason: instruction.reason, revision, pullRequest });
}

function idempotencyKey(key: string): string {
  return `delivery-transition:${createHash('sha256').update(key).digest('hex')}`;
}

/**
 * Mutable only inside the controller. Startup supplies `operationFor` and
 * `transitions` to one JiraRestActionExecutor; a stale action cannot resolve
 * after a later observation because run, full scope, epoch, and action ID all
 * have to match the recorded operation.
 */
export class DeliveryTransitionOperationResolver {
  readonly transitions: Record<string, JiraTransition> = {};
  #operations = new Map<string, ResolvedOperation>();

  replace(entries: readonly { key: string; instruction: Extract<DeliverySyncInstruction, { kind: 'transition' }>; binding: DeliveryActionBinding; revision: string }[]): void {
    this.#operations.clear();
    for (const key of Object.keys(this.transitions)) delete this.transitions[key];
    for (const { key, instruction, binding, revision } of entries) {
      this.#operations.set(instruction.id, {
        runId: binding.runId,
        scope: structuredClone(binding.scope),
        authorityEpoch: binding.authorityEpoch,
        operation: { kind: 'issue.transition', issueKey: instruction.ticketKey, transition: instruction.id },
        transition: { id: instruction.transitionId, targetStatus: instruction.toStatus },
        idempotencyKey: idempotencyKey(key),
      });
      this.transitions[instruction.id] = { id: instruction.transitionId, targetStatus: instruction.toStatus };
      // `revision` is deliberately consumed when authorizing the binding below;
      // it is not a Jira operation field and cannot be supplied by a worker.
      void revision;
    }
  }

  operationFor(action: AuthorizedAction): JiraOperation | undefined {
    const resolved = this.#operations.get(action.request.actionId);
    if (resolved === undefined || action.request.idempotencyKey !== resolved.idempotencyKey || action.request.runId !== resolved.runId || action.request.authorityEpoch !== resolved.authorityEpoch
      || !scopeEqual(action.request.scope, resolved.scope)) return undefined;
    return { ...resolved.operation };
  }
}

export interface DeliveryTransitionComposerOptions {
  observe(): Promise<TrustedDeliveryObservation>;
  policy: DeliverySyncPolicy;
  bindings: readonly DeliveryActionBinding[];
  admission: Pick<ControllerActionAdmission, 'admit'>;
  resolver: DeliveryTransitionOperationResolver;
}

export interface DeliveryCompositionResult {
  initialPlan: DeliverySyncPlan;
  finalPlan: DeliverySyncPlan;
  executions: readonly DeliveryTransitionExecution[];
  unavailable: readonly { ticketKey: string; reason: string }[];
}

/**
 * Composes trusted observations into existing signed actions. It observes three
 * times around signing: selection, signing preflight, and the final admission
 * edge. Any changed candidate, transition, status, or scope becomes a no-op.
 */
export class DeliveryTransitionComposer {
  readonly #observe: DeliveryTransitionComposerOptions['observe'];
  readonly #policy: DeliverySyncPolicy;
  readonly #bindings: readonly DeliveryActionBinding[];
  readonly #admission: DeliveryTransitionComposerOptions['admission'];
  readonly #resolver: DeliveryTransitionOperationResolver;
  #sealed = new Map<string, SealedTransition>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: DeliveryTransitionComposerOptions) {
    this.#observe = options.observe;
    this.#policy = options.policy;
    this.#bindings = options.bindings.map((binding) => ({ ...binding, scope: structuredClone(binding.scope) }));
    this.#admission = options.admission;
    this.#resolver = options.resolver;
    const keys = this.#bindings.map((binding) => binding.ticketKey);
    if (new Set(keys).size !== keys.length) throw new Error('delivery action bindings must have one explicit binding per ticket');
    if (this.#bindings.some((binding) => !Number.isFinite(Date.parse(binding.requestedAt)))) throw new Error('delivery action binding requestedAt must be a retained ISO timestamp');
  }

  async synchronize(): Promise<DeliveryCompositionResult> {
    const task = async (): Promise<DeliveryCompositionResult> => this.synchronizeExclusive();
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  private async synchronizeExclusive(): Promise<DeliveryCompositionResult> {
    const initial = await this.#observe();
    const initialPlan = this.plan(initial);
    const selected = this.transitionEntries(initialPlan, initial);
    if (selected.length === 0) {
      this.#sealed.clear();
      this.#resolver.replace([]);
      return { initialPlan, finalPlan: initialPlan, executions: await executePlannedDeliveryTransitions(initialPlan, [], this.#admission), unavailable: initial.unavailable ?? [] };
    }

    // Do not let a signer act on an observation that became stale while a
    // previous poll was being planned.
    const preflight = await this.#observe();
    const preflightPlan = this.plan(preflight);
    const preflightEntries = this.sameEntries(selected, this.transitionEntries(preflightPlan, preflight));
    const signed = await Promise.all(preflightEntries.map(async (entry) => ({ entry, request: await this.sign(entry) })));

    // This is the last observation before action admission. It specifically
    // defeats a changed PR head/merge revision using the planner's otherwise
    // stable action ID as an idempotency identity.
    const final = await this.#observe();
    const finalPlan = this.plan(final);
    const finalEntries = this.sameEntries(preflightEntries, this.transitionEntries(finalPlan, final));
    const permitted = finalEntries.flatMap((entry) => {
      const signedEntry = signed.find((candidate) => candidate.entry.key === entry.key);
      return signedEntry?.request === undefined ? [] : [{ ...entry, request: signedEntry.request }];
    });
    this.#sealed = new Map(permitted.map((entry) => [entry.instruction.id, { key: entry.key, binding: entry.binding, instruction: entry.instruction }]));
    this.#resolver.replace(permitted);
    const bindings: SignedDeliveryTransition[] = permitted.map(({ instruction, request }) => ({ instructionId: instruction.id, request }));
    const executions = await executePlannedDeliveryTransitions(finalPlan, bindings, this.#admission);
    return { initialPlan, finalPlan, executions, unavailable: final.unavailable ?? [] };
  }

  /**
   * Install this as JiraRestActionExecutor's post-reconciliation `beforeWrite`
   * callback. Jira has just established that its target status is not already
   * reached; this re-observes the external delivery evidence before the
   * executor's own final authority guard and POST.
   */
  async validateBeforeWrite(action: AuthorizedAction, operation: JiraOperation): Promise<void> {
    if (operation.kind !== 'issue.transition') throw new Error('delivery_evidence_changed_before_write');
    const sealed = this.#sealed.get(action.request.actionId);
    if (sealed === undefined || action.request.idempotencyKey !== idempotencyKey(sealed.key) || operation.issueKey !== sealed.instruction.ticketKey || operation.transition !== sealed.instruction.id
      || action.request.runId !== sealed.binding.runId || action.request.authorityEpoch !== sealed.binding.authorityEpoch
      || !scopeEqual(action.request.scope, sealed.binding.scope)) throw new Error('delivery_evidence_changed_before_write');
    const current = await this.#observe();
    const currentPlan = this.plan(current);
    const currentEntry = this.transitionEntries(currentPlan, current).find((entry) => entry.key === sealed.key && entry.instruction.id === sealed.instruction.id);
    if (currentEntry === undefined || currentEntry.binding.runId !== sealed.binding.runId || !scopeEqual(currentEntry.binding.scope, sealed.binding.scope)) {
      throw new Error('delivery_evidence_changed_before_write');
    }
  }

  private plan(observation: TrustedDeliveryObservation): DeliverySyncPlan {
    return planDeliverySynchronization({ deliveries: observation.deliveries, transitionsByTicket: observation.transitionsByTicket, policy: this.#policy });
  }

  private transitionEntries(plan: DeliverySyncPlan, observation: TrustedDeliveryObservation): Array<{ key: string; instruction: Extract<DeliverySyncInstruction, { kind: 'transition' }>; binding: DeliveryActionBinding; revision: string }> {
    const deliveries = new Map(observation.deliveries.map((entry) => [entry.ticket.key, entry]));
    return plan.instructions.flatMap((instruction) => {
      if (instruction.kind !== 'transition') return [];
      const entry = deliveries.get(instruction.ticketKey);
      const binding = this.#bindings.find((candidate) => candidate.ticketKey === instruction.ticketKey);
      const revision = entry === undefined ? undefined : candidateRevision(instruction, entry);
      if (entry === undefined || binding === undefined || revision === undefined
        || binding.repository !== instruction.repository || entry.repository.repository !== binding.repository
        || binding.scope.repository !== instruction.repository || binding.scope.branch !== entry.repository.branch || binding.scope.expectedRevision !== revision
        || binding.scope.allowedOperation !== 'jira.issue.transition') return [];
      const pullRequest = observedPullRequest(entry)?.number;
      if (!Number.isSafeInteger(pullRequest) || pullRequest! < 1) return [];
      return [{ key: instructionKey(instruction, revision, pullRequest!), instruction, binding, revision }];
    });
  }

  private sameEntries<T extends { key: string }>(left: readonly T[], right: readonly T[]): T[] {
    const available = new Set(right.map((entry) => entry.key));
    return left.filter((entry) => available.has(entry.key));
  }

  private async sign(entry: { key: string; instruction: Extract<DeliverySyncInstruction, { kind: 'transition' }>; binding: DeliveryActionBinding; revision: string }): Promise<unknown | undefined> {
    const request = {
      format: 'faktori.action-request/v1' as const,
      actionId: entry.instruction.id,
      idempotencyKey: idempotencyKey(entry.key),
      runId: entry.binding.runId,
      scope: structuredClone(entry.binding.scope),
      authorityEpoch: entry.binding.authorityEpoch,
      requestedAt: entry.binding.requestedAt,
    };
    const signed = await entry.binding.signer.sign(request);
    return requestMatches(signed, request) ? signed : undefined;
  }
}

/**
 * Production construction path: the final evidence gate is wired here, not
 * optionally left to an installer. Reuses existing grants/journal/authority;
 * no grant is minted and no verifier is read outside action admission.
 */
export function createDeliveryTransitionController(options: {
  observe: DeliveryTransitionComposerOptions['observe'];
  policy: DeliverySyncPolicy;
  bindings: readonly DeliveryActionBinding[];
  actions: Omit<ActionControllerOptions, 'executor'>;
  jira: Pick<JiraRestExecutorOptions, 'client' | 'authorizationHeader'>;
}): Pick<DeliveryTransitionComposer, 'synchronize'> {
  const resolver = new DeliveryTransitionOperationResolver();
  let composer: DeliveryTransitionComposer;
  const executor = new JiraRestActionExecutor({ ...options.jira,
    operationFor: action => resolver.operationFor(action), transitions: resolver.transitions,
    beforeWrite: (action, operation) => composer.validateBeforeWrite(action, operation),
  });
  const admission = new ControllerActionAdmission({ ...options.actions, executor });
  composer = new DeliveryTransitionComposer({ observe: options.observe, policy: options.policy, bindings: options.bindings, admission, resolver });
  return { synchronize: () => composer.synchronize() };
}
