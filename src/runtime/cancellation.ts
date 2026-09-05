import { createHash, randomUUID } from 'node:crypto';

import {
  cancelDockerExecution,
  cancelNativeExecution,
  type CancellationAuthority,
  type CancellationResult,
  type ContainerIdentityProbe,
  type ContainerRunner,
  type NativeIdentityProbe,
  type NativeProcessRunner,
} from '../execution/index.ts';
import type { DurableEffectIntent, WorkerIdentity } from './contracts.ts';
import type { DurableCoordinator } from './coordinator.ts';

export interface DurableCancellationOptions {
  coordinator: DurableCoordinator;
  runId: string;
  reason: string;
  operationId?: string;
  now?: () => Date;
}

export interface DurableDockerTerminationPreparation {
  operationId: string;
  identity: Extract<WorkerIdentity, { kind: 'container' }>;
  preflight: {
    containerId: string;
    containerStartedAt: string;
    running: true;
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function sameIdentity(left: WorkerIdentity | undefined, right: WorkerIdentity): boolean {
  return left !== undefined && stable(left) === stable(right);
}

class JournalCancellationAuthority implements CancellationAuthority {
  readonly coordinator: DurableCoordinator;
  readonly runId: string;
  readonly reason: string;
  readonly operationId: string;
  readonly now: () => Date;

  constructor(options: DurableCancellationOptions) {
    this.coordinator = options.coordinator;
    this.runId = options.runId;
    this.reason = options.reason;
    this.operationId = options.operationId ?? randomUUID();
    this.now = options.now ?? (() => new Date());
  }

  async revokeBeforeTermination(identity: WorkerIdentity, reason: string): Promise<void> {
    if (reason !== this.reason) throw new Error('Cancellation reason changed after admission');
    const snapshot = this.coordinator.snapshot(this.runId);
    if (snapshot === undefined) throw new Error(`Unknown run ${this.runId}`);
    if (!sameIdentity(snapshot.worker, identity)) throw new Error('Cancellation worker identity does not match the admitted run');

    const epoch = snapshot.authorityRevoked ? snapshot.authorityEpoch : snapshot.authorityEpoch + 1;
    if (!snapshot.authorityRevoked) {
      await this.coordinator.record('authority.revoked', this.runId, {
        epoch,
        reason,
        worker: identity,
        revokedAt: this.now().toISOString(),
      });
    }

    const requestedAt = this.now().toISOString();
    const effect: DurableEffectIntent = {
      operationId: this.operationId,
      kind: 'worker.terminate',
      identityKey: createHash('sha256').update(stable(identity)).digest('hex'),
      requestedAt,
      requestDigest: createHash('sha256').update(stable({ runId: this.runId, reason, identity, epoch })).digest('hex'),
    };
    await this.coordinator.record('worker.termination.intended', this.runId, { effect });
  }
}

async function recordCancellationResult(
  options: DurableCancellationOptions,
  operationId: string,
  result: CancellationResult,
): Promise<CancellationResult> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  await options.coordinator.record('worker.termination.observed', options.runId, {
    receipt: {
      operationId,
      observedAt,
      outcome: result.outcome === 'confirmed_exited' ? 'completed' : 'uncertain',
      detail: result.detail,
    },
  });
  await options.coordinator.record('reservation.released', options.runId, {
    // Process exit only proves execution stopped. Without a provider usage
    // receipt, the reservation remains conservative until reconciliation.
    status: 'uncertain',
    observedAt,
  });
  return result;
}

/**
 * Durable pre-stop half of a Docker transport-owned termination. The caller
 * returns from this hook without stopping the container; DockerCodexProcessRunner
 * performs the single stop immediately afterward.
 */
export async function prepareDurableDockerTermination(
  options: DurableCancellationOptions & {
    identity: Extract<WorkerIdentity, { kind: 'container' }>;
    identityProbe: ContainerIdentityProbe;
  },
): Promise<DurableDockerTerminationPreparation> {
  const authority = new JournalCancellationAuthority(options);
  await authority.revokeBeforeTermination(options.identity, options.reason);
  const observed = await options.identityProbe.inspect(options.identity.containerId);
  if (observed === undefined || 'status' in observed || !observed.running
    || observed.containerId !== options.identity.containerId
    || observed.containerStartedAt !== options.identity.containerStartedAt) {
    throw new Error('Docker termination preflight could not prove the exact running container identity; no stop is authorized');
  }
  return {
    operationId: authority.operationId,
    identity: options.identity,
    preflight: { ...observed, running: true },
  };
}

/** Records the post-stop observation without inventing a provider receipt. */
export async function observeDurableDockerTermination(
  options: DurableCancellationOptions & {
    preparation: DurableDockerTerminationPreparation;
    identityProbe: ContainerIdentityProbe;
  },
): Promise<CancellationResult> {
  const { identity, operationId } = options.preparation;
  const observed = await options.identityProbe.inspect(identity.containerId);
  const confirmed = observed === undefined
    || ('status' in observed && observed.status === 'absent')
    || ('containerId' in observed && !observed.running
      && observed.containerId === identity.containerId
      && observed.containerStartedAt === identity.containerStartedAt);
  const result: CancellationResult = confirmed
    ? { authorityRevoked: true, outcome: 'confirmed_exited', identity, detail: 'exact container identity absent after transport stop' }
    : { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: 'container identity was unavailable, changed, or still running after transport stop' };
  return recordCancellationResult(options, operationId, result);
}

export async function cancelDurableNativeRun(
  options: DurableCancellationOptions & {
    identity: Extract<WorkerIdentity, { kind: 'native' }>;
    runner: NativeProcessRunner;
    identityProbe: NativeIdentityProbe;
  },
): Promise<CancellationResult> {
  const authority = new JournalCancellationAuthority(options);
  const result = await cancelNativeExecution(options.identity, authority, options.runner, options.identityProbe, options.reason);
  return recordCancellationResult(options, authority.operationId, result);
}

export async function cancelDurableDockerRun(
  options: DurableCancellationOptions & {
    identity: Extract<WorkerIdentity, { kind: 'container' }>;
    runner: ContainerRunner;
    identityProbe: ContainerIdentityProbe;
  },
): Promise<CancellationResult> {
  const authority = new JournalCancellationAuthority(options);
  const result = await cancelDockerExecution(options.identity, authority, options.runner, options.identityProbe, options.reason);
  return recordCancellationResult(options, authority.operationId, result);
}
