import { describe, expect, it } from 'vitest';

import { JiraRestActionExecutor } from '../../src/integrations/jira.ts';

function action(idempotencyKey = 'idem-1', allowedOperation = 'jira.issue.ensure') {
  return { operationId: 'operation-1', request: { actionId: 'action-1', idempotencyKey, scope: { allowedOperation } }, grant: {} };
}

function client(responses) {
  const calls = [];
  return {
    calls,
    request: async (input) => { calls.push(input); return responses.shift() ?? { status: 204 }; },
  };
}

function executor(http, operation, transitions = { Done: { id: '31', targetStatus: 'Done' } }) {
  return new JiraRestActionExecutor({ client: http, operationFor: () => operation, transitions, authorizationHeader: async () => 'Bearer private-token' });
}

describe('Jira REST controller executor', () => {
  it('maps a project and an issue through controller-only REST writes with a deterministic issue marker', async () => {
    const projectHttp = client([{ status: 404 }, { status: 201 }]);
    const project = await executor(projectHttp, { kind: 'project.ensure', projectKey: 'TWIN', payload: { name: 'Twinzy', projectTypeKey: 'software' } }).execute(action('project-1', 'jira.project.ensure'), async () => {});
    const issueHttp = client([{ status: 200, body: { issues: [] } }, { status: 201 }]);
    const issue = await executor(issueHttp, { kind: 'issue.ensure', projectKey: 'TWIN', issueTypeId: '10001', summary: 'Ship it', labels: ['release'] }).execute(action(), async () => {});

    expect(project.outcome).toBe('completed');
    expect(projectHttp.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(projectHttp.calls[1].body).toMatchObject({ key: 'TWIN', name: 'Twinzy' });
    expect(issue.outcome).toBe('completed');
    expect(issueHttp.calls[1].body.fields.labels).toEqual(['release', expect.stringMatching(/^faktori-[a-f0-9]{24}$/)]);
    expect(issueHttp.calls[1].headers).toMatchObject({ Authorization: 'Bearer private-token', 'X-Faktori-Idempotency-Key': 'idem-1' });
  });

  it('reconciles a recovered issue by its durable idempotency marker without a second external effect', async () => {
    const http = client([{ status: 200, body: { issues: [{ key: 'TWIN-7' }] } }]);
    const result = await executor(http, { kind: 'issue.ensure', projectKey: 'TWIN', issueTypeId: '10001', summary: 'Recovered' }).execute(action('recovered-key'), async () => { throw new Error('must not enter write guard'); });

    expect(result.outcome).toBe('safe_noop');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].path).toContain('project%20%3D%20%22TWIN%22');
  });

  it('uses explicit links, assignments, and configured transitions; it never infers hierarchy', async () => {
    const linkHttp = client([{ status: 200, body: { fields: { issuelinks: [] } } }, { status: 201 }]);
    const assignedHttp = client([{ status: 200, body: { fields: { assignee: { accountId: 'other' } } } }, { status: 204 }]);
    const transitionHttp = client([{ status: 200, body: { fields: { status: { name: 'In Progress' } } } }, { status: 204 }]);

    await executor(linkHttp, { kind: 'issue.link', inwardIssueKey: 'TWIN-1', outwardIssueKey: 'TWIN-2', linkType: 'Blocks' }).execute(action('link', 'jira.issue.link'), async () => {});
    await executor(assignedHttp, { kind: 'issue.assign', issueKey: 'TWIN-1', accountId: 'account-7' }).execute(action('assign', 'jira.issue.assign'), async () => {});
    await executor(transitionHttp, { kind: 'issue.transition', issueKey: 'TWIN-1', transition: 'Done' }).execute(action('transition', 'jira.issue.transition'), async () => {});

    expect(linkHttp.calls[1].body).toEqual({ type: { name: 'Blocks' }, inwardIssue: { key: 'TWIN-1' }, outwardIssue: { key: 'TWIN-2' } });
    expect(assignedHttp.calls[1]).toMatchObject({ method: 'PUT', path: '/rest/api/3/issue/TWIN-1/assignee', body: { accountId: 'account-7' } });
    expect(transitionHttp.calls[1]).toMatchObject({ method: 'POST', path: '/rest/api/3/issue/TWIN-1/transitions', body: { transition: { id: '31' } } });
  });

  it('makes a transition failure visible and terminal, and rejects unconfigured transitions before a write', async () => {
    const failedHttp = client([{ status: 200, body: { fields: { status: { name: 'In Progress' } } } }, { status: 400 }]);
    const failed = await executor(failedHttp, { kind: 'issue.transition', issueKey: 'TWIN-1', transition: 'Done' }).execute(action('failed', 'jira.issue.transition'), async () => {});
    const unknownHttp = client([]);
    const unknown = await executor(unknownHttp, { kind: 'issue.transition', issueKey: 'TWIN-1', transition: 'Missing' }).execute(action('missing', 'jira.issue.transition'), async () => {});

    expect(failed).toEqual({ outcome: 'failed', detail: 'Jira transition Done failed with HTTP 400' });
    expect(failedHttp.calls).toHaveLength(2);
    expect(unknown).toEqual({ outcome: 'failed', detail: 'unconfigured Jira transition: Missing' });
    expect(unknownHttp.calls).toHaveLength(0);
  });

  it('blocks a resolver result whose Jira operation was not covered by the signed controller scope', async () => {
    const http = client([]);
    const result = await executor(http, { kind: 'issue.assign', issueKey: 'TWIN-1', accountId: 'account-7' }).execute(action('mismatch', 'jira.issue.ensure'), async () => {});
    expect(result.outcome).toBe('blocked');
    expect(http.calls).toHaveLength(0);
  });

  it('fails closed on unavailable or ambiguous reconciliation and sends descriptions as Jira ADF', async () => {
    const unavailable = client([{ status: 500 }]);
    const result = await executor(unavailable, { kind: 'issue.ensure', projectKey: 'TWIN', issueTypeId: '10001', summary: 'No write' }).execute(action(), async () => { throw new Error('must not write'); });
    expect(result.outcome).toBe('uncertain');
    expect(unavailable.calls).toHaveLength(1);

    const described = client([{ status: 200, body: { issues: [] } }, { status: 201 }]);
    await executor(described, { kind: 'issue.ensure', projectKey: 'TWIN', issueTypeId: '10001', summary: 'ADF', description: 'safe text' }).execute(action('adf'), async () => {});
    expect(described.calls[1].body.fields.description).toEqual({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'safe text' }] }] });
  });
});
