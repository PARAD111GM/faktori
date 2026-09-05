import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitHubDraftPullRequestExecutor, GitHubIssueLinkExecutor, GitHubRepositoryObserver, InMemoryGitHubPublicationStore, probeInstalledGh, spawnGit } from '../../src/integrations/github.ts';

const target = Object.freeze({ repository: 'example/factory-fixture', branch: 'faktori/run-7', baseRefName: 'develop', baseRevision: 'base-commit-c0', expectedRevision: 'c0ffee', publisherRemote: 'controller-owned-only', publisherWorktree: '/controller-owned' });

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
      publications.push({ number: 42, url: 'https://github.example/example/factory-fixture/pull/42', headRefName: target.branch, headRefOid: target.expectedRevision, baseRefName: target.baseRefName, isDraft: true });
      return { exitCode: 0, stdout: 'https://github.example/example/factory-fixture/pull/42\n', stderr: '' };
    }
    if (argv[0] === 'pr' && argv[1] === 'list') return { exitCode: 0, stdout: JSON.stringify(publications), stderr: '' };
    return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
  };
  const gitCalls = [];
  const git = async (argv) => {
    gitCalls.push(argv);
    if (argv.at(-3) === 'rev-parse') return { exitCode: 0, stdout: `${target.expectedRevision}\n`, stderr: '' };
    if (argv.at(-3) === 'push') return { exitCode: 0, stdout: '', stderr: '' };
    return { exitCode: 1, stdout: '', stderr: 'unexpected git command' };
  };
  return { calls, gitCalls, publications, command, git };
}

describe('controller-owned GitHub draft publication', () => {
  it('uses only controller-selected gh arguments, rechecks at the effect boundary, and stores an exact draft receipt', async () => {
    const test = fixture();
    let guarded = 0;
    const executor = new GitHubDraftPullRequestExecutor(target, test.command, new InMemoryGitHubPublicationStore(), test.git);
    const result = await executor.execute(action(), async () => { guarded += 1; });

    expect(result).toEqual({ outcome: 'completed', detail: expect.stringContaining('draft_pr:') });
    expect(guarded).toBe(3);
    const create = test.calls.find((argv) => argv[1] === 'create');
    expect(create).toEqual(expect.arrayContaining(['--repo', target.repository, '--head', target.branch, '--base', target.baseRefName, '--draft']));
    expect(create).not.toContain(target.baseRevision);
    expect(create).not.toContain(target.publisherRemote);
    expect(test.calls.filter((argv) => argv[1] === 'create')).toHaveLength(1);
    expect(test.gitCalls[0]).toEqual(expect.arrayContaining(['-C', target.publisherWorktree, 'rev-parse', '--verify', `${target.expectedRevision}^{commit}`]));
    expect(test.gitCalls[1]).toEqual(expect.arrayContaining(['push', target.publisherRemote, `${target.expectedRevision}:refs/heads/${target.branch}`]));
  });

  it('reconciles a crash after the provider effect before retrying instead of creating a second pull request', async () => {
    const test = fixture();
    const failingStore = { find: async () => undefined, save: async () => { throw new Error('controller_crashed_after_remote_effect'); } };
    const first = new GitHubDraftPullRequestExecutor(target, test.command, failingStore, test.git);
    await expect(first.execute(action(), async () => {})).rejects.toThrow('controller_crashed_after_remote_effect');

    const recoveredStore = new InMemoryGitHubPublicationStore();
    const recovered = new GitHubDraftPullRequestExecutor(target, test.command, recoveredStore, test.git);
    const result = await recovered.execute(action(), async () => { throw new Error('must_not_effect'); });

    expect(result).toEqual({ outcome: 'safe_noop', detail: expect.stringContaining('reconciled_draft_pr:') });
    expect(test.publications).toHaveLength(1);
    expect(test.calls.filter((argv) => argv[1] === 'create')).toHaveLength(1);
  });

  it('fails closed for superseded scope or a remotely observed wrong revision', async () => {
    const test = fixture();
    const executor = new GitHubDraftPullRequestExecutor(target, test.command, new InMemoryGitHubPublicationStore(), test.git);
    const changed = action('operation-other', { request: { actionId: 'publish-7', scope: { ...action().request.scope, expectedRevision: 'new-head' } } });
    await expect(executor.execute(changed, async () => {})).resolves.toEqual({ outcome: 'blocked', detail: 'publisher_target_or_revision_mismatch' });

    test.publications.push({ number: 9, url: 'https://github.example/pr/9', headRefName: target.branch, headRefOid: 'wrong', baseRefName: target.baseRefName, isDraft: true });
    await expect(executor.execute(action('operation-wrong'), async () => {})).resolves.toEqual({ outcome: 'uncertain', detail: 'remote_publication_does_not_match_admitted_target' });
    expect(test.calls.filter((argv) => argv[1] === 'create')).toHaveLength(0);
  });

  it('observes the installed gh binary without authenticating or calling an external resource', async () => {
    await expect(probeInstalledGh()).resolves.toMatch(/^gh version \d+/);
  });

  it('uses a controller-owned bare remote and disables untrusted hooks/config before publishing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'faktori-git-fixture-'));
    const remote = join(root, 'publisher.git');
    const worktree = join(root, 'controller');
    const hookMarker = join(root, 'untrusted-hook-ran');
    runGit(['init', '--bare', remote]);
    runGit(['init', worktree]);
    runGit(['-C', worktree, 'config', 'user.email', 'controller@example.test']);
    runGit(['-C', worktree, 'config', 'user.name', 'Controller']);
    writeFileSync(join(worktree, 'README.md'), 'trusted object\n');
    runGit(['-C', worktree, 'add', 'README.md']);
    runGit(['-C', worktree, 'commit', '-m', 'trusted object']);
    const expectedRevision = runGit(['-C', worktree, 'rev-parse', 'HEAD']).trim();
    const hooks = join(worktree, '.git', 'untrusted-hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\necho ran > '${hookMarker}'\n`);
    chmodSync(join(hooks, 'pre-push'), 0o755);
    runGit(['-C', worktree, 'config', 'core.hooksPath', hooks]);

    const publications = [];
    const gh = async (argv) => {
      if (argv[1] === 'list') return { exitCode: 0, stdout: JSON.stringify(publications), stderr: '' };
      if (argv[1] === 'create') { publications.push({ number: 3, url: 'https://github.example/pr/3', headRefName: 'faktori/controlled', headRefOid: expectedRevision, baseRefName: 'develop', isDraft: true }); return { exitCode: 0, stdout: 'https://github.example/pr/3\n', stderr: '' }; }
      return { exitCode: 1, stdout: '', stderr: 'unexpected gh command' };
    };
    const controlled = { ...target, branch: 'faktori/controlled', expectedRevision, publisherRemote: remote, publisherWorktree: worktree };
    const controlledAction = action('controlled-operation', { request: { actionId: 'publish-controlled', scope: { ...action().request.scope, branch: controlled.branch, expectedRevision, baseRevision: controlled.baseRevision } } });
    const result = await new GitHubDraftPullRequestExecutor(controlled, gh, new InMemoryGitHubPublicationStore(), spawnGit).execute(controlledAction, async () => {});

    expect(result.outcome).toBe('completed');
    expect(runGit(['--git-dir', remote, 'rev-parse', `refs/heads/${controlled.branch}`]).trim()).toBe(expectedRevision);
    expect(existsSync(hookMarker)).toBe(false);
  });

  it('blocks when the trusted local object is not exactly the admitted revision', async () => {
    const test = fixture();
    const git = async (argv) => argv.includes('rev-parse')
      ? { exitCode: 0, stdout: 'different-commit\n', stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' };
    await expect(new GitHubDraftPullRequestExecutor(target, test.command, new InMemoryGitHubPublicationStore(), git).execute(action(), async () => {})).resolves.toEqual({ outcome: 'blocked', detail: 'trusted_local_expected_revision_missing_or_mismatched' });
    expect(test.calls.some((argv) => argv[1] === 'create')).toBe(false);
  });

  it('registers only the configured repository and observes realistic check-run states for its exact revision', async () => {
    const calls = [];
    const observer = new GitHubRepositoryObserver(async (argv) => {
      calls.push(argv);
      if (argv[0] === 'repo') return { exitCode: 0, stdout: JSON.stringify({ nameWithOwner: target.repository, viewerPermission: 'WRITE', isPrivate: true }), stderr: '' };
      if (argv[1].endsWith('/status')) return { exitCode: 0, stdout: JSON.stringify([{ statuses: [{ context: 'legacy-security', state: 'failure', target_url: null }] }]), stderr: '' };
      return { exitCode: 0, stdout: JSON.stringify([{ check_runs: [
        { name: 'unit', head_sha: target.expectedRevision, status: 'completed', conclusion: 'success', details_url: 'https://ci.example/1' },
        { name: 'deploy', head_sha: target.expectedRevision, status: 'in_progress', conclusion: null, details_url: null },
        { name: 'lint', head_sha: target.expectedRevision, status: 'completed', conclusion: 'skipped', details_url: null },
      ] }]), stderr: '' };
    });
    await expect(observer.register(target.repository)).resolves.toEqual({ repository: target.repository, viewerPermission: 'WRITE', private: true });
    await expect(observer.observeChecks(target)).resolves.toEqual([{ name: 'unit', state: 'SUCCESS', link: 'https://ci.example/1' }, { name: 'deploy', state: 'PENDING' }, { name: 'lint', state: 'SKIPPING' }, { name: 'legacy-security', state: 'FAILURE' }]);
    expect(calls[1]).toEqual(expect.arrayContaining(['api', expect.stringContaining(`repos/${target.repository}/commits/${target.expectedRevision}/check-runs`)]));
  });

  it('rechecks authority immediately before push and PR creation', async () => {
    const test = fixture();
    const executor = new GitHubDraftPullRequestExecutor(target, test.command, new InMemoryGitHubPublicationStore(), test.git);
    let checks = 0;
    await expect(executor.execute(action(), async () => { checks += 1; if (checks === 2) throw new Error('authority_changed_before_effect'); })).rejects.toThrow('authority_changed_before_effect');
    expect(test.gitCalls.some((argv) => argv.includes('push'))).toBe(false);
    expect(test.calls.some((argv) => argv[1] === 'create')).toBe(false);
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

function runGit(argv) {
  return execFileSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
