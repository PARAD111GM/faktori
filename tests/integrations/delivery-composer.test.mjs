import { describe, expect, it } from 'vitest';

import { ControllerActionAdmission, InMemoryActionGrantVault, InMemoryActionJournal, signActionRequest } from '../../src/actions/index.ts';
import { createDeliveryTransitionController, DeliveryTransitionComposer, DeliveryTransitionOperationResolver } from '../../src/integrations/delivery-composer.ts';
import { JiraRestActionExecutor } from '../../src/integrations/jira.ts';

const policy = {
  eligibleCodingStatuses: ['To Do'], protectedStatuses: ['Human Hold'], readyForDeploymentStatus: 'Ready For Deployment',
  deployedStatus: 'Deployed', acceptedStatus: 'Done', requiredCheckSources: ['checks'], maxConcurrentCoding: 1,
};

const scope = {
  kind: 'jira.delivery-transition', repository: 'acme/repo', branch: 'feature/ops-1', baseRevision: 'base', expectedRevision: 'head-1',
  allowedOperation: 'jira.issue.transition', scopeRevision: 'delivery-authority@1',
};

function observation(head = 'head-1') {
  return {
    deliveries: [{
      ticket: { key: 'OPS-1', status: 'In Review', rank: 1, workState: 'review', dependencies: [] },
      repository: { repository: 'acme/repo', branch: 'feature/ops-1', registered: true },
      pullRequest: {
        repository: 'acme/repo', number: 7, headCommit: head, merged: false,
        evidence: [
          { kind: 'review', commit: head, verdict: 'passed', observedAt: '2026-09-11T00:00:00.000Z', source: 'independent-review' },
          { kind: 'check', commit: head, verdict: 'passed', observedAt: '2026-09-11T00:00:01.000Z', source: 'checks' },
        ],
      },
    }],
    transitionsByTicket: { 'OPS-1': [{ id: '71', name: 'Ready for deployment', targetStatus: 'Ready For Deployment' }] },
  };
}

function http(responses = []) {
  const calls = [];
  return {
    calls,
    request: async (input) => {
      calls.push(input);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? { status: 204 };
    },
  };
}

async function fixture({ authorityAllowed = true, client = http([{ status: 200, body: { fields: { status: { name: 'In Review' } } } }, { status: 204 }]) } = {}) {
  let authority = { runId: 'delivery-run', scope: structuredClone(scope), authorityEpoch: 3, revoked: false, actionAllowed: authorityAllowed };
  const journal = new InMemoryActionJournal();
  const vault = new InMemoryActionGrantVault();
  const resolver = new DeliveryTransitionOperationResolver();
  let beforeWrite;
  const executor = new JiraRestActionExecutor({ client, operationFor: (action) => resolver.operationFor(action), transitions: resolver.transitions, beforeWrite: async (action, operation) => beforeWrite?.(action, operation) });
  const admission = new ControllerActionAdmission({
    journal, grantVault: vault, authority: { current: async () => structuredClone(authority) }, executor,
    clock: { now: () => new Date('2026-09-11T00:01:00.000Z') },
    random: { id: () => `record-${journal.records().length}`, secret: () => 'deterministic-private-action-verifier-secret' },
  });
  const capability = await admission.mintGrant({ runId: authority.runId, scope, authorityEpoch: authority.authorityEpoch });
  const signedRequests = [];
  const binding = {
    ticketKey: 'OPS-1', repository: 'acme/repo', runId: authority.runId, scope, authorityEpoch: authority.authorityEpoch, requestedAt: '2026-09-11T00:00:00.000Z',
    signer: { sign: async (request) => {
      const signed = signActionRequest(request, capability, `nonce-${request.idempotencyKey}`);
      signedRequests.push(signed);
      return signed;
    } },
  };
  return { admission, authority: (value) => { authority = { ...authority, ...value }; }, binding, client, journal, resolver, vault, signedRequests, setBeforeWrite: (value) => { beforeWrite = value; } };
}

function composer(options) {
  return new DeliveryTransitionComposer({ policy, ...options });
}

describe('delivery transition composition', () => {
  it('production controller always attaches the post-reconciliation evidence gate', async () => {
    const test = await fixture();
    let reads = 0;
    const controller = createDeliveryTransitionController({
      observe: async () => observation(++reads > 3 ? 'changed-after-reconcile' : 'head-1'), policy, bindings: [test.binding],
      actions: { journal: test.journal, grantVault: test.vault, authority: test.admission.authority }, jira: { client: test.client },
    });
    const result = await controller.synchronize();
    expect(result.executions[0]).toMatchObject({ result: 'skipped', reason: 'blocked' });
    expect(test.client.calls.map(call => call.method)).toEqual(['GET']);
    expect(test.journal.records().filter(record => record.kind === 'grant.issued')).toHaveLength(1);
  });

  it('turns one fresh exact-head observation into one admitted, sealed Jira transition', async () => {
    const test = await fixture();
    const value = composer({ observe: async () => observation(), bindings: [test.binding], admission: test.admission, resolver: test.resolver });
    test.setBeforeWrite(value.validateBeforeWrite.bind(value));
    const result = await value.synchronize();

    expect(result.executions).toEqual([expect.objectContaining({ ticketKey: 'OPS-1', result: 'executed' })]);
    expect(test.client.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(test.client.calls[1]).toMatchObject({ path: '/rest/api/3/issue/OPS-1/transitions', body: { transition: { id: '71' } } });
    expect(test.journal.records().filter((record) => record.kind === 'action.intent')).toHaveLength(1);
    expect(test.journal.records().filter((record) => record.kind === 'action.receipt')).toHaveLength(1);

    const replay = await value.synchronize();
    expect(replay.executions).toEqual([expect.objectContaining({ result: 'executed' })]);
    expect(test.client.calls).toHaveLength(2);
    expect(test.journal.records().filter((record) => record.kind === 'action.intent')).toHaveLength(1);
  });

  it('does not write when the candidate changes at the final re-observation or the binding scope is stale', async () => {
    const changed = await fixture();
    let calls = 0;
    const changedResult = await composer({
      observe: async () => (calls++ < 2 ? observation('head-1') : observation('head-2')),
      bindings: [changed.binding], admission: changed.admission, resolver: changed.resolver,
    }).synchronize();
    expect(changedResult.executions).toEqual([expect.objectContaining({ result: 'skipped', reason: 'signed_action_missing' })]);
    expect(changed.client.calls).toHaveLength(0);

    const stale = await fixture();
    const staleBinding = { ...stale.binding, scope: { ...scope, expectedRevision: 'old-head' } };
    const staleResult = await composer({ observe: async () => observation(), bindings: [staleBinding], admission: stale.admission, resolver: stale.resolver }).synchronize();
    expect(staleResult.executions).toEqual([expect.objectContaining({ result: 'skipped', reason: 'signed_action_missing' })]);
    expect(stale.client.calls).toHaveLength(0);
  });

  it('keeps a revoked current authority from reaching Jira even with a valid pre-existing grant', async () => {
    const test = await fixture();
    test.authority({ actionAllowed: false, revoked: true });
    const result = await composer({ observe: async () => observation(), bindings: [test.binding], admission: test.admission, resolver: test.resolver }).synchronize();

    expect(result.executions).toEqual([expect.objectContaining({ result: 'skipped', reason: 'authority_not_current' })]);
    expect(test.client.calls).toHaveLength(0);
  });

  it('rejects a substituted PR identity even when its commit and ticket are unchanged', async () => {
    const test = await fixture();
    let reads = 0;
    const result = await composer({ observe: async () => {
      const current = observation();
      if (++reads > 2) current.deliveries[0].pullRequest.number = 8;
      return current;
    }, bindings: [test.binding], admission: test.admission, resolver: test.resolver }).synchronize();
    expect(result.executions).toEqual([expect.objectContaining({ result: 'skipped' })]);
    expect(test.client.calls).toEqual([]);
  });

  it('fails closed when the existing signer returns a request for a different retained identity', async () => {
    const test = await fixture();
    const mismatched = { ...test.binding, signer: { sign: async (request) => ({ ...request, requestedAt: '2026-09-11T00:00:01.000Z' }) } };
    const result = await composer({ observe: async () => observation(), bindings: [mismatched], admission: test.admission, resolver: test.resolver }).synchronize();
    expect(result.executions).toEqual([expect.objectContaining({ result: 'skipped', reason: 'signed_action_missing' })]);
    expect(test.client.calls).toHaveLength(0);
  });

  it('returns observation unavailability and an explicit skipped transition instead of a quiet empty cycle', async () => {
    const test = await fixture();
    const result = await composer({
      observe: async () => ({ ...observation(), unavailable: [{ ticketKey: 'OPS-2', reason: 'sprint_observation_unavailable' }] }),
      bindings: [], admission: test.admission, resolver: test.resolver,
    }).synchronize();
    expect(result.unavailable).toEqual([{ ticketKey: 'OPS-2', reason: 'sprint_observation_unavailable' }]);
    expect(result.executions).toEqual([expect.objectContaining({ ticketKey: 'OPS-1', result: 'skipped', reason: 'signed_action_missing' })]);
    expect(test.client.calls).toHaveLength(0);
  });

  it('blocks the Jira write when the candidate changes after Jira reconciliation', async () => {
    const test = await fixture();
    let reads = 0;
    const value = composer({ observe: async () => observation(++reads > 3 ? 'head-2' : 'head-1'), bindings: [test.binding], admission: test.admission, resolver: test.resolver });
    test.setBeforeWrite(value.validateBeforeWrite.bind(value));
    const result = await value.synchronize();
    expect(result.executions).toEqual([expect.objectContaining({ result: 'skipped', reason: 'blocked' })]);
    expect(test.client.calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('serializes concurrent synchronizations and clears a completed resolver when no transition remains', async () => {
    const test = await fixture();
    const value = composer({ observe: async () => observation(), bindings: [test.binding], admission: test.admission, resolver: test.resolver });
    const [first, second] = await Promise.all([value.synchronize(), value.synchronize()]);
    expect([first.executions[0].result, second.executions[0].result]).toEqual(['executed', 'executed']);
    expect(test.client.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(test.journal.records().filter((record) => record.kind === 'action.intent')).toHaveLength(1);

    const idle = composer({ observe: async () => ({ ...observation(), deliveries: [{ ...observation().deliveries[0], ticket: { ...observation().deliveries[0].ticket, status: 'Human Hold' } }] }), bindings: [test.binding], admission: test.admission, resolver: test.resolver });
    await idle.synchronize();
    expect(test.resolver.operationFor({ request: test.signedRequests[0], grant: {}, operationId: 'stale' })).toBeUndefined();
  });

  it('does not blindly retry an uncertain prior effect after controller restart', async () => {
    const firstHttp = http([{ status: 200, body: { fields: { status: { name: 'In Review' } } } }, new Error('connection lost after submit')]);
    const first = await fixture({ client: firstHttp });
    const firstResult = await composer({ observe: async () => observation(), bindings: [first.binding], admission: first.admission, resolver: first.resolver }).synchronize();
    expect(firstResult.executions).toEqual([expect.objectContaining({ result: 'skipped', reason: 'uncertain' })]);
    expect(firstHttp.calls.map((call) => call.method)).toEqual(['GET', 'POST']);

    const restartedHttp = http();
    const restartedResolver = new DeliveryTransitionOperationResolver();
    const restartedAdmission = new ControllerActionAdmission({
      journal: first.journal, grantVault: first.vault,
      authority: { current: async () => ({ runId: 'delivery-run', scope: structuredClone(scope), authorityEpoch: 3, revoked: false, actionAllowed: true }) },
      executor: new JiraRestActionExecutor({ client: restartedHttp, operationFor: (action) => restartedResolver.operationFor(action), transitions: restartedResolver.transitions }),
      clock: { now: () => new Date('2026-09-11T00:02:00.000Z') },
      random: { id: () => 'restart-record', secret: () => 'unused-restart-private-action-verifier-secret' },
    });
    const retried = await composer({ observe: async () => observation(), bindings: [first.binding], admission: restartedAdmission, resolver: restartedResolver }).synchronize();
    expect(retried.executions).toEqual([expect.objectContaining({ result: 'skipped', reason: 'exact_duplicate' })]);
    expect(restartedHttp.calls).toHaveLength(0);
  });
});
