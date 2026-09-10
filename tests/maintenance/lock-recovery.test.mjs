import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFactoryBackup, inspectCoordinatorLock, recoverCoordinatorLock } from '../../src/maintenance/index.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';
import { withOwnershipLock } from '../../src/runtime/ownership-lock.ts';

const roots = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(pid = spawnSync(process.execPath, ['-e', '']).pid) {
  const root = await mkdtemp(join(tmpdir(), 'faktori-lock-recovery-'));
  roots.push(root);
  const journal = join(root, 'operations.jsonl');
  const lock = `${journal}.coordinator-lock`;
  const bytes = JSON.stringify({ instanceId: 'test-console', pid, processStartedAt: 'recorded-start' });
  await writeFile(journal, '');
  await writeFile(lock, bytes, { mode: 0o600 });
  return { root, journal, lock, bytes };
}
function request(f, inspection) {
  return { format: 'faktori.lock-recovery-request/v1', journalPath: f.journal,
    expectedLockToken: inspection.lockToken, admissionQuiesced: true };
}

// Prevents an abandoned Console lock from permanently blocking safe backups.
it('recovers only the inspected dead owner, preserves evidence and allows a real backup', async () => {
  const f = await fixture();
  const backupRequest = { format: 'faktori.backup-request/v1', factoryId: 'test', sourceRoot: f.root,
    runtimeVersion: '0.2.0', stateFormatVersion: 1, journalPath: 'operations.jsonl',
    configurationPaths: [], artifactPaths: [], operationalPaths: ['operations.jsonl'] };
  const backupRoot = await mkdtemp(join(tmpdir(), 'faktori-recovered-backup-'));
  roots.push(backupRoot);
  await expect(createFactoryBackup(backupRequest, join(backupRoot, 'before'))).rejects.toThrow(/inspect-lock/);
  const cli = new URL('../../src/cli.ts', import.meta.url).pathname;
  const inspected = spawnSync(process.execPath, [cli, 'backup', 'inspect-lock', f.journal], { encoding: 'utf8' });
  expect(inspected.status).toBe(0);
  const inspection = JSON.parse(inspected.stdout);
  expect(inspection.ownerStatus).toBe('dead');
  const requestPath = join(f.root, 'recovery.json');
  await writeFile(requestPath, JSON.stringify(request(f, inspection)));
  const recovered = spawnSync(process.execPath, [cli, 'backup', 'recover-lock', requestPath], { encoding: 'utf8' });
  expect(recovered.status).toBe(0);
  const result = JSON.parse(recovered.stdout);
  expect(result.recovered).toBe(true);
  expect(await readFile(result.evidencePath, 'utf8')).toBe(f.bytes);
  expect(await readFile(f.journal, 'utf8')).toBe('');
  await expect(readFile(f.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  const backup = await createFactoryBackup(backupRequest, join(backupRoot, 'backup'));
  expect(backup.consistency).toBe('coordinator_offline_lock_held');
});

// Prevents recovery from taking ownership away from a live/unknown/new owner.
it('refuses live, denied, changed, unconfirmed and malformed ownership without removing locks', async () => {
  const f = await fixture(process.pid);
  let inspection = await inspectCoordinatorLock(f.journal);
  await expect(recoverCoordinatorLock(request(f, inspection))).rejects.toThrow(/alive/);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  inspection = await inspectCoordinatorLock(f.journal);
  expect(inspection.ownerStatus).toBe('unknown');
  await expect(recoverCoordinatorLock(request(f, inspection))).rejects.toThrow(/unknown/);
  kill.mockRestore();
  const dead = await fixture();
  inspection = await inspectCoordinatorLock(dead.journal);
  await expect(recoverCoordinatorLock({ ...request(dead, inspection), admissionQuiesced: false })).rejects.toThrow(/admissionQuiesced/);
  await writeFile(dead.lock, JSON.stringify({ instanceId: 'new-console', pid: process.pid, processStartedAt: 'now' }));
  await expect(recoverCoordinatorLock(request(dead, inspection))).rejects.toThrow(/differs/);
  expect(JSON.parse(await readFile(dead.lock, 'utf8')).instanceId).toBe('new-console');
  await writeFile(dead.lock, '{broken');
  await expect(inspectCoordinatorLock(dead.journal)).rejects.toThrow(/malformed/);
  expect(await readFile(f.lock, 'utf8')).toBe(f.bytes);
});

// Prevents lock paths and concurrent recovery from bypassing ownership checks.
it('rejects symlink locks and unresolved concurrent recovery', async () => {
  const f = await fixture();
  const inspection = await inspectCoordinatorLock(f.journal);
  await writeFile(`${f.lock}.recovery-lock`, 'unresolved');
  await expect(recoverCoordinatorLock(request(f, inspection))).rejects.toThrow(/ownership operation/);
  expect(await readFile(f.lock, 'utf8')).toBe(f.bytes);
  await rm(f.lock);
  await symlink(f.journal, f.lock);
  await expect(inspectCoordinatorLock(f.journal)).rejects.toThrow();
  expect(await readFile(f.journal, 'utf8')).toBe('');
});

// Prevents a concurrent starter or maintenance command from replacing the lock
// between recovery's final identity check and removal.
it('serializes coordinator startup, recovery and backup ownership changes', async () => {
  const f = await fixture();
  const inspection = await inspectCoordinatorLock(f.journal);
  const coordinator = await DurableCoordinator.open({ factoryId: 'test', journalPath: f.journal,
    identity: { instanceId: 'new-owner', pid: process.pid, processStartedAt: 'now' },
    limits: { maxConcurrentRuns: 1, maxRetries: 1, maxRuntimeMinutes: 1, maxTokens: 0, strictSpending: false },
    processProbe: { coordinator: async () => 'dead', worker: async () => 'unknown' } });
  const backupRoot = await mkdtemp(join(tmpdir(), 'faktori-lock-contention-'));
  roots.push(backupRoot);
  try {
    await withOwnershipLock(f.lock, async () => {
      await expect(coordinator.claim()).rejects.toThrow(/ownership operation/);
      await expect(recoverCoordinatorLock(request(f, inspection))).rejects.toThrow(/ownership operation/);
      await expect(createFactoryBackup({ format: 'faktori.backup-request/v1', factoryId: 'test', sourceRoot: f.root,
        runtimeVersion: '0.2.0', stateFormatVersion: 1, journalPath: 'operations.jsonl',
        configurationPaths: [], artifactPaths: [], operationalPaths: ['operations.jsonl'] }, join(backupRoot, 'backup'))).rejects.toThrow(/ownership operation/);
      expect(await readFile(f.lock, 'utf8')).toBe(f.bytes);
    });
    await coordinator.claim();
    await expect(recoverCoordinatorLock(request(f, inspection))).rejects.toThrow(/differs/);
    expect(JSON.parse(await readFile(f.lock, 'utf8')).instanceId).toBe('new-owner');
    await coordinator.release();
  } finally { coordinator.close(); }
});
