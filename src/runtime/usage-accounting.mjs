/**
 * Shared, conservative normalization for provider-reported usage. It is used
 * by the local construction utility and by the Console observer; neither
 * caller interprets account allowances, pricing, or missing telemetry.
 */
function number(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function identity(record) {
  return `${record.source ?? 'unknown'}\u0000${record.agentId ?? 'unknown'}\u0000${record.sessionId ?? record.agentId ?? 'unknown'}`;
}

function fingerprint(record) {
  const counters = record.counters ?? {};
  return ['input', 'output', 'cached', 'reasoning', 'total'].map((key) => counters[key] ?? '').join('|');
}

function responseIdentity(record) {
  return typeof record.responseId === 'string' && record.responseId.length > 0 ? record.responseId
    : typeof record.responseIdentity === 'string' && record.responseIdentity.length > 0 ? record.responseIdentity
      : undefined;
}

function recordTime(record) {
  const parsed = Date.parse(record.at ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function latestSnapshots(records) {
  const seen = new Set();
  const latest = new Map();
  const additive = [];
  const responses = new Set();
  let duplicates = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const response = responseIdentity(record);
    if (response !== undefined) {
      // Providers often number responses from 1 for every session. Response
      // identity is meaningful only within its source and session/agent scope.
      const key = `${identity(record)}\u0000${response}`;
      if (responses.has(key)) { duplicates += 1; continue; }
      responses.add(key);
    }
    if (record.cumulative !== true) { additive.push(record); continue; }
    const key = `${identity(record)}\u0000${fingerprint(record)}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    const id = identity(record);
    const prior = latest.get(id);
    if (!prior || recordTime(record) >= recordTime(prior)) latest.set(id, record);
  }
  return { records: [...latest.values(), ...additive], duplicates, accepted: seen.size + additive.length };
}

function counters(records) {
  const result = { input: null, uncachedInput: null, output: null, cached: null, reasoning: null, total: null };
  let sawInput = false;
  let completeInputPartition = true;
  let uncachedInput = 0;
  for (const record of records) {
    const values = record.counters ?? {};
    for (const field of ['input', 'output', 'cached', 'reasoning', 'total']) {
      const measured = number(values[field]);
      if (measured !== undefined) result[field] = (result[field] ?? 0) + measured;
    }
    const input = number(values.input);
    if (input !== undefined) {
      sawInput = true;
      const cached = number(values.cached);
      if (cached === undefined || cached > input) completeInputPartition = false;
      else uncachedInput += input - cached;
    }
  }
  // Cached input is a subset of input. Preserve unknown if any contributing
  // observation omitted its cached counter; aggregate subtraction would invent
  // an uncached partition from mixed-coverage observations.
  if (sawInput && completeInputPartition) result.uncachedInput = uncachedInput;
  return result;
}

function parentInclusive(records) {
  const parents = new Map(records.filter((record) => record.agentId).map((record) => [record.agentId, record]));
  const excluded = new Set();
  const overlapUnknown = [];
  const included = records.filter((record) => {
    const seen = new Set();
    let parent = parents.get(record.parentAgentId);
    while (parent && !seen.has(parent.agentId)) {
      seen.add(parent.agentId);
      const scope = parent.childScope ?? (parent.includesChildren === true ? 'inclusive' : 'exclusive');
      const totalMeasured = number(parent.counters?.total) !== undefined;
      if (totalMeasured && scope === 'inclusive') { excluded.add(record.agentId); return false; }
      if (totalMeasured && scope === 'unknown') { excluded.add(record.agentId); overlapUnknown.push(record); return false; }
      parent = parents.get(parent.parentAgentId);
    }
    return true;
  });
  return { included, excludedCount: excluded.size, overlapUnknown };
}

function unknown(records) {
  return records.filter((record) => record.telemetry === 'unknown' || number(record.counters?.total) === undefined).map((record) => ({
    ticket: record.ticket ?? 'unknown', reason: record.telemetry === 'unknown' ? 'telemetry:unknown' : 'telemetry:missing-total',
  }));
}

function models(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!record.model) continue;
    const key = `${record.model}\u0000${record.reasoning ?? 'unknown'}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  return [...grouped].map(([key, recordCount]) => {
    const [model, reasoning] = key.split('\u0000');
    return { model, reasoning, recordCount };
  });
}

function overlapSafe(records) {
  const groups = new Map();
  const compatible = [];
  for (const record of records) {
    if (record.coverageScope !== 'unknown' || number(record.counters?.total) === undefined) { compatible.push(record); continue; }
    const group = record.coverageGroup ?? `phase:${record.phase ?? 'unknown'}`;
    const values = groups.get(group) ?? [];
    values.push(record); groups.set(group, values);
  }
  const excluded = [];
  const coverageGaps = [];
  for (const [group, recordsInGroup] of groups) {
    recordsInGroup.sort((left, right) => number(right.counters?.total) - number(left.counters?.total));
    compatible.push(recordsInGroup[0]);
    if (recordsInGroup.length > 1) {
      const omitted = recordsInGroup.slice(1);
      excluded.push(...omitted);
      coverageGaps.push({ group, retainedTotal: number(recordsInGroup[0].counters?.total), excludedMeasurements: omitted.length });
    }
  }
  return { records: compatible, excluded, coverageGaps };
}

/** Return the same sanitized lower-bound summary used by build-usage.mjs. */
export function summarizeUsage(records, estimate, requestedPhase) {
  const phaseRecords = requestedPhase === undefined ? records : records.filter((record) => record?.phase === requestedPhase);
  const unattributable = phaseRecords.filter((record) => record?.cumulative === true && record.phaseAttribution === 'unknown');
  const normalized = latestSnapshots(phaseRecords.filter((record) => !unattributable.includes(record)));
  const hierarchy = parentInclusive(normalized.records);
  const coverage = overlapSafe(hierarchy.included);
  const incompleteCoverage = coverage.coverageGaps.length > 0 || hierarchy.overlapUnknown.length > 0;
  const actual = { ...counters(coverage.records), excludedChildCount: hierarchy.excludedCount, ...(incompleteCoverage ? { kind: 'overlap-safe-lower-bound' } : {}) };
  const estimates = coverage.records.map((record) => number(record.estimate?.tokens)).filter((value) => value !== undefined);
  const estimated = { total: estimates.length === 0 ? null : estimates.reduce((total, value) => total + value, 0) };
  const budget = number(estimate) ?? 0;
  const percentUsed = budget === 0 || actual.total === null ? null : Math.round((actual.total / budget) * 10000) / 100;
  const thresholds = [70, 90, 100];
  return {
    schemaVersion: 1,
    phase: requestedPhase ?? normalized.records[0]?.phase ?? null,
    generatedAt: new Date().toISOString(),
    actual,
    estimated,
    models: models(coverage.records),
    unknown: [...unknown(normalized.records), ...unattributable.map((record) => ({ ticket: record.ticket ?? 'unknown', reason: 'phase-attribution:unknown' })), ...hierarchy.overlapUnknown.map((record) => ({ ticket: record.ticket ?? 'unknown', reason: 'parent-child-overlap:unknown' })), ...coverage.excluded.map((record) => ({ ticket: record.ticket ?? 'unknown', reason: 'coverage-overlap:unknown' }))],
    coverageGaps: coverage.coverageGaps,
    records: { accepted: normalized.accepted, duplicates: normalized.duplicates },
    budget: { estimate: budget, remaining: budget === 0 || actual.total === null ? null : Math.max(0, budget - actual.total), percentUsed },
    notices: budget === 0 || actual.total === null ? [] : thresholds.filter((threshold) => actual.total >= (budget * threshold) / 100).map((threshold) => ({ threshold, type: 'budget-threshold' })),
  };
}

function reference(record, name) {
  const value = record.references?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cohort(records, predicate) {
  const selected = records.filter(predicate);
  const summary = summarizeUsage(selected, 0);
  return { recordCount: selected.length, usage: summary.actual, unknown: summary.unknown, coverageGaps: summary.coverageGaps };
}

/**
 * Outcome views intentionally overlap: PR and accepted-feature totals are
 * alternative denominators, never ingredients in a factory-wide total.
 */
export function summarizeOutcomeCohorts(records) {
  const registeredSessions = new Set(records.map((record) => record.registeredSessionId ?? `${record.source ?? 'unknown'}\u0000${record.agentId ?? 'unknown'}\u0000${record.sessionId ?? 'unknown'}`));
  const usableSessions = new Set(records.filter((record) => record.telemetry !== 'unknown' && number(record.counters?.total) !== undefined)
    .map((record) => record.registeredSessionId ?? `${record.source ?? 'unknown'}\u0000${record.agentId ?? 'unknown'}\u0000${record.sessionId ?? 'unknown'}`));
  const mergedPullRequests = new Set(records.filter((record) => record.references?.pullRequestMerged === true).map((record) => reference(record, 'pullRequest')).filter(Boolean));
  // A merged marker selects a cohort. Earlier failed, repair, and review
  // observations sharing that PR are included; the marker itself is not a
  // separate usage event. The feature rule is intentionally stricter than a
  // deployment observation: only explicit product acceptance selects it.
  const acceptedFeatures = new Set(records.filter((record) => record.references?.deploymentAccepted === true).map((record) => reference(record, 'feature')).filter(Boolean));
  const merged = cohort(records, (record) => {
    const id = reference(record, 'pullRequest');
    return id !== undefined && mergedPullRequests.has(id);
  });
  const accepted = cohort(records, (record) => {
    const id = reference(record, 'feature');
    return id !== undefined && acceptedFeatures.has(id);
  });
  const failed = cohort(records, (record) => record.attemptOutcome === 'failed' || record.attemptOutcome === 'cancelled' || record.attemptOutcome === 'interrupted_uncertain');
  const shared = cohort(records, (record) => record.references?.shared === true);
  const unattributed = cohort(records, (record) => reference(record, 'ticket') === undefined && reference(record, 'feature') === undefined && reference(record, 'candidate') === undefined && reference(record, 'pullRequest') === undefined && record.references?.shared !== true);
  const workInProgress = cohort(records, (record) => record.attemptOutcome === 'running' || record.references?.workInProgress === true);
  const mergedTotal = merged.usage.total;
  const acceptedTotal = accepted.usage.total;
  return {
    mergedPullRequests: { count: mergedPullRequests.size, ...merged, tokensPerPullRequest: mergedTotal === null || mergedPullRequests.size === 0 ? null : mergedTotal / mergedPullRequests.size },
    deploymentAcceptedFeatures: { count: acceptedFeatures.size, ...accepted, tokensPerFeature: acceptedTotal === null || acceptedFeatures.size === 0 ? null : acceptedTotal / acceptedFeatures.size },
    failedAttempts: failed,
    sharedOverhead: shared,
    unattributed,
    workInProgress,
    coverage: { registeredSessions: registeredSessions.size, usableSessions: usableSessions.size, ratio: registeredSessions.size === 0 ? null : usableSessions.size / registeredSessions.size },
  };
}
