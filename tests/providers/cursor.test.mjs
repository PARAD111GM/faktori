import { describe, expect, it } from 'vitest';

import { CursorAcpAdapter } from '../../src/providers/cursor.ts';

function intent(overrides = {}) {
  const execution = {
    profile: 'native', workspaceId: 'job-77', workspacePath: '/job-workspaces/job-77', providerId: 'cursor', model: 'cursor-default', approvedInputDigests: ['sha256:input'], ...(overrides.execution ?? {}),
  };
  return {
    format: 'faktori.run-intent/v1', runId: 'run-77', admissionKey: 'admission-77', workItem: { id: 'F3-02', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'owner/repository', branch: 'build/f3', baseRevision: 'base@1', expectedRevision: 'expected@1' },
    context: { packetRevision: 'packet@4', digest: 'sha256:packet' }, execution,
    budget: { reservationId: 'reserve-77', maxRuntimeMinutes: 3, estimatedTokens: 500, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 2, scopeDigest: 'sha256:scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1, createdAt: '2026-09-05T01:00:00.000Z', ...overrides, execution,
  };
}

function context(overrides = {}) {
  return { packetRevision: 'packet@4', digest: 'sha256:packet', prompt: 'Execute only the admitted bounded work.', ...overrides };
}

function binding(overrides = {}) {
  return {
    sessionId: 'cursor-session-77', sourceRunId: 'run-77', sourceContext: { packetRevision: 'packet@3', digest: 'sha256:previous' },
    sourceScope: { factoryId: 'factory', productId: 'product', repository: 'owner/repository', workspaceId: 'job-77', workspacePath: '/job-workspaces/job-77', providerId: 'cursor' }, ...overrides,
  };
}

function worker() {
  return { kind: 'native', pid: 77, processStartedAt: '2026-09-05T01:00:01.000Z', processGroupId: 77, runNonce: 'cursor-worker-nonce' };
}

function fakeTransport(responses = {}, options = {}) {
  const calls = [];
  const notifications = [];
  let handler;
  let notificationHandler;
  const connection = {
    worker: options.worker,
    setRequestHandler(value) { handler = value; },
    setNotificationHandler(value) { notificationHandler = value; },
    async request(request, timeoutMs) {
      calls.push({ request, timeoutMs });
      const response = responses[request.method];
      if (typeof response === 'function') return response(request, { handler, notificationHandler, notifications });
      if (response instanceof Error) throw response;
      return response ?? {};
    },
    async notify(method, params) { notifications.push({ method, params }); },
    async close() { options.closed?.(); },
  };
  return {
    calls, notifications, connection,
    async connect(request) {
      options.connected?.(request);
      if (options.connectError) throw options.connectError;
      if (options.lifecycle) await request.lifecycle?.onStarted(options.lifecycle);
      return connection;
    },
  };
}

function adapter(transport, options = {}) {
  return new CursorAcpAdapter({ transport, limits: { maxRuntimeMinutes: 5, maxTokens: 1_000, maxRetries: 1, requestTimeoutMs: 25, ...(options.limits ?? {}) }, replyPolicy: options.replyPolicy });
}

function standardResponses(overrides = {}) {
  return {
    initialize: { agentCapabilities: { loadSession: true } },
    authenticate: {},
    'session/new': { sessionId: 'cursor-session-77' },
    'session/load': { sessionId: 'cursor-session-77' },
    'session/prompt': { stopReason: 'completed' },
    ...overrides,
  };
}

describe('bounded Cursor ACP adapter', () => {
  it('uses explicit initialize, authenticate, session/new, and prompt requests with bounded correlation ids', async () => {
    const transport = fakeTransport(standardResponses());
    const result = await adapter(transport).start(intent(), context());

    expect(result.final).toEqual(expect.objectContaining({ outcome: 'completed', sessionId: 'cursor-session-77', usage: { availability: 'unavailable', unavailableReason: expect.stringMatching(/did not emit/) } }));
    expect(transport.calls.map((call) => call.request.method)).toEqual(['initialize', 'authenticate', 'session/new', 'session/prompt']);
    expect(transport.calls.map((call) => call.request.id)).toEqual(['faktori:run-77:initialize', 'faktori:run-77:authenticate', 'faktori:run-77:session-new', 'faktori:run-77:session-prompt']);
    expect(transport.calls[2].request.params).toEqual({ cwd: '/job-workspaces/job-77', mcpServers: [] });
  });

  it('loads only an explicit coordinator-bound prior session and never selects an implicit latest session', async () => {
    const transport = fakeTransport(standardResponses());
    const result = await adapter(transport).resume(intent(), binding(), context());
    const bad = await adapter(fakeTransport(standardResponses())).resume(intent(), binding({ sourceScope: { ...binding().sourceScope, workspaceId: 'wrong' } }), context());

    expect(result.final.outcome).toBe('completed');
    expect(transport.calls.map((call) => call.request.method)).toEqual(['initialize', 'authenticate', 'session/load', 'session/prompt']);
    expect(transport.calls[2].request.params.sessionId).toBe('cursor-session-77');
    expect(bad.final.outcome).toBe('unavailable');
  });

  it('does not attempt session/load when Cursor did not advertise that capability', async () => {
    const transport = fakeTransport(standardResponses({ initialize: { agentCapabilities: { loadSession: false } } }));
    const result = await adapter(transport).resume(intent(), binding(), context());
    expect(result.final.outcome).toBe('unavailable');
    expect(transport.calls.map((call) => call.request.method)).toEqual(['initialize']);
  });

  it('fails closed for unbound contexts, invalid bounds, and wrong providers before opening ACP', async () => {
    const transport = fakeTransport(standardResponses());
    const provider = adapter(transport);
    const results = await Promise.all([
      provider.start(intent(), context({ digest: 'sha256:stale' })),
      provider.start(intent({ execution: { providerId: 'codex' } }), context()),
      provider.start(intent({ budget: { reservationId: 'reserve', maxRuntimeMinutes: 8, estimatedTokens: 1, status: 'held' } }), context()),
      adapter(fakeTransport(standardResponses()), { limits: { requestTimeoutMs: 0 } }).start(intent(), context()),
    ]);
    for (const result of results) expect(result.final.outcome).toBe('unavailable');
    expect(transport.calls).toEqual([]);
  });

  it('handles coordinator-supplied permission/question/plan replies exactly once without provider authority', async () => {
    const seen = [];
    const responses = standardResponses({
      'session/prompt': async (_request, state) => {
        const permission = { id: 1, method: 'session/request_permission', params: { options: ['allow-once'] } };
        const question = { id: 2, method: 'session/request_question', params: { question: 'continue?' } };
        const plan = { id: 3, method: 'session/request_plan', params: { plan: 'bounded' } };
        expect(await state.handler(permission)).toEqual({ result: { approved: false } });
        expect(await state.handler(permission)).toEqual({ result: { approved: false } });
        expect(await state.handler(question)).toEqual({ result: { answer: 'no' } });
        expect(await state.handler(plan)).toEqual({ result: { accepted: false } });
        return { stopReason: 'completed' };
      },
    });
    const transport = fakeTransport(responses);
    const result = await adapter(transport, {
      replyPolicy: {
        async permission(request) { seen.push(request.method); return { result: { approved: false } }; },
        async question(request) { seen.push(request.method); return { result: { answer: 'no' } }; },
        async plan(request) { seen.push(request.method); return { result: { accepted: false } }; },
      },
    }).start(intent(), context());

    expect(result.final.outcome).toBe('completed');
    expect(seen).toEqual(['session/request_permission', 'session/request_question', 'session/request_plan']);
    expect(result.events.filter((event) => event.type.startsWith('acp.session/request_'))).toHaveLength(3);
  });

  it('records id-less session/update and unknown notifications as bounded observations, never authority or outcomes', async () => {
    const result = await adapter(fakeTransport(standardResponses({
      'session/prompt': async (_request, state) => {
        await state.notificationHandler({ method: 'session/update', params: { text: 'provider progress', nested: { detail: 'x'.repeat(500) } } });
        await state.notificationHandler({ method: 'cursor/unknown_observation', params: { sequence: 1 } });
        return { stopReason: 'completed' };
      },
    }))).start(intent(), context());

    expect(result.final.outcome).toBe('completed');
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'acp.session/update', raw: expect.objectContaining({ notification: true, method: 'session/update' }) }),
      expect.objectContaining({ type: 'acp.cursor/unknown_observation', raw: expect.objectContaining({ notification: true, method: 'cursor/unknown_observation' }) }),
    ]));
    expect(result.events.some((event) => Object.hasOwn(event.raw, 'authority') || Object.hasOwn(event.raw, 'outcome'))).toBe(false);
  });

  it('fails closed for unsupported, malformed, and conflicting duplicate provider requests', async () => {
    const responses = standardResponses({
      'session/prompt': async (_request, state) => {
        expect(await state.handler({ id: 1, method: 'session/unknown', params: {} })).toEqual(expect.objectContaining({ error: expect.anything() }));
        expect(await state.handler({ id: 2, method: 'session/request_permission', params: {} })).toEqual(expect.objectContaining({ error: expect.anything() }));
        await state.handler({ id: 3, method: 'session/request_question', params: {} });
        expect(await state.handler({ id: 3, method: 'session/request_question', params: { changed: true } })).toEqual(expect.objectContaining({ error: expect.anything() }));
        expect(await state.handler({ id: {}, method: 'session/request_question', params: {} })).toEqual(expect.objectContaining({ error: expect.anything() }));
        return { stopReason: 'completed' };
      },
    });
    const result = await adapter(fakeTransport(responses), { replyPolicy: { async question() { return { result: { answer: 'no' } }; } } }).start(intent(), context());
    expect(result.final.outcome).toBe('failed');
    expect(result.malformedEventCount).toBe(2);
  });

  it.each([
    ['authentication_required', { error: { code: -32000, message: 'login required' } }],
    ['quota_exhausted', { error: { code: -32000, message: 'rate limit exceeded' } }],
    ['denied', { error: { code: -32000, message: 'permission denied' } }],
  ])('normalizes %s without treating agent text as evidence', async (outcome, prompt) => {
    const result = await adapter(fakeTransport(standardResponses({ 'session/prompt': prompt }))).start(intent(), context());
    expect(result.final.outcome).toBe(outcome);
    expect(result.final.nativeCancellationReceipt).toBe(false);
  });

  it('requires the documented terminal cancellation receipt and reports unknown stop reasons as failure', async () => {
    const cancelled = await adapter(fakeTransport(standardResponses({ 'session/prompt': { stopReason: 'cancelled' } }))).start(intent(), context());
    const unknown = await adapter(fakeTransport(standardResponses({ 'session/prompt': { stopReason: 'whatever-agent-says' } }))).start(intent(), context());
    expect(cancelled.final).toEqual(expect.objectContaining({ outcome: 'cancelled', nativeCancellationReceipt: true }));
    expect(unknown.final.outcome).toBe('failed');
  });

  it('sends only documented session/cancel notification and does not invent a native receipt', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const transport = fakeTransport(standardResponses({ 'session/prompt': async () => { await gate; return { stopReason: 'completed' }; } }), { worker: worker() });
    const provider = adapter(transport);
    const running = provider.start(intent(), context(), { async onStarted() {}, async onTerminationRequired() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await provider.cancel(intent());
    release();
    await running;
    expect(transport.notifications).toEqual([{ method: 'session/cancel', params: { sessionId: 'cursor-session-77' } }]);
    expect(result).toEqual(expect.objectContaining({ outcome: 'interrupted_uncertain', nativeCancellationReceipt: false }));
  });

  it('shares an identical in-flight run and rejects a conflicting duplicate before it can create another session', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const transport = fakeTransport(standardResponses({ 'session/prompt': async () => { await gate; return { stopReason: 'completed' }; } }));
    const provider = adapter(transport);
    const first = provider.start(intent(), context());
    const duplicate = provider.start(intent(), context());
    const conflicting = await provider.resume(intent(), binding(), context());
    release();
    expect(await first).toEqual(await duplicate);
    expect(conflicting.final.outcome).toBe('unavailable');
    expect(transport.calls.filter((call) => call.request.method === 'session/new')).toHaveLength(1);
  });

  it('bounds each ACP request and treats connection loss or timeouts as non-success', async () => {
    const timeout = await adapter(fakeTransport(standardResponses({ initialize: () => new Promise(() => {}) })), { limits: { requestTimeoutMs: 5 } }).start(intent(), context());
    const lost = await adapter(fakeTransport(standardResponses(), { connectError: new Error('connection EOF') })).start(intent(), context());
    expect(timeout.final.outcome).toBe('unavailable');
    expect(timeout.errorEvidence).toMatch(/timed out/);
    expect(lost.final.outcome).toBe('unavailable');
  });

  it('preserves lifecycle worker start identity supplied by the transport', async () => {
    const started = [];
    const transport = fakeTransport(standardResponses(), { lifecycle: worker() });
    const result = await adapter(transport).start(intent(), context(), { async onStarted(identity) { started.push(identity); } });
    expect(result.final.outcome).toBe('completed');
    expect(started).toEqual([worker()]);
  });
});
