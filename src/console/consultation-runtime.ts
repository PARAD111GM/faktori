import { createHash } from 'node:crypto';

import type { DurableCoordinator } from '../runtime/coordinator.ts';
import {
  SeniorConsultationService,
  type ConsultationEvent, type ConsultationPacket, type ConsultationProposal, type ConsultationRequest, type ConsultationResumePlan,
} from '../runtime/consultation.ts';
import { deliveryJournal } from './delivery-journal.ts';

export interface ConsultationMapping {
  originalBuilderId: string;
  workItemId: string;
  runId: string;
  workItemRevision: string;
  exactRevision: string;
  seniorTemplateId: string;
  resumeTarget: string;
}

export interface SeniorConsultationDispatch {
  dispatchSenior(input: { request: ConsultationRequest; seniorTemplateId: string }): Promise<Omit<ConsultationProposal, 'consultationId' | 'originalBuilderId'>>;
  resumeBuilder(input: { plan: ConsultationResumePlan; resumeTarget: string; runId: string }): Promise<void>;
}

export type ConsultationRuntimeResult =
  | { status: 'completed'; plan: ConsultationResumePlan }
  | { status: 'failed'; consultationId: string }
  | { status: 'blocked'; reason: string; consultationId?: string };

function text(value: string, name: string): void { if (value.trim().length === 0 || value.length > 512) throw new Error(`${name}_invalid`); }
function stable(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`; }
function id(prefix: string, value: unknown): string { return `${prefix}_${createHash('sha256').update(stable(value)).digest('hex').slice(0, 32)}`; }

function validateMapping(mapping: ConsultationMapping): void {
  for (const [name, value] of Object.entries(mapping)) text(value, `consultation_mapping_${name}`);
}

/**
 * Composes bounded senior advice with explicit callback ports. Provider effects
 * are intented first and never replayed from recovery; the original builder is
 * the only permitted resume target.
 */
export class ConsoleConsultationRuntime {
  readonly #coordinator: DurableCoordinator;
  readonly #service: SeniorConsultationService;
  readonly #mappings: ConsultationMapping[];
  readonly #dispatch: SeniorConsultationDispatch;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: { coordinator: DurableCoordinator; mappings: ConsultationMapping[]; dispatch: SeniorConsultationDispatch }) {
    if (!Array.isArray(options.mappings) || options.mappings.length > 128) throw new Error('consultation_mappings_invalid');
    options.mappings.forEach(validateMapping);
    const identities = new Set(options.mappings.map(mapping => `${mapping.originalBuilderId}\u0000${mapping.workItemId}\u0000${mapping.workItemRevision}\u0000${mapping.exactRevision}`));
    if (identities.size !== options.mappings.length) throw new Error('consultation_mapping_duplicate');
    this.#coordinator = options.coordinator; this.#mappings = structuredClone(options.mappings); this.#dispatch = options.dispatch;
    this.#service = new SeniorConsultationService({ journal: deliveryJournal<ConsultationEvent>(options.coordinator, 'consultation') });
  }

  consult(packet: ConsultationPacket): Promise<ConsultationRuntimeResult> {
    const task = () => this.consultExclusive(packet); const next = this.#tail.then(task, task); this.#tail = next.catch(() => undefined); return next;
  }

  /** Read-only reconciliation signal. A caller must inspect/resolve before any new provider call. */
  recover(): Array<{ runId: string; operationId: string }> {
    return this.#coordinator.snapshots().flatMap(snapshot => snapshot.unresolvedEffects
      .filter(effect => effect.operationId.startsWith('consultation_dispatch_') || effect.operationId.startsWith('consultation_resume_'))
      .map(effect => ({ runId: snapshot.intent.runId, operationId: effect.operationId })));
  }

  private mapping(packet: ConsultationPacket): ConsultationMapping | undefined {
    return this.#mappings.find(mapping => mapping.originalBuilderId === packet.originalBuilderId && mapping.workItemId === packet.workItemId && mapping.workItemRevision === packet.workItemRevision && mapping.exactRevision === packet.exactRevision);
  }

  private async intent(runId: string, operationId: string, identityKey: string, request: unknown): Promise<void> {
    await this.#coordinator.recordEffectIntent(runId, { operationId, kind: 'action.execute', identityKey, requestedAt: new Date().toISOString(), requestDigest: id('consultation_digest', request) });
  }

  private async receipt(runId: string, operationId: string, outcome: 'completed' | 'failed' | 'uncertain'): Promise<void> {
    await this.#coordinator.recordEffectReceipt(runId, { operationId, outcome, observedAt: new Date().toISOString() });
  }

  private async consultExclusive(packet: ConsultationPacket): Promise<ConsultationRuntimeResult> {
    const mapping = this.mapping(packet);
    if (mapping === undefined) return { status: 'blocked', reason: 'consultation_mapping_unavailable' };
    const requested = await this.#service.request(packet);
    if (requested.status === 'rejected') return { status: 'blocked', reason: requested.reason };
    const prior = this.serviceEvents().find(event => (event.type === 'consultation.completed' || event.type === 'consultation.failed') && event.proposal.consultationId === requested.request.consultationId);
    if (prior !== undefined) return { status: 'blocked', reason: 'consultation_result_requires_reconciliation', consultationId: requested.request.consultationId };
    if (requested.replayed) return { status: 'blocked', reason: 'consultation_dispatch_requires_reconciliation', consultationId: requested.request.consultationId };
    const dispatchOperation = id('consultation_dispatch', requested.request.consultationId);
    await this.intent(mapping.runId, dispatchOperation, `consultation:${requested.request.consultationId}:dispatch`, requested.request);
    let returned: Omit<ConsultationProposal, 'consultationId' | 'originalBuilderId'>;
    try { returned = await this.#dispatch.dispatchSenior({ request: requested.request, seniorTemplateId: mapping.seniorTemplateId }); }
    catch { await this.receipt(mapping.runId, dispatchOperation, 'uncertain'); return { status: 'blocked', reason: 'consultation_dispatch_uncertain', consultationId: requested.request.consultationId }; }
    await this.receipt(mapping.runId, dispatchOperation, 'completed');
    const result = await this.#service.submitResult({ ...returned, consultationId: requested.request.consultationId, originalBuilderId: mapping.originalBuilderId });
    if (result.status === 'failed') return { status: 'failed', consultationId: result.consultationId };
    const resumeOperation = id('consultation_resume', result.resumePlan.consultationId);
    await this.intent(mapping.runId, resumeOperation, `consultation:${result.resumePlan.consultationId}:resume`, result.resumePlan);
    try { await this.#dispatch.resumeBuilder({ plan: result.resumePlan, resumeTarget: mapping.resumeTarget, runId: mapping.runId }); }
    catch { await this.receipt(mapping.runId, resumeOperation, 'uncertain'); return { status: 'blocked', reason: 'consultation_resume_uncertain', consultationId: result.resumePlan.consultationId }; }
    await this.receipt(mapping.runId, resumeOperation, 'completed');
    return { status: 'completed', plan: result.resumePlan };
  }

  private serviceEvents(): readonly ConsultationEvent[] {
    // The service intentionally exposes no persistence handle; its configured
    // coordinator journal remains the authoritative replay source.
    return deliveryJournal<ConsultationEvent>(this.#coordinator, 'consultation').events();
  }
}
