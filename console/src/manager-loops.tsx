import { HelpHeading, HelpSummary } from "./section-help.tsx";
import React from 'react';

export interface ManagerLoopView {
  id: string;
  productId?: string;
  podId?: string;
  status: string;
  stale: boolean;
  updatedAt?: string;
  completedPhases: string[];
  currentStage?: { phaseId: string; kind: string; round: number };
  stages: Array<{ phaseId: string; kind: string; round: number; outcome: string; completedAt: string; decision?: string; verification?: 'passed' | 'failed' }>;
  reason?: string;
  delivery?: {
    gates: Array<{
      id: 'local_acceptance' | 'publication' | 'review' | 'merge' | 'deployment' | 'staging_verification';
      label: string;
      status: 'pending' | 'passed' | 'failed' | 'unobserved';
      evidenceUrl?: string;
    }>;
    nextAction: { label: string; role: string; url?: string };
    issue?: string;
  };
}

const label = (value: string): string => value.replaceAll('_', ' ');
const loopStatusLabel = (loop: ManagerLoopView): string => loop.status === 'succeeded' ? 'Locally accepted' : loop.status === 'running' ? 'Recorded running' : label(loop.status);
const safeExternalUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
};

function Delivery({ delivery }: { delivery: NonNullable<ManagerLoopView['delivery']> }) {
  const actionUrl = safeExternalUrl(delivery.nextAction.url);
  return <div className="loop-delivery"><div className="loop-gates" aria-label="Delivery gates">{delivery.gates.map((gate) => {
    const evidenceUrl = safeExternalUrl(gate.evidenceUrl);
    return <span className={`loop-gate loop-gate-${gate.status}`} key={gate.id}><b>{gate.label}</b>{evidenceUrl ? <a href={evidenceUrl} target="_blank" rel="noopener noreferrer">{label(gate.status)}<span className="sr-only"> evidence opens in a new tab</span></a> : <em>{label(gate.status)}</em>}</span>;
  })}</div><p className="loop-next-action"><span>Next required</span><strong>{delivery.nextAction.label}</strong><small>Owner: {label(delivery.nextAction.role)}</small>{actionUrl && <a href={actionUrl} target="_blank" rel="noopener noreferrer">Open authoritative record<span className="sr-only"> in a new tab</span></a>}</p>{delivery.issue && <p className="quiet">Issue: {delivery.issue}</p>}</div>;
}
export function ManagerLoops({ loops = [], filter = { productId: '', podId: '' } }: {
  loops?: ManagerLoopView[];
  filter?: { productId: string; podId: string };
}) {
  if (loops.length === 0) return null;
  const visible = loops.filter((loop) => (!filter.productId || loop.productId === filter.productId) && (!filter.podId || loop.podId === filter.podId));
  return <section className="panel panel-primary manager-loops" aria-label="Manager loops">
    <div className="panel-heading"><div><HelpHeading level={2} scope="manager-loops">Manager loops</HelpHeading><p>Recorded phases, reviews, and repairs. Read-only; controlled by the loop runner.</p></div><strong>{visible.length}</strong></div>
    {visible.length === 0 && <p className="quiet">No connected loops in this scope.</p>}
    <div className="loop-grid">{visible.map((loop) => <article id={`manager-loop-${loop.id}`} className="loop-card" key={loop.id}>
      <div className="panel-heading"><HelpHeading level={3} scope="manager-loops">{loop.id}</HelpHeading><span className={`state state-${loop.status}`}>{loopStatusLabel(loop)}</span></div>
      {loop.stale && loop.status === 'running' && <p className="notice">Last progress recorded {loop.updatedAt ? new Date(loop.updatedAt).toLocaleString() : 'at an unknown time'}; worker liveness unconfirmed.</p>}
      {loop.stale && loop.status !== 'running' && <p className="notice">This projection may be stale. Last progress recorded {loop.updatedAt ? new Date(loop.updatedAt).toLocaleString() : 'at an unknown time'}.</p>}
      <p><strong>{loop.completedPhases.length}</strong> phases accepted · <strong>{loop.stages.filter((stage) => stage.kind === 'repair').length}</strong> repair attempts recorded</p>
      {loop.currentStage && <p>Current recorded step: <strong>{loop.currentStage.phaseId} / {label(loop.currentStage.kind)}</strong> · round {loop.currentStage.round}</p>}
      {loop.reason && <p className="notice">{loop.reason}</p>}
      <p className="quiet">Last record: {loop.updatedAt ? new Date(loop.updatedAt).toLocaleString() : 'Not available'}</p>
      {loop.delivery && <><Delivery delivery={loop.delivery} /><p className="quiet">Post-publication gates are owner-recorded evidence, not automatic verification.</p></>}
      <details><HelpSummary scope="manager-loops">Phase and review history</HelpSummary>
        <p>Accepted phases: {loop.completedPhases.length ? loop.completedPhases.join(', ') : 'None yet'}</p>
        {loop.stages.length === 0 ? <p className="quiet">No completed steps recorded.</p> : <ol className="loop-history">{loop.stages.map((stage, index) => <li key={`${stage.phaseId}-${stage.kind}-${stage.round}-${index}`}><strong>{stage.phaseId} / {label(stage.kind)}</strong><span>Round {stage.round} · Execution: {label(stage.outcome)}</span>{stage.decision && <span>Decision: {label(stage.decision)}</span>}{stage.verification && <span>Verification: {stage.verification}</span>}<time>{new Date(stage.completedAt).toLocaleString()}</time></li>)}</ol>}
      </details>
    </article>)}</div>
  </section>;
}
