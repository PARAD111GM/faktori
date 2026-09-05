#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { args, fail, writeJson } from './lib/build-records.mjs';

const command = process.argv[2];
const options = args(process.argv.slice(3));
const defaultInput = '.build/usage/records.jsonl';
const defaultOutput = 'construction/phase-summary.json';

function number(value) {
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function identity(record) {
  return `${record.agentId ?? 'unknown'}\u0000${record.sessionId ?? record.agentId ?? 'unknown'}`;
}

function fingerprint(record) {
  const counters = record.counters ?? {};
  return ['input', 'output', 'cached', 'reasoning', 'total'].map((key) => counters[key] ?? '').join('|');
}

function recordTime(record) {
  const parsed = Date.parse(record.at ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function latestSnapshots(records) {
  const seen = new Set();
  const latest = new Map();
  const additive = [];
  let duplicates = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
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
  const result = { input: null, output: null, cached: null, reasoning: null, total: null };
  for (const record of records) {
    const values = record.counters ?? {};
    for (const field of Object.keys(result)) {
      const measured = number(values[field]);
      if (measured !== undefined) result[field] = (result[field] ?? 0) + measured;
    }
  }
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
      if (totalMeasured && scope === 'inclusive') {
        excluded.add(record.agentId);
        return false;
      }
      if (totalMeasured && scope === 'unknown') {
        excluded.add(record.agentId);
        overlapUnknown.push(record);
        return false;
      }
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
    if (record.coverageScope !== 'unknown' || number(record.counters?.total) === undefined) {
      compatible.push(record);
      continue;
    }
    const group = record.coverageGroup ?? `phase:${record.phase ?? 'unknown'}`;
    const values = groups.get(group) ?? [];
    values.push(record);
    groups.set(group, values);
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

export function summarize(records, estimate, requestedPhase) {
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

async function readRecords(path) {
  const contents = await readFile(path, 'utf8');
  return contents.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Invalid JSONL record at line ${index + 1}`); }
  });
}

async function emit() {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const records = await readRecords(input);
  const summary = summarize(records, Number(options.estimate), options.phase === undefined ? undefined : Number(options.phase));
  await writeJson(output, summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function watch() {
  await emit();
  const timer = setInterval(() => emit().catch((error) => process.stderr.write(`${error.message}\n`)), 10_000);
  await new Promise(() => {});
}

if (!['summarize', 'watch'].includes(command)) fail('Usage: build-usage.mjs <summarize|watch> [--input records.jsonl] [--output summary.json] --estimate tokens [--phase number]');
else (command === 'watch' ? watch() : emit()).catch((error) => fail(error.message));
