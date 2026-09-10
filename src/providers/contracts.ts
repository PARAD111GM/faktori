import { createHash } from 'node:crypto';

import type { ProviderFinalResult, RunIntent, WorkerIdentity } from '../runtime/contracts.ts';

export type SupportedProviderId = 'codex' | 'claude' | 'cursor';

/** Current, coordinator-approved packet contents for exactly one provider turn. */
export interface ProviderCurrentContext {
  packetRevision: string;
  digest: string;
  prompt: string;
  /**
   * A capability bound to this exact authorized turn. Omission preserves the
   * configured provider default; read-only is a narrowing request only.
   */
  nativeSandbox?: 'read-only';
}

/**
 * Digest the packet reference and the exact prompt bytes passed to a provider.
 * Validation may reject a blank prompt, but authorization never trims or
 * otherwise normalizes content before binding it to the admitted intent.
 */
export function providerContextPayloadDigest(context: ProviderCurrentContext): string {
  const payload = JSON.stringify({
    digest: context.digest,
    nativeSandbox: context.nativeSandbox,
    packetRevision: context.packetRevision,
    prompt: context.prompt,
  });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

/** A RunIntent authorizes provider input only through its durable allowlist. */
export function providerContextIsAuthorized(intent: RunIntent, context: ProviderCurrentContext): boolean {
  return Array.isArray(intent.execution.approvedInputDigests)
    && intent.execution.approvedInputDigests.includes(providerContextPayloadDigest(context));
}

export interface ProviderSessionScope {
  factoryId: string;
  productId: string;
  repository: string;
  workspaceId: string;
  /** Private operational path; never copy it into public evidence. */
  workspacePath: string;
  providerId: SupportedProviderId;
}

/** Durable provenance required for an explicit same-provider session resume. */
export interface ProviderSessionBinding {
  sessionId: string;
  sourceRunId: string;
  sourceContext: {
    packetRevision: string;
    digest: string;
  };
  sourceScope: ProviderSessionScope;
}

export interface ProviderTurnLifecycle {
  onStarted(worker: WorkerIdentity): Promise<void>;
  onTerminationRequired?(worker: WorkerIdentity, reason: 'timeout' | 'output_limit' | 'cancelled'): Promise<void>;
}

export interface ProviderNormalizedEvent {
  type: string;
  raw: Record<string, unknown>;
}

export interface ProviderRunResult {
  command: 'start' | 'resume';
  sessionId?: string;
  events: ProviderNormalizedEvent[];
  malformedEventCount: number;
  errorEvidence?: string;
  final: ProviderFinalResult;
}

/** Provider adapters report observations; this contract conveys no action authority. */
export interface ProviderTurnAdapter {
  start(intent: RunIntent, currentContext: ProviderCurrentContext, lifecycle?: ProviderTurnLifecycle): Promise<ProviderRunResult>;
  resume(intent: RunIntent, sessionBinding: ProviderSessionBinding, currentContext: ProviderCurrentContext, lifecycle?: ProviderTurnLifecycle): Promise<ProviderRunResult>;
  cancel?(intent: RunIntent, lifecycle?: ProviderTurnLifecycle): Promise<ProviderFinalResult>;
}
