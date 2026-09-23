import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { DurableCoordinator } from '../runtime/coordinator.ts';
import type { RunIntent } from '../runtime/contracts.ts';
import {
  RoleQueueController,
  queueReadinessIsFresh,
  type AuthoritativeQueueSnapshot,
  type AuthoritativeWorkCandidate,
  type EntryGuardEvidence,
  type QueueBlocker,
  type QueueEvaluation,
  type QueueExecutor,
  type QueueMode,
  type QueueDependency,
  type RoleQueuePolicy,
  type WorkerReceipt,
  type WorkflowEvent,
} from '../workflow/index.ts';
import { deliveryJournal } from './delivery-journal.ts';

const MAX_SOURCE_BYTES = 256 * 1024;

type RecordValue = Record<string, unknown>;

export interface WorkflowRuntimeConfiguration {
  /** Private owner-controlled status/evidence projection; never read from a client command. */
  sourcePath: string;
  /** The source may schedule only these controller-owned execution scopes. */
  executionScopes: readonly string[];
  /** Existing dispatch owns these scopes; the queue controller will never compete for them. */
  legacyExecutionScopes: readonly string[];
}

export interface ConfiguredWorkflowWorkItem { workItemId: string; intent: RunIntent; }

export interface WorkflowAuthorityCandidate {
  workItemId: string;
  trackerStatusId: string;
  revision: string;
  rank: number;
  dependencies: readonly QueueDependency[];
  entryEvidence: readonly EntryGuardEvidence[];
  /** Provider-pool grouping is informational here; routing owns capacity decisions. */
  accountPoolId?: string;
  /** Controller-owned serialization key for candidates sharing a file boundary. */
  sharedFileKey?: string;
}

/**
 * Optional live authority observation (Jira or graph controller). When it is
 * configured, every source candidate must be present and exact before it can
 * be scheduled. A private source file alone is never presented as tracker sync.
 */
export interface WorkflowAuthorityPort {
  observe(source: { revision: string; candidates: readonly WorkflowAuthorityCandidate[] }): Promise<{
    revision: string;
    candidates: readonly WorkflowAuthorityCandidate[];
  }>;
}

export interface WorkflowTrustedReadinessPort {
  /** Trusted controller-only observations; browser/config booleans never reach this port. */
  observe(input: { sourceRevision: string; candidates: readonly AuthoritativeWorkCandidate[] }): Promise<{
    authorityRevision: string;
    observedAt: string;
    transport: { ready: boolean; blockers: readonly string[] };
    nativeGoal: { ready: boolean; blockers: readonly string[] };
    supervision: { ready: boolean; blockers: readonly string[] };
    witness: { ready: boolean; blockers: readonly string[] };
  }>;
}

export interface ConsoleWorkflowRuntimeOptions {
  coordinator: DurableCoordinator;
  configuration: WorkflowRuntimeConfiguration;
  workItems: readonly ConfiguredWorkflowWorkItem[];
  /** Adapter to CoordinatorProviderDelivery or Manager relay; it cannot receive arbitrary client commands. */
  executor: QueueExecutor;
  authority?: WorkflowAuthorityPort;
  trustedReadiness?: WorkflowTrustedReadinessPort;
  now?: () => Date;
}

export interface ConsoleWorkflowRuntimeSnapshot {
  /** A valid attended source is not evidence that automatic wake-up is safe. */
  status: 'not_configured' | 'shadow' | 'attended' | 'automatic' | 'blocked';
  mode?: QueueMode;
  /** True only when the trusted controller observed every automatic facet. */
  automaticReady: boolean;
  /** Capability evidence is kept separate from tracker/queue blockers for the Console. */
  capabilityBlockers: readonly QueueBlocker[];
  sourceRevision?: string;
  policyRevision?: string;
  lastEvaluatedAt?: string;
  queue?: QueueEvaluation['queue'];
  blockers: readonly QueueBlocker[];
  reason?: string;
}

interface SourceCandidate extends WorkflowAuthorityCandidate {
  runtimeWorkItemId: string;
  executionScope: string;
  queuedAt: string;
}

interface WorkflowSourceFile {
  format: 'faktori.console-workflow-source/v1';
  revision: string;
  validUntil: string;
  policy: RoleQueuePolicy;
  candidates: SourceCandidate[];
}

function record(value: unknown): RecordValue | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined; }
function text(value: unknown, max = 512): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\u0000'); }
function timestamp(value: unknown): value is string { return text(value, 128) && Number.isFinite(Date.parse(value)); }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function scopeList(value: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 128 || value.some((item) => !text(item, 128))) throw new Error(`${field}_invalid`);
  const list = [...new Set(value as string[])];
  if (list.length !== value.length) throw new Error(`${field}_duplicate`);
  return list;
}

export function parseWorkflowRuntimeConfiguration(value: unknown): WorkflowRuntimeConfiguration {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => !['sourcePath', 'executionScopes', 'legacyExecutionScopes'].includes(key))) throw new Error('workflow_runtime_configuration_invalid');
  if (!text(input.sourcePath, 2048) || !isAbsolute(input.sourcePath)) throw new Error('workflow_runtime_source_path_invalid');
  const executionScopes = scopeList(input.executionScopes, 'workflow_execution_scopes', false);
  const legacyExecutionScopes = input.legacyExecutionScopes === undefined ? [] : scopeList(input.legacyExecutionScopes, 'workflow_legacy_execution_scopes', true);
  return { sourcePath: input.sourcePath, executionScopes, legacyExecutionScopes };
}

function dependency(value: unknown): QueueDependency {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => !['workItemId', 'state', 'evidenceRevision'].includes(key)) || !text(input.workItemId, 256)
    || !['satisfied', 'unsatisfied', 'unknown'].includes(String(input.state)) || (input.evidenceRevision !== undefined && !text(input.evidenceRevision, 256))) throw new Error('workflow_source_dependency_invalid');
  return { workItemId: input.workItemId, state: input.state as QueueDependency['state'], ...(input.evidenceRevision === undefined ? {} : { evidenceRevision: input.evidenceRevision }) };
}

function evidence(value: unknown): EntryGuardEvidence {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => !['guardId', 'revision', 'observedAt'].includes(key)) || !text(input.guardId, 256) || !text(input.revision, 256) || !timestamp(input.observedAt)) throw new Error('workflow_source_evidence_invalid');
  return { guardId: input.guardId, revision: input.revision, observedAt: new Date(input.observedAt).toISOString() };
}

function candidate(value: unknown): SourceCandidate {
  const input = record(value);
  const allowed = ['workItemId', 'runtimeWorkItemId', 'executionScope', 'trackerStatusId', 'revision', 'rank', 'queuedAt', 'dependencies', 'entryEvidence', 'accountPoolId', 'sharedFileKey'];
  if (!input || Object.keys(input).some((key) => !allowed.includes(key)) || !text(input.workItemId, 256) || !text(input.runtimeWorkItemId, 256)
    || !text(input.executionScope, 256) || !text(input.trackerStatusId, 256) || !text(input.revision, 256) || !Number.isInteger(input.rank)
    || Number(input.rank) < 0 || !timestamp(input.queuedAt) || !Array.isArray(input.dependencies) || input.dependencies.length > 256
    || !Array.isArray(input.entryEvidence) || input.entryEvidence.length > 256
    || (input.accountPoolId !== undefined && !text(input.accountPoolId, 256)) || (input.sharedFileKey !== undefined && !text(input.sharedFileKey, 256))) throw new Error('workflow_source_candidate_invalid');
  return { workItemId: input.workItemId, runtimeWorkItemId: input.runtimeWorkItemId, executionScope: input.executionScope,
    trackerStatusId: input.trackerStatusId, revision: input.revision, rank: Number(input.rank), queuedAt: new Date(input.queuedAt).toISOString(),
    dependencies: input.dependencies.map(dependency), entryEvidence: input.entryEvidence.map(evidence),
    ...(input.accountPoolId === undefined ? {} : { accountPoolId: input.accountPoolId }), ...(input.sharedFileKey === undefined ? {} : { sharedFileKey: input.sharedFileKey }) };
}

function cycleFree(candidates: readonly SourceCandidate[]): void {
  const byId = new Map(candidates.map((item) => [item.workItemId, item]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id) || !byId.has(id)) return;
    if (visiting.has(id)) throw new Error('workflow_source_dependency_cycle');
    visiting.add(id);
    for (const item of byId.get(id)!.dependencies) visit(item.workItemId);
    visiting.delete(id); visited.add(id);
  };
  for (const item of candidates) visit(item.workItemId);
}

function sourceFile(value: unknown, now: Date): WorkflowSourceFile {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => !['format', 'revision', 'validUntil', 'policy', 'candidates'].includes(key))
    || input.format !== 'faktori.console-workflow-source/v1' || !text(input.revision, 256) || !timestamp(input.validUntil)
    || Date.parse(input.validUntil) <= now.getTime() || !Array.isArray(input.candidates) || input.candidates.length > 512 || !input.policy) throw new Error('workflow_source_invalid_or_stale');
  const candidates = input.candidates.map(candidate);
  if (new Set(candidates.map((item) => item.workItemId)).size !== candidates.length || new Set(candidates.map((item) => item.runtimeWorkItemId)).size !== candidates.length) throw new Error('workflow_source_candidate_identity_ambiguous');
  cycleFree(candidates);
  return { format: input.format, revision: input.revision, validUntil: new Date(input.validUntil).toISOString(), policy: input.policy as RoleQueuePolicy, candidates };
}

async function privateSource(path: string, now: Date): Promise<WorkflowSourceFile> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_SOURCE_BYTES || (details.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && details.uid !== process.getuid())) throw new Error('workflow_source_unsafe');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== details.dev || before.ino !== details.ino || before.size !== details.size) throw new Error('workflow_source_changed');
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (bytes.length !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw new Error('workflow_source_changed');
    return sourceFile(JSON.parse(bytes.toString('utf8')) as unknown, now);
  } finally { await handle.close(); }
}

function unavailableReadiness(revision: string, now: Date): AuthoritativeQueueSnapshot['readiness'] {
  const unavailable = { ready: false, blockers: ['trusted_readiness_not_configured'] };
  return { authorityRevision: `unavailable:${revision}`, observedAt: now.toISOString(), automatic: unavailable, transport: unavailable, witness: unavailable };
}

function automaticCapabilityBlockers(readiness: AuthoritativeQueueSnapshot['readiness'], now: Date): QueueBlocker[] {
  const facets: Array<[string, { ready: boolean; blockers: readonly string[] }]> = [
    ['automatic', readiness.automatic], ['transport', readiness.transport], ['witness', readiness.witness],
  ];
  return [...(queueReadinessIsFresh(readiness, now) ? [] : [{ code: 'automatic_readiness_stale_or_future', detail: readiness.authorityRevision }]), ...facets.flatMap(([facet, value]) => value.ready ? [] : [{
    code: `automatic_${facet}_capability_missing`,
    detail: value.blockers.join(',') || readiness.authorityRevision,
  }])];
}

function automaticReady(readiness: AuthoritativeQueueSnapshot['readiness'], now: Date): boolean {
  return queueReadinessIsFresh(readiness, now) && readiness.automatic.ready && readiness.transport.ready && readiness.witness.ready;
}

/**
 * Console composition over RoleQueueController. It owns neither external
 * tracker writes nor provider execution: root injects those authenticated
 * boundaries, while this facade enforces the source/journal/replay contract.
 */
export class ConsoleWorkflowRuntime {
  readonly #configuration: WorkflowRuntimeConfiguration;
  readonly #workItems: Map<string, ConfiguredWorkflowWorkItem>;
  readonly #journal;
  readonly #executor: QueueExecutor;
  readonly #authority?: WorkflowAuthorityPort;
  readonly #trustedReadiness?: WorkflowTrustedReadinessPort;
  readonly #now: () => Date;
  #controller?: RoleQueueController;
  #policyRevision?: string;
  #policyDigest?: string;
  #state: ConsoleWorkflowRuntimeSnapshot = { status: 'not_configured', automaticReady: false, capabilityBlockers: [], blockers: [] };
  #lastReadiness?: AuthoritativeQueueSnapshot['readiness'];

  constructor(options: ConsoleWorkflowRuntimeOptions) {
    this.#configuration = parseWorkflowRuntimeConfiguration(options.configuration);
    this.#workItems = new Map(options.workItems.map((item) => [item.workItemId, item]));
    if (this.#workItems.size !== options.workItems.length || [...this.#workItems.values()].some((item) => !text(item.workItemId, 256) || !text(item.intent.runId, 256))) throw new Error('workflow_runtime_work_items_invalid');
    this.#journal = deliveryJournal<WorkflowEvent>(options.coordinator, 'workflow');
    this.#executor = options.executor;
    this.#authority = options.authority;
    this.#trustedReadiness = options.trustedReadiness;
    this.#now = options.now ?? (() => new Date());
  }

  snapshot(): ConsoleWorkflowRuntimeSnapshot {
    const state = structuredClone(this.#state);
    if (this.#lastReadiness && !queueReadinessIsFresh(this.#lastReadiness, this.#now())) {
      state.automaticReady = false;
      state.capabilityBlockers = automaticCapabilityBlockers(this.#lastReadiness, this.#now());
      if (state.mode === 'automatic') state.status = 'blocked';
    }
    return state;
  }

  async evaluate(options: { mode: QueueMode }): Promise<QueueEvaluation> {
    try {
      const controller = await this.#controllerForCurrentPolicy();
      const result = await controller.evaluate({ mode: options.mode, excludedScopes: this.#configuration.legacyExecutionScopes });
      const readiness = this.#lastReadiness ?? unavailableReadiness(result.sourceRevision, this.#now());
      const ready = automaticReady(readiness, this.#now());
      const capabilityBlockers = automaticCapabilityBlockers(readiness, this.#now());
      this.#state = {
        status: options.mode === 'shadow' ? 'shadow' : options.mode === 'attended' ? 'attended' : ready ? 'automatic' : 'blocked',
        mode: options.mode, automaticReady: ready, capabilityBlockers, sourceRevision: result.sourceRevision,
        policyRevision: this.#policyRevision, lastEvaluatedAt: this.#now().toISOString(), queue: result.queue, blockers: result.blockers,
      };
      return result;
    } catch (error) {
      const blocker = { code: 'workflow_evaluation_unavailable', detail: error instanceof Error ? error.message : 'unknown' };
      this.#state = { status: 'blocked', mode: options.mode, automaticReady: false, capabilityBlockers: this.#lastReadiness ? automaticCapabilityBlockers(this.#lastReadiness, this.#now()) : [], lastEvaluatedAt: this.#now().toISOString(), blockers: [blocker], reason: blocker.detail };
      throw error;
    }
  }

  async reconcile(): Promise<readonly QueueBlocker[]> {
    try {
      const controller = await this.#controllerForCurrentPolicy();
      const blockers = await controller.reconcile();
      this.#state = { ...this.#state, lastEvaluatedAt: this.#now().toISOString(), blockers };
      return blockers;
    } catch (error) {
      const blocker = { code: 'workflow_reconcile_unavailable', detail: error instanceof Error ? error.message : 'unknown' };
      this.#state = { status: 'blocked', automaticReady: false, capabilityBlockers: this.#lastReadiness ? automaticCapabilityBlockers(this.#lastReadiness, this.#now()) : [], lastEvaluatedAt: this.#now().toISOString(), blockers: [blocker], reason: blocker.detail };
      throw error;
    }
  }

  async receipt(receipt: WorkerReceipt): Promise<{ applied: boolean; reason?: string }> {
    try { return await (await this.#controllerForCurrentPolicy()).recordReceipt(receipt); }
    catch (error) {
      const blocker = { code: 'workflow_receipt_unavailable', detail: error instanceof Error ? error.message : 'unknown' };
      this.#state = { status: 'blocked', automaticReady: false, capabilityBlockers: this.#lastReadiness ? automaticCapabilityBlockers(this.#lastReadiness, this.#now()) : [], lastEvaluatedAt: this.#now().toISOString(), blockers: [blocker], reason: blocker.detail };
      throw error;
    }
  }

  async #controllerForCurrentPolicy(): Promise<RoleQueueController> {
    const source = await privateSource(this.#configuration.sourcePath, this.#now());
    const policyDigest = digest(source.policy);
    if (this.#controller && this.#policyRevision === source.policy.revision && this.#policyDigest !== policyDigest) throw new Error('workflow_policy_changed_without_revision');
    if (this.#controller === undefined || this.#policyRevision !== source.policy.revision) {
      const policyRevision = source.policy.revision;
      this.#controller = new RoleQueueController({ policy: source.policy, journal: this.#journal, executor: this.#executor,
        now: this.#now, source: { observe: async () => this.#observe(policyRevision) } });
      this.#policyRevision = policyRevision;
      this.#policyDigest = policyDigest;
    }
    return this.#controller;
  }

  async #observe(expectedPolicyRevision: string): Promise<AuthoritativeQueueSnapshot> {
    const source = await privateSource(this.#configuration.sourcePath, this.#now());
    if (source.policy.revision !== expectedPolicyRevision) throw new Error('workflow_source_policy_changed_retry');
    const byRuntimeId = this.#workItems;
    for (const item of source.candidates) {
      if (!byRuntimeId.has(item.runtimeWorkItemId)) throw new Error('workflow_source_runtime_work_item_unconfigured');
      if (!this.#configuration.executionScopes.includes(item.executionScope)) throw new Error('workflow_source_execution_scope_unconfigured');
    }
    const expectedAuthority = source.candidates.map((item) => ({ workItemId: item.workItemId, trackerStatusId: item.trackerStatusId, revision: item.revision, rank: item.rank, dependencies: item.dependencies, entryEvidence: item.entryEvidence,
      ...(item.accountPoolId === undefined ? {} : { accountPoolId: item.accountPoolId }), ...(item.sharedFileKey === undefined ? {} : { sharedFileKey: item.sharedFileKey }) }));
    let authorityRevision = `static:${source.revision}`;
    let authoritative = new Map<string, WorkflowAuthorityCandidate>();
    let authorityUnavailable: string | undefined;
    if (this.#authority !== undefined) {
      try {
        const observed = await this.#authority.observe({ revision: source.revision, candidates: expectedAuthority });
        if (!text(observed.revision, 256) || !Array.isArray(observed.candidates) || observed.candidates.length > 512) throw new Error('authority_observation_invalid');
        authorityRevision = observed.revision;
        authoritative = new Map(observed.candidates.map((item) => [item.workItemId, item]));
      } catch (error) { authorityUnavailable = error instanceof Error ? error.message : 'authority_observation_unavailable'; }
    }
    const candidates: AuthoritativeWorkCandidate[] = source.candidates.map((item) => {
      const actual = authoritative.get(item.workItemId);
      const current = actual ?? { workItemId: item.workItemId, trackerStatusId: item.trackerStatusId, revision: item.revision, rank: item.rank, dependencies: item.dependencies, entryEvidence: item.entryEvidence,
        ...(item.accountPoolId === undefined ? {} : { accountPoolId: item.accountPoolId }), ...(item.sharedFileKey === undefined ? {} : { sharedFileKey: item.sharedFileKey }) };
      const authorityMissing = this.#authority !== undefined && (authorityUnavailable !== undefined || actual === undefined);
      const bound = byRuntimeId.get(item.runtimeWorkItemId)!;
      if (bound.intent.workItem.revision !== current.revision) throw new Error('workflow_source_runtime_candidate_revision_mismatch');
      const stage = source.policy.stages.find((policy) => policy.statusIds.includes(current.trackerStatusId));
      if (stage === undefined) throw new Error('workflow_source_tracker_status_unmapped');
      if ((bound.intent.workItem.role ?? 'builder') !== stage.role) throw new Error('workflow_source_runtime_role_mismatch');
      return { workItemId: item.workItemId, executionScope: item.executionScope, trackerStatusId: current.trackerStatusId, revision: current.revision,
        rank: current.rank, queuedAt: item.queuedAt, entryEvidence: current.entryEvidence, runtime: { workItemId: bound.workItemId, runId: bound.intent.runId },
        dependencies: authorityMissing ? [...current.dependencies, { workItemId: `authority:${authorityUnavailable ?? 'missing'}`, state: 'unknown' as const }] : current.dependencies,
        ...(current.accountPoolId === undefined ? {} : { accountPoolId: current.accountPoolId }), ...(current.sharedFileKey === undefined ? {} : { sharedFileKey: current.sharedFileKey }) };
    });
    const readiness = this.#trustedReadiness === undefined ? unavailableReadiness(source.revision, this.#now()) : await this.#readiness(source.revision, candidates);
    this.#lastReadiness = readiness;
    return { format: 'faktori.role-queue-source/v1', revision: digest({ source: source.revision, authority: authorityRevision, candidates: candidates.map((item) => ({ id: item.workItemId, status: item.trackerStatusId, revision: item.revision, rank: item.rank, dependencies: item.dependencies, evidence: item.entryEvidence, accountPoolId: item.accountPoolId, sharedFileKey: item.sharedFileKey })) }), candidates, readiness };
  }

  async #readiness(sourceRevision: string, candidates: readonly AuthoritativeWorkCandidate[]): Promise<AuthoritativeQueueSnapshot['readiness']> {
    try {
      const observed = await this.#trustedReadiness!.observe({ sourceRevision, candidates });
      if (!text(observed.authorityRevision, 256) || !timestamp(observed.observedAt)) throw new Error('trusted_readiness_invalid');
      const valid = (facet: { ready: boolean; blockers: readonly string[] }) => typeof facet?.ready === 'boolean' && Array.isArray(facet.blockers) && facet.blockers.every((item) => text(item, 512));
      if (!valid(observed.transport) || !valid(observed.nativeGoal) || !valid(observed.supervision) || !valid(observed.witness)) throw new Error('trusted_readiness_invalid');
      return { authorityRevision: observed.authorityRevision, observedAt: new Date(observed.observedAt).toISOString(), transport: observed.transport, witness: observed.witness,
        automatic: { ready: observed.nativeGoal.ready && observed.supervision.ready, blockers: [...observed.nativeGoal.blockers, ...observed.supervision.blockers] } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'trusted_readiness_unavailable';
      return { authorityRevision: `unavailable:${sourceRevision}`, observedAt: this.#now().toISOString(),
        automatic: { ready: false, blockers: [reason] }, transport: { ready: false, blockers: [reason] }, witness: { ready: false, blockers: [reason] } };
    }
  }
}
