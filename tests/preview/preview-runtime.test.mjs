import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PersistentPreviewRuntime, parsePersistentPreviewRuntimeConfiguration, redactPreviewFeedbackSummary } from '../../src/console/preview-runtime.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const server = `
import { createServer } from 'node:http';
const identity = { format: 'faktori.persistent-preview-identity/v1', previewId: process.env.FAKTORI_PREVIEW_ID, candidateRevision: process.env.FAKTORI_PREVIEW_REVISION, nonce: process.env.FAKTORI_PREVIEW_NONCE, endpoint: process.env.PREVIEW_URL };
createServer((request, response) => response.end(JSON.stringify(identity))).listen(Number(process.env.PORT), '127.0.0.1');
`;
const probe = `console.log(await (await fetch(process.env.PREVIEW_URL)).text());`;

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'faktori-preview-runtime-')); roots.push(root);
  await writeFile(join(root, 'server.mjs'), server); await writeFile(join(root, 'probe.mjs'), probe);
  const port = await freePort(); const url = `http://127.0.0.1:${port}`;
  const coordinator = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(root, 'ops.jsonl'), projectionPath: join(root, 'projection.sqlite'), identity: { instanceId: 'preview-test', pid: process.pid, processStartedAt: 'test-start' }, limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 1, maxTokens: 1, strictSpending: false, strictSpendingSupported: false } });
  await coordinator.claim();
  const configuration = {
    format: 'faktori.persistent-preview-runtime/v1',
    registrations: [{ id: 'preview-1', featureId: 'feature-1', implementerId: 'builder-1', ownerApprovedBy: 'owner', worktree: root, candidateRevision: 'rev-1', url,
      startup: { command: process.execPath, args: ['server.mjs'] }, identity: { command: process.execPath, args: ['probe.mjs'] }, environment: { PORT: String(port), PREVIEW_URL: url },
      browserContexts: { agent: { contextId: 'agent-context', role: 'agent' }, human: { contextId: 'human-context', role: 'human' } } }],
    operations: [
      { id: 'preview-start', previewId: 'preview-1', kind: 'start' },
      { id: 'preview-verify', previewId: 'preview-1', kind: 'verify' },
      { id: 'feedback-request', previewId: 'preview-1', kind: 'feedback', feedback: { kind: 'requested', itemId: 'feedback-1', featureId: 'feature-1', implementerId: 'builder-1', revision: 'rev-1', summary: 'Keep the single batch concise.' } },
      { id: 'preview-stop', previewId: 'preview-1', kind: 'stop' },
    ],
  };
  return { coordinator, configuration };
}

describe('persistent preview Console facade', () => {
  it('accepts only server-owned registration and operation contracts, then runs operations by ID', async () => {
    const { coordinator, configuration } = await fixture();
    const runtime = new PersistentPreviewRuntime({ coordinator, configuration: parsePersistentPreviewRuntimeConfiguration(configuration) });
    try {
      expect(await runtime.start()).toMatchObject({ browserInput: 'operation_id_or_bounded_feedback', previews: expect.arrayContaining([expect.objectContaining({ state: 'stopped' })]), operations: expect.arrayContaining([expect.objectContaining({ id: 'preview-start', previewId: 'preview-1', kind: 'start' })]) });
      expect(await runtime.command('preview-start')).toMatchObject({ state: 'running', evidence: 'current' });
      expect(await runtime.command('preview-verify')).toMatchObject({ state: 'running', runtimeRevision: 'rev-1' });
      await expect(runtime.requestFeedback('preview-1', { itemId: 'feedback-human', summary: 'Wrong revision must not be recorded.', revision: 'old-revision' })).rejects.toThrow('preview_feedback_revision_stale');
      expect(await runtime.requestFeedback('preview-1', { itemId: 'feedback-human', summary: 'Use the current preview revision.', revision: 'rev-1' })).toMatchObject({ feedback: [expect.objectContaining({ id: 'feedback-human', requestedRevision: 'rev-1' })] });
      const redacted = await runtime.requestFeedback('preview-1', { itemId: 'feedback-redacted', summary: 'Token: abcdefghijkl /Users/nathan/private-note', revision: 'rev-1' });
      expect(redacted.feedback.find(item => item.id === 'feedback-redacted')?.summary).toBe('Token: [redacted credential] [redacted local path]');
      await expect(runtime.confirmFeedback('preview-1', { itemId: 'unknown-feedback', revision: 'rev-1' })).rejects.toThrow('feedback item was not requested');
      expect(await runtime.command('feedback-request')).toMatchObject({ finalReview: 'blocked', feedback: expect.arrayContaining([expect.objectContaining({ id: 'feedback-1' })]) });
      await expect(runtime.command('start --unsafe')).rejects.toThrow('preview_operation_not_allowlisted');
      expect(await runtime.command('preview-stop')).toMatchObject({ state: 'stopped' });
      expect(coordinator.journal.events().some(event => event.kind === 'factory.delivery' && event.data.family === 'preview')).toBe(true);
    } finally { await runtime.shutdown(); await coordinator.release(); coordinator.close(); }
  }, 15_000);

  it('rejects browser-shaped configuration that embeds an executable or an unregistered preview', () => {
    expect(() => parsePersistentPreviewRuntimeConfiguration({ format: 'faktori.persistent-preview-runtime/v1', registrations: [], operations: [{ id: 'browser-command', previewId: 'missing', kind: 'start', command: 'sh' }] })).toThrow();
  });
  it('redacts credentials and host paths without altering ordinary feedback copy', () => {
    expect(redactPreviewFeedbackSummary('Tighten the empty-state sentence.')).toBe('Tighten the empty-state sentence.');
    expect(redactPreviewFeedbackSummary('Bearer abcdefghijkl at /private/tmp/notes')).toBe('[redacted credential] at [redacted local path]');
  });
});
