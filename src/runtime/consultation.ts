import { createHash } from 'node:crypto';

export type ConsultationFailureKind = 'engineering' | 'permission' | 'quota' | 'dependency' | 'transport';
export type ConsultationOutcome = 'completed' | 'failed';

/** Composition adapts the durable coordinator journal; this service creates no store. */
export interface ConsultationJournalPort {
  events(): readonly ConsultationEvent[];
  append(record: ConsultationEvent): Promise<void>;
}

export interface ConsultationEvidence {
  objective: string;
  exactRevision: string;
  contracts: Array<{ path: string; digest: string }>;
  files: Array<{ path: string; digest: string }>;
  reproduction: string;
  attempts: Array<{ hypothesis: string; result: string }>;
  question: string;
  requestedOutput: string;
}

export interface ConsultationPacket extends ConsultationEvidence {
  workItemId: string;
  workItemRevision: string;
  originalBuilderId: string;
  policyRevision: string;
  failureKind: ConsultationFailureKind;
  outputLimit: number;
  /** Allows an unchanged retry only when a policy decision is deliberately recorded. */
  repeatAuthority?: { authorityRevision: string; reason: string };
}

export interface ConsultationRequest {
  consultationId: string;
  evidenceDigest: string;
  originalBuilderId: string;
  workItemId: string;
  workItemRevision: string;
  exactRevision: string;
  packet: ConsultationPacket;
}

export interface ConsultationProposal {
  consultationId: string;
  originalBuilderId: string;
  outcome: ConsultationOutcome;
  diagnosis?: string;
  proposal?: string;
  verificationSteps?: string[];
}

export interface ConsultationResumePlan {
  consultationId: string;
  originalBuilderId: string;
  workItemId: string;
  workItemRevision: string;
  exactRevision: string;
  evidenceDigest: string;
  diagnosis: string;
  proposal: string;
  verificationSteps: string[];
}

export type ConsultationEvent =
  | { format: 'faktori.consultation-event/v1'; type: 'consultation.requested'; eventId: string; occurredAt: string; request: ConsultationRequest }
  | { format: 'faktori.consultation-event/v1'; type: 'consultation.completed' | 'consultation.failed'; eventId: string; occurredAt: string; proposal: ConsultationProposal; resumePlan?: ConsultationResumePlan };

export type ConsultationRequestResult =
  | { status: 'requested'; request: ConsultationRequest; replayed: boolean }
  | { status: 'rejected'; reason: string; evidenceDigest: string };

export type ConsultationResult =
  | { status: 'completed'; resumePlan: ConsultationResumePlan; replayed: boolean }
  | { status: 'failed'; consultationId: string; originalBuilderId: string; replayed: boolean };

export interface ConsultationClock { now(): Date; }
const SYSTEM_CLOCK: ConsultationClock = { now: () => new Date() };

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function identifier(prefix: string, value: unknown): string { return `${prefix}_${digest(value).slice(0, 32)}`; }
function bounded(value: string, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`${name}_invalid`);
  return value;
}

function validateReferences(references: Array<{ path: string; digest: string }>, name: string): void {
  if (!Array.isArray(references) || references.length > 64) throw new Error(`${name}_invalid`);
  const seen = new Set<string>();
  for (const reference of references) {
    bounded(reference.path, `${name}_path`, 512); bounded(reference.digest, `${name}_digest`, 256);
    if (reference.path.startsWith('/') || reference.path.includes('..') || seen.has(`${reference.path}\u0000${reference.digest}`)) throw new Error(`${name}_invalid`);
    seen.add(`${reference.path}\u0000${reference.digest}`);
  }
}

function validatePacket(packet: ConsultationPacket): void {
  for (const [name, value, max] of [
    ['work_item_id', packet.workItemId, 256], ['work_item_revision', packet.workItemRevision, 512], ['original_builder_id', packet.originalBuilderId, 256], ['policy_revision', packet.policyRevision, 256],
    ['objective', packet.objective, 4_000], ['exact_revision', packet.exactRevision, 512], ['reproduction', packet.reproduction, 8_000], ['question', packet.question, 4_000], ['requested_output', packet.requestedOutput, 2_000],
  ] as const) bounded(value, name, max);
  if (packet.failureKind !== 'engineering') throw new Error(`consultation_not_eligible_${packet.failureKind}`);
  if (!Number.isSafeInteger(packet.outputLimit) || packet.outputLimit < 1 || packet.outputLimit > 16_000) throw new Error('output_limit_invalid');
  validateReferences(packet.contracts, 'contracts'); validateReferences(packet.files, 'files');
  if (!Array.isArray(packet.attempts) || packet.attempts.length < 1 || packet.attempts.length > 8) throw new Error('attempts_invalid');
  for (const attempt of packet.attempts) { bounded(attempt.hypothesis, 'attempt_hypothesis', 2_000); bounded(attempt.result, 'attempt_result', 4_000); }
  if (packet.repeatAuthority !== undefined) { bounded(packet.repeatAuthority.authorityRevision, 'repeat_authority_revision', 256); bounded(packet.repeatAuthority.reason, 'repeat_authority_reason', 1_000); }
}

function evidence(packet: ConsultationPacket): ConsultationEvidence {
  return { objective: packet.objective, exactRevision: packet.exactRevision, contracts: packet.contracts, files: packet.files, reproduction: packet.reproduction, attempts: packet.attempts, question: packet.question, requestedOutput: packet.requestedOutput };
}

function completed(event: ConsultationEvent): event is Extract<ConsultationEvent, { type: 'consultation.completed' | 'consultation.failed' }> {
  return event.type === 'consultation.completed' || event.type === 'consultation.failed';
}

/** Bounded senior advice. It produces a handoff, never independent-review or implementation evidence. */
export class SeniorConsultationService {
  readonly #journal: ConsultationJournalPort;
  readonly #clock: ConsultationClock;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: { journal: ConsultationJournalPort; clock?: ConsultationClock }) { this.#journal = options.journal; this.#clock = options.clock ?? SYSTEM_CLOCK; }

  request(packet: ConsultationPacket): Promise<ConsultationRequestResult> {
    return this.serial(() => this.requestExclusive(packet));
  }

  submitResult(proposal: ConsultationProposal): Promise<ConsultationResult> {
    return this.serial(() => this.submitExclusive(proposal));
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation); this.#tail = next.catch(() => undefined); return next;
  }

  private async requestExclusive(packet: ConsultationPacket): Promise<ConsultationRequestResult> {
    validatePacket(packet);
    const evidenceDigest = digest(evidence(packet));
    const consultationId = identifier('consultation', { workItemId: packet.workItemId, workItemRevision: packet.workItemRevision, originalBuilderId: packet.originalBuilderId, evidenceDigest, policyRevision: packet.policyRevision, repeatAuthority: packet.repeatAuthority?.authorityRevision });
    const replay = this.#journal.events().find((event): event is Extract<ConsultationEvent, { type: 'consultation.requested' }> => event.type === 'consultation.requested' && event.request.consultationId === consultationId);
    if (replay !== undefined) return { status: 'requested', request: replay.request, replayed: true };
    const existing = this.#journal.events().filter((event): event is Extract<ConsultationEvent, { type: 'consultation.requested' }> => event.type === 'consultation.requested')
      .find((event) => event.request.workItemId === packet.workItemId && event.request.workItemRevision === packet.workItemRevision && event.request.originalBuilderId === packet.originalBuilderId && event.request.evidenceDigest === evidenceDigest);
    if (existing !== undefined && packet.repeatAuthority === undefined) return { status: 'rejected', reason: 'unchanged_evidence_requires_new_evidence_or_explicit_policy_authority', evidenceDigest };
    const request: ConsultationRequest = { consultationId, evidenceDigest, originalBuilderId: packet.originalBuilderId, workItemId: packet.workItemId, workItemRevision: packet.workItemRevision, exactRevision: packet.exactRevision, packet };
    await this.#journal.append({ format: 'faktori.consultation-event/v1', type: 'consultation.requested', eventId: identifier('consultation_requested', request), occurredAt: this.#clock.now().toISOString(), request });
    return { status: 'requested', request, replayed: false };
  }

  private async submitExclusive(proposal: ConsultationProposal): Promise<ConsultationResult> {
    bounded(proposal.consultationId, 'consultation_id', 256); bounded(proposal.originalBuilderId, 'original_builder_id', 256);
    if (proposal.outcome !== 'completed' && proposal.outcome !== 'failed') throw new Error('consultation_outcome_invalid');
    const requested = this.#journal.events().find((event): event is Extract<ConsultationEvent, { type: 'consultation.requested' }> => event.type === 'consultation.requested' && event.request.consultationId === proposal.consultationId);
    if (requested === undefined) throw new Error('consultation_unknown');
    if (requested.request.originalBuilderId !== proposal.originalBuilderId) throw new Error('consultation_builder_binding_mismatch');
    if (proposal.diagnosis !== undefined) bounded(proposal.diagnosis, 'consultation_diagnosis', requested.request.packet.outputLimit);
    if (proposal.proposal !== undefined) bounded(proposal.proposal, 'consultation_proposal', requested.request.packet.outputLimit);
    if (proposal.verificationSteps !== undefined) {
      if (!Array.isArray(proposal.verificationSteps) || proposal.verificationSteps.length > 16) throw new Error('consultation_verification_invalid');
      for (const step of proposal.verificationSteps) bounded(step, 'consultation_verification_step', 1_000);
    }
    const prior = this.#journal.events().filter(completed).find((event) => event.proposal.consultationId === proposal.consultationId);
    if (prior !== undefined) {
      if (stable(prior.proposal) !== stable(proposal)) throw new Error('consultation_result_conflict');
      return prior.type === 'consultation.completed' && prior.resumePlan !== undefined ? { status: 'completed', resumePlan: prior.resumePlan, replayed: true } : { status: 'failed', consultationId: proposal.consultationId, originalBuilderId: proposal.originalBuilderId, replayed: true };
    }
    if (proposal.outcome === 'failed') {
      await this.#journal.append({ format: 'faktori.consultation-event/v1', type: 'consultation.failed', eventId: identifier('consultation_failed', proposal), occurredAt: this.#clock.now().toISOString(), proposal });
      return { status: 'failed', consultationId: proposal.consultationId, originalBuilderId: proposal.originalBuilderId, replayed: false };
    }
    const diagnosis = bounded(proposal.diagnosis ?? '', 'consultation_diagnosis', requested.request.packet.outputLimit);
    const solution = bounded(proposal.proposal ?? '', 'consultation_proposal', requested.request.packet.outputLimit);
    const verificationSteps = proposal.verificationSteps ?? [];
    const resumePlan: ConsultationResumePlan = { consultationId: proposal.consultationId, originalBuilderId: proposal.originalBuilderId, workItemId: requested.request.workItemId, workItemRevision: requested.request.workItemRevision, exactRevision: requested.request.exactRevision, evidenceDigest: requested.request.evidenceDigest, diagnosis, proposal: solution, verificationSteps };
    await this.#journal.append({ format: 'faktori.consultation-event/v1', type: 'consultation.completed', eventId: identifier('consultation_completed', { proposal, resumePlan }), occurredAt: this.#clock.now().toISOString(), proposal, resumePlan });
    return { status: 'completed', resumePlan, replayed: false };
  }
}
