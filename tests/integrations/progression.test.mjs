import { describe, expect, it } from 'vitest';

import { evaluateCommitProgression } from '../../src/integrations/progression.ts';

const evidence = (kind, commit, verdict, observedAt, extra = {}) => ({ kind, commit, verdict, source: `${kind}-provider`, observedAt, ...extra });

describe('commit-bound review and check progression', () => {
  it('does not let green checks and an approval on an older head clear a changed commit', () => {
    const result = evaluateCommitProgression('head-b', [
      evidence('review', 'head-a', 'passed', '2026-09-05T00:00:00Z'),
      evidence('check', 'head-a', 'passed', '2026-09-05T00:01:00Z'),
    ]);
    expect(result).toEqual(expect.objectContaining({ state: 'waiting_for_review', review: 'pending', checks: 'pending', mergeAuthority: 'human' }));
  });

  it('keeps review and CI separate and records a successful exact head as human-merge ready only', () => {
    const result = evaluateCommitProgression('head-b', [
      evidence('review', 'head-b', 'passed', '2026-09-05T00:00:00Z'),
      evidence('check', 'head-b', 'passed', '2026-09-05T00:01:00Z'),
    ]);
    expect(result).toEqual(expect.objectContaining({ state: 'ready_for_human_merge', mergeAuthority: 'human' }));
  });

  it('keeps a waiver distinct from passing evidence and requires named authority', () => {
    const missingAuthority = evaluateCommitProgression('head-b', [evidence('review', 'head-b', 'waived', '2026-09-05T00:00:00Z'), evidence('check', 'head-b', 'passed', '2026-09-05T00:01:00Z')]);
    const authorized = evaluateCommitProgression('head-b', [evidence('review', 'head-b', 'waived', '2026-09-05T00:00:00Z', { waiverAuthority: 'owner-decision-7' }), evidence('check', 'head-b', 'passed', '2026-09-05T00:01:00Z')]);
    expect(missingAuthority).toEqual(expect.objectContaining({ state: 'waiting_for_review' }));
    expect(authorized).toEqual(expect.objectContaining({ state: 'waived', review: 'waived', checks: 'passed', mergeAuthority: 'human' }));
  });

  it('uses the latest exact observation so a later failed check blocks progression', () => {
    const result = evaluateCommitProgression('head-b', [
      evidence('review', 'head-b', 'passed', '2026-09-05T00:00:00Z'),
      evidence('check', 'head-b', 'passed', '2026-09-05T00:01:00Z'),
      evidence('check', 'head-b', 'failed', '2026-09-05T00:02:00Z'),
    ]);
    expect(result).toEqual(expect.objectContaining({ state: 'failed', checks: 'failed' }));
  });

  it('does not let a later passing build check erase a failing required security check', () => {
    const result = evaluateCommitProgression('head-b', [
      evidence('review', 'head-b', 'passed', '2026-09-05T00:00:00Z', { source: 'reviewer-1' }),
      evidence('check', 'head-b', 'failed', '2026-09-05T00:01:00Z', { source: 'security' }),
      evidence('check', 'head-b', 'passed', '2026-09-05T00:02:00Z', { source: 'build' }),
    ]);
    expect(result).toEqual(expect.objectContaining({ state: 'failed', checks: 'failed' }));
  });
});
