import { describe, expect, it } from 'vitest';

import { SeniorConsultationService } from '../../src/runtime/consultation.ts';

function journal() {
  const records = [];
  return { records, events: () => records.map((item) => structuredClone(item)), append: async (item) => { records.push(structuredClone(item)); } };
}

const clock = { now: () => new Date('2026-09-22T12:00:00.000Z') };
function packet(extra = {}) {
  return {
    workItemId: 'feature', workItemRevision: 'feature@1', originalBuilderId: 'builder-1', policyRevision: 'routing@1', failureKind: 'engineering', outputLimit: 1_000,
    objective: 'Repair the bounded feature.', exactRevision: 'abc123', contracts: [{ path: 'docs/contract.md', digest: 'contract@1' }], files: [{ path: 'src/feature.ts', digest: 'source@1' }],
    reproduction: 'The exact input returns an invalid result.', attempts: [{ hypothesis: 'The parser rejects this valid input.', result: 'The result remains invalid.' }], question: 'What minimal repair should the original builder make?', requestedOutput: 'Diagnosis, minimal change, verification.', ...extra,
  };
}

describe('bounded senior consultation', () => {
  it('requires genuine engineering evidence, prevents unchanged repeats, and returns a builder-bound resume plan', async () => {
    const port = journal(); const service = new SeniorConsultationService({ journal: port, clock });
    await expect(service.request(packet({ failureKind: 'quota' }))).rejects.toThrow('consultation_not_eligible_quota');
    const requested = await service.request(packet());
    expect(requested).toMatchObject({ status: 'requested', replayed: false, request: { originalBuilderId: 'builder-1', exactRevision: 'abc123' } });
    await expect(service.request(packet())).resolves.toMatchObject({ status: 'requested', replayed: true, request: { consultationId: requested.request.consultationId } });
    await expect(service.submitResult({ consultationId: requested.request.consultationId, originalBuilderId: 'other-builder', outcome: 'completed', diagnosis: 'x', proposal: 'y' })).rejects.toThrow('consultation_builder_binding_mismatch');
    const completed = await service.submitResult({ consultationId: requested.request.consultationId, originalBuilderId: 'builder-1', outcome: 'completed', diagnosis: 'Parser accepts an incomplete form.', proposal: 'Validate the optional field before parsing.', verificationSteps: ['Run the failing reproduction.'] });
    expect(completed).toMatchObject({ status: 'completed', replayed: false, resumePlan: { originalBuilderId: 'builder-1', exactRevision: 'abc123', proposal: 'Validate the optional field before parsing.' } });
    await expect(service.submitResult({ consultationId: requested.request.consultationId, originalBuilderId: 'builder-1', outcome: 'completed', diagnosis: 'Parser accepts an incomplete form.', proposal: 'Validate the optional field before parsing.', verificationSteps: ['Run the failing reproduction.'] })).resolves.toMatchObject({ status: 'completed', replayed: true });
  });

  it('records a bounded failure without pretending it completed the original work', async () => {
    const port = journal(); const service = new SeniorConsultationService({ journal: port, clock });
    const requested = await service.request(packet());
    const failed = await service.submitResult({ consultationId: requested.request.consultationId, originalBuilderId: 'builder-1', outcome: 'failed' });
    expect(failed).toEqual({ status: 'failed', consultationId: requested.request.consultationId, originalBuilderId: 'builder-1', replayed: false });
    expect(port.records.at(-1)).toMatchObject({ type: 'consultation.failed' });
  });
});
