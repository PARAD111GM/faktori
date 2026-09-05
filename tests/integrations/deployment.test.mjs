import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeploymentMaintenanceExecutor, FileFollowUpStore, InMemoryFollowUpStore } from '../../src/integrations/deployment.ts';

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
  await writeFile(script, `
    import { readFile, writeFile } from 'node:fs/promises';
    const [mode, marker] = process.argv.slice(2);
    if (mode === 'deploy') await writeFile(marker, JSON.stringify({ secret: process.env.DEPLOY_CREDENTIAL, revision: process.env.REVISION }));
    if (mode === 'smoke') { const deployed = JSON.parse(await readFile(marker, 'utf8')); process.exit(deployed.revision === 'rev-7' && process.env.SMOKE === 'pass' ? 0 : 13); }
    if (mode === 'recover') await writeFile(marker, 'recovered');
  `);
  const command = (mode, environment = {}) => ({ executable: process.execPath, args: [script, mode, marker], cwd: directory, environment });
  return { directory, marker, command };
}

describe('deployment and maintenance controller adapter', () => {
  it('runs actual local deploy and smoke processes, keeps credentials outside receipts, and records environment/revision evidence', async () => {
    const local = await fixture();
    try {
      const follows = new FileFollowUpStore(join(local.directory, 'durable-follow-ups'));
      const executor = new DeploymentMaintenanceExecutor({
        credentials: { DEPLOY_CREDENTIAL: 'private-controller-secret' },
        targets: [{ operation: 'deploy.preview', environment: 'preview', revision: 'rev-7', approved: true, mode: 'local-command', command: local.command('deploy', { REVISION: 'rev-7' }), smoke: local.command('smoke', { SMOKE: 'pass' }) }],
      }, follows);

      const result = await executor.execute(action(), async () => undefined);

      expect(result).toEqual({ outcome: 'completed', detail: 'deployment_and_smoke_verified' });
      expect(JSON.parse(await readFile(local.marker, 'utf8'))).toEqual({ secret: 'private-controller-secret', revision: 'rev-7' });
      expect(executor.receipts()).toEqual([expect.objectContaining({ environment: 'preview', revision: 'rev-7', status: 'deployed', mode: 'local-command' })]);
      expect(JSON.stringify(executor.receipts())).not.toContain('private-controller-secret');
      expect(await follows.records()).toEqual([]);
    } finally { await rm(local.directory, { recursive: true, force: true }); }
  });

  it('turns a deploy-success/smoke-failure into a failure with exactly one durable follow-up', async () => {
    const local = await fixture();
    try {
      const follows = new FileFollowUpStore(join(local.directory, 'durable-follow-ups'));
      const executor = new DeploymentMaintenanceExecutor({
        targets: [{ operation: 'deploy.preview', environment: 'preview', revision: 'rev-7', approved: true, mode: 'local-command', command: local.command('deploy', { REVISION: 'rev-7' }), smoke: local.command('smoke', { SMOKE: 'fail' }) }],
      }, follows);

      const first = await executor.execute(action(), async () => undefined);
      const second = await executor.execute(action(), async () => undefined);

      expect(first).toEqual({ outcome: 'failed', detail: 'smoke_check_failed' });
      expect(second).toEqual({ outcome: 'failed', detail: 'smoke_check_failed' });
      expect(await follows.records()).toEqual([expect.objectContaining({ runId: 'run-1', environment: 'preview', revision: 'rev-7', reason: 'smoke_failed' })]);
      expect(executor.receipts().filter((receipt) => receipt.status === 'deployed')).toHaveLength(2);
      expect(executor.receipts().filter((receipt) => receipt.status === 'failed')).toHaveLength(2);
    } finally { await rm(local.directory, { recursive: true, force: true }); }
  });

  it('only observes configured existing-CI records and requires approved compatible recovery hooks', async () => {
    const local = await fixture();
    try {
      const follows = new InMemoryFollowUpStore();
      const executor = new DeploymentMaintenanceExecutor({
        targets: [{ operation: 'deploy.ci', environment: 'staging', revision: 'rev-7', approved: true, mode: 'existing-ci', existingCi: { runId: 'ci-1', url: 'https://ci.example/runs/1', environment: 'staging', revision: 'rev-7', status: 'succeeded' }, smoke: local.command('smoke', { SMOKE: 'pass' }) }],
        recoveryHooks: [{ operation: 'recover.preview', environment: 'preview', revision: 'rev-7', approved: true, configured: true, compatibleWith: (candidate) => candidate.request.runId === 'run-1', precondition: () => true, command: local.command('recover') }],
      }, follows);

      await (await import('node:fs/promises')).writeFile(local.marker, JSON.stringify({ revision: 'rev-7' }));
      expect(await executor.execute(action('deploy.ci'), async () => undefined)).toEqual(expect.objectContaining({ outcome: 'completed' }));
      expect(executor.receipts()[0]).toEqual(expect.objectContaining({ mode: 'existing-ci', ciUrl: 'https://ci.example/runs/1', status: 'observed' }));
      expect(await executor.execute(action('recover.preview'), async () => undefined)).toEqual(expect.objectContaining({ outcome: 'completed' }));
      expect(await executor.execute(action('recover.preview', 'other'), async () => undefined)).toEqual({ outcome: 'blocked', detail: 'recovery_hook_not_configured_approved_or_compatible' });
    } finally { await rm(local.directory, { recursive: true, force: true }); }
  });
});
