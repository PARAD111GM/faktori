import { summarizeOutcomeCohorts, summarizeUsage } from '../runtime/usage-accounting.mjs';
import type { ManagerLoopEfficiencySnapshot, ManagerLoopSummary } from '../console/manager-loop-observer.ts';

type UsageRecord = Record<string, unknown> & { counters?: Record<string, number>; workClass?: string; at?: string };

export interface FactoryEfficiencyMetrics {
  format: 'faktori.factory-efficiency/v1';
  cohort: { sourceCount: number; recordCount: number; earliestAt?: string; latestAt?: string };
  usage: ReturnType<typeof summarizeUsage>['actual'] & { unknownMeasurements: number };
  coverage: { registeredSessions: number; usableSessions: number; ratio: number | null };
  quota: { status: 'available' | 'exhausted' | 'unknown'; observedSources: number };
  outcomes: {
    localAccepted: number;
    mergedPullRequests: { count: number; tokensPerPullRequest: number | null };
    deployed: number;
    productAcceptedFeatures: { count: number; tokensPerFeature: number | null };
  };
  shares: { rework: number | null; coordination: number | null; basis: 'measured_attributed_tokens' };
  timing: {
    claimToVerifiedAcceptanceMinutes: { sampleSize: number; median: number | null };
    acceptedToDeploymentMinutes: { sampleSize: number; median: number | null; stillWaiting: number };
  };
  unfinishedOrAbandoned: { recordCount: number; tokens: number | null };
  overhead: { sharedTokens: number | null; unattributedTokens: number | null; gmReview: { attemptCount: number; tokens: number | null; unknownMeasurements: number } };
  quality: { humanInterventions: number | null; reopened: number | null; regressions: number | null };
  qualification: string[];
}

function time(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function total(records: UsageRecord[]): number | null {
  return summarizeUsage(records, 0).actual.total;
}

function gateAt(loop: ManagerLoopSummary, id: string): string | undefined {
  return loop.delivery?.gates.find((gate) => gate.id === id && gate.status === 'passed')?.observedAt;
}

/** One factory-wide pass. Per-loop ratios are never added and outcome identities are globally deduplicated. */
export function summarizeFactoryEfficiency(snapshot: ManagerLoopEfficiencySnapshot, additionalFactoryRecords: UsageRecord[] = [], gmReviewRecords: UsageRecord[] = []): FactoryEfficiencyMetrics {
  const sourceRecords = snapshot.records as UsageRecord[];
  const records = [...sourceRecords, ...additionalFactoryRecords];
  const usage = summarizeUsage(records, 0);
  const gmReviewUsage = summarizeUsage(gmReviewRecords, 0);
  const outcomes = summarizeOutcomeCohorts(records);
  const times = records.map((record) => time(record.at)).filter((value): value is number => value !== undefined && value > 0);
  const localAccepted = new Set(snapshot.summaries.filter((loop) => loop.status === 'succeeded').map((loop) => loop.id));
  const quota = snapshot.summaries.map((loop) => loop.preflight?.quota).filter((value): value is 'available' | 'exhausted' | 'unknown' => value !== undefined);
  const deployed = new Set(snapshot.summaries.filter((loop) => loop.delivery?.gates.some((gate) => gate.id === 'deployment' && gate.status === 'passed')).map((loop) => loop.id));
  const attributed = records.filter((record) => {
    const references = record.references && typeof record.references === 'object' ? record.references as Record<string, unknown> : undefined;
    return references?.shared !== true && ['ticket', 'feature', 'candidate', 'pullRequest'].some((key) => typeof references?.[key] === 'string');
  });
  const rework = attributed.filter((record) => record.workClass === 'rework' || ['failed', 'cancelled', 'interrupted_uncertain'].includes(String(record.attemptOutcome)));
  const coordination = attributed.filter((record) => record.workClass === 'coordination');
  const attributedTotal = total(attributed);
  const reworkTotal = total(rework);
  const coordinationTotal = total(coordination);
  const lead = snapshot.summaries.flatMap((loop) => {
    const claimed = time(loop.claimedAt), accepted = time(gateAt(loop, 'staging_verification'));
    return claimed === undefined || accepted === undefined || accepted < claimed ? [] : [(accepted - claimed) / 60_000];
  });
  const deploymentWait = snapshot.summaries.flatMap((loop) => {
    const accepted = time(loop.localAcceptedAt), deployedAt = time(gateAt(loop, 'deployment'));
    return accepted === undefined || deployedAt === undefined || deployedAt < accepted ? [] : [(deployedAt - accepted) / 60_000];
  });
  const stillWaiting = snapshot.summaries.filter((loop) => loop.localAcceptedAt !== undefined && gateAt(loop, 'deployment') === undefined).length;
  const unfinished = records.filter((record) => record.references && typeof record.references === 'object' && (record.references as Record<string, unknown>).workInProgress === true
    || ['failed', 'cancelled', 'interrupted_uncertain'].includes(String(record.attemptOutcome)));
  const qualification = [
    'PR and feature views overlap and are alternatives; they are not added.',
    outcomes.mergedPullRequests.count === 0 ? 'Tokens per merged PR unavailable: no distinct merged PR is observed.' : 'Merged-PR cost includes attributed failed, repair, and review attempts.',
    outcomes.deploymentAcceptedFeatures.count === 0 ? 'Tokens per product-accepted feature unavailable: no deployment-bound product acceptance is observed.' : 'Product-accepted feature cost includes all attributed attempts.',
    lead.length === 0 ? 'Claim-to-verified-acceptance median unavailable: no complete observed timestamp pair.' : 'Lead-time median uses only complete observed timestamp pairs.',
    'Human intervention, reopened work, and regressions are unknown unless explicitly recorded.',
  ];
  return {
    format: 'faktori.factory-efficiency/v1',
    cohort: { sourceCount: snapshot.summaries.length, recordCount: records.length, ...(times.length === 0 ? {} : { earliestAt: new Date(Math.min(...times)).toISOString(), latestAt: new Date(Math.max(...times)).toISOString() }) },
    usage: { ...usage.actual, unknownMeasurements: usage.unknown.length },
    coverage: outcomes.coverage,
    quota: { status: quota.includes('exhausted') ? 'exhausted' : quota.length > 0 && quota.every((value) => value === 'available') ? 'available' : 'unknown', observedSources: quota.length },
    outcomes: {
      localAccepted: localAccepted.size,
      mergedPullRequests: { count: outcomes.mergedPullRequests.count, tokensPerPullRequest: outcomes.mergedPullRequests.tokensPerPullRequest },
      deployed: deployed.size,
      productAcceptedFeatures: { count: outcomes.deploymentAcceptedFeatures.count, tokensPerFeature: outcomes.deploymentAcceptedFeatures.tokensPerFeature },
    },
    shares: {
      rework: attributedTotal === null || attributedTotal === 0 || reworkTotal === null ? null : reworkTotal / attributedTotal,
      coordination: attributedTotal === null || attributedTotal === 0 || coordinationTotal === null ? null : coordinationTotal / attributedTotal,
      basis: 'measured_attributed_tokens',
    },
    timing: {
      claimToVerifiedAcceptanceMinutes: { sampleSize: lead.length, median: median(lead) },
      acceptedToDeploymentMinutes: { sampleSize: deploymentWait.length, median: median(deploymentWait), stillWaiting },
    },
    unfinishedOrAbandoned: { recordCount: unfinished.length, tokens: total(unfinished) },
    overhead: { sharedTokens: outcomes.sharedOverhead.usage.total, unattributedTokens: outcomes.unattributed.usage.total, gmReview: { attemptCount: gmReviewRecords.length, tokens: gmReviewUsage.actual.total, unknownMeasurements: gmReviewUsage.unknown.length } },
    quality: { humanInterventions: null, reopened: null, regressions: null },
    qualification,
  };
}
