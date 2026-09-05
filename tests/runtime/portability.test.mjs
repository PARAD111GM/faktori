import { describe, expect, it } from 'vitest';

import { assignPortableRoles, createPortableHandoff } from '../../src/runtime/portability.ts';

function handoff(overrides = {}) {
  return {
    handoffKey: 'implementation-to-review@1',
    sourceRunId: 'implementation-run',
    sourceProviderId: 'claude',
    targetProviderId: 'cursor',
    role: 'independent_review',
    scope: {
      factoryId: 'factory', productId: 'product', repository: 'org/repo', workItemId: 'work-1',
      workItemRevision: 'work@2', contextRevision: 'context@3', authorityRevision: 'authority@1', authorityEpoch: 2,
    },
    artifacts: [{ artifactId: 'implementation', kind: 'implementation', revision: 'impl@1', digest: 'sha256:implementation', reference: 'artifacts/implementation.md' }],
    verification: ['tests passed at implementation revision'],
    summary: 'Review the accepted implementation against the supplied plan and evidence.',
    createdAt: '2026-09-05T05:00:00.000Z',
    ...overrides,
  };
}

describe('portable role assignment', () => {
  it.each(['codex', 'claude', 'cursor'])('keeps a one-provider %s factory functional with a distinct review session', (providerId) => {
    const assignments = assignPortableRoles([providerId]);
    expect(assignments.map((assignment) => assignment.providerId)).toEqual([providerId, providerId, providerId]);
    expect(assignments.map((assignment) => assignment.role)).toEqual(['planning', 'implementation', 'independent_review']);
    expect(new Set(assignments.map((assignment) => assignment.sessionPurpose)).size).toBe(3);
  });

  it('supports explicit planning, implementation and review routing across all three providers', () => {
    expect(assignPortableRoles(['codex', 'claude', 'cursor'], {
      planning: 'cursor', implementation: 'claude', independent_review: 'codex',
    })).toEqual([
      { role: 'planning', providerId: 'cursor', sessionPurpose: 'planning-session' },
      { role: 'implementation', providerId: 'claude', sessionPurpose: 'implementation-session' },
      { role: 'independent_review', providerId: 'codex', sessionPurpose: 'independent_review-session' },
    ]);
  });

  it('rejects unavailable, duplicate and empty provider configurations', () => {
    expect(() => assignPortableRoles([])).toThrow(/at least one/i);
    expect(() => assignPortableRoles(['codex', 'codex'])).toThrow(/unique/i);
    expect(() => assignPortableRoles(['codex'], { planning: 'claude' })).toThrow(/unavailable/i);
  });
});

describe('cross-provider artifact handoff', () => {
  it('is deterministic and transfers accepted artifacts and evidence without native session state', () => {
    const first = createPortableHandoff(handoff());
    const replay = createPortableHandoff(handoff({ createdAt: '2026-09-05T06:00:00.000Z' }));

    expect(first.idempotencyKey).toBe(replay.idempotencyKey);
    expect(first.handoffId).toBe(replay.handoffId);
    expect(first).toEqual(expect.objectContaining({ sourceProviderId: 'claude', targetProviderId: 'cursor', role: 'independent_review' }));
    expect(JSON.stringify(first)).not.toMatch(/sessionId|privateReasoning|credential|token/i);
  });

  it('rejects same-provider, empty, duplicate, private-path and authority-bearing payloads', () => {
    expect(() => createPortableHandoff(handoff({ targetProviderId: 'claude' }))).toThrow(/different/);
    expect(() => createPortableHandoff(handoff({ artifacts: [] }))).toThrow(/artifact/);
    expect(() => createPortableHandoff(handoff({ artifacts: [handoff().artifacts[0], handoff().artifacts[0]] }))).toThrow(/duplicate/i);
    expect(() => createPortableHandoff(handoff({ artifacts: [{ ...handoff().artifacts[0], reference: '/Users/person/.claude/session.json' }] }))).toThrow(/private paths/i);
    expect(() => createPortableHandoff({ ...handoff(), publisherCredential: 'forbidden' })).toThrow(/unsupported private/);
  });
});
