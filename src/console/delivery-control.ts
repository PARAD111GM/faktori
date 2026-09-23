import { createHash } from 'node:crypto';
import type { DurableCoordinator } from '../runtime/coordinator.ts';
import { deliveryJournal } from './delivery-journal.ts';

export interface DeliveryControlPort {
  snapshot(): Record<string, unknown>;
  submit(commandId: string, command: unknown): Promise<ControlRecord>;
  /** Stop accepting work and mark any durable receipt that has not begun an effect uncertain. */
  quiesce(): Promise<void>;
}
export interface ControlRecord {
  eventId: string;
  commandId: string;
  digest: string;
  status: 'accepted' | 'completed' | 'failed' | 'uncertain';
  observedAt: string;
  detail?: string;
}

export type DeliveryControlScheduler = (start: () => void) => void;

interface PendingDelivery {
  readonly receipt: ControlRecord;
  readonly command: unknown;
  readonly operation: Promise<void>;
  state: 'scheduled' | 'running' | 'settling' | 'settled';
  start(): void;
}

/** Authenticated command receipts share the coordinator's single-writer journal.
 * After a restart an accepted command stays uncertain: never repeat its effects.
 */
export class DeliveryControl implements DeliveryControlPort {
  readonly #journal;
  readonly #observe: () => Record<string, unknown>;
  readonly #execute: (command: unknown) => Promise<unknown>;
  readonly #schedule: DeliveryControlScheduler;
  readonly #pending = new Set<PendingDelivery>();
  #tail: Promise<unknown> = Promise.resolve();
  #quiescing = false;
  constructor(coordinator: DurableCoordinator, observe: () => Record<string, unknown>, execute: (command: unknown) => Promise<unknown>, schedule: DeliveryControlScheduler = queueMicrotask) {
    this.#journal = deliveryJournal<ControlRecord>(coordinator, 'control');
    this.#observe = observe; this.#execute = execute; this.#schedule = schedule;
  }
  snapshot(): Record<string, unknown> {
    const latest = new Map<string, ControlRecord>();
    for (const event of this.#journal.events()) latest.set(event.commandId, event);
    return { ...this.#observe(), commands: [...latest.values()].slice(-30) };
  }
  submit(commandId: string, command: unknown): Promise<ControlRecord> {
    if (this.#quiescing) return Promise.reject(new Error('delivery_control_quiescing'));
    const next = this.#tail.then(async () => {
      if (this.#quiescing) throw new Error('delivery_control_quiescing');
      if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(commandId) || !command || typeof command !== 'object' || Array.isArray(command)) throw new Error('delivery_command_invalid');
      const encoded = JSON.stringify(command);
      if (encoded.length > 24_000) throw new Error('delivery_command_too_large');
      const digest = createHash('sha256').update(encoded).digest('hex');
      const prior = this.#journal.events().filter(item => item.commandId === commandId).at(-1);
      if (prior) { if (prior.digest !== digest) throw new Error('delivery_command_identity_conflict'); return prior; }
      const receipt: ControlRecord = { eventId: `control:${commandId}:accepted`, commandId, digest, status: 'accepted', observedAt: new Date().toISOString() };
      await this.#journal.append(receipt);
      this.#schedulePending(receipt, command);
      return receipt;
    });
    this.#tail = next.catch(() => undefined); return next;
  }
  /**
   * Quiescing is a durable boundary: commands accepted before it but not yet
   * started are never replayed or dispatched. Their terminal fact is instead
   * an uncertainty for the owner to reconcile after restart.
   */
  async quiesce(): Promise<void> {
    this.#quiescing = true;
    const admitted = this.#tail;
    await admitted;
    const unstarted = [...this.#pending].filter((pending) => pending.state === 'scheduled');
    for (const pending of unstarted) pending.start();
    await Promise.allSettled(unstarted.map((pending) => pending.operation));
  }
  async settle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending].map((pending) => pending.operation));
  }
  #schedulePending(receipt: ControlRecord, command: unknown): void {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
    const pending: PendingDelivery = {
      receipt, command, operation, state: 'scheduled',
      start: () => { void this.#runPending(pending, resolve, reject); },
    };
    this.#pending.add(pending);
    this.#schedule(pending.start);
    void operation.catch(() => undefined).finally(() => this.#pending.delete(pending));
  }
  async #runPending(pending: PendingDelivery, resolve: () => void, reject: (error: unknown) => void): Promise<void> {
    if (pending.state !== 'scheduled') return;
    if (this.#quiescing) {
      pending.state = 'settling';
      try {
        await this.#journal.append({ ...pending.receipt, eventId: `control:${pending.receipt.commandId}:uncertain`, status: 'uncertain', observedAt: new Date().toISOString(), detail: 'delivery_quiesced_before_effect_started' });
        resolve();
      } catch (error) { reject(error); }
      finally { pending.state = 'settled'; }
      return;
    }
    pending.state = 'running';
    try {
      await this.#execute(pending.command);
      await this.#journal.append({ ...pending.receipt, eventId: `control:${pending.receipt.commandId}:completed`, status: 'completed', observedAt: new Date().toISOString() });
      resolve();
    } catch (error) {
      try {
        await this.#journal.append({ ...pending.receipt, eventId: `control:${pending.receipt.commandId}:failed`, status: 'failed', observedAt: new Date().toISOString(), detail: error instanceof Error && /^[a-z0-9_:.-]{1,180}$/i.test(error.message) ? error.message : 'delivery_action_failed_inspect_registered_evidence' });
        resolve();
      } catch (appendError) { reject(appendError); }
    } finally { pending.state = 'settled'; }
  }
}
