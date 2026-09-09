import { describe, expect, it } from 'vitest';
import { consoleActivity } from '../../src/console/activity.ts';

describe('summarized task progression', () => {
  it('rebuilds stable milestones without exposing private messages, session output or confusing completion with acceptance', () => {
    const runs = [{ intent: { runId: 'run-1', workItem: { id: 'DEMO-7' }, target: { productId: 'product', podId: 'pod' } } }];
    const event = (eventId, kind, data = {}) => ({ eventId, runId: 'run-1', occurredAt: '2026-09-09T10:00:00Z', kind, data });
    const events = [event('1', 'run.admitted'), event('2', 'worker.started'), event('3', 'message.queued', { body: 'private instruction' }), event('4', 'provider.event', { type: 'assistant.message', event: { text: 'private reasoning' } }), event('5', 'provider.final', { result: { outcome: 'completed', summary: 'secret output', sessionId: 'private-session' } })];
    const feed = consoleActivity(events, runs, []);
    expect(feed).toHaveLength(4);
    expect(feed.find((entry) => entry.id === 'run:5').summary).toContain('acceptance is evaluated separately');
    expect(feed.every((entry) => entry.productId === 'product' && entry.podId === 'pod' && entry.runId === 'run-1')).toBe(true);
    expect(JSON.stringify(feed)).not.toMatch(/private|secret/);
    expect(consoleActivity(events, runs, [])).toEqual(feed);
  });

  it('combines loop review and repair outcomes with deduplicated Jira changes, newest first and bounded', () => {
    const loops = [{ id: 'build', productId: 'product', status: 'running', stale: true, updatedAt: '2026-09-09T12:00:00Z', completedPhases: [], currentStage: { phaseId: 'phase-1', kind: 'repair', round: 1 }, stages: [{ phaseId: 'phase-1', kind: 'review', round: 0, outcome: 'completed', decision: 'repair', verification: 'failed', completedAt: '2026-09-09T11:00:00Z' }] }];
    const jira = { id: 'jira:change', at: '2026-09-09T11:30:00Z', source: 'jira', issueKey: 'DEMO-7', summary: 'DEMO-7: To Do → In Progress' };
    const feed = consoleActivity([], [], loops, [jira, jira]);
    expect(feed).toHaveLength(3);
    expect(feed[0].summary).toContain('record is stale');
    expect(feed[1]).toEqual(jira);
    expect(feed[2].summary).toContain('decision: repair · verification: failed');
    expect(consoleActivity([], [], [], Array.from({ length: 150 }, (_, index) => ({ ...jira, id: `jira:${index}` })))).toHaveLength(100);
  });

  it('preserves quieter product and source histories before the browser applies its selected filter', () => {
    const busy = Array.from({ length: 150 }, (_, index) => ({ id: `busy:${index}`, at: '2026-09-09T12:00:00Z', source: 'run', productId: 'busy', summary: 'Work started' }));
    const quiet = { id: 'quiet:1', at: '2026-09-09T11:00:00Z', source: 'run', productId: 'quiet', summary: 'Waiting for review' };
    const jira = { id: 'jira:1', at: '2026-09-09T10:00:00Z', source: 'jira', productId: 'busy', summary: 'Issue moved to review' };
    const feed = consoleActivity([], [], [], [...busy, quiet, jira]);
    expect(feed).toHaveLength(102);
    expect(feed).toEqual(expect.arrayContaining([quiet, jira]));
  });
});
