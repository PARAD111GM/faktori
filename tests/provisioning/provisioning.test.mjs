import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  provisionApprovedProposal,
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
});

describe('resumable local provisioning', () => {
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
