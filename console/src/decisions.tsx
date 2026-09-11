import { HelpHeading, HelpSummary } from "./section-help.tsx";
import { useEffect, useRef, useState } from 'react';
import type { ManagerConnectedDecisionSnapshot } from '../../src/manager-connected/index.ts';

export type DecisionState = ManagerConnectedDecisionSnapshot['state'];
export type DecisionCapability = ManagerConnectedDecisionSnapshot['capability'];

/** Deliberately mirrors the browser-safe Batch 2 projection, never relay internals. */
export type DecisionProjection = ManagerConnectedDecisionSnapshot;

type DecisionResponse = { decision?: DecisionProjection; error?: string };
type DecisionAction = DecisionProjection['action'];
type DecisionNavigation = { openRun: (runId: string, requestId: string) => void; openSession: (sessionId: string) => void };

const stateLabel: Record<DecisionState, string> = {
  open: 'Open',
  response_recorded: 'Response recorded',
  pending_manager_ack: 'Pending Manager acknowledgement',
  manager_acknowledged: 'Manager acknowledged',
  resolved: 'Resolved',
  uncertain: 'Uncertain',
  withdrawn: 'Withdrawn',
};

const formatDate = (value?: string): string => {
  if (!value) return 'Not observed';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
};

export const orderDecisions = (decisions: DecisionProjection[]): DecisionProjection[] => [...decisions].sort((left, right) => {
  const priority = (decision: DecisionProjection): number => decision.state === 'open' || decision.state === 'uncertain' ? 0 : decision.state === 'response_recorded' || decision.state === 'pending_manager_ack' ? 1 : 2;
  return priority(left) - priority(right) || new Date(right.observedAt).valueOf() - new Date(left.observedAt).valueOf() || left.id.localeCompare(right.id);
});

const scopeLabel = (scope: DecisionProjection['scope']): string => [scope.productId, scope.planId, scope.phaseId, scope.ticketId].filter(Boolean).join(' / ');

const safeObservedUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : undefined;
  } catch { return undefined; }
};

function DecisionFacts({ decision }: { decision: DecisionProjection }) {
  return <dl className="decision-facts">
    <dt>Cause</dt><dd>{decision.cause.summary} <small>Basis: {decision.cause.basis}</small></dd>
    <dt>Recommended next action</dt><dd>{decision.recommendedNextAction}</dd>
    <dt>Impact</dt><dd>{decision.impact}</dd>
    <dt>Owner</dt><dd>{decision.accountableOwner}</dd>
  </dl>;
}

function DecisionEvidence({ decision }: { decision: DecisionProjection }) {
  if (decision.evidence.length === 0) return <p className="quiet">No additional evidence was published for this decision.</p>;
  return <ul className="decision-evidence">{decision.evidence.map((item, index) => <li key={`${item.label}-${index}`}><strong>{item.label}</strong>{item.summary && <span>{item.summary}</span>}</li>)}</ul>;
}

function DecisionAction({ decision, token, onChanged, navigation }: { decision: DecisionProjection; token: string; onChanged?: () => Promise<void> | void; navigation?: DecisionNavigation }) {
  const [responseId, setResponseId] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const idempotency = useRef<{ responseId: string; key: string } | undefined>(undefined);
  const canRecord = decision.capability === 'supported'
    && decision.action.kind === 'record_owner_response'
    && decision.state === 'open'
    && decision.options.length > 0;

  if (!canRecord) {
    const action = decision.action as DecisionAction;
    const reason = decision.capability === 'stale'
      ? 'Action capability is stale. Refresh before taking a new action.'
      : decision.capability === 'unavailable'
        ? 'This action is unavailable in the current observed state.'
        : decision.state === 'uncertain'
          ? 'The recorded owner response needs Manager reconciliation. No new browser response or acknowledgement control exists.'
        : decision.state === 'response_recorded' || decision.state === 'pending_manager_ack'
          ? 'The owner response is recorded and awaiting the Manager’s next explicit read.'
          : decision.state === 'manager_acknowledged'
            ? 'The Manager acknowledgement is recorded. No browser acknowledgement control exists.'
            : 'This decision has no further owner response action in the Console.';
    const target = action.target;
    const openTarget = decision.capability === 'supported' && target
      ? action.kind === 'answer_provider_request' && 'runId' in target && 'requestId' in target
        ? <><button type="button" onClick={() => navigation?.openRun(target.runId, target.requestId)} disabled={!navigation}>{action.label}</button><p className="quiet">Opens the retained run detail and its existing provider response control. No provider answer has been sent.</p></>
        : action.kind === 'enqueue_agent_task' && 'sessionId' in target
          ? <><button type="button" onClick={() => navigation?.openSession(target.sessionId)} disabled={!navigation}>{action.label}</button><p className="quiet">Opens the recorded session in the existing task composer. No task has been queued.</p></>
          : action.kind === 'open_external_record' && 'url' in target && safeObservedUrl(target.url)
            ? <><a className="decision-target-link" href={safeObservedUrl(target.url)} target="_blank" rel="noopener noreferrer">{action.label}<span className="sr-only"> in a new tab</span></a><p className="quiet">Opens the already observed external record; it does not change it.</p></>
            : null
      : null;
    const targetUnavailable = decision.capability === 'supported' && !openTarget ? 'The published target is no longer safe to open from this Console.' : '';
    const namedTask = action.kind === 'enqueue_agent_task' ? ` The next action names a configured agent task: ${action.label}.` : '';
    return <div className={`decision-action decision-action-${decision.capability}`}><strong>{action.label}</strong><p>{reason}{namedTask}{targetUnavailable && ` ${targetUnavailable}`}</p>{openTarget}<p className="quiet">Use the retained evidence and <a href="#work">Work activity</a> as the authoritative context. This Console does not create a provider, merge, deployment, or native approval.</p></div>;
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const selected = decision.options.find((option) => option.id === responseId);
    if (!selected) { setError('Choose one recorded owner response before submitting it.'); return; }
    if (!token) { setError('Enter the local Console command token in Settings before recording an owner response.'); return; }
    const stored = idempotency.current?.responseId === selected.id ? idempotency.current : { responseId: selected.id, key: globalThis.crypto?.randomUUID?.() ?? `decision-${decision.id}-${Date.now()}` };
    idempotency.current = stored;
    setSending(true);
    setError(undefined);
    try {
      const result = await fetch('/api/console/manager-connected/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Faktori-Console-Token': token },
        body: JSON.stringify({ type: 'record_owner_response', id: decision.id, responseId: selected.id, idempotencyKey: stored.key, expectedRevision: decision.revision }),
      });
      const body = await result.json() as DecisionResponse;
      if (!result.ok) throw new Error(body.error ?? `Owner response could not be recorded (${result.status})`);
      setResponseId('');
      await onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Owner response could not be recorded.');
    } finally { setSending(false); }
  };

  return <form className="decision-response" onSubmit={(event) => void submit(event)}>
    <label>Owner response<select value={responseId} onChange={(event) => setResponseId(event.target.value)} required><option value="">Choose a recorded response</option>{decision.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
    <p className="quiet">Records a response for Manager observation on its next explicit relay read. It does not wake or message the Manager, and it is not an approval.</p>
    {error && <p className="manager-error" role="alert">{error}</p>}
    <button className="primary" type="submit" disabled={sending || !responseId}>{sending ? 'Recording response…' : 'Record response for Manager observation'}</button>
  </form>;
}

function DecisionCard({ decision, token, onChanged, navigation, compact = false }: { decision: DecisionProjection; token: string; onChanged?: () => Promise<void> | void; navigation?: DecisionNavigation; compact?: boolean }) {
  return <article className="decision-card" id={`decision-${decision.id}`}>
    <header className="decision-heading"><div><span className="eyebrow">{scopeLabel(decision.scope)}</span><HelpHeading level={3} scope="decisions">{decision.problem}</HelpHeading></div><span className={`state state-${decision.state}`}>{stateLabel[decision.state]}</span></header>
    <p className="decision-impact">{decision.impact}</p>{decision.ownerResponse && <p className="decision-recorded-response"><strong>Recorded owner response:</strong> {decision.ownerResponse.label}</p>}
    {compact ? <><p><strong>Next:</strong> {decision.recommendedNextAction}</p><p className="quiet">Owner: {decision.accountableOwner} · Cause basis: {decision.cause.basis}</p></> : <>
      <DecisionFacts decision={decision} />
      <section className="decision-evidence-section"><HelpHeading level={4} scope="decisions">Evidence</HelpHeading><DecisionEvidence decision={decision} /></section>
      <DecisionAction decision={decision} token={token} onChanged={onChanged} navigation={navigation} />
      <small className="decision-record">Decision {decision.id} · observed {formatDate(decision.observedAt)}</small>
    </>}
  </article>;
}

export function DecisionInbox({ decisions = [], token = '', onChanged, compact = false, openDecisions, focusedDecisionId, navigation }: { decisions?: DecisionProjection[]; token?: string; onChanged?: () => Promise<void> | void; compact?: boolean; openDecisions?: () => void; focusedDecisionId?: string; navigation?: DecisionNavigation }) {
  const ordered = orderDecisions(decisions);
  const active = ordered.filter((decision) => decision.state !== 'resolved' && decision.state !== 'withdrawn');
  const retainedHistory = ordered.filter((decision) => decision.state === 'resolved' || decision.state === 'withdrawn');
  const visible = compact ? active.slice(0, 3) : active;
  const title = compact ? 'Decision Inbox' : 'Decisions';
  useEffect(() => {
    if (!focusedDecisionId || compact) return;
    const target = document.getElementById(`decision-${focusedDecisionId}`);
    const history = target?.closest('details');
    if (history instanceof HTMLDetailsElement) history.open = true;
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [compact, focusedDecisionId]);
  return <section className={`decision-inbox ${compact ? 'decision-inbox-compact' : ''}`} aria-label={compact ? 'Decision Inbox' : 'Decisions'}>
    {compact && <div className="panel panel-primary decision-inbox-heading"><div><span className="eyebrow">Owner decisions</span><HelpHeading level={2} scope="decisions" id={compact ? 'overview-decisions-title' : 'decisions-title'}>{title}</HelpHeading><p>{compact ? 'The most actionable observed decisions across projects.' : 'Resolve or delegate a specific observed problem. Manager acknowledgement remains a separate recorded state.'}</p></div><strong>{visible.length} shown</strong></div>}
    {visible.length === 0 ? <div className="panel panel-support"><div className="empty"><strong>No decisions need attention</strong><p>No open, uncertain, or pending decision records were published in this projection.</p></div></div> : <div className="decision-list">{visible.map((decision) => <DecisionCard key={decision.id} decision={decision} token={token} onChanged={onChanged} navigation={navigation} compact={compact} />)}</div>}
    {!compact && retainedHistory.length > 0 && <details className="decision-history"><HelpSummary scope="decisions">Resolved and withdrawn history ({retainedHistory.length})</HelpSummary><div className="decision-list">{retainedHistory.map((decision) => <DecisionCard key={decision.id} decision={decision} token={token} onChanged={onChanged} navigation={navigation} />)}</div></details>}
    {compact && <button type="button" className="decision-open-all" onClick={openDecisions}>Open all decisions</button>}
    {focusedDecisionId && <span className="sr-only">Focused decision {focusedDecisionId}</span>}
  </section>;
}
