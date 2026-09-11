import { describe, expect, it, vi } from 'vitest';

import { JiraObserver, parseJiraSources } from '../../src/console/jira-observer.ts';

const source = {
  id: 'twinzy-board',
  baseUrl: 'https://example.atlassian.net',
  projectKey: 'TWZ',
  productId: 'twinzy',
  podId: 'creator',
  authorizationEnv: 'TWINZY_JIRA_AUTHORIZATION',
  pollIntervalMs: 15_000,
};

function jiraIssue(key, status, category = 'indeterminate', overrides = {}) {
  return {
    key,
    fields: {
      summary: `${key} summary`,
      status: { name: status, statusCategory: { key: category } },
      assignee: { displayName: 'Nathan' },
      updated: '2026-09-09T12:00:00.000Z',
      description: 'must never cross the observer boundary',
      ...overrides,
    },
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('Jira source configuration', () => {
  it('accepts only bounded owner configuration and resolves product and pod references', () => {
    const catalog = {
      products: [{ id: 'twinzy' }],
      pods: [{ id: 'creator', productId: 'twinzy' }],
    };
    expect(parseJiraSources([source], catalog)).toEqual([source]);
    expect(() => parseJiraSources([{ ...source, token: 'secret' }], catalog)).toThrow(/only/);
    expect(() => parseJiraSources([{ ...source, baseUrl: 'https://example.atlassian.net/jira' }], catalog)).toThrow(/origin/);
    expect(() => parseJiraSources([{ ...source, baseUrl: 'https://user:secret@example.atlassian.net' }], catalog)).toThrow(/origin/);
    expect(() => parseJiraSources([{ ...source, baseUrl: 'http://example.atlassian.net' }], catalog)).toThrow(/HTTPS/);
    expect(() => parseJiraSources([{ ...source, projectKey: 'TWZ" OR project = SECRET' }], catalog)).toThrow(/projectKey/);
    expect(() => parseJiraSources([{ ...source, authorizationEnv: 'TOKEN=value' }], catalog)).toThrow(/environment variable name/);
    expect(() => parseJiraSources([{ ...source, pollIntervalMs: 14_999 }], catalog)).toThrow(/15000/);
    expect(parseJiraSources([{ ...source, boardId: '42' }], catalog)).toEqual([{ ...source, boardId: '42' }]);
    expect(() => parseJiraSources([{ ...source, boardId: '0' }], catalog)).toThrow(/board ID/);
    expect(() => parseJiraSources([{ ...source, podId: 'other' }], catalog)).toThrow(/configured pod/);
    expect(() => parseJiraSources([source, { ...source }], catalog)).toThrow(/unique/);
  });
});

describe('Jira observer', () => {
  it('pages enhanced search within a fixed project and projects only bounded safe issue fields', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ issues: [jiraIssue('TWZ-2', 'In Progress')], nextPageToken: 'next-token', isLast: false }))
      .mockResolvedValueOnce(jsonResponse({ issues: [jiraIssue('TWZ-1', 'Done', 'done', { assignee: null })], isLast: true }));
    const observer = new JiraObserver([source], {
      fetcher,
      now: () => new Date('2026-09-09T13:00:00.000Z'),
      environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer server-only-secret' },
    });

    expect(observer.snapshot()[0]).toMatchObject({ status: 'unavailable', message: 'Not synced yet.', issues: [] });
    await observer.refresh();

    expect(fetcher).toHaveBeenCalledTimes(3);
    const [firstUrl, firstOptions] = fetcher.mock.calls[0];
    const first = new URL(firstUrl);
    expect(first.pathname).toBe('/rest/api/3/search/jql');
    expect(first.searchParams.get('jql')).toBe('project = "TWZ" ORDER BY updated DESC');
    expect(first.searchParams.get('fields')).toBe('summary,status,assignee,updated');
    expect(first.searchParams.get('maxResults')).toBe('100');
    expect(firstOptions).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Accept: 'application/json', Authorization: 'Bearer server-only-secret' } });
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('nextPageToken')).toBe('next-token');

    expect(observer.snapshot()).toEqual([{
      id: 'twinzy-board', projectKey: 'TWZ', productId: 'twinzy', podId: 'creator',
      status: 'connected', lastSyncedAt: '2026-09-09T13:00:00.000Z', truncated: false,
      columnsMessage: 'Jira board columns are temporarily unavailable; issues remain available by status. Check Jira Software board read permission or configure boardId.',
      issues: [
        { key: 'TWZ-2', summary: 'TWZ-2 summary', status: 'In Progress', statusCategory: 'indeterminate', assignee: 'Nathan', updatedAt: '2026-09-09T12:00:00.000Z', url: 'https://example.atlassian.net/browse/TWZ-2' },
        { key: 'TWZ-1', summary: 'TWZ-1 summary', status: 'Done', statusCategory: 'done', updatedAt: '2026-09-09T12:00:00.000Z', url: 'https://example.atlassian.net/browse/TWZ-1' },
      ],
      changes: [{ id: expect.any(String), at: '2026-09-09T13:00:00.000Z', summary: 'Initial Jira sync: 2 issues.' }],
    }]);
    expect(JSON.stringify(observer.snapshot())).not.toMatch(/secret|description|authorizationEnv|Bearer/i);
  });

  it('uses the configured Jira column order, groups status IDs, and preserves empty columns', async () => {
    const configured = { ...source, boardId: '42' };
    const fetcher = vi.fn(async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname === '/rest/api/3/search/jql') return jsonResponse({
        issues: [
          jiraIssue('TWZ-1', 'To Do', 'new', { status: { id: '10', name: 'To Do', statusCategory: { key: 'new' } } }),
          jiraIssue('TWZ-2', 'In Progress', 'indeterminate', { status: { id: '20', name: 'In Progress', statusCategory: { key: 'indeterminate' } } }),
        ], isLast: true,
      });
      expect(url.pathname).toBe('/rest/agile/1.0/board/42/configuration');
      return jsonResponse({ columnConfig: { columns: [
        { name: 'Ready', statuses: [{ id: '10' }, { id: '11' }] },
        { name: 'Building', statuses: [{ id: '20' }, { id: '21' }] },
        { name: 'Released', statuses: [] },
      ] } });
    });
    const observer = new JiraObserver([configured], { fetcher, environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' } });
    await observer.refresh();
    const board = observer.snapshot()[0];
    expect(board.columns).toEqual([
      { name: 'Ready', statusIds: ['10', '11'] },
      { name: 'Building', statusIds: ['20', '21'] },
      { name: 'Released', statusIds: [] },
    ]);
    expect(board.columnsMessage).toBeUndefined();
    expect(board.issues.map(issue => issue.statusId)).toEqual(['10', '20']);
  });

  it('discovers configuration only for one matching board and keeps issues with a safe ambiguity message', async () => {
    const fetcher = vi.fn(async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname === '/rest/api/3/search/jql') return jsonResponse({ issues: [jiraIssue('TWZ-1', 'To Do', 'new')], isLast: true });
      expect(url.pathname).toBe('/rest/agile/1.0/board');
      expect(url.searchParams.get('projectKeyOrId')).toBe('TWZ');
      return jsonResponse({ values: [{ id: 7 }, { id: 8 }], isLast: true });
    });
    const observer = new JiraObserver([source], { fetcher, environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' } });
    await observer.refresh();
    expect(observer.snapshot()[0]).toMatchObject({ status: 'connected', issues: [expect.objectContaining({ key: 'TWZ-1' })] });
    expect(observer.snapshot()[0].columns).toBeUndefined();
    expect(observer.snapshot()[0].columnsMessage).toMatch(/multiple boards may match TWZ.*Configure boardId/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains prior configured columns as stale when configuration retrieval fails without failing issue sync', async () => {
    let now = new Date('2026-09-09T13:00:00.000Z');
    let configurationFails = false;
    const fetcher = vi.fn(async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname === '/rest/api/3/search/jql') return jsonResponse({ issues: [jiraIssue('TWZ-1', configurationFails ? 'In Progress' : 'To Do', configurationFails ? 'indeterminate' : 'new')], isLast: true });
      if (configurationFails) throw new Error('Bearer hidden provider response');
      return jsonResponse({ columnConfig: { columns: [{ name: 'To do', statuses: [] }] } });
    });
    const observer = new JiraObserver([{ ...source, boardId: '42' }], { fetcher, now: () => now, environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' } });
    await observer.refresh();
    configurationFails = true;
    now = new Date('2026-09-09T13:00:15.000Z');
    await observer.refresh();
    const board = observer.snapshot()[0];
    expect(board).toMatchObject({ status: 'connected', columns: [{ name: 'To do', statusIds: [] }], columnsStale: true, issues: [expect.objectContaining({ status: 'In Progress' })] });
    expect(board.columnsMessage).toMatch(/could not be refreshed.*retained.*stale/);
    expect(JSON.stringify(board)).not.toMatch(/hidden|Bearer|provider response/);
  });

  it('records each actual status transition once and respects per-source polling TTL', async () => {
    let now = new Date('2026-09-09T13:00:00.000Z');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ issues: [jiraIssue('TWZ-1', 'To Do', 'new')], isLast: true }))
      .mockResolvedValueOnce(jsonResponse({ issues: [jiraIssue('TWZ-1', 'In Progress')], isLast: true }))
      .mockResolvedValueOnce(jsonResponse({ issues: [jiraIssue('TWZ-1', 'In Progress')], isLast: true }));
    const observer = new JiraObserver([source], {
      fetcher, now: () => now, environment: { TWINZY_JIRA_AUTHORIZATION: 'Basic hidden' },
    });
    await observer.refresh();
    now = new Date('2026-09-09T13:00:10.000Z');
    await observer.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    now = new Date('2026-09-09T13:00:15.000Z');
    await observer.refresh();
    expect(observer.snapshot()[0].changes).toHaveLength(2);
    expect(observer.snapshot()[0].changes[1]).toMatchObject({ summary: 'TWZ-1 moved from To Do to In Progress.', issueKey: 'TWZ-1' });
    now = new Date('2026-09-09T13:00:30.000Z');
    await observer.refresh();
    expect(observer.snapshot()[0].changes).toHaveLength(2);
  });

  it('coalesces overlapping refreshes and does not start a second request', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const fetcher = vi.fn(async () => { await pending; return jsonResponse({ issues: [], isLast: true }); });
    const observer = new JiraObserver([source], { fetcher, environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' } });
    const first = observer.refresh();
    const second = observer.refresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains the last complete board as stale when a later page fails without exposing errors or credentials', async () => {
    let now = new Date('2026-09-09T13:00:00.000Z');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ issues: [jiraIssue('TWZ-1', 'To Do', 'new'), jiraIssue('TWZ-9', 'Done', 'done')], isLast: true }))
      .mockResolvedValueOnce(jsonResponse({ issues: [jiraIssue('TWZ-1', 'In Progress')], nextPageToken: 'page-2', isLast: false }))
      .mockRejectedValueOnce(new Error('Bearer hidden-secret failed at internal.example'));
    const observer = new JiraObserver([source], { fetcher, now: () => now, environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden-secret' } });
    await observer.refresh();
    const complete = observer.snapshot()[0];
    now = new Date('2026-09-09T13:00:15.000Z');
    await observer.refresh();
    const stale = observer.snapshot()[0];
    expect(stale).toMatchObject({ status: 'stale', lastSyncedAt: complete.lastSyncedAt, message: 'Jira sync is temporarily unavailable.' });
    expect(stale.issues).toEqual(complete.issues);
    expect(stale.changes).toEqual(complete.changes);
    expect(JSON.stringify(stale)).not.toMatch(/hidden|internal|Bearer|failed at/i);
  });

  it('keeps initial failures truthfully unavailable and marks the 500 issue cap explicitly', async () => {
    const failed = new JiraObserver([source], { fetcher: vi.fn().mockResolvedValue(new Response('redirect', { status: 302 })), environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' } });
    await failed.refresh();
    expect(failed.snapshot()[0]).toMatchObject({ status: 'unavailable', message: 'Jira sync is temporarily unavailable.', issues: [] });

    let cappedNow = new Date('2026-09-09T13:00:00.000Z');
    const pages = Array.from({ length: 10 }, (_, page) => ({
      issues: Array.from({ length: 100 }, (_, index) => jiraIssue(`TWZ-${page * 100 + index + 1}`, 'To Do', 'new')),
      nextPageToken: `page-${page + 2}`,
      isLast: false,
    }));
    const capped = new JiraObserver([source], { fetcher: vi.fn().mockImplementation(async () => jsonResponse(pages.shift())), now: () => cappedNow, environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' } });
    await capped.refresh();
    expect(capped.snapshot()[0]).toMatchObject({ status: 'connected', truncated: true, message: 'Jira result limit reached; snapshot is incomplete.' });
    expect(capped.snapshot()[0].issues).toHaveLength(500);
    const firstCapped = capped.snapshot()[0];
    cappedNow = new Date('2026-09-09T13:00:15.000Z');
    await capped.refresh();
    expect(capped.snapshot()[0]).toMatchObject({ status: 'stale', lastSyncedAt: firstCapped.lastSyncedAt, truncated: true });
    expect(capped.snapshot()[0].issues).toHaveLength(500);
    expect(capped.snapshot()[0].issues.map((item) => item.key)).toEqual(firstCapped.issues.map((item) => item.key));
  });

  it('bounds empty pagination and never grows or replaces a prior complete snapshot with a truncated poll', async () => {
    const emptyFetcher = vi.fn().mockImplementation(async (_url) => {
      const page = emptyFetcher.mock.calls.length;
      return jsonResponse({ issues: [], nextPageToken: `empty-${page}`, isLast: false });
    });
    const empty = new JiraObserver([source], { fetcher: emptyFetcher, environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' } });
    await empty.refresh();
    expect(emptyFetcher).toHaveBeenCalledTimes(11);
    expect(empty.snapshot()[0]).toMatchObject({ status: 'connected', truncated: true, issues: [] });

    let now = new Date('2026-09-09T13:00:00.000Z');
    const truncatedPages = Array.from({ length: 10 }, (_, page) => ({
      issues: page < 5 ? Array.from({ length: 100 }, (_, index) => jiraIssue(`TWZ-${page * 100 + index + 1}`, 'In Progress')) : [],
      nextPageToken: `page-${page + 1}`,
      isLast: false,
    }));
    let firstSearch = true;
    const fetcher = vi.fn(async (rawUrl) => {
      if (new URL(rawUrl).pathname === '/rest/agile/1.0/board') return jsonResponse({ values: [], isLast: true });
      if (firstSearch) {
        firstSearch = false;
        return jsonResponse({ issues: [jiraIssue('TWZ-999', 'Done', 'done')], isLast: true });
      }
      return jsonResponse(truncatedPages.shift());
    });
    const observer = new JiraObserver([source], { fetcher, now: () => now, environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' } });
    await observer.refresh();
    now = new Date('2026-09-09T13:00:15.000Z');
    await observer.refresh();
    expect(observer.snapshot()[0]).toMatchObject({
      status: 'stale', truncated: true,
      message: 'Jira bounded sync was incomplete; the last complete snapshot was retained.',
      issues: [expect.objectContaining({ key: 'TWZ-999' })],
    });
    expect(observer.snapshot()[0].issues).toHaveLength(1);
  });

  it('reports missing authorization and access denial with fixed actionable messages', async () => {
    const missing = new JiraObserver([source], { fetcher: vi.fn(), environment: {} });
    await missing.refresh();
    expect(missing.snapshot()[0].message).toBe('Jira authorization is not configured in the Console server environment.');

    const denied = new JiraObserver([source], {
      fetcher: vi.fn().mockResolvedValue(new Response('private provider response', { status: 403 })),
      environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' },
    });
    await denied.refresh();
    expect(denied.snapshot()[0].message).toBe('Jira access was denied. Check the server-side authorization and project access.');

    const partial = new JiraObserver([source], {
      fetcher: vi.fn().mockResolvedValue(jsonResponse({ issues: [], isLast: false })),
      environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' },
    });
    await partial.refresh();
    expect(partial.snapshot()[0]).toMatchObject({ status: 'unavailable', issues: [], message: 'Jira sync is temporarily unavailable.' });
  });

  it('rejects a malformed or out-of-project issue as a failed whole poll', async () => {
    const malformedFetcher = vi.fn().mockResolvedValue(jsonResponse({
      issues: [jiraIssue('OTHER-1', 'To Do', 'new')],
      isLast: true,
    }));
    const observer = new JiraObserver([source], {
      fetcher: malformedFetcher,
      environment: { TWINZY_JIRA_AUTHORIZATION: 'Bearer hidden' },
    });
    await observer.refresh();
    expect(observer.snapshot()[0]).toMatchObject({
      status: 'unavailable',
      message: 'Jira sync is temporarily unavailable.',
      issues: [],
      changes: [],
    });
  });
});
