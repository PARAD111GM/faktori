import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { MaintenanceValidationError } from './backup.ts';

const INSTALLATION_FORMAT = 'faktori.runtime-installation/v1' as const;
const UPDATE_REQUEST_FORMAT = 'faktori.update-request/v1' as const;
const UPDATE_APPROVAL_FORMAT = 'faktori.update-approval/v1' as const;
const CURRENT_STATE_FORMAT_VERSION = 1;
const BETTER_SQLITE3_VERSION = '13.0.3';
const REQUIRED_KIT_PATHS = ['dist', 'console/dist', 'docs', 'docker', 'examples', 'provider-entrymaps/generated', 'skills', 'templates', 'LICENSE', 'README.md', 'package.json'] as const;
// Older releases predate these entry points. Include declared additions in new
// candidates without making existing installations unreadable.
const ADDITIONAL_KIT_PATHS = ['.agents/skills/faktori-update', '.claude/commands/faktori-update.md', '.cursor/commands/faktori-update.md', 'AGENTS.md', 'INSTALL.md', 'provider-entrymaps/source.json'] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface RuntimeInstallationManifest {
  format: typeof INSTALLATION_FORMAT;
  stateFormatVersion: number;
  activeVersion: string;
  activeRelease: string;
  activeDigest: string;
  activeEntrypoint: string;
  installedAt: string;
  releases: Array<{ version: string; release: string; digest: string; activatedAt: string; migration: string }>;
}

export interface UpdateRequest {
  format: typeof UPDATE_REQUEST_FORMAT;
  installationRoot: string;
  candidateRoot: string;
}

export interface UpdateApproval {
  format: typeof UPDATE_APPROVAL_FORMAT;
  previewDigest: string;
  approvedBy: string;
  confirmedAt: string;
}

export interface UpdatePreview {
  format: 'faktori.update-preview/v1';
  currentVersion: string;
  candidateVersion: string;
  currentStateFormatVersion: number;
  candidateStateFormatVersion: number;
  migration: string;
  changes: Array<{ path: string; change: 'add' | 'replace' | 'remove'; before?: string; after?: string }>;
  preservedOwnerPaths: string[];
  candidateDigest: string;
  previewDigest: string;
  outcome: 'update_available' | 'already_current';
}

interface CandidateKit {
  root: string;
  version: string;
  stateFormatVersion: number;
  digest: string;
  files: Array<{ path: string; sha256: string; bytes: number; mode: number }>;
}

function fail(message: string): never {
  throw new MaintenanceValidationError(message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit = 4_096): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit || value.includes('\0')) fail(`${label} must be a bounded non-empty string`);
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key] as Json)}`).join(',')}}`;
}

function within(root: string, target: string): boolean {
  const inside = relative(root, target);
  return inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside));
}

async function root(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) fail(`${label} must be a normalized absolute path`);
  let canonical: string;
  try { canonical = await realpath(path); } catch { fail(`${label} must exist`); }
  if (!(await lstat(canonical)).isDirectory()) fail(`${label} must be a real directory`);
  return canonical;
}

async function noSymlinks(rootPath: string, target: string, label: string): Promise<void> {
  if (!within(rootPath, target)) fail(`${label} escapes its root`);
  let current = rootPath;
  const inside = relative(rootPath, target);
  for (const part of inside === '' ? [] : inside.split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail(`${label} contains a symbolic link`);
  }
  if (!within(rootPath, await realpath(target))) fail(`${label} resolves outside its root`);
}

async function walkFiles(rootPath: string, path: string): Promise<Array<{ path: string; sha256: string; bytes: number; mode: number }>> {
  const target = join(rootPath, ...path.split('/'));
  await noSymlinks(rootPath, target, path);
  const details = await lstat(target);
  if (details.isFile()) {
    const bytes = await readFile(target);
    return [{ path, sha256: sha256(bytes), bytes: bytes.byteLength, mode: details.mode & 0o777 }];
  }
  if (!details.isDirectory()) fail(`${path} is not a regular file or directory`);
  const files: Array<{ path: string; sha256: string; bytes: number; mode: number }> = [];
  for (const entry of (await readdir(target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) fail(`${path}/${entry.name} is a symbolic link`);
    if (!entry.isFile() && !entry.isDirectory()) fail(`${path}/${entry.name} is not a regular public-kit entry`);
    files.push(...await walkFiles(rootPath, `${path}/${entry.name}`));
  }
  return files;
}

function versionParts(version: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (match === null) fail(`runtime version ${version} must be a final major.minor.patch release; prerelease ordering is unsupported`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const l = versionParts(left);
  const r = versionParts(right);
  for (let index = 0; index < 3; index += 1) if (l[index] !== r[index]) return (l[index] as number) - (r[index] as number);
  return 0;
}

function migration(from: number, to: number): string {
  if (from === 1 && to === 1) return 'state-v1-compatible';
  fail(`no supported operational-state migration from v${from} to v${to}`);
}

function updateRequest(value: unknown): UpdateRequest {
  const input = object(value, 'update request');
  if (input.format !== UPDATE_REQUEST_FORMAT) fail(`update request format must be ${UPDATE_REQUEST_FORMAT}`);
  return { format: UPDATE_REQUEST_FORMAT, installationRoot: text(input.installationRoot, 'installationRoot'), candidateRoot: text(input.candidateRoot, 'candidateRoot') };
}

function installationManifest(value: unknown): RuntimeInstallationManifest {
  const input = object(value, 'runtime installation manifest');
  if (input.format !== INSTALLATION_FORMAT || !Array.isArray(input.releases)) fail('runtime installation manifest format is unsupported');
  if (!Number.isInteger(input.stateFormatVersion) || Number(input.stateFormatVersion) < 1) fail('runtime installation state format is invalid');
  const releases = input.releases.map((value, index) => {
    const release = object(value, `releases[${index}]`);
    const releaseId = text(release.release, `releases[${index}].release`, 256);
    if (!/^[0-9A-Za-z][0-9A-Za-z.-]+$/.test(releaseId)) fail(`releases[${index}].release is unsafe`);
    return { version: text(release.version, `releases[${index}].version`, 128), release: releaseId, digest: text(release.digest, `releases[${index}].digest`, 64), activatedAt: text(release.activatedAt, `releases[${index}].activatedAt`, 128), migration: text(release.migration, `releases[${index}].migration`, 256) };
  });
  const manifest = {
    format: INSTALLATION_FORMAT,
    stateFormatVersion: Number(input.stateFormatVersion),
    activeVersion: text(input.activeVersion, 'activeVersion', 128),
    activeRelease: text(input.activeRelease, 'activeRelease', 256),
    activeDigest: text(input.activeDigest, 'activeDigest', 64),
    activeEntrypoint: text(input.activeEntrypoint, 'activeEntrypoint', 512),
    installedAt: text(input.installedAt, 'installedAt', 128),
    releases,
  };
  if (!releases.some((release) => release.release === manifest.activeRelease && release.version === manifest.activeVersion && release.digest === manifest.activeDigest)) fail('active release is not present in release history');
  if (manifest.activeEntrypoint !== `${manifest.activeRelease}/runtime/node_modules/.bin/faktori`) fail('active entrypoint does not match the immutable active release');
  return manifest;
}

async function candidateKit(path: string): Promise<CandidateKit> {
  const candidateRoot = await root(path, 'candidateRoot');
  const packagePath = join(candidateRoot, 'package.json');
  await noSymlinks(candidateRoot, packagePath, 'package.json');
  const packageJson = object(JSON.parse(await readFile(packagePath, 'utf8')), 'candidate package.json');
  if (packageJson.name !== 'faktori') fail('candidate package must be named faktori');
  const version = text(packageJson.version, 'candidate package version', 128);
  versionParts(version);
  if (packageJson.faktoriStateFormatVersion !== CURRENT_STATE_FORMAT_VERSION) fail(`candidate package must declare faktoriStateFormatVersion ${CURRENT_STATE_FORMAT_VERSION}`);
  const dependencies = object(packageJson.dependencies, 'candidate package dependencies');
  if (dependencies['better-sqlite3'] !== BETTER_SQLITE3_VERSION) fail(`candidate package must pin better-sqlite3 ${BETTER_SQLITE3_VERSION}`);
  const declared = packageJson.files;
  if (!Array.isArray(declared)) fail('candidate package must declare its public files');
  for (const required of REQUIRED_KIT_PATHS.filter((entry) => entry !== 'package.json')) {
    if (!declared.some((entry) => entry === required || (typeof entry === 'string' && required.startsWith(`${entry}/`)))) fail(`candidate package does not declare required public-kit path ${required}`);
  }
  const additional = ADDITIONAL_KIT_PATHS.filter((path) => declared.some((entry) => entry === path || (typeof entry === 'string' && path.startsWith(`${entry}/`))));
  const files = (await Promise.all([...REQUIRED_KIT_PATHS, ...additional].map((entry) => walkFiles(candidateRoot, entry)))).flat().sort((left, right) => left.path.localeCompare(right.path));
  // npm may normalize file modes while installing a package. Release identity
  // is bound to path, content and byte length; modes are reapplied from the
  // candidate only for direct copies and are not part of content identity.
  const identity = files.map(({ path: filePath, sha256: fileDigest, bytes }) => ({ path: filePath, sha256: fileDigest, bytes }));
  const kitDigest = sha256(stable(identity as unknown as Json));
  return { root: candidateRoot, version, stateFormatVersion: CURRENT_STATE_FORMAT_VERSION, digest: kitDigest, files };
}

async function readInstallation(installationRoot: string): Promise<{ root: string; manifest: RuntimeInstallationManifest }> {
  const installRoot = await root(installationRoot, 'installationRoot');
  const path = join(installRoot, '.faktori', 'runtime-installation.json');
  await noSymlinks(installRoot, path, 'runtime-installation.json');
  return { root: installRoot, manifest: installationManifest(JSON.parse(await readFile(path, 'utf8'))) };
}

async function installedFiles(installationRoot: string, release: string): Promise<Map<string, string>> {
  if (release.includes('/') || release.includes('\\') || release === '.' || release === '..') fail('active release identity is unsafe');
  const releaseRoot = join(installationRoot, '.faktori', 'releases', release, 'runtime', 'node_modules', 'faktori');
  await noSymlinks(installationRoot, releaseRoot, 'active release package');
  const files = (await Promise.all(REQUIRED_KIT_PATHS.map((entry) => walkFiles(releaseRoot, entry)))).flat();
  for (const entry of ADDITIONAL_KIT_PATHS) {
    try { await lstat(join(releaseRoot, entry)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    files.push(...await walkFiles(releaseRoot, entry));
  }
  return new Map(files.map((file) => [file.path, file.sha256]));
}

function previewDigest(preview: Omit<UpdatePreview, 'previewDigest'>): string {
  return sha256(stable(preview as unknown as Json));
}

export async function previewRuntimeUpdate(value: unknown): Promise<UpdatePreview> {
  const request = updateRequest(value);
  const [{ root: installationRoot, manifest }, candidate] = await Promise.all([readInstallation(request.installationRoot), candidateKit(request.candidateRoot)]);
  const comparison = compareVersions(candidate.version, manifest.activeVersion);
  if (comparison < 0) fail(`refusing silent rollback from ${manifest.activeVersion} to ${candidate.version}`);
  const migrationId = migration(manifest.stateFormatVersion, candidate.stateFormatVersion);
  const current = await installedFiles(installationRoot, manifest.activeRelease);
  const next = new Map(candidate.files.map((file) => [file.path, file.sha256]));
  const changes: UpdatePreview['changes'] = [];
  for (const path of [...new Set([...current.keys(), ...next.keys()])].sort()) {
    const before = current.get(path);
    const after = next.get(path);
    if (before === after) continue;
    changes.push({ path, change: before === undefined ? 'add' : after === undefined ? 'remove' : 'replace', ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
  }
  if (comparison === 0 && candidate.digest !== manifest.activeDigest) fail('same-version candidate differs from the active release; publish a new version instead of replacing identity');
  const withoutDigest: Omit<UpdatePreview, 'previewDigest'> = {
    format: 'faktori.update-preview/v1',
    currentVersion: manifest.activeVersion,
    candidateVersion: candidate.version,
    currentStateFormatVersion: manifest.stateFormatVersion,
    candidateStateFormatVersion: candidate.stateFormatVersion,
    migration: migrationId,
    changes,
    preservedOwnerPaths: ['all paths outside .faktori/releases and .faktori/runtime-installation.json'],
    candidateDigest: candidate.digest,
    outcome: comparison === 0 ? 'already_current' : 'update_available',
  };
  return { ...withoutDigest, previewDigest: previewDigest(withoutDigest) };
}

async function copyCandidate(candidate: CandidateKit, target: string): Promise<void> {
  await mkdir(target, { recursive: false, mode: 0o700 });
  for (const file of candidate.files) {
    const source = join(candidate.root, ...file.path.split('/'));
    const destination = join(target, ...file.path.split('/'));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const handle = await open(destination, 'r+');
    try { await handle.chmod(file.mode); await handle.sync(); } finally { await handle.close(); }
  }
}

function npmCommand(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const npmExecPath = process.env.npm_execpath;
  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, ...args], { cwd, encoding: 'utf8', env: process.env })
    : spawnSync('npm', args, { cwd, encoding: 'utf8', env: process.env });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function verifyRunnableRuntime(entrypoint: string, consumer: string): Promise<void> {
  const validation = join(consumer, `.faktori-runtime-validation-${randomUUID()}`);
  await mkdir(validation, { mode: 0o700 });
  const journal = join(validation, 'operations.jsonl');
  const projection = join(validation, 'projection.sqlite');
  await writeFile(journal, '', { flag: 'wx', mode: 0o600 });
  try {
    const rebuilt = spawnSync(entrypoint, ['runtime', 'rebuild', journal, projection], {
      cwd: consumer,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
    });
    if (rebuilt.status !== 0) fail(`clean installed candidate cannot load its runtime dependencies: ${rebuilt.stderr || rebuilt.stdout}`);
    let result: unknown;
    try { result = JSON.parse(rebuilt.stdout); } catch { fail('clean installed candidate runtime verification returned invalid JSON'); }
    const output = object(result, 'runtime verification result');
    if (output.eventCount !== 0 || !Array.isArray(output.snapshots)) fail('clean installed candidate runtime verification returned an unexpected projection');
  } finally {
    await rm(validation, { recursive: true, force: true });
  }
}

async function acquireUpdateLock(control: string, previewDigest: string): Promise<{ release(): Promise<void> }> {
  const updateLock = join(control, 'update.lock');
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(updateLock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('another update is active or unresolved'); throw error; }
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, previewDigest })}\n`);
  await handle.sync();
  const identity = await handle.stat();
  return { release: async () => {
    await handle.close();
    try {
      const current = await lstat(updateLock);
      if (current.dev !== identity.dev || current.ino !== identity.ino) fail('update lock identity changed; refusing to remove another owner\'s lock');
      await rm(updateLock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } };
}

async function installCandidateRelease(candidate: CandidateKit, staging: string): Promise<{ entrypoint: string }> {
  const snapshot = join(staging, 'candidate');
  const consumer = join(staging, 'runtime');
  await mkdir(staging, { recursive: false, mode: 0o700 });
  await copyCandidate(candidate, snapshot);
  const copied = await candidateKit(snapshot);
  if (copied.digest !== candidate.digest) fail('candidate changed while the approved release snapshot was being created');
  const packed = npmCommand(['pack', '--ignore-scripts', '--json', '--pack-destination', staging], snapshot);
  if (packed.status !== 0) fail(`candidate package assembly failed: ${packed.stderr || packed.stdout}`);
  let tarball: string;
  try {
    const result = JSON.parse(packed.stdout) as Array<{ filename?: string }> | Record<string, { filename?: string }>;
    const entry = Array.isArray(result) ? result[0] : Object.values(result)[0];
    if (typeof entry?.filename !== 'string') fail('candidate package assembly did not report a tarball');
    tarball = join(staging, entry.filename);
  } catch (error) {
    if (error instanceof MaintenanceValidationError) throw error;
    fail('candidate package assembly returned invalid JSON');
  }
  await mkdir(consumer, { mode: 0o700 });
  await writeFile(join(consumer, 'package.json'), '{"name":"faktori-managed-runtime","private":true}\n', { flag: 'wx', mode: 0o600 });
  const installed = npmCommand(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', tarball], consumer);
  if (installed.status !== 0) fail(`candidate dependency installation failed: ${installed.stderr || installed.stdout}`);
  const nativePackage = object(JSON.parse(await readFile(join(consumer, 'node_modules', 'better-sqlite3', 'package.json'), 'utf8')), 'installed better-sqlite3 package');
  if (nativePackage.version !== BETTER_SQLITE3_VERSION) fail(`installed better-sqlite3 must be ${BETTER_SQLITE3_VERSION}`);
  // All lifecycle scripts stay disabled during installation. The only script
  // subsequently authorized is the exact pinned native dependency build.
  const nativeBuild = npmCommand(['rebuild', `better-sqlite3@${BETTER_SQLITE3_VERSION}`, '--offline', '--foreground-scripts', '--no-audit', '--no-fund'], consumer);
  if (nativeBuild.status !== 0) fail(`pinned better-sqlite3 native build failed: ${nativeBuild.stderr || nativeBuild.stdout}`);
  const installedPackage = await candidateKit(join(consumer, 'node_modules', 'faktori'));
  if (installedPackage.digest !== candidate.digest) fail('clean installed package differs from the approved candidate digest');
  const entrypoint = join(consumer, 'node_modules', '.bin', 'faktori');
  const help = spawnSync(entrypoint, ['--help'], { cwd: consumer, encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
  if (help.status !== 0 || !help.stdout.includes('faktori backup create') || !help.stdout.includes('faktori update preview')) fail(`clean installed candidate entrypoint failed: ${help.stderr || help.stdout}`);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', "const m=await import('faktori/maintenance');if(typeof m.createFactoryBackup!=='function'||typeof m.applyRuntimeUpdate!=='function')process.exit(2)"], { cwd: consumer, encoding: 'utf8' });
  if (imported.status !== 0) fail(`clean installed maintenance export failed: ${imported.stderr || imported.stdout}`);
  await verifyRunnableRuntime(entrypoint, consumer);
  await rm(snapshot, { recursive: true, force: true });
  await rm(tarball, { force: true });
  return { entrypoint: 'runtime/node_modules/.bin/faktori' };
}

function approval(value: unknown): UpdateApproval {
  const input = object(value, 'update approval');
  if (input.format !== UPDATE_APPROVAL_FORMAT) fail(`update approval format must be ${UPDATE_APPROVAL_FORMAT}`);
  const digest = text(input.previewDigest, 'update approval previewDigest', 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) fail('update approval previewDigest is invalid');
  return { format: UPDATE_APPROVAL_FORMAT, previewDigest: digest, approvedBy: text(input.approvedBy, 'update approval approvedBy', 256), confirmedAt: text(input.confirmedAt, 'update approval confirmedAt', 128) };
}

export async function applyRuntimeUpdate(value: unknown): Promise<{ preview: UpdatePreview; manifest: RuntimeInstallationManifest; changed: boolean }> {
  const input = object(value, 'apply update request');
  const request = updateRequest(input.request);
  const approved = approval(input.approval);
  const installationRoot = await root(request.installationRoot, 'installationRoot');
  const control = join(installationRoot, '.faktori');
  const lock = await acquireUpdateLock(control, approved.previewDigest);
  try {
    // Recompute every approval-bound field after acquiring the update lock.
    // A candidate or active release mutation between preview and apply makes
    // the digest stale and is rejected before any release is activated.
    const preview = await previewRuntimeUpdate(request);
    if (approved.previewDigest !== preview.previewDigest) fail('update approval does not match the current locked preview');
    const [{ manifest }, candidate] = await Promise.all([readInstallation(request.installationRoot), candidateKit(request.candidateRoot)]);
    if (preview.outcome === 'already_current') return { preview, manifest, changed: false };
    const release = `${candidate.version}-${candidate.digest.slice(0, 16)}`;
    const releaseRoot = join(control, 'releases', release);
    try { await lstat(releaseRoot); fail('candidate release identity already exists but is not active; inspect it before retrying'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(dirname(releaseRoot), { recursive: true, mode: 0o700 });
    let releaseEntrypoint: string;
    // Creating the final content-addressed release directory is the atomic
    // no-overwrite reservation. A failed installation remains unreferenced
    // and visibly blocks reuse of that identity; owner files are never removed.
    ({ entrypoint: releaseEntrypoint } = await installCandidateRelease(candidate, releaseRoot));
    const activatedAt = new Date().toISOString();
    const next: RuntimeInstallationManifest = {
      ...manifest,
      stateFormatVersion: candidate.stateFormatVersion,
      activeVersion: candidate.version,
      activeRelease: release,
      activeDigest: candidate.digest,
      activeEntrypoint: `${release}/${releaseEntrypoint}`,
      releases: [...manifest.releases, { version: candidate.version, release, digest: candidate.digest, activatedAt, migration: preview.migration }],
    };
    const selectedEntrypoint = join(releaseRoot, releaseEntrypoint);
    const launch = spawnSync(selectedEntrypoint, ['--help'], { cwd: installationRoot, encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
    if (launch.status !== 0 || !launch.stdout.includes('faktori backup create')) fail('selected release entrypoint did not execute successfully before activation');
    const manifestPath = join(control, 'runtime-installation.json');
    const stagedManifest = `${manifestPath}.tmp-${randomUUID()}`;
    await writeFile(stagedManifest, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(stagedManifest, manifestPath);
    return { preview, manifest: next, changed: true };
  } finally {
    await lock.release();
  }
}

/** Register an existing public kit as the first immutable managed release. */
export async function initializeRuntimeInstallation(value: unknown): Promise<RuntimeInstallationManifest> {
  const request = updateRequest(value);
  const installationRoot = await root(request.installationRoot, 'installationRoot');
  const candidate = await candidateKit(request.candidateRoot);
  const control = join(installationRoot, '.faktori');
  const manifestPath = join(control, 'runtime-installation.json');
  await mkdir(join(control, 'releases'), { recursive: true, mode: 0o700 });
  const lock = await acquireUpdateLock(control, 'initialization');
  try {
    try { await lstat(manifestPath); fail('runtime installation is already initialized'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const release = `${candidate.version}-${candidate.digest.slice(0, 16)}`;
    const target = join(control, 'releases', release);
    let releaseEntrypoint: string;
    try { await lstat(target); fail('initial release identity already exists without an installation manifest; inspect it before retrying'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    ({ entrypoint: releaseEntrypoint } = await installCandidateRelease(candidate, target));
    const activatedAt = new Date().toISOString();
    const manifest: RuntimeInstallationManifest = {
      format: INSTALLATION_FORMAT,
      stateFormatVersion: candidate.stateFormatVersion,
      activeVersion: candidate.version,
      activeRelease: release,
      activeDigest: candidate.digest,
      activeEntrypoint: `${release}/${releaseEntrypoint}`,
      installedAt: activatedAt,
      releases: [{ version: candidate.version, release, digest: candidate.digest, activatedAt, migration: 'state-v1-initialized' }],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return manifest;
  } finally {
    await lock.release();
  }
}
