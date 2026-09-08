import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createConsoleService } from '../../src/console/service.ts';
import { createConsoleOwnerActions } from '../../src/console/owner-actions.ts';
import { parseLocalConsoleConfiguration, startLocalConsole } from '../../src/console/startup.ts';
import { providerContextPayloadDigest } from '../../src/providers/contracts.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';
import { evaluatePreflight } from '../../src/diagnostics/preflight.ts';

async function waitFor(read, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (await predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for test condition');
}

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
      expect(first.json().command.status).toBe('completed');
      expect(replay.json().command.status).toBe('completed');
      expect(coordinator.snapshot('run-1').messages).toHaveLength(1);
      expect(coordinator.journal.events().filter((event) => event.kind === 'console.command')).toHaveLength(2);
      const conflict = await app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: { ...request, command: { ...request.command, body: 'Conflicting payload.' } } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().command.result.detail).toBe('command_id_payload_conflict');
      expect(coordinator.journal.events().filter((event) => event.kind === 'console.command')).toHaveLength(2);
      expect((await app.inject({ method: 'POST', url: '/api/console/commands', payload: request })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/console/commands', headers: { ...headers, origin: 'https://evil.example' }, payload: request })).statusCode).toBe(403);
    } finally {
      await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it('projects only safe read-only blockers without leaking unsafe ownership paths', async () => {
    const { root, coordinator } = await fixture();
    await coordinator.record('provider.event', 'run-1', { type: 'delegation.blocked', blocker: { format: 'faktori.blocker/v1', blockerId: 'untrusted', reasonCode: 'ownership_conflicts_with_active_child', decisionOwnerRole: 'parent_coordinator', related: { parentRunId: 'run-1' }, ownership: { state: 'observed', paths: ['src/safe.ts', '/Users/nobody/.codex/secret', '../escape', 'https://evil.example/x'], omittedPathCount: 0 }, overlaps: [], omittedIdentityCount: 0, remediation: 'untrusted' } });
    const app = createConsoleService({ coordinator, commandToken: 'local-secret', allowedOrigins: ['http://127.0.0.1:4173'] });
    try {
      const state = (await app.inject({ method: 'GET', url: '/api/console/state' })).json();
      expect(state.blockers).toEqual([expect.objectContaining({ format: 'faktori.blocker/v1', ownership: { state: 'observed', paths: ['src/safe.ts'], omittedPathCount: 3 } })]);
      expect(JSON.stringify(state)).not.toMatch(/Users|escape|evil\.example|secret/);
    } finally { await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('returns the same read-only preflight report evaluated for the Factory view', async () => {
    const { root, coordinator } = await fixture();
    const scope = { factoryId: 'factory', productId: 'product' };
    const configuration = {
      factory: { id: 'factory', name: 'Factory', defaults: { providerId: 'codex', environmentId: 'local', executionProfile: 'isolated', budget: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 5, maxTokens: 1000, strictSpending: true } } },
      providers: [{ id: 'codex', kind: 'codex', capabilities: ['isolated', 'token-limit'] }],
      environments: [{ id: 'local', kind: 'local' }],
      products: [{ id: 'product', name: 'Product' }],
      pods: [],
    };
    const observed = (id) => ({ id, status: 'pass', freshness: 'current', scope });
    const preflight = evaluatePreflight({
      format: 'faktori.preflight/v1', configuration, target: scope,
      providers: [{ providerId: 'codex', capabilities: [{ capability: 'isolated', ...observed('isolated') }, { capability: 'token-limit', ...observed('token-limit') }] }],
      console: { prerequisites: [observed('projection')] },
      execution: { prerequisites: [observed('profile')] },
      resources: { prerequisites: [observed('budget')] },
      integrations: { prerequisites: [observed('read_adapter')] },
    });
    const app = createConsoleService({ coordinator, commandToken: 'local-secret', allowedOrigins: ['http://127.0.0.1:4173'], preflight });
    try {
      const state = (await app.inject({ method: 'GET', url: '/api/console/state' })).json();
      expect(state.preflight).toEqual(preflight);
      expect(state.preflight).toMatchObject({ status: 'partial', projectionReady: false, executionReady: false, liveExecutionVerified: false });
    } finally { await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('streams provider journal changes to an already-connected Console client', async () => {
    const { root, coordinator } = await fixture();
    const app = createConsoleService({ coordinator, commandToken: 'local-secret', allowedOrigins: ['http://127.0.0.1:4173'], eventPollIntervalMs: 10 });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${address}/api/console/events`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const initial = decoder.decode((await reader.read()).value);
      expect(initial).toContain('event: state');
      await coordinator.record('provider.final', 'run-1', { result: { outcome: 'failed', summary: 'bounded failure', usage: { availability: 'unavailable', unavailableReason: 'test' }, nativeCancellationReceipt: false } });
      const update = await Promise.race([
        reader.read().then((item) => decoder.decode(item.value)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SSE update timeout')), 1_000)),
      ]);
      expect(update).toContain('"state":"failed"');
      await reader.cancel();
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
      expect(started.json().command.result).toEqual({ runId: 'run-2', detail: 'provider_delivery_started' });
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

  it('reclaims only a lock whose exact coordinator process is observed gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-console-reclaim-'));
    const journalPath = join(root, 'operations.jsonl');
    const lockPath = `${journalPath}.coordinator-lock`;
    const config = parseLocalConsoleConfiguration({ factoryId: 'factory', journalPath, projectionPath: join(root, 'projection.sqlite'), port: 0, allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 100, strictSpending: false, strictSpendingSupported: false } });
    const current = { pid: process.pid, processStartedAt: 'current-process-start', processGroupId: process.pid, running: true };
    const probe = (processList) => ({ inspect: async (pid) => pid === process.pid ? current : { status: 'unknown' }, inspectAll: async () => processList });

    try {
      await writeFile(lockPath, `${JSON.stringify({ instanceId: 'gone', pid: 910_001, processStartedAt: 'old-start', processGroupId: 910_001 })}\n`);
      const started = await startLocalConsole(config, undefined, { coordinatorIdentityProbe: probe([current]) });
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      await started.close();

      await writeFile(lockPath, `${JSON.stringify({ instanceId: 'reused', pid: 910_002, processStartedAt: 'old-start', processGroupId: 910_002 })}\n`);
      await expect(startLocalConsole(config, undefined, { coordinatorIdentityProbe: probe([current, { pid: 910_002, processStartedAt: 'replacement-start', processGroupId: 910_002, running: true }]) })).rejects.toThrow(/coordinator is mismatch/);

      await writeFile(lockPath, `${JSON.stringify({ instanceId: 'unknown', pid: 910_003, processStartedAt: 'old-start', processGroupId: 910_003 })}\n`);
      await expect(startLocalConsole(config, undefined, { coordinatorIdentityProbe: probe({ status: 'unknown' }) })).rejects.toThrow(/coordinator is unknown/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('projects the canonical factory product and pod hierarchy into Console filters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-console-hierarchy-'));
    try {
      const factoryConfiguration = JSON.parse(await readFile(new URL('../../examples/config/solo.json', import.meta.url), 'utf8'));
      const config = parseLocalConsoleConfiguration({ factoryId: 'solo-studio', factoryConfiguration, journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0, allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 45, maxTokens: 30_000, strictSpending: true, strictSpendingSupported: true } });
      const started = await startLocalConsole(config);
      const state = (await started.app.inject({ method: 'GET', url: '/api/console/state' })).json();
      expect(state.hierarchy.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'factory:solo-studio', label: 'Solo Studio' }),
        expect.objectContaining({ id: 'product:website', label: 'Studio website' }),
        expect.objectContaining({ id: 'pod:website-pod', productId: 'website' }),
      ]));
      expect(state.hierarchy.parentEdges).toEqual(expect.arrayContaining([{ from: 'factory:solo-studio', to: 'product:website' }, { from: 'product:website', to: 'pod:website-pod' }]));
      expect(state.hierarchy.filters).toEqual({ products: [{ id: 'website', name: 'Studio website' }], pods: [{ id: 'website-pod', productId: 'website' }] });
      await started.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses installed runtime config to reach coordinator admission and the Codex adapter delivery boundary', async () => {
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
          resumePlans: [],
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
      expect(response.json().command.result.detail).toBe('provider_delivery_started');
      await waitFor(() => started.coordinator.snapshot('installed-run'), (snapshot) => snapshot?.state === 'succeeded');
      expect(started.coordinator.snapshot('installed-run')).toEqual(expect.objectContaining({ providerResult: expect.objectContaining({ outcome: 'completed' }) }));
      await started.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps a held provider turn non-blocking so messages and durable cancellation remain usable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-console-cancel-'));
    let release;
    let exited = false;
    const worker = { kind: 'native', pid: 991, processStartedAt: 'worker-start', processGroupId: 991, runNonce: 'cancel-test' };
    try {
      const configuredIntent = intent('held-run');
      configuredIntent.execution.model = 'fixture';
      const context = { packetRevision: 'packet@1', digest: 'packet', prompt: 'Hold until the owner cancels this test turn.' };
      configuredIntent.execution.approvedInputDigests = [providerContextPayloadDigest(context)];
      const config = parseLocalConsoleConfiguration({
        factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
        commandToken: 'installed-token', allowedOrigins: ['http://127.0.0.1:4173'],
        limits: { maxConcurrentRuns: 3, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 500, strictSpending: false, strictSpendingSupported: false },
        runtime: { provider: { id: 'codex', environment: { PATH: '/usr/bin' }, compatibleModels: ['fixture'], runNonce: 'cancel-test' }, workItems: [{ workItemId: 'held-work', intent: configuredIntent, context }], resumePlans: [] },
      });
      const held = new Promise((resolve) => { release = resolve; });
      const started = await startLocalConsole(config, undefined, {
        codexRunner: {
          async run(request) {
            await request.lifecycle?.onStarted(worker);
            await held;
            return { exitCode: null, stdout: '', terminated: true };
          },
          async terminate(request) {
            await request.lifecycle?.onTerminationRequired(worker, 'cancelled');
            exited = true;
            release();
            return { processTerminated: true, nativeCancellationReceipt: false };
          },
        },
        nativeIdentityProbe: {
          inspect: async () => exited ? { status: 'absent' } : { ...worker, running: true },
          inspectProcessGroup: async () => exited ? { status: 'absent' } : { processGroupId: worker.processGroupId, members: [{ pid: worker.pid, processStartedAt: worker.processStartedAt, processGroupId: worker.processGroupId, running: true }] },
        },
      });
      const headers = { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'installed-token' };
      const start = await started.app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: { commandId: 'held-start', command: { type: 'start_work', workItemId: 'held-work' } } });
      expect(start.statusCode).toBe(200);
      expect(start.json().command.result.detail).toBe('provider_delivery_started');
      await waitFor(() => started.coordinator.snapshot('held-run'), (snapshot) => snapshot?.state === 'running');
      const message = await started.app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: { commandId: 'held-message', command: { type: 'message', runId: 'held-run', body: 'Use this on the next turn only.' } } });
      expect(message.statusCode).toBe(200);
      const cancelled = await started.app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: { commandId: 'held-cancel', command: { type: 'cancel', runId: 'held-run', reason: 'owner_cancelled' } } });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().command.result.detail).toBe('provider_interrupted_uncertain');
      expect(started.coordinator.snapshot('held-run')).toEqual(expect.objectContaining({ state: 'cancelled', authorityRevoked: true, messages: [expect.objectContaining({ delivery: 'next_turn' })] }));
      await started.close();
    } finally { release?.(); await rm(root, { recursive: true, force: true }); }
  });

  it('resumes only the configured target through an explicit durable source session binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-console-resume-'));
    try {
      const sourceIntent = intent('source-run');
      const targetIntent = intent('target-run');
      sourceIntent.execution.model = targetIntent.execution.model = 'fixture';
      const sourceContext = { packetRevision: 'packet@1', digest: 'packet', prompt: 'Create the source provider session.' };
      const targetContext = { packetRevision: 'packet@1', digest: 'packet', prompt: 'Continue only in the explicitly bound source session.' };
      sourceIntent.execution.approvedInputDigests = [providerContextPayloadDigest(sourceContext)];
      targetIntent.execution.approvedInputDigests = [providerContextPayloadDigest(targetContext)];
      const calls = [];
      const config = parseLocalConsoleConfiguration({
        factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
        commandToken: 'installed-token', allowedOrigins: ['http://127.0.0.1:4173'],
        limits: { maxConcurrentRuns: 3, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 500, strictSpending: false, strictSpendingSupported: false },
        runtime: {
          provider: { id: 'codex', environment: { PATH: '/usr/bin' }, compatibleModels: ['fixture'], runNonce: 'resume-test' },
          workItems: [{ workItemId: 'source-work', intent: sourceIntent, context: sourceContext }, { workItemId: 'target-work', intent: targetIntent, context: targetContext }],
          resumePlans: [{ sourceRunId: 'source-run', targetWorkItemId: 'target-work' }],
        },
      });
      const started = await startLocalConsole(config, undefined, { codexRunner: { async run(request) { calls.push(request.args); await request.lifecycle?.onStarted({ kind: 'native', pid: 992, processStartedAt: `worker-${calls.length}`, processGroupId: 992, runNonce: 'resume-test' }); return { exitCode: 0, stdout: calls.length === 1 ? `${JSON.stringify({ type: 'thread.started', thread_id: 'explicit-session' })}\n${JSON.stringify({ type: 'turn.completed', last_agent_message: 'source done' })}\n` : `${JSON.stringify({ type: 'turn.completed', last_agent_message: 'resume done' })}\n` }; } } });
      const headers = { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'installed-token' };
      await started.app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: { commandId: 'source-start', command: { type: 'start_work', workItemId: 'source-work' } } });
      await waitFor(() => started.coordinator.snapshot('source-run'), (snapshot) => snapshot?.state === 'succeeded');
      const resumed = await started.app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: { commandId: 'resume-source', command: { type: 'resume', runId: 'source-run' } } });
      expect(resumed.statusCode).toBe(200);
      await waitFor(() => started.coordinator.snapshot('target-run'), (snapshot) => snapshot?.state === 'succeeded');
      expect(calls[1]).toEqual(['exec', 'resume', '--json', '--model', 'fixture', 'explicit-session', targetContext.prompt]);
      await started.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('automatically turns durable repeated provider failures into one provider-backed bounded GM diagnosis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-console-gm-'));
    try {
      const findingKey = 'factory:repeated_handoff_failure:product:work-1:codex';
      const instructions = { revision: 'gm@1', content: 'Diagnose factory health. Recommend only bounded maintenance or approval-required improvements.' };
      const diagnosisIntent = intent('gm-diagnosis-run');
      diagnosisIntent.execution.model = 'fixture';
      diagnosisIntent.workItem = { id: 'gm-diagnosis', revision: 'gm@1' };
      diagnosisIntent.execution.approvedInputDigests = [];
      const config = parseLocalConsoleConfiguration({
        factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
        commandToken: 'installed-token', allowedOrigins: ['http://127.0.0.1:4173'],
        limits: { maxConcurrentRuns: 3, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 500, strictSpending: false, strictSpendingSupported: false },
        runtime: {
          provider: { id: 'codex', environment: { PATH: '/usr/bin' }, compatibleModels: ['fixture'], runNonce: 'gm-test' },
          workItems: [], resumePlans: [],
          gm: { instructions, diagnosisTemplate: { intent: diagnosisIntent } },
        },
      });
      const providerSummary = JSON.stringify({ summary: 'The same delivery route failed twice.', recommendations: [{ kind: 'factory_improvement', detail: 'Add a pre-handoff validation packet.' }] });
      let diagnosisRuns = 0;
      const started = await startLocalConsole(config, undefined, { healthPollIntervalMs: 10, codexRunner: { async run(request) { diagnosisRuns += 1; await request.lifecycle?.onStarted({ kind: 'native', pid: 993, processStartedAt: 'gm-worker', processGroupId: 993, runNonce: 'gm-test' }); return { exitCode: 0, stdout: `${JSON.stringify({ type: 'turn.completed', last_agent_message: providerSummary })}\n` }; } } });
      for (const [index, runId] of ['failure-run-1', 'failure-run-2'].entries()) {
        const failedIntent = intent(runId);
        failedIntent.attempt = index + 1;
        await started.coordinator.admit(failedIntent);
        await started.coordinator.record('provider.final', runId, { result: { outcome: 'failed', summary: 'test failure', usage: { availability: 'unavailable', unavailableReason: 'test' }, nativeCancellationReceipt: false } });
      }
      const state = await waitFor(
        () => started.app.inject({ method: 'GET', url: '/api/console/state' }).then((response) => response.json()),
        async (candidate) => (await candidate).factoryGM.findings[0]?.diagnosis.state === 'completed',
      );
      const resolved = await state;
      expect(resolved.factoryGM.findings[0]).toEqual(expect.objectContaining({ findingKey, occurrenceCount: 1, sourceEventIds: [expect.any(String)], diagnosis: expect.objectContaining({ state: 'completed' }) }));
      expect(resolved.factoryGM.improvements).toEqual([expect.objectContaining({ status: 'proposed', authority: 'requires_approval' })]);
      const third = intent('failure-run-3');
      third.attempt = 2;
      await started.coordinator.admit(third);
      await started.coordinator.record('provider.final', third.runId, { result: { outcome: 'failed', summary: 'new unseen failure', usage: { availability: 'unavailable', unavailableReason: 'test' }, nativeCancellationReceipt: false } });
      const repeated = await waitFor(
        () => started.app.inject({ method: 'GET', url: '/api/console/state' }).then((response) => response.json()),
        (candidate) => candidate.factoryGM.findings[0]?.occurrenceCount === 2,
      );
      expect(repeated.factoryGM.findings[0].sourceEventIds).toHaveLength(2);
      expect(diagnosisRuns).toBe(1);
      await started.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('selects configured Codex, Claude, and Cursor adapters per admitted work item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-console-providers-'));
    try {
      const providerIds = ['codex', 'claude', 'cursor'];
      const workItems = providerIds.map((providerId) => {
        const configuredIntent = intent(`${providerId}-run`);
        configuredIntent.execution.providerId = providerId;
        configuredIntent.execution.model = `${providerId}-model`;
        configuredIntent.workItem = { id: `${providerId}-work`, revision: 'work@1' };
        const context = { packetRevision: 'packet@1', digest: 'packet', prompt: `Run the configured ${providerId} route.` };
        configuredIntent.execution.approvedInputDigests = [providerContextPayloadDigest(context)];
        return { workItemId: `${providerId}-work`, intent: configuredIntent, context };
      });
      const calls = [];
      const adapter = (providerId) => ({
        async start(run, _context, lifecycle) { calls.push(providerId); await lifecycle?.onStarted({ kind: 'native', pid: 1000 + calls.length, processStartedAt: `${providerId}-worker`, processGroupId: 1000 + calls.length, runNonce: providerId }); return { command: 'start', events: [], malformedEventCount: 0, final: { outcome: 'completed', usage: { availability: 'unavailable', unavailableReason: 'test' }, nativeCancellationReceipt: false } }; },
        async resume() { throw new Error('not used'); },
      });
      const config = parseLocalConsoleConfiguration({
        factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
        commandToken: 'installed-token', allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 3, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 500, strictSpending: false, strictSpendingSupported: false },
        runtime: {
          providers: [
            { id: 'codex', environment: { PATH: '/usr/bin' }, compatibleModels: ['codex-model'], runNonce: 'codex' },
            { id: 'claude', environment: { PATH: '/usr/bin' }, compatibleModels: ['claude-model'], allowedTools: [], runNonce: 'claude' },
            { id: 'cursor', environment: { PATH: '/usr/bin' }, requestTimeoutMs: 1_000, runNonce: 'cursor' },
          ],
          workItems, resumePlans: [],
        },
      });
      const started = await startLocalConsole(config, undefined, { providerAdapters: { codex: adapter('codex'), claude: adapter('claude'), cursor: adapter('cursor') } });
      const headers = { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'installed-token' };
      for (const providerId of providerIds) await started.app.inject({ method: 'POST', url: '/api/console/commands', headers, payload: { commandId: `${providerId}-start`, command: { type: 'start_work', workItemId: `${providerId}-work` } } });
      await waitFor(() => started.coordinator.snapshots(), (snapshots) => snapshots.filter((snapshot) => snapshot.state === 'succeeded').length === 3);
      expect([...calls].sort()).toEqual([...providerIds].sort());
      await started.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('constructs the shipped isolated Codex route from an explicit hardened Docker profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-console-isolated-'));
    try {
      const control = join(root, 'control');
      await mkdir(control);
      const configuredIntent = intent('isolated-run');
      configuredIntent.execution.profile = 'isolated';
      configuredIntent.execution.model = 'fixture';
      configuredIntent.execution.workspacePath = join(root, 'workspace');
      const context = { packetRevision: 'packet@1', digest: 'packet', prompt: 'Run only in the hardened isolated profile.' };
      configuredIntent.execution.approvedInputDigests = [providerContextPayloadDigest(context)];
      const config = parseLocalConsoleConfiguration({
        factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
        allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 500, strictSpending: false, strictSpendingSupported: false },
        runtime: {
          providers: [{ id: 'codex', profile: 'isolated', environment: { PATH: '/usr/bin' }, compatibleModels: ['fixture'], runNonce: 'isolated-test', docker: { image: `sha256:${'a'.repeat(64)}`, scratchRoot: root, controlStoragePaths: [control], approvedInputs: [], networkMode: 'none', resources: { memoryBytes: 268_435_456, cpuCount: 1, pids: 64 }, allowUnsandboxedCodexInsideValidatedContainer: false } }],
          workItems: [{ workItemId: 'isolated-work', intent: configuredIntent, context }], resumePlans: [],
        },
      });
      const started = await startLocalConsole(config);
      expect((await started.app.inject({ method: 'GET', url: '/api/console/state' })).json().hierarchy.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'work:work-1' })]));
      await started.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects an unrecognized isolated credential-profile container identity mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-console-isolated-user-'));
    try {
      const control = join(root, 'control');
      const workspace = join(root, 'workspace');
      const credential = join(root, 'credential');
      await Promise.all([mkdir(control), mkdir(workspace), mkdir(credential)]);
      const configuredIntent = intent('isolated-user-run');
      configuredIntent.execution.profile = 'isolated';
      configuredIntent.execution.model = 'fixture';
      configuredIntent.execution.workspacePath = workspace;
      const context = { packetRevision: 'packet@1', digest: 'packet', prompt: 'Run only in the hardened isolated profile.' };
      configuredIntent.execution.approvedInputDigests = [providerContextPayloadDigest(context)];
      expect(() => parseLocalConsoleConfiguration({
        factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
        allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 500, strictSpending: false, strictSpendingSupported: false },
        runtime: {
          providers: [{ id: 'codex', profile: 'isolated', environment: { PATH: '/usr/bin' }, compatibleModels: ['fixture'], runNonce: 'isolated-test', docker: { image: `sha256:${'a'.repeat(64)}`, scratchRoot: root, controlStoragePaths: [control], approvedInputs: [], credentialProfile: { profileId: 'fixture', path: credential, environmentVariable: 'CODEX_HOME', containerUser: 'root' }, networkMode: 'none', resources: { memoryBytes: 268_435_456, cpuCount: 1, pids: 64 }, allowUnsandboxedCodexInsideValidatedContainer: false } }],
          workItems: [{ workItemId: 'isolated-work', intent: configuredIntent, context }], resumePlans: [],
        },
      })).toThrow(/containerUser/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
