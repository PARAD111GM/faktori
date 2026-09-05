import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

function intent() {
  return {
    format: 'faktori.run-intent/v1', runId: 'message-run', admissionKey: 'message-admission',
    workItem: { id: 'F3-03', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'org/repo', branch: 'build/phase-3', baseRevision: 'base', expectedRevision: 'expected' },
    context: { packetRevision: 'packet@1', digest: 'packet-digest' },
    execution: { profile: 'native', workspaceId: 'workspace', workspacePath: '/private/tmp/workspace', providerId: 'codex', model: 'model', approvedInputDigests: [] },
    budget: { reservationId: 'message-reservation', maxRuntimeMinutes: 2, estimatedTokens: 100, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1, createdAt: '2026-09-05T00:00:00.000Z',
  };
}

describe('durable queued-message identity', () => {
  it('records one semantic message across concurrent replay and rejects conflicting id reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-message-'));
    try {
      const owner = await DurableCoordinator.open({
        factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'),
        identity: { instanceId: 'message-owner', pid: 1, processStartedAt: 'start' },
        limits: { maxConcurrentRuns: 2, maxRetries: 0, maxRuntimeMinutes: 3, maxTokens: 500, strictSpending: false, strictSpendingSupported: false },
      });
      await owner.claim();
      await owner.admit(intent());
      const first = { messageId: 'stable-message', runId: 'message-run', createdAt: 'first-time', delivery: 'next_turn', body: 'bounded body' };
      const replay = { ...first, createdAt: 'later-time' };
      await Promise.all([owner.queueMessage(first), owner.queueMessage(replay)]);
      expect(owner.journal.events().filter((event) => event.kind === 'message.queued')).toHaveLength(1);
      await expect(owner.queueMessage({ ...replay, body: 'conflicting body' })).rejects.toThrow(/conflicts/);
      await owner.record('provider.final', 'message-run', { result: { outcome: 'completed', usage: { availability: 'unavailable', unavailableReason: 'fixture' }, nativeCancellationReceipt: false } });
      await expect(owner.queueMessage(replay)).resolves.toBeUndefined();
      await owner.release();
      owner.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
