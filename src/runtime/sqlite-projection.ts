import { createRequire } from 'node:module';

import type { RunEvent, RunSnapshot } from './contracts.ts';
import { eventDigest } from './journal.ts';

type Statement = {
  run(...parameters: unknown[]): { changes: number };
  get(...parameters: unknown[]): Record<string, unknown> | undefined;
  all(...parameters: unknown[]): Array<Record<string, unknown>>;
};
type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T extends (...arguments_: never[]) => unknown>(fn: T): T;
  close(): void;
};
type DatabaseConstructor = new(path: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => Database;

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as DatabaseConstructor;

export type ProjectionInspection = 'ready' | 'unbound' | 'missing' | 'invalid';

/** Opens an existing projection strictly read-only and validates its Faktori table shape. */
export function inspectProjectionReadOnly(path: string, expectedFactoryId?: string): ProjectionInspection {
  let database: Database | undefined;
  try {
    database = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_events'").get();
    if (table?.name !== 'run_events') return 'invalid';
    database.prepare('SELECT event_id, run_id, occurred_at, kind, payload, digest FROM run_events LIMIT 0').all();
    if (expectedFactoryId !== undefined) {
      const admissions = database.prepare("SELECT payload FROM run_events WHERE kind = 'run.admitted'").all();
      if (admissions.length === 0) return 'unbound';
      for (const row of admissions) {
        const event = JSON.parse(String(row.payload)) as { data?: { intent?: { target?: { factoryId?: unknown } } } };
        if (event.data?.intent?.target?.factoryId !== expectedFactoryId) return 'invalid';
      }
    }
    return 'ready';
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    return code === 'SQLITE_CANTOPEN' ? 'missing' : 'invalid';
  } finally {
    database?.close();
  }
}

export class RuntimeSemanticConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeSemanticConflictError';
  }
}

function semantic(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(semantic).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${semantic(object[key])}`).join(',')}}`;
}

/** A disposable query index. Its contents are always derived from the journal. */
export class SqliteProjection {
  readonly path: string;
  #database: Database;

  constructor(path = ':memory:') {
    this.path = path;
    this.#database = new BetterSqlite3(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        digest TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_events_by_run ON run_events(run_id, sequence);
    `);
  }

  close(): void {
    this.#database.close();
  }

  apply(event: RunEvent): void {
    const payload = JSON.stringify(event);
    const digest = eventDigest(event);
    const existing = this.#database.prepare('SELECT digest FROM run_events WHERE event_id = ?').get(event.eventId);
    if (existing !== undefined) {
      if (existing.digest !== digest) throw new Error(`Projection event ${event.eventId} conflicts with existing event`);
      return;
    }
    // Validate semantic identities before exposing this event through a live
    // projection. A fresh transport event id does not authorize a second run
    // admission or a changed reuse of an effect operation id.
    snapshotsFromEvents([...this.events(), event]);
    this.#database.prepare('INSERT INTO run_events (event_id, run_id, occurred_at, kind, payload, digest) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.eventId, event.runId, event.occurredAt, event.kind, payload, digest);
  }

  rebuild(events: readonly RunEvent[]): void {
    const rebuild = (): void => {
      this.#database.exec('DELETE FROM run_events');
      for (const event of events) this.apply(event);
      // A projection must not claim a rebuild succeeded if the authoritative
      // sequence contains a semantic identity conflict.
      snapshotsFromEvents(events);
    };
    this.#database.transaction(rebuild)();
  }

  events(runId?: string): RunEvent[] {
    const rows = runId === undefined
      ? this.#database.prepare('SELECT payload FROM run_events ORDER BY sequence').all()
      : this.#database.prepare('SELECT payload FROM run_events WHERE run_id = ? ORDER BY sequence').all(runId);
    return rows.map((row) => JSON.parse(String(row.payload)) as RunEvent);
  }

  snapshots(): RunSnapshot[] {
    return snapshotsFromEvents(this.events());
  }

  snapshot(runId: string): RunSnapshot | undefined {
    return snapshotsFromEvents(this.events(runId))[0];
  }
}

function objectAt(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function terminalState(outcome: string): RunSnapshot['state'] {
  if (outcome === 'completed' || outcome === 'unchanged_verified') return 'succeeded';
  if (outcome === 'denied' || outcome === 'authentication_required' || outcome === 'quota_exhausted') return 'blocked';
  if (outcome === 'cancelled') return 'cancelled';
  if (outcome === 'interrupted_uncertain' || outcome === 'unavailable') return 'interrupted_uncertain';
  return 'failed';
}

/** Shared reducer used by the projection and coordinator recovery. */
export function snapshotsFromEvents(events: readonly RunEvent[]): RunSnapshot[] {
  const snapshots = new Map<string, RunSnapshot>();
  // This survives an effect receipt, so a stale replay cannot re-open a
  // completed operation after recovery.
  const effectIntents = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.kind === 'run.admitted') {
      const intent = event.data.intent;
      if (objectAt(intent) === undefined) continue;
      const typedIntent = intent as unknown as RunSnapshot['intent'];
      const existing = snapshots.get(event.runId);
      if (existing !== undefined) {
        if (semantic(existing.intent) !== semantic(typedIntent)) {
          throw new RuntimeSemanticConflictError(`Run ${event.runId} was admitted again with a conflicting intent`);
        }
        continue;
      }
      snapshots.set(event.runId, {
        intent: typedIntent,
        state: 'admitted',
        reservation: typedIntent.budget,
        authorityEpoch: typedIntent.authority.epoch,
        authorityRevoked: false,
        unresolvedEffects: [],
        recovery: [],
        messages: [],
      });
      continue;
    }
    const snapshot = snapshots.get(event.runId);
    if (snapshot === undefined) continue;
    if (event.kind === 'message.queued') {
      const message = event.data.message;
      if (objectAt(message) !== undefined) snapshot.messages.push(message as unknown as RunSnapshot['messages'][number]);
    } else if (event.kind === 'worker.started') {
      const worker = event.data.worker;
      if (objectAt(worker) !== undefined) {
        snapshot.worker = worker as unknown as NonNullable<RunSnapshot['worker']>;
        snapshot.state = 'running';
      }
    } else if (event.kind === 'effect.intended' || event.kind === 'action.intended' || event.kind === 'worker.termination.intended') {
      const effect = event.data.effect;
      const effectData = objectAt(effect);
      if (effectData !== undefined && typeof effectData.operationId === 'string') {
        const effectKey = `${event.runId}\u0000${effectData.operationId}`;
        const priorIntent = effectIntents.get(effectKey);
        if (priorIntent !== undefined) {
          if (semantic(priorIntent) !== semantic(effectData)) {
            throw new RuntimeSemanticConflictError(`Run ${event.runId} reused effect operation ${effectData.operationId} with conflicting content`);
          }
          continue;
        }
        effectIntents.set(effectKey, effectData);
        snapshot.unresolvedEffects = [...snapshot.unresolvedEffects.filter((item) => item.operationId !== effectData.operationId), effectData as unknown as RunSnapshot['unresolvedEffects'][number]];
        if (effectData.kind === 'worker.launch' || effectData.kind === 'worker.resume') snapshot.state = 'launching';
        if (effectData.kind === 'worker.terminate') snapshot.state = 'cancelling';
      }
    } else if (event.kind === 'effect.receipt' || event.kind === 'action.receipt' || event.kind === 'worker.termination.observed') {
      const receipt = event.data.receipt;
      const receiptData = objectAt(receipt);
      if (receiptData !== undefined && typeof receiptData.operationId === 'string') {
        snapshot.unresolvedEffects = snapshot.unresolvedEffects.filter((item) => item.operationId !== receiptData.operationId);
      }
      if (event.kind === 'worker.termination.observed' && receiptData?.outcome === 'completed') snapshot.state = 'cancelled';
    } else if (event.kind === 'effect.unresolved') {
      snapshot.state = 'reconciling';
    } else if (event.kind === 'recovery.required') {
      const recovery = objectAt(event.data.recovery);
      if (recovery !== undefined && typeof recovery.recoveryId === 'string'
        && !snapshot.recovery.some((item) => item.recoveryId === recovery.recoveryId)) {
        snapshot.recovery.push(recovery as unknown as RunSnapshot['recovery'][number]);
        snapshot.state = 'reconciling';
      }
    } else if (event.kind === 'recovery.resolved') {
      const resolution = objectAt(event.data.resolution);
      if (resolution !== undefined && typeof resolution.recoveryId === 'string') {
        snapshot.recovery = snapshot.recovery.filter((item) => item.recoveryId !== resolution.recoveryId);
        snapshot.worker = undefined;
        snapshot.unresolvedEffects = [];
        if (resolution.disposition === 'authority_revoked') snapshot.authorityRevoked = true;
        snapshot.state = resolution.disposition === 'blocked'
          ? 'blocked'
          : snapshot.providerResult === undefined ? 'interrupted_uncertain' : terminalState(snapshot.providerResult.outcome);
      }
    } else if (event.kind === 'authority.revoked') {
      snapshot.authorityRevoked = true;
      snapshot.authorityEpoch = Number(event.data.epoch ?? snapshot.authorityEpoch);
      snapshot.state = 'cancelling';
    } else if (event.kind === 'reservation.released') {
      const status = event.data.status;
      if (status === 'released' || status === 'consumed' || status === 'uncertain') snapshot.reservation = { ...snapshot.reservation, status };
    } else if (event.kind === 'provider.final') {
      const result = event.data.result;
      const resultData = objectAt(result);
      if (resultData !== undefined && typeof resultData.outcome === 'string') {
        snapshot.providerResult = resultData as unknown as RunSnapshot['providerResult'];
        snapshot.state = terminalState(resultData.outcome);
      }
    }
  }
  return [...snapshots.values()];
}
