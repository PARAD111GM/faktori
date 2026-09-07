import { createHash } from 'node:crypto';

import type { RunEvent } from '../runtime/contracts.ts';

/** A read-only, portable explanation of an admission refusal. */
export interface StructuredBlocker {
  format: 'faktori.blocker/v1';
  blockerId: string;
  reasonCode: string;
  decisionOwnerRole: 'parent_coordinator';
  related: { parentRunId?: string; childRunId?: string; workstreamId?: string; delegationId?: string };
  ownership: { state: 'observed' | 'missing_or_orphaned'; paths: string[]; omittedPathCount: number };
  overlaps: Array<{ requestedPath: string; existingPath: string; existingChildRunId: string; existingDelegationId: string }>;
  omittedIdentityCount: number;
  remediation: string;
}

export interface BlockerInput {
  reasonCode: string;
  parentRunId?: string;
  childRunId?: string;
  workstreamId?: string;
  delegationId?: string;
  requestedPaths?: readonly unknown[];
  conflicting?: ReadonlyArray<{ paths: readonly unknown[]; childRunId: string; delegationId: string }>;
  orphaned?: boolean;
  omittedPathCount?: number;
  omittedIdentityCount?: number;
}

const SECRET = /(?:secret|credential|token|password|api[_-]?key|authorization|bearer)/i;
const CREDENTIAL_SIGNATURE = /(?:\bsk-(?:(?:proj|live|test)-)?[A-Za-z0-9_-]{8,}|\b(?:[rs]k_(?:live|test)|whsec)_[A-Za-z0-9]{8,}|\b(?:gh[opusr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bxox[aboprs]-[A-Za-z0-9-]{10,}|\bnpm_[A-Za-z0-9]{12,}|\bpypi-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const PRIVATE = /(?:^|[\\/])(?:\.(?:codex|claude|faktori|git|ssh|gnupg|aws)(?:[\\/]|$)|\.env(?:\.[^\\/]*)?(?:[\\/]|$)|\.(?:npmrc|netrc)(?:[\\/]|$))|(?:^|[\\/])(?:Users|home)(?:[\\/]|$)/i;

function safePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.startsWith('/') || value.startsWith('\\') || value.startsWith('~') || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes('\\') || SECRET.test(value) || CREDENTIAL_SIGNATURE.test(value) || PRIVATE.test(value)) return undefined;
  const parts = value.split('/');
  return parts.some((part) => part === '' || part === '.' || part === '..') ? undefined : value;
}

function safeIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(value)
    && !value.includes('..') && !SECRET.test(value) && !CREDENTIAL_SIGNATURE.test(value) && !PRIVATE.test(value) ? value : undefined;
}

function safeReasonCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(value)
    ? value
    : 'unsafe_or_unknown_blocker';
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The exact repository-relative ownership predicate used by admission. */
export function ownershipPathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function remediation(reasonCode: string): string {
  if (reasonCode === 'ownership_conflicts_with_active_child') return 'Wait for the named child to become terminal, or submit an explicitly authorized serialized delegation.';
  if (reasonCode === 'orphaned_delegated_child_admission_requires_identical_recovery') return 'Retry only the identical durable delegation so the coordinator can recover its missing ownership record.';
  if (reasonCode.includes('workspace')) return 'Choose an isolated workspace through the trusted allocator, then retry admission.';
  if (reasonCode === 'artifact_reference_not_approved_for_parent') return 'Use only artifacts durably approved for this parent run, then retry admission.';
  return 'Resolve the recorded admission condition through the decision-owning coordinator, then submit a new bounded request.';
}

/**
 * Sanitizes untrusted paths before projection.  Omitted values are counted but
 * never echoed, so Console can show incomplete ownership without disclosure.
 */
export function createDelegationBlocker(input: BlockerInput): StructuredBlocker {
  const reasonCode = safeReasonCode(input.reasonCode);
  const raw = input.requestedPaths ?? [];
  const safeRequested = raw.map(safePath);
  const paths = [...new Set(safeRequested.filter((value): value is string => value !== undefined))].sort();
  let omittedPathCount = boundedCount(input.omittedPathCount) + safeRequested.filter((value) => value === undefined).length;
  let omittedIdentityCount = boundedCount(input.omittedIdentityCount);
  const overlapPairs = (input.conflicting ?? []).flatMap((conflict) => {
    const safeExisting = conflict.paths.map(safePath);
    const existing = [...new Set(safeExisting.filter((value): value is string => value !== undefined))].sort();
    omittedPathCount += safeExisting.filter((value) => value === undefined).length;
    const childRunId = safeIdentity(conflict.childRunId);
    const delegationId = safeIdentity(conflict.delegationId);
    if (childRunId === undefined || delegationId === undefined) {
      omittedIdentityCount += Number(childRunId === undefined) + Number(delegationId === undefined);
      return [];
    }
    return paths.flatMap((requestedPath) => existing.filter((existingPath) => ownershipPathsOverlap([requestedPath], [existingPath]))
      .map((existingPath) => ({ requestedPath, existingPath, existingChildRunId: childRunId, existingDelegationId: delegationId })));
  });
  const overlaps = [...new Map(overlapPairs.map((pair) => [canonical(pair), pair])).values()]
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  const ownership = input.orphaned ? { state: 'missing_or_orphaned' as const, paths: [], omittedPathCount } : { state: 'observed' as const, paths, omittedPathCount };
  const related: StructuredBlocker['related'] = {};
  for (const [key, value] of Object.entries({ parentRunId: input.parentRunId, childRunId: input.childRunId, workstreamId: input.workstreamId, delegationId: input.delegationId })) {
    if (value === undefined) continue;
    const safe = safeIdentity(value);
    if (safe === undefined) omittedIdentityCount += 1;
    else related[key as keyof StructuredBlocker['related']] = safe;
  }
  const identity = { reasonCode, decisionOwnerRole: 'parent_coordinator', related, ownership, overlaps, omittedIdentityCount };
  return { format: 'faktori.blocker/v1', blockerId: `blocker-${createHash('sha256').update(canonical(identity)).digest('hex').slice(0, 24)}`, reasonCode, decisionOwnerRole: 'parent_coordinator', related, ownership, overlaps, omittedIdentityCount, remediation: remediation(reasonCode) };
}

/** Rebuild an external diagnostic through the safe, deterministic projection. */
export function projectStructuredBlocker(value: unknown): StructuredBlocker | undefined {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const related = record?.related !== null && typeof record?.related === 'object' && !Array.isArray(record?.related) ? record.related as Record<string, unknown> : undefined;
  const ownership = record?.ownership !== null && typeof record?.ownership === 'object' && !Array.isArray(record?.ownership) ? record.ownership as Record<string, unknown> : undefined;
  if (record?.format !== 'faktori.blocker/v1' || typeof record.reasonCode !== 'string' || related === undefined || ownership === undefined || !Array.isArray(ownership.paths) || !Array.isArray(record.overlaps)) return undefined;
  const conflicts = record.overlaps.flatMap((item) => {
    const pair = item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
    return pair === undefined ? [] : [{ paths: [pair.existingPath], childRunId: String(pair.existingChildRunId ?? ''), delegationId: String(pair.existingDelegationId ?? '') }];
  });
  return createDelegationBlocker({
    reasonCode: record.reasonCode,
    parentRunId: related.parentRunId as string | undefined, childRunId: related.childRunId as string | undefined,
    workstreamId: related.workstreamId as string | undefined, delegationId: related.delegationId as string | undefined,
    requestedPaths: ownership.paths,
    orphaned: ownership.state === 'missing_or_orphaned',
    conflicting: conflicts,
    omittedPathCount: boundedCount(ownership.omittedPathCount),
    omittedIdentityCount: boundedCount(record.omittedIdentityCount),
  });
}

/** Rebuilds the current blocker projection from durable observation events. */
export function structuredBlockersFromEvents(events: readonly RunEvent[]): StructuredBlocker[] {
  const active = new Map<string, StructuredBlocker>();
  const terminalRunIds = new Set(events.filter((event) => event.kind === 'provider.final').map((event) => event.runId));
  for (const event of events) {
    if (event.kind !== 'provider.event') continue;
    if (event.data.type === 'delegation.blocked') {
      const blocker = projectStructuredBlocker(event.data.blocker);
      if (blocker !== undefined) active.set(blocker.blockerId, blocker);
      continue;
    }
    if (event.data.type !== 'delegation.child-admitted') continue;
    const envelope = event.data.envelope !== null && typeof event.data.envelope === 'object' && !Array.isArray(event.data.envelope)
      ? event.data.envelope as Record<string, unknown>
      : undefined;
    if (envelope === undefined) continue;
    for (const [id, blocker] of active) {
      if (blocker.related.parentRunId === envelope.parentRunId && blocker.related.delegationId === envelope.delegationId) active.delete(id);
    }
  }
  for (const [id, blocker] of [...active]) {
    if (blocker.reasonCode !== 'ownership_conflicts_with_active_child') continue;
    const remaining = blocker.overlaps.filter((overlap) => !terminalRunIds.has(overlap.existingChildRunId));
    if (remaining.length === blocker.overlaps.length) continue;
    active.delete(id);
    if (remaining.length === 0) continue;
    const conflicts = new Map<string, { paths: string[]; childRunId: string; delegationId: string }>();
    for (const overlap of remaining) {
      const key = `${overlap.existingChildRunId}\u0000${overlap.existingDelegationId}`;
      const conflict = conflicts.get(key) ?? { paths: [], childRunId: overlap.existingChildRunId, delegationId: overlap.existingDelegationId };
      conflict.paths.push(overlap.existingPath);
      conflicts.set(key, conflict);
    }
    const projected = createDelegationBlocker({
      reasonCode: blocker.reasonCode,
      parentRunId: blocker.related.parentRunId,
      childRunId: blocker.related.childRunId,
      workstreamId: blocker.related.workstreamId,
      delegationId: blocker.related.delegationId,
      requestedPaths: blocker.ownership.paths,
      conflicting: [...conflicts.values()],
      orphaned: blocker.ownership.state === 'missing_or_orphaned',
      omittedPathCount: blocker.ownership.omittedPathCount,
      omittedIdentityCount: blocker.omittedIdentityCount,
    });
    active.set(projected.blockerId, projected);
  }
  return [...active.values()].sort((left, right) => left.blockerId.localeCompare(right.blockerId));
}
