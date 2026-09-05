import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveFactoryConfig } from '../../src/config/index.ts';
import {
  approveProvisioningProposal,
  createDiscoveryRecord,
  createProvisioningProposal,
  provisionApprovedProposal,
} from '../../src/provisioning/index.ts';

const example = JSON.parse(readFileSync(join(process.cwd(), 'examples/provisioning/interview-complete.json'), 'utf8'));

function discovery(interview = example.interview) {
  return createDiscoveryRecord({
    factoryId: 'acme-factory',
    inventory: example.discovery,
    interview,
    unknowns: example.unknowns,
  });
}

function proposal(config, record, inputs = example.proposalInputs) {
  return createProvisioningProposal({
    discovery: record,
    resolvedConfig: config,
    ...inputs,
  });
}

function approve(provisioningProposal) {
  return approveProvisioningProposal({
    proposal: provisioningProposal,
    approval: {
      proposalRevision: provisioningProposal.revision,
      configurationRevision: provisioningProposal.configurationRevision,
      approverId: 'alex',
      effectIds: provisioningProposal.effects.map((effect) => effect.id),
      confirmedRiskIds: [],
      riskAcknowledgements: {},
    },
  });
}

describe('completed onboarding interview', () => {
  it('resolves configuration, retains answers, creates a proposal, and invalidates old approval after an answer changes', async () => {
    const resolved = resolveFactoryConfig(example.configuration);
    const originalDiscovery = discovery();
    const originalProposal = proposal(resolved, originalDiscovery);
    const approval = approve(originalProposal);

    expect(resolved.factory.defaults.authority.mergeAuthority).toBe('human');
    expect(originalDiscovery.interview.organizationAndOwners.owner).toBe('alex');
    expect(originalDiscovery.interview.incidentNotificationRecovery.notify).toBe('alex');
    expect(originalProposal.humanWorkload.join(' ')).toContain('8');
    expect(originalProposal.tradeoffs.join(' ')).toContain('rollback and investigate');

    const changedInterview = structuredClone(example.interview);
    changedInterview.humanAttention.reviewWindow = 'weekday mornings';
    const changedDiscovery = discovery(changedInterview);
    const changedProposal = proposal(resolved, changedDiscovery);
    expect(changedDiscovery.revision).not.toBe(originalDiscovery.revision);
    expect(changedProposal.revision).not.toBe(originalProposal.revision);

    const root = await mkdtemp(join(tmpdir(), 'faktori-interview-'));
    try {
      expect(() => provisionApprovedProposal({ proposal: changedProposal, approval, resolvedConfig: resolved, root }))
        .toThrow(/approval: is not bound to this exact proposal/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
