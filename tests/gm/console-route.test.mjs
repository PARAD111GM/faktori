import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConsoleService } from '../../src/console/service.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

describe('authenticated Console nightly GM route', () => {
  it('rejects unauthenticated requests and preserves an explicit owner request identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-gm-console-'));
    const coordinator = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), identity: { instanceId: 'owner', pid: 1, processStartedAt: 'now' }, limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 1, maxTokens: 0, strictSpending: false, strictSpendingSupported: false } });
    await coordinator.claim(); const requests = [];
    const attempt = { format: 'faktori.gm-nightly-attempt/v1', attemptId: 'owner:review-1', trigger: 'owner_requested', requestId: 'review-1', inputDigest: `sha256:${'a'.repeat(64)}`, intendedAt: '2026-09-09T00:00:00Z', completedAt: '2026-09-09T00:00:01Z', status: 'completed', result: { findingActions: [], recommendations: [] } };
    const app = createConsoleService({ coordinator, commandToken: 'private', allowedOrigins: ['http://127.0.0.1:4173'], requestGMReview: async (id) => { requests.push(id); return attempt; } });
    try {
      expect((await app.inject({ method: 'POST', url: '/api/console/gm/review', payload: { requestId: 'review-1' } })).statusCode).toBe(403);
      const response = await app.inject({ method: 'POST', url: '/api/console/gm/review', headers: { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'private' }, payload: { requestId: 'review-1' } });
      expect(response.statusCode).toBe(200); expect(response.json().attempt.attemptId).toBe('owner:review-1'); expect(requests).toEqual(['review-1']);
    } finally { await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });
});
