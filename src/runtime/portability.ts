import { createHash } from 'node:crypto';

import type { SupportedProviderId } from '../providers/contracts.ts';

export type PortableRole = 'planning' | 'implementation' | 'independent_review';

export interface RoleAssignment {
  role: PortableRole;
  providerId: SupportedProviderId;
  /** Distinct even when a one-provider factory assigns every role to one CLI. */
  sessionPurpose: string;
}

export interface PortableArtifactReference {
  artifactId: string;
  kind: 'intent' | 'specification' | 'plan' | 'implementation' | 'verification' | 'review' | 'summary';
  revision: string;
  digest: string;
  /** Repository-relative or owner-approved durable record reference. */
  reference: string;
}

export interface PortableHandoff {
  format: 'faktori.provider-handoff/v1';
  handoffId: string;
  idempotencyKey: string;
  sourceRunId: string;
  sourceProviderId: SupportedProviderId;
  targetProviderId: SupportedProviderId;
  role: PortableRole;
  scope: {
    factoryId: string;
    productId: string;
    repository: string;
    workItemId: string;
    workItemRevision: string;
    contextRevision: string;
    authorityRevision: string;
    authorityEpoch: number;
  };
  artifacts: PortableArtifactReference[];
  verification: string[];
  summary: string;
  createdAt: string;
}

const ROLES: readonly PortableRole[] = ['planning', 'implementation', 'independent_review'];
const PROVIDERS = new Set<SupportedProviderId>(['codex', 'claude', 'cursor']);
const PRIVATE_REFERENCE = /(^|[/\\])(Users|home)([/\\])|\.codex|\.claude|session|credential|token/i;

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000')) throw new Error(`${label} must be a non-empty safe string`);
  return value;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

/** Assigns every V1 role while preserving distinct session purposes for independent review. */
export function assignPortableRoles(
  available: readonly SupportedProviderId[],
  requested: Partial<Record<PortableRole, SupportedProviderId>> = {},
): RoleAssignment[] {
  if (available.length === 0) throw new Error('At least one supported provider is required');
  if (new Set(available).size !== available.length || available.some((provider) => !PROVIDERS.has(provider))) throw new Error('Available providers must be unique supported providers');
  return ROLES.map((role, index) => {
    const providerId = requested[role] ?? available[index % available.length] as SupportedProviderId;
    if (!available.includes(providerId)) throw new Error(`Requested ${role} provider is unavailable`);
    return { role, providerId, sessionPurpose: `${role}-session` };
  });
}

export type PortableHandoffInput = Omit<PortableHandoff, 'format' | 'handoffId' | 'idempotencyKey'> & {
  handoffKey: string;
};

/**
 * Creates a document/evidence-only handoff. Native session identifiers and
 * private reasoning are intentionally absent from the contract.
 */
export function createPortableHandoff(input: PortableHandoffInput): PortableHandoff {
  const allowed = new Set(['handoffKey', 'sourceRunId', 'sourceProviderId', 'targetProviderId', 'role', 'scope', 'artifacts', 'verification', 'summary', 'createdAt']);
  const unexpected = Object.keys(input as Record<string, unknown>).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`Portable handoff contains unsupported private or authority-bearing fields: ${unexpected.join(', ')}`);
  const handoffKey = nonempty(input.handoffKey, 'handoffKey');
  nonempty(input.sourceRunId, 'sourceRunId');
  if (!PROVIDERS.has(input.sourceProviderId) || !PROVIDERS.has(input.targetProviderId)) throw new Error('Handoff providers must be supported');
  if (input.sourceProviderId === input.targetProviderId) throw new Error('Cross-provider handoff requires different source and target providers');
  if (!ROLES.includes(input.role)) throw new Error('Handoff role is unsupported');
  for (const [key, value] of Object.entries(input.scope)) {
    if (key === 'authorityEpoch') {
      if (!Number.isInteger(value) || Number(value) < 0) throw new Error('authorityEpoch must be a non-negative integer');
    } else nonempty(value, `scope.${key}`);
  }
  if (input.artifacts.length === 0) throw new Error('Portable handoff requires at least one accepted artifact');
  const artifactIds = new Set<string>();
  for (const artifact of input.artifacts) {
    if (artifactIds.has(artifact.artifactId)) throw new Error(`Duplicate artifactId ${artifact.artifactId}`);
    artifactIds.add(nonempty(artifact.artifactId, 'artifactId'));
    nonempty(artifact.revision, 'artifact.revision');
    nonempty(artifact.digest, 'artifact.digest');
    const reference = nonempty(artifact.reference, 'artifact.reference');
    if (PRIVATE_REFERENCE.test(reference) || reference.startsWith('/')) throw new Error('Artifact references must not expose private paths, sessions, credentials or tokens');
  }
  if (!Array.isArray(input.verification) || input.verification.some((item) => typeof item !== 'string' || item.trim().length === 0)) throw new Error('Verification must contain only non-empty evidence summaries');
  nonempty(input.summary, 'summary');
  nonempty(input.createdAt, 'createdAt');
  const identity = {
    handoffKey,
    sourceRunId: input.sourceRunId,
    sourceProviderId: input.sourceProviderId,
    targetProviderId: input.targetProviderId,
    role: input.role,
    scope: input.scope,
    artifacts: input.artifacts,
  };
  const idempotencyKey = digest(identity);
  return {
    format: 'faktori.provider-handoff/v1',
    handoffId: `handoff-${idempotencyKey}`,
    idempotencyKey,
    sourceRunId: input.sourceRunId,
    sourceProviderId: input.sourceProviderId,
    targetProviderId: input.targetProviderId,
    role: input.role,
    scope: { ...input.scope },
    artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
    verification: [...input.verification],
    summary: input.summary,
    createdAt: input.createdAt,
  };
}
