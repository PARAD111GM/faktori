import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { inspectProductDefinition } from './discovery.ts';
import { inspectProductDesign, serializeProductDesign } from './design.ts';
import type { LiveFileBinding, ProductBaselineObservationRequest } from './live-product.ts';

export interface NativeArtifactSeal {
  path: string;
  kind: 'ios_app_directory' | 'android_apk_file';
  digest: string;
  fileCount: number;
  sizeBytes: number;
}
export interface NativeDeliveryIdentity {
  platform: 'ios' | 'android';
  applicationId: string;
  buildVersion: string;
  nativeRuntimeVersion: string;
  operatingSystemVersion: string;
  executionTarget: 'ios_simulator' | 'android_emulator';
  signing: 'ad_hoc_simulator' | 'android_debug' | 'unsigned';
  distribution: 'local_only';
  artifactDigest: string;
}
export interface NativeBackendIdentity {
  origin: string;
  artifactDigest: string;
  schemaRevision: string;
  contractRevision: string;
}
type Data = Record<string, unknown>;
export function nativeDeliveryCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(nativeDeliveryCanonical).join(',')}]`;
  const d = value as Data;
  return `{${Object.keys(d).filter(k => d[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${nativeDeliveryCanonical(d[k])}`).join(',')}}`;
}
export const nativeDeliveryDigest = (value: unknown): string => `sha256:${createHash('sha256').update(nativeDeliveryCanonical(value)).digest('hex')}`;
function fail(reason: string): never { throw new Error(`Invalid native delivery: ${reason}`); }
function object(value: unknown, keys: string[]): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('plain JSON required');
  const d = value as Data;
  if (Object.keys(d).some(k => !keys.includes(k)) || keys.some(k => !(k in d))) fail('exact fields required');
  return d;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value)) fail('bounded text required');
  if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i.test(value)) fail('credential references required instead of secrets');
  return value;
}
function sha(value: unknown): string { const s = text(value); if (!/^sha256:[a-f0-9]{64}$/.test(s)) fail('SHA256 required'); return s; }
function canonicalPath(value: unknown): string { const s = text(value); if (!isAbsolute(s) || resolve(s) !== s) fail('canonical absolute path required'); return s; }
function binding(value: unknown): LiveFileBinding { const d = object(value, ['path', 'digest']); return { path: canonicalPath(d.path), digest: sha(d.digest) }; }
function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.nlink === after.nlink && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
const MAX_FILE = 512 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_ENTRIES = 20000;
/** Read-only seal. No signing, installation, device execution or release occurs. */
export async function captureNativeArtifact(value: unknown): Promise<NativeArtifactSeal> {
  const d = object(value, ['path', 'kind']);
  const root = canonicalPath(d.path);
  if (d.kind !== 'ios_app_directory' && d.kind !== 'android_apk_file') fail('unsupported native artifact kind');
  if (await realpath(root) !== root) fail('artifact alias');
  const entries: Array<{ path: string; kind: string; mode: number; size?: number; digest?: string }> = [];
  const identities: Array<{ path: string; stat: Stats }> = [];
  let total = 0, files = 0;
  const deadline = Date.now() + 120000;
  async function visit(path: string, name: string): Promise<void> {
    if (entries.length >= MAX_ENTRIES || Date.now() > deadline) fail('artifact entry/time limit');
    const named = await lstat(path); identities.push({ path, stat: named });
    if (named.isSymbolicLink()) fail('artifact symlink');
    if (named.isDirectory()) {
      entries.push({ path: name, kind: 'directory', mode: named.mode & 0o777 });
      for (const child of (await readdir(path)).sort()) {
        if (/[\x00-\x1f]/.test(child)) fail('invalid artifact name');
        await visit(join(path, child), name ? `${name}/${child}` : child);
      }
      return;
    }
    if (!named.isFile() || named.nlink !== 1 || named.size > MAX_FILE || total + named.size > MAX_TOTAL) fail('artifact regular-file/size bound');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!unchanged(named, before) || !before.isFile()) fail('artifact replaced before read');
      const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024); let count = 0;
      while (true) {
        if (Date.now() > deadline) fail('artifact time limit');
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
        if (!bytesRead) break;
        count += bytesRead;
        if (count > MAX_FILE || count > before.size) fail('artifact grew while read');
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (count !== before.size || !unchanged(before, await handle.stat()) || !unchanged(before, await lstat(path))) fail('artifact changed while read');
      entries.push({ path: name, kind: 'file', mode: before.mode & 0o777, size: count, digest: `sha256:${hash.digest('hex')}` });
      total += count; files++;
    } finally { await handle.close(); }
  }
  const rootStat = await lstat(root);
  if (d.kind === 'ios_app_directory' ? !rootStat.isDirectory() || !root.endsWith('.app') : !rootStat.isFile() || !root.endsWith('.apk')) fail('artifact kind/path mismatch');
  await visit(root, '');
  if (!files) fail('empty native artifact');
  for (const original of identities) if (!unchanged(original.stat, await lstat(original.path))) fail('artifact tree changed during seal');
  if (await realpath(root) !== root) fail('artifact alias changed');
  return { path: root, kind: d.kind, digest: nativeDeliveryDigest({ format: 'faktori.native-artifact-tree/v1', kind: d.kind, entries }), fileCount: files, sizeBytes: total };
}
export function parseNativeDeliveryIdentities(value: unknown): NativeDeliveryIdentity[] {
  if (!Array.isArray(value) || !value.length || value.length > 2) fail('one or two native targets required');
  const result = value.map(v => {
    const d = object(v, ['platform', 'applicationId', 'buildVersion', 'nativeRuntimeVersion', 'operatingSystemVersion', 'executionTarget', 'signing', 'distribution', 'artifactDigest']);
    if (d.platform !== 'ios' && d.platform !== 'android') fail('native platform required');
    if (d.executionTarget !== (d.platform === 'ios' ? 'ios_simulator' : 'android_emulator') || d.distribution !== 'local_only') fail('physical/store/distributed native tiers are not qualified by this adapter');
    if (!(d.platform === 'ios' ? ['ad_hoc_simulator', 'unsigned'] : ['android_debug', 'unsigned']).includes(String(d.signing))) fail('platform signing tier mismatch');
    const applicationId = text(d.applicationId);
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(applicationId)) fail('application identifier required');
    return { ...d, applicationId, buildVersion: text(d.buildVersion), nativeRuntimeVersion: text(d.nativeRuntimeVersion), operatingSystemVersion: text(d.operatingSystemVersion), artifactDigest: sha(d.artifactDigest) } as unknown as NativeDeliveryIdentity;
  });
  if (new Set(result.map(t => t.platform)).size !== result.length || result.some((t, i) => i && result[i - 1]!.platform > t.platform)) fail('native targets must be distinct and sorted by platform');
  return result;
}
export function parseNativeBackendIdentity(value: unknown): NativeBackendIdentity {
  const d = object(value, ['origin', 'artifactDigest', 'schemaRevision', 'contractRevision']);
  const origin = text(d.origin), url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) fail('fixed HTTPS or local loopback backend origin required');
  return { origin, artifactDigest: sha(d.artifactDigest), schemaRevision: text(d.schemaRevision), contractRevision: text(d.contractRevision) };
}
/** Validate accepted scope and re-seal actual artifacts. Native effects belong only to the approved observer. */
export async function validateNativeDeliveryConfiguration(value: unknown, request: ProductBaselineObservationRequest, readJSON: (binding: LiveFileBinding) => Promise<unknown>): Promise<LiveFileBinding[]> {
  const c = object(value, ['format', 'id', 'productId', 'ownerId', 'approved', 'releaseAuthority', 'workspacePath', 'expected', 'source', 'verificationConfiguration', 'evaluatorFiles', 'observerFiles', 'definition', 'design', 'designApproval', 'artifacts']);
  if (c.format !== 'faktori.native-local-delivery/v1' || c.approved !== true || c.releaseAuthority !== 'owner_native_local_observation' || c.productId !== request.productId || c.ownerId !== request.ownerId || c.workspacePath !== request.observer.cwd || nativeDeliveryCanonical(c.expected) !== nativeDeliveryCanonical(request.expected)) fail('exact owner native-local scope required');
  text(c.id);
  const definition = binding(c.definition), design = binding(c.design), approval = binding(c.designApproval);
  const definitionInput = await readJSON(definition), inspected = inspectProductDefinition(definitionInput);
  const designInput = await readJSON(design), designApproval = await readJSON(approval);
  const acceptedDesign = inspectProductDesign(definitionInput, designInput, designApproval);
  if (!inspected.readyForDesign || !acceptedDesign.readyForDelivery || inspected.definition.productId !== request.productId || acceptedDesign.approval?.ownerId !== request.ownerId) fail('separately owner-accepted native definition/design required');
  if (`sha256:${createHash('sha256').update(serializeProductDesign(designInput)).digest('hex')}` !== design.digest) fail('canonical accepted design bytes required');
  const targets = parseNativeDeliveryIdentities(request.expected.nativeTargets);
  const backend = parseNativeBackendIdentity(request.expected.nativeBackend);
  if (backend.schemaRevision !== request.expected.schemaRevision || !request.expected.contracts.some(r => r.revision === backend.contractRevision)) fail('backend schema/API compatibility binding mismatch');
  if (!acceptedDesign.design.decisions.some(d => d.area === 'api' && d.target === 'shared' && d.contract?.revision === backend.contractRevision)) fail('backend contract revision must match the accepted shared API design');
  const selected = inspected.definition.platforms.targets.filter(t => t !== 'web').sort();
  if (nativeDeliveryCanonical(selected) !== nativeDeliveryCanonical(targets.map(t => t.platform)) || nativeDeliveryCanonical(request.expected.platforms.slice().sort()) !== nativeDeliveryCanonical(selected)) fail('native selected platforms must match accepted definition');
  if (!Array.isArray(c.artifacts) || c.artifacts.length !== targets.length) fail('actual artifact for each native target required');
  for (const [index, value] of c.artifacts.entries()) {
    const a = object(value, ['path', 'kind', 'digest', 'fileCount', 'sizeBytes']);
    const seal = await captureNativeArtifact({ path: a.path, kind: a.kind });
    if (nativeDeliveryCanonical(a) !== nativeDeliveryCanonical(seal) || seal.digest !== targets[index]!.artifactDigest || seal.kind !== (targets[index]!.platform === 'ios' ? 'ios_app_directory' : 'android_apk_file')) fail('native artifact identity changed');
  }
  if (request.expected.artifactDigest !== nativeDeliveryDigest(targets) || request.receipts.artifact !== undefined || request.receipts.loopArtifactsDirectory !== undefined) fail('native artifact-set digest/profile mismatch');
  const source = object(c.source, ['candidatePath', 'files']);
  if (!Array.isArray(source.files) || source.files.length > 300 || !source.files.length) fail('complete source bindings required');
  const files = source.files.map(binding);
  if (request.expected.sourceRevision !== nativeDeliveryDigest(files) || [definition, design, approval].some(b => !files.some(f => f.path === b.path && f.digest === b.digest))) fail('accepted scope must be sealed in exact source revision');
  return [definition, design, approval];
}
