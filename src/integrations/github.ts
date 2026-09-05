import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { ActionExecutionResult, AuthorizedAction, ControllerActionExecutor } from '../actions/index.ts';

export interface GitHubCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitHubCommand = (argv: readonly string[], input?: string) => Promise<GitHubCommandResult>;

export interface GitHubPublisherTarget {
  /** Controller-owned GitHub repository identity, never supplied by a worker. */
  repository: string;
  branch: string;
  baseRevision: string;
  expectedRevision: string;
  publisherRemote: string;
}

export interface GitHubPublication {
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
}

export interface GitHubPublicationStore {
  find(operationId: string): Promise<GitHubPublication | undefined>;
  save(operationId: string, publication: GitHubPublication): Promise<void>;
}

export interface GitHubRepositoryRegistration {
  repository: string;
  viewerPermission: 'ADMIN' | 'MAINTAIN' | 'WRITE' | 'TRIAGE' | 'READ';
  private: boolean;
}

export interface GitHubCheckObservation { name: string; state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'SKIPPING'; link?: string; }

/** Read-only gh operations needed before a controller can admit publication. */
export class GitHubRepositoryObserver {
  private readonly command: GitHubCommand;
  constructor(command: GitHubCommand) { this.command = command; }

  async register(repository: string): Promise<GitHubRepositoryRegistration> {
    const result = await this.command(['repo', 'view', repository, '--json', 'nameWithOwner,viewerPermission,isPrivate']);
    if (result.exitCode !== 0) throw new Error(bounded(`gh_repository_registration_failed:${result.stderr || result.stdout}`));
    const value = parseObject(result.stdout, 'gh_repository_registration_invalid_json');
    const permission = value.viewerPermission;
    if (value.nameWithOwner !== repository || typeof value.isPrivate !== 'boolean' || !['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(String(permission))) throw new Error('gh_repository_registration_invalid_shape');
    return { repository, viewerPermission: permission as GitHubRepositoryRegistration['viewerPermission'], private: value.isPrivate };
  }

  async observeChecks(target: Pick<GitHubPublisherTarget, 'repository' | 'expectedRevision'>): Promise<readonly GitHubCheckObservation[]> {
    const result = await this.command(['pr', 'checks', target.expectedRevision, '--repo', target.repository, '--json', 'name,state,link']);
    if (result.exitCode !== 0) throw new Error(bounded(`gh_check_observation_failed:${result.stderr || result.stdout}`));
    const value = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(value)) throw new Error('gh_check_observation_invalid_json');
    return value.map((item) => {
      const record = parseObject(JSON.stringify(item), 'gh_check_observation_invalid_shape');
      if (typeof record.name !== 'string' || !['SUCCESS', 'FAILURE', 'PENDING', 'SKIPPING'].includes(String(record.state)) || (record.link !== undefined && typeof record.link !== 'string')) throw new Error('gh_check_observation_invalid_shape');
      return { name: record.name, state: record.state as GitHubCheckObservation['state'], ...(record.link === undefined ? {} : { link: record.link as string }) };
    });
  }

  async observeMerge(repository: string, number: number): Promise<{ merged: boolean; mergeCommit?: string }> {
    const result = await this.command(['pr', 'view', String(number), '--repo', repository, '--json', 'state,mergedAt,mergeCommit']);
    if (result.exitCode !== 0) throw new Error(bounded(`gh_merge_observation_failed:${result.stderr || result.stdout}`));
    const value = parseObject(result.stdout, 'gh_merge_observation_invalid_json');
    const merged = value.state === 'MERGED' && typeof value.mergedAt === 'string';
    const commit = value.mergeCommit !== null && typeof value.mergeCommit === 'object' ? (value.mergeCommit as Record<string, unknown>).oid : undefined;
    if (commit !== undefined && typeof commit !== 'string') throw new Error('gh_merge_observation_invalid_shape');
    return { merged, ...(typeof commit === 'string' ? { mergeCommit: commit } : {}) };
  }
}

export interface GitHubIssueTarget { repository: string; title: string; body: string; }

/** Controller-only issue linkage with remote-first reconciliation. */
export class GitHubIssueLinkExecutor implements ControllerActionExecutor {
  private readonly targetFor: (action: AuthorizedAction) => GitHubIssueTarget | undefined;
  private readonly command: GitHubCommand;
  constructor(command: GitHubCommand, targetFor: (action: AuthorizedAction) => GitHubIssueTarget | undefined) { this.command = command; this.targetFor = targetFor; }

  async execute(action: AuthorizedAction, guard: () => Promise<void>): Promise<ActionExecutionResult> {
    if (action.request.scope.kind !== 'github.issue' || action.request.scope.allowedOperation !== 'github.issue') return { outcome: 'blocked', detail: 'github_issue_scope_required' };
    const target = this.targetFor(action);
    if (target === undefined || target.repository !== action.request.scope.repository) return { outcome: 'blocked', detail: 'github_issue_target_not_configured' };
    const marker = `Faktori operation ${action.operationId}`;
    const prior = await this.find(target.repository, marker);
    if (prior !== undefined) return { outcome: 'safe_noop', detail: `reconciled_issue:${prior}` };
    await guard();
    const result = await this.command(['issue', 'create', '--repo', target.repository, '--title', target.title, '--body', `${target.body}\n\n${marker}`]);
    if (result.exitCode !== 0) return { outcome: 'failed', detail: bounded(`gh_issue_create_failed:${result.stderr || result.stdout}`) };
    const observed = await this.find(target.repository, marker);
    return observed === undefined ? { outcome: 'uncertain', detail: 'gh_issue_create_returned_without_reconcilable_issue' } : { outcome: 'completed', detail: `issue:${observed}` };
  }

  private async find(repository: string, marker: string): Promise<string | undefined> {
    const result = await this.command(['issue', 'list', '--repo', repository, '--state', 'all', '--search', marker, '--json', 'url', '--limit', '2']);
    if (result.exitCode !== 0) throw new Error(bounded(`gh_issue_reconciliation_failed:${result.stderr || result.stdout}`));
    const values: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(values) || values.length === 0) return undefined;
    if (values.length !== 1 || values[0] === null || typeof values[0] !== 'object' || typeof (values[0] as Record<string, unknown>).url !== 'string') throw new Error('gh_issue_reconciliation_ambiguous_or_invalid');
    return (values[0] as Record<string, string>).url;
  }
}

/**
 * Controller-owned gh boundary. It deliberately accepts only controller
 * configuration and the already-admitted action: no worker remote, checkout,
 * hook, environment, or arbitrary gh arguments can cross this boundary.
 */
export class GitHubDraftPullRequestExecutor implements ControllerActionExecutor {
  private readonly target: GitHubPublisherTarget;
  private readonly command: GitHubCommand;
  private readonly store: GitHubPublicationStore;

  constructor(
    target: GitHubPublisherTarget,
    command: GitHubCommand,
    store: GitHubPublicationStore,
  ) {
    this.target = target;
    this.command = command;
    this.store = store;
  }

  async execute(action: AuthorizedAction, guard: () => Promise<void>): Promise<ActionExecutionResult> {
    if (action.request.scope.kind !== 'github.draft-pr' || action.request.scope.allowedOperation !== 'github.draft-pr') {
      return { outcome: 'blocked', detail: 'github_draft_pr_scope_required' };
    }
    if (!sameTarget(action, this.target)) return { outcome: 'blocked', detail: 'publisher_target_or_revision_mismatch' };

    const prior = await this.store.find(action.operationId);
    if (prior !== undefined) return samePublication(prior, this.target)
      ? { outcome: 'safe_noop', detail: `reconciled_draft_pr:${prior.url}` }
      : { outcome: 'uncertain', detail: 'stored_publication_does_not_match_admitted_target' };

    // Reconciliation occurs before an effect. This is the crash-after-effect
    // path: the provider has the PR, while the local receipt has not survived.
    const existing = await this.findByOperation(action.operationId);
    if (existing !== undefined) {
      if (!samePublication(existing, this.target)) return { outcome: 'uncertain', detail: 'remote_publication_does_not_match_admitted_target' };
      await this.store.save(action.operationId, existing);
      return { outcome: 'safe_noop', detail: `reconciled_draft_pr:${existing.url}` };
    }

    await guard();
    const created = await this.command([
      'pr', 'create', '--repo', this.target.repository, '--head', this.target.branch,
      '--base', this.target.baseRevision, '--draft', '--title', `Faktori ${action.request.actionId}`,
      '--body', `Faktori operation ${action.operationId}`,
    ]);
    if (created.exitCode !== 0) return { outcome: 'failed', detail: bounded(`gh_pr_create_failed:${created.stderr || created.stdout}`) };

    // Do not trust create stdout as a receipt. Re-query by the operation marker
    // and verify the exact admitted head/base/revision before persisting locally.
    const observed = await this.findByOperation(action.operationId);
    if (observed === undefined) return { outcome: 'uncertain', detail: 'gh_create_returned_without_reconcilable_draft_pr' };
    if (!samePublication(observed, this.target)) return { outcome: 'uncertain', detail: 'created_draft_pr_does_not_match_admitted_target' };
    await this.store.save(action.operationId, observed);
    return { outcome: 'completed', detail: `draft_pr:${observed.url}` };
  }

  private async findByOperation(operationId: string): Promise<GitHubPublication | undefined> {
    const result = await this.command([
      'pr', 'list', '--repo', this.target.repository, '--head', this.target.branch,
      '--state', 'all', '--search', `Faktori operation ${operationId}`,
      '--json', 'number,url,headRefName,headRefOid,baseRefName,isDraft', '--limit', '2',
    ]);
    if (result.exitCode !== 0) throw new Error(bounded(`gh_pr_reconciliation_failed:${result.stderr || result.stdout}`));
    let values: unknown;
    try { values = JSON.parse(result.stdout); } catch { throw new Error('gh_pr_reconciliation_invalid_json'); }
    if (!Array.isArray(values) || values.length === 0) return undefined;
    if (values.length !== 1) throw new Error('gh_pr_reconciliation_ambiguous');
    return publication(values[0]);
  }
}

/** Read-only installed-gh evidence; never authenticates or contacts GitHub. */
export async function probeInstalledGh(command: GitHubCommand = spawnGh): Promise<string> {
  const result = await command(['--version']);
  if (result.exitCode !== 0 || !/^gh version \d+/m.test(result.stdout)) throw new Error('installed_gh_probe_failed');
  return result.stdout.split('\n')[0];
}

export async function spawnGh(argv: readonly string[], input?: string): Promise<GitHubCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', [...argv], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

export class InMemoryGitHubPublicationStore implements GitHubPublicationStore {
  #values = new Map<string, GitHubPublication>();
  async find(operationId: string): Promise<GitHubPublication | undefined> { return this.#values.get(operationId); }
  async save(operationId: string, value: GitHubPublication): Promise<void> { this.#values.set(operationId, structuredClone(value)); }
}

export function publicationMarker(operationId: string): string {
  return createHash('sha256').update(`faktori-github-operation:${operationId}`).digest('hex');
}

function sameTarget(action: AuthorizedAction, target: GitHubPublisherTarget): boolean {
  const scope = action.request.scope;
  return scope.repository === target.repository && scope.branch === target.branch
    && scope.baseRevision === target.baseRevision && scope.expectedRevision === target.expectedRevision;
}

function samePublication(value: GitHubPublication, target: GitHubPublisherTarget): boolean {
  return value.isDraft && value.headRefName === target.branch && value.headRefOid === target.expectedRevision && value.baseRefName === target.baseRevision;
}

function publication(value: unknown): GitHubPublication {
  if (value === null || typeof value !== 'object') throw new Error('gh_pr_reconciliation_invalid_shape');
  const item = value as Record<string, unknown>;
  if (!Number.isInteger(item.number) || typeof item.url !== 'string' || typeof item.headRefName !== 'string' || typeof item.headRefOid !== 'string' || typeof item.baseRefName !== 'string' || typeof item.isDraft !== 'boolean') throw new Error('gh_pr_reconciliation_invalid_shape');
  return { number: item.number as number, url: item.url, headRefName: item.headRefName, headRefOid: item.headRefOid, baseRefName: item.baseRefName, isDraft: item.isDraft };
}

function parseObject(value: string, error: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fail below */ }
  throw new Error(error);
}

function bounded(value: string): string { return value.slice(0, 512); }
