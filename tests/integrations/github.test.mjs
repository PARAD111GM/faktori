import { describe, expect, it } from 'vitest';

import { GitHubDraftPullRequestExecutor, GitHubIssueLinkExecutor, GitHubRepositoryObserver, InMemoryGitHubPublicationStore, probeInstalledGh } from '../../src/integrations/github.ts';

const target = Object.freeze({ repository: 'example/factory-fixture', branch: 'faktori/run-7', baseRevision: 'main', expectedRevision: 'c0ffee', publisherRemote: 'controller-owned-only' });

function action(operationId = 'operation-7', overrides = {}) {
  return {
    operationId,
    request: { actionId: 'publish-7', scope: { kind: 'github.draft-pr', allowedOperation: 'github.draft-pr', repository: target.repository, branch: target.branch, baseRevision: target.baseRevision, expectedRevision: target.expectedRevision, scopeRevision: 'scope@1' } },
    grant: {},
    ...overrides,
  };
}

function fixture() {
  const publications = [];
  const calls = [];
  const command = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'pr' && argv[1] === 'create') {
      publications.push({ number: 42, url: 'https://github.example/example/factory-fixture/pull/42', headRefName: target.branch, headRefOid: target.expectedRevision, baseRefName: target.baseRevision, isDraft: true });
      return { exitCode: 0, stdout: 'https://github.example/example/factory-fixture/pull/42\n', stderr: '' };
    }
    if (argv[0] === 'pr' && argv[1] === 'list') return { exitCode: 0, stdout: JSON.stringify(publications), stderr: '' };
    return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { calls, publications, command };
}

describe('controller-owned GitHub draft publication', () => {
  it('uses only controller-selected gh arguments, rechecks at the effect boundary, and stores an exact draft receipt', async () => {
    const test = fixture();
    let guarded = 0;
    const executor = new GitHubDraftPullRequestExecutor(target, test.command, new InMemoryGitHubPublicationStore());
    const result = await executor.execute(action(), async () => { guarded += 1; });

    expect(result).toEqual({ outcome: 'completed', detail: expect.stringContaining('draft_pr:') });
    expect(guarded).toBe(1);
    const create = test.calls.find((argv) => argv[1] === 'create');
    expect(create).toEqual(expect.arrayContaining(['--repo', target.repository, '--head', target.branch, '--base', target.baseRevision, '--draft']));
    expect(create).not.toContain(target.publisherRemote);
    expect(test.calls.filter((argv) => argv[1] === 'create')).toHaveLength(1);
  });

  it('reconciles a crash after the provider effect before retrying instead of creating a second pull request', async () => {
    const test = fixture();
    const failingStore = { find: async () => undefined, save: async () => { throw new Error('controller_crashed_after_remote_effect'); } };
    const first = new GitHubDraftPullRequestExecutor(target, test.command, failingStore);
    await expect(first.execute(action(), async () => {})).rejects.toThrow('controller_crashed_after_remote_effect');

    const recoveredStore = new InMemoryGitHubPublicationStore();
    const recovered = new GitHubDraftPullRequestExecutor(target, test.command, recoveredStore);
    const result = await recovered.execute(action(), async () => { throw new Error('must_not_effect'); });

    expect(result).toEqual({ outcome: 'safe_noop', detail: expect.stringContaining('reconciled_draft_pr:') });
    expect(test.publications).toHaveLength(1);
    expect(test.calls.filter((argv) => argv[1] === 'create')).toHaveLength(1);
  });

  it('fails closed for superseded scope or a remotely observed wrong revision', async () => {
    const test = fixture();
    const executor = new GitHubDraftPullRequestExecutor(target, test.command, new InMemoryGitHubPublicationStore());
    const changed = action('operation-other', { request: { actionId: 'publish-7', scope: { ...action().request.scope, expectedRevision: 'new-head' } } });
    await expect(executor.execute(changed, async () => {})).resolves.toEqual({ outcome: 'blocked', detail: 'publisher_target_or_revision_mismatch' });

    test.publications.push({ number: 9, url: 'https://github.example/pr/9', headRefName: target.branch, headRefOid: 'wrong', baseRefName: target.baseRevision, isDraft: true });
    await expect(executor.execute(action('operation-wrong'), async () => {})).resolves.toEqual({ outcome: 'uncertain', detail: 'remote_publication_does_not_match_admitted_target' });
    expect(test.calls.filter((argv) => argv[1] === 'create')).toHaveLength(0);
  });

  it('observes the installed gh binary without authenticating or calling an external resource', async () => {
    await expect(probeInstalledGh()).resolves.toMatch(/^gh version \d+/);
  });

  it('registers only the configured repository and observes checks for its exact revision', async () => {
    const calls = [];
    const observer = new GitHubRepositoryObserver(async (argv) => {
      calls.push(argv);
      if (argv[0] === 'repo') return { exitCode: 0, stdout: JSON.stringify({ nameWithOwner: target.repository, viewerPermission: 'WRITE', isPrivate: true }), stderr: '' };
      return { exitCode: 0, stdout: JSON.stringify([{ name: 'unit', state: 'SUCCESS', link: 'https://ci.example/1' }]), stderr: '' };
    });
    await expect(observer.register(target.repository)).resolves.toEqual({ repository: target.repository, viewerPermission: 'WRITE', private: true });
    await expect(observer.observeChecks(target)).resolves.toEqual([{ name: 'unit', state: 'SUCCESS', link: 'https://ci.example/1' }]);
    expect(calls[1]).toEqual(expect.arrayContaining(['pr', 'checks', target.expectedRevision, '--repo', target.repository]));
  });

  it('reconciles controller-owned issue linkage and observes merge state without attempting a merge', async () => {
    const calls = []; let issues = [];
    const command = async (argv) => {
      calls.push(argv);
      if (argv[0] === 'issue' && argv[1] === 'list') return { exitCode: 0, stdout: JSON.stringify(issues), stderr: '' };
      if (argv[0] === 'issue' && argv[1] === 'create') { issues = [{ url: 'https://github.example/issues/1' }]; return { exitCode: 0, stdout: 'https://github.example/issues/1', stderr: '' }; }
      return { exitCode: 0, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-05T00:00:00Z', mergeCommit: { oid: 'merged-head' } }), stderr: '' };
    };
    const linker = new GitHubIssueLinkExecutor(command, () => ({ repository: target.repository, title: 'Linked work', body: 'controller configured' }));
    const issueAction = action('issue-operation', { request: { actionId: 'link-1', scope: { ...action().request.scope, kind: 'github.issue', allowedOperation: 'github.issue' } } });
    await expect(linker.execute(issueAction, async () => {})).resolves.toEqual({ outcome: 'completed', detail: 'issue:https://github.example/issues/1' });
    await expect(linker.execute(issueAction, async () => { throw new Error('second create forbidden'); })).resolves.toEqual({ outcome: 'safe_noop', detail: 'reconciled_issue:https://github.example/issues/1' });
    await expect(new GitHubRepositoryObserver(command).observeMerge(target.repository, 1)).resolves.toEqual({ merged: true, mergeCommit: 'merged-head' });
    expect(calls.some((argv) => argv[0] === 'pr' && argv[1] === 'merge')).toBe(false);
  });
});
