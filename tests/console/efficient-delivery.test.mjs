import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseLocalConsoleConfiguration, startLocalConsole } from '../../src/console/startup.ts';
import { providerContextPayloadDigest } from '../../src/providers/contracts.ts';

const now = '2026-09-22T12:00:00.000Z';
const identity = { pid: process.pid, processStartedAt: 'efficient-delivery-test', processGroupId: process.pid, running: true };
const probe = { inspect: async () => identity, inspectAll: async () => [identity] };
const headers = { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'installed-token' };

async function waitFor(read, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (await predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for test condition');
}

function policy() {
  return { format: 'faktori.role-queue-policy/v1', revision: 'queue-policy@1', stages: [
    { stageId: 'needs_specification', role: 'planner', statusIds: ['spec'], entryGuards: [], maxWip: 1 },
    { stageId: 'ready_to_build', role: 'builder', statusIds: ['build'], entryGuards: ['approved-spec'], maxWip: 3 },
    { stageId: 'ready_for_review', role: 'reviewer', statusIds: ['review'], entryGuards: ['candidate'], maxWip: 1 },
    { stageId: 'human_review', role: 'human', statusIds: ['human'], entryGuards: ['review'], maxWip: 1 },
    { stageId: 'ready_to_release', role: 'release', statusIds: ['release'], entryGuards: ['accepted'], maxWip: 1 },
    { stageId: 'staging_acceptance', role: 'acceptance', statusIds: ['staging'], entryGuards: ['deployment'], maxWip: 1 },
    { stageId: 'done', role: 'acceptance', statusIds: ['done'], entryGuards: ['accepted'], maxWip: 0 },
  ] };
}

function candidate(id, runtimeWorkItemId, revision, rank) {
  return { workItemId: id, runtimeWorkItemId, executionScope: 'local-queue', trackerStatusId: 'build', revision, rank,
    queuedAt: '2026-09-20T12:00:00.000Z', dependencies: [], entryEvidence: [{ guardId: 'approved-spec', revision, observedAt: now }] };
}

function source(candidates, revision = 'source@1') {
  return { format: 'faktori.console-workflow-source/v1', revision, validUntil: '2030-01-01T00:00:00.000Z', policy: policy(), candidates };
}

function runIntent(runId, workItemId, revision) {
  const context = { packetRevision: `${revision}:packet`, digest: `${revision}:context`, prompt: `Perform only the configured ${workItemId} work.` };
  return { workItemId, context, intent: {
    format: 'faktori.run-intent/v1', runId, admissionKey: `admission-${runId}`, workItem: { id: workItemId, revision, role: 'builder' },
    target: { factoryId: 'factory', productId: 'product', repository: 'owner/faktori', branch: 'main', baseRevision: 'base', expectedRevision: 'head' },
    context: { packetRevision: context.packetRevision, digest: context.digest },
    execution: { profile: 'native', workspaceId: `${workItemId}-workspace`, workspacePath: `/private/tmp/${workItemId}-workspace`, providerId: 'codex', model: 'queue-model', approvedInputDigests: [providerContextPayloadDigest(context)] },
    budget: { reservationId: `reservation-${runId}`, maxRuntimeMinutes: 5, estimatedTokens: 1, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1, createdAt: now,
  } };
}

function configuration(root, sourcePath) {
  const first = runIntent('queue-run-one', 'configured-builder-one', 'candidate@1');
  const second = runIntent('queue-run-two', 'configured-builder-two', 'candidate@2');
  const observedAt = new Date().toISOString();
  return {
    factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
    commandToken: 'installed-token', allowedOrigins: ['http://127.0.0.1:4173'],
    limits: { maxConcurrentRuns: 3, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 100, strictSpending: false, strictSpendingSupported: false },
    workflow: { sourcePath, executionScopes: ['local-queue'], legacyExecutionScopes: [] },
    previews: { format: 'faktori.persistent-preview-runtime/v1', registrations: [], operations: [] },
    workAttribution: {
      'configured-builder-one': { acceptanceRevision: 'acceptance@1', featureId: 'efficient-delivery', workClass: 'implementation' },
      'configured-builder-two': { acceptanceRevision: 'acceptance@1', featureId: 'efficient-delivery', workClass: 'implementation' },
    },
    factoryConfiguration: {
      factory: { id: 'factory', name: 'Queue Factory', defaults: { providerId: 'codex-configured', environmentId: 'local', executionProfile: 'native', budget: { strictSpending: false }, roleAssignments: [{ role: 'builder', providerId: 'codex-configured', model: 'queue-model' }] } },
      providers: [{ id: 'codex-configured', kind: 'codex', capabilities: ['native'] }],
      environments: [{ id: 'local', kind: 'local' }], products: [{ id: 'product', name: 'Product' }], pods: [],
    },
    runtime: {
      providers: [{ id: 'codex', environment: { PATH: '/usr/bin' }, compatibleModels: ['queue-model'], runNonce: 'queue-codex' }],
      workItems: [first, second], resumePlans: [],
      routing: {
        policy: { policyRevision: 'routing@1', maxEvidenceAgeMs: 60_000, taskClasses: { routine: { routePreference: ['local-codex'] } } },
        candidates: [{ routeId: 'local-codex', providerId: 'codex', accountPoolId: 'local-subscription', model: 'queue-model', costTier: 'economical', taskClasses: ['routine'], capabilities: ['native'], subscriptionEligible: true, capabilityObservedAt: observedAt, modelObservedAt: observedAt }],
        observations: [{ accountPoolId: 'local-subscription', providerId: 'codex', nativeUnit: 'slots', snapshotId: 'local@1', limitUnits: 3, availableUnits: 3, observedAt, source: 'test' }],
        bindings: {
          'configured-builder-one': { taskClass: 'routine' },
          'configured-builder-two': { taskClass: 'routine' },
        },
      },
    },
  };
}

function controlledAdapter(starts) {
  return {
    async start(intent, _context, lifecycle) {
      starts.push(intent.runId);
      await lifecycle?.onStarted({ kind: 'native', pid: 4000 + starts.length, processStartedAt: `queue-worker-${starts.length}`, processGroupId: 4000 + starts.length, runNonce: 'queue-codex' });
      return { command: 'start', events: [], malformedEventCount: 0,
        final: { outcome: 'completed', usage: { availability: 'unavailable', unavailableReason: 'test' }, nativeCancellationReceipt: false } };
    },
    async resume() { throw new Error('resume_not_expected'); },
  };
}

function workflowKinds(started) {
  return started.coordinator.journal.events()
    .filter(event => event.kind === 'factory.delivery' && event.data.family === 'workflow')
    .map(event => event.data.record.kind);
}

describe('efficient delivery Console composition', () => {
  it('durably routes one configured work item once across duplicate commands and restart, then dispatches a terminal replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-efficient-delivery-'));
    const sourcePath = join(root, 'owner-workflow.json');
    const starts = [];
    let first; let restarted;
    try {
      const firstCandidate = candidate('LOCAL-1', 'configured-builder-one', 'candidate@1', 1);
      await writeFile(sourcePath, `${JSON.stringify(source([firstCandidate]))}\n`, { mode: 0o600 });
      const config = parseLocalConsoleConfiguration(configuration(root, sourcePath));
      const dependencies = { coordinatorIdentityProbe: probe, providerAdapters: { codex: controlledAdapter(starts) } };
      first = await startLocalConsole(config, undefined, dependencies);

      const initial = (await first.app.inject('/api/console/state')).json().efficientDelivery;
      expect(initial).toEqual(expect.objectContaining({ routing: expect.objectContaining({ configured: true }), workflow: expect.objectContaining({ status: expect.any(String) }), previews: expect.objectContaining({ registrations: 0 }), commands: [] }));
      expect((await first.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', payload: { commandId: 'queue-one', command: { type: 'queue_evaluate', mode: 'attended' } } })).statusCode).toBe(403);
      expect((await first.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', headers: { ...headers, origin: 'https://evil.example' }, payload: { commandId: 'queue-one', command: { type: 'queue_evaluate', mode: 'attended' } } })).statusCode).toBe(403);
      expect((await first.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', headers: { origin: headers.origin }, payload: { commandId: 'queue-one', command: { type: 'queue_evaluate', mode: 'attended' } } })).statusCode).toBe(401);

      const request = { commandId: 'queue-one', command: { type: 'queue_evaluate', mode: 'attended' } };
      const [accepted, replay] = await Promise.all([
        first.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', headers, payload: request }),
        first.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', headers, payload: request }),
      ]);
      expect(accepted.statusCode).toBe(202); expect(replay.statusCode).toBe(202);
      await waitFor(() => starts, value => value.length === 1);
      expect(starts).toEqual(['queue-run-one']);

      await waitFor(() => first.coordinator.snapshot('queue-run-one'), run => run?.state === 'succeeded');
      await waitFor(() => workflowKinds(first), kinds => kinds.includes('worker_receipt'));
      expect(starts).toHaveLength(1);
      await first.close(); first = undefined;

      restarted = await startLocalConsole(config, undefined, dependencies);
      const duplicateAfterRestart = await restarted.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', headers, payload: request });
      expect(duplicateAfterRestart.statusCode).toBe(202);
      expect(duplicateAfterRestart.json().status).toBe('completed');
      expect(starts).toEqual(['queue-run-one']);

      const secondCandidate = candidate('LOCAL-2', 'configured-builder-two', 'candidate@2', 2);
      await writeFile(sourcePath, `${JSON.stringify(source([firstCandidate, secondCandidate], 'source@2'))}\n`, { mode: 0o600 });
      const replacement = await restarted.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', headers,
        payload: { commandId: 'queue-two', command: { type: 'queue_evaluate', mode: 'attended' } } });
      expect(replacement.statusCode).toBe(202);
      await waitFor(() => starts, value => value.length === 2);
      expect(starts).toEqual(['queue-run-one', 'queue-run-two']);
      await waitFor(() => restarted.coordinator.snapshot('queue-run-two'), run => run?.state === 'succeeded');
    } finally {
      await restarted?.close(); await first?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops replenishment in shadow when a later source poll observes new work, until attended is explicit again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-efficient-shadow-'));
    const sourcePath = join(root, 'owner-workflow.json');
    const starts = []; let started;
    try {
      const firstCandidate = candidate('LOCAL-1', 'configured-builder-one', 'candidate@1', 1);
      const secondCandidate = candidate('LOCAL-2', 'configured-builder-two', 'candidate@2', 2);
      await writeFile(sourcePath, `${JSON.stringify(source([firstCandidate]))}\n`, { mode: 0o600 });
      const config = parseLocalConsoleConfiguration(configuration(root, sourcePath));
      started = await startLocalConsole(config, undefined, { coordinatorIdentityProbe: probe, providerAdapters: { codex: controlledAdapter(starts) } });
      expect((await started.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', headers,
        payload: { commandId: 'attended-first', command: { type: 'queue_evaluate', mode: 'attended' } } })).statusCode).toBe(202);
      await waitFor(() => starts, value => value.length === 1);

      expect((await started.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', headers,
        payload: { commandId: 'shadow-stop', command: { type: 'queue_evaluate', mode: 'shadow' } } })).statusCode).toBe(202);
      await waitFor(() => started.app.inject('/api/console/state').then(response => response.json().efficientDelivery), state => state.commands.some(command => command.commandId === 'shadow-stop' && command.status === 'completed') && state.workflow.mode === 'shadow');
      await writeFile(sourcePath, `${JSON.stringify(source([firstCandidate, secondCandidate], 'source@2'))}\n`, { mode: 0o600 });
      const shadowObserved = await waitFor(() => started.app.inject('/api/console/state').then(response => response.json().efficientDelivery.workflow), workflow => workflow.mode === 'shadow' && workflow.queue?.some(item => item.workItemId === 'LOCAL-2' && item.activity === 'queued'), 6_500);
      expect(shadowObserved.mode).toBe('shadow');
      expect(starts).toEqual(['queue-run-one']);

      expect((await started.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', headers,
        payload: { commandId: 'attended-resume', command: { type: 'queue_evaluate', mode: 'attended' } } })).statusCode).toBe(202);
      await waitFor(() => starts, value => value.length === 2);
      expect(starts).toEqual(['queue-run-one', 'queue-run-two']);
    } finally { await started?.close(); await rm(root, { recursive: true, force: true }); }
  }, 8_000);

  it('keeps an installation without opted-in delivery capabilities inert', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-efficient-delivery-disabled-'));
    let started;
    try {
      const config = parseLocalConsoleConfiguration({ factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
        commandToken: 'installed-token', allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 10, strictSpending: false, strictSpendingSupported: false } });
      started = await startLocalConsole(config, undefined, { coordinatorIdentityProbe: probe });
      const state = (await started.app.inject('/api/console/state')).json();
      expect(state.efficientDelivery).toBeUndefined();
      const rejected = await started.app.inject({ method: 'POST', url: '/api/console/efficient-delivery/commands', headers,
        payload: { commandId: 'disabled-queue', command: { type: 'queue_evaluate', mode: 'attended' } } });
      expect(rejected.statusCode).toBe(409);
      expect(started.coordinator.snapshots()).toEqual([]);
      expect(started.coordinator.journal.events().filter(event => event.kind === 'factory.delivery')).toEqual([]);
    } finally { await started?.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('rejects malformed workflow configuration and workflow without its required existing runtime integration', () => {
    const root = '/private/faktori-efficient-delivery';
    const base = { factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
      allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 10, strictSpending: false, strictSpendingSupported: false } };
    expect(() => parseLocalConsoleConfiguration({ ...base, workflow: { sourcePath: 'relative.json', executionScopes: ['local-queue'] } })).toThrow('workflow_runtime_source_path_invalid');
    expect(() => parseLocalConsoleConfiguration({ ...base, workflow: { sourcePath: join(root, 'owner-workflow.json'), executionScopes: ['local-queue'] } })).toThrow('workflow_requires_runtime_and_exclusive_scheduler');
  });
});
