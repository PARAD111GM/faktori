import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RunEvent } from './contracts.ts';

export class JournalCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalCorruptionError';
  }
}

export class JournalDuplicateConflictError extends JournalCorruptionError {
  constructor(eventId: string) {
    super(`Journal event ${eventId} was repeated with different content`);
    this.name = 'JournalDuplicateConflictError';
  }
}

export interface JournalClock {
  now(): Date;
}

export interface JournalRandom {
  eventId(): string;
}

export interface JournalOptions {
  clock?: JournalClock;
  random?: JournalRandom;
}

const systemClock: JournalClock = { now: () => new Date() };
const systemRandom: JournalRandom = { eventId: () => randomUUID() };

function canonicalize(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JournalCorruptionError('Journal records cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new JournalCorruptionError(`Journal records cannot contain ${typeof value} values`);
  if (ancestors.has(value)) throw new JournalCorruptionError('Journal records cannot contain circular values');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item, ancestors)).join(',')}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new JournalCorruptionError('Journal records must contain plain JSON objects');
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function cloneEvent(event: RunEvent): RunEvent {
  const clone = JSON.parse(canonicalize(event)) as unknown;
  if (!isRunEvent(clone)) throw new JournalCorruptionError('Refusing to store an invalid journal event');
  return clone;
}

export function eventDigest(event: RunEvent): string {
  return createHash('sha256').update(canonicalize(event)).digest('hex');
}

function isRunEvent(value: unknown): value is RunEvent {
  if (value === null || typeof value !== 'object') return false;
  const event = value as Partial<RunEvent>;
  return event.format === 'faktori.run-event/v1'
    && typeof event.eventId === 'string' && event.eventId.length > 0
    && typeof event.runId === 'string' && event.runId.length > 0
    && typeof event.occurredAt === 'string' && event.occurredAt.length > 0
    && typeof event.kind === 'string'
    && event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data);
}

/**
 * The journal is the operational authority. A newline is its commit marker: an
 * unterminated final record is discarded during recovery, while malformed data
 * anywhere else is corruption that must stop execution.
 */
export class AppendOnlyJournal {
  readonly path: string;
  readonly clock: JournalClock;
  readonly random: JournalRandom;
  #events: RunEvent[] = [];
  #digests = new Map<string, string>();
  #tail: Promise<void> = Promise.resolve();

  private constructor(path: string, options: JournalOptions) {
    this.path = path;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? systemRandom;
  }

  static async open(path: string, options: JournalOptions = {}): Promise<AppendOnlyJournal> {
    const journal = new AppendOnlyJournal(path, options);
    await mkdir(dirname(path), { recursive: true });
    try {
      await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const handle = await open(path, 'a');
      await handle.sync();
      await handle.close();
    }
    await journal.recover();
    return journal;
  }

  events(): readonly RunEvent[] {
    return this.#events.map(cloneEvent);
  }

  async recover(): Promise<readonly RunEvent[]> {
    const bytes = await readFile(this.path);
    const lastNewline = bytes.lastIndexOf(0x0a);
    const completeLength = lastNewline === bytes.length - 1 ? bytes.length : lastNewline + 1;
    if (bytes.length > completeLength) {
      // A missing newline is never a committed record, even if JSON happens to parse.
      const handle = await open(this.path, 'r+');
      try {
        await handle.truncate(completeLength);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const committed = bytes.subarray(0, completeLength).toString('utf8');
    const events: RunEvent[] = [];
    const digests = new Map<string, string>();
    let offset = 0;
    for (const line of committed.split('\n')) {
      if (line.length === 0) {
        offset += 1;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new JournalCorruptionError(`Malformed committed journal record at byte ${offset}`);
      }
      if (!isRunEvent(parsed)) throw new JournalCorruptionError(`Invalid committed journal record at byte ${offset}`);
      const digest = eventDigest(parsed);
      const previous = digests.get(parsed.eventId);
      if (previous !== undefined && previous !== digest) throw new JournalDuplicateConflictError(parsed.eventId);
      if (previous === undefined) {
        digests.set(parsed.eventId, digest);
        events.push(cloneEvent(parsed));
      }
      offset += Buffer.byteLength(line) + 1;
    }
    this.#events = events;
    this.#digests = digests;
    return this.events();
  }

  async append(event: RunEvent): Promise<RunEvent> {
    if (!isRunEvent(event)) throw new JournalCorruptionError('Refusing to append an invalid journal event');
    const stored = cloneEvent(event);
    const digest = eventDigest(stored);
    const existing = this.#digests.get(stored.eventId);
    if (existing !== undefined) {
      if (existing !== digest) throw new JournalDuplicateConflictError(stored.eventId);
      return cloneEvent(stored);
    }
    const write = async (): Promise<void> => {
      const repeated = this.#digests.get(stored.eventId);
      if (repeated !== undefined) {
        if (repeated !== digest) throw new JournalDuplicateConflictError(stored.eventId);
        return;
      }
      const handle = await open(this.path, 'a');
      try {
        await handle.writeFile(`${canonicalize(stored)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#digests.set(stored.eventId, digest);
      this.#events.push(stored);
    };
    const next = this.#tail.then(write, write);
    this.#tail = next.catch(() => undefined);
    await next;
    return cloneEvent(stored);
  }

  event(runId: string, kind: RunEvent['kind'], data: Record<string, unknown>, eventId = this.random.eventId()): RunEvent {
    return {
      format: 'faktori.run-event/v1',
      eventId,
      runId,
      occurredAt: this.clock.now().toISOString(),
      kind,
      data: JSON.parse(canonicalize(data)) as Record<string, unknown>,
    };
  }
}
