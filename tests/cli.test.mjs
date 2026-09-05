import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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

  it('creates a revision-bound proposal and approval, applies a bound product, and prepares Console', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-cli-'));
    const proposalRequestPath = join(directory, 'proposal-request.json');
    const approvalRequestPath = join(directory, 'approval-request.json');
    const bundlePath = join(directory, 'bundle.json');
    const consoleRequestPath = join(directory, 'console-request.json');
    const provisioningRoot = join(directory, 'owner-factory');
    const sourceRoot = join(directory, 'website-source');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'package.json'), '{"name":"website","scripts":{"test":"node --test"}}\n');
    const configuration = JSON.parse(await readFile(join(root, 'examples/config/solo.json'), 'utf8'));
    configuration.factory.defaults.executionProfile = 'native';
    configuration.factory.defaults.budget.strictSpending = false;
    await writeFile(proposalRequestPath, JSON.stringify({
      configuration,
      discovery: { factoryId: 'solo-studio', inventory: { providers: ['codex'] }, interview: { owner: 'owner-1' } },
      componentVersions: { faktori: '0.0.0', node: '24.20.0' },
      localProductSources: { website: sourceRoot },
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
    const productRoot = join(provisioningRoot, 'products/website');
    expect(execFileSync('git', ['-C', productRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim()).toBe('true');
    expect(execFileSync('git', ['-C', productRoot, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');

    await writeFile(consoleRequestPath, JSON.stringify({
      configuration,
      factoryRoot: provisioningRoot,
      productId: 'website',
      model: 'gpt-5.5',
      environment: { PATH: '/usr/bin', HOME: directory },
      port: 0,
      estimatedTokens: 1000,
      contextRevision: 'website-context@1',
      authorityRevision: 'website-authority@1',
      createdAt: '2026-09-05T18:00:00.000Z',
      workItem: {
        id: 'website-work', revision: 'website-work@1', objective: 'Complete the bounded website work.',
        acceptanceCriteria: ['The documented test passes.'],
        constraints: ['Do not use network access.'],
      },
    }));
    const prepared = run('console', 'prepare', consoleRequestPath);
    expect(prepared.status).toBe(0, prepared.stderr);
    const consoleConfiguration = JSON.parse(prepared.stdout);
    expect(consoleConfiguration.runtime.workItems[0].intent.target.baseRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(consoleConfiguration.runtime.workItems[0].context.prompt).toContain('Do not use network access.');

    const profilePath = join(provisioningRoot, 'config/factory-profile.json');
    const profileBeforeProducts = await readFile(profilePath, 'utf8');
    const websiteHead = execFileSync('git', ['-C', productRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const addProduct = async (currentConfiguration, productId) => {
      const nextConfiguration = structuredClone(currentConfiguration);
      nextConfiguration.products.push({ id: productId, name: productId.toUpperCase() });
      const productProposalPath = join(directory, `${productId}-proposal.json`);
      const productApprovalPath = join(directory, `${productId}-approval.json`);
      const productBundlePath = join(directory, `${productId}-bundle.json`);
      await writeFile(productProposalPath, JSON.stringify({
        configuration: nextConfiguration,
        discovery: { factoryId: 'solo-studio', inventory: { existingProducts: currentConfiguration.products.map(({ id }) => id) }, interview: { productId } },
        componentVersions: { faktori: '0.0.0', node: '24.20.0' },
        costs: { recurring: '$0 new recurring services', incrementalProducts: { [productId]: '$0 local' } },
        humanWorkload: [`Review and approve product ${productId}.`],
        tradeoffs: ['No pod is created automatically.'],
        change: { kind: 'add-product', productId, previousConfiguration: currentConfiguration },
      }));
      const productProposal = run('provision', 'proposal', productProposalPath);
      expect(productProposal.status).toBe(0, productProposal.stderr);
      const productPlan = JSON.parse(productProposal.stdout);
      expect(productPlan.renderedProposal).toContain('create zero implicit pods');
      await writeFile(productApprovalPath, JSON.stringify({
        proposal: productPlan.proposal,
        approval: {
          approverId: 'owner-1',
          proposalRevision: productPlan.proposal.revision,
          configurationRevision: productPlan.proposal.configurationRevision,
          effectIds: productPlan.proposal.effects.map(({ id }) => id),
          confirmedRiskIds: productPlan.proposal.risks.map(({ id }) => id),
          riskAcknowledgements: Object.fromEntries(productPlan.proposal.risks.map(({ id }) => [id, 'I accept this specific risk.'])),
        },
      }));
      const productApproval = run('provision', 'approve', productApprovalPath);
      expect(productApproval.status).toBe(0, productApproval.stderr);
      await writeFile(productBundlePath, JSON.stringify({
        proposal: productPlan.proposal,
        approval: JSON.parse(productApproval.stdout),
        resolvedConfig: productPlan.resolvedConfig,
        previousResolvedConfig: productPlan.previousResolvedConfig,
      }));
      const created = run('product', 'new', productBundlePath, provisioningRoot);
      expect(created.status).toBe(0, created.stderr);
      return { nextConfiguration, productBundlePath, created: JSON.parse(created.stdout) };
    };

    const api = await addProduct(configuration, 'api');
    expect(api.created.operations.every(({ status }) => status === 'completed')).toBe(true);
    expect(await readFile(profilePath, 'utf8')).toBe(profileBeforeProducts);
    expect(execFileSync('git', ['-C', productRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(websiteHead);
    expect(api.nextConfiguration.pods).toEqual(configuration.pods);
    const apiConsoleRequest = JSON.parse(await readFile(consoleRequestPath, 'utf8'));
    apiConsoleRequest.configuration = api.nextConfiguration;
    apiConsoleRequest.productId = 'api';
    apiConsoleRequest.workItem.id = 'api-work';
    apiConsoleRequest.workItem.revision = 'api-work@1';
    await writeFile(consoleRequestPath, JSON.stringify(apiConsoleRequest));
    const preparedApi = run('console', 'prepare', consoleRequestPath);
    expect(preparedApi.status).toBe(0, preparedApi.stderr);
    expect(JSON.parse(preparedApi.stdout).runtime.workItems[0].intent.target.productId).toBe('api');

    const worker = await addProduct(api.nextConfiguration, 'worker');
    expect(worker.created.operations.every(({ status }) => status === 'completed')).toBe(true);
    const replay = run('product', 'new', worker.productBundlePath, provisioningRoot);
    expect(replay.status).toBe(0, replay.stderr);
    expect(JSON.parse(replay.stdout).operations.every(({ status }) => status === 'reconciled')).toBe(true);
    expect(worker.nextConfiguration.pods).toEqual(configuration.pods);
  }, 40_000);

  it('previews a product without allocating a pod', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-cli-product-'));
    const requestPath = join(directory, 'product.json');
    const configuration = JSON.parse(await readFile(join(root, 'examples/config/solo.json'), 'utf8'));
    await writeFile(requestPath, JSON.stringify({ configuration, product: { id: 'api', name: 'API' }, incrementalCost: '$0 local' }));
    const result = run('product', 'preview', requestPath);
    expect(result.status).toBe(0, result.stderr);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ podsCreated: 0, incrementalCost: '$0 local' }));
  });

  it('rebuilds a real SQLite projection from the public interrupted-run journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-cli-runtime-'));
    const projection = join(directory, 'projection.sqlite');
    const result = run('runtime', 'rebuild', join(root, 'examples/runtime/interrupted-run.jsonl'), projection);

    expect(result.status).toBe(0, result.stderr);
    expect(JSON.parse(result.stdout)).toEqual({
      eventCount: 2,
      snapshots: [expect.objectContaining({
        state: 'launching',
        unresolvedEffects: [expect.objectContaining({ operationId: 'example-launch' })],
      })],
    });
    expect((await stat(projection)).size).toBeGreaterThan(0);
  });
});
