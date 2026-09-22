import type { DurableCoordinator } from '../runtime/coordinator.ts';

export type DeliveryRecordFamily = 'routing' | 'consultation' | 'workflow' | 'preview' | 'feature' | 'control';

/** Factory extensions share the coordinator's exclusive writer and append-only journal. */
export function deliveryJournal<T extends object>(coordinator: DurableCoordinator, family: DeliveryRecordFamily): {
  events(): T[]; append(record: T): Promise<void>;
} {
  const events = (): T[] => coordinator.journal.events().filter(event =>
    event.kind === 'factory.delivery' && event.runId === coordinator.factoryId && event.data.family === family,
  ).map(event => structuredClone(event.data.record) as T);
  return {
    events,
    async append(record): Promise<void> {
      // Canonical JSON removes optional undefined fields, never stores process handles.
      const safe = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
      if (JSON.stringify(safe).length > 131_072) throw new Error('delivery_record_too_large');
      const id = safe.eventId;
      if (typeof id === 'string') {
        const existing = events().find(value => (value as Record<string, unknown>).eventId === id);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(safe)) throw new Error('delivery_record_identity_conflict');
          return;
        }
      }
      await coordinator.record('factory.delivery', coordinator.factoryId, { family, record: safe });
    },
  };
}
