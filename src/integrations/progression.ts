export type EvidenceKind = 'review' | 'check';
export type EvidenceVerdict = 'passed' | 'failed' | 'pending' | 'waived';

export interface CommitEvidence {
  kind: EvidenceKind;
  commit: string;
  verdict: EvidenceVerdict;
  source: string;
  observedAt: string;
  /** A waiver is an owner decision, never a substitute for a passing observation. */
  waiverAuthority?: string;
}

export interface ProgressionDecision {
  commit: string;
  state: 'ready_for_human_merge' | 'waiting_for_review' | 'waiting_for_checks' | 'failed' | 'waived';
  review: EvidenceVerdict;
  checks: EvidenceVerdict;
  mergeAuthority: 'human';
  reasons: string[];
}

/**
 * Evaluates review and CI independently for one exact commit. Evidence for a
 * previous head is intentionally ignored rather than inherited on a rebase or
 * force-push. This records readiness; it never performs a merge.
 */
export function evaluateCommitProgression(commit: string, evidence: readonly CommitEvidence[]): ProgressionDecision {
  const exact = evidence.filter((item) => item.commit === commit);
  const review = aggregate(exact, 'review');
  const checks = aggregate(exact, 'check');
  const reviewVerdict = review?.verdict ?? 'pending';
  const checksVerdict = checks?.verdict ?? 'pending';
  const reasons: string[] = [];

  if (reviewVerdict === 'failed' || checksVerdict === 'failed') {
    if (reviewVerdict === 'failed') reasons.push('exact_commit_review_failed');
    if (checksVerdict === 'failed') reasons.push('exact_commit_checks_failed');
    return decision(commit, 'failed', reviewVerdict, checksVerdict, reasons);
  }
  if (reviewVerdict === 'waived' || checksVerdict === 'waived') {
    if (reviewVerdict === 'waived' && !validWaiver(review)) reasons.push('review_waiver_missing_authority');
    if (checksVerdict === 'waived' && !validWaiver(checks)) reasons.push('check_waiver_missing_authority');
    if (reasons.length > 0) return decision(commit, reviewVerdict === 'waived' ? 'waiting_for_review' : 'waiting_for_checks', reviewVerdict, checksVerdict, reasons);
    reasons.push('waived_evidence_requires_human_merge_decision');
    return decision(commit, 'waived', reviewVerdict, checksVerdict, reasons);
  }
  if (reviewVerdict !== 'passed') return decision(commit, 'waiting_for_review', reviewVerdict, checksVerdict, ['no_passing_review_for_exact_commit']);
  if (checksVerdict !== 'passed') return decision(commit, 'waiting_for_checks', reviewVerdict, checksVerdict, ['no_passing_checks_for_exact_commit']);
  return decision(commit, 'ready_for_human_merge', reviewVerdict, checksVerdict, ['exact_commit_review_and_checks_passed']);
}

function aggregate(evidence: readonly CommitEvidence[], kind: EvidenceKind): CommitEvidence | undefined {
  const observations = evidence.filter((item) => item.kind === kind);
  if (observations.length === 0) return undefined;
  const latestBySource = new Map<string, CommitEvidence>();
  for (const item of observations) {
    const prior = latestBySource.get(item.source);
    if (prior === undefined || prior.observedAt <= item.observedAt) latestBySource.set(item.source, item);
  }
  const values = [...latestBySource.values()];
  const selected = values.find((item) => item.verdict === 'failed')
    ?? values.find((item) => item.verdict === 'pending')
    ?? values.find((item) => item.verdict === 'waived')
    ?? values[0];
  return selected;
}

function validWaiver(value: CommitEvidence | undefined): boolean { return typeof value?.waiverAuthority === 'string' && value.waiverAuthority.trim().length > 0; }

function decision(commit: string, state: ProgressionDecision['state'], review: EvidenceVerdict, checks: EvidenceVerdict, reasons: string[]): ProgressionDecision {
  return { commit, state, review, checks, mergeAuthority: 'human', reasons };
}
