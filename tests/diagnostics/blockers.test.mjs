import { describe, expect, it } from 'vitest';

import { createDelegationBlocker, projectStructuredBlocker, structuredBlockersFromEvents } from '../../src/diagnostics/blockers.ts';

describe('structured blocker diagnostics', () => {
  it('sorts and deduplicates safe overlap pairs while visibly omitting unsafe details', () => {
    const blocker = createDelegationBlocker({
      reasonCode: 'ownership_conflicts_with_active_child',
      parentRunId: 'parent',
      workstreamId: 'Bearer-secret',
      delegationId: 'review',
      requestedPaths: ['src/app.ts', 'src/app.ts', '../escape', 'file:/private/control', '.faktori/state'],
      conflicting: [
        { paths: ['src', 'src', '/Users/nobody/.codex/token'], childRunId: 'child-1', delegationId: 'implement' },
        { paths: ['src'], childRunId: 'file:/private/run', delegationId: 'unsafe' },
      ],
    });
    expect(blocker.related).toEqual({ parentRunId: 'parent', delegationId: 'review' });
    expect(blocker.ownership).toEqual({ state: 'observed', paths: ['src/app.ts'], omittedPathCount: 4 });
    expect(blocker.overlaps).toEqual([{ requestedPath: 'src/app.ts', existingPath: 'src', existingChildRunId: 'child-1', existingDelegationId: 'implement' }]);
    expect(blocker.omittedIdentityCount).toBe(2);
    expect(JSON.stringify(blocker)).not.toMatch(/Bearer|secret|escape|file:|Users|codex/);
    expect(JSON.stringify(blocker)).not.toContain('.faktori');
  });

  it('recomputes identity from safe fields instead of trusting projected IDs or remediation text', () => {
    const first = createDelegationBlocker({ reasonCode: 'token_reservation_exceeded', parentRunId: 'parent', requestedPaths: ['src/app.ts'] });
    const projected = projectStructuredBlocker({ ...first, blockerId: 'forged', remediation: 'Launch a provider now.' });
    expect(projected).toEqual(first);
    expect(projected.blockerId).not.toBe('forged');
    expect(projected.remediation).not.toMatch(/Launch/);
  });

  it('omits credential-shaped identities and paths', () => {
    for (const credential of [`sk-${'A'.repeat(24)}`, `sk_live_${'A'.repeat(24)}`]) {
      const blocker = createDelegationBlocker({ reasonCode: 'ownership_conflicts_with_active_child', parentRunId: credential, requestedPaths: [`src/${credential}.ts`] });
      expect(blocker.related).toEqual({});
      expect(blocker.ownership).toMatchObject({ paths: [], omittedPathCount: 1 });
      expect(JSON.stringify(blocker)).not.toContain(credential);
    }
  });

  it('omits private control and credential-storage paths', () => {
    const blocker = createDelegationBlocker({
      reasonCode: 'ownership_conflicts_with_active_child',
      requestedPaths: ['src/app.ts', '.env', '.env.local', '.npmrc', '.netrc', '.ssh/id_rsa', '~/.ssh/id_rsa'],
    });
    expect(blocker.ownership).toEqual({ state: 'observed', paths: ['src/app.ts'], omittedPathCount: 6 });
    expect(JSON.stringify(blocker)).not.toMatch(/\.env|\.npmrc|\.netrc|\.ssh|id_rsa/);
  });

  it('removes a conflict blocker once the named child has a terminal receipt', () => {
    const blocker = createDelegationBlocker({
      reasonCode: 'ownership_conflicts_with_active_child',
      parentRunId: 'parent',
      delegationId: 'next-child',
      requestedPaths: ['src/app.ts'],
      conflicting: [{ paths: ['src'], childRunId: 'active-child', delegationId: 'active-delegation' }],
    });
    const events = [
      { format: 'faktori.run-event/v1', eventId: 'blocked', runId: 'parent', occurredAt: '2026-09-07T00:00:00.000Z', kind: 'provider.event', data: { type: 'delegation.blocked', blocker } },
      { format: 'faktori.run-event/v1', eventId: 'terminal', runId: 'active-child', occurredAt: '2026-09-07T00:00:01.000Z', kind: 'provider.final', data: { result: { outcome: 'completed' } } },
    ];
    expect(structuredBlockersFromEvents(events)).toEqual([]);
  });

  it('retains unresolved overlap details when only one of several conflicting children terminates', () => {
    const blocker = createDelegationBlocker({
      reasonCode: 'ownership_conflicts_with_active_child', parentRunId: 'parent', delegationId: 'next-child', requestedPaths: ['src/app.ts'],
      conflicting: [
        { paths: ['src'], childRunId: 'child-a', delegationId: 'delegation-a' },
        { paths: ['src/app.ts'], childRunId: 'child-b', delegationId: 'delegation-b' },
      ],
    });
    const projected = structuredBlockersFromEvents([
      { format: 'faktori.run-event/v1', eventId: 'blocked', runId: 'parent', occurredAt: '2026-09-07T00:00:00.000Z', kind: 'provider.event', data: { type: 'delegation.blocked', blocker } },
      { format: 'faktori.run-event/v1', eventId: 'terminal-a', runId: 'child-a', occurredAt: '2026-09-07T00:00:01.000Z', kind: 'provider.final', data: { result: { outcome: 'completed' } } },
    ]);
    expect(projected).toHaveLength(1);
    expect(projected[0].overlaps).toEqual([{ requestedPath: 'src/app.ts', existingPath: 'src/app.ts', existingChildRunId: 'child-b', existingDelegationId: 'delegation-b' }]);
  });
});
