import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseLocalConsoleConfiguration, startLocalConsole } from '../../src/console/startup.ts';

const identity = { pid: process.pid, processStartedAt: 'delivery-startup-test', processGroupId: process.pid, running: true };
const probe = { inspect: async () => identity, inspectAll: async () => [identity] };
function configuration(root) {
  return { factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'),
    port: 0, allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 100, strictSpending: false, strictSpendingSupported: false } };
}

describe('Console delivery synchronization startup', () => {
  it('does not evaluate delivery actions when the Console cannot acquire its listening port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-listener-'));
    const occupied = createServer();
    let started;
    let evaluations = 0;
    try {
      await new Promise((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', resolve);
      });
      const config = parseLocalConsoleConfiguration({ ...configuration(root), port: occupied.address().port,
        deliverySynchronization: { packetPath: join(root, 'packet.json'), grantVaultPath: join(root, 'vault') } });
      await expect(startLocalConsole(config, undefined, { coordinatorIdentityProbe: probe,
        deliverySynchronization: { clock: { now: () => { evaluations++; return new Date(); } } },
      }).then(value => { started = value; })).rejects.toThrow();
      expect(evaluations).toBe(0);
    } finally {
      await started?.close();
      await new Promise(resolve => occupied.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not enable synchronization in an existing installation without explicit configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-startup-'));
    let started;
    try {
      let externalCalls = 0;
      started = await startLocalConsole(parseLocalConsoleConfiguration(configuration(root)), undefined, {
        coordinatorIdentityProbe: probe,
        deliverySynchronization: { gh: async () => { externalCalls++; throw new Error('unexpected external call'); }, fetcher: async () => { externalCalls++; throw new Error('unexpected external call'); } },
      });
      expect((await started.app.inject('/api/console/delivery-synchronization')).json()).toEqual({ status: 'not_configured' });
      expect((await started.app.inject('/api/console/state')).json().deliverySynchronization).toEqual({ status: 'not_configured' });
      expect(externalCalls).toBe(0);
    } finally { await started?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('keeps an invalid configured packet visibly blocked without crashing the Console or exposing private paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-blocked-'));
    let started;
    try {
      const config = parseLocalConsoleConfiguration({ ...configuration(root), deliverySynchronization: { packetPath: join(root, 'private-evidence.json'), grantVaultPath: join(root, 'grant-vault'), pollIntervalMs: 5000 } });
      started = await startLocalConsole(config, undefined, { coordinatorIdentityProbe: probe });
      const response = await started.app.inject('/api/console/delivery-synchronization');
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('blocked');
      expect(response.body).not.toContain(root);
      expect(started.coordinator.snapshots()).toEqual([]);
    } finally { await started?.close(); await rm(root, { recursive: true, force: true }); }
  });
});
