import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cancelDurableNativeRun,
  observeDurableDockerTermination,
  prepareDurableDockerTermination,
} from '../../src/runtime/cancellation.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function intent() {
  return {
    format: 'faktori.run-intent/v1',
    runId: 'cancel-run',
    admissionKey: 'cancel-admission',
    workItem: { id: 'work', revision: 'work@1' },
    target: {
      factoryId: 'factory',
      productId: 'product',
      repository: 'owner/repository',
      branch: 'build/work',
      baseRevision: 'base@1',
      expectedRevision: 'expected@1',
    },
    context: { packetRevision: 'packet@1', digest: 'sha256:packet' },
    execution: {
      profile: 'native',
      workspaceId: 'workspace',
      workspacePath: '/workspace',
      providerId: 'codex',
      model: 'gpt-5.5',
      approvedInputDigests: [],
    },
    budget: { reservationId: 'reservation', maxRuntimeMinutes: 5, estimatedTokens: 100, status: 'held' },
    authority: {
      authorityRevision: 'authority@1',
      epoch: 3,
      scopeDigest: 'sha256:scope',
      policy: {
        requireIntentApproval: true,
        requireSpecificationApproval: true,
        requireIndependentReview: true,
        mergeAuthority: 'human',
        productionReleaseAuthority: 'human',
        allowPreviewDeployment: false,
        allowLocalDeployment: false,
        allowSeparateBilling: false,
      },
    },
    attempt: 1,
    createdAt: '2026-09-05T00:00:00.000Z',
  };
}

async function fixture(identity = {
  kind: 'native',
  pid: 77,
  processStartedAt: 'worker-start',
  processGroupId: 77,
  runNonce: 'run-nonce',
}) {
  const root = await mkdtemp(join(tmpdir(), 'faktori-cancel-'));
  roots.push(root);
  const coordinator = await DurableCoordinator.open({
    factoryId: 'factory',
    journalPath: join(root, 'operations.jsonl'),
    projectionPath: join(root, 'projection.sqlite'),
    identity: { instanceId: 'coordinator', pid: 10, processStartedAt: 'coordinator-start' },
    limits: {
      maxConcurrentRuns: 1,
      maxRetries: 0,
      maxRuntimeMinutes: 10,
      maxTokens: 1000,
      strictSpending: false,
      strictSpendingSupported: false,
    },
  });
  await coordinator.claim();
  await coordinator.admit(intent());
  await coordinator.record('worker.started', 'cancel-run', { worker: identity });
  return { coordinator, identity };
}

describe('durable cancellation integration', () => {
  it('revokes authority and persists termination intent before signaling, while usage stays uncertain after exit', async () => {
    const { coordinator, identity } = await fixture();
    let beforeSignal = [];
    let inspected = 0;
    const result = await cancelDurableNativeRun({
      coordinator,
      runId: 'cancel-run',
      identity,
      reason: 'owner_cancelled',
      operationId: 'cancel-operation',
      runner: {
        spawn: async () => ({ pid: 77 }),
        terminateProcessGroup: async () => {
          beforeSignal = coordinator.journal.events().map((event) => event.kind);
        },
      },
      identityProbe: {
        inspect: async () => {
          inspected += 1;
          return inspected === 1
            ? { pid: 77, processStartedAt: 'worker-start', processGroupId: 77, running: true }
            : { status: 'absent' };
        },
        inspectProcessGroup: async () => ({ status: 'absent' }),
      },
      now: () => new Date('2026-09-05T00:00:05.000Z'),
    });

    expect(result.outcome).toBe('confirmed_exited');
    expect(beforeSignal.indexOf('authority.revoked')).toBeGreaterThan(-1);
    expect(beforeSignal.indexOf('worker.termination.intended')).toBeGreaterThan(beforeSignal.indexOf('authority.revoked'));
    expect(beforeSignal).not.toContain('worker.termination.observed');
    expect(coordinator.snapshot('cancel-run')).toEqual(expect.objectContaining({
      state: 'cancelled',
      authorityRevoked: true,
      authorityEpoch: 4,
      reservation: expect.objectContaining({ status: 'uncertain' }),
      unresolvedEffects: [],
    }));
    await coordinator.release();
    coordinator.close();
  });

  it('retains revoked authority and an uncertain reservation when the exact worker still appears alive', async () => {
    const { coordinator, identity } = await fixture();
    const result = await cancelDurableNativeRun({
      coordinator,
      runId: 'cancel-run',
      identity,
      reason: 'runtime_expired',
      operationId: 'uncertain-cancel',
      runner: {
        spawn: async () => ({ pid: 77 }),
        terminateProcessGroup: async () => undefined,
      },
      identityProbe: {
        inspect: async () => ({ pid: 77, processStartedAt: 'worker-start', processGroupId: 77, running: true }),
      },
    });

    expect(result.outcome).toBe('interrupted_uncertain');
    expect(coordinator.snapshot('cancel-run')).toEqual(expect.objectContaining({
      authorityRevoked: true,
      reservation: expect.objectContaining({ status: 'uncertain' }),
    }));
    await coordinator.release();
    coordinator.close();
  });

  it('supports a transport-owned single Docker stop with durable preparation and post-stop observation', async () => {
    const identity = {
      kind: 'container',
      containerId: 'a'.repeat(64),
      containerStartedAt: '2026-09-05T00:00:01.000000000Z',
      runNonce: 'docker-run-nonce',
    };
    const { coordinator } = await fixture(identity);
    let stopped = false;
    const identityProbe = {
      inspect: async () => stopped
        ? { status: 'absent' }
        : { containerId: identity.containerId, containerStartedAt: identity.containerStartedAt, running: true },
    };

    const preparation = await prepareDurableDockerTermination({
      coordinator,
      runId: 'cancel-run',
      identity,
      identityProbe,
      reason: 'runtime_expired',
      operationId: 'docker-timeout-operation',
      now: () => new Date('2026-09-05T00:00:05.000Z'),
    });
    const beforeStop = coordinator.journal.events().map((event) => event.kind);
    expect(beforeStop.indexOf('authority.revoked')).toBeGreaterThan(-1);
    expect(beforeStop.indexOf('worker.termination.intended')).toBeGreaterThan(beforeStop.indexOf('authority.revoked'));
    expect(beforeStop).not.toContain('worker.termination.observed');
    expect(preparation).toEqual(expect.objectContaining({ operationId: 'docker-timeout-operation', identity }));

    stopped = true;
    const result = await observeDurableDockerTermination({
      coordinator,
      runId: 'cancel-run',
      preparation,
      identityProbe,
      reason: 'runtime_expired',
      operationId: 'docker-timeout-operation',
      now: () => new Date('2026-09-05T00:00:06.000Z'),
    });

    expect(result.outcome).toBe('confirmed_exited');
    expect(coordinator.snapshot('cancel-run')).toEqual(expect.objectContaining({
      state: 'cancelled',
      authorityRevoked: true,
      reservation: expect.objectContaining({ status: 'uncertain' }),
    }));
    expect(coordinator.snapshot('cancel-run')?.providerResult).toBeUndefined();
    await coordinator.release();
    coordinator.close();
  });
});
