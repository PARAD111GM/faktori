import type { DurableCoordinator } from '../runtime/coordinator.ts';
import type { ProviderOutcome, RunEvent, RunSnapshot } from '../runtime/contracts.ts';
import type { FactoryGM } from './index.ts';

const HEALTH_FAILURES = new Set<ProviderOutcome>([
  'authentication_required',
  'quota_exhausted',
  'failed',
  'interrupted_uncertain',
  'unavailable',
]);

function resultOutcome(event: RunEvent): ProviderOutcome | undefined {
  if (event.kind !== 'provider.final' || event.data.result === null || typeof event.data.result !== 'object') return undefined;
  const outcome = (event.data.result as { outcome?: unknown }).outcome;
  return typeof outcome === 'string' && HEALTH_FAILURES.has(outcome as ProviderOutcome) ? outcome as ProviderOutcome : undefined;
}

function handoffSubject(snapshot: RunSnapshot): string {
  return `${snapshot.intent.target.productId}:${snapshot.intent.workItem.id}:${snapshot.intent.execution.providerId}`;
}

/**
 * Converts only durable coordinator facts into bounded GM health signals.
 * A single failed provider turn is left alone; the second and later failure for
 * the same product/work-item/provider route becomes a repeated-handoff signal.
 */
export class CoordinatorGMHealthObserver {
  readonly #coordinator: DurableCoordinator;
  readonly #gm: FactoryGM;
  readonly #excludedWorkItemIds: ReadonlySet<string>;
  readonly #seen = new Set<string>();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: { coordinator: DurableCoordinator; gm: FactoryGM; excludedWorkItemIds?: ReadonlySet<string> }) {
    this.#coordinator = options.coordinator;
    this.#gm = options.gm;
    this.#excludedWorkItemIds = options.excludedWorkItemIds ?? new Set();
  }

  poll(): Promise<void> {
    const run = async (): Promise<void> => this.pollExclusive();
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async settle(): Promise<void> {
    await this.#tail;
  }

  private async pollExclusive(): Promise<void> {
    const snapshots = new Map(this.#coordinator.snapshots().map((snapshot) => [snapshot.intent.runId, snapshot]));
    const failures = new Map<string, number>();
    for (const event of this.#coordinator.journal.events()) {
      const snapshot = snapshots.get(event.runId);
      const outcome = resultOutcome(event);
      if (snapshot === undefined || outcome === undefined || this.#excludedWorkItemIds.has(snapshot.intent.workItem.id)) continue;
      const subject = handoffSubject(snapshot);
      const count = (failures.get(subject) ?? 0) + 1;
      failures.set(subject, count);
      if (count < 2 || this.#seen.has(event.eventId)) continue;
      await this.#gm.observe({
        kind: 'repeated_handoff_failure',
        factoryId: this.#coordinator.factoryId,
        productId: snapshot.intent.target.productId,
        ...(snapshot.intent.target.podId === undefined ? {} : { podId: snapshot.intent.target.podId }),
        handoffKey: subject,
        sourceEventId: event.eventId,
        observedAt: event.occurredAt,
        summary: `Provider delivery for ${snapshot.intent.workItem.id} ended ${outcome} after ${count} failed attempts.`,
      });
      // Mark only after the durable GM write succeeds so a transient observer
      // failure remains retryable in this process as well as after restart.
      this.#seen.add(event.eventId);
    }
  }
}
