import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import type {
  ContainerIdentityObservation,
  ContainerIdentityProbe as ContainerIdentityProbeContract,
  ContainerRunner as ContainerRunnerContract,
  ExecutionResourceLimits,
  NativeIdentityObservation,
  NativeIdentityProbe as NativeIdentityProbeContract,
  NativeProcessRunner as NativeProcessRunnerContract,
  ProcessLaunchOptions,
} from './index.ts';
import type { DockerExecutionPlan } from './index.ts';
import type { CodexProcessRequest, CodexProcessResult, CodexTerminationRequest, CodexTerminationResult } from '../providers/codex.ts';
import type { ContainerWorkerIdentity, NativeWorkerIdentity, WorkerIdentity } from '../runtime/contracts.ts';

export interface SpawnedProcess {
  pid?: number;
  stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

export interface CommandInvocation {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Required exact environment. This module never falls back to process.env. */
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
  detached?: boolean;
  /** Runs after PID creation but before this runner attaches output consumers. */
  onLaunched?: (pid: number) => Promise<void>;
  /** Runs before this runner signals the detached group for a terminal bound. */
  onTerminationRequired?: (reason: 'timeout' | 'output_limit') => Promise<void>;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError?: string;
}

export interface BoundedCommandRunnerOptions {
  spawn?: SpawnProcess;
  killProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
  terminationGraceMs?: number;
}

export interface LaunchedCommand {
  pid: number;
  completion: Promise<CommandResult>;
}

const DEFAULT_OUTPUT_CAP = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CodexTransportLifecycle {
  onStarted(worker: WorkerIdentity): Promise<void>;
  onTerminationRequired(worker: WorkerIdentity, reason: 'timeout' | 'output_limit' | 'cancelled'): Promise<void>;
}

export interface NativeCodexProcessRunnerOptions {
  commands?: BoundedCommandRunner;
  identityProbe: NativeIdentityProbeContract;
  runNonce: string;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
}

export interface DockerCodexProcessRunnerOptions {
  docker: DockerCliRunner;
  identityProbe: ContainerIdentityProbeContract;
  commands?: BoundedCommandRunner;
  runNonce: string;
  planFor(request: CodexProcessRequest): DockerExecutionPlan;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
}

/** Superset accepted by the adapter's per-turn process request as it evolves. */
export interface CodexTransportRequest extends CodexProcessRequest {
  lifecycle?: CodexTransportLifecycle;
}

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess {
  return nodeSpawn(command, [...args], options) as ChildProcess;
}

function appendBounded(current: Buffer<ArrayBufferLike>, chunk: Buffer | string, maxBytes: number): { bytes: Buffer<ArrayBufferLike>; exceeded: boolean } {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (current.length + incoming.length <= maxBytes) return { bytes: Buffer.concat([current, incoming]), exceeded: false };
  return { bytes: Buffer.concat([current, incoming.subarray(0, Math.max(0, maxBytes - current.length))]), exceeded: true };
}

function validInvocation(input: CommandInvocation): void {
  if (input.command.trim().length === 0 || input.command.includes('\0')) throw new Error('command must be a non-empty argv executable');
  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('args must be explicit strings without NUL');
  if (input.cwd.trim().length === 0) throw new Error('cwd must be explicit');
  if (input.detached === false) throw new Error('bounded commands must launch a detached process group');
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');
  if (!Number.isInteger(input.stdoutMaxBytes) || input.stdoutMaxBytes < 0 || !Number.isInteger(input.stderrMaxBytes) || input.stderrMaxBytes < 0) throw new Error('output caps must be non-negative integers');
  for (const [key, value] of Object.entries(input.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('env must be an exact string-only environment');
  }
}

/** argv-only process boundary. A timeout/output cap never returns a success. */
export class BoundedCommandRunner {
  readonly spawnProcess: SpawnProcess;
  readonly killProcessGroup: (processGroupId: number, signal: NodeJS.Signals) => void;
  readonly terminationGraceMs: number;

  constructor(options: BoundedCommandRunnerOptions = {}) {
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.killProcessGroup = options.killProcessGroup ?? ((groupId, signal) => { process.kill(-groupId, signal); });
    this.terminationGraceMs = options.terminationGraceMs ?? 250;
  }

  async run(input: CommandInvocation): Promise<CommandResult> {
    return (await this.start(input)).completion;
  }

  async start(input: CommandInvocation): Promise<LaunchedCommand> {
    validInvocation(input);
    const detached = input.detached !== false;
    let child: SpawnedProcess;
    try {
      child = this.spawnProcess(input.command, [...input.args], {
        cwd: input.cwd,
        env: { ...input.env },
        detached,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return { pid: -1, completion: Promise.resolve({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, outputLimitExceeded: false, spawnError: errorMessage(error) }) };
    }
    if (child.pid === undefined || child.pid < 1) {
      return { pid: -1, completion: Promise.resolve({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, outputLimitExceeded: false, spawnError: 'spawn did not return a child pid' }) };
    }
    const pid = child.pid;
    if (input.onLaunched !== undefined) {
      try {
        await input.onLaunched(pid);
      } catch (error) {
        try { this.killProcessGroup(pid, 'SIGTERM'); } catch { /* process may already have exited */ }
        return { pid: -1, completion: Promise.resolve({ exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, outputLimitExceeded: false, spawnError: `launch callback failed: ${errorMessage(error)}` }) };
      }
    }
    const completion = new Promise<CommandResult>((resolveResult) => {
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let timedOut = false;
      let outputLimitExceeded = false;
      let spawnError: string | undefined;
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let termination: Promise<void> | undefined;
      let finish: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
      const terminate = (): void => {
        try { this.killProcessGroup(pid, 'SIGTERM'); } catch { /* process may already have exited */ }
        killTimer = setTimeout(() => { try { this.killProcessGroup(pid, 'SIGKILL'); } catch { /* already gone */ } }, this.terminationGraceMs);
      };
      const requestTermination = (reason: 'timeout' | 'output_limit'): void => {
        if (termination !== undefined) return;
        termination = (async (): Promise<void> => {
          try {
            await input.onTerminationRequired?.(reason);
          } catch (error) {
            spawnError = `termination callback failed: ${errorMessage(error)}`;
            finish(null, null);
            return;
          }
          terminate();
        })();
      };
      const timeout = setTimeout(() => { timedOut = true; requestTermination('timeout'); }, input.timeoutMs);
      finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        const deliver = (): void => resolveResult({ exitCode, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut, outputLimitExceeded, ...(spawnError === undefined ? {} : { spawnError }) });
        if (termination === undefined) deliver();
        else void termination.finally(deliver);
      };
      child.stdout?.on('data', (chunk) => {
        const next = appendBounded(stdout, chunk, input.stdoutMaxBytes);
        stdout = next.bytes;
        if (next.exceeded && !outputLimitExceeded) { outputLimitExceeded = true; requestTermination('output_limit'); }
      });
      child.stderr?.on('data', (chunk) => {
        const next = appendBounded(stderr, chunk, input.stderrMaxBytes);
        stderr = next.bytes;
        if (next.exceeded && !outputLimitExceeded) { outputLimitExceeded = true; requestTermination('output_limit'); }
      });
      child.on('error', (error) => { spawnError = errorMessage(error); finish(null, null); });
      child.on('close', finish);
    });
    return { pid, completion };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown process error';
}

function boundedInvocation(command: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>, timeoutMs: number): CommandInvocation {
  return { command, args, cwd, env, timeoutMs, stdoutMaxBytes: DEFAULT_OUTPUT_CAP, stderrMaxBytes: DEFAULT_OUTPUT_CAP, detached: true };
}

export class NativeProcessRunner implements NativeProcessRunnerContract {
  readonly commands: BoundedCommandRunner;
  #launched = new Set<number>();

  constructor(commands = new BoundedCommandRunner()) {
    this.commands = commands;
  }

  async spawn(command: string, args: readonly string[], options: ProcessLaunchOptions): Promise<{ pid: number }> {
    const launched = await this.commands.start(boundedInvocation(command, args, options.cwd, options.env, options.limits.maxRuntimeSeconds * 1000));
    if (launched.pid < 1) throw new Error(`native process did not launch: ${(await launched.completion).spawnError ?? 'unknown failure'}`);
    this.#launched.add(launched.pid);
    return { pid: launched.pid };
  }

  async terminateProcessGroup(processGroupId: number): Promise<void> {
    if (!this.#launched.has(processGroupId)) throw new Error('refusing to signal an untracked native process group');
    this.commands.killProcessGroup(processGroupId, 'SIGTERM');
  }

  launched(pid: number): boolean {
    return this.#launched.has(pid);
  }
}

export class NativeIdentityProbe implements NativeIdentityProbeContract {
  readonly commands: BoundedCommandRunner;
  readonly runner?: NativeProcessRunner;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;

  constructor(options: { commands?: BoundedCommandRunner; runner?: NativeProcessRunner; cwd: string; env: Readonly<Record<string, string>> }) {
    this.commands = options.commands ?? new BoundedCommandRunner();
    this.runner = options.runner;
    this.cwd = options.cwd;
    this.env = options.env;
  }

  async inspect(pid: number): Promise<NativeIdentityObservation | undefined> {
    if (!Number.isInteger(pid) || pid < 1 || (this.runner !== undefined && !this.runner.launched(pid))) return { status: 'unknown' };
    const result = await this.commands.run(boundedInvocation('ps', ['-o', 'pid=,lstart=,pgid=,stat=', '-p', String(pid)], this.cwd, this.env, 1_000));
    if (result.timedOut || result.outputLimitExceeded || result.spawnError !== undefined) return { status: 'unknown' };
    if (result.exitCode !== 0 || result.stdout.trim() === '') return { status: 'absent' };
    const match = result.stdout.trim().match(/^(\d+)\s+(.+?)\s+(\d+)\s+(\S+)$/);
    if (match === null || Number(match[1]) !== pid || !Number.isInteger(Number(match[3]))) return { status: 'unknown' };
    return { pid, processStartedAt: match[2], processGroupId: Number(match[3]), running: !match[4].startsWith('Z') };
  }
}

function dockerId(value: string): string | undefined {
  const id = value.trim();
  return /^[a-f0-9]{12,64}$/i.test(id) ? id : undefined;
}

function safeDockerArgs(args: readonly string[]): void {
  if (args.length === 0 || args.some((arg) => arg.includes('\0'))) throw new Error('unsafe or empty Docker argv');
  for (const [index, argument] of args.entries()) {
    const normalized = argument.toLowerCase();
    if (normalized === '--privileged' || normalized === '--pid=host' || normalized === '--network=host') throw new Error('unsafe or empty Docker argv');
    if ((normalized === '--pid' || normalized === '--network') && args[index + 1]?.toLowerCase() === 'host') throw new Error('unsafe or empty Docker argv');
    if (normalized === '--mount' || normalized === '--volume' || normalized === '-v') {
      if (/docker\.sock/i.test(args[index + 1] ?? '')) throw new Error('unsafe or empty Docker argv');
    }
  }
}

export class DockerCliRunner implements ContainerRunnerContract {
  readonly commands: BoundedCommandRunner;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;

  constructor(options: { commands?: BoundedCommandRunner; cwd: string; env: Readonly<Record<string, string>>; timeoutMs?: number }) {
    this.commands = options.commands ?? new BoundedCommandRunner();
    this.cwd = options.cwd;
    this.env = options.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async run(args: readonly string[]): Promise<{ containerId: string }> {
    safeDockerArgs(args);
    if (args[0] !== 'run') throw new Error('DockerCliRunner only permits docker run argv');
    const result = await this.commands.run(boundedInvocation('docker', args, this.cwd, this.env, this.timeoutMs));
    const containerId = dockerId(result.stdout);
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded || result.spawnError !== undefined || containerId === undefined) throw new Error(`docker run did not return a verified container id: ${result.stderr || result.spawnError || 'unknown failure'}`);
    return { containerId };
  }

  async stop(containerId: string): Promise<void> {
    if (dockerId(containerId) === undefined) throw new Error('refusing to stop an invalid container id');
    const result = await this.commands.run(boundedInvocation('docker', ['stop', '--time', '10', containerId], this.cwd, this.env, this.timeoutMs));
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded || result.spawnError !== undefined) throw new Error(`docker stop failed: ${result.stderr || result.spawnError || 'unknown failure'}`);
  }
}

export class DockerCliIdentityProbe implements ContainerIdentityProbeContract {
  readonly commands: BoundedCommandRunner;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;

  constructor(options: { commands?: BoundedCommandRunner; cwd: string; env: Readonly<Record<string, string>> }) {
    this.commands = options.commands ?? new BoundedCommandRunner();
    this.cwd = options.cwd;
    this.env = options.env;
  }

  async inspect(containerId: string): Promise<ContainerIdentityObservation | undefined> {
    if (dockerId(containerId) === undefined) return { status: 'unknown' };
    const result = await this.commands.run(boundedInvocation('docker', ['inspect', '--format', '{{.Id}}\t{{.State.StartedAt}}\t{{.State.Running}}', containerId], this.cwd, this.env, 5_000));
    if (result.timedOut || result.outputLimitExceeded || result.spawnError !== undefined) return { status: 'unknown' };
    if (result.exitCode !== 0) return /no such object|no such container/i.test(result.stderr) ? { status: 'absent' } : { status: 'unknown' };
    const [observedId, startedAt, running] = result.stdout.trim().split('\t');
    if (dockerId(observedId ?? '') === undefined || observedId !== containerId || startedAt?.trim().length === 0 || (running !== 'true' && running !== 'false')) return { status: 'unknown' };
    return { containerId: observedId, containerStartedAt: startedAt, running: running === 'true' };
  }
}

function limitsForCodex(timeoutMs: number): ExecutionResourceLimits {
  return { maxRuntimeSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)), memoryBytes: 1, cpuCount: 1, pids: 1 };
}

function interruptedResult(result: CommandResult): CodexProcessResult {
  // A wrapper-bound interruption is not a Codex success receipt, even when a
  // helper process happened to exit 0 while the container/process was stopped.
  return { exitCode: null, stdout: result.stdout, stderr: result.stderr, terminated: true };
}

/** One native Codex worker, with lifecycle persistence before output consumption. */
export class NativeCodexProcessRunner {
  readonly commands: BoundedCommandRunner;
  readonly identityProbe: NativeIdentityProbeContract;
  readonly runNonce: string;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  #active?: NativeWorkerIdentity;

  constructor(options: NativeCodexProcessRunnerOptions) {
    this.commands = options.commands ?? new BoundedCommandRunner();
    this.identityProbe = options.identityProbe;
    this.runNonce = options.runNonce;
    this.stdoutMaxBytes = options.stdoutMaxBytes ?? DEFAULT_OUTPUT_CAP;
    this.stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_OUTPUT_CAP;
  }

  async run(request: CodexTransportRequest): Promise<CodexProcessResult> {
    if (request.command !== 'codex' || this.#active !== undefined) throw new Error('Native Codex runner permits exactly one active codex invocation');
    const lifecycle = request.lifecycle;
    let worker: NativeWorkerIdentity | undefined;
    const result = await this.commands.run({
      command: 'codex', args: request.args, cwd: request.cwd, env: request.environment, timeoutMs: request.timeoutMs,
      stdoutMaxBytes: this.stdoutMaxBytes, stderrMaxBytes: this.stderrMaxBytes, detached: true,
      onLaunched: async (pid): Promise<void> => {
        const observed = await this.identityProbe.inspect(pid);
        if (observed === undefined || 'status' in observed || !observed.running || observed.pid !== pid) throw new Error('native Codex worker identity could not be observed');
        worker = { kind: 'native', pid, processStartedAt: observed.processStartedAt, processGroupId: observed.processGroupId, runNonce: this.runNonce };
        this.#active = worker;
        await lifecycle?.onStarted(worker);
      },
      onTerminationRequired: async (reason): Promise<void> => {
        if (worker === undefined) throw new Error('native Codex worker was not observed before termination');
        await lifecycle?.onTerminationRequired(worker, reason);
      },
    });
    this.#active = undefined;
    if (result.timedOut || result.outputLimitExceeded || result.spawnError !== undefined) return interruptedResult(result);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async terminate(request: CodexTerminationRequest & { lifecycle?: CodexTransportLifecycle }): Promise<CodexTerminationResult> {
    const worker = this.#active;
    if (worker === undefined) return { processTerminated: false };
    // The ordinary adapter cancellation request carries no durable authority
    // hook. Fail closed; coordinator-owned cancellation supplies the hook or
    // calls cancelDurableNativeRun directly.
    if (request.lifecycle === undefined) return { processTerminated: false };
    await request.lifecycle.onTerminationRequired(worker, 'cancelled');
    this.commands.killProcessGroup(worker.processGroupId, 'SIGTERM');
    return { processTerminated: true, nativeCancellationReceipt: false };
  }
}

/** Docker Codex runner: launch one validated detached plan, then wait and log it. */
export class DockerCodexProcessRunner {
  readonly docker: DockerCliRunner;
  readonly identityProbe: ContainerIdentityProbeContract;
  readonly commands: BoundedCommandRunner;
  readonly runNonce: string;
  readonly planFor: (request: CodexProcessRequest) => DockerExecutionPlan;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  #active?: ContainerWorkerIdentity;

  constructor(options: DockerCodexProcessRunnerOptions) {
    this.docker = options.docker;
    this.identityProbe = options.identityProbe;
    this.commands = options.commands ?? new BoundedCommandRunner();
    this.runNonce = options.runNonce;
    this.planFor = options.planFor;
    this.stdoutMaxBytes = options.stdoutMaxBytes ?? DEFAULT_OUTPUT_CAP;
    this.stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_OUTPUT_CAP;
  }

  async run(request: CodexTransportRequest): Promise<CodexProcessResult> {
    if (request.command !== 'codex' || this.#active !== undefined) throw new Error('Docker Codex runner permits exactly one active codex invocation');
    const lifecycle = request.lifecycle;
    const plan = this.planFor(request);
    if (plan.profile !== 'isolated' || plan.args[0] !== 'run' || plan.args.filter((arg) => arg === 'codex').length !== 1) throw new Error('Docker Codex runner requires one validated detached Codex plan');
    const startedAt = Date.now();
    const launched = await this.docker.run(plan.args);
    const observed = await this.identityProbe.inspect(launched.containerId);
    if (observed === undefined || 'status' in observed || !observed.running || observed.containerId !== launched.containerId) throw new Error('Docker Codex container identity could not be observed');
    const worker: ContainerWorkerIdentity = { kind: 'container', containerId: observed.containerId, containerStartedAt: observed.containerStartedAt, runNonce: this.runNonce };
    this.#active = worker;
    await lifecycle?.onStarted(worker);
    const remaining = (): number => Math.max(1, request.timeoutMs - (Date.now() - startedAt));
    let stoppedForBound = false;
    const stopForBound = async (reason: 'timeout' | 'output_limit'): Promise<void> => {
      if (stoppedForBound) return;
      stoppedForBound = true;
      await lifecycle?.onTerminationRequired(worker, reason);
      await this.docker.stop(worker.containerId);
    };
    // Docker plans are --rm. Start following logs while the exact observed
    // container exists, before wait can observe removal at process exit.
    const logsLaunch = await this.commands.start({
      command: 'docker', args: ['logs', '--follow', worker.containerId], cwd: this.docker.cwd, env: this.docker.env,
      timeoutMs: remaining(), stdoutMaxBytes: this.stdoutMaxBytes, stderrMaxBytes: this.stderrMaxBytes, detached: true,
      onTerminationRequired: stopForBound,
    });
    const wait = await this.commands.run({
      command: 'docker', args: ['wait', worker.containerId], cwd: this.docker.cwd, env: this.docker.env,
      timeoutMs: remaining(), stdoutMaxBytes: 64, stderrMaxBytes: this.stderrMaxBytes, detached: true,
      onTerminationRequired: stopForBound,
    });
    const logs = await logsLaunch.completion;
    this.#active = undefined;
    if (wait.timedOut || wait.outputLimitExceeded || wait.spawnError !== undefined || logs.timedOut || logs.outputLimitExceeded || logs.spawnError !== undefined || stoppedForBound) {
      return interruptedResult(logs.timedOut || logs.outputLimitExceeded || logs.spawnError !== undefined ? logs : wait);
    }
    const exitCode = Number(wait.stdout.trim());
    if (!Number.isInteger(exitCode) || wait.exitCode !== 0 || logs.exitCode !== 0) return { exitCode: null, stdout: logs.stdout, stderr: `${wait.stderr}${logs.stderr}`, terminated: true };
    return { exitCode, stdout: logs.stdout, stderr: logs.stderr };
  }

  async terminate(request: CodexTerminationRequest & { lifecycle?: CodexTransportLifecycle }): Promise<CodexTerminationResult> {
    const worker = this.#active;
    if (worker === undefined) return { processTerminated: false };
    if (request.lifecycle === undefined) return { processTerminated: false };
    await request.lifecycle.onTerminationRequired(worker, 'cancelled');
    try {
      await this.docker.stop(worker.containerId);
      return { processTerminated: true, nativeCancellationReceipt: false };
    } finally {
      this.#active = undefined;
    }
  }

}
