import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { AuthorizedAction, ControllerActionExecutor } from '../actions/index.ts';

export type DeploymentMode = 'local-command' | 'existing-ci';

export interface EnvironmentReceipt {
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
  /** Non-secret names/values approved for this target. */
  environment?: Record<string, string>;
}

export interface ExistingCiRecord {
  runId: string;
  url: string;
  environment: string;
  revision: string;
  status: 'succeeded' | 'failed' | 'pending';
}

export interface DeploymentTarget {
  operation: string;
  environment: string;
  revision: string;
  approved: boolean;
  mode: DeploymentMode;
  command?: DeploymentCommand;
  existingCi?: ExistingCiRecord;
  smoke: DeploymentCommand;
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
}

export interface DeploymentConfiguration {
  targets: readonly DeploymentTarget[];
  recoveryHooks?: readonly RecoveryHook[];
  /** Private controller-held values injected only into spawned child processes. */
  credentials?: Record<string, string>;
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

export interface DeploymentClock { now(): Date; }

const systemClock: DeploymentClock = { now: () => new Date() };

function usable(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validCommand(command: DeploymentCommand | undefined): command is DeploymentCommand {
  return command !== undefined && usable(command.executable) && usable(command.cwd)
    && (command.args === undefined || command.args.every(usable))
    && (command.environment === undefined || Object.entries(command.environment).every(([key, value]) => usable(key) && typeof value === 'string'));
}

function targetFor(action: AuthorizedAction, targets: readonly DeploymentTarget[]): DeploymentTarget | undefined {
  return targets.find((target) => target.operation === action.request.scope.allowedOperation);
}

async function run(command: DeploymentCommand, credentials: Readonly<Record<string, string>>): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args ?? [], {
      cwd: command.cwd,
      env: { ...process.env, ...command.environment, ...credentials },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-500); });
    child.once('error', () => resolve({ ok: false, detail: 'command_start_failed' }));
    child.once('close', (code, signal) => resolve({ ok: code === 0, detail: code === 0 ? 'command_completed' : `command_failed:${signal ?? code ?? 'unknown'}` }));
  });
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
  readonly clock: DeploymentClock;
  #receipts: EnvironmentReceipt[] = [];

  constructor(configuration: DeploymentConfiguration, followUps: DurableFollowUpStore, clock: DeploymentClock = systemClock) {
    this.configuration = configuration;
    this.followUps = followUps;
    this.clock = clock;
  }

  receipts(): readonly EnvironmentReceipt[] {
    return this.#receipts.map((receipt) => structuredClone(receipt));
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
    const deployed = await run(target.command, this.configuration.credentials ?? {});
    if (!deployed.ok) return this.failure(target, deployed.detail);
    this.record(target, action, 'deployed');
    await guard();
    const smoke = await run(target.smoke, this.configuration.credentials ?? {});
    if (!smoke.ok) {
      await this.followUps.createOnce({
        key: `smoke:${action.request.runId}:${action.operationId}:${target.environment}:${target.revision}`,
        runId: action.request.runId,
        actionId: action.request.actionId,
        environment: target.environment,
        revision: target.revision,
        reason: 'smoke_failed',
        createdAt: this.clock.now().toISOString(),
      });
      return this.failure(target, 'smoke_check_failed');
    }
    return { outcome: 'completed', detail: 'deployment_and_smoke_verified' };
  }

  private async observeCi(action: AuthorizedAction, guard: () => Promise<void>, target: DeploymentTarget): Promise<{ outcome: 'completed' | 'blocked' | 'failed'; detail?: string }> {
    const record = target.existingCi;
    if (record === undefined || !usable(record.runId) || !usable(record.url) || record.environment !== target.environment || record.revision !== target.revision) {
      return { outcome: 'blocked', detail: 'existing_ci_record_not_compatible' };
    }
    if (record.status !== 'succeeded') return { outcome: record.status === 'failed' ? 'failed' : 'blocked', detail: `existing_ci_${record.status}` };
    await guard();
    this.record(target, action, 'observed', record.url);
    await guard();
    const smoke = await run(target.smoke, this.configuration.credentials ?? {});
    if (!smoke.ok) {
      await this.followUps.createOnce({ key: `smoke:${action.request.runId}:${action.operationId}:${target.environment}:${target.revision}`, runId: action.request.runId, actionId: action.request.actionId, environment: target.environment, revision: target.revision, reason: 'smoke_failed', createdAt: this.clock.now().toISOString() });
      return this.failure(target, 'smoke_check_failed');
    }
    return { outcome: 'completed', detail: 'existing_ci_observed_and_smoke_verified' };
  }

  private async recover(action: AuthorizedAction, guard: () => Promise<void>, hook: RecoveryHook): Promise<{ outcome: 'completed' | 'blocked' | 'failed'; detail?: string }> {
    if (!hook.configured || !hook.approved || hook.revision !== action.request.scope.expectedRevision || !usable(hook.environment) || !validCommand(hook.command) || hook.compatibleWith?.(action) === false || await hook.precondition?.() === false) {
      return { outcome: 'blocked', detail: 'recovery_hook_not_configured_approved_or_compatible' };
    }
    await guard();
    const result = await run(hook.command, this.configuration.credentials ?? {});
    if (!result.ok) return { outcome: 'failed', detail: 'recovery_hook_failed' };
    this.#receipts.push({ environment: hook.environment, revision: hook.revision, deploymentId: action.operationId, deployedAt: this.clock.now().toISOString(), mode: 'local-command', status: 'observed' });
    return { outcome: 'completed', detail: 'recovery_hook_completed' };
  }

  private record(target: DeploymentTarget, action: AuthorizedAction, status: EnvironmentReceipt['status'], ciUrl?: string): void {
    this.#receipts.push({ environment: target.environment, revision: target.revision, deploymentId: action.operationId, deployedAt: this.clock.now().toISOString(), mode: target.mode, status, ...(ciUrl === undefined ? {} : { ciUrl }) });
  }

  private failure(target: DeploymentTarget, detail: string): { outcome: 'failed'; detail: string } {
    this.#receipts.push({ environment: target.environment, revision: target.revision, deploymentId: 'failed', deployedAt: this.clock.now().toISOString(), mode: target.mode, status: 'failed' });
    return { outcome: 'failed', detail };
  }
}
