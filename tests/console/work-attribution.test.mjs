import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { registerWorkAttribution } from '../../src/console/work-attribution.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

const binding = { featureId: 'feature-one', acceptanceRevision: 'acceptance@1', workClass: 'implementation' };

async function coordinator(root, instance) {
  const value = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, `projection-${instance}.sqlite`),
    identity: { instanceId: instance, pid: instance === 'first' ? 2101 : 2102, processStartedAt: '2026-09-22T12:00:00.000Z', processGroupId: 1 },
    limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 10, strictSpending: false, strictSpendingSupported: false },
    processProbe: { coordinator: async () => 'dead', worker: async () => 'unknown' } });
  await value.claim(); return value;
}

describe('durable work attribution', () => {
  it('preserves immutable bindings through reordered restart input and omitted later config without duplicate records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-work-attribution-'));
    let first; let restarted;
    try {
      first = await coordinator(root, 'first');
      expect(await registerWorkAttribution(first, { 'work-one': binding })).toEqual({ 'work-one': binding });
      expect(first.journal.events().filter(event => event.kind === 'factory.delivery' && event.data.family === 'feature')).toHaveLength(1);
      await first.release(); first.close(); first = undefined;

      restarted = await coordinator(root, 'restarted');
      const reordered = { 'work-one': { workClass: 'implementation', acceptanceRevision: 'acceptance@1', featureId: 'feature-one' } };
      expect(await registerWorkAttribution(restarted, reordered)).toEqual({ 'work-one': binding });
      expect(await registerWorkAttribution(restarted, {})).toEqual({ 'work-one': binding });
      expect(restarted.journal.events().filter(event => event.kind === 'factory.delivery' && event.data.family === 'feature')).toHaveLength(1);
      await expect(registerWorkAttribution(restarted, { 'work-one': { ...binding, acceptanceRevision: 'acceptance@2' } })).rejects.toThrow('feature_attribution_is_immutable');
    } finally { await restarted?.release(); restarted?.close(); await first?.release(); first?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('rejects an invalid direct caller rather than relying on prior configuration parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-work-attribution-')); let value;
    try {
      value = await coordinator(root, 'first');
      await expect(registerWorkAttribution(value, { invalid: { featureId: 'feature', acceptanceRevision: 'rev', workClass: 'invalid' } })).rejects.toThrow('work_attribution_binding_invalid');
      expect(value.journal.events().filter(event => event.kind === 'factory.delivery' && event.data.family === 'feature')).toEqual([]);
    } finally { await value?.release(); value?.close(); await rm(root, { recursive: true, force: true }); }
  });
});
