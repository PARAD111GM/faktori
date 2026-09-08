import { createHash } from 'node:crypto';

import type { ProviderOutcome, RunEvent } from './contracts.ts';

export type RunManifestOmissionReason = 'not_observed' | 'unsafe_or_invalid';

export interface RunManifestOmission {
  category: 'target' | 'workItem' | 'context' | 'execution' | 'resources' | 'outcome' | 'usage';
  reason: RunManifestOmissionReason;
}

export type RunManifestUsage =
  | { availability: 'unavailable' }
  | {
      availability: 'reported' | 'partially_reported';
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
    };

/**
 * A public, deterministic observation report. It is deliberately not a run
 * replay record: prompts, messages, paths, authority, sessions, summaries,
 * and provider-native payloads never cross this boundary.
 */
export interface RunManifest {
  format: 'faktori.run-manifest/v1';
  runId: string;
  observations: {
    target?: { factoryId?: string; productId?: string; podId?: string; repository?: string; branch?: string; baseRevision?: string; expectedRevision?: string };
    workItem?: { id?: string; revision?: string };
    context?: { packetRevision?: string; digest?: string };
    execution?: { profile?: 'isolated' | 'native'; workspaceId?: string; providerId?: string; model?: string; approvedInputDigests?: string[] };
    resources?: { maxRuntimeMinutes?: number; estimatedTokens?: number; status?: 'held' | 'released' | 'consumed' | 'uncertain' };
    outcome?: { outcome?: ProviderOutcome; revision?: string };
    usage?: RunManifestUsage;
  };
  omissions: RunManifestOmission[];
  contentDigest: string;
}

const PRIVATE_OR_SECRET = /(?:bearer\s+|authorization|api[_ -]?key|access[_ -]?token|client[_ -]?secret|credential|password|cookie|session(?:[_ -]?id)?|private[_ -]?(?:reasoning|path)|\bsecret\b|\.codex|\.claude|(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.npmrc|\.netrc|\.ssh|\.gnupg|\.aws)(?:[\\/]|$))|(?:^|[\\/])(?:Users|home)(?:[\\/]|$)/i;
const CREDENTIAL_SIGNATURE = /(?:\bsk-(?:(?:proj|live|test)-)?[A-Za-z0-9_-]{8,}|\b(?:[rs]k_(?:live|test)|whsec)_[A-Za-z0-9]{8,}|\b(?:gh[opusr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bxox[aboprs]-[A-Za-z0-9-]{10,}|\bnpm_[A-Za-z0-9]{12,}|\bpypi-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const URL_OR_REMOTE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bfile:|\bssh:|\bgit@|\bwww\.)/i;
const TRAVERSAL_OR_ABSOLUTE_PATH = /(?:^[/\\]|(?:^|[/\\])(?:\.{1,2})(?:[/\\]|$)|\\)/;
const OUTCOMES = new Set<ProviderOutcome>(['completed', 'unchanged_verified', 'denied', 'authentication_required', 'quota_exhausted', 'failed', 'cancelled', 'interrupted_uncertain', 'unavailable']);
const CATEGORIES = ['target', 'workItem', 'context', 'execution', 'resources', 'outcome', 'usage'] as const;

type Category = typeof CATEGORIES[number];
type RecordValue = Record<string, unknown>;

function record(value: unknown, allowed: readonly string[]): RecordValue | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const input = value as RecordValue;
  return Object.keys(input).every((key) => allowed.includes(key)) ? input : undefined;
}

function safeText(value: unknown, max = 256, pathLike = false): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\u0000')
    || PRIVATE_OR_SECRET.test(value) || CREDENTIAL_SIGNATURE.test(value) || URL_OR_REMOTE.test(value) || (pathLike && TRAVERSAL_OR_ABSOLUTE_PATH.test(value))) return undefined;
  return value;
}

function safeIdentifier(value: unknown, max = 256): string | undefined {
  const text = safeText(value, max, true);
  return text === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(text) ? undefined : text;
}

function safeRevision(value: unknown): string | undefined {
  const text = safeText(value, 256, true);
  return text !== undefined && (/^[a-f0-9]{7,64}$/i.test(text) || /^[A-Za-z][A-Za-z0-9._-]{0,63}(?:@[0-9]{1,12})?$/.test(text)) ? text : undefined;
}

function safeDigest(value: unknown): string | undefined {
  const text = safeText(value, 71, true);
  return text !== undefined && /^(?:sha256:)?[a-f0-9]{64}$/i.test(text) ? text : undefined;
}

function safeBranch(value: unknown): string | undefined {
  const text = safeText(value, 256, true);
  return text !== undefined && /^(?!.*(?:\.\.|\/\/|@\{|\.lock(?:\/|$)))[A-Za-z0-9][A-Za-z0-9._\/-]{0,255}$/.test(text) ? text : undefined;
}

function safeModel(value: unknown): string | undefined {
  const text = safeText(value, 128, true);
  return text !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(text) ? text : undefined;
}

function safeRepository(value: unknown): string | undefined {
  const text = safeText(value, 256, true);
  return text !== undefined && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(text) ? text : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Manifest values must be finite JSON values');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new Error('Manifest values must be JSON values');
  const input = record(value, Object.keys(value as RecordValue));
  if (input === undefined) throw new Error('Manifest values must be plain JSON objects');
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
}

function contentDigest(value: Omit<RunManifest, 'contentDigest'>): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function usage(value: unknown): RunManifestUsage | undefined {
  const input = record(value, ['availability', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'reportedBy', 'unavailableReason']);
  if (input === undefined) return undefined;
  if (input.availability === 'unavailable') return { availability: 'unavailable' };
  if (input.availability !== 'reported' && input.availability !== 'partially_reported') return undefined;
  const output: Extract<RunManifestUsage, { availability: 'reported' | 'partially_reported' }> = { availability: input.availability };
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens'] as const) {
    if (input[key] === undefined) continue;
    const count = nonNegativeInteger(input[key]);
    if (count === undefined) return undefined;
    output[key] = count;
  }
  return output;
}

function present<T extends RecordValue>(value: T): T | undefined {
  const compact = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
  return Object.keys(compact).length === 0 ? undefined : compact;
}

/** Builds a deterministic report from one run's already-recovered journal events. */
export function createRunManifest(events: readonly RunEvent[], runId: string): RunManifest {
  const safeRunId = safeIdentifier(runId);
  if (safeRunId === undefined) throw new Error('runId must be a safe identifier');
  const observations: RunManifest['observations'] = {};
  const omissions = new Map<Category, RunManifestOmissionReason>();
  const mark = (category: Category, reason: RunManifestOmissionReason): void => {
    if (observations[category] !== undefined) return;
    if (reason === 'unsafe_or_invalid' || !omissions.has(category)) omissions.set(category, reason);
  };

  for (const event of events) {
    if (event.runId !== runId) continue;
    if (event.kind === 'run.admitted') {
      const data = record(event.data, ['intent']);
      const intent = data === undefined ? undefined : record(data.intent, ['format', 'runId', 'admissionKey', 'workItem', 'target', 'context', 'execution', 'budget', 'authority', 'attempt', 'createdAt']);
      if (intent === undefined || intent.format !== 'faktori.run-intent/v1' || intent.runId !== runId) {
        for (const category of ['target', 'workItem', 'context', 'execution', 'resources'] as const) mark(category, 'unsafe_or_invalid');
        continue;
      }
      const target = record(intent.target, ['factoryId', 'productId', 'podId', 'repository', 'branch', 'baseRevision', 'expectedRevision']);
      if (target === undefined) mark('target', 'unsafe_or_invalid');
      else {
        const observed = { factoryId: safeIdentifier(target.factoryId), productId: safeIdentifier(target.productId), podId: target.podId === undefined ? undefined : safeIdentifier(target.podId), repository: safeRepository(target.repository), branch: safeBranch(target.branch), baseRevision: safeRevision(target.baseRevision), expectedRevision: safeRevision(target.expectedRevision) };
        if (observed.factoryId === undefined || observed.productId === undefined || observed.repository === undefined || observed.branch === undefined || observed.baseRevision === undefined || observed.expectedRevision === undefined || (target.podId !== undefined && observed.podId === undefined)) mark('target', 'unsafe_or_invalid');
        else observations.target = present(observed);
      }
      const workItem = record(intent.workItem, ['id', 'revision']);
      if (workItem === undefined) mark('workItem', 'unsafe_or_invalid');
      else {
        const observed = { id: safeIdentifier(workItem.id), revision: safeRevision(workItem.revision) };
        if (observed.id === undefined || observed.revision === undefined) mark('workItem', 'unsafe_or_invalid'); else observations.workItem = present(observed);
      }
      const context = record(intent.context, ['packetRevision', 'digest']);
      if (context === undefined) mark('context', 'unsafe_or_invalid');
      else {
        const observed = { packetRevision: safeRevision(context.packetRevision), digest: safeDigest(context.digest) };
        if (observed.packetRevision === undefined || observed.digest === undefined) mark('context', 'unsafe_or_invalid'); else observations.context = present(observed);
      }
      const execution = record(intent.execution, ['profile', 'workspaceId', 'workspacePath', 'providerId', 'model', 'approvedInputDigests']);
      if (execution === undefined || (execution.profile !== 'isolated' && execution.profile !== 'native') || !Array.isArray(execution.approvedInputDigests)) mark('execution', 'unsafe_or_invalid');
      else {
        const digests = execution.approvedInputDigests.map(safeDigest);
        const profile = execution.profile as 'isolated' | 'native';
        const observed = { profile, workspaceId: safeIdentifier(execution.workspaceId), providerId: safeIdentifier(execution.providerId), model: safeModel(execution.model), approvedInputDigests: digests.every((item) => item !== undefined) ? [...new Set(digests as string[])].sort() : undefined };
        if (observed.workspaceId === undefined || observed.providerId === undefined || observed.model === undefined || observed.approvedInputDigests === undefined) mark('execution', 'unsafe_or_invalid'); else observations.execution = present(observed);
      }
      const budget = record(intent.budget, ['reservationId', 'maxRuntimeMinutes', 'estimatedTokens', 'status']);
      if (budget === undefined || !['held', 'released', 'consumed', 'uncertain'].includes(String(budget.status))) mark('resources', 'unsafe_or_invalid');
      else {
        const observed = { maxRuntimeMinutes: nonNegativeInteger(budget.maxRuntimeMinutes), estimatedTokens: nonNegativeInteger(budget.estimatedTokens), status: budget.status as 'held' | 'released' | 'consumed' | 'uncertain' };
        if (observed.maxRuntimeMinutes === undefined || observed.estimatedTokens === undefined) mark('resources', 'unsafe_or_invalid'); else observations.resources = present(observed);
      }
    }
    if (event.kind === 'provider.final') {
      const data = record(event.data, ['result']);
      const result = data === undefined ? undefined : record(data.result, ['outcome', 'sessionId', 'summary', 'revision', 'verification', 'usage', 'nativeCancellationReceipt']);
      if (result === undefined || !OUTCOMES.has(result.outcome as ProviderOutcome)) {
        mark('outcome', 'unsafe_or_invalid');
        mark('usage', 'unsafe_or_invalid');
        continue;
      }
      const revision = result.revision === undefined ? undefined : safeRevision(result.revision);
      if (result.revision !== undefined && revision === undefined) mark('outcome', 'unsafe_or_invalid');
      else observations.outcome = present({ outcome: result.outcome as ProviderOutcome, revision });
      const observedUsage = usage(result.usage);
      if (observedUsage === undefined) mark('usage', 'unsafe_or_invalid'); else observations.usage = observedUsage;
    }
    if (event.kind === 'usage.observed') {
      const data = record(event.data, ['usage', 'source']);
      const observedUsage = data === undefined ? undefined : usage(data.usage);
      if (observedUsage === undefined) mark('usage', 'unsafe_or_invalid'); else observations.usage = observedUsage;
    }
  }
  for (const category of CATEGORIES) if (observations[category] === undefined) mark(category, omissions.get(category) ?? 'not_observed');
  const unsigned: Omit<RunManifest, 'contentDigest'> = {
    format: 'faktori.run-manifest/v1', runId: safeRunId, observations,
    omissions: CATEGORIES.filter((category) => observations[category] === undefined).map((category) => ({ category, reason: omissions.get(category) ?? 'not_observed' })),
  };
  return { ...unsigned, contentDigest: contentDigest(unsigned) };
}

function runEvent(value: unknown): RunEvent | undefined {
  const input = record(value, ['format', 'eventId', 'runId', 'occurredAt', 'kind', 'data']);
  const rawData = input?.data;
  const data = rawData !== null && typeof rawData === 'object' && !Array.isArray(rawData)
    ? record(rawData, Object.keys(rawData as RecordValue))
    : undefined;
  return input?.format === 'faktori.run-event/v1'
    && safeIdentifier(input.eventId) !== undefined
    && safeIdentifier(input.runId) !== undefined
    && typeof input.occurredAt === 'string' && !Number.isNaN(Date.parse(input.occurredAt))
    && typeof input.kind === 'string' && /^[a-z][a-z0-9._-]{0,127}$/.test(input.kind)
    && data !== undefined
    ? input as unknown as RunEvent
    : undefined;
}

/**
 * Parses committed JSONL without repairing or creating the source. An
 * unterminated tail is ignored exactly as an uncommitted journal fragment.
 */
export function parseRunManifestJournal(contents: string): RunEvent[] {
  const committedEnd = contents.lastIndexOf('\n');
  if (committedEnd < 0) return [];
  const events: RunEvent[] = [];
  const digests = new Map<string, string>();
  for (const [index, line] of contents.slice(0, committedEnd + 1).split('\n').entries()) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid committed journal JSON at line ${index + 1}`);
    }
    const event = runEvent(parsed);
    if (event === undefined) throw new Error(`Invalid committed journal event at line ${index + 1}`);
    const digest = createHash('sha256').update(canonical(event)).digest('hex');
    const prior = digests.get(event.eventId);
    if (prior !== undefined && prior !== digest) throw new Error(`Journal event ${event.eventId} has conflicting content`);
    if (prior === undefined) {
      digests.set(event.eventId, digest);
      events.push(event);
    }
  }
  return events;
}
