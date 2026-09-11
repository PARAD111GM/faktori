import { FetchJiraHttpClient, type JiraHttpClient } from './jira.ts';
import { GitHubRepositoryObserver, spawnGh, type GitHubCommand } from './github.ts';
import { JiraActiveSprintReadAdapter, type DiscoveredJiraTransition, type JiraSprintRead } from './delivery-sync.ts';

const MAX_CONNECTIONS = 100;
const BOARD_ID = /^[1-9][0-9]{0,17}$/;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]*$/;

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined; }
function requiredText(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must be a bounded non-empty string`);
  return value;
}
function exactKeys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields`);
}

export interface DeliveryConnection {
  ticketKey: string;
  repository: string;
  pullRequest: number;
}

export interface DeliveryConnections {
  format: 'faktori.delivery-connections/v1';
  jira: { baseUrl: string; boardId: string; authorizationEnv: string };
  connections: readonly DeliveryConnection[];
}

/** Strict owner configuration parser. Authorization values never enter this shape. */
export function parseDeliveryConnections(value: unknown): DeliveryConnections {
  const input = record(value);
  if (input === undefined || input.format !== 'faktori.delivery-connections/v1') throw new Error('delivery connections format is required');
  exactKeys(input, ['format', 'jira', 'connections'], 'delivery connections');
  const jira = record(input.jira);
  if (jira === undefined) throw new Error('delivery connections Jira configuration is required');
  exactKeys(jira, ['baseUrl', 'boardId', 'authorizationEnv'], 'delivery connections Jira configuration');
  const baseUrl = requiredText(jira.baseUrl, 'jira.baseUrl');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('jira.baseUrl must be an HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.origin !== baseUrl) throw new Error('jira.baseUrl must be an HTTPS origin');
  const boardId = requiredText(jira.boardId, 'jira.boardId', 18);
  if (!BOARD_ID.test(boardId)) throw new Error('jira.boardId must be a positive bounded integer');
  const authorizationEnv = requiredText(jira.authorizationEnv, 'jira.authorizationEnv', 128);
  if (!ENVIRONMENT_NAME.test(authorizationEnv)) throw new Error('jira.authorizationEnv must be an environment variable name');
  if (!Array.isArray(input.connections) || input.connections.length > MAX_CONNECTIONS) throw new Error(`connections must be an array of at most ${MAX_CONNECTIONS}`);
  const connections = input.connections.map((raw, index): DeliveryConnection => {
    const connection = record(raw);
    if (connection === undefined) throw new Error(`connections[${index}] must be an object`);
    exactKeys(connection, ['ticketKey', 'repository', 'pullRequest'], `connections[${index}]`);
    const ticketKey = requiredText(connection.ticketKey, `connections[${index}].ticketKey`, 64);
    const repository = requiredText(connection.repository, `connections[${index}].repository`, 256);
    const pullRequest = connection.pullRequest;
    if (!ISSUE_KEY.test(ticketKey) || !REPOSITORY.test(repository) || !Number.isSafeInteger(pullRequest) || (pullRequest as number) < 1) throw new Error(`connections[${index}] has an invalid registered identity`);
    return { ticketKey, repository, pullRequest: pullRequest as number };
  });
  const identities = new Set(connections.map((item) => `${item.ticketKey}|${item.repository}|${item.pullRequest}`));
  if (identities.size !== connections.length || new Set(connections.map((item) => item.ticketKey)).size !== connections.length) throw new Error('connections must contain one unique PR identity per ticket');
  return { format: 'faktori.delivery-connections/v1', jira: { baseUrl, boardId, authorizationEnv }, connections };
}

export interface DeliveryInspectDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  fetcher?: typeof fetch;
  gh?: GitHubCommand;
}

export interface InspectedPullRequest {
  ticketKey: string;
  repository: string;
  pullRequest: number;
  state: 'available' | 'unknown';
  headCommit?: string;
  merged?: boolean;
  closed?: boolean;
  mergeCommit?: string;
  checks?: readonly { name: string; state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'SKIPPING' }[];
  /** GitHub reviewDecision is not retained exact-head independent-review evidence. */
  independentReview: 'unknown';
  /** Deployment/acceptance has no provider in this bounded inspection entrypoint. */
  deployment: 'unknown';
}

export interface DeliveryInspection {
  format: 'faktori.delivery-inspection/v1';
  sprint: JiraSprintRead;
  transitionsByTicket: Readonly<Record<string, readonly DiscoveredJiraTransition[] | undefined>>;
  pullRequests: readonly InspectedPullRequest[];
}

/**
 * Read-only integration hook for `faktori delivery inspect <connections.json>`.
 * It observes only owner-registered Jira board/ticket/PR identities; it has no
 * worker launch, planner execution, action admission, or provider mutation.
 */
export async function inspectDeliveryConnections(value: unknown, dependencies: DeliveryInspectDependencies = {}): Promise<DeliveryInspection> {
  const configuration = parseDeliveryConnections(value);
  const environment = dependencies.environment ?? process.env;
  const authorization = environment[configuration.jira.authorizationEnv];
  const jira = authorization === undefined || authorization.trim().length === 0
    ? { sprint: { state: 'unknown' as const, reason: 'jira_authorization_unavailable' }, transitionsByTicket: Object.fromEntries(configuration.connections.map((connection) => [connection.ticketKey, undefined])) }
    : await inspectJira(configuration, authorization, dependencies.fetcher ?? fetch);
  const pullRequests = await Promise.all(configuration.connections.map((connection) => inspectPullRequest(connection, dependencies.gh ?? spawnGh)));
  return { format: 'faktori.delivery-inspection/v1', sprint: jira.sprint, transitionsByTicket: jira.transitionsByTicket, pullRequests };
}

async function inspectJira(configuration: DeliveryConnections, authorization: string, fetcher: typeof fetch): Promise<{ sprint: JiraSprintRead; transitionsByTicket: Record<string, readonly DiscoveredJiraTransition[] | undefined> }> {
  const transport = new FetchJiraHttpClient(configuration.jira.baseUrl, fetcher);
  const client: JiraHttpClient = {
    request: (input) => transport.request({ ...input, headers: { ...input.headers, Authorization: authorization } }),
  };
  const adapter = new JiraActiveSprintReadAdapter(client);
  let sprint: JiraSprintRead;
  try { sprint = await adapter.read(configuration.jira.boardId); } catch { sprint = { state: 'unknown', reason: 'active_sprint_observation_unavailable' }; }
  const transitionsByTicket: Record<string, readonly DiscoveredJiraTransition[] | undefined> = {};
  for (const connection of configuration.connections) {
    try { transitionsByTicket[connection.ticketKey] = await adapter.transitions(connection.ticketKey); } catch { transitionsByTicket[connection.ticketKey] = undefined; }
  }
  return { sprint, transitionsByTicket };
}

async function inspectPullRequest(connection: DeliveryConnection, command: GitHubCommand): Promise<InspectedPullRequest> {
  try {
    const result = await command(['pr', 'view', String(connection.pullRequest), '--repo', connection.repository, '--json', 'state,mergedAt,mergeCommit,headRefOid']);
    if (result.exitCode !== 0) return unavailablePullRequest(connection);
    const body = record(JSON.parse(result.stdout) as unknown);
    const state = body?.state;
    const headCommit = body?.headRefOid;
    const rawMerge = record(body?.mergeCommit)?.oid;
    if ((state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') || typeof headCommit !== 'string' || headCommit.length === 0 || (rawMerge !== undefined && typeof rawMerge !== 'string')) return unavailablePullRequest(connection);
    const merged = state === 'MERGED' && typeof body?.mergedAt === 'string';
    const checks = await new GitHubRepositoryObserver(command).observeChecks({ repository: connection.repository, expectedRevision: headCommit });
    return { ...connection, state: 'available', headCommit, merged, closed: state === 'CLOSED', ...(typeof rawMerge === 'string' ? { mergeCommit: rawMerge } : {}), checks: checks.map(({ name, state: checkState }) => ({ name, state: checkState })), independentReview: 'unknown', deployment: 'unknown' };
  } catch { return unavailablePullRequest(connection); }
}

function unavailablePullRequest(connection: DeliveryConnection): InspectedPullRequest {
  return { ...connection, state: 'unknown', independentReview: 'unknown', deployment: 'unknown' };
}
