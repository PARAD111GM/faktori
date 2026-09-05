import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ExecutionPolicyError,
  buildDockerExecutionPlan,
  buildNativeExecutionPlan,
  cancelDockerExecution,
  cancelNativeExecution,
  launchDockerExecution,
  launchNativeExecution,
  defaultSharedScratchRoot,
  profileTrustDisclosure,
  isValidatedDockerExecutionPlan,
} from '../../src/execution/index.ts';
import { DockerCodexProcessRunner } from '../../src/execution/transports.ts';

const roots = [];
const IMAGE = `faktori@sha256:${'a'.repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stagedJob() {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'faktori-execution-'));
  roots.push(scratch);
  const workspace = join(scratch, 'job', 'workspace');
  const input = join(scratch, 'job', 'input');
  const credential = join(scratch, 'job', 'credential');
  const control = join(scratch, 'control');
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(input, { recursive: true }), mkdir(credential, { recursive: true }), mkdir(control, { recursive: true })]);
  return { scratch, workspace, input, credential, control };
}

function dockerOptions(staged, extra = {}) {
  return { image: IMAGE, scratchRoot: staged.scratch, controlStoragePaths: [staged.control], ...extra };
}

function request(staged) {
  return {
    runId: 'run-42',
    workspacePath: staged.workspace,
    command: 'codex',
    args: ['exec', 'fix the test'],
    environment: { LANG: 'C.UTF-8' },
    approvedInputs: [{ path: staged.input }],
    credentialProfile: { profileId: 'codex-local', path: staged.credential, environmentVariable: 'CODEX_HOME' },
    limits: { maxRuntimeSeconds: 120, memoryBytes: 268435456, cpuCount: 2, pids: 64 },
  };
}

describe('execution profiles', () => {
  it('uses the Docker-shared macOS scratch root and the OS temporary root elsewhere', () => {
    expect(defaultSharedScratchRoot('darwin', '/var/folders/example/T')).toBe('/private/tmp');
    expect(defaultSharedScratchRoot('linux', '/tmp')).toBe('/tmp');
  });

  it('makes native trust explicit and builds an allowlist-only environment with its exact cwd', async () => {
    const staged = await stagedJob();
    const plan = buildNativeExecutionPlan(request(staged), {
      PATH: '/safe/bin', LANG: 'en_US.UTF-8', GITHUB_TOKEN: 'never-forward', JIRA_TOKEN: 'never-forward', DEPLOY_KEY: 'never-forward', EXTRA: 'never-forward',
    });

    expect(plan).toMatchObject({ profile: 'native', trustDisclosure: 'broad_os_identity_trust', cwd: await realpath(staged.workspace), command: 'codex', args: ['exec', 'fix the test'] });
    expect(plan.env).toEqual({ PATH: '/safe/bin', LANG: 'C.UTF-8', CODEX_HOME: staged.credential });
    expect(profileTrustDisclosure('native')).toMatch(/operating-system identity/);
    expect(profileTrustDisclosure('isolated')).toMatch(/explicitly mounted/);
  });

  it('rejects non-allowlisted and publisher credential environment input rather than widening', async () => {
    const staged = await stagedJob();
    expect(() => buildNativeExecutionPlan({ ...request(staged), environment: { GITHUB_TOKEN: 'copied' } }, {})).toThrow(ExecutionPolicyError);
    expect(() => buildDockerExecutionPlan({ ...request(staged), environment: { DEBUG: '1' } }, dockerOptions(staged))).toThrow(/not allowlisted/);
  });

  it('requires a digest-pinned image and explicitly named controller storage', async () => {
    const staged = await stagedJob();
    expect(() => buildDockerExecutionPlan(request(staged), { image: '--privileged', scratchRoot: staged.scratch, controlStoragePaths: [staged.control] })).toThrow(/digest-pinned/);
    expect(() => buildDockerExecutionPlan(request(staged), { image: 'faktori:test', scratchRoot: staged.scratch, controlStoragePaths: [staged.control] })).toThrow(/digest-pinned/);
    expect(() => buildDockerExecutionPlan(request(staged), { image: IMAGE, scratchRoot: staged.scratch, controlStoragePaths: [] })).toThrow(/controlStoragePath/);
  });

  it('accepts an immutable local image ID as the isolated image identity', async () => {
    const staged = await stagedJob();
    const plan = buildDockerExecutionPlan(request(staged), dockerOptions(staged, { image: `sha256:${'b'.repeat(64)}` }));

    expect(plan.image).toBe(`sha256:${'b'.repeat(64)}`);
    expect(plan.args).toContain(plan.image);
  });

  it('renders a hardened docker invocation with only explicit staged mounts', async () => {
    const staged = await stagedJob();
    const plan = buildDockerExecutionPlan(request(staged), dockerOptions(staged));

    expect(plan).toMatchObject({ profile: 'isolated', cwd: '/workspace', networkMode: 'none' });
    expect(plan.trustDisclosure).toMatch(/Network is disabled.*read-only/);
    expect(plan.env).toEqual({ LANG: 'C.UTF-8', CODEX_HOME: '/credentials/profile' });
    expect(plan.mounts).toEqual([
      { source: await realpath(staged.workspace), target: '/workspace', readOnly: false, purpose: 'workspace' },
      { source: await realpath(staged.input), target: '/inputs/0', readOnly: true, purpose: 'approved_input' },
      { source: await realpath(staged.credential), target: '/credentials/profile', readOnly: true, purpose: 'credential_profile' },
    ]);
    expect(plan.args).toEqual([
      'run', '--detach', '--rm', '--name', 'faktori-run-42', '--network', 'none', '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '268435456', '--cpus', '2', '--ulimit', 'nofile=1024:1024', '--stop-timeout', '30', '--workdir', '/workspace', '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864',
      '--mount', `type=bind,src=${await realpath(staged.workspace)},dst=/workspace`,
      '--mount', `type=bind,src=${await realpath(staged.input)},dst=/inputs/0,readonly`,
      '--mount', `type=bind,src=${await realpath(staged.credential)},dst=/credentials/profile,readonly`,
      '--env', 'LANG=C.UTF-8', '--env', 'CODEX_HOME=/credentials/profile', IMAGE, 'codex', 'exec', 'fix the test',
    ]);
    expect(plan.args.join(' ')).not.toMatch(/docker\.sock|\/Users\/|GITHUB|JIRA|DEPLOY/);
    expect(isValidatedDockerExecutionPlan(plan)).toBe(true);
  });

  it('permits an inner-sandbox bypass only as an explicit opt-in on an unchanged hardened Docker plan', async () => {
    const staged = await stagedJob();
    let actualArgs;
    const runner = new DockerCodexProcessRunner({
      docker: {
        cwd: staged.control,
        env: {},
        async run(args) { actualArgs = args; throw new Error('planned invocation captured'); },
        async stop() {},
      },
      identityProbe: { inspect: async () => ({ status: 'unknown' }) },
      runNonce: 'isolated-bypass-test',
      allowUnsandboxedCodexInsideValidatedContainer: true,
      planFor: (codexRequest) => buildDockerExecutionPlan({
        ...request(staged),
        runId: codexRequest.runId,
        args: codexRequest.args,
        environment: codexRequest.environment,
        approvedInputs: [],
      }, dockerOptions(staged)),
    });

    await expect(runner.run({
      runId: 'run-42',
      command: 'codex',
      args: ['exec', '--json', '--model', 'gpt-5.5', 'bounded prompt'],
      cwd: staged.workspace,
      environment: { LANG: 'C.UTF-8' },
      timeoutMs: 30_000,
    })).rejects.toThrow('planned invocation captured');
    expect(actualArgs).toContain('--dangerously-bypass-approvals-and-sandbox');

    const unvalidated = new DockerCodexProcessRunner({
      docker: { cwd: staged.control, env: {}, async run() { throw new Error('must not launch'); }, async stop() {} },
      identityProbe: { inspect: async () => ({ status: 'unknown' }) },
      runNonce: 'unvalidated-bypass-test',
      allowUnsandboxedCodexInsideValidatedContainer: true,
      planFor: () => ({ profile: 'isolated', trustDisclosure: 'forged', image: IMAGE, networkMode: 'none', args: ['run', '--detach', IMAGE, 'codex', 'exec', '--dangerously-bypass-approvals-and-sandbox'], cwd: '/workspace', env: {}, mounts: [], limits: request(staged).limits }),
    });
    await expect(unvalidated.run({
      runId: 'run-42', command: 'codex', args: ['exec', '--json'], cwd: staged.workspace, environment: { LANG: 'C.UTF-8' }, timeoutMs: 30_000,
    })).rejects.toThrow(/unchanged plan from the hardened Docker builder/);
  });

  it('rejects traversal, symlink escapes, control storage, and Docker socket mounts', async () => {
    const staged = await stagedJob();
    const outside = await mkdtemp(join(await realpath(tmpdir()), 'faktori-outside-'));
    roots.push(outside);
    await symlink(outside, join(staged.scratch, 'job', 'escape'));

    expect(() => buildDockerExecutionPlan({ ...request(staged), workspacePath: join(staged.scratch, '..') }, dockerOptions(staged))).toThrow(/shared scratch root/);
    expect(() => buildDockerExecutionPlan({ ...request(staged), workspacePath: join(staged.scratch, 'job', 'escape') }, dockerOptions(staged))).toThrow(/symlink/);
    expect(() => buildDockerExecutionPlan({ ...request(staged), approvedInputs: [{ path: staged.input }] }, dockerOptions(staged, { controlStoragePaths: [staged.input] }))).toThrow(/control storage/);
    expect(() => buildDockerExecutionPlan({ ...request(staged), approvedInputs: [{ path: '/var/run/docker.sock' }] }, dockerOptions(staged))).toThrow(/symlink|shared scratch root/);
  });

  it('rejects equal and nested mount sources so readonly data cannot alias a writable mount', async () => {
    const staged = await stagedJob();
    await mkdir(join(staged.workspace, 'nested-input'));
    await mkdir(join(staged.control, 'nested-root'));
    expect(() => buildDockerExecutionPlan({ ...request(staged), approvedInputs: [{ path: staged.workspace }] }, dockerOptions(staged))).toThrow(/overlap/);
    expect(() => buildDockerExecutionPlan({ ...request(staged), approvedInputs: [{ path: join(staged.workspace, 'nested-input') }] }, dockerOptions(staged))).toThrow(/overlap/);
    expect(() => buildDockerExecutionPlan({ ...request(staged), credentialProfile: { profileId: 'same-workspace', path: staged.workspace, environmentVariable: 'CODEX_HOME' } }, dockerOptions(staged))).toThrow(/overlap/);
    expect(() => buildDockerExecutionPlan(request(staged), dockerOptions(staged, { controlStoragePaths: [staged.control, join(staged.control, 'nested-root')] }))).toThrow(/overlap/);
  });

  it('permits bridge networking and vendor credential refresh only when explicitly selected', async () => {
    const staged = await stagedJob();
    const plan = buildDockerExecutionPlan({
      ...request(staged),
      networkMode: 'bridge',
      credentialProfile: { profileId: 'codex-local', path: staged.credential, environmentVariable: 'CODEX_HOME', writable: true },
    }, dockerOptions(staged));

    expect(plan.networkMode).toBe('bridge');
    expect(plan.trustDisclosure).toMatch(/Bridge networking is explicitly enabled.*credential profile is writable/);
    expect(plan.args).toContain('bridge');
    expect(plan.args).toContain(`type=bind,src=${await realpath(staged.credential)},dst=/credentials/profile`);
    expect(plan.args).not.toContain(`type=bind,src=${await realpath(staged.credential)},dst=/credentials/profile,readonly`);
    expect(plan.args).toContain(`type=bind,src=${await realpath(staged.input)},dst=/inputs/0,readonly`);
  });

  it('rejects host and unrecognized Docker network modes without widening the default', async () => {
    const staged = await stagedJob();
    expect(() => buildDockerExecutionPlan({ ...request(staged), networkMode: 'host' }, dockerOptions(staged))).toThrow(/networkMode/);
    expect(() => buildDockerExecutionPlan({ ...request(staged), networkMode: 'container:other' }, dockerOptions(staged))).toThrow(/networkMode/);
  });

  it('records observed launch identities rather than trusting an uninspected pid or container id', async () => {
    const staged = await stagedJob();
    const nativePlan = buildNativeExecutionPlan(request(staged), {});
    let nativeOptions;
    const native = await launchNativeExecution(nativePlan, {
      spawn: async (_command, _args, options) => { nativeOptions = options; return { pid: 44 }; },
      terminateProcessGroup: async () => {},
    }, { inspect: async () => ({ pid: 44, processStartedAt: 'start-1', processGroupId: 44, running: true }) }, 'nonce-1');
    expect(native).toEqual({ kind: 'native', pid: 44, processStartedAt: 'start-1', processGroupId: 44, runNonce: 'nonce-1' });
    expect(nativeOptions.limits).toEqual(request(staged).limits);

    const dockerPlan = buildDockerExecutionPlan(request(staged), dockerOptions(staged));
    const container = await launchDockerExecution(dockerPlan, { run: async () => ({ containerId: 'ctr-1' }), stop: async () => {} }, { inspect: async () => ({ containerId: 'ctr-1', containerStartedAt: 'start-2', running: true }) }, 'nonce-2');
    expect(container).toEqual({ kind: 'container', containerId: 'ctr-1', containerStartedAt: 'start-2', runNonce: 'nonce-2' });
  });

  it('durably revokes before termination and distinguishes confirmed exit from uncertainty', async () => {
    const order = [];
    const native = { kind: 'native', pid: 44, processStartedAt: 'start-1', processGroupId: 44, runNonce: 'nonce-1' };
    const authority = { revokeBeforeTermination: async () => { order.push('revoked'); } };
    let nativeInspections = 0;
    const confirmed = await cancelNativeExecution(native, authority, { terminateProcessGroup: async () => { order.push('terminate'); }, spawn: async () => ({ pid: 0 }) }, { inspect: async () => {
      nativeInspections += 1;
      return nativeInspections === 1
        ? { pid: 44, processStartedAt: 'start-1', processGroupId: 44, running: true }
        : { status: 'absent' };
    }, inspectProcessGroup: async () => ({ status: 'absent' }) }, 'owner-cancelled');
    expect(order).toEqual(['revoked', 'terminate']);
    expect(confirmed.outcome).toBe('confirmed_exited');

    let leaderChecks = 0;
    const survivingChild = await cancelNativeExecution(native, { revokeBeforeTermination: async () => {} }, { terminateProcessGroup: async () => {}, spawn: async () => ({ pid: 0 }) }, {
      inspect: async () => {
        leaderChecks += 1;
        return leaderChecks === 1
          ? { pid: 44, processStartedAt: 'start-1', processGroupId: 44, running: true }
          : { status: 'absent' };
      },
      inspectProcessGroup: async () => ({ processGroupId: 44, members: [{ pid: 45, processStartedAt: 'child-start', processGroupId: 44, running: true }] }),
    }, 'owner-cancelled');
    expect(survivingChild).toEqual(expect.objectContaining({ outcome: 'interrupted_uncertain' }));

    const uncertain = await cancelDockerExecution({ kind: 'container', containerId: 'ctr-1', containerStartedAt: 'start-2', runNonce: 'nonce-2' }, authority, { run: async () => ({ containerId: 'ignored' }), stop: async () => { order.push('stop'); } }, { inspect: async () => ({ containerId: 'ctr-1', containerStartedAt: 'start-2', running: true }) }, 'owner-cancelled');
    expect(uncertain.outcome).toBe('interrupted_uncertain');
    expect(order).toEqual(['revoked', 'terminate', 'revoked', 'stop']);
  });

  it('does not send termination when durable revocation fails', async () => {
    const native = { kind: 'native', pid: 44, processStartedAt: 'start-1', processGroupId: 44, runNonce: 'nonce-1' };
    let signalled = false;
    await expect(cancelNativeExecution(native, { revokeBeforeTermination: async () => { throw new Error('journal unavailable'); } }, { spawn: async () => ({ pid: 0 }), terminateProcessGroup: async () => { signalled = true; } }, { inspect: async () => undefined }, 'owner-cancelled')).rejects.toThrow('journal unavailable');
    expect(signalled).toBe(false);
  });

  it('never signals a reused, mismatched, or unknown native process identity', async () => {
    const native = { kind: 'native', pid: 44, processStartedAt: 'start-1', processGroupId: 44, runNonce: 'nonce-1' };
    const authority = { revokeBeforeTermination: async () => {} };
    let signals = 0;
    const runner = { spawn: async () => ({ pid: 0 }), terminateProcessGroup: async () => { signals += 1; } };
    const mismatch = await cancelNativeExecution(native, authority, runner, { inspect: async () => ({ pid: 44, processStartedAt: 'replacement', processGroupId: 44, running: true }) }, 'owner-cancelled');
    expect(mismatch.outcome).toBe('interrupted_uncertain');
    const groupMismatch = await cancelNativeExecution(native, authority, runner, { inspect: async () => ({ pid: 44, processStartedAt: 'start-1', processGroupId: 99, running: true }) }, 'owner-cancelled');
    expect(groupMismatch.outcome).toBe('interrupted_uncertain');
    const pidMismatch = await cancelNativeExecution(native, authority, runner, { inspect: async () => ({ pid: 99, processStartedAt: 'start-1', processGroupId: 44, running: true }) }, 'owner-cancelled');
    expect(pidMismatch.outcome).toBe('interrupted_uncertain');
    const unknown = await cancelNativeExecution(native, authority, runner, { inspect: async () => ({ status: 'unknown' }) }, 'owner-cancelled');
    expect(unknown.outcome).toBe('interrupted_uncertain');
    expect(signals).toBe(0);
  });

  it('does not stop a reused or unknown container and accepts an explicitly absent one as a safe noop', async () => {
    const container = { kind: 'container', containerId: 'ctr-1', containerStartedAt: 'start-2', runNonce: 'nonce-2' };
    const authority = { revokeBeforeTermination: async () => {} };
    let stops = 0;
    const runner = { run: async () => ({ containerId: 'ignored' }), stop: async () => { stops += 1; } };
    const mismatch = await cancelDockerExecution(container, authority, runner, { inspect: async () => ({ containerId: 'ctr-1', containerStartedAt: 'replacement', running: true }) }, 'owner-cancelled');
    expect(mismatch.outcome).toBe('interrupted_uncertain');
    const unknown = await cancelDockerExecution(container, authority, runner, { inspect: async () => ({ status: 'unknown' }) }, 'owner-cancelled');
    expect(unknown.outcome).toBe('interrupted_uncertain');
    const absent = await cancelDockerExecution(container, authority, runner, { inspect: async () => ({ status: 'absent' }) }, 'owner-cancelled');
    expect(absent.outcome).toBe('confirmed_exited');
    expect(stops).toBe(0);
  });
});
