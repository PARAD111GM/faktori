import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const root = new URL('..', import.meta.url);

async function json(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

function assertCurrentPhaseConsistent(checklist, estimates, summary) {
  const phase = estimates.phases.find((candidate) => candidate.phase === checklist.project.currentPhase);
  assert.ok(phase, 'current phase must have a canonical estimate');
  assert.equal(phase.hardCeiling, false);
  assert.equal(summary.phase, checklist.project.currentPhase);
  assert.equal(summary.budget.estimate, phase.estimateTokens);
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
  const phaseZero = estimates.phases.find(({ phase }) => phase === 0);
  const phaseOne = estimates.phases.find(({ phase }) => phase === 1);
  const phaseTwo = estimates.phases.find(({ phase }) => phase === 2);
  const phaseThree = estimates.phases.find(({ phase }) => phase === 3);
  assert.equal(phaseZero.currentRevision, 2);
  assert.deepEqual(phaseZero.revisions.map(({ estimateTokens }) => estimateTokens), [160_000, 360_000]);
  assert.equal(phaseOne.currentRevision, 1);
  assert.equal(phaseOne.estimateTokens, 1_600_000);
  assert.equal(phaseOne.hardCeiling, false);
  assert.equal(phaseTwo.currentRevision, 2);
  assert.equal(phaseTwo.estimateTokens, 2_200_000);
  assert.equal(phaseTwo.hardCeiling, false);
  assert.equal(phaseThree.currentRevision, 1);
  assert.equal(phaseThree.estimateTokens, 2_400_000);
  assert.equal(phaseThree.hardCeiling, false);
  for (const phase of [phaseZero, phaseOne, phaseTwo, phaseThree]) {
    for (const revision of phase.revisions) {
      const allocation = Object.values(revision.allocations).reduce((total, value) => total + value, 0);
      assert.equal(allocation, revision.estimateTokens);
    }
    assert.equal(phase.estimateTokens, phase.revisions.at(-1).estimateTokens);
    assert.equal(phase.hardCeiling, false);
  }
});

test('public summary and dashboard expose current sanitized usage without native identities', async () => {
  const summary = await json('construction/phase-summary.json');
  const checklist = await json('construction/checklist.json');
  const estimates = await json('construction/phase-estimates.json');
  const dashboard = await readFile(new URL('construction/dashboard.html', root), 'utf8');
  assertCurrentPhaseConsistent(checklist, estimates, summary);
  assert.throws(() => assertCurrentPhaseConsistent(checklist, estimates, { ...summary, phase: summary.phase + 1 }));
  assert.throws(() => assertCurrentPhaseConsistent(checklist, estimates, { ...summary, budget: { ...summary.budget, estimate: summary.budget.estimate + 1 } }));
  const currentEstimate = estimates.phases.find(({ phase }) => phase === checklist.project.currentPhase);
  assert.throws(() => assertCurrentPhaseConsistent(checklist, { ...estimates, phases: estimates.phases.map((phase) => phase === currentEstimate ? { ...phase, hardCeiling: true } : phase) }, summary));
  assert.ok(summary.actual.total === null || summary.actual.total >= 0);
  assert.doesNotMatch(JSON.stringify(summary), /sessionId|agentId|\/Users\//);
  for (let phase = 0; phase < 8; phase += 1) {
    for (let offset = 1; offset <= 4; offset += 1) {
      assert.match(dashboard, new RegExp(`F${phase}-${String(offset).padStart(2, '0')}`));
    }
  }
  assert.match(dashboard, /Completion history/);
  assert.match(dashboard, /Token budget consumption/);
  assert.match(dashboard, new RegExp(`Current phase: ${checklist.project.currentPhase}`));
  assert.match(dashboard, new RegExp(`Phase budget: ${summary.budget.estimate} tokens`));
  assert.doesNotMatch(dashboard, /\/Users\//);
});
