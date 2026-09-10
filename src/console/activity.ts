import type { RunEvent, RunSnapshot } from '../runtime/contracts.ts';
import type { ManagerLoopSummary } from './manager-loop-observer.ts';
import type { ManagerConnectedDecisionSnapshot, ManagerConnectedRequestSnapshot } from '../manager-connected/index.ts';

export interface ConsoleActivity {
  id: string;
  at: string;
  source: 'run' | 'loop' | 'jira' | 'request' | 'decision';
  summary: string;
  productId?: string;
  podId?: string;
  runId?: string;
  loopId?: string;
  requestId?: string;
  decisionId?: string;
  planId?: string;
  phaseId?: string;
  ticketId?: string;
  issueKey?: string;
  url?: string;
}

// Summarize trusted event kinds, never arbitrary event payloads or private logs.
const MILESTONES: Partial<Record<RunEvent['kind'], string>> = {
  'run.admitted': 'Work admitted to the execution queue',
  'worker.started': 'Agent execution started',
  'message.queued': 'Owner instruction queued for the next turn',
  'provider.requested': 'Agent requested an owner response',
  'provider.request.answered': 'Owner response recorded',
  'authority.revoked': 'Run authority revoked; publication is blocked',
  'worker.termination.intended': 'Worker shutdown requested',
  'worker.termination.observed': 'Worker shutdown observed',
  'effect.unresolved': 'External operation needs reconciliation',
  'recovery.required': 'Recovery needs attention',
  'recovery.resolved': 'Recovery requirement resolved',
};
const OUTCOMES = new Set(['completed', 'unchanged_verified', 'blocked', 'denied', 'authentication_required', 'quota_exhausted', 'failed', 'cancelled', 'interrupted_uncertain', 'unavailable']);
const DELEGATION: Record<string, string> = {
  'delegation.child-admitted': 'Specialist work admitted',
  'delegation.result-submitted': 'Specialist result submitted for integration',
  'delegation.blocked': 'Specialist admission blocked',
};
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function identifier(value: string): string | undefined { return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value) ? value : undefined; }

/** A bounded, rebuildable feed of recorded milestones, not a live thought stream. */
export function consoleActivity(events: readonly RunEvent[], runs: readonly RunSnapshot[], loops: readonly ManagerLoopSummary[], jira: readonly ConsoleActivity[] = [], requests: readonly ManagerConnectedRequestSnapshot[] = [], decisions: readonly ManagerConnectedDecisionSnapshot[] = []): ConsoleActivity[] {
  const snapshots = new Map(runs.map((run) => [run.intent.runId, run]));
  const entries: ConsoleActivity[] = [];
  for (const event of events) {
    const run = snapshots.get(event.runId);
    if (!run || !identifier(event.runId)) continue;
    let summary = MILESTONES[event.kind];
    if (event.kind === 'provider.final') {
      const outcome = record(event.data.result).outcome;
      summary = `Agent turn finished${typeof outcome === 'string' && OUTCOMES.has(outcome) ? `: ${outcome.replaceAll('_', ' ')}` : ''}; acceptance is evaluated separately`;
    }
    if (event.kind === 'provider.event' && typeof event.data.type === 'string') summary = DELEGATION[event.data.type];
    if (!summary) continue;
    const workId = identifier(run.intent.workItem.id);
    entries.push({ id: `run:${event.eventId}`, at: event.occurredAt, source: 'run', summary: `${workId ? `${workId}: ` : ''}${summary}`, runId: event.runId, productId: run.intent.target.productId, ...(run.intent.target.podId === undefined ? {} : { podId: run.intent.target.podId }) });
  }
  for (const loop of loops) {
    const scope = { loopId: loop.id, ...(loop.productId === undefined ? {} : { productId: loop.productId }), ...(loop.podId === undefined ? {} : { podId: loop.podId }) };
    for (const stage of loop.stages) {
      entries.push({ id: `loop:${loop.id}:${stage.phaseId}:${stage.kind}:${stage.round}:${stage.completedAt}`, at: stage.completedAt, source: 'loop', ...scope,
        summary: `${loop.id} · ${stage.phaseId}: ${stage.kind.replaceAll('_', ' ')} ${stage.outcome.replaceAll('_', ' ')}${stage.decision ? ` · decision: ${stage.decision}` : ''}${stage.verification ? ` · verification: ${stage.verification}` : ''} (round ${stage.round})` });
    }
    if (loop.updatedAt && loop.currentStage && loop.status === 'running') {
      entries.push({ id: `loop:${loop.id}:current:${loop.currentStage.phaseId}:${loop.currentStage.kind}:${loop.currentStage.round}`, at: loop.updatedAt, source: 'loop', ...scope,
        summary: `${loop.id} · ${loop.currentStage.phaseId}: ${loop.currentStage.kind.replaceAll('_', ' ')} recorded in progress${loop.stale ? ' — progress record is stale' : ''}` });
    } else if (loop.updatedAt && ['failed', 'blocked', 'interrupted_uncertain'].includes(loop.status)) {
      entries.push({ id: `loop:${loop.id}:status:${loop.updatedAt}`, at: loop.updatedAt, source: 'loop', ...scope, summary: `${loop.id}: ${loop.status.replaceAll('_', ' ')}${loop.reason ? ` · ${loop.reason.replaceAll('_', ' ')}` : ''}` });
    }
  }
  for (const request of requests) {
    const scope = request.scope;
    const details = { requestId: request.id, productId: scope?.productId ?? request.assignment.productId, ...(scope?.planId === undefined ? {} : { planId: scope.planId }), ...(scope?.phaseId === undefined ? {} : { phaseId: scope.phaseId }), ...(scope?.ticketId === undefined ? {} : { ticketId: scope.ticketId }) };
    const title = request.title === '[redacted]' ? 'Manager-connected request' : request.title;
    entries.push({ id: `request:${request.id}:queued`, at: request.createdAt, source: 'request', ...details, summary: `${title}: queued for Manager-mediated delivery` });
    if (request.claimedAt) entries.push({ id: `request:${request.id}:claimed`, at: request.claimedAt, source: 'request', ...details, summary: `${title}: Manager claim recorded` });
    if (request.submittedAt) entries.push({ id: `request:${request.id}:submitted`, at: request.submittedAt, source: 'request', ...details, summary: `${title}: submission to the assigned task recorded` });
    if (request.completedAt) entries.push({ id: `request:${request.id}:reported`, at: request.completedAt, source: 'request', ...details, summary: `${title}: Manager-reported result observed; acceptance not evaluated` });
    if (request.uncertainAt) entries.push({ id: `request:${request.id}:uncertain`, at: request.uncertainAt, source: 'request', ...details, summary: `${title}: delivery requires reconciliation` });
    if (request.cancelledAt) entries.push({ id: `request:${request.id}:cancelled`, at: request.cancelledAt, source: 'request', ...details, summary: `${title}: queued request cancelled` });
  }
  for (const decision of decisions) {
    const scope = { decisionId: decision.id, productId: decision.scope.productId, planId: decision.scope.planId, phaseId: decision.scope.phaseId, ...(decision.scope.ticketId === undefined ? {} : { ticketId: decision.scope.ticketId }) };
    entries.push({ id: `decision:${decision.id}:created`, at: decision.createdAt, source: 'decision', ...scope, summary: `Decision opened: ${decision.problem === '[redacted]' ? 'details redacted' : decision.problem}` });
    if (decision.ownerResponse) entries.push({ id: `decision:${decision.id}:response`, at: decision.ownerResponse.recordedAt, source: 'decision', ...scope, summary: 'Owner response recorded for Manager observation' });
    if (decision.managerAcknowledgedAt) entries.push({ id: `decision:${decision.id}:acknowledged`, at: decision.managerAcknowledgedAt, source: 'decision', ...scope, summary: 'Manager acknowledgement recorded' });
    if (decision.resolvedAt) entries.push({ id: `decision:${decision.id}:resolved`, at: decision.resolvedAt, source: 'decision', ...scope, summary: 'Decision resolved; this is not delivery or product acceptance' });
    if (decision.uncertainAt) entries.push({ id: `decision:${decision.id}:uncertain`, at: decision.uncertainAt, source: 'decision', ...scope, summary: 'Decision observation requires reconciliation' });
  }
  entries.push(...jira);
  const counts = new Map<string, number>();
  return [...new Map(entries.filter((entry) => Number.isFinite(Date.parse(entry.at))).map((entry) => [entry.id, entry])).values()]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || left.id.localeCompare(right.id))
    .filter((entry) => {
      // Preserve quiet products and source filters: one busy scope must not
      // erase every older milestone from another before the browser filters.
      const scope = JSON.stringify([entry.productId ?? null, entry.podId ?? null, entry.source]);
      const count = counts.get(scope) ?? 0;
      counts.set(scope, count + 1);
      return count < 100;
    });
}
