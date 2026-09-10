import { createHash } from 'node:crypto';
import type { DurableCoordinator } from '../runtime/coordinator.ts';
import type { ManagerConnectedSnapshot } from '../manager-connected/index.ts';
import type { ManagerLoopEfficiencySnapshot, ManagerLoopSummary } from '../console/manager-loop-observer.ts';
import { CoordinatorGMStore, coordinatorGMState } from './coordinator-store.ts';
import type { GMFinding, GMFindingCategory } from './index.ts';
import { summarizeFactoryEfficiency, type FactoryEfficiencyMetrics } from './metrics.ts';

export interface DeterministicFactoryObservation {
  findings: GMFinding[];
  metrics: FactoryEfficiencyMetrics;
}

function stableId(key: string): string { return `finding-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`; }
function finding(factoryId: string, category: GMFindingCategory, subject: string, at: string, detail: Omit<GMFinding, 'format' | 'findingId' | 'findingKey' | 'factoryId' | 'category' | 'occurrenceCount' | 'openedAt' | 'updatedAt' | 'ownerAttention' | 'diagnosis' | 'recommendations' | 'rejectedRecommendations' | 'maintenance'>): GMFinding {
  const key = `${factoryId}:${category}:${subject}`;
  return { format: 'faktori.gm-finding/v1', findingId: stableId(key), findingKey: key, factoryId, category, occurrenceCount: 1, openedAt: at, updatedAt: at, ownerAttention: 'owner_once', diagnosis: { state: 'not_needed' }, recommendations: [], rejectedRecommendations: [], maintenance: [], status: 'active', ...detail };
}
function gate(loop: ManagerLoopSummary, id: string): ManagerLoopSummary['delivery'] extends infer _ ? { status?: string; observedAt?: string; evidenceUrl?: string } | undefined : never { return loop.delivery?.gates.find((item) => item.id === id); }

/** Creates only evidence-backed concerns; absence of timestamps or telemetry remains explicit rather than synthesized. */
export function observeFactoryDeterministically(input: {
  factoryId: string;
  coordinator: DurableCoordinator;
  loops: ManagerLoopEfficiencySnapshot;
  managerConnected?: ManagerConnectedSnapshot;
  deliveryDeadlineHours?: number;
  coordinationAttentionShare?: number;
  now?: Date;
  excludedWorkItemIds?: ReadonlySet<string>;
}): DeterministicFactoryObservation {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const observedResponses = new Set(input.loops.records.flatMap((record) => {
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
    const responseId = typeof record.responseId === 'string' ? record.responseId : typeof record.responseIdentity === 'string' ? record.responseIdentity : undefined;
    return sessionId && responseId ? [`${sessionId}\u0000${responseId}`] : [];
  }));
  const usageObservedAt = new Map(input.coordinator.journal?.events().filter((event) => event.kind === 'usage.observed').map((event) => [event.runId, event.occurredAt]) ?? []);
  const coordinatorRecords: Record<string, unknown>[] = [];
  const gmReviewRecords: Record<string, unknown>[] = [];
  for (const snapshot of input.coordinator.snapshots()) {
    const result = snapshot.providerResult;
    if (!result) continue;
    const sessionId = result.sessionId ?? snapshot.intent.runId;
    const telemetry = result.usage;
    const counters = telemetry.availability === 'unavailable' ? undefined : {
      ...(telemetry.inputTokens === undefined ? {} : { input: telemetry.inputTokens }),
      ...(telemetry.cachedInputTokens === undefined ? {} : { cached: telemetry.cachedInputTokens }),
      ...(telemetry.outputTokens === undefined ? {} : { output: telemetry.outputTokens }),
      ...(telemetry.reasoningTokens === undefined ? {} : { reasoning: telemetry.reasoningTokens }),
      ...(telemetry.inputTokens === undefined || telemetry.outputTokens === undefined ? {} : { total: telemetry.inputTokens + telemetry.outputTokens }),
    };
    const record = { ticket: snapshot.intent.workItem.id, source: 'coordinator', agentId: `coordinator:${snapshot.intent.runId}`, sessionId, registeredSessionId: `coordinator:${sessionId}:${snapshot.intent.runId}`, cumulative: false, coverageScope: 'exclusive', responseId: snapshot.intent.runId, ...(usageObservedAt.has(snapshot.intent.runId) ? { at: usageObservedAt.get(snapshot.intent.runId) } : {}), ...(counters === undefined ? { telemetry: 'unknown' } : { counters }), references: { shared: true }, attemptOutcome: result.outcome, workClass: 'coordination' };
    if (input.excludedWorkItemIds?.has(snapshot.intent.workItem.id)) gmReviewRecords.push(record);
    else if (!observedResponses.has(`${sessionId}\u0000${snapshot.intent.runId}`)) coordinatorRecords.push(record);
  }
  const metrics = summarizeFactoryEfficiency(input.loops, coordinatorRecords, gmReviewRecords);
  const findings: GMFinding[] = [];
  const failures = new Map<string, { count: number; work: Set<string>; evidence: string[] }>();
  for (const snapshot of input.coordinator.snapshots()) {
    if (input.excludedWorkItemIds?.has(snapshot.intent.workItem.id)) continue;
    const outcome = snapshot.providerResult?.outcome;
    if (!['authentication_required', 'quota_exhausted', 'unavailable', 'failed', 'interrupted_uncertain'].includes(String(outcome))) continue;
    const subject = `${snapshot.intent.execution.providerId}:${outcome}`;
    const group = failures.get(subject) ?? { count: 0, work: new Set<string>(), evidence: [] };
    group.count += 1; group.work.add(snapshot.intent.workItem.id); group.evidence.push(`run:${snapshot.intent.runId}:${outcome}`); failures.set(subject, group);
  }
  for (const [subject, group] of failures) if (group.count >= 2) findings.push(finding(input.factoryId, 'environment_failure', subject, at, {
    classification: 'infrastructure', latestSummary: `${group.count} provider attempts share the ${subject.split(':').at(-1)} outcome.`, evidence: group.evidence.slice(0, 12), affectedWork: [...group.work], accountableRole: 'factory_operator', nextAction: { label: 'Verify the configured provider route and prerequisite, then explicitly retry affected work.', control: 'open_factory' },
  }));
  for (const loop of input.loops.summaries) {
    const unchanged = loop.stages.filter((stage) => stage.outcome === 'unchanged_verified').length;
    if (unchanged >= 2) findings.push(finding(input.factoryId, 'unchanged_candidate_repetition', loop.id, at, {
      classification: 'delivery', latestSummary: `${loop.id} recorded ${unchanged} unchanged-candidate attempts.`, evidence: loop.stages.filter((stage) => stage.outcome === 'unchanged_verified').map((stage) => `${stage.phaseId}:${stage.kind}:${stage.completedAt}`), affectedWork: [loop.id], accountableRole: 'implementation_owner', nextAction: { label: 'Confirm that the candidate or requirements materially changed before another attempt.', control: 'open_work' },
    }));
    if ((loop.usage?.unknownMeasurements ?? 0) > 0 || loop.status === 'unavailable') findings.push(finding(input.factoryId, 'missing_telemetry', loop.id, at, {
      classification: 'infrastructure', latestSummary: `${loop.id} has ${loop.status === 'unavailable' ? 'an unavailable observation source' : `${loop.usage?.unknownMeasurements} registered measurement(s) without usable token telemetry`}.`, evidence: [loop.reason ? `observer:${loop.reason}` : `loop:${loop.id}:usage-unavailable`], affectedWork: [loop.id], accountableRole: 'factory_operator', nextAction: { label: 'Repair the registered observation or usage export; do not infer missing usage.', control: 'open_factory' },
    }));
    if (loop.reason === 'lean_preflight_failed' || loop.reason?.startsWith('lean_preflight_failed:')) {
      const checks = loop.preflight?.failedChecks ?? [];
      findings.push(finding(input.factoryId, 'environment_failure', `preflight:${loop.id}`, at, {
        classification: 'infrastructure', latestSummary: checks.length ? `${loop.id} launch is suppressed by failed prerequisite checks: ${checks.map((check) => check.id).join(', ')}.` : `${loop.id} launch is blocked by a recorded deterministic preflight failure; check details are unavailable.`, evidence: checks.length ? checks.map((check) => `preflight:${check.id}:${check.detail}`) : [`loop:${loop.id}:preflight-record`], affectedWork: [loop.id], accountableRole: 'factory_operator', nextAction: { label: 'Open Factory and satisfy the recorded prerequisite before an explicit retry.', control: 'open_factory' },
      }));
    }
    if (input.deliveryDeadlineHours !== undefined && loop.localAcceptedAt && gate(loop, 'staging_verification')?.status !== 'passed') {
      const accepted = Date.parse(loop.localAcceptedAt);
      if (Number.isFinite(accepted) && now.getTime() - accepted >= input.deliveryDeadlineHours * 3_600_000) findings.push(finding(input.factoryId, 'overdue_delivery', loop.id, at, {
        classification: 'delivery', latestSummary: `${loop.id} remains short of product acceptance beyond the configured ${input.deliveryDeadlineHours}-hour delivery deadline.`, evidence: [`local-acceptance:${loop.localAcceptedAt}`, gate(loop, 'deployment')?.evidenceUrl ?? 'deployment:evidence-unavailable'], affectedWork: [loop.id], accountableRole: loop.delivery?.nextAction.role ?? 'delivery_owner', nextAction: { label: loop.delivery?.nextAction.label ?? 'Complete the next recorded delivery gate.', ...(loop.delivery?.nextAction.url ? { url: loop.delivery.nextAction.url } : {}), control: 'open_work' },
      }));
    }
  }
  const uncertain = input.managerConnected?.requests.filter((request) => request.status === 'uncertain') ?? [];
  if (uncertain.length) findings.push(finding(input.factoryId, 'manager_delivery_uncertain', 'manager-connected', at, {
    classification: 'infrastructure', latestSummary: `${uncertain.length} Manager-connected request(s) require explicit reconciliation.`, evidence: uncertain.map((request) => `manager-request:${request.id}:uncertain`), affectedWork: uncertain.map((request) => request.id), accountableRole: 'manager', nextAction: { label: 'Reconcile each uncertain request; do not dispatch a duplicate.', control: 'open_work' },
  }));
  const threshold = input.coordinationAttentionShare ?? 0.3;
  if (metrics.shares.coordination !== null && metrics.shares.coordination > threshold) findings.push(finding(input.factoryId, 'coordination_overhead', 'factory', at, {
    classification: 'delivery', latestSummary: `Measured coordination share is ${(metrics.shares.coordination * 100).toFixed(1)}%, above the configured ${(threshold * 100).toFixed(1)}% attention threshold.`, evidence: [`cohort:${metrics.cohort.recordCount}-records`, `coordination-share:${metrics.shares.coordination}`], affectedWork: [], accountableRole: 'factory_owner', nextAction: { label: 'Review packet size and handoff count before changing policy.', control: 'open_factory' },
  }));
  return { findings, metrics };
}

/** Persists active/resolved transitions without model judgment. */
export async function persistDeterministicFindings(coordinator: DurableCoordinator, observation: DeterministicFactoryObservation, now = new Date()): Promise<GMFinding[]> {
  const store = new CoordinatorGMStore(coordinator);
  const prior = coordinatorGMState(coordinator).findings;
  const activeKeys = new Set(observation.findings.map((item) => item.findingKey));
  for (const current of observation.findings) {
    const existing = prior.find((item) => item.findingKey === current.findingKey);
    if (existing && existing.status === 'active' && existing.latestSummary === current.latestSummary && JSON.stringify(existing.evidence) === JSON.stringify(current.evidence)) continue;
    await store.upsertFinding(existing ? { ...current, findingId: existing.findingId, openedAt: existing.openedAt, occurrenceCount: existing.occurrenceCount + 1, ownerAlertedAt: existing.ownerAlertedAt ?? current.updatedAt } : { ...current, ownerAlertedAt: current.updatedAt });
  }
  for (const existing of prior.filter((item) => item.status === 'active' && item.classification && !activeKeys.has(item.findingKey))) await store.upsertFinding({ ...existing, status: 'resolved', updatedAt: now.toISOString(), ownerAttention: 'none' });
  return coordinatorGMState(coordinator).findings;
}
