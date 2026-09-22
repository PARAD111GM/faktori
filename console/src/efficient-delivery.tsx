import { useEffect, useMemo, useState } from 'react';

import { HelpHeading, HelpSummary } from './section-help.tsx';
import './efficient-delivery.css';
import type { ControlRecord } from '../../src/console/delivery-control.ts';
import type { PersistentPreviewRuntimeSnapshot } from '../../src/console/preview-runtime.ts';
import type { ConsoleWorkflowRuntimeSnapshot } from '../../src/console/workflow-runtime.ts';
import type { RouteDecision } from '../../src/runtime/routing.ts';

type EfficientDeliveryRoutingDecision = RouteDecision & { runId?: string; workItemId?: string; role?: string; taskClass?: string; observedAt?: string };

export interface EfficientDeliveryPreviewFeedback {
  id: string;
  summary: string;
  requestedRevision: string;
  appliedRevision?: string;
  confirmedRevision?: string;
}

export interface EfficientDeliveryPreview {
  id: string;
  url: string;
  state: string;
  evidence: string;
  candidateRevision: string;
  runtimeRevision?: string;
  detail?: string;
  feedback?: EfficientDeliveryPreviewFeedback[];
  finalReview?: string;
}

export interface EfficientDeliveryState {
  routing?: { configured: true; policyRevision: string; decisions: EfficientDeliveryRoutingDecision[] };
  workflow?: ConsoleWorkflowRuntimeSnapshot;
  previews?: PersistentPreviewRuntimeSnapshot;
  consultations?: { unresolved?: Array<{ runId: string; operationId: string }> };
  /** Command receipts, not browser command descriptors. */
  commands?: ControlRecord[];
}

type CommandStatus = { commandId: string; state: 'pending' | ControlRecord['status']; detail: string };
type FeedbackDraft = { itemId: string; summary: string };

const actionId = (): string => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `efficient-delivery-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};
const title = (value?: string): string => value ? value.replaceAll('_', ' ') : 'Not recorded';
const routeStatus = (value?: string): string => value ? title(value) : 'No decision recorded';
const nextFeedbackItemId = (preview: EfficientDeliveryPreview): string => {
  const prefix = `feedback-${preview.id}-`;
  const known = new Set((preview.feedback ?? []).map(item => item.id));
  for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) if (!known.has(`${prefix}${ordinal}`)) return `${prefix}${ordinal}`;
  throw new Error('feedback_batch_item_limit_reached');
};

function FeedbackState({ item }: { item: EfficientDeliveryPreviewFeedback }) {
  const status = item.confirmedRevision ? 'confirmed' : item.appliedRevision ? 'applied' : 'requested';
  const revision = item.confirmedRevision ?? item.appliedRevision ?? item.requestedRevision;
  return <div className={`efficient-feedback efficient-feedback-${status}`}><div><strong>{item.summary}</strong><small>Revision {revision}</small></div><span className={`state state-${status}`}>{status}</span></div>;
}

export function EfficientDelivery({ state, token, onChanged }: { state?: EfficientDeliveryState; token: string; onChanged?: () => void }) {
  const [commands, setCommands] = useState<Record<string, CommandStatus>>({});
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, FeedbackDraft>>({});
  const decisions = state?.routing?.decisions ?? [];
  const queue = state?.workflow?.queue ?? [];
  const previews = state?.previews?.previews ?? [];
  const receipts = state?.commands ?? [];
  const previewOperations = useMemo(() => state?.previews?.operations ?? [], [state?.previews?.operations]);
  const hasCommandToken = token.trim().length > 0;
  const mayEvaluateQueue = hasCommandToken && state?.workflow !== undefined;
  const isAwaiting = (key: string): boolean => ['pending', 'accepted'].includes(commands[key]?.state ?? '');
  const configuredFeature = state?.routing !== undefined || state?.workflow !== undefined || state?.previews !== undefined || state?.consultations !== undefined;
  const configurationLabel = state?.routing?.configured ? 'Configured' : configuredFeature ? 'Partially configured' : 'Not configured';

  useEffect(() => {
    setFeedbackDrafts(current => {
      let changed = false;
      const next = { ...current };
      for (const preview of previews) {
        const draft = next[preview.id];
        if (draft && preview.feedback.some(item => item.id === draft.itemId)) { delete next[preview.id]; changed = true; }
      }
      return changed ? next : current;
    });
  }, [previews]);

  useEffect(() => {
    setCommands(current => {
      let changed = false;
      const next = { ...current };
      for (const [key, command] of Object.entries(current)) {
        const receipt = receipts.find(item => item.commandId === command.commandId);
        if (receipt && (command.state !== receipt.status || command.detail !== (receipt.detail ?? command.detail))) {
          next[key] = { commandId: command.commandId, state: receipt.status, detail: receipt.detail ?? (receipt.status === 'completed' ? 'Completed. The controller recorded the effect.' : receipt.status === 'accepted' ? 'Accepted and awaiting a terminal controller receipt.' : 'The controller recorded an uncertain result; reconcile its owned evidence before retrying.') };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [receipts]);

  useEffect(() => {
    if (!Object.values(commands).some(command => command.state === 'accepted')) return;
    const timer = window.setInterval(() => { onChanged?.(); }, 500);
    return () => window.clearInterval(timer);
  }, [commands, onChanged]);

  const submit = async (id: string, command: { type: 'queue_evaluate'; mode: 'shadow' | 'attended' } | { type: 'preview'; operationId: string } | { type: 'preview_feedback'; previewId: string; itemId: string; summary: string; revision: string } | { type: 'preview_confirm'; previewId: string; itemId: string; revision: string }): Promise<boolean> => {
    const commandId = actionId();
    setCommands(current => ({ ...current, [id]: { commandId, state: 'pending', detail: 'Requesting a bounded, journaled action…' } }));
    try {
      const response = await fetch('/api/console/efficient-delivery/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-faktori-console-token': token },
        body: JSON.stringify({ commandId, command }),
      });
      const payload = await response.json().catch(() => undefined) as (ControlRecord & { error?: string }) | undefined;
      if (!response.ok || payload?.status === 'failed') throw new Error(payload?.detail ?? payload?.error ?? 'The request could not be recorded.');
      const status = payload?.status;
      if (status !== 'accepted' && status !== 'completed' && status !== 'uncertain') throw new Error(payload?.error ?? 'The controller did not return a command receipt.');
      setCommands(current => ({ ...current, [id]: { commandId, state: status, detail: payload?.detail ?? (status === 'accepted' ? 'Accepted and awaiting a terminal controller receipt.' : status === 'completed' ? 'Completed. The controller recorded the effect.' : 'The action is uncertain. Reconcile owned evidence before retrying.') } }));
      onChanged?.();
      return true;
    } catch (error) {
      setCommands(current => ({ ...current, [id]: { commandId, state: 'failed', detail: error instanceof Error ? `${error.message} Repair the server-side allowlist or recorded state, then retry this same bounded action.` : 'Request failed. Repair the recorded state before retrying.' } }));
      return false;
    }
  };

  if (!state) return null;

  return <section className="efficient-delivery" aria-labelledby="efficient-delivery-title">
    <header className="panel-heading"><div><HelpHeading level={2} scope="work" id="efficient-delivery-title">Efficient delivery</HelpHeading><p>Current routing, handoffs, local preview evidence, and one bounded review batch. It does not grant merge, deployment, or publishing authority.</p></div><span className={`state ${state?.routing?.configured ? 'state-configured' : 'state-unavailable'}`}>{configurationLabel}</span></header>

    <div className="efficient-delivery-grid">
      <section className="efficient-card" aria-labelledby="efficient-routing-title"><div className="panel-heading"><div><HelpHeading level={3} scope="work" id="efficient-routing-title">Routing decisions</HelpHeading><p>Policy revision {state?.routing?.policyRevision ?? 'not recorded'}.</p></div><span className="state">{decisions.length} recorded</span></div>{decisions.length === 0 ? <p className="quiet">No route decision is published. Unknown or stale capacity is not treated as permission for premium work.</p> : <ul className="efficient-list">{decisions.slice(0, 6).map((decision) => <li key={decision.attemptId}><div><strong>{decision.routeId ?? 'No route admitted'}{decision.model ? ` · ${decision.model}` : ''}{decision.providerId ? ` (${decision.providerId})` : ''}</strong><p>{decision.reason}</p><small>Capacity freshness: {decision.capacityFreshness}{decision.observedAt ? ` · observed ${decision.observedAt}` : ''}</small></div><span className="state">{routeStatus(decision.status)}</span></li>)}</ul>}</section>

      <section className="efficient-card" aria-labelledby="efficient-queue-title"><div className="panel-heading"><div><HelpHeading level={3} scope="work" id="efficient-queue-title">Workflow queue</HelpHeading><p>{state?.workflow?.reason ?? 'Queue state is a projection; it does not itself prove a handoff or completion.'}</p></div><span className="state">{state?.workflow?.status ?? 'Not configured'}</span></div>{queue.length === 0 ? <p className="quiet">No eligible queue items are currently published. Automatic evaluation remains gated.</p> : <ul className="efficient-list">{queue.map((item) => <li key={item.workItemId}><div><strong>{item.workItemId} · {title(item.stageId)}</strong><small>Owner: {title(item.role)} · Activity: {title(item.activity)} · Rank {item.rank}</small>{item.blocker && <p className="efficient-blocker">Blocker: {item.blocker}</p>}</div></li>)}</ul>}<div className="efficient-actions"><button type="button" onClick={() => void submit('queue-shadow', { type: 'queue_evaluate', mode: 'shadow' })} disabled={!mayEvaluateQueue || isAwaiting('queue-shadow')}>{isAwaiting('queue-shadow') ? 'Awaiting queue receipt' : 'Evaluate in shadow'}</button><button className="primary" type="button" onClick={() => void submit('queue-attended', { type: 'queue_evaluate', mode: 'attended' })} disabled={!mayEvaluateQueue || isAwaiting('queue-attended')}>{isAwaiting('queue-attended') ? 'Awaiting queue receipt' : 'Evaluate attended queue'}</button></div>{!state?.workflow ? <p className="quiet">Workflow is not configured. An owner must configure its source before evaluation can be requested.</p> : !hasCommandToken ? <p className="quiet">Enter the local Console command token in Settings before requesting an evaluation.</p> : <p className="quiet">Automatic queue admission is intentionally gated until connected transport and witnessed delivery evidence are current.</p>}</section>
    </div>

    <section className="efficient-card efficient-preview-card" aria-labelledby="efficient-preview-title"><div className="panel-heading"><div><HelpHeading level={3} scope="work" id="efficient-preview-title">Persistent local previews</HelpHeading><p>Human review uses a separate browser context from agent testing. A stopped or invalidated local preview is not production or deployment evidence.</p></div><span className="state">{previews.length} registered</span></div>{previews.length === 0 ? <p className="quiet">No owner-registered persistent previews are published by this Console.</p> : <div className="efficient-preview-list">{previews.map((preview) => { const controls = previewOperations.filter(operation => operation.previewId === preview.id); const draft = feedbackDrafts[preview.id]; const feedbackKey = draft ? `feedback-${preview.id}-${draft.itemId}` : `feedback-${preview.id}`; return <article key={preview.id} className="efficient-preview"><div className="efficient-preview-heading"><div><strong>{preview.id}</strong><small>Candidate {preview.candidateRevision}{preview.runtimeRevision ? ` · runtime ${preview.runtimeRevision}` : ''}</small></div><span className={`state state-${preview.state}`}>{title(preview.state)}</span></div><p>Evidence: <strong>{title(preview.evidence)}</strong>{preview.detail ? ` · ${preview.detail}` : ''}</p><a href={preview.url} target="_blank" rel="noopener noreferrer">Open local preview<span className="sr-only"> (opens in a new tab)</span></a>{controls.length > 0 && <div className="efficient-actions">{controls.map(operation => { const feedbackIndex = controls.filter(item => item.kind === 'feedback').findIndex(item => item.id === operation.id) + 1; const label = operation.kind === 'feedback' ? `Apply edit ${feedbackIndex}` : title(operation.kind); return <button key={operation.id} type="button" disabled={!hasCommandToken || isAwaiting(operation.id)} onClick={() => void submit(operation.id, { type: 'preview', operationId: operation.id })}>{isAwaiting(operation.id) ? 'Awaiting receipt…' : label}</button>; })}</div>}<div className="efficient-feedback-block"><div><HelpHeading level={4} scope="work">Feedback batch</HelpHeading><p>Requested, applied, and confirmed edits stay in this feature and implementer scope.</p></div>{(preview.feedback ?? []).length === 0 ? <p className="quiet">No feedback items are recorded.</p> : <div className="efficient-feedback-list">{preview.feedback!.map(item => <div key={item.id}><FeedbackState item={item} />{item.appliedRevision && !item.confirmedRevision && <button type="button" disabled={!hasCommandToken || isAwaiting(`confirm-${preview.id}-${item.id}`)} onClick={() => void submit(`confirm-${preview.id}-${item.id}`, { type: 'preview_confirm', previewId: preview.id, itemId: item.id, revision: item.appliedRevision! })}>{isAwaiting(`confirm-${preview.id}-${item.id}`) ? 'Awaiting receipt…' : 'Confirm applied edit'}</button>}</div>)}</div>}<label className="efficient-feedback-entry">Request a bounded edit<textarea value={draft?.summary ?? ''} maxLength={2000} onChange={(event) => setFeedbackDrafts(current => ({ ...current, [preview.id]: { itemId: current[preview.id]?.itemId ?? nextFeedbackItemId(preview), summary: event.target.value } }))} placeholder="Describe one concrete change for this preview." /></label><button type="button" disabled={!hasCommandToken || !draft?.summary.trim() || isAwaiting(feedbackKey)} onClick={() => { if (!draft) return; void submit(feedbackKey, { type: 'preview_feedback', previewId: preview.id, itemId: draft.itemId, summary: draft.summary.trim(), revision: preview.candidateRevision }); }}>{isAwaiting(feedbackKey) ? 'Awaiting receipt…' : commands[feedbackKey]?.state === 'uncertain' ? 'Retry feedback request' : 'Request feedback edit'}</button><p className="quiet">This records only the requested edit for the current revision. Applying it remains with the original builder through the owner-configured operation; this form never runs a command.</p>{!hasCommandToken && <p className="quiet">Enter the local Console command token in Settings to record feedback.</p>}<p className="quiet">Final review: {preview.finalReview ?? 'blocked'}.</p></div></article>; })}</div>}</section>

    {(state?.consultations?.unresolved?.length ?? 0) > 0 && <section className="efficient-card"><HelpHeading level={3} scope="work">Unresolved consultations</HelpHeading><ul className="efficient-list">{state!.consultations!.unresolved!.map((item) => <li key={item.operationId}><div><strong>{item.runId}</strong><p>A bounded consultation operation remains unresolved.</p><small>Operation: {item.operationId}</small></div></li>)}</ul></section>}

    {receipts.length > 0 && <section className="efficient-card"><details><HelpSummary scope="work">Command receipts ({receipts.length})</HelpSummary><ul className="efficient-list">{receipts.slice(-8).reverse().map(receipt => <li key={receipt.eventId}><div><strong>{receipt.commandId}</strong><small>{receipt.observedAt}{receipt.detail ? ` · ${receipt.detail}` : ''}</small></div><span className={`state state-${receipt.status}`}>{title(receipt.status)}</span></li>)}</ul></details></section>}
    {Object.entries(commands).filter(([, result]) => result.state !== 'completed' || !receipts.some(receipt => receipt.commandId === result.commandId)).map(([id, result]) => <p className={`efficient-command-result efficient-command-${result.state}`} key={id} role={result.state === 'failed' ? 'alert' : 'status'}><strong>{title(result.state)}:</strong> {result.detail}</p>)}
  </section>;
}
