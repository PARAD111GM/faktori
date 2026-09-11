import { describe, expect, it } from 'vitest';

import { FetchJiraHttpClient } from '../../src/integrations/jira.ts';
import { JiraActiveSprintReadAdapter, executePlannedDeliveryTransitions, planDeliverySynchronization } from '../../src/integrations/delivery-sync.ts';

const evidence = (kind, commit, verdict, observedAt, source = `${kind}-provider`) => ({ kind, commit, verdict, observedAt, source });
const policy = (overrides = {}) => ({ eligibleCodingStatuses: ['To Do'], protectedStatuses: ['In Progress', 'Human Hold'], readyForDeploymentStatus: 'Ready For Deployment', deployedStatus: 'Deployed', acceptedStatus: 'Done', maxConcurrentCoding: 1, ...overrides });
const transitions = [{ id: '71', name: 'Ready for deploy', targetStatus: 'Ready For Deployment' }, { id: '72', name: 'Deploy complete', targetStatus: 'Deployed' }, { id: '73', name: 'Accept work', targetStatus: 'Done' }];
const transitionsByTicket = (keys) => Object.fromEntries(keys.map((key) => [key, transitions]));
const delivery = (overrides = {}) => ({
  ticket: { key: 'OPS-1', status: 'To Do', rank: 1, workState: 'idle', dependencies: [] },
  repository: { repository: 'acme/repo', branch: 'main', registered: true },
  ...overrides,
});

describe('controller delivery synchronization', () => {
  it('evaluates eligible work before capacity and never lets review consume a coding slot', () => {
    const plan = planDeliverySynchronization({
      deliveries: [
        delivery({ ticket: { key: 'OPS-2', status: 'To Do', rank: 2, workState: 'review', dependencies: [] } }),
        delivery({ ticket: { key: 'OPS-3', status: 'To Do', rank: 3, workState: 'idle', dependencies: [{ key: 'OPS-0', state: 'unknown' }] } }),
        delivery({ ticket: { key: 'OPS-1', status: 'To Do', rank: 1, workState: 'idle', dependencies: [] } }),
      ], transitionsByTicket: transitionsByTicket(['OPS-1', 'OPS-2', 'OPS-3']), policy: policy(),
    });
    expect(plan.coding).toEqual({ active: 0, capacity: 1, eligibleBeforeCapacity: ['OPS-1'], selected: ['OPS-1'] });
    expect(plan.instructions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'start_coding', ticketKey: 'OPS-1' }),
      expect.objectContaining({ kind: 'observe', ticketKey: 'OPS-2', reason: 'review_waiting_for_pull_request_observation' }),
      expect.objectContaining({ kind: 'blocked', ticketKey: 'OPS-3', reason: 'dependency_unresolved_or_unknown' }),
    ]));
  });

  it('requires exact-head review and checks, registers identities, and preserves human or unknown states', () => {
    const plan = planDeliverySynchronization({
      deliveries: [
        delivery({ pullRequest: { repository: 'acme/repo', number: 4, headCommit: 'new-head', merged: false, evidence: [evidence('review', 'old-head', 'passed', '2026-09-11T00:00:00Z'), evidence('check', 'new-head', 'passed', '2026-09-11T00:01:00Z')] } }),
        delivery({ ticket: { key: 'OPS-2', status: 'Human Hold', rank: 2, workState: 'idle', dependencies: [] }, pullRequest: { repository: 'acme/repo', number: 5, headCommit: 'head', merged: true, mergeCommit: 'merge', deployment: { revision: 'merge', verified: true }, evidence: [] } }),
        delivery({ ticket: { key: 'OPS-3', status: 'Ready For Deployment', rank: 3, workState: 'idle', dependencies: [] }, pullRequest: { repository: 'other/repo', number: 6, headCommit: 'head', merged: true, mergeCommit: 'merge', deployment: { revision: 'merge', verified: true }, evidence: [] } }),
      ], transitionsByTicket: transitionsByTicket(['OPS-1', 'OPS-2', 'OPS-3']), policy: policy(),
    });
    expect(plan.instructions).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticketKey: 'OPS-1', kind: 'observe', reason: 'exact_head_waiting_for_review' }),
      expect.objectContaining({ ticketKey: 'OPS-2', kind: 'observe', reason: 'protected_human_status' }),
      expect.objectContaining({ ticketKey: 'OPS-3', kind: 'blocked', reason: 'pull_request_repository_identity_mismatch' }),
    ]));
  });

  it('proposes discovered transitions only after exact evidence, then merge SHA and verified deployment', () => {
    const plan = planDeliverySynchronization({
      deliveries: [
        delivery({ pullRequest: { repository: 'acme/repo', number: 4, headCommit: 'head', merged: false, evidence: [evidence('review', 'head', 'passed', '2026-09-11T00:00:00Z'), evidence('check', 'head', 'passed', '2026-09-11T00:01:00Z')] } }),
        delivery({ ticket: { key: 'OPS-2', status: 'Deployed', rank: 2, workState: 'idle', dependencies: [] }, pullRequest: { repository: 'acme/repo', number: 5, headCommit: 'head', merged: true, mergeCommit: 'merge-sha', deployment: { revision: 'merge-sha', verified: true }, stagingAcceptance: { revision: 'merge-sha', verified: true }, evidence: [] } }),
      ], transitionsByTicket: transitionsByTicket(['OPS-1', 'OPS-2']), policy: policy(),
    });
    expect(plan.instructions.filter((item) => item.kind === 'transition')).toEqual([
      expect.objectContaining({ ticketKey: 'OPS-1', transitionId: '71', toStatus: 'Ready For Deployment', reason: 'exact_head_ready_for_human_merge' }),
      expect.objectContaining({ ticketKey: 'OPS-2', transitionId: '73', toStatus: 'Done', reason: 'merge_deployment_and_staging_accepted' }),
    ]);
  });

  it('never transitions deployment evidence directly to accepted status and fails closed on duplicate ticket or PR identities', () => {
    const plan = planDeliverySynchronization({
      deliveries: [
        delivery({ ticket: { key: 'OPS-1', status: 'Ready For Deployment', rank: 1, workState: 'idle', dependencies: [] }, pullRequest: { repository: 'acme/repo', number: 4, headCommit: 'head', merged: true, mergeCommit: 'merge', deployment: { revision: 'merge', verified: true }, evidence: [] } }),
        delivery({ ticket: { key: 'OPS-2', status: 'To Do', rank: 2, workState: 'idle', dependencies: [] }, pullRequests: [{ repository: 'acme/repo', number: 5, headCommit: 'one', merged: false, evidence: [] }, { repository: 'acme/repo', number: 6, headCommit: 'two', merged: false, evidence: [] }] }),
        delivery({ ticket: { key: 'OPS-3', status: 'To Do', rank: 3, workState: 'idle', dependencies: [] } }),
        delivery({ ticket: { key: 'OPS-3', status: 'To Do', rank: 4, workState: 'idle', dependencies: [] } }),
      ], transitionsByTicket: { 'OPS-1': transitions, 'OPS-2': transitions, 'OPS-3': transitions }, policy: policy(),
    });
    expect(plan.instructions).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticketKey: 'OPS-1', kind: 'transition', toStatus: 'Deployed', reason: 'merge_and_deployment_verified' }),
      expect.objectContaining({ ticketKey: 'OPS-2', kind: 'blocked', reason: 'pull_request_identity_ambiguous' }),
      expect.objectContaining({ ticketKey: 'OPS-3', kind: 'blocked', reason: 'ticket_identity_ambiguous' }),
    ]));
    expect(plan.instructions.some((item) => item.ticketKey === 'OPS-1' && item.kind === 'transition' && item.toStatus === 'Done')).toBe(false);
    expect(plan.coding.selected).toEqual([]);
  });

  it('does not borrow a Jira transition ID discovered for another ticket', () => {
    const plan = planDeliverySynchronization({
      deliveries: [delivery({ pullRequest: { repository: 'acme/repo', number: 4, headCommit: 'head', merged: false, evidence: [evidence('review', 'head', 'passed', '2026-09-11T00:00:00Z'), evidence('check', 'head', 'passed', '2026-09-11T00:01:00Z')] } })],
      transitionsByTicket: { 'OPS-OTHER': transitions }, policy: policy(),
    });
    expect(plan.instructions).toEqual([expect.objectContaining({ ticketKey: 'OPS-1', kind: 'observe', reason: 'ready_for_deployment_transition_unknown' })]);
  });

  it('routes only exact signed transition bindings through existing action admission', async () => {
    const plan = { format: 'faktori.delivery-sync-plan/v1', coding: { active: 0, capacity: 1, eligibleBeforeCapacity: [], selected: [] }, instructions: [{ id: 'delivery-sync:OPS-1:transition:71', kind: 'transition', ticketKey: 'OPS-1', repository: 'acme/repo', fromStatus: 'Deployed', toStatus: 'Done', transitionId: '71', reason: 'merge_and_deployment_verified' }] };
    const calls = [];
    const admission = { admit: async (request) => { calls.push(request); return { accepted: true, receipt: { operationId: 'op', actionId: request.actionId } }; } };
    const executed = await executePlannedDeliveryTransitions(plan, [{ instructionId: plan.instructions[0].id, request: { actionId: plan.instructions[0].id, scope: { allowedOperation: 'jira.issue.transition' } } }], admission);
    const skipped = await executePlannedDeliveryTransitions(plan, [{ instructionId: plan.instructions[0].id, request: { actionId: 'other', scope: { allowedOperation: 'jira.issue.transition' } } }], admission);
    expect(calls).toHaveLength(1);
    expect(executed[0]).toMatchObject({ result: 'executed' });
    expect(skipped[0]).toMatchObject({ result: 'skipped', reason: 'signed_action_binding_invalid_or_ambiguous' });
  });
});

describe('bounded Jira sprint adapter', () => {
  it('permits only read-only Agile paths on the configured Jira origin', async () => {
    const seen = [];
    const client = new FetchJiraHttpClient('https://jira.example.test', async (url) => {
      seen.push(String(url));
      return new Response('{}', { status: 200 });
    });
    await client.request({ method: 'GET', path: '/rest/agile/1.0/board/7/sprint?state=active', headers: {} });
    expect(seen).toEqual(['https://jira.example.test/rest/agile/1.0/board/7/sprint?state=active']);
    await expect(client.request({ method: 'POST', path: '/rest/agile/1.0/board/7/sprint', headers: {} })).rejects.toThrow('read-only');
    await expect(client.request({ method: 'GET', path: '/rest/agile/1.0/../../evil', headers: {} })).rejects.toThrow('escaped');
  });

  it('reads one active sprint in provider rank order and discovers transition IDs live', async () => {
    const calls = [];
    const client = { request: async (input) => {
      calls.push(input);
      if (input.path.includes('/board/7/sprint')) return { status: 200, body: { values: [{ id: 9 }] } };
      if (input.path.includes('/sprint/9/issue')) return { status: 200, body: { total: 1, issues: [{ key: 'OPS-1', fields: { status: { name: 'To Do', statusCategory: { key: 'new' } }, issuelinks: [{ type: { name: 'Blocks' }, outwardIssue: { key: 'OPS-2' } }] } }] } };
      return { status: 200, body: { transitions: [{ id: '71', name: 'Ready for deploy', to: { name: 'Ready For Deployment' } }] } };
    } };
    const adapter = new JiraActiveSprintReadAdapter(client);
    await expect(adapter.read('7')).resolves.toEqual(expect.objectContaining({ state: 'available', sprintId: '9', issues: [expect.objectContaining({ key: 'OPS-1', rank: 1 })] }));
    await expect(adapter.transitions('OPS-1')).resolves.toEqual([{ id: '71', name: 'Ready for deploy', targetStatus: 'Ready For Deployment' }]);
    expect(calls.map((call) => call.path)).toEqual(expect.arrayContaining([expect.stringContaining('/rest/agile/1.0/'), expect.stringContaining('/rest/api/3/issue/OPS-1/transitions')]));
  });

  it('preserves ambiguity or malformed provider state as unknown instead of guessing', async () => {
    const adapter = new JiraActiveSprintReadAdapter({ request: async () => ({ status: 200, body: { values: [{ id: 1 }, { id: 2 }] } }) });
    await expect(adapter.read('7')).resolves.toEqual({ state: 'unknown', reason: 'active_sprint_ambiguous' });
  });
});
