import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, lstat, mkdir, open, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { BoundedCommandRunner, NativeCodexProcessRunner, NativeIdentityProbe } from '../execution/transports.ts';
import type { NativeIdentityProbe as NativeIdentityProbeContract } from '../execution/index.ts';
import { CodexAdapter } from '../providers/codex.ts';
import { providerContextPayloadDigest, type ProviderCurrentContext, type ProviderRunResult, type ProviderSessionBinding, type ProviderTurnAdapter } from '../providers/contracts.ts';
import type { Authority, FactoryRoleAssignment } from '../config/index.ts';
import type { RunIntent, UsageTelemetry, WorkerIdentity } from '../runtime/contracts.ts';

const execFileAsync = promisify(execFile);
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const REASONING = new Set(['low', 'medium', 'high']);
const CONFIG_KEYS = new Set(['format', 'loopId', 'workspace', 'artifactsDirectory', 'provider', 'limits', 'phases']);
const LEAN_CONFIG_KEYS = new Set(['format', 'loopId', 'profile', 'workspace', 'artifactsDirectory', 'approval', 'candidate', 'provider', 'roleRoutes', 'implementationBrief', 'repairApproval', 'requirements', 'acceptanceCriteria', 'verification', 'toolchain', 'review', 'limits']);
const WORKSPACE_KEYS = new Set(['path', 'nativeAccessApproved']);
const PROVIDER_KEYS = new Set(['kind', 'model', 'reasoning', 'contextIsolation']);
const LEAN_PROVIDER_KEYS = new Set([...PROVIDER_KEYS, 'executable', 'knownQuota']);
const LIMIT_KEYS = new Set(['maxRuntimeMinutes', 'maxTokens', 'maxRepairRounds']);
const PHASE_KEYS = new Set(['id', 'objective', 'acceptanceCriteria', 'verification']);
const COMMAND_KEYS = new Set(['command', 'args']);
const SUCCESS = new Set(['completed', 'unchanged_verified']);
const AUTHORITY: Authority = Object.freeze({
  requireIntentApproval: true,
  requireSpecificationApproval: true,
  requireIndependentReview: true,
  mergeAuthority: 'human',
  productionReleaseAuthority: 'human',
  allowPreviewDeployment: false,
  allowLocalDeployment: false,
  allowSeparateBilling: false,
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = Record<string, unknown>;
type StageKind = 'manager_brief' | 'implement' | 'repair' | 'review' | 'manager_accept' | 'deterministic_accept';

export interface ManagerLoopVerificationCommand { command: string; args: string[] }
export interface ManagerLoopPhase {
  id: string;
  objective: string;
  acceptanceCriteria: string[];
  verification: ManagerLoopVerificationCommand[];
}
export interface ManagerLoopConfiguration {
  format: 'faktori.manager-loop/v1';
  loopId: string;
  workspace: { path: string; nativeAccessApproved: true };
  artifactsDirectory: string;
  provider: { kind: 'codex'; model: string; reasoning?: 'low' | 'medium' | 'high'; contextIsolation: 'bounded' };
  limits: { maxRuntimeMinutes: number; maxTokens: number; maxRepairRounds: number };
  phases: ManagerLoopPhase[];
}

export interface LeanRoleRoute {
  id: string;
  model?: string;
  reasoning?: 'low' | 'medium' | 'high';
  suitability: 'routine' | 'bounded' | 'complex';
  availability: 'available' | 'unavailable' | 'unknown';
  justification?: string;
}

export interface LeanLoopConfiguration {
  format: 'faktori.lean-loop/v1';
  loopId: string;
  profile: 'implementation' | 'validation_only';
  workspace: { path: string; nativeAccessApproved: true };
  artifactsDirectory: string;
  approval: { approved: boolean; approvedBy: string; scopeRevision: string };
  candidate: {
    baseRevision: string;
    dependencies: Array<{ id: string; kind: 'git'; path: string; revision: string } | { id: string; kind: 'file'; path: string; digest: string }>;
    environmentInputs: Array<{ name: string; required: boolean }>;
    inputCompleteness: 'complete' | 'unknown';
  };
  provider: ManagerLoopConfiguration['provider'] & { executable: string; knownQuota: 'available' | 'exhausted' | 'unknown' };
  roleRoutes: { implementer: LeanRoleRoute[]; reviewer: LeanRoleRoute[] };
  implementationBrief?: { approved: true; objective: string; constraints: string[] };
  repairApproval?: { approved: true; approvedBy: string; scopeRevision: string };
  requirements: Array<{ id: string; text: string }>;
  acceptanceCriteria: Array<{ id: string; requirementIds: string[]; expectedOutcome: string }>;
  toolchain: Array<{ command: string; args: string[]; expectedOutput: string }>;
  review: { sensitive: boolean; requiredPasses: number };
  limits: ManagerLoopConfiguration['limits'];
  /** Normalized single work item consumed by the shared loop executor. */
  phases: [ManagerLoopPhase];
}

type ExecutableLoopConfiguration = ManagerLoopConfiguration | LeanLoopConfiguration;

export interface ManagerLoopWorkspaceEvidence {
  head: string;
  branch: string;
  dirty: boolean;
  contentDigest: string;
}

export interface ManagerLoopVerificationReceipt {
  command: string;
  args: string[];
  exitCode: number | null;
  passed: boolean;
  outputDigest: string;
  evidenceDigest?: string;
  summary?: string;
}

export interface ManagerLoopStageReceipt {
  stageId: string;
  phaseId: string;
  kind: StageKind;
  round: number;
  outcome: string;
  sessionId?: string;
  response?: RecordValue;
  /** Exact provider-reported terminal telemetry; unavailable remains unavailable. */
  usage: UsageTelemetry;
  evidence: ManagerLoopWorkspaceEvidence;
  verification?: ManagerLoopVerificationReceipt[];
  completedAt: string;
}

export interface ManagerLoopResult {
  format: 'faktori.manager-loop-result/v1';
  loopId: string;
  status: 'succeeded' | 'failed' | 'blocked' | 'interrupted_uncertain';
  completedPhases: string[];
  currentStage?: { stageId: string; phaseId: string; kind: StageKind; round: number };
  reason?: string;
  reportPath?: string;
}

interface LoopState {
  format: 'faktori.manager-loop-state/v1';
  loopId: string;
  configDigest: string;
  status: ManagerLoopResult['status'] | 'running';
  completedPhases: string[];
  stages: ManagerLoopStageReceipt[];
  currentStage?: { stageId: string; phaseId: string; kind: StageKind; round: number; intendedAt: string };
  implementerSessions: Record<string, { sessionId: string; sourceRunId: string; sourceContext: ProviderCurrentContext }>;
  lean?: {
    profile: LeanLoopConfiguration['profile'];
    preflight: LeanPreflightReceipt;
    routes: LeanRouteDecision[];
    acceptance?: LeanAcceptanceReceipt;
  };
  reason?: string;
  updatedAt: string;
}

export interface LeanAcceptanceReceipt {
  format: 'faktori.lean-acceptance-receipt/v1';
  accepted: true;
  actor: { kind: 'deterministic'; id: 'faktori.lean.accept/v1' };
  loopId: string;
  profile: LeanLoopConfiguration['profile'];
  stageId: string;
  evidence: {
    candidate: ManagerLoopWorkspaceEvidence;
    baseRevision: string;
    dependencies: LeanLoopConfiguration['candidate']['dependencies'];
    requirementsDigest: string;
    acceptanceCriteriaDigest: string;
    verificationDigest: string;
    preflightDigest: string;
    environmentInputs: LeanEnvironmentEvidence[];
    reviewStageIds: string[];
  };
  routes: LeanRouteDecision[];
  reusable: boolean;
  acceptedAt: string;
}

export interface ManagerLoopDependencies {
  adapterFactory?: (selection?: LeanRouteDecision) => ProviderTurnAdapter;
  runVerification?: (command: ManagerLoopVerificationCommand, cwd: string, timeoutMs: number, environment: Readonly<Record<string, string>>) => Promise<ManagerLoopVerificationReceipt>;
  now?: () => Date;
  createId?: () => string;
  environment?: Readonly<Record<string, string>>;
  nativeIdentityProbe?: NativeIdentityProbeContract;
}

export interface LeanRouteDecision {
  role: 'implementer' | 'reviewer';
  routeId: string;
  provider: 'codex';
  model: string;
  reasoning?: 'low' | 'medium' | 'high';
  suitability: LeanRoleRoute['suitability'];
  availability: LeanRoleRoute['availability'];
  order: number;
  escalation?: { fromRouteIds: string[]; reason: string };
  justification?: string;
}

interface LeanEnvironmentEvidence { name: string; required: boolean; present: boolean; valueDigest?: string }
interface LeanPreflightReceipt {
  format: 'faktori.lean-preflight-receipt/v1';
  passed: boolean;
  causeDigest: string;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  environmentInputs: LeanEnvironmentEvidence[];
  routes: LeanRouteDecision[];
  quota: 'available' | 'exhausted' | 'unknown';
  consecutiveFailures: number;
  launchSuppressed: boolean;
  observedAt: string;
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeys(value: RecordValue, allowed: Set<string>, path: string, issues: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is not supported`);
}

function text(value: unknown, path: string, issues: string[], max = 4_000): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\u0000')) {
    issues.push(`${path} must be a non-empty string of at most ${max} characters`);
    return '';
  }
  return value;
}

function integer(value: unknown, path: string, issues: string[], minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    issues.push(`${path} must be an integer from ${minimum} through ${maximum}`);
    return minimum;
  }
  return value;
}

export function parseManagerLoopConfiguration(input: unknown): ManagerLoopConfiguration {
  const issues: string[] = [];
  const root = record(input) ? input : (issues.push('configuration must be an object'), {});
  unknownKeys(root, CONFIG_KEYS, 'configuration', issues);
  if (root.format !== 'faktori.manager-loop/v1') issues.push('configuration.format must be "faktori.manager-loop/v1"');
  const loopId = text(root.loopId, 'configuration.loopId', issues, 64);
  if (loopId && !ID.test(loopId)) issues.push('configuration.loopId must be a lowercase slug');

  const workspace = record(root.workspace) ? root.workspace : (issues.push('configuration.workspace must be an object'), {});
  unknownKeys(workspace, WORKSPACE_KEYS, 'configuration.workspace', issues);
  const workspacePath = text(workspace.path, 'configuration.workspace.path', issues, 4_096);
  if (workspacePath && !isAbsolute(workspacePath)) issues.push('configuration.workspace.path must be absolute');
  if (workspace.nativeAccessApproved !== true) issues.push('configuration.workspace.nativeAccessApproved must be true');
  const artifactsDirectory = text(root.artifactsDirectory, 'configuration.artifactsDirectory', issues, 4_096);
  if (artifactsDirectory && !isAbsolute(artifactsDirectory)) issues.push('configuration.artifactsDirectory must be absolute');

  const provider = record(root.provider) ? root.provider : (issues.push('configuration.provider must be an object'), {});
  unknownKeys(provider, PROVIDER_KEYS, 'configuration.provider', issues);
  if (provider.kind !== 'codex') issues.push('configuration.provider.kind must be "codex" in this POC');
  const model = text(provider.model, 'configuration.provider.model', issues, 160);
  const reasoning = provider.reasoning;
  if (reasoning !== undefined && !REASONING.has(reasoning as string)) issues.push('configuration.provider.reasoning must be low, medium, or high');
  if (provider.contextIsolation !== 'bounded') issues.push('configuration.provider.contextIsolation must be "bounded" in this POC');

  const limits = record(root.limits) ? root.limits : (issues.push('configuration.limits must be an object'), {});
  unknownKeys(limits, LIMIT_KEYS, 'configuration.limits', issues);
  const maxRuntimeMinutes = integer(limits.maxRuntimeMinutes, 'configuration.limits.maxRuntimeMinutes', issues, 1, 240);
  const maxTokens = integer(limits.maxTokens, 'configuration.limits.maxTokens', issues, 0, 100_000_000);
  const maxRepairRounds = integer(limits.maxRepairRounds, 'configuration.limits.maxRepairRounds', issues, 0, 5);

  const rawPhases = Array.isArray(root.phases) ? root.phases : (issues.push('configuration.phases must be a non-empty array'), []);
  if (rawPhases.length < 1 || rawPhases.length > 20) issues.push('configuration.phases must contain 1 through 20 phases');
  const phaseIds = new Set<string>();
  const phases = rawPhases.map((item, index): ManagerLoopPhase => {
    const phase = record(item) ? item : (issues.push(`configuration.phases[${index}] must be an object`), {});
    unknownKeys(phase, PHASE_KEYS, `configuration.phases[${index}]`, issues);
    const id = text(phase.id, `configuration.phases[${index}].id`, issues, 64);
    if (id && !ID.test(id)) issues.push(`configuration.phases[${index}].id must be a lowercase slug`);
    if (phaseIds.has(id)) issues.push(`configuration.phases[${index}].id must be unique`);
    phaseIds.add(id);
    const objective = text(phase.objective, `configuration.phases[${index}].objective`, issues);
    const rawCriteria = Array.isArray(phase.acceptanceCriteria) ? phase.acceptanceCriteria : (issues.push(`configuration.phases[${index}].acceptanceCriteria must be a non-empty array`), []);
    if (rawCriteria.length < 1 || rawCriteria.length > 30) issues.push(`configuration.phases[${index}].acceptanceCriteria must contain 1 through 30 entries`);
    const acceptanceCriteria = rawCriteria.map((entry, criterion) => text(entry, `configuration.phases[${index}].acceptanceCriteria[${criterion}]`, issues, 1_000));
    const rawVerification = Array.isArray(phase.verification) ? phase.verification : (issues.push(`configuration.phases[${index}].verification must be a non-empty array`), []);
    if (rawVerification.length < 1 || rawVerification.length > 20) issues.push(`configuration.phases[${index}].verification must contain 1 through 20 commands`);
    const verification = rawVerification.map((entry, commandIndex): ManagerLoopVerificationCommand => {
      const command = record(entry) ? entry : (issues.push(`configuration.phases[${index}].verification[${commandIndex}] must be an object`), {});
      unknownKeys(command, COMMAND_KEYS, `configuration.phases[${index}].verification[${commandIndex}]`, issues);
      const executable = text(command.command, `configuration.phases[${index}].verification[${commandIndex}].command`, issues, 1_000);
      const rawArgs = Array.isArray(command.args) ? command.args : (issues.push(`configuration.phases[${index}].verification[${commandIndex}].args must be an array`), []);
      const args = rawArgs.map((argument, argumentIndex) => text(argument, `configuration.phases[${index}].verification[${commandIndex}].args[${argumentIndex}]`, issues, 4_000));
      return { command: executable, args };
    });
    return { id, objective, acceptanceCriteria, verification };
  });
  if (issues.length > 0) throw new Error(`Invalid manager loop configuration:\n- ${issues.join('\n- ')}`);
  return {
    format: 'faktori.manager-loop/v1', loopId,
    workspace: { path: resolve(workspacePath), nativeAccessApproved: true },
    artifactsDirectory: resolve(artifactsDirectory),
    provider: { kind: 'codex', model, ...(reasoning === undefined ? {} : { reasoning: reasoning as 'low' | 'medium' | 'high' }), contextIsolation: 'bounded' },
    limits: { maxRuntimeMinutes, maxTokens, maxRepairRounds }, phases,
  };
}

function boolean(value: unknown, path: string, issues: string[]): boolean {
  if (typeof value !== 'boolean') { issues.push(`${path} must be a boolean`); return false; }
  return value;
}

function stringList(value: unknown, path: string, issues: string[], maximum = 100): string[] {
  if (!Array.isArray(value) || value.length > maximum) { issues.push(`${path} must be an array with at most ${maximum} entries`); return []; }
  return value.map((entry, index) => text(entry, `${path}[${index}]`, issues, 4_000));
}

function exactRevision(value: unknown, path: string, issues: string[]): string {
  const revision = text(value, path, issues, 128);
  if (revision && !/^[a-f0-9]{40,64}$/.test(revision)) issues.push(`${path} must be an exact 40-64 character hexadecimal revision`);
  return revision;
}

function parseApproval(value: unknown, path: string, issues: string[], optional = false): { approved: boolean; approvedBy: string; scopeRevision: string } | undefined {
  if (value === undefined && optional) return undefined;
  const input = record(value) ? value : (issues.push(`${path} must be an object`), {});
  unknownKeys(input, new Set(['approved', 'approvedBy', 'scopeRevision']), path, issues);
  const approved = boolean(input.approved, `${path}.approved`, issues);
  const approvedBy = text(input.approvedBy, `${path}.approvedBy`, issues, 128);
  const scopeRevision = text(input.scopeRevision, `${path}.scopeRevision`, issues, 256);
  if (optional && approved !== true) issues.push(`${path}.approved must be true when repair authority is configured`);
  return { approved, approvedBy, scopeRevision };
}

function parseLeanRoutes(value: unknown, role: 'implementer' | 'reviewer', issues: string[]): LeanRoleRoute[] {
  const path = `configuration.roleRoutes.${role}`;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) { issues.push(`${path} must contain 1 through 10 owner-cost-ordered routes`); return []; }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const input = record(entry) ? entry : (issues.push(`${itemPath} must be an object`), {});
    unknownKeys(input, new Set(['id', 'model', 'reasoning', 'suitability', 'availability', 'justification']), itemPath, issues);
    const id = text(input.id, `${itemPath}.id`, issues, 64);
    if (id && !ID.test(id)) issues.push(`${itemPath}.id must be a lowercase slug`);
    if (ids.has(id)) issues.push(`${itemPath}.id must be unique within the role`);
    ids.add(id);
    const model = input.model === undefined ? undefined : text(input.model, `${itemPath}.model`, issues, 160);
    const reasoning = input.reasoning;
    if (reasoning !== undefined && !REASONING.has(reasoning as string)) issues.push(`${itemPath}.reasoning must be low, medium, or high`);
    const suitability = input.suitability;
    if (suitability !== 'routine' && suitability !== 'bounded' && suitability !== 'complex') issues.push(`${itemPath}.suitability must be routine, bounded, or complex`);
    const availability = input.availability ?? 'unknown';
    if (availability !== 'available' && availability !== 'unavailable' && availability !== 'unknown') issues.push(`${itemPath}.availability must be available, unavailable, or unknown`);
    const justification = input.justification === undefined ? undefined : text(input.justification, `${itemPath}.justification`, issues, 1_000);
    const selectedModel = model ?? '';
    if (/sol/i.test(selectedModel) && justification === undefined) issues.push(`${itemPath}.justification is required for a Sol route`);
    return { id, ...(model === undefined ? {} : { model }), ...(reasoning === undefined ? {} : { reasoning: reasoning as 'low' | 'medium' | 'high' }), suitability: suitability as LeanRoleRoute['suitability'], availability: availability as LeanRoleRoute['availability'], ...(justification === undefined ? {} : { justification }) };
  });
}

/** Parse the explicit opt-in lean profile without changing legacy Manager Loop parsing. */
export function parseLeanLoopConfiguration(input: unknown): LeanLoopConfiguration {
  const issues: string[] = [];
  const root = record(input) ? input : (issues.push('configuration must be an object'), {});
  unknownKeys(root, LEAN_CONFIG_KEYS, 'configuration', issues);
  if (root.format !== 'faktori.lean-loop/v1') issues.push('configuration.format must be "faktori.lean-loop/v1"');
  const loopId = text(root.loopId, 'configuration.loopId', issues, 64);
  if (loopId && !ID.test(loopId)) issues.push('configuration.loopId must be a lowercase slug');
  const profile = root.profile;
  if (profile !== 'implementation' && profile !== 'validation_only') issues.push('configuration.profile must be implementation or validation_only');

  const workspace = record(root.workspace) ? root.workspace : (issues.push('configuration.workspace must be an object'), {});
  unknownKeys(workspace, WORKSPACE_KEYS, 'configuration.workspace', issues);
  const workspacePath = text(workspace.path, 'configuration.workspace.path', issues, 4_096);
  if (workspacePath && !isAbsolute(workspacePath)) issues.push('configuration.workspace.path must be absolute');
  if (workspace.nativeAccessApproved !== true) issues.push('configuration.workspace.nativeAccessApproved must be true');
  const artifactsDirectory = text(root.artifactsDirectory, 'configuration.artifactsDirectory', issues, 4_096);
  if (artifactsDirectory && !isAbsolute(artifactsDirectory)) issues.push('configuration.artifactsDirectory must be absolute');

  const approval = parseApproval(root.approval, 'configuration.approval', issues)!;
  const repairApproval = parseApproval(root.repairApproval, 'configuration.repairApproval', issues, true);
  const candidate = record(root.candidate) ? root.candidate : (issues.push('configuration.candidate must be an object'), {});
  unknownKeys(candidate, new Set(['baseRevision', 'dependencies', 'environmentInputs', 'inputCompleteness']), 'configuration.candidate', issues);
  const baseRevision = exactRevision(candidate.baseRevision, 'configuration.candidate.baseRevision', issues);
  const rawDependencies = Array.isArray(candidate.dependencies) ? candidate.dependencies : (issues.push('configuration.candidate.dependencies must be an array'), []);
  const dependencyIds = new Set<string>();
  const dependencies = rawDependencies.map((entry, index) => {
    const path = `configuration.candidate.dependencies[${index}]`;
    const item = record(entry) ? entry : (issues.push(`${path} must be an object`), {});
    const kind = item.kind ?? (item.digest === undefined ? 'git' : 'file');
    unknownKeys(item, kind === 'file' ? new Set(['id', 'kind', 'path', 'digest']) : new Set(['id', 'kind', 'path', 'revision']), path, issues);
    if (kind !== 'git' && kind !== 'file') issues.push(`${path}.kind must be git or file`);
    const id = text(item.id, `${path}.id`, issues, 64);
    if (id && !ID.test(id)) issues.push(`${path}.id must be a lowercase slug`);
    if (dependencyIds.has(id)) issues.push(`${path}.id must be unique`);
    dependencyIds.add(id);
    const dependencyPath = text(item.path, `${path}.path`, issues, 4_096);
    if (dependencyPath && !isAbsolute(dependencyPath)) issues.push(`${path}.path must be absolute`);
    if (kind === 'file') {
      const fileDigest = text(item.digest, `${path}.digest`, issues, 71);
      if (fileDigest && !/^sha256:[a-f0-9]{64}$/.test(fileDigest)) issues.push(`${path}.digest must be a sha256 digest`);
      return { id, kind: 'file' as const, path: resolve(dependencyPath), digest: fileDigest };
    }
    return { id, kind: 'git' as const, path: resolve(dependencyPath), revision: exactRevision(item.revision, `${path}.revision`, issues) };
  });
  const rawEnvironment = Array.isArray(candidate.environmentInputs) ? candidate.environmentInputs : (issues.push('configuration.candidate.environmentInputs must be an array'), []);
  const environmentNames = new Set<string>();
  const environmentInputs = rawEnvironment.map((entry, index) => {
    const path = `configuration.candidate.environmentInputs[${index}]`;
    const item = record(entry) ? entry : (issues.push(`${path} must be an object`), {});
    unknownKeys(item, new Set(['name', 'required']), path, issues);
    const name = text(item.name, `${path}.name`, issues, 128);
    if (name && !/^[A-Z_][A-Z0-9_]*$/.test(name)) issues.push(`${path}.name must be an uppercase environment variable name`);
    if (environmentNames.has(name)) issues.push(`${path}.name must be unique`);
    environmentNames.add(name);
    return { name, required: boolean(item.required, `${path}.required`, issues) };
  });
  const inputCompleteness = candidate.inputCompleteness;
  if (inputCompleteness !== 'complete' && inputCompleteness !== 'unknown') issues.push('configuration.candidate.inputCompleteness must be complete or unknown');

  const provider = record(root.provider) ? root.provider : (issues.push('configuration.provider must be an object'), {});
  unknownKeys(provider, LEAN_PROVIDER_KEYS, 'configuration.provider', issues);
  if (provider.kind !== 'codex') issues.push('configuration.provider.kind must remain codex for this iteration');
  const model = text(provider.model, 'configuration.provider.model', issues, 160);
  const reasoning = provider.reasoning;
  if (reasoning !== undefined && !REASONING.has(reasoning as string)) issues.push('configuration.provider.reasoning must be low, medium, or high');
  if (provider.contextIsolation !== 'bounded') issues.push('configuration.provider.contextIsolation must be bounded');
  const executable = text(provider.executable, 'configuration.provider.executable', issues, 1_000);
  const knownQuota = provider.knownQuota;
  if (knownQuota !== 'available' && knownQuota !== 'exhausted' && knownQuota !== 'unknown') issues.push('configuration.provider.knownQuota must be available, exhausted, or unknown');

  const roleRoutes = record(root.roleRoutes) ? root.roleRoutes : {};
  unknownKeys(roleRoutes, new Set(['implementer', 'reviewer']), 'configuration.roleRoutes', issues);
  const implementerRoutes = parseLeanRoutes(roleRoutes.implementer, 'implementer', issues);
  const reviewerRoutes = parseLeanRoutes(roleRoutes.reviewer, 'reviewer', issues);
  if (profile === 'implementation' && implementerRoutes.length === 0) implementerRoutes.push({ id: 'provider-default', suitability: 'bounded', availability: 'unknown' });
  if (reviewerRoutes.length === 0) reviewerRoutes.push({ id: 'provider-default', suitability: 'bounded', availability: 'unknown' });

  let implementationBrief: LeanLoopConfiguration['implementationBrief'];
  if (root.implementationBrief !== undefined) {
    const brief = record(root.implementationBrief) ? root.implementationBrief : (issues.push('configuration.implementationBrief must be an object'), {});
    unknownKeys(brief, new Set(['approved', 'objective', 'constraints']), 'configuration.implementationBrief', issues);
    if (brief.approved !== true) issues.push('configuration.implementationBrief.approved must be true');
    implementationBrief = { approved: true, objective: text(brief.objective, 'configuration.implementationBrief.objective', issues), constraints: stringList(brief.constraints, 'configuration.implementationBrief.constraints', issues) };
  }
  if (profile === 'implementation' && implementationBrief === undefined) issues.push('configuration.implementationBrief is required for implementation');
  if (profile === 'validation_only' && implementationBrief !== undefined) issues.push('configuration.implementationBrief is not allowed for validation_only');

  const rawRequirements = Array.isArray(root.requirements) ? root.requirements : (issues.push('configuration.requirements must be a non-empty array'), []);
  if (rawRequirements.length < 1 || rawRequirements.length > 100) issues.push('configuration.requirements must contain 1 through 100 entries');
  const requirementIds = new Set<string>();
  const requirements = rawRequirements.map((entry, index) => {
    const path = `configuration.requirements[${index}]`;
    const item = record(entry) ? entry : (issues.push(`${path} must be an object`), {});
    unknownKeys(item, new Set(['id', 'text']), path, issues);
    const id = text(item.id, `${path}.id`, issues, 64);
    if (id && !ID.test(id)) issues.push(`${path}.id must be a lowercase slug`);
    if (requirementIds.has(id)) issues.push(`${path}.id must be unique`);
    requirementIds.add(id);
    return { id, text: text(item.text, `${path}.text`, issues) };
  });
  const rawCriteria = Array.isArray(root.acceptanceCriteria) ? root.acceptanceCriteria : (issues.push('configuration.acceptanceCriteria must be a non-empty array'), []);
  if (rawCriteria.length < 1 || rawCriteria.length > 100) issues.push('configuration.acceptanceCriteria must contain 1 through 100 entries');
  const criteriaIds = new Set<string>();
  const acceptanceCriteria = rawCriteria.map((entry, index) => {
    const path = `configuration.acceptanceCriteria[${index}]`;
    const item = record(entry) ? entry : (issues.push(`${path} must be an object`), {});
    unknownKeys(item, new Set(['id', 'requirementIds', 'expectedOutcome']), path, issues);
    const id = text(item.id, `${path}.id`, issues, 64);
    if (id && !ID.test(id)) issues.push(`${path}.id must be a lowercase slug`);
    if (criteriaIds.has(id)) issues.push(`${path}.id must be unique`);
    criteriaIds.add(id);
    const links = stringList(item.requirementIds, `${path}.requirementIds`, issues, 100);
    if (links.length === 0) issues.push(`${path}.requirementIds must name at least one requirement`);
    for (const requirementId of links) if (!requirementIds.has(requirementId)) issues.push(`${path}.requirementIds references unknown requirement ${requirementId}`);
    return { id, requirementIds: links, expectedOutcome: text(item.expectedOutcome, `${path}.expectedOutcome`, issues) };
  });
  const verificationPhase = { id: 'work', objective: implementationBrief?.objective ?? requirements.map((item) => item.text).join('\n'), acceptanceCriteria: acceptanceCriteria.map((item) => item.expectedOutcome), verification: [] as ManagerLoopVerificationCommand[] };
  const rawVerification = Array.isArray(root.verification) ? root.verification : (issues.push('configuration.verification must be a non-empty array'), []);
  if (rawVerification.length < 1 || rawVerification.length > 20) issues.push('configuration.verification must contain 1 through 20 commands');
  verificationPhase.verification = rawVerification.map((entry, index) => {
    const path = `configuration.verification[${index}]`;
    const item = record(entry) ? entry : (issues.push(`${path} must be an object`), {});
    unknownKeys(item, COMMAND_KEYS, path, issues);
    return { command: text(item.command, `${path}.command`, issues, 1_000), args: stringList(item.args, `${path}.args`, issues) };
  });
  const rawToolchain = Array.isArray(root.toolchain) ? root.toolchain : (issues.push('configuration.toolchain must be an array'), []);
  const toolchain = rawToolchain.map((entry, index) => {
    const path = `configuration.toolchain[${index}]`;
    const item = record(entry) ? entry : (issues.push(`${path} must be an object`), {});
    unknownKeys(item, new Set(['command', 'args', 'expectedOutput']), path, issues);
    return { command: text(item.command, `${path}.command`, issues, 1_000), args: stringList(item.args, `${path}.args`, issues), expectedOutput: text(item.expectedOutput, `${path}.expectedOutput`, issues, 1_000) };
  });
  const review = record(root.review) ? root.review : (issues.push('configuration.review must be an object'), {});
  unknownKeys(review, new Set(['sensitive', 'requiredPasses']), 'configuration.review', issues);
  const sensitive = boolean(review.sensitive, 'configuration.review.sensitive', issues);
  const requiredPasses = integer(review.requiredPasses, 'configuration.review.requiredPasses', issues, 1, 2);
  if (sensitive && requiredPasses < 2) issues.push('configuration.review.requiredPasses must be 2 for sensitive work');

  const limits = record(root.limits) ? root.limits : (issues.push('configuration.limits must be an object'), {});
  unknownKeys(limits, LIMIT_KEYS, 'configuration.limits', issues);
  const parsedLimits = { maxRuntimeMinutes: integer(limits.maxRuntimeMinutes, 'configuration.limits.maxRuntimeMinutes', issues, 1, 240), maxTokens: integer(limits.maxTokens, 'configuration.limits.maxTokens', issues, 0, 100_000_000), maxRepairRounds: integer(limits.maxRepairRounds, 'configuration.limits.maxRepairRounds', issues, 0, 5) };
  if (issues.length > 0) throw new Error(`Invalid lean loop configuration:\n- ${issues.join('\n- ')}`);
  return {
    format: 'faktori.lean-loop/v1', loopId, profile: profile as LeanLoopConfiguration['profile'],
    workspace: { path: resolve(workspacePath), nativeAccessApproved: true }, artifactsDirectory: resolve(artifactsDirectory), approval,
    candidate: { baseRevision, dependencies, environmentInputs, inputCompleteness: inputCompleteness as LeanLoopConfiguration['candidate']['inputCompleteness'] },
    provider: { kind: 'codex', model, ...(reasoning === undefined ? {} : { reasoning: reasoning as 'low' | 'medium' | 'high' }), contextIsolation: 'bounded', executable, knownQuota: knownQuota as LeanLoopConfiguration['provider']['knownQuota'] },
    roleRoutes: { implementer: implementerRoutes, reviewer: reviewerRoutes }, ...(implementationBrief === undefined ? {} : { implementationBrief }), ...(repairApproval === undefined ? {} : { repairApproval: repairApproval as LeanLoopConfiguration['repairApproval'] }),
    requirements, acceptanceCriteria, toolchain, review: { sensitive, requiredPasses }, limits: parsedLimits, phases: [verificationPhase],
  };
}

function parseExecutableLoopConfiguration(input: unknown): ExecutableLoopConfiguration {
  return record(input) && input.format === 'faktori.lean-loop/v1' ? parseLeanLoopConfiguration(input) : parseManagerLoopConfiguration(input);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as RecordValue;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function appendEvent(path: string, event: RecordValue): Promise<void> {
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.writeFile(`${canonical(event)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeEnvironment(source: NodeJS.ProcessEnv = process.env, declared: readonly string[] = []): Readonly<Record<string, string>> {
  const allowed = [...new Set(['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NO_COLOR', ...declared])];
  return Object.freeze(Object.fromEntries(allowed.flatMap((key) => typeof source[key] === 'string' && source[key]!.length > 0 ? [[key, source[key] as string]] : [])));
}

async function git(workspace: string, args: string[]): Promise<Buffer> {
  const result = await execFileAsync('git', ['-C', workspace, ...args], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
  return result.stdout;
}

export async function captureManagerLoopWorkspaceEvidence(workspace: string): Promise<ManagerLoopWorkspaceEvidence> {
  await access(workspace, constants.R_OK | constants.W_OK);
  const head = (await git(workspace, ['rev-parse', 'HEAD'])).toString('utf8').trim();
  const branch = (await git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toString('utf8').trim();
  const status = await git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const ordinary = (await git(workspace, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).toString('utf8').split('\u0000').filter(Boolean);
  const ignored = (await git(workspace, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).toString('utf8').split('\u0000').filter(Boolean);
  const files = [...new Set([...ordinary, ...ignored])].sort();
  if (files.length > 20_000) throw new Error('workspace evidence exceeds the 20000-file POC bound');
  const hash = createHash('sha256').update(head).update('\u0000').update(branch).update('\u0000').update(status).update('\u0000');
  let totalBytes = 0;
  for (const path of files) {
    const absolute = resolve(workspace, path);
    const within = relative(resolve(workspace), absolute);
    if (within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within)) throw new Error('workspace contains an unsafe untracked path');
    let info;
    try { info = await lstat(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update('\u0000').update(path).update('\u0000deleted'); continue; }
      throw error;
    }
    totalBytes += info.size;
    if (totalBytes > 512 * 1024 * 1024) throw new Error('workspace evidence exceeds the 512 MiB POC bound');
    hash.update('\u0000').update(path).update('\u0000').update(String(info.mode & 0o777)).update('\u0000');
    if (info.isFile()) hash.update(await readFile(absolute));
    else if (info.isSymbolicLink()) hash.update(`symlink:${await readlink(absolute)}`);
    else hash.update(`non-file:${info.mode}`);
  }
  return { head, branch, dirty: status.length > 0, contentDigest: `sha256:${hash.digest('hex')}` };
}

async function executableAvailable(command: string, environment: Readonly<Record<string, string>>): Promise<boolean> {
  const candidates = isAbsolute(command) ? [command] : (environment.PATH ?? '').split(':').filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return true; } catch {}
  }
  return false;
}

function selectLeanRoute(config: LeanLoopConfiguration, role: 'implementer' | 'reviewer'): LeanRouteDecision | undefined {
  const candidates = config.roleRoutes[role];
  const skipped: string[] = [];
  for (let order = 0; order < candidates.length; order += 1) {
    const candidate = candidates[order]!;
    if (candidate.availability === 'unavailable') { skipped.push(candidate.id); continue; }
    return {
      role, routeId: candidate.id, provider: 'codex', model: candidate.model ?? config.provider.model,
      ...(candidate.reasoning ?? config.provider.reasoning) === undefined ? {} : { reasoning: candidate.reasoning ?? config.provider.reasoning },
      suitability: candidate.suitability, availability: candidate.availability, order,
      ...(skipped.length === 0 ? {} : { escalation: { fromRouteIds: skipped, reason: 'owner_declared_route_unavailable' } }),
      ...(candidate.justification === undefined ? {} : { justification: candidate.justification }),
    };
  }
  return undefined;
}

async function leanPreflight(config: LeanLoopConfiguration, environment: Readonly<Record<string, string>>, now: () => Date): Promise<LeanPreflightReceipt> {
  const checks: LeanPreflightReceipt['checks'] = [];
  const check = (id: string, passed: boolean, detail: string): void => { checks.push({ id, passed, detail }); };
  check('approval.scope', config.approval.approved, config.approval.approved ? `approved:${config.approval.scopeRevision}` : 'approval_denied');
  check('workspace.native_access', config.workspace.nativeAccessApproved, config.workspace.nativeAccessApproved ? 'approved' : 'denied');
  try {
    const info = await lstat(config.workspace.path);
    const owned = info.isDirectory() && (typeof process.getuid !== 'function' || info.uid === process.getuid());
    check('workspace.owner', owned, owned ? 'owner_controlled_directory' : 'workspace_owner_mismatch');
    await access(config.workspace.path, constants.R_OK | constants.W_OK | constants.X_OK);
    check('workspace.access', true, 'read_write_execute');
  } catch { check('workspace.access', false, 'workspace_unavailable'); }
  check('environment.path', typeof environment.PATH === 'string' && environment.PATH.length > 0, environment.PATH ? 'declared' : 'missing');
  check('provider.executable', await executableAvailable(config.provider.executable, environment), config.provider.executable);
  check('provider.quota', config.provider.knownQuota !== 'exhausted', config.provider.knownQuota);

  const environmentInputs = config.candidate.environmentInputs.map((input): LeanEnvironmentEvidence => {
    const value = environment[input.name];
    return { ...input, present: value !== undefined, ...(value === undefined ? {} : { valueDigest: `sha256:${digest(value)}` }) };
  });
  for (const input of environmentInputs) check(`environment.${input.name}`, !input.required || input.present, input.present ? input.valueDigest! : input.required ? 'required_missing' : 'optional_missing');

  let head = '';
  try { head = (await git(config.workspace.path, ['rev-parse', 'HEAD'])).toString('utf8').trim(); }
  catch { check('candidate.head', false, 'git_head_unavailable'); }
  if (head) {
    try {
      await git(config.workspace.path, ['merge-base', '--is-ancestor', config.candidate.baseRevision, head]);
      check('candidate.base_revision', true, config.candidate.baseRevision);
    } catch { check('candidate.base_revision', false, 'base_not_ancestor_of_candidate'); }
  }
  for (const dependency of config.candidate.dependencies) {
    if (dependency.kind === 'file') {
      try {
        const info = await lstat(dependency.path);
        const observed = info.isFile() && !info.isSymbolicLink() ? `sha256:${digest(await readFile(dependency.path))}` : '';
        check(`dependency.${dependency.id}`, observed === dependency.digest, observed === dependency.digest ? observed : 'file_digest_mismatch');
      } catch { check(`dependency.${dependency.id}`, false, 'dependency_file_unavailable'); }
    } else {
      try {
        const observed = (await git(dependency.path, ['rev-parse', 'HEAD'])).toString('utf8').trim();
        const dirty = (await git(dependency.path, ['status', '--porcelain=v1', '--untracked-files=all'])).length > 0;
        check(`dependency.${dependency.id}`, observed === dependency.revision && !dirty, observed !== dependency.revision ? 'revision_mismatch' : dirty ? 'dependency_worktree_dirty' : observed);
      } catch { check(`dependency.${dependency.id}`, false, 'dependency_revision_unavailable'); }
    }
  }
  const commands = new BoundedCommandRunner();
  for (const probe of config.toolchain) {
    const result = await commands.run({ command: probe.command, args: probe.args, cwd: config.workspace.path, env: environment, timeoutMs: Math.min(config.limits.maxRuntimeMinutes * 60_000, 30_000), stdoutMaxBytes: 64 * 1024, stderrMaxBytes: 64 * 1024 });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    check(`toolchain.${probe.command}`, result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded && output.includes(probe.expectedOutput), result.exitCode === 0 ? `expected:${probe.expectedOutput}` : `exit:${result.exitCode ?? 'none'}`);
  }
  const roles: Array<'implementer' | 'reviewer'> = config.profile === 'implementation' || config.repairApproval !== undefined ? ['implementer', 'reviewer'] : ['reviewer'];
  const routes = roles.flatMap((role) => {
    const selection = selectLeanRoute(config, role);
    check(`route.${role}`, selection !== undefined, selection ? `${selection.routeId}:${selection.model}:${selection.reasoning ?? 'provider-default'}` : 'no_available_owner_configured_route');
    return selection ? [selection] : [];
  });
  const failed = checks.filter((item) => !item.passed).map(({ id, detail }) => ({ id, detail }));
  return { format: 'faktori.lean-preflight-receipt/v1', passed: failed.length === 0, causeDigest: `sha256:${digest(canonical(failed))}`, checks, environmentInputs, routes, quota: config.provider.knownQuota, consecutiveFailures: 0, launchSuppressed: false, observedAt: now().toISOString() };
}

function sanitizeString(value: string): string {
  return value
    .replace(/(?:bearer|token|api[_-]?key|authorization)\s*[=:]?\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\/(?:Users|home)\/[^\s,;]+/g, '[path]')
    .slice(0, 8_000);
}

function sanitize(value: unknown): Json {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(sanitize);
  if (record(value)) return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, sanitize(item)]));
  return String(value);
}

function strictResponse(result: ProviderRunResult): RecordValue {
  if (!SUCCESS.has(result.final.outcome)) throw new Error(`provider_${result.final.outcome}`);
  const summary = result.final.summary?.trim();
  if (!summary) throw new Error('provider_response_missing');
  let value: unknown;
  try { value = JSON.parse(summary); } catch { throw new Error('provider_response_not_strict_json'); }
  if (!record(value)) throw new Error('provider_response_must_be_object');
  return sanitize(value) as RecordValue;
}

function validatedStageResponse(kind: StageKind, result: ProviderRunResult): RecordValue {
  const value = strictResponse(result);
  const expected = kind === 'manager_brief' ? new Set(['status', 'brief'])
    : kind === 'implement' || kind === 'repair' ? new Set(['status', 'summary'])
      : kind === 'review' ? new Set(['verdict', 'summary', 'findings', 'evidenceDigest'])
        : new Set(['accepted', 'summary', 'evidenceDigest', 'reviewStageId']);
  if (Object.keys(value).some((key) => !expected.has(key)) || Object.keys(value).some((key) => value[key] === undefined)) throw new Error('provider_response_schema_invalid');
  if (kind === 'manager_brief') {
    if ((value.status !== 'ready' && value.status !== 'blocked') || typeof value.brief !== 'string' || value.brief.trim().length === 0) throw new Error('provider_response_schema_invalid');
  } else if (kind === 'implement' || kind === 'repair') {
    if ((value.status !== 'implemented' && value.status !== 'blocked') || typeof value.summary !== 'string' || value.summary.trim().length === 0) throw new Error('provider_response_schema_invalid');
  } else if (kind === 'review') {
    if ((value.verdict !== 'pass' && value.verdict !== 'repair') || typeof value.summary !== 'string' || !Array.isArray(value.findings) || value.findings.some((item) => typeof item !== 'string') || typeof value.evidenceDigest !== 'string') throw new Error('provider_response_schema_invalid');
    if ((value.verdict === 'repair' && value.findings.length === 0) || (value.verdict === 'pass' && value.findings.length !== 0)) throw new Error('provider_response_schema_invalid');
  } else if (typeof value.accepted !== 'boolean' || typeof value.summary !== 'string' || typeof value.evidenceDigest !== 'string' || typeof value.reviewStageId !== 'string') throw new Error('provider_response_schema_invalid');
  return value;
}

function responseText(value: unknown, key: string): string | undefined {
  return record(value) && typeof value[key] === 'string' && (value[key] as string).trim().length > 0 ? value[key] as string : undefined;
}

function rolePrompt(config: ExecutableLoopConfiguration, kind: StageKind, phase: ManagerLoopPhase, evidence: ManagerLoopWorkspaceEvidence, verification: ManagerLoopVerificationReceipt[], prior?: { stageId?: string; response?: RecordValue }): string {
  if (config.format === 'faktori.lean-loop/v1') {
    const reviewerVerification = verification.map(({ outputDigest: _outputDigest, evidenceDigest: _evidenceDigest, ...receipt }) => receipt);
    const packet = {
      format: 'faktori.lean-agent-packet/v1', objective: phase.objective,
      constraints: config.implementationBrief?.constraints ?? ['Do not change the validation-only candidate.'],
      requirements: config.requirements, acceptanceCriteria: config.acceptanceCriteria,
      changedFacts: kind === 'repair' ? prior?.response ?? {} : {},
      evidence: { canonicalCandidateDigest: evidence.contentDigest, candidate: { head: evidence.head, branch: evidence.branch, dirty: evidence.dirty }, verification: reviewerVerification },
      nextAction: kind === 'review' ? 'Independently inspect the exact candidate and return a fixed-head verdict.' : kind === 'repair' ? 'Repair only the stated findings within approved scope.' : 'Implement the approved brief within approved scope.',
    };
    if (kind === 'implement' || kind === 'repair') return `Act as the implementation owner for this bounded Faktori lean loop. Do not commit, merge, push, deploy, publish, change authority, or work outside the approved workspace. Compact packet: ${JSON.stringify(packet)} Return only strict JSON: {"status":"implemented"|"blocked","summary":"..."}.`;
    if (kind === 'review') return `CANONICAL_CANDIDATE_EVIDENCE_DIGEST=${evidence.contentDigest}\nThis exact literal is Faktori's canonical candidate digest. Copy it unchanged into the response field named evidenceDigest. Never recompute a digest and never substitute a context digest, verifier output digest, file hash, Git hash, or any other digest. Act as an independent read-only reviewer for this bounded Faktori lean loop. Do not edit, commit, merge, push, deploy, publish, or change authority. Compact packet: ${JSON.stringify(packet)} Return only strict JSON with exactly these fields: {"verdict":"pass"|"repair","summary":"...","findings":[],"evidenceDigest":"${evidence.contentDigest}"}. The findings array is defects-only. When verdict is pass, findings MUST be the literal empty array []; put all positive observations in summary. When verdict is repair, findings MUST contain one or more actionable defects. A pass requires direct inspection and all configured verification receipts to pass against this exact candidate.`;
    throw new Error('lean_loop_does_not_launch_manager_roles');
  }
  const common = `You are participating in a bounded Faktori Manager Loop phase. Do not commit, merge, push, deploy, change authority, or work outside the approved workspace. Phase: ${phase.id}. Objective: ${phase.objective}\nAcceptance criteria:\n${phase.acceptanceCriteria.map((item) => `- ${item}`).join('\n')}\nCurrent workspace evidence: ${JSON.stringify(evidence)}.`;
  if (kind === 'manager_brief') return `${common}\nAccepted prior phase summaries: ${JSON.stringify(prior?.response ?? {})}. Act as build manager. During this planning turn, do not edit files; the next implementer turn is explicitly authorized to edit files inside the approved workspace. Missing functionality requested by this phase is expected and is not a blocker. Report blocked only when the accepted objective is contradictory, unsafe, or impossible with the supplied scope. Return only strict JSON: {"status":"ready"|"blocked","brief":"..."}.`;
  if (kind === 'implement') return `${common}\nAccepted manager brief: ${JSON.stringify(prior?.response ?? {})}. Act as the phase implementer. Make the smallest workspace changes that satisfy the accepted phase. Do not assume or require subagent fanout; if the runtime makes specialized native subagents available, use them only for independently useful bounded work. Return only strict JSON: {"status":"implemented"|"blocked","summary":"..."}.`;
  if (kind === 'repair') return `${common}\nContinue as the same implementer session. Repair only these configured verification or independent review findings: ${JSON.stringify(prior?.response ?? {})}. Return only strict JSON: {"status":"implemented"|"blocked","summary":"..."}.`;
  if (kind === 'review') return `${common}\nConfigured verification receipts: ${JSON.stringify(verification)}. Act as an independent reviewer. Inspect actual workspace evidence. During this review turn, do not edit files; a later repair implementer turn is authorized to address findings inside the approved workspace. Return only strict JSON: {"verdict":"pass"|"repair","summary":"...","findings":["..."],"evidenceDigest":"${evidence.contentDigest}"}. A pass requires the configured verification receipts and direct workspace evidence.`;
  return `${common}\nIndependent review receipt: ${JSON.stringify(prior?.response ?? {})}. Configured verification receipts: ${JSON.stringify(verification)}. Act as build manager. During this acceptance turn, do not edit files; this restriction applies only to this manager turn. Accept only if the review passed against this exact evidence. Return only strict JSON: {"accepted":true|false,"summary":"...","evidenceDigest":"${evidence.contentDigest}","reviewStageId":"${prior?.stageId ?? ''}"}.`;
}

function contextFor(stageId: string, prompt: string, evidence: ManagerLoopWorkspaceEvidence): ProviderCurrentContext {
  return { packetRevision: `${stageId}@1`, digest: digest(canonical({ stageId, evidence })), prompt };
}

function intentFor(config: ExecutableLoopConfiguration, phase: ManagerLoopPhase, stage: { stageId: string; kind: StageKind; round: number }, context: ProviderCurrentContext, evidence: ManagerLoopWorkspaceEvidence, now: string, route?: LeanRouteDecision): RunIntent {
  const branch = evidence.branch === 'HEAD' ? 'detached' : evidence.branch;
  return {
    format: 'faktori.run-intent/v1', runId: stage.stageId, admissionKey: `${config.loopId}:${stage.stageId}`,
    workItem: { id: phase.id, revision: digest(canonical(phase)), role: stage.kind === 'implement' || stage.kind === 'repair' ? 'builder' : stage.kind === 'review' ? 'reviewer' : 'manager' },
    target: { factoryId: `manager-loop-${config.loopId}`, productId: config.loopId, repository: `local:${basename(config.workspace.path)}`, branch, baseRevision: evidence.head, expectedRevision: evidence.head },
    context: { packetRevision: context.packetRevision, digest: context.digest },
    execution: { profile: 'native', workspaceId: digest(config.workspace.path), workspacePath: config.workspace.path, providerId: 'codex', model: route?.model ?? config.provider.model, ...((route?.reasoning ?? config.provider.reasoning) === undefined ? {} : { reasoning: route?.reasoning ?? config.provider.reasoning }), approvedInputDigests: [providerContextPayloadDigest(context)] },
    budget: { reservationId: `${stage.stageId}-reservation`, maxRuntimeMinutes: config.limits.maxRuntimeMinutes, estimatedTokens: config.limits.maxTokens, status: 'held' },
    authority: { authorityRevision: 'manager-loop-human-publication/v1', epoch: 1, scopeDigest: digest(canonical(AUTHORITY)), policy: AUTHORITY }, attempt: stage.round + 1, createdAt: now,
  };
}

async function defaultVerification(command: ManagerLoopVerificationCommand, cwd: string, timeoutMs: number, environment: Readonly<Record<string, string>>): Promise<ManagerLoopVerificationReceipt> {
  const result = await new BoundedCommandRunner().run({ command: command.command, args: command.args, cwd, env: environment, timeoutMs, stdoutMaxBytes: 1024 * 1024, stderrMaxBytes: 1024 * 1024 });
  const outputDigest = digest(`${result.stdout}\u0000${result.stderr}`);
  const detail = sanitizeString(`${result.stderr}\n${result.stdout}`.trim()).slice(0, 1_000);
  return { command: command.command, args: [...command.args], exitCode: result.exitCode, passed: result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded && result.spawnError === undefined, outputDigest: `sha256:${outputDigest}`, ...(detail.length === 0 ? {} : { summary: detail }) };
}

function defaultAdapter(config: ExecutableLoopConfiguration, environment: Readonly<Record<string, string>>, createId: () => string, suppliedProbe?: NativeIdentityProbeContract, route?: LeanRouteDecision): ProviderTurnAdapter {
  const commands = new BoundedCommandRunner();
  return new CodexAdapter({
    runner: new NativeCodexProcessRunner({ commands, identityProbe: suppliedProbe ?? new NativeIdentityProbe({ commands, cwd: config.workspace.path, env: environment }), runNonce: createId() }),
    limits: { maxRuntimeMinutes: config.limits.maxRuntimeMinutes, maxTokens: config.limits.maxTokens, maxRetries: config.limits.maxRepairRounds },
    environment, compatibleModels: [route?.model ?? config.provider.model], contextIsolation: 'bounded',
  });
}

function stageId(loopId: string, phaseId: string, kind: StageKind, round: number): string {
  return `${loopId}-${phaseId}-${kind}-${round}`;
}

function resultFrom(state: LoopState, reportPath?: string): ManagerLoopResult {
  return { format: 'faktori.manager-loop-result/v1', loopId: state.loopId, status: state.status === 'running' ? 'interrupted_uncertain' : state.status, completedPhases: [...state.completedPhases], ...(state.currentStage === undefined ? {} : { currentStage: state.currentStage }), ...(state.reason === undefined ? {} : { reason: state.reason }), ...(reportPath === undefined ? {} : { reportPath }) };
}

export async function runManagerLoop(input: unknown, dependencies: ManagerLoopDependencies = {}): Promise<ManagerLoopResult> {
  const config = parseExecutableLoopConfiguration(input);
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const environment = dependencies.environment ?? safeEnvironment(process.env, config.format === 'faktori.lean-loop/v1' ? config.candidate.environmentInputs.map((item) => item.name) : []);
  if (!environment.PATH) throw new Error('manager loop requires an allowlisted PATH');
  await mkdir(config.artifactsDirectory, { recursive: true, mode: 0o700 });
  const statePath = join(config.artifactsDirectory, 'state.json');
  const eventsPath = join(config.artifactsDirectory, 'events.jsonl');
  const reportsDirectory = join(config.artifactsDirectory, 'stages');
  const reportPath = join(config.artifactsDirectory, 'report.json');
  const lockPath = join(config.artifactsDirectory, 'run.lock');
  await mkdir(reportsDirectory, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      let observed: Partial<LoopState> | undefined;
      try { observed = JSON.parse(await readFile(statePath, 'utf8')) as Partial<LoopState>; } catch {}
      return { format: 'faktori.manager-loop-result/v1', loopId: config.loopId, status: 'blocked', completedPhases: Array.isArray(observed?.completedPhases) ? observed.completedPhases : [], reason: 'manager_loop_already_running' };
    }
    throw error;
  }
  try {
  const configDigest = digest(canonical(config));
  let prior: LoopState | undefined;
  try { prior = JSON.parse(await readFile(statePath, 'utf8')) as LoopState; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (prior !== undefined) {
    if (prior.configDigest !== configDigest || prior.loopId !== config.loopId) throw new Error('manager loop state conflicts with this configuration');
    if (prior.currentStage !== undefined || prior.status === 'interrupted_uncertain') {
      prior.status = 'interrupted_uncertain';
      prior.reason = prior.reason ?? 'stage_receipt_missing_manual_reconciliation_required';
      prior.updatedAt = now().toISOString();
      await atomicJson(statePath, prior);
      return resultFrom(prior);
    }
    if (config.format === 'faktori.lean-loop/v1' && prior.status === 'succeeded') {
      if (config.candidate.inputCompleteness === 'unknown' || prior.lean?.acceptance?.reusable !== true) {
        return { format: 'faktori.manager-loop-result/v1', loopId: config.loopId, status: 'blocked', completedPhases: [...prior.completedPhases], reason: 'fresh_revalidation_required_new_artifacts_directory' };
      }
      const current = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
      const accepted = prior.lean.acceptance.evidence.candidate;
      const currentPreflight = await leanPreflight(config, environment, now);
      if (!currentPreflight.passed || canonical(current) !== canonical(accepted) || canonical(currentPreflight.environmentInputs) !== canonical(prior.lean.acceptance.evidence.environmentInputs)) {
        return { format: 'faktori.manager-loop-result/v1', loopId: config.loopId, status: 'blocked', completedPhases: [...prior.completedPhases], reason: 'accepted_evidence_changed_fresh_validation_required' };
      }
    }
    const retryableLeanPreflight = config.format === 'faktori.lean-loop/v1' && prior.status === 'blocked' && prior.reason?.startsWith('lean_preflight_failed:') === true;
    if (prior.status !== 'running' && !retryableLeanPreflight) return resultFrom(prior, prior.status === 'succeeded' ? reportPath : undefined);
  }
  let initialLean: LoopState['lean'];
  if (config.format === 'faktori.lean-loop/v1' && (prior === undefined || (prior.status === 'blocked' && prior.reason?.startsWith('lean_preflight_failed:') === true))) {
    const preflight = await leanPreflight(config, environment, now);
    const previous = prior?.lean?.preflight;
    preflight.consecutiveFailures = preflight.passed ? 0 : previous?.passed === false && previous.causeDigest === preflight.causeDigest ? previous.consecutiveFailures + 1 : 1;
    preflight.launchSuppressed = preflight.consecutiveFailures >= 2;
    await atomicJson(join(config.artifactsDirectory, 'preflight.json'), preflight);
    initialLean = { profile: config.profile, preflight, routes: preflight.routes };
    if (!preflight.passed) {
      const blocked: LoopState = { format: 'faktori.manager-loop-state/v1', loopId: config.loopId, configDigest, status: 'blocked', completedPhases: [], stages: [], implementerSessions: {}, lean: initialLean, reason: `lean_preflight_failed:${preflight.causeDigest}`, updatedAt: now().toISOString() };
      await atomicJson(statePath, blocked);
      return resultFrom(blocked);
    }
    if (prior !== undefined) {
      prior.status = 'running'; prior.reason = undefined; prior.lean = initialLean; prior.updatedAt = now().toISOString();
      await atomicJson(statePath, prior);
    }
  }
  const state: LoopState = prior ?? { format: 'faktori.manager-loop-state/v1', loopId: config.loopId, configDigest, status: 'running', completedPhases: [], stages: [], implementerSessions: {}, ...(initialLean === undefined ? {} : { lean: initialLean }), updatedAt: now().toISOString() };
  const save = async (): Promise<void> => { state.updatedAt = now().toISOString(); await atomicJson(statePath, state); };
  const fail = async (status: 'failed' | 'blocked' | 'interrupted_uncertain', reason: string): Promise<ManagerLoopResult> => {
    state.status = status; state.reason = reason; state.currentStage = undefined; await save(); return resultFrom(state);
  };
  const executeStage = async (phase: ManagerLoopPhase, kind: StageKind, round: number, verification: ManagerLoopVerificationReceipt[], previous?: { stageId?: string; response?: RecordValue }): Promise<ManagerLoopStageReceipt | ManagerLoopResult> => {
    const id = stageId(config.loopId, phase.id, kind, round);
    const before = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
    const prompt = rolePrompt(config, kind, phase, before, verification, previous);
    const context = contextFor(id, prompt, before);
    const intendedAt = now().toISOString();
    state.currentStage = { stageId: id, phaseId: phase.id, kind, round, intendedAt };
    await save();
    await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: intendedAt, kind: 'stage.intended', stage: state.currentStage });
    const leanRole = kind === 'implement' || kind === 'repair' ? 'implementer' : kind === 'review' ? 'reviewer' : undefined;
    const route = config.format === 'faktori.lean-loop/v1' && leanRole !== undefined ? state.lean?.routes.find((item) => item.role === leanRole) : undefined;
    const adapter = dependencies.adapterFactory?.(route) ?? defaultAdapter(config, environment, createId, dependencies.nativeIdentityProbe, route);
    const intent = intentFor(config, phase, { stageId: id, kind, round }, context, before, intendedAt, route);
    const lifecycle = {
      onStarted: async (worker: WorkerIdentity): Promise<void> => { await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: now().toISOString(), kind: 'worker.started', stageId: id, worker }); },
      onTerminationRequired: async (_worker: WorkerIdentity, reason: string): Promise<void> => { await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: now().toISOString(), kind: 'worker.termination.intended', stageId: id, reason }); },
    };
    let providerResult: ProviderRunResult;
    if (kind === 'repair') {
      const stored = state.implementerSessions[phase.id];
      if (stored === undefined) {
        if (config.format !== 'faktori.lean-loop/v1' || config.profile !== 'validation_only' || config.repairApproval?.approved !== true) return fail('blocked', `repair_session_unavailable:${phase.id}`);
        providerResult = await adapter.start(intent, context, lifecycle);
      } else {
        const binding: ProviderSessionBinding = { sessionId: stored.sessionId, sourceRunId: stored.sourceRunId, sourceContext: { packetRevision: stored.sourceContext.packetRevision, digest: stored.sourceContext.digest }, sourceScope: { factoryId: intent.target.factoryId, productId: intent.target.productId, repository: intent.target.repository, workspaceId: intent.execution.workspaceId, workspacePath: intent.execution.workspacePath, providerId: 'codex' } };
        providerResult = await adapter.resume(intent, binding, context, lifecycle);
      }
    } else providerResult = await adapter.start(intent, context, lifecycle);
    const after = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
    const receipt = (response?: RecordValue): ManagerLoopStageReceipt => ({
      stageId: id, phaseId: phase.id, kind, round, outcome: providerResult.final.outcome,
      ...(providerResult.sessionId === undefined ? {} : { sessionId: providerResult.sessionId }),
      ...(response === undefined ? {} : { response }), usage: providerResult.final.usage,
      evidence: after, ...(verification.length === 0 ? {} : { verification }), completedAt: now().toISOString(),
    });
    const persist = async (value: ManagerLoopStageReceipt): Promise<void> => {
      state.stages.push(value); state.currentStage = undefined;
      await atomicJson(join(reportsDirectory, `${id}.json`), value);
      await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: value.completedAt, kind: 'stage.receipt', stageId: id, outcome: value.outcome, evidence: value.evidence });
      await save();
    };
    let response: RecordValue;
    try { response = validatedStageResponse(kind, providerResult); } catch (error) {
      const reason = error instanceof Error ? error.message : 'provider_response_invalid';
      await persist(receipt());
      return fail(providerResult.final.outcome === 'interrupted_uncertain' ? 'interrupted_uncertain' : 'failed', `${id}:${reason}`);
    }
    if ((kind === 'manager_brief' || kind === 'review' || kind === 'manager_accept') && after.contentDigest !== before.contentDigest) {
      await persist(receipt(response));
      return fail('failed', `${id}:read_only_role_changed_workspace`);
    }
    const completed = receipt(response);
    if ((kind === 'implement' || kind === 'repair') && providerResult.sessionId) state.implementerSessions[phase.id] = { sessionId: providerResult.sessionId, sourceRunId: id, sourceContext: context };
    await persist(completed);
    return completed;
  };
    await save();
    for (const phase of config.phases) {
      if (state.completedPhases.includes(phase.id)) continue;
      if (config.format === 'faktori.lean-loop/v1') {
        let implementation: ManagerLoopStageReceipt | undefined;
        if (config.profile === 'implementation') {
          const launched = await executeStage(phase, 'implement', 0, [], { response: { brief: config.implementationBrief } });
          if ('status' in launched) return launched;
          implementation = launched;
          if (responseText(implementation.response, 'status') !== 'implemented') return fail('blocked', `${phase.id}:implementer_blocked`);
        }
        let repairRound = 0;
        let passingReviews: ManagerLoopStageReceipt[] = [];
        let receipts: ManagerLoopVerificationReceipt[] = [];
        while (repairRound <= config.limits.maxRepairRounds) {
          const verificationEvidence = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
          receipts = [];
          for (const command of phase.verification) {
            const observed = await (dependencies.runVerification ?? defaultVerification)(command, config.workspace.path, config.limits.maxRuntimeMinutes * 60_000, environment);
            receipts.push({ ...observed, evidenceDigest: verificationEvidence.contentDigest });
          }
          const afterVerification = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
          if (afterVerification.contentDigest !== verificationEvidence.contentDigest) return fail('failed', `${phase.id}:verification_changed_candidate`);
          await atomicJson(join(reportsDirectory, `${config.loopId}-${phase.id}-verification-${repairRound}.json`), { phaseId: phase.id, round: repairRound, evidence: verificationEvidence, receipts });
          await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: now().toISOString(), kind: 'verification.receipt', phaseId: phase.id, round: repairRound, evidence: verificationEvidence, receipts });
          if (receipts.some((receipt) => !receipt.passed)) {
            if (config.profile === 'validation_only' && config.repairApproval?.approved !== true) return fail('blocked', `${phase.id}:validation_repair_not_approved`);
            if (repairRound >= config.limits.maxRepairRounds) return fail('failed', `${phase.id}:configured_verification_failed`);
            const findings = receipts.filter((receipt) => !receipt.passed).map((receipt) => `${receipt.command} exited ${receipt.exitCode ?? 'without a code'}${receipt.summary ? `: ${receipt.summary}` : ''}`);
            const repair = await executeStage(phase, 'repair', repairRound + 1, receipts, { response: { verdict: 'repair', summary: 'Configured verification failed.', findings } });
            if ('status' in repair) return repair;
            if (responseText(repair.response, 'status') !== 'implemented') return fail('blocked', `${phase.id}:repair_blocked`);
            repairRound += 1;
            passingReviews = [];
            continue;
          }
          passingReviews = [];
          let findingReview: ManagerLoopStageReceipt | undefined;
          for (let pass = 0; pass < config.review.requiredPasses; pass += 1) {
            const expected = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
            const review = await executeStage(phase, 'review', repairRound * 10 + pass, receipts, pass === 0 ? implementation : passingReviews.at(-1));
            if ('status' in review) return review;
            if (responseText(review.response, 'evidenceDigest') !== expected.contentDigest || review.evidence.contentDigest !== expected.contentDigest) return fail('failed', `${phase.id}:review_evidence_mismatch`);
            if (responseText(review.response, 'verdict') === 'repair') { findingReview = review; break; }
            if (responseText(review.response, 'verdict') !== 'pass') return fail('failed', `${phase.id}:invalid_review_verdict`);
            passingReviews.push(review);
          }
          if (findingReview === undefined) break;
          if (config.profile === 'validation_only' && config.repairApproval?.approved !== true) return fail('blocked', `${phase.id}:validation_repair_not_approved`);
          if (repairRound >= config.limits.maxRepairRounds) return fail('failed', `${phase.id}:repair_limit_exceeded`);
          const repair = await executeStage(phase, 'repair', repairRound + 1, receipts, findingReview);
          if ('status' in repair) return repair;
          if (responseText(repair.response, 'status') !== 'implemented') return fail('blocked', `${phase.id}:repair_blocked`);
          repairRound += 1;
        }
        if (passingReviews.length !== config.review.requiredPasses) return fail('failed', `${phase.id}:review_not_passed`);
        const candidate = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
        if (passingReviews.some((review) => review.evidence.contentDigest !== candidate.contentDigest) || receipts.some((receipt) => receipt.evidenceDigest !== candidate.contentDigest || !receipt.passed)) return fail('failed', `${phase.id}:deterministic_acceptance_evidence_mismatch`);
        const finalPreflight = await leanPreflight(config, environment, now);
        const preflightEvidence = (value: LeanPreflightReceipt): unknown => ({ checks: value.checks, environmentInputs: value.environmentInputs, routes: value.routes, quota: value.quota });
        if (!finalPreflight.passed || canonical(preflightEvidence(finalPreflight)) !== canonical(preflightEvidence(state.lean!.preflight))) return fail('failed', `${phase.id}:deterministic_acceptance_preflight_changed`);
        const acceptanceStageId = stageId(config.loopId, phase.id, 'deterministic_accept', 0);
        const acceptedAt = now().toISOString();
        const acceptance: LeanAcceptanceReceipt = {
          format: 'faktori.lean-acceptance-receipt/v1', accepted: true, actor: { kind: 'deterministic', id: 'faktori.lean.accept/v1' },
          loopId: config.loopId, profile: config.profile, stageId: acceptanceStageId,
          evidence: {
            candidate, baseRevision: config.candidate.baseRevision, dependencies: config.candidate.dependencies,
            requirementsDigest: `sha256:${digest(canonical(config.requirements))}`,
            acceptanceCriteriaDigest: `sha256:${digest(canonical(config.acceptanceCriteria))}`,
            verificationDigest: `sha256:${digest(canonical(receipts))}`,
            preflightDigest: `sha256:${digest(canonical(preflightEvidence(finalPreflight)))}`,
            environmentInputs: state.lean!.preflight.environmentInputs,
            reviewStageIds: passingReviews.map((review) => review.stageId),
          },
          routes: state.lean!.routes, reusable: config.candidate.inputCompleteness === 'complete', acceptedAt,
        };
        const acceptanceStage: ManagerLoopStageReceipt = {
          stageId: acceptanceStageId, phaseId: phase.id, kind: 'deterministic_accept', round: 0, outcome: 'completed',
          response: { accepted: true, actor: acceptance.actor, evidenceDigest: candidate.contentDigest, reviewStageId: passingReviews.at(-1)!.stageId, reviewStageIds: acceptance.evidence.reviewStageIds, receipt: acceptance },
          usage: { availability: 'unavailable', unavailableReason: 'deterministic_stage_has_no_provider_usage' }, evidence: candidate, verification: receipts, completedAt: acceptedAt,
        };
        state.stages.push(acceptanceStage);
        state.lean!.acceptance = acceptance;
        await atomicJson(join(reportsDirectory, `${acceptanceStageId}.json`), acceptanceStage);
        await atomicJson(join(config.artifactsDirectory, 'acceptance.json'), acceptance);
        await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: acceptedAt, kind: 'stage.receipt', stageId: acceptanceStageId, outcome: 'completed', evidence: candidate, actor: acceptance.actor });
        state.completedPhases.push(phase.id);
        await save();
        continue;
      }
      const priorPhaseSummaries = Object.fromEntries(state.completedPhases.map((phaseId) => {
        const acceptance = [...state.stages].reverse().find((stage) => stage.phaseId === phaseId && stage.kind === 'manager_accept');
        return [phaseId, { summary: responseText(acceptance?.response, 'summary'), evidenceDigest: acceptance?.evidence.contentDigest }];
      }));
      const brief = await executeStage(phase, 'manager_brief', 0, [], { response: { acceptedPhases: priorPhaseSummaries } });
      if ('status' in brief) return brief;
      if (responseText(brief.response, 'status') !== 'ready') return fail('blocked', `${phase.id}:manager_brief_blocked`);
      const implementation = await executeStage(phase, 'implement', 0, [], brief);
      if ('status' in implementation) return implementation;
      if (responseText(implementation.response, 'status') !== 'implemented') return fail('blocked', `${phase.id}:implementer_blocked`);
      let lastReview: ManagerLoopStageReceipt | undefined;
      let receipts: ManagerLoopVerificationReceipt[] = [];
      for (let round = 0; round <= config.limits.maxRepairRounds; round += 1) {
        receipts = [];
        for (const command of phase.verification) receipts.push(await (dependencies.runVerification ?? defaultVerification)(command, config.workspace.path, config.limits.maxRuntimeMinutes * 60_000, environment));
        await atomicJson(join(reportsDirectory, `${config.loopId}-${phase.id}-verification-${round}.json`), { phaseId: phase.id, round, receipts });
        await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: now().toISOString(), kind: 'verification.receipt', phaseId: phase.id, round, receipts });
        if (receipts.some((receipt) => !receipt.passed)) {
          if (round >= config.limits.maxRepairRounds) return fail('failed', `${phase.id}:configured_verification_failed`);
          const findings = receipts.filter((receipt) => !receipt.passed).map((receipt) => `${receipt.command} exited ${receipt.exitCode ?? 'without a code'}${receipt.summary ? `: ${receipt.summary}` : ''}`);
          const repair = await executeStage(phase, 'repair', round + 1, receipts, { response: { verdict: 'repair', summary: 'Configured verification failed.', findings } });
          if ('status' in repair) return repair;
          if (responseText(repair.response, 'status') !== 'implemented') return fail('blocked', `${phase.id}:repair_blocked`);
          continue;
        }
        const evidence = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
        const review = await executeStage(phase, 'review', round, receipts, round === 0 ? implementation : lastReview);
        if ('status' in review) return review;
        if (responseText(review.response, 'evidenceDigest') !== evidence.contentDigest || review.evidence.contentDigest !== evidence.contentDigest) return fail('failed', `${phase.id}:review_evidence_mismatch`);
        lastReview = review;
        if (responseText(review.response, 'verdict') === 'pass') break;
        if (responseText(review.response, 'verdict') !== 'repair') return fail('failed', `${phase.id}:invalid_review_verdict`);
        if (round >= config.limits.maxRepairRounds) return fail('failed', `${phase.id}:repair_limit_exceeded`);
        const repair = await executeStage(phase, 'repair', round + 1, receipts, review);
        if ('status' in repair) return repair;
        if (responseText(repair.response, 'status') !== 'implemented') return fail('blocked', `${phase.id}:repair_blocked`);
      }
      if (lastReview === undefined || responseText(lastReview.response, 'verdict') !== 'pass') return fail('failed', `${phase.id}:review_not_passed`);
      const acceptanceEvidence = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
      const accepted = await executeStage(phase, 'manager_accept', 0, receipts, lastReview);
      if ('status' in accepted) return accepted;
      if (accepted.response?.accepted !== true || responseText(accepted.response, 'evidenceDigest') !== acceptanceEvidence.contentDigest || responseText(accepted.response, 'reviewStageId') !== lastReview.stageId || accepted.evidence.contentDigest !== acceptanceEvidence.contentDigest) return fail('failed', `${phase.id}:manager_acceptance_invalid`);
      state.completedPhases.push(phase.id); await save();
    }
    state.status = 'succeeded'; state.reason = undefined; await save();
    const result = resultFrom(state, reportPath); await atomicJson(reportPath, { ...result, stages: state.stages }); return result;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

/** Explicit lean entrypoint; legacy callers continue through runManagerLoop unchanged. */
export async function runLeanLoop(input: unknown, dependencies: ManagerLoopDependencies = {}): Promise<ManagerLoopResult> {
  if (!record(input) || input.format !== 'faktori.lean-loop/v1') throw new Error('lean loop requires faktori.lean-loop/v1 configuration');
  return runManagerLoop(input, dependencies);
}
