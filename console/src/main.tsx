import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

type Usage = {
  availability?: 'available' | 'estimated' | 'unavailable';
  inputTokens?: number;
  outputTokens?: number;
};

type Run = {
  runId: string;
  workItem: { id: string; revision?: string };
  target: { factoryId?: string; productId?: string; podId?: string; repository?: string; branch?: string; baseRevision?: string; expectedRevision?: string };
  provider?: string;
  model?: string;
  profile?: string;
  state: string;
  createdAt?: string;
  reservation?: { estimatedTokens?: number; status?: string };
  authority?: { epoch?: number; revoked?: boolean };
  messages?: Array<{ messageId: string; createdAt?: string; delivery?: string }>;
  result?: { outcome?: string; summary?: string; revision?: string; verification?: string[]; usage?: Usage };
};

type ConsoleState = {
  format?: string;
  observedAt?: string;
  stale?: boolean;
  admissionPaused?: boolean;
  runs?: Run[];
  overview?: { activeRuns?: number; waitingDecisions?: number; failedRuns?: number };
  resources?: {
    knownUsageTokens?: number;
    reportedUsageCount?: number;
    unavailableUsageCount?: number;
    reservedTokens?: number;
    unavailableMeasurements?: number;
    queueAge?: Array<{ runId: string; createdAt: string }>;
  };
  factoryGM?: {
    findings?: Array<{ findingId: string; category: string; latestSummary: string; ownerAttention: 'none' | 'owner_once'; diagnosis: { state: 'not_needed' | 'requested' | 'completed' | 'failed'; summary?: string } }>;
    improvements?: Array<{ proposalId: string; detail: string; status: 'proposed'; authority?: 'requires_approval' }>;
  };
};

type Command =
  | { type: 'start_work'; workItemId: string }
  | { type: 'message'; runId: string; body: string }
  | { type: 'cancel'; runId: string; reason: string }
  | { type: 'resume'; runId: string }
  | { type: 'pause_admission'; paused: boolean }
  | { type: 'open_record'; runId: string };

type Pending = { id: string; command: Command; createdAt: string; status: 'pending' | 'failed'; detail?: string };

const pendingStorageKey = 'faktori.console.pending-commands/v1';

function readPending(): Pending[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(pendingStorageKey) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is Pending => item && typeof item.id === 'string' && item.command && typeof item.createdAt === 'string') : [];
  } catch { return []; }
}

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `console-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDate(value?: string): string {
  if (!value) return 'Not observed';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function count(value?: number): string { return new Intl.NumberFormat().format(value ?? 0); }

function duration(value?: string): string {
  if (!value) return 'Not observed';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).valueOf()) / 1_000));
  if (!Number.isFinite(seconds)) return 'Not observed';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function stateLabel(state: string): string { return state.replaceAll('_', ' '); }

function useConsoleState() {
  const [state, setState] = useState<ConsoleState>();
  const [connection, setConnection] = useState<'connecting' | 'live' | 'disconnected'>('connecting');
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/console/state', { cache: 'no-store' });
      if (!response.ok) throw new Error(`State request failed (${response.status})`);
      setState(await response.json() as ConsoleState);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'State request failed');
      setConnection('disconnected');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let closed = false;
    let retry: number | undefined;
    const connect = (): void => {
      if (closed) return;
      setConnection('connecting');
      const source = new EventSource('/api/console/events');
      source.addEventListener('state', (event) => {
        try {
          setState(JSON.parse((event as MessageEvent<string>).data) as ConsoleState);
          setError(undefined);
          setConnection('live');
        } catch { setConnection('disconnected'); setError('Received an invalid live update'); }
      });
      source.onerror = () => {
        source.close();
        setConnection('disconnected');
        if (!closed) retry = window.setTimeout(connect, 2_000);
      };
    };
    connect();
    return () => { closed = true; if (retry !== undefined) window.clearTimeout(retry); };
  }, []);
  return { state, connection, error, refresh };
}

function Status({ connection, state }: { connection: 'connecting' | 'live' | 'disconnected'; state?: ConsoleState }) {
  const stale = state?.stale || connection === 'disconnected';
  const label = stale ? 'Disconnected — state may be stale' : connection === 'connecting' ? 'Connecting to coordinator' : 'Live coordinator projection';
  return <div className={`connection ${stale ? 'is-stale' : ''}`} role="status"><span className="pulse" />{label}<span className="observed">Observed {formatDate(state?.observedAt)}</span></div>;
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><strong>{title}</strong><p>{detail}</p></div>;
}

function RunState({ state }: { state: string }) { return <span className={`state state-${state}`}>{stateLabel(state)}</span>; }

function Overview({ state, selectRun }: { state: ConsoleState; selectRun: (id: string) => void }) {
  const runs = state.runs ?? [];
  return <section className="workspace"><div className="metric-row">
    <Metric label="Active work" value={count(state.overview?.activeRuns)} /><Metric label="Waiting decisions" value={count(state.overview?.waitingDecisions)} /><Metric label="Failed runs" value={count(state.overview?.failedRuns)} /><Metric label="Reserved tokens" value={count(state.resources?.reservedTokens)} />
  </div><div className="section-header"><div><h2>Attention queue</h2><p>Runs that need an owner decision or are still progressing.</p></div></div>
  {runs.length === 0 ? <Empty title="No runs in the coordinator projection" detail="Start eligible work from Work after the coordinator has admitted it." /> : <div className="run-list">{runs.map((run) => <button className="run-row" key={run.runId} onClick={() => selectRun(run.runId)}><span className="run-work">{run.workItem.id}<small>{run.target.repository ?? 'Repository not observed'}</small></span><RunState state={run.state} /><span>{duration(run.createdAt)}</span></button>)}</div>}</section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }

function Work({ state, selectRun, submit }: { state: ConsoleState; selectRun: (id: string) => void; submit: (command: Command) => void }) {
  const [workItemId, setWorkItemId] = useState('');
  const columns = ['queued', 'admitted', 'launching', 'running', 'blocked', 'reconciling', 'succeeded', 'failed', 'cancelled'];
  const runs = state.runs ?? [];
  return <section className="workspace"><div className="section-header work-header"><div><h2>Work</h2><p>Coordinator-backed work items. Relationships only appear when the projection supplies them.</p></div><form className="start-work" onSubmit={(event) => { event.preventDefault(); if (workItemId.trim()) { submit({ type: 'start_work', workItemId: workItemId.trim() }); setWorkItemId(''); } }}><label>Eligible work ID<input value={workItemId} onChange={(event) => setWorkItemId(event.target.value)} placeholder="work-123" /></label><button className="primary" type="submit" disabled={state.admissionPaused}>Start work</button></form></div>
  <div className="board" aria-label="Work board">{columns.map((column) => { const items = runs.filter((run) => run.state === column); return <div className="board-column" key={column}><h3>{stateLabel(column)} <span>{items.length}</span></h3>{items.length === 0 ? <p className="quiet">None</p> : items.map((run) => <button className="work-item" key={run.runId} onClick={() => selectRun(run.runId)}><strong>{run.workItem.id}</strong><span>{run.target.productId ?? 'Product unreported'}</span><small>{run.provider ?? 'Provider unreported'} · {duration(run.createdAt)}</small></button>)}</div>; })}</div>
  <div className="split-section"><div><h2>Hierarchy</h2><Empty title="No hierarchy edges in this projection" detail="The current Console API publishes run work-item identities but no parent or child relationships." /></div><div><h2>Dependencies</h2><Empty title="No dependency edges in this projection" detail="Dependency status is intentionally not inferred from run names or ordering." /></div></div></section>;
}

function RunDetail({ run, submit }: { run?: Run; submit: (command: Command) => void }) {
  const [message, setMessage] = useState('');
  if (!run) return <section className="workspace"><Empty title="Select a run" detail="Choose a run from Overview or Work to inspect its durable coordinator projection." /></section>;
  const timeline = [
    { label: 'Admitted to coordinator', at: run.createdAt, detail: `Reservation: ${run.reservation?.status ?? 'not observed'}` },
    ...(run.messages ?? []).map((entry) => ({ label: 'Owner instruction queued', at: entry.createdAt, detail: entry.delivery ?? 'delivery not observed' })),
    ...(run.result ? [{ label: `Provider result: ${run.result.outcome ?? 'observed'}`, at: undefined, detail: run.result.summary ?? 'No safe summary was published.' }] : []),
  ];
  return <section className="workspace"><div className="run-title"><div><span className="eyebrow">Run</span><h2>{run.runId}</h2><p>{run.workItem.id} · {run.target.repository ?? 'Repository not observed'}</p></div><RunState state={run.state} /></div><div className="detail-grid"><div><h3>Timeline</h3><ol className="timeline">{timeline.map((event, index) => <li key={`${event.label}-${index}`}><span /><div><strong>{event.label}</strong><p>{event.detail}</p><time>{formatDate(event.at)}</time></div></li>)}</ol></div><div className="inspection"><h3>Execution</h3><dl><dt>Provider</dt><dd>{run.provider ?? 'Not observed'}</dd><dt>Model</dt><dd>{run.model ?? 'Not observed'}</dd><dt>Profile</dt><dd>{run.profile ?? 'Not observed'}</dd><dt>Authority</dt><dd>{run.authority?.revoked ? 'Revoked' : `Epoch ${run.authority?.epoch ?? 'not observed'}`}</dd></dl><h3>Evidence</h3>{run.result?.verification?.length ? <ul className="evidence">{run.result.verification.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="quiet">No verification evidence was published for this run.</p>}<button onClick={() => submit({ type: 'open_record', runId: run.runId })}>Open authoritative record</button></div></div><div className="command-area"><form onSubmit={(event) => { event.preventDefault(); if (message.trim()) { submit({ type: 'message', runId: run.runId, body: message.trim() }); setMessage(''); } }}><label>Send instruction for the next provider turn<textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="State the bounded instruction…" maxLength={16000} /></label><button className="primary" type="submit">Queue instruction</button></form><div className="run-actions"><button onClick={() => submit({ type: 'resume', runId: run.runId })}>Resume if eligible</button><button className="danger" onClick={() => submit({ type: 'cancel', runId: run.runId, reason: 'Owner requested cancellation from Console.' })}>Cancel run</button></div></div></section>;
}

function Factory({ state, submit }: { state: ConsoleState; submit: (command: Command) => void }) {
  const resources = state.resources;
  const findings = state.factoryGM?.findings ?? [];
  const improvements = state.factoryGM?.improvements ?? [];
  return <section className="workspace"><div className="section-header"><div><h2>Factory</h2><p>Resource measurements and durable operational attention. The GM never gains authority from this view.</p></div><button className="primary" onClick={() => submit({ type: 'pause_admission', paused: !state.admissionPaused })}>{state.admissionPaused ? 'Resume admission' : 'Pause admission'}</button></div><div className="factory-grid"><div><h3>Resource signals</h3><dl className="resource-list"><dt>Known reported usage</dt><dd>{count(resources?.knownUsageTokens)} tokens</dd><dt>Reserved capacity</dt><dd>{count(resources?.reservedTokens)} tokens</dd><dt>Reported measurements</dt><dd>{count(resources?.reportedUsageCount)}</dd><dt>Unavailable measurements</dt><dd>{count(resources?.unavailableMeasurements ?? resources?.unavailableUsageCount)}</dd></dl><p className="notice">Usage stays separated from estimates and unavailable telemetry. No cost is inferred here.</p></div><div><h3>Queue age</h3>{resources?.queueAge?.length ? <ul className="queue-age">{resources.queueAge.map((entry) => <li key={entry.runId}><span>{entry.runId}</span><strong>{duration(entry.createdAt)}</strong></li>)}</ul> : <Empty title="No queued runs" detail="Human wait and execution time require an observed run record." />}</div></div><div className="split-section"><div><h2>GM findings</h2>{findings.length ? <ul className="findings">{findings.map((finding) => <li key={finding.findingId}><strong>{finding.category.replaceAll('_', ' ')}</strong><span>{finding.diagnosis.state}</span><p>{finding.latestSummary}</p><small>{finding.ownerAttention === 'owner_once' ? 'Owner attention requested once' : 'No owner attention requested'}{finding.diagnosis.summary ? ` · ${finding.diagnosis.summary}` : ''}</small></li>)}</ul> : <Empty title="No GM findings published" detail="The Factory GM is event-triggered; this does not claim it has run." />}</div><div><h2>Improvement backlog</h2>{improvements.length ? <ul className="findings">{improvements.map((item) => <li key={item.proposalId}><strong>{item.detail}</strong><span>{item.status}</span><p>{item.authority === 'requires_approval' ? 'Requires the normal approved delivery path.' : 'Authority not published.'}</p></li>)}</ul> : <Empty title="No improvement proposals" detail="Unapproved changes remain absent rather than being represented as planned work." />}</div></div></section>;
}

function App() {
  const { state, connection, error, refresh } = useConsoleState();
  const [view, setView] = useState<'overview' | 'work' | 'run' | 'factory'>('overview');
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [token, setToken] = useState(() => document.querySelector<HTMLMetaElement>('meta[name="faktori-console-token"]')?.content ?? '');
  const [pending, setPending] = useState<Pending[]>(readPending);
  const dispatching = useRef(new Set<string>());

  useEffect(() => { window.localStorage.setItem(pendingStorageKey, JSON.stringify(pending)); }, [pending]);
  const selectedRun = useMemo(() => state?.runs?.find((run) => run.runId === selectedRunId), [selectedRunId, state?.runs]);
  const selectRun = (id: string): void => { setSelectedRunId(id); setView('run'); };
  const send = useCallback((entry: Pending, commandKey: string) => {
    void fetch('/api/console/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Faktori-Console-Token': token }, body: JSON.stringify({ commandId: entry.id, command: entry.command }) })
      .then(async (response) => ({ response, body: await response.json() as { command?: { status?: string; result?: { detail?: string; url?: string } }; state?: ConsoleState } }))
      .then(({ response, body }) => {
        if (response.ok && body.command?.status === 'completed') {
          if (entry.command.type === 'open_record' && typeof body.command.result?.url === 'string') window.open(body.command.result.url, '_blank', 'noopener');
          setPending((current) => current.filter((item) => item.id !== entry.id));
          return body.state;
        }
        throw new Error(body.command?.result?.detail ?? `Command request failed (${response.status})`);
      })
      .then((next) => { if (next) void refresh(); })
      .catch((cause) => setPending((current) => current.map((item) => item.id === entry.id ? { ...item, status: 'failed', detail: cause instanceof Error ? cause.message : 'Command failed' } : item)))
      .finally(() => dispatching.current.delete(commandKey));
  }, [refresh, token]);
  const submit = useCallback((command: Command) => {
    if (!token) { window.alert('Enter the local Console command token before sending an owner command.'); return; }
    const commandKey = JSON.stringify(command);
    if (dispatching.current.has(commandKey)) return;
    dispatching.current.add(commandKey);
    const entry: Pending = { id: makeId(), command, createdAt: new Date().toISOString(), status: 'pending' };
    setPending((current) => [...current, entry]);
    send(entry, commandKey);
  }, [send, token]);
  const retry = (entry: Pending): void => {
    if (!token) { window.alert('Enter the local Console command token before replaying an owner command.'); return; }
    const commandKey = JSON.stringify(entry.command);
    if (dispatching.current.has(commandKey)) return;
    dispatching.current.add(commandKey);
    const replay: Pending = { ...entry, status: 'pending', detail: undefined };
    setPending((current) => current.map((item) => item.id === entry.id ? replay : item));
    send(replay, commandKey);
  };

  if (!state) return <main className="loading"><h1>Faktori</h1><p>{error ?? 'Loading the coordinator projection…'}</p><button onClick={() => void refresh()}>Retry connection</button></main>;
  return <main className="app-shell"><aside><a className="wordmark" href="#overview" onClick={() => setView('overview')}>FAKTORI<span>LOCAL CONSOLE</span></a><nav aria-label="Console views">{(['overview', 'work', 'run', 'factory'] as const).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item === 'run' ? 'Run detail' : item}</button>)}</nav><div className="session-key"><label>Local command token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="Required for actions" /></label><small>Kept only in this page session.</small></div></aside><div className="main-column"><header><div><span className="eyebrow">{state.format ?? 'faktori.console-state/v1'}</span><h1>{view === 'run' ? 'Run detail' : view[0].toUpperCase() + view.slice(1)}</h1></div><div className="header-controls"><button onClick={() => void refresh()}>Refresh</button><Status connection={connection} state={state} /></div></header>{error && <div className="alert" role="alert">{error}</div>}{pending.length > 0 && <div className="pending" role="status"><strong>{pending.length} command{pending.length === 1 ? '' : 's'} pending</strong>{pending.map((entry) => <span key={entry.id}>{entry.command.type.replaceAll('_', ' ')} {entry.status === 'failed' ? `failed: ${entry.detail}` : 'awaiting confirmation'}<button onClick={() => retry(entry)}>{entry.status === 'failed' ? 'Replay safely' : 'Retry with same identity'}</button></span>)}</div>}{view === 'overview' && <Overview state={state} selectRun={selectRun} />}{view === 'work' && <Work state={state} selectRun={selectRun} submit={submit} />}{view === 'run' && <RunDetail run={selectedRun} submit={submit} />}{view === 'factory' && <Factory state={state} submit={submit} />}</div></main>;
}

createRoot(document.getElementById('root')!).render(<App />);
