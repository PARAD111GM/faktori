import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createConsoleService } from '../../src/console/service.ts';
import { createConsoleOwnerActions } from '../../src/console/owner-actions.ts';
import { parseLocalConsoleConfiguration, startLocalConsole } from '../../src/console/startup.ts';
import { providerContextPayloadDigest } from '../../src/providers/contracts.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

function intent(runId = 'run-1') {
  return {
    format: 'faktori.run-intent/v1', runId, admissionKey: `admission-${runId}`,
    workItem: { id: 'work-1', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'org/repo', branch: 'work-1', baseRevision: 'base', expectedRevision: 'head' },
    context: { packetRevision: 'packet@1', digest: 'packet' },
    execution: { profile: 'native', workspaceId: 'workspace-1', workspacePath: '/private/tmp/workspace-1', providerId: 'codex', model: 'fixture', approvedInputDigests: [] },
    budget: { reservationId: `reservation-${runId}`, maxRuntimeMinutes: 5, estimatedTokens: 30, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1, createdAt: '2026-09-05T00:00:00.000Z',
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'faktori-console-'));
  const coordinator = await DurableCoordinator.open({
    factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'),
    identity: { instanceId: 'console-owner', pid: 101, processStartedAt: 'now' },
    limits: { maxConcurrentRuns: 3, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 500, strictSpending: false, strictSpendingSupported: false },
  });
  await coordinator.claim();
  await coordinator.admit(intent());
  return { root, coordinator };
}

describe('loopback Console service', () => {
  it('renders a durable coordinator projection and gives a repeated owner message one confirmed result', async () => {
    const { root, coordinator } = await fixture();
    const app = createConsoleService({ coordinator, commandToken: 'local-secret', allowedOrigins: ['http://127.0.0.1:4173'] });
    try {
      const before = await app.inject({ method: 'GET', url: '/api/console/state' });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual(expect.objectContaining({ runs: [expect.objectContaining({ runId: 'run-1', state: 'admitted' })] }));
      expect(JSON.stringify(before.json())).not.toContain('/private/tmp/workspace-1');

      const request = { commandId: 'message-1', command: { type: 'message', runId: 'run-1', body: 'Please verify the focused test.' } };
      const headers = { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'local-secret' };
      const [first, replay] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: request }),
        app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: request }),
      ]);
      expect(first.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(coordinator.snapshot('run-1').messages).toHaveLength(1);
      expect(coordinator.journal.events().filter((event) => event.kind === 'console.command')).toHaveLength(2);
      expect((await app.inject({ method: 'POST', url: '/api/console/commands', payload: request })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/console/commands', headers: { ...headers, origin: 'https://evil.example' }, payload: request })).statusCode).toBe(403);
    } finally {
      await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it('serves built local assets with the local command token only in the loopback document', async () => {
    const { root, coordinator } = await fixture();
    const assets = join(root, 'assets');
    await (await import('node:fs/promises')).mkdir(assets, { recursive: true });
    await (await import('node:fs/promises')).writeFile(join(assets, 'index.html'), '<!doctype html><head><title>Console</title></head><body><div id="root"></div></body>');
    await (await import('node:fs/promises')).writeFile(join(assets, 'app.js'), 'console.log("asset")');
    const app = createConsoleService({ coordinator, commandToken: 'local-secret', allowedOrigins: ['http://127.0.0.1:4173'], assetsDirectory: assets });
    try {
      const document = await app.inject({ method: 'GET', url: '/' });
      expect(document.statusCode).toBe(200);
      expect(document.body).toContain('name="faktori-console-token" content="local-secret"');
      expect((await app.inject({ method: 'GET', url: '/app.js' })).headers['content-type']).toContain('application/javascript');
      expect((await app.inject({ method: 'GET', url: '/../operations.jsonl' })).statusCode).toBe(404);
    } finally { await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('shows a failed owner command rather than inventing an unsupported provider capability', async () => {
    const { root, coordinator } = await fixture();
    const app = createConsoleService({ coordinator, commandToken: 'local-secret', allowedOrigins: ['http://127.0.0.1:4173'] });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/console/commands', headers: { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'local-secret' }, payload: { commandId: 'answer-1', command: { type: 'answer', runId: 'run-1', requestId: 'permission-1', answer: 'yes' } } });
      expect(response.statusCode).toBe(409);
      expect(response.json().command.result.detail).toBe('answer_unsupported_by_provider');
    } finally {
      await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it('admits only a trusted eligible work intent and invokes the provider boundary after admission', async () => {
    const { root, coordinator } = await fixture();
    const starts = [];
    const ownerActions = createConsoleOwnerActions(coordinator, {
      intentForWorkItem: async (workItemId) => workItemId === 'work-2' ? intent('run-2') : undefined,
      startAdmittedRun: async (runId) => { starts.push(runId); return { detail: 'provider delivery admitted' }; },
    });
    const app = createConsoleService({ coordinator, commandToken: 'local-secret', allowedOrigins: ['http://127.0.0.1:4173'], ownerActions });
    try {
      const headers = { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'local-secret' };
      const started = await app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: { commandId: 'start-1', command: { type: 'start_work', workItemId: 'work-2' } } });
      expect(started.statusCode).toBe(200);
      expect(started.json().command.result).toEqual({ runId: 'run-2', detail: 'provider delivery admitted' });
      expect(starts).toEqual(['run-2']);
      expect(coordinator.snapshot('run-2')).toEqual(expect.objectContaining({ state: 'admitted' }));
      const notEligible = await app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: { commandId: 'start-2', command: { type: 'start_work', workItemId: 'not-eligible' } } });
      expect(notEligible.statusCode).toBe(409);
      expect(notEligible.json().command.result.detail).toBe('work_item_not_eligible');
    } finally {
      await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it('starts only from explicit loopback configuration and accepts no wildcard browser origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-console-startup-'));
    try {
      const config = parseLocalConsoleConfiguration({ factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0, allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 2, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 100, strictSpending: false, strictSpendingSupported: false } });
      const started = await startLocalConsole(config);
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      await started.close();
      expect(() => parseLocalConsoleConfiguration({ ...config, allowedOrigins: ['*'] })).toThrow(/exact loopback/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses installed deterministic config to reach coordinator admission and the Codex adapter delivery boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-console-installed-'));
    try {
      const configuredIntent = intent('installed-run');
      configuredIntent.execution.model = 'fixture';
      const context = { packetRevision: 'packet@1', digest: 'packet', prompt: 'Run the deterministic installed fixture.' };
      configuredIntent.execution.approvedInputDigests = [providerContextPayloadDigest(context)];
      const config = parseLocalConsoleConfiguration({
        factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
        commandToken: 'installed-token', allowedOrigins: ['http://127.0.0.1:4173'],
        limits: { maxConcurrentRuns: 3, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 500, strictSpending: false, strictSpendingSupported: false },
        runtime: {
          provider: { id: 'codex', environment: { PATH: '/usr/bin' }, compatibleModels: ['fixture'], runNonce: 'installed-test' },
          workItems: [{ workItemId: 'installed-work', intent: configuredIntent, context }],
          gm: { instructions: { revision: 'gm@1', content: 'Diagnose only factory health.' }, diagnosisResponse: { summary: 'bounded diagnosis' } },
        },
      });
      const started = await startLocalConsole(config, undefined, {
        codexRunner: {
          async run(request) {
            await request.lifecycle?.onStarted({ kind: 'native', pid: process.pid, processStartedAt: 'test-start', processGroupId: process.pid, runNonce: 'installed-test' });
            return { exitCode: 0, stdout: JSON.stringify({ type: 'turn.completed', outcome: 'completed', summary: 'deterministic completed' }) };
          },
          async terminate() { return { processTerminated: false }; },
        },
      });
      const response = await started.app.inject({ method: 'POST', url: '/api/console/commands', headers: { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'installed-token' }, payload: { commandId: 'installed-start', command: { type: 'start_work', workItemId: 'installed-work' } } });
      expect(response.statusCode).toBe(200);
      expect(response.json().command.result.detail).toBe('provider_completed');
      expect(started.coordinator.snapshot('installed-run')).toEqual(expect.objectContaining({ state: 'succeeded', providerResult: expect.objectContaining({ outcome: 'completed' }) }));
      const finding = await started.gm.observe({ kind: 'repeated_handoff_failure', factoryId: 'factory', handoffKey: 'installed-work:review', observedAt: '2026-09-05T00:00:00.000Z', summary: 'Installed deterministic handoff failure.' });
      expect(finding.diagnosisInvoked).toBe(true);
      await started.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
