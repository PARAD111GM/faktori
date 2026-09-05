import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ActionReceipt, ActionRequest, ActionScope, RunEvent } from '../runtime/contracts.ts';
import { AppendOnlyJournal } from '../runtime/journal.ts';

export interface ActionGrantVerification {
  algorithm: 'hmac-sha256';
  keyId: string;
}

/**
 * This is deliberately safe to retain in an operational journal.  It names a
 * grant and its verification scheme, but is not sufficient to sign a request.
 */
export interface PublicActionGrant {
  format: 'faktori.action-grant/v1';
  grantId: string;
  runId: string;
  scope: ActionScope;
  authorityEpoch: number;
  issuedAt: string;
  verification: ActionGrantVerification;
}

/** A one-time worker bootstrap payload. Never place this object in a journal. */
export interface ActionGrantCapability {
  grant: PublicActionGrant;
  verifierSecret: string;
}

export interface CurrentActionAuthority {
  runId: string;
  scope: ActionScope;
  authorityEpoch: number;
  revoked: boolean;
  /** False after cancellation, a terminal run, or an explicit policy denial. */
  actionAllowed: boolean;
}

/** The controller reads this store again immediately before the local effect. */
export interface CurrentActionAuthorityStore {
  current(runId: string): Promise<CurrentActionAuthority | undefined>;
}

/**
 * Secrets belong in a private controller-owned vault, not the public journal.
 * A durable implementation must survive a controller restart to verify a
 * still-active grant; the in-memory implementation below is test-only.
 */
export interface ActionGrantVault {
  put(grantId: string, verifierSecret: string): Promise<void>;
  get(grantId: string): Promise<string | undefined>;
}

export type ActionJournalRecord =
  | {
      format: 'faktori.action-grant-record/v1';
      kind: 'grant.issued';
      recordId: string;
      occurredAt: string;
      grant: PublicActionGrant;
    }
  | {
      format: 'faktori.action-record/v1';
      kind: 'action.intent';
      recordId: string;
      occurredAt: string;
      operationId: string;
      runId: string;
      actionId: string;
      idempotencyKey: string;
      grantId: string;
      nonceDigest: string;
      requestDigest: string;
      scope: ActionScope;
      authorityEpoch: number;
      verification: ActionGrantVerification;
    }
  | {
      format: 'faktori.action-record/v1';
      kind: 'action.receipt';
      recordId: string;
      occurredAt: string;
      receipt: ActionReceipt;
    };

/** Public durable action records. Implementations must append before returning. */
export interface ActionJournal {
  append(record: ActionJournalRecord): Promise<void>;
  records(): readonly ActionJournalRecord[];
  /** Serializes admission across every controller using this operational journal. */
  withActionClaim<T>(task: () => Promise<T>): Promise<T>;
}

export interface ActionExecutionResult {
  outcome: 'completed' | 'safe_noop' | 'blocked' | 'failed' | 'uncertain';
  detail?: string;
}

export interface AuthorizedAction {
  operationId: string;
  request: Omit<ActionRequest, 'proof'>;
  grant: PublicActionGrant;
}

/**
 * This phase deliberately has no network publication executor. An executor is
 * controller-owned and must call the supplied guard directly before its local
 * effect. That makes authority revalidation testable at the effect boundary.
 */
export interface ControllerActionExecutor {
  execute(action: AuthorizedAction, guard: () => Promise<void>): Promise<ActionExecutionResult>;
}

export interface ActionClock {
  now(): Date;
}

export interface ActionRandom {
  id(): string;
  secret(): string;
}

export interface ActionControllerHooks {
  /** Test seam for an authority change after durable intent, before effect. */
  afterIntentPersisted?(action: AuthorizedAction): Promise<void> | void;
}

export interface ActionControllerOptions {
  journal: ActionJournal;
  authority: CurrentActionAuthorityStore;
  grantVault: ActionGrantVault;
  executor: ControllerActionExecutor;
  clock?: ActionClock;
  random?: ActionRandom;
  hooks?: ActionControllerHooks;
}

export interface ActionAdmissionResult {
  accepted: boolean;
  reason?: string;
  receipt: ActionReceipt;
}

const systemClock: ActionClock = { now: () => new Date() };
const systemRandom: ActionRandom = {
  id: () => randomUUID(),
  secret: () => randomBytes(32).toString('base64url'),
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equal(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sameScope(left: ActionScope, right: ActionScope): boolean {
  return canonical(left) === canonical(right);
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function present(value: string | undefined): value is string {
  return value !== undefined && isNonEmpty(value);
}

function validScope(scope: ActionScope): boolean {
  return [
    scope.kind,
    scope.repository,
    scope.branch,
    scope.baseRevision,
  scope.expectedRevision,
  scope.allowedOperation,
  scope.scopeRevision,
  ].every(isNonEmpty);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function scopeAt(value: unknown): ActionScope | undefined {
  const candidate = object(value);
  if (candidate === undefined) return undefined;
  const scope = {
    kind: stringAt(candidate, 'kind'),
    repository: stringAt(candidate, 'repository'),
    branch: stringAt(candidate, 'branch'),
    baseRevision: stringAt(candidate, 'baseRevision'),
    expectedRevision: stringAt(candidate, 'expectedRevision'),
    allowedOperation: stringAt(candidate, 'allowedOperation'),
    scopeRevision: stringAt(candidate, 'scopeRevision'),
  };
  return Object.values(scope).every((item): item is string => item !== undefined) && validScope(scope as ActionScope) ? scope as ActionScope : undefined;
}

function verificationAt(value: unknown): ActionGrantVerification | undefined {
  const candidate = object(value);
  if (candidate?.algorithm !== 'hmac-sha256' || typeof candidate.keyId !== 'string' || !isNonEmpty(candidate.keyId)) return undefined;
  return { algorithm: 'hmac-sha256', keyId: candidate.keyId };
}

function publicGrantAt(value: unknown): PublicActionGrant | undefined {
  const candidate = object(value);
  if (candidate?.format !== 'faktori.action-grant/v1') return undefined;
  const scope = scopeAt(candidate.scope);
  const verification = verificationAt(candidate.verification);
  const authorityEpoch = candidate.authorityEpoch;
  const grantId = stringAt(candidate, 'grantId');
  const runId = stringAt(candidate, 'runId');
  const issuedAt = stringAt(candidate, 'issuedAt');
  if (scope === undefined || verification === undefined || typeof authorityEpoch !== 'number' || !Number.isInteger(authorityEpoch) || !present(grantId) || !present(runId) || !present(issuedAt)) return undefined;
  return { format: 'faktori.action-grant/v1', grantId, runId, scope, authorityEpoch, issuedAt, verification };
}

function receiptAt(value: unknown): ActionReceipt | undefined {
  const candidate = object(value);
  if (candidate?.format !== 'faktori.action-receipt/v1') return undefined;
  const actionId = stringAt(candidate, 'actionId');
  const idempotencyKey = stringAt(candidate, 'idempotencyKey');
  const runId = stringAt(candidate, 'runId');
  const operationId = stringAt(candidate, 'operationId');
  const observedAt = stringAt(candidate, 'observedAt');
  const outcome = candidate.outcome;
  if (!present(actionId) || !present(idempotencyKey) || !present(runId) || !present(operationId) || !present(observedAt) || !['accepted', 'completed', 'duplicate', 'denied', 'failed', 'uncertain'].includes(String(outcome))) return undefined;
  const detail = candidate.detail;
  if (detail !== undefined && typeof detail !== 'string') return undefined;
  return { format: 'faktori.action-receipt/v1', actionId, idempotencyKey, runId, operationId, outcome: outcome as ActionReceipt['outcome'], observedAt, ...(detail === undefined ? {} : { detail }) };
}

function actionJournalRecord(event: RunEvent): ActionJournalRecord | undefined {
  const candidate = object(event.data.actionRecord);
  if (candidate === undefined) return undefined;
  const format = candidate.format;
  const kind = candidate.kind;
  const recordId = stringAt(candidate, 'recordId');
  const occurredAt = stringAt(candidate, 'occurredAt');
  if (!present(recordId) || !present(occurredAt)) return undefined;
  if (format === 'faktori.action-grant-record/v1' && kind === 'grant.issued') {
    const grant = publicGrantAt(candidate.grant);
    return grant === undefined ? undefined : { format, kind, recordId, occurredAt, grant };
  }
  if (format === 'faktori.action-record/v1' && kind === 'action.intent') {
    const scope = scopeAt(candidate.scope);
    const verification = verificationAt(candidate.verification);
    const authorityEpoch = candidate.authorityEpoch;
    const operationId = stringAt(candidate, 'operationId');
    const runId = stringAt(candidate, 'runId');
    const actionId = stringAt(candidate, 'actionId');
    const idempotencyKey = stringAt(candidate, 'idempotencyKey');
    const grantId = stringAt(candidate, 'grantId');
    const nonceDigest = stringAt(candidate, 'nonceDigest');
    const requestDigest = stringAt(candidate, 'requestDigest');
    if (scope === undefined || verification === undefined || typeof authorityEpoch !== 'number' || !Number.isInteger(authorityEpoch) || !present(operationId) || !present(runId) || !present(actionId) || !present(idempotencyKey) || !present(grantId) || !present(nonceDigest) || !present(requestDigest)) return undefined;
    return { format, kind, recordId, occurredAt, operationId, runId, actionId, idempotencyKey, grantId, nonceDigest, requestDigest, scope, authorityEpoch, verification };
  }
  if (format === 'faktori.action-record/v1' && kind === 'action.receipt') {
    const receipt = receiptAt(candidate.receipt);
    return receipt === undefined ? undefined : { format, kind, recordId, occurredAt, receipt };
  }
  return undefined;
}

function requestWithoutProof(request: ActionRequest): Omit<ActionRequest, 'proof' | 'requestDigest'> {
  const { proof: _proof, requestDigest: _requestDigest, ...unsigned } = request;
  return unsigned;
}

/** Digest every effect-relevant request field; a content revision alone is not auth. */
export function actionRequestDigest(request: ActionRequest): string {
  return sha256(canonical(requestWithoutProof(request)));
}

function proofPayload(request: ActionRequest): string {
  return canonical({
    grantId: request.proof.grantId,
    runId: request.runId,
    nonce: request.proof.nonce,
    requestDigest: request.requestDigest,
  });
}

/** Explicit helper for the isolated worker bootstrap path and deterministic tests. */
export function signActionRequest(request: Omit<ActionRequest, 'proof' | 'requestDigest'>, capability: ActionGrantCapability, nonce: string): ActionRequest {
  const unsigned: ActionRequest = {
    ...request,
    requestDigest: '',
    proof: { grantId: capability.grant.grantId, nonce, authenticationTag: '' },
  };
  unsigned.requestDigest = actionRequestDigest(unsigned);
  unsigned.proof.authenticationTag = createHmac('sha256', capability.verifierSecret).update(proofPayload(unsigned)).digest('base64url');
  return unsigned;
}

function publicRequest(request: ActionRequest): Omit<ActionRequest, 'proof'> {
  const { proof: _proof, ...result } = request;
  return result;
}

function receipt(
  request: ActionRequest,
  operationId: string,
  outcome: ActionReceipt['outcome'],
  observedAt: string,
  detail?: string,
): ActionReceipt {
  return {
    format: 'faktori.action-receipt/v1',
    actionId: request.actionId,
    idempotencyKey: request.idempotencyKey,
    runId: request.runId,
    operationId,
    outcome,
    observedAt,
    ...(detail === undefined ? {} : { detail }),
  };
}

function actionRequestAt(value: unknown): ActionRequest | undefined {
  const candidate = object(value);
  if (candidate === undefined || candidate.format !== 'faktori.action-request/v1') return undefined;
  const proof = object(candidate.proof);
  const scope = scopeAt(candidate.scope);
  const actionId = stringAt(candidate, 'actionId');
  const idempotencyKey = stringAt(candidate, 'idempotencyKey');
  const runId = stringAt(candidate, 'runId');
  const requestDigest = stringAt(candidate, 'requestDigest');
  const requestedAt = stringAt(candidate, 'requestedAt');
  const grantId = proof === undefined ? undefined : stringAt(proof, 'grantId');
  const nonce = proof === undefined ? undefined : stringAt(proof, 'nonce');
  const authenticationTag = proof === undefined ? undefined : stringAt(proof, 'authenticationTag');
  const authorityEpoch = candidate.authorityEpoch;
  if (scope === undefined || typeof authorityEpoch !== 'number' || !Number.isInteger(authorityEpoch) || !present(actionId) || !present(idempotencyKey) || !present(runId) || !present(requestDigest) || !present(requestedAt) || !present(grantId) || !present(nonce) || !present(authenticationTag)) return undefined;
  return {
    format: 'faktori.action-request/v1', actionId, idempotencyKey, runId, scope, authorityEpoch, requestDigest,
    proof: { grantId, nonce, authenticationTag }, requestedAt,
  };
}

function malformedRequestReceipt(value: unknown, observedAt: string): ActionReceipt {
  const candidate = object(value);
  const actionId = candidate === undefined ? undefined : stringAt(candidate, 'actionId');
  const idempotencyKey = candidate === undefined ? undefined : stringAt(candidate, 'idempotencyKey');
  const runId = candidate === undefined ? undefined : stringAt(candidate, 'runId');
  return {
    format: 'faktori.action-receipt/v1',
    actionId: present(actionId) ? actionId : 'invalid-action',
    idempotencyKey: present(idempotencyKey) ? idempotencyKey : 'invalid-idempotency',
    runId: present(runId) ? runId : 'invalid-run',
    operationId: 'denied:invalid-action-request',
    outcome: 'denied',
    observedAt,
    detail: 'invalid_action_request',
  };
}

function outcomeFromExecution(result: ActionExecutionResult): ActionReceipt['outcome'] {
  if (result.outcome === 'completed' || result.outcome === 'safe_noop') return 'completed';
  if (result.outcome === 'blocked') return 'denied';
  if (result.outcome === 'failed') return 'failed';
  return 'uncertain';
}

function recordMatchesRequest(record: Extract<ActionJournalRecord, { kind: 'action.intent' }>, request: ActionRequest): boolean {
  return record.runId === request.runId
    && record.actionId === request.actionId
    && record.grantId === request.proof.grantId
    && record.nonceDigest === sha256(request.proof.nonce)
    && record.requestDigest === request.requestDigest
    && record.authorityEpoch === request.authorityEpoch
    && sameScope(record.scope, request.scope);
}

function findReceipt(records: readonly ActionJournalRecord[], operationId: string): ActionReceipt | undefined {
  return records.find((record): record is Extract<ActionJournalRecord, { kind: 'action.receipt' }> => record.kind === 'action.receipt' && record.receipt.operationId === operationId)?.receipt;
}

export class InMemoryActionJournal implements ActionJournal {
  #records: ActionJournalRecord[] = [];
  #claimTail: Promise<unknown> = Promise.resolve();

  async append(record: ActionJournalRecord): Promise<void> {
    this.#records.push(structuredClone(record));
  }

  records(): readonly ActionJournalRecord[] {
    return this.#records.map((record) => structuredClone(record));
  }

  async withActionClaim<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#claimTail.then(task, task);
    this.#claimTail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Maps public action records onto the coordinator's durable append-only journal.
 * The runtime projection receives matching effect intent/receipt fields while
 * recovery reads only validated, secret-free `actionRecord` payloads.
 */
export class AppendOnlyActionJournal implements ActionJournal {
  readonly journal: AppendOnlyJournal;
  #records: ActionJournalRecord[];

  constructor(journal: AppendOnlyJournal) {
    this.journal = journal;
    this.#records = this.recordsFromEvents(journal.events());
  }

  async append(record: ActionJournalRecord): Promise<void> {
    const event = this.eventFor(record);
    await this.journal.append(event);
    this.#records.push(structuredClone(record));
  }

  records(): readonly ActionJournalRecord[] {
    return this.#records.map((record) => structuredClone(record));
  }

  /**
   * `open(..., 'wx')` is the cross-process compare-and-set. The lock is held
   * through the durable intent append, then a contender reloads the journal and
   * observes that intent instead of invoking a second executor. A surviving
   * lock after a process crash is intentionally an explicit, safe blocker.
   */
  async withActionClaim<T>(task: () => Promise<T>): Promise<T> {
    const lockPath = `${this.journal.path}.action-admission-lock`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
        await handle.sync();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise<void>((done) => setTimeout(done, 10));
      }
    }
    if (handle === undefined) throw new Error('action_claim_unresolved');
    try {
      await this.journal.recover();
      this.#records = this.recordsFromEvents(this.journal.events());
      return await task();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }

  private recordsFromEvents(events: readonly RunEvent[]): ActionJournalRecord[] {
    return events.flatMap((event) => {
      const record = actionJournalRecord(event);
      return record === undefined ? [] : [record];
    });
  }

  private eventFor(record: ActionJournalRecord): RunEvent {
    if (record.kind === 'grant.issued') {
      return this.journal.event(record.grant.runId, 'action.intended', { actionRecord: record }, record.recordId);
    }
    if (record.kind === 'action.intent') {
      return this.journal.event(record.runId, 'action.intended', {
        actionRecord: record,
        effect: {
          operationId: record.operationId,
          kind: 'action.execute',
          identityKey: record.idempotencyKey,
          requestedAt: record.occurredAt,
          requestDigest: record.requestDigest,
        },
      }, record.recordId);
    }
    return this.journal.event(record.receipt.runId, 'action.receipt', {
      actionRecord: record,
      receipt: {
        operationId: record.receipt.operationId,
        observedAt: record.receipt.observedAt,
        outcome: record.receipt.outcome === 'completed' ? 'completed' : record.receipt.outcome === 'denied' ? 'blocked' : record.receipt.outcome === 'uncertain' ? 'uncertain' : 'failed',
        ...(record.receipt.detail === undefined ? {} : { detail: record.receipt.detail }),
      },
    }, record.recordId);
  }
}

export class InMemoryActionGrantVault implements ActionGrantVault {
  #secrets = new Map<string, string>();

  async put(grantId: string, verifierSecret: string): Promise<void> {
    if (this.#secrets.has(grantId)) throw new Error(`Grant ${grantId} already has a verifier secret`);
    this.#secrets.set(grantId, verifierSecret);
  }

  async get(grantId: string): Promise<string | undefined> {
    return this.#secrets.get(grantId);
  }
}

/**
 * Private controller storage for verifier material. Records use a hashed file
 * name so neither a grant ID nor a capability is exposed through a directory
 * listing. This vault must live outside the repository and operational journal.
 */
export class FileActionGrantVault implements ActionGrantVault {
  readonly directory: string;
  #ready: Promise<void> | undefined;

  constructor(directory: string) {
    if (!isAbsolute(directory) || directory === sep || resolve(directory) !== directory) throw new Error('Action grant vault requires a normalized dedicated absolute controller storage path');
    this.directory = directory;
  }

  async put(grantId: string, verifierSecret: string): Promise<void> {
    await this.ready();
    if (!isNonEmpty(grantId) || verifierSecret.length < 32 || !/^[A-Za-z0-9_-]+$/.test(verifierSecret)) throw new Error('Refusing an invalid action grant verifier secret');
    const path = this.secretPath(grantId);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(verifierSecret, 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle?.close();
    }
    await this.assertPrivateFile(path);
  }

  async get(grantId: string): Promise<string | undefined> {
    await this.ready();
    if (!isNonEmpty(grantId)) return undefined;
    const path = this.secretPath(grantId);
    try {
      await this.assertPrivateFile(path);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const verifierSecret = await handle.readFile('utf8');
        return verifierSecret.length >= 32 && /^[A-Za-z0-9_-]+$/.test(verifierSecret) ? verifierSecret : undefined;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async ready(): Promise<void> {
    this.#ready ??= this.initialize();
    return this.#ready;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Audit every segment after creation: an explicit private path may not pass
    // through symlinked controller storage.
    let current: string = sep;
    for (const component of this.directory.split(sep).filter(Boolean)) {
      current = join(current, component);
      const status = await lstat(current);
      if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`Action grant vault path is not a real directory: ${current}`);
    }
    const status = await lstat(this.directory);
    if (status.isSymbolicLink() || !status.isDirectory() || (status.mode & 0o077) !== 0) throw new Error('Action grant vault directory is not private');
    if (typeof process.getuid === 'function' && status.uid !== process.getuid()) throw new Error('Action grant vault directory owner does not match the controller');
  }

  private secretPath(grantId: string): string {
    const path = join(this.directory, `${sha256(`faktori-action-grant:${grantId}`)}.secret`);
    if (relative(this.directory, path).startsWith(`..${sep}`) || !path.startsWith(`${this.directory}${sep}`)) throw new Error('Action grant vault path escaped its controller storage');
    return path;
  }

  private async assertPrivateFile(path: string): Promise<void> {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o077) !== 0) throw new Error('Action grant verifier file is not a private regular file');
    if (typeof process.getuid === 'function' && status.uid !== process.getuid()) throw new Error('Action grant verifier file owner does not match the controller');
  }
}

/**
 * Serializes controller admission. Its only executor contract is a deterministic
 * local effect boundary; GitHub/Jira/deployment transports are intentionally
 * out of scope for Phase 2.
 */
export class ControllerActionAdmission {
  readonly journal: ActionJournal;
  readonly authority: CurrentActionAuthorityStore;
  readonly grantVault: ActionGrantVault;
  readonly executor: ControllerActionExecutor;
  readonly clock: ActionClock;
  readonly random: ActionRandom;
  readonly hooks: ActionControllerHooks;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: ActionControllerOptions) {
    this.journal = options.journal;
    this.authority = options.authority;
    this.grantVault = options.grantVault;
    this.executor = options.executor;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? systemRandom;
    this.hooks = options.hooks ?? {};
  }

  async mintGrant(input: { runId: string; scope: ActionScope; authorityEpoch: number }): Promise<ActionGrantCapability> {
    if (!isNonEmpty(input.runId) || !validScope(input.scope) || !Number.isInteger(input.authorityEpoch) || input.authorityEpoch < 0) {
      throw new Error('Action grants require a non-empty run, immutable valid scope, and non-negative authority epoch');
    }
    const current = await this.authority.current(input.runId);
    if (!this.authorized(current, input.runId, input.scope, input.authorityEpoch)) throw new Error('Cannot mint an action grant without current run authority');
    const verifierSecret = this.random.secret();
    if (verifierSecret.length < 32) throw new Error('Action grant verifier secret is too short');
    const grant: PublicActionGrant = {
      format: 'faktori.action-grant/v1',
      grantId: this.random.id(),
      runId: input.runId,
      scope: structuredClone(input.scope),
      authorityEpoch: input.authorityEpoch,
      issuedAt: this.clock.now().toISOString(),
      verification: { algorithm: 'hmac-sha256', keyId: sha256(verifierSecret).slice(0, 32) },
    };
    await this.grantVault.put(grant.grantId, verifierSecret);
    await this.journal.append({ format: 'faktori.action-grant-record/v1', kind: 'grant.issued', recordId: this.random.id(), occurredAt: this.clock.now().toISOString(), grant });
    return { grant, verifierSecret };
  }

  async admit(request: unknown): Promise<ActionAdmissionResult> {
    const parsed = actionRequestAt(request);
    if (parsed === undefined) {
      return { accepted: false, reason: 'invalid_action_request', receipt: malformedRequestReceipt(request, this.clock.now().toISOString()) };
    }
    const task = async (): Promise<ActionAdmissionResult> => {
      try {
        return await this.journal.withActionClaim(() => this.admitExclusive(parsed));
      } catch (error) {
        if (error instanceof Error && error.message === 'action_claim_unresolved') {
          return { accepted: false, reason: 'action_claim_unavailable', receipt: receipt(parsed, `denied:${parsed.actionId}`, 'denied', this.clock.now().toISOString(), 'action_claim_unavailable') };
        }
        throw error;
      }
    };
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  private async admitExclusive(request: ActionRequest): Promise<ActionAdmissionResult> {
    const now = (): string => this.clock.now().toISOString();
    const reject = (reason: string): ActionAdmissionResult => ({
      accepted: false,
      reason,
      receipt: receipt(request, `denied:${request.actionId}`, 'denied', now(), reason),
    });
    if (!this.validRequest(request)) return reject('invalid_action_request');
    if (!equal(actionRequestDigest(request), request.requestDigest)) return reject('request_digest_mismatch');

    const records = this.journal.records();
    const sameIdempotency = records.filter((record): record is Extract<ActionJournalRecord, { kind: 'action.intent' }> => record.kind === 'action.intent' && record.idempotencyKey === request.idempotencyKey);
    if (sameIdempotency.length > 0) {
      const existing = sameIdempotency[0];
      if (!recordMatchesRequest(existing, request)) return reject('idempotency_key_reused_for_different_action');
      const stored = findReceipt(records, existing.operationId);
      if (stored !== undefined) return { accepted: stored.outcome === 'completed', reason: 'exact_duplicate', receipt: stored };
      return { accepted: false, reason: 'unresolved_action_requires_reconciliation', receipt: receipt(request, existing.operationId, 'uncertain', now(), 'durable intent has no receipt') };
    }
    const nonceDigest = sha256(request.proof.nonce);
    const nonceUsed = records.some((record) => record.kind === 'action.intent' && record.grantId === request.proof.grantId && record.nonceDigest === nonceDigest);
    if (nonceUsed) return reject('nonce_replayed');

    const grant = this.grant(records, request.proof.grantId);
    if (grant === undefined || grant.runId !== request.runId || !sameScope(grant.scope, request.scope) || grant.authorityEpoch !== request.authorityEpoch) return reject('grant_scope_or_run_mismatch');
    const verifierSecret = await this.grantVault.get(grant.grantId);
    if (verifierSecret === undefined || !equal(sha256(verifierSecret).slice(0, 32), grant.verification.keyId)) return reject('grant_verifier_unavailable');
    const expectedTag = createHmac('sha256', verifierSecret).update(proofPayload(request)).digest('base64url');
    if (!equal(expectedTag, request.proof.authenticationTag)) return reject('caller_authentication_failed');
    if (!this.authorized(await this.authority.current(request.runId), request.runId, request.scope, request.authorityEpoch)) return reject('authority_not_current');

    const operationId = this.random.id();
    const authorized: AuthorizedAction = { operationId, request: publicRequest(request), grant };
    await this.journal.append({
      format: 'faktori.action-record/v1',
      kind: 'action.intent',
      recordId: this.random.id(),
      occurredAt: now(),
      operationId,
      runId: request.runId,
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
      grantId: grant.grantId,
      nonceDigest,
      requestDigest: request.requestDigest,
      scope: structuredClone(request.scope),
      authorityEpoch: request.authorityEpoch,
      verification: structuredClone(grant.verification),
    });
    await this.hooks.afterIntentPersisted?.(authorized);

    const guard = async (): Promise<void> => {
      if (!this.authorized(await this.authority.current(request.runId), request.runId, request.scope, request.authorityEpoch)) {
        throw new Error('authority_changed_before_effect');
      }
    };
    try {
      // This check occurs after durable intent and before entering an executor,
      // so a changed authority is a known denial rather than an unknown effect.
      await guard();
    } catch (error) {
      const observed = receipt(request, operationId, 'denied', now(), error instanceof Error ? error.message : 'authority changed before effect');
      await this.journal.append({ format: 'faktori.action-record/v1', kind: 'action.receipt', recordId: this.random.id(), occurredAt: now(), receipt: observed });
      return { accepted: false, reason: 'authority_not_current', receipt: observed };
    }
    let execution: ActionExecutionResult;
    try {
      // The executor receives the same guard for its final local instruction,
      // closing the otherwise testable async race at that edge.
      execution = await this.executor.execute(authorized, guard);
      if (!['completed', 'safe_noop', 'blocked', 'failed', 'uncertain'].includes(execution.outcome)) execution = { outcome: 'uncertain', detail: 'executor returned an invalid outcome' };
    } catch (error) {
      execution = { outcome: 'uncertain', detail: error instanceof Error ? error.message : 'executor threw an unknown value' };
    }
    const observed = receipt(request, operationId, outcomeFromExecution(execution), now(), execution.detail);
    await this.journal.append({ format: 'faktori.action-record/v1', kind: 'action.receipt', recordId: this.random.id(), occurredAt: now(), receipt: observed });
    return { accepted: observed.outcome === 'completed', ...(observed.outcome === 'completed' ? {} : { reason: execution.outcome }), receipt: observed };
  }

  private grant(records: readonly ActionJournalRecord[], grantId: string): PublicActionGrant | undefined {
    return records.find((record): record is Extract<ActionJournalRecord, { kind: 'grant.issued' }> => record.kind === 'grant.issued' && record.grant.grantId === grantId)?.grant;
  }

  private validRequest(request: ActionRequest): boolean {
    return request.format === 'faktori.action-request/v1'
      && [request.actionId, request.idempotencyKey, request.runId, request.requestDigest, request.proof.grantId, request.proof.nonce, request.proof.authenticationTag, request.requestedAt].every(isNonEmpty)
      && validScope(request.scope)
      && Number.isInteger(request.authorityEpoch) && request.authorityEpoch >= 0;
  }

  private authorized(current: CurrentActionAuthority | undefined, runId: string, scope: ActionScope, epoch: number): boolean {
    return current !== undefined && current.runId === runId && current.actionAllowed && !current.revoked && current.authorityEpoch === epoch && sameScope(current.scope, scope);
  }
}
