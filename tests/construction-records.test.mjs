import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const root = new URL('..', import.meta.url);

async function json(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

test('canonical construction state contains exactly F0-01 through F7-04 with valid dependencies', async () => {
  const checklist = await json('construction/checklist.json');
  const expected = Array.from({ length: 8 }, (_, phase) =>
    Array.from({ length: 4 }, (_, offset) => `F${phase}-${String(offset + 1).padStart(2, '0')}`),
  ).flat();
  const ids = checklist.tickets.map(({ id }) => id);
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, 32);
  const known = new Set(ids);
  for (const ticket of checklist.tickets) {
    assert.match(ticket.title, /\S/);
    assert.ok(Array.isArray(ticket.dependencies));
    assert.ok(ticket.dependencies.every((dependency) => known.has(dependency)), `${ticket.id} has an unknown dependency`);
  }
  assert.ok(checklist.history.every((event) => known.has(event.ticketId)));
});

test('phase estimate revisions preserve history and each allocation sums to its estimate', async () => {
  const estimates = await json('construction/phase-estimates.json');
  const phase = estimates.phases.find(({ phase }) => phase === 0);
  assert.equal(phase.currentRevision, 2);
  assert.deepEqual(phase.revisions.map(({ estimateTokens }) => estimateTokens), [160_000, 360_000]);
  for (const revision of phase.revisions) {
    const allocation = Object.values(revision.allocations).reduce((total, value) => total + value, 0);
    assert.equal(allocation, revision.estimateTokens);
  }
  assert.equal(phase.estimateTokens, phase.revisions.at(-1).estimateTokens);
  assert.equal(phase.hardCeiling, false);
});

test('public summary and dashboard expose sanitized overlap-safe usage without native identities', async () => {
  const summary = await json('construction/phase-summary.json');
  const dashboard = await readFile(new URL('construction/dashboard.html', root), 'utf8');
  assert.equal(summary.actual.kind, 'overlap-safe-lower-bound');
  assert.equal(summary.budget.estimate, 360_000);
  assert.equal(summary.coverageGaps[0].group, 'phase-0-construction');
  assert.doesNotMatch(JSON.stringify(summary), /sessionId|agentId|\/Users\//);
  for (let phase = 0; phase < 8; phase += 1) {
    for (let offset = 1; offset <= 4; offset += 1) {
      assert.match(dashboard, new RegExp(`F${phase}-${String(offset).padStart(2, '0')}`));
    }
  }
  assert.match(dashboard, /Completion history/);
  assert.match(dashboard, /Token consumption chart/);
  assert.doesNotMatch(dashboard, /\/Users\//);
});
