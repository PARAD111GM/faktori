import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const cli = join(root, 'src', 'cli.ts');

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
}

describe('public CLI', () => {
  it('resolves the documented configuration and reports actionable errors', () => {
    const valid = run('config', 'resolve', join(root, 'examples/config/solo.json'));
    expect(valid.status).toBe(0);
    expect(JSON.parse(valid.stdout).products[0].providerId).toBe('codex');

    const invalid = run('config', 'resolve', join(root, 'package.json'));
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('Invalid factory configuration');
    expect(invalid.stderr).toContain('factory');
  });

  it('creates a revision-bound proposal and approval, then applies real local Git scaffolding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-cli-'));
    const proposalRequestPath = join(directory, 'proposal-request.json');
    const approvalRequestPath = join(directory, 'approval-request.json');
    const bundlePath = join(directory, 'bundle.json');
    const provisioningRoot = join(directory, 'owner-factory');
    const configuration = JSON.parse(await readFile(join(root, 'examples/config/solo.json'), 'utf8'));
    await writeFile(proposalRequestPath, JSON.stringify({
      configuration,
      discovery: { factoryId: 'solo-studio', inventory: { providers: ['codex'] }, interview: { owner: 'owner-1' } },
      componentVersions: { faktori: '0.0.0', node: '24.20.0' },
      costs: { recurring: '$0 new recurring services' },
      humanWorkload: ['Review and approve this local scaffold.'],
      tradeoffs: ['Remote provisioning remains unsupported in Phase 1.'],
    }));

    const proposed = run('provision', 'proposal', proposalRequestPath);
    expect(proposed.status).toBe(0, proposed.stderr);
    const bundle = JSON.parse(proposed.stdout);
    expect(bundle.renderedProposal).toContain('Concrete effects');
    await writeFile(approvalRequestPath, JSON.stringify({
      proposal: bundle.proposal,
      approval: {
        approverId: 'owner-1',
        proposalRevision: bundle.proposal.revision,
        configurationRevision: bundle.proposal.configurationRevision,
        effectIds: bundle.proposal.effects.map(({ id }) => id),
        confirmedRiskIds: bundle.proposal.risks.map(({ id }) => id),
        riskAcknowledgements: Object.fromEntries(bundle.proposal.risks.map(({ id }) => [id, 'I accept this specific risk.'])),
      },
    }));
    const approved = run('provision', 'approve', approvalRequestPath);
    expect(approved.status).toBe(0, approved.stderr);
    await writeFile(bundlePath, JSON.stringify({
      proposal: bundle.proposal,
      approval: JSON.parse(approved.stdout),
      resolvedConfig: bundle.resolvedConfig,
    }));

    const applied = run('provision', 'apply', bundlePath, provisioningRoot);
    expect(applied.status).toBe(0, applied.stderr);
    expect(JSON.parse(applied.stdout).operations.every(({ status }) => status === 'completed')).toBe(true);
    expect(execFileSync('git', ['-C', join(provisioningRoot, 'products/website'), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim()).toBe('true');
  });

  it('previews a product without allocating a pod', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-cli-product-'));
    const requestPath = join(directory, 'product.json');
    const configuration = JSON.parse(await readFile(join(root, 'examples/config/solo.json'), 'utf8'));
    await writeFile(requestPath, JSON.stringify({ configuration, product: { id: 'api', name: 'API' }, incrementalCost: '$0 local' }));
    const result = run('product', 'preview', requestPath);
    expect(result.status).toBe(0, result.stderr);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ podsCreated: 0, incrementalCost: '$0 local' }));
  });
});
