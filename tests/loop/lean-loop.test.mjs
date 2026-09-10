import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseLeanLoopConfiguration, runLeanLoop } from '../../src/loop/index.ts';
import { prepareLoopPublicationHandoff } from '../../src/loop/publication.ts';
import { projectLoopDelivery } from '../../src/loop/delivery.ts';
import { CodexAdapter } from '../../src/providers/codex.ts';

function repository(path) {
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'config', 'user.email', 'lean@example.invalid']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Lean Test']);
  execFileSync('git', ['-C', path, 'commit', '--allow-empty', '-qm', 'base']);
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function config(workspace, artifacts, baseRevision, overrides = {}) {
  return {
    format: 'faktori.lean-loop/v1', loopId: 'lean-proof', profile: 'validation_only',
    workspace: { path: workspace, nativeAccessApproved: true }, artifactsDirectory: artifacts,
    approval: { approved: true, approvedBy: 'owner', scopeRevision: 'proof-v1' },
    candidate: { baseRevision, dependencies: [], environmentInputs: [], inputCompleteness: 'complete' },
    provider: { kind: 'codex', model: 'gpt-default', reasoning: 'medium', contextIsolation: 'bounded', executable: process.execPath, knownQuota: 'unknown' },
    roleRoutes: { reviewer: [{ id: 'review-luna', model: 'gpt-luna', reasoning: 'medium', suitability: 'routine', availability: 'available' }] },
    requirements: [{ id: 'req-result', text: 'Validate the exact existing candidate.' }],
    acceptanceCriteria: [{ id: 'ac-result', requirementIds: ['req-result'], expectedOutcome: 'The declared verification passes against the exact candidate.' }],
    verification: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }], toolchain: [],
    review: { sensitive: false, requiredPasses: 1 }, limits: { maxRuntimeMinutes: 1, maxTokens: 0, maxRepairRounds: 1 },
    ...overrides,
  };
}

function result(response, sessionId = 'lean-session') {
  return { command: 'start', sessionId, events: [], malformedEventCount: 0, final: { outcome: 'completed', sessionId, summary: JSON.stringify(response), usage: { availability: 'unavailable', unavailableReason: 'test' }, nativeCancellationReceipt: false } };
}

function evidenceFrom(prompt) {
  return prompt.match(/CANONICAL_CANDIDATE_EVIDENCE_DIGEST=(sha256:[a-f0-9]{64})/)?.[1];
}

describe('opt-in lean manager loop', () => {
  it('launches lean independent review with Codex native read-only sandbox while retaining the exact digest guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-lean-native-review-'));
    const workspace = join(root, 'workspace'); const artifacts = join(root, 'records');
    await mkdir(workspace); const base = repository(workspace);
    const launches = [];
    const runner = {
      async run(request) {
        launches.push(request);
        await request.lifecycle?.onStarted({ kind: 'native', pid: 701, processStartedAt: '2026-09-09T12:00:00.000Z', processGroupId: 701, runNonce: 'lean-review' });
        const evidenceDigest = evidenceFrom(request.args.at(-1));
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'lean-review-session' })}\n${JSON.stringify({ type: 'turn.completed', last_agent_message: JSON.stringify({ verdict: 'pass', summary: 'exact candidate passed', findings: [], evidenceDigest }) })}\n`,
        };
      },
    };
    try {
      const completed = await runLeanLoop(config(workspace, artifacts, base), {
        adapterFactory: () => new CodexAdapter({ runner, limits: { maxRuntimeMinutes: 1, maxTokens: 0, maxRetries: 1 }, environment: { PATH: process.env.PATH }, compatibleModels: ['gpt-luna'], contextIsolation: 'bounded' }),
        environment: { PATH: process.env.PATH },
      });
      expect(completed.status).toBe('succeeded');
      expect(launches).toHaveLength(1);
      expect(launches[0].args).toEqual(expect.arrayContaining(['-c', 'sandbox_mode="read-only"']));
      expect(launches[0].args).not.toContain('sandbox_mode="workspace-write"');
      expect(launches[0].args.at(-1)).toMatch(/Act as an independent read-only reviewer/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('validates an existing candidate with no implementer or AI manager and emits an explicit deterministic receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-lean-validation-'));
    const workspace = join(root, 'workspace'); const artifacts = join(root, 'records');
    await mkdir(workspace); const base = repository(workspace);
    const verifier = join(root, 'verify.mjs'); const verifierBody = 'process.exit(0);\n'; await writeFile(verifier, verifierBody);
    const verifierDigest = `sha256:${createHash('sha256').update(verifierBody).digest('hex')}`;
    const launches = [];
    const adapterFactory = (route) => ({
      async start(intent, context) {
        launches.push({ role: intent.workItem.role, route, prompt: context.prompt });
        return result({ verdict: 'pass', summary: 'exact candidate passed', findings: [], evidenceDigest: evidenceFrom(context.prompt) });
      },
      async resume() { throw new Error('validation-only must not resume an implementer'); },
    });
    try {
      const completed = await runLeanLoop(config(workspace, artifacts, base, { candidate: { baseRevision: base, dependencies: [{ id: 'verifier', kind: 'file', path: verifier, digest: verifierDigest }], environmentInputs: [], inputCompleteness: 'complete' } }), { adapterFactory, environment: { PATH: process.env.PATH } });
      expect(completed).toMatchObject({ status: 'succeeded', completedPhases: ['work'] });
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({ role: 'reviewer', route: { routeId: 'review-luna', model: 'gpt-luna' } });
      const state = JSON.parse(await readFile(join(artifacts, 'state.json'), 'utf8'));
      expect(state.stages.map(({ kind }) => kind)).toEqual(['review', 'deterministic_accept']);
      expect(state.stages.some(({ kind }) => kind === 'manager_brief' || kind === 'manager_accept' || kind === 'implement')).toBe(false);
      expect(state.lean.acceptance).toMatchObject({ format: 'faktori.lean-acceptance-receipt/v1', accepted: true, actor: { kind: 'deterministic', id: 'faktori.lean.accept/v1' }, profile: 'validation_only', reusable: true });
      expect(state.lean.acceptance.evidence).toMatchObject({ baseRevision: base, dependencies: [{ id: 'verifier', kind: 'file', path: verifier, digest: verifierDigest }], reviewStageIds: [state.stages[0].stageId] });
      expect(JSON.parse(await readFile(join(artifacts, 'acceptance.json'), 'utf8'))).toEqual(state.lean.acceptance);
      const report = JSON.parse(await readFile(join(artifacts, 'report.json'), 'utf8'));
      expect(projectLoopDelivery(report).gates.slice(0, 2).map(({ status }) => status)).toEqual(['passed', 'pending']);
      const handoff = await prepareLoopPublicationHandoff({ format: 'faktori.loop-publication-prepare/v1', approved: true, workspace, loopArtifactsDirectory: artifacts, bundleDirectory: join(root, 'bundle') });
      expect(handoff.loop).toMatchObject({ acceptedEvidenceDigest: state.lean.acceptance.evidence.candidate.contentDigest, reviewStageId: state.stages[0].stageId, managerAcceptanceStageId: state.stages[1].stageId });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('runs the approved implementation brief directly, repairs through the same owner, reruns verification/review, and records routing escalation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-lean-implementation-'));
    const workspace = join(root, 'workspace'); const artifacts = join(root, 'records');
    await mkdir(workspace); const base = repository(workspace);
    const calls = []; let reviews = 0; let verifications = 0;
    const value = config(workspace, artifacts, base, {
      profile: 'implementation',
      implementationBrief: { approved: true, objective: 'Create a verified result file.', constraints: ['Only edit result.txt.'] },
      roleRoutes: {
        implementer: [{ id: 'build-luna', model: 'gpt-luna', reasoning: 'medium', suitability: 'routine', availability: 'unavailable' }, { id: 'build-terra', model: 'gpt-terra', reasoning: 'medium', suitability: 'bounded', availability: 'available' }],
        reviewer: [{ id: 'review-terra', model: 'gpt-terra', reasoning: 'medium', suitability: 'bounded', availability: 'available' }],
      },
    });
    const adapterFactory = (route) => ({
      async start(intent, context) {
        calls.push({ method: 'start', role: intent.workItem.role, route, prompt: context.prompt });
        if (intent.workItem.role === 'builder') { await writeFile(join(workspace, 'result.txt'), 'initial\n'); return result({ status: 'implemented', summary: 'implemented' }); }
        reviews += 1;
        return result(reviews === 1
          ? { verdict: 'repair', summary: 'substantive defect', findings: ['result is not fixed'], evidenceDigest: evidenceFrom(context.prompt) }
          : { verdict: 'pass', summary: 'fixed exact candidate', findings: [], evidenceDigest: evidenceFrom(context.prompt) });
      },
      async resume(_intent, _binding, context) { calls.push({ method: 'resume', prompt: context.prompt }); await writeFile(join(workspace, 'result.txt'), 'fixed\n'); return result({ status: 'implemented', summary: 'repaired' }); },
    });
    try {
      const completed = await runLeanLoop(value, {
        adapterFactory, environment: { PATH: process.env.PATH },
        runVerification: async (command) => { verifications += 1; return { ...command, exitCode: 0, passed: true, outputDigest: `sha256:${String(verifications).padStart(64, '0')}` }; },
      });
      expect(completed.status).toBe('succeeded');
      expect(calls.map(({ method }) => method)).toEqual(['start', 'start', 'resume', 'start']);
      expect(calls.every(({ prompt }) => !prompt.includes('Act as build manager'))).toBe(true);
      expect(calls[0].route).toMatchObject({ routeId: 'build-terra', escalation: { fromRouteIds: ['build-luna'], reason: 'owner_declared_route_unavailable' } });
      const reviewPrompts = calls.filter(({ role }) => role === 'reviewer').map(({ prompt }) => prompt);
      expect(reviewPrompts).toHaveLength(2);
      expect(reviewPrompts.every((prompt) => prompt.startsWith('CANONICAL_CANDIDATE_EVIDENCE_DIGEST=sha256:') && prompt.includes('Copy it unchanged') && prompt.includes('findings MUST be the literal empty array []') && prompt.includes('positive observations in summary') && !prompt.includes('outputDigest'))).toBe(true);
      expect(verifications).toBe(2);
      const state = JSON.parse(await readFile(join(artifacts, 'state.json'), 'utf8'));
      expect(state.stages.map(({ kind }) => kind)).toEqual(['implement', 'review', 'repair', 'review', 'deterministic_accept']);
      expect(state.lean.acceptance.routes).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'implementer', routeId: 'build-terra' }), expect.objectContaining({ role: 'reviewer', routeId: 'review-terra' })]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('blocks unapproved validation repair and candidate changes without silently acquiring write authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-lean-authority-'));
    const workspace = join(root, 'workspace'); await mkdir(workspace); const base = repository(workspace);
    let launches = 0;
    const adapterFactory = () => ({
      async start(_intent, context) { launches += 1; return result({ verdict: 'repair', summary: 'needs repair', findings: ['substantive finding'], evidenceDigest: evidenceFrom(context.prompt) }); },
      async resume() { throw new Error('must not write'); },
    });
    try {
      const blocked = await runLeanLoop(config(workspace, join(root, 'review-records'), base), { adapterFactory, environment: { PATH: process.env.PATH } });
      expect(blocked).toMatchObject({ status: 'blocked', reason: 'work:validation_repair_not_approved' });
      expect(launches).toBe(1);
      expect(await readFile(join(workspace, '.git/HEAD'), 'utf8')).toBeTruthy();

      let changedReviewLaunches = 0;
      const changed = await runLeanLoop(config(workspace, join(root, 'changed-records'), base), {
        adapterFactory: () => ({ async start() { changedReviewLaunches += 1; throw new Error('review must not launch'); }, async resume() { throw new Error('unexpected'); } }),
        environment: { PATH: process.env.PATH },
        runVerification: async (command) => { await writeFile(join(workspace, 'changed-during-verification.txt'), 'changed\n'); return { ...command, exitCode: 0, passed: true, outputDigest: `sha256:${'a'.repeat(64)}` }; },
      });
      expect(changed).toMatchObject({ status: 'failed', reason: 'work:verification_changed_candidate' });
      expect(changedReviewLaunches).toBe(0);

      const verifier = join(root, 'external-verifier.mjs'); const body = 'process.exit(0);\n'; await writeFile(verifier, body);
      const dependency = { id: 'external-verifier', kind: 'file', path: verifier, digest: `sha256:${createHash('sha256').update(body).digest('hex')}` };
      const dependencyChanged = await runLeanLoop(config(workspace, join(root, 'dependency-records'), base, { candidate: { baseRevision: base, dependencies: [dependency], environmentInputs: [], inputCompleteness: 'complete' } }), {
        adapterFactory: () => ({
          async start(_intent, context) { await writeFile(verifier, 'process.exit(1);\n'); return result({ verdict: 'pass', summary: 'candidate passed', findings: [], evidenceDigest: evidenceFrom(context.prompt) }); },
          async resume() { throw new Error('unexpected'); },
        }),
        environment: { PATH: process.env.PATH },
      });
      expect(dependencyChanged).toMatchObject({ status: 'failed', reason: 'work:deterministic_acceptance_preflight_changed' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('performs deterministic preflight before inference and retains sensitive fixed-head review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-lean-preflight-'));
    const workspace = join(root, 'workspace'); await mkdir(workspace); const base = repository(workspace);
    let launches = 0;
    const adapterFactory = () => ({ async start(_intent, context) { launches += 1; return result({ verdict: 'pass', summary: 'passed', findings: [], evidenceDigest: evidenceFrom(context.prompt) }); }, async resume() { throw new Error('unexpected'); } });
    try {
      const denied = config(workspace, join(root, 'denied'), base, { approval: { approved: false, approvedBy: 'owner', scopeRevision: 'denied' } });
      expect((await runLeanLoop(denied, { adapterFactory, environment: { PATH: process.env.PATH } })).status).toBe('blocked');
      const exhausted = config(workspace, join(root, 'quota'), base, { provider: { ...config(workspace, '', base).provider, knownQuota: 'exhausted' } });
      expect((await runLeanLoop(exhausted, { adapterFactory, environment: { PATH: process.env.PATH } })).status).toBe('blocked');
      const dependencyRoot = join(root, 'dependency'); await mkdir(dependencyRoot); const dependencyRevision = repository(dependencyRoot); await writeFile(join(dependencyRoot, 'dirty.txt'), 'unreviewed\n');
      const dirtyDependency = config(workspace, join(root, 'dirty-dependency'), base, { candidate: { baseRevision: base, dependencies: [{ id: 'dirty-repo', kind: 'git', path: dependencyRoot, revision: dependencyRevision }], environmentInputs: [], inputCompleteness: 'complete' } });
      expect((await runLeanLoop(dirtyDependency, { adapterFactory, environment: { PATH: process.env.PATH } })).status).toBe('blocked');
      expect(launches).toBe(0);

      const executable = join(root, 'late-provider');
      const lateConfig = config(workspace, join(root, 'late'), base, { provider: { ...config(workspace, '', base).provider, executable } });
      expect((await runLeanLoop(lateConfig, { adapterFactory, environment: { PATH: process.env.PATH } })).status).toBe('blocked');
      expect((await runLeanLoop(lateConfig, { adapterFactory, environment: { PATH: process.env.PATH } })).status).toBe('blocked');
      expect(JSON.parse(await readFile(join(root, 'late/preflight.json'), 'utf8'))).toMatchObject({ consecutiveFailures: 2, launchSuppressed: true });
      await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o700);
      expect((await runLeanLoop(lateConfig, { adapterFactory, environment: { PATH: process.env.PATH } })).status).toBe('succeeded');

      const sensitive = config(workspace, join(root, 'sensitive'), base, { review: { sensitive: true, requiredPasses: 2 }, candidate: { baseRevision: base, dependencies: [], environmentInputs: [], inputCompleteness: 'unknown' } });
      expect((await runLeanLoop(sensitive, { adapterFactory, environment: { PATH: process.env.PATH } })).status).toBe('succeeded');
      const state = JSON.parse(await readFile(join(root, 'sensitive/state.json'), 'utf8'));
      expect(state.stages.filter(({ kind }) => kind === 'review')).toHaveLength(2);
      expect(state.lean.acceptance.reusable).toBe(false);
      expect(launches).toBe(3);
      expect(await runLeanLoop(sensitive, { adapterFactory, environment: { PATH: process.env.PATH } })).toMatchObject({ status: 'blocked', reason: 'fresh_revalidation_required_new_artifacts_directory' });
      expect(launches).toBe(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires structural criteria links and explicit approved implementation briefs without guessing semantic quality', () => {
    const valid = config('/tmp/workspace', '/tmp/artifacts', 'a'.repeat(40));
    expect(parseLeanLoopConfiguration(valid).candidate.dependencies).toEqual([]);
    expect(() => parseLeanLoopConfiguration({ ...valid, acceptanceCriteria: [{ id: 'accept', requirementIds: ['missing'], expectedOutcome: 'Anything explicitly approved by the owner.' }] })).toThrow(/unknown requirement/);
    expect(() => parseLeanLoopConfiguration({ ...valid, profile: 'implementation' })).toThrow(/implementationBrief is required/);
    expect(() => parseLeanLoopConfiguration({ ...valid, review: { sensitive: true, requiredPasses: 1 } })).toThrow(/must be 2/);
  });

  it('returns a nonzero CLI status for a blocked lean result while retaining its JSON receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-lean-cli-'));
    const workspace = join(root, 'workspace'); await mkdir(workspace); const base = repository(workspace);
    const path = join(root, 'lean.json');
    await writeFile(path, JSON.stringify(config(workspace, join(root, 'records'), base, { approval: { approved: false, approvedBy: 'owner', scopeRevision: 'denied' } })));
    try {
      const cli = new URL('../../src/cli.ts', import.meta.url).pathname;
      const invoked = spawnSync(process.execPath, [cli, 'loop', 'lean', path], { encoding: 'utf8' });
      expect(invoked.status).toBe(1);
      expect(JSON.parse(invoked.stdout)).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/^lean_preflight_failed:/) });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
