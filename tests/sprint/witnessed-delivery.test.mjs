import { describe, expect, it } from 'vitest';

import { evaluateWitnessedDelivery, witnessedDeliveryConfigurationDigest } from '../../src/sprint/witnessed-delivery.ts';

const now = new Date('2026-09-13T12:00:00.000Z');
const catalogRevision = 'a'.repeat(64);
const completed = [{ id: 'witness-request', status: 'completed', completedAt: '2026-09-13T11:30:00.000Z', report: { delivery: 'reported', productAcceptance: 'not_evaluated' } }];

function readiness() {
  const input = { format: 'faktori.sprint-readiness/v1', sprintId: 'console-batch-one', revision: 'r1', mode: 'unattended', managerThreadId: 'manager', targets: [], artifactBindings: [{ path: '/private/controller/packet.json', sha256: 'b'.repeat(64) }], checks: [] };
  input.witnessedDelivery = {
    format: 'faktori.witnessed-delivery/v1', sprintRevision: 'r1', catalogRevision,
    configurationDigest: witnessedDeliveryConfigurationDigest(input),
    journey: { requestId: 'witness-request', state: 'completed', completedAt: completed[0].completedAt },
    validations: [
      { kind: 'candidate', state: 'passed', evidence: 'receipt:candidate:current', observedAt: '2026-09-13T11:20:00.000Z' },
      { kind: 'runtime', state: 'passed', evidence: 'receipt:runtime:current', observedAt: '2026-09-13T11:25:00.000Z' },
      { kind: 'staging', state: 'passed', evidence: 'receipt:staging:current', observedAt: '2026-09-13T11:29:00.000Z' },
    ],
    ownerAcceptance: { state: 'accepted', owner: 'owner', evidence: 'decision:owner-accepted', observedAt: '2026-09-13T11:31:00.000Z' },
    validUntil: '2026-09-13T13:00:00.000Z',
  };
  return input;
}

describe('witnessed unattended delivery admission', () => {
  it('requires a durable completion plus candidate, runtime, staging-or-delivery, and explicit owner evidence', () => {
    const input = readiness();
    expect(evaluateWitnessedDelivery(input, completed, catalogRevision, now)).toMatchObject({ ready: true, configurationDigest: witnessedDeliveryConfigurationDigest(input) });
    expect(evaluateWitnessedDelivery(input, [], catalogRevision, now)).toMatchObject({ ready: false,
      blockers: expect.arrayContaining([expect.objectContaining({ id: 'witness_completion_unverified' })]) });
  });

  it('blocks missing, stale, failed, unknown, denied, duplicate, and changed-configuration witnesses without an override', () => {
    const cases = [
      ['missing', input => { delete input.witnessedDelivery; }, 'witness_missing'],
      ['stale', input => { input.witnessedDelivery.validUntil = '2026-09-13T11:59:00.000Z'; }, 'witness_stale'],
      ['failed', input => { input.witnessedDelivery.validations[1].state = 'failed'; }, 'witness_runtime_failed'],
      ['unknown', input => { input.witnessedDelivery.journey.state = 'unknown'; }, 'witness_journey_unknown'],
      ['denied', input => { input.witnessedDelivery.ownerAcceptance.state = 'denied'; }, 'witness_owner_denied'],
      ['duplicate', input => { input.witnessedDelivery.validations.push({ ...input.witnessedDelivery.validations[0] }); }, 'witness_candidate_missing'],
      ['optional failed', input => { input.witnessedDelivery.validations.push({ kind: 'repository', state: 'failed', evidence: 'receipt:repository', observedAt: '2026-09-13T11:30:00.000Z' }); }, 'witness_repository_failed'],
      ['optional unknown', input => { input.witnessedDelivery.validations.push({ kind: 'tool', state: 'unknown', evidence: 'receipt:tool', observedAt: '2026-09-13T11:30:00.000Z' }); }, 'witness_tool_unknown'],
      ['configuration changed', input => { input.checks.push({ id: 'new-controller-check' }); }, 'witness_configuration_mismatch'],
    ];
    for (const [, change, blocker] of cases) {
      const input = readiness(); change(input);
      expect(evaluateWitnessedDelivery(input, completed, catalogRevision, now)).toMatchObject({ ready: false,
        blockers: expect.arrayContaining([expect.objectContaining({ id: blocker })]) });
    }
  });

  it('continues to recognize the same immutable completed receipt after a restart snapshot reload', () => {
    const input = readiness();
    const restartedSnapshot = structuredClone(completed);
    expect(evaluateWitnessedDelivery(input, restartedSnapshot, catalogRevision, now)).toMatchObject({ ready: true });
    restartedSnapshot[0].status = 'uncertain';
    expect(evaluateWitnessedDelivery(input, restartedSnapshot, catalogRevision, now)).toMatchObject({ ready: false,
      blockers: expect.arrayContaining([expect.objectContaining({ id: 'witness_completion_unverified' })]) });
  });

  it('allows separate passed delivery and staging evidence, but never accepts a future completion timestamp', () => {
    const input = readiness();
    input.witnessedDelivery.validations.push({ kind: 'delivery', state: 'passed', evidence: 'receipt:delivery:current', observedAt: '2026-09-13T11:29:30.000Z' });
    expect(evaluateWitnessedDelivery(input, completed, catalogRevision, now)).toMatchObject({ ready: true });
    input.witnessedDelivery.journey.completedAt = '2026-09-13T12:01:00.000Z';
    expect(evaluateWitnessedDelivery(input, [{ ...completed[0], completedAt: input.witnessedDelivery.journey.completedAt }], catalogRevision, now)).toMatchObject({ ready: false,
      blockers: expect.arrayContaining([expect.objectContaining({ id: 'witness_journey_invalid' })]) });
  });

  it('does not require a witness for the preserved attended path', () => {
    const input = readiness(); input.mode = 'attended'; delete input.witnessedDelivery;
    expect(evaluateWitnessedDelivery(input, [], catalogRevision, now)).toMatchObject({ ready: true, blockers: [] });
  });
});
