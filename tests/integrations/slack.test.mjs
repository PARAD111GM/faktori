import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileSlackOutboxJournal,
  FetchSlackRouterStatusReader,
  FetchSlackRouterTransport,
  InMemorySlackOutboxJournal,
  SlackOutboxController,
  SlackRouterActionExecutor,
} from '../../src/integrations/slack.ts';

function notification(overrides = {}) {
  return {
    eventId: 'event-1', repository: 'paradiiigm/faktori', pullRequest: 42,
    channel: 'pr-review', ticket: 'TWZ-42', title: 'Reliable Slack outbox',
    stage: 'ready', text: 'Ready for independent review.', ...overrides,
  };
}

function transport(statuses = [200]) {
  const posts = [];
  return { posts, post: async (input) => {
    posts.push(input.payload);
    const status = statuses.shift() ?? 200;
    return { status, ...(status >= 200 && status < 300 ? { receipt: { eventId: input.eventId, subject: input.subject, payloadDigest: input.payloadDigest, channelId: 'C1', messageTs: '1.0001' } } : {}) };
  } };
}

function reader(receipts = ['delivered']) {
  const reads = [];
  return { reads, receipt: async (input) => { reads.push(input); return receipts.shift() ?? 'unavailable'; } };
}

function controller(journal, router = transport(), statusReader) {
  return { router, outbox: new SlackOutboxController({ journal, transport: router, channels: ['pr-review', 'errors'], ...(statusReader === undefined ? {} : { statusReader }) }) };
}

describe('Slack router durable outbox', () => {
  it('delivers other project ticket identities without relaxing destination or identity validation', async () => {
    const journal = new InMemorySlackOutboxJournal();
    const { outbox, router } = controller(journal);
    await expect(outbox.dispatch(notification({ ticket: 'APP-42' }), async () => undefined)).resolves.toEqual({ status: 'delivered', duplicate: false });
    expect(router.posts[0].ticket).toBe('APP-42');
    for (const ticket of ['APP-0', 'APP-42\n', '<@U123>', 'A'.repeat(33) + '-1']) {
      await expect(outbox.dispatch(notification({ eventId: 'invalid', ticket }), async () => undefined)).rejects.toThrow('issue identity');
    }
    await expect(outbox.dispatch(notification({ eventId: 'wrong-channel', ticket: 'APP-43', channel: 'C012345' }), async () => undefined)).rejects.toThrow('configured safe event');
    expect(router.posts).toHaveLength(1);
  });

  it('persists intent before the router call, rejects a forged channel, and retains no private auth callback', async () => {
    const journal = new InMemorySlackOutboxJournal();
    const { outbox, router } = controller(journal);

    await expect(outbox.dispatch(notification({ channel: 'C012345' }), async () => undefined)).rejects.toThrow('configured safe event');
    expect(await journal.records()).toEqual([]);

    let guardSawIntent = false;
    await expect(outbox.dispatch(notification(), async () => {
      guardSawIntent = (await journal.records()).some((record) => record.kind === 'intent');
      throw new Error('authority revoked');
    })).resolves.toEqual({ status: 'blocked', reason: 'authority revoked' });
    expect(guardSawIntent).toBe(true);
    expect(router.posts).toEqual([]);
    expect(await journal.records()).toEqual([
      expect.objectContaining({ kind: 'intent', payload: expect.objectContaining({ channel: 'pr-review', ref: 'paradiiigm/faktori#42' }) }),
      expect.objectContaining({ kind: 'blocked', reason: 'authority revoked' }),
    ]);
    expect(JSON.stringify(await journal.records())).not.toContain('Authorization');
  });

  it('deduplicates exact identities but refuses a payload collision', async () => {
    const journal = new InMemorySlackOutboxJournal();
    const { outbox, router } = controller(journal);

    expect(await outbox.dispatch(notification(), async () => undefined)).toEqual({ status: 'delivered', duplicate: false });
    expect(await outbox.dispatch(notification(), async () => undefined)).toEqual({ status: 'delivered', duplicate: true });
    await expect(outbox.dispatch(notification({ text: 'Changed but reusing the event ID' }), async () => undefined)).rejects.toThrow('different payload');
    expect(router.posts).toHaveLength(1);
  });

  it('treats HTTP 500 as ambiguous, reconciles a provider receipt, and never blindly retries', async () => {
    const journal = new InMemorySlackOutboxJournal();
    const router = transport([500, 200]);
    const statusReader = reader(['absent', 'absent', 'absent']);
    const { outbox } = controller(journal, router, statusReader);

    expect(await outbox.dispatch(notification(), async () => undefined)).toEqual({ status: 'uncertain', reason: 'delivery_absent_requires_explicit_retry' });
    expect(router.posts).toHaveLength(1);
    expect(await outbox.dispatch(notification(), async () => undefined)).toEqual({ status: 'uncertain', reason: 'delivery_absent_requires_explicit_retry' });
    expect(router.posts).toHaveLength(1);
    expect(await outbox.retryAfterReconciliation('event-1', async () => undefined)).toEqual({ status: 'delivered', duplicate: false });
    expect(router.posts).toHaveLength(2);
    expect((await journal.records()).some((record) => record.kind === 'uncertain' && record.transportStatus === 500)).toBe(true);
  });

  it('recovers an ambiguous send after restart from a delivery receipt without a second post', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-slack-outbox-'));
    try {
      const path = join(directory, 'operations.jsonl');
      const firstRouter = transport([500]);
      const first = controller(new FileSlackOutboxJournal(path), firstRouter, reader(['unavailable']));
      expect(await first.outbox.dispatch(notification(), async () => undefined)).toEqual({ status: 'uncertain', reason: 'delivery_receipt_unavailable' });
      expect(firstRouter.posts).toHaveLength(1);

      const secondRouter = transport();
      const second = controller(new FileSlackOutboxJournal(path), secondRouter, reader(['delivered']));
      expect(await second.outbox.reconcile('event-1')).toEqual({ status: 'delivered', duplicate: true });
      expect(secondRouter.posts).toEqual([]);
      expect(await second.outbox.status('event-1')).toEqual(expect.objectContaining({ delivery: 'delivered' }));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('serializes same PR/channel subjects across controllers and records human acknowledgement separately', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-slack-subject-'));
    try {
      const path = join(directory, 'operations.jsonl');
      const calls = [];
      let release;
      const slowRouter = { post: async (input) => {
        calls.push(input.eventId);
        if (input.eventId === 'event-1') await new Promise((resolve) => { release = resolve; });
        return { status: 200, receipt: { eventId: input.eventId, subject: input.subject, payloadDigest: input.payloadDigest, channelId: 'C1', messageTs: '1.0001' } };
      } };
      const first = controller(new FileSlackOutboxJournal(path), slowRouter);
      const second = controller(new FileSlackOutboxJournal(path), slowRouter);
      const firstSend = first.outbox.dispatch(notification(), async () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const secondSend = second.outbox.dispatch(notification({ eventId: 'event-2', text: 'A later PR update' }), async () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(calls).toEqual(['event-1']);
      release();
      await expect(firstSend).resolves.toEqual({ status: 'delivered', duplicate: false });
      await expect(secondSend).resolves.toEqual({ status: 'delivered', duplicate: false });
      expect(calls).toEqual(['event-1', 'event-2']);

      await second.outbox.acknowledge('event-1', 'human-message-ts-1');
      expect(await second.outbox.status('event-1')).toEqual(expect.objectContaining({ delivery: 'delivered', acknowledgedAt: expect.any(String) }));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('uses the existing controller action guard and only accepts controller-configured notifications', async () => {
    const journal = new InMemorySlackOutboxJournal();
    const { outbox, router } = controller(journal);
    const executor = new SlackRouterActionExecutor(outbox, (action) => action.operationId === 'operation-1' ? notification() : undefined);
    const action = { operationId: 'operation-1', request: { scope: { allowedOperation: 'slack.notify' } }, grant: {} };

    expect(await executor.execute(action, async () => undefined)).toEqual({ outcome: 'completed', detail: 'slack_delivery_confirmed' });
    expect(router.posts).toHaveLength(1);
    expect(await executor.execute({ ...action, request: { scope: { allowedOperation: 'slack.other' } } }, async () => undefined)).toEqual({ outcome: 'blocked', detail: 'signed action does not name the configured Slack operation' });
  });

  it('does not mistake a generic 200 route acceptance for a Slack delivery receipt', async () => {
    const journal = new InMemorySlackOutboxJournal();
    const router = { post: async () => ({ status: 200 }) };
    const { outbox } = controller(journal, router, reader(['unavailable']));
    expect(await outbox.dispatch(notification(), async () => undefined)).toEqual({ status: 'uncertain', reason: 'delivery_receipt_unavailable' });
  });

  it('uses configured auth header names, redirect errors and timeout signals, while a receipt 404 stays unknown', async () => {
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const transport = new FetchSlackRouterTransport('https://router.example/slack', { authorizationHeader: async () => 'private-token', authHeaderName: 'X-Router-Token', timeoutMs: 123, fetcher });
    const result = await transport.post({ payload: { eventId: 'event-1', ref: 'paradiiigm/faktori#42', channel: 'pr-review', text: 'safe' }, eventId: 'event-1', subject: 'paradiiigm/faktori#42|pr-review', payloadDigest: 'a'.repeat(64) });
    expect(result).toEqual({ status: 200, receipt: undefined });
    expect(calls[0].init).toEqual(expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'X-Router-Token': 'private-token' }) }));

    const reader404 = new FetchSlackRouterStatusReader('https://router.example/receipt', { fetcher: async (_url, init) => { calls.push({ init }); return new Response('', { status: 404 }); } });
    expect(await reader404.receipt({ eventId: 'event-1', subject: 'paradiiigm/faktori#42|pr-review', payloadDigest: 'a'.repeat(64) })).toBe('unavailable');
    expect(calls[1].init).toEqual(expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });

  it('refuses permissive or symlinked journal storage before reading or writing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-slack-private-'));
    try {
      const permissive = join(directory, 'permissive.jsonl');
      const journal = new FileSlackOutboxJournal(permissive);
      await journal.append({ format: 'faktori.slack-outbox/v1', kind: 'intent', eventId: 'event-1', subject: 'paradiiigm/faktori#42|pr-review', payloadDigest: 'a'.repeat(64), occurredAt: new Date().toISOString(), payload: { eventId: 'event-1', ref: 'paradiiigm/faktori#42', channel: 'pr-review', text: 'safe' } });
      await chmod(permissive, 0o644);
      await expect(journal.records()).rejects.toThrow('private controller-owned regular file');

      const target = join(directory, 'target.jsonl');
      const link = join(directory, 'link.jsonl');
      await symlink(target, link);
      await expect(new FileSlackOutboxJournal(link).append({ format: 'faktori.slack-outbox/v1', kind: 'intent', eventId: 'event-2', subject: 'paradiiigm/faktori#42|pr-review', payloadDigest: 'b'.repeat(64), occurredAt: new Date().toISOString(), payload: { eventId: 'event-2', ref: 'paradiiigm/faktori#42', channel: 'pr-review', text: 'safe' } })).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
