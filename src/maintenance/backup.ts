import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AppendOnlyJournal } from '../runtime/journal.ts';
import { snapshotsFromEvents } from '../runtime/sqlite-projection.ts';
import type { RecoveryRequirement, RunEvent, RunSnapshot } from '../runtime/contracts.ts';

const BACKUP_FORMAT = 'faktori.backup/v1' as const;
const BACKUP_REQUEST_FORMAT = 'faktori.backup-request/v1' as const;
const RECONCILIATION_FORMAT = 'faktori.restore-reconciliation/v1' as const;
const RESTORE_FORMAT = 'faktori.restore/v1' as const;
const STATE_FORMAT_VERSION = 1;
const SENSITIVE_CONFIGURATION_KEY = /(?:(?:api|access|auth|refresh|client)[_-]?(?:key|token|secret)|token|secret|password|credential(?:profile|path|store)?|authorization|cookie|private[_-]?key|(?:codex|claude|cursor)[_-]?home)$/i;

type BackupKind = 'configuration' | 'artifact' | 'operational';
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface FactoryBackupRequest {
  format: typeof BACKUP_REQUEST_FORMAT;
  factoryId: string;
  sourceRoot: string;
  runtimeVersion: string;
  stateFormatVersion: 1;
  journalPath: string;
  configurationPaths: string[];
  artifactPaths: string[];
  operationalPaths: string[];
  projectionPaths?: string[];
  credentialPaths?: string[];
}

export interface BackupFileRecord {
  path: string;
  kind: BackupKind;
  sha256: string;
  bytes: number;
  mode: number;
  redactedConfigurationKeys?: string[];
}

export interface FactoryBackupManifest {
  format: typeof BACKUP_FORMAT;
  backupId: string;
  factoryId: string;
  runtimeVersion: string;
  stateFormatVersion: 1;
  createdAt: string;
  sourceRoot: string;
  consistency: 'coordinator_offline_lock_held';
  journalPath: string;
  projectionPolicy: 'excluded_rebuild_from_journal';
  credentialPolicy: 'excluded_provider_owned_stores';
  files: BackupFileRecord[];
  backupDigest: string;
}

export interface FactoryRestoreResult {
  format: typeof RESTORE_FORMAT;
  restorationId: string;
  backupId: string;
  factoryId: string;
  destinationRoot: string;
  restoredFiles: number;
  reconciliationRequired: RecoveryRequirement[];
  admissionBlocked: boolean;
  configurationRebindings: Array<{ file: string; jsonPath: string; from: string; to: string }>;
}

export interface FactoryRestoreRequest {
  format: 'faktori.restore-request/v1';
  destinationRoot: string;
  expectedFactoryId: string;
  expectedSourceRoot: string;
  rebindConfigurationPaths: true;
}

export type RecoveryDisposition = 'confirmed_absent' | 'effect_already_completed' | 'safe_noop' | 'authority_revoked' | 'blocked';

export interface RestoreReconciliationRequest {
  format: typeof RECONCILIATION_FORMAT;
  restoredRoot: string;
  journalPath: string;
  sourceBackupId: string;
  decisions: Array<{ recoveryId: string; disposition: RecoveryDisposition; evidence: string }>;
}

export class MaintenanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceValidationError';
  }
}

function fail(message: string): never {
  throw new MaintenanceValidationError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit = 1_024): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit || value.includes('\0')) fail(`${label} must be a bounded non-empty string`);
  return value;
}

function exactStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const result = value.map((item, index) => safeRelativePath(text(item, `${label}[${index}]`), `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicate paths`);
  return result.sort();
}

function safeRelativePath(value: string, label: string): string {
  if (isAbsolute(value) || value.includes('\\')) fail(`${label} must be a portable relative path`);
  const parts = value.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) fail(`${label} contains an unsafe path segment`);
  const normalized = parts.join('/');
  if (normalized === 'manifest.json' || normalized.startsWith('files/')) fail(`${label} collides with backup metadata`);
  return normalized;
}

function isWithin(root: string, target: string): boolean {
  const inside = relative(root, target);
  return inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside));
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function stable(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key] as Json)}`).join(',')}}`;
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function manifestDigest(manifest: Omit<FactoryBackupManifest, 'backupDigest'>): string {
  return digest(stable(manifest as unknown as Json));
}

async function canonicalRoot(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || path === sep) fail(`${label} must be a normalized dedicated absolute path`);
  let real: string;
  try { real = await realpath(path); } catch { fail(`${label} must exist`); }
  const details = await lstat(real);
  if (!details.isDirectory()) fail(`${label} must be a real directory`);
  return real;
}

async function assertNoSymlinks(root: string, target: string, label: string): Promise<void> {
  if (!isWithin(root, target)) fail(`${label} escapes its root`);
  const inside = relative(root, target);
  let current = root;
  for (const part of inside === '' ? [] : inside.split(sep)) {
    current = join(current, part);
    const details = await lstat(current);
    if (details.isSymbolicLink()) fail(`${label} contains a symbolic link`);
  }
  const real = await realpath(target);
  if (!isWithin(root, real)) fail(`${label} resolves outside its root`);
}

function isExcluded(path: string, exclusions: readonly string[]): boolean {
  return path.endsWith('.coordinator-lock')
    || path.endsWith('.action-admission-lock')
    || path === 'update.lock'
    || path.endsWith('/update.lock')
    || exclusions.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

async function filesUnder(root: string, path: string, exclusions: readonly string[] = []): Promise<string[]> {
  if (isExcluded(path, exclusions)) return [];
  const target = join(root, ...path.split('/'));
  await assertNoSymlinks(root, target, path);
  const details = await lstat(target);
  if (details.isFile()) return [path];
  if (!details.isDirectory()) fail(`${path} must be a regular file or directory`);
  const names = readdir(target, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of (await names).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) fail(`${path}/${entry.name} is a symbolic link`);
    const child = `${path}/${entry.name}`;
    if (isExcluded(child, exclusions)) continue;
    if (entry.isDirectory()) result.push(...await filesUnder(root, child, exclusions));
    else if (entry.isFile()) result.push(child);
    else fail(`${child} is not a regular file`);
  }
  return result;
}

function normalizeJson(value: unknown, path: string, redactions: string[], ancestors = new WeakSet<object>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') fail(`${path} must contain JSON data only`);
  if (ancestors.has(value)) fail(`${path} contains a circular value`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item, index) => normalizeJson(item, `${path}[${index}]`, redactions, ancestors));
    const result: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
      if (SENSITIVE_CONFIGURATION_KEY.test(key)) {
        redactions.push(`${path}.${key}`);
        continue;
      }
      result[key] = normalizeJson(item, `${path}.${key}`, redactions, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

async function backupBytes(source: string, kind: BackupKind, path: string): Promise<{ bytes: Uint8Array; redactions?: string[] }> {
  const bytes = await readFile(source);
  if (kind !== 'configuration') return { bytes };
  if (!path.endsWith('.json')) fail(`configuration path ${path} must be JSON so secret-bearing fields can be excluded`);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail(`configuration path ${path} is not valid JSON`); }
  const redactions: string[] = [];
  const sanitized = normalizeJson(parsed, path, redactions);
  return { bytes: Buffer.from(`${JSON.stringify(sanitized, null, 2)}\n`), ...(redactions.length === 0 ? {} : { redactions }) };
}

function validateCommittedJournal(bytes: Uint8Array, label: string): void {
  if (bytes.length > 0 && bytes.at(-1) !== 0x0a) fail(`${label} has an unterminated journal tail; stop the coordinator and repair recovery before backup`);
  const ids = new Set<string>();
  for (const [index, line] of Buffer.from(bytes).toString('utf8').split('\n').entries()) {
    if (line === '') continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { fail(`${label} has malformed JSON at line ${index + 1}`); }
    const record = object(event, `${label} line ${index + 1}`);
    if (record.format !== 'faktori.run-event/v1' || typeof record.eventId !== 'string' || typeof record.runId !== 'string') fail(`${label} has an invalid event at line ${index + 1}`);
    if (ids.has(record.eventId)) fail(`${label} contains a duplicate event ID`);
    ids.add(record.eventId);
  }
}

async function acquireOfflineLock(journal: string, purpose: string): Promise<{ release(): Promise<void> }> {
  const lockPath = `${journal}.coordinator-lock`;
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(`factory coordinator is active or ownership is unresolved; ${purpose} requires quiesced admission`);
    throw error;
  }
  await handle.writeFile(`${JSON.stringify({ instanceId: `maintenance-${purpose}-${process.pid}`, pid: process.pid, processStartedAt: new Date().toISOString() })}\n`, 'utf8');
  await handle.sync();
  const identity = await handle.stat();
  return { release: async () => {
    await handle.close();
    try {
      const current = await lstat(lockPath);
      if (current.dev !== identity.dev || current.ino !== identity.ino) fail(`maintenance ${purpose} lock identity changed; refusing to remove another owner's lock`);
      await rm(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } };
}

function validateBackupRequest(value: unknown): FactoryBackupRequest {
  const input = object(value, 'backup request');
  if (input.format !== BACKUP_REQUEST_FORMAT) fail(`backup request format must be ${BACKUP_REQUEST_FORMAT}`);
  if (input.stateFormatVersion !== STATE_FORMAT_VERSION) fail(`stateFormatVersion must be ${STATE_FORMAT_VERSION}`);
  const request: FactoryBackupRequest = {
    format: BACKUP_REQUEST_FORMAT,
    factoryId: text(input.factoryId, 'factoryId', 256),
    sourceRoot: text(input.sourceRoot, 'sourceRoot', 4_096),
    runtimeVersion: text(input.runtimeVersion, 'runtimeVersion', 128),
    stateFormatVersion: STATE_FORMAT_VERSION,
    journalPath: safeRelativePath(text(input.journalPath, 'journalPath'), 'journalPath'),
    configurationPaths: exactStringArray(input.configurationPaths, 'configurationPaths'),
    artifactPaths: exactStringArray(input.artifactPaths, 'artifactPaths'),
    operationalPaths: exactStringArray(input.operationalPaths, 'operationalPaths'),
    projectionPaths: input.projectionPaths === undefined ? [] : exactStringArray(input.projectionPaths, 'projectionPaths'),
    credentialPaths: input.credentialPaths === undefined ? [] : exactStringArray(input.credentialPaths, 'credentialPaths'),
  };
  if (!request.operationalPaths.some((path) => overlaps(path, request.journalPath))) fail('journalPath must be included by operationalPaths');
  const included = [...request.configurationPaths, ...request.artifactPaths, ...request.operationalPaths];
  for (let index = 0; index < included.length; index += 1) {
    if (included.slice(index + 1).some((other) => overlaps(included[index] as string, other))) fail('included backup roots must not overlap');
  }
  return request;
}

export async function createFactoryBackup(value: unknown, destinationRoot: string): Promise<FactoryBackupManifest> {
  const request = validateBackupRequest(value);
  const sourceRoot = await canonicalRoot(request.sourceRoot, 'sourceRoot');
  if (!isAbsolute(destinationRoot) || resolve(destinationRoot) !== destinationRoot) fail('backup destination must be a normalized absolute path');
  const destinationParent = await canonicalRoot(dirname(destinationRoot), 'backup destination parent');
  const destination = join(destinationParent, basename(destinationRoot));
  if (isWithin(sourceRoot, destination) || isWithin(destination, sourceRoot)) fail('backup destination must be separate from the factory source');
  try { await lstat(destination); fail('backup destination already exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const journal = join(sourceRoot, ...request.journalPath.split('/'));
  await assertNoSymlinks(sourceRoot, journal, 'journalPath');
  const lock = await acquireOfflineLock(journal, 'backup');
  try {
    try { await mkdir(destination, { recursive: false, mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('backup destination already exists'); throw error; }
    await writeFile(join(destination, '.incomplete'), 'backup creation did not complete\n', { flag: 'wx', mode: 0o600 });
    const paths = new Map<string, BackupKind>();
    const exclusions = [
      ...(request.projectionPaths ?? []).flatMap((path) => [path, `${path}-wal`, `${path}-shm`]),
      ...(request.credentialPaths ?? []),
      `${request.journalPath}.coordinator-lock`,
      `${request.journalPath}.action-admission-lock`,
    ];
    for (const [kind, roots] of [['configuration', request.configurationPaths], ['artifact', request.artifactPaths], ['operational', request.operationalPaths]] as const) {
      for (const root of roots) for (const path of await filesUnder(sourceRoot, root, exclusions)) {
        if (paths.has(path)) fail(`backup material overlaps at ${path}`);
        paths.set(path, kind);
      }
    }
    await mkdir(join(destination, 'files'), { recursive: true, mode: 0o700 });
    const records: BackupFileRecord[] = [];
    for (const [path, kind] of [...paths].sort(([left], [right]) => left.localeCompare(right))) {
      const source = join(sourceRoot, ...path.split('/'));
      const prepared = await backupBytes(source, kind, path);
      if (path === request.journalPath) validateCommittedJournal(prepared.bytes, path);
      const target = join(destination, 'files', ...path.split('/'));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, prepared.bytes, { flag: 'wx', mode: 0o600 });
      const details = await stat(source);
      records.push({
        path, kind, sha256: digest(prepared.bytes), bytes: prepared.bytes.byteLength,
        mode: details.mode & 0o777,
        ...(prepared.redactions === undefined ? {} : { redactedConfigurationKeys: prepared.redactions }),
      });
    }
    if (!records.some((record) => record.path === request.journalPath)) fail('journalPath must resolve to a backed-up regular file');
    const withoutDigest: Omit<FactoryBackupManifest, 'backupDigest'> = {
      format: BACKUP_FORMAT,
      backupId: `backup-${digest(`${request.factoryId}\0${new Date().toISOString()}\0${records.map((item) => item.sha256).join('')}`).slice(0, 24)}`,
      factoryId: request.factoryId,
      runtimeVersion: request.runtimeVersion,
      stateFormatVersion: STATE_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      sourceRoot,
      consistency: 'coordinator_offline_lock_held',
      journalPath: request.journalPath,
      projectionPolicy: 'excluded_rebuild_from_journal',
      credentialPolicy: 'excluded_provider_owned_stores',
      files: records,
    };
    const manifest = { ...withoutDigest, backupDigest: manifestDigest(withoutDigest) };
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rm(join(destination, '.incomplete'));
    return manifest;
  } finally {
    await lock.release();
  }
}

function backupManifest(value: unknown): FactoryBackupManifest {
  const input = object(value, 'backup manifest');
  if (input.format !== BACKUP_FORMAT || input.stateFormatVersion !== STATE_FORMAT_VERSION) fail('unsupported backup format or state version');
  if (!Array.isArray(input.files)) fail('backup manifest files must be an array');
  const files = input.files.map((item, index) => {
    const record = object(item, `files[${index}]`);
    const kind = record.kind;
    if (kind !== 'configuration' && kind !== 'artifact' && kind !== 'operational') fail(`files[${index}].kind is unsupported`);
    const mode = record.mode;
    const bytes = record.bytes;
    const sha256 = text(record.sha256, `files[${index}].sha256`, 64);
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || Number(bytes) < 0 || !Number.isInteger(mode) || Number(mode) < 0 || Number(mode) > 0o777) fail(`files[${index}] has invalid digest, size, or mode`);
    const redacted = record.redactedConfigurationKeys === undefined ? undefined : (Array.isArray(record.redactedConfigurationKeys) ? record.redactedConfigurationKeys.map((entry, redactionIndex) => text(entry, `files[${index}].redactedConfigurationKeys[${redactionIndex}]`)) : fail(`files[${index}].redactedConfigurationKeys must be an array`));
    return { path: safeRelativePath(text(record.path, `files[${index}].path`), `files[${index}].path`), kind: kind as BackupKind, sha256, bytes: Number(bytes), mode: Number(mode), ...(redacted === undefined ? {} : { redactedConfigurationKeys: redacted }) };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) fail('backup manifest contains duplicate file paths');
  const manifest: FactoryBackupManifest = {
    format: BACKUP_FORMAT,
    backupId: text(input.backupId, 'backupId', 256),
    factoryId: text(input.factoryId, 'factoryId', 256),
    runtimeVersion: text(input.runtimeVersion, 'runtimeVersion', 128),
    stateFormatVersion: STATE_FORMAT_VERSION,
    createdAt: text(input.createdAt, 'createdAt', 128),
    sourceRoot: text(input.sourceRoot, 'sourceRoot', 4_096),
    consistency: input.consistency === 'coordinator_offline_lock_held' ? input.consistency : fail('backup consistency proof is invalid'),
    journalPath: safeRelativePath(text(input.journalPath, 'journalPath'), 'journalPath'),
    projectionPolicy: input.projectionPolicy === 'excluded_rebuild_from_journal' ? input.projectionPolicy : fail('backup projection policy is invalid'),
    credentialPolicy: input.credentialPolicy === 'excluded_provider_owned_stores' ? input.credentialPolicy : fail('backup credential policy is invalid'),
    files,
    backupDigest: text(input.backupDigest, 'backupDigest', 64),
  };
  if (!isAbsolute(manifest.sourceRoot) || resolve(manifest.sourceRoot) !== manifest.sourceRoot || manifest.sourceRoot === sep) fail('backup sourceRoot is not a normalized dedicated absolute path');
  const { backupDigest, ...payload } = manifest;
  if (!/^[a-f0-9]{64}$/.test(backupDigest) || manifestDigest(payload) !== backupDigest) fail('backup manifest digest does not match its contents');
  if (!files.some((file) => file.path === manifest.journalPath && file.kind === 'operational')) fail('backup manifest does not contain its operational journal');
  return manifest;
}

async function validatedBackup(backupRoot: string): Promise<{ root: string; manifest: FactoryBackupManifest }> {
  const root = await canonicalRoot(backupRoot, 'backupRoot');
  const manifestPath = join(root, 'manifest.json');
  await assertNoSymlinks(root, manifestPath, 'manifest.json');
  const manifest = backupManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const expected = new Set(['manifest.json', ...manifest.files.map((file) => `files/${file.path}`)]);
  const observed = new Set<string>();
  async function walk(directory: string, prefix = ''): Promise<void> {
    const entries = await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(`backup contains symbolic link ${path}`);
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else if (entry.isFile()) observed.add(path);
      else fail(`backup contains non-regular entry ${path}`);
    }
  }
  await walk(root);
  if ([...observed].some((path) => !expected.has(path)) || [...expected].some((path) => !observed.has(path))) fail('backup contents do not exactly match the manifest');
  for (const record of manifest.files) {
    const path = join(root, 'files', ...record.path.split('/'));
    await assertNoSymlinks(root, path, record.path);
    const bytes = await readFile(path);
    if (bytes.byteLength !== record.bytes || digest(bytes) !== record.sha256) fail(`backup file ${record.path} does not match its manifest digest`);
    if (record.path === manifest.journalPath) validateCommittedJournal(bytes, record.path);
  }
  return { root, manifest };
}

function restoreRequest(value: unknown): FactoryRestoreRequest {
  const input = object(value, 'restore request');
  if (input.format !== 'faktori.restore-request/v1') fail('restore request format must be faktori.restore-request/v1');
  if (input.rebindConfigurationPaths !== true) fail('restore request must explicitly confirm configuration path rebinding');
  return {
    format: 'faktori.restore-request/v1',
    destinationRoot: text(input.destinationRoot, 'destinationRoot', 4_096),
    expectedFactoryId: text(input.expectedFactoryId, 'expectedFactoryId', 256),
    expectedSourceRoot: text(input.expectedSourceRoot, 'expectedSourceRoot', 4_096),
    rebindConfigurationPaths: true,
  };
}

function rebindConfiguration(
  value: Json,
  jsonPath: string,
  file: string,
  sourceRoot: string,
  destinationRoot: string,
  changes: FactoryRestoreResult['configurationRebindings'],
): Json {
  if (typeof value === 'string') {
    const fromSource = value === sourceRoot || value.startsWith(`${sourceRoot}${sep}`);
    if (!fromSource) return value;
    const next = `${destinationRoot}${value.slice(sourceRoot.length)}`;
    changes.push({ file, jsonPath, from: value, to: next });
    return next;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item, index) => rebindConfiguration(item, `${jsonPath}[${index}]`, file, sourceRoot, destinationRoot, changes));
  const result: { [key: string]: Json } = {};
  for (const [key, item] of Object.entries(value)) result[key] = rebindConfiguration(item, `${jsonPath}.${key}`, file, sourceRoot, destinationRoot, changes);
  return result;
}

function recoveryRequirement(snapshot: RunSnapshot, backupId: string, now: string): RecoveryRequirement | undefined {
  const uncertainTerminal = snapshot.state === 'interrupted_uncertain';
  const active = !['succeeded', 'blocked', 'failed', 'cancelled', 'interrupted_uncertain'].includes(snapshot.state);
  if (!active && !uncertainTerminal && snapshot.unresolvedEffects.length === 0) return undefined;
  return {
    recoveryId: `restore-${digest(`${backupId}\0${snapshot.intent.runId}`).slice(0, 24)}`,
    sourceBackupId: backupId,
    reason: 'restored_worker_or_effect_uncertain',
    priorState: snapshot.state,
    ...(snapshot.worker === undefined ? {} : { worker: snapshot.worker }),
    unresolvedOperationIds: snapshot.unresolvedEffects.map((effect) => effect.operationId).sort(),
    requiredAt: now,
  };
}

export async function restoreFactoryBackup(backupRoot: string, requestValue: unknown): Promise<FactoryRestoreResult> {
  const validated = await validatedBackup(backupRoot);
  const request = restoreRequest(requestValue);
  if (request.expectedFactoryId !== validated.manifest.factoryId) fail('restore request factory identity does not match the backup');
  if (request.expectedSourceRoot !== validated.manifest.sourceRoot) fail('restore request source root does not match the backup; relocation must be explicitly confirmed');
  const destinationRoot = request.destinationRoot;
  if (!isAbsolute(destinationRoot) || resolve(destinationRoot) !== destinationRoot) fail('restore destination must be a normalized absolute path');
  const parent = await canonicalRoot(dirname(destinationRoot), 'restore destination parent');
  const destination = join(parent, basename(destinationRoot));
  if (isWithin(validated.root, destination) || isWithin(destination, validated.root)) fail('restore destination must be separate from the backup');
  try { await lstat(destination); fail('restore destination already exists; owner material will never be overwritten'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!isAbsolute(request.expectedSourceRoot) || resolve(request.expectedSourceRoot) !== request.expectedSourceRoot || request.expectedSourceRoot === sep) fail('expectedSourceRoot must be a normalized dedicated absolute path');
  try {
    try { await mkdir(destination, { recursive: false, mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('restore destination already exists; owner material will never be overwritten'); throw error; }
    const incomplete = join(destination, '.faktori', 'restore-incomplete.json');
    await mkdir(dirname(incomplete), { recursive: true, mode: 0o700 });
    await writeFile(incomplete, `${JSON.stringify({ format: 'faktori.restore-incomplete/v1', backupId: validated.manifest.backupId })}\n`, { flag: 'wx', mode: 0o600 });
    const configurationRebindings: FactoryRestoreResult['configurationRebindings'] = [];
    for (const record of validated.manifest.files) {
      const source = join(validated.root, 'files', ...record.path.split('/'));
      const target = join(destination, ...record.path.split('/'));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (record.kind === 'configuration') {
        const parsed = JSON.parse(await readFile(source, 'utf8')) as Json;
        const rebound = rebindConfiguration(parsed, '$', record.path, validated.manifest.sourceRoot, destination, configurationRebindings);
        await writeFile(target, `${JSON.stringify(rebound, null, 2)}\n`, { flag: 'wx', mode: record.mode & 0o777 });
      } else {
        await copyFile(source, target, constants.COPYFILE_EXCL);
      }
      const handle = await open(target, 'r+');
      try { await handle.chmod(record.mode & 0o777); await handle.sync(); } finally { await handle.close(); }
    }
    const restoredJournal = join(destination, ...validated.manifest.journalPath.split('/'));
    const journal = await AppendOnlyJournal.open(restoredJournal);
    const snapshots = snapshotsFromEvents(journal.events());
    const now = new Date().toISOString();
    const requirements = snapshots.map((snapshot) => ({ snapshot, requirement: recoveryRequirement(snapshot, validated.manifest.backupId, now) }))
      .filter((entry): entry is { snapshot: RunSnapshot; requirement: RecoveryRequirement } => entry.requirement !== undefined);
    for (const { snapshot, requirement } of requirements) {
      const event: RunEvent = {
        format: 'faktori.run-event/v1',
        eventId: `event-${requirement.recoveryId}`,
        runId: snapshot.intent.runId,
        occurredAt: now,
        kind: 'recovery.required',
        data: { recovery: requirement },
      };
      await journal.append(event);
    }
    const result: FactoryRestoreResult = {
      format: RESTORE_FORMAT,
      restorationId: `restoration-${randomUUID()}`,
      backupId: validated.manifest.backupId,
      factoryId: validated.manifest.factoryId,
      destinationRoot: destination,
      restoredFiles: validated.manifest.files.length,
      reconciliationRequired: requirements.map((entry) => entry.requirement),
      admissionBlocked: requirements.length > 0,
      configurationRebindings,
    };
    const recordPath = join(destination, '.faktori', 'restoration.json');
    await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
    await writeFile(recordPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rm(incomplete);
    return result;
  } catch (error) { throw error; }
}

function reconciliationRequest(value: unknown): RestoreReconciliationRequest {
  const input = object(value, 'reconciliation request');
  if (input.format !== RECONCILIATION_FORMAT) fail(`reconciliation format must be ${RECONCILIATION_FORMAT}`);
  if (!Array.isArray(input.decisions)) fail('decisions must be an array');
  const decisions = input.decisions.map((value, index) => {
    const decision = object(value, `decisions[${index}]`);
    const disposition = decision.disposition;
    if (!['confirmed_absent', 'effect_already_completed', 'safe_noop', 'authority_revoked', 'blocked'].includes(String(disposition))) fail(`decisions[${index}].disposition is unsupported`);
    return { recoveryId: text(decision.recoveryId, `decisions[${index}].recoveryId`, 256), disposition: disposition as RecoveryDisposition, evidence: text(decision.evidence, `decisions[${index}].evidence`, 2_000) };
  });
  if (new Set(decisions.map((decision) => decision.recoveryId)).size !== decisions.length) fail('decisions must identify each recovery only once');
  return {
    format: RECONCILIATION_FORMAT,
    restoredRoot: text(input.restoredRoot, 'restoredRoot', 4_096),
    journalPath: safeRelativePath(text(input.journalPath, 'journalPath'), 'journalPath'),
    sourceBackupId: text(input.sourceBackupId, 'sourceBackupId', 256),
    decisions,
  };
}

export async function reconcileRestoredFactory(value: unknown): Promise<{ resolved: number; admissionBlocked: boolean; snapshots: RunSnapshot[] }> {
  const request = reconciliationRequest(value);
  const root = await canonicalRoot(request.restoredRoot, 'restoredRoot');
  const journalPath = join(root, ...request.journalPath.split('/'));
  await assertNoSymlinks(root, journalPath, 'journalPath');
  const lock = await acquireOfflineLock(journalPath, 'reconciliation');
  try {
    const journal = await AppendOnlyJournal.open(journalPath);
    const snapshots = snapshotsFromEvents(journal.events());
    const pending = snapshots.flatMap((snapshot) => snapshot.recovery.map((recovery) => ({ runId: snapshot.intent.runId, recovery })));
    const expected = pending.filter((entry) => entry.recovery.sourceBackupId === request.sourceBackupId);
    if (expected.length !== pending.length) fail('sourceBackupId does not match every pending restoration block');
    const expectedIds = expected.map((entry) => entry.recovery.recoveryId).sort();
    const actualIds = request.decisions.map((decision) => decision.recoveryId).sort();
    if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) fail('decisions must cover every pending recovery exactly once');
    const now = new Date().toISOString();
    for (const decision of request.decisions) {
      const entry = expected.find((candidate) => candidate.recovery.recoveryId === decision.recoveryId) as typeof expected[number];
      await journal.append({
        format: 'faktori.run-event/v1',
        eventId: `event-resolved-${decision.recoveryId}`,
        runId: entry.runId,
        occurredAt: now,
        kind: 'recovery.resolved',
        data: { resolution: { ...decision, sourceBackupId: request.sourceBackupId, resolvedAt: now } },
      });
    }
    const reconciled = snapshotsFromEvents(journal.events());
    return { resolved: request.decisions.length, admissionBlocked: reconciled.some((snapshot) => snapshot.recovery.length > 0), snapshots: reconciled };
  } finally {
    await lock.release();
  }
}
