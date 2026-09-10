import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLocalConsoleConfiguration } from '../../src/console/startup.ts';
import { createConsoleSettings } from '../../src/console/settings.ts';
import { renderLocalGMScheduler } from '../../src/gm/index.ts';

const examplePath = resolve('examples/config/nightly-gm.json');

describe('local nightly GM scheduler contract', () => {
  it('parses the complete example and renders inert timezone-aware launchd and systemd polling definitions', async () => {
    const configuration = parseLocalConsoleConfiguration(JSON.parse(await readFile(examplePath, 'utf8')));
    expect(configuration.runtime.gm).toMatchObject({ mode: 'nightly', schedule: { enabled: true, timezone: 'America/Chicago', localTime: '02:00' }, reviewRoutes: [{ intent: { workItem: { role: 'gm' } } }] });
    expect(createConsoleSettings(configuration).generalManager).toEqual({ mode: 'nightly', reviewRouteCount: 1, schedule: { enabled: true, timezone: 'America/Chicago', localTime: '02:00' }, deliveryDeadlineHours: 48 });
    const launchd = await renderLocalGMScheduler(examplePath, 'launchd', '/usr/local/bin/node', '/usr/local/lib/faktori/dist/cli.js');
    expect(launchd).toMatchObject({ platform: 'launchd', installed: false, pollingIntervalSeconds: 900, timezone: 'America/Chicago' });
    expect(launchd.definition).toContain('<string>--scheduled</string>');
    const linux = await renderLocalGMScheduler(examplePath, 'systemd', '/usr/bin/node', '/usr/lib/faktori/dist/cli.js');
    expect(linux).toMatchObject({ platform: 'systemd', installed: false, note: expect.stringContaining('not exercised on macOS') });
    expect(linux.timer).toContain('OnUnitActiveSec=15m');
  });

  it('retains the legacy diagnosisTemplate as the single nightly review-route fallback', () => {
    const intent = { format: 'faktori.run-intent/v1', runId: 'template', admissionKey: 'template', workItem: { id: 'gm', revision: '1' }, target: { factoryId: 'factory', productId: 'ops', repository: 'o/r', branch: 'main', baseRevision: 'a', expectedRevision: 'b' }, context: { packetRevision: '1', digest: 'x' }, execution: { profile: 'native', workspaceId: 'gm', workspacePath: '/tmp/gm', providerId: 'codex', model: 'cheap', approvedInputDigests: [] }, budget: { reservationId: 'x', maxRuntimeMinutes: 1, estimatedTokens: 0, status: 'held' }, authority: { authorityRevision: '1', epoch: 1, scopeDigest: 'x', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } }, attempt: 1, createdAt: '2026-09-09T00:00:00Z' };
    const parsed = parseLocalConsoleConfiguration({ factoryId: 'factory', journalPath: '/tmp/factory.jsonl', projectionPath: '/tmp/factory.sqlite', port: 4173, commandToken: 'private', allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 1, maxTokens: 0, strictSpending: false, strictSpendingSupported: false }, managerLoops: [], runtime: { providers: [{ id: 'codex', profile: 'native', environment: { PATH: '/usr/bin' }, compatibleModels: ['cheap'], runNonce: 'one', contextIsolation: 'bounded' }], workItems: [], resumePlans: [], gm: { mode: 'nightly', instructions: { revision: '1', content: 'Review only.' }, diagnosisTemplate: { intent }, schedule: { enabled: true, timezone: 'UTC', localTime: '00:00' } } } });
    expect(parsed.runtime.gm.reviewRoutes).toHaveLength(1);
    expect(parsed.runtime.gm.diagnosisTemplate.intent).toEqual(intent);
  });

  it('rejects GM templates that cannot fit the configured adapter limits before startup', async () => {
    const base = JSON.parse(await readFile(examplePath, 'utf8'));
    const cases = [
      { field: 'token', change: (config) => { config.runtime.gm.reviewRoutes[0].intent.budget.estimatedTokens = 20_000; }, message: /budget\.estimatedTokens must fit limits\.maxTokens \(0\)/ },
      { field: 'runtime', change: (config) => { config.limits.maxRuntimeMinutes = 9; }, message: /budget\.maxRuntimeMinutes must fit limits\.maxRuntimeMinutes \(9\)/ },
      { field: 'retry', change: (config) => { config.runtime.gm.reviewRoutes[0].intent.attempt = 2; }, message: /intent\.attempt must be between 1 and limits\.maxRetries \+ 1 \(1\)/ },
    ];
    for (const candidate of cases) {
      const config = structuredClone(base);
      candidate.change(config);
      expect(() => parseLocalConsoleConfiguration(config), candidate.field).toThrow(candidate.message);
    }
  });
});
