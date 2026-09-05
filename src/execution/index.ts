/**
 * The execution boundary deliberately plans every host interaction before a
 * runner is called.  This module does not collect credentials: a credential
 * profile is a selected, pre-staged directory managed by the caller.
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import type { ExecutionProfile } from '../config/index.ts';
import type { ContainerWorkerIdentity, NativeWorkerIdentity, WorkerIdentity } from '../runtime/contracts.ts';

export const DEFAULT_SHARED_SCRATCH_ROOT = '/private/tmp';
export const SAFE_ENVIRONMENT_KEYS = ['LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] as const;

const FORBIDDEN_ENVIRONMENT_KEY = /^(?:GITHUB|GH|JIRA|ATLASSIAN|AWS|AZURE|GOOGLE|VERCEL|NETLIFY|CLOUDFLARE|DEPLOY|DOCKER|SSH|GIT_ASKPASS|GIT_CONFIG|NPM_TOKEN|NODE_AUTH_TOKEN)(?:_|$)/i;
const SAFE_ENVIRONMENT_KEY = new Set<string>(SAFE_ENVIRONMENT_KEYS);
const DOCKER_IMAGE_REFERENCE = /^(?:sha256:[a-f0-9]{64}|(?:(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64})$/;
const validatedDockerPlans = new WeakMap<object, string>();

export class ExecutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionPolicyError';
  }
}

export interface CredentialProfile {
  /** Opaque identifier suitable for records; never put a credential value here. */
  profileId: string;
  /** Existing, pre-staged directory. Docker profiles require it below scratchRoot. */
  path: string;
  /** Provider-specific configuration-location variable, for example CODEX_HOME. */
  environmentVariable: string;
  /** Opt in only when the unmodified vendor CLI must refresh its own session. */
  writable?: boolean;
}

export interface ApprovedInput {
  path: string;
  label?: string;
}

export interface ExecutionResourceLimits {
  maxRuntimeSeconds: number;
  memoryBytes: number;
  cpuCount: number;
  pids: number;
}

export interface ExecutionRequest {
  runId: string;
  workspacePath: string;
  command: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
  approvedInputs?: readonly ApprovedInput[];
  credentialProfile?: CredentialProfile;
  /** Isolated workers are offline unless the admitted run explicitly needs bridge networking. */
  networkMode?: 'none' | 'bridge';
  limits: ExecutionResourceLimits;
}

export interface NativeExecutionPlan {
  profile: 'native';
  trustDisclosure: 'broad_os_identity_trust';
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** The injected native runner is responsible for applying these host limits. */
  limits: ExecutionResourceLimits;
}

export interface DockerMount {
  source: string;
  target: string;
  readOnly: boolean;
  purpose: 'workspace' | 'approved_input' | 'credential_profile';
}

export interface DockerExecutionPlan {
  profile: 'isolated';
  trustDisclosure: string;
  image: string;
  networkMode: 'none' | 'bridge';
  args: readonly string[];
  cwd: '/workspace';
  env: Readonly<Record<string, string>>;
  mounts: readonly DockerMount[];
  limits: ExecutionResourceLimits;
}

export interface DockerProfileOptions {
  image: string;
  /** Alternate shared roots require an explicit coordinator policy decision. */
  allowedSharedScratchRoots?: readonly string[];
  scratchRoot?: string;
  /** Controller-owned roots that must be named for every isolated execution. */
  controlStoragePaths: readonly string[];
  hostHome?: string;
}

/** True only for an unchanged plan returned by this module's hardened builder. */
export function isValidatedDockerExecutionPlan(value: DockerExecutionPlan): boolean {
  return validatedDockerPlans.get(value) === JSON.stringify(value);
}

export interface ProcessLaunchOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  detached: boolean;
  limits: ExecutionResourceLimits;
}

export interface NativeProcessRunner {
  spawn(command: string, args: readonly string[], options: ProcessLaunchOptions): Promise<{ pid: number }>;
  terminateProcessGroup(processGroupId: number): Promise<void>;
}

export interface NativeIdentityProbe {
  inspect(pid: number): Promise<NativeIdentityObservation | undefined>;
  inspectProcessGroup?(processGroupId: number): Promise<NativeProcessGroupObservation | undefined>;
}

export interface ContainerRunner {
  run(args: readonly string[]): Promise<{ containerId: string }>;
  stop(containerId: string): Promise<void>;
}

export interface ContainerIdentityProbe {
  inspect(containerId: string): Promise<ContainerIdentityObservation | undefined>;
}

export type NativeProcessObservation = { pid: number; processStartedAt: string; processGroupId: number; running: boolean };

export type NativeIdentityObservation =
  | NativeProcessObservation
  | { status: 'absent' | 'unknown' };

export type NativeProcessGroupObservation =
  | { processGroupId: number; members: readonly NativeProcessObservation[] }
  | { status: 'absent' | 'unknown' };

export type ContainerIdentityObservation =
  | { containerId: string; containerStartedAt: string; running: boolean }
  | { status: 'absent' | 'unknown' };

export interface CancellationAuthority {
  /** Persist revocation before this module sends a signal or container stop. */
  revokeBeforeTermination(identity: WorkerIdentity, reason: string): Promise<void>;
}

export interface CancellationResult {
  authorityRevoked: true;
  outcome: 'confirmed_exited' | 'interrupted_uncertain';
  identity: WorkerIdentity;
  detail: string;
}

export function profileTrustDisclosure(profile: ExecutionProfile): string {
  return profile === 'native'
    ? 'Native execution trusts the worker with the access of its operating-system identity; it is not equivalent to container isolation.'
    : 'Isolated execution permits only the explicitly mounted workspace, approved read-only inputs, and selected read-only credential profile.';
}

export function buildNativeExecutionPlan(request: ExecutionRequest, inheritedEnvironment: NodeJS.ProcessEnv = process.env): NativeExecutionPlan {
  if (request.networkMode !== undefined) throw new ExecutionPolicyError('networkMode applies only to the isolated Docker profile');
  const workspace = assertRealDirectory(request.workspacePath, 'workspacePath');
  const env = controlledEnvironment(request.environment, inheritedEnvironment, request.credentialProfile, false);
  validateRequest(request);
  return {
    profile: 'native',
    trustDisclosure: 'broad_os_identity_trust',
    command: request.command,
    args: [...request.args],
    cwd: workspace,
    env,
    limits: { ...request.limits },
  };
}

export function buildDockerExecutionPlan(request: ExecutionRequest, options: DockerProfileOptions): DockerExecutionPlan {
  validateRequest(request);
  validateDockerImage(options.image);
  const scratchRoot = assertRealDirectory(options.scratchRoot ?? DEFAULT_SHARED_SCRATCH_ROOT, 'scratchRoot');
  const networkMode = request.networkMode ?? 'none';
  if (networkMode !== 'none' && networkMode !== 'bridge') throw new ExecutionPolicyError('networkMode must be "none" or explicit "bridge"');
  const allowedSharedScratchRoots = (options.allowedSharedScratchRoots ?? [DEFAULT_SHARED_SCRATCH_ROOT])
    .map((path) => assertRealDirectory(path, 'allowedSharedScratchRoots'));
  if (!allowedSharedScratchRoots.some((allowedRoot) => isWithin(allowedRoot, scratchRoot))) {
    throw new ExecutionPolicyError('scratchRoot is not within an explicitly allowed shared scratch root');
  }
  const hostHome = options.hostHome === undefined ? canonicalExistingDirectory(homedir(), 'hostHome') : canonicalExistingDirectory(options.hostHome, 'hostHome');
  if (options.controlStoragePaths.length === 0) throw new ExecutionPolicyError('at least one controller controlStoragePath must be explicit');
  const controlStorage = options.controlStoragePaths.map((path) => canonicalExistingDirectory(path, 'controlStoragePath'));
  const workspace = assertContainedRealDirectory(scratchRoot, request.workspacePath, 'workspacePath');
  rejectSensitivePath(workspace, hostHome, controlStorage, 'workspacePath');

  const mounts: DockerMount[] = [{ source: workspace, target: '/workspace', readOnly: false, purpose: 'workspace' }];
  for (const [index, input] of (request.approvedInputs ?? []).entries()) {
    const source = assertContainedExistingPath(scratchRoot, input.path, `approvedInputs[${index}].path`);
    rejectSensitivePath(source, hostHome, controlStorage, `approvedInputs[${index}].path`);
    mounts.push({ source, target: `/inputs/${index}`, readOnly: true, purpose: 'approved_input' });
  }
  if (request.credentialProfile !== undefined) {
    const source = assertContainedRealDirectory(scratchRoot, request.credentialProfile.path, 'credentialProfile.path');
    rejectSensitivePath(source, hostHome, controlStorage, 'credentialProfile.path');
    mounts.push({ source, target: '/credentials/profile', readOnly: request.credentialProfile.writable !== true, purpose: 'credential_profile' });
  }
  assertNoMountSourceOverlap([
    ...mounts,
    ...controlStorage.map((source) => ({ source, purpose: 'control_storage' as const })),
  ]);
  const env = controlledEnvironment(request.environment, {}, request.credentialProfile, true);
  const dockerArgs = dockerArguments(request, options.image, mounts, env, networkMode);
  const plan: DockerExecutionPlan = {
    profile: 'isolated',
    trustDisclosure: dockerTrustDisclosure(networkMode, request.credentialProfile?.writable === true),
    image: options.image,
    networkMode,
    args: dockerArgs,
    cwd: '/workspace',
    env,
    mounts,
    limits: { ...request.limits },
  };
  validatedDockerPlans.set(plan, JSON.stringify(plan));
  return plan;
}

export async function launchNativeExecution(
  plan: NativeExecutionPlan,
  runner: NativeProcessRunner,
  identityProbe: NativeIdentityProbe,
  runNonce: string,
): Promise<NativeWorkerIdentity> {
  const launched = await runner.spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, detached: true, limits: plan.limits });
  const observed = await identityProbe.inspect(launched.pid);
  if (!isNativeObserved(observed) || !observed.running || observed.pid !== launched.pid) {
    throw new ExecutionPolicyError('native worker identity could not be observed after launch');
  }
  return { kind: 'native', pid: observed.pid, processStartedAt: observed.processStartedAt, processGroupId: observed.processGroupId, runNonce };
}

export async function launchDockerExecution(
  plan: DockerExecutionPlan,
  runner: ContainerRunner,
  identityProbe: ContainerIdentityProbe,
  runNonce: string,
): Promise<ContainerWorkerIdentity> {
  const launched = await runner.run(plan.args);
  const observed = await identityProbe.inspect(launched.containerId);
  if (!isContainerObserved(observed) || !observed.running || observed.containerId !== launched.containerId) {
    throw new ExecutionPolicyError('container worker identity could not be observed after launch');
  }
  return { kind: 'container', containerId: observed.containerId, containerStartedAt: observed.containerStartedAt, runNonce };
}

export async function cancelNativeExecution(
  identity: NativeWorkerIdentity,
  authority: CancellationAuthority,
  runner: NativeProcessRunner,
  identityProbe: NativeIdentityProbe,
  reason: string,
): Promise<CancellationResult> {
  await authority.revokeBeforeTermination(identity, reason);
  const beforeTermination = await identityProbe.inspect(identity.pid);
  const preflight = nativePreflight(identity, beforeTermination);
  if (preflight !== undefined) return preflight;
  try {
    await runner.terminateProcessGroup(identity.processGroupId);
    const observed = await identityProbe.inspect(identity.pid);
    if (isNativeAbsent(observed) || (isNativeObserved(observed) && !observed.running && sameNativeIdentity(identity, observed))) {
      const group = await identityProbe.inspectProcessGroup?.(identity.processGroupId);
      if (nativeGroupExited(group)) {
        return { authorityRevoked: true, outcome: 'confirmed_exited', identity, detail: 'process group termination confirmed by group identity probe' };
      }
      return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: 'worker leader exited but whole process-group exit was not confirmed' };
    }
    if (isNativeUnknown(observed) || !isNativeObserved(observed) || !sameNativeIdentity(identity, observed)) {
      return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: 'process identity was unavailable or changed after termination request' };
    }
  } catch (error) {
    return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: `process group termination error: ${errorMessage(error)}` };
  }
  return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: 'process remains observed after termination request' };
}

export async function cancelDockerExecution(
  identity: ContainerWorkerIdentity,
  authority: CancellationAuthority,
  runner: ContainerRunner,
  identityProbe: ContainerIdentityProbe,
  reason: string,
): Promise<CancellationResult> {
  await authority.revokeBeforeTermination(identity, reason);
  const beforeTermination = await identityProbe.inspect(identity.containerId);
  const preflight = containerPreflight(identity, beforeTermination);
  if (preflight !== undefined) return preflight;
  try {
    await runner.stop(identity.containerId);
    const observed = await identityProbe.inspect(identity.containerId);
    if (isContainerAbsent(observed) || observed === undefined || (isContainerObserved(observed) && !observed.running && sameContainerIdentity(identity, observed))) {
      return { authorityRevoked: true, outcome: 'confirmed_exited', identity, detail: 'container exit confirmed by identity probe' };
    }
    if (isContainerUnknown(observed) || !isContainerObserved(observed) || !sameContainerIdentity(identity, observed)) {
      return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: 'container identity was unavailable or changed after termination request' };
    }
  } catch (error) {
    return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: `container termination error: ${errorMessage(error)}` };
  }
  return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: 'container remains observed after termination request' };
}

function validateRequest(request: ExecutionRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(request.runId)) throw new ExecutionPolicyError('runId must be a bounded opaque identifier');
  if (request.command.trim() === '') throw new ExecutionPolicyError('command must be explicit');
  for (const [name, value] of Object.entries(request.limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new ExecutionPolicyError(`limits.${name} must be a positive integer`);
  }
  if (request.credentialProfile !== undefined) validateCredentialProfile(request.credentialProfile);
}

function validateCredentialProfile(profile: CredentialProfile): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile.profileId)) throw new ExecutionPolicyError('credentialProfile.profileId must be opaque and bounded');
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(profile.environmentVariable) || FORBIDDEN_ENVIRONMENT_KEY.test(profile.environmentVariable)) {
    throw new ExecutionPolicyError('credentialProfile.environmentVariable is not an allowed provider configuration variable');
  }
}

function validateDockerImage(image: string): void {
  if (image.length === 0 || image.length > 512 || image.startsWith('-') || !DOCKER_IMAGE_REFERENCE.test(image)) {
    throw new ExecutionPolicyError('Docker image must be a bounded digest-pinned reference or image ID and must not be parsed as an option');
  }
}

function controlledEnvironment(explicit: Readonly<Record<string, string>> | undefined, inherited: NodeJS.ProcessEnv, credentialProfile: CredentialProfile | undefined, isolated: boolean): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = inherited[key];
    if (value !== undefined) output[key] = value;
  }
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (!SAFE_ENVIRONMENT_KEY.has(key) || FORBIDDEN_ENVIRONMENT_KEY.test(key)) throw new ExecutionPolicyError(`environment key "${key}" is not allowlisted`);
    if (value.length > 4096) throw new ExecutionPolicyError(`environment value for "${key}" exceeds the bounded limit`);
    output[key] = value;
  }
  if (credentialProfile !== undefined) output[credentialProfile.environmentVariable] = isolated ? '/credentials/profile' : credentialProfile.path;
  return output;
}

function dockerArguments(request: ExecutionRequest, image: string, mounts: readonly DockerMount[], env: Readonly<Record<string, string>>, networkMode: 'none' | 'bridge'): string[] {
  const args = ['run', '--detach', '--rm', '--name', `faktori-${request.runId}`, '--network', networkMode, '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', String(request.limits.pids), '--memory', String(request.limits.memoryBytes), '--cpus', String(request.limits.cpuCount), '--ulimit', 'nofile=1024:1024', '--stop-timeout', String(Math.min(30, request.limits.maxRuntimeSeconds)), '--workdir', '/workspace', '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864'];
  // Docker's --mount syntax is read-write by default; unlike readonly, `rw`
  // is not a valid bare mount option.
  for (const mount of mounts) args.push('--mount', `type=bind,src=${mount.source},dst=${mount.target}${mount.readOnly ? ',readonly' : ''}`);
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
  args.push(image, request.command, ...request.args);
  return args;
}

function dockerTrustDisclosure(networkMode: 'none' | 'bridge', writableCredentialProfile: boolean): string {
  const disclosures = ['Container isolation permits only the explicitly mounted workspace and approved inputs.'];
  disclosures.push(networkMode === 'none' ? 'Network is disabled.' : 'Bridge networking is explicitly enabled for this admitted run.');
  disclosures.push(writableCredentialProfile
    ? 'The selected vendor credential profile is writable so the unmodified vendor CLI may refresh its own session.'
    : 'The selected vendor credential profile is read-only.');
  return disclosures.join(' ');
}

function assertNoMountSourceOverlap(mounts: ReadonlyArray<Pick<DockerMount, 'source' | 'purpose'> | { source: string; purpose: 'control_storage' }>): void {
  for (let leftIndex = 0; leftIndex < mounts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < mounts.length; rightIndex += 1) {
      const left = mounts[leftIndex];
      const right = mounts[rightIndex];
      if (isWithin(left.source, right.source) || isWithin(right.source, left.source)) {
        throw new ExecutionPolicyError(`mount sources for ${left.purpose} and ${right.purpose} overlap`);
      }
    }
  }
}

function nativePreflight(identity: NativeWorkerIdentity, observed: NativeIdentityObservation | undefined): CancellationResult | undefined {
  if (isNativeUnknown(observed)) return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: 'process identity probe is unavailable before termination request' };
  // `undefined` remains an absent result for compatibility with probes that
  // predate the explicit absent/unknown distinction.
  if (observed === undefined || isNativeAbsent(observed) || (isNativeObserved(observed) && !observed.running && sameNativeIdentity(identity, observed))) {
    return { authorityRevoked: true, outcome: 'confirmed_exited', identity, detail: 'process already absent before termination request' };
  }
  if (!isNativeObserved(observed) || !sameNativeIdentity(identity, observed)) {
    return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: 'process identity changed before termination request; no signal sent' };
  }
  return undefined;
}

function containerPreflight(identity: ContainerWorkerIdentity, observed: ContainerIdentityObservation | undefined): CancellationResult | undefined {
  if (isContainerUnknown(observed)) return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: 'container identity probe is unavailable before termination request' };
  if (observed === undefined || isContainerAbsent(observed) || (isContainerObserved(observed) && !observed.running && sameContainerIdentity(identity, observed))) {
    return { authorityRevoked: true, outcome: 'confirmed_exited', identity, detail: 'container already absent before termination request' };
  }
  if (!isContainerObserved(observed) || !sameContainerIdentity(identity, observed)) {
    return { authorityRevoked: true, outcome: 'interrupted_uncertain', identity, detail: 'container identity changed before termination request; no stop sent' };
  }
  return undefined;
}

function isNativeObserved(observed: NativeIdentityObservation | undefined): observed is Extract<NativeIdentityObservation, { pid: number }> {
  return observed !== undefined && 'pid' in observed;
}

function isNativeAbsent(observed: NativeIdentityObservation | undefined): boolean {
  return observed !== undefined && 'status' in observed && observed.status === 'absent';
}

function isNativeUnknown(observed: NativeIdentityObservation | undefined): boolean {
  return observed !== undefined && 'status' in observed && observed.status === 'unknown';
}

function nativeGroupExited(observed: NativeProcessGroupObservation | undefined): boolean {
  return observed !== undefined && (('status' in observed && observed.status === 'absent')
    || ('members' in observed && observed.members.every((member) => !member.running)));
}

function sameNativeIdentity(identity: NativeWorkerIdentity, observed: Extract<NativeIdentityObservation, { pid: number }>): boolean {
  return observed.pid === identity.pid && observed.processStartedAt === identity.processStartedAt && observed.processGroupId === identity.processGroupId;
}

function isContainerObserved(observed: ContainerIdentityObservation | undefined): observed is Extract<ContainerIdentityObservation, { containerId: string }> {
  return observed !== undefined && 'containerId' in observed;
}

function isContainerAbsent(observed: ContainerIdentityObservation | undefined): boolean {
  return observed !== undefined && 'status' in observed && observed.status === 'absent';
}

function isContainerUnknown(observed: ContainerIdentityObservation | undefined): boolean {
  return observed !== undefined && 'status' in observed && observed.status === 'unknown';
}

function sameContainerIdentity(identity: ContainerWorkerIdentity, observed: Extract<ContainerIdentityObservation, { containerId: string }>): boolean {
  return observed.containerId === identity.containerId && observed.containerStartedAt === identity.containerStartedAt;
}

function assertRealDirectory(path: string, label: string): string {
  return canonicalExistingDirectory(path, label);
}

function canonicalExistingDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new ExecutionPolicyError(`${label} must be absolute`);
  if (!existsSync(path)) throw new ExecutionPolicyError(`${label} must exist`);
  assertNoSymlinkComponents(path, path, label);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ExecutionPolicyError(`${label} must be a real directory, not a symlink`);
  return realpathSync(path);
}

function assertContainedRealDirectory(root: string, candidate: string, label: string): string {
  const target = assertContainedExistingPath(root, candidate, label);
  if (!lstatSync(target).isDirectory()) throw new ExecutionPolicyError(`${label} must be a directory`);
  return target;
}

function assertContainedExistingPath(root: string, candidate: string, label: string): string {
  if (!isAbsolute(candidate)) throw new ExecutionPolicyError(`${label} must be absolute`);
  const resolved = resolve(candidate);
  if (!existsSync(resolved)) throw new ExecutionPolicyError(`${label} must exist before launch`);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new ExecutionPolicyError(`${label} must not be a symlink`);
  const real = realpathSync(resolved);
  // macOS exposes /var through /private/var. Compare canonical paths so an
  // approved /var/folders staging directory is not mistaken for an escape.
  if (!isWithin(root, real)) throw new ExecutionPolicyError(`${label} contains a symlink escape or resolves outside the shared scratch root`);
  assertNoSymlinkComponents(root, real, label);
  return real;
}

function assertNoSymlinkComponents(root: string, target: string, label: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (!isWithin(normalizedRoot, normalizedTarget)) throw new ExecutionPolicyError(`${label} escapes containment root`);
  const inside = relative(normalizedRoot, normalizedTarget);
  let current = normalizedRoot;
  for (const component of inside === '' ? [] : inside.split(sep)) {
    current = resolve(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new ExecutionPolicyError(`${label} contains symlink component "${relative(normalizedRoot, current)}"`);
  }
}

function isWithin(root: string, target: string): boolean {
  const inside = relative(root, target);
  return inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside));
}

function rejectSensitivePath(path: string, hostHome: string, controlStoragePaths: readonly string[], label: string): void {
  if (isWithin(hostHome, path)) throw new ExecutionPolicyError(`${label} must not mount host home`);
  if (controlStoragePaths.some((controlPath) => isWithin(controlPath, path) || isWithin(path, controlPath))) {
    throw new ExecutionPolicyError(`${label} must not mount control storage`);
  }
  if (basename(path) === 'docker.sock' || path === '/var/run/docker.sock') throw new ExecutionPolicyError(`${label} must not mount Docker socket`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown termination error';
}
