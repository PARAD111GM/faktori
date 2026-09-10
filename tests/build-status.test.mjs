import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const command = join(root, 'scripts', 'update-build-status.mjs');

function invoke(checklist, ...args) {
  return spawnSync(process.execPath, [command, '--checklist', checklist, '--ticket', 'F0-02', ...args], { encoding: 'utf8' });
}

test('updates a later iteration ticket from its declared checklist and rejects absent work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faktori-status-'));
  const checklist = join(dir, 'checklist.json');
  await writeFile(checklist, JSON.stringify({ schemaVersion: 1, tickets: [{ id: 'LEAN-01', status: 'not_started' }], history: [] }));
  const result = spawnSync(process.execPath, [command, '--checklist', checklist, '--ticket', 'LEAN-01', '--status', 'in_progress'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const saved = await readFile(checklist, 'utf8');
  assert.equal(JSON.parse(saved).history[0].ticketId, 'LEAN-01');
  const absent = spawnSync(process.execPath, [command, '--checklist', checklist, '--ticket', 'LEAN-99', '--status', 'complete'], { encoding: 'utf8' });
  assert.notEqual(absent.status, 0);
  assert.equal(await readFile(checklist, 'utf8'), saved);
});

test('preserves append-only reopened and split history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faktori-status-'));
  const checklist = join(dir, 'checklist.json');
  await writeFile(checklist, JSON.stringify({ schemaVersion: 1, tickets: [{ id: 'F0-02', phase: 0, title: 'Tracking', status: 'complete', dependencies: [] }], history: [{ eventId: 'e1', at: '2026-09-04T00:00:00Z', ticketId: 'F0-02', from: 'in_progress', to: 'complete' }] }));
  for (const args of [['--status', 'in_progress', '--reason', 'reopened'], ['--status', 'split', '--reason', 'separate watch task', '--split-into', 'F0-02a,F0-02b']]) {
    const result = invoke(checklist, ...args);
    assert.equal(result.status, 0, result.stderr);
  }
  const saved = JSON.parse(await readFile(checklist, 'utf8'));
  assert.equal(saved.history.length, 5);
  assert.deepEqual(saved.history.slice(0, 3).map(({ to }) => to), ['complete', 'in_progress', 'split']);
  assert.deepEqual(saved.tickets[0].splitInto, ['F0-02a', 'F0-02b']);
  assert.deepEqual(saved.tickets.slice(1).map(({ id, splitFrom, phase, dependencies, status }) => ({ id, splitFrom, phase, dependencies, status })), [
    { id: 'F0-02a', splitFrom: 'F0-02', phase: 0, dependencies: [], status: 'not_started' },
    { id: 'F0-02b', splitFrom: 'F0-02', phase: 0, dependencies: [], status: 'not_started' },
  ]);
  assert.deepEqual(saved.tickets[1].owner, { role: 'unassigned' });
  assert.deepEqual(saved.tickets[1].notes, []);
  assert.deepEqual(saved.tickets[1].evidence, []);
  assert.match(saved.tickets[1].title, /Tracking/);
  assert.deepEqual(saved.history.slice(3).map(({ ticketId, type, to, splitFrom }) => ({ ticketId, type, to, splitFrom })), [
    { ticketId: 'F0-02a', type: 'created', to: 'not_started', splitFrom: 'F0-02' },
    { ticketId: 'F0-02b', type: 'created', to: 'not_started', splitFrom: 'F0-02' },
  ]);
  const laterUpdate = spawnSync(process.execPath, [command, '--checklist', checklist, '--ticket', 'F0-02a', '--status', 'in_progress'], { encoding: 'utf8' });
  assert.equal(laterUpdate.status, 0, laterUpdate.stderr);
});

test('rejects malformed, duplicate, and canonical split IDs without partially writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faktori-status-'));
  const checklist = join(dir, 'checklist.json');
  const original = JSON.stringify({ schemaVersion: 1, tickets: [{ id: 'F0-02', phase: 0, title: 'Tracking', status: 'in_progress', dependencies: ['F0-01'] }], history: [] });
  await writeFile(checklist, original);
  for (const splitInto of ['F0-02a,', 'F0-02a,F0-02a', 'F0-01', 'F0-03a']) {
    const result = invoke(checklist, '--status', 'split', '--split-into', splitInto);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(checklist, 'utf8'), original);
  }
});

test('rejects an existing derived ticket without partially writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faktori-status-'));
  const checklist = join(dir, 'checklist.json');
  const original = JSON.stringify({ schemaVersion: 1, tickets: [{ id: 'F0-02', phase: 0, title: 'Tracking', status: 'in_progress', dependencies: [] }, { id: 'F0-02a', phase: 0, title: 'Prior split', status: 'not_started', dependencies: [], splitFrom: 'F0-02' }], history: [] });
  await writeFile(checklist, original);
  const result = invoke(checklist, '--status', 'split', '--split-into', 'F0-02a,F0-02b');
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(checklist, 'utf8'), original);
});
