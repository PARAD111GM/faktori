import { describe, expect, it } from 'vitest';

import { ControllerActionAdmission, InMemoryActionGrantVault, InMemoryActionJournal, signActionRequest } from '../../src/actions/index.ts';
import { GitHubDraftPullRequestExecutor, InMemoryGitHubPublicationStore } from '../../src/integrations/github.ts';

const scope = { kind: 'github.draft-pr', repository: 'example/factory-fixture', branch: 'faktori/run-1', baseRevision: 'main', expectedRevision: 'head-1', allowedOperation: 'github.draft-pr', scopeRevision: 'scope@1' };

describe('Phase 4 integration wiring', () => {
  it('passes a GitHub effect through durable action admission and rejects revocation before gh execution', async () => {
    let authority = { runId: 'run-1', scope: structuredClone(scope), authorityEpoch: 1, revoked: false, actionAllowed: true };
    const journal = new InMemoryActionJournal();
    const calls = [];
    const command = async (argv) => {
      calls.push(argv);
      if (argv[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '' };
      if (argv[1] === 'create') return { exitCode: 0, stdout: 'created', stderr: '' };
      return { exitCode: 0, stdout: JSON.stringify([{ number: 1, url: 'https://example/pr/1', headRefName: scope.branch, headRefOid: scope.expectedRevision, baseRefName: scope.baseRevision, isDraft: true }]), stderr: '' };
    };
    let queryCount = 0;
    const reconciledCommand = async (argv) => {
      if (argv[1] === 'list') {
        queryCount += 1;
        return queryCount === 1 ? command(argv) : { exitCode: 0, stdout: JSON.stringify([{ number: 1, url: 'https://example/pr/1', headRefName: scope.branch, headRefOid: scope.expectedRevision, baseRefName: scope.baseRevision, isDraft: true }]), stderr: '' };
      }
      return command(argv);
    };
    const admission = new ControllerActionAdmission({
      journal, grantVault: new InMemoryActionGrantVault(), authority: { current: async () => structuredClone(authority) },
      executor: new GitHubDraftPullRequestExecutor(
        { ...scope, baseRefName: 'main', publisherRemote: 'controller-only', publisherWorktree: '/private/controller' },
        reconciledCommand,
        new InMemoryGitHubPublicationStore(),
        async (argv) => argv.includes('rev-parse') ? { exitCode: 0, stdout: 'head-1\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' },
      ),
      random: { id: () => `id-${journal.records().length}`, secret: () => 'long-enough-private-verifier-secret-for-test' },
    });
    const capability = await admission.mintGrant({ runId: 'run-1', scope, authorityEpoch: 1 });
    const request = signActionRequest({ format: 'faktori.action-request/v1', actionId: 'publish-1', idempotencyKey: 'idem-1', runId: 'run-1', scope, authorityEpoch: 1, requestedAt: '2026-09-05T00:00:00Z' }, capability, 'nonce-1');
    await expect(admission.admit(request)).resolves.toEqual(expect.objectContaining({ accepted: true, receipt: expect.objectContaining({ outcome: 'completed' }) }));
    expect(journal.records().some((record) => record.kind === 'action.intent')).toBe(true);
    expect(calls.some((argv) => argv[1] === 'create')).toBe(true);

    authority = { ...authority, actionAllowed: false, revoked: true };
    const blocked = signActionRequest({ format: 'faktori.action-request/v1', actionId: 'publish-2', idempotencyKey: 'idem-2', runId: 'run-1', scope, authorityEpoch: 1, requestedAt: '2026-09-05T00:01:00Z' }, capability, 'nonce-2');
    await expect(admission.admit(blocked)).resolves.toEqual(expect.objectContaining({ accepted: false, reason: 'authority_not_current' }));
    expect(calls.filter((argv) => argv[1] === 'create')).toHaveLength(1);
  });
});
