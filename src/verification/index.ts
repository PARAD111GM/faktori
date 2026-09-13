import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { BoundedCommandRunner, NativeIdentityProbe, type CommandResult } from '../execution/transports.ts';
import type { NativeProcessGroupObservation, NativeProcessObservation } from '../execution/index.ts';
import { captureCandidateSnapshot, copyCandidateSnapshot, type CandidateSnapshot } from './snapshot.ts';

export { captureCandidateSnapshot } from './snapshot.ts';
export type { CandidateSnapshot } from './snapshot.ts';

export interface VerificationCommand { command: string; args: string[] }
export interface CandidateVerificationConfiguration {
  format: 'faktori.candidate-verification/v1';
  /** Commands are owner-trusted native project code, not sandboxed code. */
  execution: { nativeAccessApproved: true; approvedBy: string };
  candidate: { path: string; expectedDigest: string };
  startup: VerificationCommand;
  identity: VerificationCommand;
  check: VerificationCommand;
  /** Exact environment. Nothing is inherited from the controller process. */
  environment: Record<string, string>;
  negativeControls: Array<{ id: string; environment: Record<string, string>; expectedFailureCode: string }>;
  limits: { startupTimeoutMs: number; checkTimeoutMs: number; shutdownTimeoutMs: number; outputMaxBytes: number };
}
export interface RuntimeIdentity {
  format: 'faktori.runtime-identity/v1';
  runId: string;
  candidateDigest: string;
  variant: string;
  endpoint?: string;
}
export interface RuntimeCheck {
  format: 'faktori.runtime-check/v1';
  runId: string;
  candidateDigest: string;
  variant: string;
  status: 'passed' | 'failed';
  failureCode?: string;
}
export interface CandidateScenarioResult {
  id: string;
  runId: string;
  environmentDigest: string;
  passed: boolean;
  reason?: string;
  identity?: RuntimeIdentity;
  check?: RuntimeCheck;
  cleanup: 'confirmed' | 'unconfirmed';
  processes: Array<{ pid: number; observedMembers: NativeProcessObservation[] }>;
  outputDigest: string;
}
export interface CandidateVerificationResult {
  format: 'faktori.candidate-verification-result/v1';
  candidateDigest: string;
  /** Binds the approved commands, limits, environment inputs, and control set. */
  configurationDigest: string;
  status: 'passed' | 'failed';
  passed: boolean;
  reason?: string;
  snapshot?: CandidateSnapshot;
  scenarios: CandidateScenarioResult[];
  outputDigest: string;
  executionBoundary: 'owner_trusted_native';
  /** Retained only when a process could not be confirmed stopped. */
  recoveryDirectory?: string;
}

const digest = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4_000 && !value.includes('\0');
const sha = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));
const detail = (error: unknown): string => error instanceof Error ? error.message : 'verification_error';
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('verification_unknown_field');
}
function environment(value: unknown): Record<string, string> {
  if (!record(value) || Object.entries(value).some(([key, val]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.startsWith('FAKTORI_VERIFY_') || typeof val !== 'string' || val.length > 32_768 || val.includes('\0'))) throw new Error('verification_invalid_environment');
  return { ...value } as Record<string, string>;
}
function command(value: unknown): VerificationCommand {
  if (!record(value)) throw new Error('verification_invalid_command');
  keys(value, ['command', 'args']);
  if (!text(value.command) || !isAbsolute(value.command) || !Array.isArray(value.args) || value.args.length > 100 || value.args.some(arg => typeof arg !== 'string' || arg.length > 32_768 || arg.includes('\0'))) throw new Error('verification_requires_absolute_executable_and_argv');
  return { command: value.command, args: [...value.args] as string[] };
}
export function parseCandidateVerificationConfiguration(value: unknown): CandidateVerificationConfiguration {
  if (!record(value) || value.format !== 'faktori.candidate-verification/v1') throw new Error('verification_invalid_configuration');
  keys(value, ['format', 'execution', 'candidate', 'startup', 'identity', 'check', 'environment', 'negativeControls', 'limits']);
  if (!record(value.execution) || value.execution.nativeAccessApproved !== true || !text(value.execution.approvedBy)) throw new Error('verification_native_execution_not_approved');
  keys(value.execution, ['nativeAccessApproved', 'approvedBy']);
  if (!record(value.candidate) || !text(value.candidate.path) || !isAbsolute(value.candidate.path) || !sha(value.candidate.expectedDigest)) throw new Error('verification_invalid_candidate');
  keys(value.candidate, ['path', 'expectedDigest']);
  if (!record(value.limits)) throw new Error('verification_invalid_limits');
  keys(value.limits, ['startupTimeoutMs', 'checkTimeoutMs', 'shutdownTimeoutMs', 'outputMaxBytes']);
  for (const [key, max] of Object.entries({ startupTimeoutMs: 60_000, checkTimeoutMs: 120_000, shutdownTimeoutMs: 5_000, outputMaxBytes: 1_048_576 })) {
    if (!Number.isInteger(value.limits[key]) || Number(value.limits[key]) < 1 || Number(value.limits[key]) > max) throw new Error('verification_invalid_limits');
  }
  if (!Array.isArray(value.negativeControls) || value.negativeControls.length < 1 || value.negativeControls.length > 10) throw new Error('verification_negative_controls_required');
  const seen = new Set(['healthy']);
  const negativeControls = value.negativeControls.map(control => {
    if (!record(control) || !id(control.id) || seen.has(control.id) || !id(control.expectedFailureCode)) throw new Error('verification_invalid_negative_control');
    keys(control, ['id', 'environment', 'expectedFailureCode']);
    seen.add(control.id);
    return { id: control.id, environment: environment(control.environment), expectedFailureCode: control.expectedFailureCode };
  });
  return { format: value.format, execution: { nativeAccessApproved: true, approvedBy: value.execution.approvedBy }, candidate: { path: value.candidate.path, expectedDigest: value.candidate.expectedDigest }, startup: command(value.startup), identity: command(value.identity), check: command(value.check), environment: environment(value.environment), negativeControls, limits: { ...value.limits } as CandidateVerificationConfiguration['limits'] };
}

function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.outputLimitExceeded && result.spawnError === undefined;
}
function bound<T extends RuntimeIdentity | RuntimeCheck>(value: unknown, expected: { runId: string; candidateDigest: string; variant: string }, format: T['format']): T {
  if (!record(value) || value.format !== format || value.runId !== expected.runId || value.candidateDigest !== expected.candidateDigest || value.variant !== expected.variant) throw new Error('runtime_identity_mismatch');
  keys(value, format === 'faktori.runtime-identity/v1' ? ['format', 'runId', 'candidateDigest', 'variant', 'endpoint'] : ['format', 'runId', 'candidateDigest', 'variant', 'status', 'failureCode']);
  if (format === 'faktori.runtime-identity/v1' && value.endpoint !== undefined) {
    if (!text(value.endpoint)) throw new Error('runtime_invalid_endpoint');
    const url = new URL(value.endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.hash || url.search) throw new Error('runtime_endpoint_must_be_loopback');
  }
  if (format === 'faktori.runtime-check/v1' && (value.status !== 'passed' && value.status !== 'failed' || value.failureCode !== undefined && !id(value.failureCode) || value.status === 'passed' && value.failureCode !== undefined || value.status === 'failed' && !id(value.failureCode))) throw new Error('runtime_invalid_check_result');
  return value as T;
}
function evidenceJson(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new Error('runtime_evidence_malformed'); }
}
async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), remaining); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function scenario(config: CandidateVerificationConfiguration, snapshot: string, scratch: string, variant: string, overrides: Record<string, string>, expectedFailureCode?: string): Promise<CandidateScenarioResult> {
  const runId = randomUUID();
  const expected = { runId, candidateDigest: config.candidate.expectedDigest, variant };
  const env = { ...config.environment, ...overrides, FAKTORI_VERIFY_RUN_ID: runId, FAKTORI_VERIFY_CANDIDATE_DIGEST: expected.candidateDigest, FAKTORI_VERIFY_VARIANT: variant, FAKTORI_VERIFY_DIRECTORY: scratch };
  const commands = new BoundedCommandRunner({ terminationGraceMs: Math.min(250, config.limits.shutdownTimeoutMs) });
  const receipts: unknown[] = [];
  const identities = new Map<number, NativeProcessObservation[]>();
  const terminations = new Map<number, Promise<boolean>>();
  let cleanup = true;
  let runtimePid: number | undefined;
  let runtimeResult: CommandResult | undefined;
  let runtimeCompletion: Promise<CommandResult> | undefined;
  let identity: RuntimeIdentity | undefined;
  let check: RuntimeCheck | undefined;
  let reason: string | undefined;
  async function group(pid: number, deadline: number): Promise<NativeProcessGroupObservation | undefined> {
    if (Date.now() >= deadline) return undefined;
    const bounded = new BoundedCommandRunner({ terminationGraceMs: 0 });
    const originalRun = bounded.run.bind(bounded);
    bounded.run = input => originalRun({ ...input, timeoutMs: Math.max(1, Math.min(input.timeoutMs, deadline - Date.now())) });
    return beforeDeadline(new NativeIdentityProbe({ commands: bounded, cwd: snapshot, env }).inspectProcessGroup(pid), deadline);
  }
  const gone = (observed: NativeProcessGroupObservation | undefined): boolean => observed !== undefined && ('status' in observed ? observed.status === 'absent' : observed.members.every(member => !member.running));
  const same = (a: NativeProcessObservation, b: NativeProcessObservation): boolean => a.pid === b.pid && a.processGroupId === b.processGroupId && a.processStartedAt === b.processStartedAt;
  async function remember(pid: number): Promise<void> {
    if (pid < 1) return;
    identities.delete(pid);
    terminations.delete(pid);
    const observed = await group(pid, Date.now() + 1_000);
    if (observed && 'members' in observed && observed.members.some(member => member.pid === pid && member.running)) identities.set(pid, [...observed.members]);
  }
  function stop(pid: number, deadline = Date.now() + config.limits.shutdownTimeoutMs): Promise<boolean> {
    if (pid < 1) return Promise.resolve(true);
    const existing = terminations.get(pid);
    if (existing) return existing;
    const termination = (async () => {
      let anchors = identities.get(pid) ?? [];
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        const observed = await group(pid, deadline);
        if (gone(observed)) return true;
        if (!observed || !('members' in observed) || !observed.members.some(member => member.running && anchors.some(anchor => same(anchor, member)))) return false;
        anchors = [...observed.members];
        if (Date.now() >= deadline) return false;
        try { commands.killProcessGroup(pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
        await delay(Math.max(0, Math.min(25, deadline - Date.now())));
      }
      while (Date.now() < deadline) {
        if (gone(await group(pid, deadline))) return true;
        await delay(Math.max(0, Math.min(25, deadline - Date.now())));
      }
      return false;
    })();
    terminations.set(pid, termination);
    return termination;
  }
  async function run(command: VerificationCommand, timeoutMs: number): Promise<CommandResult> {
    let identityReady = Promise.resolve();
    const launched = await commands.start({ ...command, cwd: snapshot, env, timeoutMs, stdoutMaxBytes: config.limits.outputMaxBytes, stderrMaxBytes: config.limits.outputMaxBytes, onTerminationRequired: async () => { await identityReady; cleanup = await stop(launched.pid) && cleanup; return 'handled'; } });
    identityReady = remember(launched.pid);
    await identityReady;
    const result = await launched.completion;
    cleanup = await stop(launched.pid) && cleanup;
    receipts.push({ command, result });
    return result;
  }
  async function live(): Promise<void> {
    if (runtimeResult !== undefined || runtimePid === undefined) throw new Error('runtime_exited');
    const observed = await group(runtimePid, Date.now() + 1_000);
    const anchors = identities.get(runtimePid) ?? [];
    if (!observed || !('members' in observed) || !observed.members.some(member => member.pid === runtimePid && member.running && anchors.some(anchor => same(anchor, member)))) throw new Error('runtime_exited_or_identity_unavailable');
    identities.set(runtimePid, [...observed.members]);
  }
  async function readIdentity(timeoutMs: number): Promise<RuntimeIdentity | undefined> {
    const result = await run(config.identity, timeoutMs);
    await live();
    if (!commandSucceeded(result)) return undefined;
    return bound<RuntimeIdentity>(evidenceJson(result.stdout), expected, 'faktori.runtime-identity/v1');
  }
  try {
    let identityReady = Promise.resolve();
    const launched = await commands.start({ ...config.startup, cwd: snapshot, env, timeoutMs: config.limits.startupTimeoutMs + config.limits.checkTimeoutMs + 5_000, stdoutMaxBytes: config.limits.outputMaxBytes, stderrMaxBytes: config.limits.outputMaxBytes, onTerminationRequired: async () => { await identityReady; if (runtimePid) cleanup = await stop(runtimePid) && cleanup; return 'handled'; } });
    runtimePid = launched.pid;
    runtimeCompletion = launched.completion.then(result => { runtimeResult = result; return result; });
    if (runtimePid < 1) throw new Error('runtime_start_failed');
    identityReady = remember(runtimePid);
    await identityReady;
    const readyDeadline = Date.now() + config.limits.startupTimeoutMs;
    do {
      await live();
      identity = await readIdentity(Math.max(1, Math.min(1_000, readyDeadline - Date.now())));
      if (identity) break;
      await delay(25);
    } while (Date.now() < readyDeadline);
    if (!identity) throw new Error('runtime_identity_timeout');
    const observed = await run(config.check, config.limits.checkTimeoutMs);
    await live();
    if (!commandSucceeded(observed)) throw new Error(observed.timedOut ? 'check_timeout' : 'check_execution_failed');
    check = bound<RuntimeCheck>(evidenceJson(observed.stdout), expected, 'faktori.runtime-check/v1');
    const after = await readIdentity(1_000);
    if (!after || digest(after) !== digest(identity)) throw new Error('runtime_identity_changed');
    if (expectedFailureCode === undefined ? check.status !== 'passed' : check.status !== 'failed' || check.failureCode !== expectedFailureCode) throw new Error(expectedFailureCode === undefined ? 'healthy_check_failed' : 'negative_control_not_detected');
    if ((await captureCandidateSnapshot(snapshot)).candidateDigest !== expected.candidateDigest) throw new Error('runtime_changed_candidate');
    await live();
  } catch (error) { reason = detail(error); }
  finally {
    const deadline = Date.now() + config.limits.shutdownTimeoutMs;
    if (runtimePid !== undefined) cleanup = await stop(runtimePid, deadline) && cleanup;
    if (runtimeCompletion) {
      const result = runtimeResult ?? await beforeDeadline(runtimeCompletion, deadline);
      if (result) receipts.push({ command: config.startup, result });
      else cleanup = false;
    }
    if (!cleanup) reason ??= 'runtime_cleanup_unconfirmed';
  }
  return { id: variant, runId, environmentDigest: digest(env), passed: reason === undefined, ...(reason ? { reason } : {}), ...(identity ? { identity } : {}), ...(check ? { check } : {}), cleanup: cleanup ? 'confirmed' : 'unconfirmed', processes: [...identities].map(([pid, observedMembers]) => ({ pid, observedMembers })), outputDigest: digest({ environmentDigest: digest(env), receipts }) };
}

/** Deterministic evidence only. Commands are trusted by the approving owner. */
export async function verifyCandidateRuntime(value: unknown): Promise<CandidateVerificationResult> {
  const config = parseCandidateVerificationConfiguration(value);
  const scenarios: CandidateScenarioResult[] = [];
  let snapshot: CandidateSnapshot | undefined;
  let reason: string | undefined;
  const temporary = await mkdtemp(join(tmpdir(), 'faktori-candidate-verification-'));
  try {
    for (const control of [{ id: 'healthy', environment: {} as Record<string, string>, expectedFailureCode: undefined }, ...config.negativeControls]) {
      const path = join(temporary, control.id);
      const scratch = join(temporary, `${control.id}-runtime`);
      await mkdir(path); await mkdir(scratch);
      snapshot = await copyCandidateSnapshot(config.candidate.path, path, config.candidate.expectedDigest);
      const result = await scenario(config, path, scratch, control.id, control.environment, control.expectedFailureCode);
      scenarios.push(result);
      if (!result.passed) { reason = `${control.id}:${result.reason}`; break; }
    }
    if ((await captureCandidateSnapshot(config.candidate.path)).candidateDigest !== config.candidate.expectedDigest) reason ??= 'source_candidate_changed';
  } catch (error) { reason = detail(error); }
  finally { if (scenarios.every(item => item.cleanup === 'confirmed')) await rm(temporary, { recursive: true, force: true }); }
  const passed = reason === undefined && scenarios.length === config.negativeControls.length + 1 && scenarios.every(item => item.passed);
  const result = { format: 'faktori.candidate-verification-result/v1' as const, candidateDigest: config.candidate.expectedDigest, configurationDigest: digest(config), status: passed ? 'passed' as const : 'failed' as const, passed, ...(reason ? { reason } : {}), ...(snapshot ? { snapshot } : {}), scenarios, executionBoundary: 'owner_trusted_native' as const, ...(scenarios.some(item => item.cleanup === 'unconfirmed') ? { recoveryDirectory: temporary } : {}) };
  return { ...result, outputDigest: digest(result) };
}
