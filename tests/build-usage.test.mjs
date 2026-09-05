import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const usage = join(root, 'scripts', 'build-usage.mjs');

async function fixture(records) {
  const dir = await mkdtemp(join(tmpdir(), 'faktori-usage-'));
  const input = join(dir, 'usage.jsonl');
  const output = join(dir, 'summary.json');
  await writeFile(input, records.map((record) => JSON.stringify(record)).join('\n'));
  return { dir, input, output };
}

async function run(input, output, estimate = 1_000) {
  const result = await import('node:child_process').then(({ spawnSync }) =>
    spawnSync(process.execPath, [usage, 'summarize', '--input', input, '--output', output, '--estimate', String(estimate)], { encoding: 'utf8' }),
  );
  return result;
}

test('deduplicates repeated cumulative snapshots but retains changed sessions', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'implementer', sessionId: 'a', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { input: 10, output: 5, total: 15 }, cumulative: true },
    { phase: 0, ticket: 'F0-02', agentId: 'implementer', sessionId: 'a', at: '2026-09-04T00:00:10Z', source: 'goal', counters: { input: 10, output: 5, total: 15 }, cumulative: true },
    { phase: 0, ticket: 'F0-02', agentId: 'implementer', sessionId: 'a', at: '2026-09-04T00:00:20Z', source: 'goal', counters: { input: 14, output: 8, total: 22 }, cumulative: true },
    { phase: 0, ticket: 'F0-02', agentId: 'specialist', sessionId: 'b', at: '2026-09-04T00:00:20Z', source: 'goal', counters: { input: 3, output: 2, total: 5 }, cumulative: true },
  ]);
  const result = await run(input, output);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.actual.total, 27);
  assert.equal(summary.records.accepted, 3);
  assert.equal(summary.records.duplicates, 1);
});

test('filters records to the requested phase before aggregation', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'phase-zero', sessionId: 'a', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 20 }, cumulative: true },
    { phase: 1, ticket: 'F1-01', agentId: 'phase-one', sessionId: 'b', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 80 }, cumulative: true },
  ]);
  const result = await import('node:child_process').then(({ spawnSync }) =>
    spawnSync(process.execPath, [usage, 'summarize', '--input', input, '--output', output, '--estimate', '100', '--phase', '0'], { encoding: 'utf8' }),
  );
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.actual.total, 20);
  assert.equal(summary.records.accepted, 1);
});

test('does not relabel a cross-phase cumulative total with unknown phase attribution', async () => {
  const { input, output } = await fixture([
    { phase: 1, ticket: 'F1-01', agentId: 'persistent-manager', sessionId: 'manager', at: '2026-09-04T00:00:00Z', source: 'goal', cumulative: true, phaseAttribution: 'unknown', counters: { total: 500 } },
  ]);
  const result = await import('node:child_process').then(({ spawnSync }) =>
    spawnSync(process.execPath, [usage, 'summarize', '--input', input, '--output', output, '--estimate', '1000', '--phase', '1'], { encoding: 'utf8' }),
  );
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.actual.total, null);
  assert.deepEqual(summary.unknown, [{ ticket: 'F1-01', reason: 'phase-attribution:unknown' }]);
});

test('does not double-count children already included in a parent total', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'parent', sessionId: 'p', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 100 }, cumulative: true, includesChildren: true },
    { phase: 0, ticket: 'F0-02', agentId: 'child', parentAgentId: 'parent', sessionId: 'c', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 40 }, cumulative: true },
  ]);
  const result = await run(input, output);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.actual.total, 100);
  assert.equal(summary.actual.excludedChildCount, 1);
});

test('refuses to sum a child with a parent whose inclusion scope is unknown', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'parent', sessionId: 'p', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 100 }, cumulative: true, childScope: 'unknown' },
    { phase: 0, ticket: 'F0-02', agentId: 'child', parentAgentId: 'parent', sessionId: 'c', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 40 }, cumulative: true },
  ]);
  const result = await run(input, output);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.actual.total, 100);
  assert.equal(summary.actual.kind, 'overlap-safe-lower-bound');
  assert.deepEqual(summary.unknown, [{ ticket: 'F0-02', reason: 'parent-child-overlap:unknown' }]);
});

test('excludes every measured descendant of an inclusive parent, not only direct children', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'grandparent', sessionId: 'g', at: '2026-09-04T00:00:00Z', source: 'goal', childScope: 'inclusive', counters: { total: 100 }, cumulative: true },
    { phase: 0, ticket: 'F0-02', agentId: 'parent', parentAgentId: 'grandparent', sessionId: 'p', at: '2026-09-04T00:00:00Z', source: 'goal', childScope: 'exclusive', counters: { total: 40 }, cumulative: true },
    { phase: 0, ticket: 'F0-02', agentId: 'child', parentAgentId: 'parent', sessionId: 'c', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 25 }, cumulative: true },
  ]);
  const result = await run(input, output);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.actual.total, 100);
  assert.equal(summary.actual.excludedChildCount, 2);
});

test('retains child measurements when an inclusive parent has no measured total', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'parent', sessionId: 'p', at: '2026-09-04T00:00:00Z', source: 'goal', childScope: 'inclusive', counters: { input: 8 }, cumulative: true },
    { phase: 0, ticket: 'F0-02', agentId: 'child', parentAgentId: 'parent', sessionId: 'c', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 40 }, cumulative: true },
  ]);
  const result = await run(input, output);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.actual.total, 40);
  assert.equal(summary.actual.excludedChildCount, 0);
});

test('uses the highest compatible total as a lower bound for unknown cross-session coverage', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'manager', sessionId: 'manager', at: '2026-09-04T00:06:55Z', source: 'goal', coverageScope: 'unknown', coverageGroup: 'phase-0-construction', counters: { total: 78_528 }, cumulative: true },
    { phase: 0, ticket: 'F0-02', agentId: 'implementer', sessionId: 'implementer', at: '2026-09-04T00:10:03Z', source: 'goal', coverageScope: 'unknown', coverageGroup: 'phase-0-construction', counters: { total: 407_976 }, cumulative: true },
  ]);
  const result = await run(input, output, 160_000);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.actual.total, 407_976);
  assert.equal(summary.actual.kind, 'overlap-safe-lower-bound');
  assert.deepEqual(summary.coverageGaps, [{ group: 'phase-0-construction', retainedTotal: 407_976, excludedMeasurements: 1 }]);
  assert.deepEqual(summary.unknown, [{ ticket: 'F0-02', reason: 'coverage-overlap:unknown' }]);
});

test('accounts categories without treating cached or reasoning subsets as extra tokens', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'a', sessionId: 'a', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { input: 60, output: 40, cached: 20, reasoning: 10, total: 100 }, cumulative: true },
  ]);
  const result = await run(input, output);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(summary.actual, { input: 60, output: 40, cached: 20, reasoning: 10, total: 100, excludedChildCount: 0 });
});

test('makes absent telemetry explicitly unknown and keeps estimates distinct', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'a', sessionId: 'a', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { input: 5, total: 5 }, cumulative: true },
    { phase: 0, ticket: 'F0-03', agentId: 'b', sessionId: 'b', at: '2026-09-04T00:00:00Z', source: 'goal', telemetry: 'unknown', estimate: { tokens: 50 } },
  ]);
  const result = await run(input, output);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.actual.total, 5);
  assert.equal(summary.estimated.total, 50);
  assert.deepEqual(summary.unknown, [{ ticket: 'F0-03', reason: 'telemetry:unknown' }]);
});

test('preserves a measured zero total and represents absent categories as unknown', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'a', sessionId: 'a', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 0 }, cumulative: true },
  ]);
  const result = await run(input, output);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.actual.total, 0);
  assert.equal(summary.actual.input, null);
  assert.equal(summary.actual.output, null);
  assert.equal(summary.actual.cached, null);
  assert.equal(summary.actual.reasoning, null);
  assert.deepEqual(summary.unknown, []);
});

test('emits each threshold notice accurately once at 70, 90, and 100 percent', async () => {
  const { input, output } = await fixture([
    { phase: 0, ticket: 'F0-02', agentId: 'a', sessionId: 'a', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 100 }, cumulative: true },
  ]);
  const result = await run(input, output, 100);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(summary.notices.map(({ threshold }) => threshold), [70, 90, 100]);
  assert.equal(summary.budget.percentUsed, 100);
});

test('watch remains alive after its first local summary refresh', async () => {
  const { input, output } = await fixture([{ phase: 0, ticket: 'F0-02', agentId: 'a', sessionId: 'a', at: '2026-09-04T00:00:00Z', source: 'goal', counters: { total: 1 }, cumulative: true }]);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [usage, 'watch', '--input', input, '--output', output, '--estimate', '10'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(child.exitCode, null);
  child.kill();
});
