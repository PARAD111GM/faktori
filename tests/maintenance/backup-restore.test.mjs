import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createFactoryBackup,
  MaintenanceValidationError,
  reconcileRestoredFactory,
  restoreFactoryBackup,
} from '../../src/maintenance/index.ts';
import { parseLocalConsoleConfiguration, startLocalConsole } from '../../src/console/startup.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

function intent(runId) {
  return {
    format: 'faktori.run-intent/v1', runId, admissionKey: `admission-${runId}`,
    workItem: { id: `work-${runId}`, revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'org/repo', branch: 'build/phase-6', baseRevision: 'base', expectedRevision: 'head' },
    context: { packetRevision: 'packet@1', digest: 'packet' },
    execution: { profile: 'native', workspaceId: 'workspace', workspacePath: '/private/tmp/faktori-work', providerId: 'codex', model: 'fixture', approvedInputDigests: [] },
    budget: { reservationId: `reservation-${runId}`, maxRuntimeMinutes: 10, estimatedTokens: 10, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1, createdAt: '2026-09-05T00:00:00.000Z',
  };
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function signedManifest(manifest) {
  const { backupDigest: _ignored, ...payload } = manifest;
  return { ...payload, backupDigest: createHash('sha256').update(stable(payload)).digest('hex') };
}

function restoreRequest(test, destinationRoot) {
  return { format: 'faktori.restore-request/v1', destinationRoot, expectedFactoryId: 'factory', expectedSourceRoot: test.sourceRoot, rebindConfigurationPaths: true };
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'faktori-backup-'));
  const source = join(parent, 'source');
  await mkdir(join(source, 'config'), { recursive: true });
  await mkdir(join(source, 'artifacts'), { recursive: true });
  await mkdir(join(source, 'projections'), { recursive: true });
  await mkdir(join(source, 'credentials'), { recursive: true });
  await writeFile(join(source, 'config', 'factory.json'), JSON.stringify({ name: 'Owner factory', nested: { apiToken: 'must-not-export', visible: true }, password: 'must-not-export' }));
  await writeFile(join(source, 'artifacts', 'receipt.txt'), 'external effect evidence');
  await writeFile(join(source, 'projections', 'runtime.sqlite'), 'rebuildable projection');
  await writeFile(join(source, 'credentials', 'provider.secret'), 'provider-owned credential');
  const journalPath = join(source, 'operations.jsonl');
  const coordinator = await DurableCoordinator.open({
    factoryId: 'factory', journalPath, projectionPath: join(source, 'projection.sqlite'),
    identity: { instanceId: 'source-coordinator', pid: 101, processStartedAt: '2026-09-05T00:00:00.000Z' },
    limits: { maxConcurrentRuns: 2, maxRetries: 1, maxRuntimeMinutes: 30, maxTokens: 100, strictSpending: false, strictSpendingSupported: false },
  });
  await coordinator.claim();
  await coordinator.admit(intent('interrupted-run'));
  await coordinator.recordEffectIntent('interrupted-run', { operationId: 'effect-1', kind: 'action.execute', requestedAt: '2026-09-05T00:00:01.000Z', idempotencyKey: 'effect-key', requestDigest: 'request-digest' });
  return { parent, source, sourceRoot: await realpath(source), coordinator, request: { format: 'faktori.backup-request/v1', factoryId: 'factory', sourceRoot: source, runtimeVersion: '0.6.0', stateFormatVersion: 1, journalPath: 'operations.jsonl', configurationPaths: ['config'], artifactPaths: ['artifacts'], operationalPaths: ['operations.jsonl'], projectionPaths: ['projections', 'projection.sqlite'], credentialPaths: ['credentials'] } };
}

describe('assembled recovery backup and restore boundary', () => {
  it('backs up a quiesced factory, restores separately, blocks admission until exact reconciliation, and preserves an uncertain effect without replaying it', async () => {
    const test = await fixture();
    try {
      await test.coordinator.release(); test.coordinator.close();
      const backup = await createFactoryBackup(test.request, join(test.parent, 'backup'));
      expect(backup.consistency).toBe('coordinator_offline_lock_held');
      expect(backup.credentialPolicy).toBe('excluded_provider_owned_stores');
      expect(backup.files.map((file) => file.path)).toEqual(['artifacts/receipt.txt', 'config/factory.json', 'operations.jsonl']);
      const config = JSON.parse(await readFile(join(test.parent, 'backup', 'files', 'config', 'factory.json'), 'utf8'));
      expect(config).toEqual({ name: 'Owner factory', nested: { visible: true } });
      expect(JSON.stringify(config)).not.toContain('must-not-export');

      const restored = await restoreFactoryBackup(join(test.parent, 'backup'), restoreRequest(test, join(test.parent, 'restored')));
      expect(restored).toEqual(expect.objectContaining({ admissionBlocked: true, reconciliationRequired: [expect.objectContaining({ unresolvedOperationIds: ['effect-1'], priorState: 'admitted' })] }));
      expect(await readFile(join(test.parent, 'restored', 'artifacts', 'receipt.txt'), 'utf8')).toBe('external effect evidence');
      await expect(readFile(join(test.parent, 'restored', 'credentials', 'provider.secret'))).rejects.toThrow();
      await expect(readFile(join(test.parent, 'restored', 'projections', 'runtime.sqlite'))).rejects.toThrow();

      const blocked = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(test.parent, 'restored', 'operations.jsonl'), projectionPath: join(test.parent, 'restored', 'rebuilt.sqlite'), identity: { instanceId: 'restored-blocked', pid: 202, processStartedAt: '2026-09-05T00:01:00.000Z' }, limits: { maxConcurrentRuns: 2, maxRetries: 1, maxRuntimeMinutes: 30, maxTokens: 100, strictSpending: false, strictSpendingSupported: false } });
      await blocked.claim();
      expect(await blocked.admit(intent('new-before-reconcile'))).toEqual({ accepted: false, reason: 'restore_reconciliation_required' });
      await blocked.release(); blocked.close();

      const recoveryId = restored.reconciliationRequired[0].recoveryId;
      const reconciled = await reconcileRestoredFactory({ format: 'faktori.restore-reconciliation/v1', restoredRoot: restored.destinationRoot, journalPath: 'operations.jsonl', sourceBackupId: restored.backupId, decisions: [{ recoveryId, disposition: 'effect_already_completed', evidence: 'provider receipt confirms operation effect-1 completed exactly once' }] });
      expect(reconciled).toEqual(expect.objectContaining({ resolved: 1, admissionBlocked: false }));
      const restoredJournal = await readFile(join(test.parent, 'restored', 'operations.jsonl'), 'utf8');
      expect(restoredJournal.match(/"kind":"effect\.intended"/g)).toHaveLength(1);
      expect(restoredJournal).not.toContain('"kind":"effect.receipt"');

      const resumed = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(test.parent, 'restored', 'operations.jsonl'), projectionPath: join(test.parent, 'restored', 'rebuilt-after.sqlite'), identity: { instanceId: 'restored-resumed', pid: 203, processStartedAt: '2026-09-05T00:02:00.000Z' }, limits: { maxConcurrentRuns: 2, maxRetries: 1, maxRuntimeMinutes: 30, maxTokens: 100, strictSpending: false, strictSpendingSupported: false } });
      await resumed.claim();
      expect(await resumed.admit(intent('new-after-reconcile'))).toEqual(expect.objectContaining({ accepted: true }));
      await resumed.release(); resumed.close();
    } finally { try { await test.coordinator.release(); } catch {} test.coordinator.close(); await rm(test.parent, { recursive: true, force: true }); }
  });

  it('refuses a backup while an active coordinator owns admission', async () => {
    const test = await fixture();
    try {
      await expect(createFactoryBackup(test.request, join(test.parent, 'backup'))).rejects.toThrow(/coordinator is active|quiesced admission/);
    } finally { await test.coordinator.release(); test.coordinator.close(); await rm(test.parent, { recursive: true, force: true }); }
  });

  it('rejects digest corruption, manifest traversal, backup symlinks, and an existing restore target before it writes owner material', async () => {
    const test = await fixture();
    try {
      await test.coordinator.release(); test.coordinator.close();
      const backupRoot = join(test.parent, 'backup');
      await createFactoryBackup(test.request, backupRoot);
      const manifestPath = join(backupRoot, 'manifest.json');
      const original = JSON.parse(await readFile(manifestPath, 'utf8'));
      await writeFile(manifestPath, JSON.stringify({ ...original, factoryId: 'tampered' }));
      await expect(restoreFactoryBackup(backupRoot, restoreRequest(test, join(test.parent, 'digest-target')))).rejects.toBeInstanceOf(MaintenanceValidationError);
      await writeFile(manifestPath, JSON.stringify(signedManifest({ ...original, files: [{ ...original.files[0], path: '../escape' }] })));
      await expect(restoreFactoryBackup(backupRoot, restoreRequest(test, join(test.parent, 'traversal-target')))).rejects.toBeInstanceOf(MaintenanceValidationError);
      await writeFile(manifestPath, JSON.stringify(original));
      await symlink(join(backupRoot, 'files', 'artifacts', 'receipt.txt'), join(backupRoot, 'files', 'linked.txt'));
      await expect(restoreFactoryBackup(backupRoot, restoreRequest(test, join(test.parent, 'symlink-target')))).rejects.toBeInstanceOf(MaintenanceValidationError);
      await rm(join(backupRoot, 'files', 'linked.txt'));
      const ownerTarget = join(test.parent, 'owner-target');
      await mkdir(ownerTarget); await writeFile(join(ownerTarget, 'owner.txt'), 'do not overwrite');
      await expect(restoreFactoryBackup(backupRoot, restoreRequest(test, ownerTarget))).rejects.toThrow(/never be overwritten/);
      expect(await readFile(join(ownerTarget, 'owner.txt'), 'utf8')).toBe('do not overwrite');
    } finally { try { await test.coordinator.release(); } catch {} test.coordinator.close(); await rm(test.parent, { recursive: true, force: true }); }
  });

  it('excludes credential and projection descendants plus ephemeral locks when an operational directory is selected', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'faktori-directory-selection-'));
    const source = join(parent, 'source');
    try {
      await mkdir(join(source, 'config'), { recursive: true });
      await mkdir(join(source, 'state', 'credentials'), { recursive: true });
      await writeFile(join(source, 'config', 'factory.json'), '{"name":"safe"}\n');
      await writeFile(join(source, 'state', 'operations.jsonl'), '');
      await writeFile(join(source, 'state', 'projection.sqlite'), 'rebuildable');
      await writeFile(join(source, 'state', 'projection.sqlite-wal'), 'rebuildable wal');
      await writeFile(join(source, 'state', 'credentials', 'provider.secret'), 'excluded credential');
      await writeFile(join(source, 'state', 'operations.jsonl.action-admission-lock'), 'ephemeral action lock');
      const manifest = await createFactoryBackup({ format: 'faktori.backup-request/v1', factoryId: 'factory', sourceRoot: source, runtimeVersion: '0.6.0', stateFormatVersion: 1, journalPath: 'state/operations.jsonl', configurationPaths: ['config'], artifactPaths: [], operationalPaths: ['state'], projectionPaths: ['state/projection.sqlite'], credentialPaths: ['state/credentials'] }, join(parent, 'backup'));
      expect(manifest.files.map((file) => file.path)).toEqual(['config/factory.json', 'state/operations.jsonl']);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it('restores a real LocalConsoleConfiguration into a separate root, explicitly rebinds owner paths, retains historical journal bytes, and starts the restored service', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'faktori-console-restore-'));
    const source = join(parent, 'source');
    try {
      await mkdir(join(source, 'config'), { recursive: true });
      const sourceRoot = await realpath(source);
      const originalConfiguration = { factoryId: 'factory', journalPath: join(sourceRoot, 'operations.jsonl'), projectionPath: join(sourceRoot, 'projection.sqlite'), port: 0, commandToken: 'restored-token', allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 100, strictSpending: false, strictSpendingSupported: false } };
      parseLocalConsoleConfiguration(originalConfiguration);
      await writeFile(join(source, 'config', 'local-console.json'), `${JSON.stringify(originalConfiguration, null, 2)}\n`);
      await writeFile(join(source, 'operations.jsonl'), '');
      const backup = await createFactoryBackup({ format: 'faktori.backup-request/v1', factoryId: 'factory', sourceRoot: source, runtimeVersion: '0.6.0', stateFormatVersion: 1, journalPath: 'operations.jsonl', configurationPaths: ['config'], artifactPaths: [], operationalPaths: ['operations.jsonl'], projectionPaths: ['projection.sqlite'], credentialPaths: [] }, join(parent, 'backup'));
      const beforeJournal = await readFile(join(parent, 'backup', 'files', 'operations.jsonl'), 'utf8');
      const destination = join(parent, 'restored');
      const restored = await restoreFactoryBackup(join(parent, 'backup'), { format: 'faktori.restore-request/v1', destinationRoot: destination, expectedFactoryId: 'factory', expectedSourceRoot: sourceRoot, rebindConfigurationPaths: true });
      expect(restored.configurationRebindings).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'config/local-console.json', jsonPath: '$.journalPath', from: join(sourceRoot, 'operations.jsonl'), to: join(restored.destinationRoot, 'operations.jsonl') }), expect.objectContaining({ jsonPath: '$.projectionPath', to: join(restored.destinationRoot, 'projection.sqlite') })]));
      expect(await readFile(join(restored.destinationRoot, 'operations.jsonl'), 'utf8')).toBe(beforeJournal);
      const configuration = parseLocalConsoleConfiguration(JSON.parse(await readFile(join(restored.destinationRoot, 'config', 'local-console.json'), 'utf8')));
      const started = await startLocalConsole(configuration);
      try { expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:/); }
      finally { await started.close(); }
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
});
