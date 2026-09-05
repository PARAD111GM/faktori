import { createHash } from 'node:crypto';

import type { ActionExecutionResult, AuthorizedAction, ControllerActionExecutor } from '../actions/index.ts';

export interface JiraHttpResponse {
  status: number;
  body?: unknown;
}

/** Controller-owned HTTP boundary. Implementations may obtain credentials privately. */
export interface JiraHttpClient {
  request(input: { method: 'GET' | 'POST' | 'PUT'; path: string; headers: Readonly<Record<string, string>>; body?: unknown }): Promise<JiraHttpResponse>;
}

/** Concrete controller-side REST transport; callers supply only a fixed base URL and private auth callback. */
export class FetchJiraHttpClient implements JiraHttpClient {
  readonly #base: URL;
  readonly #fetcher: typeof fetch;
  constructor(baseUrl: string, fetcher: typeof fetch = fetch) {
    this.#base = new URL(baseUrl);
    this.#fetcher = fetcher;
    if (this.#base.protocol !== 'https:' && this.#base.protocol !== 'http:') throw new Error('Jira base URL must be http(s)');
  }
  async request(input: { method: 'GET' | 'POST' | 'PUT'; path: string; headers: Readonly<Record<string, string>>; body?: unknown }): Promise<JiraHttpResponse> {
    if (!input.path.startsWith('/rest/api/3/')) throw new Error('Jira path escaped configured API root');
    const response = await this.#fetcher(new URL(input.path, this.#base), { method: input.method, headers: input.headers, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
    const raw = await response.text();
    let body: unknown = undefined;
    if (raw.length > 0) { try { body = JSON.parse(raw); } catch { throw new Error('Jira returned invalid JSON'); } }
    return { status: response.status, body };
  }
}

export interface JiraTransition {
  id: string;
  /** The status name that proves a previously dispatched transition completed. */
  targetStatus: string;
}

export type JiraOperation =
  | { kind: 'project.ensure'; projectKey: string; payload: Readonly<Record<string, unknown>> }
  | { kind: 'issue.ensure'; projectKey: string; issueTypeId: string; summary: string; description?: string; labels?: readonly string[] }
  | { kind: 'issue.link'; inwardIssueKey: string; outwardIssueKey: string; linkType: string }
  | { kind: 'issue.assign'; issueKey: string; accountId: string }
  | { kind: 'issue.transition'; issueKey: string; transition: string };

export interface JiraRestExecutorOptions {
  client: JiraHttpClient;
  /** Maps a signed controller action to a sealed Jira operation; workers never supply REST input. */
  operationFor(action: AuthorizedAction): JiraOperation | undefined;
  transitions: Readonly<Record<string, JiraTransition>>;
  /** Called only inside the controller process. Its value is never retained by this adapter. */
  authorizationHeader?: () => Promise<string>;
}

class JiraConfigurationError extends Error {}

function text(value: string, label: string): string {
  if (value.trim().length === 0 || value.includes('\0')) throw new Error(`${label} must be a non-empty safe string`);
  return value;
}

function encoded(value: string): string { return encodeURIComponent(text(value, 'Jira identifier')); }
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function stringAt(value: unknown, key: string): string | undefined {
  const candidate = object(value)?.[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Strict, controller-owned Jira REST executor. It deliberately supports links
 * rather than a hierarchy endpoint: hierarchy semantics remain explicit in the
 * configured Jira link type and cannot be inferred by a worker.
 */
export class JiraRestActionExecutor implements ControllerActionExecutor {
  readonly #client: JiraHttpClient;
  readonly #operationFor: JiraRestExecutorOptions['operationFor'];
  readonly #transitions: JiraRestExecutorOptions['transitions'];
  readonly #authorizationHeader?: JiraRestExecutorOptions['authorizationHeader'];

  constructor(options: JiraRestExecutorOptions) {
    this.#client = options.client;
    this.#operationFor = options.operationFor;
    this.#transitions = options.transitions;
    this.#authorizationHeader = options.authorizationHeader;
  }

  async execute(action: AuthorizedAction, guard: () => Promise<void>): Promise<ActionExecutionResult> {
    const operation = this.#operationFor(action);
    if (operation === undefined || action.request.scope.allowedOperation !== `jira.${operation.kind}`) {
      return { outcome: 'blocked', detail: 'signed action does not name a configured Jira operation' };
    }
    try {
      return await this.executeConfigured(action, operation, guard);
    } catch (error) {
      if (error instanceof JiraConfigurationError) return { outcome: 'failed', detail: error.message };
      // A transport interruption cannot prove whether Jira accepted a write.
      return { outcome: 'uncertain', detail: error instanceof Error ? error.message : 'Jira transport failed' };
    }
  }

  private async executeConfigured(action: AuthorizedAction, operation: JiraOperation, guard: () => Promise<void>): Promise<ActionExecutionResult> {
    if (await this.reconciled(action, operation)) return { outcome: 'safe_noop', detail: 'Jira already reflects this idempotent action' };
    await guard(); // Immediately precedes the only possible externally visible write.
    const response = await this.write(action, operation);
    if (response.status >= 200 && response.status < 300) return { outcome: 'completed', detail: `Jira ${operation.kind} completed` };
    if (operation.kind === 'issue.transition') return { outcome: 'failed', detail: `Jira transition ${operation.transition} failed with HTTP ${response.status}` };
    return { outcome: 'failed', detail: `Jira ${operation.kind} failed with HTTP ${response.status}` };
  }

  private async reconciled(action: AuthorizedAction, operation: JiraOperation): Promise<boolean> {
    switch (operation.kind) {
      case 'project.ensure': {
        const result = await this.read(`/rest/api/3/project/${encoded(operation.projectKey)}`);
        if (result.status === 200) return true;
        if (result.status === 404) return false;
        throw new Error(`Jira project reconciliation unavailable: HTTP ${result.status}`);
      }
      case 'issue.ensure': {
        const marker = this.issueMarker(action.request.idempotencyKey);
        const result = await this.read(`/rest/api/3/search/jql?jql=${encoded(`project = "${text(operation.projectKey, 'projectKey')}" AND labels = "${marker}"`)}&maxResults=2`);
        const issues = object(result.body)?.issues;
        if (result.status !== 200 || !Array.isArray(issues)) throw new Error(`Jira issue reconciliation unavailable: HTTP ${result.status}`);
        if (issues.length > 1) throw new JiraConfigurationError('ambiguous Jira issue reconciliation');
        return issues.length === 1;
      }
      case 'issue.link': {
        const result = await this.read(`/rest/api/3/issue/${encoded(operation.inwardIssueKey)}?fields=issuelinks`);
        const links = object(object(result.body)?.fields)?.issuelinks;
        if (result.status !== 200 || !Array.isArray(links)) throw new Error(`Jira link reconciliation unavailable: HTTP ${result.status}`);
        return links.some((link) => {
          const item = object(link);
          return stringAt(item?.type, 'name') === operation.linkType && stringAt(item?.outwardIssue, 'key') === operation.outwardIssueKey;
        });
      }
      case 'issue.assign': {
        const result = await this.read(`/rest/api/3/issue/${encoded(operation.issueKey)}?fields=assignee`);
        if (result.status !== 200) throw new Error(`Jira assignment reconciliation unavailable: HTTP ${result.status}`);
        return stringAt(object(result.body)?.fields && object(object(result.body)?.fields)?.assignee, 'accountId') === operation.accountId;
      }
      case 'issue.transition': {
        const configured = this.#transitions[operation.transition];
        if (configured === undefined) throw new JiraConfigurationError(`unconfigured Jira transition: ${operation.transition}`);
        const result = await this.read(`/rest/api/3/issue/${encoded(operation.issueKey)}?fields=status`);
        if (result.status !== 200) throw new Error(`Jira transition reconciliation unavailable: HTTP ${result.status}`);
        return stringAt(object(result.body)?.fields && object(object(result.body)?.fields)?.status, 'name') === configured.targetStatus;
      }
    }
  }

  private async write(action: AuthorizedAction, operation: JiraOperation): Promise<JiraHttpResponse> {
    const headers = await this.headers(action);
    switch (operation.kind) {
      case 'project.ensure': return this.#client.request({ method: 'POST', path: '/rest/api/3/project', headers, body: { ...operation.payload, key: text(operation.projectKey, 'projectKey') } });
      case 'issue.ensure': return this.#client.request({ method: 'POST', path: '/rest/api/3/issue', headers, body: { fields: { project: { key: text(operation.projectKey, 'projectKey') }, issuetype: { id: text(operation.issueTypeId, 'issueTypeId') }, summary: text(operation.summary, 'summary'), ...(operation.description === undefined ? {} : { description: adf(operation.description) }), labels: [...(operation.labels ?? []), this.issueMarker(action.request.idempotencyKey)] } } });
      case 'issue.link': return this.#client.request({ method: 'POST', path: '/rest/api/3/issueLink', headers, body: { type: { name: text(operation.linkType, 'linkType') }, inwardIssue: { key: text(operation.inwardIssueKey, 'inwardIssueKey') }, outwardIssue: { key: text(operation.outwardIssueKey, 'outwardIssueKey') } } });
      case 'issue.assign': return this.#client.request({ method: 'PUT', path: `/rest/api/3/issue/${encoded(operation.issueKey)}/assignee`, headers, body: { accountId: text(operation.accountId, 'accountId') } });
      case 'issue.transition': {
        const configured = this.#transitions[operation.transition];
        if (configured === undefined) throw new JiraConfigurationError(`unconfigured Jira transition: ${operation.transition}`);
        return this.#client.request({ method: 'POST', path: `/rest/api/3/issue/${encoded(operation.issueKey)}/transitions`, headers, body: { transition: { id: text(configured.id, 'transition id') } } });
      }
    }
  }

  private async read(path: string): Promise<JiraHttpResponse> { return this.#client.request({ method: 'GET', path, headers: await this.headers() }); }
  private issueMarker(idempotencyKey: string): string { return `faktori-${createHash('sha256').update(text(idempotencyKey, 'idempotencyKey')).digest('hex').slice(0, 24)}`; }
  private async headers(action?: AuthorizedAction): Promise<Record<string, string>> {
    const authorization = await this.#authorizationHeader?.();
    return { Accept: 'application/json', 'Content-Type': 'application/json', ...(authorization === undefined ? {} : { Authorization: authorization }), ...(action === undefined ? {} : { 'X-Faktori-Idempotency-Key': action.request.idempotencyKey }) };
  }
}

function adf(description: string): Record<string, unknown> { return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: text(description, 'description') }] }] }; }
