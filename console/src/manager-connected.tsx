import { useRef, useState } from 'react';
import type {
  ManagerConnectedAction as StoreManagerConnectedAction,
  ManagerConnectedRequestSnapshot,
  ManagerConnectedSessionAssignment,
  ManagerConnectedSnapshot as StoreManagerConnectedSnapshot,
} from '../../src/manager-connected/index.ts';
import type { WorkManagementState } from '../../src/console/work-management.ts';

export type ManagerConnectedSession = ManagerConnectedSessionAssignment;
export type ManagerConnectedRequest = ManagerConnectedRequestSnapshot;
export type ManagerConnectedSnapshot = StoreManagerConnectedSnapshot;

export type ManagerConnectedAction = Extract<StoreManagerConnectedAction, { type: 'enqueue' | 'cancel' }>;

const formatDate = (value?: string): string => {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};

const label = (value?: string): string => value === 'completed' ? 'Result reported' : value ? value.replaceAll('_', ' ') : 'Not recorded';

const makeId = (): string => globalThis.crypto?.randomUUID?.() ?? `manager-connected-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const sessionId = (session: ManagerConnectedSession): string => session.id ?? '';
const sessionAlias = (session: ManagerConnectedSession): string => session.id ?? '';

const requestGuidance = (status?: string): string => {
  if (status === 'queued') return 'Queued for Manager handoff.';
  if (status === 'claimed') return 'Claimed by the Manager; provider submission is not yet recorded.';
  if (status === 'submitted') return 'Sent to the assigned task; a result has not yet been reported.';
  if (status === 'uncertain') return 'Delivery is uncertain. Reconcile the recorded request before sending another one.';
  if (status === 'cancelled') return 'Cancellation is recorded.';
  if (status === 'completed') return 'A Manager report is recorded; it is not independent acceptance.';
  return 'No Manager summary has been recorded.';
};

function SessionFacts({ session }: { session: ManagerConnectedSession }) {
  const facts = [
    ['Role', session.role],
    ['Product', session.productId],
    ['Plan', session.planId],
    ['Phase', session.phaseId],
    ['Ticket', session.ticketId],
  ].filter(([, value]) => Boolean(value));
  return <dl className="manager-session-facts">{facts.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>;
}

export function ManagerConnected({ snapshot, workManagement, focusedRequestId, submit }: { snapshot?: ManagerConnectedSnapshot; workManagement?: WorkManagementState; focusedRequestId?: string; submit: (action: ManagerConnectedAction) => Promise<void> }) {
  const [alias, setAlias] = useState('');
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState<string>();
  const pendingId = useRef<string>();
  const pendingAction = useRef<Extract<ManagerConnectedAction, { type: 'enqueue' }>>();
  const sessions = snapshot?.sessions ?? [];
  const catalogConfigured = workManagement?.status === 'available' || workManagement?.status === 'stale';
  const catalogEnabled = workManagement?.status === 'available';
  const requestableSessions = catalogConfigured
    ? sessions.filter((session) => Boolean(session.productId && session.planId && session.phaseId))
    : sessions;
  const requests = snapshot?.requests ?? [];
  const manager = snapshot?.manager;
  const managerTitle = manager?.title ?? 'Manager';
  const lastContactAt = snapshot?.lastHeartbeatAt;

  if (!snapshot?.manager) return <section className="panel panel-support manager-connected manager-connected-setup" aria-labelledby="manager-connected-title">
    <div className="panel-heading"><div><h2 id="manager-connected-title">Manager-connected work</h2><p>Optional experimental work handoff.</p></div></div>
    <p>Set up an active Manager in <code>docs/manager-connected.md</code>, then restart the Console to publish its recorded sessions.</p>
  </section>;

  const enqueue = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    let action = pendingAction.current;
    if (!action) {
      const selected = requestableSessions.find((session) => sessionAlias(session) === alias.trim());
      const selectedId = selected ? sessionId(selected) : '';
      if (!selectedId) { setError('Choose a recorded session alias.'); return; }
      if (!title.trim() || !instruction.trim()) { setError('Add a title and instruction before enqueuing.'); return; }
      const scoped = selected?.planId && selected.phaseId
        ? { productId: selected.productId, planId: selected.planId, phaseId: selected.phaseId, ...(selected.ticketId ? { ticketId: selected.ticketId } : {}) }
        : undefined;
      action = {
        type: 'enqueue',
        id: pendingId.current ?? makeId(),
        sessionId: selectedId,
        title: title.trim(),
        instruction: instruction.trim(),
        ...(workManagement?.status === 'available' && workManagement.revision ? { catalogRevision: workManagement.revision } : {}),
        ...(scoped ? { scope: scoped } : {}),
      };
      if (catalogConfigured && (!catalogEnabled || !workManagement?.revision || !scoped)) {
        setError('This catalog requires a current revision and a session with recorded plan and phase scope.');
        return;
      }
      pendingId.current = action.id;
      pendingAction.current = action;
    }
    setError(undefined);
    setSending(true);
    try {
      await submit(action);
      pendingId.current = undefined;
      pendingAction.current = undefined;
      setAlias('');
      setTitle('');
      setInstruction('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Enqueue request could not be confirmed.');
    } finally { setSending(false); }
  };

  const cancel = async (id: string): Promise<void> => {
    setError(undefined);
    setCancelling(id);
    try { await submit({ type: 'cancel', id }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Cancellation could not be confirmed.'); }
    finally { setCancelling(undefined); }
  };

  return <section className="panel panel-primary manager-connected" aria-labelledby="manager-connected-title">
    <div className="panel-heading manager-connected-heading"><div><h2 id="manager-connected-title">{managerTitle}</h2><p>Experimental handoff. Active Manager required. {lastContactAt ? `Last contact: ${formatDate(lastContactAt)}.` : 'No Manager heartbeat recorded yet.'}</p></div><span className="state">Configured</span></div>
    <p className="notice">Manager reports are not independent acceptance. Contact time is a record, not a liveness signal.{workManagement?.status === 'available' && ` New requests carry catalog revision ${workManagement.revision ?? 'not observed'} when available.`}</p>
    <div className="manager-connected-grid">
      <section className="manager-sessions"><h3>Recorded sessions</h3>{sessions.length === 0 ? <p className="quiet">No sessions have been published by this Manager.</p> : <ul>{sessions.map((session) => <li key={sessionId(session) || sessionAlias(session)}><strong>{session.title ?? sessionAlias(session)}</strong><small>{sessionAlias(session)}</small><SessionFacts session={session} /></li>)}</ul>}</section>
      <form className="manager-enqueue" onSubmit={(event) => void enqueue(event)}>
        <h3>Enqueue work</h3>
        <label>Session alias<input list="manager-session-aliases" value={alias} onChange={(event) => { setAlias(event.target.value); setError(undefined); }} disabled={Boolean(pendingAction.current)} placeholder="Choose a recorded session" required /><datalist id="manager-session-aliases">{requestableSessions.map((session) => <option key={sessionId(session) || sessionAlias(session)} value={sessionAlias(session)} />)}</datalist></label>
        <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} disabled={Boolean(pendingAction.current)} maxLength={240} placeholder="Name the bounded work" required /></label>
        <label>Instruction<textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={Boolean(pendingAction.current)} maxLength={16000} placeholder="State the bounded instruction" required /></label>
        {error && <p className="manager-error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={sending || requestableSessions.length === 0 || (catalogConfigured && (!catalogEnabled || !workManagement?.revision))}>{sending ? 'Sending request' : pendingId.current ? 'Retry same request' : 'Enqueue work'}</button>
        <p className="quiet">{catalogEnabled ? 'Catalog-backed requests require the shown revision and the selected recorded scope.' : catalogConfigured ? 'Catalog reload is stale, so new scoped requests stay disabled until a current revision is observed.' : 'If a response is uncertain, this form keeps the same request ID for a manual retry. It never retries automatically.'}</p>
      </form>
    </div>
    <section className="manager-requests"><div className="panel-heading"><div><h3>Requests</h3><p>Recorded request summaries and statuses.</p></div><strong>{requests.length}</strong></div>{requests.length === 0 ? <p className="quiet">No Manager-connected requests have been recorded.</p> : <ul>{requests.map((request) => { const session = sessions.find((item) => sessionId(item) === request.sessionId); return <li id={`manager-request-${request.id}`} className={focusedRequestId === request.id ? 'is-focused' : undefined} key={request.id}><div><strong>{request.title ?? 'Untitled request'}</strong><span className={`state state-${request.status ?? 'unknown'}`}>{label(request.status)}</span></div><p>{request.report?.summary ?? requestGuidance(request.status)}</p>{request.report && <small className="reported-result">Manager-reported result; product acceptance not evaluated.</small>}<small>{session?.title ?? request.sessionId ?? 'Session not recorded'} · {formatDate(request.report?.observedAt ?? request.createdAt)}</small>{request.status === 'queued' && <button type="button" className="danger" disabled={cancelling === request.id} onClick={() => void cancel(request.id)}>{cancelling === request.id ? 'Cancelling request' : 'Cancel queued request'}</button>}</li>; })}</ul>}</section>
  </section>;
}
