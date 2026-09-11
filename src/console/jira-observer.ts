import type { ResolvedFactoryConfiguration } from '../config/index.ts';

export interface JiraSource {
  id: string;
  baseUrl: string;
  projectKey: string;
  productId?: string;
  podId?: string;
  /** Optional Jira Agile board ID. When absent, Console uses a board only when the project resolves to one board. */
  boardId?: string;
  /** Name of a server environment variable containing the complete Authorization header value. */
  authorizationEnv: string;
  pollIntervalMs?: number;
}

export type JiraStatusCategory = 'new' | 'indeterminate' | 'done' | 'unknown';

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  statusId?: string;
  statusCategory: JiraStatusCategory;
  assignee?: string;
  updatedAt: string;
  url: string;
}

/** Ordered Jira board columns, with every Jira status ID assigned to that column. */
export interface JiraColumn {
  name: string;
  statusIds: string[];
}

export interface JiraActivity {
  id: string;
  at: string;
  summary: string;
  issueKey?: string;
}

export interface JiraBoard {
  id: string;
  projectKey: string;
  productId?: string;
  podId?: string;
  status: 'connected' | 'unavailable' | 'stale';
  lastSyncedAt?: string;
  message?: string;
  truncated: boolean;
  /** Absent when a safe board configuration has not been obtained. An empty array is a configured empty board. */
  columns?: JiraColumn[];
  /** Fixed, safe explanation when column configuration is unavailable or retained stale. */
  columnsMessage?: string;
  /** True only when a prior successful column configuration is being retained after a failed retrieval. */
  columnsStale?: boolean;
  issues: JiraIssue[];
  changes: JiraActivity[];
}

export interface JiraObserverOptions {
  fetcher?: typeof fetch;
  now?: () => Date;
  environment?: Readonly<Record<string, string | undefined>>;
}

type InputRecord = Record<string, unknown>;

const SOURCE_KEYS = new Set(['id', 'baseUrl', 'projectKey', 'productId', 'podId', 'boardId', 'authorizationEnv', 'pollIntervalMs']);
const SOURCE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SCOPE_ID = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,31}$/;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const ISSUE_KEY = /^([A-Z][A-Z0-9_]{0,31})-([1-9][0-9]*)$/;
const BOARD_ID = /^[1-9][0-9]{0,17}$/;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MINIMUM_POLL_INTERVAL_MS = 15_000;
const MAXIMUM_POLL_INTERVAL_MS = 24 * 60 * 60_000;
const PAGE_SIZE = 100;
const MAX_ISSUES = 500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 10_000;
const MAX_ACTIVITY = 100;
const MAX_SUMMARY_LENGTH = 500;
const MAX_STATUS_LENGTH = 128;
const MAX_ASSIGNEE_LENGTH = 200;
const MAX_PAGES = 10;
const MAX_COLUMNS = 100;
const MAX_STATUSES_PER_COLUMN = 200;

class JiraPollFailure extends Error {
  readonly kind: 'authorization_missing' | 'access_denied';

  constructor(kind: JiraPollFailure['kind']) {
    super(kind);
    this.kind = kind;
  }
}

function record(value: unknown): InputRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as InputRecord : undefined;
}

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, maximum);
}

function requiredText(value: unknown, field: string): string {
  const parsed = text(value, 1024);
  if (parsed === undefined || parsed !== value) throw new Error(`${field} must be a bounded non-empty string`);
  return parsed;
}

/** Validate owner-controlled Jira sources without ever accepting credential values. */
export function parseJiraSources(value: unknown, catalog?: Pick<ResolvedFactoryConfiguration, 'products' | 'pods'>): JiraSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('jiraSources must be an array of at most 100 configured boards');
  const sources = value.map((item, index): JiraSource => {
    const input = record(item);
    if (input === undefined || Object.keys(input).some((key) => !SOURCE_KEYS.has(key))) {
      throw new Error(`jiraSources[${index}] must contain only id, baseUrl, projectKey, productId, podId, boardId, authorizationEnv, and pollIntervalMs`);
    }
    const id = requiredText(input.id, `jiraSources[${index}].id`);
    if (!SOURCE_ID.test(id)) throw new Error(`jiraSources[${index}].id must be a bounded lowercase identifier`);
    const rawBaseUrl = requiredText(input.baseUrl, `jiraSources[${index}].baseUrl`);
    let baseUrl: URL;
    try { baseUrl = new URL(rawBaseUrl); } catch { throw new Error(`jiraSources[${index}].baseUrl must be an HTTPS origin`); }
    if (baseUrl.protocol !== 'https:' || baseUrl.username !== '' || baseUrl.password !== '' || baseUrl.pathname !== '/'
      || baseUrl.search !== '' || baseUrl.hash !== '' || baseUrl.origin !== rawBaseUrl) {
      throw new Error(`jiraSources[${index}].baseUrl must be an HTTPS origin with no userinfo, path, query, or hash`);
    }
    const projectKey = requiredText(input.projectKey, `jiraSources[${index}].projectKey`);
    if (!PROJECT_KEY.test(projectKey)) throw new Error(`jiraSources[${index}].projectKey must be a bounded uppercase Jira project key`);
    const authorizationEnv = requiredText(input.authorizationEnv, `jiraSources[${index}].authorizationEnv`);
    if (!ENVIRONMENT_NAME.test(authorizationEnv)) throw new Error(`jiraSources[${index}].authorizationEnv must be an environment variable name`);
    const boardId = input.boardId === undefined ? undefined : requiredText(input.boardId, `jiraSources[${index}].boardId`);
    if (boardId !== undefined && !BOARD_ID.test(boardId)) throw new Error(`jiraSources[${index}].boardId must be a positive Jira board ID`);
    const productId = input.productId === undefined ? undefined : requiredText(input.productId, `jiraSources[${index}].productId`);
    const podId = input.podId === undefined ? undefined : requiredText(input.podId, `jiraSources[${index}].podId`);
    if (productId !== undefined && !SCOPE_ID.test(productId)) throw new Error(`jiraSources[${index}].productId must be a bounded identifier`);
    if (podId !== undefined && !SCOPE_ID.test(podId)) throw new Error(`jiraSources[${index}].podId must be a bounded identifier`);
    if (podId !== undefined && productId === undefined) throw new Error(`jiraSources[${index}].podId requires productId`);
    if (catalog !== undefined && productId !== undefined && !catalog.products.some((product) => product.id === productId)) {
      throw new Error(`jiraSources[${index}].productId must reference a configured product`);
    }
    if (catalog !== undefined && podId !== undefined && !catalog.pods.some((pod) => pod.id === podId && pod.productId === productId)) {
      throw new Error(`jiraSources[${index}].podId must reference a configured pod in the selected product`);
    }
    const pollIntervalMs = input.pollIntervalMs;
    if (pollIntervalMs !== undefined && (!Number.isInteger(pollIntervalMs) || Number(pollIntervalMs) < MINIMUM_POLL_INTERVAL_MS
      || Number(pollIntervalMs) > MAXIMUM_POLL_INTERVAL_MS)) {
      throw new Error(`jiraSources[${index}].pollIntervalMs must be an integer from 15000 to ${MAXIMUM_POLL_INTERVAL_MS}`);
    }
    return {
      id,
      baseUrl: baseUrl.origin,
      projectKey,
      ...(productId === undefined ? {} : { productId }),
      ...(podId === undefined ? {} : { podId }),
      ...(boardId === undefined ? {} : { boardId }),
      authorizationEnv,
      ...(pollIntervalMs === undefined ? {} : { pollIntervalMs: Number(pollIntervalMs) }),
    };
  });
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error('jiraSources ids must be unique');
  return sources;
}

function initialBoard(source: JiraSource): JiraBoard {
  return {
    id: source.id,
    projectKey: source.projectKey,
    ...(source.productId === undefined ? {} : { productId: source.productId }),
    ...(source.podId === undefined ? {} : { podId: source.podId }),
    status: 'unavailable',
    message: 'Not synced yet.',
    truncated: false,
    issues: [],
    changes: [],
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) throw new Error('response rejected');
  if (response.body === null) throw new Error('response rejected');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('response rejected');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; } catch { throw new Error('response rejected'); }
}

/** Apply the same redirect, origin, size, timeout, and authorization boundaries to every Jira endpoint. */
async function requestJson(source: JiraSource, authorization: string, fetcher: typeof fetch, controllers: Set<AbortController>, url: URL): Promise<unknown> {
  const controller = new AbortController();
  controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetcher(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/json', Authorization: authorization },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) throw new JiraPollFailure('access_denied');
    if (!response.ok || response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('request rejected');
    if (response.url !== '' && new URL(response.url).origin !== source.baseUrl) throw new Error('response origin rejected');
    return await boundedJson(response);
  } finally {
    clearTimeout(timeout);
    controllers.delete(controller);
  }
}

function issue(source: JiraSource, value: unknown): JiraIssue {
  const input = record(value);
  const key = text(input?.key, 64);
  const match = key === undefined ? undefined : ISSUE_KEY.exec(key);
  const fields = record(input?.fields);
  const statusRecord = record(fields?.status);
  const categoryRecord = record(statusRecord?.statusCategory);
  const summary = text(fields?.summary, MAX_SUMMARY_LENGTH);
  const status = text(statusRecord?.name, MAX_STATUS_LENGTH);
  const statusId = text(statusRecord?.id, MAX_STATUS_LENGTH);
  const updated = typeof fields?.updated === 'string' && Number.isFinite(Date.parse(fields.updated)) ? new Date(fields.updated).toISOString() : undefined;
  const assigneeRecord = fields?.assignee === null || fields?.assignee === undefined ? undefined : record(fields.assignee);
  const assignee = assigneeRecord === undefined ? undefined : text(assigneeRecord.displayName, MAX_ASSIGNEE_LENGTH);
  if (match?.[1] !== source.projectKey || fields === undefined || summary === undefined || status === undefined || updated === undefined
    || (fields.assignee !== null && fields.assignee !== undefined && assignee === undefined)) throw new Error('issue rejected');
  const rawCategory = categoryRecord?.key;
  const statusCategory: JiraStatusCategory = rawCategory === 'new' || rawCategory === 'indeterminate' || rawCategory === 'done' ? rawCategory : 'unknown';
  return {
    key: key as string,
    summary,
    status,
    ...(statusId === undefined ? {} : { statusId }),
    statusCategory,
    ...(assignee === undefined ? {} : { assignee }),
    updatedAt: updated,
    url: `${source.baseUrl}/browse/${encodeURIComponent(key as string)}`,
  };
}

interface PollResult { issues: JiraIssue[]; truncated: boolean }

async function pollSource(source: JiraSource, authorization: string, fetcher: typeof fetch, controllers: Set<AbortController>): Promise<PollResult> {
  const issues: JiraIssue[] = [];
  const seenIssues = new Set<string>();
  const seenTokens = new Set<string>();
  let nextPageToken: string | undefined;
  let pages = 0;
  while (issues.length < MAX_ISSUES && pages < MAX_PAGES) {
    pages += 1;
    const url = new URL('/rest/api/3/search/jql', source.baseUrl);
    url.searchParams.set('jql', `project = "${source.projectKey}" ORDER BY updated DESC`);
    url.searchParams.set('fields', 'summary,status,assignee,updated');
    url.searchParams.set('maxResults', String(Math.min(PAGE_SIZE, MAX_ISSUES - issues.length)));
    if (nextPageToken !== undefined) url.searchParams.set('nextPageToken', nextPageToken);
    const bodyValue = await requestJson(source, authorization, fetcher, controllers, url);
    const body = record(bodyValue);
    if (!Array.isArray(body?.issues) || body.issues.length > PAGE_SIZE) throw new Error('response rejected');
    for (const raw of body.issues) {
      const projected = issue(source, raw);
      if (seenIssues.has(projected.key)) throw new Error('response rejected');
      seenIssues.add(projected.key);
      issues.push(projected);
    }
    const token = body.nextPageToken;
    if (body.isLast !== undefined && typeof body.isLast !== 'boolean') throw new Error('response rejected');
    if (body.isLast === true) return { issues, truncated: false };
    if (token === undefined || token === null) {
      if (body.isLast === false) throw new Error('response rejected');
      return { issues, truncated: false };
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 1024 || seenTokens.has(token)) throw new Error('response rejected');
    seenTokens.add(token);
    nextPageToken = token;
  }
  return { issues, truncated: true };
}

function boardId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && BOARD_ID.test(value) ? value : undefined;
}

async function discoverBoardId(source: JiraSource, authorization: string, fetcher: typeof fetch, controllers: Set<AbortController>): Promise<{ boardId?: string; message?: string }> {
  if (source.boardId !== undefined) return { boardId: source.boardId };
  const url = new URL('/rest/agile/1.0/board', source.baseUrl);
  url.searchParams.set('projectKeyOrId', source.projectKey);
  url.searchParams.set('maxResults', '100');
  const body = record(await requestJson(source, authorization, fetcher, controllers, url));
  const values = body?.values;
  if (!Array.isArray(values) || values.length > 100 || (body?.isLast !== undefined && typeof body.isLast !== 'boolean')) throw new Error('response rejected');
  // A non-final page cannot establish uniqueness, even if its first page has one result.
  const rawTotal = body?.total;
  const total = typeof rawTotal === 'number' && Number.isSafeInteger(rawTotal) && rawTotal >= 0 && rawTotal <= 10_000 ? rawTotal : undefined;
  if (body?.isLast === false || values.length > 1 || (total !== undefined && total > 1)) {
    return { message: `Jira board columns are unavailable because multiple boards may match ${source.projectKey}. Configure boardId for this source.` };
  }
  if (values.length === 0) return { message: `Jira board columns are unavailable because no board matches ${source.projectKey}. Configure boardId for this source.` };
  if (body?.isLast !== true && total !== 1) {
    return { message: `Jira board columns are unavailable because Console could not confirm one board for ${source.projectKey}. Configure boardId for this source.` };
  }
  const id = boardId(record(values[0])?.id);
  if (id === undefined) throw new Error('response rejected');
  return { boardId: id };
}

function columns(value: unknown): JiraColumn[] {
  const configuration = record(value);
  const columnConfig = record(configuration?.columnConfig);
  const rawColumns = columnConfig?.columns;
  if (!Array.isArray(rawColumns) || rawColumns.length > MAX_COLUMNS) throw new Error('response rejected');
  const seenStatuses = new Set<string>();
  return rawColumns.map((raw): JiraColumn => {
    const column = record(raw);
    const name = text(column?.name, MAX_STATUS_LENGTH);
    const statuses = column?.statuses;
    if (name === undefined || !Array.isArray(statuses) || statuses.length > MAX_STATUSES_PER_COLUMN) throw new Error('response rejected');
    const statusIds = statuses.map((status) => boardId(record(status)?.id));
    if (statusIds.some((statusId) => statusId === undefined)) throw new Error('response rejected');
    for (const statusId of statusIds as string[]) {
      if (seenStatuses.has(statusId)) throw new Error('response rejected');
      seenStatuses.add(statusId);
    }
    return { name, statusIds: statusIds as string[] };
  });
}

async function pollColumns(source: JiraSource, authorization: string, fetcher: typeof fetch, controllers: Set<AbortController>): Promise<{ columns?: JiraColumn[]; message?: string }> {
  const discovered = await discoverBoardId(source, authorization, fetcher, controllers);
  if (discovered.boardId === undefined) return { message: discovered.message };
  const url = new URL(`/rest/agile/1.0/board/${encodeURIComponent(discovered.boardId)}/configuration`, source.baseUrl);
  return { columns: columns(await requestJson(source, authorization, fetcher, controllers, url)) };
}

function copyBoard(board: JiraBoard): JiraBoard {
  return { ...board, issues: board.issues.map((item) => ({ ...item })), changes: board.changes.map((item) => ({ ...item })), ...(board.columns === undefined ? {} : { columns: board.columns.map((column) => ({ ...column, statusIds: [...column.statusIds] })) }) };
}

/** Server-only, bounded Jira polling. Browser state is always served from this sanitized cache. */
export class JiraObserver {
  readonly #sources: readonly JiraSource[];
  readonly #fetcher: typeof fetch;
  readonly #now: () => Date;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #lastAttempt = new Map<string, number>();
  readonly #controllers = new Set<AbortController>();
  #boards: JiraBoard[];
  #refreshing?: Promise<void>;
  #closed = false;

  constructor(sources: readonly JiraSource[], options: JiraObserverOptions = {}) {
    this.#sources = sources.map((source) => ({ ...source }));
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#environment = options.environment ?? process.env;
    this.#boards = this.#sources.map(initialBoard);
  }

  snapshot(): JiraBoard[] {
    return this.#boards.map(copyBoard);
  }

  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#refreshing !== undefined) return this.#refreshing;
    const operation = this.#refreshDue();
    this.#refreshing = operation.finally(() => { this.#refreshing = undefined; });
    return this.#refreshing;
  }

  async #refreshDue(): Promise<void> {
    const attemptedAt = this.#now().getTime();
    const due = this.#sources.filter((source) => {
      const previous = this.#lastAttempt.get(source.id);
      return previous === undefined || attemptedAt - previous >= (source.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    });
    for (const source of due) this.#lastAttempt.set(source.id, attemptedAt);
    await Promise.all(due.map(async (source) => {
      const index = this.#sources.findIndex((candidate) => candidate.id === source.id);
      const previous = this.#boards[index] as JiraBoard;
      try {
        const authorization = this.#environment[source.authorizationEnv];
        if (typeof authorization !== 'string' || authorization.trim().length === 0 || authorization.length > 16_384) throw new JiraPollFailure('authorization_missing');
        const result = await pollSource(source, authorization, this.#fetcher, this.#controllers);
        if (this.#closed) return;
        let columnState: Pick<JiraBoard, 'columns' | 'columnsMessage' | 'columnsStale'> = {};
        try {
          const columnResult = await pollColumns(source, authorization, this.#fetcher, this.#controllers);
          if (columnResult.columns !== undefined) columnState = { columns: columnResult.columns };
          else if (previous.columns !== undefined) {
            columnState = { columns: previous.columns.map((column) => ({ ...column, statusIds: [...column.statusIds] })), columnsStale: true, columnsMessage: `${columnResult.message ?? 'Jira board columns are temporarily unavailable.'} The last successful column configuration is retained and may be stale.` };
          } else columnState = { columnsMessage: columnResult.message ?? 'Jira board columns are temporarily unavailable; issues remain available by status. Check Jira Software board read permission or configure boardId.' };
        } catch {
          columnState = previous.columns === undefined
            ? { columnsMessage: 'Jira board columns are temporarily unavailable; issues remain available by status. Check Jira Software board read permission or configure boardId.' }
            : { columns: previous.columns.map((column) => ({ ...column, statusIds: [...column.statusIds] })), columnsStale: true, columnsMessage: 'Jira board columns could not be refreshed. Check Jira Software board read permission or configure boardId. The last successful column configuration is retained and may be stale.' };
        }
        if (this.#closed) return;
        const syncedAt = this.#now().toISOString();
        if (result.truncated && previous.lastSyncedAt !== undefined) {
          this.#boards[index] = {
            ...copyBoard(previous),
            status: 'stale',
            message: 'Jira bounded sync was incomplete; the last complete snapshot was retained.',
            truncated: true,
          };
          return;
        }
        const previousByKey = new Map(previous.issues.map((item) => [item.key, item]));
        const transitions = previous.lastSyncedAt === undefined
          ? [{ id: `${source.id}:initial:${syncedAt}`, at: syncedAt, summary: `Initial Jira sync: ${result.issues.length} issues.` }]
          : result.issues.flatMap((item): JiraActivity[] => {
            const before = previousByKey.get(item.key);
            return before !== undefined && before.status !== item.status
              ? [{ id: `${source.id}:${item.key}:${item.updatedAt}`, at: syncedAt, summary: `${item.key} moved from ${before.status} to ${item.status}.`, issueKey: item.key }]
              : [];
          });
        const priorChanges = previous.changes;
        const knownActivity = new Set(priorChanges.map((item) => item.id));
        const changes = [...priorChanges, ...transitions.filter((item) => !knownActivity.has(item.id))].slice(-MAX_ACTIVITY);
        this.#boards[index] = {
          id: source.id,
          projectKey: source.projectKey,
          ...(source.productId === undefined ? {} : { productId: source.productId }),
          ...(source.podId === undefined ? {} : { podId: source.podId }),
          status: 'connected',
          lastSyncedAt: syncedAt,
          ...(result.truncated ? { message: 'Jira result limit reached; snapshot is incomplete.' } : {}),
          truncated: result.truncated,
          ...columnState,
          issues: result.issues,
          changes,
        };
      } catch (error) {
        if (this.#closed) return;
        const message = error instanceof JiraPollFailure && error.kind === 'authorization_missing'
          ? 'Jira authorization is not configured in the Console server environment.'
          : error instanceof JiraPollFailure && error.kind === 'access_denied'
            ? 'Jira access was denied. Check the server-side authorization and project access.'
            : 'Jira sync is temporarily unavailable.';
        this.#boards[index] = {
          ...copyBoard(previous),
          status: previous.lastSyncedAt === undefined ? 'unavailable' : 'stale',
          message,
        };
      }
    }));
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }
}
