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
import type { RunIntent, WorkerIdentity } from '../runtime/contracts.ts';

const execFileAsync = promisify(execFile);
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const REASONING = new Set(['low', 'medium', 'high']);
const CONFIG_KEYS = new Set(['format', 'loopId', 'workspace', 'artifactsDirectory', 'provider', 'limits', 'phases']);
const WORKSPACE_KEYS = new Set(['path', 'nativeAccessApproved']);
const PROVIDER_KEYS = new Set(['kind', 'model', 'reasoning', 'contextIsolation']);
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
type StageKind = 'manager_brief' | 'implement' | 'repair' | 'review' | 'manager_accept';

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
  reason?: string;
  updatedAt: string;
}

export interface ManagerLoopDependencies {
  adapterFactory?: () => ProviderTurnAdapter;
  runVerification?: (command: ManagerLoopVerificationCommand, cwd: string, timeoutMs: number, environment: Readonly<Record<string, string>>) => Promise<ManagerLoopVerificationReceipt>;
  now?: () => Date;
  createId?: () => string;
  environment?: Readonly<Record<string, string>>;
  nativeIdentityProbe?: NativeIdentityProbeContract;
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

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as RecordValue;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function digest(value: string): string {
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

function safeEnvironment(source: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const allowed = ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NO_COLOR'];
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

function rolePrompt(kind: StageKind, phase: ManagerLoopPhase, evidence: ManagerLoopWorkspaceEvidence, verification: ManagerLoopVerificationReceipt[], prior?: { stageId?: string; response?: RecordValue }): string {
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

function intentFor(config: ManagerLoopConfiguration, phase: ManagerLoopPhase, stage: { stageId: string; kind: StageKind; round: number }, context: ProviderCurrentContext, evidence: ManagerLoopWorkspaceEvidence, now: string): RunIntent {
  const branch = evidence.branch === 'HEAD' ? 'detached' : evidence.branch;
  return {
    format: 'faktori.run-intent/v1', runId: stage.stageId, admissionKey: `${config.loopId}:${stage.stageId}`,
    workItem: { id: phase.id, revision: digest(canonical(phase)), role: stage.kind === 'implement' || stage.kind === 'repair' ? 'builder' : stage.kind === 'review' ? 'reviewer' : 'manager' },
    target: { factoryId: `manager-loop-${config.loopId}`, productId: config.loopId, repository: `local:${basename(config.workspace.path)}`, branch, baseRevision: evidence.head, expectedRevision: evidence.head },
    context: { packetRevision: context.packetRevision, digest: context.digest },
    execution: { profile: 'native', workspaceId: digest(config.workspace.path), workspacePath: config.workspace.path, providerId: 'codex', model: config.provider.model, ...(config.provider.reasoning === undefined ? {} : { reasoning: config.provider.reasoning }), approvedInputDigests: [providerContextPayloadDigest(context)] },
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

function defaultAdapter(config: ManagerLoopConfiguration, environment: Readonly<Record<string, string>>, createId: () => string, suppliedProbe?: NativeIdentityProbeContract): ProviderTurnAdapter {
  const commands = new BoundedCommandRunner();
  return new CodexAdapter({
    runner: new NativeCodexProcessRunner({ commands, identityProbe: suppliedProbe ?? new NativeIdentityProbe({ commands, cwd: config.workspace.path, env: environment }), runNonce: createId() }),
    limits: { maxRuntimeMinutes: config.limits.maxRuntimeMinutes, maxTokens: config.limits.maxTokens, maxRetries: config.limits.maxRepairRounds },
    environment, compatibleModels: [config.provider.model], contextIsolation: 'bounded',
  });
}

function stageId(loopId: string, phaseId: string, kind: StageKind, round: number): string {
  return `${loopId}-${phaseId}-${kind}-${round}`;
}

function resultFrom(state: LoopState, reportPath?: string): ManagerLoopResult {
  return { format: 'faktori.manager-loop-result/v1', loopId: state.loopId, status: state.status === 'running' ? 'interrupted_uncertain' : state.status, completedPhases: [...state.completedPhases], ...(state.currentStage === undefined ? {} : { currentStage: state.currentStage }), ...(state.reason === undefined ? {} : { reason: state.reason }), ...(reportPath === undefined ? {} : { reportPath }) };
}

export async function runManagerLoop(input: unknown, dependencies: ManagerLoopDependencies = {}): Promise<ManagerLoopResult> {
  const config = parseManagerLoopConfiguration(input);
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const environment = dependencies.environment ?? safeEnvironment();
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
    if (prior.status !== 'running') return resultFrom(prior, prior.status === 'succeeded' ? reportPath : undefined);
  }
  const state: LoopState = prior ?? { format: 'faktori.manager-loop-state/v1', loopId: config.loopId, configDigest, status: 'running', completedPhases: [], stages: [], implementerSessions: {}, updatedAt: now().toISOString() };
  const save = async (): Promise<void> => { state.updatedAt = now().toISOString(); await atomicJson(statePath, state); };
  const fail = async (status: 'failed' | 'blocked' | 'interrupted_uncertain', reason: string): Promise<ManagerLoopResult> => {
    state.status = status; state.reason = reason; state.currentStage = undefined; await save(); return resultFrom(state);
  };
  const executeStage = async (phase: ManagerLoopPhase, kind: StageKind, round: number, verification: ManagerLoopVerificationReceipt[], previous?: { stageId?: string; response?: RecordValue }): Promise<ManagerLoopStageReceipt | ManagerLoopResult> => {
    const id = stageId(config.loopId, phase.id, kind, round);
    const before = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
    const prompt = rolePrompt(kind, phase, before, verification, previous);
    const context = contextFor(id, prompt, before);
    const intendedAt = now().toISOString();
    state.currentStage = { stageId: id, phaseId: phase.id, kind, round, intendedAt };
    await save();
    await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: intendedAt, kind: 'stage.intended', stage: state.currentStage });
    const adapter = dependencies.adapterFactory?.() ?? defaultAdapter(config, environment, createId, dependencies.nativeIdentityProbe);
    const intent = intentFor(config, phase, { stageId: id, kind, round }, context, before, intendedAt);
    const lifecycle = {
      onStarted: async (worker: WorkerIdentity): Promise<void> => { await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: now().toISOString(), kind: 'worker.started', stageId: id, worker }); },
      onTerminationRequired: async (_worker: WorkerIdentity, reason: string): Promise<void> => { await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: now().toISOString(), kind: 'worker.termination.intended', stageId: id, reason }); },
    };
    let providerResult: ProviderRunResult;
    if (kind === 'repair') {
      const stored = state.implementerSessions[phase.id];
      if (stored === undefined) return fail('blocked', `repair_session_unavailable:${phase.id}`);
      const binding: ProviderSessionBinding = { sessionId: stored.sessionId, sourceRunId: stored.sourceRunId, sourceContext: { packetRevision: stored.sourceContext.packetRevision, digest: stored.sourceContext.digest }, sourceScope: { factoryId: intent.target.factoryId, productId: intent.target.productId, repository: intent.target.repository, workspaceId: intent.execution.workspaceId, workspacePath: intent.execution.workspacePath, providerId: 'codex' } };
      providerResult = await adapter.resume(intent, binding, context, lifecycle);
    } else providerResult = await adapter.start(intent, context, lifecycle);
    let response: RecordValue;
    try { response = validatedStageResponse(kind, providerResult); } catch (error) {
      const reason = error instanceof Error ? error.message : 'provider_response_invalid';
      return fail(providerResult.final.outcome === 'interrupted_uncertain' ? 'interrupted_uncertain' : 'failed', `${id}:${reason}`);
    }
    const after = await captureManagerLoopWorkspaceEvidence(config.workspace.path);
    if ((kind === 'manager_brief' || kind === 'review' || kind === 'manager_accept') && after.contentDigest !== before.contentDigest) return fail('failed', `${id}:read_only_role_changed_workspace`);
    const receipt: ManagerLoopStageReceipt = { stageId: id, phaseId: phase.id, kind, round, outcome: providerResult.final.outcome, ...(providerResult.sessionId === undefined ? {} : { sessionId: providerResult.sessionId }), response, evidence: after, ...(verification.length === 0 ? {} : { verification }), completedAt: now().toISOString() };
    if (kind === 'implement' && providerResult.sessionId) state.implementerSessions[phase.id] = { sessionId: providerResult.sessionId, sourceRunId: id, sourceContext: context };
    state.stages.push(receipt); state.currentStage = undefined; await atomicJson(join(reportsDirectory, `${id}.json`), receipt); await appendEvent(eventsPath, { format: 'faktori.manager-loop-event/v1', eventId: createId(), loopId: config.loopId, occurredAt: receipt.completedAt, kind: 'stage.receipt', stageId: id, outcome: receipt.outcome, evidence: receipt.evidence }); await save();
    return receipt;
  };
    await save();
    for (const phase of config.phases) {
      if (state.completedPhases.includes(phase.id)) continue;
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
