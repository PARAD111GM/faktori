import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureManagerLoopWorkspaceEvidence } from '../../src/loop/index.ts';
import { parseLoopPublicationRequest, prepareLoopPublicationHandoff, publishLoopPublication } from '../../src/loop/publication.ts';
import { projectLoopDelivery } from '../../src/loop/delivery.ts';
import { spawnGit } from '../../src/integrations/github.ts';

describe('manager-loop publication handoff', () => {
  it('freezes accepted dirty content, maps only that tree to an exact commit, publishes once, and mirrors the receipt', async () => {
    const fixture = await publicationFixture();
    const result = await publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git, now: () => new Date('2026-09-09T12:01:00.000Z') });

    expect(result).toMatchObject({
      format: 'faktori.loop-publication-receipt/v1', status: 'published',
      loop: { loopId: 'loop-one', acceptedEvidenceDigest: fixture.evidence.contentDigest },
      binding: { repository: 'example/factory', expectedRevision: fixture.expectedRevision, reviewedTreeDigest: fixture.handoff.manifest.reviewedTreeDigest },
      pr: { number: 17, url: 'https://github.com/example/factory/pull/17', headRefOid: fixture.expectedRevision, isDraft: true },
    });
    expect(JSON.parse(readFileSync(join(fixture.bundle, 'publication.json'), 'utf8'))).toEqual(result);
    expect(JSON.parse(readFileSync(join(fixture.artifacts, 'publication.json'), 'utf8'))).toEqual(result);
    expect(fixture.calls.filter((argv) => argv[0] === 'pr' && argv[1] === 'create')).toHaveLength(1);
    expect(fixture.gitCalls.find((argv) => argv.includes('push'))).toEqual(expect.arrayContaining([`${fixture.expectedRevision}:refs/heads/faktori/loop-one`]));
    const delivery = projectLoopDelivery(JSON.parse(readFileSync(join(fixture.artifacts, 'report.json'), 'utf8')), result);
    expect(delivery.gates[1]).toEqual({ id: 'publication', label: 'Publication', status: 'passed', evidenceUrl: result.pr.url });
    expect(delivery.nextAction).toEqual({ label: 'Awaiting external review', role: 'reviewer', url: result.pr.url });

    const retry = await publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git, now: () => new Date('2026-09-09T12:02:00.000Z') });
    expect(retry).toMatchObject({ status: 'reconciled', operationId: result.operationId, pr: result.pr });
    expect(fixture.calls.filter((argv) => argv[0] === 'pr' && argv[1] === 'create')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(fixture.artifacts, 'publication.json'), 'utf8'))).toEqual(retry);
  }, 15_000);

  it('reconciles the same remote pull request after an unresolved local receipt and repairs both receipt copies', async () => {
    const fixture = await publicationFixture();
    const first = await publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git });
    const unresolved = { ...first, status: 'intended', pr: undefined, detail: undefined };
    writePrivateJson(join(fixture.bundle, 'publication.json'), unresolved);
    writePrivateJson(join(fixture.artifacts, 'publication.json'), unresolved);
    const creates = fixture.calls.filter((argv) => argv[0] === 'pr' && argv[1] === 'create').length;

    const recovered = await publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git });

    expect(recovered).toMatchObject({ status: 'reconciled', operationId: first.operationId, pr: first.pr });
    expect(fixture.calls.filter((argv) => argv[0] === 'pr' && argv[1] === 'create')).toHaveLength(creates);
    expect(JSON.parse(readFileSync(join(fixture.bundle, 'publication.json'), 'utf8'))).toEqual(recovered);
    expect(JSON.parse(readFileSync(join(fixture.artifacts, 'publication.json'), 'utf8'))).toEqual(recovered);
  }, 15_000);

  it('fails closed before GitHub when the selected commit is not the reviewed bundle tree', async () => {
    const fixture = await publicationFixture();
    writeFileSync(join(fixture.workspace, 'unreviewed.txt'), 'not reviewed\n');
    runGit(['-C', fixture.workspace, 'add', 'unreviewed.txt']);
    runGit(['-C', fixture.workspace, 'commit', '-m', 'unreviewed substitution']);
    const substitutedRevision = runGit(['-C', fixture.workspace, 'rev-parse', 'HEAD']).trim();
    const request = { ...fixture.request, publication: { ...fixture.request.publication, expectedRevision: substitutedRevision } };

    await expect(publishLoopPublication(request, { gh: fixture.gh, git: fixture.git })).rejects.toThrow('publication_commit_does_not_match_reviewed_tree');
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.gitCalls.some((argv) => argv.includes('push'))).toBe(false);
  }, 15_000);

  it('requires explicit narrow request authority and owner-only bundle permissions', async () => {
    const fixture = await publicationFixture();
    expect(() => parseLoopPublicationRequest({ ...fixture.request, approved: false })).toThrow('publication_requires_explicit_owner_approval');
    expect(() => parseLoopPublicationRequest({ ...fixture.request, extraAuthority: 'merge' })).toThrow('publication_request_contains_unsupported_fields');
    const trunkTarget = { ...fixture.request, publication: { ...fixture.request.publication, branch: fixture.request.publication.baseRefName } };
    await expect(publishLoopPublication(trunkTarget, { gh: fixture.gh, git: fixture.git })).rejects.toThrow('publication_branch_must_differ_from_base');
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.gitCalls).toHaveLength(0);
    chmodSync(fixture.bundle, 0o755);
    await expect(publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git })).rejects.toThrow('publication_directory_permissions_must_be_owner_only');
    expect(fixture.calls).toHaveLength(0);
  }, 15_000);

  it('serializes parallel publication and honors cancellation before push or PR creation', async () => {
    const locked = await publicationFixture();
    writeFileSync(join(locked.bundle, '.publication.lock'), 'active\n', { mode: 0o600 });
    await expect(publishLoopPublication(locked.request, { gh: locked.gh, git: locked.git })).rejects.toThrow('publication_operation_already_running');
    expect(locked.calls).toHaveLength(0);

    const cancelled = await publicationFixture();
    const abort = new AbortController();
    abort.abort();
    const result = await publishLoopPublication(cancelled.request, { gh: cancelled.gh, git: cancelled.git, signal: abort.signal });
    expect(result).toMatchObject({ status: 'blocked', detail: 'publication_cancelled_before_effect' });
    expect(cancelled.calls.some((argv) => argv[0] === 'pr' && argv[1] === 'create')).toBe(false);
    expect(cancelled.gitCalls.some((argv) => argv.includes('push'))).toBe(false);
  }, 15_000);

  it('does not seal a handoff if the accepted workspace changes during capture', async () => {
    await expect(publicationFixture({ mutateAfterManifest: true })).rejects.toThrow('publication_workspace_changed_during_bundle_capture');
  }, 15_000);

  it('never pushes or creates from a tampered locally stored publication receipt', async () => {
    const fixture = await publicationFixture();
    const first = await publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git });
    const tampered = { ...first, pr: { ...first.pr, headRefOid: 'f'.repeat(40) } };
    writePrivateJson(join(fixture.bundle, 'publication.json'), tampered);
    writePrivateJson(join(fixture.artifacts, 'publication.json'), tampered);
    const creates = fixture.calls.filter((argv) => argv[0] === 'pr' && argv[1] === 'create').length;
    const pushes = fixture.gitCalls.filter((argv) => argv.includes('push')).length;

    await expect(publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git })).rejects.toThrow('publication_stored_pr_mismatch');

    expect(fixture.calls.filter((argv) => argv[0] === 'pr' && argv[1] === 'create')).toHaveLength(creates);
    expect(fixture.gitCalls.filter((argv) => argv.includes('push'))).toHaveLength(pushes);
  }, 15_000);

  it('keeps retrying remote observation without a push or duplicate PR when a known PR disappears', async () => {
    const fixture = await publicationFixture();
    const first = await publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git });
    fixture.publications.length = 0;
    const creates = fixture.calls.filter((argv) => argv[0] === 'pr' && argv[1] === 'create').length;
    const pushes = fixture.gitCalls.filter((argv) => argv.includes('push')).length;

    const missing = await publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git });
    const missingAgain = await publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git });
    fixture.publications.push({ ...first.pr, state: 'CLOSED' });
    const closed = await publishLoopPublication(fixture.request, { gh: fixture.gh, git: fixture.git });

    expect(missing).toMatchObject({ status: 'uncertain', pr: first.pr, detail: 'stored_publication_not_observed_remotely' });
    expect(missingAgain).toMatchObject({ status: 'uncertain', pr: first.pr, detail: 'stored_publication_not_observed_remotely' });
    expect(closed).toMatchObject({ status: 'uncertain', detail: 'remote_publication_is_closed' });
    expect(fixture.calls.filter((argv) => argv[0] === 'pr' && argv[1] === 'create')).toHaveLength(creates);
    expect(fixture.gitCalls.filter((argv) => argv.includes('push'))).toHaveLength(pushes);
  }, 15_000);
});

async function publicationFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'faktori-loop-publication-'));
  const workspace = join(root, 'workspace');
  const artifacts = join(root, 'loop-records');
  const bundle = join(root, 'publication-bundle');
  const remote = join(root, 'publisher.git');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(artifacts, { mode: 0o700 });
  runGit(['init', workspace]);
  runGit(['-C', workspace, 'config', 'user.email', 'owner@example.test']);
  runGit(['-C', workspace, 'config', 'user.name', 'Owner']);
  writeFileSync(join(workspace, 'README.md'), 'base\n');
  runGit(['-C', workspace, 'add', 'README.md']);
  runGit(['-C', workspace, 'commit', '-m', 'base']);
  const baseRevision = runGit(['-C', workspace, 'rev-parse', 'HEAD']).trim();
  runGit(['init', '--bare', remote]);
  runGit(['-C', workspace, 'push', remote, `${baseRevision}:refs/heads/main`]);

  writeFileSync(join(workspace, 'README.md'), 'reviewed change\n');
  writeFileSync(join(workspace, 'feature.txt'), 'reviewed addition\n');
  const evidence = await captureManagerLoopWorkspaceEvidence(workspace);
  const reviewStageId = 'loop-one-build-review-0';
  const managerAcceptanceStageId = 'loop-one-build-manager_accept-0';
  writePrivateJson(join(artifacts, 'report.json'), {
    format: 'faktori.manager-loop-result/v1', loopId: 'loop-one', status: 'succeeded', completedPhases: ['build'],
    stages: [
      {
        stageId: reviewStageId, phaseId: 'build', kind: 'review', round: 0, outcome: 'completed', evidence,
        verification: [{ command: 'npm', args: ['test'], exitCode: 0, passed: true, outputDigest: 'sha256:verified' }],
        response: { verdict: 'pass', summary: 'accepted exact content', findings: [], evidenceDigest: evidence.contentDigest }, completedAt: '2026-09-09T12:00:00.000Z',
      },
      {
        stageId: managerAcceptanceStageId, phaseId: 'build', kind: 'manager_accept', round: 0, outcome: 'completed', evidence,
        verification: [{ command: 'npm', args: ['test'], exitCode: 0, passed: true, outputDigest: 'sha256:verified' }],
        response: { accepted: true, summary: 'accepted', evidenceDigest: evidence.contentDigest, reviewStageId }, completedAt: '2026-09-09T12:00:01.000Z',
      },
    ],
  });

  const handoff = await prepareLoopPublicationHandoff({
    format: 'faktori.loop-publication-prepare/v1', approved: true, workspace, loopArtifactsDirectory: artifacts, bundleDirectory: bundle,
  }, {
    now: () => new Date('2026-09-09T12:00:02.000Z'),
    ...(options.mutateAfterManifest ? { afterManifestCaptured: () => writeFileSync(join(workspace, 'feature.txt'), 'changed during capture\n') } : {}),
  });
  runGit(['-C', workspace, 'add', '--all']);
  runGit(['-C', workspace, 'commit', '-m', 'reviewed result']);
  const expectedRevision = runGit(['-C', workspace, 'rev-parse', 'HEAD']).trim();
  const request = {
    format: 'faktori.loop-publication-request/v1', approved: true, bundleDirectory: bundle,
    publication: { repository: 'example/factory', branch: 'faktori/loop-one', baseRefName: 'main', baseRevision, expectedRevision, publisherRemote: remote, publisherWorktree: workspace },
  };
  const calls = [];
  const publications = [];
  const gh = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === 'repo' && argv[1] === 'view') return { exitCode: 0, stdout: JSON.stringify({ nameWithOwner: 'example/factory', viewerPermission: 'WRITE', isPrivate: true }), stderr: '' };
    if (argv[0] === 'pr' && argv[1] === 'list') return { exitCode: 0, stdout: JSON.stringify(publications), stderr: '' };
    if (argv[0] === 'pr' && argv[1] === 'create') {
      publications.push({ number: 17, url: 'https://github.com/example/factory/pull/17', headRefName: 'faktori/loop-one', headRefOid: expectedRevision, baseRefName: 'main', isDraft: true, state: 'OPEN' });
      return { exitCode: 0, stdout: 'https://github.com/example/factory/pull/17\n', stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected gh: ${argv.join(' ')}` };
  };
  const gitCalls = [];
  const git = async (argv) => { gitCalls.push([...argv]); return spawnGit(argv); };
  return { root, workspace, artifacts, bundle, remote, baseRevision, expectedRevision, evidence, handoff, request, calls, publications, gh, git, gitCalls };
}

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function runGit(argv) {
  return execFileSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
