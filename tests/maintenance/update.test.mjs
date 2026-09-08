import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyRuntimeUpdate, initializeRuntimeInstallation, MaintenanceValidationError, previewRuntimeUpdate } from '../../src/maintenance/index.ts';

const repository = new URL('../..', import.meta.url).pathname;
const kitPaths = ['dist', 'console/dist', 'docs', 'docker', 'examples', 'provider-entrymaps/generated', 'skills', 'templates', 'LICENSE', 'README.md'];

async function candidate(root, name, version, stateFormatVersion = 1) {
  const destination = join(root, name);
  for (const path of kitPaths) await cp(join(repository, path), join(destination, path), { recursive: true });
  const packageJson = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
  await writeFile(join(destination, 'package.json'), `${JSON.stringify({ ...packageJson, version, faktoriStateFormatVersion: stateFormatVersion }, null, 2)}\n`);
  return destination;
}

function request(installationRoot, candidateRoot) {
  return { format: 'faktori.update-request/v1', installationRoot, candidateRoot };
}

function approval(preview) {
  return { format: 'faktori.update-approval/v1', previewDigest: preview.previewDigest, approvedBy: 'owner', confirmedAt: '2026-09-05T00:00:00.000Z' };
}

describe('managed runtime update assembly', () => {
  it('initializes a real built kit, applies an approval-bound later release, preserves owner material, and executes the manifest-selected independent installed entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-update-'));
    try {
      const installation = join(root, 'installation');
      const first = await candidate(root, 'candidate-1', '1.0.0');
      const second = await candidate(root, 'candidate-2', '1.0.1');
      await (await import('node:fs/promises')).mkdir(installation);
      await writeFile(join(installation, 'owner-customization.json'), '{"must":"survive"}\n');
      const initialized = await initializeRuntimeInstallation(request(installation, first));
      const preview = await previewRuntimeUpdate(request(installation, second));
      expect(preview).toEqual(expect.objectContaining({ currentVersion: '1.0.0', candidateVersion: '1.0.1', outcome: 'update_available', migration: 'state-v1-compatible' }));
      const applied = await applyRuntimeUpdate({ request: request(installation, second), approval: approval(preview) });
      expect(applied).toEqual(expect.objectContaining({ changed: true, manifest: expect.objectContaining({ activeVersion: '1.0.1', activeEntrypoint: expect.stringMatching(/^1\.0\.1-[a-f0-9]{16}\/runtime\/node_modules\/\.bin\/faktori$/) }) }));
      expect(await readFile(join(installation, 'owner-customization.json'), 'utf8')).toBe('{"must":"survive"}\n');
      const manifest = JSON.parse(await readFile(join(installation, '.faktori', 'runtime-installation.json'), 'utf8'));
      expect(manifest.activeRelease).not.toBe(initialized.activeRelease);
      const { spawnSync } = await import('node:child_process');
      const selected = spawnSync(join(installation, '.faktori', 'releases', manifest.activeEntrypoint), ['--help'], { encoding: 'utf8' });
      expect(selected.status).toBe(0);
      expect(selected.stdout).toContain('faktori update preview');
      const runtimeProof = join(root, 'selected-runtime-proof');
      await mkdir(runtimeProof);
      const journal = join(runtimeProof, 'operations.jsonl');
      await writeFile(journal, '');
      const rebuilt = spawnSync(join(installation, '.faktori', 'releases', manifest.activeEntrypoint), ['runtime', 'rebuild', journal, join(runtimeProof, 'projection.sqlite')], { encoding: 'utf8' });
      expect(rebuilt.status).toBe(0);
      expect(JSON.parse(rebuilt.stdout)).toEqual(expect.objectContaining({ eventCount: 0, snapshots: [] }));
    } finally { await rm(root, { recursive: true, force: true }); }
  // This intentionally copies and activates two complete built kits. Under the
  // full parallel suite it can exceed 30 seconds even though the isolated test
  // passes, so keep a bounded ceiling that includes suite-level I/O contention.
  }, 60_000);

  it('rejects a candidate altered after preview without activation, plus rollback, prerelease, and unsupported operational state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-update-reject-'));
    try {
      const installation = join(root, 'installation');
      await (await import('node:fs/promises')).mkdir(installation);
      const base = await candidate(root, 'base', '1.0.0');
      const next = await candidate(root, 'next', '1.0.1');
      await initializeRuntimeInstallation(request(installation, base));
      const preview = await previewRuntimeUpdate(request(installation, next));
      await writeFile(join(next, 'README.md'), 'candidate mutated after owner preview\n');
      await expect(applyRuntimeUpdate({ request: request(installation, next), approval: approval(preview) })).rejects.toThrow(/approval does not match/);
      expect(JSON.parse(await readFile(join(installation, '.faktori', 'runtime-installation.json'), 'utf8')).activeVersion).toBe('1.0.0');
      await expect(previewRuntimeUpdate(request(installation, await candidate(root, 'rollback', '0.9.9')))).rejects.toBeInstanceOf(MaintenanceValidationError);
      await expect(previewRuntimeUpdate(request(installation, await candidate(root, 'prerelease', '1.0.2-rc.1')))).rejects.toBeInstanceOf(MaintenanceValidationError);
      await expect(previewRuntimeUpdate(request(installation, await candidate(root, 'state-v2', '1.0.2', 2)))).rejects.toBeInstanceOf(MaintenanceValidationError);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
