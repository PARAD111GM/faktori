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

    const result = await runner.run({ command: 'codex', args: ['exec', '--json'], cwd: CWD, environment: { CODEX_HOME: '/selected' }, timeoutMs: 500, lifecycle });

    expect(result).toEqual({ exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: '' });
    expect(order).toEqual(['started:native:81']);
  });

  it('calls native lifecycle termination before a timeout signal and returns uncertain termination', async () => {
    const order = [];
    const child = new FakeChild(82);
    const commands = new BoundedCommandRunner({
      spawn: () => child,
      killProcessGroup: (pid, signal) => {
        order.push(`signal:${pid}:${signal}`);
        if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      },
    });
    const runner = new NativeCodexProcessRunner({
      commands, runNonce: 'native-timeout',
      identityProbe: { inspect: async (pid) => ({ pid, processStartedAt: 'start-82', processGroupId: 82, running: true }) },
    });
    const lifecycle = {
        onStarted: async () => { order.push('started'); },
        onTerminationRequired: async (_worker, reason) => { order.push(`termination:${reason}`); },
    };

    const result = await runner.run({ command: 'codex', args: ['exec'], cwd: CWD, environment: { CODEX_HOME: '/selected' }, timeoutMs: 5, lifecycle });

    expect(result).toEqual(expect.objectContaining({ terminated: true, exitCode: null }));
    expect(order).toEqual(['started', 'termination:timeout', 'signal:82:SIGTERM']);
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
        if (args[0] === 'stop') queueMicrotask(() => { order.push('stop'); logsChild.emit('close', 0, null); child.emit('close', 0, null); });
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

    const result = await runner.run({ command: 'codex', args: ['exec', '--json'], cwd: CWD, environment: { CODEX_HOME: '/selected' }, timeoutMs: 5, lifecycle });

    expect(result).toEqual(expect.objectContaining({ terminated: true, exitCode: null }));
    expect(order.slice(0, 4)).toEqual(['started:container', 'logs', 'termination:timeout', 'stop']);
    expect(order).toContain('wait-signal:92:SIGTERM');
  });
});
