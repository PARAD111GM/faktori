import { createHash } from 'node:crypto';

import type { CodexCurrentContext, CodexProcessLifecycle, CodexRunResult, CodexSessionBinding } from '../providers/codex.ts';
import type { DurableEffectIntent, ProviderFinalResult, RunIntent, RunSnapshot, UsageTelemetry, WorkerIdentity } from './contracts.ts';
import { isTerminalRunState } from './contracts.ts';
import type { DurableCoordinator } from './coordinator.ts';

export interface CodexTurnAdapter {
  start(intent: RunIntent, currentContext: CodexCurrentContext, lifecycle?: CodexTurnLifecycle): Promise<CodexRunResult>;
  resume(intent: RunIntent, sessionBinding: CodexSessionBinding, currentContext: CodexCurrentContext, lifecycle?: CodexTurnLifecycle): Promise<CodexRunResult>;
}

/** Called by the actual Codex transport after it has observed its worker. */
export type CodexTurnLifecycle = CodexProcessLifecycle;

export interface CodexDeliveryRequest {
  runId: string;
  context: CodexCurrentContext;
  resume?: CodexSessionBinding;
}

export interface CodexDeliveryResult {
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
export class CoordinatorCodexDelivery {
  readonly #coordinator: DurableCoordinator;
  readonly #adapter: CodexTurnAdapter;
  readonly #terminateWorker: (worker: WorkerIdentity, reason: string) => Promise<void>;
  #tails = new Map<string, Promise<CodexDeliveryResult>>();

  constructor(options: {
    coordinator: DurableCoordinator;
    adapter: CodexTurnAdapter;
    terminateWorker: (worker: WorkerIdentity, reason: string) => Promise<void>;
  }) {
    this.#coordinator = options.coordinator;
    this.#adapter = options.adapter;
    this.#terminateWorker = options.terminateWorker;
  }

  async deliver(request: CodexDeliveryRequest): Promise<CodexDeliveryResult> {
    const previous = this.#tails.get(request.runId);
    if (previous !== undefined) return previous;
    const run = this.deliverExclusive(request);
    this.#tails.set(request.runId, run);
    try {
      return await run;
    } finally {
      if (this.#tails.get(request.runId) === run) this.#tails.delete(request.runId);
    }
  }

  private async deliverExclusive(request: CodexDeliveryRequest): Promise<CodexDeliveryResult> {
    const snapshot = this.exactSnapshot(request, true);
    const command = request.resume === undefined ? 'start' : 'resume';
    const sessionId = command === 'resume' ? this.requireResumeBinding(request.resume as CodexSessionBinding) : undefined;
    const operation = this.operation(snapshot.intent, command, sessionId);
    const replay = this.priorDelivery(snapshot.intent.runId, operation);
    if (replay !== undefined) return replay;
    if (isTerminalRunState(snapshot.state)) throw new DeliveryPreconditionError(`Run ${request.runId} is terminal and cannot receive a Codex turn`);
    if (snapshot.authorityRevoked) throw new DeliveryPreconditionError(`Run ${request.runId} authority is revoked`);

    await this.#coordinator.recordEffectIntent(snapshot.intent.runId, operation);
    let observedWorker = false;
    let observedWorkerIdentity: string | undefined;
    const lifecycle: CodexTurnLifecycle = {
      onStarted: async (worker): Promise<void> => {
        if (observedWorker) throw new DeliveryPreconditionError(`Codex delivery operation ${operation.operationId} reported more than one worker identity`);
        if (!isWorkerIdentity(worker)) throw new DeliveryPreconditionError('Codex transport did not report an exact worker identity');
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
        if (!isWorkerIdentity(worker)) throw new DeliveryPreconditionError('Codex transport requested termination for an unproven worker identity');
        if (!observedWorker || observedWorkerIdentity !== stable(worker)) throw new DeliveryPreconditionError('Codex transport requested termination for a worker other than the recorded worker');
        await this.#terminateWorker(worker, reason);
      },
    };
    try {
      const result = command === 'start'
        ? await this.#adapter.start(snapshot.intent, request.context, lifecycle)
        : await this.#adapter.resume(snapshot.intent, request.resume as CodexSessionBinding, request.context, lifecycle);
      if (!observedWorker) {
        await this.recordLifecycleFailure(snapshot.intent.runId, operation, 'Codex transport returned without an exact worker-start callback');
        return this.finalize(snapshot.intent.runId, command, unavailable('interrupted_uncertain', 'Codex transport returned without an exact worker-start callback'));
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
      if (!observedWorker) await this.recordLifecycleFailure(snapshot.intent.runId, operation, 'Codex transport failed before an exact worker-start callback');
      return this.finalize(snapshot.intent.runId, command, unavailable('interrupted_uncertain', 'Codex transport failed after launch intent; provider outcome is unknown'));
    }
  }

  private exactSnapshot(request: CodexDeliveryRequest, allowPriorReplay = false): RunSnapshot {
    const snapshot = this.#coordinator.snapshot(request.runId);
    if (snapshot === undefined) throw new DeliveryPreconditionError(`Run ${request.runId} was not admitted`);
    if (!allowPriorReplay && isTerminalRunState(snapshot.state)) throw new DeliveryPreconditionError(`Run ${request.runId} is terminal and cannot receive a Codex turn`);
    if (!allowPriorReplay && snapshot.authorityRevoked) throw new DeliveryPreconditionError(`Run ${request.runId} authority is revoked`);
    if (snapshot.intent.execution.providerId !== 'codex') throw new DeliveryPreconditionError(`Run ${request.runId} is not assigned to Codex`);
    if (request.context.packetRevision !== snapshot.intent.context.packetRevision || request.context.digest !== snapshot.intent.context.digest) {
      throw new DeliveryPreconditionError(`Run ${request.runId} current context does not match the admitted packet revision and digest`);
    }
    if (request.context.prompt.trim().length === 0) throw new DeliveryPreconditionError('Current Codex context prompt is required');
    return snapshot;
  }

  private requireResumeBinding(binding: CodexSessionBinding): string {
    if (binding.sessionId.trim().length === 0) throw new DeliveryPreconditionError('Codex resume requires an explicit session binding');
    const source = this.#coordinator.snapshot(binding.sourceRunId);
    if (source === undefined || source.providerResult === undefined || source.providerResult.sessionId !== binding.sessionId) {
      throw new DeliveryPreconditionError('Codex resume session is not proven by a durable source provider final record');
    }
    if (source.intent.context.packetRevision !== binding.sourceContext.packetRevision || source.intent.context.digest !== binding.sourceContext.digest) {
      throw new DeliveryPreconditionError('Codex resume source context binding does not match durable source intent');
    }
    return binding.sessionId;
  }

  private operation(intent: RunIntent, command: 'start' | 'resume', sessionId: string | undefined): DurableEffectIntent {
    const request = { runId: intent.runId, command, sessionId, context: intent.context, execution: intent.execution, attempt: intent.attempt };
    const requestDigest = digest(request);
    return {
      operationId: `codex-turn-${requestDigest}`,
      kind: command === 'start' ? 'worker.launch' : 'worker.resume',
      identityKey: digest({ runId: intent.runId, workspaceId: intent.execution.workspaceId, providerId: 'codex' }),
      requestedAt: new Date().toISOString(),
      requestDigest,
    };
  }

  private priorDelivery(runId: string, operation: DurableEffectIntent): CodexDeliveryResult | undefined {
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
      throw new DeliveryPreconditionError(`Codex delivery operation ${operation.operationId} was reused with conflicting content`);
    }
    const snapshot = this.#coordinator.snapshot(runId);
    if (snapshot?.providerResult === undefined) {
      throw new DeliveryPreconditionError(`Codex delivery operation ${operation.operationId} is unresolved and cannot be retried`);
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

  private async finalize(runId: string, command: 'start' | 'resume', final: ProviderFinalResult): Promise<CodexDeliveryResult> {
    await this.#coordinator.record('usage.observed', runId, { usage: final.usage, source: 'codex' });
    await this.#coordinator.record('provider.final', runId, { result: final, command });
    await this.#coordinator.record('reservation.released', runId, { status: usageStatus(final.usage), reason: 'provider_final_usage_telemetry' });
    return { status: 'delivered', command, final };
  }
}
