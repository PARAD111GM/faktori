import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { CursorAcpStdioTransport } from '../../src/execution/cursor-acp-stdio.ts';

function worker() {
  return { kind: 'native', pid: 4242, processStartedAt: '2026-09-05T01:00:01.000Z', processGroupId: 4242, runNonce: 'cursor-nonce' };
}

function fakeChild(pid = 4242) {
  const process = new EventEmitter();
  process.pid = pid;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.writes = [];
  process.stdin = { write(line) { process.writes.push(line); return true; }, end() { process.ended = true; } };
  return process;
}

function transport(child, options = {}) {
  const spawns = [];
  const provider = new CursorAcpStdioTransport({
    environment: { PATH: '/controlled/bin', CURSOR_PROFILE: 'selected-profile' },
    runNonce: 'cursor-nonce',
    identityProbe: { async inspect(pid) { return options.identity ?? { pid, processStartedAt: '2026-09-05T01:00:01.000Z', processGroupId: pid, running: true }; } },
    spawn(command, args, spawnOptions) { spawns.push({ command, args, spawnOptions }); if (options.spawnError) throw options.spawnError; return child; },
    maxLineBytes: options.maxLineBytes,
  });
  return { provider, spawns };
}

function connectRequest(overrides = {}) {
  return { runId: 'run-77', command: 'cursor agent acp', cwd: '/job-workspaces/job-77', timeoutMs: 300, ...overrides };
}

function parseWrites(child) {
  return child.writes.map((line) => JSON.parse(line));
}

describe('Cursor ACP stdio transport', () => {
  it('spawns only cursor agent acp in the exact cwd and controlled environment after durable identity persistence', async () => {
    const child = fakeChild();
    const { provider, spawns } = transport(child);
    const order = [];
    const connection = await provider.connect(connectRequest({ lifecycle: { async onStarted(identity) { order.push(identity); } } }));

    expect(order).toEqual([worker()]);
    expect(spawns).toEqual([expect.objectContaining({ command: 'cursor', args: ['agent', 'acp'], spawnOptions: expect.objectContaining({ cwd: '/job-workspaces/job-77', env: { PATH: '/controlled/bin', CURSOR_PROFILE: 'selected-profile' }, detached: true, shell: false }) })]);
    expect(child.writes).toEqual([]);
    expect(connection.worker).toEqual(worker());
  });

  it('frames JSON-RPC requests and correlates out-of-order responses exactly', async () => {
    const child = fakeChild();
    const connection = await transport(child).provider.connect(connectRequest());
    const first = connection.request({ id: 'first', method: 'initialize', params: {} }, 100);
    const second = connection.request({ id: 'second', method: 'authenticate', params: {} }, 100);
    expect(parseWrites(child).map((message) => message.id)).toEqual(['first', 'second']);
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 'second', result: { second: true } })}\n${JSON.stringify({ jsonrpc: '2.0', id: 'first', result: { first: true } })}\n`);
    await expect(second).resolves.toEqual({ second: true });
    await expect(first).resolves.toEqual({ first: true });
  });

  it('serializes inbound provider requests and writes exact coordinator replies', async () => {
    const child = fakeChild();
    const connection = await transport(child).provider.connect(connectRequest());
    const seen = [];
    connection.setRequestHandler(async (request) => { seen.push(request.id); return { result: { accepted: request.id } }; });
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/request_question', params: {} })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([1, 2]);
    expect(parseWrites(child)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { accepted: 1 } },
      { jsonrpc: '2.0', id: 2, result: { accepted: 2 } },
    ]);
  });

  it('fails pending calls closed on malformed, duplicate, or orphan protocol messages', async () => {
    const malformedChild = fakeChild();
    const malformed = await transport(malformedChild).provider.connect(connectRequest());
    const malformedPending = malformed.request({ id: 'one', method: 'initialize', params: {} }, 100);
    malformedChild.stdout.emit('data', '{not-json}\n');
    await expect(malformedPending).rejects.toThrow(/malformed/);

    const duplicateChild = fakeChild();
    const duplicate = await transport(duplicateChild).provider.connect(connectRequest());
    const pending = duplicate.request({ id: 'one', method: 'initialize', params: {} }, 100);
    duplicateChild.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 'one', result: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 'one', result: {} })}\n`);
    await expect(pending).resolves.toEqual({});
    await expect(duplicate.request({ id: 'two', method: 'authenticate', params: {} }, 100)).rejects.toThrow(/closed/);
  });

  it('bounds requests, invokes the durable termination hook, and never waits indefinitely', async () => {
    const child = fakeChild();
    const termination = [];
    const connection = await transport(child).provider.connect(connectRequest({ lifecycle: {
      async onStarted() {},
      async onTerminationRequired(identity, reason) { termination.push({ identity, reason }); },
    } }));
    await expect(connection.request({ id: 'one', method: 'initialize', params: {} }, 5)).rejects.toThrow(/timed out/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(termination).toEqual([{ identity: worker(), reason: 'timeout' }]);
  });

  it('safely supports only the documented cancel notification and closes stdin without ambient process signaling', async () => {
    const child = fakeChild();
    const connection = await transport(child).provider.connect(connectRequest());
    await connection.notify('session/cancel', { sessionId: 'cursor-session-77' });
    await expect(connection.notify('made/up', {})).rejects.toThrow(/unsupported/);
    await connection.close();
    expect(parseWrites(child)).toEqual([{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'cursor-session-77' } }]);
    expect(child.ended).toBe(true);
  });

  it('refuses missing identities and duplicate active transport connections before sending ACP messages', async () => {
    const identityChild = fakeChild();
    const noIdentity = transport(identityChild, { identity: { status: 'unknown' } });
    await expect(noIdentity.provider.connect(connectRequest())).rejects.toThrow(/identity/);
    expect(identityChild.writes).toEqual([]);

    const child = fakeChild();
    const { provider } = transport(child);
    await provider.connect(connectRequest());
    await expect(provider.connect(connectRequest({ runId: 'run-78' }))).rejects.toThrow(/one active/);
  });

  it('closes stdin when durable worker-start recording fails, without sending any ACP message', async () => {
    const child = fakeChild();
    const { provider } = transport(child);
    await expect(provider.connect(connectRequest({ lifecycle: { async onStarted() { throw new Error('journal unavailable'); } } }))).rejects.toThrow(/journal unavailable/);
    expect(child.ended).toBe(true);
    expect(child.writes).toEqual([]);
  });
});
