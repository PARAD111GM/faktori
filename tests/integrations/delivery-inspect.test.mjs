import { describe, expect, it } from 'vitest';

import { inspectDeliveryConnections, parseDeliveryConnections } from '../../src/integrations/delivery-inspect.ts';

const configuration = { format: 'faktori.delivery-connections/v1', jira: { baseUrl: 'https://jira.example.test', boardId: '7', authorizationEnv: 'JIRA_AUTH' }, connections: [{ ticketKey: 'OPS-1', repository: 'acme/repo', pullRequest: 3 }] };

describe('read-only delivery inspection', () => {
  it('strictly accepts only credential-free configured identities', () => {
    expect(parseDeliveryConnections(configuration)).toEqual(configuration);
    expect(() => parseDeliveryConnections({ ...configuration, jira: { ...configuration.jira, authorization: 'secret' } })).toThrow('unsupported fields');
    expect(() => parseDeliveryConnections({ ...configuration, connections: [...configuration.connections, { ...configuration.connections[0] }] })).toThrow('unique PR identity');
  });

  it('observes bound sprint, live per-ticket transitions, PR head/check facts, and leaves review/deployment unknown', async () => {
    const jiraRequests = [];
    const fetcher = async (url) => {
      const value = String(url); jiraRequests.push(value);
      if (value.includes('/board/7/sprint')) return new Response(JSON.stringify({ values: [{ id: 8 }] }), { status: 200 });
      if (value.includes('/sprint/8/issue')) return new Response(JSON.stringify({ total: 1, issues: [{ key: 'OPS-1', fields: { status: { name: 'To Do', statusCategory: { key: 'new' } }, issuelinks: [] } }] }), { status: 200 });
      return new Response(JSON.stringify({ transitions: [{ id: '71', name: 'Queue deploy', to: { name: 'Ready For Deployment' } }] }), { status: 200 });
    };
    const calls = [];
    const gh = async (argv) => {
      calls.push(argv);
      if (argv[0] === 'pr') return { exitCode: 0, stdout: JSON.stringify({ state: 'OPEN', mergedAt: null, mergeCommit: null, headRefOid: 'head-1' }), stderr: '' };
      if (argv[1]?.includes('/check-runs')) return { exitCode: 0, stdout: JSON.stringify([{ check_runs: [{ name: 'verify', head_sha: 'head-1', status: 'completed', conclusion: 'success' }] }]), stderr: '' };
      return { exitCode: 0, stdout: JSON.stringify([{ statuses: [] }]), stderr: '' };
    };
    const result = await inspectDeliveryConnections(configuration, { environment: { JIRA_AUTH: 'Bearer secret-value' }, fetcher, gh });
    expect(result).toMatchObject({ sprint: { state: 'available', sprintId: '8' }, transitionsByTicket: { 'OPS-1': [{ id: '71', targetStatus: 'Ready For Deployment' }] }, pullRequests: [expect.objectContaining({ ticketKey: 'OPS-1', headCommit: 'head-1', independentReview: 'unknown', deployment: 'unknown' })] });
    expect(jiraRequests).toHaveLength(3);
    expect(calls.every((argv) => !['create', 'merge', 'edit'].includes(argv[1]))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it('keeps Jira authorization and unavailable GitHub observation visibly unknown', async () => {
    const result = await inspectDeliveryConnections(configuration, { environment: {}, gh: async () => ({ exitCode: 1, stdout: '', stderr: 'private token detail' }) });
    expect(result).toEqual(expect.objectContaining({ sprint: { state: 'unknown', reason: 'jira_authorization_unavailable' }, pullRequests: [expect.objectContaining({ state: 'unknown', independentReview: 'unknown', deployment: 'unknown' })] }));
    expect(JSON.stringify(result)).not.toContain('private token detail');
  });
});
