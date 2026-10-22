import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AuthorizedAction } from '../actions/index.ts';
import { DeploymentMaintenanceExecutor, type DeploymentCommand, type EnvironmentReceipt } from '../integrations/deployment.ts';
import { withOwnershipLock } from '../runtime/ownership-lock.ts';
import { BoundedCommandRunner } from '../execution/transports.ts';
import { captureNativeArtifact, nativeDeliveryCanonical, nativeDeliveryDigest, parseNativeBackendIdentity, type NativeArtifactSeal, type NativeBackendIdentity } from './native-delivery.ts';
import { inspectProductDefinition } from './discovery.ts';
import { inspectProductDesign, serializeProductDesign } from './design.ts';
import { qualifiedNativeSourceBindings, type LiveFileBinding, type ProductBaselineObservationRequest } from './live-product.ts';

type Data = Record<string, unknown>;
type Phase = 'build_sign_export' | 'upload';
export type NativeReleaseEvidenceClass = 'native_vendor' | 'synthetic_fixture';
export interface NativeReleaseTarget {
  platform: 'ios' | 'android'; applicationId: string; buildVersion: string; nativeRuntimeVersion: string;
  accountId: string; publisherId: string; signingFingerprint: string; distributionSigningFingerprint: string;
  track: 'testflight' | 'app_store' | 'play_internal' | 'play_closed' | 'play_production';
  artifactPath: string; artifactKind: 'ios_ipa_file' | 'android_aab_file';
}
export interface NativeSignedReleaseTarget extends NativeReleaseTarget { artifact: NativeArtifactSeal; artifactByteDigest: string }
interface CommandManifest { command: DeploymentCommand; observer: DeploymentCommand; codeFiles: LiveFileBinding[]; resultPath: string }
export interface NativeReleasePlan {
  format: 'faktori.native-release-plan/v1'; id: string; productId: string; ownerId: string;
  evidenceClass: NativeReleaseEvidenceClass; configuration: LiveFileBinding;
  candidateDigest: string; sourceRevision: string; workspacePath: string; outputDirectory: string;
  backend: NativeBackendIdentity; supportedClients: unknown[]; contracts: unknown[];
  targets: NativeReleaseTarget[]; bindings: LiveFileBinding[]; digest: string;
  effectsApproved: false; productionReady: false;
}
export interface NativeReleaseUploadPlan {
  format: 'faktori.native-release-upload-plan/v1'; plan: LiveFileBinding; buildReceipt: LiveFileBinding;
  productId: string; ownerId: string; targets: NativeSignedReleaseTarget[]; digest: string;
  uploadApproved: false; productionReady: false;
}
export interface NativeReleaseReceipt {
  format: 'faktori.native-release-receipt/v1'; phase: Phase; operationId: string; scopeDigest: string;
  status: 'candidate_prepared' | 'submitted_pending_review' | 'distribution_available' | 'uncertain';
  plan: LiveFileBinding; selectedPlan: LiveFileBinding; intent: LiveFileBinding; authorityIntent: LiveFileBinding; approval: LiveFileBinding; evidenceClass: NativeReleaseEvidenceClass;
  productId: string; ownerId: string; targets?: NativeSignedReleaseTarget[];
  bindings: LiveFileBinding[]; observation?: Data; environmentReceipts: EnvironmentReceipt[];
  nativeSigningQualified: boolean; productionReady: false; automaticRetryAllowed: false;
}
const SHA = /^sha256:[a-f0-9]{64}$/;
const ENV = new Set(['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'NO_COLOR']);
const bytesDigest = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fail(reason: string): never { throw new Error(`Invalid native release: ${reason}`); }
function data(v: unknown, keys?: string[]): Data {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) fail('plain JSON required');
  const d = v as Data; if (keys && Object.keys(d).some(k => !keys.includes(k))) fail('unsupported field'); return d;
}
function text(v: unknown, max = 4096): string {
  if (typeof v !== 'string' || !v.length || v.length > max || /[\x00-\x1f]/.test(v)) fail('bounded non-secret text required');
  if (/-----BEGIN .*PRIVATE KEY-----|\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{15,}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.|(?:password|secret|token)\s*[:=]\s*\S+|https?:\/\/[^/\s]+@/i.test(v)) fail('native credential references only; no secret values');
  return v;
}
function path(v: unknown): string { const p = text(v); if (!isAbsolute(p) || resolve(p) !== p) fail('canonical absolute path required'); return p; }
function sha(v: unknown): string { const s = text(v, 71); if (!SHA.test(s)) fail('SHA256 required'); return s; }
function binding(v: unknown): LiveFileBinding { const d = data(v, ['path', 'digest']); return { path: path(d.path), digest: sha(d.digest) }; }
function contains(a: string, b: string): boolean { const r = relative(a, b); return r === '' || r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); }
async function protectedPath(p: string, workspace: string): Promise<void> {
  let actual: string; try { actual = await realpath(p); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; actual = join(await realpath(dirname(p)), p.slice(dirname(p).length + 1)); }
  if (actual !== p || contains(workspace, p) || contains(p, workspace)) fail('control/command/output path aliases or overlaps candidate workspace');
}
async function privateDirectory(p: string): Promise<void> { const s = await lstat(p); if (await realpath(p) !== p || !s.isDirectory() || (s.mode & 0o077) || typeof process.getuid === 'function' && s.uid !== process.getuid()) fail('private canonical controller directory required'); }
async function read(b: LiveFileBinding): Promise<Buffer> {
  if (await realpath(b.path) !== b.path) fail('binding alias');
  const h = await open(b.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await h.stat(); if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) || s.size > 8_000_000 || typeof process.getuid === 'function' && s.uid !== process.getuid()) fail('private bounded owned binding required');
    const buf = Buffer.alloc(s.size + 1); let pos = 0;
    while (pos < buf.length) { const { bytesRead } = await h.read(buf, pos, buf.length - pos, pos); if (!bytesRead) break; pos += bytesRead; }
    const after = await h.stat(), named = await lstat(b.path), raw = buf.subarray(0, pos);
    if (pos !== s.size || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs || named.dev !== s.dev || named.ino !== s.ino || named.size !== s.size || named.mtimeMs !== s.mtimeMs || named.ctimeMs !== s.ctimeMs || bytesDigest(raw) !== b.digest) fail('binding changed');
    return raw;
  } finally { await h.close(); }
}
async function json(b: LiveFileBinding): Promise<Data> { const raw = await read(b); let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { fail('malformed private normalized JSON; raw data/errors are not surfaced'); } return data(value); }
async function fileBinding(p: string): Promise<LiveFileBinding> { const raw = await readUnboundPrivate(p); return { path: p, digest: bytesDigest(raw) }; }
async function readUnboundPrivate(p: string): Promise<Buffer> {
  // Bind first read, then use the same stable/private reader; no caller-supplied pass flags.
  const h = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: Buffer;
  try { const s = await h.stat(); if (!s.isFile() || s.size > 8_000_000 || s.nlink !== 1 || (s.mode & 0o077)) fail('private bounded receipt required'); const buf = Buffer.alloc(s.size + 1); let pos = 0; while (pos < buf.length) { const { bytesRead } = await h.read(buf, pos, buf.length - pos, pos); if (!bytesRead) break; pos += bytesRead; } if (pos !== s.size) fail('receipt changed'); raw = buf.subarray(0, pos); } finally { await h.close(); }
  return read({ path: p, digest: bytesDigest(raw!) });
}
async function streamDigest(p: string, nativeExecutable = false): Promise<string> {
  if (await realpath(p) !== p || !(await lstat(p)).isFile()) fail('code/artifact requires canonical regular file'); const h = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const s = await h.stat(); if (!s.isFile() || !nativeExecutable && s.nlink !== 1 || s.size > 512 * 1024 * 1024) fail('code/artifact size/type'); const hash = createHash('sha256'), chunk = Buffer.alloc(256 * 1024); let pos = 0;
    while (true) { const { bytesRead } = await h.read(chunk, 0, chunk.length, pos); if (!bytesRead) break; pos += bytesRead; if (pos > s.size) fail('code/artifact grew'); hash.update(chunk.subarray(0, bytesRead)); }
    const a = await h.stat(), n = await lstat(p); if (pos !== s.size || a.size !== s.size || a.nlink !== s.nlink || a.mtimeMs !== s.mtimeMs || a.ctimeMs !== s.ctimeMs || n.dev !== s.dev || n.ino !== s.ino || n.size !== s.size || n.nlink !== s.nlink || n.mtimeMs !== s.mtimeMs || n.ctimeMs !== s.ctimeMs) fail('code/artifact changed'); return `sha256:${hash.digest('hex')}`;
  } finally { await h.close(); }
}
async function writeOnce(p: string, value: unknown): Promise<void> { const h = await open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await h.writeFile(`${JSON.stringify(value)}\n`); await h.sync(); } finally { await h.close(); } const d = await open(dirname(p), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await d.sync(); } finally { await d.close(); } }
function targets(v: unknown): NativeReleaseTarget[] {
  if (!Array.isArray(v) || !v.length || v.length > 2) fail('one or two distinct native targets required');
  const result = v.map(x => { const d = data(x, ['platform', 'applicationId', 'buildVersion', 'nativeRuntimeVersion', 'accountId', 'publisherId', 'signingFingerprint', 'distributionSigningFingerprint', 'track', 'artifactPath', 'artifactKind']);
    if (d.platform !== 'ios' && d.platform !== 'android' || d.artifactKind !== (d.platform === 'ios' ? 'ios_ipa_file' : 'android_aab_file') || !(d.platform === 'ios' ? ['testflight', 'app_store'] : ['play_internal', 'play_closed', 'play_production']).includes(String(d.track))) fail('platform/artifact/distribution tier mismatch');
    const applicationId = text(d.applicationId, 256); if (!/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(applicationId)) fail('stable application ID required');
    return { platform: d.platform, applicationId, buildVersion: text(d.buildVersion, 128), nativeRuntimeVersion: text(d.nativeRuntimeVersion, 128), accountId: text(d.accountId, 256), publisherId: text(d.publisherId, 256), signingFingerprint: sha(d.signingFingerprint), distributionSigningFingerprint: sha(d.distributionSigningFingerprint), track: d.track, artifactPath: path(d.artifactPath), artifactKind: d.artifactKind } as NativeReleaseTarget;
  });
  if (new Set(result.map(t => t.platform)).size !== result.length || result.some((t, i) => i && result[i - 1]!.platform > t.platform)) fail('distinct sorted platform targets required'); return result;
}
function command(v: unknown): DeploymentCommand {
  const d = data(v, ['executable', 'args', 'cwd', 'environment', 'timeoutMs', 'stdoutMaxBytes', 'stderrMaxBytes']), env = data(d.environment);
  if (!Array.isArray(d.args) || d.args.length > 100 || Object.keys(env).some(k => !ENV.has(k)) || !Number.isSafeInteger(d.timeoutMs) || Number(d.timeoutMs) < 1 || Number(d.timeoutMs) > 900000) fail('bounded explicit command/environment required');
  if (d.stdoutMaxBytes !== 1000000 || d.stderrMaxBytes !== 1000000) fail('fixed bounded capture required');
  if (d.args.some(a => typeof a === 'string' && /^--?(?:.*(?:password|secret|token)|api[-_]?key|access[-_]?key)(?:=|$)/i.test(a))) fail('raw credential argv forbidden; use vendor-owned native custody');
  return { executable: path(d.executable), args: d.args.map(a => text(a, 32000)), cwd: path(d.cwd), environment: Object.fromEntries(Object.entries(env).map(([k, value]) => [k, text(value)])), timeoutMs: Number(d.timeoutMs), stdoutMaxBytes: 1000000, stderrMaxBytes: 1000000 };
}
function invocation(c: DeploymentCommand): string { if (c.executable !== process.execPath) { if (/^(?:node(?:js)?|sh|bash|zsh|dash|fish|python[\d.]*|ruby|perl|php|pwsh|powershell)(?:\.exe)?$/i.test(basename(c.executable))) fail('interpreter wrappers require the qualified Node executable and sealed actual script'); return c.executable; } const script = c.args?.[0]; if (!script || script.startsWith('-')) fail('Node commands require sealed actual script argv[0], no eval/import wrappers'); return resolve(c.cwd, script); }
async function manifest(v: unknown, workspace: string, output: string, checked = new Map<string, string>()): Promise<CommandManifest> {
  const d = data(v, ['command', 'observer', 'codeFiles', 'resultPath']), c = command(d.command), o = command(d.observer);
  if (!Array.isArray(d.codeFiles) || !d.codeFiles.length || d.codeFiles.length > 100) fail('sealed command and observer code required');
  const codeFiles = d.codeFiles.map(binding), resultPath = path(d.resultPath);
  if (!contains(output, resultPath) || resultPath === output || c.cwd !== workspace || o.cwd !== workspace || o.timeoutMs! > 120000) fail('exact candidate cwd and bounded output observer required');
  for (const cmd of [c, o]) if (![cmd.executable, invocation(cmd)].every(p => codeFiles.some(b => b.path === p))) fail('actual executable and invoked code must be sealed');
  if (new Set(codeFiles.map(b => b.path)).size !== codeFiles.length) fail('duplicate code binding');
  for (const b of codeFiles) { await protectedPath(b.path, workspace); const actual = checked.get(b.path) ?? await streamDigest(b.path, b.path === c.executable || b.path === o.executable); if (actual !== b.digest) fail('command code bytes changed'); checked.set(b.path, actual); }
  await protectedPath(resultPath, workspace); return { command: c, observer: o, codeFiles, resultPath };
}
async function config(b: LiveFileBinding) { const c = await json(b); data(c, ['format', 'id', 'productId', 'ownerId', 'evidenceClass', 'workspacePath', 'outputDirectory', 'candidateDigest', 'sourceRevision', 'source', 'definition', 'design', 'designApproval', 'verificationConfiguration', 'verification', 'evaluatorFiles', 'observerFiles', 'runtimeObserver', 'backend', 'supportedClients', 'contracts', 'targets', 'build', 'upload']);
  if (c.format !== 'faktori.native-release-configuration/v1' || !['native_vendor', 'synthetic_fixture'].includes(String(c.evidenceClass))) fail('native release configuration/evidence class required');
  const workspace = path(c.workspacePath), output = path(c.outputDirectory); if (await realpath(workspace) !== workspace) fail('workspace alias'); await privateDirectory(output); await protectedPath(output, workspace); await protectedPath(b.path, workspace);
  // Deduplicate identical code paths only within this fresh validation call; no cross-effect/replay cache.
  const checked = new Map<string, string>(), build = await manifest(c.build, workspace, output, checked), upload = await manifest(c.upload, workspace, output, checked); if (build.resultPath === upload.resultPath) fail('phase observation files must be separate'); return { c, workspace, output, build, upload, checked };
}
/** Read-only preparation; accepted scope and genuine candidate verification are necessary but grant no signing/upload authority. */
export async function prepareNativeRelease(value: unknown): Promise<NativeReleasePlan> {
  const r = data(value, ['format', 'configuration']); if (r.format !== 'faktori.native-release-prepare/v1') fail('prepare format'); const cb = binding(r.configuration), { c, workspace, output, build, upload, checked } = await config(cb);
  const definition = binding(c.definition), design = binding(c.design), approval = binding(c.designApproval), inspected = inspectProductDefinition(await json(definition)), accepted = inspectProductDesign(await json(definition), await json(design), await json(approval));
  const productId = text(c.productId, 128), ownerId = text(c.ownerId, 128), ts = targets(c.targets), backend = parseNativeBackendIdentity(c.backend);
  if (c.evidenceClass === 'native_vendor' && !backend.origin.startsWith('https://')) fail('native vendor distribution requires the approved HTTPS backend');
  if (!ts.every(t => ['app_store', 'play_production'].includes(t.track)) && !ts.every(t => !['app_store', 'play_production'].includes(t.track))) fail('one consistent beta or production distribution tier required');
  if (!inspected.readyForDesign || !accepted.readyForDelivery || inspected.definition.productId !== productId || accepted.approval?.ownerId !== ownerId || bytesDigest(serializeProductDesign(await json(design))) !== design.digest) fail('exact separately owner-accepted definition/design required');
  const selected = inspected.definition.platforms.targets.filter(p => p !== 'web').sort(); if (nativeDeliveryCanonical(selected) !== nativeDeliveryCanonical(ts.map(t => t.platform))) fail('selected native platforms differ');
  if (!accepted.design.decisions.some(d => d.area === 'api' && d.target === 'shared' && d.contract?.revision === backend.contractRevision)) fail('shared backend contract differs from accepted design');
  for (const refs of [c.supportedClients, c.contracts]) { if (!Array.isArray(refs) || !refs.length || refs.length > 100) fail('bounded client/API compatibility required'); for (const ref of refs) { const d = data(ref, ['reference', 'revision']); text(d.reference); text(d.revision, 256); } }
  if (!(c.contracts as Data[]).some(x => x.revision === backend.contractRevision)) fail('shared backend compatibility differs');
  for (const t of ts) { if (!contains(output, t.artifactPath) || t.artifactPath === output) fail('artifact output outside approved root'); await protectedPath(t.artifactPath, workspace); }
  const source = data(c.source, ['candidatePath', 'files']); if (source.candidatePath !== workspace) fail('qualified candidate must be the exact build/upload/runtime workspace');
  if (!Array.isArray(source.files) || nativeDeliveryDigest(source.files) !== c.sourceRevision || [definition, design, approval].some(b => !(source.files as Data[]).some(f => f.path === b.path && f.digest === b.digest))) fail('accepted scope must participate in exact candidate source revision');
  const runtime = data(c.runtimeObserver, ['identity', 'check', 'environment', 'limits', 'codeFiles']), verification = binding(c.verification);
  const limits = data(runtime.limits, ['timeoutMs', 'outputMaxBytes']); if (!Number.isSafeInteger(limits.timeoutMs) || Number(limits.timeoutMs) < 1 || Number(limits.timeoutMs) > 120000 || !Number.isSafeInteger(limits.outputMaxBytes) || Number(limits.outputMaxBytes) < 1024 || Number(limits.outputMaxBytes) > 1000000) fail('runtime observer bounds');
  if (!Array.isArray(runtime.codeFiles) || runtime.codeFiles.length > 100) fail('runtime observer executable/code bindings required');
  const runtimeCode = runtime.codeFiles.map(binding);
  for (const v of [runtime.identity, runtime.check]) { const cmd = data(v, ['command', 'args']); const parsed = command({ executable: cmd.command, args: cmd.args, cwd: workspace, environment: runtime.environment, timeoutMs: limits.timeoutMs, stdoutMaxBytes: 1000000, stderrMaxBytes: 1000000 }); for (const p of [parsed.executable, invocation(parsed)]) if (!runtimeCode.some(b => b.path === p)) fail('actual runtime observer executable and script must be sealed'); }
  for (const b of runtimeCode) { await protectedPath(b.path, workspace); const actual = checked.get(b.path) ?? await streamDigest(b.path, [runtime.identity, runtime.check].some(v => (v as Data).command === b.path)); if (actual !== b.digest) fail('runtime observer bytes changed'); checked.set(b.path, actual); }
  const request = { productId, ownerId, receipts: { configuration: cb, verification }, expected: { candidateDigest: sha(c.candidateDigest) }, observer: { cwd: workspace, identity: runtime.identity, check: runtime.check } } as unknown as ProductBaselineObservationRequest;
  const bindings = await qualifiedNativeSourceBindings(c, request, [definition, design, approval]);
  bindings.push(...build.codeFiles, ...upload.codeFiles, ...runtimeCode); for (const observer of c.observerFiles as Data[]) await protectedPath(binding(observer).path, workspace);
  const body = { format: 'faktori.native-release-plan/v1' as const, id: text(c.id, 128), productId, ownerId, evidenceClass: c.evidenceClass as NativeReleaseEvidenceClass, configuration: cb, candidateDigest: sha(c.candidateDigest), sourceRevision: sha(c.sourceRevision), workspacePath: workspace, outputDirectory: output, backend, supportedClients: c.supportedClients as unknown[], contracts: c.contracts as unknown[], targets: ts, bindings, effectsApproved: false as const, productionReady: false as const };
  return { ...body, digest: nativeDeliveryDigest(body) };
}
async function loadPlan(b: LiveFileBinding): Promise<NativeReleasePlan> {
  const stored = await json(b); if (stored.format !== 'faktori.native-release-plan/v1') fail('prepared plan required');
  const fresh = await prepareNativeRelease({ format: 'faktori.native-release-prepare/v1', configuration: stored.configuration });
  if (nativeDeliveryCanonical(stored) !== nativeDeliveryCanonical(fresh)) fail('prepared plan or dependencies changed'); await protectedPath(b.path, fresh.workspacePath); return fresh;
}
async function sealedTargets(plan: NativeReleasePlan): Promise<NativeSignedReleaseTarget[]> {
  const result: NativeSignedReleaseTarget[] = [];
  for (const target of plan.targets) result.push({ ...target, artifact: await captureNativeArtifact({ path: target.artifactPath, kind: target.artifactKind }), artifactByteDigest: await streamDigest(target.artifactPath) });
  return result;
}
async function validateReceipt(b: LiveFileBinding, plan: NativeReleasePlan, expectedPhase?: Phase): Promise<NativeReleaseReceipt> {
  const raw = data(await json(b), ['format', 'phase', 'operationId', 'scopeDigest', 'status', 'plan', 'selectedPlan', 'intent', 'authorityIntent', 'approval', 'evidenceClass', 'productId', 'ownerId', 'targets', 'bindings', 'observation', 'environmentReceipts', 'nativeSigningQualified', 'productionReady', 'automaticRetryAllowed']);
  const r = raw as unknown as NativeReleaseReceipt;
  if (r.format !== 'faktori.native-release-receipt/v1' || !['build_sign_export', 'upload'].includes(r.phase) || expectedPhase && r.phase !== expectedPhase || !['candidate_prepared', 'submitted_pending_review', 'distribution_available', 'uncertain'].includes(r.status) || r.productId !== plan.productId || r.ownerId !== plan.ownerId || r.evidenceClass !== plan.evidenceClass || !Array.isArray(r.bindings) || r.bindings.length > 500 || r.productionReady !== false || r.automaticRetryAllowed !== false) fail('release receipt identity');
  // Caller has freshly qualified this plan; validate the exact recorded bytes without recursively qualifying it twice.
  for (const item of [b, binding(r.plan), binding(r.selectedPlan), binding(r.approval), binding(r.intent), binding(r.authorityIntent)]) await protectedPath(item.path, plan.workspacePath);
  if (nativeDeliveryCanonical(await json(binding(r.plan))) !== nativeDeliveryCanonical(plan)) fail('receipt plan differs');
  const selected = r.phase === 'upload' ? await loadUploadPlan(binding(r.selectedPlan)) : plan;
  if (r.phase === 'build_sign_export' && nativeDeliveryCanonical(await json(binding(r.selectedPlan))) !== nativeDeliveryCanonical(plan)) fail('selected build plan differs');
  await approval(binding(r.approval), r.phase, selected); for (const item of r.bindings) await read(binding(item));
  const intent = await json(binding(r.intent)), directory = dirname(r.intent.path);
  if (r.intent.path !== join(directory, `${r.phase}.intent.json`) || intent.format !== 'faktori.native-release-intent/v1' || intent.phase !== r.phase || intent.operationId !== r.operationId || nativeDeliveryCanonical(intent.plan) !== nativeDeliveryCanonical(r.selectedPlan) || nativeDeliveryCanonical(intent.approval) !== nativeDeliveryCanonical(r.approval) || intent.scopeDigest !== r.scopeDigest || r.scopeDigest !== nativeReleaseApprovalScopeDigest(r.phase, selected) || r.operationId !== nativeDeliveryDigest({ phase: r.phase, planDigest: selected.digest, receiptDirectory: directory })) fail('receipt does not bind durable approved phase intent');
  const authority = await json(binding(r.authorityIntent));
  if (r.authorityIntent.path !== phaseCustodyPath(plan, r.phase, selected.digest) || authority.format !== 'faktori.native-release-phase-custody/v1' || authority.operationId !== r.operationId || authority.planDigest !== selected.digest || authority.receiptDirectory !== directory || nativeDeliveryCanonical(authority.approval) !== nativeDeliveryCanonical(r.approval)) fail('receipt phase custody differs');
  if (r.targets) { parseNativeSignedReleaseTargets(r.targets); if (nativeDeliveryCanonical(r.targets) !== nativeDeliveryCanonical(await sealedTargets(plan))) fail('signed artifact bytes changed'); }
  if (r.status !== 'uncertain') {
    if (!r.targets || !r.observation || r.nativeSigningQualified !== (plan.evidenceClass === 'native_vendor')) fail('completed signing/distribution observation required');
    const { build, upload } = await config(plan.configuration), observedPath = r.phase === 'upload' ? upload.resultPath : build.resultPath;
    const observed = r.bindings.find(b => b.path === observedPath); if (!observed || nativeDeliveryCanonical(await json(observed)) !== nativeDeliveryCanonical(r.observation)) fail('receipt observation bytes differ');
    if (r.phase === 'build_sign_export') { if (r.status !== 'candidate_prepared') fail('build status differs'); signingObservation(r.observation, plan, r.targets, r.operationId); }
    else { distributionObservation(r.observation, plan, r.targets, r.operationId); if (r.status !== (r.observation.status === 'available' ? 'distribution_available' : 'submitted_pending_review')) fail('store status differs'); }
  }
  return r;
}
function phaseCustodyPath(plan: NativeReleasePlan, phase: Phase, selectedDigest: string): string { return join(plan.outputDirectory, `phase-${phase}-${selectedDigest.slice(7)}.intent.json`); }
/** Actual signed candidate is concrete and reviewable before separate upload approval. */
export async function prepareNativeReleaseUpload(value: unknown): Promise<NativeReleaseUploadPlan> {
  const d = data(value, ['format', 'plan', 'buildReceipt']); if (d.format !== 'faktori.native-release-upload-prepare/v1') fail('upload preparation format');
  const pb = binding(d.plan), bb = binding(d.buildReceipt), plan = await loadPlan(pb), receipt = await validateReceipt(bb, plan, 'build_sign_export');
  if (receipt.phase !== 'build_sign_export' || receipt.status !== 'candidate_prepared' || !receipt.targets || plan.evidenceClass === 'native_vendor' && !receipt.nativeSigningQualified) fail('upload requires actually prepared signed candidate');
  const body = { format: 'faktori.native-release-upload-plan/v1' as const, plan: pb, buildReceipt: bb, productId: plan.productId, ownerId: plan.ownerId, targets: receipt.targets, uploadApproved: false as const, productionReady: false as const };
  return { ...body, digest: nativeDeliveryDigest(body) };
}
async function loadUploadPlan(b: LiveFileBinding): Promise<NativeReleaseUploadPlan> {
  const stored = await json(b); if (stored.format !== 'faktori.native-release-upload-plan/v1') fail('upload plan required');
  const fresh = await prepareNativeReleaseUpload({ format: 'faktori.native-release-upload-prepare/v1', plan: stored.plan, buildReceipt: stored.buildReceipt });
  if (nativeDeliveryCanonical(stored) !== nativeDeliveryCanonical(fresh)) fail('artifact-bound upload plan changed'); return fresh;
}
/** Pure scope digest; a returned digest is not an owner approval. */
export function nativeReleaseApprovalScopeDigest(phase: Phase, plan: NativeReleasePlan | NativeReleaseUploadPlan): string {
  if (phase !== 'build_sign_export' && phase !== 'upload' || plan.format !== (phase === 'upload' ? 'faktori.native-release-upload-plan/v1' : 'faktori.native-release-plan/v1')) fail('approval phase differs');
  return nativeDeliveryDigest({ phase, planDigest: plan.digest, productId: plan.productId, ownerId: plan.ownerId, targets: plan.targets });
}
async function approval(b: LiveFileBinding, phase: Phase, plan: NativeReleasePlan | NativeReleaseUploadPlan) {
  const a = data(await json(b), ['format', 'phase', 'ownerId', 'decisionId', 'approved', 'nativeAccessApproved', 'planDigest', 'scopeDigest']);
  if (a.format !== 'faktori.native-release-approval/v1' || a.phase !== phase || a.ownerId !== plan.ownerId || a.approved !== true || a.nativeAccessApproved !== true || a.planDigest !== plan.digest || a.scopeDigest !== nativeReleaseApprovalScopeDigest(phase, plan)) fail('separate exact owner effect approval required'); text(a.decisionId, 128); return a;
}
function signingObservation(o: Data, plan: NativeReleasePlan, actual: NativeSignedReleaseTarget[], operationId: string) {
  data(o, ['format', 'operationId', 'evidenceClass', 'productId', 'ownerId', 'candidateDigest', 'sourceRevision', 'backend', 'targets', 'accountAuthenticated', 'signingVerified', 'artifactFormatVerified']);
  if (o.format !== 'faktori.native-signing-observation/v1' || o.operationId !== operationId || o.evidenceClass !== plan.evidenceClass || o.productId !== plan.productId || o.ownerId !== plan.ownerId || o.candidateDigest !== plan.candidateDigest || o.sourceRevision !== plan.sourceRevision || nativeDeliveryCanonical(o.backend) !== nativeDeliveryCanonical(plan.backend) || nativeDeliveryCanonical(o.targets) !== nativeDeliveryCanonical(actual)) fail('actual signing/account/app/build/artifact/backend identity differs');
  const native = plan.evidenceClass === 'native_vendor'; if (['accountAuthenticated', 'signingVerified', 'artifactFormatVerified'].some(k => o[k] !== native)) fail('fixture cannot claim actual account, archive format or production signing proof');
}
function distributionObservation(o: Data, plan: NativeReleasePlan, actual: NativeSignedReleaseTarget[], operationId: string) {
  data(o, ['format', 'operationId', 'evidenceClass', 'productId', 'ownerId', 'candidateDigest', 'sourceRevision', 'targets', 'status', 'providerReceiptId']);
  if (o.format !== 'faktori.native-distribution-observation/v1' || o.operationId !== operationId || o.evidenceClass !== plan.evidenceClass || o.productId !== plan.productId || o.ownerId !== plan.ownerId || o.candidateDigest !== plan.candidateDigest || o.sourceRevision !== plan.sourceRevision || nativeDeliveryCanonical(o.targets) !== nativeDeliveryCanonical(actual) || !['submitted', 'processing', 'review_pending', 'available'].includes(String(o.status))) fail('actual distribution account/app/build/track/artifact identity differs'); text(o.providerReceiptId, 512);
}
/** Two existing command/executor phases. Intent is durable before either command; uncertainty never grants another attempt. */
export async function executeNativeRelease(value: unknown): Promise<NativeReleaseReceipt> {
  const d = data(value, ['format', 'phase', 'plan', 'approval', 'receiptDirectory']); if (d.format !== 'faktori.native-release-execute/v1' || !['build_sign_export', 'upload'].includes(String(d.phase))) fail('execution phase/format');
  const phase = d.phase as Phase, selected = binding(d.plan), ab = binding(d.approval), upload = phase === 'upload' ? await loadUploadPlan(selected) : undefined;
  const pb = upload?.plan ?? selected, plan = await loadPlan(pb), phasePlan = upload ?? plan, directory = path(d.receiptDirectory);
  await privateDirectory(directory); await protectedPath(directory, plan.workspacePath); await protectedPath(ab.path, plan.workspacePath); await approval(ab, phase, phasePlan);
  const intentPath = join(directory, `${phase}.intent.json`), receiptPath = join(directory, `${phase}.receipt.json`), requestDigest = nativeDeliveryDigest(d), operationId = nativeDeliveryDigest({ phase, planDigest: phasePlan.digest, receiptDirectory: directory });
  return withOwnershipLock(join(plan.outputDirectory, `native-phase-${phase}-${phasePlan.digest.slice(7)}`), async () => {
    try {
      const previous = await json(await fileBinding(receiptPath));
      const intention = await json(await fileBinding(intentPath)); if (intention.requestDigest !== requestDigest || previous.operationId !== operationId || previous.status === 'uncertain') fail('uncertain or conflicting phase; inspect only, never rerun');
      return await validateReceipt(await fileBinding(receiptPath), plan);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    try { await lstat(intentPath); fail('unfinished phase intent; inspect only, never rerun'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const authorityPath = phaseCustodyPath(plan, phase, phasePlan.digest);
    try { await lstat(authorityPath); fail('phase already claimed in another receipt directory; inspect only, never rerun'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const { build, upload: uploadCommands } = await config(plan.configuration), commands = phase === 'upload' ? uploadCommands : build;
    // An old observation must not be mistaken for the just-executed operation.
    try { await lstat(commands.resultPath); fail('phase observation already exists; new candidate/recovery inspection required'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await writeOnce(authorityPath, { format: 'faktori.native-release-phase-custody/v1', operationId, phase, planDigest: phasePlan.digest, receiptDirectory: directory, approval: ab, automaticRetryAllowed: false });
    await writeOnce(intentPath, { format: 'faktori.native-release-intent/v1', phase, operationId, requestDigest, plan: selected, approval: ab, scopeDigest: nativeReleaseApprovalScopeDigest(phase, phasePlan), recordedAt: new Date().toISOString(), automaticRetryAllowed: false });
    const environmentReceipts: EnvironmentReceipt[] = [];
    const intent = await fileBinding(intentPath), authorityIntent = await fileBinding(authorityPath);
    const result: NativeReleaseReceipt = { format: 'faktori.native-release-receipt/v1', phase, operationId, scopeDigest: nativeReleaseApprovalScopeDigest(phase, phasePlan), status: 'uncertain', plan: pb, selectedPlan: selected, intent, authorityIntent, approval: ab, evidenceClass: plan.evidenceClass, productId: plan.productId, ownerId: plan.ownerId, bindings: [selected, ab, intent, authorityIntent], environmentReceipts, nativeSigningQualified: false, productionReady: false, automaticRetryAllowed: false };
    const guard = async () => { const current = phase === 'upload' ? await loadUploadPlan(selected) : await loadPlan(selected); if (current.digest !== phasePlan.digest) fail('candidate/effect scope changed'); await approval(ab, phase, current); };
    const scope = { kind: 'native.release', repository: plan.productId, branch: 'owner-approved-native-release', baseRevision: plan.sourceRevision, expectedRevision: plan.sourceRevision, allowedOperation: operationId, scopeRevision: phasePlan.digest };
    const action: AuthorizedAction = { operationId, request: { format: 'faktori.action-request/v1', actionId: `${plan.id}.${phase}`, idempotencyKey: operationId, runId: plan.id, scope, authorityEpoch: 0, requestDigest, requestedAt: new Date().toISOString() }, grant: { format: 'faktori.action-grant/v1', grantId: operationId, runId: plan.id, scope, authorityEpoch: 0, issuedAt: new Date().toISOString(), verification: { algorithm: 'hmac-sha256', keyId: 'explicit-owner-native-release-request' } } };
    // The existing controller executor receives only approved configuration, never worker credentials or ambient environment.
    const addOperation = (c: DeploymentCommand): DeploymentCommand => ({ ...c, environment: { ...c.environment, FAKTORI_RELEASE_OPERATION_ID: operationId } });
    const executor = new DeploymentMaintenanceExecutor({ targets: [{ operation: operationId, environment: `${plan.productId}.${phase}`, revision: plan.sourceRevision, approved: true, mode: 'local-command', command: addOperation(commands.command), smoke: addOperation(commands.observer) }] }, { async createOnce(followUp) { await writeOnce(join(directory, `${phase}.follow-up.json`), followUp); return true; } }, { async records() { return environmentReceipts; }, async append(receipt) { const p = join(directory, `${phase}.environment-${environmentReceipts.length}.json`); await writeOnce(p, receipt); result.bindings.push(await fileBinding(p)); environmentReceipts.push(receipt); } });
    try {
      const executed = await executor.execute(action, guard); if (executed.outcome !== 'completed') fail('effect or independent signing/distribution observer failed; no duplicate effect');
      await guard(); const observationBinding = await fileBinding(commands.resultPath), o = await json(observationBinding), actual = await sealedTargets(plan);
      if (phase === 'build_sign_export') { signingObservation(o, plan, actual, operationId); result.status = 'candidate_prepared'; result.nativeSigningQualified = plan.evidenceClass === 'native_vendor'; }
      else { if (nativeDeliveryCanonical(actual) !== nativeDeliveryCanonical(upload!.targets)) fail('artifact changed during upload'); distributionObservation(o, plan, actual, operationId); result.status = o.status === 'available' ? 'distribution_available' : 'submitted_pending_review'; result.nativeSigningQualified = plan.evidenceClass === 'native_vendor'; result.bindings.push(upload!.buildReceipt); }
      result.targets = actual; result.observation = o; result.bindings.push(observationBinding);
      await guard(); await read(observationBinding); if (nativeDeliveryCanonical(actual) !== nativeDeliveryCanonical(await sealedTargets(plan))) fail('artifact changed after observation');
    } catch { result.status = 'uncertain'; result.nativeSigningQualified = false; }
    await writeOnce(receiptPath, result); return result;
  });
}
/** Read-only custody/recovery inspection. It never calls a vendor, retries a command or restores authority. */
export async function inspectNativeRelease(value: unknown): Promise<{ intent?: Data; receipt?: Data; recovery: 'inspect_only_no_retry'; executionStarted: false }> {
  const d = data(value, ['format', 'phase', 'receiptDirectory']); if (d.format !== 'faktori.native-release-inspect/v1' || !['build_sign_export', 'upload'].includes(String(d.phase))) fail('inspection phase/format');
  const directory = path(d.receiptDirectory); await privateDirectory(directory); const result: { intent?: Data; receipt?: Data; recovery: 'inspect_only_no_retry'; executionStarted: false } = { recovery: 'inspect_only_no_retry', executionStarted: false };
  for (const kind of ['intent', 'receipt'] as const) { try { const b = await fileBinding(join(directory, `${d.phase}.${kind}.json`)), raw = await json(b); if (raw.format !== `faktori.native-release-${kind}/v1` || raw.phase !== d.phase) fail('inspection record identity'); const status = raw.status; if (kind === 'receipt' && !['candidate_prepared', 'submitted_pending_review', 'distribution_available', 'uncertain'].includes(String(status))) fail('inspection status'); result[kind] = { format: raw.format, phase: d.phase, binding: b, ...(raw.operationId === undefined ? {} : { operationId: sha(raw.operationId) }), ...(kind === 'receipt' ? { status } : {}), integrityQualified: false, automaticRetryAllowed: false }; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } } return result;
}
/** Separately approved read-only recovery of the SAME upload operation. It cannot submit or restore expired upload authority. */
export async function reconcileNativeRelease(value: unknown): Promise<Data> {
  const d = data(value, ['format', 'receipt', 'inspection', 'approval', 'receiptDirectory']); if (d.format !== 'faktori.native-release-reconcile/v1') fail('reconciliation format');
  const rb = binding(d.receipt), original = await json(rb), plan = await loadPlan(binding(original.plan)), receipt = await validateReceipt(rb, plan);
  if (receipt.phase !== 'upload') fail('read-only store recovery requires existing upload intent/receipt');
  const uploadPlan = await loadUploadPlan(receipt.selectedPlan), directory = path(d.receiptDirectory), ab = binding(d.approval), i = data(d.inspection, ['observer', 'codeFiles', 'resultPath']);
  await privateDirectory(directory); await protectedPath(directory, plan.workspacePath); await protectedPath(ab.path, plan.workspacePath);
  const inspection = await manifest({ command: i.observer, ...i }, plan.workspacePath, plan.outputDirectory), scopeDigest = nativeDeliveryDigest({ receipt: rb, inspection: i });
  const check = async () => { await validateReceipt(rb, plan); await loadPlan(receipt.plan); await manifest({ command: i.observer, ...i }, plan.workspacePath, plan.outputDirectory); const a = data(await json(ab), ['format', 'ownerId', 'decisionId', 'approved', 'nativeAccessApproved', 'scope', 'scopeDigest']); if (a.format !== 'faktori.native-release-inspection-approval/v1' || a.ownerId !== plan.ownerId || a.approved !== true || a.nativeAccessApproved !== true || a.scope !== 'read_only_target' || a.scopeDigest !== scopeDigest) fail('separate exact read-only inspection approval required'); text(a.decisionId, 128); };
  await check();
  return withOwnershipLock(join(directory, 'native-reconciliation'), async () => {
    const output = join(directory, 'reconciliation.json'), intention = join(directory, 'reconciliation.intent.json');
    try { const previous = await json(await fileBinding(output)); if (previous.scopeDigest !== scopeDigest) fail('conflicting read-only recovery'); await reconciliationBasis(await fileBinding(output), plan); return previous; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    for (const p of [intention, inspection.resultPath]) { try { await lstat(p); fail('unfinished inspection; new separately approved inspection scope required'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
    const inspectionBinding = await (async () => { const p = join(directory, 'inspection.json'); await writeOnce(p, i); return fileBinding(p); })();
    await writeOnce(intention, { format: 'faktori.native-release-reconciliation-intent/v1', receipt: rb, inspection: inspectionBinding, approval: ab, scopeDigest, operationId: receipt.operationId, effectRetryAllowed: false });
    await check();
    const c = inspection.observer, executed = await new BoundedCommandRunner().run({ command: c.executable, args: c.args ?? [], cwd: c.cwd, env: { ...c.environment, FAKTORI_RELEASE_OPERATION_ID: receipt.operationId }, timeoutMs: c.timeoutMs!, stdoutMaxBytes: c.stdoutMaxBytes!, stderrMaxBytes: c.stderrMaxBytes! });
    if (executed.exitCode !== 0 || executed.signal || executed.timedOut || executed.outputLimitExceeded || executed.spawnError) fail('read-only inspection uncertain; no effect retry');
    await check(); const observation = await fileBinding(inspection.resultPath), o = await json(observation), actual = await sealedTargets(plan);
    if (nativeDeliveryCanonical(actual) !== nativeDeliveryCanonical(uploadPlan.targets)) fail('recovery artifact differs'); distributionObservation(o, plan, actual, receipt.operationId); await check(); await read(observation);
    const result = { format: 'faktori.native-release-reconciliation/v1', receipt: rb, inspection: inspectionBinding, approval: ab, intent: await fileBinding(intention), observation, scopeDigest, operationId: receipt.operationId, status: o.status === 'available' ? 'distribution_available' : 'submitted_pending_review', effectRetryAllowed: false, productionReady: false };
    await writeOnce(output, result); return result;
  });
}
async function reconciliationBasis(b: LiveFileBinding, plan: NativeReleasePlan): Promise<{ receipt: NativeReleaseReceipt; bindings: LiveFileBinding[] }> {
  const r = data(await json(b), ['format', 'receipt', 'inspection', 'approval', 'intent', 'observation', 'scopeDigest', 'operationId', 'status', 'effectRetryAllowed', 'productionReady']);
  if (r.format !== 'faktori.native-release-reconciliation/v1' || r.effectRetryAllowed !== false || r.productionReady !== false) fail('recovery receipt format');
  const rb = binding(r.receipt), original = await validateReceipt(rb, plan), i = await json(binding(r.inspection)), a = data(await json(binding(r.approval)), ['format', 'ownerId', 'decisionId', 'approved', 'nativeAccessApproved', 'scope', 'scopeDigest']);
  await manifest({ command: i.observer, ...i }, plan.workspacePath, plan.outputDirectory);
  const scope = nativeDeliveryDigest({ receipt: rb, inspection: i }), intent = await json(binding(r.intent));
  if (original.phase !== 'upload' || r.operationId !== original.operationId || r.scopeDigest !== scope || a.format !== 'faktori.native-release-inspection-approval/v1' || a.ownerId !== plan.ownerId || a.approved !== true || a.nativeAccessApproved !== true || a.scope !== 'read_only_target' || a.scopeDigest !== scope || intent.format !== 'faktori.native-release-reconciliation-intent/v1' || intent.scopeDigest !== scope || nativeDeliveryCanonical(intent.receipt) !== nativeDeliveryCanonical(rb) || nativeDeliveryCanonical(intent.inspection) !== nativeDeliveryCanonical(r.inspection) || nativeDeliveryCanonical(intent.approval) !== nativeDeliveryCanonical(r.approval)) fail('read-only recovery authority/intent differs');
  text(a.decisionId, 128); const observed = binding(r.observation); if (observed.path !== i.resultPath) fail('recovery observation path differs'); const o = await json(observed), actual = await sealedTargets(plan), upload = await loadUploadPlan(original.selectedPlan);
  if (nativeDeliveryCanonical(actual) !== nativeDeliveryCanonical(upload.targets)) fail('recovery signed artifact differs'); distributionObservation(o, plan, actual, original.operationId);
  if (r.status !== (o.status === 'available' ? 'distribution_available' : 'submitted_pending_review')) fail('recovered store state differs');
  return { receipt: { ...original, status: r.status as NativeReleaseReceipt['status'], observation: o, targets: actual, nativeSigningQualified: plan.evidenceClass === 'native_vendor' }, bindings: [b, rb, binding(r.inspection), binding(r.approval), binding(r.intent), observed, ...original.bindings] };
}
/** Pure signed-target identity parser. A file extension or these values are not signature/store proof. */
export function parseNativeSignedReleaseTargets(value: unknown): NativeSignedReleaseTarget[] {
  if (!Array.isArray(value)) fail('signed targets required');
  const base = targets(value.map(v => { const d = data(v); const { artifact: _artifact, artifactByteDigest: _digest, ...t } = d; return t; }));
  return base.map((t, i) => { const d = data(value[i], [...Object.keys(t), 'artifact', 'artifactByteDigest']), a = data(d.artifact, ['path', 'kind', 'digest', 'fileCount', 'sizeBytes']);
    if (a.path !== t.artifactPath || a.kind !== t.artifactKind || a.fileCount !== 1 || !Number.isSafeInteger(a.sizeBytes) || Number(a.sizeBytes) < 1 || Number(a.sizeBytes) > 512 * 1024 * 1024) fail('artifact seal identity');
    return { ...t, artifact: { path: t.artifactPath, kind: t.artifactKind, digest: sha(a.digest), fileCount: 1, sizeBytes: Number(a.sizeBytes) }, artifactByteDigest: sha(d.artifactByteDigest) };
  });
}
/** A completed actual release plus current read-only device/provider observation enter the existing adoption journal. */
export async function nativeReleaseObservationBasis(request: ProductBaselineObservationRequest, value: Data): Promise<LiveFileBinding[]> {
  const c = data(value, ['format', 'id', 'approved', 'releaseAuthority', 'productId', 'ownerId', 'workspacePath', 'expected', 'releasePlan', 'releaseReceipt', 'source', 'verificationConfiguration', 'evaluatorFiles', 'observerFiles']);
  if (c.format !== 'faktori.native-release-observation/v1' || c.approved !== true || c.releaseAuthority !== 'owner_native_distribution_observation' || c.productId !== request.productId || c.ownerId !== request.ownerId || c.workspacePath !== request.observer.cwd || nativeDeliveryCanonical(c.expected) !== nativeDeliveryCanonical(request.expected)) fail('exact separate owner native-distribution observation scope required');
  const pb = binding(c.releasePlan), rb = binding(c.releaseReceipt), plan = await loadPlan(pb), rawReceipt = await json(rb);
  await protectedPath(request.journalPath, plan.workspacePath); await protectedPath(request.receipts.configuration.path, plan.workspacePath);
  const recovered = rawReceipt.format === 'faktori.native-release-reconciliation/v1' ? await reconciliationBasis(rb, plan) : undefined;
  const receipt = recovered?.receipt ?? await validateReceipt(rb, plan);
  if (receipt.phase !== 'upload' || receipt.status !== 'distribution_available' || receipt.observation?.status !== 'available' || !receipt.targets || plan.evidenceClass === 'native_vendor' && !receipt.nativeSigningQualified) fail('pending, uncertain or unqualified store state cannot be adopted');
  const cfg = await json(plan.configuration), runtime = data(cfg.runtimeObserver);
  if (plan.productId !== request.productId || plan.ownerId !== request.ownerId || plan.candidateDigest !== request.expected.candidateDigest || plan.sourceRevision !== request.expected.sourceRevision || request.expected.nativeReleaseReceiptDigest !== rb.digest || request.expected.artifactDigest !== nativeDeliveryDigest(receipt.targets) || nativeDeliveryCanonical(request.expected.nativeReleasedTargets) !== nativeDeliveryCanonical(receipt.targets) || nativeDeliveryCanonical(request.expected.nativeBackend) !== nativeDeliveryCanonical(plan.backend) || request.expected.schemaRevision !== plan.backend.schemaRevision || nativeDeliveryCanonical(request.expected.supportedClients) !== nativeDeliveryCanonical(plan.supportedClients) || nativeDeliveryCanonical(request.expected.contracts) !== nativeDeliveryCanonical(plan.contracts)) fail('released candidate/artifact/client/backend identity differs');
  const production = plan.targets.every(t => ['app_store', 'play_production'].includes(t.track)), beta = plan.targets.every(t => !['app_store', 'play_production'].includes(t.track));
  const environment = plan.evidenceClass === 'synthetic_fixture' ? 'local_qualification' : production ? 'public_production' : beta ? 'beta_distribution' : undefined;
  if (!environment || request.environment !== environment) fail('fixture/beta/production distribution scope cannot be relabeled');
  if (request.receipts.artifact || request.receipts.loopArtifactsDirectory || nativeDeliveryCanonical(request.receipts.verification) !== nativeDeliveryCanonical(cfg.verification)) fail('native release cannot fabricate Lean/OCI receipts or substitute verification');
  for (const field of ['source', 'verificationConfiguration', 'evaluatorFiles', 'observerFiles']) if (nativeDeliveryCanonical(c[field]) !== nativeDeliveryCanonical(cfg[field])) fail('native release source/observer qualification differs');
  for (const field of ['identity', 'check', 'environment', 'limits']) if (nativeDeliveryCanonical(request.observer[field as keyof typeof request.observer]) !== nativeDeliveryCanonical(runtime[field])) fail('actual native release observer scope differs');
  const expectedPlatforms = plan.targets.map(t => t.platform); if (nativeDeliveryCanonical(request.expected.platforms) !== nativeDeliveryCanonical(expectedPlatforms)) fail('released platform set differs');
  return qualifiedNativeSourceBindings(c, request, [pb, rb, plan.configuration, receipt.approval, receipt.intent, ...receipt.bindings, ...(recovered?.bindings ?? [])]);
}
