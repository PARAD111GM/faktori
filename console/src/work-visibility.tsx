import { useMemo, useState } from 'react';

export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done' | 'unknown';
  assignee?: string;
  updatedAt: string;
  url: string;
};

export type JiraBoard = {
  id: string;
  projectKey: string;
  productId?: string;
  podId?: string;
  status: 'connected' | 'unavailable' | 'stale';
  lastSyncedAt?: string;
  message?: string;
  truncated?: boolean;
  issues: JiraIssue[];
};

export type ActivityItem = {
  id: string;
  at: string;
  source: 'run' | 'loop' | 'jira';
  summary: string;
  productId?: string;
  podId?: string;
  runId?: string;
  loopId?: string;
  issueKey?: string;
  url?: string;
};

type ScopeFilter = { productId: string; podId: string };
type VisibleRun = { runId: string; workItem: { id: string }; target: { productId?: string; podId?: string } };

function safeExternalUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function formatDate(value?: string): string {
  if (!value) return 'Not observed';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function jiraBoardMatches(board: JiraBoard, filter: ScopeFilter): boolean {
  return (filter.productId === '' || board.productId === filter.productId)
    && (filter.podId === '' || board.podId === filter.podId);
}

export function filterJiraIssues(issues: JiraIssue[], query: string): JiraIssue[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return issues;
  return issues.filter((issue) => [issue.key, issue.summary, issue.status, issue.assignee ?? ''].join(' ').toLocaleLowerCase().includes(needle));
}

export function filterActivity(items: ActivityItem[], filter: ScopeFilter, source: 'all' | ActivityItem['source'] = 'all'): ActivityItem[] {
  return items
    .filter((item) => (filter.productId === '' || item.productId === filter.productId)
      && (filter.podId === '' || item.podId === filter.podId)
      && (source === 'all' || item.source === source))
    .sort((left, right) => {
      const leftAt = new Date(left.at).valueOf();
      const rightAt = new Date(right.at).valueOf();
      return (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0);
    })
    .slice(0, 100);
}

export function JiraWorkBoard({ boards, runs, filter, selectRun }: { boards: JiraBoard[]; runs: VisibleRun[]; filter: ScopeFilter; selectRun: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const visibleBoards = boards.filter((board) => jiraBoardMatches(board, filter));
  const issueEntries = visibleBoards.flatMap((board) => board.issues.map((issue) => ({ board, issue })));
  const filteredIssues = new Set(filterJiraIssues(issueEntries.map((entry) => entry.issue), query));
  const issues = issueEntries.filter((entry) => filteredIssues.has(entry.issue));
  const categoryOrder: JiraIssue['statusCategory'][] = ['new', 'indeterminate', 'done', 'unknown'];
  const statuses = [...new Set(issueEntries.map((entry) => entry.issue.status))].sort((left, right) => {
    const leftCategory = issueEntries.find((entry) => entry.issue.status === left)?.issue.statusCategory ?? 'unknown';
    const rightCategory = issueEntries.find((entry) => entry.issue.status === right)?.issue.statusCategory ?? 'unknown';
    return categoryOrder.indexOf(leftCategory) - categoryOrder.indexOf(rightCategory);
  });

  if (visibleBoards.length === 0) {
    return <section className="panel panel-primary jira-board-section"><div className="panel-heading"><div><h2>Jira work</h2><p>Jira is not configured for this scope.</p></div></div><div className="empty"><strong>Execution runs remain available</strong><p>To add a read-only Jira work source, follow docs/console-jira.md and restart the Console.</p></div></section>;
  }

  const unavailable = visibleBoards.filter((board) => board.status === 'unavailable');
  return <section className="jira-board-section" aria-labelledby="jira-work-title">
    <div className="panel panel-primary section-header jira-header"><div><span className="eyebrow">Read-only work source</span><h2 id="jira-work-title">Jira work</h2><p>Synced issue statuses from {visibleBoards.map((board) => board.projectKey).join(', ')}. Changes must be made in Jira.</p></div><div className="jira-sync-list">{visibleBoards.map((board) => <span className={`jira-sync jira-sync-${board.status}`} key={board.id}><b>{board.projectKey}</b>{board.status === 'connected' ? 'Synced' : board.status === 'stale' ? 'Stale' : 'Unavailable'} · {formatDate(board.lastSyncedAt)}</span>)}</div></div>
    {visibleBoards.some((board) => board.status === 'stale') && <p className="jira-notice jira-notice-stale" role="status">This board is showing the last successful Jira sync. Issue state may be out of date.</p>}
    {unavailable.map((board) => <p className="jira-notice jira-notice-error" role="alert" key={board.id}><strong>{board.projectKey} could not be refreshed.</strong> {board.message ?? 'No Jira issues are available from this source.'}</p>)}
    {visibleBoards.some((board) => board.truncated) && <p className="jira-notice" role="status">This view is truncated. Open Jira to inspect the complete project backlog.</p>}
    <div className="board-toolbar"><label>Find Jira work<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search key, summary, status, or assignee" /></label><span role="status" aria-live="polite">{issues.length} issue{issues.length === 1 ? '' : 's'}{query && <button type="button" onClick={() => setQuery('')}>Clear search</button>}</span></div>
    {statuses.length === 0 ? <div className="panel panel-muted"><div className="empty"><strong>{unavailable.length === visibleBoards.length ? 'Jira work unavailable' : 'No Jira issues in this scope'}</strong><p>{unavailable.length === visibleBoards.length ? 'The last Jira refresh did not produce a safe issue projection.' : 'The connected Jira source returned no issues.'}</p></div></div> : <div className="panel panel-muted jira-board" tabIndex={0} aria-label="Jira work board">{statuses.map((status) => {
      const statusIssues = issues.filter((entry) => entry.issue.status === status);
      return <div className="jira-column" key={status}><h3>{status} <span>{statusIssues.length}</span></h3>{statusIssues.length === 0 ? <p className="quiet">None</p> : statusIssues.map(({ board, issue }) => {
        const issueUrl = safeExternalUrl(issue.url);
        const runId = runs.find((run) => run.workItem.id === issue.key
          && (board.productId === undefined || run.target.productId === board.productId)
          && (board.podId === undefined || run.target.podId === board.podId))?.runId;
        return <article className={`jira-card jira-category-${issue.statusCategory}`} key={`${board.id}:${issue.key}`}><div className="jira-card-key">{issueUrl ? <a href={issueUrl} target="_blank" rel="noopener noreferrer">{issue.key}<span className="sr-only"> (opens Jira in a new tab)</span></a> : <strong>{issue.key}</strong>}<span>{issue.status}</span></div><h4>{issue.summary}</h4><dl><dt>Assignee</dt><dd>{issue.assignee ?? 'Unassigned'}</dd><dt>Updated</dt><dd>{formatDate(issue.updatedAt)}</dd></dl>{runId && <button type="button" className="jira-run-link" onClick={() => selectRun(runId)}>Open coordinator run</button>}</article>;
      })}</div>;
    })}</div>}
  </section>;
}

export function ActivityFeed({ items, filter, selectRun, compact = false }: { items: ActivityItem[]; filter: ScopeFilter; selectRun: (id: string) => void; compact?: boolean }) {
  const [source, setSource] = useState<'all' | ActivityItem['source']>('all');
  const visible = useMemo(() => filterActivity(items, filter, source).slice(0, compact ? 5 : 100), [compact, filter, items, source]);
  return <section className={`panel panel-support activity-feed ${compact ? 'activity-feed-compact' : ''}`} aria-labelledby={compact ? 'overview-activity-title' : 'work-activity-title'}><div className="panel-heading"><div><h2 id={compact ? 'overview-activity-title' : 'work-activity-title'}>Running activity</h2><p>Up to {compact ? 5 : 100} recent published factory events in this scope. Recorded milestones, not a live agent transcript.</p></div><label>Source<select value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="all">All sources</option><option value="run">Runs</option><option value="loop">Loops</option><option value="jira">Jira</option></select></label></div>{visible.length === 0 ? <div className="empty"><strong>No activity published</strong><p>No safe run, loop, or Jira event summaries match this scope and source.</p></div> : <ol className="activity-list">{visible.map((item) => {
    const externalUrl = safeExternalUrl(item.url);
    return <li key={item.id}><span className={`activity-source activity-source-${item.source}`}>{item.source}</span><div><p>{item.summary}</p><small><time dateTime={item.at}>{formatDate(item.at)}</time>{item.issueKey ? ` · ${item.issueKey}` : ''}{item.loopId ? ` · ${item.loopId}` : ''}</small></div>{item.runId ? <button type="button" onClick={() => selectRun(item.runId!)}>Open run</button> : externalUrl ? <a href={externalUrl} target="_blank" rel="noopener noreferrer">Open source<span className="sr-only"> in a new tab</span></a> : null}</li>;
  })}</ol>}{compact && <a className="loop-detail-link" href="#work">Open Work for the expanded activity feed</a>}</section>;
}
