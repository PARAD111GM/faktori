import { describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../../src/providers/claude.ts';

function intent(overrides = {}) {
  const execution = {
    profile: 'native',
    workspaceId: 'job-77',
    workspacePath: '/job-workspaces/job-77',
    providerId: 'claude',
    model: 'claude-sonnet-test',
    approvedInputDigests: ['sha256:input'],
    ...(overrides.execution ?? {}),
  };
  return {
    format: 'faktori.run-intent/v1',
    runId: 'run-77',
    admissionKey: 'admission-77',
    workItem: { id: 'F3-01', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'owner/repository', branch: 'build/f3', baseRevision: 'base@1', expectedRevision: 'expected@1' },
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

function context(overrides = {}) {
  return { packetRevision: 'packet@4', digest: 'sha256:packet', prompt: 'Context packet packet@4. Execute only the admitted bounded work.', ...overrides };
}

function binding(overrides = {}) {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111',
    sourceRunId: 'run-77',
    sourceContext: { packetRevision: 'packet@3', digest: 'sha256:previous-packet' },
    sourceScope: {
      factoryId: 'factory', productId: 'product', repository: 'owner/repository',
      workspaceId: 'job-77', workspacePath: '/job-workspaces/job-77', providerId: 'claude',
    },
    ...overrides,
  };
}

function worker() {
  return { kind: 'native', pid: 77, processStartedAt: '2026-09-05T01:00:01.000Z', processGroupId: 77, runNonce: 'worker-fixture-nonce' };
}

function jsonl(...events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
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
  return new ClaudeAdapter({
    runner,
    limits: { maxRuntimeMinutes: 5, maxTokens: 1_000, maxRetries: 1, ...limits },
    environment: { PATH: '/controlled/bin', CLAUDE_PROFILE: 'selected-profile' },
    compatibleModels: ['claude-sonnet-test'],
    allowedTools: ['Read', 'Edit'],
    createSessionId: () => '22222222-2222-4222-8222-222222222222',
    ...options,
  });
}

describe('bounded Claude print adapter', () => {
  it('uses unmodified print/streaming JSON with a fresh explicit session, recorded cwd, controlled environment, and bounded tools', async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: jsonl(
        { type: 'system', subtype: 'init', session_id: '22222222-2222-4222-8222-222222222222' },
        { type: 'assistant', message: { text: 'working' } },
        { type: 'result', subtype: 'success', session_id: '22222222-2222-4222-8222-222222222222', result: 'done from /Users/nathan/job with bearer stream-secret', usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3 } },
      ),
    });
    const provider = adapter(runner);

    const result = await provider.start(intent(), context({ prompt: 'Context packet packet@4. Edit only src/example.ts.' }));

    expect(result.final).toEqual(expect.objectContaining({
      outcome: 'completed',
      sessionId: '22222222-2222-4222-8222-222222222222',
      usage: expect.objectContaining({ availability: 'reported', inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 }),
    }));
    expect(runner.calls).toHaveLength(1);
    const [call] = runner.calls;
    expect(call).toEqual(expect.objectContaining({ command: 'claude', cwd: '/job-workspaces/job-77', timeoutMs: 180_000, environment: { PATH: '/controlled/bin', CLAUDE_PROFILE: 'selected-profile' } }));
    expect(call.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'manual', '--tools', 'Read,Edit', '--model', 'claude-sonnet-test', '--session-id', '22222222-2222-4222-8222-222222222222']));
    expect(call.args.join(' ')).not.toMatch(/--continue|--add-dir|bypass|fallback-model|mcp-config|--background/i);
    expect(result.final.summary).not.toMatch(/\/Users\/nathan|stream-secret/);
  });

  it('resumes only the explicit same-scope session in the recorded workspace and supplies current context', async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: jsonl(
        { type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' },
        { type: 'result', subtype: 'success', session_id: '11111111-1111-4111-8111-111111111111', result: 'resumed', usage: { input_tokens: 4, output_tokens: 2 } },
      ),
    });

    const result = await adapter(runner).resume(intent(), binding(), context({ prompt: 'Context packet packet@4. Continue from current references.' }));

    expect(result.final.outcome).toBe('completed');
    expect(runner.calls[0].args).toEqual(expect.arrayContaining(['--resume', '11111111-1111-4111-8111-111111111111']));
    expect(runner.calls[0].args.join(' ')).not.toMatch(/--continue/);
    expect(runner.calls[0].args.at(-1)).toContain('Continue from current references');
    expect(runner.calls[0].cwd).toBe('/job-workspaces/job-77');
  });

  it.each([
    ['factory', intent({ target: { ...intent().target, factoryId: 'other-factory' } }), binding()],
    ['product', intent({ target: { ...intent().target, productId: 'other-product' } }), binding()],
    ['repository', intent({ target: { ...intent().target, repository: 'other/repository' } }), binding()],
    ['workspace', intent({ execution: { workspaceId: 'other-workspace', workspacePath: '/job-workspaces/other-workspace' } }), binding()],
    ['provider', intent({ execution: { providerId: 'codex' } }), binding({ sourceScope: { ...binding().sourceScope, providerId: 'codex' } })],
  ])('rejects an explicit resume binding crossing %s identity before launch', async (_label, target, resumeBinding) => {
    const runner = fakeRunner();
    const result = await adapter(runner).resume(target, resumeBinding, context());

    expect(result.final.outcome).toBe('unavailable');
    expect(result.final.summary).toMatch(/session binding|not assigned/i);
    expect(runner.calls).toEqual([]);
  });

  it.each([
    ['missing current prompt', intent(), context({ prompt: '' })],
    ['mismatched current digest', intent(), context({ digest: 'sha256:other' })],
    ['unapproved model', intent({ execution: { model: 'other-model' } }), context()],
    ['runtime bound exceeded', intent({ budget: { ...intent().budget, maxRuntimeMinutes: 6 } }), context()],
    ['token bound exceeded', intent({ budget: { ...intent().budget, estimatedTokens: 1_001 } }), context()],
    ['retry bound exceeded', intent({ attempt: 3 }), context()],
  ])('rejects %s before starting the native process', async (_label, target, currentContext) => {
    const runner = fakeRunner();
    const result = await adapter(runner).start(target, currentContext);

    expect(result.final.outcome).toBe('unavailable');
    expect(runner.calls).toEqual([]);
  });

  it('reports tool suppression as a visible denied outcome without inventing permission replies', async () => {
    const runner = fakeRunner({
      exitCode: 0,
      stdout: jsonl(
        { type: 'system', subtype: 'init', session_id: '22222222-2222-4222-8222-222222222222' },
        { type: 'result', subtype: 'error', is_error: true, session_id: '22222222-2222-4222-8222-222222222222', permission_denials: [{ tool_name: 'Edit' }], result: 'Edit is not allowed', usage: { input_tokens: 1, output_tokens: 1 } },
      ),
    });

    const provider = adapter(runner, {}, { allowedTools: [] });
    const result = await provider.start(intent(), context());

    expect(provider.capabilities).toEqual(expect.objectContaining({ approvalReplies: false, permissions: 'tool_suppression_only' }));
    expect(result.final).toEqual(expect.objectContaining({ outcome: 'denied', nativeCancellationReceipt: false }));
    expect(runner.calls[0].args).toEqual(expect.arrayContaining(['--tools', '']));
  });

  it.each([
    ['authentication', { error_code: 'authentication_required', result: 'Login required' }, 'authentication_required'],
    ['quota', { error_code: 'rate_limit', result: 'Rate limit exceeded' }, 'quota_exhausted'],
    ['provider failure', { error_code: 'internal_error', result: 'unexpected failure' }, 'failed'],
  ])('classifies streamed %s failure truthfully', async (_label, error, outcome) => {
    const runner = fakeRunner({
      exitCode: 1,
      stdout: jsonl({ type: 'result', is_error: true, session_id: '22222222-2222-4222-8222-222222222222', ...error }),
      stderr: 'authorization Bearer secret-value /Users/person/private',
    });
    const result = await adapter(runner).start(intent(), context());

    expect(result.final.outcome).toBe(outcome);
    expect(result.errorEvidence ?? result.final.summary).not.toMatch(/secret-value|\/Users\/person/);
  });

  it('never treats malformed streams, a nonzero exit, a mismatched session, or wrapper termination as successful completion', async () => {
    const malformed = await adapter(fakeRunner({ exitCode: 0, stdout: '{not JSON}\n' })).start(intent(), context());
    const nonzero = await adapter(fakeRunner({ exitCode: 1, stdout: jsonl({ type: 'result', session_id: '22222222-2222-4222-8222-222222222222', result: 'done' }) })).start(intent(), context());
    const mismatch = await adapter(fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'result', session_id: '33333333-3333-4333-8333-333333333333', result: 'done' }) })).start(intent(), context());
    const terminated = await adapter(fakeRunner({ exitCode: null, terminated: true, stdout: jsonl({ type: 'result', session_id: '22222222-2222-4222-8222-222222222222', result: 'done' }) })).start(intent(), context());

    expect(malformed.final.outcome).toBe('failed');
    expect(nonzero.final.outcome).toBe('failed');
    expect(mismatch.final.outcome).toBe('failed');
    expect(terminated.final.outcome).toBe('interrupted_uncertain');
  });

  it('keeps cancellation and absent usage uncertain even if wrapper termination succeeds', async () => {
    const runner = fakeRunner();
    runner.terminate = async (request) => {
      runner.terminations.push(request);
      return { processTerminated: true, nativeCancellationReceipt: true };
    };

    const result = await adapter(runner).cancel(intent());

    expect(runner.terminations).toEqual([{ runId: 'run-77', cwd: '/job-workspaces/job-77' }]);
    expect(result).toEqual(expect.objectContaining({ outcome: 'interrupted_uncertain', nativeCancellationReceipt: false, usage: { availability: 'unavailable', unavailableReason: 'cancellation does not supply usage telemetry' } }));
  });

  it('requires a durable worker start callback before provider success can be delivered', async () => {
    const runner = fakeRunner({ exitCode: 0, stdout: jsonl({ type: 'result', session_id: '22222222-2222-4222-8222-222222222222', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }) });
    const provider = adapter(runner);

    const missingStart = await provider.start(intent(), context(), { async onStarted() { throw new Error('durable worker start unavailable'); } });
    const observedStart = await provider.start(intent({ runId: 'run-78' }), context(), { async onStarted(received) { expect(received).toEqual(worker()); } });

    expect(missingStart.final.outcome).toBe('interrupted_uncertain');
    expect(observedStart.final.outcome).toBe('interrupted_uncertain');
    expect(runner.calls).toHaveLength(2);
  });
});
