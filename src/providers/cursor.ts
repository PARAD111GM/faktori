import type { ProviderFinalResult, RunIntent, UsageTelemetry, WorkerIdentity } from '../runtime/contracts.ts';
import type {
  ProviderCurrentContext,
  ProviderNormalizedEvent,
  ProviderRunResult,
  ProviderSessionBinding,
  ProviderTurnAdapter,
  ProviderTurnLifecycle,
} from './contracts.ts';

type JsonRecord = Record<string, unknown>;
type Outcome = ProviderFinalResult['outcome'];

export interface CursorAcpLimits {
  maxRuntimeMinutes: number;
  maxTokens: number;
  maxRetries: number;
  requestTimeoutMs: number;
}

/** A deliberately small injected ACP stdio boundary; it owns no credentials. */
export interface CursorAcpTransport {
  connect(request: CursorAcpConnectRequest): Promise<CursorAcpConnection>;
}

export interface CursorAcpConnectRequest {
  runId: string;
  command: 'cursor agent acp';
  /** Private operational path; do not put it in public records. */
  cwd: string;
  timeoutMs: number;
  lifecycle?: ProviderTurnLifecycle;
}

export interface CursorAcpRpcRequest {
  id: string | number;
  method: string;
  params?: JsonRecord;
}

export interface CursorAcpConnection {
  request(request: CursorAcpRpcRequest, timeoutMs: number): Promise<JsonRecord>;
  notify(method: string, params: JsonRecord): Promise<void>;
  /** The transport must deliver every inbound JSON-RPC request exactly as received. */
  setRequestHandler?(handler: (request: CursorAcpRpcRequest) => Promise<CursorAcpInboundReply>): void;
  close?(): Promise<void>;
  /** Present only when the transport has an exact, durable worker identity. */
  worker?: WorkerIdentity;
}

export type CursorAcpInboundReply =
  | { result: JsonRecord }
  | { error: { code: number; message: string } };

/** Replies are supplied by the coordinator; provider payloads never decide them. */
export interface CursorAcpReplyPolicy {
  permission?(request: CursorAcpRpcRequest, intent: RunIntent): Promise<CursorAcpInboundReply | undefined>;
  question?(request: CursorAcpRpcRequest, intent: RunIntent): Promise<CursorAcpInboundReply | undefined>;
  plan?(request: CursorAcpRpcRequest, intent: RunIntent): Promise<CursorAcpInboundReply | undefined>;
}

export interface CursorAcpAdapterOptions {
  transport: CursorAcpTransport;
  limits: CursorAcpLimits;
  replyPolicy?: CursorAcpReplyPolicy;
  clientInfo?: { name: string; version: string };
}

export interface CursorAcpCapabilities {
  sessionLifecycle: 'initialize_authenticate_new_or_load';
  resume: true;
  cancellation: 'session_cancel_notification_terminal_receipt_required';
  permissionReplies: 'protocol_handler_unobserved';
  questionReplies: 'protocol_handler_unobserved';
  planReplies: 'protocol_handler_unobserved';
  usage: 'unavailable_not_emitted_in_observed_flow';
}

export type CursorCurrentContext = ProviderCurrentContext;
export type CursorSessionBinding = ProviderSessionBinding;
export type CursorNormalizedEvent = ProviderNormalizedEvent;
export type CursorRunResult = ProviderRunResult;

const CAPABILITIES: CursorAcpCapabilities = Object.freeze({
  sessionLifecycle: 'initialize_authenticate_new_or_load',
  resume: true,
  cancellation: 'session_cancel_notification_terminal_receipt_required',
  permissionReplies: 'protocol_handler_unobserved',
  questionReplies: 'protocol_handler_unobserved',
  planReplies: 'protocol_handler_unobserved',
  usage: 'unavailable_not_emitted_in_observed_flow',
});

const MAX_EVIDENCE = 320;
const SUCCESS_STOPS = new Set(['completed', 'end_turn', 'finished']);

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function sanitize(value: string): string | undefined {
  const compact = value
    .replace(/(?:bearer|token|api[_-]?key|authorization)\s*[=:]?\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\/(?:Users|home)\/[^\s,;]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > 0 ? compact.slice(0, MAX_EVIDENCE) : undefined;
}

function classify(value: unknown): Outcome {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (/auth|login|credential/.test(text)) return 'authentication_required';
  if (/quota|rate.?limit|usage.?limit|capacity/.test(text)) return 'quota_exhausted';
  if (/permission|denied|approval/.test(text)) return 'denied';
  if (/cancel/.test(text)) return 'cancelled';
  if (/unavailable|not.?installed|connection|spawn|eof|timed?\s*out|timeout/.test(text)) return 'unavailable';
  return 'failed';
}

function unavailable(reason: string): ProviderFinalResult {
  return {
    outcome: 'unavailable',
    summary: reason,
    usage: { availability: 'unavailable', unavailableReason: reason },
    nativeCancellationReceipt: false,
  };
}

function usageUnavailable(reason = 'Cursor ACP did not emit usage telemetry'): UsageTelemetry {
  return { availability: 'unavailable', unavailableReason: reason };
}

function validIntent(intent: RunIntent, limits: CursorAcpLimits): string | undefined {
  if (intent.execution.providerId !== 'cursor') return 'run intent is not assigned to the cursor provider';
  if (!nonEmpty(intent.execution.workspacePath)) return 'run intent has no recorded workspace path';
  if (!Number.isInteger(intent.attempt) || intent.attempt < 1 || intent.attempt > limits.maxRetries + 1) return 'run attempt exceeds the configured retry bound';
  if (!Number.isInteger(intent.budget.maxRuntimeMinutes) || intent.budget.maxRuntimeMinutes < 1 || intent.budget.maxRuntimeMinutes > limits.maxRuntimeMinutes) return 'run runtime exceeds the configured runtime bound';
  if (!Number.isInteger(intent.budget.estimatedTokens) || intent.budget.estimatedTokens < 0 || intent.budget.estimatedTokens > limits.maxTokens) return 'run token estimate exceeds the configured token bound';
  if (!positiveInteger(limits.requestTimeoutMs)) return 'a positive ACP request timeout is required';
  return undefined;
}

function validContext(intent: RunIntent, current: CursorCurrentContext): string | undefined {
  if (current.packetRevision !== intent.context.packetRevision || current.digest !== intent.context.digest) return 'current context reference does not match the run intent';
  if (!nonEmpty(current.prompt)) return 'current context packet and prompt are required';
  return undefined;
}

function validBinding(intent: RunIntent, binding: CursorSessionBinding): boolean {
  const scope = binding.sourceScope;
  return nonEmpty(binding.sessionId) !== undefined
    && nonEmpty(binding.sourceRunId) !== undefined
    && nonEmpty(binding.sourceContext.packetRevision) !== undefined
    && nonEmpty(binding.sourceContext.digest) !== undefined
    && scope.factoryId === intent.target.factoryId
    && scope.productId === intent.target.productId
    && scope.repository === intent.target.repository
    && scope.workspaceId === intent.execution.workspaceId
    && scope.workspacePath === intent.execution.workspacePath
    && scope.providerId === intent.execution.providerId;
}

function rpcError(response: JsonRecord): string | undefined {
  const error = record(response.error) ? response.error : undefined;
  if (!error) return undefined;
  const code = typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code) : undefined;
  return [code, nonEmpty(error.message)].filter(Boolean).join(': ') || 'Cursor ACP returned a malformed error response';
}

function sessionId(response: JsonRecord): string | undefined {
  return nonEmpty(response.sessionId) ?? nonEmpty(response.session_id);
}

function stopReason(response: JsonRecord): string | undefined {
  return nonEmpty(response.stopReason) ?? nonEmpty(response.stop_reason);
}

function requestId(runId: string, step: string): string {
  return `faktori:${runId}:${step}`;
}

function inboundKey(request: CursorAcpRpcRequest): string {
  return `${String(request.id)}:${request.method}`;
}

function sameInbound(left: CursorAcpRpcRequest, right: CursorAcpRpcRequest): boolean {
  try {
    return left.method === right.method && JSON.stringify(left.params ?? {}) === JSON.stringify(right.params ?? {});
  } catch {
    return false;
  }
}

interface ActiveTurn {
  connection: CursorAcpConnection;
  sessionId: string;
  lifecycle?: ProviderTurnLifecycle;
  worker?: WorkerIdentity;
}

/**
 * Cursor's documented ACP lifecycle, intentionally kept as a bounded stdio
 * client. All native requests are explicit; no latest-session or synthetic
 * usage/approval receipt is inferred by this adapter.
 */
export class CursorAcpAdapter implements ProviderTurnAdapter {
  readonly capabilities = CAPABILITIES;
  readonly #transport: CursorAcpTransport;
  readonly #limits: CursorAcpLimits;
  readonly #replyPolicy?: CursorAcpReplyPolicy;
  readonly #clientInfo: { name: string; version: string };
  readonly #active = new Map<string, ActiveTurn>();
  readonly #inFlight = new Map<string, { signature: string; result: Promise<CursorRunResult> }>();

  constructor(options: CursorAcpAdapterOptions) {
    this.#transport = options.transport;
    this.#limits = options.limits;
    this.#replyPolicy = options.replyPolicy;
    this.#clientInfo = options.clientInfo ?? { name: 'faktori', version: '0.0.0' };
  }

  async start(intent: RunIntent, current: CursorCurrentContext, lifecycle?: ProviderTurnLifecycle): Promise<CursorRunResult> {
    const invalid = validIntent(intent, this.#limits) ?? validContext(intent, current);
    if (invalid) return this.#failedStart('start', invalid);
    return this.#deduplicated('start', intent, current, undefined, lifecycle);
  }

  async resume(intent: RunIntent, binding: CursorSessionBinding, current: CursorCurrentContext, lifecycle?: ProviderTurnLifecycle): Promise<CursorRunResult> {
    const invalid = validIntent(intent, this.#limits)
      ?? validContext(intent, current)
      ?? (validBinding(intent, binding) ? undefined : 'an explicit coordinator-recorded Cursor session binding is required for resume');
    if (invalid) return this.#failedStart('resume', invalid);
    return this.#deduplicated('resume', intent, current, binding, lifecycle);
  }

  async cancel(intent: RunIntent, lifecycle?: ProviderTurnLifecycle): Promise<ProviderFinalResult> {
    const invalid = validIntent(intent, this.#limits);
    if (invalid) return unavailable(invalid);
    const active = this.#active.get(intent.runId);
    if (active === undefined) return unavailable('no active Cursor ACP turn has an explicit session to cancel');
    try {
      await active.connection.notify('session/cancel', { sessionId: active.sessionId });
      const worker = active.worker ?? active.connection.worker;
      if (worker !== undefined && (lifecycle ?? active.lifecycle)?.onTerminationRequired !== undefined) {
        await (lifecycle ?? active.lifecycle)?.onTerminationRequired?.(worker, 'cancelled');
      }
      // session/cancel is a notification. A cancelled outcome needs the later
      // terminal stopReason, so this call cannot manufacture a receipt.
      return {
        outcome: 'interrupted_uncertain',
        summary: 'Cursor ACP cancellation notification was sent; awaiting a native terminal cancellation receipt',
        usage: usageUnavailable('cancellation does not supply usage telemetry'),
        nativeCancellationReceipt: false,
      };
    } catch (error) {
      return {
        outcome: 'interrupted_uncertain',
        summary: sanitize(error instanceof Error ? error.message : 'Cursor ACP cancellation transport failed') ?? 'Cursor ACP cancellation transport failed',
        usage: usageUnavailable('cancellation transport failed'),
        nativeCancellationReceipt: false,
      };
    }
  }

  async #run(command: 'start' | 'resume', intent: RunIntent, current: CursorCurrentContext, binding: CursorSessionBinding | undefined, lifecycle?: ProviderTurnLifecycle): Promise<CursorRunResult> {
    const events: CursorNormalizedEvent[] = [];
    let malformedEventCount = 0;
    let connection: CursorAcpConnection | undefined;
    try {
      connection = await this.#transport.connect({
        runId: intent.runId,
        command: 'cursor agent acp',
        cwd: intent.execution.workspacePath,
        timeoutMs: intent.budget.maxRuntimeMinutes * 60_000,
        ...(lifecycle === undefined ? {} : { lifecycle }),
      });
      const inbound = new Map<string, { request: CursorAcpRpcRequest; reply: CursorAcpInboundReply }>();
      connection.setRequestHandler?.(async (request) => {
        if (!record(request) || (typeof request.id !== 'string' && (typeof request.id !== 'number' || !Number.isFinite(request.id))) || !nonEmpty(request.method) || (request.params !== undefined && !record(request.params))) {
          malformedEventCount += 1;
          return { error: { code: -32600, message: 'invalid ACP request' } };
        }
        const key = inboundKey(request);
        const prior = inbound.get(key);
        if (prior !== undefined) {
          if (!sameInbound(prior.request, request)) {
            malformedEventCount += 1;
            return { error: { code: -32600, message: 'conflicting duplicate ACP request id' } };
          }
          return prior.reply;
        }
        const reply = await this.#replyFor(request, intent);
        inbound.set(key, { request, reply });
        events.push({ type: `acp.${request.method}`, raw: { id: request.id, method: request.method, ...(request.params === undefined ? {} : { params: request.params }) } });
        return reply;
      });

      const initialize = await this.#request(connection, intent.runId, 'initialize', 'initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: this.#clientInfo,
      });
      events.push({ type: 'acp.initialize', raw: initialize });
      if (rpcError(initialize)) return this.#result(command, events, malformedEventCount, this.#errorFinal(rpcError(initialize) as string));
      if (binding !== undefined && (!record(initialize.agentCapabilities) || initialize.agentCapabilities.loadSession !== true)) {
        return this.#result(command, events, malformedEventCount, unavailable('Cursor ACP did not advertise loadSession for this explicit resume'));
      }

      const authenticated = await this.#request(connection, intent.runId, 'authenticate', 'authenticate', { methodId: 'cursor_login' });
      events.push({ type: 'acp.authenticate', raw: authenticated });
      if (rpcError(authenticated)) return this.#result(command, events, malformedEventCount, this.#errorFinal(rpcError(authenticated) as string));

      const session = binding === undefined
        ? await this.#request(connection, intent.runId, 'session-new', 'session/new', { cwd: intent.execution.workspacePath, mcpServers: [] })
        : await this.#request(connection, intent.runId, 'session-load', 'session/load', { sessionId: binding.sessionId, cwd: intent.execution.workspacePath, mcpServers: [] });
      events.push({ type: binding === undefined ? 'acp.session.new' : 'acp.session.load', raw: session });
      if (rpcError(session)) return this.#result(command, events, malformedEventCount, this.#errorFinal(rpcError(session) as string));
      const establishedSession = sessionId(session) ?? (binding === undefined ? undefined : binding.sessionId);
      if (!establishedSession) return this.#result(command, events, malformedEventCount, this.#errorFinal('Cursor ACP session response omitted sessionId'));

      this.#active.set(intent.runId, { connection, sessionId: establishedSession, lifecycle, worker: connection.worker });
      const prompt = await this.#request(connection, intent.runId, 'session-prompt', 'session/prompt', {
        sessionId: establishedSession,
        prompt: [{ type: 'text', text: current.prompt.trim() }],
      });
      events.push({ type: 'acp.session.prompt', raw: prompt });
      if (rpcError(prompt)) return this.#result(command, events, malformedEventCount, this.#errorFinal(rpcError(prompt) as string, establishedSession));
      const stop = stopReason(prompt);
      if (stop === 'cancelled') return this.#result(command, events, malformedEventCount, { outcome: 'cancelled', sessionId: establishedSession, summary: 'Cursor ACP terminal stopReason: cancelled', usage: usageUnavailable(), nativeCancellationReceipt: true });
      if (!stop || !SUCCESS_STOPS.has(stop)) return this.#result(command, events, malformedEventCount, { outcome: 'failed', sessionId: establishedSession, summary: `Cursor ACP returned unsupported or missing terminal stopReason${stop ? `: ${sanitize(stop)}` : ''}`, usage: usageUnavailable(), nativeCancellationReceipt: false });
      if (malformedEventCount > 0) return this.#result(command, events, malformedEventCount, { outcome: 'failed', sessionId: establishedSession, summary: 'Cursor ACP emitted malformed or conflicting requests', usage: usageUnavailable(), nativeCancellationReceipt: false });
      return this.#result(command, events, malformedEventCount, { outcome: 'completed', sessionId: establishedSession, usage: usageUnavailable(), nativeCancellationReceipt: false });
    } catch (error) {
      const evidence = sanitize(error instanceof Error ? error.message : 'Cursor ACP connection lost');
      return this.#result(command, events, malformedEventCount, {
        outcome: classify(evidence),
        ...(evidence ? { summary: evidence } : {}),
        usage: usageUnavailable('Cursor ACP transport failed before a terminal receipt'),
        nativeCancellationReceipt: false,
      }, evidence);
    } finally {
      this.#active.delete(intent.runId);
      await connection?.close?.().catch(() => undefined);
    }
  }

  async #request(connection: CursorAcpConnection, runId: string, step: string, method: string, params: JsonRecord): Promise<JsonRecord> {
    const timeout = this.#limits.requestTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        connection.request({ id: requestId(runId, step), method, params }, timeout),
        new Promise<JsonRecord>((_, reject) => { timer = setTimeout(() => reject(new Error(`Cursor ACP ${method} request timed out`)), timeout); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #deduplicated(command: 'start' | 'resume', intent: RunIntent, current: CursorCurrentContext, binding: CursorSessionBinding | undefined, lifecycle?: ProviderTurnLifecycle): Promise<CursorRunResult> {
    const signature = JSON.stringify({ command, packetRevision: current.packetRevision, digest: current.digest, sessionId: binding?.sessionId });
    const prior = this.#inFlight.get(intent.runId);
    if (prior !== undefined) {
      return prior.signature === signature
        ? prior.result
        : Promise.resolve(this.#failedStart(command, 'conflicting duplicate Cursor ACP turn for the same run id'));
    }
    const result = this.#run(command, intent, current, binding, lifecycle);
    this.#inFlight.set(intent.runId, { signature, result });
    void result.finally(() => {
      const active = this.#inFlight.get(intent.runId);
      if (active?.result === result) this.#inFlight.delete(intent.runId);
    });
    return result;
  }

  async #replyFor(request: CursorAcpRpcRequest, intent: RunIntent): Promise<CursorAcpInboundReply> {
    const policy = request.method === 'session/request_permission' ? this.#replyPolicy?.permission
      : request.method === 'session/request_question' || request.method === 'session/request_user_input' ? this.#replyPolicy?.question
        : request.method === 'session/request_plan' ? this.#replyPolicy?.plan : undefined;
    if (policy === undefined) return { error: { code: -32601, message: 'ACP request is unsupported by the coordinator reply policy' } };
    try {
      return await policy(request, intent) ?? { error: { code: -32001, message: 'coordinator denied ACP request' } };
    } catch {
      return { error: { code: -32001, message: 'coordinator reply policy failed closed' } };
    }
  }

  #errorFinal(error: string, session?: string): ProviderFinalResult {
    return { outcome: classify(error), ...(session ? { sessionId: session } : {}), summary: sanitize(error), usage: usageUnavailable(), nativeCancellationReceipt: false };
  }

  #result(command: 'start' | 'resume', events: CursorNormalizedEvent[], malformedEventCount: number, final: ProviderFinalResult, errorEvidence?: string): CursorRunResult {
    return { command, ...(final.sessionId ? { sessionId: final.sessionId } : {}), events, malformedEventCount, ...(errorEvidence ? { errorEvidence } : {}), final };
  }

  #failedStart(command: 'start' | 'resume', reason: string): CursorRunResult {
    return { command, events: [], malformedEventCount: 0, final: unavailable(reason) };
  }
}

/** Matches the provider adapter naming used by the existing Codex transport. */
export { CursorAcpAdapter as CursorAdapter };
