import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ConsoleProviderRequestBroker } from '../../src/console/provider-requests.ts';
import { createConsoleService } from '../../src/console/service.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

function intent() {
  return {
    format: 'faktori.run-intent/v1', runId: 'cursor-run', admissionKey: 'cursor-admission',
    workItem: { id: 'work', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'org/repo', branch: 'work', baseRevision: 'base', expectedRevision: 'head' },
    context: { packetRevision: 'packet@1', digest: 'packet' },
    execution: { profile: 'native', workspaceId: 'workspace', workspacePath: '/private/tmp/workspace', providerId: 'cursor', model: 'cursor', approvedInputDigests: [] },
    budget: { reservationId: 'reservation', maxRuntimeMinutes: 5, estimatedTokens: 30, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1, createdAt: '2026-09-05T00:00:00.000Z',
  };
}

describe('Console provider request bridge', () => {
  it('projects a live provider question and returns exactly one durable owner answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-provider-request-'));
    const coordinator = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), identity: { instanceId: 'coordinator', pid: 1, processStartedAt: 'now' }, limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 100, strictSpending: false, strictSpendingSupported: false } });
    await coordinator.claim();
    await coordinator.admit(intent());
    const broker = new ConsoleProviderRequestBroker({ coordinator, timeoutMs: 1_000 });
    const app = createConsoleService({ coordinator, commandToken: 'token', allowedOrigins: ['http://127.0.0.1:4173'] });
    try {
      const reply = broker.replyPolicy().question({ id: 7, method: 'session/request_question', params: { question: 'Continue with the bounded verification?', options: ['yes', 'no'] } }, intent());
      for (let attempt = 0; attempt < 100 && !coordinator.journal.events().some((event) => event.kind === 'provider.requested'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      const pending = (await app.inject({ method: 'GET', url: '/api/console/state' })).json().runs[0].providerRequests[0];
      expect(pending).toEqual(expect.objectContaining({ requestId: 'number:7', method: 'session/request_question', prompt: 'Continue with the bounded verification?', options: ['yes', 'no'], status: 'pending' }));
      await expect(broker.answer('cursor-run', 'number:7', 'yes')).resolves.toEqual({ detail: 'provider_request_answered' });
      await expect(reply).resolves.toEqual({ result: { answer: 'yes' } });
      expect((await app.inject({ method: 'GET', url: '/api/console/state' })).json().runs[0].providerRequests[0].status).toBe('answered');
      await expect(broker.answer('cursor-run', 'number:7', 'again')).rejects.toThrow('provider_request_not_pending');
    } finally {
      broker.close(); await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true });
    }
  });
});
