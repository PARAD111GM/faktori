import { chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { captureManagerLoopWorkspaceEvidence, parseManagerLoopConfiguration, runManagerLoop } from '../../src/loop/index.ts';

function initializeRepository(path) {
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['-C', path, 'config', 'user.email', 'manager-loop@example.invalid']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Manager Loop Test']);
  execFileSync('git', ['-C', path, 'commit', '--allow-empty', '-qm', 'initial']);
}

function configuration(workspace, artifacts, overrides = {}) {
  return {
    format: 'faktori.manager-loop/v1', loopId: 'proof',
    workspace: { path: workspace, nativeAccessApproved: true }, artifactsDirectory: artifacts,
    provider: { kind: 'codex', model: 'gpt-test', reasoning: 'medium', contextIsolation: 'bounded' },
    limits: { maxRuntimeMinutes: 1, maxTokens: 0, maxRepairRounds: 1 },
    phases: [{ id: 'build', objective: 'Create the requested result.', acceptanceCriteria: ['The result is verified.'], verification: [{ command: process.execPath, args: ['-e', 'process.exit(0)'] }] }],
    ...overrides,
  };
}

function providerResult(response, sessionId = 'session-1') {
  return { command: 'start', sessionId, events: [], malformedEventCount: 0, final: { outcome: 'completed', sessionId, summary: JSON.stringify(response), usage: { availability: 'unavailable', unavailableReason: 'test' }, nativeCancellationReceipt: false } };
}

describe('manager loop proof of concept', () => {
  it('runs the real native process transport through manager, fresh implementer, independent review, repair, verification, and exact acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-manager-loop-'));
    const workspace = join(root, 'workspace');
    const artifacts = join(root, 'records');
    const bin = join(root, 'bin');
    await mkdir(workspace); await mkdir(bin); initializeRepository(workspace);
    const codex = join(bin, 'codex');
    await writeFile(codex, `#!${process.execPath}\nconst fs = await import('node:fs/promises');\nconst prompt = process.argv.at(-1);\nawait new Promise(r => setTimeout(r, 75));\nlet response;\nif (prompt.includes('Act as the phase implementer')) { await fs.writeFile('result.txt', 'needs repair\\n'); response = {status:'implemented',summary:'initial'}; }\nelse if (prompt.includes('Continue as the same implementer')) { await fs.writeFile('result.txt', 'verified\\n'); response = {status:'implemented',summary:'repaired'}; }\nelse if (prompt.includes('Act as an independent reviewer')) { const body = await fs.readFile('result.txt','utf8'); const evidenceDigest = prompt.match(/contentDigest\\\":\\\"(sha256:[a-f0-9]+)/)?.[1] ?? prompt.match(/contentDigest":"(sha256:[a-f0-9]+)/)?.[1]; response = body.includes('verified') ? {verdict:'pass',summary:'verified',findings:[],evidenceDigest} : {verdict:'repair',summary:'repair required',findings:['result is incomplete'],evidenceDigest}; }\nelse if (prompt.includes('Independent review receipt')) { const evidenceDigest = [...prompt.matchAll(/contentDigest\\\":\\\"(sha256:[a-f0-9]+)/g)].at(-1)?.[1] ?? [...prompt.matchAll(/contentDigest":"(sha256:[a-f0-9]+)/g)].at(-1)?.[1]; const reviewStageId = prompt.match(/reviewStageId":"([^\"]+)/)?.[1]; response = {accepted:true,summary:'accepted',evidenceDigest,reviewStageId}; }\nelse response = {status:'ready',brief:'bounded brief'};\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'session-1'}));\nconsole.log(JSON.stringify({type:'item.completed',item:{text:JSON.stringify(response)}}));\nconsole.log(JSON.stringify({type:'turn.completed'}));\n`, { mode: 0o700 });
    await writeFile(codex, (await readFile(codex, 'utf8')).replace('setTimeout(r, 75)', 'setTimeout(r, 500)'));
    await chmod(codex, 0o700);

    const identityProbe = { async inspect(pid) { return { pid, processStartedAt: 'observed-start', processGroupId: pid, running: true }; } };
    const result = await runManagerLoop(configuration(workspace, artifacts), { environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: root }, nativeIdentityProbe: identityProbe });

    expect(result).toMatchObject({ status: 'succeeded', completedPhases: ['build'] });
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('verified\n');
    const state = JSON.parse(await readFile(join(artifacts, 'state.json'), 'utf8'));
    expect(state.stages.map(({ kind }) => kind)).toEqual(['manager_brief', 'implement', 'review', 'repair', 'review', 'manager_accept']);
    expect(state.stages.filter(({ kind }) => kind === 'review').every(({ verification }) => verification.every(({ passed }) => passed))).toBe(true);
    expect(state.stages.at(-1).response.evidenceDigest).toBe(state.stages.at(-1).evidence.contentDigest);
    expect(execFileSync('git', ['-C', workspace, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('1');
    expect(execFileSync('git', ['-C', workspace, 'remote'], { encoding: 'utf8' }).trim()).toBe('');
    expect((await runManagerLoop(configuration(workspace, artifacts), { environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: root }, nativeIdentityProbe: identityProbe })).status).toBe('succeeded');
  }, 20_000);

  it('does not relaunch a stage whose durable intent has no receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-manager-uncertain-'));
    const workspace = join(root, 'workspace'); const artifacts = join(root, 'records');
    await mkdir(workspace); initializeRepository(workspace);
    let launches = 0;
    const adapterFactory = () => ({
      async start() { launches += 1; throw new Error('simulated process loss'); },
      async resume() { throw new Error('unexpected resume'); },
    });
    await expect(runManagerLoop(configuration(workspace, artifacts), { adapterFactory, environment: { PATH: '/usr/bin:/bin' } })).rejects.toThrow('simulated process loss');
    const recovered = await runManagerLoop(configuration(workspace, artifacts), { adapterFactory, environment: { PATH: '/usr/bin:/bin' } });
    expect(recovered).toMatchObject({ status: 'interrupted_uncertain', reason: 'stage_receipt_missing_manual_reconciliation_required', currentStage: { kind: 'manager_brief' } });
    expect(launches).toBe(1);
  });

  it('routes failed executable verification into the same bounded implementer repair session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-manager-verification-repair-'));
    const workspace = join(root, 'workspace'); const artifacts = join(root, 'records');
    await mkdir(workspace); initializeRepository(workspace);
    const calls = [];
    const prompts = [];
    const adapterFactory = () => ({
      async start(_intent, context) {
        calls.push('start');
        const prompt = context.prompt;
        prompts.push(prompt);
        if (prompt.includes('Independent review receipt')) {
          const evidenceDigest = [...prompt.matchAll(/contentDigest\\?":"(sha256:[a-f0-9]+)/g)].at(-1)?.[1];
          const reviewStageId = prompt.match(/reviewStageId":"([^"]+)/)?.[1];
          return providerResult({ accepted: true, summary: 'accepted', evidenceDigest, reviewStageId });
        }
        if (prompt.includes('Act as an independent reviewer')) {
          const evidenceDigest = prompt.match(/contentDigest\\?":"(sha256:[a-f0-9]+)/)?.[1];
          return providerResult({ verdict: 'pass', summary: 'verified after repair', findings: [], evidenceDigest });
        }
        if (prompt.includes('Act as the phase implementer')) return providerResult({ status: 'implemented', summary: 'initial' });
        return providerResult({ status: 'ready', brief: 'brief' });
      },
      async resume() { calls.push('resume'); return providerResult({ status: 'implemented', summary: 'verification repaired' }); },
    });
    let verificationRuns = 0;
    const result = await runManagerLoop(configuration(workspace, artifacts), {
      adapterFactory, environment: { PATH: '/usr/bin:/bin' },
      runVerification: async (command) => {
        verificationRuns += 1;
        return { command: command.command, args: command.args, exitCode: verificationRuns === 1 ? 1 : 0, passed: verificationRuns > 1, outputDigest: `sha256:${verificationRuns}`, ...(verificationRuns === 1 ? { summary: 'assertion failed' } : {}) };
      },
    });
    expect(result.status).toBe('succeeded');
    expect(calls).toContain('resume');
    expect(prompts[0]).toContain('next implementer turn is explicitly authorized to edit files');
    expect(prompts[0]).toContain('Missing functionality requested by this phase is expected and is not a blocker');
    const state = JSON.parse(await readFile(join(artifacts, 'state.json'), 'utf8'));
    expect(state.stages.map(({ kind }) => kind)).toEqual(['manager_brief', 'implement', 'repair', 'review', 'manager_accept']);
    expect(JSON.stringify(state.stages.find(({ kind }) => kind === 'repair').verification)).toContain('assertion failed');
  });

  it('requires explicit native approval and rejects unknown config or shell-shaped verification', () => {
    const valid = configuration('/tmp/workspace', '/tmp/artifacts');
    expect(() => parseManagerLoopConfiguration({ ...valid, workspace: { path: '/tmp/workspace', nativeAccessApproved: false } })).toThrow(/nativeAccessApproved/);
    expect(() => parseManagerLoopConfiguration({ ...valid, provider: { ...valid.provider, contextIsolation: 'host' } })).toThrow(/must be "bounded"/);
    expect(() => parseManagerLoopConfiguration({ ...valid, surprise: true })).toThrow(/surprise/);
    const shell = structuredClone(valid);
    shell.phases[0].verification[0].shell = 'node --test';
    expect(() => parseManagerLoopConfiguration(shell)).toThrow(/shell is not supported/);
  });

  it('cannot pass review without successful configured verification or exact evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-manager-evidence-'));
    const workspace = join(root, 'workspace'); await mkdir(workspace); initializeRepository(workspace);
    const responses = [
      { status: 'ready', brief: 'brief' },
      { status: 'implemented', summary: 'done' },
      { verdict: 'pass', summary: 'claimed pass', findings: [], evidenceDigest: 'sha256:wrong' },
    ];
    const adapterFactory = () => ({ async start() { return providerResult(responses.shift()); }, async resume() { throw new Error('unexpected'); } });
    const failedVerificationConfig = configuration(workspace, join(root, 'failed-verification'));
    failedVerificationConfig.limits.maxRepairRounds = 0;
    const failedVerification = await runManagerLoop(failedVerificationConfig, { adapterFactory, environment: { PATH: '/usr/bin:/bin' }, runVerification: async (command) => ({ command: command.command, args: command.args, exitCode: 1, passed: false, outputDigest: 'sha256:failed' }) });
    expect(failedVerification).toMatchObject({ status: 'failed', reason: 'build:configured_verification_failed' });
    expect(responses).toHaveLength(1);

    const responses2 = [{ status: 'ready', brief: 'brief' }, { status: 'implemented', summary: 'done' }, { verdict: 'pass', summary: 'claimed pass', findings: [], evidenceDigest: 'sha256:wrong' }];
    const mismatched = await runManagerLoop(configuration(workspace, join(root, 'wrong-evidence')), { adapterFactory: () => ({ async start() { return providerResult(responses2.shift()); }, async resume() { throw new Error('unexpected'); } }), environment: { PATH: '/usr/bin:/bin' }, runVerification: async (command) => ({ command: command.command, args: command.args, exitCode: 0, passed: true, outputDigest: 'sha256:passed' }) });
    expect(mismatched).toMatchObject({ status: 'failed', reason: 'build:review_evidence_mismatch' });
  });

  it('binds evidence to ignored content, executable modes, and the current branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-manager-digest-'));
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(root, 'tracked.txt'), 'tracked\n');
    initializeRepository(root);
    execFileSync('git', ['-C', root, 'add', '.gitignore', 'tracked.txt']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'ignore rule']);
    await writeFile(join(root, 'ignored.txt'), 'first\n', { mode: 0o600 });
    await writeFile(join(root, 'ordinary.txt'), 'ordinary first\n');
    const first = await captureManagerLoopWorkspaceEvidence(root);
    await writeFile(join(root, 'ordinary.txt'), 'ordinary second\n');
    const ordinaryChanged = await captureManagerLoopWorkspaceEvidence(root);
    await writeFile(join(root, 'ignored.txt'), 'second\n');
    const contentChanged = await captureManagerLoopWorkspaceEvidence(root);
    await chmod(join(root, 'ignored.txt'), 0o700);
    const modeChanged = await captureManagerLoopWorkspaceEvidence(root);
    await writeFile(join(root, 'tracked.txt'), 'changed\n');
    const unstaged = await captureManagerLoopWorkspaceEvidence(root);
    execFileSync('git', ['-C', root, 'add', 'tracked.txt']);
    const staged = await captureManagerLoopWorkspaceEvidence(root);
    await writeFile(join(root, 'tracked.txt'), 'changed again\n');
    await chmod(join(root, 'tracked.txt'), 0o700);
    await unlink(join(root, 'tracked.txt'));
    const deleted = await captureManagerLoopWorkspaceEvidence(root);
    execFileSync('git', ['-C', root, 'switch', '-qc', 'other']);
    const branchChanged = await captureManagerLoopWorkspaceEvidence(root);
    expect(new Set([first.contentDigest, ordinaryChanged.contentDigest, contentChanged.contentDigest, modeChanged.contentDigest, unstaged.contentDigest, staged.contentDigest, deleted.contentDigest, branchChanged.contentDigest]).size).toBe(8);
  });

  it('returns busy without rewriting an actively held stage as uncertain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-manager-concurrent-'));
    const workspace = join(root, 'workspace'); const artifacts = join(root, 'records');
    await mkdir(workspace); initializeRepository(workspace);
    let rejectLaunch;
    let started;
    const launchStarted = new Promise((resolve) => { started = resolve; });
    const adapterFactory = () => ({
      async start() { started(); return new Promise((_resolve, reject) => { rejectLaunch = reject; }); },
      async resume() { throw new Error('unexpected'); },
    });
    const first = runManagerLoop(configuration(workspace, artifacts), { adapterFactory, environment: { PATH: '/usr/bin:/bin' } });
    await launchStarted;
    const second = await runManagerLoop(configuration(workspace, artifacts), { adapterFactory, environment: { PATH: '/usr/bin:/bin' } });
    expect(second).toMatchObject({ status: 'blocked', reason: 'manager_loop_already_running' });
    expect(JSON.parse(await readFile(join(artifacts, 'state.json'), 'utf8'))).toMatchObject({ status: 'running', currentStage: { kind: 'manager_brief' } });
    rejectLaunch(new Error('end test run'));
    await expect(first).rejects.toThrow('end test run');
  });
});
