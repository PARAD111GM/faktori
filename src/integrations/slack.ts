import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { ActionExecutionResult, AuthorizedAction, ControllerActionExecutor } from '../actions/index.ts';

export interface SlackNotification {
  /** Stable producer identity. Reuse with changed content is refused. */
  eventId: string;
  /** Controller-configured repository identity, used to qualify the PR subject. */
  repository: string;
  pullRequest: number;
  /** Logical name only. A raw Slack channel ID is never accepted. */
  channel: string;
  text: string;
  ticket?: string;
  title?: string;
  stage?: string;
  resolved?: boolean;
}

export interface SlackRouterPayload {
  eventId: string;
  ref: string;
  channel: string;
  text: string;
  ticket?: string;
  title?: string;
  stage?: string;
  resolved?: true;
}

export interface SlackRouterDeliveryReceipt {
  eventId: string;
  subject: string;
  payloadDigest: string;
  /** Router/Slack-native evidence, for example a channel ID and message timestamp. */
  channelId: string;
  messageTs: string;
}

export interface SlackRouterResponse { status: number; receipt?: SlackRouterDeliveryReceipt; }

export interface SlackRouterSend {
  payload: SlackRouterPayload;
  eventId: string;
  subject: string;
  payloadDigest: string;
}

/** A configured controller transport. Its endpoint and private auth stay outside outbox records. */
export interface SlackRouterTransport {
  post(input: SlackRouterSend): Promise<SlackRouterResponse>;
}

export type SlackDeliveryReceipt = 'delivered' | 'absent' | 'unavailable';

/** Read-only delivery evidence. It is deliberately distinct from a human reply or acknowledgement. */
export interface SlackDeliveryStatusReader {
  receipt(input: { eventId: string; subject: string; payloadDigest: string }): Promise<SlackDeliveryReceipt>;
}

export type SlackOutboxRecord =
  | { format: 'faktori.slack-outbox/v1'; kind: 'intent'; eventId: string; subject: string; payloadDigest: string; occurredAt: string; payload: SlackRouterPayload }
  | { format: 'faktori.slack-outbox/v1'; kind: 'delivery'; eventId: string; subject: string; payloadDigest: string; occurredAt: string; transportStatus?: number }
  | { format: 'faktori.slack-outbox/v1'; kind: 'uncertain'; eventId: string; subject: string; payloadDigest: string; occurredAt: string; reason: string; transportStatus?: number }
  | { format: 'faktori.slack-outbox/v1'; kind: 'blocked'; eventId: string; subject: string; payloadDigest: string; occurredAt: string; reason: string }
  | { format: 'faktori.slack-outbox/v1'; kind: 'acknowledged'; eventId: string; subject: string; payloadDigest: string; occurredAt: string; acknowledgmentId: string };

export interface SlackOutboxJournal {
  append(record: SlackOutboxRecord): Promise<void>;
  records(): Promise<readonly SlackOutboxRecord[]>;
  /** Must serialize an event identity and its PR/channel subject across controllers. */
  withClaims<T>(eventId: string, subject: string, task: () => Promise<T>): Promise<T>;
}

export class InMemorySlackOutboxJournal implements SlackOutboxJournal {
  #records: SlackOutboxRecord[] = [];
  #tail: Promise<unknown> = Promise.resolve();

  async append(record: SlackOutboxRecord): Promise<void> { this.#records.push(structuredClone(record)); }
  async records(): Promise<readonly SlackOutboxRecord[]> { return this.#records.map((record) => structuredClone(record)); }
  async withClaims<T>(_eventId: string, _subject: string, task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Append-only controller storage. Per-event plus per-subject create-only locks
 * serialize concurrent processes; a surviving crash lock is a safe blocker,
 * never a signal to resend a possibly delivered post.
 */
export class FileSlackOutboxJournal implements SlackOutboxJournal {
  readonly path: string;

  constructor(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Slack outbox journal requires a normalized absolute controller path');
    this.path = path;
  }

  async append(record: SlackOutboxRecord): Promise<void> {
    await this.ready();
    const handle = await appendNoFollow(this.path);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await privateRegularFile(this.path, 'Slack outbox journal');
  }

  async records(): Promise<readonly SlackOutboxRecord[]> {
    try {
      await this.ready();
      const status = await privateRegularFile(this.path, 'Slack outbox journal');
      if (status.size > MAX_JOURNAL_BYTES) throw new Error('Slack outbox journal exceeds its bounded recovery size');
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let contents: string;
      try { contents = await handle.readFile('utf8'); }
      finally { await handle.close(); }
      const lines = contents.split('\n').filter(Boolean);
      if (lines.length > MAX_JOURNAL_RECORDS || lines.some((line) => Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES)) throw new Error('Slack outbox journal exceeds its bounded recovery record limit');
      return lines.map((line) => recordAt(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async withClaims<T>(eventId: string, subject: string, task: () => Promise<T>): Promise<T> {
    const directory = `${this.path}.slack-locks`;
    await this.ready();
    await privateDirectory(directory, 'Slack outbox lock directory');
    const names = [lockName('event', eventId), lockName('subject', subject)].sort();
    const handles: { path: string; handle: Awaited<ReturnType<typeof open>> }[] = [];
    try {
      for (const name of names) {
        const path = join(directory, name);
        handles.push({ path, handle: await claim(path) });
      }
      return await task();
    } finally {
      for (const claimed of handles.reverse()) {
        await claimed.handle.close();
        await rm(claimed.path, { force: true });
      }
    }
  }

  private async ready(): Promise<void> { await privateDirectory(dirname(this.path), 'Slack outbox journal directory'); }
}

export interface SlackOutboxClock { now(): Date; }
const systemClock: SlackOutboxClock = { now: () => new Date() };

export type SlackDispatchResult =
  | { status: 'delivered'; duplicate: boolean }
  | { status: 'uncertain'; reason: string }
  | { status: 'blocked'; reason: string };

export interface SlackDeliveryState {
  eventId: string;
  subject: string;
  payloadDigest: string;
  delivery: 'intended' | 'delivered' | 'uncertain' | 'blocked';
  acknowledgedAt?: string;
}

export interface SlackOutboxControllerOptions {
  journal: SlackOutboxJournal;
  transport: SlackRouterTransport;
  /** Logical channel names allowed for this installation. */
  channels: readonly string[];
  statusReader?: SlackDeliveryStatusReader;
  clock?: SlackOutboxClock;
}

/**
 * Controller-owned Slack outbox. Intent is synced before a network effect;
 * uncertain sends can only be retried after a separate receipt reconciliation.
 */
export class SlackOutboxController {
  readonly #journal: SlackOutboxJournal;
  readonly #transport: SlackRouterTransport;
  readonly #channels: ReadonlySet<string>;
  readonly #statusReader?: SlackDeliveryStatusReader;
  readonly #clock: SlackOutboxClock;

  constructor(options: SlackOutboxControllerOptions) {
    this.#journal = options.journal;
    this.#transport = options.transport;
    this.#channels = new Set(options.channels);
    this.#statusReader = options.statusReader;
    this.#clock = options.clock ?? systemClock;
    if (this.#channels.size === 0 || [...this.#channels].some((channel) => !logicalChannel(channel))) throw new Error('Slack outbox requires a non-empty configured logical channel allowlist');
  }

  async dispatch(notification: SlackNotification, authorize: () => Promise<void>): Promise<SlackDispatchResult> {
    const prepared = prepare(notification, this.#channels);
    return this.#journal.withClaims(prepared.eventId, prepared.subject, async () => {
      const state = await this.stateFor(prepared.eventId, prepared.subject, prepared.payloadDigest);
      if (state?.delivery === 'delivered') return { status: 'delivered', duplicate: true };
      if (state?.delivery === 'uncertain' || state?.delivery === 'intended') return this.reconcileLocked(prepared, state);
      if (state?.delivery === 'blocked') return { status: 'blocked', reason: 'prior_authorization_denial' };

      await this.#journal.append({ format: 'faktori.slack-outbox/v1', kind: 'intent', eventId: prepared.eventId, subject: prepared.subject, payloadDigest: prepared.payloadDigest, occurredAt: this.now(), payload: prepared.payload });
      try { await authorize(); }
      catch (error) {
        const reason = error instanceof Error ? error.message : 'authorization denied';
        await this.#journal.append({ format: 'faktori.slack-outbox/v1', kind: 'blocked', eventId: prepared.eventId, subject: prepared.subject, payloadDigest: prepared.payloadDigest, occurredAt: this.now(), reason });
        return { status: 'blocked', reason };
      }
      return this.sendLocked(prepared);
    });
  }

  /** Never posts. This is the recovery operation after an ambiguous response. */
  async reconcile(eventId: string): Promise<SlackDispatchResult> {
    const intent = await this.intent(eventId);
    if (intent === undefined) return { status: 'blocked', reason: 'unknown_event' };
    return this.#journal.withClaims(eventId, intent.subject, async () => {
      const state = await this.stateFor(intent.eventId, intent.subject, intent.payloadDigest);
      if (state?.delivery === 'delivered') return { status: 'delivered', duplicate: true };
      if (state?.delivery === 'blocked') return { status: 'blocked', reason: 'prior_authorization_denial' };
      return this.reconcileLocked({ eventId: intent.eventId, subject: intent.subject, payloadDigest: intent.payloadDigest }, state);
    });
  }

  /** A retry is admitted only after a receipt reader proves the prior send absent. */
  async retryAfterReconciliation(eventId: string, authorize: () => Promise<void>): Promise<SlackDispatchResult> {
    const intent = await this.intent(eventId);
    if (intent === undefined) return { status: 'blocked', reason: 'unknown_event' };
    return this.#journal.withClaims(eventId, intent.subject, async () => {
      const state = await this.stateFor(intent.eventId, intent.subject, intent.payloadDigest);
      if (state?.delivery === 'delivered') return { status: 'delivered', duplicate: true };
      if (state?.delivery === 'blocked') return { status: 'blocked', reason: 'prior_authorization_denial' };
      if (this.#statusReader === undefined) return { status: 'uncertain', reason: 'delivery_receipt_reader_not_configured' };
      const receipt = await this.receipt(intent);
      if (receipt === 'delivered') {
        await this.delivered(intent);
        return { status: 'delivered', duplicate: true };
      }
      if (receipt !== 'absent') return { status: 'uncertain', reason: 'delivery_receipt_unavailable' };
      try { await authorize(); }
      catch (error) { return { status: 'blocked', reason: error instanceof Error ? error.message : 'authorization denied' }; }
      return this.sendLocked(intent);
    });
  }

  /** This local record is intentionally not considered by delivery reconciliation. */
  async acknowledge(eventId: string, acknowledgmentId: string): Promise<void> {
    const intent = await this.intent(eventId);
    if (intent === undefined || !safe(acknowledgmentId)) throw new Error('Slack acknowledgement requires a known event and safe acknowledgment identity');
    await this.#journal.withClaims(eventId, intent.subject, async () => {
      const records = await this.#journal.records();
      if (records.some((record) => record.kind === 'acknowledged' && record.eventId === eventId && record.acknowledgmentId === acknowledgmentId)) return;
      await this.#journal.append({ format: 'faktori.slack-outbox/v1', kind: 'acknowledged', eventId, subject: intent.subject, payloadDigest: intent.payloadDigest, occurredAt: this.now(), acknowledgmentId });
    });
  }

  async status(eventId: string): Promise<SlackDeliveryState | undefined> {
    const intent = await this.intent(eventId);
    return intent === undefined ? undefined : this.stateFor(intent.eventId, intent.subject, intent.payloadDigest);
  }

  private async sendLocked(prepared: Prepared): Promise<SlackDispatchResult> {
    try {
      const response = await this.#transport.post(prepared);
      if (response.status >= 200 && response.status < 300 && receiptMatches(response.receipt, prepared)) {
        await this.delivered(prepared, response.status);
        return { status: 'delivered', duplicate: false };
      }
      return this.uncertain(prepared, response.status >= 200 && response.status < 300 ? 'router_accepted_without_correlated_delivery_receipt' : `router_http_${response.status}`, response.status);
    } catch (error) {
      return this.uncertain(prepared, error instanceof Error ? error.message : 'router_transport_failed');
    }
  }

  private async reconcileLocked(prepared: Pick<Prepared, 'eventId' | 'subject' | 'payloadDigest'>, state: SlackDeliveryState | undefined): Promise<SlackDispatchResult> {
    if (state?.delivery === 'delivered') return { status: 'delivered', duplicate: true };
    if (this.#statusReader === undefined) return { status: 'uncertain', reason: 'delivery_receipt_reader_not_configured' };
    const receipt = await this.receipt(prepared);
    if (receipt === 'delivered') {
      await this.delivered(prepared);
      return { status: 'delivered', duplicate: true };
    }
    if (receipt === 'absent') return { status: 'uncertain', reason: 'delivery_absent_requires_explicit_retry' };
    return { status: 'uncertain', reason: 'delivery_receipt_unavailable' };
  }

  private async receipt(prepared: Pick<Prepared, 'eventId' | 'subject' | 'payloadDigest'>): Promise<SlackDeliveryReceipt> {
    try { return await this.#statusReader!.receipt(prepared); }
    catch { return 'unavailable'; }
  }

  private async delivered(prepared: Pick<Prepared, 'eventId' | 'subject' | 'payloadDigest'>, transportStatus?: number): Promise<void> {
    await this.#journal.append({ format: 'faktori.slack-outbox/v1', kind: 'delivery', eventId: prepared.eventId, subject: prepared.subject, payloadDigest: prepared.payloadDigest, occurredAt: this.now(), ...(transportStatus === undefined ? {} : { transportStatus }) });
  }

  private async uncertain(prepared: Pick<Prepared, 'eventId' | 'subject' | 'payloadDigest'>, reason: string, transportStatus?: number): Promise<SlackDispatchResult> {
    await this.#journal.append({ format: 'faktori.slack-outbox/v1', kind: 'uncertain', eventId: prepared.eventId, subject: prepared.subject, payloadDigest: prepared.payloadDigest, occurredAt: this.now(), reason: bounded(reason), ...(transportStatus === undefined ? {} : { transportStatus }) });
    return this.reconcileLocked(prepared, { eventId: prepared.eventId, subject: prepared.subject, payloadDigest: prepared.payloadDigest, delivery: 'uncertain' });
  }

  private async intent(eventId: string): Promise<Extract<SlackOutboxRecord, { kind: 'intent' }> | undefined> {
    return (await this.#journal.records()).find((record): record is Extract<SlackOutboxRecord, { kind: 'intent' }> => record.kind === 'intent' && record.eventId === eventId);
  }

  private async stateFor(eventId: string, subject: string, payloadDigest: string): Promise<SlackDeliveryState | undefined> {
    const matching = (await this.#journal.records()).filter((record) => record.eventId === eventId);
    if (matching.length === 0) return undefined;
    if (matching.some((record) => record.subject !== subject || record.payloadDigest !== payloadDigest)) throw new Error('Slack event identity is already bound to a different payload');
    const intent = matching.find((record): record is Extract<SlackOutboxRecord, { kind: 'intent' }> => record.kind === 'intent');
    if (intent === undefined) throw new Error('Slack outbox record has no durable intent');
    const last = [...matching].reverse().find((record) => record.kind === 'delivery' || record.kind === 'uncertain' || record.kind === 'blocked');
    const acknowledgement = [...matching].reverse().find((record): record is Extract<SlackOutboxRecord, { kind: 'acknowledged' }> => record.kind === 'acknowledged');
    return { eventId, subject, payloadDigest, delivery: last?.kind === 'delivery' ? 'delivered' : last?.kind === 'blocked' ? 'blocked' : last?.kind === 'uncertain' ? 'uncertain' : 'intended', ...(acknowledgement === undefined ? {} : { acknowledgedAt: acknowledgement.occurredAt }) };
  }

  private now(): string { return this.#clock.now().toISOString(); }
}

/** Turns an authenticated action into a sealed configured Slack notification. */
export class SlackRouterActionExecutor implements ControllerActionExecutor {
  readonly #outbox: SlackOutboxController;
  readonly #notificationFor: (action: AuthorizedAction) => SlackNotification | undefined;
  constructor(outbox: SlackOutboxController, notificationFor: (action: AuthorizedAction) => SlackNotification | undefined) {
    this.#outbox = outbox;
    this.#notificationFor = notificationFor;
  }
  async execute(action: AuthorizedAction, guard: () => Promise<void>): Promise<ActionExecutionResult> {
    if (action.request.scope.allowedOperation !== 'slack.notify') return { outcome: 'blocked', detail: 'signed action does not name the configured Slack operation' };
    const notification = this.#notificationFor(action);
    if (notification === undefined) return { outcome: 'blocked', detail: 'Slack notification is not controller configured' };
    try {
      const result = await this.#outbox.dispatch(notification, guard);
      if (result.status === 'delivered') return { outcome: result.duplicate ? 'safe_noop' : 'completed', detail: result.duplicate ? 'slack_delivery_reconciled' : 'slack_delivery_confirmed' };
      return { outcome: result.status, detail: result.reason };
    } catch (error) { return { outcome: 'blocked', detail: error instanceof Error ? error.message : 'Slack configuration rejected' }; }
  }
}

export interface FetchSlackRouterOptions {
  /** Called only in the controller. Its value is never recorded by this module. */
  authorizationHeader?: () => Promise<string | undefined>;
  /** Some existing routers use a private custom header instead of Authorization. */
  authHeaderName?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

/** Safe configured fetch transport. The caller supplies no URL or auth material. */
export class FetchSlackRouterTransport implements SlackRouterTransport {
  readonly #url: URL;
  readonly #fetcher: typeof fetch;
  readonly #authorizationHeader?: () => Promise<string | undefined>;
  readonly #authHeaderName: string;
  readonly #timeoutMs: number;
  constructor(url: string, options: FetchSlackRouterOptions | (() => Promise<string | undefined>) = {}, legacyFetcher?: typeof fetch) {
    this.#url = safeUrl(url, 'Slack router URL');
    const normalized = typeof options === 'function' ? { authorizationHeader: options, fetcher: legacyFetcher } : options;
    this.#fetcher = normalized.fetcher ?? fetch;
    this.#authorizationHeader = normalized.authorizationHeader;
    this.#authHeaderName = headerName(normalized.authHeaderName ?? 'Authorization');
    this.#timeoutMs = timeout(normalized.timeoutMs);
  }
  async post(input: SlackRouterSend): Promise<SlackRouterResponse> {
    const authorization = await this.#authorizationHeader?.();
    const response = await this.#fetcher(this.#url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs), headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(authorization === undefined ? {} : { [this.#authHeaderName]: authorization }) }, body: JSON.stringify(input.payload) });
    return { status: response.status, ...(response.ok ? { receipt: await deliveryReceipt(response, input) } : {}) };
  }
}

/** Optional configured receipt endpoint for crash/HTTP-500 reconciliation. */
export class FetchSlackRouterStatusReader implements SlackDeliveryStatusReader {
  readonly #url: URL;
  readonly #fetcher: typeof fetch;
  readonly #authorizationHeader?: () => Promise<string | undefined>;
  readonly #authHeaderName: string;
  readonly #timeoutMs: number;
  constructor(url: string, options: FetchSlackRouterOptions | (() => Promise<string | undefined>) = {}, legacyFetcher?: typeof fetch) {
    this.#url = safeUrl(url, 'Slack receipt URL');
    const normalized = typeof options === 'function' ? { authorizationHeader: options, fetcher: legacyFetcher } : options;
    this.#fetcher = normalized.fetcher ?? fetch;
    this.#authorizationHeader = normalized.authorizationHeader;
    this.#authHeaderName = headerName(normalized.authHeaderName ?? 'Authorization');
    this.#timeoutMs = timeout(normalized.timeoutMs);
  }
  async receipt(input: { eventId: string; subject: string; payloadDigest: string }): Promise<SlackDeliveryReceipt> {
    const url = new URL(this.#url);
    url.searchParams.set('eventId', input.eventId);
    url.searchParams.set('subject', input.subject);
    url.searchParams.set('payloadDigest', input.payloadDigest);
    const authorization = await this.#authorizationHeader?.();
    const response = await this.#fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs), headers: { Accept: 'application/json', ...(authorization === undefined ? {} : { [this.#authHeaderName]: authorization }) } });
    // A missing or mismatched status endpoint does not prove a post is absent.
    if (response.status === 404) return 'unavailable';
    if (!response.ok) return 'unavailable';
    const body: unknown = await response.json();
    const receipt = receiptObject(body);
    if (receipt === undefined || receipt.eventId !== input.eventId || receipt.subject !== input.subject || receipt.payloadDigest !== input.payloadDigest) return 'unavailable';
    return receipt.status === 'delivered' ? 'delivered' : receipt.status === 'absent' ? 'absent' : 'unavailable';
  }
}

interface Prepared { eventId: string; subject: string; payloadDigest: string; payload: SlackRouterPayload; }

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_RECORDS = 10_000;
const MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

function prepare(notification: SlackNotification, channels: ReadonlySet<string>): Prepared {
  if (!safe(notification.eventId) || !repository(notification.repository) || !Number.isSafeInteger(notification.pullRequest) || notification.pullRequest < 1 || !channels.has(notification.channel) || !safe(notification.text)) throw new Error('Slack notification is not a configured safe event');
  // Project identity comes from the controller-configured notification, not a
  // hardcoded installation prefix. Require a bounded, complete tracker key.
  if (notification.ticket !== undefined && !/^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,17}(?![\s\S])/.test(notification.ticket)) throw new Error('Slack ticket must be a valid issue identity');
  for (const value of [notification.title, notification.stage]) if (value !== undefined && !safe(value)) throw new Error('Slack notification contains unsafe metadata');
  const payload: SlackRouterPayload = { eventId: notification.eventId, ref: `${notification.repository}#${notification.pullRequest}`, channel: notification.channel, text: notification.text, ...(notification.ticket === undefined ? {} : { ticket: notification.ticket }), ...(notification.title === undefined ? {} : { title: notification.title }), ...(notification.stage === undefined ? {} : { stage: notification.stage }), ...(notification.resolved === true ? { resolved: true } : {}) };
  const subject = `${payload.ref}|${payload.channel}`;
  return { eventId: payload.eventId, subject, payloadDigest: digest(payload), payload };
}

function recordAt(value: unknown): SlackOutboxRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Slack outbox journal is corrupt');
  const record = value as Record<string, unknown>;
  if (record.format !== 'faktori.slack-outbox/v1' || !['intent', 'delivery', 'uncertain', 'blocked', 'acknowledged'].includes(String(record.kind)) || !safe(String(record.eventId ?? '')) || !safe(String(record.subject ?? '')) || !/^[a-f0-9]{64}$/.test(String(record.payloadDigest ?? '')) || !safe(String(record.occurredAt ?? ''))) throw new Error('Slack outbox journal record is invalid');
  if (record.kind === 'intent') {
    const payload = payloadAt(record.payload);
    if (payload === undefined || record.subject !== `${payload.ref}|${payload.channel}` || record.eventId !== payload.eventId || record.payloadDigest !== digest(payload)) throw new Error('Slack outbox intent record is invalid');
  }
  if ((record.kind === 'uncertain' || record.kind === 'blocked') && !safe(String(record.reason ?? ''))) throw new Error('Slack outbox outcome record is invalid');
  if (record.kind === 'acknowledged' && !safe(String(record.acknowledgmentId ?? ''))) throw new Error('Slack outbox acknowledgement record is invalid');
  return record as unknown as SlackOutboxRecord;
}

function logicalChannel(value: string): boolean { return /^[a-z][a-z0-9-]{0,63}$/.test(value); }
function repository(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value); }
function safe(value: string): boolean { return typeof value === 'string' && value.trim().length > 0 && value.length <= 16_384 && !value.includes('\0'); }
function bounded(value: string): string { return safe(value) ? value.slice(0, 512) : 'router_transport_failed'; }
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function canonical(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`; }
function lockName(kind: string, key: string): string { return `${kind}-${createHash('sha256').update(`faktori-slack:${key}`).digest('hex')}.lock`; }
async function claim(path: string): Promise<Awaited<ReturnType<typeof open>>> { for (let attempt = 0; attempt < 200; attempt += 1) { try { /* O_EXCL rejects an existing symlink without following it; macOS rejects O_NOFOLLOW combined with O_CREAT. */ const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8'); await handle.sync(); await privateRegularFile(path, 'Slack outbox lock'); return handle; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await new Promise<void>((done) => setTimeout(done, 10)); } } throw new Error('slack_claim_unresolved'); }
async function appendNoFollow(path: string): Promise<Awaited<ReturnType<typeof open>>> { try { await privateRegularFile(path, 'Slack outbox journal'); return await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } try { /* O_EXCL is no-follow creation: a competing symlink is an EEXIST, never opened. */ return await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await privateRegularFile(path, 'Slack outbox journal'); return open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW); } }
function safeUrl(value: string, label: string): URL { const url = new URL(value); if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error(`${label} must be HTTPS or loopback HTTP without embedded credentials`); return url; }
function headerName(value: string): string { if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(value)) throw new Error('Slack auth header name is invalid'); return value; }
function timeout(value: number | undefined): number { const result = value ?? DEFAULT_TIMEOUT_MS; if (!Number.isSafeInteger(result) || result < 1 || result > 120_000) throw new Error('Slack fetch timeout must be a bounded positive integer'); return result; }
interface RouterReceiptBody { status: string; eventId: string; subject: string; payloadDigest: string; channelId?: string; messageTs?: string; }
function receiptMatches(receipt: RouterReceiptBody | SlackRouterDeliveryReceipt | undefined, input: Pick<SlackRouterSend, 'eventId' | 'subject' | 'payloadDigest'>): receipt is SlackRouterDeliveryReceipt { return receipt !== undefined && receipt.eventId === input.eventId && receipt.subject === input.subject && receipt.payloadDigest === input.payloadDigest && safe(receipt.channelId ?? '') && safe(receipt.messageTs ?? ''); }
async function deliveryReceipt(response: Response, input: SlackRouterSend): Promise<SlackRouterDeliveryReceipt | undefined> { try { const receipt = receiptObject(await response.json()); return receipt !== undefined && receipt.status === 'delivered' && receiptMatches(receipt, input) ? { eventId: receipt.eventId, subject: receipt.subject, payloadDigest: receipt.payloadDigest, channelId: receipt.channelId, messageTs: receipt.messageTs } : undefined; } catch { return undefined; } }
function receiptObject(value: unknown): RouterReceiptBody | undefined { if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined; const record = value as Record<string, unknown>; return typeof record.status === 'string' && typeof record.eventId === 'string' && typeof record.subject === 'string' && typeof record.payloadDigest === 'string' && (record.channelId === undefined || typeof record.channelId === 'string') && (record.messageTs === undefined || typeof record.messageTs === 'string') ? record as unknown as RouterReceiptBody : undefined; }
function payloadAt(value: unknown): SlackRouterPayload | undefined { if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined; const payload = value as Record<string, unknown>; return typeof payload.eventId === 'string' && typeof payload.ref === 'string' && typeof payload.channel === 'string' && typeof payload.text === 'string' && (payload.ticket === undefined || typeof payload.ticket === 'string') && (payload.title === undefined || typeof payload.title === 'string') && (payload.stage === undefined || typeof payload.stage === 'string') && (payload.resolved === undefined || payload.resolved === true) ? payload as unknown as SlackRouterPayload : undefined; }
async function privateDirectory(path: string, label: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); const status = await lstat(path); if (status.isSymbolicLink() || !status.isDirectory() || (status.mode & 0o077) !== 0 || !owned(status)) throw new Error(`${label} must be a private controller-owned real directory`); }
async function privateRegularFile(path: string, label: string): Promise<Awaited<ReturnType<typeof lstat>>> { const status = await lstat(path); if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o077) !== 0 || !owned(status)) throw new Error(`${label} must be a private controller-owned regular file`); return status; }
function owned(status: { uid: number }): boolean { return typeof process.getuid !== 'function' || status.uid === process.getuid(); }
