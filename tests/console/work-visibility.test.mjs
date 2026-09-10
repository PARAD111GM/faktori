import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ActivityFeed, JiraWorkBoard, filterActivity, filterJiraIssues, jiraBoardMatches } from '../../console/src/work-visibility.tsx';
import { Overview } from '../../console/src/main.tsx';
import { ManagerLoops } from '../../console/src/manager-loops.tsx';

const board = {
  id: 'board-a', projectKey: 'TWZ', productId: 'product-a', podId: 'pod-a', status: 'stale', lastSyncedAt: '2026-09-09T12:00:00Z', truncated: true,
  issues: [
    { key: 'TWZ-4', summary: 'Wire factory home', status: 'In Progress', statusCategory: 'indeterminate', assignee: 'Nathan', updatedAt: '2026-09-09T11:00:00Z', url: 'https://jira.example/browse/TWZ-4' },
    { key: 'TWZ-5', summary: 'Ship the gate', status: 'Ready for Deployment', statusCategory: 'new', updatedAt: '2026-09-09T10:00:00Z', url: 'javascript:alert(1)' },
  ],
};

describe('Console work visibility', () => {
  it('filters Jira work by scope and user-visible issue fields', () => {
    expect(jiraBoardMatches(board, { productId: 'product-a', podId: 'pod-a' })).toBe(true);
    expect(jiraBoardMatches(board, { productId: 'product-b', podId: '' })).toBe(false);
    expect(filterJiraIssues(board.issues, ' nathan ')).toEqual([board.issues[0]]);
    expect(filterJiraIssues(board.issues, 'ready for deployment')).toEqual([board.issues[1]]);
    expect(filterJiraIssues(board.issues, 'TWZ-4')).toEqual([board.issues[0]]);
  });

  it('shows native Jira statuses, stale and truncation truth, safe links, and a same-scope coordinator run', () => {
    const html = renderToStaticMarkup(createElement(JiraWorkBoard, {
      boards: [board],
      runs: [{ runId: 'run-4', workItem: { id: 'TWZ-4' }, target: { productId: 'product-a', podId: 'pod-a' } }],
      filter: { productId: 'product-a', podId: 'pod-a' },
      selectRun() {},
    }));
    expect(html).toContain('In Progress');
    expect(html).toContain('Ready for Deployment');
    expect(html).toContain('showing the last successful Jira sync');
    expect(html).toContain('This view is truncated');
    expect(html).toContain('href="https://jira.example/browse/TWZ-4"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Open coordinator run');
    expect(html).not.toContain('draggable');

    const unavailable = renderToStaticMarkup(createElement(JiraWorkBoard, {
      boards: [{ ...board, status: 'unavailable', issues: [], message: 'Jira request timed out.' }],
      runs: [], filter: { productId: 'product-a', podId: 'pod-a' }, selectRun() {},
    }));
    expect(unavailable).toContain('could not be refreshed');
    expect(unavailable).toContain('Jira request timed out.');
    expect(unavailable).toContain('Jira work unavailable');
  });

  it('explains Jira setup without hiding the existing execution surface', () => {
    const html = renderToStaticMarkup(createElement(JiraWorkBoard, { boards: [], runs: [], filter: { productId: '', podId: '' }, selectRun() {} }));
    expect(html).toContain('Jira is not configured');
    expect(html).toContain('docs/console-jira.md');
    expect(html).toContain('Execution runs remain available');
  });

  it('scopes, sorts, filters and bounds deterministic activity summaries', () => {
    const items = Array.from({ length: 105 }, (_, index) => ({
      id: `event-${index}`, at: new Date(Date.UTC(2026, 8, 9, 0, index)).toISOString(), source: index % 2 ? 'run' : 'jira', summary: `Published event ${index}`, productId: 'product-a', podId: 'pod-a', ...(index % 2 ? { runId: `run-${index}` } : { issueKey: `TWZ-${index}`, url: 'https://jira.example' }),
    }));
    items.push({ id: 'other', at: '2027-01-01T00:00:00Z', source: 'loop', summary: 'Other product', productId: 'product-b' });
    const visible = filterActivity(items, { productId: 'product-a', podId: 'pod-a' });
    expect(visible).toHaveLength(100);
    expect(visible[0]?.summary).toBe('Published event 104');
    expect(visible.some((item) => item.id === 'other')).toBe(false);
    expect(filterActivity(items, { productId: 'product-a', podId: 'pod-a' }, 'jira').every((item) => item.source === 'jira')).toBe(true);
  });

  it('renders activity with timestamps, run selection, source links, and a truthful empty state', () => {
    const items = [
      { id: 'run-event', at: '2026-09-09T12:00:00Z', source: 'run', summary: 'TWZ-4 started', productId: 'product-a', runId: 'run-4' },
      { id: 'jira-event', at: '2026-09-09T12:01:00Z', source: 'jira', summary: 'TWZ-4 moved to review', productId: 'product-a', issueKey: 'TWZ-4', url: 'https://jira.example/browse/TWZ-4' },
    ];
    const html = renderToStaticMarkup(createElement(ActivityFeed, { items, filter: { productId: 'product-a', podId: '' }, selectRun() {} }));
    expect(html.indexOf('moved to review')).toBeLessThan(html.indexOf('started'));
    expect(html).toContain('Open run');
    expect(html).toContain('Open source');
    expect(html).toContain('dateTime="2026-09-09T12:01:00Z"');
    const empty = renderToStaticMarkup(createElement(ActivityFeed, { items, filter: { productId: 'missing', podId: '' }, selectRun() {} }));
    expect(empty).toContain('No activity published');
  });

  it('keeps a compact link to completed Manager Loop work when no coordinator run exists', () => {
    const completedLoop = {
      id: 'two-phase-math-proof', productId: 'product-a', podId: 'pod-a', status: 'succeeded', stale: false,
      updatedAt: '2026-09-09T12:02:00Z', completedPhases: ['prove-addition', 'prove-subtraction'], currentStage: undefined,
      stages: [{ phaseId: 'prove-subtraction', kind: 'review', round: 0, outcome: 'completed', completedAt: '2026-09-09T12:02:00Z', decision: 'accept', verification: 'passed' }],
    };
    const html = renderToStaticMarkup(createElement(Overview, {
      state: { managerLoops: [completedLoop], blockers: [] }, runs: [], filter: { productId: 'product-a', podId: 'pod-a' }, selectRun() {},
    }));
    expect(html).toContain('Current and recent work');
    expect(html).toContain('1 recorded Manager Loop available in <a href="#work">Work</a>');
    expect(html).not.toContain('Last step: prove-subtraction / review');
    expect(html).toContain('Coordinator runs</span><strong>0');
    expect(html).toContain('Manager loops</span><strong>1');
    expect(html).toContain('Recorded active loops</span><strong>0');
    expect(html).toContain('Accepted loop phases</span><strong>2');
    expect(html).toContain('Active coordinator runs</span><strong>0');
    expect(html).toContain('Open Work for the expanded activity feed');
  });

  it('does not present stale recorded loop state as live and applies the overview scope', () => {
    const loops = [
      { id: 'stale-loop', productId: 'product-a', podId: 'pod-a', status: 'running', stale: true, updatedAt: '2026-09-09T10:00:00Z', completedPhases: ['foundation'], currentStage: { phaseId: 'feature', kind: 'implementation', round: 1 }, stages: [] },
      { id: 'other-loop', productId: 'product-b', podId: 'pod-b', status: 'succeeded', stale: false, updatedAt: '2026-09-09T12:00:00Z', completedPhases: ['one', 'two', 'three'], stages: [] },
    ];
    const html = renderToStaticMarkup(createElement(Overview, {
      state: { managerLoops: loops, blockers: [] }, runs: [], filter: { productId: 'product-a', podId: 'pod-a' }, selectRun() {},
    }));
    expect(html).toContain('stale-loop');
    expect(html).not.toContain('other-loop');
    expect(html).toContain('Recorded state stale');
    expect(html).toContain('Manager loops</span><strong>1');
    expect(html).toContain('Recorded active loops</span><strong>1');
    expect(html).toContain('Accepted loop phases</span><strong>1');
    expect(html).toContain('Active coordinator runs</span><strong>0');
  });

  it('distinguishes local acceptance from unobserved publication and delivery gates', () => {
    const loop = {
      id: 'locally-accepted-loop', status: 'succeeded', stale: false, updatedAt: '2026-09-09T12:00:00Z', completedPhases: ['one', 'two'], stages: [],
      delivery: {
        gates: [
          { id: 'local_acceptance', label: 'Local acceptance', status: 'passed' },
          { id: 'publication', label: 'Published', status: 'unobserved' },
          { id: 'review', label: 'Independent review', status: 'unobserved' },
          { id: 'merge', label: 'Merged', status: 'unobserved' },
          { id: 'deployment', label: 'Deployed', status: 'unobserved' },
          { id: 'staging_verification', label: 'Staging verified', status: 'unobserved' },
        ],
        nextAction: { label: 'Publish the candidate', role: 'publisher' }, issue: 'TWZ-44',
      },
    };
    const html = renderToStaticMarkup(createElement(ManagerLoops, { loops: [loop] }));
    expect(html).toContain('Locally accepted');
    expect(html).toContain('Local acceptance');
    expect(html).toContain('passed');
    expect(html.match(/<em>unobserved<\/em>/g)).toHaveLength(5);
    expect(html).toContain('Publish the candidate');
    expect(html).toContain('Owner: publisher');
    expect(html).not.toContain('Published</b><em>passed');
  });

  it('shows failed publication evidence and the next responsible role without unsafe links', () => {
    const loop = {
      id: 'publication-failed-loop', status: 'blocked', stale: false, completedPhases: ['one'], stages: [],
      delivery: {
        gates: [{ id: 'publication', label: 'Published', status: 'failed', evidenceUrl: 'https://records.example/publication/4' }],
        nextAction: { label: 'Repair publication', role: 'publication_agent', url: 'https://records.example/actions/4' },
      },
    };
    const html = renderToStaticMarkup(createElement(ManagerLoops, { loops: [loop] }));
    expect(html).toContain('Published');
    expect(html).toContain('failed');
    expect(html).toContain('href="https://records.example/publication/4"');
    expect(html).toContain('Repair publication');
    expect(html).toContain('Owner: publication agent');
    expect(html).toContain('Open authoritative record');

    const unsafe = renderToStaticMarkup(createElement(ManagerLoops, { loops: [{ ...loop, delivery: { ...loop.delivery, nextAction: { ...loop.delivery.nextAction, url: 'javascript:alert(1)' } } }] }));
    expect(unsafe).not.toContain('javascript:');
  });

  it('reports last progress for a quiet running loop without claiming it stopped', () => {
    const html = renderToStaticMarkup(createElement(ManagerLoops, { loops: [{ id: 'quiet-loop', status: 'running', stale: true, updatedAt: '2026-09-09T08:00:00Z', completedPhases: [], stages: [] }] }));
    expect(html).toContain('Recorded running');
    expect(html).toContain('Last progress recorded');
    expect(html).toContain('worker liveness unconfirmed');
    expect(html).not.toMatch(/worker (?:is )?stopped/i);
  });
});
