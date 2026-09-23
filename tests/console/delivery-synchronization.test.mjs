import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DeliverySynchronizationRuntime, parseDeliverySynchronizationConfiguration } from '../../src/console/delivery-synchronization.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';
import { AppendOnlyActionJournal, ControllerActionAdmission, FileActionGrantVault, signActionRequest } from '../../src/actions/index.ts';

async function coordinator(root) {
  const value = await DurableCoordinator.open({
    factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'),
    identity: { instanceId: 'delivery-test', pid: process.pid, processStartedAt: 'test' },
    limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 100, strictSpending: false, strictSpendingSupported: false },
  });
  await value.claim();
  return value;
}

describe('delivery synchronization runtime', () => {
  it('requires explicit normalized controller paths and a bounded polling interval', () => {
    expect(() => parseDeliverySynchronizationConfiguration({ packetPath: 'relative.json', grantVaultPath: '/private/vault' })).toThrow();
    expect(() => parseDeliverySynchronizationConfiguration({ packetPath: '/private/packet', grantVaultPath: '/private/vault', pollIntervalMs: 4999 })).toThrow();
    expect(parseDeliverySynchronizationConfiguration({ packetPath: '/private/packet', grantVaultPath: '/private/vault', pollIntervalMs: 5000 })).toEqual({ packetPath: '/private/packet', grantVaultPath: '/private/vault', pollIntervalMs: 5000 });
  });

  it('keeps an absent private packet blocked without a worker, journal action, or external observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-sync-'));
    const value = await coordinator(root);
    let external = 0;
    const runtime = new DeliverySynchronizationRuntime({
      configuration: { packetPath: join(root, 'packet.json'), grantVaultPath: join(root, 'vault') }, coordinator: value,
      dependencies: { fetcher: async () => { external += 1; throw new Error('must not fetch'); }, gh: async () => { external += 1; throw new Error('must not execute gh'); } },
    });
    try {
      await runtime.start();
      expect(runtime.snapshot()).toMatchObject({ status: 'blocked', unavailable: [], executions: [] });
      expect(external).toBe(0);
      expect(value.snapshots()).toEqual([]);
    } finally {
      await runtime.close(); await value.release(); value.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['normal', 'revoked', 'packet_changed', 'unresolved'])('enforces the signed delivery effect boundary (%s)', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-live-'));
    const value = await coordinator(root);
    const scope = { kind: 'jira.delivery-transition', repository: 'acme/repo', branch: 'main', baseRevision: 'base', expectedRevision: 'head', allowedOperation: 'jira.issue.transition', scopeRevision: 'authority@1' };
    const intent = { format: 'faktori.run-intent/v1', runId: 'delivery-run', admissionKey: 'delivery-admission', workItem: { id: 'delivery', revision: 'delivery@1', role: 'manager' }, target: { factoryId: 'factory', productId: 'product', repository: 'acme/repo', branch: 'main', baseRevision: 'base', expectedRevision: 'head' }, context: { packetRevision: 'packet', digest: 'digest' }, execution: { profile: 'native', workspaceId: 'workspace', workspacePath: '/private/workspace', providerId: 'provider', model: 'model', approvedInputDigests: [] }, budget: { reservationId: 'reserve', maxRuntimeMinutes: 5, estimatedTokens: 1, status: 'held' }, authority: { authorityRevision: 'authority@1', epoch: 2, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } }, attempt: 1, createdAt: '2026-09-11T00:00:00.000Z' };
    await value.admit(intent);
    const privateRoot = await realpath(root);
    const vaultPath = join(privateRoot, 'vault');
    const admission = new ControllerActionAdmission({ journal: new AppendOnlyActionJournal(value.journal), grantVault: new FileActionGrantVault(vaultPath), authority: { current: async () => ({ runId: 'delivery-run', scope, authorityEpoch: 2, revoked: false, actionAllowed: true }) }, executor: { execute: async () => ({ outcome: 'safe_noop' }) }, clock: { now: () => new Date('2026-09-11T00:00:00.000Z') }, random: { id: () => `id-${Math.random()}`, secret: () => 'deterministic-private-action-verifier-secret' } });
    const capability = await admission.mintGrant({ runId: 'delivery-run', scope, authorityEpoch: 2 });
    const key = JSON.stringify({ id: 'delivery-sync:OPS-1:transition:71', ticketKey: 'OPS-1', repository: 'acme/repo', fromStatus: 'In Review', toStatus: 'Ready For Deployment', transitionId: '71', reason: 'exact_head_ready_for_human_merge', revision: 'head', pullRequest: 3 });
    const unsigned = { format: 'faktori.action-request/v1', actionId: 'delivery-sync:OPS-1:transition:71', idempotencyKey: `delivery-transition:${createHash('sha256').update(key).digest('hex')}`, runId: 'delivery-run', scope, authorityEpoch: 2, requestedAt: '2026-09-11T00:00:00.000Z' };
    const signed = signActionRequest(unsigned, capability, 'stable-nonce');
    const packet = { format: 'faktori.delivery-synchronization/v1', validUntil: '2030-01-01T00:00:00.000Z', connections: { format: 'faktori.delivery-connections/v1', jira: { baseUrl: 'https://jira.example', boardId: '1', authorizationEnv: 'JIRA_TOKEN' }, connections: [{ ticketKey: 'OPS-1', repository: 'acme/repo', pullRequest: 3 }] }, registrations: [{ ticket: { key: 'OPS-1', status: 'In Review', rank: 1, workState: 'review', dependencies: [] }, repository: { repository: 'acme/repo', branch: 'main', registered: true }, pullRequest: { repository: 'acme/repo', number: 3, headCommit: 'head', merged: false, evidence: [{ kind: 'review', commit: 'head', verdict: 'passed', source: 'independent', observedAt: '2026-09-11T00:00:00.000Z' }] } }], policy: { eligibleCodingStatuses: [], protectedStatuses: [], readyForDeploymentStatus: 'Ready For Deployment', maxConcurrentCoding: 0, requiredCheckSources: ['verify'] }, bindings: [{ ticketKey: 'OPS-1', repository: 'acme/repo', runId: 'delivery-run', scope, authorityEpoch: 2, requestedAt: unsigned.requestedAt, request: signed }] };
    const packetPath = join(privateRoot, 'packet.json'); await writeFile(packetPath, JSON.stringify(packet)); await chmod(packetPath, 0o600);
    let posts = 0;
    const fetcher = async (url, init = {}) => { const path = new URL(url).pathname; if (init.method === 'POST') { posts++; return new Response(null, { status: 204 }); } if (path.includes('/board/1/sprint')) return new Response(JSON.stringify({ values: [{ id: 8, state: 'active' }] }), { status: 200 }); if (path.includes('/sprint/8/issue')) return new Response(JSON.stringify({ total: 1, issues: [{ key: 'OPS-1', fields: { status: { name: 'In Review', statusCategory: { key: 'indeterminate' } }, issuelinks: [] } }] }), { status: 200 }); if (path.includes('/transitions')) return new Response(JSON.stringify({ transitions: [{ id: '71', name: 'Ready', to: { name: 'Ready For Deployment' } }] }), { status: 200 }); return new Response(JSON.stringify({ fields: { status: { name: 'In Review' } } }), { status: 200 }); };
    const gh = async (argv) => argv[1] === 'view' ? { exitCode: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'head', mergeCommit: null }), stderr: '' } : { exitCode: 0, stdout: JSON.stringify([{ check_runs: [{ name: 'verify', head_sha: 'head', status: 'completed', conclusion: 'success' }] }]), stderr: '' };
    let changed = false;
    const guardedGh = async (...args) => {
      if (!changed && mode === 'packet_changed') {
        changed = true;
        await writeFile(packetPath, JSON.stringify({ ...packet, validUntil: '2031-01-01T00:00:00.000Z' }));
      }
      return gh(...args);
    };
    if (mode === 'revoked') await value.journal.append(value.journal.event('delivery-run', 'authority.revoked', { epoch: 3 }, 'revoke'));
    if (mode === 'unresolved') await value.journal.append(value.journal.event('delivery-run', 'action.intended', { effect: { operationId: 'prior-crashed-action', kind: 'action.execute', identityKey: signed.idempotencyKey, requestedAt: unsigned.requestedAt, requestDigest: signed.requestDigest } }, 'old-intent'));
    const runtime = new DeliverySynchronizationRuntime({ configuration: { packetPath, grantVaultPath: vaultPath }, coordinator: value, dependencies: { environment: { JIRA_TOKEN: 'Bearer test' }, fetcher, gh: guardedGh } });
    let restarted;
    try {
      await runtime.start();
      if (mode !== 'normal') {
        expect(runtime.snapshot().status).toBe('blocked');
        expect(posts).toBe(0);
        return;
      }
      expect(runtime.snapshot(), JSON.stringify(runtime.snapshot())).toMatchObject({ status: 'monitoring', executions: [{ ticketKey: 'OPS-1', outcome: 'completed' }] });
      expect(posts).toBe(1);
      await runtime.close();
      restarted = new DeliverySynchronizationRuntime({ configuration: { packetPath, grantVaultPath: vaultPath }, coordinator: value, dependencies: { environment: { JIRA_TOKEN: 'Bearer test' }, fetcher, gh } });
      await restarted.start();
      expect(restarted.snapshot().status).toBe('monitoring');
      expect(posts).toBe(1);
      // Losing a required binding is actionable, not a healthy no-op.
      await writeFile(packetPath, JSON.stringify({ ...packet, bindings: [] }));
      await restarted.tick();
      expect(restarted.snapshot()).toMatchObject({ status: 'blocked', reason: 'signed_action_missing' });
      expect(posts).toBe(1);
      await writeFile(packetPath, JSON.stringify({ ...packet, validUntil: '2000-01-01T00:00:00.000Z' }));
      await restarted.tick();
      expect(restarted.snapshot()).toMatchObject({ status: 'blocked', reason: 'packet_expired' });
      expect(posts).toBe(1);
    } finally { await restarted?.close(); await runtime.close(); await value.release(); value.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('rejects controller storage in repositories, including symlinked parents, before external observation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-storage-'));
    const value = await coordinator(root);
    try {
      const repo = join(root, 'product');
      await mkdir(join(repo, '.git'), { recursive: true });
      const alias = join(root, 'alias');
      await symlink(repo, alias);
      for (const path of [repo, alias]) {
        const runtime = new DeliverySynchronizationRuntime({ configuration: { packetPath: join(path, 'packet.json'), grantVaultPath: join(root, 'vault') }, coordinator: value });
        try {
          await runtime.tick();
          expect(runtime.snapshot()).toMatchObject({ status: 'blocked', reason: 'controller_storage_inside_workspace' });
        } finally { await runtime.close(); }
      }
    } finally { await value.release(); value.close(); await rm(root, { recursive: true, force: true }); }
  });
});
