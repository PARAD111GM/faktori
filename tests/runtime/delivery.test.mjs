import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DurableCoordinator } from '../../src/runtime/coordinator.ts';
import { CoordinatorCodexDelivery, DeliveryPreconditionError } from '../../src/runtime/delivery.ts';

async function fixtureDirectory() {
  return mkdtemp(join(tmpdir(), 'faktori-delivery-'));
}

function intent(runId = 'run-delivery') {
  return {
    format: 'faktori.run-intent/v1',
    runId,
    admissionKey: `admission-${runId}`,
    workItem: { id: 'F2-03', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'org/repo', branch: 'build/phase-2', baseRevision: 'base', expectedRevision: 'expected' },
    context: { packetRevision: 'packet@4', digest: 'packet-digest' },
    execution: { profile: 'native', workspaceId: `workspace-${runId}`, workspacePath: '/private/tmp/faktori-job', providerId: 'codex', model: 'gpt-5.5', approvedInputDigests: ['input-digest'] },
    budget: { reservationId: `reservation-${runId}`, maxRuntimeMinutes: 3, estimatedTokens: 100, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1,
    createdAt: '2026-09-05T00:00:00.000Z',
  };
}

async function coordinator(directory) {
  const value = await DurableCoordinator.open({
    factoryId: 'factory',
    journalPath: join(directory, 'operations.jsonl'),
    projectionPath: join(directory, 'projection.sqlite'),
    identity: { instanceId: 'delivery-coordinator', pid: 123, processStartedAt: 'process-start' },
    limits: { maxConcurrentRuns: 4, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 1000, strictSpending: false, strictSpendingSupported: false },
  });
  await value.claim();
  return value;
}

function final(overrides = {}) {
  return {
    outcome: 'completed',
    sessionId: 'session-1',
    usage: { availability: 'reported', inputTokens: 10, outputTokens: 3, reasoningTokens: 2, reportedBy: 'fixture' },
    nativeCancellationReceipt: false,
    ...overrides,
  };
}

function delivery(coordinatorValue, overrides = {}) {
  const calls = { start: [], resume: [], startsObserved: 0 };
  const worker = { kind: 'native', pid: 456, processStartedAt: 'worker-start', processGroupId: 456, runNonce: 'worker-nonce' };
  const adapter = {
    async start(run, context, lifecycle) {
      calls.start.push({ run, context, lifecycle });
      await lifecycle.onStarted(worker);
      calls.startsObserved += 1;
      return { command: 'start', events: [{ type: 'thread.started', raw: { type: 'thread.started', thread_id: 'session-1' } }, { type: 'turn.completed', raw: { type: 'turn.completed' } }], malformedEventCount: 0, final: final() };
    },
    async resume(run, binding, context, lifecycle) {
      calls.resume.push({ run, binding, context, lifecycle });
      await lifecycle.onStarted(worker);
      calls.startsObserved += 1;
      return { command: 'resume', events: [], malformedEventCount: 0, final: final({ sessionId: binding.sessionId }) };
    },
    ...overrides.adapter,
  };
  return { calls, service: new CoordinatorCodexDelivery({ coordinator: coordinatorValue, adapter, terminateWorker: overrides.terminateWorker ?? (async () => undefined) }) };
}

function request(runId = 'run-delivery', extras = {}) {
  return {
    runId,
    context: { packetRevision: 'packet@4', digest: 'packet-digest', prompt: 'Current bounded context.' },
    ...extras,
  };
}

function sourceScope(sourceIntent) {
  return {
    factoryId: sourceIntent.target.factoryId,
    productId: sourceIntent.target.productId,
    repository: sourceIntent.target.repository,
    workspaceId: sourceIntent.execution.workspaceId,
    workspacePath: sourceIntent.execution.workspacePath,
    providerId: sourceIntent.execution.providerId,
  };
}

describe('coordinator-owned Codex delivery', () => {
  it('persists lifecycle evidence before normalized provider events and consumes only reported usage', async () => {
    const directory = await fixtureDirectory();
    try {
      const owner = await coordinator(directory);
      await owner.admit(intent());
      const { service, calls } = delivery(owner);
      const result = await service.deliver(request());

      expect(result).toEqual(expect.objectContaining({ status: 'delivered', command: 'start', final: expect.objectContaining({ outcome: 'completed' }) }));
      expect(calls.start).toEqual([expect.objectContaining({ context: expect.objectContaining({ prompt: 'Current bounded context.' }) })]);
      expect(calls.startsObserved).toBe(1);
      const kinds = owner.journal.events().filter((event) => event.runId === 'run-delivery').map((event) => event.kind);
      expect(kinds.indexOf('effect.intended')).toBeLessThan(kinds.indexOf('effect.receipt'));
      expect(kinds.indexOf('effect.receipt')).toBeLessThan(kinds.indexOf('worker.started'));
      expect(kinds.indexOf('worker.started')).toBeLessThan(kinds.indexOf('provider.event'));
      expect(kinds.indexOf('provider.event')).toBeLessThan(kinds.indexOf('provider.final'));
      expect(owner.snapshot('run-delivery')).toEqual(expect.objectContaining({ state: 'succeeded', reservation: expect.objectContaining({ status: 'consumed' }) }));
      await owner.release();
      owner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects mismatched context and revoked authority before lifecycle or adapter effects', async () => {
    const directory = await fixtureDirectory();
    try {
      const owner = await coordinator(directory);
      await owner.admit(intent());
      const { service, calls } = delivery(owner);
      await expect(service.deliver(request('run-delivery', { context: { packetRevision: 'wrong', digest: 'packet-digest', prompt: 'wrong' } }))).rejects.toBeInstanceOf(DeliveryPreconditionError);
      await owner.record('authority.revoked', 'run-delivery', { epoch: 2 });
      await expect(service.deliver(request())).rejects.toBeInstanceOf(DeliveryPreconditionError);
      expect(calls.start).toEqual([]);
      await owner.release();
      owner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resumes only a session proved by a prior durable provider final and is idempotent after completion', async () => {
    const directory = await fixtureDirectory();
    try {
      const owner = await coordinator(directory);
      const source = intent('source-run');
      await owner.admit(source);
      await owner.record('provider.final', 'source-run', { result: final({ sessionId: 'durable-session' }) });
      const target = intent('resume-run');
      target.execution.workspaceId = source.execution.workspaceId;
      await owner.admit(target);
      const { service, calls } = delivery(owner);
      const resume = request('resume-run', { resume: { sessionId: 'durable-session', sourceRunId: 'source-run', sourceContext: { packetRevision: 'packet@4', digest: 'packet-digest' }, sourceScope: sourceScope(source) } });
      expect(await service.deliver(resume)).toEqual(expect.objectContaining({ status: 'delivered', command: 'resume' }));
      expect(calls.resume).toEqual([expect.objectContaining({ binding: expect.objectContaining({ sessionId: 'durable-session' }) })]);
      expect(await service.deliver(resume)).toEqual(expect.objectContaining({ status: 'already_recorded', command: 'resume' }));
      expect(calls.resume).toHaveLength(1);
      await owner.admit(intent('bad-resume'));
      await expect(service.deliver(request('bad-resume', { resume: { sessionId: 'invented', sourceRunId: 'source-run', sourceContext: { packetRevision: 'packet@4', digest: 'packet-digest' }, sourceScope: sourceScope(source) } }))).rejects.toThrow(/not proven/);
      await owner.release();
      owner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects cross-workspace and cross-product or repository resume before launch intent or adapter invocation', async () => {
    const directory = await fixtureDirectory();
    try {
      const owner = await coordinator(directory);
      const source = intent('source-scope-run');
      await owner.admit(source);
      await owner.record('provider.final', source.runId, { result: final({ sessionId: 'scope-session' }) });
      const { service, calls } = delivery(owner);
      const binding = {
        sessionId: 'scope-session',
        sourceRunId: source.runId,
        sourceContext: { ...source.context },
        sourceScope: sourceScope(source),
      };

      const crossWorkspace = intent('cross-workspace-run');
      await owner.admit(crossWorkspace);
      await expect(service.deliver(request(crossWorkspace.runId, { resume: binding }))).rejects.toThrow(/cannot cross/);

      const crossProduct = intent('cross-product-run');
      crossProduct.execution.workspaceId = source.execution.workspaceId;
      crossProduct.target.productId = 'other-product';
      await owner.admit(crossProduct);
      await expect(service.deliver(request(crossProduct.runId, { resume: binding }))).rejects.toThrow(/cannot cross/);

      const crossRepository = intent('cross-repository-run');
      crossRepository.execution.workspaceId = source.execution.workspaceId;
      crossRepository.target.repository = 'other/repository';
      await owner.admit(crossRepository);
      await expect(service.deliver(request(crossRepository.runId, { resume: binding }))).rejects.toThrow(/cannot cross/);

      expect(calls.resume).toEqual([]);
      for (const runId of [crossWorkspace.runId, crossProduct.runId, crossRepository.runId]) {
        expect(owner.journal.events().some((event) => event.runId === runId && event.kind === 'effect.intended')).toBe(false);
      }
      await owner.release();
      owner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('records failure or timeout as non-success with uncertain usage and survives projection rebuild', async () => {
    const directory = await fixtureDirectory();
    try {
      const owner = await coordinator(directory);
      await owner.admit(intent());
      const { service } = delivery(owner, {
        adapter: {
          async start(_run, _context, lifecycle) {
            await lifecycle.onStarted({ kind: 'native', pid: 999, processStartedAt: 'timed-out-worker', processGroupId: 999, runNonce: 'timed-out' });
            return { command: 'start', events: [], malformedEventCount: 0, final: final({ outcome: 'interrupted_uncertain', usage: { availability: 'unavailable', unavailableReason: 'timeout without usage receipt' } }) };
          },
        },
      });
      const result = await service.deliver(request());
      expect(result.final.outcome).toBe('interrupted_uncertain');
      expect(owner.snapshot('run-delivery')).toEqual(expect.objectContaining({ state: 'interrupted_uncertain', reservation: expect.objectContaining({ status: 'uncertain' }) }));
      owner.projection.rebuild(owner.journal.events());
      expect(owner.projection.snapshot('run-delivery')).toEqual(expect.objectContaining({ state: 'interrupted_uncertain', reservation: expect.objectContaining({ status: 'uncertain' }) }));
      await owner.release();
      owner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('marks a turn uncertain without accepting a provider success when the adapter never observes a worker identity', async () => {
    const directory = await fixtureDirectory();
    try {
      const owner = await coordinator(directory);
      await owner.admit(intent());
      const { service } = delivery(owner, {
        adapter: {
          async start() {
            return { command: 'start', events: [], malformedEventCount: 0, final: final() };
          },
        },
      });
      const result = await service.deliver(request());
      expect(result.final.outcome).toBe('interrupted_uncertain');
      expect(owner.snapshot('run-delivery')).toEqual(expect.objectContaining({ state: 'interrupted_uncertain', reservation: expect.objectContaining({ status: 'uncertain' }) }));
      await owner.release();
      owner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('forwards a transport termination request to the durable termination boundary before accepting its outcome', async () => {
    const directory = await fixtureDirectory();
    try {
      const owner = await coordinator(directory);
      await owner.admit(intent());
      const terminations = [];
      const worker = { kind: 'native', pid: 776, processStartedAt: 'termination-worker', processGroupId: 776, runNonce: 'termination-nonce' };
      const { service } = delivery(owner, {
        terminateWorker: async (identity, reason) => { terminations.push({ identity, reason }); },
        adapter: {
          async start(_run, _context, lifecycle) {
            await lifecycle.onStarted(worker);
            await lifecycle.onTerminationRequired(worker, 'runtime_limit');
            return { command: 'start', events: [], malformedEventCount: 0, final: final({ outcome: 'interrupted_uncertain', usage: { availability: 'unavailable', unavailableReason: 'terminated' } }) };
          },
        },
      });
      await service.deliver(request());
      expect(terminations).toEqual([{ identity: worker, reason: 'runtime_limit' }]);
      await owner.release();
      owner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
