import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NativeIdentityProbe } from '../../src/execution/transports.ts';
import { PersistentPreviewService } from '../../src/preview/index.ts';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const server = `
import { createServer } from 'node:http';
const identity = { format: 'faktori.persistent-preview-identity/v1', previewId: process.env.FAKTORI_PREVIEW_ID, candidateRevision: process.env.FAKTORI_PREVIEW_REVISION, nonce: process.env.FAKTORI_PREVIEW_NONCE, endpoint: 'http://127.0.0.1:' + process.env.PORT };
if (process.env.BAD_IDENTITY === '1') identity.candidateRevision = 'stale-revision';
createServer((request, response) => {
  if (request.url === '/identity') { response.end(JSON.stringify(identity)); return; }
  response.end(JSON.stringify({ persisted: true, revision: identity.candidateRevision }));
}).listen(Number(process.env.PORT), '127.0.0.1');
`;
const identity = `
const response = await fetch(process.env.PREVIEW_URL + '/identity');
console.log(await response.text());
`;

async function port() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}

async function fixture(extraEnvironment = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'faktori-preview-'));
  roots.push(root);
  await writeFile(join(root, 'server.mjs'), server);
  await writeFile(join(root, 'identity.mjs'), identity);
  const localPort = await port();
  const records = [];
  const probe = new NativeIdentityProbe({ cwd: root, env: { PATH: '/usr/bin:/bin' } });
  let unknown = false;
  const journal = { events: () => records, append: async record => { records.push(structuredClone(record)); } };
  const identityProbeFor = () => ({
    inspect: async pid => {
      if (unknown) return { status: 'unknown' };
      const observed = await probe.inspect(pid);
      if (!('status' in observed) || observed.status !== 'unknown') return observed;
      try { process.kill(pid, 0); return observed; } catch (error) { return error.code === 'ESRCH' ? { status: 'absent' } : observed; }
    },
    inspectProcessGroup: async group => unknown ? { status: 'unknown' } : probe.inspectProcessGroup(group),
  });
  const registration = {
    id: 'preview-1', featureId: 'feature-1', implementerId: 'builder-1', ownerApprovedBy: 'owner', worktree: root,
    candidateRevision: 'revision-1', url: `http://127.0.0.1:${localPort}`,
    startup: { command: process.execPath, args: ['server.mjs'] }, identity: { command: process.execPath, args: ['identity.mjs'] },
    environment: { PORT: String(localPort), PREVIEW_URL: `http://127.0.0.1:${localPort}`, ...extraEnvironment },
    browserContexts: { agent: { role: 'agent', contextId: 'agent-context' }, human: { role: 'human', contextId: 'human-context' } },
    limits: { identityTimeoutMs: 2_000, shutdownTimeoutMs: 2_000, outputMaxBytes: 8_000 },
  };
  const service = new PersistentPreviewService({
    journal, identityProbeFor,
    ...options,
  });
  await service.register(registration);
  return { service, records, journal, identityProbeFor, registration, setUnknown: value => { unknown = value; } };
}

describe('persistent human preview lifecycle', () => {
  it('runs an owner-registered local server, verifies its actual runtime revision, and preserves separate browser contexts', async () => {
    const { service, records } = await fixture();
    const started = await service.start('preview-1');
    expect(started).toMatchObject({ state: 'running', evidence: 'current', runtimeRevision: 'revision-1', automaticPush: false, browserEvidence: 'not_recorded' });
    expect(started.browserContexts.agent.contextId).not.toBe(started.browserContexts.human.contextId);
    expect(records.map(record => record.kind)).toEqual(expect.arrayContaining(['preview.registered', 'preview.started', 'preview.identity.verified']));

    const same = await service.start('preview-1');
    expect(same.process.pid).toBe(started.process.pid);
    await expect(fetch(`${same.url}/`, { signal: AbortSignal.timeout(2_000) }).then(response => response.json())).resolves.toEqual({ persisted: true, revision: 'revision-1' });

    const stopped = await service.stop('preview-1');
    expect(stopped).toMatchObject({ state: 'stopped', evidence: 'not_observed' });
    expect(records.at(-1).kind).toBe('preview.stopped');
  }, 15_000);

  it('invalidates a preview whose identity probe reports the wrong runtime revision and never turns it into evidence', async () => {
    const { service } = await fixture({ BAD_IDENTITY: '1' });
    const result = await service.start('preview-1');
    expect(result).toMatchObject({ state: 'invalidated', evidence: 'invalidated' });
    expect(result.detail).toMatch(/preview_identity_mismatch/);
    expect((await service.stop('preview-1')).state).toBe('stopped');
  }, 15_000);

  it('does not duplicate launch while liveness is uncertain; it requires a later observation before a restart', async () => {
    const { service, setUnknown } = await fixture();
    const started = await service.start('preview-1');
    setUnknown(true);
    expect((await service.snapshot('preview-1')).state).toBe('uncertain');
    const blocked = await service.start('preview-1');
    expect(blocked).toMatchObject({ state: 'uncertain', process: { pid: started.process.pid } });
    setUnknown(false);
    expect((await service.stop('preview-1')).state).toBe('stopped');
    const restarted = await service.start('preview-1');
    expect(restarted).toMatchObject({ state: 'running', evidence: 'current' });
    expect(restarted.process.pid).not.toBe(started.process.pid);
    await service.stop('preview-1');
  }, 15_000);

  it('retains an unverified launch PID as durable uncertainty and never launches or signals a duplicate before reconciliation', async () => {
    let observation = 'unknown';
    let launches = 0;
    let signals = 0;
    const commands = {
      start: async () => ({ pid: 71234, completion: new Promise(() => {}) }),
      run: async ({ env }) => ({ exitCode: 0, signal: null, stdout: JSON.stringify({ format: 'faktori.persistent-preview-identity/v1', previewId: env.FAKTORI_PREVIEW_ID, candidateRevision: env.FAKTORI_PREVIEW_REVISION, nonce: env.FAKTORI_PREVIEW_NONCE, endpoint: env.PREVIEW_URL }), stderr: '', timedOut: false, outputLimitExceeded: false }),
      killProcessGroup: () => { signals += 1; },
    };
    const identityProbeFor = () => ({
      inspect: async pid => observation === 'unknown' ? { status: 'unknown' } : { pid, processStartedAt: 'known-start', processGroupId: pid, running: true },
      inspectProcessGroup: async group => observation === 'unknown' ? { status: 'unknown' } : { processGroupId: group, members: [{ pid: group, processStartedAt: 'known-start', processGroupId: group, running: true }] },
    });
    const originalStart = commands.start;
    commands.start = async input => { launches += 1; return originalStart(input); };
    const { service, records } = await fixture({}, { commands, identityProbeFor });
    const uncertain = await service.start('preview-1');
    expect(uncertain).toMatchObject({ state: 'uncertain', evidence: 'not_observed' });
    const launchPid = records.find(record => record.kind === 'preview.observation.uncertain')?.data?.pid;
    expect(typeof launchPid).toBe('number');
    expect(launches).toBe(1);
    expect((await service.stop('preview-1')).state).toBe('uncertain');
    expect(signals).toBe(0);
    expect((await service.start('preview-1')).state).toBe('uncertain');
    expect(launches).toBe(1);
    expect(records.some(record => record.kind === 'preview.stopped')).toBe(false);

    observation = 'known';
    const reconciled = await service.start('preview-1');
    expect(reconciled).toMatchObject({ state: 'running', evidence: 'current', process: { pid: launchPid } });
    expect(launches).toBe(1);
  }, 15_000);

  it('hydrates a persisted process as uncertain, then observes its identity before avoiding a duplicate restart', async () => {
    const { service, records, identityProbeFor, registration } = await fixture();
    const started = await service.start('preview-1');
    const incompleteJournal = { events: () => records.filter(record => record.kind !== 'preview.identity.verified'), append: async record => { records.push(structuredClone(record)); } };
    const restored = new PersistentPreviewService({ journal: incompleteJournal, identityProbeFor });
    expect(await restored.register(registration)).toMatchObject({ state: 'uncertain', evidence: 'not_observed', process: { pid: started.process.pid } });
    const observed = await restored.start('preview-1');
    expect(observed).toMatchObject({ state: 'running', evidence: 'current', runtimeRevision: 'revision-1', process: { pid: started.process.pid } });
    await restored.stop('preview-1');
  }, 15_000);

  it('keeps feedback inside one feature and implementer, and invalidates old preview evidence when an edit changes revision', async () => {
    const { service, records } = await fixture();
    await service.start('preview-1');
    await service.feedback('preview-1', { kind: 'requested', itemId: 'feedback-1', featureId: 'feature-1', implementerId: 'builder-1', revision: 'revision-1', summary: 'Tighten the empty state.' });
    await service.feedback('preview-1', { kind: 'applied', itemId: 'feedback-1', featureId: 'feature-1', implementerId: 'builder-1', revision: 'revision-2' });
    const confirmed = await service.feedback('preview-1', { kind: 'confirmed', itemId: 'feedback-1', featureId: 'feature-1', implementerId: 'builder-1', revision: 'revision-2' });
    expect(confirmed).toMatchObject({ finalReview: 'blocked', evidence: 'invalidated', state: 'invalidated' });
    expect(confirmed.automaticPush).toBe(false);
    expect(records.map(record => record.kind)).toEqual(expect.arrayContaining(['preview.feedback.requested', 'preview.feedback.applied', 'preview.feedback.confirmed', 'preview.final-review.ready']));
    await expect(service.feedback('preview-1', { kind: 'requested', itemId: 'feedback-2', featureId: 'another-feature', implementerId: 'builder-1', revision: 'revision-2', summary: 'out of scope' })).rejects.toThrow(/registered feature/);
    await service.stop('preview-1');
  }, 15_000);
});
