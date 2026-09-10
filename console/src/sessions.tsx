import type { ManagerConnectedManager } from '../../src/manager-connected/index.ts';
import type { WorkManagementSession, WorkManagementState } from '../../src/console/work-management.ts';

const formatDate = (value?: string): string => {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};

const scope = (session: WorkManagementSession): string => {
  const parts = [session.productId, session.planId, session.phaseId, session.ticketId].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(' / ') : 'Scope not recorded';
};

function Session({ session }: { session: WorkManagementSession }) {
  const liveness = (session as WorkManagementSession & { liveness?: 'unknown' }).liveness ?? 'unknown';
  return <article className="session-card"><div className="session-card-heading"><div><span className="state">Configured</span><h3>{session.title || session.id}</h3><p>{session.role || 'Role not recorded'}</p></div><small>{session.id}</small></div><dl><dt>Assigned scope</dt><dd>{scope(session)}</dd><dt>Provider</dt><dd>Not observed</dd><dt>Capabilities</dt><dd>Not observed</dd><dt>Current activity</dt><dd>{liveness === 'unknown' ? 'Unknown — no liveness observation' : 'Unknown'}</dd></dl></article>;
}

export function Sessions({ workManagement, manager, lastHeartbeatAt }: { workManagement?: WorkManagementState; manager?: ManagerConnectedManager; lastHeartbeatAt?: string }) {
  const sessions = workManagement?.sessions ?? [];
  return <section className="workspace sessions-workspace"><div className="panel panel-primary sessions-header"><div><span className="eyebrow">Recorded task topology</span><h2>Sessions</h2><p>Assignments and recorded contact are not evidence that a task is currently active.</p></div><span className={`state state-${workManagement?.status ?? 'unavailable'}`}>{workManagement?.status ?? 'unavailable'}</span></div>
    <section className="panel panel-support manager-session-card"><div className="panel-heading"><div><h3>Manager</h3><p>Manager-connected coordination is optional and does not provide task discovery or deep links.</p></div><span className="state">{manager ? 'Configured' : 'Not recorded'}</span></div>{manager ? <dl><dt>Title</dt><dd>{manager.title}</dd><dt>Last recorded contact</dt><dd>{formatDate(lastHeartbeatAt)}</dd><dt>Current activity</dt><dd>Unknown — no liveness observation</dd></dl> : <p className="quiet">No Manager session is published by the current Console configuration.</p>}</section>
    {workManagement?.status === 'unavailable' ? <section className="panel panel-primary"><div className="empty"><strong>Session catalog unavailable</strong><p>{workManagement?.error ?? 'Legacy Manager-connected configuration remains available in Work when configured.'}</p></div></section> : <section className="sessions-list" aria-label="Recorded work sessions"><div className="panel-heading"><div><h3>Assigned sessions</h3><p>Titles, roles, and scopes reflect the latest catalog projection.</p></div><strong>{sessions.length}</strong></div>{sessions.length === 0 ? <div className="panel panel-primary"><div className="empty"><strong>No assigned sessions published</strong><p>This does not indicate that no one is working; it only means no session assignment is recorded in the catalog.</p></div></div> : sessions.map((session) => <Session key={session.id} session={session} />)}</section>}
  </section>;
}
