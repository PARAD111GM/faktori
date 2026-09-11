import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AppendOnlyActionJournal, FileActionGrantVault, type AuthorizedAction, type CurrentActionAuthority, type CurrentActionAuthorityStore } from '../actions/index.ts';
import { createDeliveryTransitionController, type DeliveryActionBinding, type DeliveryCompositionResult } from '../integrations/delivery-composer.ts';
import { observeDeliveryForSynchronization } from '../integrations/delivery-observation.ts';
import { parseDeliveryConnections, type DeliveryConnections, type DeliveryInspectDependencies } from '../integrations/delivery-inspect.ts';
import { spawnGh } from '../integrations/github.ts';
import { FetchJiraHttpClient } from '../integrations/jira.ts';
import type { DeliverySyncPolicy, RegisteredDelivery } from '../integrations/delivery-sync.ts';
import type { ActionRequest, ActionScope } from '../runtime/contracts.ts';
import { isTerminalRunState } from '../runtime/contracts.ts';
import type { DurableCoordinator } from '../runtime/coordinator.ts';

const MAX_PACKET_BYTES = 1024 * 1024;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}
function exact(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label}_unsupported_field`);
}
function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}_invalid`);
  return value;
}
function iso(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label}_invalid`);
  return result;
}
function sameScope(left: ActionScope, right: ActionScope): boolean {
  return left.kind === right.kind && left.repository === right.repository && left.branch === right.branch && left.baseRevision === right.baseRevision
    && left.expectedRevision === right.expectedRevision && left.allowedOperation === right.allowedOperation && left.scopeRevision === right.scopeRevision;
}

export interface DeliverySynchronizationConfiguration {
  packetPath: string;
  grantVaultPath: string;
  pollIntervalMs?: number;
}

/** Strict config boundary. The packet and vault must remain private controller files outside product worktrees. */
export function parseDeliverySynchronizationConfiguration(value: unknown): DeliverySynchronizationConfiguration {
  const input = record(value);
  if (input === undefined) throw new Error('delivery_synchronization_configuration_invalid');
  exact(input, ['packetPath', 'grantVaultPath', 'pollIntervalMs'], 'delivery_synchronization_configuration');
  const packetPath = text(input.packetPath, 'delivery_packet_path', 4096);
  const grantVaultPath = text(input.grantVaultPath, 'delivery_grant_vault_path', 4096);
  if (!isAbsolute(packetPath) || resolve(packetPath) !== packetPath || !isAbsolute(grantVaultPath) || resolve(grantVaultPath) !== grantVaultPath) throw new Error('delivery_synchronization_paths_must_be_absolute');
  const pollIntervalMs: number | undefined = input.pollIntervalMs === undefined ? undefined : typeof input.pollIntervalMs === 'number' ? input.pollIntervalMs : undefined;
  if (input.pollIntervalMs !== undefined && pollIntervalMs === undefined) throw new Error('delivery_synchronization_poll_interval_invalid');
  if (pollIntervalMs !== undefined && (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < MIN_POLL_INTERVAL_MS || pollIntervalMs > MAX_BACKOFF_MS)) throw new Error('delivery_synchronization_poll_interval_invalid');
  return { packetPath, grantVaultPath, ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }) };
}

interface PacketBinding {
  ticketKey: string;
  repository: string;
  runId: string;
  scope: ActionScope;
  authorityEpoch: number;
  requestedAt: string;
  request: ActionRequest;
}
interface DeliverySynchronizationPacket {
  validUntil: string;
  connections: DeliveryConnections;
  registrations: readonly RegisteredDelivery[];
  policy: DeliverySyncPolicy;
  bindings: readonly PacketBinding[];
}

function scope(value: unknown): ActionScope {
  const input = record(value);
  if (input === undefined) throw new Error('delivery_scope_invalid');
  exact(input, ['kind', 'repository', 'branch', 'baseRevision', 'expectedRevision', 'allowedOperation', 'scopeRevision'], 'delivery_scope');
  const result: ActionScope = {
    kind: text(input.kind, 'delivery_scope_kind', 64), repository: text(input.repository, 'delivery_scope_repository', 256),
    branch: text(input.branch, 'delivery_scope_branch', 256), baseRevision: text(input.baseRevision, 'delivery_scope_base', 256),
    expectedRevision: text(input.expectedRevision, 'delivery_scope_expected', 256), allowedOperation: text(input.allowedOperation, 'delivery_scope_operation', 128),
    scopeRevision: text(input.scopeRevision, 'delivery_scope_revision', 256),
  };
  return result;
}
function request(value: unknown): ActionRequest {
  const input = record(value);
  if (input === undefined) throw new Error('delivery_signed_request_invalid');
  exact(input, ['format', 'actionId', 'idempotencyKey', 'runId', 'scope', 'authorityEpoch', 'requestedAt', 'requestDigest', 'proof'], 'delivery_signed_request');
  if (input.format !== 'faktori.action-request/v1' || !Number.isSafeInteger(input.authorityEpoch) || (input.authorityEpoch as number) < 0) throw new Error('delivery_signed_request_invalid');
  const proof = record(input.proof);
  if (proof === undefined) throw new Error('delivery_signed_request_invalid');
  exact(proof, ['grantId', 'nonce', 'authenticationTag'], 'delivery_signed_request_proof');
  const callerProof = { grantId: text(proof.grantId, 'delivery_grant_id'), nonce: text(proof.nonce, 'delivery_nonce'), authenticationTag: text(proof.authenticationTag, 'delivery_authentication_tag') };
  return { format: 'faktori.action-request/v1', actionId: text(input.actionId, 'delivery_action_id'), idempotencyKey: text(input.idempotencyKey, 'delivery_idempotency_key'), runId: text(input.runId, 'delivery_request_run'), scope: scope(input.scope), authorityEpoch: input.authorityEpoch as number, requestedAt: iso(input.requestedAt, 'delivery_request_time'), requestDigest: text(input.requestDigest, 'delivery_request_digest'), proof: callerProof };
}
function policy(value: unknown): DeliverySyncPolicy {
  const input = record(value);
  if (input === undefined) throw new Error('delivery_policy_invalid');
  exact(input, ['eligibleCodingStatuses', 'protectedStatuses', 'readyForDeploymentStatus', 'deployedStatus', 'acceptedStatus', 'requiredCheckSources', 'maxConcurrentCoding'], 'delivery_policy');
  const strings = (candidate: unknown, label: string): readonly string[] => {
    if (!Array.isArray(candidate) || candidate.length > 100 || candidate.some(item => typeof item !== 'string' || item.trim().length === 0 || item.length > 128)) throw new Error(`${label}_invalid`);
    return candidate.map(item => item as string);
  };
  if (!Number.isSafeInteger(input.maxConcurrentCoding) || (input.maxConcurrentCoding as number) < 0 || (input.maxConcurrentCoding as number) > 100) throw new Error('delivery_policy_capacity_invalid');
  const optional = (candidate: unknown, label: string): string | undefined => candidate === undefined ? undefined : text(candidate, label, 128);
  return { eligibleCodingStatuses: strings(input.eligibleCodingStatuses, 'delivery_policy_eligible'), protectedStatuses: strings(input.protectedStatuses, 'delivery_policy_protected'), requiredCheckSources: input.requiredCheckSources === undefined ? undefined : strings(input.requiredCheckSources, 'delivery_policy_checks'), readyForDeploymentStatus: optional(input.readyForDeploymentStatus, 'delivery_policy_ready'), deployedStatus: optional(input.deployedStatus, 'delivery_policy_deployed'), acceptedStatus: optional(input.acceptedStatus, 'delivery_policy_accepted'), maxConcurrentCoding: input.maxConcurrentCoding as number };
}
function packet(value: unknown): DeliverySynchronizationPacket {
  const input = record(value);
  if (input === undefined || input.format !== 'faktori.delivery-synchronization/v1') throw new Error('delivery_packet_format_invalid');
  exact(input, ['format', 'validUntil', 'connections', 'registrations', 'policy', 'bindings'], 'delivery_packet');
  if (!Array.isArray(input.registrations) || input.registrations.length > 100 || !Array.isArray(input.bindings) || input.bindings.length > 100) throw new Error('delivery_packet_collection_invalid');
  const bindings = input.bindings.map((raw, index): PacketBinding => {
    const item = record(raw);
    if (item === undefined) throw new Error(`delivery_binding_${index}_invalid`);
    exact(item, ['ticketKey', 'repository', 'runId', 'scope', 'authorityEpoch', 'requestedAt', 'request'], 'delivery_binding');
    if (!Number.isSafeInteger(item.authorityEpoch) || (item.authorityEpoch as number) < 0) throw new Error('delivery_binding_epoch_invalid');
    const parsed = request(item.request);
    const result = { ticketKey: text(item.ticketKey, 'delivery_binding_ticket', 64), repository: text(item.repository, 'delivery_binding_repository', 256), runId: text(item.runId, 'delivery_binding_run'), scope: scope(item.scope), authorityEpoch: item.authorityEpoch as number, requestedAt: iso(item.requestedAt, 'delivery_binding_time'), request: parsed };
    if (parsed.runId !== result.runId || parsed.authorityEpoch !== result.authorityEpoch || parsed.requestedAt !== result.requestedAt || !sameScope(parsed.scope, result.scope)) throw new Error('delivery_binding_request_mismatch');
    return result;
  });
  if (new Set(bindings.map(item => item.ticketKey)).size !== bindings.length || new Set(bindings.map(item => item.runId)).size !== bindings.length) throw new Error('delivery_binding_identity_ambiguous');
  return { validUntil: iso(input.validUntil, 'delivery_packet_valid_until'), connections: parseDeliveryConnections(input.connections), registrations: structuredClone(input.registrations) as RegisteredDelivery[], policy: policy(input.policy), bindings };
}

async function readPrivatePacket(path: string): Promise<{ bytes: Buffer; digest: string }> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_PACKET_BYTES || (before.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && before.uid !== process.getuid())) throw new Error('delivery_packet_private_file_invalid');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size > MAX_PACKET_BYTES || (current.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && current.uid !== process.getuid())) throw new Error('delivery_packet_private_file_changed');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_PACKET_BYTES) throw new Error('delivery_packet_too_large');
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

async function canonicalStoragePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalStoragePath(dirname(path)), basename(path));
  }
}
async function assertOutsideWorkspaces(path: string, workspaces: readonly string[]): Promise<void> {
  const canonical = await canonicalStoragePath(path);
  for (const workspace of workspaces) {
    const root = await canonicalStoragePath(resolve(workspace));
    const inside = relative(root, canonical);
    if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) throw new Error('delivery_storage_inside_workspace');
  }
  for (let ancestor = canonical; ; ancestor = dirname(ancestor)) {
    try { await lstat(join(ancestor, '.git')); throw new Error('delivery_storage_inside_repository'); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    if (dirname(ancestor) === ancestor) break;
  }
}

export interface DeliverySynchronizationDependencies extends DeliveryInspectDependencies {
  clock?: { now(): Date };
}
export interface DeliverySynchronizationSnapshot {
  status: 'monitoring' | 'blocked' | 'stopped';
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  reason?: string;
  unavailable: readonly { ticketKey: string; reason: string }[];
  executions: readonly { ticketKey: string; outcome: string; detail?: string }[];
}

function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('expired')) return 'packet_expired';
  if (message.includes('changed')) return 'packet_changed';
  if (message.includes('private')) return 'packet_private_file_invalid';
  if (message.includes('storage_inside')) return 'controller_storage_inside_workspace';
  if (message.includes('authority')) return 'authority_not_current';
  return 'packet_or_observation_unavailable';
}

/** Opt-in controller loop. It owns no credentials or grants; it composes only a retained signed request. */
export class DeliverySynchronizationRuntime {
  readonly #configuration: DeliverySynchronizationConfiguration;
  readonly #coordinator: DurableCoordinator;
  readonly #dependencies: DeliverySynchronizationDependencies;
  readonly #journal: AppendOnlyActionJournal;
  readonly #vault: FileActionGrantVault;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;
  #closed = false;
  #failures = 0;
  #state: DeliverySynchronizationSnapshot = { status: 'blocked', reason: 'evaluation_pending', unavailable: [], executions: [] };

  constructor(options: { configuration: DeliverySynchronizationConfiguration; coordinator: DurableCoordinator; dependencies?: DeliverySynchronizationDependencies }) {
    this.#configuration = parseDeliverySynchronizationConfiguration(options.configuration);
    this.#coordinator = options.coordinator;
    this.#dependencies = options.dependencies ?? {};
    this.#journal = new AppendOnlyActionJournal(options.coordinator.journal);
    this.#vault = new FileActionGrantVault(this.#configuration.grantVaultPath);
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('delivery_synchronization_closed');
    await this.tick();
    this.schedule();
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await this.#inFlight;
    this.#state = { ...this.#state, status: 'stopped' };
  }
  snapshot(): DeliverySynchronizationSnapshot { return structuredClone(this.#state); }
  async tick(): Promise<void> {
    if (this.#closed || this.#inFlight !== undefined) return this.#inFlight;
    this.#inFlight = this.run().finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }
  private schedule(): void {
    if (this.#closed) return;
    const base = this.#configuration.pollIntervalMs ?? MIN_POLL_INTERVAL_MS;
    const delay = Math.min(MAX_BACKOFF_MS, base * (2 ** Math.min(this.#failures, 8)));
    this.#timer = setTimeout(() => { void this.tick().finally(() => this.schedule()); }, delay);
  }
  private async run(): Promise<void> {
    const attempted = this.now();
    try {
      const loaded = await this.loadCurrent();
      // Only this invocation's freshly admitted intent may remain unresolved
      // during its final effect guard. A prior/crashed action is never exempt.
      let activeAction: AuthorizedAction | undefined;
      const authority: CurrentActionAuthorityStore = { current: async runId => this.currentAuthority(runId, loaded.digest, loaded.value, activeAction) };
      const boundedFetcher: typeof fetch = async (input, init) => (this.#dependencies.fetcher ?? fetch)(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      const boundedGh: DeliveryInspectDependencies['gh'] = async (argv, input, options) => (this.#dependencies.gh ?? spawnGh)(argv, input, { ...options, timeoutMs: 10_000 });
      const observe = async () => {
        await this.assertCurrent(loaded.digest);
        const observed = await observeDeliveryForSynchronization(loaded.value.connections, loaded.value.registrations, { ...this.#dependencies, fetcher: boundedFetcher, gh: boundedGh });
        await this.assertCurrent(loaded.digest);
        return observed;
      };
      const bindings: DeliveryActionBinding[] = loaded.value.bindings.map(binding => ({ ...binding, scope: structuredClone(binding.scope), signer: { sign: async unsigned => this.matchRequest(binding, unsigned, loaded.digest) } }));
      const client = new FetchJiraHttpClient(loaded.value.connections.jira.baseUrl, boundedFetcher);
      const controller = createDeliveryTransitionController({ observe, policy: loaded.value.policy, bindings, actions: { journal: this.#journal, authority, grantVault: this.#vault, hooks: { afterIntentPersisted: async action => { activeAction = action; } } }, jira: { client, authorizationHeader: async () => {
        await this.assertCurrent(loaded.digest);
        const authorization = (this.#dependencies.environment ?? process.env)[loaded.value.connections.jira.authorizationEnv];
        if (authorization === undefined || authorization.trim().length === 0) throw new Error('delivery_authorization_unavailable');
        return authorization;
      } } });
      const result = await controller.synchronize();
      this.#state = this.resultState(result, attempted);
      this.#failures = 0;
    } catch (error) {
      this.#failures += 1;
      this.#state = { status: 'blocked', lastAttemptAt: attempted, reason: safeReason(error), unavailable: [], executions: [] };
    }
  }
  private resultState(result: DeliveryCompositionResult, attempted: string): DeliverySynchronizationSnapshot {
    const instruction = new Map(result.finalPlan.instructions.map(item => [item.id, item]));
    const unavailable = result.unavailable.map(item => ({ ticketKey: item.ticketKey, reason: item.reason }));
    const executions = result.executions.map(item => ({ ticketKey: item.ticketKey ?? instruction.get(item.instructionId)?.ticketKey ?? 'unknown', outcome: item.receipt?.outcome ?? item.result, ...(item.reason === undefined ? {} : { detail: item.reason }) }));
    const failed = result.executions.find(item =>
      (item.result === 'skipped' && item.reason !== 'exact_duplicate') ||
      (item.receipt !== undefined && !['completed', 'duplicate'].includes(item.receipt.outcome)));
    const blocked = unavailable.length > 0 || failed !== undefined;
    return { status: blocked ? 'blocked' : 'monitoring', lastAttemptAt: attempted,
      ...(blocked ? (this.#state.lastSuccessAt ? { lastSuccessAt: this.#state.lastSuccessAt } : {}) : { lastSuccessAt: this.now() }),
      ...(blocked ? { reason: unavailable[0]?.reason ?? failed?.reason ?? failed?.receipt?.outcome ?? 'delivery_action_blocked' } : {}), unavailable, executions };
  }
  private async loadCurrent(): Promise<{ digest: string; value: DeliverySynchronizationPacket }> {
    const workspaces = this.#coordinator.snapshots().map(item => item.intent.execution.workspacePath);
    await assertOutsideWorkspaces(this.#configuration.packetPath, workspaces);
    await assertOutsideWorkspaces(this.#configuration.grantVaultPath, workspaces);
    const read = await readPrivatePacket(this.#configuration.packetPath);
    const parsed = packet(JSON.parse(read.bytes.toString('utf8')) as unknown);
    if (Date.parse(parsed.validUntil) <= (this.#dependencies.clock?.now().getTime() ?? Date.now())) throw new Error('delivery_packet_expired');
    return { digest: read.digest, value: parsed };
  }
  private now(): string { return (this.#dependencies.clock?.now() ?? new Date()).toISOString(); }
  private async assertCurrent(digest: string): Promise<void> {
    const loaded = await this.loadCurrent();
    if (loaded.digest !== digest) throw new Error('delivery_packet_changed');
  }
  private async currentAuthority(runId: string, digest: string, value: DeliverySynchronizationPacket, activeAction?: AuthorizedAction): Promise<CurrentActionAuthority | undefined> {
    try {
      await this.assertCurrent(digest);
      const binding = value.bindings.find(item => item.runId === runId);
      const snapshot = this.#coordinator.snapshot(runId);
      if (binding === undefined || snapshot === undefined || snapshot.authorityRevoked || snapshot.state === 'cancelling' || isTerminalRunState(snapshot.state) || snapshot.recovery.length > 0 || snapshot.intent.workItem.role === 'reviewer') return undefined;
      if (snapshot.unresolvedEffects.some(effect => activeAction === undefined ||
        activeAction.request.runId !== runId || effect.kind !== 'action.execute' ||
        effect.operationId !== activeAction.operationId || effect.requestDigest !== activeAction.request.requestDigest ||
        effect.identityKey !== activeAction.request.idempotencyKey)) return undefined;
      const target = snapshot.intent.target;
      if (target.repository !== binding.scope.repository || target.branch !== binding.scope.branch || target.baseRevision !== binding.scope.baseRevision || target.expectedRevision !== binding.scope.expectedRevision || snapshot.intent.authority.authorityRevision !== binding.scope.scopeRevision || snapshot.intent.authority.epoch !== binding.authorityEpoch || snapshot.authorityEpoch !== binding.authorityEpoch) return undefined;
      return { runId, scope: structuredClone(binding.scope), authorityEpoch: binding.authorityEpoch, revoked: false, actionAllowed: true };
    } catch { return undefined; }
  }
  private async matchRequest(binding: PacketBinding, unsigned: Omit<ActionRequest, 'proof' | 'requestDigest'>, digest: string): Promise<unknown> {
    await this.assertCurrent(digest);
    const signed = binding.request;
    return signed.format === unsigned.format && signed.actionId === unsigned.actionId && signed.idempotencyKey === unsigned.idempotencyKey && signed.runId === unsigned.runId && signed.authorityEpoch === unsigned.authorityEpoch && signed.requestedAt === unsigned.requestedAt && sameScope(signed.scope, unsigned.scope) ? structuredClone(signed) : undefined;
  }
}
