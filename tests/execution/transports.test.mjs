import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  BoundedCommandRunner,
  DockerCliIdentityProbe,
  DockerCliRunner,
  DockerCodexProcessRunner,
  NativeIdentityProbe,
  NativeCodexProcessRunner,
  NativeProcessRunner,
} from '../../src/execution/transports.ts';
import { CodexAdapter } from '../../src/providers/codex.ts';

const CWD = process.cwd();
const ENV = { PATH: process.env.PATH ?? '' };

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

describe('argv-only execution transports', () => {
  it('runs a harmless local child with exact cwd/env and no inherited environment fallback', async () => {
    const commands = new BoundedCommandRunner();
    const result = await commands.run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(`${process.cwd()}|${process.env.ONLY ?? "missing"}|${process.env.HOME ?? "absent"}`)'],
      cwd: CWD,
      env: { ONLY: 'explicit' },
      timeoutMs: 2_000,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
    });

    expect(result).toEqual(expect.objectContaining({ exitCode: 0, timedOut: false, outputLimitExceeded: false, stderr: '' }));
    expect(result.stdout).toBe(`${CWD}|explicit|absent`);
  });

  it('caps output and terminates the exact detached group on timeout without reporting success', async () => {
    const commands = new BoundedCommandRunner();
    const output = await commands.run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(64)); process.exit(0)'],
      cwd: CWD,
      env: {},
      timeoutMs: 2_000,
      stdoutMaxBytes: 8,
      stderrMaxBytes: 8,
    });
    const timeout = await commands.run({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: CWD,
      env: {},
      timeoutMs: 30,
      stdoutMaxBytes: 8,
      stderrMaxBytes: 8,
    });

    expect(output).toEqual(expect.objectContaining({ outputLimitExceeded: true, stdout: 'xxxxxxxx' }));
    expect(timeout).toEqual(expect.objectContaining({ timedOut: true }));
  });

  it('observes a launched native pid with start marker and pgid before safe tracked-group termination', async () => {
    const processChild = new FakeChild(72);
    const commands = new BoundedCommandRunner({
      spawn: (command, args) => {
        if (command === 'ps') {
          const ps = new FakeChild(73);
          queueMicrotask(() => { ps.stdout.emit('data', '72 Thu Sep  4 21:00:00 2026 72 S\n'); ps.emit('close', 0, null); });
          return ps;
        }
        return processChild;
      },
      killProcessGroup: (pid, signal) => { if (pid === 72 && signal === 'SIGTERM') queueMicrotask(() => processChild.emit('close', null, 'SIGTERM')); },
    });
    const runner = new NativeProcessRunner(commands);
    const probe = new NativeIdentityProbe({ commands, runner, cwd: CWD, env: ENV });
    const launched = await runner.spawn('worker', ['--bounded'], {
      cwd: CWD,
      env: {},
      detached: true,
      limits: { maxRuntimeSeconds: 10, memoryBytes: 1, cpuCount: 1, pids: 1 },
    });
    const observed = await probe.inspect(launched.pid);

    expect(observed).toEqual({ pid: launched.pid, processGroupId: launched.pid, running: true, processStartedAt: 'Thu Sep  4 21:00:00 2026' });
    await runner.terminateProcessGroup(launched.pid);
    await expect(runner.terminateProcessGroup(999_999_999)).rejects.toThrow(/untracked/);
  });

  it('treats every nonzero pid inspection as unknown and enumerates exact group members separately', async () => {
    let response = 'permission';
    const commands = new BoundedCommandRunner({
      spawn: () => {
        const child = new FakeChild(74);
        queueMicrotask(() => {
          if (response === 'permission') {
            child.stderr.emit('data', 'ps: access denied\n');
            child.emit('close', 1, null);
          } else if (response === 'absent') {
            child.emit('close', 1, null);
          } else {
            child.stdout.emit('data', [
              '84 Thu Sep  4 21:00:00 2026 84 S',
              '85 Thu Sep  4 21:00:01 2026 84 S',
              '90 Thu Sep  4 21:00:02 2026 90 S',
            ].join('\n'));
            child.emit('close', 0, null);
          }
        });
        return child;
      },
    });
    const probe = new NativeIdentityProbe({ commands, cwd: CWD, env: ENV });

    expect(await probe.inspect(84)).toEqual({ status: 'unknown' });
    response = 'absent';
    expect(await probe.inspect(84)).toEqual({ status: 'unknown' });
    response = 'group';
    expect(await probe.inspectProcessGroup(84)).toEqual({
      processGroupId: 84,
      members: [
        { pid: 84, processStartedAt: 'Thu Sep  4 21:00:00 2026', processGroupId: 84, running: true },
        { pid: 85, processStartedAt: 'Thu Sep  4 21:00:01 2026', processGroupId: 84, running: true },
      ],
    });
  });

  it('uses exact Docker argv, explicit env, and validates run/inspect output without invoking Docker', async () => {
    const calls = [];
    const id = 'a'.repeat(64);
    const commands = new BoundedCommandRunner({
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        const child = new FakeChild();
        queueMicrotask(() => {
          if (args[0] === 'inspect') child.stdout.emit('data', `${id}\t2026-09-04T00:00:00.000000000Z\ttrue\n`);
          else child.stdout.emit('data', `${id}\n`);
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    const docker = new DockerCliRunner({ commands, cwd: CWD, env: { LANG: 'C' } });
    const probe = new DockerCliIdentityProbe({ commands, cwd: CWD, env: { LANG: 'C' } });

    await expect(docker.run(['run', '--detach', 'image@sha256:abc'])).resolves.toEqual({ containerId: id });
    await expect(probe.inspect(id)).resolves.toEqual({ containerId: id, containerStartedAt: '2026-09-04T00:00:00.000000000Z', running: true });
    await expect(docker.run(['run', '--privileged', 'image'])).rejects.toThrow(/unsafe/);
    await expect(docker.run(['run', 'image@sha256:abc', 'node', '-e', 'console.log("/var/run/docker.sock is absent")'])).resolves.toEqual({ containerId: id });
    await expect(docker.run(['run', '--mount', 'type=bind,src=/var/run/docker.sock,dst=/socket', 'image@sha256:abc'])).rejects.toThrow(/unsafe/);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ command: 'docker', args: ['run', '--detach', 'image@sha256:abc'], options: { cwd: CWD, env: { LANG: 'C' }, shell: false } });
    expect(calls[0].options.env).not.toHaveProperty('HOME');
  });

  it('reports fake Docker timeout, spawn errors, invalid ids, and absent inspect truthfully', async () => {
    const killed = [];
    const hangingChild = new FakeChild(91);
    const hanging = new BoundedCommandRunner({
      spawn: () => hangingChild,
      killProcessGroup: (pid, signal) => {
        killed.push([pid, signal]);
        if (signal === 'SIGTERM') queueMicrotask(() => hangingChild.emit('close', null, 'SIGTERM'));
      },
      terminationGraceMs: 1,
    });
    const docker = new DockerCliRunner({ commands: hanging, cwd: CWD, env: {}, timeoutMs: 5 });
    await expect(docker.run(['run', 'image'])).rejects.toThrow(/did not return/);
    expect(killed).toContainEqual([91, 'SIGTERM']);

    const absent = new BoundedCommandRunner({
      spawn: (_command, _args) => {
        const child = new FakeChild();
        queueMicrotask(() => { child.stderr.emit('data', 'Error: No such object\n'); child.emit('close', 1, null); });
        return child;
      },
    });
    const probe = new DockerCliIdentityProbe({ commands: absent, cwd: CWD, env: {} });
    expect(await probe.inspect('b'.repeat(64))).toEqual({ status: 'absent' });
  });

  it('starts one native Codex argv worker, persists its identity before output, and revokes before deadline signal', async () => {
    const order = [];
    const child = new FakeChild(81);
    const commands = new BoundedCommandRunner({
      spawn: (command, args, options) => {
        expect({ command, args, options: { cwd: options.cwd, env: options.env, shell: options.shell } }).toEqual({ command: 'codex', args: ['exec', '--json'], options: { cwd: CWD, env: { CODEX_HOME: '/selected' }, shell: false } });
        setTimeout(() => { child.stdout.emit('data', '{"type":"turn.completed"}\n'); child.emit('close', 0, null); }, 5);
        return child;
      },
      killProcessGroup: (pid, signal) => { order.push(`signal:${pid}:${signal}`); },
    });
    const runner = new NativeCodexProcessRunner({
      commands,
      runNonce: 'native-nonce',
      identityProbe: { inspect: async (pid) => ({ pid, processStartedAt: 'start-81', processGroupId: 81, running: true }) },
    });
    const lifecycle = {
        onStarted: async (worker) => { order.push(`started:${worker.kind}:${worker.pid}`); },
        onTerminationRequired: async () => { order.push('termination'); },
    };

    const result = await runner.run({ runId: 'native-run', command: 'codex', args: ['exec', '--json'], cwd: CWD, environment: { CODEX_HOME: '/selected' }, timeoutMs: 500, lifecycle });

    expect(result).toEqual({ exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: '' });
    expect(order).toEqual(['started:native:81']);
  });

  it('calls native lifecycle termination before a timeout signal and returns uncertain termination', async () => {
    const order = [];
    const child = new FakeChild(82);
    let workerRunning = true;
    const commands = new BoundedCommandRunner({
      spawn: () => child,
      killProcessGroup: (pid, signal) => {
        order.push(`signal:${pid}:${signal}`);
        if (signal === 'SIGTERM') queueMicrotask(() => { workerRunning = false; child.emit('close', null, 'SIGTERM'); });
      },
      terminationGraceMs: 1,
    });
    const runner = new NativeCodexProcessRunner({
      commands, runNonce: 'native-timeout',
      identityProbe: { inspect: async (pid) => workerRunning ? ({ pid, processStartedAt: 'start-82', processGroupId: 82, running: true }) : ({ status: 'absent' }) },
    });
    const lifecycle = {
        onStarted: async () => { order.push('started'); },
        onTerminationRequired: async (_worker, reason) => { order.push(`termination:${reason}`); },
    };

    const result = await runner.run({ runId: 'native-timeout-run', command: 'codex', args: ['exec'], cwd: CWD, environment: { CODEX_HOME: '/selected' }, timeoutMs: 5, lifecycle });

    expect(result).toEqual(expect.objectContaining({ terminated: true, exitCode: null }));
    expect(order).toEqual(['started', 'termination:timeout', 'signal:82:SIGTERM']);
  });

  it('composes explicit adapter cancellation with the exact active run and refuses a wrong run before signaling', async () => {
    const order = [];
    const child = new FakeChild(83);
    let spawnedArgs;
    let workerRunning = true;
    const commands = new BoundedCommandRunner({
      spawn: (_command, args) => { spawnedArgs = args; return child; },
      killProcessGroup: (pid, signal) => {
        order.push(`signal:${pid}:${signal}`);
        if (signal === 'SIGTERM') queueMicrotask(() => { workerRunning = false; child.emit('close', null, 'SIGTERM'); });
      },
      terminationGraceMs: 1,
    });
    const runner = new NativeCodexProcessRunner({
      commands,
      runNonce: 'native-explicit-cancel',
      identityProbe: { inspect: async (pid) => workerRunning ? ({ pid, processStartedAt: 'start-83', processGroupId: 83, running: true }) : ({ status: 'absent' }) },
      allowUnsandboxedCodexInsideValidatedContainer: true,
    });
    const adapter = new CodexAdapter({
      runner,
      limits: { maxRuntimeMinutes: 5, maxTokens: 1_000, maxRetries: 0 },
      environment: { PATH: '/controlled/bin' },
      compatibleModels: ['gpt-5.5'],
    });
    const runIntent = {
      format: 'faktori.run-intent/v1',
      runId: 'explicit-cancel-run',
      admissionKey: 'explicit-cancel-admission',
      workItem: { id: 'F2-03', revision: 'work@1' },
      target: { factoryId: 'factory', productId: 'product', repository: 'owner/repo', branch: 'build/f2', baseRevision: 'base', expectedRevision: 'expected' },
      context: { packetRevision: 'packet@1', digest: 'packet-digest' },
      execution: { profile: 'isolated', workspaceId: 'workspace', workspacePath: CWD, providerId: 'codex', model: 'gpt-5.5', approvedInputDigests: [] },
      budget: { reservationId: 'reservation', maxRuntimeMinutes: 5, estimatedTokens: 100, status: 'held' },
      authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
      attempt: 1,
      createdAt: '2026-09-05T00:00:00.000Z',
    };
    let started;
    const observedStart = new Promise((resolve) => { started = resolve; });
    const running = adapter.start(runIntent, { ...runIntent.context, prompt: 'Wait for explicit cancellation.' }, {
      async onStarted() { order.push('started'); started(); },
    });
    await observedStart;
    const cancellationLifecycle = {
      async onStarted() { throw new Error('cancellation must not start a worker'); },
      async onTerminationRequired(_worker, reason) { order.push(`durable:${reason}`); },
    };

    const wrongRun = await adapter.cancel({ ...runIntent, runId: 'wrong-run' }, cancellationLifecycle);
    expect(wrongRun.outcome).toBe('failed');
    expect(order).toEqual(['started']);
    expect(spawnedArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');

    const denied = await adapter.cancel(runIntent, {
      async onStarted() { throw new Error('cancellation must not start a worker'); },
      async onTerminationRequired() { throw new Error('journal unavailable'); },
    });
    expect(denied.outcome).toBe('interrupted_uncertain');
    expect(order).toEqual(['started']);

    const cancelled = await adapter.cancel(runIntent, cancellationLifecycle);
    const interrupted = await running;
    expect(cancelled).toEqual(expect.objectContaining({ outcome: 'interrupted_uncertain', nativeCancellationReceipt: false }));
    expect(interrupted.final.outcome).toBe('interrupted_uncertain');
    expect(order).toEqual(['started', 'durable:cancelled', 'signal:83:SIGTERM']);
  });

  it('kills an anchored surviving child after the native leader exits on SIGTERM', async () => {
    const order = [];
    const child = new FakeChild(84);
    let leaderRunning = true;
    let childRunning = true;
    const commands = new BoundedCommandRunner({
      spawn: () => child,
      killProcessGroup: (pid, signal) => {
        order.push(`signal:${pid}:${signal}`);
        if (signal === 'SIGTERM') queueMicrotask(() => { leaderRunning = false; child.emit('close', null, 'SIGTERM'); });
        if (signal === 'SIGKILL') childRunning = false;
      },
      terminationGraceMs: 1,
    });
    const runner = new NativeCodexProcessRunner({
      commands,
      runNonce: 'native-sigterm-ignored',
      identityProbe: {
        inspect: async (pid) => {
          order.push(`inspect:${leaderRunning ? 'leader' : 'absent'}`);
          return leaderRunning ? { pid, processStartedAt: 'start-84', processGroupId: 84, running: true } : { status: 'absent' };
        },
        inspectProcessGroup: async () => {
          order.push(`group:${leaderRunning ? 'leader+' : ''}${childRunning ? 'child' : 'absent'}`);
          const members = [
            ...(leaderRunning ? [{ pid: 84, processStartedAt: 'start-84', processGroupId: 84, running: true }] : []),
            ...(childRunning ? [{ pid: 85, processStartedAt: 'start-85', processGroupId: 84, running: true }] : []),
          ];
          return members.length === 0 ? { status: 'absent' } : { processGroupId: 84, members };
        },
      },
    });
    const lifecycle = {
      async onStarted() { order.push('started'); },
      async onTerminationRequired(_worker, reason) { order.push(`durable:${reason}`); },
    };

    const result = await runner.run({ runId: 'sigterm-ignored-run', command: 'codex', args: ['exec'], cwd: CWD, environment: {}, timeoutMs: 5, lifecycle });

    expect(result).toEqual(expect.objectContaining({ terminated: true, exitCode: null }));
    expect(order).toEqual([
      'inspect:leader', 'started', 'durable:timeout', 'inspect:leader', 'group:leader+child',
      'signal:84:SIGTERM', 'group:child', 'signal:84:SIGKILL', 'group:absent',
    ]);
  });

  it('does not SIGKILL a native group whose observed identity is no longer anchored', async () => {
    const signals = [];
    const child = new FakeChild(86);
    let leaderRunning = true;
    let groupChecks = 0;
    const commands = new BoundedCommandRunner({
      spawn: () => child,
      killProcessGroup: (_pid, signal) => {
        signals.push(signal);
        if (signal === 'SIGTERM') queueMicrotask(() => { leaderRunning = false; child.emit('close', null, 'SIGTERM'); });
      },
      terminationGraceMs: 1,
    });
    const runner = new NativeCodexProcessRunner({
      commands,
      runNonce: 'native-reused-group',
      identityProbe: {
        inspect: async (pid) => leaderRunning ? { pid, processStartedAt: 'start-86', processGroupId: 86, running: true } : { status: 'absent' },
        inspectProcessGroup: async () => {
          groupChecks += 1;
          return groupChecks === 1
            ? { processGroupId: 86, members: [{ pid: 86, processStartedAt: 'start-86', processGroupId: 86, running: true }] }
            : { processGroupId: 86, members: [{ pid: 99, processStartedAt: 'replacement', processGroupId: 86, running: true }] };
        },
      },
    });
    const result = await runner.run({
      runId: 'reused-group-run', command: 'codex', args: ['exec'], cwd: CWD, environment: {}, timeoutMs: 5,
      lifecycle: { async onStarted() {}, async onTerminationRequired() {} },
    });

    expect(result).toEqual(expect.objectContaining({ terminated: true, exitCode: null }));
    expect(signals).toEqual(['SIGTERM']);
  });

  it('coalesces simultaneous explicit and bounded Docker termination into one durable hook and one stop', async () => {
    const id = 'd'.repeat(64);
    let logsChild;
    let waitChild;
    let hookCalls = 0;
    let stops = 0;
    let started;
    const observedStart = new Promise((resolve) => { started = resolve; });
    let releaseHook;
    const hookGate = new Promise((resolve) => { releaseHook = resolve; });
    const commands = new BoundedCommandRunner({
      spawn: (_command, args) => {
        const child = new FakeChild(args[0] === 'logs' ? 94 : 95);
        if (args[0] === 'logs') logsChild = child;
        if (args[0] === 'wait') waitChild = child;
        return child;
      },
      killProcessGroup: () => {},
    });
    const docker = {
      cwd: CWD,
      env: {},
      async run() { return { containerId: id }; },
      async stop() {
        stops += 1;
        queueMicrotask(() => {
          logsChild?.emit('close', 0, null);
          waitChild?.stdout.emit('data', '143\n');
          waitChild?.emit('close', 0, null);
        });
      },
    };
    const runner = new DockerCodexProcessRunner({
      docker,
      commands,
      runNonce: 'docker-coalesced',
      identityProbe: { inspect: async (containerId) => ({ containerId, containerStartedAt: 'docker-start', running: true }) },
      planFor: () => ({ profile: 'isolated', trustDisclosure: 'test', image: 'faktori@sha256:abc', networkMode: 'none', args: ['run', '--detach', 'faktori@sha256:abc', 'codex', 'exec'], cwd: '/workspace', env: {}, mounts: [], limits: { maxRuntimeSeconds: 1, memoryBytes: 1, cpuCount: 1, pids: 1 } }),
    });
    const lifecycle = {
      async onStarted() { started(); },
      async onTerminationRequired() { hookCalls += 1; await hookGate; },
    };
    const running = runner.run({ runId: 'coalesced-run', command: 'codex', args: ['exec'], cwd: CWD, environment: {}, timeoutMs: 5, lifecycle });
    await observedStart;
    const explicit = runner.terminate({ runId: 'coalesced-run', cwd: CWD, lifecycle });
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseHook();

    expect(await explicit).toEqual({ processTerminated: true, nativeCancellationReceipt: false });
    expect(await running).toEqual(expect.objectContaining({ terminated: true, exitCode: null }));
    expect(hookCalls).toBe(1);
    expect(stops).toBe(1);
  });

  it('uses one detached Docker Codex plan and calls lifecycle before stopping after docker wait deadline', async () => {
    const id = 'c'.repeat(64);
    const order = [];
    let waitChild;
    let logsChild;
    const commands = new BoundedCommandRunner({
      spawn: (_command, args) => {
        const child = new FakeChild(args[0] === 'wait' ? 92 : 93);
        if (args[0] === 'run') queueMicrotask(() => { child.stdout.emit('data', `${id}\n`); child.emit('close', 0, null); });
        if (args[0] === 'logs') { order.push('logs'); logsChild = child; }
        if (args[0] === 'stop') queueMicrotask(() => {
          order.push('stop');
          logsChild.emit('close', 0, null);
          waitChild.stdout.emit('data', '143\n');
          waitChild.emit('close', 0, null);
          child.emit('close', 0, null);
        });
        if (args[0] === 'wait') waitChild = child;
        return child;
      },
      killProcessGroup: (pid, signal) => {
        order.push(`wait-signal:${pid}:${signal}`);
        if (pid === 92 && signal === 'SIGTERM') queueMicrotask(() => waitChild.emit('close', null, 'SIGTERM'));
      },
    });
    const docker = new DockerCliRunner({ commands, cwd: CWD, env: { LANG: 'C' }, timeoutMs: 500 });
    const runner = new DockerCodexProcessRunner({
      docker,
      commands,
      runNonce: 'docker-nonce',
      identityProbe: { inspect: async (containerId) => ({ containerId, containerStartedAt: 'container-start', running: true }) },
      planFor: () => ({ profile: 'isolated', trustDisclosure: 'test', image: 'faktori@sha256:abc', networkMode: 'none', args: ['run', '--detach', 'faktori@sha256:abc', 'codex', 'exec', '--json'], cwd: '/workspace', env: {}, mounts: [], limits: { maxRuntimeSeconds: 1, memoryBytes: 1, cpuCount: 1, pids: 1 } }),
    });
    const lifecycle = {
        onStarted: async (worker) => { order.push(`started:${worker.kind}`); },
        onTerminationRequired: async (_worker, reason) => { order.push(`termination:${reason}`); },
    };

    const result = await runner.run({ runId: 'docker-timeout-run', command: 'codex', args: ['exec', '--json'], cwd: CWD, environment: { CODEX_HOME: '/selected' }, timeoutMs: 5, lifecycle });

    expect(result).toEqual(expect.objectContaining({ terminated: true, exitCode: null }));
    expect(order.slice(0, 4)).toEqual(['started:container', 'logs', 'termination:timeout', 'stop']);
    expect(order.filter((entry) => entry === 'stop')).toHaveLength(1);
  });
});
