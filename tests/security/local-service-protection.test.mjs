import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createConsoleService } from '../../src/console/service.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

function intent(runId = 'run-1') {
  return {
    format: 'faktori.run-intent/v1', runId, admissionKey: `admission-${runId}`,
    workItem: { id: 'work-1', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'org/repo', branch: 'build/phase-6', baseRevision: 'base', expectedRevision: 'head' },
    context: { packetRevision: 'packet@1', digest: 'packet' },
    execution: { profile: 'native', workspaceId: 'workspace', workspacePath: '/private/tmp/worker-only', providerId: 'codex', model: 'fixture', approvedInputDigests: [] },
    budget: { reservationId: `reservation-${runId}`, maxRuntimeMinutes: 5, estimatedTokens: 10, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1, createdAt: '2026-09-05T00:00:00.000Z',
  };
}

async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'faktori-local-security-'));
  const coordinator = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), identity: { instanceId: 'security-test', pid: 301, processStartedAt: '2026-09-05T00:00:00.000Z' }, limits: { maxConcurrentRuns: 2, maxRetries: 1, maxRuntimeMinutes: 20, maxTokens: 100, strictSpending: false, strictSpendingSupported: false } });
  await coordinator.claim(); await coordinator.admit(intent());
  const assets = join(root, 'assets'); await mkdir(assets); await writeFile(join(assets, 'index.html'), '<!doctype html><head><title>Console</title></head><body><main>safe</main></body>');
  await writeFile(join(root, 'control-secret.txt'), 'controller credential');
  const app = createConsoleService({ coordinator, commandToken: 'expected-token', allowedOrigins: ['http://127.0.0.1:4173'], assetsDirectory: assets });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { root, coordinator, app, address, assets };
}

describe('running loopback Console rejects crafted requests', () => {
  it('requires the exact origin and token over an actual localhost listener before any command side effect', async () => {
    const test = await serviceFixture();
    const payload = { commandId: 'hostile-message', command: { type: 'message', runId: 'run-1', body: 'hello' } };
    const post = (headers) => fetch(`${test.address}/api/console/commands`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
    try {
      expect((await post({ origin: 'http://127.0.0.1:4173' })).status).toBe(401);
      expect((await post({ origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'wrong-token' })).status).toBe(401);
      expect((await post({ origin: 'https://attacker.invalid', 'x-faktori-console-token': 'expected-token' })).status).toBe(403);
      expect(test.coordinator.snapshot('run-1').messages).toEqual([]);
      expect((await post({ origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'expected-token' })).status).toBe(200);
      expect(test.coordinator.snapshot('run-1').messages).toHaveLength(1);
    } finally { await test.app.close(); await test.coordinator.release(); test.coordinator.close(); await rm(test.root, { recursive: true, force: true }); }
  });

  it('does not let forged run scope, hostile script text, traversal, or static symlinks escape the local service boundary', async () => {
    const test = await serviceFixture();
    try {
      const headers = { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'expected-token', 'content-type': 'application/json' };
      const forged = await fetch(`${test.address}/api/console/commands`, { method: 'POST', headers, body: JSON.stringify({ commandId: 'forged-run', command: { type: 'message', runId: 'other-run', body: 'forged scope' } }) });
      expect(forged.status).toBe(409);
      expect(test.coordinator.snapshot('run-1').messages).toEqual([]);

      const scriptBody = '<script>window.pwned=true</script>';
      const script = await fetch(`${test.address}/api/console/commands`, { method: 'POST', headers, body: JSON.stringify({ commandId: 'script-content', command: { type: 'message', runId: 'run-1', body: scriptBody } }) });
      expect(script.status).toBe(200);
      expect(script.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(script.headers.get('content-type')).toContain('application/json');
      const document = await fetch(`${test.address}/`);
      expect(document.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(await document.text()).not.toContain(scriptBody);

      await symlink(join(test.root, 'control-secret.txt'), join(test.assets, 'controller-link.txt'));
      for (const path of ['/../control-secret.txt', '/%2e%2e/control-secret.txt', '/controller-link.txt']) {
        const response = await fetch(`${test.address}${path}`);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('controller credential');
      }
    } finally { await test.app.close(); await test.coordinator.release(); test.coordinator.close(); await rm(test.root, { recursive: true, force: true }); }
  });
});
