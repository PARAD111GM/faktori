import { HelpHeading } from "./section-help.tsx";
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
  return <article className="session-card"><div className="session-card-heading"><div><span className="state">Configured</span><HelpHeading level={3} scope="sessions">{session.title || session.id}</HelpHeading><p>{session.role || 'Role not recorded'}</p></div><small>{session.id}</small></div><dl><dt>Assigned scope</dt><dd>{scope(session)}</dd><dt>Provider</dt><dd>Not observed</dd><dt>Capabilities</dt><dd>Not observed</dd><dt>Current activity</dt><dd>{liveness === 'unknown' ? 'Unknown — no liveness observation' : 'Unknown'}</dd></dl></article>;
}

export function Sessions({ workManagement, manager, lastHeartbeatAt }: { workManagement?: WorkManagementState; manager?: ManagerConnectedManager; lastHeartbeatAt?: string }) {
  const sessions = workManagement?.sessions ?? [];
  return <section className="workspace sessions-workspace">
    <section className="panel panel-support manager-session-card"><div className="panel-heading"><div><HelpHeading level={3} scope="sessions">Manager</HelpHeading><p>Manager-connected coordination is optional and does not provide task discovery or deep links.</p></div><span className="state">{manager ? 'Configured' : 'Not recorded'}</span></div>{manager ? <dl><dt>Title</dt><dd>{manager.title}</dd><dt>Last recorded contact</dt><dd>{formatDate(lastHeartbeatAt)}</dd><dt>Current activity</dt><dd>Unknown — no liveness observation</dd></dl> : <p className="quiet">No Manager session is published by the current Console configuration.</p>}</section>
    {workManagement?.status === 'unavailable' ? <section className="panel panel-primary"><div className="empty"><HelpHeading level={3} scope="sessions">Session catalog unavailable</HelpHeading><p>{workManagement?.error ?? 'Legacy Manager-connected configuration remains available in Work when configured.'}</p></div></section> : <section className="sessions-list" aria-label="Recorded work sessions"><div className="panel-heading"><div><HelpHeading level={3} scope="sessions">Assigned sessions</HelpHeading><p>Titles, roles, and scopes reflect the latest catalog projection.</p></div><strong>{sessions.length}</strong></div>{sessions.length === 0 ? <div className="panel panel-primary"><div className="empty"><HelpHeading level={3} scope="sessions">No assigned sessions published</HelpHeading><p>This does not indicate that no one is working; it only means no session assignment is recorded in the catalog.</p></div></div> : sessions.map((session) => <Session key={session.id} session={session} />)}</section>}
  </section>;
}
