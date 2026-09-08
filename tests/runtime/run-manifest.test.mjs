import { describe, expect, it } from 'vitest';

import { createRunManifest, parseRunManifestJournal } from '../../src/runtime/run-manifest.ts';

const contextDigest = 'a'.repeat(64);
const inputDigest = 'b'.repeat(64);

function event(kind, data, eventId = kind) {
  return { format: 'faktori.run-event/v1', eventId, runId: 'run-1', occurredAt: '2026-09-07T00:00:00.000Z', kind, data };
}

function intent(overrides = {}) {
  return {
    format: 'faktori.run-intent/v1', runId: 'run-1', admissionKey: 'admission',
    workItem: { id: 'work-1', revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', podId: 'pod', repository: 'org/repo', branch: 'build/phase-8', baseRevision: 'base@1', expectedRevision: 'expected@1' },
    context: { packetRevision: 'packet@1', digest: contextDigest },
    execution: { profile: 'isolated', workspaceId: 'workspace-1', workspacePath: '/private/tmp/never-exported', providerId: 'codex', model: 'gpt-5.6-terra', approvedInputDigests: [inputDigest] },
    budget: { reservationId: 'reservation', maxRuntimeMinutes: 30, estimatedTokens: 2000, status: 'held' },
    authority: { secret: 'never-exported' }, attempt: 1, createdAt: '2026-09-07T00:00:00.000Z', ...overrides,
  };
}

describe('run manifest', () => {
  it('reports only safe observed provenance, resources, outcome, and usage with a stable digest', () => {
    const events = [
      event('run.admitted', { intent: intent() }, 'admitted'),
      event('provider.final', { result: { outcome: 'completed', sessionId: 'session-123', summary: 'raw summary', revision: 'artifact@2', verification: ['raw proof'], usage: { availability: 'reported', inputTokens: 7, cachedInputTokens: 3, outputTokens: 11, reasoningTokens: 5, reportedBy: 'native-meter' }, nativeCancellationReceipt: true } }, 'final'),
    ];
    const first = createRunManifest(events, 'run-1');
    const reordered = createRunManifest(events.map((item) => JSON.parse(JSON.stringify(item))), 'run-1');
    expect(first).toEqual(reordered);
    expect(first.observations).toEqual(expect.objectContaining({
      target: expect.objectContaining({ repository: 'org/repo', expectedRevision: 'expected@1' }),
      execution: { profile: 'isolated', workspaceId: 'workspace-1', providerId: 'codex', model: 'gpt-5.6-terra', approvedInputDigests: [inputDigest] },
      resources: { maxRuntimeMinutes: 30, estimatedTokens: 2000, status: 'held' },
      outcome: { outcome: 'completed', revision: 'artifact@2' },
      usage: { availability: 'reported', inputTokens: 7, cachedInputTokens: 3, outputTokens: 11, reasoningTokens: 5 },
    }));
    expect(JSON.stringify(first)).not.toMatch(/workspacePath|session-123|raw summary|raw proof|never-exported|reportedBy|authority/i);
    expect(first.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps unavailable usage unknown and does not derive totals from cached or reasoning counts', () => {
    const manifest = createRunManifest([
      event('run.admitted', { intent: intent() }),
      event('provider.final', { result: { outcome: 'failed', usage: { availability: 'unavailable', unavailableReason: 'meter unavailable' }, nativeCancellationReceipt: false } }),
    ], 'run-1');
    expect(manifest.observations.usage).toEqual({ availability: 'unavailable' });
    expect(JSON.stringify(manifest)).not.toContain('meter unavailable');
  });

  it('omits unsafe values, exact-schema violations, URLs, paths, and secret-bearing provider fields', () => {
    const poisoned = intent({
      target: { factoryId: 'factory', productId: 'product', repository: 'https://token:secret@example.test/repo', branch: '../escape', baseRevision: 'base@1', expectedRevision: 'expected@1', extra: 'forbidden' },
      execution: { profile: 'native', workspaceId: 'workspace', workspacePath: '/Users/nathan/.codex/session', providerId: 'Bearer secret', model: 'model', approvedInputDigests: ['https://bad.test/input'] },
    });
    const manifest = createRunManifest([
      event('run.admitted', { intent: poisoned }),
      event('provider.final', { result: { outcome: 'completed', revision: '/home/nathan/secret', usage: { availability: 'reported', outputTokens: 4, secret: 'api_key=leak' }, nativeCancellationReceipt: false, extra: 'forbidden' } }),
    ], 'run-1');
    expect(manifest.observations.target).toBeUndefined();
    expect(manifest.observations.execution).toBeUndefined();
    expect(manifest.observations.outcome).toBeUndefined();
    expect(manifest.observations.usage).toBeUndefined();
    expect(manifest.omissions).toEqual(expect.arrayContaining([
      { category: 'target', reason: 'unsafe_or_invalid' },
      { category: 'execution', reason: 'unsafe_or_invalid' },
      { category: 'outcome', reason: 'unsafe_or_invalid' },
      { category: 'usage', reason: 'unsafe_or_invalid' },
    ]));
    expect(JSON.stringify(manifest)).not.toMatch(/api_key|example\.test|Users|home|escape/i);
  });

  it('rejects credential signatures even when they otherwise match a field grammar', () => {
    for (const credential of [`sk-${'A'.repeat(24)}`, `sk_live_${'A'.repeat(24)}`]) {
      const poisoned = intent({
        target: { ...intent().target, baseRevision: credential },
        context: { packetRevision: 'packet@1', digest: credential },
        execution: { ...intent().execution, model: credential, approvedInputDigests: [credential] },
      });
      const manifest = createRunManifest([event('run.admitted', { intent: poisoned })], 'run-1');
      expect(manifest.observations.target).toBeUndefined();
      expect(manifest.observations.context).toBeUndefined();
      expect(manifest.observations.execution).toBeUndefined();
      expect(JSON.stringify(manifest)).not.toContain(credential);
    }
  });

  it('reports every category missing when no safe run observation exists', () => {
    const manifest = createRunManifest([event('message.queued', { message: { body: 'prompt with secret=never' } })], 'run-1');
    expect(manifest.observations).toEqual({});
    expect(manifest.omissions).toEqual([
      { category: 'target', reason: 'not_observed' }, { category: 'workItem', reason: 'not_observed' }, { category: 'context', reason: 'not_observed' },
      { category: 'execution', reason: 'not_observed' }, { category: 'resources', reason: 'not_observed' }, { category: 'outcome', reason: 'not_observed' }, { category: 'usage', reason: 'not_observed' },
    ]);
  });

  it('parses only committed validated records without mutating or trusting an incomplete tail', () => {
    const admitted = event('run.admitted', { intent: intent() }, 'admitted');
    const contents = `${JSON.stringify(admitted)}\n${JSON.stringify({ ...admitted, eventId: 'uncommitted' })}`;
    expect(parseRunManifestJournal(contents)).toEqual([admitted]);
    expect(parseRunManifestJournal(`${JSON.stringify({ ...admitted, kind: 'future.observation' })}\n`)).toEqual([{ ...admitted, kind: 'future.observation' }]);
    expect(() => parseRunManifestJournal(`${JSON.stringify(admitted)}\n${JSON.stringify({ ...admitted, data: {} })}\n`)).toThrow(/conflicting content/);
  });
});
