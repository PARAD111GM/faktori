import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DeliveryControl } from '../../src/console/delivery-control.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

async function coordinator(root, instanceId) {
  const value = await DurableCoordinator.open({
    factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'),
    identity: { instanceId, pid: 1, processStartedAt: instanceId },
    limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 0, strictSpending: false, strictSpendingSupported: false },
  });
  await value.claim();
  return value;
}

describe('DeliveryControl shutdown boundary', () => {
  it('records an accepted but unstarted command as uncertain, never effects it, and does not replay it after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-control-'));
    const scheduled = [];
    let first; let restarted; let effects = 0;
    const command = { type: 'consultation', packet: { id: 'bounded' } };
    try {
      first = await coordinator(root, 'first');
      const control = new DeliveryControl(first, () => ({}), async () => { effects += 1; }, (start) => scheduled.push(start));
      await expect(control.submit('accepted-before-close', command)).resolves.toMatchObject({ status: 'accepted' });
      expect(effects).toBe(0);

      await control.quiesce();
      expect(effects).toBe(0);
      expect(control.snapshot().commands).toEqual([expect.objectContaining({ commandId: 'accepted-before-close', status: 'uncertain', detail: 'delivery_quiesced_before_effect_started' })]);
      scheduled.forEach((start) => start());
      await control.settle();
      expect(effects).toBe(0);
      await expect(control.submit('new-after-close', command)).rejects.toThrow('delivery_control_quiescing');

      await first.release(); first.close(); first = undefined;
      restarted = await coordinator(root, 'restarted');
      const afterRestart = new DeliveryControl(restarted, () => ({}), async () => { effects += 1; });
      await expect(afterRestart.submit('accepted-before-close', command)).resolves.toMatchObject({ status: 'uncertain' });
      await afterRestart.settle();
      expect(effects).toBe(0);
    } finally {
      await restarted?.release(); restarted?.close();
      await first?.release(); first?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('settles effects that had already started while quiesce prevents only later dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-control-active-'));
    const scheduled = [];
    let value; let release;
    try {
      value = await coordinator(root, 'active');
      const effect = new Promise((resolve) => { release = resolve; });
      const control = new DeliveryControl(value, () => ({}), async () => effect, (start) => scheduled.push(start));
      await control.submit('already-running', { type: 'preview', operationId: 'configured' });
      scheduled.shift()();
      await Promise.resolve();
      const quiesced = control.quiesce();
      await quiesced;
      let settled = false;
      const waiting = control.settle().then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await waiting;
      expect(control.snapshot().commands).toEqual([expect.objectContaining({ commandId: 'already-running', status: 'completed' })]);
    } finally {
      await value?.release(); value?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
