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
}

const label = (value: string): string => value.replaceAll('_', ' ');
export function ManagerLoops({ loops = [], filter = { productId: '', podId: '' } }: {
  loops?: ManagerLoopView[];
  filter?: { productId: string; podId: string };
}) {
  if (loops.length === 0) return null;
  const visible = loops.filter((loop) => (!filter.productId || loop.productId === filter.productId) && (!filter.podId || loop.podId === filter.podId));
  return <section className="panel panel-primary manager-loops" aria-label="Manager loops">
    <div className="panel-heading"><div><h2>Manager loops</h2><p>Recorded phases, reviews, and repairs. Read-only; controlled by the loop runner.</p></div><strong>{visible.length}</strong></div>
    {visible.length === 0 && <p className="quiet">No connected loops in this scope.</p>}
    <div className="loop-grid">{visible.map((loop) => <article className="loop-card" key={loop.id}>
      <div className="panel-heading"><h3>{loop.id}</h3><span className={`state state-${loop.status}`}>{loop.status === 'running' ? 'Recorded running' : label(loop.status)}</span></div>
      {loop.stale && <p className="notice">Records are stale or unavailable. Worker activity is not confirmed.</p>}
      <p><strong>{loop.completedPhases.length}</strong> phases accepted · <strong>{loop.stages.filter((stage) => stage.kind === 'repair').length}</strong> repair attempts recorded</p>
      {loop.currentStage && <p>Current recorded step: <strong>{loop.currentStage.phaseId} / {label(loop.currentStage.kind)}</strong> · round {loop.currentStage.round}</p>}
      {loop.reason && <p className="notice">{loop.reason}</p>}
      <p className="quiet">Last record: {loop.updatedAt ? new Date(loop.updatedAt).toLocaleString() : 'Not available'}</p>
      <details><summary>Phase and review history</summary>
        <p>Accepted phases: {loop.completedPhases.length ? loop.completedPhases.join(', ') : 'None yet'}</p>
        {loop.stages.length === 0 ? <p className="quiet">No completed steps recorded.</p> : <ol className="loop-history">{loop.stages.map((stage, index) => <li key={`${stage.phaseId}-${stage.kind}-${stage.round}-${index}`}><strong>{stage.phaseId} / {label(stage.kind)}</strong><span>Round {stage.round} · Execution: {label(stage.outcome)}</span>{stage.decision && <span>Decision: {label(stage.decision)}</span>}{stage.verification && <span>Verification: {stage.verification}</span>}<time>{new Date(stage.completedAt).toLocaleString()}</time></li>)}</ol>}
      </details>
    </article>)}</div>
  </section>;
}
