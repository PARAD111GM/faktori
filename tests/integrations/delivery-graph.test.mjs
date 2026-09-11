import { describe, expect, it } from 'vitest';
import { dependencyEvidenceDigest, planGraphDelivery } from '../../src/integrations/delivery-graph.ts';

const source = id => ({ id, text: id, revision: 'r1' });
const node = id => ({ id, kind: 'executable', label: id, objective: source(`${id}-objective`), criteria: [source(`${id}-criteria`)],
  designReferences: [], artifacts: [source(`${id}-artifact`)], commands: [], authority: [], evidenceRequirements: [] });
function fixture() {
  const hierarchy = { revision: 'r1', globalConstraints: [], nodes: ['a', 'b', 'c'].map(node),
    dependencies: [{ id: 'b-needs-a', fromId: 'b', toId: 'a', contract: source('contract') }] };
  const registrations = ['a', 'b', 'c'].map((id, index) => ({ nodeId: id, delivery: {
    ticket: { key: `OPS-${index + 1}`, rank: index === 1 ? 0 : index + 1, status: 'To Do', workState: index === 0 ? 'review' : 'idle', dependencies: [] },
    repository: { repository: 'owner/repo', branch: 'main', registered: true },
  } }));
  return { hierarchy, registrations, observations: [], transitionsByTicket: {},
    policy: { eligibleCodingStatuses: ['To Do'], protectedStatuses: [], maxConcurrentCoding: 1 } };
}
describe('graph-backed delivery frontier', () => {
  it('orders only eligible nodes by Jira rank and assembles scoped context for dispatch', () => {
    const input = fixture();
    expect(planGraphDelivery(input).frontier.map(n => n.nodeId)).toEqual(['c']);
    input.observations.push({ edgeId: 'b-needs-a', state: 'satisfied', evidence: 'receipt:contract-verified', dependencyDigest: dependencyEvidenceDigest(input.hierarchy, 'b-needs-a') });
    const plan = planGraphDelivery(input);
    expect(plan.frontier.map(n => n.nodeId)).toEqual(['b']);
    expect(plan.frontier[0].context.dependencyContracts[0].dependsOnNodeId).toBe('a');
    expect(plan.frontier[0].context.artifacts.map(a => a.id)).not.toContain('c-artifact');
  });
  it('invalidates affected edge evidence, not unrelated sibling changes', () => {
    const input = fixture();
    input.observations.push({ edgeId: 'b-needs-a', state: 'satisfied', evidence: 'receipt:1', dependencyDigest: dependencyEvidenceDigest(input.hierarchy, 'b-needs-a') });
    input.hierarchy.nodes[2].artifacts[0].revision = 'r2'; input.hierarchy.revision = 'r2';
    expect(planGraphDelivery(input).frontier.map(n => n.nodeId)).toEqual(['b']);
    input.hierarchy.nodes[0].artifacts[0].revision = 'r2';
    expect(planGraphDelivery(input).frontier.map(n => n.nodeId)).toEqual(['c']);
    expect(planGraphDelivery(input).blockedEdges).toEqual([expect.objectContaining({ edgeId: 'b-needs-a' })]);
  });
  it('rejects cycles, planning-node execution and ambiguous mappings before selection', () => {
    const cyclic = fixture(); cyclic.hierarchy.dependencies.push({ id: 'a-needs-b', fromId: 'a', toId: 'b', contract: source('reverse') });
    expect(() => planGraphDelivery(cyclic)).toThrow(/cycle/i);
    const planning = fixture(); planning.hierarchy.nodes[0].kind = 'planning';
    expect(() => planGraphDelivery(planning)).toThrow(/executable/);
    const duplicate = fixture(); duplicate.registrations.push(duplicate.registrations[0]);
    expect(() => planGraphDelivery(duplicate)).toThrow(/unique/);
  });
  it('invalidates evidence through the affected upstream dependency closure', () => {
    const input = fixture(); input.hierarchy.nodes.push(node('d'));
    input.hierarchy.dependencies.push({ id: 'a-needs-d', fromId: 'a', toId: 'd', contract: source('second-contract') });
    input.observations.push({ edgeId: 'b-needs-a', state: 'satisfied', evidence: 'receipt:1', dependencyDigest: dependencyEvidenceDigest(input.hierarchy, 'b-needs-a') });
    expect(planGraphDelivery(input).frontier.map(n => n.nodeId)).toEqual(['b']);
    input.hierarchy.nodes[3].artifacts[0].revision = 'r2';
    expect(planGraphDelivery(input).frontier.map(n => n.nodeId)).toEqual(['c']);
  });
  it('does not lose newer Jira blockers when the graph projection lags', () => {
    const input = fixture(); input.registrations[2].delivery.ticket.dependencies = [{ key: 'OPS-99', state: 'resolved' }];
    const result = planGraphDelivery(input);
    expect(result.frontier).toEqual([]);
    expect(result.blockedEdges).toContainEqual({ nodeId: 'c', edgeId: 'OPS-99', reason: 'tracker_dependency_missing_from_graph' });
  });
  it('does not promote a reviewed candidate across an unsatisfied graph edge', () => {
    const input = fixture();
    input.registrations[1].delivery.pullRequest = { repository: 'owner/repo', number: 1, headCommit: 'head', merged: false,
      evidence: ['check', 'review'].map(kind => ({ kind, commit: 'head', verdict: 'passed', source: kind, observedAt: '2026-09-11T12:00:00Z' })) };
    input.policy.readyForDeploymentStatus = 'Ready';
    input.transitionsByTicket = { 'OPS-2': [{ id: '31', name: 'Ready', targetStatus: 'Ready' }] };
    expect(planGraphDelivery(input).instructions).toContainEqual(expect.objectContaining({ ticketKey: 'OPS-2', kind: 'blocked', reason: 'graph_dependency_evidence_not_satisfied' }));
  });
});
