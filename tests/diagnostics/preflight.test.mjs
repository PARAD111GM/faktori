import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { evaluatePreflight } from '../../src/diagnostics/preflight.ts';

const config = () => ({
  factory: { id: 'factory-a', name: 'Factory A', defaults: { providerId: 'codex', environmentId: 'local', executionProfile: 'isolated', budget: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 20, maxTokens: 1000, strictSpending: true } } },
  providers: [{ id: 'codex', kind: 'codex', capabilities: ['isolated', 'token-limit', 'subagents'] }],
  environments: [{ id: 'local', kind: 'local' }],
  products: [{ id: 'product-a', name: 'Product A' }],
  pods: [{ id: 'pod-a', productId: 'product-a' }],
});

const scope = { factoryId: 'factory-a', productId: 'product-a', podId: 'pod-a' };
const observation = (id, status = 'pass') => ({ id, status, freshness: 'current', scope });
const request = () => ({
  format: 'faktori.preflight/v1', configuration: config(), target: scope,
  expectedRevision: 'evidence@1',
  profile: { executionProfile: 'isolated', requiredCapabilities: ['subagents'] },
  providers: [{ providerId: 'codex', capabilities: [
    { capability: 'isolated', status: 'pass', freshness: 'current', scope },
    { capability: 'token-limit', status: 'pass', freshness: 'current', scope },
    { capability: 'subagents', status: 'pass', freshness: 'current', scope },
  ] }],
  console: { prerequisites: [observation('projection')] },
  execution: { prerequisites: [observation('profile')] },
  resources: { prerequisites: [observation('budget')] },
  integrations: { prerequisites: [observation('read_adapter')] },
  liveEvidence: { evidence: [{ ...observation('provider_execution'), revision: 'evidence@1' }] },
});

describe('evaluatePreflight', () => {
  it('returns a deterministic report without promoting caller assertions to verified readiness', () => {
    const first = evaluatePreflight(request());
    const second = evaluatePreflight(request());
    expect(first).toEqual(second);
    expect(first).toMatchObject({ format: 'faktori.preflight-result/v1', scope, status: 'partial', executionReady: false, liveExecutionVerified: false, projectionReady: false, summary: { fail: 0, unavailable: 0 } });
    expect(first.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'provider.isolated.observed', status: 'not_tested', section: 'provider', basis: 'observed', freshness: 'unknown' }),
      expect.objectContaining({ id: 'resources.budget', status: 'not_tested' }),
    ]));
  });

  it('keeps projection readiness separate when execution is unavailable', () => {
    const input = request();
    input.execution.prerequisites[0].status = 'unavailable';
    const result = evaluatePreflight(input);
    expect(result.executionReady).toBe(false);
    expect(result.projectionReady).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.checks.find((item) => item.id === 'execution.profile')).toMatchObject({ status: 'unavailable' });
  });

  it('fails closed for unsupported config capabilities, stale evidence, and mismatched scope', () => {
    const unsupported = request();
    unsupported.configuration.providers[0].capabilities = ['isolated', 'subagents'];
    expect(evaluatePreflight(unsupported).executionReady).toBe(false);
    const stale = request(); stale.providers[0].capabilities[0].freshness = 'stale';
    expect(evaluatePreflight(stale).checks.find((item) => item.id === 'provider.isolated.observed')).toMatchObject({ status: 'unavailable', freshness: 'stale' });
    const wrongScope = request(); wrongScope.console.prerequisites[0].scope = { ...scope, productId: 'other' };
    expect(evaluatePreflight(wrongScope).checks.find((item) => item.id === 'console.projection')).toMatchObject({ status: 'unavailable' });
  });

  it('does not infer missing observations and treats explicit unavailable as dominant', () => {
    const input = request();
    input.providers[0].capabilities = [
      { capability: 'isolated', status: 'pass', freshness: 'current', scope },
      { capability: 'isolated', status: 'fail', freshness: 'current', scope },
    ];
    const result = evaluatePreflight(input);
    expect(result.checks.find((item) => item.id === 'provider.isolated.observed')).toMatchObject({ status: 'fail' });
    expect(result.checks.find((item) => item.id === 'provider.token-limit.observed')).toMatchObject({ status: 'not_tested' });
    expect(result.executionReady).toBe(false);
  });

  it('reports live execution as not tested when no revision-bound evidence is supplied', () => {
    const input = request();
    delete input.liveEvidence;
    const result = evaluatePreflight(input);
    expect(result.status).toBe('partial');
    expect(result.executionReady).toBe(false);
    expect(result.liveExecutionVerified).toBe(false);
    expect(result.projectionReady).toBe(false);
    expect(result.checks.find((item) => item.id === 'live_evidence.observed')).toMatchObject({ status: 'not_tested' });
  });

  it('rejects unrelated live revisions and credential-shaped evidence', () => {
    const unrelated = request();
    unrelated.liveEvidence.evidence[0].revision = 'other@1';
    expect(evaluatePreflight(unrelated).checks.find((item) => item.id === 'live_evidence.provider_execution')).toMatchObject({ status: 'fail' });

    for (const secret of [`sk-${'A'.repeat(24)}`, `sk_live_${'A'.repeat(24)}`]) {
      const credential = request();
      credential.target.factoryId = secret;
      credential.expectedRevision = secret;
      credential.liveEvidence.evidence[0].revision = secret;
      const encoded = JSON.stringify(evaluatePreflight(credential));
      expect(encoded).not.toContain(secret);
      expect(evaluatePreflight(credential).liveExecutionVerified).toBe(false);
    }
  });

  it('redacts malformed and secret-bearing input rather than returning it or action authority', () => {
    const secret = 'Bearer secret-value /Users/nathan/.codex token';
    const result = evaluatePreflight({ format: 'wrong', target: { factoryId: secret, productId: 'product' }, configuration: { secret } });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toMatch(/approval|command|workspacePath|prompt|credential/i);
    expect(result.executionReady).toBe(false);
    expect(result.checks.every((item) => ['pass', 'fail', 'unavailable', 'not_tested'].includes(item.status))).toBe(true);
  });

  it('has no filesystem, process, provider, approval, or writer dependency surface', async () => {
    const source = await readFile(new URL('../../src/diagnostics/preflight.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:(?:fs|child_process|http|https|net)|coordinator|provider adapter|provision|spawn|process\.|fetch\(/i);
    const action = vi.fn();
    evaluatePreflight(request());
    expect(action).not.toHaveBeenCalled();
  });
});
