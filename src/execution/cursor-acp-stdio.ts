import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

import type { CursorAcpConnection, CursorAcpConnectRequest, CursorAcpInboundReply, CursorAcpNotification, CursorAcpRpcRequest, CursorAcpTransport } from '../providers/cursor.ts';
import type { NativeIdentityObservation } from './index.ts';
import type { NativeWorkerIdentity, WorkerIdentity } from '../runtime/contracts.ts';

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
}

export interface CursorAcpStdioTransportOptions {
  /** Exact allowlisted process environment. Ambient environment is never merged. */
  environment: Readonly<Record<string, string>>;
  identityProbe: CursorAcpNativeIdentityProbe;
  runNonce: string;
  spawn?: CursorAcpStdioSpawn;
  maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
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
  readonly worker: WorkerIdentity;
  readonly #child: CursorAcpStdioChild;
  readonly #request: CursorAcpConnectRequest;
  readonly #maxLineBytes: number;
  readonly #onClosed: () => void;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #completed = new Set<string>();
  #handler?: (request: CursorAcpRpcRequest) => Promise<CursorAcpInboundReply>;
  #notificationHandler?: (notification: CursorAcpNotification) => Promise<void>;
  #inboundTail: Promise<void> = Promise.resolve();
  #notificationTail: Promise<void> = Promise.resolve();
  #buffer = Buffer.alloc(0);
  #closed = false;
  #termination?: Promise<void>;

  constructor(child: CursorAcpStdioChild, worker: NativeWorkerIdentity, request: CursorAcpConnectRequest, maxLineBytes: number, onClosed: () => void) {
    this.#child = child;
    this.worker = worker;
    this.#request = request;
    this.#maxLineBytes = maxLineBytes;
    this.#onClosed = onClosed;
    child.stdout?.on('data', (chunk) => this.#onData(chunk));
    child.on('error', (error) => this.#lost(`Cursor ACP process error: ${errorMessage(error)}`));
    child.on('close', (code, signal) => this.#lost(`Cursor ACP connection closed before a terminal receipt (exit ${code ?? 'null'}${signal ? `, ${signal}` : ''})`));
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
        void this.#requireTermination('timeout').catch(() => undefined);
      }, timeoutMs);
      this.#pending.set(key, { resolve, reject, timeout });
      try {
        this.#write({ jsonrpc: '2.0', id: request.id, method: request.method, ...(request.params === undefined ? {} : { params: request.params }) });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(key);
        reject(new Error(errorMessage(error)));
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
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Cursor ACP connection closed'));
    }
    this.#pending.clear();
    // EOF is a safe local close. Process-group termination remains exclusively
    // coordinator-authorized through lifecycle.onTerminationRequired.
    try { this.#child.stdin?.end(); } catch { /* process may have already exited */ }
    this.#onClosed();
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
      this.#lost('Cursor ACP stdin failed while replying to provider request');
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
    this.#lost(message);
    void this.#requireTermination('output_limit').catch(() => undefined);
  }

  #lost(message: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.#pending.clear();
    this.#onClosed();
  }

  async #requireTermination(reason: 'timeout' | 'output_limit'): Promise<void> {
    if (this.#termination !== undefined) return this.#termination;
    const lifecycle = this.#request.lifecycle;
    this.#termination = lifecycle?.onTerminationRequired === undefined
      ? Promise.resolve()
      : lifecycle.onTerminationRequired(this.worker, reason);
    return this.#termination;
  }
}

/** Shipped stdio transport for the observed `cursor agent acp` protocol. */
export class CursorAcpStdioTransport implements CursorAcpTransport {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #identityProbe: CursorAcpNativeIdentityProbe;
  readonly #runNonce: string;
  readonly #spawn: CursorAcpStdioSpawn;
  readonly #maxLineBytes: number;
  #active = false;

  constructor(options: CursorAcpStdioTransportOptions) {
    if (!validEnvironment(options.environment)) throw new Error('Cursor ACP stdio transport requires a nonempty controlled environment');
    if (options.runNonce.trim().length === 0) throw new Error('Cursor ACP stdio transport requires a run nonce');
    if (!Number.isInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES) || (options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES) < 1) throw new Error('Cursor ACP stdio transport requires a positive line limit');
    this.#environment = Object.freeze({ ...options.environment });
    this.#identityProbe = options.identityProbe;
    this.#runNonce = options.runNonce;
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
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
    if (child.pid === undefined || child.pid < 1 || child.stdin === null || child.stdin === undefined || child.stdout === null || child.stdout === undefined) throw new Error('Cursor ACP spawn did not provide stdio and pid');
    const observed = await this.#identityProbe.inspect(child.pid);
    if (observed === undefined || 'status' in observed || !observed.running || observed.pid !== child.pid) {
      try { child.stdin.end(); } catch { /* process may already have exited */ }
      throw new Error('Cursor ACP native worker identity could not be observed');
    }
    const worker: NativeWorkerIdentity = { kind: 'native', pid: child.pid, processStartedAt: observed.processStartedAt, processGroupId: observed.processGroupId, runNonce: this.#runNonce };
    if (!sameNativeWorker(worker, observed)) {
      try { child.stdin.end(); } catch { /* process may already have exited */ }
      throw new Error('Cursor ACP native worker identity changed before lifecycle receipt');
    }
    // Coordinator persistence happens before any JSON-RPC message can be written.
    try {
      await request.lifecycle?.onStarted(worker);
    } catch (error) {
      try { child.stdin.end(); } catch { /* process may already have exited */ }
      throw error;
    }
    this.#active = true;
    return new StdioCursorAcpConnection(child, worker, request, this.#maxLineBytes, () => { this.#active = false; });
  }
}
