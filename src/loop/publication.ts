import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readlink, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { AuthorizedAction } from '../actions/index.ts';
import {
  GitHubDraftPullRequestExecutor,
  GitHubRepositoryObserver,
  spawnGh,
  spawnGit,
  type GitCommand,
  type GitHubCommand,
  type GitHubPublication,
  type GitHubPublicationStore,
  type GitHubPublisherTarget,
} from '../integrations/github.ts';
import { captureManagerLoopWorkspaceEvidence } from './index.ts';

const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{40,64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_REF = /^(?![-/.])(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)|[~^:?*\[\\\s]))[A-Za-z0-9._/-]+(?<![/.])$/;

type RecordValue = Record<string, unknown>;
type PublicationStatus = 'intended' | 'published' | 'reconciled' | 'blocked' | 'failed' | 'uncertain';

export interface LoopPublicationPrepareRequest {
  format: 'faktori.loop-publication-prepare/v1';
  approved: true;
  workspace: string;
  loopArtifactsDirectory: string;
  bundleDirectory: string;
}

export interface ReviewedFileEntry {
  path: string;
  payload: string;
  type: 'file' | 'symlink';
  mode: '100644' | '100755' | '120000';
  size: number;
  sha256: string;
  blobOid: string;
}

export interface LoopPublicationHandoff {
  format: 'faktori.loop-publication-handoff/v1';
  createdAt: string;
  origin: { loopArtifactsDirectory: string };
  loop: {
    loopId: string;
    reportDigest: string;
    acceptedEvidenceDigest: string;
    acceptedBranch: string;
    reviewStageId: string;
    managerAcceptanceStageId: string;
  };
  manifest: {
    objectFormat: 'sha1' | 'sha256';
    fileCount: number;
    totalBytes: number;
    reviewedTreeDigest: string;
    files: ReviewedFileEntry[];
  };
}

export interface LoopPublicationRequest {
  format: 'faktori.loop-publication-request/v1';
  approved: true;
  bundleDirectory: string;
  publication: {
    repository: string;
    branch: string;
    baseRefName: string;
    baseRevision: string;
    expectedRevision: string;
    publisherRemote: string;
    publisherWorktree: string;
  };
}

export interface LoopPublicationReceipt {
  format: 'faktori.loop-publication-receipt/v1';
  status: PublicationStatus;
  operationId: string;
  loop: {
    loopId: string;
    acceptedEvidenceDigest: string;
    reviewStageId: string;
    managerAcceptanceStageId: string;
  };
  binding: {
    repository: string;
    branch: string;
    baseRefName: string;
    baseRevision: string;
    expectedRevision: string;
    reviewedTreeDigest: string;
  };
  pr?: GitHubPublication;
  observedAt: string;
  detail?: string;
}

export interface LoopPublicationDependencies {
  gh?: GitHubCommand;
  git?: GitCommand;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface LoopPublicationPrepareDependencies {
  now?: () => Date;
  /** Test/embedding seam for a concurrent writer at the snapshot boundary. */
  afterManifestCaptured?: () => Promise<void> | void;
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: RecordValue, keys: readonly string[], name: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) throw new Error(`${name}_contains_unsupported_fields`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4_096 || value.includes('\0')) throw new Error(`${name}_required`);
  return value;
}

function absolutePath(value: unknown, name: string): string {
  const candidate = requiredString(value, name);
  if (!isAbsolute(candidate)) throw new Error(`${name}_must_be_absolute`);
  return resolve(candidate);
}

export function parseLoopPublicationPrepareRequest(input: unknown): LoopPublicationPrepareRequest {
  if (!record(input)) throw new Error('publication_prepare_request_must_be_an_object');
  exactKeys(input, ['format', 'approved', 'workspace', 'loopArtifactsDirectory', 'bundleDirectory'], 'publication_prepare_request');
  if (input.format !== 'faktori.loop-publication-prepare/v1') throw new Error('publication_prepare_format_invalid');
  if (input.approved !== true) throw new Error('publication_prepare_requires_explicit_owner_approval');
  return {
    format: 'faktori.loop-publication-prepare/v1', approved: true,
    workspace: absolutePath(input.workspace, 'publication_workspace'),
    loopArtifactsDirectory: absolutePath(input.loopArtifactsDirectory, 'publication_loop_artifacts_directory'),
    bundleDirectory: absolutePath(input.bundleDirectory, 'publication_bundle_directory'),
  };
}

export function parseLoopPublicationRequest(input: unknown): LoopPublicationRequest {
  if (!record(input)) throw new Error('publication_request_must_be_an_object');
  exactKeys(input, ['format', 'approved', 'bundleDirectory', 'publication'], 'publication_request');
  if (input.format !== 'faktori.loop-publication-request/v1') throw new Error('publication_request_format_invalid');
  if (input.approved !== true) throw new Error('publication_requires_explicit_owner_approval');
  if (!record(input.publication)) throw new Error('publication_scope_required');
  exactKeys(input.publication, ['repository', 'branch', 'baseRefName', 'baseRevision', 'expectedRevision', 'publisherRemote', 'publisherWorktree'], 'publication_scope');
  const repository = requiredString(input.publication.repository, 'publication_repository');
  const branch = requiredString(input.publication.branch, 'publication_branch');
  const baseRefName = requiredString(input.publication.baseRefName, 'publication_base_ref_name');
  const baseRevision = requiredString(input.publication.baseRevision, 'publication_base_revision');
  const expectedRevision = requiredString(input.publication.expectedRevision, 'publication_expected_revision');
  if (!REPOSITORY.test(repository)) throw new Error('publication_repository_invalid');
  if (!SAFE_REF.test(branch) || !SAFE_REF.test(baseRefName)) throw new Error('publication_ref_invalid');
  if (branch === baseRefName) throw new Error('publication_branch_must_differ_from_base');
  if (!COMMIT.test(baseRevision) || !COMMIT.test(expectedRevision)) throw new Error('publication_revision_must_be_an_exact_commit');
  return {
    format: 'faktori.loop-publication-request/v1', approved: true,
    bundleDirectory: absolutePath(input.bundleDirectory, 'publication_bundle_directory'),
    publication: {
      repository, branch, baseRefName, baseRevision, expectedRevision,
      publisherRemote: requiredString(input.publication.publisherRemote, 'publication_publisher_remote'),
      publisherWorktree: absolutePath(input.publication.publisherWorktree, 'publication_publisher_worktree'),
    },
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as RecordValue;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function blobOid(content: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${content.length}\0`).update(content).digest('hex');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}

async function controllerDirectory(path: string, writable: boolean, create = false, ownerOnly = true): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('publication_directory_must_be_a_real_directory');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('publication_directory_owner_mismatch');
  if (ownerOnly && (info.mode & 0o077) !== 0) throw new Error('publication_directory_permissions_must_be_owner_only');
  await access(path, constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0));
}

async function controllerFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('publication_file_must_be_a_regular_file');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('publication_file_owner_mismatch');
  if ((info.mode & 0o077) !== 0) throw new Error('publication_file_permissions_must_be_owner_only');
  await access(path, constants.R_OK);
}

async function readControllerFile(path: string, maximumBytes: number, tooLarge: string): Promise<Buffer> {
  await controllerFile(path);
  const before = await lstat(path);
  if (before.size > maximumBytes) throw new Error(tooLarge);
  const body = await readFile(path);
  if (body.length > maximumBytes) throw new Error(tooLarge);
  return body;
}

async function withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('publication_operation_already_running');
    throw error;
  }
  try { return await task(); }
  finally { await lock.close(); await rm(path, { force: true }); }
}

function safeRelativePath(path: string, name = 'publication_file_path'): string {
  if (path.length === 0 || path.includes('\0') || isAbsolute(path)) throw new Error(`${name}_unsafe`);
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment === '.git')) throw new Error(`${name}_unsafe`);
  return path;
}

async function gitBuffer(workspace: string, args: string[]): Promise<Buffer> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout) => error === null ? resolvePromise(stdout) : reject(error));
  });
}

function acceptedLoopReport(value: unknown, reportBody: Buffer): LoopPublicationHandoff['loop'] {
  if (!record(value) || value.format !== 'faktori.manager-loop-result/v1' || value.status !== 'succeeded' || typeof value.loopId !== 'string' || !Array.isArray(value.stages) || value.stages.length === 0) throw new Error('publication_requires_a_succeeded_manager_loop_report');
  const stages = value.stages.filter(record);
  if (stages.length !== value.stages.length) throw new Error('publication_loop_report_stages_invalid');
  const acceptance = stages.at(-1);
  if ((acceptance?.kind !== 'manager_accept' && acceptance?.kind !== 'deterministic_accept') || typeof acceptance.stageId !== 'string' || !record(acceptance.response) || acceptance.response.accepted !== true || !record(acceptance.evidence)) throw new Error('publication_requires_final_manager_acceptance');
  const acceptedEvidenceDigest = requiredString(acceptance.response.evidenceDigest, 'publication_accepted_evidence_digest');
  const acceptedBranch = requiredString(acceptance.evidence.branch, 'publication_accepted_branch');
  if (acceptance.evidence.contentDigest !== acceptedEvidenceDigest) throw new Error('publication_manager_acceptance_evidence_mismatch');
  const reviewStageId = requiredString(acceptance.response.reviewStageId, 'publication_review_stage_id');
  const reviewStageIds = acceptance.kind === 'deterministic_accept' ? acceptance.response.reviewStageIds : [reviewStageId];
  if (!Array.isArray(reviewStageIds) || reviewStageIds.length < 1 || reviewStageIds.some((id) => typeof id !== 'string') || reviewStageIds.at(-1) !== reviewStageId) throw new Error('publication_exact_review_evidence_missing');
  const reviews = reviewStageIds.map((id) => stages.find((stage) => stage.stageId === id));
  if (reviews.some((review) => review?.kind !== 'review' || review.phaseId !== acceptance.phaseId || !record(review.response) || review.response.verdict !== 'pass' || review.response.evidenceDigest !== acceptedEvidenceDigest || !record(review.evidence) || review.evidence.contentDigest !== acceptedEvidenceDigest)) throw new Error('publication_exact_review_evidence_missing');
  if (reviews.some((review) => !Array.isArray(review?.verification) || review.verification.length === 0 || review.verification.some((item) => !record(item) || item.passed !== true || (acceptance.kind === 'deterministic_accept' && item.evidenceDigest !== acceptedEvidenceDigest)))) throw new Error('publication_passing_verification_receipts_missing');
  if (acceptance.kind === 'deterministic_accept') {
    const receipt = acceptance.response.receipt;
    if (!record(receipt)) throw new Error('publication_deterministic_acceptance_receipt_invalid');
    const actor = receipt.actor;
    const evidence = receipt.evidence;
    if (!record(actor) || !record(evidence) || !record(evidence.candidate)) throw new Error('publication_deterministic_acceptance_receipt_invalid');
    const candidate = evidence.candidate;
    if (receipt.format !== 'faktori.lean-acceptance-receipt/v1' || receipt.accepted !== true || actor.kind !== 'deterministic' || actor.id !== 'faktori.lean.accept/v1'
      || receipt.loopId !== value.loopId || receipt.stageId !== acceptance.stageId || candidate?.contentDigest !== acceptedEvidenceDigest || candidate.branch !== acceptedBranch
      || !Array.isArray(evidence?.reviewStageIds) || canonical(evidence.reviewStageIds) !== canonical(reviewStageIds)
      || typeof evidence?.requirementsDigest !== 'string' || typeof evidence?.acceptanceCriteriaDigest !== 'string' || typeof evidence?.verificationDigest !== 'string' || typeof evidence?.preflightDigest !== 'string'
      || evidence.verificationDigest !== sha256(canonical(acceptance.verification)) || typeof receipt.reusable !== 'boolean') throw new Error('publication_deterministic_acceptance_receipt_invalid');
  }
  return {
    loopId: value.loopId,
    reportDigest: sha256(reportBody),
    acceptedEvidenceDigest,
    acceptedBranch,
    reviewStageId,
    managerAcceptanceStageId: acceptance.stageId,
  };
}

async function writePayload(bundle: string, path: string, content: Buffer): Promise<string> {
  const payload = join('files', ...path.split('/'));
  const absolute = join(bundle, payload);
  const within = relative(bundle, absolute);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('publication_payload_path_unsafe');
  await mkdir(resolve(absolute, '..'), { recursive: true, mode: 0o700 });
  const handle = await open(absolute, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  return payload.split(sep).join('/');
}

async function captureReviewedManifest(workspace: string, bundle: string): Promise<LoopPublicationHandoff['manifest']> {
  const formatText = (await gitBuffer(workspace, ['rev-parse', '--show-object-format'])).toString('utf8').trim();
  if (formatText !== 'sha1' && formatText !== 'sha256') throw new Error('publication_git_object_format_unsupported');
  const paths = [...new Set((await gitBuffer(workspace, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).toString('utf8').split('\0').filter(Boolean))].sort();
  if (paths.length > MAX_FILES) throw new Error('publication_bundle_file_limit_exceeded');
  const files: ReviewedFileEntry[] = [];
  let totalBytes = 0;
  for (const rawPath of paths) {
    const path = safeRelativePath(rawPath);
    const absolute = resolve(workspace, path);
    const within = relative(resolve(workspace), absolute);
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('publication_workspace_path_unsafe');
    let info;
    try { info = await lstat(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let content: Buffer;
    let type: ReviewedFileEntry['type'];
    let mode: ReviewedFileEntry['mode'];
    if (info.isFile()) {
      if (totalBytes + info.size > MAX_BYTES) throw new Error('publication_bundle_byte_limit_exceeded');
      content = await readFile(absolute); type = 'file'; mode = (info.mode & 0o111) === 0 ? '100644' : '100755';
    } else if (info.isSymbolicLink()) {
      content = Buffer.from(await readlink(absolute)); type = 'symlink'; mode = '120000';
    } else throw new Error(`publication_file_type_unsupported:${path}`);
    totalBytes += content.length;
    if (totalBytes > MAX_BYTES) throw new Error('publication_bundle_byte_limit_exceeded');
    const payload = await writePayload(bundle, path, content);
    files.push({ path, payload, type, mode, size: content.length, sha256: sha256(content), blobOid: blobOid(content, formatText) });
  }
  return { objectFormat: formatText, fileCount: files.length, totalBytes, reviewedTreeDigest: sha256(canonical(files.map(({ payload: _payload, ...entry }) => entry))), files };
}

async function verifyWorkspaceMatchesManifest(workspace: string, manifest: LoopPublicationHandoff['manifest']): Promise<void> {
  const paths = [...new Set((await gitBuffer(workspace, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).toString('utf8').split('\0').filter(Boolean))].sort();
  const expectedPaths = manifest.files.map((entry) => entry.path);
  const entries = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const existingPaths: string[] = [];
  for (const path of paths) {
    const absolute = resolve(workspace, safeRelativePath(path));
    let info;
    try { info = await lstat(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    existingPaths.push(path);
    const entry = entries.get(path);
    if (entry === undefined) throw new Error('publication_workspace_changed_during_bundle_capture');
    const content = info.isFile() ? await readFile(absolute) : info.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : undefined;
    const mode = info.isFile() ? ((info.mode & 0o111) === 0 ? '100644' : '100755') : info.isSymbolicLink() ? '120000' : undefined;
    if (content === undefined || mode !== entry.mode || content.length !== entry.size || sha256(content) !== entry.sha256 || blobOid(content, manifest.objectFormat) !== entry.blobOid) throw new Error('publication_workspace_changed_during_bundle_capture');
  }
  if (canonical(existingPaths) !== canonical(expectedPaths)) throw new Error('publication_workspace_changed_during_bundle_capture');
}

export async function prepareLoopPublicationHandoff(input: unknown, dependencies: LoopPublicationPrepareDependencies = {}): Promise<LoopPublicationHandoff> {
  const request = parseLoopPublicationPrepareRequest(input);
  await controllerDirectory(request.workspace, true, false, false);
  await controllerDirectory(request.loopArtifactsDirectory, true);
  await controllerDirectory(request.bundleDirectory, true, true);
  return withLock(join(request.bundleDirectory, '.prepare.lock'), async () => {
    const reportPath = join(request.loopArtifactsDirectory, 'report.json');
    const reportBody = await readControllerFile(reportPath, 16 * 1024 * 1024, 'publication_loop_report_too_large');
    let report: unknown;
    try { report = JSON.parse(reportBody.toString('utf8')); } catch { throw new Error('publication_loop_report_invalid_json'); }
    const loop = acceptedLoopReport(report, reportBody);
    const evidence = await captureManagerLoopWorkspaceEvidence(request.workspace);
    if (evidence.contentDigest !== loop.acceptedEvidenceDigest || evidence.branch !== loop.acceptedBranch) throw new Error('publication_workspace_no_longer_matches_accepted_review');
    const handoffPath = join(request.bundleDirectory, 'handoff.json');
    try {
      const existing = parseLoopPublicationHandoff(JSON.parse((await readControllerFile(handoffPath, 16 * 1024 * 1024, 'publication_handoff_too_large')).toString('utf8')));
      if (canonical(existing.loop) !== canonical(loop)) throw new Error('publication_bundle_already_bound_to_different_review');
      await verifyPayloads(request.bundleDirectory, existing);
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try { await lstat(join(request.bundleDirectory, 'files')); throw new Error('publication_incomplete_bundle_requires_owner_recovery'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(join(request.bundleDirectory, 'files'), { mode: 0o700 });
    const manifest = await captureReviewedManifest(request.workspace, request.bundleDirectory);
    await dependencies.afterManifestCaptured?.();
    const afterCapture = await captureManagerLoopWorkspaceEvidence(request.workspace);
    if (afterCapture.contentDigest !== loop.acceptedEvidenceDigest || afterCapture.branch !== loop.acceptedBranch) throw new Error('publication_workspace_changed_during_bundle_capture');
    await verifyWorkspaceMatchesManifest(request.workspace, manifest);
    const afterVerification = await captureManagerLoopWorkspaceEvidence(request.workspace);
    if (afterVerification.contentDigest !== loop.acceptedEvidenceDigest || afterVerification.branch !== loop.acceptedBranch) throw new Error('publication_workspace_changed_during_bundle_capture');
    const handoff: LoopPublicationHandoff = {
      format: 'faktori.loop-publication-handoff/v1',
      createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      origin: { loopArtifactsDirectory: request.loopArtifactsDirectory },
      loop,
      manifest,
    };
    await atomicJson(handoffPath, handoff);
    return handoff;
  });
}

function parseLoopPublicationHandoff(input: unknown): LoopPublicationHandoff {
  if (!record(input) || input.format !== 'faktori.loop-publication-handoff/v1' || !record(input.origin) || !record(input.loop) || !record(input.manifest) || !Array.isArray(input.manifest.files)) throw new Error('publication_handoff_invalid');
  const objectFormat = input.manifest.objectFormat;
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error('publication_handoff_object_format_invalid');
  const files = input.manifest.files.map((value): ReviewedFileEntry => {
    if (!record(value)) throw new Error('publication_handoff_file_invalid');
    const type = value.type;
    const mode = value.mode;
    if ((type !== 'file' && type !== 'symlink') || !['100644', '100755', '120000'].includes(String(mode))) throw new Error('publication_handoff_file_invalid');
    const path = safeRelativePath(requiredString(value.path, 'publication_handoff_file_path'));
    const payload = safeRelativePath(requiredString(value.payload, 'publication_handoff_payload_path'), 'publication_handoff_payload_path');
    if (!payload.startsWith('files/')) throw new Error('publication_handoff_payload_path_unsafe');
    if (!Number.isInteger(value.size) || (value.size as number) < 0 || typeof value.sha256 !== 'string' || typeof value.blobOid !== 'string') throw new Error('publication_handoff_file_invalid');
    return { path, payload, type, mode: mode as ReviewedFileEntry['mode'], size: value.size as number, sha256: value.sha256, blobOid: value.blobOid };
  });
  if (input.manifest.fileCount !== files.length || !Number.isInteger(input.manifest.totalBytes) || input.manifest.totalBytes as number > MAX_BYTES || typeof input.manifest.reviewedTreeDigest !== 'string') throw new Error('publication_handoff_manifest_invalid');
  const loop = input.loop;
  return {
    format: 'faktori.loop-publication-handoff/v1',
    createdAt: requiredString(input.createdAt, 'publication_handoff_created_at'),
    origin: { loopArtifactsDirectory: absolutePath(input.origin.loopArtifactsDirectory, 'publication_handoff_origin') },
    loop: {
      loopId: requiredString(loop.loopId, 'publication_handoff_loop_id'),
      reportDigest: requiredString(loop.reportDigest, 'publication_handoff_report_digest'),
      acceptedEvidenceDigest: requiredString(loop.acceptedEvidenceDigest, 'publication_handoff_evidence_digest'),
      acceptedBranch: requiredString(loop.acceptedBranch, 'publication_handoff_branch'),
      reviewStageId: requiredString(loop.reviewStageId, 'publication_handoff_review_stage'),
      managerAcceptanceStageId: requiredString(loop.managerAcceptanceStageId, 'publication_handoff_acceptance_stage'),
    },
    manifest: { objectFormat, fileCount: files.length, totalBytes: input.manifest.totalBytes as number, reviewedTreeDigest: input.manifest.reviewedTreeDigest, files },
  };
}

async function verifyPayloads(bundle: string, handoff: LoopPublicationHandoff): Promise<void> {
  if (handoff.manifest.files.length > MAX_FILES) throw new Error('publication_bundle_file_limit_exceeded');
  let totalBytes = 0;
  for (const entry of handoff.manifest.files) {
    const path = resolve(bundle, entry.payload);
    const within = relative(bundle, path);
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('publication_payload_path_unsafe');
    const remaining = MAX_BYTES - totalBytes;
    const content = await readControllerFile(path, remaining, 'publication_bundle_byte_limit_exceeded');
    totalBytes += content.length;
    if (content.length !== entry.size || sha256(content) !== entry.sha256 || blobOid(content, handoff.manifest.objectFormat) !== entry.blobOid) throw new Error(`publication_payload_digest_mismatch:${entry.path}`);
  }
  const treeDigest = sha256(canonical(handoff.manifest.files.map(({ payload: _payload, ...entry }) => entry)));
  if (totalBytes !== handoff.manifest.totalBytes || treeDigest !== handoff.manifest.reviewedTreeDigest) throw new Error('publication_reviewed_tree_digest_mismatch');
}

async function verifyCommit(git: GitCommand, request: LoopPublicationRequest, handoff: LoopPublicationHandoff): Promise<void> {
  const prefix = ['-C', request.publication.publisherWorktree, '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper='];
  const object = await git([...prefix, 'rev-parse', '--verify', `${request.publication.expectedRevision}^{commit}`]);
  if (object.exitCode !== 0 || object.stdout.trim() !== request.publication.expectedRevision) throw new Error('publication_expected_commit_missing');
  const format = await git([...prefix, 'rev-parse', '--show-object-format']);
  if (format.exitCode !== 0 || format.stdout.trim() !== handoff.manifest.objectFormat) throw new Error('publication_git_object_format_mismatch');
  const tree = await git([...prefix, 'ls-tree', '-rz', '--full-tree', request.publication.expectedRevision]);
  if (tree.exitCode !== 0) throw new Error('publication_expected_tree_unavailable');
  const observed = tree.stdout.split('\0').filter(Boolean).map((line) => {
    const match = /^(\d+)\s+(\S+)\s+([0-9a-f]+)\t([\s\S]+)$/.exec(line);
    if (match === null || match[2] !== 'blob') throw new Error('publication_expected_tree_contains_unsupported_entry');
    return { mode: match[1], blobOid: match[3], path: match[4] };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const expected = handoff.manifest.files.map(({ mode, blobOid: oid, path }) => ({ mode, blobOid: oid, path })).sort((left, right) => left.path.localeCompare(right.path));
  if (canonical(observed) !== canonical(expected)) throw new Error('publication_commit_does_not_match_reviewed_tree');
  const ancestry = await git([...prefix, 'merge-base', '--is-ancestor', request.publication.baseRevision, request.publication.expectedRevision]);
  if (ancestry.exitCode !== 0) throw new Error('publication_base_is_not_an_ancestor_of_expected_commit');
}

function operationId(request: LoopPublicationRequest, handoff: LoopPublicationHandoff): string {
  const binding = {
    loopId: handoff.loop.loopId,
    acceptedEvidenceDigest: handoff.loop.acceptedEvidenceDigest,
    reviewedTreeDigest: handoff.manifest.reviewedTreeDigest,
    repository: request.publication.repository,
    branch: request.publication.branch,
    baseRefName: request.publication.baseRefName,
    baseRevision: request.publication.baseRevision,
    expectedRevision: request.publication.expectedRevision,
  };
  return `loop-publication-${sha256(canonical(binding)).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function receiptFor(request: LoopPublicationRequest, handoff: LoopPublicationHandoff, status: PublicationStatus, now: Date, pr?: GitHubPublication, detail?: string): LoopPublicationReceipt {
  return {
    format: 'faktori.loop-publication-receipt/v1', status, operationId: operationId(request, handoff),
    loop: { loopId: handoff.loop.loopId, acceptedEvidenceDigest: handoff.loop.acceptedEvidenceDigest, reviewStageId: handoff.loop.reviewStageId, managerAcceptanceStageId: handoff.loop.managerAcceptanceStageId },
    binding: { repository: request.publication.repository, branch: request.publication.branch, baseRefName: request.publication.baseRefName, baseRevision: request.publication.baseRevision, expectedRevision: request.publication.expectedRevision, reviewedTreeDigest: handoff.manifest.reviewedTreeDigest },
    ...(pr === undefined ? {} : { pr }), observedAt: now.toISOString(), ...(detail === undefined ? {} : { detail: detail.slice(0, 512) }),
  };
}

function sameReceiptBinding(left: LoopPublicationReceipt, right: LoopPublicationReceipt): boolean {
  return left.operationId === right.operationId && canonical(left.loop) === canonical(right.loop) && canonical(left.binding) === canonical(right.binding);
}

function receiptRank(receipt: LoopPublicationReceipt): number {
  if ((receipt.status === 'published' || receipt.status === 'reconciled') && receipt.pr !== undefined) return 3;
  if (receipt.pr !== undefined) return 2;
  return receipt.status === 'intended' ? 1 : 0;
}

function publicationMatches(value: GitHubPublication, request: LoopPublicationRequest): boolean {
  if (!Number.isInteger(value.number) || value.number < 1 || value.isDraft !== true || value.headRefName !== request.publication.branch || value.headRefOid !== request.publication.expectedRevision || value.baseRefName !== request.publication.baseRefName) return false;
  try {
    const url = new URL(value.url);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.search && !url.hash && url.pathname === `/${request.publication.repository}/pull/${value.number}`;
  } catch { return false; }
}

async function writeReceipt(bundle: string, handoff: LoopPublicationHandoff, receipt: LoopPublicationReceipt): Promise<void> {
  await atomicJson(join(bundle, 'publication.json'), receipt);
  await atomicJson(join(handoff.origin.loopArtifactsDirectory, 'publication.json'), receipt);
}

function parseReceipt(value: unknown): LoopPublicationReceipt {
  if (!record(value)) throw new Error('publication_receipt_invalid');
  exactKeys(value, ['format', 'status', 'operationId', 'loop', 'binding', 'pr', 'observedAt', 'detail'], 'publication_receipt');
  if (value.format !== 'faktori.loop-publication-receipt/v1' || !['intended', 'published', 'reconciled', 'blocked', 'failed', 'uncertain'].includes(String(value.status)) || !record(value.loop) || !record(value.binding)) throw new Error('publication_receipt_invalid');
  exactKeys(value.loop, ['loopId', 'acceptedEvidenceDigest', 'reviewStageId', 'managerAcceptanceStageId'], 'publication_receipt_loop');
  exactKeys(value.binding, ['repository', 'branch', 'baseRefName', 'baseRevision', 'expectedRevision', 'reviewedTreeDigest'], 'publication_receipt_binding');
  const receipt: LoopPublicationReceipt = {
    format: 'faktori.loop-publication-receipt/v1', status: value.status as PublicationStatus,
    operationId: requiredString(value.operationId, 'publication_receipt_operation_id'),
    loop: {
      loopId: requiredString(value.loop.loopId, 'publication_receipt_loop_id'),
      acceptedEvidenceDigest: requiredString(value.loop.acceptedEvidenceDigest, 'publication_receipt_evidence_digest'),
      reviewStageId: requiredString(value.loop.reviewStageId, 'publication_receipt_review_stage'),
      managerAcceptanceStageId: requiredString(value.loop.managerAcceptanceStageId, 'publication_receipt_acceptance_stage'),
    },
    binding: {
      repository: requiredString(value.binding.repository, 'publication_receipt_repository'),
      branch: requiredString(value.binding.branch, 'publication_receipt_branch'),
      baseRefName: requiredString(value.binding.baseRefName, 'publication_receipt_base_ref'),
      baseRevision: requiredString(value.binding.baseRevision, 'publication_receipt_base_revision'),
      expectedRevision: requiredString(value.binding.expectedRevision, 'publication_receipt_expected_revision'),
      reviewedTreeDigest: requiredString(value.binding.reviewedTreeDigest, 'publication_receipt_tree_digest'),
    },
    observedAt: requiredString(value.observedAt, 'publication_receipt_observed_at'),
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
  };
  if (!REPOSITORY.test(receipt.binding.repository) || !SAFE_REF.test(receipt.binding.branch) || !SAFE_REF.test(receipt.binding.baseRefName) || receipt.binding.branch === receipt.binding.baseRefName || !COMMIT.test(receipt.binding.baseRevision) || !COMMIT.test(receipt.binding.expectedRevision) || !/^sha256:[0-9a-f]{64}$/.test(receipt.loop.acceptedEvidenceDigest) || !/^sha256:[0-9a-f]{64}$/.test(receipt.binding.reviewedTreeDigest) || !Number.isFinite(Date.parse(receipt.observedAt))) throw new Error('publication_receipt_invalid');
  if (value.pr !== undefined) {
    if (!record(value.pr)) throw new Error('publication_receipt_pr_invalid');
    exactKeys(value.pr, ['number', 'url', 'headRefName', 'headRefOid', 'baseRefName', 'isDraft'], 'publication_receipt_pr');
    if (!Number.isInteger(value.pr.number) || (value.pr.number as number) < 1 || typeof value.pr.url !== 'string' || typeof value.pr.headRefName !== 'string' || typeof value.pr.headRefOid !== 'string' || typeof value.pr.baseRefName !== 'string' || typeof value.pr.isDraft !== 'boolean') throw new Error('publication_receipt_pr_invalid');
    receipt.pr = { number: value.pr.number as number, url: value.pr.url, headRefName: value.pr.headRefName, headRefOid: value.pr.headRefOid, baseRefName: value.pr.baseRefName, isDraft: value.pr.isDraft };
  }
  if ((receipt.status === 'published' || receipt.status === 'reconciled') && receipt.pr === undefined) throw new Error('publication_receipt_final_status_requires_pr');
  return receipt;
}

interface RemotePublicationObservation { state: 'MISSING' | 'OPEN' | 'CLOSED' | 'MERGED'; publication?: GitHubPublication }

async function observePriorPublication(gh: GitHubCommand, request: LoopPublicationRequest, operation: string): Promise<RemotePublicationObservation> {
  const result = await gh(['pr', 'list', '--repo', request.publication.repository, '--head', request.publication.branch, '--state', 'all', '--search', `Faktori operation ${operation}`, '--json', 'number,url,headRefName,headRefOid,baseRefName,isDraft,state', '--limit', '2']);
  if (result.exitCode !== 0) throw new Error(`gh_pr_reconciliation_failed:${(result.stderr || result.stdout).slice(0, 512)}`);
  let values: unknown;
  try { values = JSON.parse(result.stdout); } catch { throw new Error('gh_pr_reconciliation_invalid_json'); }
  if (!Array.isArray(values) || values.length === 0) return { state: 'MISSING' };
  if (values.length !== 1 || !record(values[0])) throw new Error('gh_pr_reconciliation_ambiguous_or_invalid');
  const item = values[0];
  if (!Number.isInteger(item.number) || typeof item.url !== 'string' || typeof item.headRefName !== 'string' || typeof item.headRefOid !== 'string' || typeof item.baseRefName !== 'string' || typeof item.isDraft !== 'boolean' || !['OPEN', 'CLOSED', 'MERGED'].includes(String(item.state))) throw new Error('gh_pr_reconciliation_invalid_shape');
  return { state: item.state as RemotePublicationObservation['state'], publication: { number: item.number as number, url: item.url, headRefName: item.headRefName, headRefOid: item.headRefOid, baseRefName: item.baseRefName, isDraft: item.isDraft } };
}

class ReceiptPublicationStore implements GitHubPublicationStore {
  value?: GitHubPublication;
  constructor(value?: GitHubPublication) { this.value = value; }
  async find(_operationId: string): Promise<GitHubPublication | undefined> { return this.value; }
  async save(_operationId: string, publication: GitHubPublication): Promise<void> { this.value = structuredClone(publication); }
}

export async function publishLoopPublication(input: unknown, dependencies: LoopPublicationDependencies = {}): Promise<LoopPublicationReceipt> {
  const request = parseLoopPublicationRequest(input);
  const now = dependencies.now ?? (() => new Date());
  const gh = dependencies.gh ?? spawnGh;
  const git = dependencies.git ?? spawnGit;
  await controllerDirectory(request.bundleDirectory, true);
  const handoffPath = join(request.bundleDirectory, 'handoff.json');
  const handoff = parseLoopPublicationHandoff(JSON.parse((await readControllerFile(handoffPath, 16 * 1024 * 1024, 'publication_handoff_too_large')).toString('utf8')));
  await controllerDirectory(handoff.origin.loopArtifactsDirectory, true);
  await controllerDirectory(request.publication.publisherWorktree, false, false, false);
  return withLock(join(request.bundleDirectory, '.publication.lock'), async () => {
    await verifyPayloads(request.bundleDirectory, handoff);
    await verifyCommit(git, request, handoff);
    const intended = receiptFor(request, handoff, 'intended', now());
    let prior: LoopPublicationReceipt | undefined;
    for (const path of [join(request.bundleDirectory, 'publication.json'), join(handoff.origin.loopArtifactsDirectory, 'publication.json')]) {
      let candidate: LoopPublicationReceipt | undefined;
      try { candidate = parseReceipt(JSON.parse((await readControllerFile(path, 1024 * 1024, 'publication_receipt_too_large')).toString('utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (candidate !== undefined && !sameReceiptBinding(candidate, intended)) throw new Error('publication_retry_binding_mismatch');
      if (candidate !== undefined && (prior === undefined || receiptRank(candidate) > receiptRank(prior))) prior = candidate;
    }
    if (prior !== undefined && !sameReceiptBinding(prior, intended)) throw new Error('publication_retry_binding_mismatch');
    if (prior?.pr !== undefined) {
      if (!publicationMatches(prior.pr, request)) throw new Error('publication_stored_pr_mismatch');
      let remote: RemotePublicationObservation;
      try { remote = await observePriorPublication(gh, request, intended.operationId); }
      catch (error) {
        const uncertain = receiptFor(request, handoff, 'uncertain', now(), prior.pr, error instanceof Error ? error.message : 'publication_remote_reconciliation_failed');
        await writeReceipt(request.bundleDirectory, handoff, uncertain);
        return uncertain;
      }
      if (remote.state !== 'OPEN' || remote.publication === undefined || !publicationMatches(remote.publication, request)) {
        const detail = remote.state === 'MISSING' ? 'stored_publication_not_observed_remotely' : remote.state !== 'OPEN' ? `remote_publication_is_${remote.state.toLowerCase()}` : 'remote_publication_does_not_match_exact_binding';
        const uncertain = receiptFor(request, handoff, 'uncertain', now(), remote.publication ?? prior.pr, detail);
        await writeReceipt(request.bundleDirectory, handoff, uncertain);
        return uncertain;
      }
      const reconciled = receiptFor(request, handoff, 'reconciled', now(), remote.publication, 'existing_exact_publication_reused');
      await writeReceipt(request.bundleDirectory, handoff, reconciled);
      return reconciled;
    }
    const registration = await new GitHubRepositoryObserver(gh).register(request.publication.repository);
    if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(registration.viewerPermission)) throw new Error('publication_repository_write_permission_required');
    await writeReceipt(request.bundleDirectory, handoff, intended);
    if (prior !== undefined) {
      let remote: RemotePublicationObservation;
      try { remote = await observePriorPublication(gh, request, intended.operationId); }
      catch (error) {
        const uncertain = receiptFor(request, handoff, 'uncertain', now(), undefined, error instanceof Error ? error.message : 'publication_remote_reconciliation_failed');
        await writeReceipt(request.bundleDirectory, handoff, uncertain);
        return uncertain;
      }
      if (remote.state !== 'MISSING') {
        const exact = remote.publication !== undefined && publicationMatches(remote.publication, request);
        const status: PublicationStatus = remote.state === 'OPEN' && exact ? 'reconciled' : 'uncertain';
        const detail = remote.state === 'OPEN' && exact ? 'existing_exact_publication_reused' : remote.state !== 'OPEN' ? `remote_publication_is_${remote.state.toLowerCase()}` : 'remote_publication_does_not_match_exact_binding';
        const reconciled = receiptFor(request, handoff, status, now(), remote.publication, detail);
        await writeReceipt(request.bundleDirectory, handoff, reconciled);
        return reconciled;
      }
    }
    const target: GitHubPublisherTarget = { ...request.publication };
    const store = new ReceiptPublicationStore();
    const action: AuthorizedAction = {
      operationId: intended.operationId,
      request: {
        format: 'faktori.action-request/v1', actionId: `publish-${handoff.loop.loopId}`, idempotencyKey: intended.operationId, runId: handoff.loop.loopId,
        scope: { kind: 'github.draft-pr', repository: target.repository, branch: target.branch, baseRevision: target.baseRevision, expectedRevision: target.expectedRevision, allowedOperation: 'github.draft-pr', scopeRevision: handoff.manifest.reviewedTreeDigest },
        authorityEpoch: 0, requestDigest: sha256(canonical(intended.binding)), requestedAt: intended.observedAt,
      },
      grant: { format: 'faktori.action-grant/v1', grantId: intended.operationId, runId: handoff.loop.loopId, scope: { kind: 'github.draft-pr', repository: target.repository, branch: target.branch, baseRevision: target.baseRevision, expectedRevision: target.expectedRevision, allowedOperation: 'github.draft-pr', scopeRevision: handoff.manifest.reviewedTreeDigest }, authorityEpoch: 0, issuedAt: intended.observedAt, verification: { algorithm: 'hmac-sha256', keyId: 'explicit-owner-publication-request' } },
    };
    const guard = async (): Promise<void> => {
      if (dependencies.signal?.aborted === true) throw new Error('publication_cancelled_before_effect');
    };
    let outcome: Awaited<ReturnType<GitHubDraftPullRequestExecutor['execute']>>;
    try { outcome = await new GitHubDraftPullRequestExecutor(target, gh, store, git).execute(action, guard); }
    catch (error) {
      const status: PublicationStatus = dependencies.signal?.aborted === true ? 'blocked' : 'uncertain';
      const observed = receiptFor(request, handoff, status, now(), store.value, error instanceof Error ? error.message : 'publication_executor_failed');
      await writeReceipt(request.bundleDirectory, handoff, observed);
      return observed;
    }
    const status: PublicationStatus = outcome.outcome === 'completed' ? 'published' : outcome.outcome === 'safe_noop' ? 'reconciled' : outcome.outcome;
    const finalStatus = (status === 'published' || status === 'reconciled') && (store.value === undefined || !publicationMatches(store.value, request)) ? 'uncertain' : status;
    const detail = finalStatus === 'uncertain' && status !== 'uncertain' ? 'observed_publication_does_not_match_exact_binding' : outcome.detail;
    const observed = receiptFor(request, handoff, finalStatus, now(), store.value, detail);
    await writeReceipt(request.bundleDirectory, handoff, observed);
    return observed;
  });
}
