import { describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/providers/codex.ts';
import { providerContextPayloadDigest } from '../../src/providers/contracts.ts';

function intent(overrides = {}) {
  const execution = {
    profile: 'native',
    workspaceId: 'job-77',
    workspacePath: '/job-workspaces/job-77',
    providerId: 'codex',
    model: 'gpt-5.5',
    approvedInputDigests: ['sha256:input', ...[
      { packetRevision: 'packet@4', digest: 'sha256:packet', prompt: 'Context packet packet@4. Execute only the admitted bounded work.' },
      { packetRevision: 'packet@4', digest: 'sha256:packet', prompt: 'Context packet packet@4. Launch the bounded job.' },
      { packetRevision: 'packet@4', digest: 'sha256:packet', prompt: 'Context packet packet@4. Edit only src/example.ts.' },
      { packetRevision: 'packet@4', digest: 'sha256:packet', prompt: 'Context packet packet@4. Run npm test only.' },
      { packetRevision: 'packet@4', digest: 'sha256:packet', prompt: 'Context packet packet@5 replaces all stale assumptions.' },
    ].map(providerContextPayloadDigest)],
    ...(overrides.execution ?? {}),
  };
  return {
    format: 'faktori.run-intent/v1',
    runId: 'run-77',
    admissionKey: 'admission-77',
    workItem: { id: 'F2-03', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'owner/repository', branch: 'build/f2', baseRevision: 'base@1', expectedRevision: 'expected@1' },
    context: { packetRevision: 'packet@4', digest: 'sha256:packet' },
    execution,
    budget: { reservationId: 'reserve-77', maxRuntimeMinutes: 3, estimatedTokens: 500, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 2, scopeDigest: 'sha256:scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt: 1,
    createdAt: '2026-09-05T01:00:00.000Z',
    ...overrides,
    execution,
  };
}

function jsonl(...events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function context(overrides = {}) {
  return { packetRevision: 'packet@4', digest: 'sha256:packet', prompt: 'Context packet packet@4. Execute only the admitted bounded work.', ...overrides };
}

function binding(overrides = {}) {
  return {
    sessionId: 'fixture-session-id',
    sourceRunId: 'run-77',
    sourceContext: { packetRevision: 'packet@3', digest: 'sha256:previous-packet' },
    sourceScope: {
      factoryId: 'factory',
      productId: 'product',
      repository: 'owner/repository',
      workspaceId: 'job-77',
      workspacePath: '/job-workspaces/job-77',
      providerId: 'codex',
    },
    ...overrides,
  };
}

function worker() {
  return { kind: 'native', pid: 77, processStartedAt: '2026-09-05T01:00:01.000Z', processGroupId: 77, runNonce: 'worker-fixture-nonce' };
}

function fakeRunner(result = { exitCode: 0, stdout: '' }) {
  const calls = [];
  const terminations = [];
  return {
    calls,
    terminations,
    async run(request) {
      calls.push(request);
      return typeof result === 'function' ? result(request) : result;
    },
    async terminate(request) {
      terminations.push(request);
      return { processTerminated: true };
    },
  };
}

function adapter(runner, limits = {}, options = {}) {
  return new CodexAdapter({
    runner,
    limits: { maxRuntimeMinutes: 5, maxTokens: 1_000, maxRetries: 1, ...limits },
    environment: { PATH: '/controlled/bin', CODEX_PROFILE: 'selected-profile' },
    ...options,
  });
}

describe('bounded Codex exec adapter', () => {
  it('uses explicit JSON start, recorded cwd, compatible model, and current context for launch/edit/test turns', async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: jsonl(
        { type: 'thread.started', thread_id: 'thread-77' },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_tokens: 4 }, last_agent_message: 'done' },
      ),
    });
    const provider = adapter(runner);

    const launch = await provider.start(intent(), context({ prompt: 'Context packet packet@4. Launch the bounded job.' }));
    const edit = await provider.start(intent({ runId: 'run-edit' }), context({ prompt: 'Context packet packet@4. Edit only src/example.ts.' }));
    const test = await provider.start(intent({ runId: 'run-test' }), context({ prompt: 'Context packet packet@4. Run npm test only.' }));

    expect(launch.final).toEqual(expect.objectContaining({ outcome: 'completed', sessionId: 'thread-77', usage: expect.objectContaining({ availability: 'reported', inputTokens: 10, outputTokens: 3 }) }));
    expect(edit.final.outcome).toBe('completed');
    expect(test.final.outcome).toBe('completed');
    expect(runner.calls).toHaveLength(3);
    for (const call of runner.calls) {
      expect(call).toEqual(expect.objectContaining({ command: 'codex', cwd: '/job-workspaces/job-77', timeoutMs: 180_000, environment: { PATH: '/controlled/bin', CODEX_PROFILE: 'selected-profile' } }));
      expect(call.args).toContain('--json');
      expect(call.args).toEqual(expect.arrayContaining(['--model', 'gpt-5.5']));
      expect(call.args.join(' ')).not.toMatch(/--last|--sandbox|--add-dir|dangerously-bypass/i);
    }
    expect(runner.calls[1].args.at(-1)).toContain('Edit only src/example.ts');
    expect(runner.calls[2].args.at(-1)).toContain('Run npm test only');
  });

  it('resumes only an explicit session in the recorded workspace and carries current context', async () => {
    const runner = fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }) });
    const result = await adapter(runner).resume(intent(), binding({ sourceRunId: 'prior-terminal-run' }), context({ prompt: 'Context packet packet@5 replaces all stale assumptions.' }));

    expect(result.command).toBe('resume');
    expect(runner.calls[0]).toEqual(expect.objectContaining({ cwd: '/job-workspaces/job-77' }));
    expect(runner.calls[0].args).toEqual(['exec', 'resume', '--json', '--model', 'gpt-5.5', 'fixture-session-id', 'Context packet packet@5 replaces all stale assumptions.']);
    expect(runner.calls[0].args).not.toContain('--last');
    expect(result.final.usage).toEqual(expect.objectContaining({ availability: 'partially_reported', inputTokens: 1, outputTokens: 2 }));
  });

  it('can suppress ambient user memory and escalation without claiming native filesystem isolation', async () => {
    const runner = fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'turn.completed' }) });
    const provider = adapter(runner, {}, { contextIsolation: 'bounded' });

    expect((await provider.start(intent(), context())).final.outcome).toBe('completed');
    expect(runner.calls[0].args).toEqual(expect.arrayContaining([
      'exec', '--ignore-user-config', '--ignore-rules', '--disable', 'memories', '--disable', 'apps',
      '--disable', 'plugins', '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--strict-config',
      '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"', '--json', '--model', 'gpt-5.5',
    ]));
    expect(runner.calls[0].args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('binds an explicitly read-only turn to the native Codex sandbox instead of the bounded write default', async () => {
    const runner = fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'turn.completed' }) });
    const review = context({ nativeSandbox: 'read-only' });
    const target = intent({ execution: { approvedInputDigests: [providerContextPayloadDigest(review)] } });

    expect((await adapter(runner, {}, { contextIsolation: 'bounded' }).start(target, review)).final.outcome).toBe('completed');
    expect(runner.calls[0].args).toEqual(expect.arrayContaining(['-c', 'sandbox_mode="read-only"']));
    expect(runner.calls[0].args).not.toContain('sandbox_mode="workspace-write"');

    const hostRunner = fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'turn.completed' }) });
    expect((await adapter(hostRunner).start(target, review)).final.outcome).toBe('completed');
    expect(hostRunner.calls[0].args).toEqual(expect.arrayContaining(['-c', 'sandbox_mode="read-only"']));

    expect((await adapter(runner, {}, { contextIsolation: 'bounded' }).start(target, { ...review, nativeSandbox: undefined })).final.outcome).toBe('unavailable');
    expect(runner.calls).toHaveLength(1);
  });

  it('executes the exact authorized prompt bytes and rejects substituted content', async () => {
    const runner = fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'thread.started', thread_id: 'thread-exact' }, { type: 'turn.completed' }) });
    const exact = context({ prompt: '  exact Codex prompt\n' });
    const target = intent({ execution: { approvedInputDigests: [providerContextPayloadDigest(exact)] } });
    expect((await adapter(runner).start(target, exact)).final.outcome).toBe('completed');
    expect(runner.calls[0].args.at(-1)).toBe(exact.prompt);
    expect((await adapter(runner).start(target, { ...exact, prompt: exact.prompt.trim() })).final.outcome).toBe('unavailable');
    expect(runner.calls).toHaveLength(1);
  });

  it('rejects missing context, implicit sessions, incompatible models, and runtime/token/retry bound breaches before process launch', async () => {
    const runner = fakeRunner();
    const provider = adapter(runner);

    const missingContext = await provider.start(intent(), context({ prompt: '  ' }));
    const substitutedPrompt = await provider.start(intent(), context({ prompt: 'Caller substituted unapproved content.' }));
    const implicitSession = await provider.resume(intent(), binding({ sessionId: '' }), context());
    const incompatibleModel = await provider.start(intent({ execution: { model: 'gpt-6' } }), context());
    const tooLong = await provider.start(intent({ budget: { reservationId: 'reserve-77', maxRuntimeMinutes: 6, estimatedTokens: 500, status: 'held' } }), context());
    const tooManyTokens = await provider.start(intent({ budget: { reservationId: 'reserve-77', maxRuntimeMinutes: 3, estimatedTokens: 1_001, status: 'held' } }), context());
    const retryExceeded = await provider.start(intent({ attempt: 3 }), context());

    for (const result of [missingContext, substitutedPrompt, implicitSession, incompatibleModel, tooLong, tooManyTokens, retryExceeded]) {
      expect(result.final.outcome).toBe('unavailable');
    }
    expect(implicitSession.final.summary).toMatch(/coordinator-recorded session binding/);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ['completed', { type: 'turn.completed' }],
    ['unchanged_verified', { type: 'turn.completed', outcome: 'unchanged_verified', verification: ['recorded test receipt'] }],
    ['denied', { type: 'error', code: 'permission_denied', message: 'approval required' }],
    ['authentication_required', { type: 'error', code: 'login_required', message: 'authenticate' }],
    ['quota_exhausted', { type: 'error', code: 'rate_limit', message: 'quota exceeded' }],
    ['failed', { type: 'error', code: 'unexpected_failure', message: 'operation failed' }],
    ['cancelled', { type: 'turn.cancelled', code: 'cancelled', native_cancellation_receipt: true }],
    ['interrupted_uncertain', { type: 'error', code: 'worker_interrupted', message: 'terminated' }],
    ['unavailable', { type: 'error', code: 'provider_unavailable', message: 'not installed' }],
  ])('normalizes the distinct provider outcome %s without granting action authority', async (outcome, event) => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: jsonl(event),
    });
    const result = await adapter(runner).start(intent(), context());

    expect(result.final.outcome).toBe(outcome);
    expect(Object.keys(result)).not.toContain('authority');
  });

  it('does not call an unchanged result verified unless the provider actually emits verification evidence', async () => {
    const result = await adapter(fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'turn.completed', outcome: 'unchanged_verified' }) })).start(intent(), context());

    expect(result.final.outcome).toBe('failed');
  });

  it('requires a recognized native terminal event plus exit 0 for success', async () => {
    const streams = [
      '',
      jsonl({ type: 'thread.started', thread_id: 'fixture-thread' }),
      jsonl({ type: 'item.completed', status: 'completed', item: { text: 'ordinary agent text says quota exceeded' } }),
      jsonl({ type: 'turn.completed' }, { type: 'item.completed' }, { malformed: true }),
    ];

    for (const stdout of streams) {
      const result = await adapter(fakeRunner({ exitCode: 0, stdout })).start(intent(), context());
      expect(result.final.outcome).toBe('failed');
    }
  });

  it('lets a nonzero exit override an emitted success receipt', async () => {
    const result = await adapter(fakeRunner({ exitCode: 1, stdout: jsonl({ type: 'turn.completed', outcome: 'unchanged_verified', verification: ['test receipt'] }) })).start(intent(), context());

    expect(result.final.outcome).toBe('failed');
  });

  it('never classifies ordinary agent text as auth, quota, or permission evidence', async () => {
    const result = await adapter(fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'turn.completed', item: { text: 'Please authenticate; quota exceeded; permission denied.' } }) })).start(intent(), context());

    expect(result.final.outcome).toBe('completed');
    expect(result.errorEvidence).toBeUndefined();
  });

  it('uses only bounded sanitized stderr when a failed process has no known JSON error', async () => {
    const result = await adapter(fakeRunner({ exitCode: 1, stdout: jsonl({ type: 'turn.completed' }), stderr: 'authentication failed Bearer top-secret-value /Users/example/private-file\nmore text' })).start(intent(), context());

    expect(result.final.outcome).toBe('authentication_required');
    expect(result.errorEvidence).toContain('[redacted]');
    expect(result.errorEvidence).toContain('[path]');
    expect(result.errorEvidence).not.toContain('top-secret-value');
  });

  it('requires exact current packet evidence, a nonempty controlled environment, and nonempty coordinator-recorded resume provenance', async () => {
    const runner = fakeRunner();
    const changedPacket = await adapter(runner).start(intent(), context({ digest: 'sha256:stale' }));
    const noEnvironment = await adapter(runner, {}, { environment: {} }).start(intent(), context());
    const missingSourceRun = await adapter(runner).resume(intent(), binding({ sourceRunId: '' }), context());
    const missingSourceContext = await adapter(runner).resume(intent(), binding({ sourceContext: { packetRevision: '', digest: '' } }), context());
    const differentWorkspace = await adapter(runner).resume(intent(), binding({ sourceScope: { ...binding().sourceScope, workspaceId: 'other-workspace' } }), context());
    const differentProduct = await adapter(runner).resume(intent(), binding({ sourceScope: { ...binding().sourceScope, productId: 'other-product' } }), context());

    for (const result of [changedPacket, noEnvironment, missingSourceRun, missingSourceContext, differentWorkspace, differentProduct]) expect(result.final.outcome).toBe('unavailable');
    expect(changedPacket.final.summary).toMatch(/context reference/);
    expect(noEnvironment.final.summary).toMatch(/controlled execution environment/);
    expect(missingSourceRun.final.summary).toMatch(/coordinator-recorded session binding/);
    expect(runner.calls).toEqual([]);
  });

  it('forwards the supplied lifecycle callbacks with the exact worker identity before completion', async () => {
    const runner = fakeRunner(async (request) => {
      await request.lifecycle.onStarted(worker());
      await request.lifecycle.onTerminationRequired(worker(), 'output_limit');
      return { exitCode: 0, stdout: jsonl({ type: 'turn.completed' }) };
    });
    const started = [];
    const termination = [];
    const lifecycle = {
      async onStarted(identity) { started.push(identity); },
      async onTerminationRequired(identity, reason) { termination.push({ identity, reason }); },
    };

    const result = await adapter(runner).start(intent(), context(), lifecycle);

    expect(result.final.outcome).toBe('completed');
    expect(started).toEqual([worker()]);
    expect(termination).toEqual([{ identity: worker(), reason: 'output_limit' }]);
    expect(runner.calls[0].lifecycle).toEqual(expect.objectContaining({ onStarted: expect.any(Function), onTerminationRequired: expect.any(Function) }));
  });

  it('cannot complete when a supplied lifecycle receives no worker-start callback', async () => {
    const runner = fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'turn.completed' }) });
    const lifecycle = { async onStarted() {} };

    const result = await adapter(runner).start(intent(), context(), lifecycle);

    expect(result.final).toEqual(expect.objectContaining({ outcome: 'interrupted_uncertain', summary: expect.stringMatching(/worker-start receipt/) }));
  });

  it('fails closed when either lifecycle callback throws', async () => {
    const startedThrows = fakeRunner(async (request) => {
      try { await request.lifecycle.onStarted(worker()); } catch {}
      return { exitCode: 0, stdout: jsonl({ type: 'turn.completed' }) };
    });
    const terminationThrows = fakeRunner(async (request) => {
      await request.lifecycle.onStarted(worker());
      try { await request.lifecycle.onTerminationRequired(worker(), 'timeout'); } catch {}
      return { exitCode: 0, stdout: jsonl({ type: 'turn.completed' }) };
    });

    const first = await adapter(startedThrows).start(intent(), context(), { async onStarted() { throw new Error('journal unavailable'); } });
    const second = await adapter(terminationThrows).resume(intent(), binding(), context(), {
      async onStarted() {},
      async onTerminationRequired() { throw new Error('journal unavailable'); },
    });

    expect(first.final.outcome).toBe('interrupted_uncertain');
    expect(second.final.outcome).toBe('interrupted_uncertain');
  });

  it('classifies common real error signals and preserves unavailable usage telemetry', async () => {
    const cases = [
      ['authentication_required', { type: 'error', code: 'login_required', message: 'Please authenticate' }],
      ['quota_exhausted', { type: 'error', code: 'rate_limit', message: 'quota exceeded' }],
      ['denied', { type: 'error', code: 'permission_denied', message: 'approval required' }],
      ['failed', { type: 'error', code: 'unexpected', message: 'operation failed' }],
    ];

    for (const [outcome, event] of cases) {
      const result = await adapter(fakeRunner({ exitCode: 1, stdout: jsonl(event) })).start(intent(), context());
      expect(result.final).toEqual(expect.objectContaining({ outcome, usage: { availability: 'unavailable', unavailableReason: 'Codex JSONL did not emit usage telemetry' } }));
    }
  });

  it('classifies malformed JSONL as failure instead of inventing a successful receipt', async () => {
    const result = await adapter(fakeRunner({ exitCode: 0, stdout: '{not-json}\n{"missing":"type"}\n' })).start(intent(), context());

    expect(result.malformedEventCount).toBe(2);
    expect(result.events).toEqual([]);
    expect(result.final.outcome).toBe('failed');
  });

  it('makes a terminated wrapper or absent native cancellation receipt interrupted_uncertain', async () => {
    const wrapperTermination = await adapter(fakeRunner({ exitCode: null, terminated: true, stdout: jsonl({ type: 'turn.cancelled' }) })).start(intent(), context());
    const cancelledWithoutReceipt = await adapter(fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'turn.cancelled', code: 'cancelled' }) })).start(intent(), context());

    expect(wrapperTermination.final).toEqual(expect.objectContaining({ outcome: 'interrupted_uncertain', nativeCancellationReceipt: false }));
    expect(cancelledWithoutReceipt.final.outcome).toBe('interrupted_uncertain');
  });

  it('reports controlled wrapper cancellation as uncertain until a native receipt is observed', async () => {
    const runner = fakeRunner();
    const result = await adapter(runner).cancel(intent());

    expect(runner.terminations).toEqual([{ runId: 'run-77', cwd: '/job-workspaces/job-77' }]);
    expect(result).toEqual(expect.objectContaining({ outcome: 'interrupted_uncertain', nativeCancellationReceipt: false }));
  });

  it('reports native receipt cancellation separately when an injected runner actually observes it', async () => {
    const runner = fakeRunner();
    runner.terminate = async () => ({ processTerminated: true, nativeCancellationReceipt: true });
    const result = await adapter(runner).cancel(intent());

    expect(result).toEqual(expect.objectContaining({ outcome: 'cancelled', nativeCancellationReceipt: true }));
  });

  it('reports transport exceptions as unavailable, not successful execution', async () => {
    const runner = fakeRunner(() => { throw new Error('spawn denied'); });
    const result = await adapter(runner).start(intent(), context());

    expect(result.final).toEqual(expect.objectContaining({ outcome: 'unavailable', nativeCancellationReceipt: false }));
  });
});
