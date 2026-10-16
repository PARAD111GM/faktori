import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DurableCoordinator } from '../runtime/coordinator.ts';
import type { ProviderFinalResult, RunIntent, UsageTelemetry } from '../runtime/contracts.ts';
import { providerContextIsAuthorized, providerContextPayloadDigest, type ProviderCurrentContext, type ProviderRunResult, type ProviderSessionBinding, type ProviderTurnLifecycle } from '../providers/contracts.ts';
import { deliveryJournal } from '../console/delivery-journal.ts';
import type { WorkflowTrustedReadinessPort } from '../console/workflow-runtime.ts';
import { persistPrivateProviderArtifact } from './transports.ts';
import { appServerRecord, CODEX_APP_SERVER_PROTOCOL_VERSION, readNativeMcpExclusionManifest, type NativeMcpExclusionBinding, type CodexAppServerConnection, type CodexAppServerTransport } from './codex-app-server.ts';

export interface NativeSupervisionWitness {
  format: 'faktori.native-supervision-witness/v1';
  authority: 'operator-attested-native-runtime'; fixture: false;
  profileDigest: string; sourceRevision: string; observedAt: string; validUntil: string;
  ownerDecisionId: string; qualificationRunId: string;
  checks: Array<{ kind: 'transport' | 'native_goal' | 'idle_wake' | 'restart' | 'cancel' | 'candidate' | 'runtime'; outcome: 'passed'; path: string; sha256: string }>;
}
export interface NativeSupervisionConfiguration {
  profileId: string; factoryId: string; executable: string; executableSha256: string;
  workspacePath: string; artifactsDirectory: string; model: string; reasoning: 'low' | 'medium' | 'high';
  nativeAccessApproved: true;
  /** Separate explicit operator permission; prepare alone never authorizes inference. */
  boundedTurnApproved: boolean;
  /** Exact protected per-server exclusion manifest, required for inference. */
  mcpExclusion?: NativeMcpExclusionBinding;
  limits: { maxRuntimeMinutes: number; maxOutputBytes: number; maxContextBytes: number };
  /** Exact private operator attestation, never a source/config readiness boolean. */
  witness?: { path: string; sha256: string };
}
type Binding = { runId: string; requestDigest: string; threadId: string; objective: string; sourceRunId?: string; artifactPath: string; artifactSha256: string };
type RecordEvent = { format: 'faktori.native-supervision-record/v1'; eventId: string; profileDigest: string; runId: string; kind: string; data: Record<string, unknown> };
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
function exact(value: unknown, keys: string[]) { const r = appServerRecord(value); if (Object.keys(r).some(k => !keys.includes(k))) throw new Error('native_configuration_unknown_field'); return r; }
export function parseNativeSupervisionConfiguration(value: unknown): NativeSupervisionConfiguration {
  const r = exact(value, ['profileId', 'factoryId', 'executable', 'executableSha256', 'workspacePath', 'artifactsDirectory', 'model', 'reasoning', 'nativeAccessApproved', 'boundedTurnApproved', 'limits', 'witness', 'mcpExclusion']);
  const l = exact(r.limits, ['maxRuntimeMinutes', 'maxOutputBytes', 'maxContextBytes']);
  if (!text(r.profileId, 128) || !text(r.factoryId, 128) || !text(r.model, 128) || !['low', 'medium', 'high'].includes(String(r.reasoning)) || r.nativeAccessApproved !== true || typeof r.boundedTurnApproved !== 'boolean'
    || !text(r.executableSha256, 64) || !/^[a-f0-9]{64}$/.test(r.executableSha256)) throw new Error('native_configuration_invalid');
  for (const key of ['executable', 'workspacePath', 'artifactsDirectory']) if (!text(r[key]) || !isAbsolute(r[key] as string)) throw new Error('native_configuration_path_invalid');
  if (!Number.isSafeInteger(l.maxRuntimeMinutes) || Number(l.maxRuntimeMinutes) < 1 || Number(l.maxRuntimeMinutes) > 10 || !Number.isSafeInteger(l.maxOutputBytes) || Number(l.maxOutputBytes) < 1024 || Number(l.maxOutputBytes) > 8_000_000 || !Number.isSafeInteger(l.maxContextBytes) || Number(l.maxContextBytes) < 1 || Number(l.maxContextBytes) > 128000) throw new Error('native_configuration_limits_invalid');
  if (r.witness !== undefined) { const w = exact(r.witness, ['path', 'sha256']); if (!text(w.path) || !isAbsolute(w.path) || !text(w.sha256, 64) || !/^[a-f0-9]{64}$/.test(w.sha256)) throw new Error('native_witness_binding_invalid'); }
  if (r.mcpExclusion !== undefined) { const m = exact(r.mcpExclusion, ['path', 'sha256']); if (!text(m.path) || !isAbsolute(m.path) || !text(m.sha256, 64) || !/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error('native_mcp_manifest_binding_invalid'); }
  if (r.boundedTurnApproved && !r.mcpExclusion) throw new Error('native_mcp_exclusion_required_for_inference');
  return JSON.parse(JSON.stringify(r)) as NativeSupervisionConfiguration;
}
export function nativeSupervisionProfileDigest(config: NativeSupervisionConfiguration): string {
  const { witness: _witness, ...profile } = parseNativeSupervisionConfiguration(config); return sha(canonical(profile));
}
async function bytes(path: string, max: number, privateFile = true): Promise<Buffer> {
  if (await realpath(path) !== path) throw new Error('native_path_not_canonical');
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = await h.stat(); if (!s.isFile() || s.size > max || privateFile && ((s.mode & 0o077) !== 0 || typeof process.getuid === 'function' && s.uid !== process.getuid())) throw new Error('native_file_unavailable'); return await h.readFile(); } finally { await h.close(); }
}
/** Vendor executables can exceed response-file bounds. Hash a canonical regular
 * file in bounded chunks; never allocate its full payload or follow a symlink. */
export async function nativeSupervisionExecutableDigest(path: string): Promise<string> {
  const maximum = 512 * 1024 * 1024;
  if (!isAbsolute(path) || await realpath(path) !== path) throw new Error('native_executable_not_canonical');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) throw new Error('native_executable_unavailable_or_too_large');
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(256 * 1024); let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position); if (bytesRead === 0) break;
      position += bytesRead; if (position > maximum || position > before.size) throw new Error('native_executable_changed_during_digest');
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat(), named = await lstat(path);
    if (position !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !named.isFile() || named.dev !== after.dev || named.ino !== after.ino || named.size !== after.size || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs) throw new Error('native_executable_changed_during_digest');
    return hash.digest('hex');
  } finally { await handle.close(); }
}
function emptyResult(command: 'start' | 'resume', outcome: ProviderFinalResult['outcome'], sessionId?: string): ProviderRunResult {
  return { command, sessionId, events: [], malformedEventCount: 0, final: { outcome, sessionId, summary: `Native supervision: ${outcome}`, usage: { availability: 'unavailable', unavailableReason: 'native usage was not observed' }, nativeCancellationReceipt: false } };
}

/** Adds native task observations to the existing coordinator, never a scheduler. */
export class TaskSupervisor implements WorkflowTrustedReadinessPort {
  readonly configuration: NativeSupervisionConfiguration;
  readonly profileDigest: string;
  readonly coordinator: DurableCoordinator;
  readonly transport: CodexAppServerTransport;
  readonly #workItems: ReadonlyMap<string, { workItemId: string; intent: RunIntent; context: ProviderCurrentContext }>;
  readonly #journal;
  #active?: { intent: RunIntent; connection: CodexAppServerConnection; threadId: string; turnId?: string; cancelRequested: boolean; completion: Promise<ProviderFinalResult>; finish(value: ProviderFinalResult): void; lifecycle: ProviderTurnLifecycle; cancelPromise?: Promise<ProviderFinalResult> };
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #observedReadiness?: { sourceRevision: string; at: number };
  constructor(options: { coordinator: DurableCoordinator; configuration: NativeSupervisionConfiguration; transport: CodexAppServerTransport; workItems?: readonly { workItemId: string; intent: RunIntent; context: ProviderCurrentContext }[] }) {
    this.configuration = parseNativeSupervisionConfiguration(options.configuration); this.profileDigest = nativeSupervisionProfileDigest(this.configuration);
    this.coordinator = options.coordinator; this.transport = options.transport; this.#journal = deliveryJournal<RecordEvent>(options.coordinator, 'control');
    this.#workItems = new Map((options.workItems ?? []).map(e => [e.workItemId, e]));
    if (this.#workItems.size !== (options.workItems ?? []).length) throw new Error('native_configured_work_duplicate');
    if (options.coordinator.factoryId !== this.configuration.factoryId) throw new Error('native_factory_mismatch');
  }
  private records(runId?: string) { return this.#journal.events().filter(e => e.format === 'faktori.native-supervision-record/v1' && e.profileDigest === this.profileDigest && (runId === undefined || e.runId === runId)); }
  private append(runId: string, kind: string, data: Record<string, unknown>) {
    return this.#journal.append({ format: 'faktori.native-supervision-record/v1', eventId: `native:${this.profileDigest}:${runId}:${kind}`, profileDigest: this.profileDigest, runId, kind, data });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> { const p = this.#tail.then(work); this.#tail = p.catch(() => {}); return p; }
  private async protectPath(path: string) {
    const workspace = await realpath(this.configuration.workspacePath);
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error('native_protected_path_not_canonical');
    let canonical: string;
    try { canonical = await realpath(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; canonical = join(await realpath(dirname(path)), basename(path)); }
    if (canonical !== path) throw new Error('native_protected_path_not_canonical');
    const contains = (a: string, b: string) => { const r = relative(a, b); return r === '' || r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
    if (contains(workspace, canonical) || contains(canonical, workspace)) throw new Error('native_protected_storage_overlaps_writable_workspace');
  }
  private async protectedStorage() {
    for (const path of [this.configuration.artifactsDirectory, this.configuration.executable, this.coordinator.journal.path, this.coordinator.lockPath, ...(this.coordinator.projection.path === ':memory:' ? [] : [this.coordinator.projection.path]), ...(this.configuration.witness ? [this.configuration.witness.path] : []), ...(this.configuration.mcpExclusion ? [this.configuration.mcpExclusion.path] : [])]) await this.protectPath(path);
  }
  private async validate(intent: RunIntent, context: ProviderCurrentContext, readOnlyRevoked = false) {
    if (this.#closed) throw new Error('native_supervisor_closed');
    const c = this.configuration, s = this.coordinator.snapshot(intent.runId);
    if (!s || canonical(s.intent) !== canonical(intent) || s.authorityRevoked && !readOnlyRevoked) throw new Error('native_run_not_admitted');
    this.validateConfigurationBinding(intent, context);
    if (await realpath(c.workspacePath) !== c.workspacePath || await realpath(c.artifactsDirectory) !== c.artifactsDirectory || await nativeSupervisionExecutableDigest(c.executable) !== c.executableSha256) throw new Error('native_profile_source_changed');
    await this.protectedStorage();
    if (c.mcpExclusion) await readNativeMcpExclusionManifest(c.mcpExclusion);
  }
  private validateConfigurationBinding(intent: RunIntent, context: ProviderCurrentContext) {
    const c = this.configuration;
    if (intent.target.factoryId !== c.factoryId || intent.execution.providerId !== 'codex' || intent.execution.profile !== 'native' || intent.execution.workspacePath !== c.workspacePath || intent.execution.model !== c.model || intent.execution.reasoning !== c.reasoning || intent.context.digest !== context.digest || intent.context.packetRevision !== context.packetRevision || !providerContextIsAuthorized(intent, context) || intent.authority.policy.allowSeparateBilling || !Number.isSafeInteger(intent.budget.maxRuntimeMinutes) || intent.budget.maxRuntimeMinutes < 1 || intent.budget.maxRuntimeMinutes > c.limits.maxRuntimeMinutes || Buffer.byteLength(context.prompt) > c.limits.maxContextBytes) throw new Error('native_run_authority_or_context_mismatch');
  }
  private requestDigest(intent: RunIntent, context: ProviderCurrentContext) { return sha(canonical({ profile: this.profileDigest, intent, payload: providerContextPayloadDigest(context) })); }
  private async binding(intent: RunIntent, context: ProviderCurrentContext): Promise<Binding> {
    const e = this.records(intent.runId).find(e => e.kind === 'prepared'); if (!e) throw new Error('native_owned_thread_not_prepared');
    const b = e.data as unknown as Binding;
    if (b.runId !== intent.runId || b.requestDigest !== this.requestDigest(intent, context) || !UUID.test(b.threadId) || sha(await bytes(b.artifactPath, 500_000)) !== b.artifactSha256) throw new Error('native_owned_thread_binding_changed');
    return b;
  }
  private async artifact(runId: string, stage: string, value: unknown) {
    const path = await persistPrivateProviderArtifact(this.configuration.artifactsDirectory, [this.profileDigest, runId, stage], value); return { artifactPath: path, artifactSha256: sha(await bytes(path, this.configuration.limits.maxOutputBytes * 2 + 500000)) };
  }
  private thread(value: unknown, id?: string) {
    const t = appServerRecord(appServerRecord(value).thread);
    if (!text(t.id) || !UUID.test(t.id) || id !== undefined && t.id !== id || t.cwd !== this.configuration.workspacePath || t.model !== this.configuration.model || t.modelProvider !== 'openai' || t.ephemeral !== false || t.cliVersion !== CODEX_APP_SERVER_PROTOCOL_VERSION) throw new Error('native_thread_scope_or_version_mismatch'); return t;
  }
  private goal(value: unknown, b: Binding, status: string) {
    const g = appServerRecord(appServerRecord(value).goal); if (g.threadId !== b.threadId || g.objective !== b.objective || g.status !== status || g.tokenBudget !== undefined && g.tokenBudget !== null) throw new Error('native_goal_scope_or_status_mismatch'); return g;
  }
  private async mcpTransportBinding(connection: CodexAppServerConnection) {
    const binding = this.configuration.mcpExclusion;
    if (!binding) { if (connection.mcpExclusion) throw new Error('native_mcp_transport_scope_mismatch'); return undefined; }
    const manifest = await readNativeMcpExclusionManifest(binding);
    if (connection.mcpExclusion?.sha256 !== binding.sha256 || canonical(connection.mcpExclusion.serverNames) !== canonical(manifest.serverNames)) throw new Error('native_mcp_transport_scope_mismatch');
    return manifest;
  }
  /** Metadata discovery is scoped to the already-owned loaded thread. This is
   * a pre-inference guard, not portable wildcard/config or network isolation. */
  private async guardMcp(connection: CodexAppServerConnection, threadId: string, timeoutMs = 5000) {
    const manifest = await this.mcpTransportBinding(connection);
    if (!manifest) throw new Error('native_mcp_exclusion_required_for_inference');
    const seen = new Set<string>(), pages: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      const page = await connection.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100, cursor }, timeoutMs);
      if (!Array.isArray(page.data) || page.data.length > 100 || page.nextCursor !== null && page.nextCursor !== undefined && !text(page.nextCursor, 256)) throw new Error('native_mcp_inventory_incomplete');
      for (const value of page.data) {
        const server = appServerRecord(value), tools = appServerRecord(server.tools);
        if (!text(server.name, 100) || !manifest.serverNames.includes(server.name) || seen.has(server.name) || server.runtimeStatus !== 'disabled' || Object.keys(tools).length !== 0 || !Array.isArray(server.resources) || server.resources.length !== 0 || !Array.isArray(server.resourceTemplates) || server.resourceTemplates.length !== 0) throw new Error('native_mcp_inventory_not_excluded');
        seen.add(server.name);
      }
      pages.push(page); cursor = page.nextCursor === undefined ? null : page.nextCursor as string | null;
      if (cursor === null) {
        if (seen.size !== manifest.serverNames.length) throw new Error('native_mcp_inventory_incomplete');
        await this.mcpTransportBinding(connection); return { manifestSha256: this.configuration.mcpExclusion!.sha256, threadId, serverCount: seen.size, inventoryDigest: sha(canonical(pages)), pages };
      }
    }
    throw new Error('native_mcp_inventory_incomplete');
  }
  private async readWitness(sourceRevision: string) {
    await this.protectedStorage();
    const w = this.configuration.witness; if (!w) throw new Error('native_runtime_witness_missing');
    const raw = await bytes(w.path, 65536); if (sha(raw) !== w.sha256) throw new Error('native_witness_bytes_changed');
    const v = exact(JSON.parse(raw.toString('utf8')), ['format', 'authority', 'fixture', 'profileDigest', 'sourceRevision', 'observedAt', 'validUntil', 'ownerDecisionId', 'qualificationRunId', 'checks']);
    const now = Date.now(), observed = Date.parse(String(v.observedAt)), until = Date.parse(String(v.validUntil));
    if (v.format !== 'faktori.native-supervision-witness/v1' || v.authority !== 'operator-attested-native-runtime' || v.fixture !== false || v.profileDigest !== this.profileDigest || v.sourceRevision !== sourceRevision || !text(v.ownerDecisionId, 256) || !text(v.qualificationRunId, 256) || !Number.isFinite(observed) || observed > now || now - observed >= 120000 || !Number.isFinite(until) || until <= now || until - observed > 120000 || !Array.isArray(v.checks) || v.checks.length !== 7) throw new Error('native_witness_missing_stale_or_not_operator_authority');
    const required = new Set(['transport', 'native_goal', 'idle_wake', 'restart', 'cancel', 'candidate', 'runtime']);
    for (const value of v.checks) { const check = exact(value, ['kind', 'outcome', 'path', 'sha256']); if (!required.delete(String(check.kind)) || check.outcome !== 'passed' || !text(check.path) || !isAbsolute(check.path) || !text(check.sha256, 64)) throw new Error('native_witness_evidence_changed'); await this.protectPath(check.path); if (sha(await bytes(check.path, 1000000)) !== check.sha256) throw new Error('native_witness_evidence_changed'); }
    if (required.size) throw new Error('native_witness_checks_missing'); return v;
  }
  /** Metadata-only owned preparation. A paused goal does not authorize a turn. */
  prepare(intent: RunIntent, context: ProviderCurrentContext, session?: ProviderSessionBinding): Promise<Binding> {
    return this.serial(async () => {
      await this.validate(intent, context);
      if (this.records(intent.runId).some(e => e.kind === 'prepared')) { const b = await this.binding(intent, context); if (b.sourceRunId !== session?.sourceRunId || session && b.threadId !== session.sessionId) throw new Error('native_preparation_mode_changed'); return b; }
      if (this.records(intent.runId).some(e => e.kind === 'prepare_intended')) throw new Error('native_prepare_uncertain_no_relaunch');
      let source: Binding | undefined;
      if (session) {
        const s = this.coordinator.snapshot(session.sourceRunId), p = this.records(session.sourceRunId).find(e => e.kind === 'prepared'), terminal = this.records(session.sourceRunId).find(e => e.kind === 'terminal');
        if (!s || !p || !terminal || terminal.data.outcome !== 'completed' || s.providerResult?.sessionId !== session.sessionId || s.providerResult.outcome !== 'completed' || s.intent.workItem.role !== intent.workItem.role || s.intent.execution.workspacePath !== intent.execution.workspacePath || s.intent.target.repository !== intent.target.repository || s.intent.target.productId !== intent.target.productId || s.intent.target.branch !== intent.target.branch || session.sourceContext.digest !== s.intent.context.digest || session.sourceContext.packetRevision !== s.intent.context.packetRevision) throw new Error('native_resume_source_unverified_or_cross_scope');
        const scope = { factoryId: s.intent.target.factoryId, productId: s.intent.target.productId, repository: s.intent.target.repository, workspaceId: s.intent.execution.workspaceId, workspacePath: s.intent.execution.workspacePath, providerId: s.intent.execution.providerId };
        if (canonical(session.sourceScope) !== canonical(scope)) throw new Error('native_resume_source_scope_changed');
        source = p.data as unknown as Binding;
        if (source.threadId !== session.sessionId || sha(await bytes(source.artifactPath, 500000)) !== source.artifactSha256 || sha(await bytes(String(terminal.data.artifactPath), this.configuration.limits.maxOutputBytes * 2 + 500000)) !== terminal.data.artifactSha256) throw new Error('native_resume_source_artifact_changed');
      }
      const requestDigest = this.requestDigest(intent, context);
      await this.append(intent.runId, 'prepare_intended', { requestDigest, ...(session ? { sourceRunId: session.sourceRunId, threadId: session.sessionId } : {}) });
      let connection: CodexAppServerConnection | undefined;
      let stop: (() => void) | undefined, unexpectedTurn = false;
      try {
        connection = await this.transport.connect(this.configuration.workspacePath);
        await this.mcpTransportBinding(connection);
        stop = connection.subscribe((method, p) => { if (method === 'turn/started' || method === 'turn/completed' || method === 'thread/status/changed' && appServerRecord(p.status).type === 'active' || this.configuration.mcpExclusion && method === 'mcpServer/startupStatus/updated') unexpectedTurn = true; });
        if (unexpectedTurn) throw new Error('native_metadata_task_not_idle');
        const t = source ? this.thread(await connection.request('thread/read', { threadId: source.threadId, includeTurns: false }), source.threadId) : this.thread(await connection.request('thread/start', { model: this.configuration.model, modelProvider: 'openai', cwd: this.configuration.workspacePath, ephemeral: false, sandbox: 'read-only', approvalPolicy: 'never', environments: [], allowProviderModelFallback: false }));
        if (!['idle', 'notLoaded'].includes(String(appServerRecord(t.status).type)) || unexpectedTurn) throw new Error('native_metadata_task_not_idle');
        if (source) { this.goal(await connection.request('thread/goal/get', { threadId: source.threadId }), source, 'paused'); if (!['idle', 'notLoaded'].includes(String(appServerRecord(t.status).type))) throw new Error('native_resume_task_not_idle'); }
        const b = { runId: intent.runId, requestDigest, threadId: String(t.id), ...(session ? { sourceRunId: session.sourceRunId } : {}), objective: `One bounded factory turn ${intent.runId}; work ${intent.workItem.id}@${intent.workItem.revision}; context ${context.digest}. No release or product acceptance authority.` };
        // Record exact identity before any goal mutation. Interrupted creation is never retried.
        await this.append(intent.runId, 'thread_observed', { ...b });
        this.goal(await connection.request('thread/goal/set', { threadId: b.threadId, objective: b.objective, status: 'paused', origin: 'user' }), b as Binding, 'paused');
        this.goal(await connection.request('thread/goal/get', { threadId: b.threadId }), b as Binding, 'paused');
        const mcp = this.configuration.mcpExclusion && !source ? await this.guardMcp(connection, b.threadId) : undefined;
        if (unexpectedTurn) throw new Error('native_metadata_preparation_started_inference');
        await connection.close();
        if (unexpectedTurn) throw new Error('native_metadata_preparation_started_inference');
        const a = await this.artifact(intent.runId, 'prepared', { intent, context, binding: b, ...(mcp ? { mcp } : {}), capture: connection.capture() });
        await this.append(intent.runId, 'prepared', { ...b, ...a }); return { ...b, ...a };
      } finally { stop?.(); await connection?.close().catch(() => {}); }
    });
  }
  async execute(intent: RunIntent, context: ProviderCurrentContext, command: 'start' | 'resume', session?: ProviderSessionBinding, lifecycle?: ProviderTurnLifecycle): Promise<ProviderRunResult> {
    return this.serial(async () => {
      await this.validate(intent, context);
      if (!this.configuration.boundedTurnApproved || !lifecycle) throw new Error('native_bounded_turn_not_approved');
      const b = await this.binding(intent, context);
      if (command === 'resume' && (!session || session.sessionId !== b.threadId || session.sourceRunId !== b.sourceRunId) || command === 'start' && b.sourceRunId) throw new Error('native_resume_scope_mismatch');
      const prior = this.records(intent.runId).find(e => e.kind === 'terminal');
      if (prior) {
        for (const kind of ['mcp_checked_before_activation', 'mcp_checked_before_turn']) {
          const guard = this.records(intent.runId).find(e => e.kind === kind);
          if (!guard || guard.data.threadId !== b.threadId || guard.data.manifestSha256 !== this.configuration.mcpExclusion!.sha256 || sha(await bytes(String(guard.data.artifactPath), this.configuration.limits.maxOutputBytes * 2 + 500000)) !== guard.data.artifactSha256) throw new Error('native_mcp_guard_evidence_changed');
        }
        const value = JSON.parse((await bytes(String(prior.data.artifactPath), this.configuration.limits.maxOutputBytes * 2 + 500000)).toString('utf8')); if (sha(await bytes(String(prior.data.artifactPath), this.configuration.limits.maxOutputBytes * 2 + 500000)) !== prior.data.artifactSha256) throw new Error('native_terminal_artifact_changed'); return value.result as ProviderRunResult;
      }
      if (this.records(intent.runId).some(e => e.kind === 'turn_intended')) throw new Error('native_turn_uncertain_inspect_only');
      if (this.records().some(e => e.kind === 'turn_intended' && !this.records(e.runId).some(t => t.kind === 'terminal'))) throw new Error('native_profile_uncertain_capacity_hold');
      await this.append(intent.runId, 'turn_intended', { threadId: b.threadId, requestDigest: b.requestDigest, command });
      const result = emptyResult(command, 'interrupted_uncertain', b.threadId);
      let connection: CodexAppServerConnection | undefined, stop: (() => void) | undefined, closed = false;
      let terminal: Record<string, unknown> | undefined, terminalError: Error | undefined, usage: UsageTelemetry = result.final.usage;
      let turnRequested = false, notifiedTurnId: string | undefined, expectedClosing = false;
      let closeReason: 'timeout' | 'output_limit' | 'cancelled' = 'cancelled';
      let wake: (() => void) | undefined;
      let finish: (value: ProviderFinalResult) => void = () => {};
      const completion = new Promise<ProviderFinalResult>(resolve => { finish = resolve; });
      const startedAt = Date.now(), timeoutMs = intent.budget.maxRuntimeMinutes * 60000;
      try {
        connection = await this.transport.connect(this.configuration.workspacePath, lifecycle);
        await this.mcpTransportBinding(connection);
        const active = { intent, connection, threadId: b.threadId, turnId: undefined as string | undefined, cancelRequested: false, completion, finish, lifecycle }; this.#active = active;
        stop = connection.subscribe((method, p) => {
          if (method === 'faktori/transportFailed') { if (expectedClosing && p.reason === 'native_transport_disconnected') return; if (p.reason === 'native_output_limit') closeReason = 'output_limit'; terminalError = new Error(String(p.reason)); wake?.(); return; }
          if (method === 'mcpServer/startupStatus/updated') { terminalError = new Error('native_mcp_exclusion_drift'); wake?.(); return; }
          if (p.threadId !== b.threadId) { if (['turn/completed', 'turn/started'].includes(method) || method === 'thread/status/changed' && appServerRecord(p.status).type === 'active') { terminalError = new Error('native_foreign_turn_observed'); wake?.(); } return; }
          if (method === 'turn/started') {
            const id = String(appServerRecord(p.turn).id);
            if (!turnRequested || terminal || notifiedTurnId && notifiedTurnId !== id) terminalError = new Error('native_unrequested_or_extra_turn');
            notifiedTurnId = id; wake?.();
          }
          if (method === 'thread/status/changed' && appServerRecord(p.status).type === 'active' && !turnRequested) { terminalError = new Error('native_unrequested_active_task'); wake?.(); }
          if (method === 'turn/completed') {
            if (!turnRequested) terminalError = new Error('native_unrequested_terminal');
            const turn = appServerRecord(p.turn);
            if (terminal && canonical(terminal) !== canonical(turn)) terminalError = new Error('native_terminal_conflict');
            terminal = turn; wake?.();
          }
          if (method === 'thread/tokenUsage/updated' && (!active.turnId || p.turnId === active.turnId)) {
            const u = appServerRecord(appServerRecord(p.tokenUsage).last);
            if (['inputTokens', 'cachedInputTokens', 'outputTokens'].every(k => Number.isSafeInteger(u[k]) && Number(u[k]) >= 0)) usage = { availability: 'reported', inputTokens: Number(u.inputTokens), cachedInputTokens: Number(u.cachedInputTokens), outputTokens: Number(u.outputTokens), reportedBy: 'codex.app-server.thread/tokenUsage/updated' };
          }
          if (method === 'error' && p.willRetry !== true) { terminalError = new Error('native_turn_error'); wake?.(); }
        });
        if (terminalError || terminal) throw new Error('native_unrequested_turn_before_dispatch');
        const t = this.thread(await connection.request('thread/resume', { threadId: b.threadId, model: this.configuration.model, modelProvider: 'openai', cwd: this.configuration.workspacePath, sandbox: context.nativeSandbox === 'read-only' ? 'read-only' : 'workspace-write', approvalPolicy: 'never', excludeTurns: true, runtimeWorkspaceRoots: [this.configuration.workspacePath] }), b.threadId);
        if (appServerRecord(t.status).type !== 'idle') throw new Error('native_task_not_idle_no_steering');
        this.goal(await connection.request('thread/goal/get', { threadId: b.threadId }), b, 'paused');
        if (terminalError || terminal) throw new Error('native_unrequested_turn_before_dispatch');
        await this.validate(intent, context);
        const beforeActivation = await this.guardMcp(connection, b.threadId);
        const activationArtifact = await this.artifact(intent.runId, 'mcp-before-activation', beforeActivation);
        await this.append(intent.runId, 'mcp_checked_before_activation', { threadId: b.threadId, manifestSha256: beforeActivation.manifestSha256, ...activationArtifact });
        await this.validate(intent, context);
        await this.mcpTransportBinding(connection);
        if (terminalError || terminal || active.cancelRequested || Date.now() - startedAt >= timeoutMs) throw new Error('native_handoff_not_available');
        this.goal(await connection.request('thread/goal/set', { threadId: b.threadId, status: 'active', origin: 'user' }), b, 'active');
        this.goal(await connection.request('thread/goal/get', { threadId: b.threadId }), b, 'active');
        await this.validate(intent, context);
        const beforeTurn = await this.guardMcp(connection, b.threadId);
        const turnArtifact = await this.artifact(intent.runId, 'mcp-before-turn', beforeTurn);
        await this.append(intent.runId, 'mcp_checked_before_turn', { threadId: b.threadId, manifestSha256: beforeTurn.manifestSha256, ...turnArtifact });
        if (active.cancelRequested) throw new Error('native_authority_revoked_before_turn');
        if (this.configuration.witness) {
          const r = this.#observedReadiness; if (!r || Date.now() < r.at || Date.now() - r.at >= 120000) throw new Error('native_handoff_readiness_expired');
          await this.readWitness(r.sourceRevision);
        }
        await this.validate(intent, context);
        await this.mcpTransportBinding(connection);
        if (terminalError || terminal || Date.now() - startedAt >= timeoutMs) throw new Error('native_unrequested_turn_before_dispatch');
        turnRequested = true;
        const started = appServerRecord((await connection.request('turn/start', { threadId: b.threadId, input: [{ type: 'text', text: context.prompt, text_elements: [] }], clientUserMessageId: `faktori:${b.requestDigest}`, model: this.configuration.model, effort: this.configuration.reasoning, approvalPolicy: 'never', environments: [], runtimeWorkspaceRoots: [this.configuration.workspacePath], sandboxPolicy: context.nativeSandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [this.configuration.workspacePath], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } })).turn);
        if (!text(started.id) || !UUID.test(started.id) || notifiedTurnId && notifiedTurnId !== started.id) throw new Error('native_turn_identity_missing'); active.turnId = started.id;
        await this.append(intent.runId, 'turn_observed', { threadId: b.threadId, turnId: active.turnId });
        let cancelledAt: number | undefined;
        while (!terminal && !terminalError && Date.now() - startedAt < timeoutMs) {
          if (active.cancelRequested) { cancelledAt ??= Date.now(); if (Date.now() - cancelledAt >= 5000) { await lifecycle.onTerminationRequired?.(connection.worker, 'cancelled'); throw new Error('native_interrupt_terminal_missing'); } }
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, Math.min(250, timeoutMs - (Date.now() - startedAt))); wake = () => { clearTimeout(timer); resolve(); }; });
        }
        if (terminalError) throw terminalError;
        if (!terminal) { closeReason = 'timeout'; await lifecycle.onTerminationRequired?.(connection.worker, 'timeout'); throw new Error('native_turn_timeout'); }
        const observed = terminal as Record<string, unknown>;
        if (observed.id !== active.turnId || !['completed', 'failed', 'interrupted'].includes(String(observed.status))) throw new Error('native_terminal_identity_mismatch');
        result.final.outcome = observed.status === 'completed' && !active.cancelRequested ? 'completed' : observed.status === 'interrupted' && active.cancelRequested ? 'cancelled' : 'failed';
        result.final.nativeCancellationReceipt = observed.status === 'interrupted' && active.cancelRequested;
        result.final.usage = usage;
        this.goal(await connection.request('thread/goal/set', { threadId: b.threadId, status: 'paused', origin: 'automatic' }), b, 'paused');
        if (terminalError) throw terminalError;
        expectedClosing = true; await connection.close(); closed = true;
        if (terminalError) throw terminalError;
      } catch { result.final.outcome = 'interrupted_uncertain'; result.final.nativeCancellationReceipt = false; }
      finally { stop?.(); if (connection && !closed) { try { await connection.close(closeReason); closed = true; } catch { closed = false; } } }
      if (!closed) { result.final.outcome = 'interrupted_uncertain'; result.final.nativeCancellationReceipt = false; }
      try {
        const a = await this.artifact(intent.runId, 'terminal', { result, terminal, capture: connection?.capture(), closed });
        // An uncertain result is retained but never releases native capacity or permits another turn.
        await this.append(intent.runId, result.final.outcome === 'interrupted_uncertain' ? 'uncertain' : 'terminal', { ...a, threadId: b.threadId, outcome: result.final.outcome });
      } catch (error) { result.final.outcome = 'interrupted_uncertain'; result.final.nativeCancellationReceipt = false; throw error; }
      finally { this.#active = undefined; finish(result.final); }
      return result;
    });
  }
  async cancel(intent: RunIntent, lifecycle?: ProviderTurnLifecycle): Promise<ProviderFinalResult> {
    const a = this.#active;
    if (!a || canonical(a.intent) !== canonical(intent)) return emptyResult('start', 'interrupted_uncertain').final;
    if (a.cancelPromise) return a.cancelPromise;
    a.cancelRequested = true;
    const cancel = async () => {
      if (!a.turnId) { await lifecycle?.onTerminationRequired?.(a.connection.worker, 'cancelled'); await a.connection.close(); return emptyResult('start', 'interrupted_uncertain', a.threadId).final; }
      await this.append(intent.runId, 'interrupt_intended', { threadId: a.threadId, turnId: a.turnId });
      // Existing cancellation must prove a live exact PID before interrupt/EOF.
      await lifecycle?.onTerminationRequired?.(a.connection.worker, 'cancelled');
      await a.connection.request('turn/interrupt', { threadId: a.threadId, turnId: a.turnId });
      return a.completion;
    };
    a.cancelPromise = Promise.resolve().then(cancel); return a.cancelPromise;
  }
  async close(): Promise<void> { this.#closed = true; const a = this.#active; if (a) await this.cancel(a.intent, a.lifecycle); await this.#tail; }
  /** No inference/retry: reads only the exact recorded owned thread and turn. */
  async inspect(intent: RunIntent, context: ProviderCurrentContext) {
    await this.validate(intent, context, true); const b = await this.binding(intent, context);
    const connection = await this.transport.connect(this.configuration.workspacePath);
    let unexpected = false;
    const stop = connection.subscribe((method, p) => { if (method === 'turn/started' || method === 'turn/completed' || method === 'thread/status/changed' && appServerRecord(p.status).type === 'active' || this.configuration.mcpExclusion && method === 'mcpServer/startupStatus/updated') unexpected = true; });
    try {
      await this.mcpTransportBinding(connection);
      if (unexpected) throw new Error('native_inspection_unrequested_activity');
      const thread = this.thread(await connection.request('thread/read', { threadId: b.threadId, includeTurns: false }), b.threadId);
      const goal = appServerRecord((await connection.request('thread/goal/get', { threadId: b.threadId })).goal), status = appServerRecord(thread.status).type;
      if (goal.threadId !== b.threadId || goal.objective !== b.objective || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(String(goal.status)) || !['idle', 'notLoaded', 'active', 'systemError'].includes(String(status))) throw new Error('native_goal_scope_or_status_mismatch');
      await connection.close();
      if (unexpected) throw new Error('native_inspection_unrequested_activity');
      return { threadId: b.threadId, status, goalStatus: goal.status, unresolved: this.records(intent.runId).some(e => e.kind === 'turn_intended') && !this.records(intent.runId).some(e => e.kind === 'terminal') };
    } finally { stop(); await connection.close(); }
  }
  async observe(input: Parameters<WorkflowTrustedReadinessPort['observe']>[0]): ReturnType<WorkflowTrustedReadinessPort['observe']> {
    const fail = (reason: string) => ({ authorityRevision: `native:${this.profileDigest}`, observedAt: new Date().toISOString(), transport: { ready: false, blockers: [reason] }, nativeGoal: { ready: false, blockers: [reason] }, supervision: { ready: false, blockers: [reason] }, witness: { ready: false, blockers: [reason] } });
    if (this.#closed || !this.configuration.witness || !this.configuration.boundedTurnApproved || !this.configuration.mcpExclusion) return fail('native_supervision_runtime_witness_missing');
    try {
      await readNativeMcpExclusionManifest(this.configuration.mcpExclusion);
      const w = this.configuration.witness, v = await this.readWitness(input.sourceRevision);
      if (input.candidates.length < 1 || this.#active || this.records().some(e => e.kind === 'turn_intended' && !this.records(e.runId).some(t => t.kind === 'terminal'))) throw new Error('native_supervision_uncertain_or_busy');
      const qualified = this.coordinator.snapshot(String(v.qualificationRunId)), qualifier = this.records(String(v.qualificationRunId)).find(e => e.kind === 'prepared'), terminal = this.records(String(v.qualificationRunId)).find(e => e.kind === 'terminal');
      if (!qualified || !qualifier || !terminal || terminal.data.outcome !== 'completed') throw new Error('native_attended_qualification_not_retained');
      const retained = JSON.parse((await bytes(String(qualifier.data.artifactPath), 500000)).toString('utf8'));
      const live = await this.inspect(qualified.intent, retained.context as ProviderCurrentContext);
      if (live.unresolved || live.goalStatus !== 'paused' || !['idle', 'notLoaded'].includes(String(live.status))) throw new Error('native_qualification_thread_not_paused_idle');
      for (const candidate of input.candidates) {
        const entry = this.#workItems.get(candidate.runtime.workItemId);
        if (!entry || entry.intent.runId !== candidate.runtime.runId || entry.intent.workItem.revision !== candidate.revision) throw new Error('native_candidate_authority_changed');
        this.validateConfigurationBinding(entry.intent, entry.context);
        const s = this.coordinator.snapshot(entry.intent.runId); if (s && (s.authorityRevoked || canonical(s.intent) !== canonical(entry.intent))) throw new Error('native_candidate_admitted_binding_changed');
      }
      // Ready means the witnessed guarded native-goal capability is available,
      // NOT that a paused task has an active goal. Execute verifies activation at
      // the authorized handoff; unknown vendor lifecycle behavior cannot qualify.
      const ready = { ready: true, blockers: [] };
      await this.readWitness(input.sourceRevision);
      this.#observedReadiness = { sourceRevision: input.sourceRevision, at: Date.now() };
      return { authorityRevision: `native:${this.profileDigest}:${w.sha256}`, observedAt: new Date().toISOString(), transport: ready, nativeGoal: ready, supervision: ready, witness: ready };
    } catch { return fail('native_supervision_witness_or_live_binding_unavailable'); }
  }
}
