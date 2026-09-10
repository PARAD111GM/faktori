import { describe, expect, it } from 'vitest';
import { summarizeFactoryEfficiency } from '../../src/gm/index.ts';

const record = (session, total, references, extra = {}) => ({ source: `source-${session}`, agentId: session, sessionId: session, registeredSessionId: session, at: `2026-09-09T0${session.length}:00:00Z`, counters: { total }, references, ...extra });

describe('factory efficiency metrics', () => {
  it('globally deduplicates overlapping PR and feature identities and keeps ratios non-additive', () => {
    const references = { ticket: 'LEAN-1', pullRequest: 'pr-7', pullRequestMerged: true, feature: 'feature-7', deploymentAccepted: true };
    const metrics = summarizeFactoryEfficiency({ records: [record('a', 100, references, { workClass: 'delivery' }), record('bb', 50, references, { workClass: 'rework', attemptOutcome: 'failed' }), record('ccc', 25, references, { workClass: 'coordination' }), record('dddd', 40, { shared: true }, { workClass: 'coordination' })], summaries: [
      { id: 'one', status: 'succeeded', stale: false, claimedAt: '2026-09-09T01:00:00Z', localAcceptedAt: '2026-09-09T02:00:00Z', completedPhases: [], stages: [], references, delivery: { gates: [{ id: 'deployment', label: 'Deployment', status: 'passed', observedAt: '2026-09-09T03:00:00Z' }, { id: 'staging_verification', label: 'Staging', status: 'passed', observedAt: '2026-09-09T04:00:00Z' }], nextAction: { label: 'done', role: 'owner' } } },
      { id: 'two', status: 'failed', stale: false, completedPhases: [], stages: [], references },
    ] });
    expect(metrics.outcomes).toMatchObject({ localAccepted: 1, mergedPullRequests: { count: 1, tokensPerPullRequest: 175 }, deployed: 1, productAcceptedFeatures: { count: 1, tokensPerFeature: 175 } });
    expect(metrics.shares).toMatchObject({ rework: 50 / 175, coordination: 25 / 175 });
    expect(metrics.timing).toMatchObject({ claimToVerifiedAcceptanceMinutes: { sampleSize: 1, median: 180 }, acceptedToDeploymentMinutes: { sampleSize: 1, median: 60 } });
    expect(metrics.overhead.sharedTokens).toBe(40);
  });

  it('keeps outcome denominators and unavailable timestamps unknown instead of zero-cost', () => {
    const metrics = summarizeFactoryEfficiency({ records: [record('a', 472585, { ticket: 'proof' }), { source: 'missing', agentId: 'x', sessionId: 'x', registeredSessionId: 'x', telemetry: 'unknown' }], summaries: [{ id: 'proof', status: 'succeeded', stale: false, completedPhases: [], stages: [] }] });
    expect(metrics.outcomes.mergedPullRequests).toEqual({ count: 0, tokensPerPullRequest: null });
    expect(metrics.outcomes.productAcceptedFeatures).toEqual({ count: 0, tokensPerFeature: null });
    expect(metrics.timing.claimToVerifiedAcceptanceMinutes).toEqual({ sampleSize: 0, median: null });
    expect(metrics.coverage).toEqual({ registeredSessions: 2, usableSessions: 1, ratio: 0.5 });
  });

  it('includes distinct coordinator sessions in coverage and reports GM review usage separately', () => {
    const metrics = summarizeFactoryEfficiency(
      { records: [record('source', 100, { ticket: 'proof' })], summaries: [] },
      [record('coordinator', 25, { shared: true })],
      [{ source: 'coordinator', agentId: 'gm', sessionId: 'gm', registeredSessionId: 'gm', telemetry: 'unknown', references: { shared: true } }],
    );
    expect(metrics.usage.total).toBe(125);
    expect(metrics.coverage).toEqual({ registeredSessions: 2, usableSessions: 2, ratio: 1 });
    expect(metrics.overhead).toMatchObject({ sharedTokens: 25, gmReview: { attemptCount: 1, tokens: null, unknownMeasurements: 1 } });
  });
});
