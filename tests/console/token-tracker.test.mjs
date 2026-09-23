import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
let server;

beforeAll(async () => {
  server = await createServer({ root, configFile: false, logLevel: 'silent', server: { middlewareMode: true } });
});

afterAll(async () => { await server?.close(); });

describe('Console token tracker', () => {
  it('deduplicates repeated stage observations and keeps cached input out of the total', async () => {
    const { summarizeTokenTrackerRoles, trackerRoleCoverage } = await server.ssrLoadModule('/console/src/token-tracker.tsx');
    const build = { phaseId: 'feature', kind: 'implement', round: 0, outcome: 'completed', completedAt: '2026-09-12T12:00:00Z', usage: { availability: 'reported', inputTokens: 100, cachedInputTokens: 60, outputTokens: 10 } };
    const loops = [{ id: 'loop-one', stages: [build, build] }];
    const roles = summarizeTokenTrackerRoles(loops);
    expect(roles.find((item) => item.role === 'build')).toMatchObject({ receiptCount: 1, usage: { input: 100, cached: 60, uncachedInput: 40, output: 10, total: 110 } });
    expect(trackerRoleCoverage(loops)).toMatchObject({ receiptUsage: { total: 110 }, coverage: { registeredObservations: 2, usableObservations: 2, ratio: 1 } });
  });

  it('leaves incomplete cached partitions and unavailable telemetry unknown', async () => {
    const { summarizeTokenTrackerRoles } = await server.ssrLoadModule('/console/src/token-tracker.tsx');
    const loops = [{ id: 'loop-one', stages: [
      { phaseId: 'feature', kind: 'implement', round: 0, outcome: 'completed', completedAt: '2026-09-12T12:00:00Z', usage: { availability: 'reported', inputTokens: 100, outputTokens: 10 } },
      { phaseId: 'feature', kind: 'review', round: 0, outcome: 'completed', completedAt: '2026-09-12T12:01:00Z', usage: { availability: 'unavailable' } },
    ] }];
    const roles = summarizeTokenTrackerRoles(loops);
    expect(roles.find((item) => item.role === 'build')?.usage).toMatchObject({ input: 100, cached: null, uncachedInput: null, output: 10, total: 110 });
    expect(roles.find((item) => item.role === 'review')?.usage).toMatchObject({ total: null, unknownMeasurements: 1 });
  });

  it('keeps build, coordination, review, and repair categories separately summed', async () => {
    const { TokenTracker, summarizeTokenTrackerRoles } = await server.ssrLoadModule('/console/src/token-tracker.tsx');
    const loops = [{ id: 'loop-one', productId: 'product-a', podId: 'pod-a', status: 'running', stages: [
      { phaseId: 'one', kind: 'manager_brief', round: 0, outcome: 'completed', completedAt: '2026-09-12T12:00:00Z', usage: { availability: 'reported', inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 } },
      { phaseId: 'one', kind: 'implement', round: 0, outcome: 'completed', completedAt: '2026-09-12T12:01:00Z', usage: { availability: 'reported', inputTokens: 20, cachedInputTokens: 5, outputTokens: 2 } },
      { phaseId: 'one', kind: 'review', round: 0, outcome: 'completed', completedAt: '2026-09-12T12:02:00Z', usage: { availability: 'reported', inputTokens: 30, cachedInputTokens: 10, outputTokens: 3 } },
      { phaseId: 'one', kind: 'repair', round: 1, outcome: 'completed', completedAt: '2026-09-12T12:03:00Z', usage: { availability: 'reported', inputTokens: 40, cachedInputTokens: 20, outputTokens: 4 } },
    ] }];
    const roles = summarizeTokenTrackerRoles(loops);
    expect(Object.fromEntries(roles.map((item) => [item.role, item.usage.total]))).toEqual({ build: 22, coordination: 11, review: 33, repair: 44 });
    const html = renderToStaticMarkup(createElement(TokenTracker, { loops, efficiency: { usage: { input: 100, cached: 35, uncachedInput: 65, output: 10, total: 110, unknownMeasurements: 0 }, coverage: { registeredObservations: 4, usableObservations: 4, ratio: 1 } } }));
    expect(html).toContain('Project: product-a · Scope: pod-a · Model: not recorded');
    expect(html).toContain('Cached input is already part of input and is never added again.');
    expect(html).toContain('Coverage is only for registered Manager Loop observations, not the whole factory');
    expect(html).toContain('not invoices, savings, or product acceptance');
  });

  it('uses the loop-only tracker projection instead of broader factory efficiency usage', async () => {
    const { Factory } = await server.ssrLoadModule('/console/src/main.tsx');
    const state = {
      managerLoops: [],
      tokenTracker: { usage: { input: 100, cached: 20, uncachedInput: 80, output: 10, total: 110, unknownMeasurements: 0 }, coverage: { registeredObservations: 1, usableObservations: 1, ratio: 1 } },
      factoryGM: { efficiency: { cohort: { sourceCount: 2, recordCount: 2 }, usage: { total: 999, unknownMeasurements: 0 }, coverage: { registeredSessions: 2, usableSessions: 2, ratio: 1 }, quota: { status: 'unknown', observedSources: 0 }, outcomes: { localAccepted: 0, mergedPullRequests: { count: 0, tokensPerPullRequest: null }, deployed: 0, productAcceptedFeatures: { count: 0, tokensPerFeature: null } }, shares: { rework: null, coordination: null }, timing: { claimToVerifiedAcceptanceMinutes: { sampleSize: 0, median: null }, acceptedToDeploymentMinutes: { sampleSize: 0, median: null, stillWaiting: 0 } }, unfinishedOrAbandoned: { recordCount: 0, tokens: null }, overhead: { sharedTokens: null, unattributedTokens: null, gmReview: { attemptCount: 0, tokens: null, unknownMeasurements: 0 } }, quality: { humanInterventions: null, reopened: null, regressions: null }, qualification: [] } },
    };
    const html = renderToStaticMarkup(createElement(Factory, { state, runs: [], submit() {} }));
    expect(html).toContain('<dt>Measured total</dt><dd>110</dd>');
    expect(html).toContain('Measured tokens</span><strong>999</strong>');
    expect(html).toContain('Coverage is only for registered Manager Loop observations, not the whole factory');
  });
});
