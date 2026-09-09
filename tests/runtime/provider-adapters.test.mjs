import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../../src/providers/claude.ts';
import { CodexAdapter } from '../../src/providers/codex.ts';
import { CursorAcpAdapter } from '../../src/providers/cursor.ts';
import { providerContextPayloadDigest } from '../../src/providers/contracts.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';
import { CoordinatorProviderDelivery } from '../../src/runtime/delivery.ts';

function intent(providerId) {
  return {
    format: 'faktori.run-intent/v1', runId: `${providerId}-run`, admissionKey: `${providerId}-admission`,
    workItem: { id: 'F3-common', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'org/repo', branch: 'build/phase-3', baseRevision: 'base', expectedRevision: 'expected' },
    context: { packetRevision: 'packet@1', digest: 'packet-digest' },
    execution: {
      profile: 'native', workspaceId: `${providerId}-workspace`, workspacePath: `/private/tmp/${providerId}-workspace`, providerId, model: `${providerId}-model`,
      approvedInputDigests: [providerContextPayloadDigest({ packetRevision: 'packet@1', digest: 'packet-digest', prompt: 'Use only this current scoped packet.' })],
    },
    budget: { reservationId: `${providerId}-reservation`, maxRuntimeMinutes: 2, estimatedTokens: 100, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1, createdAt: '2026-09-05T00:00:00.000Z',
  };
}

function worker(providerId) {
  const pid = { codex: 701, claude: 702, cursor: 703 }[providerId];
  return { kind: 'native', pid, processStartedAt: `${providerId}-worker-start`, processGroupId: pid, runNonce: `${providerId}-nonce` };
}

function adapter(providerId, requests = []) {
  if (providerId === 'codex') return new CodexAdapter({
    limits: { maxRuntimeMinutes: 2, maxTokens: 500, maxRetries: 0 }, compatibleModels: ['codex-model'], environment: { PATH: '/controlled/bin' },
    runner: { async run(request) { requests.push(request); await request.lifecycle.onStarted(worker('codex')); return { exitCode: 0, stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'codex-session' })}\n${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } })}\n` }; } },
  });
  if (providerId === 'claude') return new ClaudeAdapter({
    limits: { maxRuntimeMinutes: 2, maxTokens: 500, maxRetries: 0 }, compatibleModels: ['claude-model'], environment: { PATH: '/controlled/bin' }, allowedTools: [], createSessionId: () => '11111111-1111-4111-8111-111111111111',
    runner: { async run(request) { requests.push(request); await request.lifecycle.onStarted(worker('claude')); return { exitCode: 0, stdout: `${JSON.stringify({ type: 'system', session_id: '11111111-1111-4111-8111-111111111111' })}\n${JSON.stringify({ type: 'result', session_id: '11111111-1111-4111-8111-111111111111', result: 'done', usage: { input_tokens: 2, output_tokens: 1 } })}\n` }; } },
  });
  const connection = {
    worker: worker('cursor'), setRequestHandler() {}, async notify() {}, async close() {},
    async request(request) {
      if (request.method === 'initialize') return { agentCapabilities: { loadSession: true } };
      if (request.method === 'session/new') return { sessionId: 'cursor-session' };
      if (request.method === 'session/prompt') return { stopReason: 'completed' };
      return {};
    },
  };
  return new CursorAcpAdapter({
    limits: { maxRuntimeMinutes: 2, maxTokens: 500, maxRetries: 0, requestTimeoutMs: 100 },
    transport: { async connect(request) { await request.lifecycle.onStarted(worker('cursor')); return connection; } },
  });
}

describe('actual provider adapters through coordinator delivery', () => {
  it.each(['codex', 'claude', 'cursor'])('completes a coordinator-admitted one-provider %s run through the common contract', async (providerId) => {
    const root = await mkdtemp(join(tmpdir(), `faktori-${providerId}-delivery-`));
    try {
      const owner = await DurableCoordinator.open({
        factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'),
        identity: { instanceId: `${providerId}-coordinator`, pid: 1, processStartedAt: 'start' },
        limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 2, maxTokens: 500, strictSpending: false, strictSpendingSupported: false },
      });
      await owner.claim();
      const run = intent(providerId);
      expect((await owner.admit(run)).accepted).toBe(true);
      const service = new CoordinatorProviderDelivery({ coordinator: owner, adapter: adapter(providerId), providerId, terminateWorker: async () => undefined });
      const delivered = await service.deliver({ runId: run.runId, context: { ...run.context, prompt: 'Use only this current scoped packet.' } });
      expect(delivered.final).toEqual(expect.objectContaining({ outcome: 'completed', sessionId: expect.any(String) }));
      expect(owner.snapshot(run.runId)).toEqual(expect.objectContaining({ state: 'succeeded', worker: worker(providerId) }));
      const events = owner.journal.events().filter((event) => event.runId === run.runId);
      expect(events.find((event) => event.kind === 'usage.observed')?.data.source).toBe(providerId);
      expect(events.find((event) => event.kind === 'effect.intended')?.data.effect.operationId).toMatch(new RegExp(`^${providerId}-turn-`));
      await owner.release();
      owner.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['codex', ['-c', 'model_reasoning_effort="high"']],
    ['claude', ['--effort', 'high']],
  ])('transmits configured reasoning through the actual %s process request', async (providerId, expectedArgs) => {
    const requests = [];
    const run = intent(providerId);
    run.execution.reasoning = 'high';
    const result = await adapter(providerId, requests).start(run, { ...run.context, prompt: 'Use only this current scoped packet.' }, { onStarted: async () => {} });
    expect(result.final.outcome).toBe('completed');
    const offset = requests[0].args.findIndex((value) => value === expectedArgs[0]);
    expect(requests[0].args.slice(offset, offset + 2)).toEqual(expectedArgs);
  });
});
