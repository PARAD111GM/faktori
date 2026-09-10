import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { ManagerConnectedDecisionSnapshot, ManagerConnectedRequestSnapshot, ManagerConnectedSessionAssignment } from '../manager-connected/index.ts';

/**
 * Browser-safe contract for the optional, owner-maintained work catalog.
 * Paths that locate catalog/artifact bytes deliberately never appear here.
 */
export type WorkManagementAvailability = 'available' | 'stale' | 'unavailable';

export interface WorkManagementArtifact {
  id: string;
  title: string;
  role: string;
  /** Relative to the server-only project artifact home. */
  path: string;
}

export interface WorkManagementTicket {
  id: string;
  order: number;
  title: string;
  goal: string;
  dependencies: string[];
  issueKey?: string;
  runIds?: string[];
  loopIds?: string[];
  /** Owner-published work state. Reports, PRs, and sessions never change it. */
  status?: WorkManagementTicketStatus;
  /** Separate, explicit delivery evidence; none of these imply another. */
  evidence?: WorkManagementTicketEvidence;
  /** Retained owner-published state transitions used for daily rollups. */
  statusEvents?: WorkManagementTicketStatusEvent[];
}

export type WorkManagementTicketStatus = 'done' | 'in_progress' | 'remaining' | 'blocked';
/** Owner-published catalog evidence is a declaration, never proof from a provider. */
export type WorkManagementEvidenceState = 'owner_published' | 'unknown';
export interface WorkManagementTicketEvidence {
  local: WorkManagementEvidenceState;
  reviewed: WorkManagementEvidenceState;
  merged: WorkManagementEvidenceState;
  deployed: WorkManagementEvidenceState;
  productAccepted: WorkManagementEvidenceState;
}
export interface WorkManagementTicketStatusEvent { at: string; status: WorkManagementTicketStatus; }
export interface WorkManagementTicketCounts { total: number; done: number; inProgress: number; remaining: number; blocked: number; unknown: number; }
export interface WorkManagementDailySummary {
  date: string;
  timezone: string;
  observedAt: string;
  populationBasis: 'retained_same_day_events';
  done: number;
  inProgress: number;
  remaining: number;
  blocked: number;
  activity: {
    managerReports: number;
    decisionTransitions: number;
    blockers: number;
    ticketTransitions: number;
    ticketDoneTransitions: number;
    loopPhaseEvents: number;
    pullRequestChanges: number;
    /** No durable PR-change journal exists in this lean projection yet. */
    pullRequestChangeCoverage: 'available' | 'unavailable';
  };
}
export interface WorkManagementDailyEvent { at: string; productId?: string; kind: 'manager_report' | 'decision_transition' | 'blocker' | 'loop_phase' | 'pull_request_change'; }
export interface WorkManagementPullRequestMetrics {
  status: WorkManagementAvailability;
  observedAt?: string;
  populationBasis: 'explicit_catalog_linked_pull_requests';
  denominator: number;
  merged: number;
  unknown: number;
  independentReviewStatus: WorkManagementAvailability;
  independentReviewPassed: number;
  independentReviewUnknown: number;
}
export interface WorkManagementProgress {
  status: WorkManagementAvailability;
  observedAt?: string;
  populationBasis: 'catalog_tickets_explicit_status';
  tickets: WorkManagementTicketCounts;
  evidence: WorkManagementTicketEvidence;
  pullRequests: WorkManagementPullRequestMetrics;
}
export interface WorkManagementPullRequestLink { ticketId: string; repository: string; number: number; }
export interface WorkManagementPullRequestProjection extends WorkManagementPullRequestLink {
  status: WorkManagementAvailability;
  observedAt?: string;
  merged: 'yes' | 'no' | 'unknown';
  review: 'passed' | 'unknown';
  url?: string;
  error?: string;
}

export interface WorkManagementPhase {
  id: string;
  order: number;
  title: string;
  goal: string;
  acceptance: string;
  tickets: WorkManagementTicket[];
}

export interface WorkManagementPlan {
  id: string;
  order: number;
  title: string;
  goal: string;
  phases: WorkManagementPhase[];
}

export interface WorkManagementProject {
  productId: string;
  title: string;
  goal: string;
  artifacts: WorkManagementArtifact[];
  plans: WorkManagementPlan[];
  linkedPullRequests?: WorkManagementPullRequestLink[];
}

export interface WorkManagementArtifactProjection extends WorkManagementArtifact {
  status: WorkManagementAvailability;
  content?: string;
  contentBasis?: 'owner_snapshot' | 'observed_file';
  digest?: string;
  observedAt?: string;
  snapshotAt?: string;
  sourceRevision?: string;
  error?: string;
}

export interface WorkManagementProjectProjection extends Omit<WorkManagementProject, 'artifacts'> {
  artifacts: WorkManagementArtifactProjection[];
  progress: WorkManagementProgress;
  /** Oldest-to-newest retained daily state; empty means no retained events. */
  dailySummaries: WorkManagementDailySummary[];
  pullRequests: WorkManagementPullRequestProjection[];
}

/** A public request remains a delivery report, never ticket acceptance. */
export type WorkManagementRequest = ManagerConnectedRequestSnapshot;
export type WorkManagementSession = ManagerConnectedSessionAssignment & { liveness: 'unknown' };

export interface WorkManagementState {
  status: WorkManagementAvailability;
  revision?: string;
  observedAt?: string;
  error?: string;
  projects: WorkManagementProjectProjection[];
  sessions: WorkManagementSession[];
  requests: WorkManagementRequest[];
  decisions: ManagerConnectedDecisionSnapshot[];
}

/** Server-only configuration: the browser receives no absolute path. */
export interface WorkCatalogConfiguration {
  path: string;
  /** Explicit owner opt-in; catalog links remain inert without it. */
  observeLinkedPullRequests?: true;
  /** IANA owner timezone for daily summaries; defaults explicitly to host timezone. */
  timezone?: string;
}

/** Server-only artifact fields are never reused in the browser-safe artifact type. */
export interface WorkCatalogArtifact extends WorkManagementArtifact {
  /** Bounded owner-published text in the catalog, never read from a path. */
  content?: string;
  sourceRevision?: string;
  snapshotAt?: string;
}

export interface WorkCatalogProject extends Omit<WorkManagementProject, 'artifacts'> {
  /** Server-only absolute directory containing allowlisted relative artifacts. */
  artifactHome?: string;
  artifacts: WorkCatalogArtifact[];
}

export interface WorkCatalog {
  format: 'faktori.work-catalog/v1';
  projects: WorkCatalogProject[];
}

export interface ScopedWorkAssignment {
  productId: string;
  planId: string;
  phaseId: string;
  ticketId?: string;
}

const ID = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
// Tickets may retain the owner tracker’s stable key (for example CWM-006).
// Product/plan/phase IDs remain lowercase Faktori identifiers.
const TICKET_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,78}[A-Za-z0-9])?$/;
const MAX_TEXT = 16_000;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const PRIVATE_ARTIFACT_LINE = /(?:bearer\s+|authorization|api[_ -]?key|credential|secret|session[_ -]?id|\.codex|\.claude|\bsk-(?:(?:proj|live|test)-)?[A-Za-z0-9_-]{8,}|\b(?:gh[opusr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|[\s=:"'(])(?:\/(?!\/)\S*|[A-Za-z]:\\\S*|\\\\[^\s\\]+\\\S*))/i;

function plain(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} must be a plain object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}.${key} is not supported`);
}

function text(value: unknown, path: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) throw new Error(`${path} must be a bounded non-empty string`);
  return value;
}

function optionalTimestamp(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${path} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function id(value: unknown, path: string): string {
  const parsed = text(value, path, 80);
  if (!ID.test(parsed)) throw new Error(`${path} must be a lowercase stable identifier`);
  return parsed;
}

function ticketId(value: unknown, path: string): string {
  const parsed = text(value, path, 80);
  if (!TICKET_ID.test(parsed)) throw new Error(`${path} must be a safe stable ticket identifier`);
  return parsed;
}

function order(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 10_000) throw new Error(`${path} must be a positive bounded display order`);
  return Number(value);
}

function stringList(value: unknown, path: string, item: (input: unknown, itemPath: string) => string = id): string[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error(`${path} must be a bounded array`);
  const parsed = value.map((entry, index) => item(entry, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${path} must not repeat values`);
  return parsed;
}

function safeRelativePath(value: unknown, path: string): string {
  const parsed = text(value, path, 1_024);
  if (isAbsolute(parsed) || parsed.includes('\\') || parsed.split('/').some((segment) => segment === '..' || segment === '.' || segment.length === 0 || segment.length > 255) || parsed.split('/').length > 20) throw new Error(`${path} must be a safe relative path`);
  return parsed;
}

export function sanitizeArtifactContentForProjection(content: string): string {
  return content.split(/(?<=\n)/).map((line) => PRIVATE_ARTIFACT_LINE.test(line) ? (line.endsWith('\n') ? '[redacted]\n' : '[redacted]') : line).join('');
}

function artifact(value: unknown, path: string): WorkCatalogArtifact {
  const input = plain(value, path);
  keys(input, ['id', 'title', 'role', 'path', 'content', 'sourceRevision', 'snapshotAt'], path);
  const content = input.content === undefined ? undefined : text(input.content, `${path}.content`, MAX_ARTIFACT_BYTES);
  const sourceRevision = input.sourceRevision === undefined ? undefined : text(input.sourceRevision, `${path}.sourceRevision`, 256);
  if (sourceRevision !== undefined && !/^[A-Za-z0-9._:-]+$/.test(sourceRevision)) throw new Error(`${path}.sourceRevision must be a safe revision label`);
  return {
    id: id(input.id, `${path}.id`), title: text(input.title, `${path}.title`, 256), role: text(input.role, `${path}.role`, 128), path: safeRelativePath(input.path, `${path}.path`),
    ...(content === undefined ? {} : { content }), ...(sourceRevision === undefined ? {} : { sourceRevision }), ...(optionalTimestamp(input.snapshotAt, `${path}.snapshotAt`) === undefined ? {} : { snapshotAt: optionalTimestamp(input.snapshotAt, `${path}.snapshotAt`) }),
  };
}

function ticket(value: unknown, path: string): WorkManagementTicket {
  const input = plain(value, path);
  keys(input, ['id', 'order', 'title', 'goal', 'dependencies', 'issueKey', 'runIds', 'loopIds', 'status', 'evidence', 'statusEvents'], path);
  const status = input.status === undefined ? undefined : ticketStatus(input.status, `${path}.status`);
  const evidence = input.evidence === undefined ? undefined : ticketEvidence(input.evidence, `${path}.evidence`);
  const statusEvents = input.statusEvents === undefined ? undefined : ticketStatusEvents(input.statusEvents, `${path}.statusEvents`);
  return {
    id: ticketId(input.id, `${path}.id`), order: order(input.order, `${path}.order`), title: text(input.title, `${path}.title`, 256), goal: text(input.goal, `${path}.goal`),
    dependencies: stringList(input.dependencies, `${path}.dependencies`, ticketId),
    ...(input.issueKey === undefined ? {} : { issueKey: text(input.issueKey, `${path}.issueKey`, 128) }),
    ...(input.runIds === undefined ? {} : { runIds: stringList(input.runIds, `${path}.runIds`) }),
    ...(input.loopIds === undefined ? {} : { loopIds: stringList(input.loopIds, `${path}.loopIds`) }),
    ...(status === undefined ? {} : { status }), ...(evidence === undefined ? {} : { evidence }), ...(statusEvents === undefined ? {} : { statusEvents }),
  };
}

function ticketStatus(value: unknown, path: string): WorkManagementTicketStatus {
  if (value !== 'done' && value !== 'in_progress' && value !== 'remaining' && value !== 'blocked') throw new Error(`${path} must be an explicit ticket state`);
  return value;
}

function ticketEvidence(value: unknown, path: string): WorkManagementTicketEvidence {
  const input = plain(value, path);
  const names = ['local', 'reviewed', 'merged', 'deployed', 'productAccepted'] as const;
  keys(input, [...names], path);
  if (names.some((name) => input[name] !== 'owner_published' && input[name] !== 'unknown')) throw new Error(`${path} must name each distinct evidence state as owner_published or unknown`);
  return Object.fromEntries(names.map((name) => [name, input[name]])) as unknown as WorkManagementTicketEvidence;
}

function ticketStatusEvents(value: unknown, path: string): WorkManagementTicketStatusEvent[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(`${path} must be a bounded array`);
  const parsed = value.map((item, index) => {
    const input = plain(item, `${path}[${index}]`); keys(input, ['at', 'status'], `${path}[${index}]`);
    return { at: optionalTimestamp(input.at, `${path}[${index}].at`)!, status: ticketStatus(input.status, `${path}[${index}].status`) };
  });
  for (let index = 1; index < parsed.length; index += 1) if (parsed[index - 1]!.at >= parsed[index]!.at) throw new Error(`${path} must be strictly ordered by timestamp`);
  return parsed;
}

function phase(value: unknown, path: string): WorkManagementPhase {
  const input = plain(value, path);
  keys(input, ['id', 'order', 'title', 'goal', 'acceptance', 'tickets'], path);
  if (!Array.isArray(input.tickets) || input.tickets.length > 1_000) throw new Error(`${path}.tickets must be a bounded array`);
  const tickets = input.tickets.map((entry, index) => ticket(entry, `${path}.tickets[${index}]`));
  return { id: id(input.id, `${path}.id`), order: order(input.order, `${path}.order`), title: text(input.title, `${path}.title`, 256), goal: text(input.goal, `${path}.goal`), acceptance: text(input.acceptance, `${path}.acceptance`), tickets };
}

function plan(value: unknown, path: string): WorkManagementPlan {
  const input = plain(value, path);
  keys(input, ['id', 'order', 'title', 'goal', 'phases'], path);
  if (!Array.isArray(input.phases) || input.phases.length > 1_000) throw new Error(`${path}.phases must be a bounded array`);
  return { id: id(input.id, `${path}.id`), order: order(input.order, `${path}.order`), title: text(input.title, `${path}.title`, 256), goal: text(input.goal, `${path}.goal`), phases: input.phases.map((entry, index) => phase(entry, `${path}.phases[${index}]`)) };
}

function catalogProject(value: unknown, path: string): WorkCatalogProject {
  const input = plain(value, path);
  keys(input, ['productId', 'title', 'goal', 'artifactHome', 'artifacts', 'plans', 'linkedPullRequests'], path);
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 100) throw new Error(`${path}.artifacts must be a bounded array`);
  if (!Array.isArray(input.plans) || input.plans.length > 100) throw new Error(`${path}.plans must be a bounded array`);
  const artifacts = input.artifacts.map((entry, index) => artifact(entry, `${path}.artifacts[${index}]`));
  const artifactHome = input.artifactHome === undefined ? undefined : text(input.artifactHome, `${path}.artifactHome`, 4_096);
  const linkedPullRequests = input.linkedPullRequests === undefined ? undefined : pullRequestLinks(input.linkedPullRequests, `${path}.linkedPullRequests`);
  if (artifactHome !== undefined && !isAbsolute(artifactHome)) throw new Error(`${path}.artifactHome must be an absolute local path`);
  if (artifacts.some((item) => item.content === undefined) && artifactHome === undefined) throw new Error(`${path}.artifactHome is required for file-observed artifacts`);
  return { productId: id(input.productId, `${path}.productId`), title: text(input.title, `${path}.title`, 256), goal: text(input.goal, `${path}.goal`), ...(artifactHome === undefined ? {} : { artifactHome: resolve(artifactHome) }), artifacts, plans: input.plans.map((entry, index) => plan(entry, `${path}.plans[${index}]`)), ...(linkedPullRequests === undefined ? {} : { linkedPullRequests }) };
}

function pullRequestLinks(value: unknown, path: string): WorkManagementPullRequestLink[] {
  if (!Array.isArray(value) || value.length > 1_000) throw new Error(`${path} must be a bounded array`);
  return value.map((item, index) => {
    const input = plain(item, `${path}[${index}]`); keys(input, ['ticketId', 'repository', 'number'], `${path}[${index}]`);
    const repository = text(input.repository, `${path}[${index}].repository`, 256);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`${path}[${index}].repository must be an explicit owner/repository allowlist entry`);
    if (!Number.isInteger(input.number) || Number(input.number) < 1 || Number(input.number) > 10_000_000) throw new Error(`${path}[${index}].number must be a bounded pull request number`);
    return { ticketId: ticketId(input.ticketId, `${path}[${index}].ticketId`), repository, number: Number(input.number) };
  });
}

function uniqueOrders(nodes: Array<{ id: string; order: number }>, path: string): void {
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error(`${path} IDs must be unique`);
  if (new Set(nodes.map((node) => node.order)).size !== nodes.length) throw new Error(`${path} display orders must be unique`);
}

function validateGraph(catalog: WorkCatalog): void {
  if (new Set(catalog.projects.map((project) => project.productId)).size !== catalog.projects.length) throw new Error('workCatalog.projects productIds must be unique');
  const ticketProjects = new Map<string, string>();
  const ticketDependencies = new Map<string, string[]>();
  for (const project of catalog.projects) {
    if (new Set(project.artifacts.map((item) => item.id)).size !== project.artifacts.length || new Set(project.artifacts.map((item) => item.path)).size !== project.artifacts.length) throw new Error(`workCatalog project ${project.productId} artifacts must have unique IDs and paths`);
    uniqueOrders(project.plans, `workCatalog project ${project.productId} plans`);
    for (const currentPlan of project.plans) {
      uniqueOrders(currentPlan.phases, `workCatalog plan ${currentPlan.id} phases`);
      for (const currentPhase of currentPlan.phases) {
        uniqueOrders(currentPhase.tickets, `workCatalog phase ${currentPhase.id} tickets`);
        for (const currentTicket of currentPhase.tickets) {
          if (ticketProjects.has(currentTicket.id)) throw new Error(`workCatalog ticket ${currentTicket.id} must be unique across projects`);
          ticketProjects.set(currentTicket.id, project.productId);
          ticketDependencies.set(currentTicket.id, currentTicket.dependencies);
        }
      }
    }
    const links = project.linkedPullRequests ?? [];
    if (new Set(links.map((link) => `${link.repository}#${link.number}`)).size !== links.length) throw new Error(`workCatalog project ${project.productId} linked pull requests must be unique`);
  }
  for (const [ticketId, dependencies] of ticketDependencies) for (const dependency of dependencies) {
    if (ticketProjects.get(dependency) === undefined) throw new Error(`workCatalog ticket ${ticketId} has an orphan dependency ${dependency}`);
    if (ticketProjects.get(dependency) !== ticketProjects.get(ticketId)) throw new Error(`workCatalog ticket ${ticketId} cannot depend across projects`);
  }
  for (const project of catalog.projects) for (const link of project.linkedPullRequests ?? []) {
    if (ticketProjects.get(link.ticketId) !== project.productId) throw new Error(`workCatalog linked pull request ${link.repository}#${link.number} must name a ticket in its project`);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (ticketId: string): void => {
    if (visiting.has(ticketId)) throw new Error(`workCatalog ticket dependencies contain a cycle at ${ticketId}`);
    if (visited.has(ticketId)) return;
    visiting.add(ticketId); for (const dependency of ticketDependencies.get(ticketId) ?? []) visit(dependency); visiting.delete(ticketId); visited.add(ticketId);
  };
  for (const ticketId of ticketDependencies.keys()) visit(ticketId);
}

export function parseWorkCatalog(value: unknown): WorkCatalog {
  const input = plain(value, 'workCatalog');
  keys(input, ['format', 'projects'], 'workCatalog');
  if (input.format !== 'faktori.work-catalog/v1') throw new Error('workCatalog.format must be faktori.work-catalog/v1');
  if (!Array.isArray(input.projects) || input.projects.length > 100) throw new Error('workCatalog.projects must be a bounded array');
  const catalog: WorkCatalog = { format: 'faktori.work-catalog/v1', projects: input.projects.map((project, index) => catalogProject(project, `workCatalog.projects[${index}]`)) };
  validateGraph(catalog);
  return catalog;
}

export function validateWorkScope(catalog: WorkCatalog, value: unknown): ScopedWorkAssignment {
  const input = plain(value, 'work scope'); keys(input, ['productId', 'planId', 'phaseId', 'ticketId'], 'work scope');
  const scope: ScopedWorkAssignment = { productId: id(input.productId, 'work scope.productId'), planId: id(input.planId, 'work scope.planId'), phaseId: id(input.phaseId, 'work scope.phaseId'), ...(input.ticketId === undefined ? {} : { ticketId: ticketId(input.ticketId, 'work scope.ticketId') }) };
  const project = catalog.projects.find((candidate) => candidate.productId === scope.productId);
  const currentPlan = project?.plans.find((candidate) => candidate.id === scope.planId);
  const currentPhase = currentPlan?.phases.find((candidate) => candidate.id === scope.phaseId);
  if (!project || !currentPlan || !currentPhase || (scope.ticketId !== undefined && !currentPhase.tickets.some((candidate) => candidate.id === scope.ticketId))) throw new Error('work scope must name one catalog project, plan, phase, and optional ticket in that hierarchy');
  return scope;
}

function publicArtifact(artifact: WorkCatalogArtifact): WorkManagementArtifact {
  return { id: artifact.id, title: artifact.title, role: artifact.role, path: artifact.path };
}

function emptyEvidence(): WorkManagementTicketEvidence {
  return { local: 'unknown', reviewed: 'unknown', merged: 'unknown', deployed: 'unknown', productAccepted: 'unknown' };
}

function allTickets(project: Pick<WorkCatalogProject, 'plans'>): WorkManagementTicket[] {
  return project.plans.flatMap((plan) => plan.phases.flatMap((phase) => phase.tickets));
}

function ticketCounts(tickets: readonly WorkManagementTicket[]): WorkManagementTicketCounts {
  const counts: WorkManagementTicketCounts = { total: tickets.length, done: 0, inProgress: 0, remaining: 0, blocked: 0, unknown: 0 };
  for (const ticket of tickets) {
    if (ticket.status === 'done') counts.done += 1;
    else if (ticket.status === 'in_progress') counts.inProgress += 1;
    else if (ticket.status === 'remaining') counts.remaining += 1;
    else if (ticket.status === 'blocked') counts.blocked += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function evidenceCounts(tickets: readonly WorkManagementTicket[]): WorkManagementTicketEvidence {
  const result = emptyEvidence();
  for (const name of Object.keys(result) as Array<keyof WorkManagementTicketEvidence>) {
    result[name] = tickets.some((ticket) => ticket.evidence?.[name] === 'owner_published') ? 'owner_published' : 'unknown';
  }
  return result;
}

function dateInTimezone(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function validDate(value: Date): boolean { return Number.isFinite(value.getTime()); }

/** A polling comparison ignores display-time ticks but retains calendar rollover. */
function projectionChangeKey(state: WorkManagementState): string {
  return JSON.stringify(state, (name, value) => name === 'observedAt' ? undefined : value);
}

function pullRequestMetrics(items: readonly WorkManagementPullRequestProjection[], status: WorkManagementAvailability, observedAt: string | undefined): WorkManagementPullRequestMetrics {
  const observationStatus: WorkManagementAvailability = items.length === 0 || items.every((item) => item.status === 'unavailable') ? 'unavailable' : status === 'stale' || items.some((item) => item.status === 'stale') ? 'stale' : items.every((item) => item.status === 'available') ? 'available' : 'unavailable';
  // PR reviewDecision is intentionally not treated as an independent Faktori
  // gate. Until a retained exact-head gate source is integrated, its measure is
  // explicitly unavailable even when GitHub itself is readable.
  return { status: observationStatus, ...(observedAt === undefined ? {} : { observedAt }), populationBasis: 'explicit_catalog_linked_pull_requests', denominator: items.length, merged: items.filter((item) => item.merged === 'yes').length, unknown: items.filter((item) => item.merged === 'unknown').length, independentReviewStatus: 'unavailable', independentReviewPassed: items.filter((item) => item.review === 'passed').length, independentReviewUnknown: items.filter((item) => item.review === 'unknown').length };
}

function publicProjects(catalog: WorkCatalog, artifacts: Map<string, WorkManagementArtifactProjection>, catalogObservedAt: string | undefined, now: Date, status: WorkManagementAvailability, pullRequests: readonly WorkManagementPullRequestProjection[] = [], events: readonly WorkManagementDailyEvent[] = [], timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): WorkManagementProjectProjection[] {
  return catalog.projects.map(({ artifactHome: _artifactHome, artifacts: sourceArtifacts, ...project }) => {
    const tickets = allTickets(project);
    const links = project.linkedPullRequests ?? [];
    const observed = new Map(pullRequests.map((item) => [`${item.repository}#${item.number}`, item]));
    const projectPullRequests = links.map((link) => {
      const value = structuredClone(observed.get(`${link.repository}#${link.number}`) ?? { ...link, status: 'unavailable' as const, merged: 'unknown' as const, review: 'unknown' as const, error: 'linked_pull_request_observer_not_configured' });
      return status === 'stale' && value.status === 'available' ? { ...value, status: 'stale' as const, error: 'catalog_stale' } : value;
    });
    const current = validDate(now) ? now : new Date();
    const currentDate = dateInTimezone(current, timezone);
    const isCurrentDay = (at: string): boolean => { const value = new Date(at); return validDate(value) && dateInTimezone(value, timezone) === currentDate; };
    const sameDay = events.filter((event) => event.productId === project.productId && isCurrentDay(event.at));
    const statusEvents = tickets.flatMap((ticket) => ticket.statusEvents ?? []).filter((event) => isCurrentDay(event.at));
    // Linked PR reads retain only a current bounded observation, not a durable
    // change history. Never make a zero look like complete history coverage.
    const prChangeCoverage = 'unavailable' as const;
    const activity = {
      managerReports: sameDay.filter((event) => event.kind === 'manager_report').length,
      decisionTransitions: sameDay.filter((event) => event.kind === 'decision_transition').length,
      blockers: sameDay.filter((event) => event.kind === 'blocker').length,
      ticketTransitions: statusEvents.length,
      ticketDoneTransitions: statusEvents.filter((event) => event.status === 'done').length,
      loopPhaseEvents: sameDay.filter((event) => event.kind === 'loop_phase').length,
      pullRequestChanges: 0,
      pullRequestChangeCoverage: prChangeCoverage,
    };
    const counts = ticketCounts(tickets);
    return {
      ...structuredClone(project), artifacts: sourceArtifacts.map((item) => structuredClone(artifacts.get(`${project.productId}:${item.id}`) ?? { ...publicArtifact(item), status: 'unavailable', error: 'artifact_not_observed' })),
      progress: { status, ...(catalogObservedAt === undefined ? {} : { observedAt: catalogObservedAt }), populationBasis: 'catalog_tickets_explicit_status', tickets: counts, evidence: evidenceCounts(tickets), pullRequests: pullRequestMetrics(projectPullRequests, status, catalogObservedAt) },
      dailySummaries: [{ date: currentDate, timezone, observedAt: current.toISOString(), populationBasis: 'retained_same_day_events', done: counts.done, inProgress: counts.inProgress, remaining: counts.remaining, blocked: counts.blocked, activity }],
      pullRequests: projectPullRequests,
    };
  });
}

async function artifactProjection(project: WorkCatalogProject, artifact: WorkCatalogArtifact, observedAt: string): Promise<WorkManagementArtifactProjection> {
  const unavailable = (error: string): WorkManagementArtifactProjection => ({ ...publicArtifact(artifact), status: 'unavailable', observedAt, error });
  if (artifact.content !== undefined) {
    const content = sanitizeArtifactContentForProjection(artifact.content);
    return {
      id: artifact.id, title: artifact.title, role: artifact.role, path: artifact.path, status: 'available', content, contentBasis: 'owner_snapshot',
      digest: createHash('sha256').update(artifact.content).digest('hex'), observedAt, ...(artifact.snapshotAt === undefined ? {} : { snapshotAt: artifact.snapshotAt }), ...(artifact.sourceRevision === undefined ? {} : { sourceRevision: artifact.sourceRevision }),
    };
  }
  if (!project.artifactHome) return unavailable('artifact_home_not_configured');
  // Node does not expose an openat/dirfd API on macOS or Windows. Do not
  // emulate one with lstat/realpath walks: an intermediate directory can be
  // swapped after inspection. Linux /proc/self/fd gives descriptor-anchored
  // traversal; other hosts deliberately retain metadata without content.
  if (process.platform !== 'linux') return unavailable('artifact_content_unavailable_without_dirfd_traversal');
  try {
    let directory = await open(project.artifactHome, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parts = artifact.path.split('/');
    let bytes: Buffer;
    try {
      for (const segment of parts.slice(0, -1)) {
        const next = await open(`/proc/self/fd/${directory.fd}/${segment}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await directory.close();
        directory = next;
      }
      const handle = await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      try {
        if (!before.isFile() || before.size > MAX_ARTIFACT_BYTES) return unavailable('artifact_not_a_bounded_regular_file');
        bytes = await handle.readFile();
        const after = await handle.stat();
        if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || bytes.length !== before.size) return unavailable('artifact_changed_during_read');
      } finally { await handle.close(); }
    } finally { await directory.close(); }
    if (bytes.includes(0)) return unavailable('artifact_not_text');
    const content = bytes.toString('utf8');
    if (content.includes('\uFFFD')) return unavailable('artifact_not_utf8_text');
    return { id: artifact.id, title: artifact.title, role: artifact.role, path: artifact.path, status: 'available', content: sanitizeArtifactContentForProjection(content), contentBasis: 'observed_file', digest: createHash('sha256').update(bytes).digest('hex'), observedAt };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return unavailable(code === 'ENOENT' ? 'artifact_missing' : code === 'ENOTDIR' || code === 'ELOOP' || code === 'EINVAL' ? 'artifact_content_unavailable_without_dirfd_traversal' : 'artifact_unreadable');
  }
}

/** A single serialized digest poller. It observes files; it never edits or schedules work. */
export class WorkCatalogObserver {
  #catalog?: WorkCatalog;
  #revision?: string;
  #observedAt?: string;
  #error?: string;
  #artifacts = new Map<string, WorkManagementArtifactProjection>();
  #refreshing: Promise<void> = Promise.resolve();
  #listeners = new Set<() => void>();
  #projectionKey?: string;

  readonly configuration: WorkCatalogConfiguration;
  readonly productNames: ReadonlyMap<string, string>;
  readonly timezone: string;
  readonly #now: () => Date;

  private constructor(configuration: WorkCatalogConfiguration, productNames: ReadonlyMap<string, string> = new Map(), now: () => Date = () => new Date()) {
    this.configuration = configuration;
    this.productNames = productNames;
    this.#now = now;
    this.timezone = configuration.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { new Intl.DateTimeFormat('en-US', { timeZone: this.timezone }); } catch { throw new Error('work_catalog_timezone_invalid'); }
  }

  static async open(configuration: WorkCatalogConfiguration, productNames?: ReadonlyMap<string, string>, options?: { now?: () => Date }): Promise<WorkCatalogObserver> {
    const observer = new WorkCatalogObserver(configuration, productNames, options?.now);
    await observer.refresh();
    if (!observer.#catalog) throw new Error(observer.#error ?? 'work catalog is unavailable');
    return observer;
  }

  onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  snapshot(manager?: { sessions: ManagerConnectedSessionAssignment[]; requests: WorkManagementRequest[]; decisions: ManagerConnectedDecisionSnapshot[] }, pullRequests: readonly WorkManagementPullRequestProjection[] = [], events: readonly WorkManagementDailyEvent[] = []): WorkManagementState {
    const catalog = this.#catalog;
    const status: WorkManagementAvailability = catalog ? (this.#error ? 'stale' : 'available') : 'unavailable';
    return {
      status, ...(this.#revision === undefined ? {} : { revision: this.#revision }), ...(this.#observedAt === undefined ? {} : { observedAt: this.#observedAt }), ...(this.#error === undefined ? {} : { error: this.#error }),
      projects: catalog ? publicProjects(catalog, this.#artifacts, this.#observedAt, this.#now(), status, pullRequests, events, this.timezone).map((project) => ({ ...project, title: this.productNames.get(project.productId) ?? project.title })) : [], sessions: (manager?.sessions ?? []).map((session) => ({ ...session, liveness: 'unknown' as const })), requests: manager?.requests ?? [], decisions: manager?.decisions ?? [],
    };
  }

  catalog(): WorkCatalog | undefined { return this.#catalog && structuredClone(this.#catalog); }

  async refresh(): Promise<void> {
    const operation = async (): Promise<void> => {
      const observedAt = new Date().toISOString();
      const beforeState = this.#projectionKey ?? projectionChangeKey(this.snapshot());
      try {
        const details = await lstat(this.configuration.path);
        if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_ARTIFACT_BYTES) throw new Error('catalog must be a bounded regular file');
        const bytes = await readFile(this.configuration.path);
        if (bytes.length !== details.size || bytes.includes(0)) throw new Error('catalog changed during read or is not text');
        const revision = createHash('sha256').update(bytes).digest('hex');
        const parsed = revision === this.#revision && this.#catalog
          ? this.#catalog
          : parseWorkCatalog(JSON.parse(bytes.toString('utf8')) as unknown);
        const artifacts = new Map<string, WorkManagementArtifactProjection>();
        for (const project of parsed.projects) for (const artifact of project.artifacts) artifacts.set(`${project.productId}:${artifact.id}`, await artifactProjection(project, artifact, observedAt));
        const oldArtifacts = [...this.#artifacts.values()].map(({ observedAt: _observedAt, ...item }) => item);
        const nextArtifacts = [...artifacts.values()].map(({ observedAt: _observedAt, ...item }) => item);
        const artifactChanged = JSON.stringify(oldArtifacts) !== JSON.stringify(nextArtifacts);
        if (revision !== this.#revision || artifactChanged || this.#error !== undefined) {
          this.#catalog = parsed; this.#revision = revision; this.#observedAt = observedAt; this.#artifacts = artifacts; this.#error = undefined;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'catalog_reload_failed';
        if (message !== this.#error) { this.#observedAt = observedAt; this.#error = message; }
      }
      const afterState = projectionChangeKey(this.snapshot());
      this.#projectionKey = afterState;
      if (afterState !== beforeState) for (const listener of this.#listeners) listener();
    };
    const next = this.#refreshing.then(operation, operation); this.#refreshing = next.catch(() => undefined); return next;
  }
}
