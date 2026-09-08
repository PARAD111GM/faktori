import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';
import { Settings } from './settings.tsx';
import type { ConsoleSettings } from '../../src/console/settings.ts';

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

type Blocker = { blockerId: string; reasonCode: string; decisionOwnerRole: string; related: { parentRunId?: string; childRunId?: string; workstreamId?: string; delegationId?: string }; ownership: { state: string; paths: string[]; omittedPathCount: number }; overlaps: Array<{ requestedPath: string; existingPath: string; existingChildRunId: string; existingDelegationId: string }>; omittedIdentityCount: number; remediation: string };
type Preflight = { format: string; scope: { factoryId: string; productId: string; podId?: string }; status: 'ready' | 'partial' | 'blocked'; executionReady: boolean; liveExecutionVerified: boolean; projectionReady: boolean; checks: Array<{ id: string; section: string; status: 'pass' | 'fail' | 'unavailable' | 'not_tested'; basis: string; freshness: string; remediation: string }> };

type HierarchyNode = { id: string; kind: 'factory' | 'product' | 'pod' | 'work_item'; label: string; productId?: string; podId?: string; state?: string };
type Hierarchy = {
  nodes?: HierarchyNode[];
  parentEdges?: Array<{ from: string; to: string }>;
  dependencyEdges?: Array<{ from: string; to: string }>;
  filters?: { products?: Array<{ id: string; name: string }>; pods?: Array<{ id: string; productId: string }> };
};
type ScopeFilter = { productId: string; podId: string };

type ConsoleState = {
  settings?: ConsoleSettings;
  format?: string;
  observedAt?: string;
  stale?: boolean;
  admissionPaused?: boolean;
  runs?: Run[];
  blockers?: Blocker[];
  preflight?: Preflight;
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

function measurement(value?: number, suffix = ''): string {
  return value === undefined ? 'Unavailable' : `${count(value)}${suffix}`;
}

function duration(value?: string): string {
  if (!value) return 'Not observed';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).valueOf()) / 1_000));
  if (!Number.isFinite(seconds)) return 'Not observed';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function stateLabel(state: string): string { return state.replaceAll('_', ' '); }

export function runMatches(run: Run, filter: ScopeFilter): boolean {
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
  const label = stale ? 'Disconnected — state may be stale' : connection === 'connecting' ? 'Connecting to factory' : 'Connected to factory';
  return <div className={`connection ${stale ? 'is-stale' : ''}`} role="status"><span className="pulse" />{label}<span className="observed">Observed {formatDate(state?.observedAt)}</span></div>;
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><strong>{title}</strong><p>{detail}</p></div>;
}

function RunState({ state }: { state: string }) { return <span className={`state state-${state}`}>{stateLabel(state)}</span>; }

type IconName = 'overview' | 'work' | 'run' | 'factory' | 'settings' | 'refresh';

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
    overview: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
    work: <><path d="M7 3h8l4 4v14H7z" /><path d="M15 3v5h5M10 12h6M10 16h6" /></>,
    run: <path d="m7 4 12 8L7 20z" />,
    factory: <><path d="M3 21V9l6 3V7l6 4V3h6v18z" /><path d="M7 17h2M13 17h2M17 8h2" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 0-2 5" /></>,
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function Overview({ state, runs, selectRun, openWork }: { state: ConsoleState; runs: Run[]; selectRun: (id: string) => void; openWork?: () => void }) {
  const activeRuns = runs.filter((run) => ['admitted', 'launching', 'running', 'cancelling', 'reconciling'].includes(run.state)).length;
  const attentionRuns = runs.filter((run) => run.state === 'blocked' || run.state === 'reconciling' || run.providerRequests?.some((request) => request.status === 'pending'));
  const waitingDecisions = attentionRuns.length;
  const failedRuns = runs.filter((run) => run.state === 'failed').length;
  const reservedTokens = runs.filter((run) => run.reservation?.status === 'held' || run.reservation?.status === 'uncertain').reduce((total, run) => total + (run.reservation?.estimatedTokens ?? 0), 0);
  const resources = state.resources;
  const renderRuns = (items: Run[], emptyTitle: string, emptyDetail: string) => items.length === 0
    ? <Empty title={emptyTitle} detail={emptyDetail} />
    : <div className="run-list">{items.map((run) => <button className="run-row" key={run.runId} onClick={() => selectRun(run.runId)}><span className="run-work">{run.workItem.id}<small>{run.target.repository ?? 'Repository not observed'}</small></span><RunState state={run.state} /><span>{duration(run.createdAt)}</span></button>)}</div>;
  return <section className="workspace overview-workspace"><div className="overview-bento">
    <section className="panel panel-primary attention-panel"><div className="panel-heading"><div><h2>Needs your attention</h2><p>Review requests and work that needs a decision.</p></div><strong className="panel-count">{String(waitingDecisions).padStart(2, '0')}</strong></div>{renderRuns(attentionRuns, 'You’re all caught up', 'No runs in this view are waiting for a decision or recovery.')}</section>
    <section className="panel capacity-panel"><div className="panel-heading"><div><h2>Factory capacity</h2><p>Factory-wide resources with scoped run counts.</p></div><strong>{activeRuns} scoped runs</strong></div><dl className="capacity-list"><dt>Factory admission</dt><dd>{state.admissionPaused ? 'Paused' : 'Open'}</dd><dt>Scoped reservations</dt><dd>{count(reservedTokens)}</dd><dt>Factory reported usage</dt><dd>{resources?.reportedUsageCount ? measurement(resources.knownUsageTokens) : 'Unavailable'}</dd><dt>Factory unavailable measurements</dt><dd>{measurement(resources?.unavailableMeasurements ?? resources?.unavailableUsageCount)}</dd></dl><p className="capacity-note">Usage appears when a provider reports it. Unknown usage is never counted as zero.</p></section>
    <section className="panel panel-primary active-panel"><div className="panel-heading"><div><h2>Current work</h2><p>Runs for the selected product and pod.</p></div><strong>{runs.length} total</strong></div>{renderRuns(runs, 'No work started yet', 'Open Work to start an approved work item. Its progress will appear here.')}{runs.length === 0 && openWork && <button onClick={openWork}>Open Work</button>}</section>
    <section className="panel panel-support blocker-panel"><div className="panel-heading"><div><h2>Factory blockers</h2><p>Issues preventing work from starting across the factory.</p></div><strong>{state.blockers?.length ?? 0}</strong></div>{state.blockers?.length ? <Blockers blockers={state.blockers} /> : <Empty title="No blockers reported" detail="No issues preventing admission have been reported." />}</section>
    <section className="panel panel-muted signal-panel"><div className="panel-heading"><div><h2>At a glance</h2><p>Activity for the selected product and pod.</p></div></div><div className="metric-row"><Metric label="Active work" value={count(activeRuns)} /><Metric label="Waiting decisions" value={count(waitingDecisions)} /><Metric label="Failed runs" value={count(failedRuns)} /><Metric label="Reserved tokens" value={count(reservedTokens)} /></div></section>
  </div></section>;
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
  return <div className="split-section hierarchy-section"><section className="panel panel-primary"><h2>Hierarchy</h2>{nodes.length === 0 ? <Empty title="No hierarchy nodes match this scope" detail="Choose another product or pod filter to inspect the published work hierarchy." /> : <div className="hierarchy-tree">{roots.map((node) => <HierarchyBranch key={node.id} node={node} children={children} />)}</div>}</section><section className="panel panel-support"><h2>Dependencies</h2>{dependencies.length === 0 ? <Empty title="No dependency edges match this scope" detail="Dependencies are shown only when the coordinator projection publishes an explicit edge." /> : <ul className="dependency-list">{dependencies.map((edge) => <li key={`${edge.from}-${edge.to}`}><span>{allNodeLabels.get(edge.from) ?? edge.from}</span><b>depends on</b><span>{allNodeLabels.get(edge.to) ?? edge.to}</span></li>)}</ul>}</section></div>;
}

export function Work({ state, runs, filter, selectRun, submit }: { state: ConsoleState; runs: Run[]; filter: ScopeFilter; selectRun: (id: string) => void; submit: (command: Command) => void }) {
  const [workItemId, setWorkItemId] = useState('');
  const [query, setQuery] = useState('');
  const matchingRuns = filterWorkRuns(runs, query);
  const columns = ['queued', 'admitted', 'launching', 'running', 'blocked', 'reconciling', 'succeeded', 'failed', 'cancelled'];
  return <section className="workspace"><div className="panel panel-primary section-header work-header"><div><h2>Work</h2><p>Track work from the queue through completion. Scroll the board to see every stage.</p></div><form className="start-work" onSubmit={(event) => { event.preventDefault(); if (workItemId.trim()) { submit({ type: 'start_work', workItemId: workItemId.trim() }); setWorkItemId(''); } }}><label>Eligible work ID<input value={workItemId} onChange={(event) => setWorkItemId(event.target.value)} placeholder="Enter an approved work item ID" /></label><button className="primary" type="submit" disabled={state.admissionPaused}>Start work</button></form></div>
  <div className="board-toolbar"><label>Find work<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search work ID, provider, or status" /></label><span role="status">{matchingRuns.length} of {runs.length} runs{query && <button type="button" onClick={() => setQuery('')}>Clear search</button>}</span></div>
  <div className="panel panel-muted board" tabIndex={0} aria-label="Work board">{columns.map((column) => { const items = matchingRuns.filter((run) => run.state === column); return <div className="board-column" key={column}><h3>{stateLabel(column)} <span>{items.length}</span></h3>{items.length === 0 ? <p className="quiet">None</p> : items.map((run) => <button className="work-item" key={run.runId} onClick={() => selectRun(run.runId)}><strong>{run.workItem.id}</strong><span>{run.target.productId ?? 'Product unreported'}</span><small>{run.provider ?? 'Provider unreported'} · {duration(run.createdAt)}</small></button>)}</div>; })}</div>
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

export function RunDetail({ run, submit, blockers }: { run?: Run; submit: (command: Command) => void; blockers: Blocker[] }) {
  const [message, setMessage] = useState('');
  if (!run) return <section className="workspace"><div className="panel panel-primary"><Empty title="Select a run" detail="Choose a run from Overview or Work to see its progress, evidence, and messages." /></div></section>;
  const timeline = [
    { label: 'Admitted to coordinator', at: run.createdAt, detail: `Reservation: ${run.reservation?.status ?? 'not observed'}` },
    ...(run.messages ?? []).map((entry) => ({ label: 'Owner instruction queued', at: entry.createdAt, detail: entry.delivery ?? 'delivery not observed' })),
    ...(run.result ? [{ label: `Provider result: ${run.result.outcome ?? 'observed'}`, at: undefined, detail: run.result.summary ?? 'No safe summary was published.' }] : []),
  ];
  return <section className="workspace run-workspace">
    <div className="panel panel-primary run-title"><div><span className="eyebrow">Run</span><h2>{run.runId}</h2><p>{run.workItem.id} · {run.target.repository ?? 'Repository not observed'}</p></div><RunState state={run.state} /></div>
    <div className="detail-grid"><section className="panel panel-primary"><h3>Timeline</h3><ol className="timeline">{timeline.map((event, index) => <li key={`${event.label}-${index}`}><span /><div><strong>{event.label}</strong><p>{event.detail}</p><time>{formatDate(event.at)}</time></div></li>)}</ol></section><section className="panel panel-support inspection"><h3>Execution</h3><dl><dt>Provider</dt><dd>{run.provider ?? 'Not observed'}</dd><dt>Model</dt><dd>{run.model ?? 'Not observed'}</dd><dt>Profile</dt><dd>{run.profile ?? 'Not observed'}</dd><dt>Authority</dt><dd>{run.authority?.revoked ? 'Revoked' : `Epoch ${run.authority?.epoch ?? 'not observed'}`}</dd></dl><h3>Evidence</h3>{run.result?.verification?.length ? <ul className="evidence">{run.result.verification.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="quiet">No verification evidence was published for this run.</p>}<button onClick={() => submit({ type: 'open_record', runId: run.runId })}>Open authoritative record</button></section></div>
    <Blockers blockers={blockers} runId={run.runId} />
    <section className="panel panel-muted request-section"><h3>Provider requests</h3><ProviderRequests run={run} submit={submit} /></section>
    <div className="command-area"><form className="panel panel-primary" onSubmit={(event) => { event.preventDefault(); if (message.trim()) { submit({ type: 'message', runId: run.runId, body: message.trim() }); setMessage(''); } }}><label>Send instruction for the next provider turn<textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="State the bounded instruction…" maxLength={16000} /></label><button className="primary" type="submit">Queue instruction</button></form><div className="panel capacity-panel run-actions"><button onClick={() => submit({ type: 'resume', runId: run.runId })}>Resume if eligible</button><button className="danger" onClick={() => submit({ type: 'cancel', runId: run.runId, reason: 'Owner requested cancellation from Console.' })}>Cancel run</button></div></div>
  </section>;
}

function Blockers({ blockers, runId }: { blockers: Blocker[]; runId?: string }) {
  const visible = blockers.filter((blocker) => runId === undefined || blocker.related.parentRunId === runId || blocker.related.childRunId === runId);
  if (visible.length === 0) return null;
  return <section className="panel panel-support request-section"><h3>Admission blockers</h3><p className="quiet">These are read-only coordinator diagnoses. They do not resume or change work.</p><ul className="findings">{visible.map((blocker) => <li key={blocker.blockerId}><strong>{blocker.reasonCode.replaceAll('_', ' ')}</strong><span>{blocker.decisionOwnerRole.replaceAll('_', ' ')}</span><p>{blocker.remediation}</p><small>{blocker.ownership.state === 'missing_or_orphaned' ? 'Ownership record is missing or orphaned.' : blocker.ownership.paths.length ? `Observed paths: ${blocker.ownership.paths.join(', ')}` : 'No safe ownership paths were published.'}{blocker.ownership.omittedPathCount ? ` · ${blocker.ownership.omittedPathCount} unsafe path value(s) omitted` : ''}{blocker.omittedIdentityCount ? ` · ${blocker.omittedIdentityCount} unsafe identity value(s) omitted` : ''}</small>{blocker.overlaps.length ? <small> · Overlap: {blocker.overlaps.map((pair) => `${pair.requestedPath} / ${pair.existingPath}`).join(', ')}</small> : null}</li>)}</ul></section>;
}

export function Factory({ state, runs, submit }: { state: ConsoleState; runs: Run[]; submit: (command: Command) => void }) {
  const resources = state.resources;
  const findings = state.factoryGM?.findings ?? [];
  const improvements = state.factoryGM?.improvements ?? [];
  const runIds = new Set(runs.map((run) => run.runId));
  const queueAge = (resources?.queueAge ?? []).filter((entry) => runIds.has(entry.runId));
  const preflight = state.preflight;
  const knownUsage = (resources?.reportedUsageCount ?? 0) > 0 && resources?.knownUsageTokens !== undefined ? `${count(resources.knownUsageTokens)} tokens` : 'Unavailable';
  const reportedMeasurements = resources?.reportedUsageCount === undefined ? 'Unavailable' : count(resources.reportedUsageCount);
  const unavailableMeasurements = measurement(resources?.unavailableMeasurements ?? resources?.unavailableUsageCount);
  return <section className="workspace">
    <div className="section-header"><div><h2>Factory</h2><p>Resource measurements and durable operational attention. The GM never gains authority from this view.</p></div><button className="primary" onClick={() => submit({ type: 'pause_admission', paused: !state.admissionPaused })}>{state.admissionPaused ? 'Resume admission' : 'Pause admission'}</button></div>
    {preflight ? <div className="request-section"><h3>Read-only preflight</h3><p className="quiet">{preflight.scope.productId}{preflight.scope.podId ? ` / ${preflight.scope.podId}` : ''} · {preflight.status}. Projection: {preflight.projectionReady ? 'ready' : 'not ready'}. Execution prerequisites: {preflight.executionReady ? 'ready' : 'not verified'}. Live execution: {preflight.liveExecutionVerified ? 'verified by supplied revision-bound evidence' : 'not tested'}.</p><ul className="findings">{preflight.checks.map((item) => <li key={item.id}><strong>{item.id.replaceAll('_', ' ')}</strong><span>{item.status.replaceAll('_', ' ')}</span><p>{item.remediation}</p><small>{item.section} · {item.basis} · {item.freshness}</small></li>)}</ul><p className="notice">Preflight is an observation report, not an admission lease, approval, repair, or provider launch.</p></div> : <p className="notice">No preflight report was supplied. Provider execution is not tested by this view.</p>}
    <div className="factory-grid"><div><h3>Resource signals</h3><dl className="resource-list"><dt>Known reported usage</dt><dd>{knownUsage}</dd><dt>Reserved capacity</dt><dd>{measurement(resources?.reservedTokens, ' tokens')}</dd><dt>Reported measurements</dt><dd>{reportedMeasurements}</dd><dt>Unavailable measurements</dt><dd>{unavailableMeasurements}</dd></dl><p className="notice">Usage stays separated from estimates and unavailable telemetry. No cost is inferred here.</p></div><div><h3>Queue age</h3>{queueAge.length ? <ul className="queue-age">{queueAge.map((entry) => <li key={entry.runId}><span>{entry.runId}</span><strong>{duration(entry.createdAt)}</strong></li>)}</ul> : <Empty title="No queued runs in this scope" detail="Human wait and execution time require an observed run record." />}</div></div>
    <div className="split-section"><div><h2>GM findings</h2>{findings.length ? <ul className="findings">{findings.map((finding) => <li key={finding.findingId}><strong>{finding.category.replaceAll('_', ' ')}</strong><span>{finding.diagnosis.state}</span><p>{finding.latestSummary}</p><small>{finding.ownerAttention === 'owner_once' ? 'Owner attention requested once' : 'No owner attention requested'}{finding.diagnosis.summary ? ` · ${finding.diagnosis.summary}` : ''}</small></li>)}</ul> : <Empty title="No GM findings published" detail="The Factory GM is event-triggered; this does not claim it has run." />}</div><div><h2>Improvement backlog</h2>{improvements.length ? <ul className="findings">{improvements.map((item) => <li key={item.proposalId}><strong>{item.detail}</strong><span>{item.status}</span><p>{item.authority === 'requires_approval' ? 'Requires the normal approved delivery path.' : 'Authority not published.'}</p></li>)}</ul> : <Empty title="No improvement proposals" detail="Unapproved changes remain absent rather than being represented as planned work." />}</div></div>
  </section>;
}

export function ScopeFilters({ hierarchy, filter, setFilter }: { hierarchy?: Hierarchy; filter: ScopeFilter; setFilter: (next: ScopeFilter) => void }) {
  const products = hierarchy?.filters?.products ?? [];
  const pods = (hierarchy?.filters?.pods ?? []).filter((pod) => filter.productId === '' || pod.productId === filter.productId);
  return <div className="scope-filters" aria-label="Console scope filters"><label><span>Product</span><select value={filter.productId} onChange={(event) => setFilter({ productId: event.target.value, podId: '' })}><option value="">All products</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label><label><span>Pod</span><select value={filter.podId} onChange={(event) => setFilter({ ...filter, podId: event.target.value })} disabled={pods.length === 0}><option value="">All pods</option>{pods.map((pod) => <option key={pod.id} value={pod.id}>{pod.id}</option>)}</select></label></div>;
}

export function filterWorkRuns(runs: Run[], query: string): Run[] {
  const needle = query.trim().toLocaleLowerCase();
  return runs.filter((run) => [run.workItem.id, run.runId, run.provider ?? '', stateLabel(run.state)].join(' ').toLocaleLowerCase().includes(needle));
}

export function viewFromHash(hash: string): 'overview' | 'work' | 'run' | 'factory' | 'settings' {
  const view = hash.slice(1);
  return view === 'work' || view === 'run' || view === 'factory' || view === 'settings' ? view : 'overview';
}

function App() {
  const { state, connection, error, refresh } = useConsoleState();
  const [view, setView] = useState<ReturnType<typeof viewFromHash>>(() => viewFromHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => {
      if (['#overview', '#work', '#run', '#factory', '#settings'].includes(window.location.hash)) setView(viewFromHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => { window.history.replaceState(null, '', '#' + view); }, [view]);
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
  const views = ['overview', 'work', 'run', 'factory', 'settings'] as const;
  const title = view === 'run' ? 'Run detail' : view[0].toUpperCase() + view.slice(1);
  return <main className="app-shell">
    <a className="skip-link" href="#console-content">Skip to content</a>
    <aside className="sidebar"><a className="wordmark" href="#overview" onClick={() => setView('overview')}><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span className="brand-name">FAKTORI<small>LOCAL CONSOLE</small></span></a><nav aria-label="Console views">{views.map((item) => <button key={item} type="button" className={view === item ? 'active' : ''} aria-current={view === item ? 'page' : undefined} onClick={() => setView(item)}><Icon name={item} /><span>{item === 'run' ? 'Run detail' : item}</span></button>)}</nav></aside>
    <div className="main-column" id="console-content"><header className="topbar"><div className="title-group"><span className="eyebrow">{state.hierarchy?.nodes?.find((node) => node.kind === 'factory')?.label ?? 'Local factory'}</span><h1>{title}</h1></div><div className="header-controls">{view !== 'settings' && <ScopeFilters hierarchy={state.hierarchy} filter={filter} setFilter={setFilter} />}<button className="refresh-button" type="button" aria-label="Refresh" onClick={() => void refresh()}><Icon name="refresh" /><span>Refresh</span></button></div></header><div className="status-strip"><Status connection={connection} state={state} /></div>
    {error && <div className="alert" role="alert">{error}</div>}{pending.length > 0 && <div className="pending" role="status"><strong>{pending.length} command{pending.length === 1 ? '' : 's'} pending</strong>{pending.map((entry) => <span key={entry.id}>{entry.command.type.replaceAll('_', ' ')} {entry.status === 'failed' ? `failed: ${entry.detail}` : 'awaiting confirmation'}<button type="button" onClick={() => retry(entry)}>{entry.status === 'failed' ? 'Replay safely' : 'Retry with same identity'}</button></span>)}</div>}
    {view === 'settings' && <Settings settings={state.settings} connectionSettings={<details className="session-key"><summary>Connection settings</summary><label><span>Local command token</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="Required for actions" /></label><small>Kept only in this page session.</small></details>} />}{view === 'overview' && <Overview state={state} runs={visibleRuns} selectRun={selectRun} openWork={() => setView('work')} />}{view === 'work' && <Work state={state} runs={visibleRuns} filter={filter} selectRun={selectRun} submit={submit} />}{view === 'run' && <RunDetail run={selectedRun} submit={submit} blockers={state.blockers ?? []} />}{view === 'factory' && <Factory state={state} runs={visibleRuns} submit={submit} />}</div>
  </main>;
}

const rootElement = typeof document === 'undefined' ? null : document.getElementById('root');
if (rootElement) createRoot(rootElement).render(<App />);
