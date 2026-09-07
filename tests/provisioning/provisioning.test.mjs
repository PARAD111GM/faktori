import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ProvisioningValidationError,
  approveProvisioningProposal,
  createDiscoveryRecord,
  createFakeRemoteTransport,
  createProvisioningProposal,
  previewNewProduct,
  provisionApprovedNewProduct,
  provisionApprovedProposal,
  readApprovedConfigurationRevision,
  renderProvisioningProposal,
} from '../../src/provisioning/index.ts';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function resolvedConfig() {
  return {
    factory: {
      id: 'acme-factory',
      name: 'Acme Factory',
      defaults: { providerId: 'codex', environmentId: 'local' },
    },
    products: [{
      id: 'web',
      name: 'Web',
      providerId: 'codex',
      environmentId: 'local',
      authority: {
        requireIndependentReview: true,
        mergeAuthority: 'human',
        productionReleaseAuthority: 'human',
        allowSeparateBilling: false,
      },
    }],
    pods: [{ id: 'web-pod', productId: 'web' }],
  };
}

function proposalFor(config = resolvedConfig(), extra = {}) {
  return createProvisioningProposal({
    discovery: createDiscoveryRecord({
      factoryId: config.factory.id,
      inventory: { repositories: ['existing-web'], providers: ['codex'] },
      interview: { owner: 'owner-1', productScope: 'web application' },
    }),
    resolvedConfig: config,
    componentVersions: { node: '24.20.0', faktori: '0.0.0' },
    costs: { recurring: '$0 new recurring services', incrementalProducts: { web: '$0' } },
    humanWorkload: ['Review the profile and approve its local Git scaffold.'],
    tradeoffs: ['Remote creation remains unavailable in Phase 1.'],
    ...extra,
  });
}

function approve(proposal) {
  return approveProvisioningProposal({
    proposal,
    approval: {
      approverId: 'owner-1',
      proposalRevision: proposal.revision,
      configurationRevision: proposal.configurationRevision,
      effectIds: proposal.effects.map((effect) => effect.id),
      confirmedRiskIds: proposal.risks.map((risk) => risk.id),
      riskAcknowledgements: Object.fromEntries(proposal.risks.map((risk) => [risk.id, 'I understand and specifically accept this relaxation.'])),
    },
  });
}

function approvalRevision(approval) {
  const payload = {
    approverId: approval.approverId,
    configurationRevision: approval.configurationRevision,
    confirmedRiskIds: approval.confirmedRiskIds,
    effectIds: approval.effectIds,
    format: approval.format,
    proposalRevision: approval.proposalRevision,
    riskAcknowledgements: approval.riskAcknowledgements,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

describe('provisioning proposal and approval', () => {
  it('records discovery and renders a concrete readable proposal with locked versions', () => {
    const proposal = proposalFor();
    const rendered = renderProvisioningProposal(proposal);

    expect(proposal.components).toEqual({ faktori: '0.0.0', node: '24.20.0' });
    expect(rendered).toContain('Cost');
    expect(rendered).toContain('Human workload');
    expect(rendered).toContain('Tradeoffs');
    expect(rendered).toContain('local:product-repository:web');
  });

  it('invalidates an approval after a concrete effect or resolved configuration changes', () => {
    const proposal = proposalFor();
    const approval = approve(proposal);
    const changedProposal = structuredClone(proposal);
    changedProposal.effects[0].description = 'A materially different effect.';

    expect(() => provisionApprovedProposal({ proposal: changedProposal, approval, resolvedConfig: resolvedConfig(), root: '/private/tmp/faktori-never-created' }))
      .toThrow(/proposal\.revision: does not match/);

    const changedConfig = resolvedConfig();
    changedConfig.products[0].environmentId = 'preview';
    expect(() => provisionApprovedProposal({ proposal, approval, resolvedConfig: changedConfig, root: '/private/tmp/faktori-never-created' }))
      .toThrow(/changed after proposal approval/);
  });

  it('requires a specific acknowledgement and new confirmation for every authority relaxation', () => {
    const config = resolvedConfig();
    config.products[0].authority.requireIndependentReview = false;
    const proposal = proposalFor(config);
    const incomplete = {
      proposalRevision: proposal.revision,
      configurationRevision: proposal.configurationRevision,
      approverId: 'owner-1',
      effectIds: proposal.effects.map((effect) => effect.id),
      confirmedRiskIds: [],
    };

    expect(() => approveProvisioningProposal({ proposal, approval: incomplete })).toThrow(/renew confirmation/);
    expect(proposal.risks).toEqual([expect.objectContaining({ id: 'authority:web:requireIndependentReview' })]);
    expect(approve(proposal).confirmedRiskIds).toEqual(['authority:web:requireIndependentReview']);
  });

  it('rejects a forged approval at consumption even when it bypasses the approval helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(root);
    const proposal = proposalFor();
    const forged = { ...approve(proposal), effectIds: [proposal.effects[0].id] };
    forged.revision = approvalRevision(forged);

    expect(() => provisionApprovedProposal({ proposal, approval: forged, resolvedConfig: resolvedConfig(), root }))
      .toThrow(/approval\.effectIds: must confirm every current item exactly once/);
  });

  it('previews inherited defaults and incremental cost without inventing a pod', () => {
    expect(previewNewProduct({
      resolvedConfig: resolvedConfig(),
      product: { id: 'api', name: 'API' },
      incrementalCost: '$12/month estimate',
    })).toEqual(expect.objectContaining({
      inheritsFactoryDefaults: true,
      incrementalCost: '$12/month estimate',
      podsCreated: 0,
      product: expect.objectContaining({ providerId: 'codex', environmentId: 'local' }),
    }));
  });

  it('adds an approved product to an existing factory without changing its profile, repositories, or pods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-product-new-'));
    const source = await mkdtemp(join(tmpdir(), 'faktori-product-source-'));
    roots.push(root, source);
    await writeFile(join(source, 'package.json'), '{"name":"api"}\n');
    const current = resolvedConfig();
    const initial = proposalFor(current);
    provisionApprovedProposal({ proposal: initial, approval: approve(initial), resolvedConfig: current, root });
    const profile = join(root, 'config/factory-profile.json');
    const profileBefore = await readFile(profile, 'utf8');
    const webHeadBefore = execFileSync('git', ['-C', join(root, 'products/web'), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const next = structuredClone(current);
    next.products.push({
      id: 'api', name: 'API', providerId: 'codex', environmentId: 'local',
      authority: structuredClone(current.products[0].authority),
    });
    const proposal = proposalFor(next, {
      change: { kind: 'add-product', productId: 'api', previousResolvedConfig: current },
      localProductSources: { api: source },
      costs: { recurring: '$0', incrementalProducts: { api: '$0 local' } },
    });

    expect(proposal.effects.map(({ id }) => id)).toEqual([
      'local:product-registration:api',
      'local:product-repository:api',
    ]);
    expect(renderProvisioningProposal(proposal)).toContain('create zero implicit pods');
    const bundle = { proposal, approval: approve(proposal), resolvedConfig: next, previousResolvedConfig: current, root };
    const first = provisionApprovedNewProduct(bundle);
    expect(first.operations.every(({ status }) => status === 'completed')).toBe(true);
    expect(await readFile(profile, 'utf8')).toBe(profileBefore);
    expect(execFileSync('git', ['-C', join(root, 'products/web'), 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(webHeadBefore);
    expect(execFileSync('git', ['-C', join(root, 'products/api'), 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    expect(next.pods).toEqual(current.pods);
    expect(readApprovedConfigurationRevision(root)).toBe(proposal.configurationRevision);
    const replay = provisionApprovedNewProduct(bundle);
    expect(replay.operations.every(({ status }) => status === 'reconciled')).toBe(true);
  });

  it('rejects product additions that mutate existing scope, add a pod, or race from a stale revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-product-new-'));
    roots.push(root);
    const current = resolvedConfig();
    const initial = proposalFor(current);
    provisionApprovedProposal({ proposal: initial, approval: approve(initial), resolvedConfig: current, root });
    const changedExisting = structuredClone(current);
    changedExisting.products[0].name = 'Changed without product-update authority';
    changedExisting.products.push({ id: 'api', name: 'API', providerId: 'codex', environmentId: 'local', authority: structuredClone(current.products[0].authority) });
    expect(() => proposalFor(changedExisting, { change: { kind: 'add-product', productId: 'api', previousResolvedConfig: current } }))
      .toThrow(/existing product web changed/);
    const implicitPod = structuredClone(current);
    implicitPod.products.push({ id: 'api', name: 'API', providerId: 'codex', environmentId: 'local', authority: structuredClone(current.products[0].authority) });
    implicitPod.pods.push({ id: 'api-pod', productId: 'api' });
    expect(() => proposalFor(implicitPod, { change: { kind: 'add-product', productId: 'api', previousResolvedConfig: current } }))
      .toThrow(/preserve factory defaults, providers, environments, and every existing pod/);

    const add = (id) => {
      const next = structuredClone(current);
      next.products.push({ id, name: id.toUpperCase(), providerId: 'codex', environmentId: 'local', authority: structuredClone(current.products[0].authority) });
      const proposal = proposalFor(next, { change: { kind: 'add-product', productId: id, previousResolvedConfig: current } });
      return { proposal, approval: approve(proposal), resolvedConfig: next, previousResolvedConfig: current, root };
    };
    provisionApprovedNewProduct(add('api'));
    expect(() => provisionApprovedNewProduct(add('worker'))).toThrow(/configuration changed/);
    expect(execFileSync('git', ['-C', join(root, 'products/web'), 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['-C', join(root, 'products/api'), 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    expect(() => provisionApprovedNewProduct({ proposal: initial, approval: approve(initial), resolvedConfig: current, root }))
      .toThrow(/requires an add-product proposal/);
  });

  it('admits only one of two concurrent product additions from the same approved revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-product-race-'));
    roots.push(root);
    const current = resolvedConfig();
    const initial = proposalFor(current);
    provisionApprovedProposal({ proposal: initial, approval: approve(initial), resolvedConfig: current, root });
    const addition = (id) => {
      const next = structuredClone(current);
      next.products.push({ id, name: id.toUpperCase(), providerId: 'codex', environmentId: 'local', authority: structuredClone(current.products[0].authority) });
      const proposal = proposalFor(next, { change: { kind: 'add-product', productId: id, previousResolvedConfig: current } });
      return { proposal, approval: approve(proposal), resolvedConfig: next, previousResolvedConfig: current, root };
    };
    const api = addition('api');
    const worker = addition('worker');
    let raced = false;
    const loser = provisionApprovedNewProduct({
      ...api,
      onBeforeProductRegistrationWrite() {
        if (!raced) {
          raced = true;
          provisionApprovedNewProduct(worker);
        }
      },
    });

    expect(loser.operations).toEqual([
      expect.objectContaining({
        effectId: 'local:product-registration:api',
        status: 'blocked',
        reason: expect.stringContaining('different product addition claimed'),
      }),
    ]);
    expect(readApprovedConfigurationRevision(root)).toBe(worker.proposal.configurationRevision);
    await expect(access(join(root, 'products/api'))).rejects.toThrow();
    expect(execFileSync('git', ['-C', join(root, 'products/worker'), 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['-C', join(root, 'products/web'), 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });

  it('keeps a registered product visibly blocked and resumable when its approved source import fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-product-resume-'));
    const source = await mkdtemp(join(tmpdir(), 'faktori-product-source-'));
    roots.push(root, source);
    const current = resolvedConfig();
    const initial = proposalFor(current);
    provisionApprovedProposal({ proposal: initial, approval: approve(initial), resolvedConfig: current, root });
    await writeFile(join(source, 'app.mjs'), 'export const version = 1;\n');
    const next = structuredClone(current);
    next.products.push({ id: 'api', name: 'API', providerId: 'codex', environmentId: 'local', authority: structuredClone(current.products[0].authority) });
    const proposal = proposalFor(next, {
      change: { kind: 'add-product', productId: 'api', previousResolvedConfig: current },
      localProductSources: { api: source },
    });
    const bundle = { proposal, approval: approve(proposal), resolvedConfig: next, previousResolvedConfig: current, root };
    await writeFile(join(source, 'app.mjs'), 'export const version = 2;\n');

    const blocked = provisionApprovedNewProduct(bundle);
    expect(blocked.operations).toEqual([
      expect.objectContaining({ effectId: 'local:product-registration:api', status: 'completed' }),
      expect.objectContaining({ effectId: 'local:product-repository:api', status: 'blocked', reason: expect.stringContaining('source snapshot changed') }),
    ]);
    expect(readApprovedConfigurationRevision(root)).toBe(proposal.configurationRevision);
    expect(() => execFileSync('git', ['-C', join(root, 'products/api'), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: 'pipe' })).toThrow();

    await writeFile(join(source, 'app.mjs'), 'export const version = 1;\n');
    const resumed = provisionApprovedNewProduct(bundle);
    expect(resumed.operations).toEqual([
      expect.objectContaining({ effectId: 'local:product-registration:api', status: 'reconciled' }),
      expect.objectContaining({ effectId: 'local:product-repository:api', status: 'completed' }),
    ]);
    expect(execFileSync('git', ['-C', join(root, 'products/api'), 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });
});

describe('resumable local provisioning', () => {
  it('copies an approval-bound existing product snapshot before initializing its local repository', async () => {
    const source = await mkdtemp(join(tmpdir(), 'faktori-product-source-'));
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(source, root);
    await mkdir(join(source, 'src'), { recursive: true });
    await mkdir(join(source, '.git'), { recursive: true });
    await writeFile(join(source, 'package.json'), '{"name":"existing-product"}\n');
    await writeFile(join(source, 'src', 'app.mjs'), 'export const ready = true;\n');
    await writeFile(join(source, '.git', 'source-only'), 'must not be copied\n');
    const proposal = proposalFor(resolvedConfig(), { localProductSources: { web: source } });

    expect(proposal.effects.find(({ id }) => id === 'local:product-repository:web')).toEqual(expect.objectContaining({
      source: expect.objectContaining({ fileCount: 2, digest: expect.any(String) }),
    }));
    const result = provisionApprovedProposal({ proposal, approval: approve(proposal), resolvedConfig: resolvedConfig(), root });
    const target = join(root, 'products', 'web');
    expect(result.operations.find(({ effectId }) => effectId === 'local:product-repository:web')).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(await readFile(join(target, 'src', 'app.mjs'), 'utf8')).toBe('export const ready = true;\n');
    expect(execFileSync('git', ['-C', target, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim()).toBe('true');
    expect(execFileSync('git', ['-C', target, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('main');
    expect(execFileSync('git', ['-C', target, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()).toBe('chore: initialize product');
    expect(execFileSync('git', ['-C', target, 'config', '--local', '--get', 'user.name'], { encoding: 'utf8' }).trim()).toBe('Faktori Agent');
    expect(execFileSync('git', ['-C', target, 'config', '--local', '--get', 'user.email'], { encoding: 'utf8' }).trim()).toBe('faktori@localhost');
    expect(execFileSync('git', ['-C', target, 'status', '--short'], { encoding: 'utf8' })).toBe('');
    await expect(access(join(target, '.git', 'source-only'))).rejects.toThrow();
  });

  it('blocks a changed local product source instead of copying unapproved bytes', async () => {
    const source = await mkdtemp(join(tmpdir(), 'faktori-product-source-'));
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(source, root);
    await writeFile(join(source, 'app.mjs'), 'export const revision = 1;\n');
    const proposal = proposalFor(resolvedConfig(), { localProductSources: { web: source } });
    await writeFile(join(source, 'app.mjs'), 'export const revision = 2;\n');

    const result = provisionApprovedProposal({ proposal, approval: approve(proposal), resolvedConfig: resolvedConfig(), root });
    expect(result.operations.find(({ effectId }) => effectId === 'local:product-repository:web')).toEqual(expect.objectContaining({
      status: 'blocked',
      reason: expect.stringContaining('source snapshot changed'),
    }));
    expect(() => execFileSync('git', ['-C', join(root, 'products', 'web'), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });

  it('refuses Git initialization when the copied scaffold changes before activation', async () => {
    const source = await mkdtemp(join(tmpdir(), 'faktori-product-source-'));
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(source, root);
    await writeFile(join(source, 'app.mjs'), 'export const approved = true;\n');
    const proposal = proposalFor(resolvedConfig(), { localProductSources: { web: source } });

    const result = provisionApprovedProposal({
      proposal,
      approval: approve(proposal),
      resolvedConfig: resolvedConfig(),
      root,
      onBeforeGitInit({ target }) { writeFileSync(join(target, 'app.mjs'), 'export const approved = false;\n'); },
    });
    expect(result.operations.find(({ effectId }) => effectId === 'local:product-repository:web')).toEqual(expect.objectContaining({
      status: 'blocked',
      reason: expect.stringContaining('changed after the approved copy'),
    }));
    expect(() => execFileSync('git', ['-C', join(root, 'products', 'web'), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });

  it('does not adopt a product directory merely because it is inside another Git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(root);
    execFileSync('git', ['init', '--quiet', root]);
    await mkdir(join(root, 'products', 'web'), { recursive: true });
    const proposal = proposalFor();

    const result = provisionApprovedProposal({ proposal, approval: approve(proposal), resolvedConfig: resolvedConfig(), root });
    expect(result.operations.find(({ effectId }) => effectId === 'local:product-repository:web')).toEqual(expect.objectContaining({
      status: 'blocked',
      reason: expect.stringContaining('not a Git repository'),
    }));
    expect(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()).toBe(await realpath(root));
  });

  it('rejects a symlink in a proposed local product source', async () => {
    const source = await mkdtemp(join(tmpdir(), 'faktori-product-source-'));
    const outside = await mkdtemp(join(tmpdir(), 'faktori-product-outside-'));
    roots.push(source, outside);
    await writeFile(join(outside, 'secret.txt'), 'outside\n');
    await symlink(join(outside, 'secret.txt'), join(source, 'linked.txt'));

    expect(() => proposalFor(resolvedConfig(), { localProductSources: { web: source } }))
      .toThrow(/source contains symlink/);
  });

  it('persists intent before a real Git effect, then reconciles on rerun without duplicate repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(root);
    const proposal = proposalFor();
    const approval = approve(proposal);
    let interrupted = false;

    expect(() => provisionApprovedProposal({
      proposal,
      approval,
      resolvedConfig: resolvedConfig(),
      root,
      onAfterEffect({ effect }) {
        if (effect.kind === 'local-git-repository' && !interrupted) {
          interrupted = true;
          throw new Error('simulated interruption after git init');
        }
      },
    })).toThrow('simulated interruption');

    const journalBeforeResume = await readFile(join(root, '.faktori/provisioning/operations.jsonl'), 'utf8');
    expect(journalBeforeResume).toContain('"status":"intended"');
    expect(execFileSync('git', ['-C', join(root, 'products/web'), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim()).toBe('true');

    const resumed = provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root });
    expect(resumed.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ effectId: 'local:product-repository:web', status: 'reconciled' }),
    ]));
    expect(execFileSync('git', ['-C', join(root, 'products/web'), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim()).toBe('true');
  });

  it('detects owner drift on a later rerun without overwriting the profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(root);
    const proposal = proposalFor();
    const approval = approve(proposal);
    provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root });
    const profile = join(root, 'config/factory-profile.json');
    await writeFile(profile, '{"owner":"customized"}\n');

    const rerun = provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root });
    expect(await readFile(profile, 'utf8')).toBe('{"owner":"customized"}\n');
    expect(rerun.operations.find((operation) => operation.effectId === 'local:factory-profile')).toEqual(expect.objectContaining({
      status: 'blocked',
      reason: expect.stringContaining('Drift detected'),
    }));
  });

  it('keeps remote effects visibly pending through an explicitly fake transport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(root);
    const proposal = proposalFor(resolvedConfig(), {
      remoteEffects: [{ id: 'github-web', target: 'github/acme/web', description: 'Create the configured GitHub repository.' }],
    });
    const result = provisionApprovedProposal({
      proposal,
      approval: approve(proposal),
      resolvedConfig: resolvedConfig(),
      root,
      remoteTransport: createFakeRemoteTransport(),
    });

    expect(result.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ effectId: 'remote:github-web', status: 'pending', supported: false, transport: 'fake' }),
    ]));
    expect(() => provisionApprovedProposal({ proposal, approval: approve(proposal), resolvedConfig: resolvedConfig(), root, remoteTransport: { kind: 'real' } }))
      .toThrow(ProvisioningValidationError);
  });

  it('rejects symlinked configuration and products parents before a local write or Git effect', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    const productsRoot = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    const outside = await mkdtemp(join(tmpdir(), 'faktori-outside-'));
    roots.push(configRoot, productsRoot, outside);
    const proposal = proposalFor();
    const approval = approve(proposal);

    await symlink(outside, join(configRoot, 'config'));
    expect(() => provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root: configRoot }))
      .toThrow(/contains symlink component "config"/);

    await mkdir(join(productsRoot, 'config'), { recursive: true });
    await symlink(outside, join(productsRoot, 'products'));
    expect(() => provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root: productsRoot }))
      .toThrow(/contains symlink component "products"/);
  });

  it('rejects a symlinked journal parent before it can write outside the provisioning root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    const outside = await mkdtemp(join(tmpdir(), 'faktori-outside-'));
    roots.push(root, outside);
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'outside remains untouched\n');
    await symlink(outside, join(root, '.faktori'));
    const proposal = proposalFor();
    const approval = approve(proposal);

    expect(() => provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root }))
      .toThrow(/contains symlink component "\.faktori"/);
    expect(await readFile(sentinel, 'utf8')).toBe('outside remains untouched\n');
  });

  it('resumes known intended Git operations before and after leaf-directory creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(root);
    const proposal = proposalFor();
    const approval = approve(proposal);
    let preEffectInterrupted = false;

    expect(() => provisionApprovedProposal({
      proposal,
      approval,
      resolvedConfig: resolvedConfig(),
      root,
      onBeforeEffect({ effect }) {
        if (effect.kind === 'local-git-repository' && !preEffectInterrupted) {
          preEffectInterrupted = true;
          throw new Error('simulated interruption before git leaf creation');
        }
      },
    })).toThrow('before git leaf creation');
    provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root });
    expect(execFileSync('git', ['-C', join(root, 'products/web'), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim()).toBe('true');

    const secondRoot = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(secondRoot);
    expect(() => provisionApprovedProposal({
      proposal,
      approval,
      resolvedConfig: resolvedConfig(),
      root: secondRoot,
      onBeforeGitInit() {
        throw new Error('simulated interruption after leaf creation');
      },
    })).toThrow('after leaf creation');
    expect(() => execFileSync('git', ['-C', join(secondRoot, 'products/web'), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow();
    provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root: secondRoot });
    expect(execFileSync('git', ['-C', join(secondRoot, 'products/web'), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim()).toBe('true');
  });

  it('ignores only an incomplete trailing journal record during recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-provisioning-'));
    roots.push(root);
    const proposal = proposalFor();
    const approval = approve(proposal);
    provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root });
    await appendFile(join(root, '.faktori/provisioning/operations.jsonl'), '{"partial":');

    expect(() => provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root })).not.toThrow();
    expect(await readFile(join(root, '.faktori/provisioning/operations.jsonl'), 'utf8')).not.toContain('"partial"');
    expect(() => provisionApprovedProposal({ proposal, approval, resolvedConfig: resolvedConfig(), root })).not.toThrow();
  });
});
