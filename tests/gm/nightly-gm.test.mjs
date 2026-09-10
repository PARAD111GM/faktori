import { describe, expect, it } from 'vitest';
import { NightlyGM, projectGMNightlyState, summarizeFactoryEfficiency } from '../../src/gm/index.ts';

function store() {
  const values = [];
  return { values, attempts: async () => structuredClone(values), append: async (value) => { values.push(structuredClone(value)); } };
}

function finding() {
  return { format: 'faktori.gm-finding/v1', findingId: 'finding-1', findingKey: 'factory:missing:one', factoryId: 'factory', category: 'missing_telemetry', occurrenceCount: 1, openedAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z', latestSummary: 'Telemetry missing.', classification: 'infrastructure', status: 'active', evidence: ['loop:one'], affectedWork: ['one'], accountableRole: 'factory_operator', nextAction: { label: 'Repair export.' }, ownerAttention: 'owner_once', diagnosis: { state: 'not_needed' }, recommendations: [], rejectedRecommendations: [], maintenance: [] };
}

function metrics() {
  return summarizeFactoryEfficiency({ summaries: [], records: [] });
}

function create(overrides = {}) {
  const durable = store(); let calls = 0; let now = new Date('2026-09-09T08:00:00Z');
  const instance = new NightlyGM({ schedule: { enabled: true, timezone: 'America/Chicago', localTime: '02:00' }, instructions: { revision: 'gm@1', content: 'Review only.' }, store: durable,
    review: { review: async () => { calls += 1; return { findingActions: [{ findingId: 'finding-1', action: 'retain', evidence: 'Still observed.' }], recommendations: [{ priority: 'low', findingId: 'finding-1', recommendation: 'Repair export.', expectedBenefit: 'Restore coverage.', evidence: ['loop:one'], nextAction: 'Inspect registration.' }] }; } },
    snapshot: async () => ({ findings: [finding()], metrics: metrics() }), now: () => now, ...overrides });
  return { instance, durable, calls: () => calls, setNow: (value) => { now = new Date(value); } };
}

describe('consolidated nightly GM', () => {
  it('deduplicates concurrent and restarted scheduled attempts and skips unchanged facts despite prior recommendations', async () => {
    const fixture = create();
    const [left, right] = await Promise.all([fixture.instance.run({ type: 'scheduled' }), fixture.instance.run({ type: 'scheduled' })]);
    expect(left.status).toBe('completed'); expect(right).toEqual(left); expect(fixture.calls()).toBe(1);
    fixture.setNow('2026-09-10T08:00:00Z');
    const next = await fixture.instance.run({ type: 'scheduled' });
    expect(next.status).toBe('skipped_unchanged'); expect(fixture.calls()).toBe(1);
    const restarted = new NightlyGM({ schedule: { enabled: true, timezone: 'America/Chicago', localTime: '02:00' }, instructions: { revision: 'gm@1', content: 'Review only.' }, store: fixture.durable, review: { review: async () => { throw new Error('must not retry'); } }, snapshot: async () => ({ findings: [finding()], metrics: metrics() }), now: () => new Date('2026-09-10T09:00:00Z') });
    expect((await restarted.run({ type: 'scheduled' })).status).toBe('skipped_unchanged');
  });

  it('records intent before a failed call and never automatically retries that identity', async () => {
    const durable = store(); let calls = 0;
    const instance = new NightlyGM({ schedule: { enabled: true, timezone: 'UTC', localTime: '00:00' }, instructions: { revision: 'gm@1', content: 'Review.' }, store: durable, review: { review: async () => { calls += 1; expect(durable.values.at(-1).status).toBe('intended'); throw new Error('uncertain'); } }, snapshot: async () => ({ findings: [finding()], metrics: metrics() }), now: () => new Date('2026-09-09T12:00:00Z') });
    expect((await instance.run({ type: 'scheduled' })).status).toBe('failed');
    expect((await instance.run({ type: 'scheduled' })).status).toBe('failed');
    expect(calls).toBe(1);
    expect(projectGMNightlyState(durable.values, { enabled: true, timezone: 'UTC', localTime: '00:00' }, new Date('2026-09-09T13:00:00Z')).supervision).toBe('degraded');
  });

  it('fails closed on authority-widening or structurally invalid model output', async () => {
    const fixture = create({ review: { review: async () => ({ findingActions: [], recommendations: [], policyChange: 'merge without review' }) } });
    const result = await fixture.instance.run({ type: 'owner_requested', requestId: 'owner-1' });
    expect(result).toMatchObject({ status: 'failed', failure: 'provider_result_invalid' });
  });

  it('sends a complete strict example and does not let its own review overhead wake the next daily call', async () => {
    const durable = store(); let calls = 0; let gmTokens = null; let now = new Date('2026-09-09T12:00:00Z'); let prompt;
    const instance = new NightlyGM({ schedule: { enabled: true, timezone: 'UTC', localTime: '00:00' }, instructions: { revision: 'gm@1', content: 'Review.' }, store: durable,
      review: { review: async (request) => { calls += 1; prompt = JSON.parse(request.prompt); return { findingActions: [{ findingId: 'finding-1', action: 'retain', evidence: 'Still observed.' }], recommendations: [{ priority: 'low', findingId: 'finding-1', recommendation: 'Repair export.', expectedBenefit: 'Restore coverage.', evidence: ['loop:one'], nextAction: 'Inspect registration.' }] }; } },
      snapshot: async () => { const value = metrics(); value.overhead.gmReview = { attemptCount: gmTokens === null ? 0 : 1, tokens: gmTokens, unknownMeasurements: 0 }; return { findings: [finding()], metrics: value }; }, now: () => now });
    expect((await instance.run({ type: 'scheduled' })).status).toBe('completed');
    expect(prompt.outputContract.example).toMatchObject({ findingActions: [{ findingId: 'finding-1', action: 'retain', evidence: expect.any(String) }], recommendations: [{ priority: 'high', findingId: 'finding-1', evidence: [expect.any(String)], nextAction: expect.any(String) }] });
    expect(prompt.reviewInput.changedFindings).toHaveLength(1);
    gmTokens = 25; now = new Date('2026-09-10T12:00:00Z');
    expect((await instance.run({ type: 'scheduled' })).status).toBe('skipped_unchanged');
    expect(calls).toBe(1);
  });

  it('does not represent configuration alone as monitoring', () => {
    expect(projectGMNightlyState([], { enabled: true, timezone: 'UTC', localTime: '02:00' }, new Date('2026-09-09T01:00:00Z')).supervision).toBe('degraded');
    expect(projectGMNightlyState([], { enabled: false, timezone: 'UTC', localTime: '02:00' }).supervision).toBe('not_configured');
  });
});
