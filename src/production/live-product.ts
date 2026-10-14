import { nativeDeliveryCanonical, parseNativeDeliveryIdentities, parseNativeBackendIdentity, validateNativeDeliveryConfiguration, type NativeDeliveryIdentity, type NativeBackendIdentity } from './native-delivery.ts';
import { nativeReleaseObservationBasis, parseNativeSignedReleaseTargets, type NativeSignedReleaseTarget } from './native-release.ts';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BoundedCommandRunner, persistPrivateProviderArtifact } from '../execution/transports.ts';
import { parseLeanLoopConfiguration } from '../loop/index.ts';
import { projectLoopDelivery } from '../loop/delivery.ts';
import { withOwnershipLock } from '../runtime/ownership-lock.ts';
import { prepareProductDiscoverySession, saveProductDiscoverySession, type ProductDiscoverySession } from './discovery-session.ts';
import type { ProductPlatform, ProductReference } from './discovery.ts';
import { captureCandidateSnapshot, parseCandidateVerificationConfiguration } from '../verification/index.ts';

export type ProductLiveEnvironment = 'local_qualification' | 'beta_distribution' | 'public_production';
export interface LiveFileBinding { path: string; digest: string }
export interface ProductLiveIdentity {
  productId: string;
  environment: ProductLiveEnvironment;
  candidateDigest: string;
  sourceRevision: string;
  artifactDigest: string;
  schemaRevision: string;
  targetOrigin?: string;
  resourceId?: string;
  releaseManifestDigest?: string;
  nativeTargets?: NativeDeliveryIdentity[];
  nativeBackend?: NativeBackendIdentity;
  nativeReleasedTargets?: NativeSignedReleaseTarget[];
  nativeReleaseReceiptDigest?: string;
}
interface ObserverCommand { command: string; args: string[] }
export interface ProductBaselineObservationRequest {
  format: 'faktori.product-baseline-observation/v1';
  profile?: 'managed_lean' | 'external_hosted' | 'native_local' | 'native_release';
  id: string; productId: string; ownerId: string; environment: ProductLiveEnvironment;
  journalPath: string; expectedParentDigest: string | null;
  receipts: { configuration: LiveFileBinding; verification: LiveFileBinding; artifact?: LiveFileBinding; loopArtifactsDirectory?: string };
  expected: ProductLiveIdentity & {
    sourceReference: string; artifactReference: string; platforms: ProductPlatform[];
    supportedClients: ProductReference[]; contracts: ProductReference[];
  };
  observer: {
    cwd: string; identity: ObserverCommand; check: ObserverCommand;
    environment: Record<string, string>;
    limits: { timeoutMs: number; outputMaxBytes: number };
    approval: { nativeAccessApproved: true; approvedBy: string; scope: 'read_only_target'; scopeDigest: string };
  };
}
export interface LiveProductObservation {
  id: string; productId: string; ownerId: string; environment: ProductLiveEnvironment;
  basis: 'qualified_local_runtime' | 'owner_recorded_delivery_and_observed_runtime' | 'externally_released_and_observed_runtime' | 'authorized_native_distribution_and_observed_runtime';
  status: 'passed' | 'failed';
  requestDigest: string;
  request: ProductBaselineObservationRequest;
  receiptBindings: LiveFileBinding[];
  identity?: ProductLiveIdentity;
  checks?: { authenticated: boolean; persistence: boolean; compatibility: boolean; recovery: boolean; outcome: boolean; outcomeText: string };
  artifactPaths: string[];
  artifactBindings: LiveFileBinding[];
  reason?: string;
  productionReady: false;
  nativeDelivery?: { format: 'faktori.native-local-characterization/v1'; configurationDigest: string; targets: NativeDeliveryIdentity[]; backend: NativeBackendIdentity; distributionQualified: false; factoryPublicationClaimed: false };
  nativeChecks?: { nativeUI: true; lifecycle: true; artifactIdentity: true; signingIdentity: true; backendCompatibility: true };
  nativeRelease?: { format: 'faktori.native-release-characterization/v1'; configurationDigest: string; receiptDigest: string; environment: ProductLiveEnvironment; targets: NativeSignedReleaseTarget[]; factoryPublicationClaimed: false };
  externalRelease?: { format: 'faktori.external-hosted-characterization/v1'; actor: 'faktori.live-product-controller/v1'; releaseId: string; configurationDigest: string; factoryPublicationClaimed: false };
}
export interface LiveProductAdoption {
  id: string; productId: string; ownerId: string; environment: ProductLiveEnvironment;
  observationId: string; observationDigest: string;
  authority: 'owner_adoption_only';
  productionReady: false;
}
export interface ProductLiveJournalEntry {
  format: 'faktori.product-live-journal/v1';
  id: string; kind: 'observation' | 'adoption' | 'increment'; productId: string;
  revision: number; previousDigest: string | null; digest: string;
  requestDigest: string; recordedAt: string;
  payload: LiveProductObservation | LiveProductAdoption | { session: ProductDiscoverySession; adoptionId: string; adoptionDigest: string; historyPath: string };
}
type Data = Record<string, unknown>;
const SHA = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ENV_KEYS = new Set(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'NO_COLOR']);
function fail(message: string): never { throw new Error(`Invalid live product: ${message}`); }
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const d = value as Data;
  return `{${Object.keys(d).filter(k => d[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(d[k])}`).join(',')}}`;
}
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`;
const bytesDigest = (bytes: string | Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function bound(value: unknown, depth = 0, budget = { nodes: 0 }, ancestors = new Set<object>()): void {
  if (++budget.nodes > 20000 || depth > 20) fail('input exceeds size/depth limit');
  if (typeof value === 'string' && Buffer.byteLength(value) > 1_000_000) fail('input string exceeds one megabyte');
  if (value === null || typeof value !== 'object') return;
  if (ancestors.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) fail('input must be acyclic plain JSON');
  if (Array.isArray(value) && value.length > 400) fail('input array exceeds bound');
  ancestors.add(value);
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!('value' in d)) fail('accessors are unsupported');
    bound(d.value, depth + 1, budget, ancestors);
  }
  ancestors.delete(value);
}
function object(value: unknown, fields: string[], label: string): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be plain JSON`);
  const d = value as Data;
  if (Object.keys(d).some(key => !fields.includes(key))) fail(`${label} contains unsupported fields`);
  return d;
}
function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`${label} requires bounded text`);
  if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i.test(value)) fail(`${label} must use a private credential reference rather than a secret value`);
  return value;
}
function id(value: unknown, label: string): string { const v = text(value, label, 120); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) fail(`${label} requires an identifier`); return v; }
function path(value: unknown, label: string): string { const v = text(value, label); if (!isAbsolute(v) || resolve(v) !== v) fail(`${label} requires canonical absolute path`); return v; }
function sha(value: unknown, label: string): string { const v = text(value, label, 71); if (!SHA.test(v)) fail(`${label} requires a SHA256 byte/record digest`); return v; }
function parent(value: unknown): string | null { return value === null ? null : sha(value, 'expectedParentDigest'); }
function platforms(value: unknown): ProductPlatform[] {
  if (!Array.isArray(value) || !value.length || value.length > 3 || new Set(value).size !== value.length || value.some(p => !['web', 'ios', 'android'].includes(p))) fail('platforms must identify distinct produced targets');
  return [...value] as ProductPlatform[];
}
function refs(value: unknown, label: string): ProductReference[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) fail(`${label} needs bounded versioned references`);
  return value.map(v => { const d = object(v, ['reference', 'revision'], label); return { reference: text(d.reference, `${label}.reference`), revision: text(d.revision, `${label}.revision`, 256) }; });
}
function fileBinding(value: unknown, label: string): LiveFileBinding { const d = object(value, ['path', 'digest'], label); return { path: path(d.path, `${label}.path`), digest: sha(d.digest, `${label}.digest`) }; }
function command(value: unknown): ObserverCommand {
  const d = object(value, ['command', 'args'], 'observer command');
  if (!Array.isArray(d.args) || d.args.length > 100) fail('observer argv is required');
  return { command: path(d.command, 'observer executable'), args: d.args.map((v, i) => typeof v === 'string' && !v.length ? '' : text(v, `observer argv ${i}`, 32000)) };
}
function parseObservation(value: unknown): ProductBaselineObservationRequest {
  bound(value);
  const d = object(value, ['format', 'profile', 'id', 'productId', 'ownerId', 'environment', 'journalPath', 'expectedParentDigest', 'receipts', 'expected', 'observer'], 'observation');
  if (d.format !== 'faktori.product-baseline-observation/v1' || !['local_qualification', 'beta_distribution', 'public_production'].includes(String(d.environment))) fail('observation format/environment is unsupported');
  if (d.profile !== undefined && d.profile !== 'managed_lean' && d.profile !== 'external_hosted' && d.profile !== 'native_local' && d.profile !== 'native_release') fail('unsupported release profile');
  const external = d.profile === 'external_hosted';
  const native = d.profile === 'native_local';
  const release = d.profile === 'native_release';
  if (!release && d.environment === 'beta_distribution') fail('beta distribution requires its separate native release profile');
  if (native && d.environment !== 'local_qualification') fail('native_local cannot claim public/store delivery');
  if (external && d.environment !== 'public_production') fail('external_hosted requires an already externally released public target');
  const r = object(d.receipts, ['configuration', 'verification', 'artifact', 'loopArtifactsDirectory'], 'receipts');
  const e = object(d.expected, ['productId', 'environment', 'candidateDigest', 'sourceRevision', 'artifactDigest', 'schemaRevision', 'sourceReference', 'artifactReference', 'platforms', 'supportedClients', 'contracts', ...(external ? ['targetOrigin', 'resourceId', 'releaseManifestDigest'] : []), ...(native ? ['nativeTargets', 'nativeBackend'] : []), ...(release ? ['nativeReleasedTargets', 'nativeBackend', 'nativeReleaseReceiptDigest'] : [])], 'expected runtime');
  const o = object(d.observer, ['cwd', 'identity', 'check', 'environment', 'limits', 'approval'], 'observer');
  const env = object(o.environment, [...ENV_KEYS, ...(release ? ['HOME'] : [])], 'observer environment');
  const a = object(o.approval, ['nativeAccessApproved', 'approvedBy', 'scope', 'scopeDigest'], 'observer approval');
  if (a.nativeAccessApproved !== true || a.scope !== 'read_only_target') fail('explicit approved native read-only-target observation is required');
  const limits = object(o.limits, ['timeoutMs', 'outputMaxBytes'], 'observer limits');
  if (!Number.isInteger(limits.timeoutMs) || Number(limits.timeoutMs) < 1 || Number(limits.timeoutMs) > 120000 || !Number.isInteger(limits.outputMaxBytes) || Number(limits.outputMaxBytes) < 1024 || Number(limits.outputMaxBytes) > 1000000) fail('observer limits are invalid');
  const sourceRevision = text(e.sourceRevision, 'sourceRevision', external || native || release ? 71 : 64);
  if (!COMMIT.test(sourceRevision) && !((external || native || release) && SHA.test(sourceRevision))) fail('sourceRevision requires an exact Git commit or external SHA256 source revision');
  const result: ProductBaselineObservationRequest = {
    format: d.format, ...(d.profile === undefined ? {} : { profile: d.profile as ProductBaselineObservationRequest['profile'] }), id: id(d.id, 'id'), productId: id(d.productId, 'productId'), ownerId: id(d.ownerId, 'ownerId'), environment: d.environment as ProductLiveEnvironment,
    journalPath: path(d.journalPath, 'journalPath'), expectedParentDigest: parent(d.expectedParentDigest),
    receipts: { configuration: fileBinding(r.configuration, 'configuration'), verification: fileBinding(r.verification, 'verification'), ...(r.artifact === undefined ? {} : { artifact: fileBinding(r.artifact, 'artifact') }), ...(r.loopArtifactsDirectory === undefined ? {} : { loopArtifactsDirectory: path(r.loopArtifactsDirectory, 'loopArtifactsDirectory') }) },
    expected: { productId: id(e.productId, 'expected.productId'), environment: e.environment as ProductLiveEnvironment, candidateDigest: sha(e.candidateDigest, 'candidateDigest'), sourceRevision, artifactDigest: sha(e.artifactDigest, 'artifactDigest'), schemaRevision: text(e.schemaRevision, 'schemaRevision', 256), sourceReference: text(e.sourceReference, 'sourceReference'), artifactReference: text(e.artifactReference, 'artifactReference'), platforms: platforms(e.platforms), supportedClients: refs(e.supportedClients, 'supportedClients'), contracts: refs(e.contracts, 'contracts'), ...(external ? { targetOrigin: httpsOrigin(e.targetOrigin), resourceId: text(e.resourceId, 'resourceId', 256), releaseManifestDigest: sha(e.releaseManifestDigest, 'releaseManifestDigest') } : {}), ...(native ? { nativeTargets: parseNativeDeliveryIdentities(e.nativeTargets), nativeBackend: parseNativeBackendIdentity(e.nativeBackend) } : {}), ...(release ? { nativeReleasedTargets: parseNativeSignedReleaseTargets(e.nativeReleasedTargets), nativeBackend: parseNativeBackendIdentity(e.nativeBackend), nativeReleaseReceiptDigest: sha(e.nativeReleaseReceiptDigest, 'nativeReleaseReceiptDigest') } : {}) },
    observer: { cwd: path(o.cwd, 'observer cwd'), identity: command(o.identity), check: command(o.check), environment: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, text(value, `observer environment ${key}`)])), limits: { timeoutMs: Number(limits.timeoutMs), outputMaxBytes: Number(limits.outputMaxBytes) }, approval: { nativeAccessApproved: true, approvedBy: text(a.approvedBy, 'approvedBy', 120), scope: 'read_only_target', scopeDigest: sha(a.scopeDigest, 'scopeDigest') } },
  };
  if (result.expected.productId !== result.productId || result.expected.environment !== result.environment || result.observer.approval.approvedBy !== result.ownerId) fail('runtime/owner approval identity mismatch');
  if (result.environment === 'local_qualification' && result.receipts.loopArtifactsDirectory) fail('local qualification cannot claim publication or public delivery receipts');
  if (external && result.receipts.loopArtifactsDirectory) fail('external releases cannot claim managed publication/delivery receipts');
  return result;
}
/** Nonexecuting digest of the complete owner-selected observer and receipt scope. */
export function productBaselineObservationScopeDigest(value: unknown): string {
  bound(value);
  const d = value as ProductBaselineObservationRequest;
  const { approval: _approval, ...observer } = d.observer;
  return digest({ ...(d.profile === undefined ? {} : { profile: d.profile }), productId: d.productId, ownerId: d.ownerId, environment: d.environment, receipts: d.receipts, expected: d.expected, observer });
}
function httpsOrigin(value: unknown): string {
  const v = text(value, 'targetOrigin'); let u: URL;
  try { u = new URL(v); } catch { fail('targetOrigin requires a fixed HTTPS origin'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.origin !== v) fail('targetOrigin requires a fixed absolute HTTPS origin without path or credentials');
  return v;
}
async function privateDirectory(value: string): Promise<void> {
  const s = await lstat(value);
  if (await realpath(value) !== value || !s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0) fail('journal and evidence directory must be canonical/private');
}
async function privateBytes(value: string, maximum = 8_000_000): Promise<Buffer> {
  if (await realpath(value) !== value) fail('receipt/journal path contains aliases');
  const f = await open(value, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await f.stat();
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0 || s.size > maximum) fail('receipt/journal must be bounded private unaliased regular file');
    const buffer = Buffer.alloc(s.size + 1); let length = 0;
    while (length < buffer.length) { const result = await f.read(buffer, length, buffer.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const bytes = buffer.subarray(0, length); const after = await f.stat(); const current = await lstat(value);
    if (bytes.length !== s.size || after.size !== s.size || after.mtimeMs !== s.mtimeMs || current.dev !== s.dev || current.ino !== s.ino) fail('receipt/journal changed during read');
    return bytes;
  } finally { await f.close(); }
}
function json(bytes: Buffer): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
async function boundFile(binding: LiveFileBinding): Promise<unknown> {
  const bytes = await validateBinding(binding);
  const value = json(bytes); bound(value); return value;
}
async function validateBinding(binding: LiveFileBinding): Promise<Buffer> {
  const bytes = await privateBytes(binding.path);
  if (bytesDigest(bytes) !== binding.digest) fail('receipt byte digest mismatch');
  return bytes;
}
/** Private append-only revision chain. Incomplete records are preserved and rejected. */
export async function readProductLiveJournal(value: string): Promise<ProductLiveJournalEntry[]> {
  const journal = path(value, 'journalPath'); await privateDirectory(dirname(journal));
  let bytes: Buffer;
  try { bytes = await privateBytes(journal); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!bytes.length || bytes.at(-1) !== 10) fail('incomplete journal; explicit recovery is required');
  const entries = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\n').map(line => JSON.parse(line) as ProductLiveJournalEntry);
  if (entries.length > 400) fail('journal exceeds 400 entries');
  const ids = new Set<string>();
  for (const [index, e] of entries.entries()) {
    bound(e); object(e, ['format', 'id', 'kind', 'productId', 'revision', 'previousDigest', 'digest', 'requestDigest', 'recordedAt', 'payload'], 'journal entry');
    const { digest: recorded, ...body } = e;
    if (e.format !== 'faktori.product-live-journal/v1' || !['observation', 'adoption', 'increment'].includes(e.kind) || e.revision !== index + 1 || e.previousDigest !== (entries[index - 1]?.digest ?? null) || recorded !== digest(body) || ids.has(e.id)) fail('invalid immutable journal revision chain');
    id(e.id, 'journal id'); id(e.productId, 'journal product'); sha(e.requestDigest, 'journal request');
    if (index && e.productId !== entries[0]!.productId) fail('journal cannot cross product identities');
    ids.add(e.id);
  }
  return entries;
}
async function append(journal: string, entries: ProductLiveJournalEntry[], id: string, kind: ProductLiveJournalEntry['kind'], productId: string, requestDigest: string, payload: ProductLiveJournalEntry['payload']): Promise<ProductLiveJournalEntry> {
  const body = { format: 'faktori.product-live-journal/v1' as const, id, kind, productId, revision: entries.length + 1, previousDigest: entries.at(-1)?.digest ?? null, requestDigest, recordedAt: new Date().toISOString(), payload };
  const entry = { ...body, digest: digest(body) }; const line = `${JSON.stringify(entry)}\n`;
  if (entries.length >= 400 || Buffer.byteLength(line) > 2_000_000) fail('journal entry/revision bound exceeded');
  const f = await open(journal, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const s = await f.stat(); const current = await lstat(journal);
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0 || current.dev !== s.dev || current.ino !== s.ino || s.size + Buffer.byteLength(line) > 8_000_000) fail('journal changed or exceeds bound');
    await f.writeFile(line); await f.sync();
  } finally { await f.close(); }
  return entry;
}
async function transaction<T>(journal: string, operation: (entries: ProductLiveJournalEntry[]) => Promise<T>): Promise<T> {
  await privateDirectory(dirname(journal));
  return withOwnershipLock(`${journal}.ownership`, async () => operation(await readProductLiveJournal(journal)));
}
async function capacity(journal: string, entries: ProductLiveJournalEntry[], reserve = 50000): Promise<void> {
  let size = 0; try { size = (await lstat(journal)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (entries.length >= 400 || size + reserve > 8_000_000) fail('journal capacity requires explicit archival before commands or discovery writes');
}
async function claim(journal: string, operationId: string, kind: ProductLiveJournalEntry['kind'], requestDigest: string, previousDigest: string | null): Promise<void> {
  const marker = join(dirname(journal), `.live-operation-${createHash('sha256').update(`${journal}:${operationId}`).digest('hex')}.json`);
  let f;
  try { f = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; fail('prior live operation is incomplete; preserve its intent and artifacts for explicit operator recovery, never automatically rerun'); }
  try { await f.writeFile(`${JSON.stringify({ operationId, kind, requestDigest, previousDigest, status: 'intended', recordedAt: new Date().toISOString() })}\n`); await f.sync(); }
  finally { await f.close(); }
  const directory = await open(dirname(journal), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
function current(entries: ProductLiveJournalEntry[], productId: string, expected: string | null): void {
  if ((entries.at(-1)?.digest ?? null) !== expected || entries.some(e => e.productId !== productId)) fail('stale journal parent or different product');
}
function replay(entries: ProductLiveJournalEntry[], id: string, kind: ProductLiveJournalEntry['kind'], requestDigest: string): ProductLiveJournalEntry | undefined {
  const previous = entries.find(e => e.id === id);
  if (previous && (previous.kind !== kind || previous.requestDigest !== requestDigest)) fail('conflicting retry identity');
  return previous;
}
async function receiptBasis(request: ProductBaselineObservationRequest): Promise<LiveFileBinding[]> {
  if (request.profile === 'native_release') return nativeReleaseObservationBasis(request, await boundFile(request.receipts.configuration) as Data);
  if (request.profile === 'external_hosted' || request.profile === 'native_local') return characterizedReceiptBasis(request);
  const config = parseLeanLoopConfiguration(await boundFile(request.receipts.configuration));
  if (config.approval.approved !== true || config.approval.approvedBy !== request.ownerId || config.workspace.path !== request.observer.cwd) fail('observer must use the existing owner-approved execution workspace');
  const v = await boundFile(request.receipts.verification) as Data;
  if (v.format !== 'faktori.candidate-verification-result/v1' || v.passed !== true || v.status !== 'passed' || v.candidateDigest !== request.expected.candidateDigest || v.executionBoundary !== 'owner_trusted_native' || !Array.isArray(v.scenarios) || !v.scenarios.length || v.scenarios.some(s => !s || typeof s !== 'object' || (s as Data).passed !== true || (s as Data).cleanup !== 'confirmed')) fail('matching completed existing candidate-runtime verification is required');
  const result = [request.receipts.configuration, request.receipts.verification];
  if (request.environment === 'public_production') {
    if (!request.receipts.loopArtifactsDirectory || !request.receipts.artifact) fail('public adoption requires existing publication/delivery and exact sealed released-artifact evidence');
    if (request.receipts.artifact.digest !== request.expected.artifactDigest) fail('released artifact must match observed runtime artifact digest');
    const artifactBytes = await privateBytes(request.receipts.artifact.path);
    if (bytesDigest(artifactBytes) !== request.receipts.artifact.digest) fail('released artifact bytes changed');
    const files = await Promise.all(['state.json', 'publication.json', 'delivery.json'].map(async name => {
      const p = join(request.receipts.loopArtifactsDirectory!, name); const bytes = await privateBytes(p);
      return { binding: { path: p, digest: bytesDigest(bytes) }, value: json(bytes) };
    }));
    const state = files[0]!.value as Data, publication = files[1]!.value as Data;
    const summary = projectLoopDelivery(state, publication, files[2]!.value);
    const delivery = files[2]!.value as Data;
    const gates = delivery.gates as Data[];
    if (summary.issue || summary.gates.some(g => g.status !== 'passed') || gates.find(g => g.id === 'deployment')?.deployedRevision !== request.expected.sourceRevision || gates.find(g => g.id === 'staging_verification')?.acceptedRevision !== request.expected.sourceRevision) fail('public release chain must pass at the observed source revision');
    // Configuration identity and the controller's sealed dependency set join
    // snapshot-verification and artifact byte hashes to the accepted workspace
    // evidence. These hash families must never be equated to one another.
    if (config.artifactsDirectory !== request.receipts.loopArtifactsDirectory || state.loopId !== config.loopId || state.configDigest !== digest(config).slice(7)) fail('public release chain belongs to a different loop or approved configuration');
    const accepted = (state.lean as Data | undefined)?.acceptance as Data | undefined;
    const evidence = accepted?.evidence as Data | undefined;
    const acceptedCandidate = evidence?.candidate as Data | undefined;
    const publishedLoop = publication.loop as Data | undefined;
    if (accepted?.format !== 'faktori.lean-acceptance-receipt/v1' || accepted.accepted !== true || accepted.loopId !== config.loopId || stable(accepted.actor) !== stable({ kind: 'deterministic', id: 'faktori.lean.accept/v1' }) || publishedLoop?.loopId !== config.loopId || acceptedCandidate?.contentDigest !== publishedLoop?.acceptedEvidenceDigest || evidence?.baseRevision !== config.candidate.baseRevision || stable(evidence?.dependencies) !== stable(config.candidate.dependencies) || evidence?.requirementsDigest !== digest(config.requirements)) fail('public release lacks exact controller acceptance/configuration/candidate binding');
    const stages = Array.isArray(state.stages) ? state.stages as Data[] : [];
    const acceptedStage = stages.find(stage => stage.kind === 'deterministic_accept' && stage.stageId === accepted.stageId);
    if (!acceptedStage || stable((acceptedStage.response as Data | undefined)?.receipt) !== stable(accepted) || publishedLoop?.managerAcceptanceStageId !== accepted.stageId || evidence.verificationDigest !== digest(acceptedStage.verification)) fail('public acceptance must be the exact sealed controller stage and verification payload');
    for (const [identifier, binding] of [['live-runtime-verification', request.receipts.verification], ['live-release-artifact', request.receipts.artifact]] as const) {
      if (!config.candidate.dependencies.some(dependency => dependency.id === identifier && dependency.kind === 'file' && dependency.path === binding.path && dependency.digest === binding.digest)) fail('runtime verification and artifact must be exact sealed acceptance file dependencies');
    }
    result.push(request.receipts.artifact);
    result.push(...files.map(f => f.binding));
  }
  return result;
}
/** Owner declarations characterize an external release; only native observations qualify its runtime. */
function invokedCode(command: ObserverCommand, cwd: string): string {
  // This runtime's Node executable is the only qualified interpreter. Other
  // commands must seal the executable itself, never an incidental argv value.
  if (command.command !== process.execPath) return command.command;
  const script = command.args[0];
  if (!script || script.startsWith('-')) fail('qualified Node invocation requires the actual script at argv[0], without eval/import flags or wrappers');
  return resolve(cwd, script);
}
async function characterizedReceiptBasis(request: ProductBaselineObservationRequest): Promise<LiveFileBinding[]> {
  const native = request.profile === 'native_local';
  const c = object(await boundFile(request.receipts.configuration), ['format', 'id', 'productId', 'ownerId', 'approved', 'releaseAuthority', 'workspacePath', 'expected', 'source', 'verificationConfiguration', 'evaluatorFiles', 'observerFiles', ...(native ? ['definition', 'design', 'designApproval', 'artifacts'] : ['manifest'])], 'characterized release');
  let extraBindings: LiveFileBinding[] = [];
  if (native) {
    extraBindings = await validateNativeDeliveryConfiguration(c, request, boundFile);
  } else {
  if (c.format !== 'faktori.external-hosted-release/v1' || c.approved !== true || c.releaseAuthority !== 'owner_recorded_external_release' || c.productId !== request.productId || c.ownerId !== request.ownerId || c.workspacePath !== request.observer.cwd || stable(c.expected) !== stable(request.expected)) fail('external release requires exact separate owner-approved source/target/client characterization');
  id(c.id, 'external release id');
  if (!request.receipts.artifact || request.receipts.artifact.digest !== request.expected.artifactDigest) fail('external release requires exact image configuration bytes');
  const artifact = object(await boundFile(request.receipts.artifact), ['architecture', 'author', 'config', 'container', 'container_config', 'created', 'docker_version', 'history', 'os', 'rootfs', 'variant'], 'OCI image configuration');
  if (typeof artifact.architecture !== 'string' || artifact.os !== 'linux' || !artifact.rootfs || !artifact.config) fail('external artifact must be an OCI/Docker image configuration, not a registry manifest');
  const manifestBinding = fileBinding(c.manifest, 'external manifest');
  if (manifestBinding.digest !== request.expected.releaseManifestDigest) fail('immutable release manifest differs from requested target');
  const manifest = object(await boundFile(manifestBinding), ['schemaVersion', 'mediaType', 'config', 'layers', 'annotations', 'subject', 'artifactType'], 'OCI manifest');
  const descriptor = object(manifest.config, ['mediaType', 'size', 'digest', 'urls', 'annotations', 'data', 'platform', 'artifactType'], 'OCI image descriptor');
  if (manifest.schemaVersion !== 2 || !['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(String(manifest.mediaType)) || !['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'].includes(String(descriptor.mediaType)) || descriptor.digest !== request.expected.artifactDigest || descriptor.size !== (await validateBinding(request.receipts.artifact)).length || !Array.isArray(manifest.layers)) fail('OCI manifest must bind the exact image config digest and byte size');
  extraBindings = [request.receipts.artifact, manifestBinding];
  }
  return qualifiedNativeSourceBindings(c, request, extraBindings);
}
/** Shared existing native-verifier/source proof; does not grant signing or upload authority. */
export async function qualifiedNativeSourceBindings(c: Record<string, unknown>, request: ProductBaselineObservationRequest, extraBindings: LiveFileBinding[] = []): Promise<LiveFileBinding[]> {
  const source = object(c.source, ['candidatePath', 'files'], 'external source');
  const candidatePath = path(source.candidatePath, 'external candidate path');
  if (await realpath(candidatePath) !== candidatePath) fail('external candidate path contains aliases');
  if (!Array.isArray(source.files) || !source.files.length || source.files.length > 300) fail('external source requires bounded exact file provenance');
  const files = source.files.map(v => fileBinding(v, 'external source file'));
  if (new Set(files.map(f => f.path)).size !== files.length || files.some(f => !f.path.startsWith(`${candidatePath}/`))) fail('source bindings must identify distinct files inside the exact candidate');
  const verificationConfiguration = fileBinding(c.verificationConfiguration, 'native verification configuration');
  const vc = parseCandidateVerificationConfiguration(await boundFile(verificationConfiguration));
  if (vc.execution.approvedBy !== request.ownerId || vc.candidate.path !== candidatePath || vc.candidate.expectedDigest !== request.expected.candidateDigest || !vc.negativeControls.length) fail('external native verification must bind this owner, source candidate and negative controls');
  if (!Array.isArray(c.evaluatorFiles) || !c.evaluatorFiles.length || c.evaluatorFiles.length > 100) fail('protected evaluator file bindings are required');
  const evaluators = c.evaluatorFiles.map(v => fileBinding(v, 'protected evaluator'));
  if (vc.environment.NODE_OPTIONS !== undefined || vc.environment.NODE_PATH !== undefined || vc.negativeControls.some(control => control.environment.NODE_OPTIONS !== undefined || control.environment.NODE_PATH !== undefined)) fail('external qualification cannot use Node preload or module-path environment overrides');
  if (new Set(evaluators.map(f => f.path)).size !== evaluators.length || evaluators.some(f => !files.some(sourceFile => sourceFile.path === f.path && sourceFile.digest === f.digest)) || !evaluators.some(f => invokedCode(vc.check, candidatePath) === f.path)) fail('native check must actually invoke a sealed evaluator included in the verified source snapshot');
  if (!Array.isArray(c.observerFiles) || !c.observerFiles.length || c.observerFiles.length > 100) fail('sealed observer code file bindings are required');
  const observers = c.observerFiles.map(v => fileBinding(v, 'observer code'));
  if (new Set(observers.map(f => f.path)).size !== observers.length || [request.observer.identity, request.observer.check].some(command => !observers.some(f => invokedCode(command, request.observer.cwd) === f.path))) fail('both actual observer commands must invoke sealed code files');
  const v = object(await boundFile(request.receipts.verification), ['format', 'candidateDigest', 'configurationDigest', 'status', 'passed', 'reason', 'snapshot', 'scenarios', 'executionBoundary', 'recoveryDirectory', 'outputDigest'], 'native verification result');
  const { outputDigest, ...verificationBody } = v;
  if (v.format !== 'faktori.candidate-verification-result/v1' || v.passed !== true || v.status !== 'passed' || v.reason !== undefined || v.recoveryDirectory !== undefined || v.executionBoundary !== 'owner_trusted_native' || v.candidateDigest !== request.expected.candidateDigest || v.configurationDigest !== bytesDigest(JSON.stringify(vc)) || outputDigest !== bytesDigest(JSON.stringify(verificationBody)) || !Array.isArray(v.scenarios)) fail('external release requires the exact qualified native verifier result/configuration, never a declared pass');
  const expectedScenarios = ['healthy', ...vc.negativeControls.map(control => control.id)];
  if (v.scenarios.length !== expectedScenarios.length || v.scenarios.some((s, index) => !s || typeof s !== 'object' || (s as Data).id !== expectedScenarios[index] || (s as Data).passed !== true || (s as Data).cleanup !== 'confirmed')) fail('external verification must complete every healthy and seeded-negative scenario with cleanup');
  const bindings = [request.receipts.configuration, request.receipts.verification, ...extraBindings, verificationConfiguration, ...files, ...evaluators, ...observers];
  for (const binding of bindings) await validateBinding(binding);
  const snapshot = await captureCandidateSnapshot(candidatePath);
  if (snapshot.candidateDigest !== request.expected.candidateDigest || snapshot.fileCount !== files.length || stable(v.snapshot) !== stable(snapshot)) fail('qualified source snapshot and complete file provenance changed');
  return bindings;
}
async function validateObservationEvidence(observation: LiveProductObservation): Promise<void> {
  for (const binding of [...observation.receiptBindings, ...observation.artifactBindings]) await validateBinding(binding);
  if ((observation.request.profile === 'external_hosted' || observation.request.profile === 'native_local' || observation.request.profile === 'native_release') && stable(await receiptBasis(observation.request)) !== stable(observation.receiptBindings)) fail('external characterization dependency set changed');
}
function identity(value: unknown, request: ProductBaselineObservationRequest): ProductLiveIdentity {
  const extra = request.profile === 'external_hosted' ? ['targetOrigin', 'resourceId', 'releaseManifestDigest'] : request.profile === 'native_local' ? ['nativeTargets', 'nativeBackend'] : request.profile === 'native_release' ? ['nativeReleasedTargets', 'nativeBackend', 'nativeReleaseReceiptDigest'] : [];
  const d = object(value, ['format', 'productId', 'environment', 'candidateDigest', 'sourceRevision', 'artifactDigest', 'schemaRevision', ...extra], 'observed identity');
  const expected = request.expected;
  if (d.format !== 'faktori.product-live-identity/v1') fail('observer identity format mismatch');
  for (const key of ['productId', 'environment', 'candidateDigest', 'sourceRevision', 'artifactDigest', 'schemaRevision'] as const) if (d[key] !== expected[key]) fail('actual runtime identity differs from the adopted candidate/source/schema');
  for (const key of extra) if (nativeDeliveryCanonical(d[key]) !== nativeDeliveryCanonical((expected as unknown as Data)[key])) fail('actual external target origin/resource/immutable manifest mismatch');
  return { productId: expected.productId, environment: expected.environment, candidateDigest: expected.candidateDigest, sourceRevision: expected.sourceRevision, artifactDigest: expected.artifactDigest, schemaRevision: expected.schemaRevision, ...(request.profile === 'external_hosted' ? { targetOrigin: expected.targetOrigin, resourceId: expected.resourceId, releaseManifestDigest: expected.releaseManifestDigest } : {}), ...(request.profile === 'native_local' ? { nativeTargets: expected.nativeTargets, nativeBackend: expected.nativeBackend } : {}), ...(request.profile === 'native_release' ? { nativeReleasedTargets: expected.nativeReleasedTargets, nativeBackend: expected.nativeBackend, nativeReleaseReceiptDigest: expected.nativeReleaseReceiptDigest } : {}) };
}
async function runObserver(request: ProductBaselineObservationRequest, command: ObserverCommand): Promise<unknown> {
  const result = await new BoundedCommandRunner().run({ ...command, cwd: request.observer.cwd, env: request.observer.environment, timeoutMs: request.observer.limits.timeoutMs, stdoutMaxBytes: request.observer.limits.outputMaxBytes, stderrMaxBytes: request.observer.limits.outputMaxBytes });
  if (result.exitCode !== 0 || result.signal || result.timedOut || result.outputLimitExceeded || result.spawnError) fail('bounded observer command failed or became uncertain');
  const value: unknown = JSON.parse(result.stdout); bound(value); return value;
}
async function observe(request: ProductBaselineObservationRequest): Promise<{ identity: ProductLiveIdentity; checks: NonNullable<LiveProductObservation['checks']>; nativeChecks?: LiveProductObservation['nativeChecks'] }> {
  const first = identity(await runObserver(request, request.observer.identity), request);
  const c = object(await runObserver(request, request.observer.check), ['format', 'productId', 'environment', 'candidateDigest', 'sourceRevision', 'artifactDigest', 'schemaRevision', 'checks', ...(request.profile === 'external_hosted' ? ['targetOrigin', 'resourceId', 'releaseManifestDigest'] : []), ...(request.profile === 'native_local' ? ['nativeTargets', 'nativeBackend', 'nativeChecks'] : []), ...(request.profile === 'native_release' ? ['nativeReleasedTargets', 'nativeBackend', 'nativeReleaseReceiptDigest', 'nativeChecks'] : [])], 'runtime check');
  const checks = object(c.checks, ['authenticated', 'persistence', 'compatibility', 'recovery', 'outcome', 'outcomeText'], 'runtime checks');
  if (c.format !== 'faktori.product-live-check/v1' || ['authenticated', 'persistence', 'compatibility', 'recovery', 'outcome'].some(key => checks[key] !== true)) fail('authenticated/persistence/compatibility/recovery/outcome observations must all pass');
  if (request.profile === 'native_local' || request.profile === 'native_release') {
    const nativeChecks = object(c.nativeChecks, ['nativeUI', 'lifecycle', 'artifactIdentity', 'signingIdentity', 'backendCompatibility'], 'native runtime checks');
    if (['nativeUI', 'lifecycle', 'artifactIdentity', 'signingIdentity', 'backendCompatibility'].some(key => nativeChecks[key] !== true)) fail('native runtime checks must all pass');
  }
  const { checks: _checks, nativeChecks: _nativeChecks, ...checkIdentity } = c;
  identity({ ...checkIdentity, format: 'faktori.product-live-identity/v1' }, request);
  identity(await runObserver(request, request.observer.identity), request);
  return { identity: first, checks: { authenticated: true, persistence: true, compatibility: true, recovery: true, outcome: true, outcomeText: text(checks.outcomeText, 'observed outcome', 8000) }, ...(['native_local', 'native_release'].includes(request.profile ?? '') ? { nativeChecks: { nativeUI: true as const, lifecycle: true as const, artifactIdentity: true as const, signingIdentity: true as const, backendCompatibility: true as const } } : {}) };
}
/** Runs only the separately approved bounded observer; never deploys or grants release authority. */
export async function observeProductBaseline(value: unknown): Promise<LiveProductObservation> {
  const request = parseObservation(value);
  if (request.observer.approval.scopeDigest !== productBaselineObservationScopeDigest(request)) fail('observer authority does not bind the exact command/receipt/runtime scope');
  const requestDigest = digest(request);
  return transaction(request.journalPath, async entries => {
    const previous = replay(entries, request.id, 'observation', requestDigest);
    if (previous) { const payload = previous.payload as LiveProductObservation; await validateObservationEvidence(payload); return payload; }
    current(entries, request.productId, request.expectedParentDigest);
    await capacity(request.journalPath, entries, Buffer.byteLength(JSON.stringify(request)) + 50000);
    const receiptBindings = await receiptBasis(request);
    if (request.profile === 'external_hosted' || request.profile === 'native_local' || request.profile === 'native_release') {
      const reserve = Buffer.byteLength(JSON.stringify(request)) + Buffer.byteLength(JSON.stringify(receiptBindings)) + 50000;
      if (reserve > 2_000_000) fail('external observation exceeds the bounded journal entry before commands');
      await capacity(request.journalPath, entries, reserve);
    }
    await claim(request.journalPath, request.id, 'observation', requestDigest, entries.at(-1)?.digest ?? null);
    let observed: Awaited<ReturnType<typeof observe>> | undefined; let reason: string | undefined;
    try { observed = await observe(request); } catch { reason = 'approved runtime observer failed; retained source/receipt bindings were not promoted'; }
    // Re-read all inputs after the command effects before recording any result.
    for (const binding of receiptBindings) await validateBinding(binding);
    if ((request.profile === 'external_hosted' || request.profile === 'native_local' || request.profile === 'native_release') && stable(await receiptBasis(request)) !== stable(receiptBindings)) fail('external release changed after observer');
    const externalRelease = request.profile === 'external_hosted' ? { format: 'faktori.external-hosted-characterization/v1' as const, actor: 'faktori.live-product-controller/v1' as const, releaseId: id((await boundFile(request.receipts.configuration) as Data).id, 'external release id'), configurationDigest: request.receipts.configuration.digest, factoryPublicationClaimed: false as const } : undefined;
    const nativeDelivery = request.profile === 'native_local' ? { format: 'faktori.native-local-characterization/v1' as const, configurationDigest: request.receipts.configuration.digest, targets: request.expected.nativeTargets!, backend: request.expected.nativeBackend!, distributionQualified: false as const, factoryPublicationClaimed: false as const } : undefined;
    const nativeRelease = request.profile === 'native_release' ? { format: 'faktori.native-release-characterization/v1' as const, configurationDigest: request.receipts.configuration.digest, receiptDigest: request.expected.nativeReleaseReceiptDigest!, environment: request.environment, targets: request.expected.nativeReleasedTargets!, factoryPublicationClaimed: false as const } : undefined;
    const evidenceDirectory = join(dirname(request.journalPath), `live-observation-${randomUUID()}`); await mkdir(evidenceDirectory, { mode: 0o700 });
    const artifact = await persistPrivateProviderArtifact(evidenceDirectory, [request.id], { requestDigest, observed, reason, ...(externalRelease ? { externalRelease, expected: request.expected, receiptBindings, observerAuthority: request.observer.approval } : {}), ...(nativeDelivery ? { nativeDelivery, expected: request.expected, receiptBindings, observerAuthority: request.observer.approval } : {}), ...(nativeRelease ? { nativeRelease, expected: request.expected, receiptBindings, observerAuthority: request.observer.approval } : {}), capture: 'validated observer JSON; no inherited credentials or stderr persisted' });
    const observation: LiveProductObservation = { id: request.id, productId: request.productId, ownerId: request.ownerId, environment: request.environment, basis: request.environment === 'local_qualification' ? 'qualified_local_runtime' : request.profile === 'external_hosted' ? 'externally_released_and_observed_runtime' : request.profile === 'native_release' ? 'authorized_native_distribution_and_observed_runtime' : 'owner_recorded_delivery_and_observed_runtime', status: observed ? 'passed' : 'failed', requestDigest, request, receiptBindings, ...(observed ?? {}), ...(externalRelease ? { externalRelease } : {}), ...(nativeDelivery ? { nativeDelivery } : {}), ...(nativeRelease ? { nativeRelease } : {}), artifactPaths: [artifact], artifactBindings: [{ path: artifact, digest: bytesDigest(await privateBytes(artifact)) }], ...(reason ? { reason } : {}), productionReady: false };
    await append(request.journalPath, entries, request.id, 'observation', request.productId, requestDigest, observation);
    return observation;
  });
}
/** Explicit durable adoption; local qualification remains local even after acceptance. */
export async function adoptProductBaseline(value: unknown): Promise<LiveProductAdoption> {
  bound(value); const d = object(value, ['format', 'id', 'productId', 'ownerId', 'journalPath', 'observationId', 'expectedParentDigest', 'approved'], 'adoption');
  if (d.format !== 'faktori.product-baseline-adoption/v1' || d.approved !== true) fail('explicit owner baseline adoption is required');
  const journal = path(d.journalPath, 'journalPath'), productId = id(d.productId, 'productId'), ownerId = id(d.ownerId, 'ownerId'), adoptionId = id(d.id, 'id'), observationId = id(d.observationId, 'observationId');
  const requestDigest = digest(d);
  return transaction(journal, async entries => {
    const previous = replay(entries, adoptionId, 'adoption', requestDigest); if (previous) {
      const adopted = previous.payload as LiveProductAdoption;
      const observed = entries.find(e => e.id === adopted.observationId && e.digest === adopted.observationDigest)?.payload as LiveProductObservation | undefined;
      if ((observed?.request.profile === 'external_hosted' || observed?.request.profile === 'native_local' || observed?.request.profile === 'native_release')) await validateObservationEvidence(observed);
      return adopted;
    }
    current(entries, productId, parent(d.expectedParentDigest));
    await capacity(journal, entries);
    const entry = entries.find(e => e.id === observationId && e.kind === 'observation');
    const observation = entry?.payload as LiveProductObservation | undefined;
    if (!entry || observation?.status !== 'passed' || observation.productId !== productId || observation.ownerId !== ownerId) fail('adoption requires a matching passed owner runtime observation');
    await validateObservationEvidence(observation);
    await claim(journal, adoptionId, 'adoption', requestDigest, entries.at(-1)?.digest ?? null);
    await observe(observation.request);
    await validateObservationEvidence(observation);
    const adoption: LiveProductAdoption = { id: adoptionId, productId, ownerId, environment: observation.environment, observationId, observationDigest: entry.digest, authority: 'owner_adoption_only', productionReady: false };
    await append(journal, entries, adoptionId, 'adoption', productId, requestDigest, adoption); return adoption;
  });
}
/** Owner-requested next cycle; never selects priorities or manufactures owner answers. */
export async function beginProductIncrement(value: unknown): Promise<ProductDiscoverySession> {
  bound(value); const d = object(value, ['format', 'id', 'productId', 'ownerId', 'journalPath', 'adoptionId', 'expectedParentDigest', 'sessionId', 'historyPath', 'rawIdea', 'ideaSource', 'platforms'], 'increment');
  if (d.format !== 'faktori.product-increment-start/v1') fail('increment format is unsupported');
  const journal = path(d.journalPath, 'journalPath'), productId = id(d.productId, 'productId'), ownerId = id(d.ownerId, 'ownerId'), incrementId = id(d.id, 'id'), adoptionId = id(d.adoptionId, 'adoptionId'), historyPath = path(d.historyPath, 'historyPath');
  const requestDigest = digest(d);
  return transaction(journal, async entries => {
    const previous = replay(entries, incrementId, 'increment', requestDigest); if (previous) {
      const prior = previous.payload as { session: ProductDiscoverySession; adoptionId: string; adoptionDigest: string };
      const adopted = entries.find(e => e.id === prior.adoptionId && e.digest === prior.adoptionDigest)?.payload as LiveProductAdoption | undefined;
      const observed = adopted && entries.find(e => e.id === adopted.observationId && e.digest === adopted.observationDigest)?.payload as LiveProductObservation | undefined;
      if ((observed?.request.profile === 'external_hosted' || observed?.request.profile === 'native_local' || observed?.request.profile === 'native_release')) await validateObservationEvidence(observed);
      return prior.session;
    }
    current(entries, productId, parent(d.expectedParentDigest));
    await capacity(journal, entries);
    const adoptions = entries.filter(e => e.kind === 'adoption'); const adopted = adoptions.at(-1);
    if (!adopted || adopted.id !== adoptionId) fail('next increment must use the current adopted baseline');
    const adoption = adopted.payload as LiveProductAdoption;
    if (adoption.ownerId !== ownerId) fail('next increment owner differs from baseline owner');
    const observationEntry = entries.find(e => e.id === adoption.observationId && e.digest === adoption.observationDigest);
    if (!observationEntry) fail('adopted observation is missing');
    const observation = observationEntry.payload as LiveProductObservation;
    await validateObservationEvidence(observation);
    await claim(journal, incrementId, 'increment', requestDigest, entries.at(-1)?.digest ?? null);
    await observe(observation.request);
    await validateObservationEvidence(observation);
    const expected = observation.request.expected;
    const source = { reference: `file:${journal}#${observationEntry.id}`, revision: observationEntry.digest };
    const ideaSource = object(d.ideaSource, ['reference', 'revision'], 'owner idea source');
    const session = prepareProductDiscoverySession({ sessionId: id(d.sessionId, 'sessionId'), productId, ownerId, rawIdea: text(d.rawIdea, 'owner feature', 8000), ideaSource: { reference: text(ideaSource.reference, 'owner idea reference'), revision: text(ideaSource.revision, 'owner idea revision', 256) }, platforms: d.platforms === undefined ? expected.platforms : platforms(d.platforms), existingProduct: {
      baseline: { reference: expected.sourceReference, revision: expected.sourceRevision }, deployedArtifact: { reference: expected.artifactReference, revision: expected.artifactDigest },
      notes: [
        { text: `Baseline environment: ${observation.environment}; evidence basis: ${observation.basis}. No publication, release or new feature approval is inherited.`, source },
        { text: `Preserve supported clients: ${stable(expected.supportedClients)}; contracts: ${stable(expected.contracts)}; schema revision: ${expected.schemaRevision}.`, source },
        ...(observation.nativeDelivery ? [{ text: `Native local qualification only: ${stable(observation.nativeDelivery)}. Physical devices, production signing and distribution are not qualified.`, source }] : []),
        ...(observation.nativeRelease ? [{ text: `Owner-authorized native distribution baseline: ${stable(observation.nativeRelease)}; backend: ${stable(expected.nativeBackend)}. Preserve exact app/build/publisher/signing/track, artifact and client/backend compatibility. Beta distribution remains beta; synthetic qualification remains local. No signing, upload, store review acceptance or next release authority is inherited.`, source }] : []),
        { text: `Prior observed evaluator outcome (not an owner-selected priority): ${observation.checks!.outcomeText}`, source },
      ],
    } });
    await saveProductDiscoverySession(historyPath, session);
    await append(journal, entries, incrementId, 'increment', productId, requestDigest, { session, adoptionId, adoptionDigest: adopted.digest, historyPath }); return session;
  });
}
