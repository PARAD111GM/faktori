import type {
  WorkManagementArtifactProjection,
  WorkManagementPhase,
  WorkManagementProjectProjection,
  WorkManagementRequest,
  WorkManagementState,
  WorkManagementSession,
  WorkManagementTicket,
} from '../../src/console/work-management.ts';

type DetailNavigation = {
  openRun: (id: string, productId: string) => void;
  openLoop: (id: string, productId: string) => void;
  openRequest: (id: string, productId: string) => void;
};

const formatDate = (value?: string): string => {
  if (!value) return 'Not observed';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};

const ordered = <T extends { order: number }>(items: T[]): T[] => [...items].sort((left, right) => left.order - right.order || String((left as { id?: string }).id).localeCompare(String((right as { id?: string }).id)));

function Artifact({ artifact }: { artifact: WorkManagementArtifactProjection }) {
  const label = artifact.status === 'available' ? 'Available' : artifact.status === 'stale' ? 'Stale' : 'Unavailable';
  const snapshot = artifact.contentBasis === 'owner_snapshot';
  return <article className="work-artifact">
    <div><span className={`state state-${artifact.status}`}>{label}</span><strong>{artifact.title}</strong><small>{artifact.role} · {artifact.path}</small></div>
    {artifact.content !== undefined
      ? <><p className="artifact-content-basis">{snapshot ? 'Owner-published snapshot — not live file content.' : 'Observed file content.'}</p>{artifact.sourceRevision && <small>Recorded revision: {artifact.sourceRevision}</small>}{artifact.snapshotAt && <small>Snapshot recorded: {formatDate(artifact.snapshotAt)}</small>}<pre>{artifact.content}</pre></>
      : <p>{artifact.error ?? (artifact.status === 'stale' ? 'Last safe artifact content may be out of date.' : 'No readable artifact content was published.')}</p>}
    {artifact.observedAt && <small>Observed {formatDate(artifact.observedAt)}</small>}
  </article>;
}

type TicketContext = { productId: string; planId: string; phaseId: string; dependencyTitles: Map<string, string>; sessions: WorkManagementSession[] };

function Correlations({ ticket, context, requests, navigation }: { ticket: WorkManagementTicket; context: TicketContext; requests: WorkManagementRequest[]; navigation: DetailNavigation }) {
  const relatedRequests = requests.filter((request) => request.assignment.productId === context.productId
    && request.assignment.planId === context.planId
    && request.assignment.phaseId === context.phaseId
    && request.assignment.ticketId === ticket.id);
  if (!ticket.runIds?.length && !ticket.loopIds?.length && relatedRequests.length === 0) return null;
  return <div className="ticket-correlations">
    {ticket.runIds?.map((runId) => <button key={runId} type="button" onClick={() => navigation.openRun(runId, context.productId)}>Open run <span>{runId}</span></button>)}
    {ticket.loopIds?.map((loopId) => <button key={loopId} type="button" onClick={() => navigation.openLoop(loopId, context.productId)}>Open loop <span>{loopId}</span></button>)}
    {relatedRequests.map((request) => <div className="ticket-request" key={request.id}><button type="button" onClick={() => navigation.openRequest(request.id, context.productId)}>Open request <span>{request.title}</span></button>{request.report && <p><strong>Manager-reported accomplishment:</strong> {request.report.summary}</p>}</div>)}
  </div>;
}

function Ticket({ ticket, context, requests, navigation }: { ticket: WorkManagementTicket; context: TicketContext; requests: WorkManagementRequest[]; navigation: DetailNavigation }) {
  const owner = context.sessions.find((session) => session.productId === context.productId && session.planId === context.planId && session.phaseId === context.phaseId && session.ticketId === ticket.id);
  return <li className="work-ticket">
    <div className="ticket-heading"><span className="ticket-number">{ticket.order}</span><div><strong>{ticket.title}</strong><p>{ticket.goal}</p></div>{ticket.issueKey && <small className="ticket-issue">{ticket.issueKey}</small>}</div>
    {owner && <p className="ticket-owner"><strong>Owner:</strong> {owner.title || owner.id} · {owner.role || 'Role not recorded'}</p>}
    {ticket.dependencies.length > 0 && <p className="ticket-dependencies">Depends on: {ticket.dependencies.map((id) => context.dependencyTitles.has(id) ? `${context.dependencyTitles.get(id)} (${id})` : id).join(', ')}</p>}
    <Correlations ticket={ticket} context={context} requests={requests} navigation={navigation} />
    <small className="work-id">Ticket ID: {ticket.id}</small>
  </li>;
}

function Phase({ phase, context, requests, navigation }: { phase: WorkManagementPhase; context: Omit<TicketContext, 'phaseId'>; requests: WorkManagementRequest[]; navigation: DetailNavigation }) {
  const phaseContext = { ...context, phaseId: phase.id };
  const owner = context.sessions.find((session) => session.productId === context.productId && session.planId === context.planId && session.phaseId === phase.id && session.ticketId === undefined);
  return <li className="work-phase">
    <div className="phase-heading"><span className="phase-number">{phase.order}</span><div><h4>{phase.title}</h4><p>{phase.goal}</p></div></div>
    <p className="phase-acceptance"><strong>Acceptance:</strong> {phase.acceptance}</p>
    {owner && <p className="phase-owner"><strong>Phase owner:</strong> {owner.title || owner.id} · {owner.role || 'Role not recorded'}</p>}
    {phase.tickets.length === 0 ? <p className="quiet">No tickets recorded for this phase.</p> : <ol className="work-tickets">{ordered(phase.tickets).map((ticket) => <Ticket key={ticket.id} ticket={ticket} context={phaseContext} requests={requests} navigation={navigation} />)}</ol>}
    <small className="work-id">Phase ID: {phase.id}</small>
  </li>;
}

function Project({ project, requests, sessions, navigation }: { project: WorkManagementProjectProjection; requests: WorkManagementRequest[]; sessions: WorkManagementSession[]; navigation: DetailNavigation }) {
  const dependencyTitles = new Map(project.plans.flatMap((plan) => plan.phases.flatMap((phase) => phase.tickets.map((ticket) => [ticket.id, ticket.title]))));
  return <article className="project-card">
    <header className="project-heading"><div><span className="eyebrow">Project</span><h2>{project.title}</h2><p>{project.goal}</p></div><small>{project.productId}</small></header>
    {project.artifacts.length > 0 && <section className="project-artifacts" aria-label={`${project.title} artifacts`}><h3>Artifacts</h3>{project.artifacts.map((artifact) => <Artifact key={artifact.id} artifact={artifact} />)}</section>}
    {project.plans.length === 0 ? <div className="empty"><strong>No plans published</strong><p>This project has no ordered plan in the current catalog.</p></div> : <div className="project-plans">{ordered(project.plans).map((plan) => <section className="work-plan" key={plan.id}><header><span className="plan-number">Plan {plan.order}</span><div><h3>{plan.title}</h3><p>{plan.goal}</p></div></header>{plan.phases.length === 0 ? <p className="quiet">No phases recorded for this plan.</p> : <ol className="work-phases">{ordered(plan.phases).map((phase) => <Phase key={phase.id} phase={phase} context={{ productId: project.productId, planId: plan.id, dependencyTitles, sessions }} requests={requests} navigation={navigation} />)}</ol>}<small className="work-id">Plan ID: {plan.id}</small></section>)}</div>}
  </article>;
}

export function Projects({ workManagement, navigation }: { workManagement?: WorkManagementState; navigation: DetailNavigation }) {
  if (!workManagement || workManagement.status === 'unavailable') return <section className="workspace projects-workspace"><div className="panel panel-primary"><div className="panel-heading"><div><h2>Projects</h2><p>Human-readable plans appear when an owner-maintained work catalog is configured.</p></div><span className="state state-unavailable">Unavailable</span></div><div className="empty"><strong>Work catalog unavailable</strong><p>{workManagement?.error ?? 'No catalog projection was published.'} Legacy Console configuration remains usable. Add an optional work catalog and restart the Console to publish Projects.</p></div></div></section>;
  return <section className="workspace projects-workspace">
    <div className="panel panel-primary projects-header"><div><span className="eyebrow">Owner-maintained work catalog</span><h2>Projects</h2><p>Goals and ordered work are catalog facts. Manager reports are shown separately and never mark work accepted.</p></div><div className="projects-catalog-facts"><span className={`state state-${workManagement.status}`}>{workManagement.status}</span><small>Revision {workManagement.revision ?? 'not observed'}</small><small>Observed {formatDate(workManagement.observedAt)}</small></div></div>
    {workManagement.status === 'stale' && <p className="catalog-notice" role="status">The last valid catalog remains visible. {workManagement.error ?? 'The latest reload could not be confirmed.'}</p>}
    {workManagement.projects.length === 0 ? <div className="panel panel-support"><div className="empty"><strong>No projects published</strong><p>The configured catalog did not publish a project projection.</p></div></div> : workManagement.projects.map((project) => <Project key={project.productId} project={project} requests={workManagement.requests} sessions={workManagement.sessions} navigation={navigation} />)}
  </section>;
}
