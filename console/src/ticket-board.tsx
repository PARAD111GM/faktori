import { useState } from 'react';
import type { WorkManagementState } from '../../src/console/work-management.ts';
import { jiraBoardMatches, type JiraBoard } from './work-visibility.tsx';

type Run = { runId: string; workItem: { id: string }; target: { productId?: string; podId?: string } };
type Props = { workManagement?: WorkManagementState; boards: JiraBoard[]; runs: Run[]; filter: { productId: string; podId: string }; selectRun: (id: string) => void };
type Card = { key: string; id: string; title: string; status: string; productId?: string; podId?: string; context: string; goal?: string; url?: string; runIds?: string[]; assignee?: string };
const localStatuses: Record<string, string> = { remaining: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', unknown: 'Status not recorded' };
function safeUrl(value?: string) {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

export function TicketBoard({ workManagement, boards, runs, filter, selectRun }: Props) {
  const [query, setQuery] = useState('');
  const sources = boards.filter(board => jiraBoardMatches(board, filter));
  const local: Card[] = (workManagement?.projects ?? []).filter(project => !filter.productId || project.productId === filter.productId)
    .flatMap(project => project.plans.flatMap(plan => plan.phases.flatMap(phase => phase.tickets
      .filter(ticket => !sources.some(board => board.productId === project.productId && board.issues.some(issue => issue.key === (ticket.issueKey ?? ticket.id))))
      .map(ticket => ({ key: [project.productId, plan.id, phase.id, ticket.id].join(':'), id: ticket.id, title: ticket.title, status: localStatuses[ticket.status ?? 'unknown'] ?? 'Status not recorded', productId: project.productId, context: [project.title, plan.title, phase.title].join(' / '), goal: ticket.goal, runIds: ticket.runIds })))));
  const jira: Card[] = sources.flatMap(board => board.issues.map(issue => ({ key: [board.productId, issue.key].join(':'), id: issue.key, title: issue.summary, status: issue.status, productId: board.productId, podId: board.podId, context: board.projectKey + ' · Jira', url: issue.url, assignee: issue.assignee })));
  const cards = [...new Map([...jira, ...local].map(card => [card.key, card])).values()];
  const needle = query.trim().toLocaleLowerCase();
  const shown = cards.filter(card => [card.id, card.title, card.context, card.goal, card.status, card.assignee].join(' ').toLocaleLowerCase().includes(needle));
  const statuses = [...new Set([...(local.length ? ['To do', 'In progress', 'Done'] : []), ...cards.map(card => card.status)])];
  return <section aria-label="Tickets">
    {sources.map(board => <p className="jira-notice" role={board.status === 'unavailable' ? 'alert' : 'status'} key={board.id}>{board.projectKey}: {board.status === 'unavailable' ? 'could not be refreshed' : board.status === 'stale' ? 'Showing last successful sync; status may be outdated' : 'Synced from Jira'}. {board.message} {board.truncated && 'Results are truncated; open Jira for the full backlog.'}</p>)}
    {workManagement?.status === 'stale' && <p className="jira-notice" role="status">Showing the last valid project catalog. Open Projects to resolve its configuration error.</p>}
    <div className="board-toolbar"><label>Find tickets<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search ticket, title, project, or status" /></label><span role="status">{shown.length} of {cards.length} tickets</span></div>
    <div className="panel panel-muted board" tabIndex={0} aria-label="Work board">
      {cards.length === 0 ? <div className="empty"><strong>No tickets available</strong><p>Add tickets to your project plan or configure its Jira source.</p><a href="#projects">Open Projects</a></div> : statuses.map(status => <div className="board-column" key={status}><h3>{status} <span>{shown.filter(card => card.status === status).length}</span></h3>{shown.filter(card => card.status === status).map(card => {
        const linkedRuns = runs.filter(run => run.target.productId === card.productId && (!card.podId || run.target.podId === card.podId) && (card.runIds?.includes(run.runId) || run.workItem.id === card.id));
        const url = safeUrl(card.url);
        return <article className="jira-card" key={card.key}><strong>{card.id}</strong><h4>{card.title}</h4><p>{card.context}</p>{card.goal && card.goal !== card.title && <p>{card.goal}</p>}{card.assignee && <p>Assigned to {card.assignee}</p>}{url ? <a href={url} target="_blank" rel="noopener noreferrer">Open in Jira</a> : <a href={'#projects?project=' + encodeURIComponent(card.productId ?? '')}>Open project</a>}{linkedRuns.map(run => <button key={run.runId} type="button" onClick={() => selectRun(run.runId)}>Open execution {run.runId}</button>)}</article>;
      })}</div>)}
    </div>
  </section>;
}
