import { describe, expect, it } from 'vitest';

import { FactoryGM } from '../../src/gm/index.ts';

function durableStore() {
  const findings = new Map();
  const improvements = [];
  return {
    findings, improvements,
    findingByKey: async (key) => findings.get(key),
    upsertFinding: async (finding) => { findings.set(finding.findingKey, structuredClone(finding)); },
    appendImprovement: async (proposal) => { improvements.push(structuredClone(proposal)); },
  };
}

function gm(overrides = {}) {
  const store = durableStore();
  return {
    store,
    instance: new FactoryGM({
      factoryId: 'factory-a', instructions: { revision: 'gm-instructions@1', content: 'Diagnose factory health only. Never change product requirements, policy, or merge authority.' },
      store, now: () => new Date('2026-09-05T12:00:00.000Z'),
      ...overrides,
    }),
  };
}

describe('Factory GM', () => {
  it('deduplicates repeated handoff failure into one durable finding and diagnoses only once', async () => {
    const diagnoses = [];
    const { instance, store } = gm({ diagnosis: { diagnose: async (request) => { diagnoses.push(request); return { summary: 'The handoff packet is stale.' }; } } });
    const signal = { kind: 'repeated_handoff_failure', factoryId: 'factory-a', productId: 'p1', handoffKey: 'work-9:review', observedAt: '2026-09-05T12:00:00.000Z', summary: 'Review handoff failed.' };

    const first = await instance.observe(signal);
    const second = await instance.observe({ ...signal, observedAt: '2026-09-05T12:01:00.000Z', summary: 'Review handoff failed again.' });

    expect(store.findings.size).toBe(1);
    expect(second.finding.findingId).toBe(first.finding.findingId);
    expect(second.finding.occurrenceCount).toBe(2);
    expect(second.finding.latestSummary).toBe('Review handoff failed again.');
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]).toMatchObject({ instructionRevision: 'gm-instructions@1', category: 'repeated_handoff_failure', maxOutputCharacters: 6000 });
  });

  it('upserts a merge wait bottleneck and requires owner attention once without a model call or owner spam', async () => {
    let calls = 0;
    const { instance, store } = gm({ diagnosis: { diagnose: async () => { calls += 1; throw new Error('must not run'); } }, mergeWaitAttentionMinutes: 60 });
    const signal = { kind: 'merge_wait_bottleneck', factoryId: 'factory-a', mergeKey: 'org/repo#12', observedAt: '2026-09-05T12:00:00.000Z', waitingMinutes: 75, summary: 'PR has waited for a human merge.' };

    const first = await instance.observe(signal);
    const repeat = await instance.observe({ ...signal, observedAt: '2026-09-05T13:00:00.000Z', waitingMinutes: 90 });

    expect(store.findings.size).toBe(1);
    expect(first.ownerAttentionNewlyRequired).toBe(true);
    expect(repeat.ownerAttentionNewlyRequired).toBe(false);
    expect(repeat.finding.ownerAttention).toBe('owner_once');
    expect(repeat.finding.ownerAlertedAt).toBe('2026-09-05T12:00:00.000Z');
    expect(repeat.finding.occurrenceCount).toBe(2);
    expect(calls).toBe(0);
  });

  it('does not call a live model for deterministic negative signals', async () => {
    const { instance } = gm({ diagnosis: { diagnose: async () => { throw new Error('negative signals must not diagnose'); } } });
    const result = await instance.observe({ kind: 'merge_wait_bottleneck', factoryId: 'factory-a', mergeKey: 'org/repo#13', observedAt: '2026-09-05T12:00:00.000Z', waitingMinutes: 5, summary: 'Waiting for merge.' });
    expect(result.diagnosisInvoked).toBe(false);
    expect(result.finding.diagnosis.state).toBe('not_needed');
  });

  it('rejects product requirement, merge authority, and policy changes while allowing only configured routine maintenance', async () => {
    const executed = [];
    const { instance, store } = gm({
      configuredRoutineActions: ['refresh_projection'],
      maintenance: { execute: async (action) => { executed.push(action); } },
      diagnosis: { diagnose: async () => ({
        summary: 'Three unrelated ideas.',
        recommendations: [
          { kind: 'routine_maintenance', action: 'refresh_projection', detail: 'Refresh the rebuildable view.' },
          { kind: 'factory_improvement', detail: 'Propose a retry receipt review.' },
          { kind: 'product_requirement_change', detail: 'Require a new product approval.' },
          { kind: 'merge_authority_change', detail: 'Let the GM merge PRs.' },
          { kind: 'policy_change', detail: 'Relax independent review.' },
        ],
      }) },
    });

    const result = await instance.observe({ kind: 'repeated_handoff_failure', factoryId: 'factory-a', handoffKey: 'work-2:build', observedAt: '2026-09-05T12:00:00.000Z', summary: 'Build handoff failed.' });

    expect(executed).toEqual(['refresh_projection']);
    expect(store.improvements).toEqual([expect.objectContaining({ status: 'proposed', authority: 'requires_approval' })]);
    expect(result.finding.rejectedRecommendations).toEqual([
      expect.objectContaining({ kind: 'product_requirement_change', reason: 'factory_gm_has_no_product_merge_or_policy_authority' }),
      expect.objectContaining({ kind: 'merge_authority_change', reason: 'factory_gm_has_no_product_merge_or_policy_authority' }),
      expect.objectContaining({ kind: 'policy_change', reason: 'factory_gm_has_no_product_merge_or_policy_authority' }),
    ]);
  });
});
