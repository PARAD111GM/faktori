import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareLocalCodexConsole } from '../../src/console/prepare.ts';
import { parseLocalConsoleConfiguration, startLocalConsole } from '../../src/console/startup.ts';
import { approveProvisioningProposal, createDiscoveryRecord, createProvisioningProposal, provisionApprovedProposal } from '../../src/provisioning/index.ts';
import { resolveFactoryConfig } from '../../src/config/index.ts';
import { SqliteProjection } from '../../src/runtime/sqlite-projection.ts';

const roots = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function preparedFactory({ executionProfile = 'native', strictSpending = false } = {}) {
  const source = await mkdtemp(join(tmpdir(), 'faktori-console-source-'));
  const factoryRoot = await mkdtemp(join(tmpdir(), 'faktori-console-factory-'));
  roots.push(source, factoryRoot);
  await writeFile(join(source, 'package.json'), '{"name":"task-board","scripts":{"test":"node --test"}}\n');
  const configuration = JSON.parse(await readFile(join(process.cwd(), 'examples/config/solo.json'), 'utf8'));
  configuration.factory.id = 'cold-start';
  configuration.factory.name = 'Cold Start';
  configuration.factory.defaults.executionProfile = executionProfile;
  configuration.factory.defaults.budget.strictSpending = strictSpending;
  configuration.products = [{ id: 'task-board', name: 'Task Board' }];
  configuration.pods = [{ id: 'task-board-pod', productId: 'task-board' }];
  const resolved = resolveFactoryConfig(configuration);
  const discovery = createDiscoveryRecord({ factoryId: 'cold-start', inventory: { repositories: [source], providers: ['codex'] }, interview: { owner: 'owner' } });
  const proposal = createProvisioningProposal({ discovery, resolvedConfig: resolved, componentVersions: { faktori: '0.0.0', node: '24.20.0' }, localProductSources: { 'task-board': source } });
  const approval = approveProvisioningProposal({ proposal, approval: { approverId: 'owner', proposalRevision: proposal.revision, configurationRevision: proposal.configurationRevision, effectIds: proposal.effects.map(({ id }) => id), confirmedRiskIds: [], riskAcknowledgements: {} } });
  provisionApprovedProposal({ proposal, approval, resolvedConfig: resolved, root: factoryRoot });
  return { configuration, factoryRoot, workspace: join(factoryRoot, 'products', 'task-board') };
}

function request(factory) {
  return {
    configuration: factory.configuration,
    factoryRoot: factory.factoryRoot,
    productId: 'task-board',
    model: 'gpt-5.5',
    environment: { PATH: '/usr/bin', HOME: '/private/tmp/provider-home' },
    port: 0,
    estimatedTokens: 1000,
    contextRevision: 'task-board-context@1',
    authorityRevision: 'task-board-authority@1',
    createdAt: '2026-09-05T18:00:00.000Z',
    workItem: {
      id: 'task-board-implementation',
      revision: 'task-board-work@1',
      objective: 'Implement the frozen task-board behavior.',
      acceptanceCriteria: ['The documented acceptance command passes.', 'State survives reload and restart.'],
      constraints: ['Do not change the test oracle.', 'Do not use network access.'],
    },
  };
}

describe('local Console preparation', () => {
  it('prepares and starts an approved isolated factory in explicit projection-only mode without provider authority', async () => {
    const factory = await preparedFactory({ executionProfile: 'isolated', strictSpending: true });
    const generated = prepareLocalCodexConsole({
      mode: 'projection',
      configuration: factory.configuration,
      factoryRoot: factory.factoryRoot,
      port: 0,
    });
    const scope = { factoryId: 'cold-start', productId: 'task-board', podId: 'task-board-pod' };
    await mkdir(dirname(generated.projectionPath), { recursive: true });
    const installedProjection = new SqliteProjection(generated.projectionPath);
    installedProjection.close();
    generated.preflightRequest = {
      format: 'faktori.preflight/v1',
      configuration: factory.configuration,
      target: scope,
      providers: [{ providerId: 'codex', capabilities: [
        { capability: 'isolated', status: 'pass', freshness: 'current', scope },
        { capability: 'token-limit', status: 'pass', freshness: 'current', scope },
      ] }],
      console: { prerequisites: [{ id: 'projection', status: 'pass', freshness: 'current', scope }] },
      execution: { prerequisites: [] },
      resources: { prerequisites: [] },
      integrations: { prerequisites: [] },
    };
    const parsed = parseLocalConsoleConfiguration(generated);

    expect(parsed.runtime).toBeUndefined();
    expect(parsed.preflight).toMatchObject({ status: 'partial', projectionReady: true, executionReady: false, liveExecutionVerified: false });
    expect(parsed.limits).toEqual(expect.objectContaining({ strictSpending: true, strictSpendingSupported: false }));
    expect(() => prepareLocalCodexConsole({
      mode: 'projection',
      configuration: factory.configuration,
      factoryRoot: factory.factoryRoot,
      productId: 'task-board',
    })).toThrow(/must not include provider or work-item fields/);
    const started = await startLocalConsole(parsed);
    try {
      const state = (await started.app.inject({ method: 'GET', url: '/api/console/state' })).json();
      expect(state.hierarchy.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'factory:cold-start', label: 'Cold Start' }),
        expect.objectContaining({ id: 'product:task-board', label: 'Task Board' }),
        expect.objectContaining({ id: 'pod:task-board-pod', productId: 'task-board' }),
      ]));
      expect(state.hierarchy.nodes.filter((node) => node.kind === 'work_item')).toEqual([]);
      expect(state.preflight).toEqual(parsed.preflight);
    } finally {
      await started.close();
    }
  });

  it('reports a missing Console projection without creating it during configuration parsing', async () => {
    const factory = await preparedFactory();
    const generated = prepareLocalCodexConsole({ mode: 'projection', configuration: factory.configuration, factoryRoot: factory.factoryRoot, port: 0 });
    generated.preflightRequest = {
      format: 'faktori.preflight/v1',
      configuration: factory.configuration,
      target: { factoryId: 'cold-start', productId: 'task-board' },
      execution: { prerequisites: [] }, resources: { prerequisites: [] }, integrations: { prerequisites: [] },
    };
    const parsed = parseLocalConsoleConfiguration(generated);
    expect(parsed.preflight).toMatchObject({ status: 'blocked', projectionReady: false, executionReady: false, liveExecutionVerified: false });
    expect(parsed.preflight.checks.find((item) => item.id === 'console.installed_projection').remediation).toMatch(/faktori runtime rebuild/i);
    await expect(readFile(generated.projectionPath)).rejects.toThrow();
  });

  it('binds one clean provisioned product, exact context, authority, and native Codex route', async () => {
    const factory = await preparedFactory();
    const generated = prepareLocalCodexConsole(request(factory));
    const parsed = parseLocalConsoleConfiguration(generated);

    expect(parsed.factoryId).toBe('cold-start');
    expect(parsed.runtime.workItems[0].intent.target.baseRevision).toBe(execFileSync('git', ['-C', factory.workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    expect(parsed.runtime.workItems[0].intent.execution.approvedInputDigests).toHaveLength(1);
    expect(parsed.runtime.workItems[0].context.prompt).toContain('The documented acceptance command passes.');
    expect(parsed.runtime.workItems[0].context.prompt).toContain('Do not change the test oracle.');
    expect(parsed.runtime.workItems[0].context.prompt).toContain('Do not inspect memory');
    expect(parsed.runtime.workItems[0].context.prompt).toContain('Do not create symlinks');
    expect(parsed.runtime.providers).toEqual([expect.objectContaining({ id: 'codex', profile: 'native', compatibleModels: ['gpt-5.5'], contextIsolation: 'bounded' })]);
  });

  it('rejects a dirty product and an unsupported strict-spending promise', async () => {
    const factory = await preparedFactory();
    await writeFile(join(factory.workspace, 'unapproved.txt'), 'dirty\n');
    expect(() => prepareLocalCodexConsole(request(factory))).toThrow(/must be clean/);
    await rm(join(factory.workspace, 'unapproved.txt'));
    const strict = request(factory);
    strict.configuration.factory.defaults.budget.strictSpending = true;
    expect(() => prepareLocalCodexConsole(strict)).toThrow(/profile does not match|strict spending/);
  });
});
