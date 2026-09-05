import type { NativeIdentityObservation, NativeIdentityProbe } from './index.ts';
import { BoundedCommandRunner } from './transports.ts';
import type { ClaudeProcessRequest, ClaudeProcessResult, ClaudeTerminationRequest, ClaudeTerminationResult } from '../providers/claude.ts';
import type { NativeWorkerIdentity, WorkerIdentity } from '../runtime/contracts.ts';

const DEFAULT_OUTPUT_CAP = 1024 * 1024;

export interface ClaudeTransportLifecycle {
  onStarted(worker: WorkerIdentity): Promise<void>;
  onTerminationRequired(worker: WorkerIdentity, reason: 'timeout' | 'output_limit' | 'cancelled'): Promise<void>;
}

export interface NativeClaudeProcessRunnerOptions {
  commands?: BoundedCommandRunner;
  identityProbe: NativeIdentityProbe;
  runNonce: string;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
}

/** Superset accepted by the adapter's per-turn process request as it evolves. */
export interface ClaudeTransportRequest extends ClaudeProcessRequest {
  lifecycle?: ClaudeTransportLifecycle;
}

type ActiveNativeClaudeWorker = {
  worker: NativeWorkerIdentity;
  runId: string;
  cwd: string;
  cancelled: boolean;
  termination?: Promise<void>;
};

function sameNativeWorker(
  worker: NativeWorkerIdentity,
  observed: NativeIdentityObservation | undefined,
): observed is Extract<NativeIdentityObservation, { pid: number }> {
  return observed !== undefined && 'pid' in observed
    && observed.pid === worker.pid
    && observed.processStartedAt === worker.processStartedAt
    && observed.processGroupId === worker.processGroupId;
}

function nativeGroupExited(observed: Awaited<ReturnType<NonNullable<NativeIdentityProbe['inspectProcessGroup']>>>): boolean {
  return observed !== undefined && (('status' in observed && observed.status === 'absent')
    || ('members' in observed && observed.members.every((member) => !member.running)));
}

function interruptedResult(result: { stdout: string; stderr: string }): ClaudeProcessResult {
  // SIGINT/SIGTERM or a wrapper exit is not a provider-native Claude cancellation receipt.
  return { exitCode: null, stdout: result.stdout, stderr: result.stderr, terminated: true };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** One native Claude worker, with an exact durable identity before stream consumption. */
export class NativeClaudeProcessRunner {
  readonly commands: BoundedCommandRunner;
  readonly identityProbe: NativeIdentityProbe;
  readonly runNonce: string;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  #active?: ActiveNativeClaudeWorker;

  constructor(options: NativeClaudeProcessRunnerOptions) {
    this.commands = options.commands ?? new BoundedCommandRunner();
    this.identityProbe = options.identityProbe;
    this.runNonce = options.runNonce;
    this.stdoutMaxBytes = options.stdoutMaxBytes ?? DEFAULT_OUTPUT_CAP;
    this.stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_OUTPUT_CAP;
  }

  async run(request: ClaudeTransportRequest): Promise<ClaudeProcessResult> {
    if (request.command !== 'claude' || request.runId.trim().length === 0 || this.#active !== undefined) {
      throw new Error('Native Claude runner permits exactly one active claude invocation');
    }
    const lifecycle = request.lifecycle;
    let active: ActiveNativeClaudeWorker | undefined;
    try {
      const result = await this.commands.run({
        command: 'claude',
        args: request.args,
        cwd: request.cwd,
        env: request.environment,
        timeoutMs: request.timeoutMs,
        stdoutMaxBytes: this.stdoutMaxBytes,
        stderrMaxBytes: this.stderrMaxBytes,
        detached: true,
        onLaunched: async (pid): Promise<void> => {
          const observed = await this.identityProbe.inspect(pid);
          if (observed === undefined || 'status' in observed || !observed.running || observed.pid !== pid) {
            throw new Error('native Claude worker identity could not be observed');
          }
          const worker: NativeWorkerIdentity = {
            kind: 'native',
            pid,
            processStartedAt: observed.processStartedAt,
            processGroupId: observed.processGroupId,
            runNonce: this.runNonce,
          };
          active = { worker, runId: request.runId, cwd: request.cwd, cancelled: false };
          this.#active = active;
          await lifecycle?.onStarted(worker);
        },
        onTerminationRequired: async (reason): Promise<'handled'> => {
          if (active === undefined || lifecycle?.onTerminationRequired === undefined) {
            throw new Error('native Claude worker has no durable termination authority hook');
          }
          await this.terminateActive(active, lifecycle, reason);
          return 'handled';
        },
      });
      if (active?.cancelled || result.timedOut || result.outputLimitExceeded || result.spawnError !== undefined) return interruptedResult(result);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } finally {
      this.#active = undefined;
    }
  }

  async terminate(request: ClaudeTerminationRequest & { lifecycle?: ClaudeTransportLifecycle }): Promise<ClaudeTerminationResult> {
    const active = this.#active;
    if (active === undefined || active.runId !== request.runId || active.cwd !== request.cwd || request.lifecycle === undefined) {
      return { processTerminated: false };
    }
    await this.terminateActive(active, request.lifecycle, 'cancelled');
    return { processTerminated: true, nativeCancellationReceipt: false };
  }

  private async terminateActive(
    active: ActiveNativeClaudeWorker,
    lifecycle: ClaudeTransportLifecycle,
    reason: 'timeout' | 'output_limit' | 'cancelled',
  ): Promise<void> {
    if (active.termination !== undefined) return active.termination;
    const previouslyCancelled = active.cancelled;
    let authorityRecorded = false;
    const termination = (async (): Promise<void> => {
      await lifecycle.onTerminationRequired(active.worker, reason);
      authorityRecorded = true;
      active.cancelled = active.cancelled || reason === 'cancelled';

      const beforeSignal = await this.identityProbe.inspect(active.worker.pid);
      if (!sameNativeWorker(active.worker, beforeSignal)) {
        throw new Error('native Claude worker identity unavailable or changed before SIGTERM; no signal sent');
      }
      this.commands.killProcessGroup(active.worker.processGroupId, 'SIGTERM');

      await wait(this.commands.terminationGraceMs);
      const afterTermGroup = await this.identityProbe.inspectProcessGroup?.(active.worker.processGroupId);
      if (nativeGroupExited(afterTermGroup)) return;
      // Without a group observation we cannot safely establish continuous identity for SIGKILL.
      if (afterTermGroup === undefined || 'status' in afterTermGroup) {
        throw new Error('native Claude process-group exit is unknown after SIGTERM; SIGKILL not sent');
      }
      const hasLeader = afterTermGroup.members.some((member) => member.pid === active.worker.pid
        && member.processStartedAt === active.worker.processStartedAt
        && member.processGroupId === active.worker.processGroupId);
      if (!hasLeader) throw new Error('native Claude process group has no continuous worker identity after SIGTERM; SIGKILL not sent');

      this.commands.killProcessGroup(active.worker.processGroupId, 'SIGKILL');
      await wait(this.commands.terminationGraceMs);
      const afterKillGroup = await this.identityProbe.inspectProcessGroup?.(active.worker.processGroupId);
      if (!nativeGroupExited(afterKillGroup)) throw new Error('native Claude worker exit could not be confirmed after identity-checked SIGKILL');
    })();
    active.termination = termination;
    try {
      await termination;
    } catch (error) {
      if (active.termination === termination) active.termination = undefined;
      if (!authorityRecorded) active.cancelled = previouslyCancelled;
      throw error;
    }
  }
}
