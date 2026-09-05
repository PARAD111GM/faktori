import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { CursorAcpStdioTransport } from '../../src/execution/cursor-acp-stdio.ts';

function worker() {
  return { kind: 'native', pid: 4242, processStartedAt: '2026-09-05T01:00:01.000Z', processGroupId: 4242, runNonce: 'cursor-nonce' };
}

function fakeChild(pid = 4242, options = {}) {
  const process = new EventEmitter();
  process.pid = pid;
  process.running = true;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.writes = [];
  process.stdin = {
    write(line) { process.writes.push(line); return true; },
    end() {
      process.ended = true;
      if (options.exitOnEnd !== false && process.running) {
        process.running = false;
        queueMicrotask(() => process.emit('close', 0, null));
      }
    },
  };
  return process;
}

function transport(child, options = {}) {
  const spawns = [];
  const group = () => child.running
    ? { processGroupId: child.pid, members: [{ pid: child.pid, processStartedAt: '2026-09-05T01:00:01.000Z', processGroupId: child.pid, running: true }] }
    : { status: 'absent' };
  const provider = new CursorAcpStdioTransport({
    environment: { PATH: '/controlled/bin', CURSOR_PROFILE: 'selected-profile' },
    runNonce: 'cursor-nonce',
    identityProbe: {
      async inspect(pid) {
        if (options.identityError) throw options.identityError;
        return options.identity ?? (child.running ? { pid, processStartedAt: '2026-09-05T01:00:01.000Z', processGroupId: pid, running: true } : { status: 'absent' });
      },
      async inspectProcessGroup() { return options.group ?? group(); },
    },
    killProcessGroup(processGroupId, signal) {
      options.killProcessGroup?.(processGroupId, signal);
      if (options.killProcessGroup === undefined && signal === 'SIGTERM') {
        child.running = false;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      }
    },
    spawn(command, args, spawnOptions) { spawns.push({ command, args, spawnOptions }); if (options.spawnError) throw options.spawnError; return child; },
    maxLineBytes: options.maxLineBytes,
    closeGraceMs: options.closeGraceMs,
    terminationGraceMs: options.terminationGraceMs,
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

  it('accepts id-less session/update notifications from the live ACP flow without replying or closing the session', async () => {
    const child = fakeChild();
    const connection = await transport(child).provider.connect(connectRequest());
    const seen = [];
    connection.setNotificationHandler(async (notification) => { seen.push(notification); });
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session-77', update: { text: 'progress' } } })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'cursor/unknown_observation', params: { step: 2 } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([
      { method: 'session/update', params: { sessionId: 'cursor-session-77', update: { text: 'progress' } } },
      { method: 'cursor/unknown_observation', params: { step: 2 } },
    ]);
    expect(child.writes).toEqual([]);
    const pending = connection.request({ id: 'after-update', method: 'initialize', params: {} }, 100);
    child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: 'after-update', result: {} })}\n`);
    await expect(pending).resolves.toEqual({});
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

  it('confirms a normal terminal child and process-group exit before releasing the connection', async () => {
    const child = fakeChild();
    const termination = [];
    const { provider } = transport(child);
    const connection = await provider.connect(connectRequest({ lifecycle: {
      async onStarted() {},
      async onTerminationRequired(identity, reason) { termination.push({ identity, reason }); },
    } }));
    await connection.notify('session/cancel', { sessionId: 'cursor-session-77' });
    await expect(connection.notify('made/up', {})).rejects.toThrow(/unsupported/);
    await connection.close();
    expect(parseWrites(child)).toEqual([{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'cursor-session-77' } }]);
    expect(child.ended).toBe(true);
    expect(termination).toEqual([]);
    child.running = true;
    await expect(provider.connect(connectRequest({ runId: 'run-after-confirmed-exit' }))).resolves.toBeDefined();
  });

  it('revokes durably before identity-checked cleanup when EOF leaves a Cursor ACP child running', async () => {
    const child = fakeChild(4242, { exitOnEnd: false });
    const order = [];
    const { provider } = transport(child, {
      closeGraceMs: 1,
      terminationGraceMs: 1,
      killProcessGroup(processGroupId, signal) {
        order.push(`signal:${processGroupId}:${signal}`);
        if (signal === 'SIGTERM') {
          child.running = false;
          queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        }
      },
    });
    const connection = await provider.connect(connectRequest({ lifecycle: {
      async onStarted() { order.push('started'); },
      async onTerminationRequired(identity, reason) { order.push(`revoke:${identity.pid}:${reason}`); },
    } }));

    await connection.close();
    expect(order).toEqual(['started', 'revoke:4242:cancelled', 'signal:4242:SIGTERM']);
    child.running = true;
    await expect(provider.connect(connectRequest({ runId: 'run-after-cleanup' }))).resolves.toBeDefined();
  });

  it('does not release a lingering active identity when process-group exit cannot be confirmed', async () => {
    const child = fakeChild(4242, { exitOnEnd: false });
    const signals = [];
    const { provider } = transport(child, {
      closeGraceMs: 1,
      terminationGraceMs: 1,
      killProcessGroup(processGroupId, signal) { signals.push([processGroupId, signal]); },
    });
    const connection = await provider.connect(connectRequest({ lifecycle: {
      async onStarted() {},
      async onTerminationRequired() {},
    } }));

    await expect(connection.close()).rejects.toThrow(/could not be confirmed/);
    expect(signals).toEqual([[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
    await expect(provider.connect(connectRequest({ runId: 'still-active' }))).rejects.toThrow(/one active/);
  });

  it('orders protocol-failure revocation before identity-checked termination and releases only after confirmed exit', async () => {
    const child = fakeChild(4242, { exitOnEnd: false });
    const order = [];
    const { provider } = transport(child, {
      terminationGraceMs: 1,
      killProcessGroup(processGroupId, signal) {
        order.push(`signal:${processGroupId}:${signal}`);
        if (signal === 'SIGTERM') {
          child.running = false;
          queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        }
      },
    });
    const connection = await provider.connect(connectRequest({ lifecycle: {
      async onStarted() { order.push('started'); },
      async onTerminationRequired(identity, reason) { order.push(`revoke:${identity.pid}:${reason}`); },
    } }));
    const pending = connection.request({ id: 'one', method: 'initialize', params: {} }, 100);
    child.stdout.emit('data', '{not-json}\n');
    await expect(pending).rejects.toThrow(/malformed/);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(order).toEqual(['started', 'revoke:4242:output_limit', 'signal:4242:SIGTERM']);
    child.running = true;
    await expect(provider.connect(connectRequest({ runId: 'run-after-protocol-cleanup' }))).resolves.toBeDefined();
  });

  it('quarantines missing identities and refuses duplicate active transport connections before sending ACP messages', async () => {
    const identityChild = fakeChild(4242, { exitOnEnd: false });
    const noIdentity = transport(identityChild, { identity: { status: 'unknown' } });
    await expect(noIdentity.provider.connect(connectRequest())).rejects.toThrow(/identity/);
    expect(identityChild.writes).toEqual([]);
    await expect(noIdentity.provider.connect(connectRequest({ runId: 'quarantined' }))).rejects.toThrow(/one active/);

    const child = fakeChild();
    const { provider } = transport(child);
    await provider.connect(connectRequest());
    await expect(provider.connect(connectRequest({ runId: 'run-78' }))).rejects.toThrow(/one active/);
  });

  it('quarantines mismatched and failed identity probes without signaling an unproven worker', async () => {
    for (const options of [
      { identity: { pid: 9999, processStartedAt: 'other', processGroupId: 9999, running: true } },
      { identityError: new Error('probe internals must not escape') },
    ]) {
      const child = fakeChild(4242, { exitOnEnd: false });
      const signals = [];
      const { provider } = transport(child, {
        ...options,
        killProcessGroup(processGroupId, signal) { signals.push([processGroupId, signal]); },
      });

      await expect(provider.connect(connectRequest())).rejects.toThrow(/identity/);
      expect(child.ended).toBe(true);
      expect(child.writes).toEqual([]);
      expect(signals).toEqual([]);
      await expect(provider.connect(connectRequest({ runId: 'blocked-by-unproven-worker' }))).rejects.toThrow(/one active/);
    }
  });

  it('closes stdin when durable worker-start recording fails, without sending any ACP message', async () => {
    const child = fakeChild();
    const { provider } = transport(child);
    await expect(provider.connect(connectRequest({ lifecycle: { async onStarted() { throw new Error('journal unavailable'); } } }))).rejects.toThrow(/journal unavailable/);
    expect(child.ended).toBe(true);
    expect(child.writes).toEqual([]);
  });

  it('retains the transport slot when worker-start persistence fails and EOF cannot prove exit', async () => {
    const child = fakeChild(4242, { exitOnEnd: false });
    const signals = [];
    const { provider } = transport(child, {
      closeGraceMs: 1,
      terminationGraceMs: 1,
      killProcessGroup(processGroupId, signal) { signals.push([processGroupId, signal]); },
    });
    await expect(provider.connect(connectRequest({ lifecycle: {
      async onStarted() { throw new Error('journal unavailable'); },
      async onTerminationRequired() { throw new Error('worker identity was not durably recorded'); },
    } }))).rejects.toThrow(/journal unavailable/);
    expect(child.ended).toBe(true);
    expect(signals).toEqual([]);
    await expect(provider.connect(connectRequest({ runId: 'blocked-by-unrecorded-survivor' }))).rejects.toThrow(/one active/);
  });
});
