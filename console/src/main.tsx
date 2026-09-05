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
  providerRequests?: Array<{ requestId: string; method: string; prompt: string; options: string[]; status: 'pending' | 'answered' | 'timed_out'; observedAt?: string }>;
  result?: { outcome?: string; summary?: string; revision?: string; verification?: string[]; usage?: Usage };
};

type HierarchyNode = { id: string; kind: 'factory' | 'product' | 'pod' | 'work_item'; label: string; productId?: string; podId?: string; state?: string };
type Hierarchy = {
  nodes?: HierarchyNode[];
  parentEdges?: Array<{ from: string; to: string }>;
  dependencyEdges?: Array<{ from: string; to: string }>;
  filters?: { products?: Array<{ id: string; name: string }>; pods?: Array<{ id: string; productId: string }> };
};
type ScopeFilter = { productId: string; podId: string };

type ConsoleState = {
  format?: string;
  observedAt?: string;
  stale?: boolean;
  admissionPaused?: boolean;
  runs?: Run[];
  hierarchy?: Hierarchy;
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
  | { type: 'answer'; runId: string; requestId: string; answer: string }
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

function runMatches(run: Run, filter: ScopeFilter): boolean {
  return (filter.productId === '' || run.target.productId === filter.productId) && (filter.podId === '' || run.target.podId === filter.podId);
}

function nodeMatches(node: HierarchyNode, filter: ScopeFilter): boolean {
  if (node.kind === 'factory') return true;
  if (node.kind === 'product') return filter.productId === '' || node.productId === filter.productId;
  if (node.kind === 'pod') return (filter.productId === '' || node.productId === filter.productId) && (filter.podId === '' || node.podId === filter.podId);
  return (filter.productId === '' || node.productId === filter.productId) && (filter.podId === '' || node.podId === filter.podId);
}

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

function Overview({ state, runs, selectRun }: { state: ConsoleState; runs: Run[]; selectRun: (id: string) => void }) {
  const activeRuns = runs.filter((run) => ['admitted', 'launching', 'running', 'cancelling', 'reconciling'].includes(run.state)).length;
  const waitingDecisions = runs.filter((run) => run.state === 'blocked' || run.state === 'reconciling' || run.providerRequests?.some((request) => request.status === 'pending')).length;
  const failedRuns = runs.filter((run) => run.state === 'failed').length;
  const reservedTokens = runs.filter((run) => run.reservation?.status === 'held' || run.reservation?.status === 'uncertain').reduce((total, run) => total + (run.reservation?.estimatedTokens ?? 0), 0);
  return <section className="workspace"><div className="metric-row">
    <Metric label="Active work" value={count(activeRuns)} /><Metric label="Waiting decisions" value={count(waitingDecisions)} /><Metric label="Failed runs" value={count(failedRuns)} /><Metric label="Reserved tokens" value={count(reservedTokens)} />
  </div><div className="section-header"><div><h2>Attention queue</h2><p>Runs that need an owner decision or are still progressing.</p></div></div>
  {runs.length === 0 ? <Empty title="No runs in the coordinator projection" detail="Start eligible work from Work after the coordinator has admitted it." /> : <div className="run-list">{runs.map((run) => <button className="run-row" key={run.runId} onClick={() => selectRun(run.runId)}><span className="run-work">{run.workItem.id}<small>{run.target.repository ?? 'Repository not observed'}</small></span><RunState state={run.state} /><span>{duration(run.createdAt)}</span></button>)}</div>}</section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }

function HierarchyBranch({ node, children }: { node: HierarchyNode; children: Map<string, HierarchyNode[]> }) {
  const descendants = children.get(node.id) ?? [];
  const detail = <><span className={`hierarchy-kind ${node.kind}`}>{node.kind.replace('_', ' ')}</span>{node.state && <RunState state={node.state} />}</>;
  if (descendants.length === 0) return <div className="hierarchy-leaf"><span>{node.label}</span>{detail}</div>;
  return <details className="hierarchy-branch" open={node.kind === 'factory'}><summary><span>{node.label}</span>{detail}</summary><div className="hierarchy-children">{descendants.map((child) => <HierarchyBranch key={child.id} node={child} children={children} />)}</div></details>;
}

function WorkHierarchy({ hierarchy, filter }: { hierarchy?: Hierarchy; filter: ScopeFilter }) {
  const allNodes = hierarchy?.nodes ?? [];
  const podProductId = hierarchy?.filters?.pods?.find((pod) => pod.id === filter.podId)?.productId;
  const hierarchyFilter = { ...filter, productId: filter.productId || podProductId || '' };
  const nodes = allNodes.filter((node) => nodeMatches(node, hierarchyFilter));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, HierarchyNode[]>();
  const childIds = new Set<string>();
  for (const edge of hierarchy?.parentEdges ?? []) {
    const parent = nodeById.get(edge.from);
    const child = nodeById.get(edge.to);
    if (!parent || !child) continue;
    children.set(parent.id, [...(children.get(parent.id) ?? []), child]);
    childIds.add(child.id);
  }
  const roots = nodes.filter((node) => !childIds.has(node.id));
  const allNodeLabels = new Map(allNodes.map((node) => [node.id, node.label]));
  const dependencies = (hierarchy?.dependencyEdges ?? []).filter((edge) => nodeById.has(edge.from) || nodeById.has(edge.to));
  return <div className="split-section hierarchy-section"><div><h2>Hierarchy</h2>{nodes.length === 0 ? <Empty title="No hierarchy nodes match this scope" detail="Choose another product or pod filter to inspect the published work hierarchy." /> : <div className="hierarchy-tree">{roots.map((node) => <HierarchyBranch key={node.id} node={node} children={children} />)}</div>}</div><div><h2>Dependencies</h2>{dependencies.length === 0 ? <Empty title="No dependency edges match this scope" detail="Dependencies are shown only when the coordinator projection publishes an explicit edge." /> : <ul className="dependency-list">{dependencies.map((edge) => <li key={`${edge.from}-${edge.to}`}><span>{allNodeLabels.get(edge.from) ?? edge.from}</span><b>depends on</b><span>{allNodeLabels.get(edge.to) ?? edge.to}</span></li>)}</ul>}</div></div>;
}

function Work({ state, runs, filter, selectRun, submit }: { state: ConsoleState; runs: Run[]; filter: ScopeFilter; selectRun: (id: string) => void; submit: (command: Command) => void }) {
  const [workItemId, setWorkItemId] = useState('');
  const columns = ['queued', 'admitted', 'launching', 'running', 'blocked', 'reconciling', 'succeeded', 'failed', 'cancelled'];
  return <section className="workspace"><div className="section-header work-header"><div><h2>Work</h2><p>Coordinator-backed work items. Relationships only appear when the projection supplies them.</p></div><form className="start-work" onSubmit={(event) => { event.preventDefault(); if (workItemId.trim()) { submit({ type: 'start_work', workItemId: workItemId.trim() }); setWorkItemId(''); } }}><label>Eligible work ID<input value={workItemId} onChange={(event) => setWorkItemId(event.target.value)} placeholder="work-123" /></label><button className="primary" type="submit" disabled={state.admissionPaused}>Start work</button></form></div>
  <div className="board" aria-label="Work board">{columns.map((column) => { const items = runs.filter((run) => run.state === column); return <div className="board-column" key={column}><h3>{stateLabel(column)} <span>{items.length}</span></h3>{items.length === 0 ? <p className="quiet">None</p> : items.map((run) => <button className="work-item" key={run.runId} onClick={() => selectRun(run.runId)}><strong>{run.workItem.id}</strong><span>{run.target.productId ?? 'Product unreported'}</span><small>{run.provider ?? 'Provider unreported'} · {duration(run.createdAt)}</small></button>)}</div>; })}</div>
  <WorkHierarchy hierarchy={state.hierarchy} filter={filter} /></section>;
}

function ProviderRequests({ run, submit }: { run: Run; submit: (command: Command) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const requests = run.providerRequests?.filter((request) => request.status === 'pending') ?? [];
  if (requests.length === 0) return <p className="quiet">No pending provider questions, permissions, or plans.</p>;
  return <div className="provider-requests">{requests.map((request) => {
    const response = answers[request.requestId] ?? request.options[0] ?? '';
    const selectResponse = request.options.length > 0;
    return <form className="provider-request" key={request.requestId} onSubmit={(event) => { event.preventDefault(); if (response.trim()) { submit({ type: 'answer', runId: run.runId, requestId: request.requestId, answer: response.trim() }); setAnswers((current) => ({ ...current, [request.requestId]: '' })); } }}><div><span className="request-method">{request.method.replaceAll('_', ' ')}</span><time>{formatDate(request.observedAt)}</time></div><p>{request.prompt}</p><label>{selectResponse ? 'Response' : 'Your response'}{selectResponse ? <select value={response} onChange={(event) => setAnswers((current) => ({ ...current, [request.requestId]: event.target.value }))}>{request.options.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <textarea value={response} onChange={(event) => setAnswers((current) => ({ ...current, [request.requestId]: event.target.value }))} placeholder="Enter a bounded response…" maxLength={16000} />}</label><button className="primary" type="submit" disabled={!response.trim()}>Send response</button></form>;
  })}</div>;
}

function RunDetail({ run, submit }: { run?: Run; submit: (command: Command) => void }) {
  const [message, setMessage] = useState('');
  if (!run) return <section className="workspace"><Empty title="Select a run" detail="Choose a run from Overview or Work to inspect its durable coordinator projection." /></section>;
  const timeline = [
    { label: 'Admitted to coordinator', at: run.createdAt, detail: `Reservation: ${run.reservation?.status ?? 'not observed'}` },
    ...(run.messages ?? []).map((entry) => ({ label: 'Owner instruction queued', at: entry.createdAt, detail: entry.delivery ?? 'delivery not observed' })),
    ...(run.result ? [{ label: `Provider result: ${run.result.outcome ?? 'observed'}`, at: undefined, detail: run.result.summary ?? 'No safe summary was published.' }] : []),
  ];
  return <section className="workspace"><div className="run-title"><div><span className="eyebrow">Run</span><h2>{run.runId}</h2><p>{run.workItem.id} · {run.target.repository ?? 'Repository not observed'}</p></div><RunState state={run.state} /></div><div className="detail-grid"><div><h3>Timeline</h3><ol className="timeline">{timeline.map((event, index) => <li key={`${event.label}-${index}`}><span /><div><strong>{event.label}</strong><p>{event.detail}</p><time>{formatDate(event.at)}</time></div></li>)}</ol></div><div className="inspection"><h3>Execution</h3><dl><dt>Provider</dt><dd>{run.provider ?? 'Not observed'}</dd><dt>Model</dt><dd>{run.model ?? 'Not observed'}</dd><dt>Profile</dt><dd>{run.profile ?? 'Not observed'}</dd><dt>Authority</dt><dd>{run.authority?.revoked ? 'Revoked' : `Epoch ${run.authority?.epoch ?? 'not observed'}`}</dd></dl><h3>Evidence</h3>{run.result?.verification?.length ? <ul className="evidence">{run.result.verification.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="quiet">No verification evidence was published for this run.</p>}<button onClick={() => submit({ type: 'open_record', runId: run.runId })}>Open authoritative record</button></div></div><div className="request-section"><h3>Provider requests</h3><ProviderRequests run={run} submit={submit} /></div><div className="command-area"><form onSubmit={(event) => { event.preventDefault(); if (message.trim()) { submit({ type: 'message', runId: run.runId, body: message.trim() }); setMessage(''); } }}><label>Send instruction for the next provider turn<textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="State the bounded instruction…" maxLength={16000} /></label><button className="primary" type="submit">Queue instruction</button></form><div className="run-actions"><button onClick={() => submit({ type: 'resume', runId: run.runId })}>Resume if eligible</button><button className="danger" onClick={() => submit({ type: 'cancel', runId: run.runId, reason: 'Owner requested cancellation from Console.' })}>Cancel run</button></div></div></section>;
}

function Factory({ state, runs, submit }: { state: ConsoleState; runs: Run[]; submit: (command: Command) => void }) {
  const resources = state.resources;
  const findings = state.factoryGM?.findings ?? [];
  const improvements = state.factoryGM?.improvements ?? [];
  const runIds = new Set(runs.map((run) => run.runId));
  const queueAge = (resources?.queueAge ?? []).filter((entry) => runIds.has(entry.runId));
  return <section className="workspace"><div className="section-header"><div><h2>Factory</h2><p>Resource measurements and durable operational attention. The GM never gains authority from this view.</p></div><button className="primary" onClick={() => submit({ type: 'pause_admission', paused: !state.admissionPaused })}>{state.admissionPaused ? 'Resume admission' : 'Pause admission'}</button></div><div className="factory-grid"><div><h3>Resource signals</h3><dl className="resource-list"><dt>Known reported usage</dt><dd>{count(resources?.knownUsageTokens)} tokens</dd><dt>Reserved capacity</dt><dd>{count(resources?.reservedTokens)} tokens</dd><dt>Reported measurements</dt><dd>{count(resources?.reportedUsageCount)}</dd><dt>Unavailable measurements</dt><dd>{count(resources?.unavailableMeasurements ?? resources?.unavailableUsageCount)}</dd></dl><p className="notice">Usage stays separated from estimates and unavailable telemetry. No cost is inferred here.</p></div><div><h3>Queue age</h3>{queueAge.length ? <ul className="queue-age">{queueAge.map((entry) => <li key={entry.runId}><span>{entry.runId}</span><strong>{duration(entry.createdAt)}</strong></li>)}</ul> : <Empty title="No queued runs in this scope" detail="Human wait and execution time require an observed run record." />}</div></div><div className="split-section"><div><h2>GM findings</h2>{findings.length ? <ul className="findings">{findings.map((finding) => <li key={finding.findingId}><strong>{finding.category.replaceAll('_', ' ')}</strong><span>{finding.diagnosis.state}</span><p>{finding.latestSummary}</p><small>{finding.ownerAttention === 'owner_once' ? 'Owner attention requested once' : 'No owner attention requested'}{finding.diagnosis.summary ? ` · ${finding.diagnosis.summary}` : ''}</small></li>)}</ul> : <Empty title="No GM findings published" detail="The Factory GM is event-triggered; this does not claim it has run." />}</div><div><h2>Improvement backlog</h2>{improvements.length ? <ul className="findings">{improvements.map((item) => <li key={item.proposalId}><strong>{item.detail}</strong><span>{item.status}</span><p>{item.authority === 'requires_approval' ? 'Requires the normal approved delivery path.' : 'Authority not published.'}</p></li>)}</ul> : <Empty title="No improvement proposals" detail="Unapproved changes remain absent rather than being represented as planned work." />}</div></div></section>;
}

function ScopeFilters({ hierarchy, filter, setFilter }: { hierarchy?: Hierarchy; filter: ScopeFilter; setFilter: (next: ScopeFilter) => void }) {
  const products = hierarchy?.filters?.products ?? [];
  const pods = (hierarchy?.filters?.pods ?? []).filter((pod) => filter.productId === '' || pod.productId === filter.productId);
  return <div className="scope-filters" aria-label="Console scope filters"><label>Product<select value={filter.productId} onChange={(event) => setFilter({ productId: event.target.value, podId: '' })}><option value="">All products</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label><label>Pod<select value={filter.podId} onChange={(event) => setFilter({ ...filter, podId: event.target.value })} disabled={pods.length === 0}><option value="">All pods</option>{pods.map((pod) => <option key={pod.id} value={pod.id}>{pod.id}</option>)}</select></label></div>;
}

function App() {
  const { state, connection, error, refresh } = useConsoleState();
  const [view, setView] = useState<'overview' | 'work' | 'run' | 'factory'>('overview');
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [filter, setFilter] = useState<ScopeFilter>({ productId: '', podId: '' });
  const [token, setToken] = useState(() => document.querySelector<HTMLMetaElement>('meta[name="faktori-console-token"]')?.content ?? '');
  const [pending, setPending] = useState<Pending[]>(readPending);
  const dispatching = useRef(new Set<string>());

  useEffect(() => { window.localStorage.setItem(pendingStorageKey, JSON.stringify(pending)); }, [pending]);
  const visibleRuns = useMemo(() => (state?.runs ?? []).filter((run) => runMatches(run, filter)), [filter, state?.runs]);
  const selectedRun = useMemo(() => visibleRuns.find((run) => run.runId === selectedRunId), [selectedRunId, visibleRuns]);
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
  return <main className="app-shell"><aside><a className="wordmark" href="#overview" onClick={() => setView('overview')}>FAKTORI<span>LOCAL CONSOLE</span></a><nav aria-label="Console views">{(['overview', 'work', 'run', 'factory'] as const).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item === 'run' ? 'Run detail' : item}</button>)}</nav><div className="session-key"><label>Local command token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="Required for actions" /></label><small>Kept only in this page session.</small></div></aside><div className="main-column"><header><div><span className="eyebrow">{state.format ?? 'faktori.console-state/v1'}</span><h1>{view === 'run' ? 'Run detail' : view[0].toUpperCase() + view.slice(1)}</h1></div><div className="header-controls"><ScopeFilters hierarchy={state.hierarchy} filter={filter} setFilter={setFilter} /><button onClick={() => void refresh()}>Refresh</button><Status connection={connection} state={state} /></div></header>{error && <div className="alert" role="alert">{error}</div>}{pending.length > 0 && <div className="pending" role="status"><strong>{pending.length} command{pending.length === 1 ? '' : 's'} pending</strong>{pending.map((entry) => <span key={entry.id}>{entry.command.type.replaceAll('_', ' ')} {entry.status === 'failed' ? `failed: ${entry.detail}` : 'awaiting confirmation'}<button onClick={() => retry(entry)}>{entry.status === 'failed' ? 'Replay safely' : 'Retry with same identity'}</button></span>)}</div>}{view === 'overview' && <Overview state={state} runs={visibleRuns} selectRun={selectRun} />}{view === 'work' && <Work state={state} runs={visibleRuns} filter={filter} selectRun={selectRun} submit={submit} />}{view === 'run' && <RunDetail run={selectedRun} submit={submit} />}{view === 'factory' && <Factory state={state} runs={visibleRuns} submit={submit} />}</div></main>;
}

createRoot(document.getElementById('root')!).render(<App />);
