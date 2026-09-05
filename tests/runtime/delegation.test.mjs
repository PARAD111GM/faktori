import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DurableCoordinator } from '../../src/runtime/coordinator.ts';
import { DurableDelegationService, DelegationPreconditionError } from '../../src/runtime/delegation.ts';

async function directory() {
  return mkdtemp(join(tmpdir(), 'faktori-delegation-'));
}

function parentIntent() {
  return {
    format: 'faktori.run-intent/v1', runId: 'parent', admissionKey: 'parent-admission',
    workItem: { id: 'F3-03', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'org/repo', branch: 'build/phase-3', baseRevision: 'base', expectedRevision: 'expected' },
    context: { packetRevision: 'packet@1', digest: 'packet-digest' },
    execution: { profile: 'native', workspaceId: 'parent-workspace', workspacePath: '/private/tmp/parent', providerId: 'codex', model: 'parent-model', approvedInputDigests: ['approved-artifact', 'packet-digest'] },
    budget: { reservationId: 'parent-reservation', maxRuntimeMinutes: 10, estimatedTokens: 100, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1, createdAt: '2026-09-05T00:00:00.000Z',
  };
}

async function coordinator(root, limits = {}) {
  const value = await DurableCoordinator.open({
    factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'),
    identity: { instanceId: `delegation-${Math.random()}`, pid: 1, processStartedAt: 'start' },
    limits: { maxConcurrentRuns: 8, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 1_000, strictSpending: false, strictSpendingSupported: false, ...limits },
  });
  await value.claim();
  await value.admit(parentIntent());
  return value;
}

function request(overrides = {}) {
  return {
    format: 'faktori.delegation-request/v1', delegationId: 'implement', parentRunId: 'parent', workstreamId: 'implementation',
    ownership: { paths: ['src/feature.ts'], mode: 'exclusive' }, artifactReferences: [{ artifactId: 'brief', digest: 'approved-artifact' }], message: 'Implement the bounded workstream.',
    ...overrides,
  };
}

function service(owner, options = {}) {
  return new DurableDelegationService({
    coordinator: owner,
    allocate: (_parent, candidate, childRunId) => ({ workspaceId: `workspace-${candidate.delegationId}`, workspacePath: `/private/tmp/${childRunId}`, profile: 'native', providerId: 'codex', model: 'trusted-model', maxRuntimeMinutes: 4, estimatedTokens: 200 }),
    ...options,
  });
}

async function close(owner) {
  await owner.release();
  owner.close();
}

describe('durable delegation', () => {
  it('serializes duplicate/racing child admission through the coordinator and never queues a duplicate writer message', async () => {
    const root = await directory();
    try {
      const owner = await coordinator(root);
      const delegation = service(owner);
      const [first, second] = await Promise.all([delegation.admit(request()), delegation.admit(request())]);
      expect(first).toEqual(expect.objectContaining({ accepted: true }));
      expect(second).toEqual(expect.objectContaining({ accepted: true, child: expect.objectContaining({ childRunId: first.child.childRunId }) }));
      const childEvents = owner.journal.events().filter((event) => event.runId === first.child.childRunId);
      expect(childEvents.filter((event) => event.kind === 'run.admitted')).toHaveLength(1);
      expect(childEvents.filter((event) => event.kind === 'message.queued')).toHaveLength(1);
      await delegation.message('parent', first.child.childRunId, 'Continue with the approved artifact.');
      await delegation.message('parent', first.child.childRunId, 'Continue with the approved artifact.');
      expect(owner.journal.events().filter((event) => event.runId === first.child.childRunId && event.kind === 'message.queued')).toHaveLength(2);
      await close(owner);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('uses the parent coordinator reservation and rejects ownership conflicts unless trusted policy explicitly serializes them', async () => {
    const root = await directory();
    try {
      const owner = await coordinator(root);
      const delegation = service(owner, { authorizeSerialization: () => true });
      const first = await delegation.admit(request());
      const conflict = await delegation.admit(request({ delegationId: 'review', workstreamId: 'review', ownership: { paths: ['src'], mode: 'exclusive' } }));
      expect(conflict).toEqual({ accepted: false, reason: 'ownership_conflicts_with_active_child' });
      const serialized = await delegation.admit(request({ delegationId: 'review', workstreamId: 'review', ownership: { paths: ['src'], mode: 'serialized', serializedAfter: ['implement'] } }));
      expect(serialized).toEqual(expect.objectContaining({ accepted: true }));
      expect(delegation.canLaunch('parent', serialized.child.childRunId)).toBe(false);
      await owner.record('provider.final', first.child.childRunId, { result: { outcome: 'completed', usage: { availability: 'unavailable', unavailableReason: 'fixture' }, nativeCancellationReceipt: false } });
      expect(delegation.canLaunch('parent', serialized.child.childRunId)).toBe(true);
      await close(owner);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a distinct workspace id that aliases a parent or concurrent child normalized workspace path', async () => {
    const root = await directory();
    try {
      const owner = await coordinator(root);
      const parentAlias = service(owner, { allocate: () => ({ workspaceId: 'different-id', workspacePath: '/private/tmp/parent', profile: 'native', providerId: 'codex', model: 'trusted-model', maxRuntimeMinutes: 4, estimatedTokens: 200 }) });
      await expect(parentAlias.admit(request())).rejects.toThrow(/parent workspace path/);

      const firstService = service(owner, { allocate: (_parent, candidate) => ({ workspaceId: `workspace-${candidate.delegationId}`, workspacePath: '/private/tmp/shared-child-workspace', profile: 'native', providerId: 'codex', model: 'trusted-model', maxRuntimeMinutes: 4, estimatedTokens: 200 }) });
      expect((await firstService.admit(request())).accepted).toBe(true);
      const siblingAlias = service(owner, { allocate: () => ({ workspaceId: 'different-child-id', workspacePath: '/private/tmp/shared-child-workspace', profile: 'native', providerId: 'codex', model: 'trusted-model', maxRuntimeMinutes: 4, estimatedTokens: 200 }) });
      expect(await siblingAlias.admit(request({ delegationId: 'docs', workstreamId: 'docs', ownership: { paths: ['docs/readme.md'], mode: 'exclusive' } }))).toEqual({ accepted: false, reason: 'workspace_path_conflicts_with_active_child' });
      await close(owner);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reserves against shared capacity/budget rather than an untrusted child payload', async () => {
    const root = await directory();
    try {
      const owner = await coordinator(root, { maxTokens: 500 });
      const delegation = service(owner, { allocate: (_parent, candidate, childRunId) => ({ workspaceId: `workspace-${candidate.delegationId}`, workspacePath: `/private/tmp/${childRunId}`, profile: 'native', providerId: 'codex', model: 'trusted-model', maxRuntimeMinutes: 4, estimatedTokens: 250 }) });
      expect((await delegation.admit(request())).accepted).toBe(true);
      expect(await delegation.admit(request({ delegationId: 'docs', workstreamId: 'docs', ownership: { paths: ['docs/readme.md'], mode: 'exclusive' } }))).toEqual({ accepted: false, reason: 'token_reservation_exceeded' });
      await close(owner);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('admits a later provider child from an exact durable parent handoff, while rejecting forged output references', async () => {
    const root = await directory();
    try {
      const owner = await coordinator(root);
      const delegation = service(owner);
      const plan = await delegation.admit(request({ delegationId: 'plan', workstreamId: 'planning', ownership: { paths: ['docs/plan.md'], mode: 'exclusive' } }));
      await owner.record('provider.final', plan.child.childRunId, { result: { outcome: 'completed', summary: 'plan complete', usage: { availability: 'reported', outputTokens: 5 }, nativeCancellationReceipt: false } });
      await delegation.handoff('parent', plan.child.childRunId, [{ artifactId: 'implementation-plan', digest: 'plan-output-digest' }]);

      const implementation = await delegation.admit(request({ delegationId: 'implementation', workstreamId: 'implementation', ownership: { paths: ['src/feature.ts'], mode: 'exclusive' }, artifactReferences: [{ artifactId: 'implementation-plan', digest: 'plan-output-digest' }] }));
      expect(implementation).toEqual(expect.objectContaining({ accepted: true }));
      expect(implementation.child.snapshot.intent.execution.approvedInputDigests).toContain('plan-output-digest');
      expect(await delegation.admit(request({ delegationId: 'forged', workstreamId: 'forged', ownership: { paths: ['src/forged.ts'], mode: 'exclusive' }, artifactReferences: [{ artifactId: 'implementation-plan', digest: 'forged-digest' }] }))).toEqual({ accepted: false, reason: 'artifact_reference_not_approved_for_parent' });
      await close(owner);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects an otherwise durable artifact handoff that belongs to another parent run', async () => {
    const root = await directory();
    try {
      const owner = await coordinator(root);
      const delegation = service(owner);
      const foreignParent = parentIntent();
      foreignParent.runId = 'foreign-parent';
      foreignParent.admissionKey = 'foreign-parent-admission';
      foreignParent.budget.reservationId = 'foreign-parent-reservation';
      await owner.admit(foreignParent);
      const foreign = await delegation.admit(request({ parentRunId: 'foreign-parent', delegationId: 'foreign-plan', workstreamId: 'foreign-planning', ownership: { paths: ['docs/foreign.md'], mode: 'exclusive' } }));
      await owner.record('provider.final', foreign.child.childRunId, { result: { outcome: 'completed', usage: { availability: 'unavailable', unavailableReason: 'fixture' }, nativeCancellationReceipt: false } });
      await delegation.handoff('foreign-parent', foreign.child.childRunId, [{ artifactId: 'foreign-plan', digest: 'foreign-output-digest' }]);
      expect(await delegation.admit(request({ delegationId: 'cross-parent', workstreamId: 'cross-parent', ownership: { paths: ['src/cross-parent.ts'], mode: 'exclusive' }, artifactReferences: [{ artifactId: 'foreign-plan', digest: 'foreign-output-digest' }] }))).toEqual({ accepted: false, reason: 'artifact_reference_not_approved_for_parent' });
      await close(owner);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('replays a durable child final handoff after restart without duplicating the parent result message', async () => {
    const root = await directory();
    try {
      let owner = await coordinator(root);
      let delegation = service(owner);
      const admitted = await delegation.admit(request());
      await owner.record('provider.final', admitted.child.childRunId, { result: { outcome: 'completed', summary: 'done', revision: 'artifact@1', usage: { availability: 'reported', outputTokens: 10 }, nativeCancellationReceipt: false } });
      await delegation.handoff('parent', admitted.child.childRunId, [{ artifactId: 'patch', digest: 'output-digest' }]);
      const before = owner.journal.events().filter((event) => event.runId === 'parent' && event.kind === 'message.queued').length;
      await close(owner);
      owner = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection-restart.sqlite'), identity: { instanceId: 'restart', pid: 2, processStartedAt: 'restart' }, limits: { maxConcurrentRuns: 8, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 1_000, strictSpending: false, strictSpendingSupported: false } });
      await owner.claim();
      delegation = service(owner);
      await delegation.recoverHandoffs('parent');
      expect(owner.journal.events().filter((event) => event.runId === 'parent' && event.kind === 'message.queued')).toHaveLength(before);
      await close(owner);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('recovers an admission interrupted before its initial message using only the identical request', async () => {
    const root = await directory();
    try {
      const owner = await coordinator(root);
      let allocations = 0;
      const delegation = service(owner, { allocate: (_parent, candidate, childRunId) => {
        allocations += 1;
        return { workspaceId: `workspace-${candidate.delegationId}`, workspacePath: `/private/tmp/${childRunId}`, profile: 'native', providerId: 'codex', model: 'trusted-model', maxRuntimeMinutes: 4, estimatedTokens: 200 };
      } });
      const originalQueue = owner.queueMessage.bind(owner);
      let interrupted = true;
      owner.queueMessage = async (message) => {
        if (interrupted && message.messageId.startsWith('delegation-initial-')) {
          interrupted = false;
          throw new Error('simulated append interruption');
        }
        return originalQueue(message);
      };
      await expect(delegation.admit(request())).rejects.toThrow('simulated append interruption');
      const recovered = await delegation.admit(request());
      expect(recovered).toEqual(expect.objectContaining({ accepted: true }));
      expect(allocations).toBe(1);
      expect(owner.journal.events().filter((event) => event.runId === recovered.child.childRunId && event.kind === 'run.admitted')).toHaveLength(1);
      expect(owner.journal.events().filter((event) => event.runId === recovered.child.childRunId && event.kind === 'message.queued')).toHaveLength(1);
      await close(owner);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('treats child fields as untrusted and revokes child publication before exposing an exact surviving worker to cancellation', async () => {
    const root = await directory();
    try {
      const owner = await coordinator(root);
      const delegation = service(owner);
      await expect(delegation.admit({ ...request(), target: { factoryId: 'other' }, ownership: { paths: ['../escape'], mode: 'exclusive' } })).rejects.toBeInstanceOf(DelegationPreconditionError);
      const admitted = await delegation.admit(request());
      const worker = { kind: 'native', pid: 91, processStartedAt: 'worker-start', processGroupId: 91, runNonce: 'exact' };
      await owner.record('worker.started', admitted.child.childRunId, { worker });
      await owner.record('authority.revoked', 'parent', { epoch: 2, reason: 'owner_cancelled' });
      const seen = [];
      const result = await delegation.reconcileCancelledParent('parent', async (child) => { seen.push(child.worker); });
      expect(seen).toEqual([worker]);
      expect(result).toEqual([expect.objectContaining({ childRunId: admitted.child.childRunId, state: 'termination_requested', worker })]);
      expect(owner.snapshot(admitted.child.childRunId)).toEqual(expect.objectContaining({ authorityRevoked: true }));
      await close(owner);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
