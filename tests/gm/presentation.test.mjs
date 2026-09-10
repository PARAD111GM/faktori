import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Factory, Overview } from '../../console/src/main.tsx';

describe('LEAN-06 Console surface', () => {
  it('shows degraded supervision, qualified unknowns, and problem-owner-next action without unsafe authority controls', () => {
    const state = { factoryGM: { nightly: { configured: true, supervision: 'degraded', schedule: { enabled: true, timezone: 'America/Chicago', localTime: '02:00' } }, efficiency: { cohort: { sourceCount: 6, recordCount: 9 }, usage: { total: 472585, unknownMeasurements: 1 }, coverage: { registeredSessions: 10, usableSessions: 9, ratio: 0.9 }, outcomes: { localAccepted: 2, mergedPullRequests: { count: 0, tokensPerPullRequest: null }, deployed: 0, productAcceptedFeatures: { count: 0, tokensPerFeature: null } }, shares: { rework: 0.2, coordination: 0.1 }, timing: { claimToVerifiedAcceptanceMinutes: { sampleSize: 0, median: null }, acceptedToDeploymentMinutes: { sampleSize: 0, median: null, stillWaiting: 2 } }, unfinishedOrAbandoned: { recordCount: 1, tokens: 10 }, overhead: { sharedTokens: null, unattributedTokens: null }, quality: { humanInterventions: null, reopened: null, regressions: null }, qualification: ['Tokens per merged PR unavailable.'] }, findings: [{ findingId: 'one', category: 'environment_failure', classification: 'infrastructure', latestSummary: 'Provider executable prerequisite is missing.', accountableRole: 'factory_operator', nextAction: { label: 'Repair the registered prerequisite.', control: 'open_factory' }, ownerAttention: 'owner_once', diagnosis: { state: 'not_needed' } }], improvements: [] }, resources: {} };
    state.factoryGM.nightly.lastSuccessfulReview = { completedAt: '2026-09-09T12:00:00Z', result: { recommendations: [{ priority: 'high', findingId: 'one', recommendation: 'Repair <provider> route.', expectedBenefit: 'Restore measured coverage.', evidence: ['preflight:provider_executable'], nextAction: 'Factory operator verifies the route.', authority: 'proposal_only' }] } };
    const html = renderToStaticMarkup(createElement(Factory, { state, runs: [], submit() {} }));
    expect(html).toContain('degraded'); expect(html).toContain('Configuration alone is not monitoring proof'); expect(html).toContain('6 sources · 9 records'); expect(html).toContain('Tokens / merged PR</span><strong>Unavailable'); expect(html).toContain('Owner: factory operator · Next: Repair the registered prerequisite.'); expect(html).toContain('infrastructure'); expect(html).not.toContain('Approve merge');
    expect(html).toContain('Latest GM review'); expect(html).toContain('proposal only'); expect(html).toContain('Repair &lt;provider&gt; route.'); expect(html).toContain('Expected benefit: Restore measured coverage.'); expect(html).toContain('Evidence: preflight:provider_executable'); expect(html).toContain('Next: Factory operator verifies the route.'); expect(html).not.toContain('Repair <provider> route.');
  });

  it('keeps Overview limited to cross-project facts and leaves activity to Work', () => {
    const activity = Array.from({ length: 10 }, (_, index) => ({ id: String(index), at: `2026-09-09T00:00:${String(index).padStart(2, '0')}Z`, source: 'loop', summary: `event-${index}` }));
    const html = renderToStaticMarkup(createElement(Overview, { state: { activity, managerLoops: [] }, runs: [], selectRun() {} }));
    expect(html).toContain('At a glance');
    expect(html).toContain('Cross-project catalog facts, not live activity.');
    expect(html).not.toContain('activity-source');
    expect(html).not.toContain('event-9');
    expect(html).not.toContain('Open Work for the expanded activity feed');
  });
});
