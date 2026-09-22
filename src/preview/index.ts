import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { BoundedCommandRunner, type CommandResult } from '../execution/transports.ts';
import type { NativeIdentityObservation, NativeProcessGroupObservation, NativeProcessObservation } from '../execution/index.ts';

/**
 * Persistent previews are intentionally not candidate verification runs.
 * They keep one owner-registered local process alive for human review, while
 * disposable verification owns a copied candidate and always tears it down.
 */
export const PERSISTENT_PREVIEW_FORMAT = 'faktori.persistent-preview/v1' as const;

export interface PreviewJournal {
  events(): readonly PreviewRecord[];
  append(record: PreviewRecord): Promise<void>;
}

export type PreviewRecord = {
  format: typeof PERSISTENT_PREVIEW_FORMAT;
  kind: 'preview.registered' | 'preview.start.requested' | 'preview.started' | 'preview.identity.verified'
    | 'preview.identity.invalidated' | 'preview.stop.requested' | 'preview.stopped'
    | 'preview.observation.uncertain' | 'preview.process.exited' | 'preview.feedback.requested'
    | 'preview.feedback.applied' | 'preview.feedback.confirmed' | 'preview.final-review.ready';
  previewId: string;
  occurredAt: string;
  candidateRevision: string;
  detail?: string;
  data?: Record<string, string | number | boolean>;
};

export interface PreviewCommand {
  command: string;
  args: readonly string[];
}

export interface PreviewBrowserContext {
  /** A caller-owned opaque browser context identifier; it is not browser evidence. */
  contextId: string;
  role: 'agent' | 'human';
}

export interface PreviewBrowserContexts {
  agent: PreviewBrowserContext;
  human: PreviewBrowserContext;
}

export interface PreviewRegistration {
  id: string;
  featureId: string;
  implementerId: string;
  ownerApprovedBy: string;
  /** Exact real worktree to run; this is never a candidate copy. */
  worktree: string;
  /** Revision that the running app must report through the identity probe. */
  candidateRevision: string;
  /** Loopback URL expected from the running application identity endpoint. */
  url: string;
  startup: PreviewCommand;
  /** Owner-approved command which queries the running application. */
  identity: PreviewCommand;
  /** Exact child environment. The parent environment is never inherited. */
  environment: Readonly<Record<string, string>>;
  browserContexts: PreviewBrowserContexts;
  limits?: { identityTimeoutMs?: number; shutdownTimeoutMs?: number; outputMaxBytes?: number };
}

export interface PreviewRuntimeIdentity {
  format: 'faktori.persistent-preview-identity/v1';
  previewId: string;
  candidateRevision: string;
  nonce: string;
  endpoint: string;
}

export interface PreviewProcessIdentity {
  pid: number;
  processStartedAt: string;
  processGroupId: number;
  nonce: string;
}

export type PreviewState = 'stopped' | 'starting' | 'running' | 'stopping' | 'uncertain' | 'invalidated' | 'failed';
export type FinalReviewGate = 'blocked' | 'ready';

export interface PreviewFeedbackItem {
  id: string;
  featureId: string;
  implementerId: string;
  summary: string;
  requestedRevision: string;
  requestedAt: string;
  appliedRevision?: string;
  appliedAt?: string;
  confirmedRevision?: string;
  confirmedAt?: string;
}

export type PreviewFeedbackOperation = {
  kind: 'requested';
  itemId: string;
  featureId: string;
  implementerId: string;
  summary: string;
  revision: string;
} | {
  kind: 'applied' | 'confirmed';
  itemId: string;
  featureId: string;
  implementerId: string;
  revision: string;
};

export interface PreviewSnapshot {
  id: string;
  featureId: string;
  implementerId: string;
  state: PreviewState;
  candidateRevision: string;
  runtimeRevision?: string;
  url: string;
  process?: PreviewProcessIdentity;
  evidence: 'not_observed' | 'current' | 'invalidated';
  browserContexts: PreviewBrowserContexts;
  /** This core neither drives a browser nor fabricates browser evidence. */
  browserEvidence: 'not_recorded';
  feedback: PreviewFeedbackItem[];
  finalReview: FinalReviewGate;
  automaticPush: false;
  detail?: string;
}

export interface PreviewIdentityProbe {
  inspect(pid: number): Promise<NativeIdentityObservation | undefined>;
  inspectProcessGroup?(processGroupId: number): Promise<NativeProcessGroupObservation | undefined>;
}

export interface PersistentPreviewServiceOptions {
  journal: PreviewJournal;
  commands?: BoundedCommandRunner;
  identityProbeFor?(worktree: string): PreviewIdentityProbe;
  now?(): Date;
  nonce?(): string;
}

type Entry = {
  registration: PreviewRegistration;
  worktree: string;
  state: PreviewState;
  evidence: PreviewSnapshot['evidence'];
  process?: PreviewProcessIdentity;
  /** A launch PID without a trusted process-start/group identity is never signalable. */
  unverifiedLaunch?: { pid: number; nonce: string };
  runtimeRevision?: string;
  detail?: string;
  feedback: Map<string, PreviewFeedbackItem>;
  started?: Promise<void>;
};

const text = (value: unknown, max = 4_000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const safeId = (value: unknown): value is string => text(value, 128) && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value);
const secretKey = /(?:token|secret|password|credential|authorization|cookie|private.?key|api.?key|npm_auth|deploy|publish|github|gitlab|jira|slack|aws|azure|google|cloudflare|vercel|netlify)/i;
const probeEnvironment = Object.freeze({ PATH: '/usr/bin:/bin' });
const commandSucceeded = (result: CommandResult): boolean => result.exitCode === 0 && result.signal === null && !result.timedOut && !result.outputLimitExceeded && result.spawnError === undefined;
const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

function command(value: PreviewCommand, field: string): PreviewCommand {
  if (!value || !text(value.command) || !isAbsolute(value.command) || !Array.isArray(value.args)
    || value.args.length > 100 || value.args.some(arg => !text(arg, 32_768))) throw new Error(`${field} must be an absolute executable with explicit argv`);
  return { command: value.command, args: [...value.args] };
}

function endpoint(value: string): string {
  if (!text(value)) throw new Error('preview url is required');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('persistent preview endpoint must be an unauthenticated loopback URL');
  return parsed.toString();
}

function exactEnvironment(value: Readonly<Record<string, string>>): Record<string, string> {
  if (!value || Object.entries(value).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    || secretKey.test(key) || typeof item !== 'string' || item.includes('\0') || item.length > 32_768)) {
    throw new Error('preview environment must be explicit and cannot contain publishing credentials or secrets');
  }
  return { ...value };
}

function browserContexts(value: PreviewBrowserContexts): PreviewBrowserContexts {
  if (!value || !safeId(value.agent?.contextId) || !safeId(value.human?.contextId)
    || value.agent.role !== 'agent' || value.human.role !== 'human' || value.agent.contextId === value.human.contextId) {
    throw new Error('preview requires distinct agent and human browser contexts');
  }
  return { agent: { ...value.agent }, human: { ...value.human } };
}

function limits(value: PreviewRegistration['limits']): Required<NonNullable<PreviewRegistration['limits']>> {
  const answer = { identityTimeoutMs: value?.identityTimeoutMs ?? 3_000, shutdownTimeoutMs: value?.shutdownTimeoutMs ?? 1_000, outputMaxBytes: value?.outputMaxBytes ?? 65_536 };
  if (!Number.isInteger(answer.identityTimeoutMs) || answer.identityTimeoutMs < 1 || answer.identityTimeoutMs > 60_000
    || !Number.isInteger(answer.shutdownTimeoutMs) || answer.shutdownTimeoutMs < 1 || answer.shutdownTimeoutMs > 30_000
    || !Number.isInteger(answer.outputMaxBytes) || answer.outputMaxBytes < 1 || answer.outputMaxBytes > 1_048_576) throw new Error('preview limits are invalid');
  return answer;
}

function sameProcess(expected: PreviewProcessIdentity, observed: NativeIdentityObservation | undefined): observed is NativeProcessObservation {
  return observed !== undefined && 'pid' in observed && observed.running && observed.pid === expected.pid
    && observed.processStartedAt === expected.processStartedAt && observed.processGroupId === expected.processGroupId;
}

function groupAbsent(observed: NativeProcessGroupObservation | undefined): boolean {
  return observed !== undefined && (('status' in observed && observed.status === 'absent')
    || ('members' in observed && observed.members.every(member => !member.running)));
}

function parseProcess(line: string): NativeProcessObservation | undefined {
  const match = line.trim().match(/^(\d+)\s+(.+?)\s+(\d+)\s+(\S+)$/);
  if (match === null || !Number.isInteger(Number(match[1])) || !Number.isInteger(Number(match[3]))) return undefined;
  return { pid: Number(match[1]), processStartedAt: match[2], processGroupId: Number(match[3]), running: !match[4].startsWith('Z') };
}

/** `ps` reports an absent PID with a nonzero status on some supported hosts. */
class SystemPreviewIdentityProbe implements PreviewIdentityProbe {
  readonly commands: BoundedCommandRunner;
  readonly cwd: string;
  constructor(commands: BoundedCommandRunner, cwd: string) { this.commands = commands; this.cwd = cwd; }
  async inspect(pid: number): Promise<NativeIdentityObservation> {
    const result = await this.commands.run({ command: '/bin/ps', args: ['-o', 'pid=,lstart=,pgid=,stat=', '-p', String(pid)], cwd: this.cwd, env: probeEnvironment, timeoutMs: 1_000, stdoutMaxBytes: 16_384, stderrMaxBytes: 16_384, detached: true });
    if (result.timedOut || result.outputLimitExceeded || result.spawnError !== undefined) return { status: 'unknown' };
    if (result.stdout.trim() === '') return { status: 'absent' };
    const parsed = parseProcess(result.stdout);
    return result.exitCode === 0 && parsed?.pid === pid ? parsed : { status: 'unknown' };
  }
  async inspectProcessGroup(processGroupId: number): Promise<NativeProcessGroupObservation> {
    const result = await this.commands.run({ command: '/bin/ps', args: ['-axo', 'pid=,lstart=,pgid=,stat='], cwd: this.cwd, env: probeEnvironment, timeoutMs: 1_000, stdoutMaxBytes: 1_048_576, stderrMaxBytes: 16_384, detached: true });
    if (!commandSucceeded(result)) return { status: 'unknown' };
    const all = result.stdout.split('\n').filter(Boolean).map(parseProcess);
    if (all.some(item => item === undefined)) return { status: 'unknown' };
    const members = (all as NativeProcessObservation[]).filter(item => item.processGroupId === processGroupId);
    return members.length === 0 ? { status: 'absent' } : { processGroupId, members };
  }
}

function parseIdentity(output: string, expected: { previewId: string; candidateRevision: string; nonce: string; url: string }): PreviewRuntimeIdentity {
  let value: unknown;
  try { value = JSON.parse(output.trim()); } catch { throw new Error('preview_identity_not_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('preview_identity_invalid');
  const identity = value as Record<string, unknown>;
  if (identity.format !== 'faktori.persistent-preview-identity/v1' || identity.previewId !== expected.previewId
    || identity.candidateRevision !== expected.candidateRevision || identity.nonce !== expected.nonce || !text(identity.endpoint)) throw new Error('preview_identity_mismatch');
  if (endpoint(identity.endpoint) !== endpoint(expected.url)) throw new Error('preview_identity_endpoint_mismatch');
  return identity as unknown as PreviewRuntimeIdentity;
}

export class PersistentPreviewService {
  readonly journal: PreviewJournal;
  readonly commands: BoundedCommandRunner;
  readonly #entries = new Map<string, Entry>();
  readonly #identityProbeFor: (worktree: string) => PreviewIdentityProbe;
  readonly #now: () => Date;
  readonly #nonce: () => string;

  constructor(options: PersistentPreviewServiceOptions) {
    this.journal = options.journal;
    this.commands = options.commands ?? new BoundedCommandRunner();
    this.#identityProbeFor = options.identityProbeFor ?? ((worktree) => new SystemPreviewIdentityProbe(this.commands, worktree));
    this.#now = options.now ?? (() => new Date());
    this.#nonce = options.nonce ?? randomUUID;
  }

  async register(input: PreviewRegistration): Promise<PreviewSnapshot> {
    if (!safeId(input.id) || !safeId(input.featureId) || !safeId(input.implementerId) || !text(input.ownerApprovedBy, 256)
      || !text(input.candidateRevision, 512) || !isAbsolute(input.worktree)) throw new Error('preview registration has invalid identity or worktree');
    const worktree = realpathSync(input.worktree);
    const registration: PreviewRegistration = {
      ...input,
      worktree,
      url: endpoint(input.url),
      startup: command(input.startup, 'preview startup'),
      identity: command(input.identity, 'preview identity probe'),
      environment: exactEnvironment(input.environment),
      browserContexts: browserContexts(input.browserContexts),
      limits: limits(input.limits),
    };
    const prior = this.#entries.get(registration.id);
    if (prior !== undefined && prior.state !== 'stopped' && prior.state !== 'failed') {
      if (prior.registration.candidateRevision !== registration.candidateRevision) {
        prior.registration = registration;
        prior.worktree = worktree;
        prior.evidence = 'invalidated';
        prior.state = 'invalidated';
        prior.detail = 'owner_registered_revision_changed; stop and observe the old process before restarting';
        await this.#event(prior, 'preview.identity.invalidated', prior.detail);
        return this.#snapshot(prior);
      }
      throw new Error('active preview registration cannot be replaced without an observed stop');
    }
    const entry: Entry = prior ?? { registration, worktree, state: 'stopped', evidence: 'not_observed', feedback: new Map() };
    entry.registration = registration;
    entry.worktree = worktree;
    entry.runtimeRevision = undefined;
    entry.evidence = 'not_observed';
    entry.detail = undefined;
    this.#entries.set(registration.id, entry);
    if (prior === undefined) this.#hydrate(entry);
    await this.#event(entry, 'preview.registered');
    return this.#snapshot(entry);
  }

  async start(id: string): Promise<PreviewSnapshot> {
    const entry = this.#entry(id);
    if (entry.state === 'starting') return this.#snapshot(entry);
    if (entry.state === 'running') return this.#refresh(entry);
    if (entry.state === 'stopping') throw new Error('preview stop is in progress; observe cleanup before restarting');
    if (entry.state === 'uncertain' || entry.state === 'invalidated') {
      const observed = await this.#observeForRestart(entry);
      if (!observed) return this.#snapshot(entry);
    }
    entry.state = 'starting'; entry.evidence = 'not_observed'; entry.detail = undefined;
    await this.#event(entry, 'preview.start.requested');
    const started = this.#launch(entry);
    entry.started = started;
    await started;
    return this.#snapshot(entry);
  }

  async stop(id: string): Promise<PreviewSnapshot> {
    const entry = this.#entry(id);
    if (entry.state === 'stopped' || entry.state === 'failed') return this.#snapshot(entry);
    if (entry.process === undefined) { entry.state = 'uncertain'; entry.detail = 'no recorded process identity; restart requires observation'; await this.#event(entry, 'preview.observation.uncertain', entry.detail); return this.#snapshot(entry); }
    const probe = this.#identityProbeFor(entry.worktree);
    const before = await probe.inspect(entry.process.pid);
    if (!sameProcess(entry.process, before)) {
      if (before !== undefined && 'status' in before && before.status === 'absent') { await this.#stopped(entry, 'process_absent_before_stop'); return this.#snapshot(entry); }
      entry.state = 'uncertain'; entry.detail = 'recorded preview process identity could not be verified; it was not signaled'; await this.#event(entry, 'preview.observation.uncertain', entry.detail); return this.#snapshot(entry);
    }
    entry.state = 'stopping'; await this.#event(entry, 'preview.stop.requested');
    try { this.commands.killProcessGroup(entry.process.processGroupId, 'SIGTERM'); } catch {
      entry.state = 'uncertain'; entry.detail = 'preview signal failed; process identity requires observation'; await this.#event(entry, 'preview.observation.uncertain', entry.detail); return this.#snapshot(entry);
    }
    let stopped = await this.#waitForExit(entry, probe);
    // A persistent preview has no automatic restart. A final SIGKILL is only
    // permitted when the same leader identity and its recorded group are still
    // observed; a reused PID or unknown group remains an uncertainty instead.
    if (!stopped && await this.#maySignalGroup(entry, probe)) {
      try { this.commands.killProcessGroup(entry.process.processGroupId, 'SIGKILL'); } catch { /* observation below decides */ }
      stopped = await this.#waitForExit(entry, probe);
    }
    if (stopped) await this.#stopped(entry, 'process_group_exit_confirmed');
    else { entry.state = 'uncertain'; entry.detail = 'preview process-group cleanup could not be confirmed'; await this.#event(entry, 'preview.observation.uncertain', entry.detail); }
    return this.#snapshot(entry);
  }

  async snapshot(id?: string): Promise<PreviewSnapshot | PreviewSnapshot[]> {
    if (id === undefined) return Promise.all([...this.#entries.values()].map(entry => this.#refresh(entry)));
    return this.#refresh(this.#entry(id));
  }

  async feedback(id: string, operation: PreviewFeedbackOperation): Promise<PreviewSnapshot> {
    const entry = this.#entry(id);
    if (!safeId(operation.itemId) || operation.featureId !== entry.registration.featureId || operation.implementerId !== entry.registration.implementerId
      || !text(operation.revision, 512) || ('summary' in operation && !text(operation.summary, 2_000))) throw new Error('preview feedback must stay within the registered feature, implementer, and bounded revision');
    const now = this.#now().toISOString();
    if (operation.kind === 'requested') {
      if (entry.feedback.has(operation.itemId)) throw new Error('feedback item already exists');
      const item: PreviewFeedbackItem = { id: operation.itemId, featureId: operation.featureId, implementerId: operation.implementerId, summary: operation.summary, requestedRevision: operation.revision, requestedAt: now };
      entry.feedback.set(item.id, item);
      await this.#event(entry, 'preview.feedback.requested', undefined, { itemId: item.id, revision: item.requestedRevision, summary: item.summary, featureId: item.featureId, implementerId: item.implementerId });
    } else {
      const item = entry.feedback.get(operation.itemId);
      if (item === undefined) throw new Error('feedback item was not requested');
      if (operation.kind === 'applied') {
        if (item.appliedRevision !== undefined) throw new Error('feedback item was already applied');
        item.appliedRevision = operation.revision; item.appliedAt = now;
        await this.#event(entry, 'preview.feedback.applied', undefined, { itemId: item.id, revision: operation.revision });
        if (operation.revision !== entry.registration.candidateRevision) {
          entry.state = 'invalidated'; entry.evidence = 'invalidated'; entry.detail = 'feedback applied a new revision; preview evidence must be refreshed before final review';
          await this.#event(entry, 'preview.identity.invalidated', entry.detail);
        }
      } else {
        if (item.appliedRevision === undefined || item.confirmedRevision !== undefined || item.appliedRevision !== operation.revision) throw new Error('feedback confirmation requires the same applied revision');
        item.confirmedRevision = operation.revision; item.confirmedAt = now;
        await this.#event(entry, 'preview.feedback.confirmed', undefined, { itemId: item.id, revision: operation.revision });
      }
    }
    if (this.#finalReviewReady(entry)) await this.#event(entry, 'preview.final-review.ready');
    return this.#snapshot(entry);
  }

  #entry(id: string): Entry { const entry = this.#entries.get(id); if (entry === undefined) throw new Error('unknown persistent preview'); return entry; }
  #environment(entry: Entry, nonce: string): Record<string, string> {
    return { ...entry.registration.environment, FAKTORI_PREVIEW_ID: entry.registration.id, FAKTORI_PREVIEW_REVISION: entry.registration.candidateRevision, FAKTORI_PREVIEW_NONCE: nonce };
  }
  async #event(entry: Entry, kind: PreviewRecord['kind'], detail?: string, data?: PreviewRecord['data']): Promise<void> {
    await this.journal.append({ format: PERSISTENT_PREVIEW_FORMAT, kind, previewId: entry.registration.id, occurredAt: this.#now().toISOString(), candidateRevision: entry.registration.candidateRevision, ...(detail ? { detail } : {}), ...(data ? { data } : {}) });
  }
  #snapshot(entry: Entry): PreviewSnapshot {
    return { id: entry.registration.id, featureId: entry.registration.featureId, implementerId: entry.registration.implementerId, state: entry.state, candidateRevision: entry.registration.candidateRevision, ...(entry.runtimeRevision ? { runtimeRevision: entry.runtimeRevision } : {}), url: entry.registration.url, ...(entry.process ? { process: { ...entry.process } } : {}), evidence: entry.evidence, browserContexts: browserContexts(entry.registration.browserContexts), browserEvidence: 'not_recorded', feedback: [...entry.feedback.values()].map(item => ({ ...item })), finalReview: this.#finalReviewReady(entry) ? 'ready' : 'blocked', automaticPush: false, ...(entry.detail ? { detail: entry.detail } : {}) };
  }
  #finalReviewReady(entry: Entry): boolean {
    return entry.evidence === 'current' && entry.state === 'running' && [...entry.feedback.values()].every(item => item.confirmedRevision !== undefined && item.confirmedRevision === item.appliedRevision && item.confirmedRevision === entry.registration.candidateRevision);
  }
  async #launch(entry: Entry): Promise<void> {
    const nonce = this.#nonce();
    const registered = entry.registration;
    const configuredLimits = limits(registered.limits);
    const launched = await this.commands.start({ command: registered.startup.command, args: registered.startup.args, cwd: entry.worktree, env: this.#environment(entry, nonce), timeoutMs: 24 * 60 * 60 * 1_000, stdoutMaxBytes: configuredLimits.outputMaxBytes, stderrMaxBytes: configuredLimits.outputMaxBytes, detached: true });
    if (launched.pid < 1) { entry.state = 'failed'; entry.detail = 'preview startup failed'; return; }
    entry.unverifiedLaunch = { pid: launched.pid, nonce };
    const probe = this.#identityProbeFor(entry.worktree);
    const observed = await probe.inspect(launched.pid);
    if (observed === undefined || !('pid' in observed) || !observed.running || observed.pid !== launched.pid) {
      entry.state = 'uncertain'; entry.evidence = 'not_observed'; entry.detail = 'preview launch pid could not be safely identified; restart and cleanup require reconciliation';
      await this.#event(entry, 'preview.observation.uncertain', entry.detail, { pid: launched.pid, nonce });
      return;
    }
    entry.process = { pid: observed.pid, processStartedAt: observed.processStartedAt, processGroupId: observed.processGroupId, nonce };
    entry.unverifiedLaunch = undefined;
    await this.#event(entry, 'preview.started', undefined, { pid: observed.pid, processGroupId: observed.processGroupId, processStartedAt: observed.processStartedAt, nonce });
    void launched.completion.then(() => this.#observedExit(entry, nonce)).catch(() => undefined);
    const verified = await this.#identity(entry);
    if (!verified) return;
    entry.state = 'running'; entry.evidence = 'current'; entry.runtimeRevision = registered.candidateRevision; entry.detail = undefined;
    await this.#event(entry, 'preview.identity.verified', undefined, { pid: observed.pid });
    if (this.#finalReviewReady(entry)) await this.#event(entry, 'preview.final-review.ready');
  }
  async #identity(entry: Entry): Promise<boolean> {
    if (entry.process === undefined) return false;
    const configuredLimits = limits(entry.registration.limits);
    let failure: unknown = new Error('preview_identity_command_failed');
    // A spawned server is observable before its loopback listener is accepting.
    // Retry only a transient probe-command failure, inside the owner-set bound;
    // an identity mismatch is terminal and is never papered over by a retry.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.commands.run({ command: entry.registration.identity.command, args: entry.registration.identity.args, cwd: entry.worktree, env: this.#environment(entry, entry.process.nonce), timeoutMs: configuredLimits.identityTimeoutMs, stdoutMaxBytes: configuredLimits.outputMaxBytes, stderrMaxBytes: configuredLimits.outputMaxBytes, detached: true });
      try {
        if (!commandSucceeded(result)) throw new Error('preview_identity_command_failed');
        parseIdentity(result.stdout, { previewId: entry.registration.id, candidateRevision: entry.registration.candidateRevision, nonce: entry.process.nonce, url: entry.registration.url });
        return true;
      } catch (error) {
        failure = error;
        if (!(error instanceof Error) || error.message !== 'preview_identity_command_failed' || attempt === 2) break;
        await delay(50 * (attempt + 1));
      }
    }
    entry.state = 'invalidated'; entry.evidence = 'invalidated'; entry.detail = failure instanceof Error ? failure.message : 'preview identity failed';
    await this.#event(entry, 'preview.identity.invalidated', entry.detail);
    return false;
  }
  async #refresh(entry: Entry): Promise<PreviewSnapshot> {
    if (entry.process === undefined || (entry.state !== 'running' && entry.state !== 'invalidated')) return this.#snapshot(entry);
    const observed = await this.#identityProbeFor(entry.worktree).inspect(entry.process.pid);
    if (observed !== undefined && 'status' in observed && observed.status === 'absent') { await this.#stopped(entry, 'process_absent_observed'); return this.#snapshot(entry); }
    if (!sameProcess(entry.process, observed)) { entry.state = 'uncertain'; entry.evidence = 'invalidated'; entry.detail = 'preview process identity is no longer safely observable'; await this.#event(entry, 'preview.observation.uncertain', entry.detail); return this.#snapshot(entry); }
    if (entry.state === 'running') await this.#identity(entry);
    return this.#snapshot(entry);
  }
  async #observeForRestart(entry: Entry): Promise<boolean> {
    const probe = this.#identityProbeFor(entry.worktree);
    if (entry.process === undefined && entry.unverifiedLaunch !== undefined) {
      const launched = entry.unverifiedLaunch;
      const observed = await probe.inspect(launched.pid);
      if (observed !== undefined && 'status' in observed && observed.status === 'absent') {
        entry.unverifiedLaunch = undefined;
        await this.#stopped(entry, 'unverified_launch_absent_before_restart');
        return true;
      }
      if (observed !== undefined && 'pid' in observed && observed.running && observed.pid === launched.pid) {
        entry.process = { pid: observed.pid, processStartedAt: observed.processStartedAt, processGroupId: observed.processGroupId, nonce: launched.nonce };
        const recovered = entry.process;
        entry.unverifiedLaunch = undefined;
        if (await this.#identity(entry)) {
          entry.state = 'running'; entry.evidence = 'current'; entry.runtimeRevision = entry.registration.candidateRevision; entry.detail = 'unverified launch reconciled through runtime identity';
          await this.#event(entry, 'preview.identity.verified', entry.detail, { pid: recovered.pid });
          return false;
        }
        entry.process = undefined;
        entry.unverifiedLaunch = launched;
      }
      entry.state = 'uncertain'; entry.evidence = 'not_observed'; entry.detail = 'unverified launch pid remains present or unknown; it was not restarted or signaled';
      await this.#event(entry, 'preview.observation.uncertain', entry.detail, { pid: launched.pid, nonce: launched.nonce });
      return false;
    }
    if (entry.process === undefined) { entry.state = 'stopped'; entry.evidence = 'not_observed'; return true; }
    const observed = await probe.inspect(entry.process.pid);
    if (observed !== undefined && 'status' in observed && observed.status === 'absent') { await this.#stopped(entry, 'absence_observed_before_restart'); return true; }
    if (sameProcess(entry.process, observed)) {
      const group = await probe.inspectProcessGroup?.(entry.process.processGroupId);
      const hasRecordedLeader = group === undefined || ('members' in group && group.members.some(member => member.running && member.pid === entry.process?.pid && member.processStartedAt === entry.process.processStartedAt && member.processGroupId === entry.process.processGroupId));
      if (hasRecordedLeader && await this.#identity(entry)) {
        entry.state = 'running'; entry.evidence = 'current'; entry.runtimeRevision = entry.registration.candidateRevision; entry.detail = 'restored process identity observed';
        await this.#event(entry, 'preview.identity.verified', entry.detail, { pid: entry.process.pid });
        return false;
      }
    }
    entry.state = 'uncertain'; entry.detail = 'restart blocked until the recorded process identity is confirmed absent'; await this.#event(entry, 'preview.observation.uncertain', entry.detail); return false;
  }
  async #waitForExit(entry: Entry, probe: PreviewIdentityProbe): Promise<boolean> {
    if (entry.process === undefined) return false;
    const endsAt = Date.now() + limits(entry.registration.limits).shutdownTimeoutMs;
    while (Date.now() <= endsAt) {
      const leader = await probe.inspect(entry.process.pid);
      const group = await probe.inspectProcessGroup?.(entry.process.processGroupId);
      if ((leader !== undefined && 'status' in leader && leader.status === 'absent') && (group === undefined || groupAbsent(group))) return true;
      await delay(40);
    }
    return false;
  }
  async #maySignalGroup(entry: Entry, probe: PreviewIdentityProbe): Promise<boolean> {
    if (entry.process === undefined) return false;
    const leader = await probe.inspect(entry.process.pid);
    if (!sameProcess(entry.process, leader)) return false;
    const group = await probe.inspectProcessGroup?.(entry.process.processGroupId);
    if (group === undefined) return true;
    return 'members' in group && group.members.some(member => member.running && member.pid === entry.process?.pid
      && member.processStartedAt === entry.process.processStartedAt && member.processGroupId === entry.process.processGroupId);
  }
  async #stopped(entry: Entry, detail: string): Promise<void> { entry.state = 'stopped'; entry.evidence = 'not_observed'; entry.process = undefined; entry.unverifiedLaunch = undefined; entry.runtimeRevision = undefined; entry.detail = detail; await this.#event(entry, 'preview.stopped', detail); }
  async #observedExit(entry: Entry, nonce: string): Promise<void> {
    if (entry.process?.nonce !== nonce || entry.state === 'stopped') return;
    const observed = await this.#identityProbeFor(entry.worktree).inspect(entry.process.pid);
    if (observed !== undefined && 'status' in observed && observed.status === 'absent') await this.#stopped(entry, 'process_exit_observed');
  }
  #hydrate(entry: Entry): void {
    const history = this.journal.events().filter(record => record.previewId === entry.registration.id);
    let process: PreviewProcessIdentity | undefined;
    let unverifiedLaunch: Entry['unverifiedLaunch'];
    let state: PreviewState = 'stopped';
    let evidence: PreviewSnapshot['evidence'] = 'not_observed';
    for (const record of history) {
      if (record.kind === 'preview.started' && typeof record.data?.pid === 'number' && typeof record.data.processGroupId === 'number'
        && typeof record.data.processStartedAt === 'string' && typeof record.data.nonce === 'string') {
        process = { pid: record.data.pid, processGroupId: record.data.processGroupId, processStartedAt: record.data.processStartedAt, nonce: record.data.nonce };
        state = record.candidateRevision === entry.registration.candidateRevision ? 'uncertain' : 'invalidated';
        evidence = record.candidateRevision === entry.registration.candidateRevision ? 'not_observed' : 'invalidated';
      } else if (record.kind === 'preview.identity.verified' && process !== undefined) {
        state = record.candidateRevision === entry.registration.candidateRevision ? 'running' : 'invalidated';
        evidence = record.candidateRevision === entry.registration.candidateRevision ? 'current' : 'invalidated';
      } else if (record.kind === 'preview.identity.invalidated' && process !== undefined) {
        state = 'invalidated'; evidence = 'invalidated';
      } else if (record.kind === 'preview.observation.uncertain') {
        if (process === undefined && typeof record.data?.pid === 'number' && typeof record.data.nonce === 'string') unverifiedLaunch = { pid: record.data.pid, nonce: record.data.nonce };
        state = 'uncertain'; evidence = process === undefined ? 'not_observed' : 'invalidated';
      } else if (record.kind === 'preview.feedback.requested' && typeof record.data?.itemId === 'string' && typeof record.data.revision === 'string'
        && typeof record.data.summary === 'string' && typeof record.data.featureId === 'string' && typeof record.data.implementerId === 'string'
        && record.data.featureId === entry.registration.featureId && record.data.implementerId === entry.registration.implementerId) {
        entry.feedback.set(record.data.itemId, { id: record.data.itemId, featureId: record.data.featureId, implementerId: record.data.implementerId, summary: record.data.summary, requestedRevision: record.data.revision, requestedAt: record.occurredAt });
      } else if (record.kind === 'preview.feedback.applied' && typeof record.data?.itemId === 'string' && typeof record.data.revision === 'string') {
        const item = entry.feedback.get(record.data.itemId); if (item) { item.appliedRevision = record.data.revision; item.appliedAt = record.occurredAt; }
      } else if (record.kind === 'preview.feedback.confirmed' && typeof record.data?.itemId === 'string' && typeof record.data.revision === 'string') {
        const item = entry.feedback.get(record.data.itemId); if (item) { item.confirmedRevision = record.data.revision; item.confirmedAt = record.occurredAt; }
      } else if (record.kind === 'preview.stopped' || record.kind === 'preview.process.exited') {
        process = undefined; unverifiedLaunch = undefined; state = 'stopped'; evidence = 'not_observed';
      }
    }
    entry.process = process;
    entry.unverifiedLaunch = unverifiedLaunch;
    entry.state = process === undefined && state === 'invalidated' ? 'invalidated' : state;
    entry.evidence = evidence;
    if (state === 'running') entry.runtimeRevision = entry.registration.candidateRevision;
  }
}
