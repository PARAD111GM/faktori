import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

import type { CursorAcpConnection, CursorAcpConnectRequest, CursorAcpInboundReply, CursorAcpNotification, CursorAcpRpcRequest, CursorAcpTransport } from '../providers/cursor.ts';
import type { NativeIdentityObservation, NativeProcessGroupObservation } from './index.ts';
import type { NativeWorkerIdentity } from '../runtime/contracts.ts';

type JsonRecord = Record<string, unknown>;

export interface CursorAcpStdioInput {
  write(chunk: string): boolean;
  end(): void;
}

export interface CursorAcpStdioOutput {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface CursorAcpStdioChild {
  pid?: number;
  stdin?: CursorAcpStdioInput | null;
  stdout?: CursorAcpStdioOutput | null;
  stderr?: CursorAcpStdioOutput | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type CursorAcpStdioSpawn = (command: string, args: readonly string[], options: SpawnOptions) => CursorAcpStdioChild;

export interface CursorAcpNativeIdentityProbe {
  inspect(pid: number): Promise<NativeIdentityObservation | undefined>;
  /** Required to prove that the detached group, not merely its leader, exited. */
  inspectProcessGroup(processGroupId: number): Promise<NativeProcessGroupObservation | undefined>;
}

export interface CursorAcpStdioTransportOptions {
  /** Exact allowlisted process environment. Ambient environment is never merged. */
  environment: Readonly<Record<string, string>>;
  identityProbe: CursorAcpNativeIdentityProbe;
  /** Injected by the trusted execution boundary; never signal a group blindly. */
  killProcessGroup(processGroupId: number, signal: NodeJS.Signals): void;
  runNonce: string;
  spawn?: CursorAcpStdioSpawn;
  maxLineBytes?: number;
  /** Bounded time for an EOF-initiated ACP child to exit without revocation. */
  closeGraceMs?: number;
  /** Bounded time after each identity-checked process-group signal. */
  terminationGraceMs?: number;
}

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const MAX_METHOD_LENGTH = 160;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validEnvironment(environment: Readonly<Record<string, string>>): boolean {
  const values = Object.entries(environment);
  return values.length > 0 && values.every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0'));
}

function idKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function sameId(left: unknown, right: string | number): boolean {
  return (typeof left === 'string' || typeof left === 'number') && typeof left === typeof right && left === right;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : 'Cursor ACP stdio transport failed';
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): CursorAcpStdioChild {
  return nodeSpawn(command, [...args], options) as CursorAcpStdioChild;
}

function sameNativeWorker(worker: NativeWorkerIdentity, observed: NativeIdentityObservation | undefined): observed is Extract<NativeIdentityObservation, { pid: number }> {
  return observed !== undefined && !('status' in observed) && observed.running
    && observed.pid === worker.pid && observed.processStartedAt === worker.processStartedAt
    && observed.processGroupId === worker.processGroupId;
}

function groupExited(observed: NativeProcessGroupObservation | undefined): boolean {
  return observed !== undefined && (('status' in observed && observed.status === 'absent')
    || ('members' in observed && observed.members.every((member) => !member.running)));
}

function observedGroup(observed: NativeProcessGroupObservation | undefined): observed is Extract<NativeProcessGroupObservation, { processGroupId: number }> {
  return observed !== undefined && 'members' in observed;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface PendingRequest {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * One real Cursor ACP JSON-RPC connection. It makes no permission decisions,
 * does not inherit credentials, and never sends shell text instead of argv.
 */
class StdioCursorAcpConnection implements CursorAcpConnection {
  readonly worker: NativeWorkerIdentity;
  readonly #child: CursorAcpStdioChild;
  readonly #request: CursorAcpConnectRequest;
  readonly #maxLineBytes: number;
  readonly #identityProbe: CursorAcpNativeIdentityProbe;
  readonly #killProcessGroup: (processGroupId: number, signal: NodeJS.Signals) => void;
  readonly #closeGraceMs: number;
  readonly #terminationGraceMs: number;
  readonly #onClosed: () => void;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #completed = new Set<string>();
  #handler?: (request: CursorAcpRpcRequest) => Promise<CursorAcpInboundReply>;
  #notificationHandler?: (notification: CursorAcpNotification) => Promise<void>;
  #inboundTail: Promise<void> = Promise.resolve();
  #notificationTail: Promise<void> = Promise.resolve();
  #buffer = Buffer.alloc(0);
  #closed = false;
  #closing = false;
  #released = false;
  #childClosed = false;
  #childClose?: { code: number | null; signal: NodeJS.Signals | null };
  #childExit: Promise<void>;
  #resolveChildExit!: () => void;
  #close?: Promise<void>;
  #failure?: Promise<void>;
  #termination?: Promise<void>;

  constructor(
    child: CursorAcpStdioChild,
    worker: NativeWorkerIdentity,
    request: CursorAcpConnectRequest,
    options: Pick<CursorAcpStdioTransportOptions, 'identityProbe' | 'killProcessGroup' | 'maxLineBytes' | 'closeGraceMs' | 'terminationGraceMs'>,
    onClosed: () => void,
  ) {
    this.#child = child;
    this.worker = worker;
    this.#request = request;
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.#identityProbe = options.identityProbe;
    this.#killProcessGroup = options.killProcessGroup;
    this.#closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.#terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.#onClosed = onClosed;
    this.#childExit = new Promise((resolve) => { this.#resolveChildExit = resolve; });
    child.stdout?.on('data', (chunk) => this.#onData(chunk));
    child.on('error', (error) => this.#startFailure(`Cursor ACP process error: ${errorMessage(error)}`, 'output_limit'));
    child.on('close', (code, signal) => {
      this.#childClosed = true;
      this.#childClose = { code, signal };
      this.#resolveChildExit();
      if (!this.#closing && this.#failure === undefined) {
        this.#startUnexpectedClose(`Cursor ACP connection closed before a terminal receipt (exit ${code ?? 'null'}${signal ? `, ${signal}` : ''})`);
      }
    });
  }

  setRequestHandler(handler: (request: CursorAcpRpcRequest) => Promise<CursorAcpInboundReply>): void {
    if (this.#handler !== undefined) throw new Error('Cursor ACP inbound request handler is already set');
    this.#handler = handler;
  }

  setNotificationHandler(handler: (notification: CursorAcpNotification) => Promise<void>): void {
    if (this.#notificationHandler !== undefined) throw new Error('Cursor ACP notification handler is already set');
    this.#notificationHandler = handler;
  }

  async request(request: CursorAcpRpcRequest, timeoutMs: number): Promise<JsonRecord> {
    if (this.#closed) throw new Error('Cursor ACP connection is closed');
    if (!this.#validRequest(request) || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid bounded Cursor ACP request');
    const key = idKey(request.id);
    if (this.#pending.has(key) || this.#completed.has(key)) throw new Error('duplicate Cursor ACP request correlation id');
    return new Promise<JsonRecord>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(key);
        reject(new Error(`Cursor ACP ${request.method} request timed out`));
        this.#startFailure(`Cursor ACP ${request.method} request timed out`, 'timeout');
      }, timeoutMs);
      this.#pending.set(key, { resolve, reject, timeout });
      try {
        this.#write({ jsonrpc: '2.0', id: request.id, method: request.method, ...(request.params === undefined ? {} : { params: request.params }) });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(key);
        reject(new Error(errorMessage(error)));
        this.#startFailure(`Cursor ACP stdin failed: ${errorMessage(error)}`, 'output_limit');
      }
    });
  }

  async notify(method: string, params: JsonRecord): Promise<void> {
    if (this.#closed) throw new Error('Cursor ACP connection is closed');
    if (method !== 'session/cancel' || !record(params) || typeof params.sessionId !== 'string' || params.sessionId.trim().length === 0) {
      throw new Error('unsupported or malformed Cursor ACP notification');
    }
    this.#write({ jsonrpc: '2.0', method, params });
  }

  async close(): Promise<void> {
    if (this.#close !== undefined) return this.#close;
    if (this.#failure !== undefined) return this.#failure;
    if (this.#released) return;
    this.#closing = true;
    this.#closed = true;
    this.#rejectPending('Cursor ACP connection closed');
    this.#close = (async (): Promise<void> => {
      // EOF is a non-authoritative local close. It is clean only if both the
      // child and its detached group are observed to have exited within bound.
      this.#endStdin();
      if (await this.#waitForChildClose(this.#closeGraceMs) && await this.#confirmedExit()) {
        this.#release();
        return;
      }
      // A lingering EOF cleanup must be durable-revoke-first. It is process
      // cleanup, not a provider-native `session/cancel` receipt.
      await this.#terminate('cancelled');
      this.#release();
    })();
    return this.#close;
  }

  #onData(chunk: Buffer | string): void {
    if (this.#closed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#buffer = Buffer.concat([this.#buffer, incoming]);
    if (this.#buffer.length > this.#maxLineBytes && !this.#buffer.includes(0x0a)) {
      this.#protocolFailure('Cursor ACP line exceeded the configured maximum');
      return;
    }
    let newline: number;
    while ((newline = this.#buffer.indexOf(0x0a)) >= 0) {
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length > this.#maxLineBytes) { this.#protocolFailure('Cursor ACP line exceeded the configured maximum'); return; }
      if (line.length === 0) continue;
      let message: unknown;
      try { message = JSON.parse(line.toString('utf8')); } catch { this.#protocolFailure('Cursor ACP emitted malformed JSON-RPC'); return; }
      this.#onMessage(message);
    }
  }

  #onMessage(message: unknown): void {
    if (!record(message) || message.jsonrpc !== '2.0') { this.#protocolFailure('Cursor ACP emitted malformed JSON-RPC envelope'); return; }
    if (typeof message.method === 'string') {
      if (!Object.hasOwn(message, 'id')) {
        this.#notificationTail = this.#notificationTail.then(() => this.#handleNotification(message)).catch(() => undefined);
      } else {
        this.#inboundTail = this.#inboundTail.then(() => this.#handleInbound(message)).catch(() => undefined);
      }
      return;
    }
    if (!('id' in message) || (!('result' in message) && !('error' in message))) { this.#protocolFailure('Cursor ACP emitted out-of-order or malformed response'); return; }
    const id = message.id;
    if (typeof id !== 'string' && typeof id !== 'number') { this.#protocolFailure('Cursor ACP response has invalid correlation id'); return; }
    const key = idKey(id);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      // A duplicate or orphan response cannot be allowed to alter later turns.
      this.#protocolFailure('Cursor ACP emitted duplicate or orphan response');
      return;
    }
    this.#pending.delete(key);
    this.#completed.add(key);
    clearTimeout(pending.timeout);
    if ('error' in message) pending.resolve({ error: message.error });
    else if (record(message.result)) pending.resolve(message.result);
    else pending.reject(new Error('Cursor ACP response result is malformed'));
  }

  async #handleInbound(message: JsonRecord): Promise<void> {
    const request: CursorAcpRpcRequest | undefined = (typeof message.id === 'string' || typeof message.id === 'number')
      && typeof message.method === 'string' && message.method.trim().length > 0 && message.method.length <= MAX_METHOD_LENGTH && (message.params === undefined || record(message.params))
      ? { id: message.id, method: message.method, ...(record(message.params) ? { params: message.params } : {}) } : undefined;
    if (request === undefined) { this.#protocolFailure('Cursor ACP emitted malformed inbound request'); return; }
    let reply: CursorAcpInboundReply;
    try {
      reply = this.#handler === undefined
        ? { error: { code: -32601, message: 'ACP request handler unavailable' } }
        : await this.#handler(request);
    } catch {
      reply = { error: { code: -32001, message: 'coordinator reply handler failed closed' } };
    }
    const validResult = 'result' in reply && record(reply.result);
    const validError = 'error' in reply && record(reply.error) && typeof reply.error.code === 'number' && typeof reply.error.message === 'string';
    if (!validResult && !validError) {
      reply = { error: { code: -32001, message: 'coordinator reply handler returned malformed reply' } };
    }
    try {
      this.#write({ jsonrpc: '2.0', id: request.id, ...reply });
    } catch {
      this.#startFailure('Cursor ACP stdin failed while replying to provider request', 'output_limit');
    }
  }

  async #handleNotification(message: JsonRecord): Promise<void> {
    const notification: CursorAcpNotification | undefined = typeof message.method === 'string'
      && message.method.trim().length > 0 && message.method.length <= MAX_METHOD_LENGTH && (message.params === undefined || record(message.params))
      ? { method: message.method, ...(record(message.params) ? { params: message.params } : {}) } : undefined;
    if (notification === undefined) { this.#protocolFailure('Cursor ACP emitted malformed notification'); return; }
    if (this.#notificationHandler === undefined) {
      this.#protocolFailure('Cursor ACP emitted notification before an observation handler was registered');
      return;
    }
    try {
      await this.#notificationHandler(notification);
    } catch {
      this.#protocolFailure('Cursor ACP notification handler failed');
    }
  }

  #validRequest(request: CursorAcpRpcRequest): boolean {
    return (typeof request.id === 'string' || (typeof request.id === 'number' && Number.isFinite(request.id)))
      && typeof request.method === 'string' && request.method.trim().length > 0 && request.method.length <= MAX_METHOD_LENGTH
      && (request.params === undefined || record(request.params));
  }

  #write(value: JsonRecord): void {
    const stdin = this.#child.stdin;
    if (stdin === null || stdin === undefined) throw new Error('Cursor ACP stdin is unavailable');
    stdin.write(`${JSON.stringify(value)}\n`);
  }

  #protocolFailure(message: string): void {
    this.#startFailure(message, 'output_limit');
  }

  #rejectPending(message: string): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.#pending.clear();
  }

  #endStdin(): void {
    try { this.#child.stdin?.end(); } catch { /* process may have already exited */ }
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#onClosed();
  }

  #startFailure(message: string, reason: 'timeout' | 'output_limit'): void {
    if (this.#failure !== undefined || this.#released) return;
    this.#rejectPending(message);
    this.#failure = (async (): Promise<void> => {
      await this.#terminate(reason);
      this.#release();
    })();
    void this.#failure.catch(() => undefined);
  }

  #startUnexpectedClose(message: string): void {
    if (this.#failure !== undefined || this.#released) return;
    this.#rejectPending(message);
    this.#failure = (async (): Promise<void> => {
      // A child close can be a normal post-receipt exit, but it must still
      // prove the detached group is gone before the active identity is freed.
      if (await this.#confirmedExit()) {
        this.#release();
        return;
      }
      await this.#terminate('output_limit');
      this.#release();
    })();
    void this.#failure.catch(() => undefined);
  }

  async #waitForChildClose(timeoutMs: number): Promise<boolean> {
    if (this.#childClosed) return true;
    return Promise.race([
      this.#childExit.then(() => true),
      wait(timeoutMs).then(() => false),
    ]);
  }

  async #confirmedExit(): Promise<boolean> {
    if (!this.#childClosed) return false;
    return groupExited(await this.#identityProbe.inspectProcessGroup(this.worker.processGroupId));
  }

  async #terminate(reason: 'timeout' | 'output_limit' | 'cancelled'): Promise<void> {
    if (this.#termination !== undefined) return this.#termination;
    const lifecycle = this.#request.lifecycle;
    this.#termination = (async (): Promise<void> => {
      if (lifecycle?.onTerminationRequired === undefined) {
        throw new Error('Cursor ACP worker has no durable termination authority hook');
      }
      // The coordinator persists authority revocation before any local EOF or
      // process-group signal is used to clean up an unsafe transport state.
      await lifecycle.onTerminationRequired(this.worker, reason);
      this.#endStdin();

      const beforeSignal = await this.#identityProbe.inspect(this.worker.pid);
      const beforeGroup = await this.#identityProbe.inspectProcessGroup(this.worker.processGroupId);
      if (!sameNativeWorker(this.worker, beforeSignal)) {
        if (groupExited(beforeGroup) && await this.#waitForChildClose(this.#terminationGraceMs)) return;
        throw new Error('Cursor ACP worker identity unavailable or changed before SIGTERM; no signal sent');
      }
      if (!observedGroup(beforeGroup)
        || !beforeGroup.members.some((member) => member.pid === this.worker.pid
          && member.processStartedAt === this.worker.processStartedAt
          && member.processGroupId === this.worker.processGroupId
          && member.running)) {
        throw new Error('Cursor ACP process-group observation did not contain the exact worker leader; no signal sent');
      }
      this.#killProcessGroup(this.worker.processGroupId, 'SIGTERM');
      await wait(this.#terminationGraceMs);
      if (await this.#confirmedExit()) return;

      const afterTermGroup = await this.#identityProbe.inspectProcessGroup(this.worker.processGroupId);
      if (!observedGroup(afterTermGroup)
        || !afterTermGroup.members.some((member) => member.pid === this.worker.pid
          && member.processStartedAt === this.worker.processStartedAt
          && member.processGroupId === this.worker.processGroupId
          && member.running)) {
        throw new Error('Cursor ACP process group has no continuous worker identity after SIGTERM; SIGKILL not sent');
      }
      this.#killProcessGroup(this.worker.processGroupId, 'SIGKILL');
      await wait(this.#terminationGraceMs);
      if (await this.#confirmedExit()) return;
      throw new Error('Cursor ACP worker exit could not be confirmed after identity-checked SIGKILL');
    })();
    try {
      await this.#termination;
    } catch (error) {
      if (this.#termination !== undefined) this.#termination = undefined;
      throw error;
    }
  }
}

/** Shipped stdio transport for the observed `cursor agent acp` protocol. */
export class CursorAcpStdioTransport implements CursorAcpTransport {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #identityProbe: CursorAcpNativeIdentityProbe;
  readonly #killProcessGroup: (processGroupId: number, signal: NodeJS.Signals) => void;
  readonly #runNonce: string;
  readonly #spawn: CursorAcpStdioSpawn;
  readonly #maxLineBytes: number;
  readonly #closeGraceMs: number;
  readonly #terminationGraceMs: number;
  #active = false;

  constructor(options: CursorAcpStdioTransportOptions) {
    if (!validEnvironment(options.environment)) throw new Error('Cursor ACP stdio transport requires a nonempty controlled environment');
    if (options.runNonce.trim().length === 0) throw new Error('Cursor ACP stdio transport requires a run nonce');
    if (!Number.isInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES) || (options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES) < 1) throw new Error('Cursor ACP stdio transport requires a positive line limit');
    if (typeof options.identityProbe.inspectProcessGroup !== 'function' || typeof options.killProcessGroup !== 'function') {
      throw new Error('Cursor ACP stdio transport requires process-group inspection and signaling dependencies');
    }
    if (!Number.isInteger(options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS) || (options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS) < 1
      || !Number.isInteger(options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS) || (options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS) < 1) {
      throw new Error('Cursor ACP stdio transport requires positive close and termination grace bounds');
    }
    this.#environment = Object.freeze({ ...options.environment });
    this.#identityProbe = options.identityProbe;
    this.#killProcessGroup = options.killProcessGroup;
    this.#runNonce = options.runNonce;
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.#closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.#terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  }

  async connect(request: CursorAcpConnectRequest): Promise<CursorAcpConnection> {
    if (this.#active) throw new Error('Cursor ACP stdio transport permits exactly one active connection');
    if (request.command !== 'cursor agent acp' || request.runId.trim().length === 0 || request.cwd.trim().length === 0 || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) throw new Error('invalid Cursor ACP connect request');
    let child: CursorAcpStdioChild;
    try {
      child = this.#spawn('cursor', ['agent', 'acp'], { cwd: request.cwd, env: { ...this.#environment }, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      throw new Error(`Cursor ACP spawn failed: ${errorMessage(error)}`);
    }
    // A successful spawn consumes the transport slot immediately. Until an
    // exact native identity is observed, no signal is safe and EOF cannot
    // prove which process (or process group) survived. Keep this instance
    // quarantined on every pre-identity failure; an operator must recreate it.
    this.#active = true;
    if (child.pid === undefined || child.pid < 1 || child.stdin === null || child.stdin === undefined || child.stdout === null || child.stdout === undefined) {
      try { child.stdin?.end(); } catch { /* process may already have exited */ }
      throw new Error('Cursor ACP spawn did not provide stdio and pid');
    }
    let observed: Awaited<ReturnType<CursorAcpNativeIdentityProbe['inspect']>>;
    try {
      observed = await this.#identityProbe.inspect(child.pid);
    } catch {
      try { child.stdin.end(); } catch { /* process may already have exited */ }
      throw new Error('Cursor ACP native worker identity could not be observed');
    }
    if (observed === undefined || 'status' in observed || !observed.running || observed.pid !== child.pid) {
      try { child.stdin.end(); } catch { /* process may already have exited */ }
      throw new Error('Cursor ACP native worker identity could not be observed');
    }
    const worker: NativeWorkerIdentity = { kind: 'native', pid: child.pid, processStartedAt: observed.processStartedAt, processGroupId: observed.processGroupId, runNonce: this.#runNonce };
    if (!sameNativeWorker(worker, observed)) {
      try { child.stdin.end(); } catch { /* process may already have exited */ }
      throw new Error('Cursor ACP native worker identity changed before lifecycle receipt');
    }
    // The exact worker is now owned by the connection before asking the
    // coordinator to persist it. If persistence fails, EOF cleanup must be
    // observed before this transport can admit another worker; a lingering
    // identity keeps the slot occupied.
    const connection = new StdioCursorAcpConnection(child, worker, request, {
      identityProbe: this.#identityProbe,
      killProcessGroup: this.#killProcessGroup,
      maxLineBytes: this.#maxLineBytes,
      closeGraceMs: this.#closeGraceMs,
      terminationGraceMs: this.#terminationGraceMs,
    }, () => { this.#active = false; });
    // Coordinator persistence happens before any JSON-RPC message can be written.
    try {
      await request.lifecycle?.onStarted(worker);
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
    return connection;
  }
}
