import { useState } from 'react';
import type { WorkManagementState } from '../../src/console/work-management.ts';
import { JiraWorkBoard, type JiraBoard } from './work-visibility.tsx';

type Run = { runId: string; workItem: { id: string }; target: { productId?: string; podId?: string } };
type Props = { workManagement?: WorkManagementState; boards: JiraBoard[]; runs: Run[]; filter: { productId: string; podId: string }; selectRun: (id: string) => void };
const columns = [['remaining', 'To do'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done'], ['unknown', 'Status not recorded']] as const;

export function TicketBoard({ workManagement, boards, runs, filter, selectRun }: Props) {
  const [query, setQuery] = useState('');
  const [showEmptyColumns, setShowEmptyColumns] = useState(false);
  const sources = boards.filter(board => !filter.productId || board.productId === filter.productId);
  const tickets = (workManagement?.projects ?? []).filter(project => !filter.productId || project.productId === filter.productId)
    .flatMap(project => project.plans.flatMap(plan => plan.phases.flatMap(phase => phase.tickets.map(ticket => ({ project, plan, phase, ticket })))))
    .filter(({ project, ticket }) => !sources.some(board => (!board.productId || board.productId === project.productId) && board.issues.some(issue => issue.key === (ticket.issueKey ?? ticket.id))));
  const needle = query.trim().toLocaleLowerCase();
  const shown = tickets.filter(({ project, plan, phase, ticket }) => [ticket.id, ticket.title, ticket.goal, ticket.issueKey, project.title, plan.title, phase.title].join(' ').toLocaleLowerCase().includes(needle));
  const visibleColumns = columns.filter(([status]) => showEmptyColumns || tickets.some(({ ticket }) => (ticket.status ?? 'unknown') === status));
  return <>
    {sources.length > 0 && <JiraWorkBoard boards={sources} runs={runs} filter={filter} selectRun={selectRun} />}
    <section className="jira-board-section" aria-label="Local tickets">
      <div className="panel panel-primary section-header"><div><h2>Local tickets</h2><p>{sources.length ? 'Catalog tickets not already shown in Jira. Local status is separate from Jira status.' : 'All tickets from your project plans. No ticket-manager connection or running agent is required.'}</p></div><a className="overview-link" href="#projects">Manage project plans</a></div>
      {workManagement?.status === 'stale' && <p className="jira-notice" role="status">Showing the last valid local catalog. Correct the catalog error in Projects to resume updates.</p>}
      <div className="board-toolbar"><label>Find tickets<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search ticket, title, project, or phase" /></label><label><input type="checkbox" checked={showEmptyColumns} onChange={event => setShowEmptyColumns(event.target.checked)} />Show empty columns</label><span role="status">{shown.length} of {tickets.length} local tickets</span></div>
      {tickets.length === 0 ? <div className="panel panel-muted empty"><strong>{sources.length ? 'No additional local tickets' : 'No local tickets have been published'}</strong><p>{sources.length ? 'Your linked Jira issues are shown above.' : 'Add tickets to a project plan in the work catalog, or connect Jira in the Console configuration. Open Projects for catalog status and Settings for connection guidance.'}</p><a href="#settings">Open Settings</a></div> : <div className="panel panel-muted jira-board" tabIndex={0} aria-label="Local ticket board">{visibleColumns.map(([status, label]) => {
        const items = shown.filter(({ ticket }) => (ticket.status ?? 'unknown') === status);
        return <div className="jira-column" key={status}><h3>{label} <span>{items.length}</span></h3>{items.map(({ project, plan, phase, ticket }) => {
          const run = runs.find(value => value.target.productId === project.productId && (ticket.runIds?.includes(value.runId) || value.workItem.id === ticket.id));
          return <article className="jira-card" key={`${project.productId}:${ticket.id}`}><div className="jira-card-key"><strong>{ticket.id}</strong></div><h4>{ticket.title}</h4><p>{project.title} / {plan.title} / {phase.title}</p>{ticket.goal && <p>{ticket.goal}</p>}{ticket.dependencies.length > 0 && <p>Depends on: {ticket.dependencies.join(', ')}</p>}<a href={`#projects?project=${encodeURIComponent(project.productId)}`}>Open project</a>{run && <button type="button" onClick={() => selectRun(run.runId)}>Open execution</button>}</article>;
        })}</div>;
      })}</div>}
    </section>
  </>;
}
