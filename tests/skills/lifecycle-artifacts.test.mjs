import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(process.cwd());
const skills = readdirSync(join(root, 'skills'));
const required = ['bootstrap', 'product-creation', 'interview', 'research', 'shaping', 'plan', 'design', 'build', 'review', 'test', 'deploy', 'maintain', 'update', 'handoff', 'factory-operation', 'factory-improvement'];

describe('first-party lifecycle kit', () => {
  it('contains every required skill with valid concise frontmatter', () => {
    expect(skills.sort()).toEqual(required.sort());
    for (const skill of required) {
      const text = readFileSync(join(root, 'skills', skill, 'SKILL.md'), 'utf8');
      expect(text).toMatch(/^---\nname: [a-z0-9-]+\ndescription: .+\n---\n/);
    }
  });

  it('keeps Node and Python examples on the same lifecycle', () => {
    const node = JSON.parse(readFileSync(join(root, 'examples/lifecycle/node.json')));
    const python = JSON.parse(readFileSync(join(root, 'examples/lifecycle/python.json')));
    expect(node.lifecycle).toEqual(['plan', 'design', 'build', 'test', 'deploy', 'maintain']);
    expect(python.lifecycle).toEqual(node.lifecycle);
    expect(python.package).toBe(node.package);
  });

  it('links bootstrap to a discover-first interview with complete answer mapping', () => {
    const bootstrap = readFileSync(join(root, 'skills/bootstrap/SKILL.md'), 'utf8');
    const guide = readFileSync(join(root, 'docs/onboarding/interview.md'), 'utf8');
    const record = JSON.parse(readFileSync(join(root, 'templates/provisioning/interview-record.json')));
    expect(bootstrap).toContain('docs/onboarding/interview.md');
    for (const dimension of ['product scope', 'stack', 'organization', 'hierarchy', 'provider', 'budget', 'human attention', 'approval', 'environments', 'incident']) {
      expect(guide.toLowerCase()).toContain(dimension);
    }
    expect(Object.keys(record.answers)).toHaveLength(10);
    const allowedDestination = /^(factory\.defaults\.(providerId|budget|authority)|environments\[\]|discovery\.(interview\.[A-Za-z][A-Za-z0-9]*|inventory\.[A-Za-z][A-Za-z0-9]*)|proposal\.(costs|humanWorkload|tradeoffs|risks)|mappingReview\.laterPhasePending\[\])$/;
    for (const answer of Object.values(record.answers)) {
      expect(answer).toMatchObject({ status: 'unresolved', mapsTo: expect.any(Array) });
      expect(answer.mapsTo.length).toBeGreaterThan(0);
      for (const destination of answer.mapsTo) expect(destination).toMatch(allowedDestination);
    }
    expect(record.answers.providerPreference.mapsTo).toEqual(['discovery.interview.providerPreference', 'factory.defaults.providerId']);
    expect(record.answers.financialBudget.mapsTo).toEqual(['discovery.interview.financialBudget', 'factory.defaults.budget']);
    expect(record.answers.humanAttention.mapsTo).toEqual(['discovery.interview.humanAttention', 'proposal.humanWorkload']);
    expect(record.answers.approvalMergeReleaseAuthority.mapsTo).toEqual(['discovery.interview.approvalMergeReleaseAuthority', 'factory.defaults.authority']);
    expect(record.answers.environments.mapsTo).toEqual(['discovery.inventory.environments', 'environments[]']);
    expect(record.answers.incidentNotificationRecovery.mapsTo).toEqual(['discovery.interview.incidentNotificationRecovery', 'mappingReview.laterPhasePending[]', 'proposal.tradeoffs']);
    expect(record.discovery).toHaveProperty('sourceRevisions');
    expect(record).toHaveProperty('unknowns');
  });
});
