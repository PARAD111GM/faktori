import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { NativeClaudeProcessRunner } from '../../src/execution/claude-process.ts';
import { BoundedCommandRunner } from '../../src/execution/transports.ts';

const CWD = process.cwd();

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

function lifecycle(order, started) {
  return {
    async onStarted(worker) {
      order.push(`started:${worker.kind}:${worker.pid}`);
      started?.();
    },
    async onTerminationRequired(_worker, reason) {
      order.push(`termination:${reason}`);
    },
  };
}

describe('native Claude process transport', () => {
  it('starts one exact Claude argv worker with controlled cwd/env and persists identity before streaming output', async () => {
    const order = [];
    const child = new FakeChild(301);
    const commands = new BoundedCommandRunner({
      spawn: (command, args, options) => {
        expect({ command, args, cwd: options.cwd, env: options.env, shell: options.shell, detached: options.detached }).toEqual({
          command: 'claude', args: ['-p', '--output-format', 'stream-json', 'bounded prompt'], cwd: CWD, env: { CLAUDE_PROFILE: 'selected' }, shell: false, detached: true,
        });
        setTimeout(() => { child.stdout.emit('data', '{"type":"result"}\n'); child.emit('close', 0, null); }, 5);
        return child;
      },
    });
    const runner = new NativeClaudeProcessRunner({
      commands,
      runNonce: 'claude-native-nonce',
      identityProbe: { inspect: async (pid) => ({ pid, processStartedAt: 'start-301', processGroupId: 301, running: true }) },
    });

    const result = await runner.run({
      runId: 'claude-run', command: 'claude', args: ['-p', '--output-format', 'stream-json', 'bounded prompt'],
      cwd: CWD, environment: { CLAUDE_PROFILE: 'selected' }, timeoutMs: 500, lifecycle: lifecycle(order),
    });

    expect(result).toEqual({ exitCode: 0, stdout: '{"type":"result"}\n', stderr: '' });
    expect(order).toEqual(['started:native:301']);
  });

  it('applies stream output bounds and requires the durable hook before timeout termination', async () => {
    const order = [];
    const child = new FakeChild(302);
    let running = true;
    const commands = new BoundedCommandRunner({
      spawn: () => child,
      killProcessGroup: (pid, signal) => {
        order.push(`signal:${pid}:${signal}`);
        if (signal === 'SIGTERM') queueMicrotask(() => { running = false; child.emit('close', null, 'SIGTERM'); });
      },
      terminationGraceMs: 1,
    });
    const runner = new NativeClaudeProcessRunner({
      commands,
      runNonce: 'claude-timeout-nonce',
      stdoutMaxBytes: 8,
      identityProbe: {
        inspect: async (pid) => running ? ({ pid, processStartedAt: 'start-302', processGroupId: 302, running: true }) : ({ status: 'absent' }),
        inspectProcessGroup: async () => running ? ({ processGroupId: 302, members: [{ pid: 302, processStartedAt: 'start-302', processGroupId: 302, running: true }] }) : ({ status: 'absent' }),
      },
    });

    const runningResult = runner.run({ runId: 'claude-timeout', command: 'claude', args: ['-p'], cwd: CWD, environment: {}, timeoutMs: 50, lifecycle: lifecycle(order) });
    setTimeout(() => child.stdout.emit('data', 'x'.repeat(16)), 5);
    const result = await runningResult;

    expect(result).toEqual(expect.objectContaining({ terminated: true, exitCode: null, stdout: 'xxxxxxxx' }));
    expect(order).toEqual(['started:native:302', 'termination:output_limit', 'signal:302:SIGTERM']);
  });

  it('refuses unproven identity, concurrent workers, and cancellation without the exact lifecycle authority', async () => {
    const child = new FakeChild(303);
    let started;
    const observedStart = new Promise((resolve) => { started = resolve; });
    const commands = new BoundedCommandRunner({
      spawn: () => child,
      killProcessGroup: (_pid, signal) => { if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, 'SIGTERM')); },
      terminationGraceMs: 1,
    });
    const runner = new NativeClaudeProcessRunner({
      commands,
      runNonce: 'claude-cancel-nonce',
      identityProbe: {
        inspect: async (pid) => ({ pid, processStartedAt: 'start-303', processGroupId: 303, running: true }),
        inspectProcessGroup: async () => ({ status: 'absent' }),
      },
    });
    const activeLifecycle = lifecycle([], started);
    const running = runner.run({ runId: 'active-run', command: 'claude', args: ['-p'], cwd: CWD, environment: {}, timeoutMs: 500, lifecycle: activeLifecycle });
    await observedStart;

    await expect(runner.run({ runId: 'second-run', command: 'claude', args: ['-p'], cwd: CWD, environment: {}, timeoutMs: 500, lifecycle: activeLifecycle })).rejects.toThrow(/exactly one active/);
    await expect(runner.terminate({ runId: 'wrong-run', cwd: CWD, lifecycle: activeLifecycle })).resolves.toEqual({ processTerminated: false });
    await expect(runner.terminate({ runId: 'active-run', cwd: CWD })).resolves.toEqual({ processTerminated: false });

    const cancelled = await runner.terminate({ runId: 'active-run', cwd: CWD, lifecycle: activeLifecycle });
    expect(cancelled).toEqual({ processTerminated: true, nativeCancellationReceipt: false });
    expect(await running).toEqual(expect.objectContaining({ terminated: true, exitCode: null }));

    const unproven = new NativeClaudeProcessRunner({
      commands: new BoundedCommandRunner({ spawn: () => new FakeChild(304) }),
      runNonce: 'unproven', identityProbe: { inspect: async () => ({ status: 'unknown' }) },
    });
    await expect(unproven.run({ runId: 'unproven-run', command: 'claude', args: ['-p'], cwd: CWD, environment: {}, timeoutMs: 10, lifecycle: activeLifecycle })).resolves.toEqual(expect.objectContaining({ terminated: true, exitCode: null }));
  });

  it('does not invent a native cancellation receipt when an authority-approved process-group stop succeeds', async () => {
    const child = new FakeChild(305);
    let running = true;
    const signals = [];
    const commands = new BoundedCommandRunner({
      spawn: () => child,
      killProcessGroup: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 'SIGTERM') queueMicrotask(() => { running = false; child.emit('close', null, 'SIGTERM'); });
      },
      terminationGraceMs: 1,
    });
    const runner = new NativeClaudeProcessRunner({
      commands,
      runNonce: 'claude-receipt-nonce',
      identityProbe: {
        inspect: async (pid) => running ? ({ pid, processStartedAt: 'start-305', processGroupId: 305, running: true }) : ({ status: 'absent' }),
        inspectProcessGroup: async () => running ? ({ processGroupId: 305, members: [{ pid: 305, processStartedAt: 'start-305', processGroupId: 305, running: true }] }) : ({ status: 'absent' }),
      },
    });
    let started;
    const start = new Promise((resolve) => { started = resolve; });
    const activeLifecycle = lifecycle([], started);
    const run = runner.run({ runId: 'receipt-run', command: 'claude', args: ['-p'], cwd: CWD, environment: {}, timeoutMs: 500, lifecycle: activeLifecycle });
    await start;

    expect(await runner.terminate({ runId: 'receipt-run', cwd: CWD, lifecycle: activeLifecycle })).toEqual({ processTerminated: true, nativeCancellationReceipt: false });
    expect(await run).toEqual(expect.objectContaining({ terminated: true, exitCode: null }));
    expect(signals).toEqual([[305, 'SIGTERM']]);
  });
});
