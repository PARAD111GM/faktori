import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureCandidateSnapshot, parseCandidateVerificationConfiguration, verifyCandidateRuntime } from '../../src/verification/index.ts';

// Real disposable HTTP app. Fault modes alter the served product behavior.
// The identity and check clients connect to its ephemeral loopback port.
const runtime = `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.env.FAULT ?? 'none';
const identity = { format: 'faktori.runtime-identity/v1', runId: process.env.FAKTORI_VERIFY_RUN_ID, candidateDigest: process.env.FAKTORI_VERIFY_CANDIDATE_DIGEST, variant: process.env.FAKTORI_VERIFY_VARIANT };
if (mode === 'wrong-identity') identity.runId = 'stale-runtime';
if (mode === 'startup-crash') process.exit(9);
if (mode === 'startup-timeout') { setInterval(() => {}, 1000); } else {
  if (mode === 'mutate') writeFileSync('candidate.txt', 'changed');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.PIDS) appendFileSync(process.env.PIDS, JSON.stringify([process.pid, child.pid]) + '\\n');
  const server = createServer((req, res) => {
    if (req.url === '/identity') { res.end(JSON.stringify(identity)); return; }
    if (mode === 'crash') { process.exit(8); }
    if (mode === 'hang') return;
    res.end(JSON.stringify({ result: mode === 'defect' ? 3 : 4 }));
  });
  server.listen(0, '127.0.0.1', () => {
    identity.endpoint = 'http://127.0.0.1:' + server.address().port;
    writeFileSync(join(process.env.FAKTORI_VERIFY_DIRECTORY, 'endpoint'), identity.endpoint);
  });
}
`;
const client = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const endpoint = readFileSync(join(process.env.FAKTORI_VERIFY_DIRECTORY, 'endpoint'), 'utf8');
const identity = await (await fetch(endpoint + '/identity')).json();
if (process.argv[2] === 'identity' && process.env.IDENTITY_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.IDENTITY_DELAY_MS)));
if (process.argv[2] === 'identity') { console.log(JSON.stringify(identity)); } else {
  if (process.env.FAULT === 'check-crash') { console.log(JSON.stringify({format:'faktori.runtime-check/v1',runId:identity.runId,candidateDigest:identity.candidateDigest,variant:identity.variant,status:'failed',failureCode:'arithmetic'})); process.exit(7); }
  if (process.env.FAULT === 'overflow') { console.log('a'.repeat(100000)); setInterval(()=>{},1000); } else {
    const product = await (await fetch(endpoint + '/calculate')).json();
    console.log(JSON.stringify({ format: 'faktori.runtime-check/v1', runId: identity.runId, candidateDigest: identity.candidateDigest, variant: identity.variant, status: product.result === 4 ? 'passed' : 'failed', ...(product.result === 4 ? {} : { failureCode: 'arithmetic' }) }));
  }
}
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'faktori-verification-story-'));
  const candidate = join(root, 'candidate');
  await mkdir(candidate);
  await writeFile(join(candidate, 'runtime.mjs'), runtime);
  await writeFile(join(candidate, 'client.mjs'), client);
  await writeFile(join(candidate, 'candidate.txt'), 'approved candidate');
  const snapshot = await captureCandidateSnapshot(candidate);
  const config = {
    format: 'faktori.candidate-verification/v1', execution: { nativeAccessApproved: true, approvedBy: 'owner' },
    candidate: { path: candidate, expectedDigest: snapshot.candidateDigest },
    startup: { command: process.execPath, args: ['runtime.mjs'] },
    identity: { command: process.execPath, args: ['client.mjs', 'identity'] },
    check: { command: process.execPath, args: ['client.mjs', 'check'] },
    environment: { PATH: process.env.PATH, PIDS: join(root, 'pids.json') },
    negativeControls: [{ id: 'broken-calculation', environment: { FAULT: 'defect' }, expectedFailureCode: 'arithmetic' }],
    limits: { startupTimeoutMs: 3000, checkTimeoutMs: 1500, shutdownTimeoutMs: 1000, outputMaxBytes: 16000 },
  };
  return { root, candidate, snapshot, config };
}
function running(pid) {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return Boolean(state) && !state.startsWith('Z');
  } catch { return false; }
}
async function processIds(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').flatMap(line => JSON.parse(line));
}

describe('candidate runtime verification', () => {
  it('proves the CLI snapshot and healthy/negative runtime commands against a disposable HTTP application', async () => {
    const { root, candidate, config } = await fixture();
    const built = join(import.meta.dirname, '../../dist/cli.js');
    const cli = existsSync(built) ? built : join(import.meta.dirname, '../../src/cli.ts');
    try {
      const snapshot = JSON.parse(execFileSync(process.execPath, [cli, 'verification', 'snapshot', candidate], { encoding: 'utf8', timeout: 15000 }));
      config.candidate.expectedDigest = snapshot.candidateDigest;
      const manifest = join(root, 'verification.json');
      await writeFile(manifest, JSON.stringify(config));
      const executed = spawnSync(process.execPath, [cli, 'verification', 'run', manifest], { encoding: 'utf8', timeout: 20000 });
      expect(executed.status, executed.stdout + executed.stderr).toBe(0);
      const result = JSON.parse(executed.stdout);
      expect(result).toMatchObject({ status: 'passed', passed: true, candidateDigest: snapshot.candidateDigest });
      expect(result.configurationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(result.scenarios.every(scenario => /^sha256:[a-f0-9]{64}$/.test(scenario.environmentDigest))).toBe(true);
      expect(result.scenarios.map(scenario => scenario.check.status)).toEqual(['passed', 'failed']);
      expect(result.scenarios.every(scenario => scenario.cleanup === 'confirmed')).toBe(true);
      const pids = await processIds(config.environment.PIDS);
      expect(pids).toHaveLength(4);
      for (const pid of pids) expect(running(pid)).toBe(false);
      expect(await captureCandidateSnapshot(candidate)).toEqual(snapshot);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  it('honors configured identity deadlines, observes healthy and broken behavior, and removes both process trees', async () => {
    const { root, candidate, snapshot, config } = await fixture();
    // Prevents the verifier's former hidden one-second identity cap from
    // rejecting an owner-approved probe that fits its configured deadline.
    config.environment.IDENTITY_DELAY_MS = '1100';
    config.limits.startupTimeoutMs = 6000;
    config.limits.checkTimeoutMs = 4000;
    try {
      const result = await verifyCandidateRuntime(config);
      expect(result).toMatchObject({ passed: true, status: 'passed', candidateDigest: snapshot.candidateDigest, executionBoundary: 'owner_trusted_native' });
      expect(result.scenarios.map(scenario => [scenario.id, scenario.passed, scenario.cleanup, scenario.check.status])).toEqual([
        ['healthy', true, 'confirmed', 'passed'], ['broken-calculation', true, 'confirmed', 'failed'],
      ]);
      expect(result.scenarios[1].check.failureCode).toBe('arithmetic');
      expect(result.scenarios.every(scenario => scenario.identity.endpoint.startsWith('http://127.0.0.1:'))).toBe(true);
      expect(result.outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(await captureCandidateSnapshot(candidate)).toEqual(snapshot);
      const pids = await processIds(config.environment.PIDS);
      expect(pids).toHaveLength(4);
      for (const pid of pids) expect(running(pid)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  // Prevents a dead app, stale deployment, crashed checker, or insensitive test
  // from being accepted as evidence that the deliberate defect was detected.
  it.each(['crash', 'wrong-identity', 'check-crash', 'none', 'hang', 'overflow'])('rejects %s as negative-control success and cleans up', async fault => {
    const { root, config } = await fixture();
    config.negativeControls[0].environment.FAULT = fault;
    try {
      const result = await verifyCandidateRuntime(config);
      expect(result.passed).toBe(false);
      expect(result.scenarios[0].passed).toBe(true);
      expect(result.scenarios[1]).toMatchObject({ passed: false, cleanup: 'confirmed' });
      expect(result.scenarios[1].reason).toBeTruthy();
      for (const pid of await processIds(config.environment.PIDS)) expect(running(pid)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);

  it.each(['startup-crash', 'startup-timeout', 'mutate'])('fails a %s candidate before producing acceptance', async fault => {
    const { root, config } = await fixture();
    config.environment.FAULT = fault;
    config.limits.startupTimeoutMs = 300;
    try {
      const result = await verifyCandidateRuntime(config);
      expect(result).toMatchObject({ passed: false, status: 'failed' });
      expect(result.scenarios).toHaveLength(1);
      expect(result.scenarios[0]).toMatchObject({ passed: false, cleanup: 'confirmed' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);

  it('rejects stale snapshots and changed/linked candidate inputs without executing a startup', async () => {
    const { root, candidate, snapshot, config } = await fixture();
    try {
      await writeFile(join(candidate, 'candidate.txt'), 'changed after approval');
      expect((await verifyCandidateRuntime(config))).toMatchObject({ passed: false, reason: 'candidate_digest_mismatch', scenarios: [] });
      await expect(readFile(config.environment.PIDS)).rejects.toThrow();
      expect((await captureCandidateSnapshot(candidate)).candidateDigest).not.toBe(snapshot.candidateDigest);
      await symlink(join(root, 'not-followed'), join(candidate, 'linked'));
      await expect(captureCandidateSnapshot(candidate)).rejects.toThrow('candidate_symlink_not_supported');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('binds ignored files, file modes, and empty directories while excluding only root Git metadata', async () => {
    const { root, candidate } = await fixture();
    try {
      const before = await captureCandidateSnapshot(candidate);
      await mkdir(join(candidate, '.git')); await writeFile(join(candidate, '.git', 'HEAD'), 'metadata');
      expect(await captureCandidateSnapshot(candidate)).toEqual(before);
      await writeFile(join(candidate, '.ignored'), 'real runtime input');
      const ignored = await captureCandidateSnapshot(candidate);
      expect(ignored.candidateDigest).not.toBe(before.candidateDigest);
      await chmod(join(candidate, '.ignored'), 0o700);
      expect((await captureCandidateSnapshot(candidate)).candidateDigest).not.toBe(ignored.candidateDigest);
      await mkdir(join(candidate, 'empty'));
      expect((await captureCandidateSnapshot(candidate)).candidateDigest).not.toBe(ignored.candidateDigest);
      expect(Object.keys(before).sort()).toEqual(['candidateDigest', 'excludedMetadata', 'fileCount', 'format', 'totalBytes']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires explicit native authority, bounded commands, and non-overridable run identity', async () => {
    const { root, config } = await fixture();
    try {
      for (const changed of [
        { ...config, execution: { nativeAccessApproved: false, approvedBy: 'owner' } },
        { ...config, startup: { command: 'node', args: [] } },
        { ...config, limits: { ...config.limits, checkTimeoutMs: 0 } },
        { ...config, negativeControls: [] },
        { ...config, environment: { FAKTORI_VERIFY_RUN_ID: 'fake' } },
        { ...config, negativeControls: [{ id: 'healthy', environment: {}, expectedFailureCode: 'arithmetic' }] },
      ]) expect(() => parseCandidateVerificationConfiguration(changed)).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
