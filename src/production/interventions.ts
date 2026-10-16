import { createHash } from 'node:crypto';
import { constants, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export type SpikeInterventionOutcome = 'observed' | 'failed' | 'not_verified';

export interface SpikeIntervention {
  id: string;
  spikeId: string;
  stage: string;
  occurredAt: string;
  actor: string;
  reason: string;
  action: string;
  outcome: SpikeInterventionOutcome;
  evidenceRefs: string[];
  capabilityGap?: string;
}

const entryFields = ['id', 'spikeId', 'stage', 'occurredAt', 'actor', 'reason', 'action', 'outcome', 'evidenceRefs', 'capabilityGap'];
const outcomes = new Set<SpikeInterventionOutcome>(['observed', 'failed', 'not_verified']);
const maximumEntryBytes = 64 * 1024;
const lockTimeoutMs = 15_000;

type RecordValue = Record<string, unknown>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as RecordValue;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function safeText(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${field} must be bounded non-empty text`);
  if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i.test(value)) throw new Error(`${field} must not contain secrets or environment values`);
  return value;
}

function identifier(value: unknown, field: string): string {
  const text = safeText(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new Error(`${field} must be a reference identifier`);
  return text;
}

function parseEntry(value: unknown, field = 'entry'): SpikeIntervention {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${field} must be a plain object`);
  const input = value as RecordValue;
  const unknown = Object.keys(input).find(key => !entryFields.includes(key));
  if (unknown) throw new Error(`${field} contains unknown field: ${unknown}`);
  const id = identifier(input.id, `${field}.id`);
  const spikeId = identifier(input.spikeId, `${field}.spikeId`);
  const stage = identifier(input.stage, `${field}.stage`);
  const occurredAt = safeText(input.occurredAt, `${field}.occurredAt`, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(occurredAt) || new Date(occurredAt).toISOString() !== occurredAt) throw new Error(`${field}.occurredAt must be a valid UTC ISO timestamp`);
  const actor = safeText(input.actor, `${field}.actor`, 128);
  const reason = safeText(input.reason, `${field}.reason`, 2000);
  const action = safeText(input.action, `${field}.action`, 2000);
  if (typeof input.outcome !== 'string' || !outcomes.has(input.outcome as SpikeInterventionOutcome)) throw new Error(`${field}.outcome must be observed, failed, or not_verified`);
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 32) throw new Error(`${field}.evidenceRefs must contain at most 32 references`);
  const evidenceRefs = input.evidenceRefs.map((reference, index) => safeText(reference, `${field}.evidenceRefs[${index}]`, 512));
  const capabilityGap = input.capabilityGap === undefined ? undefined : safeText(input.capabilityGap, `${field}.capabilityGap`, 2000);
  const entry: SpikeIntervention = { id, spikeId, stage, occurredAt, actor, reason, action, outcome: input.outcome as SpikeInterventionOutcome, evidenceRefs, ...(capabilityGap === undefined ? {} : { capabilityGap }) };
  if (Buffer.byteLength(canonical(entry), 'utf8') > maximumEntryBytes) throw new Error(`${field} exceeds the maximum serialized entry size`);
  return entry;
}

function ledgerPath(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) throw new Error('ledger path must be a normalized absolute path');
  return value;
}

async function withLedgerLock<T>(path: string, createParent: boolean, action: () => Promise<T>): Promise<T> {
  // Check the nearest existing ancestor before mkdir so an aliased parent does
  // not create directories outside the explicitly addressed ledger location.
  let ancestor = dirname(path);
  for (;;) {
    try {
      if (await realpath(ancestor) !== ancestor) throw new Error('ledger parent must use its canonical path, without symlinks');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (createParent) await mkdir(dirname(path), { recursive: true });
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error('ledger parent must not contain symlinks');
  const lockPath = `${path}.lock`;
  const startedAt = Date.now();
  let lock;
  while (!lock) {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - startedAt >= lockTimeoutMs) throw new Error('intervention ledger is locked; inspect the explicit lock file before retrying');
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    }
  }
  try { return await action(); }
  finally {
    const held = await lock.stat();
    await lock.close();
    const current = await lstat(lockPath);
    if (current.dev !== held.dev || current.ino !== held.ino) throw new Error('ledger lock changed; refusing to remove it');
    await unlink(lockPath);
  }
}

async function readUnlocked(path: string): Promise<SpikeIntervention[]> {
  let bytes: Buffer;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = await handle.stat();
      if (!held.isFile() || held.nlink !== 1) throw new Error('ledger must be a regular file without hard-link aliases');
      bytes = await handle.readFile();
    } finally { await handle.close(); }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0x0a) throw new Error('intervention ledger has an incomplete final line; preserving it and refusing to continue');
  const content = bytes.toString('utf8');
  const lines = content.slice(0, -1).split('\n');
  const entries: SpikeIntervention[] = [];
  const byId = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines[index]!); }
    catch { throw new Error(`malformed intervention ledger JSON at line ${index + 1}`); }
    const entry = parseEntry(parsed, `line ${index + 1}`);
    const digest = createHash('sha256').update(canonical(entry)).digest('hex');
    const prior = byId.get(entry.id);
    if (prior !== undefined && prior !== digest) throw new Error(`conflicting intervention id in ledger: ${entry.id}`);
    if (prior === undefined) byId.set(entry.id, digest);
    entries.push(entry);
  }
  return entries;
}

/** Reads complete ledger records. Invalid committed lines or partial tails fail closed. */
export async function readSpikeInterventions(pathValue: string): Promise<SpikeIntervention[]> {
  const path = ledgerPath(pathValue);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('ledger must be a regular file without aliases');
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return withLedgerLock(path, false, () => readUnlocked(path));
}

/** Appends one durable intervention record, or returns the existing record for an exact idempotent retry. */
export async function appendSpikeIntervention(pathValue: string, value: unknown): Promise<SpikeIntervention> {
  const path = ledgerPath(pathValue);
  const entry = parseEntry(value);
  return withLedgerLock(path, true, async () => {
    const entries = await readUnlocked(path);
    const existing = entries.find(candidate => candidate.id === entry.id);
    if (existing) {
      if (canonical(existing) !== canonical(entry)) throw new Error(`intervention id was already used with different content: ${entry.id}`);
      return existing;
    }
    const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const held = await handle.stat();
      const current = await lstat(path);
      if (!held.isFile() || held.nlink !== 1 || held.dev !== current.dev || held.ino !== current.ino || await realpath(dirname(path)) !== dirname(path)) throw new Error('ledger identity or canonical parent changed; refusing to append');
      await handle.writeFile(`${canonical(entry)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    return entry;
  });
}
