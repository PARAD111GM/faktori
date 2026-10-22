import { describe, expect, it } from 'vitest';

import { prepareAttendedSpike } from '../../src/production/index.ts';

function request(overrides = {}) {
  return { format: 'faktori.attended-spike-request/v1', spikeId: 'checkout-spike-1', ...overrides };
}

describe('attended spike preparation', () => {
  it('preserves a vague raw idea for discovery without inventing requirements', () => {
    const result = prepareAttendedSpike(request({ rawIdea: 'Make our checkout better' }));
    expect(result).toMatchObject({ status: 'prepared_for_discovery', rawIdea: 'Make our checkout better', executionReady: false, productionReady: false });
    expect(result.stages[0]).toMatchObject({ id: 'requirements_discovery', state: 'not_started', skillPath: 'skills/interview/SKILL.md' });
    expect(result).not.toHaveProperty('requirements');
    expect(result.unresolvedDecisions).toEqual([
      'owner', 'resource:workspace', 'resource:provider', 'resource:deployment',
      'resource:database', 'resource:verification', 'resource:incident',
      'execution_authority', 'deployment_authority', 'resource_policy', 'approved_command_handoff',
    ]);
  });

  it('keeps a missing idea unresolved and requires discovery', () => {
    const result = prepareAttendedSpike(request());
    expect(result.status).toBe('needs_idea');
    expect(result.unresolvedDecisions).toContain('raw_idea');
    expect(result.stages.every((stage) => stage.state === 'not_started')).toBe(true);
  });

  it('treats owner-selected resources as declarations, not execution proof', () => {
    const result = prepareAttendedSpike(request({ rawIdea: 'Explore onboarding', ownerId: 'owner-1', resources: [{ kind: 'workspace', status: 'owner_selected', reference: 'repo:product' }] }));
    expect(result).toMatchObject({ executionReady: false, productionReady: false, resourceEvidence: 'declared_not_observed' });
    expect(result.unresolvedDecisions).toEqual([
      'resource:provider', 'resource:deployment', 'resource:database', 'resource:verification', 'resource:incident',
      'execution_authority', 'deployment_authority', 'resource_policy', 'approved_command_handoff',
    ]);
    expect(result.resources[0].status).toBe('owner_selected');
  });

  it('resolves all six resource decisions only when each resource is owner-selected', () => {
    const kinds = ['workspace', 'provider', 'deployment', 'database', 'verification', 'incident'];
    const resources = kinds.map((kind) => ({ kind, status: 'owner_selected', reference: `${kind}:declared` }));
    const result = prepareAttendedSpike(request({ rawIdea: 'Explore onboarding', ownerId: 'owner-1', resources }));
    expect(result.unresolvedDecisions).toEqual([
      'execution_authority', 'deployment_authority', 'resource_policy', 'approved_command_handoff',
    ]);
    expect(result).toMatchObject({ executionReady: false, productionReady: false, resourceEvidence: 'declared_not_observed' });
  });

  it('keeps anonymous owner-selected resources unresolved until a reference is supplied', () => {
    const kinds = ['workspace', 'provider', 'deployment', 'database', 'verification', 'incident'];
    const resources = kinds.map((kind) => ({ kind, status: 'owner_selected' }));
    const result = prepareAttendedSpike(request({ rawIdea: 'Explore onboarding', ownerId: 'owner-1', resources }));
    expect(result.unresolvedDecisions).toEqual([
      ...kinds.map((kind) => `resource:${kind}`),
      'execution_authority', 'deployment_authority', 'resource_policy', 'approved_command_handoff',
    ]);
  });

  it('keeps unknown and proposed resource declarations actionable', () => {
    const result = prepareAttendedSpike(request({ resources: [
      { kind: 'workspace', status: 'unknown' },
      { kind: 'provider', status: 'proposed' },
    ] }));
    expect(result.unresolvedDecisions).toEqual([
      'raw_idea', 'owner', 'resource:workspace', 'resource:provider', 'resource:deployment',
      'resource:database', 'resource:verification', 'resource:incident',
      'execution_authority', 'deployment_authority', 'resource_policy', 'approved_command_handoff',
    ]);
  });

  it('rejects extra command, secret, and approval fields at every object boundary', () => {
    expect(() => prepareAttendedSpike(request({ command: 'deploy now' }))).toThrow(/unknown field/);
    expect(() => prepareAttendedSpike(request({ secret: 'token' }))).toThrow(/unknown field/);
    expect(() => prepareAttendedSpike(request({ approval: { approved: true } }))).toThrow(/unknown field/);
    expect(() => prepareAttendedSpike(request({ resources: [{ kind: 'provider', status: 'proposed', approval: true }] }))).toThrow(/unknown field/);
  });

  it('rejects malformed and oversized identifiers, strings, arrays, and enum values', () => {
    expect(() => prepareAttendedSpike(request({ spikeId: '../escape' }))).toThrow(/spikeId/);
    expect(() => prepareAttendedSpike(request({ rawIdea: 'x'.repeat(4001) }))).toThrow(/rawIdea/);
    expect(() => prepareAttendedSpike(request({ constraints: Array.from({ length: 33 }, () => 'bounded') }))).toThrow(/constraints/);
    expect(() => prepareAttendedSpike(request({ resources: [{ kind: 'shell', status: 'proposed' }] }))).toThrow(/kind/);
    expect(() => prepareAttendedSpike(request({ rawIdea: { text: 'hello' } }))).toThrow(/rawIdea/);
    expect(() => prepareAttendedSpike(request({ rawIdea: 'idea\0with nul' }))).toThrow(/rawIdea/);
    expect(() => prepareAttendedSpike(request({ resources: [
      { kind: 'workspace', status: 'proposed' }, { kind: 'workspace', status: 'owner_selected' },
    ] }))).toThrow(/duplicate kind/);
  });

  it('produces stable digests, changes the digest with request data, and does not mutate input', () => {
    const input = request({ rawIdea: 'idea', constraints: ['keep scope small'], resources: [{ kind: 'database', status: 'unknown' }] });
    const before = structuredClone(input);
    const first = prepareAttendedSpike(input);
    expect(prepareAttendedSpike(input).requestDigest).toBe(first.requestDigest);
    expect(prepareAttendedSpike({ ...input, rawIdea: 'different idea' }).requestDigest).not.toBe(first.requestDigest);
    expect(input).toEqual(before);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.resources)).toBe(true);
  });
});
