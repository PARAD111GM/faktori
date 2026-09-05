import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CoordinatorGMStore, FactoryGM, coordinatorGMState } from '../../src/gm/index.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

describe('coordinator-backed Factory GM records', () => {
  it('rebuilds one finding and approval-required improvement from the coordinator journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-gm-store-'));
    const options = { factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), identity: { instanceId: 'gm-owner', pid: 1, processStartedAt: 'now' }, limits: { maxConcurrentRuns: 2, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 100, strictSpending: false, strictSpendingSupported: false } };
    let coordinator = await DurableCoordinator.open(options);
    try {
      await coordinator.claim();
      const gm = new FactoryGM({ factoryId: 'factory', instructions: { revision: 'gm@1', content: 'Diagnose the factory only.' }, store: new CoordinatorGMStore(coordinator), diagnosis: { diagnose: async () => ({ recommendations: [{ kind: 'factory_improvement', detail: 'Propose packet validation.' }] }) } });
      await gm.observe({ kind: 'repeated_handoff_failure', factoryId: 'factory', handoffKey: 'work-1:review', observedAt: '2026-09-05T00:00:00.000Z', summary: 'Handoff failed.' });
      expect(coordinatorGMState(coordinator)).toEqual({ findings: [expect.objectContaining({ occurrenceCount: 1 })], improvements: [expect.objectContaining({ authority: 'requires_approval' })] });
      await coordinator.release(); coordinator.close();
      coordinator = await DurableCoordinator.open({ ...options, projectionPath: join(root, 'reopened.sqlite'), identity: { instanceId: 'gm-owner-reopened', pid: 2, processStartedAt: 'later' } });
      await coordinator.claim();
      expect(coordinatorGMState(coordinator).findings).toHaveLength(1);
      expect(coordinatorGMState(coordinator).improvements).toHaveLength(1);
    } finally { await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });
});
