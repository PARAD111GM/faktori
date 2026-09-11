import { describe, expect, it } from 'vitest';
import { reconcileDeliveryInspection } from '../../src/integrations/delivery-observation.ts';
import { planDeliverySynchronization } from '../../src/integrations/delivery-sync.ts';

const time = '2026-09-11T20:00:00Z';
const registration = () => ({ ticket: { key: 'OPS-1', status: 'old-status', rank: 99, workState: 'review', dependencies: [] },
  repository: { repository: 'acme/repo', branch: 'main', registered: true },
  pullRequest: { repository: 'acme/repo', number: 3, headCommit: 'head', merged: false,
    evidence: [{ kind: 'review', commit: 'head', source: 'independent-review', verdict: 'passed', observedAt: time },
      { kind: 'check', commit: 'head', source: 'verify', verdict: 'passed', observedAt: time }],
    deployment: { revision: 'merge-old', verified: true }, stagingAcceptance: { revision: 'merge-old', verified: true } } });
const inspection = () => ({ format: 'faktori.delivery-inspection/v1',
  sprint: { state: 'available', sprintId: '8', issues: [{ key: 'OPS-1', status: 'In Review', rank: 1, dependencyLinks: [], statusCategory: 'indeterminate' }] },
  transitionsByTicket: { 'OPS-1': [{ id: '71', name: 'Ready', targetStatus: 'Ready For Deployment' }] },
  pullRequests: [{ ticketKey: 'OPS-1', repository: 'acme/repo', pullRequest: 3, state: 'available', closed: false, merged: false,
    headCommit: 'head', checks: [{ name: 'verify', state: 'SUCCESS' }], independentReview: 'unknown', deployment: 'unknown' }] });
const policy = { eligibleCodingStatuses: [], protectedStatuses: [], readyForDeploymentStatus: 'Ready For Deployment', maxConcurrentCoding: 0 };
const plan = (result) => planDeliverySynchronization({ ...result, policy });

describe('delivery observation reconciliation', () => {
  it('joins fresh tracker/check observations to retained exact-head review rather than replaying stale status or checks', () => {
    const read = inspection();
    const result = reconcileDeliveryInspection(read, [registration()], time);
    expect(result.deliveries[0].ticket).toMatchObject({ status: 'In Review', rank: 1 });
    expect(plan(result).instructions[0]).toMatchObject({ kind: 'transition', fromStatus: 'In Review' });
    read.pullRequests[0].checks[0].state = 'FAILURE';
    expect(plan(reconcileDeliveryInspection(read, [registration()], time)).instructions[0]).toMatchObject({ kind: 'observe', reason: 'exact_head_failed' });
  });

  it('does not turn GitHub summaries or older candidate/deployment evidence into current acceptance', () => {
    const read = inspection(); read.pullRequests[0].headCommit = 'new-head';
    let result = reconcileDeliveryInspection(read, [registration()], time);
    expect(plan(result).instructions[0]).toMatchObject({ reason: 'exact_head_waiting_for_review' });
    read.pullRequests[0].merged = true; read.pullRequests[0].mergeCommit = 'merge-new';
    result = reconcileDeliveryInspection(read, [registration()], time);
    expect(result.deliveries[0].pullRequest.deployment).toBeUndefined();
    expect(result.deliveries[0].pullRequest.stagingAcceptance).toBeUndefined();
    expect(plan(result).instructions[0]).toMatchObject({ reason: 'verified_merge_deployment_unknown' });
  });

  it('excludes unavailable, closed, unregistered or out-of-sprint work without falling back to prior observations', () => {
    const mutations = [
      r => { r.sprint = { state: 'unknown', reason: 'offline' }; },
      r => { r.sprint.issues = []; },
      r => { r.pullRequests[0].closed = true; },
      r => { r.pullRequests[0].state = 'unknown'; },
      r => { r.pullRequests[0].repository = 'other/repo'; },
      r => { r.pullRequests.push({ ...r.pullRequests[0] }); },
    ];
    for (const mutate of mutations) {
      const read = inspection(); mutate(read);
      const result = reconcileDeliveryInspection(read, [registration()], time);
      expect(result.deliveries).toEqual([]);
      expect(result.unavailable).toHaveLength(1);
      expect(plan(result).instructions).toEqual([]);
    }
  });
});
