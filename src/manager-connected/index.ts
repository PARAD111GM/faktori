import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export interface ManagerConnectedManager {
  threadId: string;
  title: string;
}

export interface ManagerConnectedSessionAssignment {
  id: string;
  threadId: string;
  title: string;
  role: string;
  productId: string;
  podId?: string;
  planId?: string;
  phaseId?: string;
  ticketId?: string;
}

export interface ManagerConnectedConfig {
  directory: string;
  manager: ManagerConnectedManager;
  sessions: ManagerConnectedSessionAssignment[];
}

export type ManagerConnectedRequestStatus =
  | 'queued'
  | 'claimed'
  | 'submitted'
  | 'completed'
  | 'uncertain'
  | 'cancelled';

export type ManagerConnectedAction =
  | { type: 'enqueue'; id: string; sessionId: string; title: string; instruction: string }
  | { type: 'claim'; id: string }
  | { type: 'submitted'; id: string }
  | { type: 'complete'; id: string; threadId: string; summary: string }
  | { type: 'heartbeat' }
  | { type: 'cancel'; id: string };

export interface ManagerConnectedCompletionReport {
  sourceThreadId: string;
  observedByManagerThreadId: string;
  summary: string;
  observedAt: string;
  /** A trusted Manager observed the callback. This is not product acceptance. */
  delivery: 'reported';
  productAcceptance: 'not_evaluated';
}

export interface ManagerConnectedRequestSnapshot {
  id: string;
  sessionId: string;
  title: string;
  status: ManagerConnectedRequestStatus;
  assignment: ManagerConnectedSessionAssignment;
  callbackManager: ManagerConnectedManager;
  createdAt: string;
  claimedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  uncertainAt?: string;
  uncertaintyReason?: 'restart_requires_reconciliation';
  report?: ManagerConnectedCompletionReport;
  /** The exact instruction is intentionally available only from a successful claim. */
  instructionAvailable: true;
}

export interface ManagerConnectedSnapshot {
  sequence: number;
  manager: ManagerConnectedManager;
  sessions: ManagerConnectedSessionAssignment[];
  requests: ManagerConnectedRequestSnapshot[];
  lastHeartbeatAt?: string;
}

export interface ManagerConnectedClaim {
  format: 'faktori.manager-connected-claim/v1';
  requestId: string;
  sessionId: string;
  title: string;
  instruction: string;
  targetThreadId: string;
  assignment: ManagerConnectedSessionAssignment;
  callback: {
    managerThreadId: string;
    requestId: string;
    requiredSourceThreadId: string;
  };
}

export type ManagerConnectedOperationResult =
  | { type: 'enqueue'; duplicate: boolean; request: ManagerConnectedRequestSnapshot }
  | { type: 'claim'; claim: ManagerConnectedClaim }
  | { type: 'submitted' | 'complete' | 'cancel'; request: ManagerConnectedRequestSnapshot }
  | { type: 'heartbeat'; snapshot: ManagerConnectedSnapshot };

export class ManagerConnectedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ManagerConnectedError';
    this.code = code;
  }
}

type InputRecord = Record<string, unknown>;

interface DurableRequest {
  id: string;
  sessionId: string;
  title: string;
  instruction: string;
  status: ManagerConnectedRequestStatus;
  assignment: ManagerConnectedSessionAssignment;
  callbackManager: ManagerConnectedManager;
  createdAt: string;
  claimedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  uncertainAt?: string;
  uncertaintyReason?: 'restart_requires_reconciliation';
  report?: ManagerConnectedCompletionReport;
}

type EventType = 'queued' | 'claimed' | 'submission_observed' | 'response_observed'
  | 'cancelled' | 'restart_requires_reconciliation' | 'heartbeat';

interface ManagerConnectedEvent {
  format: 'faktori.manager-connected-event/v1';
  sequence: number;
  at: string;
  type: EventType;
  request?: DurableRequest;
}

type Listener = () => void;

const SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_STATUSES = new Set<ManagerConnectedRequestStatus>(['queued', 'claimed', 'submitted', 'completed', 'uncertain', 'cancelled']);
const EVENT_TYPES = new Set<EventType>(['queued', 'claimed', 'submission_observed', 'response_observed', 'cancelled', 'restart_requires_reconciliation', 'heartbeat']);
const SAFE_TEXT_LIMIT = 16_000;
// Keep the Console-facing projection aligned with the runtime's existing public-evidence filters.
const PRIVATE_OR_SECRET = /(?:^|[^a-z0-9_])(session(?:[_ -]?id)?|credential|secret|api[_ -]?key|bearer|authorization|private[_ -]?(?:reasoning|path)|authority)(?:$|[^a-z0-9_])|(^|[\\/])(Users|home)([\\/])|\.codex|\.claude/i;
const CREDENTIAL_SIGNATURE = /(?:\bsk-(?:(?:proj|live|test)-)?[A-Za-z0-9_-]{8,}|\b(?:[rs]k_(?:live|test)|whsec)_[A-Za-z0-9]{8,}|\b(?:gh[opusr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bxox[aboprs]-[A-Za-z0-9-]{10,}|\bnpm_[A-Za-z0-9]{12,}|\bpypi-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const ABSOLUTE_PATH = /(?:^|[\s=:"'(])(?:\/(?!\/)(?:\S*)|[A-Za-z]:\\\S*|\\\\[^\s\\]+\\\S*)/;
const FILE_URI = /\bfile:\/\//i;

function fail(code: string, message: string): never {
  throw new ManagerConnectedError(code, message);
}

function record(value: unknown, path: string): InputRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return fail('invalid_input', `${path} must be a plain object`);
  }
  return value as InputRecord;
}

function exactKeys(value: InputRecord, allowed: readonly string[], path: string): void {
  const supported = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) fail('invalid_input', `${path}.${key} is not supported`);
  }
}

function boundedText(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || value.includes('\u0000')) {
    return fail('invalid_input', `${path} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function slug(value: unknown, path: string): string {
  const parsed = boundedText(value, path, 80);
  if (!SLUG.test(parsed)) return fail('invalid_input', `${path} must be a lowercase slug`);
  return parsed;
}

function uuid(value: unknown, path: string): string {
  const parsed = boundedText(value, path, 36);
  if (!UUID.test(parsed)) return fail('invalid_input', `${path} must be a UUID`);
  return parsed.toLowerCase();
}

function requestIdentity(value: unknown, path: string): string {
  const parsed = boundedText(value, path, 80);
  if (UUID.test(parsed)) return parsed.toLowerCase();
  // Stable slugs are retained for the proven relay protocol; the Console uses UUIDs.
  if (SLUG.test(parsed)) return parsed;
  return fail('invalid_input', `${path} must be a UUID or lowercase stable slug`);
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return fail('journal_corrupt', `${path} must be a timestamp`);
  return new Date(value).toISOString();
}

function optionalSlug(input: InputRecord, key: 'podId' | 'planId' | 'phaseId' | 'ticketId', path: string): string | undefined {
  return input[key] === undefined ? undefined : slug(input[key], `${path}.${key}`);
}

function parseManager(value: unknown, path: string): ManagerConnectedManager {
  const input = record(value, path);
  exactKeys(input, ['threadId', 'title'], path);
  return {
    threadId: uuid(input.threadId, `${path}.threadId`),
    title: boundedText(input.title, `${path}.title`, 256),
  };
}

function parseSession(value: unknown, path: string): ManagerConnectedSessionAssignment {
  const input = record(value, path);
  exactKeys(input, ['id', 'threadId', 'title', 'role', 'productId', 'podId', 'planId', 'phaseId', 'ticketId'], path);
  return {
    id: slug(input.id, `${path}.id`),
    threadId: uuid(input.threadId, `${path}.threadId`),
    title: boundedText(input.title, `${path}.title`, 256),
    role: boundedText(input.role, `${path}.role`, 128),
    productId: slug(input.productId, `${path}.productId`),
    ...(optionalSlug(input, 'podId', path) === undefined ? {} : { podId: optionalSlug(input, 'podId', path) }),
    ...(optionalSlug(input, 'planId', path) === undefined ? {} : { planId: optionalSlug(input, 'planId', path) }),
    ...(optionalSlug(input, 'phaseId', path) === undefined ? {} : { phaseId: optionalSlug(input, 'phaseId', path) }),
    ...(optionalSlug(input, 'ticketId', path) === undefined ? {} : { ticketId: optionalSlug(input, 'ticketId', path) }),
  };
}

export function parseManagerConnectedConfig(value: unknown): ManagerConnectedConfig {
  const input = record(value, 'managerConnected');
  exactKeys(input, ['directory', 'manager', 'sessions'], 'managerConnected');
  const directoryInput = boundedText(input.directory, 'managerConnected.directory', 4_096);
  if (!isAbsolute(directoryInput)) fail('invalid_input', 'managerConnected.directory must be absolute');
  const directory = resolve(directoryInput);
  if (!Array.isArray(input.sessions) || input.sessions.length === 0 || input.sessions.length > 256) {
    fail('invalid_input', 'managerConnected.sessions must contain 1-256 explicit assignments');
  }
  const manager = parseManager(input.manager, 'managerConnected.manager');
  const sessions = input.sessions.map((session, index) => parseSession(session, `managerConnected.sessions[${index}]`));
  const ids = new Set<string>();
  const threads = new Set<string>();
  for (const session of sessions) {
    if (ids.has(session.id)) fail('invalid_input', `managerConnected.sessions repeats id ${session.id}`);
    if (threads.has(session.threadId)) fail('invalid_input', `managerConnected.sessions repeats threadId ${session.threadId}`);
    if (session.threadId === manager.threadId) fail('invalid_input', `managerConnected session ${session.id} cannot target the Manager thread`);
    ids.add(session.id);
    threads.add(session.threadId);
  }
  return structuredClone({ directory, manager, sessions });
}

function parseAction(value: unknown): ManagerConnectedAction {
  const input = record(value, 'action');
  const type = input.type;
  if (type === 'enqueue') {
    exactKeys(input, ['type', 'id', 'sessionId', 'title', 'instruction'], 'action');
    return { type, id: requestIdentity(input.id, 'action.id'), sessionId: slug(input.sessionId, 'action.sessionId'), title: boundedText(input.title, 'action.title', 256), instruction: boundedText(input.instruction, 'action.instruction', SAFE_TEXT_LIMIT) };
  }
  if (type === 'claim' || type === 'submitted' || type === 'cancel') {
    exactKeys(input, ['type', 'id'], 'action');
    return { type, id: requestIdentity(input.id, 'action.id') };
  }
  if (type === 'complete') {
    exactKeys(input, ['type', 'id', 'threadId', 'summary'], 'action');
    return { type, id: requestIdentity(input.id, 'action.id'), threadId: uuid(input.threadId, 'action.threadId'), summary: boundedText(input.summary, 'action.summary', SAFE_TEXT_LIMIT) };
  }
  if (type === 'heartbeat') {
    exactKeys(input, ['type'], 'action');
    return { type };
  }
  return fail('invalid_input', 'action.type is unsupported');
}

function stable(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('journal_corrupt', 'journal contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const input = record(value, 'journal value');
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stable(input[key])}`).join(',')}}`;
}

function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function safeProjectionText(value: string): string {
  return value.length <= SAFE_TEXT_LIMIT && !PRIVATE_OR_SECRET.test(value) && !CREDENTIAL_SIGNATURE.test(value) && !ABSOLUTE_PATH.test(value) && !FILE_URI.test(value) ? value : '[redacted]';
}

function safeManager(manager: ManagerConnectedManager): ManagerConnectedManager {
  return { threadId: manager.threadId, title: safeProjectionText(manager.title) };
}

function safeAssignment(assignment: ManagerConnectedSessionAssignment): ManagerConnectedSessionAssignment {
  return { ...assignment, title: safeProjectionText(assignment.title), role: safeProjectionText(assignment.role) };
}

function publicRequest(request: DurableRequest): ManagerConnectedRequestSnapshot {
  return {
    id: request.id,
    sessionId: request.sessionId,
    title: safeProjectionText(request.title),
    status: request.status,
    assignment: safeAssignment(request.assignment),
    callbackManager: safeManager(request.callbackManager),
    createdAt: request.createdAt,
    ...(request.claimedAt === undefined ? {} : { claimedAt: request.claimedAt }),
    ...(request.submittedAt === undefined ? {} : { submittedAt: request.submittedAt }),
    ...(request.completedAt === undefined ? {} : { completedAt: request.completedAt }),
    ...(request.cancelledAt === undefined ? {} : { cancelledAt: request.cancelledAt }),
    ...(request.uncertainAt === undefined ? {} : { uncertainAt: request.uncertainAt }),
    ...(request.uncertaintyReason === undefined ? {} : { uncertaintyReason: request.uncertaintyReason }),
    ...(request.report === undefined ? {} : { report: { ...request.report, summary: safeProjectionText(request.report.summary) } }),
    instructionAvailable: true,
  };
}

function parseReport(value: unknown, path: string): ManagerConnectedCompletionReport {
  const input = record(value, path);
  exactKeys(input, ['sourceThreadId', 'observedByManagerThreadId', 'summary', 'observedAt', 'delivery', 'productAcceptance'], path);
  if (input.delivery !== 'reported' || input.productAcceptance !== 'not_evaluated') fail('journal_corrupt', `${path} has unsupported delivery semantics`);
  return {
    sourceThreadId: uuid(input.sourceThreadId, `${path}.sourceThreadId`),
    observedByManagerThreadId: uuid(input.observedByManagerThreadId, `${path}.observedByManagerThreadId`),
    summary: boundedText(input.summary, `${path}.summary`, SAFE_TEXT_LIMIT),
    observedAt: timestamp(input.observedAt, `${path}.observedAt`),
    delivery: 'reported',
    productAcceptance: 'not_evaluated',
  };
}

function parseDurableRequest(value: unknown, path: string): DurableRequest {
  const input = record(value, path);
  exactKeys(input, ['id', 'sessionId', 'title', 'instruction', 'status', 'assignment', 'callbackManager', 'createdAt', 'claimedAt', 'submittedAt', 'completedAt', 'cancelledAt', 'uncertainAt', 'uncertaintyReason', 'report'], path);
  if (typeof input.status !== 'string' || !REQUEST_STATUSES.has(input.status as ManagerConnectedRequestStatus)) fail('journal_corrupt', `${path}.status is invalid`);
  const status = input.status as ManagerConnectedRequestStatus;
  const optionalTimestamp = (key: 'claimedAt' | 'submittedAt' | 'completedAt' | 'cancelledAt' | 'uncertainAt'): string | undefined => input[key] === undefined ? undefined : timestamp(input[key], `${path}.${key}`);
  const request: DurableRequest = {
    id: requestIdentity(input.id, `${path}.id`),
    sessionId: slug(input.sessionId, `${path}.sessionId`),
    title: boundedText(input.title, `${path}.title`, 256),
    instruction: boundedText(input.instruction, `${path}.instruction`, SAFE_TEXT_LIMIT),
    status,
    assignment: parseSession(input.assignment, `${path}.assignment`),
    callbackManager: parseManager(input.callbackManager, `${path}.callbackManager`),
    createdAt: timestamp(input.createdAt, `${path}.createdAt`),
    ...(optionalTimestamp('claimedAt') === undefined ? {} : { claimedAt: optionalTimestamp('claimedAt') }),
    ...(optionalTimestamp('submittedAt') === undefined ? {} : { submittedAt: optionalTimestamp('submittedAt') }),
    ...(optionalTimestamp('completedAt') === undefined ? {} : { completedAt: optionalTimestamp('completedAt') }),
    ...(optionalTimestamp('cancelledAt') === undefined ? {} : { cancelledAt: optionalTimestamp('cancelledAt') }),
    ...(optionalTimestamp('uncertainAt') === undefined ? {} : { uncertainAt: optionalTimestamp('uncertainAt') }),
    ...(input.uncertaintyReason === undefined ? {} : { uncertaintyReason: input.uncertaintyReason === 'restart_requires_reconciliation' ? input.uncertaintyReason : fail('journal_corrupt', `${path}.uncertaintyReason is invalid`) }),
    ...(input.report === undefined ? {} : { report: parseReport(input.report, `${path}.report`) }),
  };
  if (request.sessionId !== request.assignment.id) fail('journal_corrupt', `${path} session assignment identity changed`);
  const required: Partial<Record<ManagerConnectedRequestStatus, keyof DurableRequest>> = { claimed: 'claimedAt', submitted: 'submittedAt', completed: 'completedAt', cancelled: 'cancelledAt', uncertain: 'uncertainAt' };
  const requiredField = required[status];
  if (requiredField !== undefined && request[requiredField] === undefined) fail('journal_corrupt', `${path}.${String(requiredField)} is required for ${status}`);
  if (status === 'completed' && request.report === undefined) fail('journal_corrupt', `${path}.report is required for completed`);
  if (status === 'uncertain' && request.uncertaintyReason !== 'restart_requires_reconciliation') fail('journal_corrupt', `${path}.uncertaintyReason is required for uncertain`);
  if (request.report !== undefined && (request.report.sourceThreadId !== request.assignment.threadId
    || request.report.observedByManagerThreadId !== request.callbackManager.threadId
    || request.report.observedAt !== request.completedAt)) {
    fail('journal_corrupt', `${path}.report does not match its immutable assignment and completion`);
  }
  return request;
}

function parseEvent(value: unknown, expectedSequence: number): ManagerConnectedEvent {
  try {
    const input = record(value, `journal event ${expectedSequence}`);
    exactKeys(input, ['format', 'sequence', 'at', 'type', 'request'], `journal event ${expectedSequence}`);
    if (input.format !== 'faktori.manager-connected-event/v1' || input.sequence !== expectedSequence || typeof input.type !== 'string' || !EVENT_TYPES.has(input.type as EventType)) {
      fail('journal_corrupt', `journal event ${expectedSequence} has an invalid envelope`);
    }
    const type = input.type as EventType;
    const event: ManagerConnectedEvent = {
      format: 'faktori.manager-connected-event/v1',
      sequence: expectedSequence,
      at: timestamp(input.at, `journal event ${expectedSequence}.at`),
      type,
      ...(input.request === undefined ? {} : { request: parseDurableRequest(input.request, `journal event ${expectedSequence}.request`) }),
    };
    if ((type === 'heartbeat') !== (event.request === undefined)) fail('journal_corrupt', `journal event ${expectedSequence} has an invalid request payload`);
    return event;
  } catch (error) {
    if (error instanceof ManagerConnectedError && error.code !== 'journal_corrupt') {
      throw new ManagerConnectedError('journal_corrupt', `invalid committed journal event ${expectedSequence}: ${error.message}`);
    }
    throw error;
  }
}

function immutableRequest(request: DurableRequest): unknown {
  return {
    id: request.id,
    sessionId: request.sessionId,
    title: request.title,
    instruction: request.instruction,
    assignment: request.assignment,
    callbackManager: request.callbackManager,
    createdAt: request.createdAt,
  };
}

function applyEvent(requests: Map<string, DurableRequest>, event: ManagerConnectedEvent): void {
  if (event.type === 'heartbeat') return;
  const next = event.request as DurableRequest;
  const previous = requests.get(next.id);
  if (event.type === 'queued') {
    const exactQueued = { ...(immutableRequest(next) as object), status: 'queued' };
    if (previous !== undefined || !same(next, exactQueued)) fail('journal_corrupt', `request ${next.id} has an invalid queued event`);
    requests.set(next.id, structuredClone(next));
    return;
  }
  if (previous === undefined || !same(immutableRequest(previous), immutableRequest(next))) fail('journal_corrupt', `request ${next.id} changed immutable identity`);
  const valid = event.type === 'claimed' ? previous.status === 'queued' && same(next, { ...previous, status: 'claimed', claimedAt: next.claimedAt })
    : event.type === 'submission_observed' ? previous.status === 'claimed' && same(next, { ...previous, status: 'submitted', submittedAt: next.submittedAt })
      : event.type === 'response_observed' ? ['submitted', 'uncertain'].includes(previous.status) && same(next, { ...previous, status: 'completed', completedAt: next.completedAt, report: next.report })
        : event.type === 'cancelled' ? previous.status === 'queued' && same(next, { ...previous, status: 'cancelled', cancelledAt: next.cancelledAt })
          : event.type === 'restart_requires_reconciliation' ? ['claimed', 'submitted'].includes(previous.status)
            && same(next, { ...previous, status: 'uncertain', uncertainAt: next.uncertainAt, uncertaintyReason: 'restart_requires_reconciliation' })
            : false;
  if (!valid) fail('journal_corrupt', `request ${next.id} has an invalid ${event.type} transition`);
  requests.set(next.id, structuredClone(next));
}

async function fullWrite(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    if (result.bytesWritten < 1) fail('journal_write_failed', 'journal write made no progress');
    offset += result.bytesWritten;
  }
}

async function quarantineTornTail(path: string, journal: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0 || bytes.at(-1) === 0x0a) return bytes;
  const boundary = bytes.lastIndexOf(0x0a) + 1;
  const tail = bytes.subarray(boundary);
  const quarantinePath = `${path}.incomplete-${randomUUID()}`;
  const quarantine = await open(quarantinePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await fullWrite(quarantine, tail);
    await quarantine.sync();
  } finally {
    await quarantine.close();
  }
  await journal.truncate(boundary);
  await journal.sync();
  return bytes.subarray(0, boundary);
}

export class ManagerConnectedStore {
  readonly #config: ManagerConnectedConfig;
  readonly #lockPath: string;
  readonly #lockIdentity: string;
  readonly #journalPath: string;
  readonly #requests = new Map<string, DurableRequest>();
  readonly #listeners = new Set<Listener>();
  #lockHandle?: Awaited<ReturnType<typeof open>>;
  #journalHandle?: Awaited<ReturnType<typeof open>>;
  #sequence = 0;
  #lastHeartbeatAt?: string;
  #closed = false;
  #poisoned = false;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(config: ManagerConnectedConfig) {
    this.#config = structuredClone(config);
    this.#lockPath = join(config.directory, 'owner.lock');
    this.#journalPath = join(config.directory, 'events.jsonl');
    this.#lockIdentity = `${process.pid}:${randomUUID()}`;
  }

  static async open(value: ManagerConnectedConfig): Promise<ManagerConnectedStore> {
    const config = parseManagerConnectedConfig(value);
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    const details = await lstat(config.directory);
    const owner = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0 || (owner !== undefined && details.uid !== owner)) {
      fail('invalid_directory', 'manager-connected directory must be a private owner-owned real directory');
    }
    const store = new ManagerConnectedStore(config);
    await store.acquire();
    try {
      await store.recover();
      for (const request of [...store.#requests.values()]) {
        if (request.status !== 'claimed' && request.status !== 'submitted') continue;
        const at = new Date().toISOString();
        await store.append('restart_requires_reconciliation', { ...request, status: 'uncertain', uncertainAt: at, uncertaintyReason: 'restart_requires_reconciliation' });
      }
      return store;
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
  }

  snapshot(): ManagerConnectedSnapshot {
    this.assertOpen();
    return {
      sequence: this.#sequence,
      manager: safeManager(this.#config.manager),
      sessions: this.#config.sessions.map(safeAssignment),
      requests: [...this.#requests.values()].map(publicRequest),
      ...(this.#lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: this.#lastHeartbeatAt }),
    };
  }

  onChange(listener: Listener): () => void {
    this.assertOpen();
    if (typeof listener !== 'function') fail('invalid_input', 'listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async operate(value: unknown): Promise<ManagerConnectedOperationResult> {
    /**
     * `complete` is trusted only because the containing service authenticates
     * the active Manager. This store checks the reported source/correlation but
     * cannot independently prove which provider task sent a callback.
     */
    const action = parseAction(value);
    this.assertMutable();
    const task = async (): Promise<ManagerConnectedOperationResult> => this.operateExclusive(action);
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail.catch(() => undefined);
    this.#listeners.clear();
    await this.#journalHandle?.close();
    this.#journalHandle = undefined;
    await this.#lockHandle?.close();
    this.#lockHandle = undefined;
    try {
      const identity = await readFile(this.#lockPath, 'utf8');
      if (identity === `${this.#lockIdentity}\n`) await unlink(this.#lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async acquire(): Promise<void> {
    let created = false;
    try {
      this.#lockHandle = await open(this.#lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      await fullWrite(this.#lockHandle, Buffer.from(`${this.#lockIdentity}\n`));
      await this.#lockHandle.sync();
    } catch (error) {
      await this.#lockHandle?.close().catch(() => undefined);
      this.#lockHandle = undefined;
      if (created) await unlink(this.#lockPath).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('directory_owned', 'manager-connected directory is already owned or was not cleanly closed; verify the prior owner is dead before retiring the lock');
      throw error;
    }
  }

  private async recover(): Promise<void> {
    try {
      this.#journalHandle = await open(this.#journalPath, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('invalid_journal', 'manager-connected journal cannot be a symbolic link');
      throw error;
    }
    const journalDetails = await this.#journalHandle.stat();
    const owner = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (!journalDetails.isFile() || (journalDetails.mode & 0o077) !== 0 || (owner !== undefined && journalDetails.uid !== owner)) {
      fail('invalid_journal', 'manager-connected journal must be a private owner-owned regular file');
    }
    let bytes: Buffer = await this.#journalHandle.readFile();
    bytes = await quarantineTornTail(this.#journalPath, this.#journalHandle, bytes);
    const text = bytes.toString('utf8');
    const lines = text.split('\n');
    let expected = 1;
    for (const line of lines) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line) as unknown; } catch { fail('journal_corrupt', `malformed committed journal event ${expected}`); }
      const event = parseEvent(parsed, expected);
      applyEvent(this.#requests, event);
      if (event.type === 'heartbeat') this.#lastHeartbeatAt = event.at;
      expected += 1;
    }
    this.#sequence = expected - 1;
  }

  private async append(type: EventType, request?: DurableRequest): Promise<void> {
    const at = new Date().toISOString();
    const event: ManagerConnectedEvent = {
      format: 'faktori.manager-connected-event/v1',
      sequence: this.#sequence + 1,
      at,
      type,
      ...(request === undefined ? {} : { request: structuredClone(request) }),
    };
    try {
      await fullWrite(this.#journalHandle as Awaited<ReturnType<typeof open>>, Buffer.from(`${stable(event)}\n`));
      await this.#journalHandle?.sync();
    } catch {
      // The bytes may be absent, torn, or fully visible without a confirmed fsync.
      // Keep ownership, poison this process, and require restart recovery.
      this.#poisoned = true;
      fail('journal_uncertain', 'manager-connected journal append was not durably confirmed; restart and reconcile before further mutations');
    }
    applyEvent(this.#requests, event);
    this.#sequence = event.sequence;
    if (type === 'heartbeat') this.#lastHeartbeatAt = at;
    for (const listener of this.#listeners) {
      try { listener(); } catch { /* Observers cannot roll back a durable transition. */ }
    }
  }

  private currentRequest(id: string): DurableRequest {
    const request = this.#requests.get(id);
    if (request === undefined) return fail('request_not_found', `manager-connected request ${id} was not found`);
    return request;
  }

  private currentAssignment(request: DurableRequest): ManagerConnectedSessionAssignment {
    const assignment = this.#config.sessions.find((session) => session.id === request.sessionId);
    if (assignment === undefined) return fail('target_revoked', `session assignment ${request.sessionId} is no longer authorized`);
    if (!same(assignment, request.assignment)) return fail('assignment_changed', `session assignment ${request.sessionId} changed after enqueue; cancel and enqueue a new request identity`);
    if (!same(this.#config.manager, request.callbackManager)) return fail('manager_assignment_changed', 'Manager callback assignment changed after enqueue; cancel and enqueue a new request identity');
    return assignment;
  }

  private async operateExclusive(action: ManagerConnectedAction): Promise<ManagerConnectedOperationResult> {
    this.assertMutable();
    if (action.type === 'heartbeat') {
      await this.append('heartbeat');
      return { type: 'heartbeat', snapshot: this.snapshot() };
    }
    if (action.type === 'enqueue') {
      const assignment = this.#config.sessions.find((session) => session.id === action.sessionId);
      if (assignment === undefined) fail('target_revoked', `session assignment ${action.sessionId} is not authorized`);
      const candidate = {
        id: action.id,
        sessionId: action.sessionId,
        title: action.title,
        instruction: action.instruction,
        assignment,
        callbackManager: this.#config.manager,
      };
      const existing = this.#requests.get(action.id);
      if (existing !== undefined) {
        const bound = { id: existing.id, sessionId: existing.sessionId, title: existing.title, instruction: existing.instruction, assignment: existing.assignment, callbackManager: existing.callbackManager };
        if (!same(candidate, bound)) fail('request_identity_conflict', `request identity ${action.id} already binds different content or assignments`);
        return { type: 'enqueue', duplicate: true, request: publicRequest(existing) };
      }
      const request: DurableRequest = { ...candidate, status: 'queued', createdAt: new Date().toISOString() };
      await this.append('queued', request);
      return { type: 'enqueue', duplicate: false, request: publicRequest(request) };
    }
    const request = this.currentRequest(action.id);
    if (action.type === 'claim') {
      const assignment = this.currentAssignment(request);
      if (request.status !== 'queued') fail('claim_not_available', `request ${request.id} is ${request.status}; claimed work is never retried automatically`);
      const claimedAt = new Date().toISOString();
      await this.append('claimed', { ...request, status: 'claimed', claimedAt });
      return {
        type: 'claim',
        claim: {
          format: 'faktori.manager-connected-claim/v1',
          requestId: request.id,
          sessionId: request.sessionId,
          title: request.title,
          instruction: request.instruction,
          targetThreadId: assignment.threadId,
          assignment: structuredClone(assignment),
          callback: { managerThreadId: request.callbackManager.threadId, requestId: request.id, requiredSourceThreadId: assignment.threadId },
        },
      };
    }
    if (action.type === 'submitted') {
      if (request.status === 'submitted') return { type: 'submitted', request: publicRequest(request) };
      if (request.status !== 'claimed') fail('submission_not_claimed', `request ${request.id} is ${request.status}; submission cannot be recorded`);
      const submittedAt = new Date().toISOString();
      const submitted: DurableRequest = { ...request, status: 'submitted', submittedAt };
      await this.append('submission_observed', submitted);
      return { type: 'submitted', request: publicRequest(submitted) };
    }
    if (action.type === 'complete') {
      if (this.#config.manager.threadId !== request.callbackManager.threadId) {
        fail('manager_assignment_changed', `request ${request.id} belongs to a different Manager callback task; restore that Manager assignment before reconciliation`);
      }
      if (action.threadId !== request.assignment.threadId) fail('response_source_mismatch', `request ${request.id} expected a callback from ${request.assignment.threadId}`);
      if (request.status === 'completed') {
        if (request.report?.sourceThreadId !== action.threadId || request.report.summary !== action.summary) fail('completion_conflict', `request ${request.id} already has a different completion report`);
        return { type: 'complete', request: publicRequest(request) };
      }
      if (!['submitted', 'uncertain'].includes(request.status)) fail('request_not_dispatched', `request ${request.id} has no recorded submission to reconcile`);
      const completedAt = new Date().toISOString();
      const completed: DurableRequest = {
        ...request,
        status: 'completed',
        completedAt,
        report: {
          sourceThreadId: action.threadId,
          observedByManagerThreadId: this.#config.manager.threadId,
          summary: action.summary,
          observedAt: completedAt,
          delivery: 'reported',
          productAcceptance: 'not_evaluated',
        },
      };
      await this.append('response_observed', completed);
      return { type: 'complete', request: publicRequest(completed) };
    }
    if (request.status !== 'queued') fail('cancel_not_queued', `request ${request.id} is ${request.status}; only queued requests can be cancelled`);
    const cancelledAt = new Date().toISOString();
    const cancelled: DurableRequest = { ...request, status: 'cancelled', cancelledAt };
    await this.append('cancelled', cancelled);
    return { type: 'cancel', request: publicRequest(cancelled) };
  }

  private assertOpen(): void {
    if (this.#closed || this.#journalHandle === undefined) fail('store_closed', 'manager-connected store is closed');
  }

  private assertMutable(): void {
    this.assertOpen();
    if (this.#poisoned) fail('store_requires_restart', 'manager-connected journal outcome is uncertain; restart and reconcile before further mutations');
  }
}
