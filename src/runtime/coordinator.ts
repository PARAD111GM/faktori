import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  CoordinatorIdentity,
  DurableEffectIntent,
  DurableEffectReceipt,
  QueuedMessage,
  RunEvent,
  RunIntent,
  RunSnapshot,
  WorkerIdentity,
} from './contracts.ts';
import { isTerminalRunState } from './contracts.ts';
import { AppendOnlyJournal, type JournalClock } from './journal.ts';
import { SqliteProjection, snapshotsFromEvents } from './sqlite-projection.ts';

export type ProcessStatus = 'alive' | 'dead' | 'unknown' | 'mismatch';

export interface ProcessProbe {
  coordinator(identity: CoordinatorIdentity): Promise<ProcessStatus>;
  worker(identity: WorkerIdentity): Promise<ProcessStatus>;
}

export interface AdmissionLimits {
  maxConcurrentRuns: number;
  maxRetries: number;
  maxRuntimeMinutes: number;
  maxTokens: number;
  strictSpending: boolean;
  /** The selected route proves a hard token cap, not merely a displayed quota. */
  strictSpendingSupported: boolean;
}

export interface CoordinatorOptions {
  factoryId: string;
  journalPath: string;
  projectionPath?: string;
  identity: CoordinatorIdentity;
  limits: AdmissionLimits;
  clock?: JournalClock;
  processProbe?: ProcessProbe;
  randomId?: () => string;
  /** Test/host hook between stale-worker probe and exact lock revalidation. */
  beforeStaleLockDelete?: () => void | Promise<void>;
}

export interface AdmissionResult {
  accepted: boolean;
  reason?: string;
  snapshot?: RunSnapshot;
}

const unknownProbe: ProcessProbe = {
  coordinator: async () => 'unknown',
  worker: async () => 'unknown',
};

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}

function isValidLimits(limits: AdmissionLimits): boolean {
  return Number.isInteger(limits.maxConcurrentRuns) && limits.maxConcurrentRuns > 0
    && Number.isInteger(limits.maxRetries) && limits.maxRetries >= 0
    && Number.isInteger(limits.maxRuntimeMinutes) && limits.maxRuntimeMinutes > 0
    && Number.isInteger(limits.maxTokens) && limits.maxTokens >= 0;
}

/**
 * Coordinates one factory. The lock prevents two live coordinators, while the
 * journal records every admission/effect before any worker or action caller can
 * make an external change.
 */
export class DurableCoordinator {
  readonly journal: AppendOnlyJournal;
  readonly projection: SqliteProjection;
  readonly identity: CoordinatorIdentity;
  readonly factoryId: string;
  readonly limits: AdmissionLimits;
  readonly lockPath: string;
  #probe: ProcessProbe;
  #randomId: () => string;
  #beforeStaleLockDelete?: () => void | Promise<void>;
  #claimed = false;
  #admissionTail: Promise<unknown> = Promise.resolve();
  #messageTail: Promise<unknown> = Promise.resolve();

  private constructor(options: CoordinatorOptions, journal: AppendOnlyJournal, projection: SqliteProjection) {
    if (!isValidLimits(options.limits)) throw new Error('Coordinator limits must be bounded non-negative integers');
    this.factoryId = options.factoryId;
    this.journal = journal;
    this.projection = projection;
    this.identity = options.identity;
    this.limits = options.limits;
    this.lockPath = `${options.journalPath}.coordinator-lock`;
    this.#probe = options.processProbe ?? unknownProbe;
    this.#randomId = options.randomId ?? randomUUID;
    this.#beforeStaleLockDelete = options.beforeStaleLockDelete;
  }

  static async open(options: CoordinatorOptions): Promise<DurableCoordinator> {
    const journal = await AppendOnlyJournal.open(options.journalPath, { clock: options.clock });
    const projection = new SqliteProjection(options.projectionPath ?? ':memory:');
    projection.rebuild(journal.events());
    return new DurableCoordinator(options, journal, projection);
  }

  close(): void {
    this.projection.close();
  }

  snapshots(): RunSnapshot[] {
    return snapshotsFromEvents(this.journal.events());
  }

  snapshot(runId: string): RunSnapshot | undefined {
    return this.snapshots().find((snapshot) => snapshot.intent.runId === runId);
  }

  async claim(): Promise<void> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    try {
      const handle = await open(this.lockPath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(this.identity)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await this.readLock();
      if (current === undefined) throw new Error('Existing coordinator lock is unreadable; ownership is unknown and cannot be reclaimed');
      const status = await this.#probe.coordinator(current.identity);
      if (status !== 'dead') {
        throw new Error(`Factory coordinator is ${status}; heartbeat expiry is not authority to reclaim it`);
      }
      // A probe positively reported death. Re-read the full raw lock before
      // deletion: a newer coordinator lock is never ours to remove.
      await this.#beforeStaleLockDelete?.();
      const confirmed = await this.readLock();
      if (confirmed === undefined || confirmed.raw !== current.raw) {
        throw new Error('Coordinator lock changed after stale-owner probe; refusing to reclaim ownership');
      }
      await unlink(this.lockPath);
      return this.claim();
    }
    this.#claimed = true;
    await this.record('coordinator.claimed', 'factory', { factoryId: this.factoryId, identity: this.identity });
  }

  async heartbeat(): Promise<void> {
    this.assertClaimed();
    await this.record('coordinator.heartbeat', 'factory', { factoryId: this.factoryId, identity: this.identity });
  }

  async release(): Promise<void> {
    if (!this.#claimed) return;
    await this.record('coordinator.released', 'factory', { factoryId: this.factoryId, identity: this.identity });
    await unlink(this.lockPath);
    this.#claimed = false;
  }

  /** Serializes admission through this coordinator before durable reservation. */
  async admit(intent: RunIntent): Promise<AdmissionResult> {
    this.assertClaimed();
    const task = async (): Promise<AdmissionResult> => this.admitExclusive(intent);
    const next = this.#admissionTail.then(task, task);
    this.#admissionTail = next.catch(() => undefined);
    return next;
  }

  async queueMessage(message: QueuedMessage): Promise<void> {
    const task = async (): Promise<void> => this.queueMessageExclusive(message);
    const next = this.#messageTail.then(task, task);
    this.#messageTail = next.catch(() => undefined);
    return next;
  }

  private async queueMessageExclusive(message: QueuedMessage): Promise<void> {
    this.assertClaimed();
    const semantic = { messageId: message.messageId, runId: message.runId, delivery: message.delivery, body: message.body };
    const prior = this.journal.events().find((event) => event.kind === 'message.queued'
      && (event.data.message as Partial<QueuedMessage> | undefined)?.messageId === message.messageId);
    if (prior !== undefined) {
      const recorded = prior.data.message as Partial<QueuedMessage> | undefined;
      const recordedSemantic = recorded === undefined ? undefined : {
        messageId: recorded.messageId, runId: recorded.runId, delivery: recorded.delivery, body: recorded.body,
      };
      if (stable(recordedSemantic) !== stable(semantic)) throw new Error(`Message id ${message.messageId} conflicts with an existing durable message`);
      return;
    }
    const snapshot = this.snapshot(message.runId);
    if (snapshot === undefined) throw new Error(`Cannot queue a message for unknown run ${message.runId}`);
    if (isTerminalRunState(snapshot.state)) throw new Error(`Cannot queue a message for terminal run ${message.runId}`);
    await this.record('message.queued', message.runId, { message });
  }

  /** Persist an intent before the caller carries out a worker or action effect. */
  async recordEffectIntent(runId: string, effect: DurableEffectIntent): Promise<void> {
    this.assertClaimed();
    this.requireKnownNonterminal(runId);
    await this.record('effect.intended', runId, { effect });
  }

  /** Persist the observed receipt after a worker or action effect. */
  async recordEffectReceipt(runId: string, receipt: DurableEffectReceipt): Promise<void> {
    this.assertClaimed();
    this.requireKnown(runId);
    await this.record('effect.receipt', runId, { receipt });
  }

  async record(event: RunEvent['kind'], runId: string, data: Record<string, unknown>): Promise<void> {
    this.assertClaimed();
    const candidate = this.journal.event(runId, event, data);
    // Fail before committing a semantically conflicting run/effect identity.
    // The journal is authoritative, so appending first would permanently
    // poison recovery even if the disposable projection rejected the event.
    snapshotsFromEvents([...this.journal.events(), candidate]);
    const appended = await this.journal.append(candidate);
    this.projection.apply(appended);
  }

  /**
   * Records the recovery fact without inventing a retry. Alive, unknown, and
   * mismatched identities all remain blocked for a human/adapter reconciliation.
   */
  async recover(): Promise<RunSnapshot[]> {
    this.assertClaimed();
    this.projection.rebuild(this.journal.events());
    for (const snapshot of this.snapshots()) {
      const interruptedWorkerMaySurvive = snapshot.state === 'interrupted_uncertain' && snapshot.worker !== undefined;
      if (isTerminalRunState(snapshot.state) && !interruptedWorkerMaySurvive) continue;
      if (snapshot.worker !== undefined) {
        const workerStatus = await this.#probe.worker(snapshot.worker);
        if (workerStatus !== 'dead') {
          await this.recordUnresolved(snapshot.intent.runId, `worker_${workerStatus}`, snapshot.worker);
          continue;
        }
        await this.recordUnresolved(snapshot.intent.runId, 'worker_dead_without_terminal_receipt', snapshot.worker);
        continue;
      }
      for (const effect of snapshot.unresolvedEffects) {
        await this.recordUnresolved(snapshot.intent.runId, 'effect_receipt_missing', effect);
      }
    }
    return this.snapshots();
  }

  private async admitExclusive(intent: RunIntent): Promise<AdmissionResult> {
    this.assertClaimed();
    if (this.snapshots().some((snapshot) => snapshot.recovery.length > 0)) {
      return { accepted: false, reason: 'restore_reconciliation_required' };
    }
    const existing = this.snapshots().find((snapshot) => snapshot.intent.admissionKey === intent.admissionKey);
    if (existing !== undefined) {
      if (stable(existing.intent) !== stable(intent)) return { accepted: false, reason: 'admission_key_conflicts_with_existing_intent' };
      return { accepted: true, snapshot: existing };
    }
    if (this.snapshot(intent.runId) !== undefined) return { accepted: false, reason: 'run_id_already_exists' };
    if (this.snapshots().some((snapshot) => snapshot.reservation.reservationId === intent.budget.reservationId)) return { accepted: false, reason: 'reservation_id_already_exists' };
    if (intent.target.factoryId !== this.factoryId) return { accepted: false, reason: 'factory_id_mismatch' };
    if (!Number.isInteger(intent.attempt) || intent.attempt < 1 || intent.attempt > this.limits.maxRetries + 1) return { accepted: false, reason: 'retry_limit_exceeded' };
    if (!Number.isInteger(intent.budget.maxRuntimeMinutes) || intent.budget.maxRuntimeMinutes < 1 || intent.budget.maxRuntimeMinutes > this.limits.maxRuntimeMinutes) return { accepted: false, reason: 'runtime_limit_exceeded' };
    if (!Number.isInteger(intent.budget.estimatedTokens) || intent.budget.estimatedTokens < 0) return { accepted: false, reason: 'invalid_token_estimate' };
    if (intent.budget.status !== 'held') return { accepted: false, reason: 'reservation_must_be_held' };
    if (this.limits.strictSpending && !this.limits.strictSpendingSupported) return { accepted: false, reason: 'strict_spending_capability_unavailable' };
    const snapshots = this.snapshots();
    const capacityOccupied = snapshots.filter((snapshot) => !isTerminalRunState(snapshot.state)
      || (snapshot.state === 'interrupted_uncertain' && snapshot.worker !== undefined));
    if (capacityOccupied.length >= this.limits.maxConcurrentRuns) return { accepted: false, reason: 'concurrency_limit_exceeded' };
    const reserved = snapshots
      .filter((snapshot) => snapshot.reservation.status === 'held' || snapshot.reservation.status === 'uncertain')
      .reduce((sum, snapshot) => sum + snapshot.reservation.estimatedTokens, 0);
    if (this.limits.maxTokens > 0 && reserved + intent.budget.estimatedTokens > this.limits.maxTokens) return { accepted: false, reason: 'token_reservation_exceeded' };
    await this.record('run.admitted', intent.runId, { intent });
    return { accepted: true, snapshot: this.snapshot(intent.runId) };
  }

  private async recordUnresolved(runId: string, reason: string, subject: unknown): Promise<void> {
    const previous = this.journal.events().some((event) => event.runId === runId
      && event.kind === 'effect.unresolved' && event.data.reason === reason && stable(event.data.subject) === stable(subject));
    if (!previous) await this.record('effect.unresolved', runId, { reason, subject, observedAt: this.journal.clock.now().toISOString() });
  }

  private requireKnown(runId: string): RunSnapshot {
    const snapshot = this.snapshot(runId);
    if (snapshot === undefined) throw new Error(`Unknown run ${runId}`);
    return snapshot;
  }

  private requireKnownNonterminal(runId: string): RunSnapshot {
    const snapshot = this.requireKnown(runId);
    if (isTerminalRunState(snapshot.state)) throw new Error(`Run ${runId} is terminal and cannot receive a new effect`);
    return snapshot;
  }

  private assertClaimed(): void {
    if (!this.#claimed) throw new Error('Coordinator must claim exclusive ownership before operating');
  }

  private async readLock(): Promise<{ identity: CoordinatorIdentity; raw: string } | undefined> {
    try {
      const raw = await readFile(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object') return undefined;
      const identity = parsed as Partial<CoordinatorIdentity>;
      return typeof identity.instanceId === 'string' && typeof identity.pid === 'number' && typeof identity.processStartedAt === 'string'
        ? { identity: identity as CoordinatorIdentity, raw } : undefined;
    } catch {
      return undefined;
    }
  }
}
