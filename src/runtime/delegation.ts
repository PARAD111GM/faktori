import { createHash } from 'node:crypto';
import { normalize } from 'node:path';

import type { ProviderFinalResult, QueuedMessage, RunIntent, RunSnapshot, WorkerIdentity } from './contracts.ts';
import { isTerminalRunState } from './contracts.ts';
import type { DurableCoordinator } from './coordinator.ts';

export type DelegationOwnershipMode = 'exclusive' | 'serialized';

/**
 * The only shape accepted from a provider turn.  It deliberately contains no
 * target, authority, execution profile, reservation, or publisher material:
 * those values are copied from the admitted parent or supplied by the trusted
 * allocator below.
 */
export interface DelegationRequest {
  format: 'faktori.delegation-request/v1';
  delegationId: string;
  parentRunId: string;
  workstreamId: string;
  ownership: {
    paths: string[];
    mode: DelegationOwnershipMode;
    /** Exact prior delegation ids which this request is allowed to wait behind. */
    serializedAfter?: string[];
  };
  artifactReferences?: Array<{ artifactId: string; digest: string }>;
  message?: string;
}

export interface ChildAllocation {
  workspaceId: string;
  workspacePath: string;
  profile: RunIntent['execution']['profile'];
  providerId: string;
  model: string;
  maxRuntimeMinutes: number;
  estimatedTokens: number;
}

export interface DelegationEnvelope {
  format: 'faktori.delegation-envelope/v1';
  kind: 'child.initial' | 'child.message' | 'child.result';
  delegationId: string;
  parentRunId: string;
  childRunId: string;
  workstreamId: string;
  ownership: { paths: string[]; mode: DelegationOwnershipMode; serializedAfter: string[] };
  artifactReferences: Array<{ artifactId: string; digest: string }>;
  payloadDigest: string;
  message?: string;
  result?: ProviderFinalResult;
}

export interface DelegatedChild {
  delegationId: string;
  parentRunId: string;
  childRunId: string;
  envelope: DelegationEnvelope;
  snapshot: RunSnapshot;
}

export interface ChildAdmissionResult {
  accepted: boolean;
  child?: DelegatedChild;
  reason?: string;
}

export interface ChildCancellationResult {
  childRunId: string;
  delegationId: string;
  state: 'cancelled_before_launch' | 'termination_requested' | 'surviving_identity';
  worker?: WorkerIdentity;
}

export class DelegationPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationPreconditionError';
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  const record = object(value);
  if (record === undefined) return value;
  return Object.fromEntries(Object.entries(record)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, withoutUndefined(item)]));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new DelegationPreconditionError(`${field} must be a bounded non-empty string`);
  return value;
}

function path(value: unknown): string {
  const candidate = text(value, 'ownership path', 512);
  if (candidate.startsWith('/') || candidate.includes('\\') || candidate.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new DelegationPreconditionError('ownership paths must be normalized repository-relative paths');
  }
  return candidate;
}

function parseRequest(value: unknown): DelegationRequest {
  const input = object(value);
  if (input?.format !== 'faktori.delegation-request/v1') throw new DelegationPreconditionError('delegation request format is required');
  const ownership = object(input.ownership);
  if (ownership === undefined) throw new DelegationPreconditionError('ownership is required');
  const mode = ownership?.mode;
  if (mode !== 'exclusive' && mode !== 'serialized') throw new DelegationPreconditionError('ownership mode must be exclusive or serialized');
  if (!Array.isArray(ownership.paths) || ownership.paths.length === 0 || ownership.paths.length > 64) throw new DelegationPreconditionError('ownership paths must be a bounded non-empty list');
  const paths = [...new Set(ownership.paths.map(path))].sort();
  const serializedAfter = ownership.serializedAfter === undefined ? [] : ownership.serializedAfter;
  if (!Array.isArray(serializedAfter) || serializedAfter.length > 64) throw new DelegationPreconditionError('serializedAfter must be a bounded list');
  const parsedSerializedAfter = [...new Set(serializedAfter.map((item) => text(item, 'serializedAfter item'))) ].sort();
  if (mode === 'exclusive' && parsedSerializedAfter.length > 0) throw new DelegationPreconditionError('exclusive ownership cannot declare serialized predecessors');
  const rawArtifacts = input.artifactReferences === undefined ? [] : input.artifactReferences;
  if (!Array.isArray(rawArtifacts) || rawArtifacts.length > 64) throw new DelegationPreconditionError('artifact references must be a bounded list');
  const artifactReferences = rawArtifacts.map((item) => {
    const artifact = object(item);
    return { artifactId: text(artifact?.artifactId, 'artifact id'), digest: text(artifact?.digest, 'artifact digest', 512) };
  });
  const uniqueArtifacts = new Set(artifactReferences.map((artifact) => `${artifact.artifactId}\u0000${artifact.digest}`));
  if (uniqueArtifacts.size !== artifactReferences.length) throw new DelegationPreconditionError('artifact references must not repeat');
  const message = input.message === undefined ? undefined : text(input.message, 'delegation message', 16_000);
  return {
    format: 'faktori.delegation-request/v1',
    delegationId: text(input.delegationId, 'delegation id'),
    parentRunId: text(input.parentRunId, 'parent run id'),
    workstreamId: text(input.workstreamId, 'workstream id'),
    ownership: { paths, mode, serializedAfter: parsedSerializedAfter },
    artifactReferences,
    message,
  };
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function envelopeFrom(value: unknown): DelegationEnvelope | undefined {
  const record = object(value);
  if (record?.format !== 'faktori.delegation-envelope/v1'
    || (record.kind !== 'child.initial' && record.kind !== 'child.message' && record.kind !== 'child.result')
    || typeof record.delegationId !== 'string' || typeof record.parentRunId !== 'string'
    || typeof record.childRunId !== 'string' || typeof record.workstreamId !== 'string'
    || typeof record.payloadDigest !== 'string') return undefined;
  const ownership = object(record.ownership);
  if (ownership === undefined || (ownership.mode !== 'exclusive' && ownership.mode !== 'serialized')
    || !Array.isArray(ownership.paths) || !ownership.paths.every((item) => typeof item === 'string')
    || !Array.isArray(ownership.serializedAfter) || !ownership.serializedAfter.every((item) => typeof item === 'string')
    || !Array.isArray(record.artifactReferences)) return undefined;
  const references = record.artifactReferences.map((item) => object(item)).filter((item): item is Record<string, unknown> => item !== undefined);
  if (references.length !== record.artifactReferences.length || !references.every((item) => typeof item.artifactId === 'string' && typeof item.digest === 'string')) return undefined;
  return record as unknown as DelegationEnvelope;
}

function messageEnvelope(event: { kind: string; data: Record<string, unknown> }): DelegationEnvelope | undefined {
  if (event.kind !== 'message.queued') return undefined;
  const message = object(event.data.message);
  if (message === undefined || typeof message.body !== 'string') return undefined;
  try { return envelopeFrom(JSON.parse(message.body)); } catch { return undefined; }
}

/**
 * Coordinator-admitted child work without a second scheduler.  The caller
 * supplies allocation policy from trusted configuration; provider payloads are
 * treated as labels and references only.
 */
export class DurableDelegationService {
  readonly #coordinator: DurableCoordinator;
  readonly #allocate: (parent: RunSnapshot, request: DelegationRequest, childRunId: string) => ChildAllocation | Promise<ChildAllocation>;
  readonly #authorizeSerialization: (parent: RunSnapshot, request: DelegationRequest, conflicting: DelegatedChild) => boolean | Promise<boolean>;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: {
    coordinator: DurableCoordinator;
    allocate: (parent: RunSnapshot, request: DelegationRequest, childRunId: string) => ChildAllocation | Promise<ChildAllocation>;
    authorizeSerialization?: (parent: RunSnapshot, request: DelegationRequest, conflicting: DelegatedChild) => boolean | Promise<boolean>;
  }) {
    this.#coordinator = options.coordinator;
    this.#allocate = options.allocate;
    this.#authorizeSerialization = options.authorizeSerialization ?? (() => false);
  }

  async admit(value: unknown): Promise<ChildAdmissionResult> {
    return this.serial(() => this.admitExclusive(parseRequest(value)));
  }

  /** Queue an exactly-scoped child message. Duplicate content is replay-safe. */
  async message(parentRunId: string, childRunId: string, message: string): Promise<void> {
    return this.serial(async () => {
      const child = this.requireChild(parentRunId, childRunId);
      const parent = this.requireActiveParent(parentRunId);
      const envelope = this.withDigest({ ...child.envelope, kind: 'child.message' as const, message: text(message, 'child message', 16_000), result: undefined });
      await this.queueOnce(childRunId, envelope, `delegation-message-${childRunId}-${envelope.payloadDigest}`);
      // Keep the parent read in this operation: cancellation/revocation blocks
      // stale callers before their child receives further work.
      void parent;
    });
  }

  /**
   * Persists a child result as a provider event before queuing its parent
   * handoff.  A restart can replay the second half from the durable event.
   */
  async handoff(parentRunId: string, childRunId: string, artifacts: Array<{ artifactId: string; digest: string }> = []): Promise<void> {
    return this.serial(() => this.handoffExclusive(parentRunId, childRunId, artifacts));
  }

  /** Replay child result submissions which made it to the journal before a crash. */
  async recoverHandoffs(parentRunId: string): Promise<void> {
    return this.serial(async () => {
      this.requireActiveParent(parentRunId);
      for (const child of this.children(parentRunId)) {
        const submitted = this.submittedResult(child.childRunId);
        if (submitted !== undefined) await this.forwardSubmittedResult(child, submitted);
      }
    });
  }

  /** A serialized child must not be delivered until all its named predecessors are terminal. */
  canLaunch(parentRunId: string, childRunId: string): boolean {
    const child = this.requireChild(parentRunId, childRunId);
    return child.envelope.ownership.serializedAfter.every((delegationId) => {
      const predecessor = this.children(parentRunId).find((candidate) => candidate.delegationId === delegationId);
      return predecessor !== undefined && isTerminalRunState(predecessor.snapshot.state);
    });
  }

  /**
   * Parent cancellation must already have revoked publication.  Each surviving
   * child is identified from its admitted durable run before a terminate hook
   * can be called; unstarted children are cancelled without inventing a worker.
   */
  async reconcileCancelledParent(
    parentRunId: string,
    terminate?: (child: DelegatedChild & { worker: WorkerIdentity }) => Promise<void>,
  ): Promise<ChildCancellationResult[]> {
    return this.serial(async () => {
      const parent = this.#coordinator.snapshot(parentRunId);
      if (parent === undefined || !parent.authorityRevoked) throw new DelegationPreconditionError('parent publication authority must be revoked before child cancellation');
      const results: ChildCancellationResult[] = [];
      for (const child of this.children(parentRunId)) {
        if (isTerminalRunState(child.snapshot.state)) continue;
        if (!child.snapshot.authorityRevoked) {
          await this.#coordinator.record('authority.revoked', child.childRunId, {
            epoch: child.snapshot.authorityEpoch + 1,
            reason: 'parent_cancelled',
            parentRunId,
          });
        }
        if (child.snapshot.worker === undefined) {
          await this.#coordinator.record('provider.final', child.childRunId, {
            result: { outcome: 'cancelled', summary: 'parent cancelled before child worker launch', usage: { availability: 'unavailable', unavailableReason: 'not launched' }, nativeCancellationReceipt: false },
          });
          await this.#coordinator.record('reservation.released', child.childRunId, { status: 'released', reason: 'parent_cancelled_before_launch' });
          results.push({ childRunId: child.childRunId, delegationId: child.delegationId, state: 'cancelled_before_launch' });
          continue;
        }
        if (terminate === undefined) {
          results.push({ childRunId: child.childRunId, delegationId: child.delegationId, state: 'surviving_identity', worker: child.snapshot.worker });
          continue;
        }
        await terminate({ ...child, worker: child.snapshot.worker });
        results.push({ childRunId: child.childRunId, delegationId: child.delegationId, state: 'termination_requested', worker: child.snapshot.worker });
      }
      return results;
    });
  }

  private async admitExclusive(request: DelegationRequest): Promise<ChildAdmissionResult> {
    const parent = this.requireActiveParent(request.parentRunId);
    if (request.artifactReferences?.some((artifact) => !this.artifactAllowedForParent(parent, artifact))) {
      return { accepted: false, reason: 'artifact_reference_not_approved_for_parent' };
    }
    const existing = this.children(request.parentRunId).find((child) => child.delegationId === request.delegationId);
    if (existing !== undefined) {
      const expected = this.initialDigest(request, existing.childRunId);
      if (existing.envelope.payloadDigest !== expected) return { accepted: false, reason: 'delegation_id_conflicts_with_existing_request' };
      return { accepted: true, child: existing };
    }
    const childRunId = `delegated-${digest({ parentRunId: request.parentRunId, delegationId: request.delegationId })}`;
    const envelope = this.withDigest({
      format: 'faktori.delegation-envelope/v1', kind: 'child.initial', delegationId: request.delegationId,
      parentRunId: request.parentRunId, childRunId, workstreamId: request.workstreamId,
      ownership: { paths: request.ownership.paths, mode: request.ownership.mode, serializedAfter: request.ownership.serializedAfter ?? [] },
      artifactReferences: request.artifactReferences ?? [],
      message: request.message,
    });
    // Admission is durable before its initial message.  If the process died in
    // that tiny interval, recover the exact coordinator intent without calling
    // allocation again (which may legitimately have changed in memory).
    const alreadyAdmitted = this.#coordinator.snapshot(childRunId);
    if (alreadyAdmitted !== undefined) {
      const expectedKey = `delegation:${request.parentRunId}:${request.delegationId}:${envelope.payloadDigest}`;
      if (alreadyAdmitted.intent.admissionKey !== expectedKey) return { accepted: false, reason: 'child_run_id_conflicts_with_existing_intent' };
      await this.queueOnce(childRunId, envelope, `delegation-initial-${childRunId}-${envelope.payloadDigest}`);
      return { accepted: true, child: { delegationId: request.delegationId, parentRunId: request.parentRunId, childRunId, envelope, snapshot: alreadyAdmitted } };
    }
    const siblings = this.children(request.parentRunId);
    if (request.ownership.mode === 'serialized' && (request.ownership.serializedAfter ?? []).some((delegationId) => !siblings.some((child) => child.delegationId === delegationId))) {
      return { accepted: false, reason: 'serialized_predecessor_is_not_a_durable_sibling' };
    }
    const conflicting = siblings.filter((child) => !isTerminalRunState(child.snapshot.state)
      && overlaps(request.ownership.paths, child.envelope.ownership.paths));
    for (const child of conflicting) {
      const named = request.ownership.mode === 'serialized' && request.ownership.serializedAfter?.includes(child.delegationId) === true;
      if (!named || !await this.#authorizeSerialization(parent, request, child)) return { accepted: false, reason: 'ownership_conflicts_with_active_child' };
    }
    const allocation = await this.#allocate(parent, request, childRunId);
    const workspacePath = this.validateAllocation(parent, allocation);
    for (const child of siblings.filter((item) => !isTerminalRunState(item.snapshot.state))) {
      const shared = child.snapshot.intent.execution.workspaceId === allocation.workspaceId;
      const sharedPath = normalize(child.snapshot.intent.execution.workspacePath) === workspacePath;
      if (!shared && !sharedPath) continue;
      const named = request.ownership.mode === 'serialized' && request.ownership.serializedAfter?.includes(child.delegationId) === true;
      if (!named || !await this.#authorizeSerialization(parent, request, child)) {
        return { accepted: false, reason: sharedPath ? 'workspace_path_conflicts_with_active_child' : 'workspace_conflicts_with_active_child' };
      }
    }
    const intent: RunIntent = {
      format: 'faktori.run-intent/v1', runId: childRunId,
      admissionKey: `delegation:${request.parentRunId}:${request.delegationId}:${envelope.payloadDigest}`,
      workItem: { id: `delegation:${request.workstreamId}`, revision: parent.intent.workItem.revision },
      target: { ...parent.intent.target }, context: { ...parent.intent.context },
      execution: {
        profile: allocation.profile, workspaceId: allocation.workspaceId, workspacePath,
        providerId: allocation.providerId, model: allocation.model,
        // A handoff digest enters the child only after its exact artifact pair
        // has been durably submitted by a prior child and forwarded to this
        // parent.  This is not an authority grant from the new child payload.
        approvedInputDigests: [...new Set([...parent.intent.execution.approvedInputDigests, ...(request.artifactReferences ?? []).map((artifact) => artifact.digest)])],
      },
      budget: { reservationId: `delegation:${childRunId}`, maxRuntimeMinutes: allocation.maxRuntimeMinutes, estimatedTokens: allocation.estimatedTokens, status: 'held' },
      authority: { ...parent.intent.authority, policy: { ...parent.intent.authority.policy } }, attempt: 1,
      // This is derived from the parent rather than wall-clock time so a
      // restart between admission and its initial durable message can replay
      // the exact coordinator intent.
      createdAt: parent.intent.createdAt,
    };
    const admitted = await this.#coordinator.admit(intent);
    if (!admitted.accepted || admitted.snapshot === undefined) return { accepted: false, reason: admitted.reason };
    await this.queueOnce(childRunId, envelope, `delegation-initial-${childRunId}-${envelope.payloadDigest}`);
    return { accepted: true, child: { delegationId: request.delegationId, parentRunId: request.parentRunId, childRunId, envelope, snapshot: this.#coordinator.snapshot(childRunId) as RunSnapshot } };
  }

  private async handoffExclusive(parentRunId: string, childRunId: string, artifacts: Array<{ artifactId: string; digest: string }>): Promise<void> {
    this.requireActiveParent(parentRunId);
    const child = this.requireChild(parentRunId, childRunId);
    if (child.snapshot.providerResult === undefined || !isTerminalRunState(child.snapshot.state)) throw new DelegationPreconditionError('child has no durable final result to hand off');
    const references = parseRequest({ ...this.asRequest(child.envelope), artifactReferences: artifacts }).artifactReferences ?? [];
    const submitted = this.withDigest({ ...child.envelope, kind: 'child.result' as const, artifactReferences: references, result: child.snapshot.providerResult, message: undefined });
    const prior = this.submittedResult(childRunId);
    if (prior !== undefined && prior.payloadDigest !== submitted.payloadDigest) throw new DelegationPreconditionError('child result was already submitted with conflicting artifact handoff');
    if (prior === undefined) await this.#coordinator.record('provider.event', childRunId, { type: 'delegation.result-submitted', event: submitted });
    await this.forwardSubmittedResult(child, submitted);
  }

  private async forwardSubmittedResult(child: DelegatedChild, submitted: DelegationEnvelope): Promise<void> {
    this.requireActiveParent(child.parentRunId);
    const parentMessage = this.withDigest({ ...submitted, kind: 'child.result' as const });
    await this.queueOnce(child.parentRunId, parentMessage, `delegation-result-${child.childRunId}-${parentMessage.payloadDigest}`);
  }

  private submittedResult(childRunId: string): DelegationEnvelope | undefined {
    const submitted = this.#coordinator.journal.events()
      .filter((event) => event.runId === childRunId && event.kind === 'provider.event' && event.data.type === 'delegation.result-submitted')
      .map((event) => envelopeFrom(event.data.event))
      .filter((event): event is DelegationEnvelope => event !== undefined);
    if (submitted.length === 0) return undefined;
    if (submitted.some((item) => item.kind !== 'child.result' || item.payloadDigest !== submitted[0]?.payloadDigest)) {
      throw new DelegationPreconditionError('conflicting durable result submissions for delegated child');
    }
    return submitted[0];
  }

  private artifactAllowedForParent(parent: RunSnapshot, artifact: { artifactId: string; digest: string }): boolean {
    // RunIntent presently represents owner-approved input material by digest,
    // so the parent-origin branch cannot carry an artifact id to compare. New
    // child-produced material requires the stronger id-and-digest pairing.
    if (parent.intent.execution.approvedInputDigests.includes(artifact.digest)) return true;
    for (const event of this.#coordinator.journal.events()) {
      if (event.runId !== parent.intent.runId) continue;
      const forwarded = messageEnvelope(event);
      if (forwarded?.kind !== 'child.result' || forwarded.parentRunId !== parent.intent.runId) continue;
      if (!forwarded.artifactReferences.some((candidate) => candidate.artifactId === artifact.artifactId && candidate.digest === artifact.digest)) continue;
      const submitted = this.submittedResult(forwarded.childRunId);
      if (submitted !== undefined && submitted.parentRunId === parent.intent.runId && submitted.payloadDigest === forwarded.payloadDigest
        && submitted.artifactReferences.some((candidate) => candidate.artifactId === artifact.artifactId && candidate.digest === artifact.digest)) return true;
    }
    return false;
  }

  private children(parentRunId: string): DelegatedChild[] {
    const output: DelegatedChild[] = [];
    for (const event of this.#coordinator.journal.events()) {
      const envelope = messageEnvelope(event);
      if (envelope?.kind !== 'child.initial' || envelope.parentRunId !== parentRunId || envelope.childRunId !== event.runId) continue;
      const snapshot = this.#coordinator.snapshot(event.runId);
      if (snapshot !== undefined) output.push({ delegationId: envelope.delegationId, parentRunId, childRunId: event.runId, envelope, snapshot });
    }
    const unique = new Map<string, DelegatedChild>();
    for (const child of output) {
      const prior = unique.get(child.childRunId);
      if (prior !== undefined && stable(prior.envelope) !== stable(child.envelope)) throw new DelegationPreconditionError('conflicting durable child admission envelope');
      unique.set(child.childRunId, child);
    }
    return [...unique.values()];
  }

  private requireChild(parentRunId: string, childRunId: string): DelegatedChild {
    const child = this.children(parentRunId).find((item) => item.childRunId === childRunId);
    if (child === undefined) throw new DelegationPreconditionError('child is not durably attributed to the requested parent');
    return child;
  }

  private requireActiveParent(parentRunId: string): RunSnapshot {
    const parent = this.#coordinator.snapshot(parentRunId);
    if (parent === undefined) throw new DelegationPreconditionError('parent run is not admitted');
    if (parent.authorityRevoked || isTerminalRunState(parent.state)) throw new DelegationPreconditionError('parent cannot delegate after revocation or terminal completion');
    return parent;
  }

  private validateAllocation(parent: RunSnapshot, allocation: ChildAllocation): string {
    text(allocation.workspaceId, 'trusted workspace id');
    text(allocation.workspacePath, 'trusted workspace path', 4096);
    text(allocation.providerId, 'trusted provider id');
    text(allocation.model, 'trusted model');
    if (allocation.workspaceId === parent.intent.execution.workspaceId) throw new DelegationPreconditionError('concurrent child allocation cannot reuse the parent workspace');
    const workspacePath = normalize(allocation.workspacePath);
    if (workspacePath !== allocation.workspacePath) throw new DelegationPreconditionError('trusted workspace path must be normalized');
    if (workspacePath === normalize(parent.intent.execution.workspacePath)) throw new DelegationPreconditionError('concurrent child allocation cannot reuse the parent workspace path');
    if (!Number.isInteger(allocation.maxRuntimeMinutes) || allocation.maxRuntimeMinutes < 1 || !Number.isInteger(allocation.estimatedTokens) || allocation.estimatedTokens < 0) {
      throw new DelegationPreconditionError('trusted allocation has invalid bounded resource values');
    }
    return workspacePath;
  }

  private asRequest(envelope: DelegationEnvelope): DelegationRequest {
    return { format: 'faktori.delegation-request/v1', delegationId: envelope.delegationId, parentRunId: envelope.parentRunId,
      workstreamId: envelope.workstreamId, ownership: envelope.ownership, artifactReferences: envelope.artifactReferences };
  }

  private initialDigest(request: DelegationRequest, childRunId: string): string {
    return this.withDigest({
      format: 'faktori.delegation-envelope/v1', kind: 'child.initial', delegationId: request.delegationId,
      parentRunId: request.parentRunId, childRunId, workstreamId: request.workstreamId,
      ownership: { paths: request.ownership.paths, mode: request.ownership.mode, serializedAfter: request.ownership.serializedAfter ?? [] },
      artifactReferences: request.artifactReferences ?? [], message: request.message,
    }).payloadDigest;
  }

  private withDigest(value: Omit<DelegationEnvelope, 'payloadDigest'> & { payloadDigest?: string }): DelegationEnvelope {
    const without = withoutUndefined(value) as Record<string, unknown>;
    delete without.payloadDigest;
    return { ...without, payloadDigest: digest(without) } as DelegationEnvelope;
  }

  private async queueOnce(runId: string, envelope: DelegationEnvelope, messageId: string): Promise<void> {
    const body = stable(envelope);
    const prior = this.#coordinator.journal.events().find((event) => {
      if (event.runId !== runId || event.kind !== 'message.queued') return false;
      const message = object(event.data.message);
      return message?.messageId === messageId;
    });
    if (prior !== undefined) {
      const message = object(prior.data.message);
      if (message?.body !== body) throw new DelegationPreconditionError('durable delegation message id was reused with conflicting content');
      return;
    }
    const message: QueuedMessage = { messageId, runId, createdAt: new Date().toISOString(), delivery: 'next_turn', body };
    await this.#coordinator.queueMessage(message);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
