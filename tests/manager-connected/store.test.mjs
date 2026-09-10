import { appendFile, chmod, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ManagerConnectedError,
  ManagerConnectedStore,
  parseManagerConnectedConfig,
} from '../../src/manager-connected/index.ts';

const MANAGER = '019c89ea-34b1-7f65-8c96-0f496bb5a001';
const BUILDER = '019c89ea-34b1-7f65-8c96-0f496bb5a002';
const REVIEWER = '019c89ea-34b1-7f65-8c96-0f496bb5a003';
const OTHER = '019c89ea-34b1-7f65-8c96-0f496bb5a004';
const REQUEST_ONE = '019c89ea-34b1-7f65-8c96-0f496bb5b101';
const REQUEST_TWO = '019c89ea-34b1-7f65-8c96-0f496bb5b102';

const roots = [];
const stores = [];

async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'faktori-manager-connected-'));
  roots.push(directory);
  return directory;
}

function config(directory, overrides = {}) {
  return {
    directory,
    manager: overrides.manager ?? { threadId: MANAGER, title: 'Build Manager' },
    sessions: overrides.sessions ?? [
      { id: 'builder', threadId: BUILDER, title: 'Phase builder', role: 'implementer', productId: 'faktori', podId: 'runtime', phaseId: 'phase-9', ticketId: 'f9-01' },
      { id: 'reviewer', threadId: REVIEWER, title: 'Independent reviewer', role: 'reviewer', productId: 'faktori', planId: 'manager-connected' },
    ],
  };
}

async function opened(value) {
  const store = await ManagerConnectedStore.open(value);
  stores.push(store);
  return store;
}

async function enqueue(store, overrides = {}) {
  return store.operate({
    type: 'enqueue',
    id: overrides.id ?? REQUEST_ONE,
    sessionId: overrides.sessionId ?? 'builder',
    title: overrides.title ?? 'Implement bounded change',
    instruction: overrides.instruction ?? 'Inspect only the assigned files and report the observed result.',
  });
}

function expectCode(code) {
  return expect.objectContaining({ name: 'ManagerConnectedError', code });
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('manager-connected configuration', () => {
  it('accepts only explicit absolute, unambiguous existing-session assignments', async () => {
    const directory = await root();
    const parsed = parseManagerConnectedConfig(config(`${directory}/../${directory.split('/').at(-1)}`));
    expect(parsed.directory).toBe(directory);
    expect(parsed.sessions[0]).toMatchObject({ id: 'builder', threadId: BUILDER, productId: 'faktori', phaseId: 'phase-9' });

    expect(() => parseManagerConnectedConfig({ ...config(directory), directory: 'relative' })).toThrow(expectCode('invalid_input'));
    expect(() => parseManagerConnectedConfig(config(directory, { sessions: [
      { id: 'one', threadId: BUILDER, title: 'One', role: 'builder', productId: 'faktori' },
      { id: 'two', threadId: BUILDER, title: 'Two', role: 'reviewer', productId: 'faktori' },
    ] }))).toThrow(expectCode('invalid_input'));
    expect(() => parseManagerConnectedConfig({ ...config(directory), extra: true })).toThrow(expectCode('invalid_input'));
  });
});

describe('manager-connected durable requests', () => {
  it('returns exact instructions only from a claim and redacts unsafe projection text', async () => {
    const directory = await root();
    const store = await opened(config(directory, { sessions: [
      { id: 'builder', threadId: BUILDER, title: 'API key sk-live-1234567890', role: 'implementer', productId: 'faktori' },
    ] }));
    await enqueue(store, { title: 'Use /Users/private/repo', instruction: 'Exact private instruction that the relay must preserve.' });

    const before = store.snapshot();
    expect(before.requests[0]).toMatchObject({ title: '[redacted]', assignment: { title: '[redacted]' }, instructionAvailable: true });
    expect(before.requests[0]).not.toHaveProperty('instruction');

    const claimed = await store.operate({ type: 'claim', id: REQUEST_ONE });
    expect(claimed).toEqual({
      type: 'claim',
      claim: expect.objectContaining({
        requestId: REQUEST_ONE,
        instruction: 'Exact private instruction that the relay must preserve.',
        targetThreadId: BUILDER,
        assignment: expect.objectContaining({ id: 'builder', threadId: BUILDER }),
        callback: { managerThreadId: MANAGER, requestId: REQUEST_ONE, requiredSourceThreadId: BUILDER },
      }),
    });

    await store.operate({ type: 'submitted', id: REQUEST_ONE });
    await store.operate({ type: 'complete', id: REQUEST_ONE, threadId: BUILDER, summary: 'credential secret must stay private' });
    expect(store.snapshot().requests[0].report).toEqual(expect.objectContaining({ summary: '[redacted]', delivery: 'reported', productAcceptance: 'not_evaluated' }));

    await enqueue(store, { id: REQUEST_TWO, title: 'Use file:///private/tmp/a' });
    expect(store.snapshot().requests[1].title).toBe('[redacted]');
  });

  it('admits one competing claim, emits changes, and never allows a claim retry', async () => {
    const store = await opened(config(await root()));
    await enqueue(store);
    let changes = 0;
    const unsubscribe = store.onChange(() => { changes += 1; });

    const claims = await Promise.allSettled([
      store.operate({ type: 'claim', id: REQUEST_ONE }),
      store.operate({ type: 'claim', id: REQUEST_ONE }),
    ]);
    expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expectCode('claim_not_available') }),
    ]);
    expect(store.snapshot().requests[0].status).toBe('claimed');
    expect(changes).toBe(1);
    unsubscribe();
  });

  it('makes enqueue and completion idempotent only for identical content', async () => {
    const store = await opened(config(await root()));
    expect((await enqueue(store)).duplicate).toBe(false);
    expect((await enqueue(store)).duplicate).toBe(true);
    await expect(enqueue(store, { title: 'Different request' })).rejects.toMatchObject(expectCode('request_identity_conflict'));

    await store.operate({ type: 'claim', id: REQUEST_ONE });
    await store.operate({ type: 'submitted', id: REQUEST_ONE });
    await store.operate({ type: 'submitted', id: REQUEST_ONE });
    await store.operate({ type: 'complete', id: REQUEST_ONE, threadId: BUILDER, summary: 'Observed response' });
    await store.operate({ type: 'complete', id: REQUEST_ONE, threadId: BUILDER, summary: 'Observed response' });
    await expect(store.operate({ type: 'complete', id: REQUEST_ONE, threadId: BUILDER, summary: 'Conflicting response' })).rejects.toMatchObject(expectCode('completion_conflict'));
    expect(store.snapshot().requests[0].status).toBe('completed');
  });

  it('rejects a mismatched callback source and marks a trusted report separately from acceptance', async () => {
    const store = await opened(config(await root()));
    await enqueue(store);
    await store.operate({ type: 'claim', id: REQUEST_ONE });
    await store.operate({ type: 'submitted', id: REQUEST_ONE });
    await expect(store.operate({ type: 'complete', id: REQUEST_ONE, threadId: OTHER, summary: 'Forged callback' })).rejects.toMatchObject(expectCode('response_source_mismatch'));
    const completed = await store.operate({ type: 'complete', id: REQUEST_ONE, threadId: BUILDER, summary: 'Observed callback' });
    expect(completed.request.report).toEqual(expect.objectContaining({ sourceThreadId: BUILDER, observedByManagerThreadId: MANAGER, delivery: 'reported', productAcceptance: 'not_evaluated' }));
  });

  it('allows cancellation only before a request is claimed', async () => {
    const store = await opened(config(await root()));
    await enqueue(store, { id: REQUEST_ONE });
    expect((await store.operate({ type: 'cancel', id: REQUEST_ONE })).request.status).toBe('cancelled');
    await expect(store.operate({ type: 'claim', id: REQUEST_ONE })).rejects.toMatchObject(expectCode('claim_not_available'));

    await enqueue(store, { id: REQUEST_TWO });
    await store.operate({ type: 'claim', id: REQUEST_TWO });
    await expect(store.operate({ type: 'cancel', id: REQUEST_TWO })).rejects.toMatchObject(expectCode('cancel_not_queued'));
  });

  it('does not treat a callback as submitted work before submission is durably observed', async () => {
    const store = await opened(config(await root()));
    await enqueue(store);
    await store.operate({ type: 'claim', id: REQUEST_ONE });
    await expect(store.operate({ type: 'complete', id: REQUEST_ONE, threadId: BUILDER, summary: 'Early callback' })).rejects.toMatchObject(expectCode('request_not_dispatched'));
  });
});

describe('manager-connected recovery and authority', () => {
  it('keeps harmless authority prose visible while redacting decision credentials and paths', async () => {
    // Product failure prevented: an honest explanation of non-authority becomes
    // unreadable, or private credentials/local paths reach the browser.
    const store = await opened(config(await root()));
    const result = await store.operate({
      type: 'decision_create', id: '019c89ea-34b1-7f65-8c96-0f496bb5c100',
      scope: { productId: 'faktori', planId: 'console-plan', phaseId: 'batch-two' },
      problem: 'Inspect /Users/nathan/private evidence.', cause: { basis: 'reported', summary: 'A credential secret needs a private check.' }, evidence: [{ label: 'Private evidence path' }],
      accountableOwner: 'owner', recommendedNextAction: 'Do not send the credential to the browser.', impact: 'This grants no provider, publication, merge, deployment, or spending authority.',
      capability: 'supported', action: { kind: 'record_owner_response', label: 'Record response for Manager observation' }, options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }],
    });
    expect(result.decision).toMatchObject({ problem: '[redacted]', cause: { summary: '[redacted]' }, recommendedNextAction: '[redacted]', impact: 'This grants no provider, publication, merge, deployment, or spending authority.' });
  });

  it('preserves a scoped owner choice through response, Manager acknowledgement, resolution, replay, and restart', async () => {
    // Product failure prevented: an interrupted owner response could be resent as
    // a different choice or silently turned into an approval after restart.
    const directory = await root();
    const store = await opened(config(directory));
    const decision = {
      type: 'decision_create', id: '019c89ea-34b1-7f65-8c96-0f496bb5c101',
      scope: { productId: 'faktori', planId: 'console-plan', phaseId: 'batch-two', ticketId: 'CWM-008' },
      problem: 'Choose the default display for resolved decisions.',
      cause: { basis: 'observed', summary: 'The inbox needs one owner-controlled default.' }, evidence: [{ label: 'Console Batch 2 plan' }],
      accountableOwner: 'owner', recommendedNextAction: 'Record one display preference for Manager observation.', impact: 'Only the default display changes; no work is dispatched.',
      capability: 'supported', action: { kind: 'record_owner_response', label: 'Record response for Manager observation' },
      options: [{ id: 'collapsed', label: 'Collapsed' }, { id: 'expanded', label: 'Expanded' }],
    };
    expect((await store.operate(decision)).decision).toMatchObject({ state: 'open', revision: 1, scope: decision.scope });
    const response = { type: 'record_owner_response', id: decision.id, responseId: 'collapsed', idempotencyKey: '019c89ea-34b1-7f65-8c96-0f496bb5c102', expectedRevision: 1 };
    expect((await store.operate(response)).decision).toMatchObject({ state: 'pending_manager_ack', revision: 3, ownerResponse: { optionId: 'collapsed' } });
    expect((await store.operate(response)).duplicate).toBe(true);
    await expect(store.operate({ ...response, responseId: 'expanded' })).rejects.toMatchObject(expectCode('decision_idempotency_conflict'));
    await expect(store.operate({ ...response, idempotencyKey: '019c89ea-34b1-7f65-8c96-0f496bb5c103' })).rejects.toMatchObject(expectCode('decision_response_already_recorded'));
    await store.close();

    const recovered = await opened(config(directory));
    expect(recovered.snapshot().decisions).toEqual([expect.objectContaining({ id: decision.id, state: 'pending_manager_ack', ownerResponse: expect.objectContaining({ optionId: 'collapsed' }) })]);
    expect((await recovered.operate({ type: 'decision_acknowledge', id: decision.id, expectedRevision: 3 })).decision).toMatchObject({ state: 'manager_acknowledged', revision: 4 });
    expect((await recovered.operate({ type: 'decision_resolve', id: decision.id, expectedRevision: 4 })).decision).toMatchObject({ state: 'resolved', revision: 5 });
  });

  it('replays durable state and turns restart in-flight work uncertain without retrying it', async () => {
    const directory = await root();
    const first = await opened(config(directory));
    await enqueue(first);
    await first.operate({ type: 'claim', id: REQUEST_ONE });
    await first.operate({ type: 'submitted', id: REQUEST_ONE });
    await first.close();

    const second = await opened(config(directory));
    expect(second.snapshot().requests[0]).toMatchObject({ status: 'uncertain', uncertaintyReason: 'restart_requires_reconciliation' });
    await expect(second.operate({ type: 'claim', id: REQUEST_ONE })).rejects.toMatchObject(expectCode('claim_not_available'));
    await second.operate({ type: 'complete', id: REQUEST_ONE, threadId: BUILDER, summary: 'Callback reconciled without resend' });
    expect(second.snapshot().requests[0].status).toBe('completed');

    const lines = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    expect(lines.map((line) => line.type)).toEqual(['queued', 'claimed', 'submission_observed', 'restart_requires_reconciliation', 'response_observed']);
  });

  it('fails a claim when its immutable assignment changed or was revoked', async () => {
    const changedDirectory = await root();
    const changed = await opened(config(changedDirectory));
    await enqueue(changed);
    await changed.close();
    const changedConfig = config(changedDirectory);
    changedConfig.sessions[0] = { ...changedConfig.sessions[0], threadId: OTHER };
    const reopenedChanged = await opened(changedConfig);
    await expect(reopenedChanged.operate({ type: 'claim', id: REQUEST_ONE })).rejects.toMatchObject(expectCode('assignment_changed'));

    const revokedDirectory = await root();
    const revoked = await opened(config(revokedDirectory));
    await enqueue(revoked);
    await revoked.close();
    const reopenedRevoked = await opened(config(revokedDirectory, { sessions: [
      { id: 'reviewer', threadId: REVIEWER, title: 'Reviewer', role: 'reviewer', productId: 'faktori' },
    ] }));
    await expect(reopenedRevoked.operate({ type: 'claim', id: REQUEST_ONE })).rejects.toMatchObject(expectCode('target_revoked'));
  });

  it('rejects a queued request under a stale Manager callback assignment', async () => {
    const directory = await root();
    const first = await opened(config(directory));
    await enqueue(first);
    await first.close();

    const stale = await opened(config(directory, { manager: { threadId: OTHER, title: 'Replacement Manager' } }));
    await expect(stale.operate({ type: 'claim', id: REQUEST_ONE })).rejects.toMatchObject(expectCode('manager_assignment_changed'));
  });

  it('does not misattribute an uncertain callback after the configured Manager is replaced', async () => {
    const directory = await root();
    const first = await opened(config(directory));
    await enqueue(first);
    await first.operate({ type: 'claim', id: REQUEST_ONE });
    await first.operate({ type: 'submitted', id: REQUEST_ONE });
    await first.close();

    const replacement = await opened(config(directory, { manager: { threadId: OTHER, title: 'Replacement Manager' } }));
    await expect(replacement.operate({ type: 'complete', id: REQUEST_ONE, threadId: BUILDER, summary: 'Observed elsewhere' })).rejects.toMatchObject(expectCode('manager_assignment_changed'));
    await replacement.close();

    const restored = await opened(config(directory));
    await restored.operate({ type: 'complete', id: REQUEST_ONE, threadId: BUILDER, summary: 'Observed by original Manager' });
    expect(restored.snapshot().requests[0].report).toEqual(expect.objectContaining({ observedByManagerThreadId: MANAGER }));
  });

  it('quarantines only an incomplete tail and retains the last committed request', async () => {
    const directory = await root();
    const first = await opened(config(directory));
    await enqueue(first);
    await first.close();
    await appendFile(join(directory, 'events.jsonl'), '{"incomplete":');

    const recovered = await opened(config(directory));
    expect(recovered.snapshot().requests).toEqual([expect.objectContaining({ id: REQUEST_ONE, status: 'queued' })]);
    expect((await readFile(join(directory, 'events.jsonl'), 'utf8')).endsWith('\n')).toBe(true);
    expect((await readdir(directory)).filter((name) => name.startsWith('events.jsonl.incomplete-'))).toHaveLength(1);
  });

  it('fails closed on committed corruption and releases the ownership lock from the failed open', async () => {
    const directory = await root();
    await writeFile(join(directory, 'events.jsonl'), '{"malformed":true}\n', { mode: 0o600 });
    await expect(ManagerConnectedStore.open(config(directory))).rejects.toMatchObject(expectCode('journal_corrupt'));

    await writeFile(join(directory, 'events.jsonl'), '');
    const recovered = await opened(config(directory));
    expect(recovered.snapshot().sequence).toBe(0);
  });

  it('rejects a symlink journal without following it', async () => {
    const directory = await root();
    const target = join(directory, 'outside-events.jsonl');
    await writeFile(target, '');
    await symlink(target, join(directory, 'events.jsonl'));
    await expect(ManagerConnectedStore.open(config(directory))).rejects.toMatchObject(expectCode('invalid_journal'));
    expect(await readFile(target, 'utf8')).toBe('');
  });

  it('rejects storage that is readable by other local users', async () => {
    const publicDirectory = await root();
    await chmod(publicDirectory, 0o755);
    await expect(ManagerConnectedStore.open(config(publicDirectory))).rejects.toMatchObject(expectCode('invalid_directory'));

    const publicJournalDirectory = await root();
    await writeFile(join(publicJournalDirectory, 'events.jsonl'), '', { mode: 0o644 });
    await expect(ManagerConnectedStore.open(config(publicJournalDirectory))).rejects.toMatchObject(expectCode('invalid_journal'));
  });

  it('poisons mutations after an unconfirmed fsync and recovers the fully written event only after restart', async () => {
    const directory = await root();
    const store = await opened(config(directory));
    const probe = await open(join(directory, 'prototype-probe'), 'w+');
    const sync = vi.spyOn(Object.getPrototypeOf(probe), 'sync').mockRejectedValueOnce(new Error('injected fsync failure'));
    await expect(enqueue(store)).rejects.toMatchObject(expectCode('journal_uncertain'));
    sync.mockRestore();
    await probe.close();
    expect(store.snapshot()).toMatchObject({ sequence: 0, requests: [] });
    await expect(store.operate({ type: 'heartbeat' })).rejects.toMatchObject(expectCode('store_requires_restart'));
    await store.close();

    const recovered = await opened(config(directory));
    expect(recovered.snapshot().requests).toEqual([expect.objectContaining({ id: REQUEST_ONE, status: 'queued' })]);
  });

  it('permits exactly one process owner until the first store closes cleanly', async () => {
    const directory = await root();
    const first = await opened(config(directory));
    await expect(ManagerConnectedStore.open(config(directory))).rejects.toMatchObject(expectCode('directory_owned'));
    await first.close();
    const second = await opened(config(directory));
    expect(second.snapshot().requests).toEqual([]);
  });

  it('records a durable heartbeat and notifies the live-state listener', async () => {
    const store = await opened(config(await root()));
    let observed = 0;
    store.onChange(() => { observed += 1; });
    const heartbeat = await store.operate({ type: 'heartbeat' });
    expect(heartbeat.snapshot).toMatchObject({ sequence: 1, lastHeartbeatAt: expect.any(String) });
    expect(observed).toBe(1);
  });
});
