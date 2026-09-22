import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManagerLoopObserver } from '../../src/console/manager-loop-observer.ts';
import { observeFactoryDeterministically } from '../../src/gm/index.ts';

describe('deterministic factory observations', () => {
  it('explains a blocked lean preflight with safe failed-check evidence rather than only its digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-gm-observer-')); const artifacts = join(root, 'loop'); await mkdir(artifacts);
    await writeFile(join(artifacts, 'state.json'), JSON.stringify({ format: 'faktori.manager-loop-state/v1', loopId: 'lean-proof', status: 'blocked', completedPhases: [], stages: [], reason: `lean_preflight_failed:sha256:${'a'.repeat(64)}`, updatedAt: '2026-09-09T00:00:00Z' }));
    await writeFile(join(artifacts, 'preflight.json'), JSON.stringify({ format: 'faktori.lean-preflight-receipt/v1', passed: false, causeDigest: `sha256:${'a'.repeat(64)}`, checks: [{ id: 'provider.executable', passed: false, detail: 'executable_missing' }], environmentInputs: [], routes: [], quota: 'unknown', consecutiveFailures: 2, launchSuppressed: true, observedAt: '2026-09-09T00:00:00Z' }));
    const observer = new ManagerLoopObserver({ sources: [{ id: 'lean-proof', artifactsDirectory: artifacts }] });
    try {
      await observer.poll();
      expect(observer.summaries()[0].preflight).toMatchObject({ failedChecks: [{ id: 'provider.executable', detail: 'executable_missing' }], consecutiveFailures: 2, launchSuppressed: true });
      const observation = observeFactoryDeterministically({ factoryId: 'factory', coordinator: { snapshots: () => [] }, loops: observer.efficiencySnapshot(), now: new Date('2026-09-09T01:00:00Z') });
      expect(observation.findings).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'environment_failure', classification: 'infrastructure', latestSummary: expect.stringContaining('provider.executable'), accountableRole: 'factory_operator' })]));
    } finally { observer.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('keeps a nonterminal configured run in usage coverage as unknown instead of dropping it', () => {
    const run = { intent: { runId: 'active-run', workItem: { id: 'work-one' }, execution: { providerId: 'codex', model: 'configured-model' }, authority: { authorityRevision: 'authority@1' } } };
    const observation = observeFactoryDeterministically({ factoryId: 'factory', coordinator: { snapshots: () => [run] },
      loops: { records: [], summaries: [] }, workAttribution: { 'work-one': { featureId: 'feature-one', acceptanceRevision: 'acceptance@1', workClass: 'implementation' } }, now: new Date('2026-09-22T12:00:00.000Z') });
    expect(observation.metrics).toMatchObject({ cohort: { recordCount: 1 }, usage: { total: null, unknownMeasurements: 1 },
      coverage: { registeredSessions: 1, usableSessions: 0, ratio: 0 }, unfinishedOrAbandoned: { recordCount: 1, tokens: null } });
    expect(observation.metrics.usageByModel).toEqual([expect.objectContaining({ provider: 'codex', model: 'configured-model', workClass: 'implementation', recordCount: 1, unknownMeasurements: 1 })]);
  });
});
