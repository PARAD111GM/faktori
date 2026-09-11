import { HelpHeading } from "./section-help.tsx";
import { useState, type ReactNode } from 'react';
import type { WorkManagementState } from '../../src/console/work-management.ts';
import { jiraBoardMatches, type JiraBoard } from './work-visibility.tsx';

type Run = { runId: string; workItem: { id: string }; target: { productId?: string; podId?: string } };
type Props = { projectControl?: ReactNode; workManagement?: WorkManagementState; boards: JiraBoard[]; runs: Run[]; filter: { productId: string; podId: string }; selectRun: (id: string) => void };
type Card = { key: string; id: string; title: string; status: string; column?: string; productId?: string; podId?: string; context: string; goal?: string; url?: string; runIds?: string[]; assignee?: string };
const localStatuses: Record<string, string> = { remaining: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', unknown: 'Status not recorded' };
function safeUrl(value?: string) {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

export function TicketBoard({ projectControl, workManagement, boards, runs, filter, selectRun }: Props) {
  const [query, setQuery] = useState('');
  const sources = boards.filter(board => jiraBoardMatches(board, filter));
  const local: Card[] = (workManagement?.projects ?? []).filter(project => !filter.productId || project.productId === filter.productId)
    .flatMap(project => project.plans.flatMap(plan => plan.phases.flatMap(phase => phase.tickets
      .filter(ticket => !sources.some(board => board.productId === project.productId && board.issues.some(issue => issue.key === (ticket.issueKey ?? ticket.id))))
      .map(ticket => ({ key: [project.productId, plan.id, phase.id, ticket.id].join(':'), id: ticket.id, title: ticket.title, status: localStatuses[ticket.status ?? 'unknown'] ?? 'Status not recorded', productId: project.productId, context: [project.title, plan.title, phase.title].join(' / '), goal: ticket.goal, runIds: ticket.runIds })))));
  const configured = sources.flatMap(board => (board.columns ?? []).map((column, index) => ({ key: `jira:${board.id}:${index}`, title: column.name, context: sources.length > 1 ? board.projectKey : undefined })));
  const jira: Card[] = sources.flatMap(board => board.issues.map(issue => {
    const index = board.columns?.findIndex(column => issue.statusId !== undefined && column.statusIds.includes(issue.statusId)) ?? -1;
    return { key: [board.id, issue.key].join(':'), id: issue.key, title: issue.summary, status: issue.status,
      column: index >= 0 ? `jira:${board.id}:${index}` : board.columns ? `jira:${board.id}:unmapped` : `status:${issue.status}`,
      productId: board.productId, podId: board.podId, context: board.projectKey + ' · Jira', url: issue.url, assignee: issue.assignee };
  }));
  const cards = [...new Map([...jira, ...local].map(card => [card.key, card])).values()];
  const needle = query.trim().toLocaleLowerCase();
  const shown = cards.filter(card => [card.id, card.title, card.context, card.goal, card.status, card.assignee].join(' ').toLocaleLowerCase().includes(needle));
  const columns = [...configured];
  for (const status of local.length ? ['To do', 'In progress', 'Done'] : []) columns.push({ key: `status:${status}`, title: status, context: undefined });
  for (const card of cards) {
    const key = card.column ?? `status:${card.status}`;
    if (!columns.some(column => column.key === key)) columns.push({ key, title: key.endsWith(':unmapped') ? 'Outside board columns' : card.status, context: undefined });
  }
  const columnCards = (key: string) => shown.filter(card => (card.column ?? `status:${card.status}`) === key);
  return <section aria-label="Tickets">
    {sources.map(board => <p className="jira-notice" role={board.status === 'unavailable' ? 'alert' : 'status'} key={board.id}>{board.projectKey}: {board.status === 'unavailable' ? 'could not be refreshed' : board.status === 'stale' ? 'Showing last successful sync; status may be outdated' : 'Synced from Jira'}. {board.message} {board.truncated && 'Results are truncated; open Jira for the full backlog.'}</p>)}
    {sources.filter(board => board.columnsMessage || !board.columns).map(board => <p className="jira-notice" role="status" key={`${board.id}:columns`}>{board.projectKey}: {board.columnsMessage ?? 'Board configuration is unavailable. Showing observed statuses only; Jira column order and empty columns are not available yet.'}</p>)}
    {workManagement?.status === 'stale' && <p className="jira-notice" role="status">Showing the last valid project catalog. Open Projects to resolve its configuration error.</p>}
    <div className="board-toolbar work-filters">{projectControl}<label>Find tickets<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search ticket, title, project, or status" /></label><span role="status">{shown.length} of {cards.length} tickets</span></div>
    <div className={`panel panel-muted board${columns.length === 0 ? ' board-empty' : ''}`} tabIndex={0} aria-label="Work board">
      {columns.length === 0 ? <div className="empty"><HelpHeading level={3} scope="ticket-board">No tickets available</HelpHeading><p>Add tickets to your project plan or configure its Jira source.</p><a className="overview-link" href="#projects">Open Projects</a></div> : columns.map(column => <div className="board-column" key={column.key}><HelpHeading level={3} scope="ticket-board">{column.context ? `${column.context} · ${column.title}` : column.title} <span>{columnCards(column.key).length}</span></HelpHeading><div className="board-card-scroll" tabIndex={0} role="region" aria-label={column.title + ' tickets'}>{columnCards(column.key).map(card => {
        const linkedRuns = runs.filter(run => run.target.productId === card.productId && (!card.podId || run.target.podId === card.podId) && (card.runIds?.includes(run.runId) || run.workItem.id === card.id));
        const url = safeUrl(card.url);
        return <article className="jira-card" key={card.key}><strong>{card.id}</strong><HelpHeading level={4} scope="ticket-board">{card.title}</HelpHeading><p>{card.context}</p>{card.goal && card.goal !== card.title && <p>{card.goal}</p>}{card.assignee && <p>Assigned to {card.assignee}</p>}{url ? <a href={url} target="_blank" rel="noopener noreferrer">Open in Jira</a> : <a href={'#projects?project=' + encodeURIComponent(card.productId ?? '')}>Open project</a>}{linkedRuns.map(run => <button key={run.runId} type="button" onClick={() => selectRun(run.runId)}>Open execution {run.runId}</button>)}</article>;
      })}</div></div>)}
    </div>
  </section>;
}
