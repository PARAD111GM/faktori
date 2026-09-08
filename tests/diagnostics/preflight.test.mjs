import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { evaluatePreflight } from '../../src/diagnostics/preflight.ts';
import { evaluateInstalledPreflight } from '../../src/diagnostics/local-preflight.ts';
import { SqliteProjection } from '../../src/runtime/sqlite-projection.ts';

const config = () => ({
  factory: { id: 'factory-a', name: 'Factory A', defaults: { providerId: 'codex', environmentId: 'local', executionProfile: 'isolated', budget: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 20, maxTokens: 1000, strictSpending: true } } },
  providers: [{ id: 'codex', kind: 'codex', capabilities: ['isolated', 'token-limit', 'subagents'] }],
  environments: [{ id: 'local', kind: 'local' }],
  products: [{ id: 'product-a', name: 'Product A' }],
  pods: [{ id: 'pod-a', productId: 'product-a' }],
});

const scope = { factoryId: 'factory-a', productId: 'product-a', podId: 'pod-a' };
const observation = (id, status = 'pass') => ({ id, status, freshness: 'current', scope });
const runIntent = (factoryId) => ({
  format: 'faktori.run-intent/v1', runId: 'run', admissionKey: 'admission',
  workItem: { id: 'work', revision: 'work@1' },
  target: { factoryId, productId: scope.productId, podId: scope.podId, repository: 'org/repo', branch: 'work', baseRevision: 'base@1', expectedRevision: 'head@1' },
  context: { packetRevision: 'packet@1', digest: 'a'.repeat(64) },
  execution: { profile: 'isolated', workspaceId: 'workspace', workspacePath: '/private/tmp/workspace', providerId: 'codex', model: 'fixture', approvedInputDigests: [] },
  budget: { reservationId: 'reservation', maxRuntimeMinutes: 5, estimatedTokens: 1000, status: 'held' },
  authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'b'.repeat(64), policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
  attempt: 1, createdAt: '2026-09-07T00:00:00.000Z',
});
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

  it('cannot be given a forged trusted projection observation through the core API', () => {
    const result = evaluatePreflight(request(), { factoryId: scope.factoryId, projection: 'ready' });
    expect(result).toMatchObject({ projectionReady: false, executionReady: false, liveExecutionVerified: false });
    expect(result.checks.find((item) => item.id === 'console.installed_projection')).toMatchObject({ status: 'not_tested', basis: 'not_observed' });
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
    const wrongScope = request(); wrongScope.execution.prerequisites[0].scope = { ...scope, productId: 'other' };
    expect(evaluatePreflight(wrongScope).checks.find((item) => item.id === 'execution.profile')).toMatchObject({ status: 'unavailable' });
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

  it('marks an actual installed projection ready while execution and live evidence remain unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-preflight-'));
    const projectionPath = join(directory, 'projection.sqlite');
    const projection = new SqliteProjection(projectionPath);
    projection.apply({ format: 'faktori.run-event/v1', eventId: 'admitted', runId: 'run', occurredAt: '2026-09-07T00:00:00.000Z', kind: 'run.admitted', data: { intent: runIntent(scope.factoryId) } });
    projection.close();
    try {
      const result = evaluateInstalledPreflight(request(), { factoryId: scope.factoryId, projectionPath });
      expect(result).toMatchObject({ status: 'partial', projectionReady: true, executionReady: false, liveExecutionVerified: false });
      expect(result.checks.find((item) => item.id === 'console.installed_projection')).toMatchObject({ status: 'pass', basis: 'observed', freshness: 'current' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an installed projection containing a different factory scope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-preflight-scope-'));
    const projectionPath = join(directory, 'projection.sqlite');
    const projection = new SqliteProjection(projectionPath);
    projection.apply({ format: 'faktori.run-event/v1', eventId: 'admitted', runId: 'run', occurredAt: '2026-09-07T00:00:00.000Z', kind: 'run.admitted', data: { intent: runIntent('other-factory') } });
    projection.close();
    try {
      const result = evaluateInstalledPreflight(request(), { factoryId: scope.factoryId, projectionPath });
      expect(result).toMatchObject({ status: 'blocked', projectionReady: false });
      expect(result.checks.find((item) => item.id === 'console.installed_projection').remediation).toMatch(/invalid local SQLite projection/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a missing installed projection with specific nonexecuting remediation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-preflight-missing-'));
    try {
      const result = evaluateInstalledPreflight(request(), { factoryId: scope.factoryId, projectionPath: join(directory, 'missing.sqlite') });
      const check = result.checks.find((item) => item.id === 'console.installed_projection');
      expect(result).toMatchObject({ status: 'blocked', projectionReady: false, executionReady: false, liveExecutionVerified: false });
      expect(check).toMatchObject({ status: 'fail' });
      expect(check.remediation).toMatch(/authoritative journal.*faktori runtime rebuild/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it('never emits credential-shaped prerequisite or live-evidence identifiers', () => {
    const secretId = `sk-${'A'.repeat(24)}`;
    const input = request();
    input.console.prerequisites[0].id = secretId;
    input.liveEvidence.evidence[0].id = secretId;
    const encoded = JSON.stringify(evaluatePreflight(input));
    expect(encoded).not.toContain(secretId);
    expect(encoded).toContain('live_evidence.invalid_input');
  });

  it('has no filesystem, process, provider, approval, or writer dependency surface', async () => {
    const source = await readFile(new URL('../../src/diagnostics/preflight.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:(?:fs|child_process|http|https|net)|coordinator|provider adapter|provision|spawn|process\.|fetch\(/i);
    const action = vi.fn();
    evaluatePreflight(request());
    expect(action).not.toHaveBeenCalled();
  });
});
