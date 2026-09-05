import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { AuthorizedAction, ControllerActionExecutor } from '../actions/index.ts';
import { BoundedCommandRunner, type CommandResult } from '../execution/transports.ts';

export type DeploymentMode = 'local-command' | 'existing-ci';

export interface EnvironmentReceipt {
  runId: string;
  actionId: string;
  environment: string;
  revision: string;
  deploymentId: string;
  deployedAt: string;
  mode: DeploymentMode;
  status: 'deployed' | 'failed' | 'observed';
  ciUrl?: string;
}

export interface DeploymentCommand {
  executable: string;
  args?: string[];
  cwd: string;
  /** Exact non-secret environment allowlist approved for this command. */
  environment: Record<string, string>;
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
}

/** Controller-held credentials are selected per target and command phase. */
export interface TargetCredentials {
  deploy?: Record<string, string>;
  smoke?: Record<string, string>;
  recovery?: Record<string, string>;
}

export interface ExistingCiRecord {
  runId: string;
  url: string;
  environment: string;
  revision: string;
  status: 'succeeded' | 'failed' | 'pending';
}

/** Configured CI transport; actions cannot carry CI observations. */
export interface ExistingCiObserver {
  observe(input: { runId: string; environment: string; revision: string }): Promise<ExistingCiRecord | undefined>;
}

export interface DeploymentTarget {
  operation: string;
  environment: string;
  revision: string;
  approved: boolean;
  mode: DeploymentMode;
  command?: DeploymentCommand;
  /** Required configured CI run identity for existing-CI mode. */
  ciRunId?: string;
  smoke: DeploymentCommand;
  credentials?: TargetCredentials;
}

export interface RecoveryHook {
  operation: string;
  environment: string;
  revision: string;
  approved: boolean;
  configured: boolean;
  compatibleWith?: (action: AuthorizedAction) => boolean;
  precondition?: () => Promise<boolean> | boolean;
  command: DeploymentCommand;
  credentials?: Record<string, string>;
}

export interface DeploymentConfiguration {
  targets: readonly DeploymentTarget[];
  recoveryHooks?: readonly RecoveryHook[];
  ciObserver?: ExistingCiObserver;
}

export interface FollowUp {
  key: string;
  runId: string;
  actionId: string;
  environment: string;
  revision: string;
  reason: 'smoke_failed';
  createdAt: string;
}

/** The implementation must persist before returning true. */
export interface DurableFollowUpStore {
  createOnce(followUp: FollowUp): Promise<boolean>;
}

export class InMemoryFollowUpStore implements DurableFollowUpStore {
  #records = new Map<string, FollowUp>();

  async createOnce(followUp: FollowUp): Promise<boolean> {
    if (this.#records.has(followUp.key)) return false;
    this.#records.set(followUp.key, structuredClone(followUp));
    return true;
  }

  records(): readonly FollowUp[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}

/**
 * Private controller storage for failure follow-ups. A create-only hashed file
 * provides cross-process idempotency without storing a command or credential.
 */
export class FileFollowUpStore implements DurableFollowUpStore {
  readonly directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error('Follow-up storage requires a normalized absolute controller path');
    this.directory = directory;
  }

  async createOnce(followUp: FollowUp): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const name = createHash('sha256').update(`faktori-follow-up:${followUp.key}`).digest('hex');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(join(this.directory, `${name}.json`), 'wx', 0o600);
      await handle.writeFile(JSON.stringify(followUp), 'utf8');
      await handle.sync();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async records(): Promise<readonly FollowUp[]> {
    try {
      return await Promise.all((await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map(async (name) => JSON.parse(await readFile(join(this.directory, name), 'utf8')) as FollowUp));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

/** Deployment observations are controller records, not executor-local memory. */
export interface DurableDeploymentRecordStore {
  append(receipt: EnvironmentReceipt): Promise<void>;
  records(): Promise<readonly EnvironmentReceipt[]>;
}

export class FileDeploymentRecordStore implements DurableDeploymentRecordStore {
  readonly directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error('Deployment record storage requires a normalized absolute controller path');
    this.directory = directory;
  }

  async append(receipt: EnvironmentReceipt): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const name = `${receipt.deployedAt.replace(/[^0-9]/g, '')}-${randomUUID()}.json`;
    const handle = await open(join(this.directory, name), 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(receipt), 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
  }

  async records(): Promise<readonly EnvironmentReceipt[]> {
    try {
      return await Promise.all((await readdir(this.directory)).filter((name) => /^[0-9]+-[0-9a-f-]+\.json$/.test(name)).sort().map(async (name) => JSON.parse(await readFile(join(this.directory, name), 'utf8')) as EnvironmentReceipt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

export interface DeploymentClock { now(): Date; }

const systemClock: DeploymentClock = { now: () => new Date() };
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_CAP = 64 * 1024;

function usable(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validCommand(command: DeploymentCommand | undefined): command is DeploymentCommand {
  return command !== undefined && usable(command.executable) && usable(command.cwd)
    && (command.args === undefined || command.args.every(usable))
    && Object.entries(command.environment).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0'))
    && (command.timeoutMs === undefined || Number.isInteger(command.timeoutMs) && command.timeoutMs > 0)
    && (command.stdoutMaxBytes === undefined || Number.isInteger(command.stdoutMaxBytes) && command.stdoutMaxBytes >= 0)
    && (command.stderrMaxBytes === undefined || Number.isInteger(command.stderrMaxBytes) && command.stderrMaxBytes >= 0);
}

function targetFor(action: AuthorizedAction, targets: readonly DeploymentTarget[]): DeploymentTarget | undefined {
  return targets.find((target) => target.operation === action.request.scope.allowedOperation);
}

function commandDetail(result: CommandResult): string {
  if (result.timedOut) return 'command_timed_out';
  if (result.outputLimitExceeded) return 'command_output_limit_exceeded';
  if (result.spawnError !== undefined) return 'command_start_failed';
  return result.exitCode === 0 ? 'command_completed' : `command_failed:${result.signal ?? result.exitCode ?? 'unknown'}`;
}

async function run(runner: BoundedCommandRunner, command: DeploymentCommand, credentials: Readonly<Record<string, string>> = {}): Promise<{ ok: boolean; detail: string }> {
  // No process.env inheritance: this exact allowlist is the child environment.
  const result = await runner.run({ command: command.executable, args: command.args ?? [], cwd: command.cwd, env: { ...command.environment, ...credentials }, timeoutMs: command.timeoutMs ?? DEFAULT_TIMEOUT_MS, stdoutMaxBytes: command.stdoutMaxBytes ?? DEFAULT_OUTPUT_CAP, stderrMaxBytes: command.stderrMaxBytes ?? DEFAULT_OUTPUT_CAP });
  return { ok: result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded && result.spawnError === undefined, detail: commandDetail(result) };
}

/**
 * A controller-side adapter: untrusted action input selects only an already
 * configured operation. Commands and credentials never travel in the action.
 * Existing-CI mode observes a supplied provider record; it does not poll or
 * start provider workflows.
 */
export class DeploymentMaintenanceExecutor implements ControllerActionExecutor {
  readonly configuration: DeploymentConfiguration;
  readonly followUps: DurableFollowUpStore;
  readonly records: DurableDeploymentRecordStore;
  readonly clock: DeploymentClock;
  readonly commands: BoundedCommandRunner;

  constructor(configuration: DeploymentConfiguration, followUps: DurableFollowUpStore, records: DurableDeploymentRecordStore, clock: DeploymentClock = systemClock, commands: BoundedCommandRunner = new BoundedCommandRunner()) {
    this.configuration = configuration;
    this.followUps = followUps;
    this.records = records;
    this.clock = clock;
    this.commands = commands;
  }

  async execute(action: AuthorizedAction, guard: () => Promise<void>): Promise<{ outcome: 'completed' | 'blocked' | 'failed'; detail?: string }> {
    const recovery = this.configuration.recoveryHooks?.find((hook) => hook.operation === action.request.scope.allowedOperation);
    if (recovery !== undefined) return this.recover(action, guard, recovery);
    const target = targetFor(action, this.configuration.targets);
    if (target === undefined) return { outcome: 'blocked', detail: 'deployment_target_not_configured' };
    if (!target.approved || target.revision !== action.request.scope.expectedRevision || !usable(target.environment) || !validCommand(target.smoke)) {
      return { outcome: 'blocked', detail: 'deployment_target_not_approved_or_compatible' };
    }
    if (target.mode === 'existing-ci') return this.observeCi(action, guard, target);
    if (!validCommand(target.command)) return { outcome: 'blocked', detail: 'local_deployment_command_not_configured' };

    await guard();
    const deployed = await run(this.commands, target.command, target.credentials?.deploy);
    if (!deployed.ok) return this.failure(target, action, deployed.detail);
    await this.record(target, action, 'deployed');
    await guard();
    return this.smoke(target, action);
  }

  private async observeCi(action: AuthorizedAction, guard: () => Promise<void>, target: DeploymentTarget): Promise<{ outcome: 'completed' | 'blocked' | 'failed'; detail?: string }> {
    if (!usable(target.ciRunId) || this.configuration.ciObserver === undefined) return { outcome: 'blocked', detail: 'existing_ci_observer_not_configured' };
    const record = await this.configuration.ciObserver.observe({ runId: target.ciRunId, environment: target.environment, revision: target.revision });
    if (record === undefined || record.runId !== target.ciRunId || !usable(record.url) || record.environment !== target.environment || record.revision !== target.revision) {
      return { outcome: 'blocked', detail: 'existing_ci_record_not_compatible' };
    }
    if (record.status !== 'succeeded') return { outcome: record.status === 'failed' ? 'failed' : 'blocked', detail: `existing_ci_${record.status}` };
    await guard();
    await this.record(target, action, 'observed', record.url);
    await guard();
    return this.smoke(target, action);
  }

  private async recover(action: AuthorizedAction, guard: () => Promise<void>, hook: RecoveryHook): Promise<{ outcome: 'completed' | 'blocked' | 'failed'; detail?: string }> {
    if (!hook.configured || !hook.approved || hook.revision !== action.request.scope.expectedRevision || !usable(hook.environment) || !validCommand(hook.command) || hook.compatibleWith?.(action) === false || await hook.precondition?.() === false) {
      return { outcome: 'blocked', detail: 'recovery_hook_not_configured_approved_or_compatible' };
    }
    await guard();
    const result = await run(this.commands, hook.command, hook.credentials);
    if (!result.ok) return this.failure({ environment: hook.environment, revision: hook.revision, mode: 'local-command' }, action, 'recovery_hook_failed');
    await this.records.append({ runId: action.request.runId, actionId: action.request.actionId, environment: hook.environment, revision: hook.revision, deploymentId: action.operationId, deployedAt: this.clock.now().toISOString(), mode: 'local-command', status: 'observed' });
    return { outcome: 'completed', detail: 'recovery_hook_completed' };
  }

  private async smoke(target: DeploymentTarget, action: AuthorizedAction): Promise<{ outcome: 'completed' | 'failed'; detail: string }> {
    const smoke = await run(this.commands, target.smoke, target.credentials?.smoke);
    if (!smoke.ok) {
      await this.followUps.createOnce({ key: `smoke:${action.request.runId}:${action.operationId}:${target.environment}:${target.revision}`, runId: action.request.runId, actionId: action.request.actionId, environment: target.environment, revision: target.revision, reason: 'smoke_failed', createdAt: this.clock.now().toISOString() });
      return this.failure(target, action, 'smoke_check_failed');
    }
    return { outcome: 'completed', detail: target.mode === 'existing-ci' ? 'existing_ci_observed_and_smoke_verified' : 'deployment_and_smoke_verified' };
  }

  private async record(target: DeploymentTarget, action: AuthorizedAction, status: EnvironmentReceipt['status'], ciUrl?: string): Promise<void> {
    await this.records.append({ runId: action.request.runId, actionId: action.request.actionId, environment: target.environment, revision: target.revision, deploymentId: action.operationId, deployedAt: this.clock.now().toISOString(), mode: target.mode, status, ...(ciUrl === undefined ? {} : { ciUrl }) });
  }

  private async failure(target: Pick<DeploymentTarget, 'environment' | 'revision' | 'mode'>, action: AuthorizedAction, detail: string): Promise<{ outcome: 'failed'; detail: string }> {
    await this.records.append({ runId: action.request.runId, actionId: action.request.actionId, environment: target.environment, revision: target.revision, deploymentId: action.operationId, deployedAt: this.clock.now().toISOString(), mode: target.mode, status: 'failed' });
    return { outcome: 'failed', detail };
  }
}
