import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { observeCodexGoal } from '../../src/sprint/codex-goal.ts';

const threadId = '019c89ea-34b1-7f65-8c96-0f496bb5a001';
function transport(reply) {
  const calls = [];
  const spawn = (_command, args) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
    child.stdin.on('data', bytes => { const message = JSON.parse(bytes.toString()); calls.push(message);
      const response = reply(message); if (response) child.stdout.write(JSON.stringify(response) + '\n'); });
    return child;
  };
  return { spawn, calls };
}
describe('Codex native goal observation', () => {
  it('uses only initialize, initialized, and the exact correlated read-only goal RPC', async () => {
    const fake = transport(message => message.id === 1 ? { jsonrpc: '2.0', id: 1, result: {} }
      : message.id === 2 ? { jsonrpc: '2.0', id: 2, result: { goal: { threadId, status: 'active', objective: 'private objective token=secret' } } } : undefined);
    const observation = await observeCodexGoal(threadId, { spawn: fake.spawn }); expect(observation).toMatchObject({ status: 'active', goal: { status: 'active', objectivePresent: true } }); expect(JSON.stringify(observation)).not.toMatch(/objective token|secret/);
    expect(fake.calls).toEqual([{ id: 1, method: 'initialize', params: { clientInfo: { name: 'faktori', version: '1' }, capabilities: {} } }, { method: 'initialized' }, { id: 2, method: 'thread/goal/get', params: { threadId } }]);
  });
  it('fails closed for malformed correlation, process failure, timeout, and invalid identifiers', async () => {
    const malformed = transport(() => ({ jsonrpc: '2.0', id: 9, result: {} }));
    await expect(observeCodexGoal(threadId, { spawn: malformed.spawn })).resolves.toMatchObject({ status: 'unavailable' });
    const broken = transport(() => undefined);
    await expect(observeCodexGoal(threadId, { spawn: (() => { throw new Error('no executable'); }) })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(observeCodexGoal(threadId, { spawn: broken.spawn, timeoutMs: 50 })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(observeCodexGoal('not-a-thread', { spawn: malformed.spawn })).resolves.toMatchObject({ status: 'unavailable' }); expect(malformed.calls).toHaveLength(1);
  });
  it('distinguishes missing and inactive from untrusted or malformed goal evidence', async () => {
    // Prevent a broken transport or a different task from being reported as a
    // missing goal that an operator might unnecessarily replace.
    for (const [result, status] of [
      [{ goal: null }, 'missing'],
      [{ goal: { threadId, status: 'complete', objective: 'done' } }, 'inactive'],
      [{ goal: { threadId, status: 'blocked', objective: 'blocked' } }, 'inactive'],
      [{ goal: { threadId: 'another-task', status: 'active', objective: 'private' } }, 'unavailable'],
      [{ goal: { threadId, status: 'active', objective: ' ' } }, 'unavailable'],
      [{ goal: { threadId, status: 'invented', objective: 'private' } }, 'unavailable'],
      [{}, 'unavailable'],
    ]) {
      const fake = transport(message => message.id === 1 ? { id: 1, result: {} }
        : message.id === 2 ? { id: 2, result } : undefined);
      await expect(observeCodexGoal(threadId, { spawn: fake.spawn })).resolves.toMatchObject({ status });
    }
    const oversized = transport(message => message.id === 1 ? { id: 1, result: { padding: 'x'.repeat(70_000) } } : undefined);
    await expect(observeCodexGoal(threadId, { spawn: oversized.spawn })).resolves.toMatchObject({ status: 'unavailable', reason: 'output_limit' });
    expect(oversized.calls).toHaveLength(1);
    const rpcError = transport(message => message.id === 1 ? { id: 1, result: {} }
      : message.id === 2 ? { id: 2, error: { message: 'private diagnostic' } } : undefined);
    const report = await observeCodexGoal(threadId, { spawn: rpcError.spawn });
    expect(report).toMatchObject({ status: 'unavailable', reason: 'protocol_error' });
    expect(JSON.stringify(report)).not.toContain('private diagnostic');
  });
});
