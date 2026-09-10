import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// This verifier lives outside the candidate workspace so a worker cannot make
// its work pass by weakening the accepted contract.
const [workspace, mode] = process.argv.slice(2);
assert.ok(workspace, 'Supply candidate workspace');
assert.ok(['existing', 'implementation'].includes(mode), 'Supply proof mode');
const api = await import(pathToFileURL(resolve(workspace, 'tasks.mjs')).href);
const input = Object.freeze([]);
const first = api.addTask(input, '  Ship the task board  ');
assert.equal(input.length, 0);
assert.equal(first.length, 1);
assert.equal(first[0].title, 'Ship the task board');
assert.equal(first[0].completed, false);
assert.equal(typeof first[0].id, 'string');
assert.ok(first[0].id.length > 0);
const second = api.addTask(Object.freeze(first), 'Verify delivery');
assert.notEqual(first[0].id, second[1].id);
assert.deepEqual(second[0], first[0]);
assert.throws(() => api.addTask(input, ' \n '));
assert.throws(() => api.addTask(input, null));
if (mode === 'implementation') {
  const frozen = Object.freeze(second.map((task) => Object.freeze({ ...task })));
  const completed = api.completeTask(frozen, frozen[0].id);
  assert.notEqual(completed, frozen);
  assert.deepEqual(completed, [{ ...frozen[0], completed: true }, frozen[1]]);
  assert.equal(frozen[0].completed, false);
  assert.throws(() => api.completeTask(frozen, 'missing-task-id'));
  assert.deepEqual(api.completeTask(completed, completed[0].id), completed);
}
process.stdout.write(`LEAN proof ${mode}: accepted contract passed\n`);
