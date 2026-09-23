import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ConsoleWorkflowRuntime, parseWorkflowRuntimeConfiguration } from '../../src/console/workflow-runtime.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

const now = '2026-09-22T12:00:00.000Z';

function policy() {
  return { format: 'faktori.role-queue-policy/v1', revision: 'workflow-policy@1', stages: [
    { stageId: 'needs_specification', role: 'planner', statusIds: ['spec'], entryGuards: [], maxWip: 1 },
    { stageId: 'ready_to_build', role: 'builder', statusIds: ['build'], entryGuards: ['approved-spec'], maxWip: 3 },
    { stageId: 'ready_for_review', role: 'reviewer', statusIds: ['review'], entryGuards: ['candidate'], maxWip: 1 },
    { stageId: 'human_review', role: 'human', statusIds: ['human'], entryGuards: ['review'], maxWip: 1 },
    { stageId: 'ready_to_release', role: 'release', statusIds: ['release'], entryGuards: ['accepted'], maxWip: 1 },
    { stageId: 'staging_acceptance', role: 'acceptance', statusIds: ['staging'], entryGuards: ['deployment'], maxWip: 1 },
    { stageId: 'done', role: 'acceptance', statusIds: ['done'], entryGuards: ['accepted'], maxWip: 0 },
  ] };
}

function source(overrides = {}) {
  return { format: 'faktori.console-workflow-source/v1', revision: 'source@1', validUntil: '2030-01-01T00:00:00.000Z', policy: policy(), candidates: [{
    workItemId: 'ticket-1', runtimeWorkItemId: 'configured-builder', executionScope: 'faktori-sandbox', trackerStatusId: 'build', revision: 'candidate@1', rank: 1,
    queuedAt: '2026-09-20T12:00:00.000Z', dependencies: [], entryEvidence: [{ guardId: 'approved-spec', revision: 'candidate@1', observedAt: now }],
  }], ...overrides };
}

function intent() {
  return { format: 'faktori.run-intent/v1', runId: 'configured-run', admissionKey: 'configured-admission', workItem: { id: 'configured-builder', revision: 'candidate@1', role: 'builder' },
    target: { factoryId: 'factory', productId: 'faktori', repository: 'owner/faktori', branch: 'main', baseRevision: 'base', expectedRevision: 'head' },
    context: { packetRevision: 'packet@1', digest: 'context' }, execution: { profile: 'native', workspaceId: 'workspace', workspacePath: '/private/workspace', providerId: 'codex', model: 'configured', approvedInputDigests: [] },
    budget: { reservationId: 'reservation', maxRuntimeMinutes: 10, estimatedTokens: 1, status: 'held' }, authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } }, attempt: 1, createdAt: now };
}

async function coordinator(root, instance) {
  const value = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, `projection-${instance}.sqlite`),
    identity: { instanceId: instance, pid: instance === 'one' ? 101 : 102, processStartedAt: now, processGroupId: 1 },
    limits: { maxConcurrentRuns: 3, maxRetries: 1, maxRuntimeMinutes: 30, maxTokens: 100, strictSpending: false, strictSpendingSupported: false },
    processProbe: { coordinator: async () => 'dead', worker: async () => 'unknown' } });
  await value.claim(); return value;
}

function trustedReadiness() {
  return { observe: async () => ({ authorityRevision: 'readiness@1', observedAt: now,
    transport: { ready: true, blockers: [] }, nativeGoal: { ready: true, blockers: [] }, supervision: { ready: true, blockers: [] }, witness: { ready: true, blockers: [] } }) };
}

describe('Console workflow runtime', () => {
  it('uses the coordinator journal for duplicate-safe launch and restart replay, while binding only configured runtime work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-workflow-runtime-'));
    const path = join(root, 'workflow.json'); const launched = [];
    let clock = Date.parse(now);
    try {
      await writeFile(path, JSON.stringify(source()), { mode: 0o600 });
      const firstCoordinator = await coordinator(root, 'one');
      const options = { configuration: { sourcePath: path, executionScopes: ['faktori-sandbox'], legacyExecutionScopes: [] }, workItems: [{ workItemId: 'configured-builder', intent: intent() }],
        executor: { launch: async assignment => { launched.push(assignment); return { status: 'running', workerId: 'worker-1' }; }, inspect: async () => ({ status: 'unknown', reason: 'not used' }) }, trustedReadiness: trustedReadiness(), now: () => new Date(clock) };
      const runtime = new ConsoleWorkflowRuntime({ coordinator: firstCoordinator, ...options });
      const [first, duplicate] = await Promise.all([runtime.evaluate({ mode: 'automatic' }), runtime.evaluate({ mode: 'automatic' })]);
      expect(first.launches).toHaveLength(1); expect(duplicate.launches).toEqual([]);
      expect(runtime.snapshot()).toMatchObject({ status: 'automatic', mode: 'automatic', automaticReady: true, capabilityBlockers: [] });
      expect(first.launches[0]).toMatchObject({ workItemId: 'ticket-1', runtime: { workItemId: 'configured-builder', runId: 'configured-run' } });
      expect(launched).toHaveLength(1);
      clock += 120_000;
      expect(runtime.snapshot()).toMatchObject({ status: 'blocked', automaticReady: false,
        capabilityBlockers: expect.arrayContaining([expect.objectContaining({ code: 'automatic_readiness_stale_or_future' })]) });
      expect(firstCoordinator.journal.events().filter(event => event.kind === 'factory.delivery').map(event => event.data.record.kind)).toEqual(['claim', 'launch_intended', 'launch_observed']);
      await firstCoordinator.release(); firstCoordinator.close();

      const restartedCoordinator = await coordinator(root, 'two');
      const restarted = new ConsoleWorkflowRuntime({ coordinator: restartedCoordinator, ...options });
      const replay = await restarted.evaluate({ mode: 'automatic' });
      expect(replay.launches).toEqual([]);
      expect(launched).toHaveLength(1);
      await restartedCoordinator.release(); restartedCoordinator.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails automatic admission closed without an independently trusted transport, goal, supervision, and witness observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-workflow-runtime-')); const path = join(root, 'workflow.json');
    try {
      await writeFile(path, JSON.stringify(source()), { mode: 0o600 });
      const value = await coordinator(root, 'one');
      const runtime = new ConsoleWorkflowRuntime({ coordinator: value, configuration: { sourcePath: path, executionScopes: ['faktori-sandbox'], legacyExecutionScopes: [] }, workItems: [{ workItemId: 'configured-builder', intent: intent() }], executor: { launch: async () => { throw new Error('must not launch'); }, inspect: async () => ({ status: 'unknown', reason: 'unused' }) }, now: () => new Date(now) });
      const result = await runtime.evaluate({ mode: 'automatic' });
      expect(result.launches).toEqual([]);
      expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'automatic_transport_capability_missing' }));
      expect(runtime.snapshot()).toMatchObject({ status: 'blocked', mode: 'automatic', automaticReady: false,
        capabilityBlockers: expect.arrayContaining([expect.objectContaining({ code: 'automatic_transport_capability_missing' })]) });
      await value.release(); value.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('labels a valid manual queue as shadow or attended without implying automatic wake-up readiness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-workflow-runtime-')); const path = join(root, 'workflow.json');
    try {
      await writeFile(path, JSON.stringify(source()), { mode: 0o600 });
      const value = await coordinator(root, 'one');
      const runtime = new ConsoleWorkflowRuntime({ coordinator: value, configuration: { sourcePath: path, executionScopes: ['faktori-sandbox'], legacyExecutionScopes: [] }, workItems: [{ workItemId: 'configured-builder', intent: intent() }], executor: { launch: async () => ({ status: 'running', workerId: 'worker-1' }), inspect: async () => ({ status: 'unknown', reason: 'unused' }) }, now: () => new Date(now) });
      await runtime.evaluate({ mode: 'shadow' });
      expect(runtime.snapshot()).toMatchObject({ status: 'shadow', mode: 'shadow', automaticReady: false,
        capabilityBlockers: expect.arrayContaining([expect.objectContaining({ code: 'automatic_transport_capability_missing' })]) });
      await runtime.evaluate({ mode: 'attended' });
      expect(runtime.snapshot()).toMatchObject({ status: 'attended', mode: 'attended', automaticReady: false });
      await value.release(); value.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves a missing live authority observation as blocked rather than scheduling a static file candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-workflow-runtime-')); const path = join(root, 'workflow.json');
    try {
      await writeFile(path, JSON.stringify(source()), { mode: 0o600 });
      const value = await coordinator(root, 'one');
      const runtime = new ConsoleWorkflowRuntime({ coordinator: value, configuration: { sourcePath: path, executionScopes: ['faktori-sandbox'], legacyExecutionScopes: [] }, workItems: [{ workItemId: 'configured-builder', intent: intent() }], executor: { launch: async () => ({ status: 'running', workerId: 'must-not-run' }), inspect: async () => ({ status: 'unknown', reason: 'unused' }) }, authority: { observe: async () => ({ revision: 'jira@1', candidates: [] }) }, trustedReadiness: trustedReadiness(), now: () => new Date(now) });
      const result = await runtime.evaluate({ mode: 'attended' });
      expect(result.launches).toEqual([]);
      expect(result.queue).toContainEqual(expect.objectContaining({ activity: 'blocked', blocker: expect.stringContaining('authority:missing') }));
      await value.release(); value.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('parses only private source and explicit execution-scope configuration', () => {
    expect(parseWorkflowRuntimeConfiguration({ sourcePath: '/private/workflow.json', executionScopes: ['one'] })).toEqual({ sourcePath: '/private/workflow.json', executionScopes: ['one'], legacyExecutionScopes: [] });
    expect(() => parseWorkflowRuntimeConfiguration({ sourcePath: '/private/workflow.json', executionScopes: [] })).toThrow('workflow_execution_scopes_invalid');
    expect(() => parseWorkflowRuntimeConfiguration({ sourcePath: 'relative', executionScopes: ['one'], ready: true })).toThrow('workflow_runtime_configuration_invalid');
  });

  it('rejects a tracker revision or stage-role that is not bound to the configured runtime work item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-workflow-runtime-')); const path = join(root, 'workflow.json');
    try {
      await writeFile(path, JSON.stringify(source({ candidates: [{ ...source().candidates[0], revision: 'candidate@changed', entryEvidence: [{ guardId: 'approved-spec', revision: 'candidate@changed', observedAt: now }] }] })), { mode: 0o600 });
      const value = await coordinator(root, 'one');
      const runtime = new ConsoleWorkflowRuntime({ coordinator: value, configuration: { sourcePath: path, executionScopes: ['faktori-sandbox'], legacyExecutionScopes: [] }, workItems: [{ workItemId: 'configured-builder', intent: intent() }], executor: { launch: async () => ({ status: 'running', workerId: 'must-not-run' }), inspect: async () => ({ status: 'unknown', reason: 'unused' }) }, trustedReadiness: trustedReadiness(), now: () => new Date(now) });
      await expect(runtime.evaluate({ mode: 'attended' })).rejects.toThrow('workflow_source_runtime_candidate_revision_mismatch');
      await writeFile(path, JSON.stringify(source({ revision: 'source@role', candidates: [{ ...source().candidates[0], trackerStatusId: 'review', entryEvidence: [{ guardId: 'candidate', revision: 'candidate@1', observedAt: now }] }] })), { mode: 0o600 });
      await expect(runtime.evaluate({ mode: 'attended' })).rejects.toThrow('workflow_source_runtime_role_mismatch');
      await value.release(); value.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves shared-file keys through authority overlay and serializes independent configured candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-workflow-runtime-')); const path = join(root, 'workflow.json'); const launched = [];
    try {
      const first = { ...source().candidates[0], accountPoolId: 'informational-pool', sharedFileKey: 'src/shared.ts' };
      const second = { ...first, workItemId: 'ticket-2', runtimeWorkItemId: 'configured-builder-two', revision: 'candidate@2', rank: 2,
        entryEvidence: [{ guardId: 'approved-spec', revision: 'candidate@2', observedAt: now }] };
      await writeFile(path, JSON.stringify(source({ revision: 'source@shared-file', candidates: [first, second] })), { mode: 0o600 });
      const value = await coordinator(root, 'one');
      const secondIntent = structuredClone(intent());
      secondIntent.runId = 'configured-run-two'; secondIntent.admissionKey = 'configured-admission-two'; secondIntent.workItem = { id: 'configured-builder-two', revision: 'candidate@2', role: 'builder' }; secondIntent.budget.reservationId = 'reservation-two';
      const runtime = new ConsoleWorkflowRuntime({ coordinator: value, configuration: { sourcePath: path, executionScopes: ['faktori-sandbox'], legacyExecutionScopes: [] },
        workItems: [{ workItemId: 'configured-builder', intent: intent() }, { workItemId: 'configured-builder-two', intent: secondIntent }],
        authority: { observe: async input => ({ revision: 'jira@shared', candidates: input.candidates.map(candidate => ({ ...candidate })) }) }, trustedReadiness: trustedReadiness(),
        executor: { launch: async assignment => { launched.push(assignment); return { status: 'running', workerId: assignment.runtime.runId }; }, inspect: async () => ({ status: 'unknown', reason: 'unused' }) }, now: () => new Date(now) });
      const result = await runtime.evaluate({ mode: 'attended' });
      expect(launched).toHaveLength(1);
      expect(result.launches).toHaveLength(1);
      expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'shared_file_serialization', detail: 'src/shared.ts', workItemId: 'ticket-2' }));
      await value.release(); value.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
