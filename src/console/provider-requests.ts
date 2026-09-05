import type { CursorAcpInboundReply, CursorAcpReplyPolicy, CursorAcpRpcRequest } from '../providers/cursor.ts';
import type { RunIntent } from '../runtime/contracts.ts';
import type { DurableCoordinator } from '../runtime/coordinator.ts';

const UNSAFE = /(?:bearer\s+|authorization|api[_ -]?key|credential|secret|session[_ -]?id|\/Users\/|\\Users\\|\.codex|\.claude)/i;

type Pending = {
  method: string;
  requestId: string;
  resolve(reply: CursorAcpInboundReply): void;
  timer: ReturnType<typeof setTimeout>;
};

function id(request: CursorAcpRpcRequest): string {
  return `${typeof request.id}:${String(request.id)}`;
}

function safeText(value: unknown, maximum = 1_000): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !UNSAFE.test(value) ? value : undefined;
}

function presentation(request: CursorAcpRpcRequest): { prompt: string; options: string[] } {
  const params = request.params ?? {};
  const prompt = ['question', 'prompt', 'message', 'title', 'description', 'plan']
    .map((key) => safeText(params[key]))
    .find((value) => value !== undefined) ?? `Provider request: ${request.method}`;
  const rawOptions = Array.isArray(params.options) ? params.options : [];
  const options = rawOptions.map((value) => safeText(value, 128)).filter((value): value is string => value !== undefined).slice(0, 12);
  return { prompt, options };
}

function affirmative(answer: string): boolean {
  return /^(?:approve|approved|allow|allow-once|accept|accepted|yes|true)$/i.test(answer.trim());
}

function reply(method: string, answer: string): CursorAcpInboundReply {
  if (method === 'session/request_permission') return { result: { approved: affirmative(answer) } };
  if (method === 'session/request_plan') return { result: { accepted: affirmative(answer) } };
  return { result: { answer } };
}

/** Durable owner-response bridge for the provider requests Cursor ACP exposes. */
export class ConsoleProviderRequestBroker {
  readonly #coordinator: DurableCoordinator;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Pending>();

  constructor(options: { coordinator: DurableCoordinator; timeoutMs: number }) {
    this.#coordinator = options.coordinator;
    this.#timeoutMs = options.timeoutMs;
  }

  replyPolicy(): CursorAcpReplyPolicy {
    const request = (value: CursorAcpRpcRequest, intent: RunIntent): Promise<CursorAcpInboundReply> => this.request(value, intent);
    return { permission: request, question: request, plan: request };
  }

  async answer(runId: string, requestId: string, answer: string): Promise<{ detail: string }> {
    const key = `${runId}\u0000${requestId}`;
    const pending = this.#pending.get(key);
    if (pending === undefined) throw new Error('provider_request_not_pending');
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    await this.#coordinator.record('provider.request.answered', runId, { request: { requestId, method: pending.method, status: 'answered', observedAt: new Date().toISOString() } });
    pending.resolve(reply(pending.method, answer));
    return { detail: 'provider_request_answered' };
  }

  close(): void {
    for (const [key, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve({ error: { code: -32001, message: 'Console provider request bridge closed' } });
      this.#pending.delete(key);
    }
  }

  private async request(request: CursorAcpRpcRequest, intent: RunIntent): Promise<CursorAcpInboundReply> {
    const requestId = id(request);
    const key = `${intent.runId}\u0000${requestId}`;
    if (this.#pending.has(key)) throw new Error('conflicting duplicate pending provider request');
    const shown = presentation(request);
    await this.#coordinator.record('provider.requested', intent.runId, { request: { requestId, method: request.method, ...shown, status: 'pending', observedAt: new Date().toISOString() } });
    return new Promise<CursorAcpInboundReply>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(key);
        if (pending === undefined) return;
        this.#pending.delete(key);
        void this.#coordinator.record('provider.request.answered', intent.runId, { request: { requestId, method: request.method, status: 'timed_out', observedAt: new Date().toISOString() } });
        resolve({ error: { code: -32001, message: 'Owner response window expired' } });
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(key, { method: request.method, requestId, resolve, timer });
    });
  }
}
