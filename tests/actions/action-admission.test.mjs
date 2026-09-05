import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AppendOnlyActionJournal,
  ControllerActionAdmission,
  FileActionGrantVault,
  InMemoryActionGrantVault,
  InMemoryActionJournal,
  actionRequestDigest,
  signActionRequest,
} from '../../src/actions/index.ts';
import { AppendOnlyJournal } from '../../src/runtime/journal.ts';

const scope = Object.freeze({
  kind: 'local.publish',
  repository: 'org/repository',
  branch: 'build/phase-2',
  baseRevision: 'base@1',
  expectedRevision: 'expected@2',
  allowedOperation: 'local.publish',
  scopeRevision: 'scope@4',
});

function clone(value) {
  return structuredClone(value);
}

function authorityState(overrides = {}) {
  return {
    runId: 'run-1',
    scope: clone(scope),
    authorityEpoch: 7,
    revoked: false,
    actionAllowed: true,
    ...overrides,
  };
}

function requestFields(overrides = {}) {
  return {
    format: 'faktori.action-request/v1',
    actionId: 'action-1',
    idempotencyKey: 'idempotency-1',
    runId: 'run-1',
    scope: clone(scope),
    authorityEpoch: 7,
    requestedAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  };
}

function fixture(options = {}) {
  let authority = authorityState();
  let sequence = 0;
  const journal = new InMemoryActionJournal();
  const vault = new InMemoryActionGrantVault();
  const effects = [];
  const controller = new ControllerActionAdmission({
    journal,
    grantVault: vault,
    authority: { current: async () => clone(authority) },
    executor: {
      execute: async (action, guard) => {
        await guard();
        effects.push({ action, journalBeforeEffect: journal.records() });
        return { outcome: 'completed', detail: 'deterministic local effect completed' };
      },
    },
    clock: { now: () => new Date('2026-09-04T00:00:01.000Z') },
    random: { id: () => `record-${++sequence}`, secret: () => 'a-deterministic-test-secret-that-is-long-enough' },
    ...options,
  });
  return {
    controller,
    journal,
    vault,
    effects,
    setAuthority(next) { authority = authorityState(next); },
    currentAuthority() { return clone(authority); },
  };
}

async function grantedRequest(test, overrides = {}, nonce = 'nonce-1') {
  const capability = await test.controller.mintGrant({ runId: 'run-1', scope: clone(scope), authorityEpoch: 7 });
  return { capability, request: signActionRequest(requestFields(overrides), capability, nonce) };
}

describe('controller-owned action admission', () => {
  it('uses one durable action claim across two controllers, so concurrent identical requests perform one effect', async () => {
    const directory = await mkdtemp(join('/private/tmp', 'faktori-action-claim-'));
    try {
      const path = join(directory, 'operations.jsonl');
      const authority = { current: async () => authorityState() };
      const vault = new InMemoryActionGrantVault();
      const effects = [];
      const makeController = async () => new ControllerActionAdmission({
        journal: new AppendOnlyActionJournal(await AppendOnlyJournal.open(path)),
        authority,
        grantVault: vault,
        executor: { execute: async (action, guard) => { await guard(); effects.push(action.operationId); return { outcome: 'completed' }; } },
      });
      const first = await makeController();
      const capability = await first.mintGrant({ runId: 'run-1', scope: clone(scope), authorityEpoch: 7 });
      const second = await makeController();
      const request = signActionRequest(requestFields(), capability, 'shared-nonce');
      const [left, right] = await Promise.all([first.admit(request), second.admit(request)]);

      expect(effects).toHaveLength(1);
      expect([left, right].filter((result) => result.receipt.outcome === 'completed')).toHaveLength(2);
      expect([left.reason, right.reason]).toContain('exact_duplicate');
      expect((await AppendOnlyJournal.open(path)).events().filter((event) => event.data.actionRecord?.kind === 'action.intent')).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('restores a private file-backed verifier after a controller restart without placing it in the journal', async () => {
    const directory = await mkdtemp(join('/private/tmp', 'faktori-action-vault-'));
    try {
      const path = join(directory, 'operations.jsonl');
      const vaultPath = join(directory, 'controller-vault');
      const authority = { current: async () => authorityState() };
      const journalA = new AppendOnlyActionJournal(await AppendOnlyJournal.open(path));
      const controllerA = new ControllerActionAdmission({
        journal: journalA, authority, grantVault: new FileActionGrantVault(vaultPath),
        executor: { execute: async () => ({ outcome: 'failed' }) },
      });
      const capability = await controllerA.mintGrant({ runId: 'run-1', scope: clone(scope), authorityEpoch: 7 });
      const request = signActionRequest(requestFields(), capability, 'restart-nonce');
      const effects = [];
      const reopenedRaw = await AppendOnlyJournal.open(path);
      const controllerB = new ControllerActionAdmission({
        journal: new AppendOnlyActionJournal(reopenedRaw), authority, grantVault: new FileActionGrantVault(vaultPath),
        executor: { execute: async (action, guard) => { await guard(); effects.push(action.operationId); return { outcome: 'completed' }; } },
      });
      const result = await controllerB.admit(request);
      const vaultFiles = await (await import('node:fs/promises')).readdir(vaultPath);

      expect(result).toEqual(expect.objectContaining({ accepted: true, receipt: expect.objectContaining({ outcome: 'completed' }) }));
      expect(effects).toHaveLength(1);
      expect(vaultFiles).toHaveLength(1);
      expect(vaultFiles[0]).toMatch(/^[a-f0-9]{64}\.secret$/);
      expect(JSON.stringify(reopenedRaw.events())).not.toContain(capability.verifierSecret);
      expect(JSON.stringify(reopenedRaw.events())).not.toContain(request.proof.authenticationTag);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('denies malformed and proof-less untrusted input without throwing', async () => {
    const test = fixture();
    const proofLess = requestFields();

    const results = await Promise.all([test.controller.admit({}), test.controller.admit(proofLess)]);

    expect(results).toEqual([
      expect.objectContaining({ accepted: false, reason: 'invalid_action_request', receipt: expect.objectContaining({ outcome: 'denied' }) }),
      expect.objectContaining({ accepted: false, reason: 'invalid_action_request', receipt: expect.objectContaining({ outcome: 'denied' }) }),
    ]);
    expect(test.effects).toEqual([]);
  });

  it('requires the current authority record to name the exact run for grant minting and pre-intent admission', async () => {
    const wrongMint = fixture({ authority: { current: async () => authorityState({ runId: 'other-run' }) } });
    await expect(wrongMint.controller.mintGrant({ runId: 'run-1', scope: clone(scope), authorityEpoch: 7 })).rejects.toThrow(/current run authority/);

    const wrongAdmission = fixture();
    const { request } = await grantedRequest(wrongAdmission);
    wrongAdmission.setAuthority({ runId: 'other-run' });

    expect((await wrongAdmission.controller.admit(request)).reason).toBe('authority_not_current');
    expect(wrongAdmission.effects).toEqual([]);
  });

  it('reopens public action records from the durable coordinator journal without capability material', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-action-journal-'));
    try {
      const raw = await AppendOnlyJournal.open(join(directory, 'operations.jsonl'));
      const journal = new AppendOnlyActionJournal(raw);
      await journal.append({
        format: 'faktori.action-grant-record/v1',
        kind: 'grant.issued',
        recordId: 'grant-record',
        occurredAt: '2026-09-04T00:00:00.000Z',
        grant: {
          format: 'faktori.action-grant/v1', grantId: 'grant-1', runId: 'run-1', scope: clone(scope), authorityEpoch: 7,
          issuedAt: '2026-09-04T00:00:00.000Z', verification: { algorithm: 'hmac-sha256', keyId: 'public-verification-id' },
        },
      });
      const reopened = new AppendOnlyActionJournal(await AppendOnlyJournal.open(join(directory, 'operations.jsonl')));

      expect(reopened.records()).toEqual(journal.records());
      expect(JSON.stringify(raw.events())).not.toContain('verifierSecret');
      expect(raw.events()[0]).toEqual(expect.objectContaining({ kind: 'action.intended', data: expect.objectContaining({ actionRecord: expect.objectContaining({ grant: expect.not.objectContaining({ verifierSecret: expect.anything() }) }) }) }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('mints a per-run HMAC grant, journals intent before local effect, and never journals the verifier secret or proof', async () => {
    const test = fixture();
    const { capability, request } = await grantedRequest(test);

    const result = await test.controller.admit(request);

    expect(result).toEqual(expect.objectContaining({ accepted: true, receipt: expect.objectContaining({ outcome: 'completed' }) }));
    expect(test.effects).toHaveLength(1);
    expect(test.effects[0].journalBeforeEffect.some((record) => record.kind === 'action.intent')).toBe(true);
    const publicRecords = JSON.stringify(test.journal.records());
    expect(publicRecords).toContain(capability.grant.grantId);
    expect(publicRecords).toContain(capability.grant.verification.keyId);
    expect(publicRecords).not.toContain(capability.verifierSecret);
    expect(publicRecords).not.toContain(request.proof.authenticationTag);
    expect(test.journal.records().find((record) => record.kind === 'action.intent')).toEqual(expect.objectContaining({
      grantId: capability.grant.grantId,
      nonceDigest: expect.any(String),
      requestDigest: request.requestDigest,
    }));
  });

  it('returns an exact duplicate stored receipt without a second local effect, but rejects idempotency and nonce reuse with changed input', async () => {
    const test = fixture();
    const { capability, request } = await grantedRequest(test);
    const first = await test.controller.admit(request);
    const duplicate = await test.controller.admit(request);
    const changedIdempotency = signActionRequest(requestFields({ actionId: 'action-other' }), capability, 'nonce-2');
    const reusedNonce = signActionRequest(requestFields({ idempotencyKey: 'idempotency-other' }), capability, 'nonce-1');

    expect(duplicate).toEqual(expect.objectContaining({ accepted: true, reason: 'exact_duplicate', receipt: first.receipt }));
    expect((await test.controller.admit(changedIdempotency)).reason).toBe('idempotency_key_reused_for_different_action');
    expect((await test.controller.admit(reusedNonce)).reason).toBe('nonce_replayed');
    expect(test.effects).toHaveLength(1);
  });

  it('rejects forged proof, changed digest, wrong run, target, revision, scope revision, and stale authority without an effect', async () => {
    const test = fixture();
    const { capability, request } = await grantedRequest(test);
    const forged = clone(request);
    forged.proof.authenticationTag = 'forged';
    const changedDigest = clone(request);
    changedDigest.requestDigest = actionRequestDigest({ ...changedDigest, actionId: 'different-but-not-resigned' });
    const wrongRun = signActionRequest(requestFields({ runId: 'run-2', idempotencyKey: 'run-2-key' }), capability, 'nonce-run-2');
    const wrongTarget = signActionRequest(requestFields({ idempotencyKey: 'target-key', scope: { ...scope, branch: 'other-branch' } }), capability, 'nonce-target');
    const wrongRevision = signActionRequest(requestFields({ idempotencyKey: 'revision-key', scope: { ...scope, expectedRevision: 'expected@other' } }), capability, 'nonce-revision');
    const wrongScopeRevision = signActionRequest(requestFields({ idempotencyKey: 'scope-key', scope: { ...scope, scopeRevision: 'scope@other' } }), capability, 'nonce-scope');
    const staleEpoch = signActionRequest(requestFields({ idempotencyKey: 'epoch-key', authorityEpoch: 6 }), capability, 'nonce-epoch');

    expect((await test.controller.admit(forged)).reason).toBe('caller_authentication_failed');
    expect((await test.controller.admit(changedDigest)).reason).toBe('request_digest_mismatch');
    for (const invalid of [wrongRun, wrongTarget, wrongRevision, wrongScopeRevision, staleEpoch]) {
      expect((await test.controller.admit(invalid)).reason).toBe('grant_scope_or_run_mismatch');
    }
    expect(test.effects).toEqual([]);
  });

  it('blocks cancelled or revoked authority and rechecks authority after durable intent before entering an effect', async () => {
    const initiallyCancelled = fixture();
    const { request: cancelledRequest } = await grantedRequest(initiallyCancelled);
    initiallyCancelled.setAuthority({ actionAllowed: false, revoked: true });
    expect((await initiallyCancelled.controller.admit(cancelledRequest)).reason).toBe('authority_not_current');
    expect(initiallyCancelled.effects).toEqual([]);

    let authority = authorityState();
    const race = fixture({
      authority: { current: async () => clone(authority) },
      hooks: { afterIntentPersisted: () => { authority = authorityState({ runId: 'other-run' }); } },
    });
    const { request } = await grantedRequest(race);
    const result = await race.controller.admit(request);

    expect(result).toEqual(expect.objectContaining({ accepted: false, reason: 'authority_not_current', receipt: expect.objectContaining({ outcome: 'denied' }) }));
    expect(race.effects).toEqual([]);
    expect(race.journal.records().filter((record) => record.kind === 'action.intent')).toHaveLength(1);
    expect(race.journal.records().filter((record) => record.kind === 'action.receipt')).toHaveLength(1);
  });

  it('retains a crash-after-intent as uncertain and blocks the same request pending reconciliation', async () => {
    const test = fixture();
    const { capability, request } = await grantedRequest(test);
    await test.journal.append({
      format: 'faktori.action-record/v1',
      kind: 'action.intent',
      recordId: 'crashed-intent',
      occurredAt: '2026-09-04T00:00:02.000Z',
      operationId: 'operation-crashed',
      runId: request.runId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      grantId: capability.grant.grantId,
      nonceDigest: '9e3f156324d42f0ea4b6f4fce81d56fbd64a2143a3fdd60a130d9c90e5b4d688',
      requestDigest: request.requestDigest,
      scope: clone(scope),
      authorityEpoch: 7,
      verification: clone(capability.grant.verification),
    });
    // The digest above is intentionally the SHA-256 digest of `nonce-1`.
    const result = await test.controller.admit(request);

    expect(result).toEqual(expect.objectContaining({ accepted: false, reason: 'unresolved_action_requires_reconciliation', receipt: expect.objectContaining({ outcome: 'uncertain', operationId: 'operation-crashed' }) }));
    expect(test.effects).toEqual([]);
    expect(test.journal.records().filter((record) => record.kind === 'action.receipt')).toHaveLength(0);
  });

  it('treats an executor interruption as uncertain and does not allow a late retry to invoke another effect', async () => {
    const test = fixture({
      executor: { execute: async (_action, guard) => { await guard(); throw new Error('local process interrupted after dispatch'); } },
    });
    const { request } = await grantedRequest(test);
    const first = await test.controller.admit(request);
    const lateRetry = await test.controller.admit(request);

    expect(first.receipt.outcome).toBe('uncertain');
    expect(lateRetry).toEqual(expect.objectContaining({ accepted: false, reason: 'exact_duplicate', receipt: first.receipt }));
    expect(test.effects).toEqual([]);
  });
});
