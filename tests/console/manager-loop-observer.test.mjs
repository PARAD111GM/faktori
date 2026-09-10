import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ManagerLoopObserver } from '../../src/console/manager-loop-observer.ts';
import { createConsoleService } from '../../src/console/service.ts';
import { parseLocalConsoleConfiguration } from '../../src/console/startup.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

function loopState(overrides = {}) {
  return {
    format: 'faktori.manager-loop-state/v1',
    loopId: 'two-phase-math-proof',
    configDigest: 'not-projected',
    status: 'running',
    completedPhases: ['arithmetic'],
    stages: [{
      stageId: 'not-projected', phaseId: 'arithmetic', kind: 'review', round: 0,
      outcome: 'completed', response: { verdict: 'pass', summary: 'not projected' },
      verification: [{ command: 'node', args: ['--test'], passed: true, summary: 'not projected' }],
      sessionId: 'not-projected', evidence: { contentDigest: 'not-projected' }, completedAt: '2026-09-09T12:00:00.000Z',
    }],
    currentStage: { stageId: 'not-projected', phaseId: 'geometry', kind: 'implement', round: 0, intendedAt: '2026-09-09T12:01:00.000Z' },
    implementerSessions: { geometry: { sessionId: 'not-projected' } },
    updatedAt: '2026-09-09T12:01:00.000Z',
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'faktori-manager-loop-console-'));
  const artifacts = join(root, 'artifacts');
  await mkdir(artifacts);
  const coordinator = await DurableCoordinator.open({
    factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'),
    identity: { instanceId: 'observer-test', pid: 101, processStartedAt: 'now' },
    limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 0, strictSpending: false, strictSpendingSupported: false },
  });
  await coordinator.claim();
  return { root, artifacts, coordinator };
}

async function waitFor(read, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Manager Loop projection');
}

describe('Manager Loop Console observer', () => {
  it('projects reported and unavailable stage telemetry through shared lower-bound accounting and outcome cohorts', async () => {
    const { root, artifacts, coordinator } = await fixture();
    await writeFile(join(artifacts, 'state.json'), JSON.stringify(loopState({
      status: 'failed', currentStage: undefined,
      stages: [
        { stageId: 'failed-implement', phaseId: 'arithmetic', kind: 'implement', round: 0, outcome: 'failed', completedAt: '2026-09-09T12:00:00Z', evidence: {}, sessionId: 'resume-1', usage: { availability: 'reported', inputTokens: 80, cachedInputTokens: 30, outputTokens: 20, reasoningTokens: 10 } },
        { stageId: 'unavailable-review', phaseId: 'arithmetic', kind: 'review', round: 0, outcome: 'completed', completedAt: '2026-09-09T12:01:00Z', evidence: {}, usage: { availability: 'unavailable', unavailableReason: 'provider did not emit telemetry' } },
      ],
    })));
    const observer = new ManagerLoopObserver({ sources: [{ id: 'two-phase-math-proof', artifactsDirectory: artifacts, references: { ticket: 'LEAN-01', pullRequest: 'pr-1', pullRequestMerged: true, feature: 'feature-1', deploymentAccepted: true } }] });
    try {
      await observer.poll();
      const summary = observer.summaries()[0];
      expect(summary.usage).toEqual({ input: 80, uncachedInput: 50, output: 20, cached: 30, reasoning: 10, total: 100, excludedChildCount: 0, unknownMeasurements: 1 });
      expect(summary.outcomes).toMatchObject({ mergedPullRequests: { count: 0 }, deploymentAcceptedFeatures: { count: 0 }, failedAttempts: { usage: { total: 100 } }, coverage: { registeredSessions: 2, usableSessions: 1, ratio: 0.5 } });
      expect(JSON.stringify(summary)).not.toMatch(/resume-1|provider did not emit/);
    } finally { observer.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('uses validated delivery receipts for merged and product-accepted cohorts, never a deployment receipt alone', async () => {
    const { root, artifacts, coordinator } = await fixture();
    const digest = `sha256:${'a'.repeat(64)}`;
    const commit = 'b'.repeat(40);
    const stage = { stageId: 'implementation', phaseId: 'arithmetic', kind: 'implement', round: 0, outcome: 'failed', completedAt: '2026-09-09T12:00:00Z', evidence: {}, usage: { availability: 'reported', inputTokens: 40, cachedInputTokens: 10, outputTokens: 10 } };
    const acceptance = { stageId: 'acceptance', phaseId: 'arithmetic', kind: 'manager_accept', round: 0, outcome: 'completed', completedAt: '2026-09-09T12:01:00Z', evidence: { contentDigest: digest }, usage: { availability: 'unavailable', unavailableReason: 'not emitted' }, response: { accepted: true } };
    await writeFile(join(artifacts, 'state.json'), JSON.stringify(loopState({ status: 'succeeded', currentStage: undefined, stages: [stage, acceptance] })));
    await writeFile(join(artifacts, 'publication.json'), JSON.stringify({ format: 'faktori.loop-publication-receipt/v1', status: 'published', loop: { loopId: 'two-phase-math-proof', acceptedEvidenceDigest: digest }, binding: { repository: 'example/product', branch: 'feature', baseRefName: 'main', expectedRevision: commit }, pr: { number: 1, url: 'https://github.com/example/product/pull/1', headRefName: 'feature', baseRefName: 'main', headRefOid: commit } }));
    const delivery = (staging) => ({ format: 'faktori.loop-delivery/v1', loopId: 'two-phase-math-proof', acceptedEvidenceDigest: digest, reviewedCommit: commit, gates: [
      { id: 'review', status: 'passed', evidenceUrl: 'https://example.com/review', recordedBy: 'owner', observedAt: '2026-09-09T12:02:00Z' },
      { id: 'merge', status: 'passed', evidenceUrl: 'https://example.com/merge', recordedBy: 'owner', observedAt: '2026-09-09T12:03:00Z' },
      { id: 'deployment', status: 'passed', evidenceUrl: 'https://example.com/deploy', recordedBy: 'owner', observedAt: '2026-09-09T12:04:00Z' },
      { id: 'staging_verification', status: staging, evidenceUrl: 'https://example.com/staging', recordedBy: 'owner', observedAt: '2026-09-09T12:05:00Z' },
    ] });
    await writeFile(join(artifacts, 'delivery.json'), JSON.stringify(delivery('pending')));
    const observer = new ManagerLoopObserver({ sources: [{ id: 'two-phase-math-proof', artifactsDirectory: artifacts, references: { pullRequest: 'pr-1', feature: 'feature-1' } }] });
    try {
      await observer.poll();
      expect(observer.summaries()[0].outcomes).toMatchObject({ mergedPullRequests: { count: 1, usage: { total: 50 } }, deploymentAcceptedFeatures: { count: 0 } });
      await writeFile(join(artifacts, 'delivery.json'), JSON.stringify(delivery('passed')));
      await observer.poll();
      expect(observer.summaries()[0].outcomes).toMatchObject({ mergedPullRequests: { count: 1, usage: { total: 50 } }, deploymentAcceptedFeatures: { count: 1, usage: { total: 50 } } });
    } finally { observer.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('counts a current recorded stage as unknown coverage and keeps prior loop spend visible as WIP', async () => {
    const { root, artifacts, coordinator } = await fixture();
    await writeFile(join(artifacts, 'state.json'), JSON.stringify(loopState({
      stages: [{ stageId: 'brief', phaseId: 'arithmetic', kind: 'manager_brief', round: 0, outcome: 'completed', completedAt: '2026-09-09T12:00:00Z', evidence: {}, usage: { availability: 'reported', inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 } }],
    })));
    const observer = new ManagerLoopObserver({ sources: [{ id: 'two-phase-math-proof', artifactsDirectory: artifacts }] });
    try {
      await observer.poll();
      expect(observer.summaries()[0].outcomes).toMatchObject({ workInProgress: { recordCount: 2, usage: { total: 30 } }, coverage: { registeredSessions: 2, usableSessions: 1, ratio: 0.5 } });
    } finally { observer.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('refreshes publication evidence even when the accepted loop state does not change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-observer-'));
    const digest = `sha256:${'a'.repeat(64)}`;
    const commit = 'b'.repeat(40);
    await writeFile(join(root, 'state.json'), JSON.stringify(loopState({
      status: 'succeeded', currentStage: undefined,
      stages: [{ stageId: 'accepted', phaseId: 'arithmetic', kind: 'manager_accept', round: 0, outcome: 'completed', completedAt: '2026-09-09T12:00:00Z', evidence: { contentDigest: digest } }],
    })));
    const observer = new ManagerLoopObserver({ sources: [{ id: 'two-phase-math-proof', artifactsDirectory: root }] });
    try {
      await observer.poll();
      expect(observer.summaries()[0].delivery.nextAction.label).toBe('Awaiting publication');
      await writeFile(join(root, 'publication.json'), JSON.stringify({
        format: 'faktori.loop-publication-receipt/v1', status: 'published',
        loop: { loopId: 'two-phase-math-proof', acceptedEvidenceDigest: digest },
        binding: { repository: 'example/product', branch: 'feature', baseRefName: 'main', expectedRevision: commit },
        pr: { number: 1, url: 'https://github.com/example/product/pull/1', headRefName: 'feature', baseRefName: 'main', headRefOid: commit },
      }));
      await observer.poll();
      expect(observer.summaries()[0].delivery.nextAction).toEqual({ label: 'Awaiting external review', role: 'reviewer', url: 'https://github.com/example/product/pull/1' });
      await writeFile(join(root, 'delivery.json'), '{malformed');
      await observer.poll();
      expect(observer.summaries()[0].delivery.nextAction.label).toBe('Reconcile delivery evidence');
      expect(observer.summaries()[0].delivery.gates.slice(2).every((gate) => gate.status === 'unobserved')).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('projects sanitized recorded state and streams real file updates without exposing controller records', async () => {
    const { root, artifacts, coordinator } = await fixture();
    await writeFile(join(artifacts, 'state.json'), `${JSON.stringify(loopState())}\n`);
    const observer = new ManagerLoopObserver({ sources: [{ id: 'two-phase-math-proof', artifactsDirectory: artifacts, productId: 'math', podId: 'proof-pod' }], pollIntervalMs: 10 });
    const app = createConsoleService({ coordinator, commandToken: 'secret', allowedOrigins: ['http://127.0.0.1:4173'], managerLoopObserver: observer });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const initialState = await waitFor(
        () => app.inject({ method: 'GET', url: '/api/console/state' }).then((response) => response.json()),
        (state) => state.managerLoops[0]?.status === 'running',
      );
      expect(initialState.managerLoops).toMatchObject([{
        id: 'two-phase-math-proof', productId: 'math', podId: 'proof-pod', status: 'running', stale: false,
        updatedAt: '2026-09-09T12:01:00.000Z', completedPhases: ['arithmetic'],
        currentStage: { phaseId: 'geometry', kind: 'implement', round: 0 },
        delivery: {
          gates: ['local_acceptance', 'publication', 'review', 'merge', 'deployment', 'staging_verification'].map((id, index) => ({
            id, label: ['Local acceptance', 'Publication', 'External review', 'Merge', 'Deployment', 'Staging verification'][index], status: index === 0 ? 'pending' : 'unobserved',
          })),
          nextAction: { label: 'Awaiting local acceptance', role: 'manager' },
        },
        stages: [{ phaseId: 'arithmetic', kind: 'review', round: 0, outcome: 'completed', completedAt: '2026-09-09T12:00:00.000Z', decision: 'pass', verification: 'passed' }],
      }]);
      expect(JSON.stringify(initialState.managerLoops)).not.toMatch(/artifacts|session|prompt|stageId|contentDigest|node|--test/);

      const response = await fetch(`${address}/api/console/events`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      await reader.read();
      await writeFile(join(artifacts, 'state.json'), `${JSON.stringify(loopState({ status: 'succeeded', currentStage: undefined, completedPhases: ['arithmetic', 'geometry'], updatedAt: '2026-09-09T12:02:00.000Z' }))}\n`);
      const update = await Promise.race([
        reader.read().then((item) => decoder.decode(item.value)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SSE update timeout')), 1_000)),
      ]);
      expect(update).toContain('"status":"succeeded"');
      expect(update).toContain('"completedPhases":["arithmetic","geometry"]');
      await reader.cancel();
    } finally {
      await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it('emits a stale transition for old recorded running activity without claiming process liveness', async () => {
    const { root, artifacts, coordinator } = await fixture();
    await writeFile(join(artifacts, 'state.json'), `${JSON.stringify(loopState())}\n`);
    let observedNow = Date.now();
    const observer = new ManagerLoopObserver({ sources: [{ id: 'two-phase-math-proof', artifactsDirectory: artifacts }], pollIntervalMs: 10, staleAfterMs: 25, now: () => new Date(observedNow) });
    const app = createConsoleService({ coordinator, commandToken: 'secret', allowedOrigins: ['http://127.0.0.1:4173'], managerLoopObserver: observer });
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      await waitFor(() => app.inject({ method: 'GET', url: '/api/console/state' }).then((response) => response.json()), (state) => state.managerLoops[0]?.status === 'running' && state.managerLoops[0]?.stale === false);
      const response = await fetch(`${address}/api/console/events`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      await reader.read();
      observedNow += 1_000;
      const update = await Promise.race([
        reader.read().then((item) => decoder.decode(item.value)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('stale SSE update timeout')), 1_000)),
      ]);
      expect(update).toContain('"status":"running","stale":true');
      await reader.cancel();
    } finally {
      await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps missing and malformed allowlisted records visible and never mutates their directories', async () => {
    const { root, artifacts, coordinator } = await fixture();
    const malformed = join(root, 'malformed');
    const missing = join(root, 'missing');
    await mkdir(malformed);
    const malformedPath = join(malformed, 'state.json');
    await writeFile(malformedPath, '{"session_id":"must-not-leak"');
    const before = await readFile(malformedPath, 'utf8');
    const beforeFiles = await readdir(malformed);
    const observer = new ManagerLoopObserver({ sources: [
      { id: 'malformed-proof', artifactsDirectory: malformed },
      { id: 'missing-proof', artifactsDirectory: missing },
    ] });
    await observer.poll();
    expect(observer.summaries()).toEqual([
      { id: 'malformed-proof', status: 'unavailable', stale: true, updatedAt: expect.any(String), completedPhases: [], stages: [], reason: 'state_malformed' },
      { id: 'missing-proof', status: 'unavailable', stale: true, completedPhases: [], stages: [], reason: 'state_missing' },
    ]);
    expect(await readFile(malformedPath, 'utf8')).toBe(before);
    expect(await readdir(malformed)).toEqual(beforeFiles);
    await expect(readdir(missing)).rejects.toThrow();

    const parsed = parseLocalConsoleConfiguration({
      factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0,
      allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 0, strictSpending: false, strictSpendingSupported: false },
      managerLoops: [{ id: 'two-phase-math-proof', artifactsDirectory: artifacts, productId: 'math' }],
    });
    expect(parsed.managerLoops).toEqual([{ id: 'two-phase-math-proof', artifactsDirectory: artifacts, productId: 'math' }]);
    expect(() => parseLocalConsoleConfiguration({ ...parsed, managerLoops: [{ id: 'bad', artifactsDirectory: 'relative' }] })).toThrow(/absolute/);
    expect(() => parseLocalConsoleConfiguration({ ...parsed, managerLoops: [{ id: 'Not-A-Loop-Slug', artifactsDirectory: artifacts }] })).toThrow(/lowercase slug/);
    expect(() => parseLocalConsoleConfiguration({ ...parsed, managerLoops: [{ id: 'duplicate', artifactsDirectory: artifacts }, { id: 'duplicate', artifactsDirectory: join(root, 'other') }] })).toThrow(/unique/);
    expect(() => parseLocalConsoleConfiguration({ ...parsed, managerLoops: [{ id: 'hidden-pod', artifactsDirectory: artifacts, podId: 'proof-pod' }] })).toThrow(/requires productId/);

    await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true });
  });
});
