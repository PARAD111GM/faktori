import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeploymentMaintenanceExecutor, FileDeploymentRecordStore, FileFollowUpStore, InMemoryFollowUpStore } from '../../src/integrations/deployment.ts';

function action(operation = 'deploy.preview', revision = 'rev-7') {
  return {
    operationId: 'operation-1',
    request: { runId: 'run-1', actionId: 'action-1', scope: { allowedOperation: operation, expectedRevision: revision } },
    grant: {},
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'faktori-deployment-'));
  const script = join(directory, 'fixture.mjs');
  const marker = join(directory, 'deployed.json');
  const smokeMarker = join(directory, 'smoke.json');
  await writeFile(script, `
    import { readFile, writeFile } from 'node:fs/promises';
    const [mode, marker] = process.argv.slice(2);
    if (mode === 'deploy') await writeFile(marker, JSON.stringify({ secret: process.env.DEPLOY_CREDENTIAL, revision: process.env.REVISION, ambient: process.env.AMBIENT_SENTINEL }));
    if (mode === 'smoke') { const deployed = JSON.parse(await readFile(marker, 'utf8')); await writeFile(marker + '.smoke', JSON.stringify({ deploySecret: process.env.DEPLOY_CREDENTIAL, smokeSecret: process.env.SMOKE_CREDENTIAL, ambient: process.env.AMBIENT_SENTINEL })); process.exit(deployed.revision === 'rev-7' && process.env.SMOKE === 'pass' ? 0 : 13); }
    if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (mode === 'recover') await writeFile(marker, 'recovered');
  `);
  const command = (mode, environment = {}) => ({ executable: process.execPath, args: [script, mode, marker], cwd: directory, environment });
  return { directory, marker, smokeMarker: `${marker}.smoke`, command };
}

describe('deployment and maintenance controller adapter', () => {
  it('runs actual bounded local deploy and smoke processes with phase-scoped credentials and durable evidence', async () => {
    const local = await fixture();
    try {
      const follows = new FileFollowUpStore(join(local.directory, 'durable-follow-ups'));
      const records = new FileDeploymentRecordStore(join(local.directory, 'durable-records'));
      const executor = new DeploymentMaintenanceExecutor({
        targets: [{ operation: 'deploy.preview', environment: 'preview', revision: 'rev-7', approved: true, mode: 'local-command', command: local.command('deploy', { REVISION: 'rev-7' }), smoke: local.command('smoke', { SMOKE: 'pass' }), credentials: { deploy: { DEPLOY_CREDENTIAL: 'private-controller-secret' }, smoke: { SMOKE_CREDENTIAL: 'smoke-only-secret' } } }],
      }, follows, records);

      const previous = process.env.AMBIENT_SENTINEL;
      process.env.AMBIENT_SENTINEL = 'must-not-reach-child';
      let result;
      try { result = await executor.execute(action(), async () => undefined); }
      finally { if (previous === undefined) delete process.env.AMBIENT_SENTINEL; else process.env.AMBIENT_SENTINEL = previous; }

      expect(result).toEqual({ outcome: 'completed', detail: 'deployment_and_smoke_verified' });
      expect(JSON.parse(await readFile(local.marker, 'utf8'))).toEqual({ secret: 'private-controller-secret', revision: 'rev-7' });
      expect(JSON.parse(await readFile(local.smokeMarker, 'utf8'))).toEqual({ smokeSecret: 'smoke-only-secret' });
      expect(await records.records()).toEqual([expect.objectContaining({ runId: 'run-1', actionId: 'action-1', environment: 'preview', revision: 'rev-7', status: 'deployed', mode: 'local-command' })]);
      expect(JSON.stringify(await records.records())).not.toContain('private-controller-secret');
      expect(await follows.records()).toEqual([]);
    } finally { await rm(local.directory, { recursive: true, force: true }); }
  });

  it('turns a deploy-success/smoke-failure into a failure with exactly one durable follow-up', async () => {
    const local = await fixture();
    try {
      const follows = new FileFollowUpStore(join(local.directory, 'durable-follow-ups'));
      const records = new FileDeploymentRecordStore(join(local.directory, 'durable-records'));
      const executor = new DeploymentMaintenanceExecutor({
        targets: [{ operation: 'deploy.preview', environment: 'preview', revision: 'rev-7', approved: true, mode: 'local-command', command: local.command('deploy', { REVISION: 'rev-7' }), smoke: local.command('smoke', { SMOKE: 'fail' }) }],
      }, follows, records);

      const first = await executor.execute(action(), async () => undefined);
      const second = await executor.execute(action(), async () => undefined);

      expect(first).toEqual({ outcome: 'failed', detail: 'smoke_check_failed' });
      expect(second).toEqual({ outcome: 'failed', detail: 'smoke_check_failed' });
      expect(await follows.records()).toEqual([expect.objectContaining({ runId: 'run-1', environment: 'preview', revision: 'rev-7', reason: 'smoke_failed' })]);
      expect((await records.records()).filter((receipt) => receipt.status === 'deployed')).toHaveLength(2);
      expect((await records.records()).filter((receipt) => receipt.status === 'failed')).toHaveLength(2);
    } finally { await rm(local.directory, { recursive: true, force: true }); }
  });

  it('bounds local command runtime through the shared detached-process runner and persists the failed observation', async () => {
    const local = await fixture();
    try {
      const follows = new InMemoryFollowUpStore();
      const records = new FileDeploymentRecordStore(join(local.directory, 'durable-records'));
      const executor = new DeploymentMaintenanceExecutor({
        targets: [{ operation: 'deploy.slow', environment: 'preview', revision: 'rev-7', approved: true, mode: 'local-command', command: { ...local.command('slow'), timeoutMs: 25 }, smoke: local.command('smoke', { SMOKE: 'pass' }) }],
      }, follows, records);

      expect(await executor.execute(action('deploy.slow'), async () => undefined)).toEqual({ outcome: 'failed', detail: 'command_timed_out' });
      expect(await records.records()).toEqual([expect.objectContaining({ runId: 'run-1', environment: 'preview', status: 'failed' })]);
    } finally { await rm(local.directory, { recursive: true, force: true }); }
  });

  it('only observes configured existing-CI records and requires approved compatible recovery hooks', async () => {
    const local = await fixture();
    try {
      const follows = new InMemoryFollowUpStore();
      const records = new FileDeploymentRecordStore(join(local.directory, 'durable-records'));
      const executor = new DeploymentMaintenanceExecutor({
        ciObserver: { observe: async (input) => input.runId === 'ci-1' ? { runId: 'ci-1', url: 'https://ci.example/runs/1', environment: 'staging', revision: 'rev-7', status: 'succeeded' } : undefined },
        targets: [{ operation: 'deploy.ci', environment: 'staging', revision: 'rev-7', approved: true, mode: 'existing-ci', ciRunId: 'ci-1', smoke: local.command('smoke', { SMOKE: 'pass' }) }],
        recoveryHooks: [{ operation: 'recover.preview', environment: 'preview', revision: 'rev-7', approved: true, configured: true, compatibleWith: (candidate) => candidate.request.runId === 'run-1', precondition: () => true, command: local.command('recover') }],
      }, follows, records);

      await (await import('node:fs/promises')).writeFile(local.marker, JSON.stringify({ revision: 'rev-7' }));
      expect(await executor.execute(action('deploy.ci'), async () => undefined)).toEqual(expect.objectContaining({ outcome: 'completed' }));
      expect((await records.records())[0]).toEqual(expect.objectContaining({ runId: 'run-1', mode: 'existing-ci', ciUrl: 'https://ci.example/runs/1', status: 'observed' }));
      expect(await executor.execute(action('recover.preview'), async () => undefined)).toEqual(expect.objectContaining({ outcome: 'completed' }));
      expect(await executor.execute(action('recover.preview', 'other'), async () => undefined)).toEqual({ outcome: 'blocked', detail: 'recovery_hook_not_configured_approved_or_compatible' });
    } finally { await rm(local.directory, { recursive: true, force: true }); }
  });
});
