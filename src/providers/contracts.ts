import type { ProviderFinalResult, RunIntent, WorkerIdentity } from '../runtime/contracts.ts';

export type SupportedProviderId = 'codex' | 'claude' | 'cursor';

/** Current, coordinator-approved packet contents for exactly one provider turn. */
export interface ProviderCurrentContext {
  packetRevision: string;
  digest: string;
  prompt: string;
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
