import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runLeanLoop } from '../../src/loop/index.ts';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(path, args) { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim(); }
function repository(path) { execFileSync('git', ['init', '-q', path]); git(path, ['config', 'user.email', 'test@example.invalid']); git(path, ['config', 'user.name', 'Test']); execFileSync('git', ['-C', path, 'commit', '--allow-empty', '-qm', 'base']); return git(path, ['rev-parse', 'HEAD']); }
function config(workspace, artifacts, base) { return { format: 'faktori.lean-loop/v1', loopId: 'routing-proof', profile: 'validation_only', workspace: { path: workspace, nativeAccessApproved: true }, artifactsDirectory: artifacts, approval: { approved: true, approvedBy: 'owner', scopeRevision: 'scope@1' }, candidate: { baseRevision: base, dependencies: [], environmentInputs: [], inputCompleteness: 'complete' }, provider: { kind: 'codex', model: 'legacy-static-model', contextIsolation: 'bounded', executable: process.execPath, knownQuota: 'available' }, roleRoutes: { reviewer: [{ id: 'legacy-static', model: 'legacy-static-model', suitability: 'routine', availability: 'available' }] }, requirements: [{ id: 'req', text: 'Review the candidate.' }], acceptanceCriteria: [{ id: 'accept', requirementIds: ['req'], expectedOutcome: 'Review passes.' }], verification: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }], toolchain: [], review: { sensitive: false, requiredPasses: 1 }, limits: { maxRuntimeMinutes: 1, maxTokens: 0, maxRepairRounds: 0 }, subscriptionRouting: { enabled: true, stageTaskClasses: { review: 'routine-review' }, rolePrompts: { reviewer: 'Use the owner-approved narrow review checklist.' } } }; }
function providerResult() { return { command: 'start', sessionId: 'review-session', events: [], malformedEventCount: 0, final: { outcome: 'completed', sessionId: 'review-session', summary: JSON.stringify({ verdict: 'pass', summary: 'candidate passes', findings: [] }), usage: { availability: 'unavailable', unavailableReason: 'test' }, nativeCancellationReceipt: false } }; }

describe('lean-loop subscription routing port', () => {
  it('routes the real model turn through the controller port, appends the configured role prompt, and records terminal state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-loop-routing-')); roots.push(root); const workspace = join(root, 'workspace'); await mkdir(workspace); const base = repository(workspace); const selections = []; const terminals = [];
    const result = await runLeanLoop(config(workspace, join(root, 'records'), base), { environment: { PATH: process.env.PATH }, routing: {
      async select(intent, revision, taskClass) { selections.push({ intent, revision, taskClass }); return { ...intent, execution: { ...intent.execution, model: 'controller-selected-model' } }; },
      async terminal(runId, outcome) { terminals.push({ runId, outcome }); },
    }, adapterFactory: route => ({ async start(intent, context) { expect(route).toMatchObject({ routeId: 'subscription-controller', model: 'controller-selected-model', availability: 'unknown' }); expect(intent.execution.model).toBe('controller-selected-model'); expect(context.prompt).toContain('Additional owner-configured reviewer instructions: Use the owner-approved narrow review checklist.'); return providerResult(); }, async resume() { throw new Error('unexpected'); } }) });
    expect(result.status).toBe('succeeded'); expect(selections).toMatchObject([{ taskClass: 'routine-review', revision: expect.stringMatching(/review-0@1/) }]); expect(terminals).toEqual([{ runId: 'routing-proof-work-review-0', outcome: 'completed' }]);
  });

  it('fails closed before any model call when routing is enabled without a Console controller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-loop-routing-missing-')); roots.push(root); const workspace = join(root, 'workspace'); await mkdir(workspace); const base = repository(workspace); let calls = 0;
    const result = await runLeanLoop(config(workspace, join(root, 'records'), base), { environment: { PATH: process.env.PATH }, adapterFactory: () => ({ async start() { calls += 1; return providerResult(); }, async resume() { throw new Error('unexpected'); } }) });
    expect(result).toMatchObject({ status: 'blocked', reason: 'subscription_routing_requires_console_controller' }); expect(calls).toBe(0);
  });

  it('releases a selected unsupported provider reservation without starting a model turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-loop-routing-unsupported-')); roots.push(root); const workspace = join(root, 'workspace'); await mkdir(workspace); const base = repository(workspace); const terminals = []; let adapterCalls = 0;
    const result = await runLeanLoop(config(workspace, join(root, 'records'), base), { environment: { PATH: process.env.PATH }, routing: {
      async select(intent) { return { ...intent, execution: { ...intent.execution, providerId: 'unsupported-provider' } }; },
      async terminal(runId, outcome) { terminals.push({ runId, outcome }); },
    }, adapterFactory: () => { adapterCalls += 1; throw new Error('adapter_must_not_start'); } });
    expect(result).toMatchObject({ status: 'blocked', reason: 'routing-proof-work-review-0:subscription_routing_provider_unsupported' });
    expect(terminals).toEqual([{ runId: 'routing-proof-work-review-0', outcome: 'denied' }]); expect(adapterCalls).toBe(0);
  });

  it('marks a selected reservation uncertain when adapter construction fails before model invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-loop-routing-adapter-failure-')); roots.push(root); const workspace = join(root, 'workspace'); await mkdir(workspace); const base = repository(workspace); const terminals = []; let adapterCalls = 0;
    const result = await runLeanLoop(config(workspace, join(root, 'records'), base), { environment: { PATH: process.env.PATH }, routing: {
      async select(intent) { return intent; },
      async terminal(runId, outcome) { terminals.push({ runId, outcome }); },
    }, adapterFactory: () => { adapterCalls += 1; throw new Error('adapter_unavailable'); } });
    expect(result).toMatchObject({ status: 'interrupted_uncertain', reason: 'routing-proof-work-review-0:provider_turn_uncertain' });
    expect(terminals).toEqual([{ runId: 'routing-proof-work-review-0', outcome: 'interrupted_uncertain' }]); expect(adapterCalls).toBe(1);
  });
});
