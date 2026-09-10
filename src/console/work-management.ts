import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { ManagerConnectedRequestSnapshot, ManagerConnectedSessionAssignment } from '../manager-connected/index.ts';

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
}

/** A public request remains a delivery report, never ticket acceptance. */
export type WorkManagementRequest = ManagerConnectedRequestSnapshot;
export type WorkManagementSession = ManagerConnectedSessionAssignment;

export interface WorkManagementState {
  status: WorkManagementAvailability;
  revision?: string;
  observedAt?: string;
  error?: string;
  projects: WorkManagementProjectProjection[];
  sessions: WorkManagementSession[];
  requests: WorkManagementRequest[];
}

/** Server-only configuration: the browser receives no absolute path. */
export interface WorkCatalogConfiguration {
  path: string;
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
  keys(input, ['id', 'order', 'title', 'goal', 'dependencies', 'issueKey', 'runIds', 'loopIds'], path);
  return {
    id: ticketId(input.id, `${path}.id`), order: order(input.order, `${path}.order`), title: text(input.title, `${path}.title`, 256), goal: text(input.goal, `${path}.goal`),
    dependencies: stringList(input.dependencies, `${path}.dependencies`, ticketId),
    ...(input.issueKey === undefined ? {} : { issueKey: text(input.issueKey, `${path}.issueKey`, 128) }),
    ...(input.runIds === undefined ? {} : { runIds: stringList(input.runIds, `${path}.runIds`) }),
    ...(input.loopIds === undefined ? {} : { loopIds: stringList(input.loopIds, `${path}.loopIds`) }),
  };
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
  keys(input, ['productId', 'title', 'goal', 'artifactHome', 'artifacts', 'plans'], path);
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 100) throw new Error(`${path}.artifacts must be a bounded array`);
  if (!Array.isArray(input.plans) || input.plans.length > 100) throw new Error(`${path}.plans must be a bounded array`);
  const artifacts = input.artifacts.map((entry, index) => artifact(entry, `${path}.artifacts[${index}]`));
  const artifactHome = input.artifactHome === undefined ? undefined : text(input.artifactHome, `${path}.artifactHome`, 4_096);
  if (artifactHome !== undefined && !isAbsolute(artifactHome)) throw new Error(`${path}.artifactHome must be an absolute local path`);
  if (artifacts.some((item) => item.content === undefined) && artifactHome === undefined) throw new Error(`${path}.artifactHome is required for file-observed artifacts`);
  return { productId: id(input.productId, `${path}.productId`), title: text(input.title, `${path}.title`, 256), goal: text(input.goal, `${path}.goal`), ...(artifactHome === undefined ? {} : { artifactHome: resolve(artifactHome) }), artifacts, plans: input.plans.map((entry, index) => plan(entry, `${path}.plans[${index}]`)) };
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
  }
  for (const [ticketId, dependencies] of ticketDependencies) for (const dependency of dependencies) {
    if (ticketProjects.get(dependency) === undefined) throw new Error(`workCatalog ticket ${ticketId} has an orphan dependency ${dependency}`);
    if (ticketProjects.get(dependency) !== ticketProjects.get(ticketId)) throw new Error(`workCatalog ticket ${ticketId} cannot depend across projects`);
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

function publicProjects(catalog: WorkCatalog, artifacts: Map<string, WorkManagementArtifactProjection>): WorkManagementProjectProjection[] {
  return catalog.projects.map(({ artifactHome: _artifactHome, artifacts: sourceArtifacts, ...project }) => ({ ...structuredClone(project), artifacts: sourceArtifacts.map((item) => structuredClone(artifacts.get(`${project.productId}:${item.id}`) ?? { ...publicArtifact(item), status: 'unavailable', error: 'artifact_not_observed' })) }));
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

  readonly configuration: WorkCatalogConfiguration;
  readonly productNames: ReadonlyMap<string, string>;

  private constructor(configuration: WorkCatalogConfiguration, productNames: ReadonlyMap<string, string> = new Map()) {
    this.configuration = configuration;
    this.productNames = productNames;
  }

  static async open(configuration: WorkCatalogConfiguration, productNames?: ReadonlyMap<string, string>): Promise<WorkCatalogObserver> {
    const observer = new WorkCatalogObserver(configuration, productNames);
    await observer.refresh();
    if (!observer.#catalog) throw new Error(observer.#error ?? 'work catalog is unavailable');
    return observer;
  }

  onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  snapshot(manager?: { sessions: WorkManagementSession[]; requests: WorkManagementRequest[] }): WorkManagementState {
    const catalog = this.#catalog;
    return {
      status: catalog ? (this.#error ? 'stale' : 'available') : 'unavailable', ...(this.#revision === undefined ? {} : { revision: this.#revision }), ...(this.#observedAt === undefined ? {} : { observedAt: this.#observedAt }), ...(this.#error === undefined ? {} : { error: this.#error }),
      projects: catalog ? publicProjects(catalog, this.#artifacts).map((project) => ({ ...project, title: this.productNames.get(project.productId) ?? project.title })) : [], sessions: manager?.sessions ?? [], requests: manager?.requests ?? [],
    };
  }

  catalog(): WorkCatalog | undefined { return this.#catalog && structuredClone(this.#catalog); }

  async refresh(): Promise<void> {
    const operation = async (): Promise<void> => {
      const observedAt = new Date().toISOString();
      const beforeState = JSON.stringify(this.snapshot());
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
      if (JSON.stringify(this.snapshot()) !== beforeState) for (const listener of this.#listeners) listener();
    };
    const next = this.#refreshing.then(operation, operation); this.#refreshing = next.catch(() => undefined); return next;
  }
}
