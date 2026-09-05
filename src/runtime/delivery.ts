import { createHash } from 'node:crypto';

import type {
  ProviderCurrentContext,
  ProviderRunResult,
  ProviderSessionBinding,
  ProviderTurnAdapter,
  ProviderTurnLifecycle,
  SupportedProviderId,
} from '../providers/contracts.ts';
import { providerContextIsAuthorized, providerContextPayloadDigest } from '../providers/contracts.ts';
import type { DurableEffectIntent, ProviderFinalResult, RunIntent, RunSnapshot, UsageTelemetry, WorkerIdentity } from './contracts.ts';
import { isTerminalRunState } from './contracts.ts';
import type { DurableCoordinator } from './coordinator.ts';

export interface ProviderDeliveryRequest {
  runId: string;
  context: ProviderCurrentContext;
  resume?: ProviderSessionBinding;
}

export interface ProviderDeliveryResult {
  status: 'delivered' | 'already_recorded';
  command: 'start' | 'resume';
  final: ProviderFinalResult;
}

export class DeliveryPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryPreconditionError';
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

/**
 * Canonical durable binding for a provider worker operation.  Prompt material
 * itself stays out of the journal; its canonical payload digest is included in
 * the signed-by-content request digest instead.
 */
export function providerDeliveryOperationRequestDigest(
  intent: RunIntent,
  currentContext: ProviderCurrentContext,
  command: 'start' | 'resume',
  sessionId: string | undefined,
): string {
  return digest({
    runId: intent.runId,
    command,
    sessionId,
    context: { ...intent.context, payloadDigest: providerContextPayloadDigest(currentContext) },
    execution: intent.execution,
    attempt: intent.attempt,
  });
}

function unavailable(outcome: ProviderFinalResult['outcome'], summary: string): ProviderFinalResult {
  return {
    outcome,
    summary,
    usage: { availability: 'unavailable', unavailableReason: summary },
    nativeCancellationReceipt: false,
  };
}

function usageStatus(usage: UsageTelemetry): 'consumed' | 'uncertain' {
  return usage.availability === 'reported' || usage.availability === 'partially_reported' ? 'consumed' : 'uncertain';
}

function isEffect(value: unknown): value is DurableEffectIntent {
  return value !== null && typeof value === 'object' && typeof (value as Partial<DurableEffectIntent>).operationId === 'string';
}

function isWorkerIdentity(value: unknown): value is WorkerIdentity {
  if (value === null || typeof value !== 'object') return false;
  const identity = value as Partial<WorkerIdentity>;
  if (identity.kind === 'native') {
    return typeof identity.pid === 'number' && typeof identity.processStartedAt === 'string'
      && typeof identity.processGroupId === 'number' && typeof identity.runNonce === 'string';
  }
  return identity.kind === 'container' && typeof identity.containerId === 'string'
    && typeof identity.containerStartedAt === 'string' && typeof identity.runNonce === 'string';
}

/**
 * Coordinator-owned bridge between an admitted durable run and the Codex
 * adapter. It does not provide action authority and it never turns an absent
 * receipt into a success.
 */
export class CoordinatorProviderDelivery {
  readonly #coordinator: DurableCoordinator;
  readonly #adapter: ProviderTurnAdapter;
  readonly #providerId: SupportedProviderId;
  readonly #terminateWorker: (worker: WorkerIdentity, reason: string) => Promise<void>;
  #tails = new Map<string, { requestDigest: string; result: Promise<ProviderDeliveryResult> }>();

  constructor(options: {
    coordinator: DurableCoordinator;
    adapter: ProviderTurnAdapter;
    providerId: SupportedProviderId;
    terminateWorker: (worker: WorkerIdentity, reason: string) => Promise<void>;
  }) {
    this.#coordinator = options.coordinator;
    this.#adapter = options.adapter;
    this.#providerId = options.providerId;
    this.#terminateWorker = options.terminateWorker;
  }

  async deliver(request: ProviderDeliveryRequest): Promise<ProviderDeliveryResult> {
    const requestDigest = this.deliveryRequestDigest(request);
    const previous = this.#tails.get(request.runId);
    if (previous !== undefined) {
      if (previous.requestDigest !== requestDigest) {
        throw new DeliveryPreconditionError(`Run ${request.runId} already has an active ${this.providerLabel()} delivery with conflicting executed content`);
      }
      return previous.result;
    }
    const run = this.deliverExclusive(request);
    this.#tails.set(request.runId, { requestDigest, result: run });
    try {
      return await run;
    } finally {
      if (this.#tails.get(request.runId)?.result === run) this.#tails.delete(request.runId);
    }
  }

  /** Explicitly cancels only the currently delivering worker for this run. */
  async cancel(runId: string): Promise<ProviderFinalResult> {
    const activeDelivery = this.#tails.get(runId);
    if (activeDelivery === undefined) throw new DeliveryPreconditionError(`Run ${runId} has no active ${this.providerLabel()} delivery to cancel`);
    const snapshot = this.#coordinator.snapshot(runId);
    if (snapshot === undefined || snapshot.worker === undefined) throw new DeliveryPreconditionError(`Run ${runId} has no durable active worker identity`);
    if (snapshot.authorityRevoked) throw new DeliveryPreconditionError(`Run ${runId} authority is already revoked`);
    if (this.#adapter.cancel === undefined) throw new DeliveryPreconditionError(`${this.#providerId} adapter does not expose explicit cancellation`);
    const expectedWorker = stable(snapshot.worker);
    let authorized = false;
    const result = await this.#adapter.cancel(snapshot.intent, {
      async onStarted(): Promise<void> {
        throw new DeliveryPreconditionError('Cancellation cannot start another worker');
      },
      onTerminationRequired: async (worker, reason): Promise<void> => {
        if (reason !== 'cancelled' || stable(worker) !== expectedWorker) {
          throw new DeliveryPreconditionError('Cancellation worker identity does not match the durable active run');
        }
        await this.#terminateWorker(worker, reason);
        authorized = true;
      },
    });
    if (!authorized || !snapshot.worker) {
      return unavailable('interrupted_uncertain', 'Codex cancellation was not authorized by the durable worker boundary');
    }
    // The provider turn owns the process wait. Do not report the owner cancel
    // complete until that delivery has observed and journaled its terminal
    // result; the durable termination receipt can then be appended last.
    await activeDelivery.result;
    return result;
  }

  private async deliverExclusive(request: ProviderDeliveryRequest): Promise<ProviderDeliveryResult> {
    const snapshot = this.exactSnapshot(request, true);
    const command = request.resume === undefined ? 'start' : 'resume';
    const sessionId = command === 'resume' ? this.requireResumeBinding(snapshot.intent, request.resume as ProviderSessionBinding) : undefined;
    const operation = this.operation(snapshot.intent, request.context, command, sessionId);
    const replay = this.priorDelivery(snapshot.intent.runId, operation);
    if (replay !== undefined) return replay;
    if (isTerminalRunState(snapshot.state)) throw new DeliveryPreconditionError(`Run ${request.runId} is terminal and cannot receive a Codex turn`);
    if (snapshot.authorityRevoked) throw new DeliveryPreconditionError(`Run ${request.runId} authority is revoked`);

    await this.#coordinator.recordEffectIntent(snapshot.intent.runId, operation);
    let observedWorker = false;
    let observedWorkerIdentity: string | undefined;
    const lifecycle: ProviderTurnLifecycle = {
      onStarted: async (worker): Promise<void> => {
        if (observedWorker) throw new DeliveryPreconditionError(`${this.#providerId} delivery operation ${operation.operationId} reported more than one worker identity`);
        if (!isWorkerIdentity(worker)) throw new DeliveryPreconditionError(`${this.#providerId} transport did not report an exact worker identity`);
        await this.#coordinator.recordEffectReceipt(snapshot.intent.runId, {
          operationId: operation.operationId,
          observedAt: new Date().toISOString(),
          outcome: 'completed',
        });
        await this.#coordinator.record('worker.started', snapshot.intent.runId, { worker, operationId: operation.operationId });
        observedWorker = true;
        observedWorkerIdentity = stable(worker);
      },
      onTerminationRequired: async (worker, reason): Promise<void> => {
        if (!isWorkerIdentity(worker)) throw new DeliveryPreconditionError(`${this.#providerId} transport requested termination for an unproven worker identity`);
        if (!observedWorker || observedWorkerIdentity !== stable(worker)) throw new DeliveryPreconditionError(`${this.#providerId} transport requested termination for a worker other than the recorded worker`);
        await this.#terminateWorker(worker, reason);
      },
    };
    try {
      const result = command === 'start'
        ? await this.#adapter.start(snapshot.intent, request.context, lifecycle)
        : await this.#adapter.resume(snapshot.intent, request.resume as ProviderSessionBinding, request.context, lifecycle);
      if (!observedWorker) {
        await this.recordLifecycleFailure(snapshot.intent.runId, operation, `${this.#providerId} transport returned without an exact worker-start callback`);
        return this.finalize(snapshot.intent.runId, command, unavailable('interrupted_uncertain', `${this.#providerId} transport returned without an exact worker-start callback`));
      }
      for (const event of result.events) {
        await this.#coordinator.record('provider.event', snapshot.intent.runId, {
          command,
          type: event.type,
          event: event.raw,
        });
      }
      return this.finalize(snapshot.intent.runId, command, result.final);
    } catch {
      if (!observedWorker) await this.recordLifecycleFailure(snapshot.intent.runId, operation, `${this.#providerId} transport failed before an exact worker-start callback`);
      return this.finalize(snapshot.intent.runId, command, unavailable('interrupted_uncertain', `${this.#providerId} transport failed after launch intent; provider outcome is unknown`));
    }
  }

  private exactSnapshot(request: ProviderDeliveryRequest, allowPriorReplay = false): RunSnapshot {
    const snapshot = this.#coordinator.snapshot(request.runId);
    if (snapshot === undefined) throw new DeliveryPreconditionError(`Run ${request.runId} was not admitted`);
    if (!allowPriorReplay && isTerminalRunState(snapshot.state)) throw new DeliveryPreconditionError(`Run ${request.runId} is terminal and cannot receive a Codex turn`);
    if (!allowPriorReplay && snapshot.authorityRevoked) throw new DeliveryPreconditionError(`Run ${request.runId} authority is revoked`);
    if (snapshot.intent.execution.providerId !== this.#providerId) throw new DeliveryPreconditionError(`Run ${request.runId} is not assigned to ${this.#providerId}`);
    if (request.context.packetRevision !== snapshot.intent.context.packetRevision || request.context.digest !== snapshot.intent.context.digest) {
      throw new DeliveryPreconditionError(`Run ${request.runId} current context does not match the admitted packet revision and digest`);
    }
    if (request.context.prompt.trim().length === 0) throw new DeliveryPreconditionError(`Current ${this.#providerId} context prompt is required`);
    if (!providerContextIsAuthorized(snapshot.intent, request.context)) {
      throw new DeliveryPreconditionError(`Run ${request.runId} does not authorize the exact ${this.#providerId} prompt and context payload`);
    }
    return snapshot;
  }

  private requireResumeBinding(target: RunIntent, binding: ProviderSessionBinding): string {
    if (binding.sessionId.trim().length === 0) throw new DeliveryPreconditionError(`${this.#providerId} resume requires an explicit session binding`);
    const source = this.#coordinator.snapshot(binding.sourceRunId);
    if (source === undefined || source.providerResult === undefined || source.providerResult.sessionId !== binding.sessionId) {
      throw new DeliveryPreconditionError(`${this.#providerId} resume session is not proven by a durable source provider final record`);
    }
    if (source.intent.context.packetRevision !== binding.sourceContext.packetRevision || source.intent.context.digest !== binding.sourceContext.digest) {
      throw new DeliveryPreconditionError(`${this.#providerId} resume source context binding does not match durable source intent`);
    }
    const durableScope = {
      factoryId: source.intent.target.factoryId,
      productId: source.intent.target.productId,
      repository: source.intent.target.repository,
      workspaceId: source.intent.execution.workspaceId,
      workspacePath: source.intent.execution.workspacePath,
      providerId: source.intent.execution.providerId,
    };
    if (stable(binding.sourceScope) !== stable(durableScope)) {
      throw new DeliveryPreconditionError(`${this.#providerId} resume source scope does not match the durable source intent`);
    }
    const targetScope = {
      factoryId: target.target.factoryId,
      productId: target.target.productId,
      repository: target.target.repository,
      workspaceId: target.execution.workspaceId,
      workspacePath: target.execution.workspacePath,
      providerId: target.execution.providerId,
    };
    if (stable(durableScope) !== stable(targetScope)) {
      throw new DeliveryPreconditionError(`${this.#providerId} resume cannot cross its recorded factory, product, repository, workspace, or provider scope`);
    }
    return binding.sessionId;
  }

  private operation(intent: RunIntent, currentContext: ProviderCurrentContext, command: 'start' | 'resume', sessionId: string | undefined): DurableEffectIntent {
    // Persist only the digest of private prompt contents, while binding the
    // worker effect to precisely what the adapter will execute.
    const requestDigest = providerDeliveryOperationRequestDigest(intent, currentContext, command, sessionId);
    return {
      operationId: `${this.#providerId}-turn-${requestDigest}`,
      kind: command === 'start' ? 'worker.launch' : 'worker.resume',
      identityKey: digest({ runId: intent.runId, workspaceId: intent.execution.workspaceId, providerId: this.#providerId }),
      requestedAt: new Date().toISOString(),
      requestDigest,
    };
  }

  private priorDelivery(runId: string, operation: DurableEffectIntent): ProviderDeliveryResult | undefined {
    const effects = this.#coordinator.journal.events().filter((event) => event.runId === runId && event.kind === 'effect.intended');
    let prior: DurableEffectIntent | undefined;
    for (const event of effects) {
      const effect = event.data.effect;
      if (isEffect(effect) && effect.operationId === operation.operationId) {
        prior = effect;
        break;
      }
    }
    if (prior === undefined) return undefined;
    // requestedAt differs on replay; operation identity is the digest-bound
    // semantic key. Any other changed field is a fail-closed reuse.
    if (prior.kind !== operation.kind || prior.identityKey !== operation.identityKey || prior.requestDigest !== operation.requestDigest) {
      throw new DeliveryPreconditionError(`${this.#providerId} delivery operation ${operation.operationId} was reused with conflicting content`);
    }
    const snapshot = this.#coordinator.snapshot(runId);
    if (snapshot?.providerResult === undefined) {
      throw new DeliveryPreconditionError(`${this.#providerId} delivery operation ${operation.operationId} is unresolved and cannot be retried`);
    }
    return { status: 'already_recorded', command: operation.kind === 'worker.resume' ? 'resume' : 'start', final: snapshot.providerResult };
  }

  private async recordLifecycleFailure(runId: string, operation: DurableEffectIntent, detail: string): Promise<void> {
    await this.#coordinator.recordEffectReceipt(runId, {
      operationId: operation.operationId,
      observedAt: new Date().toISOString(),
      outcome: 'uncertain',
      detail,
    });
  }

  private async finalize(runId: string, command: 'start' | 'resume', final: ProviderFinalResult): Promise<ProviderDeliveryResult> {
    await this.#coordinator.record('usage.observed', runId, { usage: final.usage, source: this.#providerId });
    await this.#coordinator.record('provider.final', runId, { result: final, command });
    await this.#coordinator.record('reservation.released', runId, { status: usageStatus(final.usage), reason: 'provider_final_usage_telemetry' });
    return { status: 'delivered', command, final };
  }

  private providerLabel(): string {
    return `${this.#providerId[0]?.toUpperCase() ?? ''}${this.#providerId.slice(1)}`;
  }

  private deliveryRequestDigest(request: ProviderDeliveryRequest): string {
    return digest({
      runId: request.runId,
      context: {
        packetRevision: request.context.packetRevision,
        digest: request.context.digest,
        payloadDigest: providerContextPayloadDigest(request.context),
      },
      ...(request.resume === undefined ? {} : { resume: request.resume }),
    });
  }
}

/** Phase 2 compatibility surface; new providers use CoordinatorProviderDelivery directly. */
export class CoordinatorCodexDelivery extends CoordinatorProviderDelivery {
  constructor(options: {
    coordinator: DurableCoordinator;
    adapter: ProviderTurnAdapter;
    terminateWorker: (worker: WorkerIdentity, reason: string) => Promise<void>;
  }) {
    super({ ...options, providerId: 'codex' });
  }
}

export type CodexTurnAdapter = ProviderTurnAdapter;
export type CodexTurnLifecycle = ProviderTurnLifecycle;
export type CodexDeliveryRequest = ProviderDeliveryRequest;
export type CodexDeliveryResult = ProviderDeliveryResult;
