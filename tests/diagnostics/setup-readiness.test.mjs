import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { evaluateSetupReadiness } from '../../src/diagnostics/setup-readiness.ts';
import { parseLocalConsoleConfiguration } from '../../src/console/startup.ts';

function localConsole(overrides = {}) {
  return {
    factoryId: 'solo-studio',
    journalPath: '/private/tmp/faktori-operations.jsonl',
    projectionPath: '/private/tmp/faktori-projection.sqlite',
    port: 0,
    allowedOrigins: ['http://127.0.0.1:4173'],
    limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 0, strictSpending: false, strictSpendingSupported: false },
    managerLoops: [],
    runtime: {
      providers: [{ id: 'codex', profile: 'native', environment: { PATH: '/usr/bin' }, compatibleModels: ['fixture'], runNonce: 'setup-readiness', contextIsolation: 'bounded' }],
      workItems: [],
      resumePlans: [],
    },
    ...overrides,
  };
}

describe('evaluateSetupReadiness', () => {
  it('flags absent GM scheduling, Jira, and provider catalog instead of treating optional omissions as complete', () => {
    const result = evaluateSetupReadiness(parseLocalConsoleConfiguration(localConsole()), {});

    expect(result).toMatchObject({
      format: 'faktori.setup-readiness-result/v1',
      status: 'blocked',
      complete: false,
      summary: { configured: 1, verified: 0, unavailable: 4, deferred: 0 },
    });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gm.scheduling', status: 'unavailable' }),
      expect.objectContaining({ id: 'jira.sources', status: 'unavailable' }),
      expect.objectContaining({ id: 'providers.catalog', status: 'unavailable' }),
      expect.objectContaining({ id: 'providers.runtime_routes', status: 'configured' }),
    ]));
    expect(result.providerSelection).toEqual([
      { id: 'codex', selected: false, runtimeRoute: true },
      { id: 'claude', selected: false, runtimeRoute: false },
      { id: 'cursor', selected: false, runtimeRoute: false },
    ]);
  });

  it('distinguishes a configured Jira source and auth environment presence from verified Jira access, and finds catalog-only provider routes', async () => {
    const configuration = JSON.parse(await readFile(resolve('examples/config/nightly-gm.json'), 'utf8'));
    configuration.factoryConfiguration = JSON.parse(await readFile(resolve('examples/config/solo.json'), 'utf8'));
    configuration.factoryConfiguration.factory.id = 'example-factory';
    configuration.factoryConfiguration.providers.push({ id: 'claude-review', kind: 'claude-code', capabilities: ['native'] });
    configuration.factoryConfiguration.factory.defaults.budget.strictSpending = false;
    configuration.jiraSources = [{ id: 'factory-board', baseUrl: 'https://example.atlassian.net', projectKey: 'FACTORY', authorizationEnv: 'FAKTORI_JIRA_AUTH' }];

    const secret = 'Bearer private-jira-credential';
    const result = evaluateSetupReadiness(parseLocalConsoleConfiguration(configuration), { FAKTORI_JIRA_AUTH: secret });

    expect(result).toMatchObject({ complete: false, summary: { verified: 0 } });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gm.scheduling', status: 'configured' }),
      expect.objectContaining({ id: 'jira.factory-board.project_source', status: 'configured' }),
      expect.objectContaining({ id: 'jira.factory-board.authorization_environment', status: 'configured' }),
      expect.objectContaining({ id: 'provider.codex.runtime_route', status: 'configured' }),
      expect.objectContaining({ id: 'provider.claude-review.runtime_route', status: 'unavailable' }),
    ]));
    expect(result.providerSelection).toEqual(expect.arrayContaining([
      { id: 'codex', selected: true, runtimeRoute: true },
      { id: 'claude', selected: true, runtimeRoute: false },
      { id: 'cursor', selected: false, runtimeRoute: false },
    ]));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toMatch(/commandToken|runNonce|environment"\s*:/i);
  });
});
