import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';
import { ManagerConnectedStore } from '../../src/manager-connected/index.ts';
import { createConsoleService } from '../../src/console/service.ts';
import { callManagerRelay, writeManagerRelayConnection } from '../../src/console/manager-relay.ts';

describe('Manager-connected Console transport', () => {
  // Prevents a browser request from dispatching or inventing an agent callback.
  it('separates owner queueing from private Manager delivery and keeps reported work distinct from acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-manager-console-'));
    const threadId = '11111111-1111-4111-8111-111111111111';
    const coordinator = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(root, 'ops.jsonl'), projectionPath: join(root, 'projection.sqlite'), identity: { instanceId: 'test', pid: process.pid, processStartedAt: 'now' }, limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 5, maxTokens: 500, strictSpending: false, strictSpendingSupported: false } });
    await coordinator.claim();
    const store = await ManagerConnectedStore.open({ directory: join(root, 'manager'), manager: { threadId: '22222222-2222-4222-8222-222222222222', title: 'Build manager' }, sessions: [{ id: 'phase-one', threadId, title: 'First phase', role: 'implementer', productId: 'factory' }] });
    const token = 'a'.repeat(64);
    const app = createConsoleService({ coordinator, commandToken: 'owner-token', allowedOrigins: ['http://127.0.0.1:43177'], managerConnected: { store, relayToken: token } });
    let remove;
    try {
      const ownerHeaders = { origin: 'http://127.0.0.1:43177', 'x-faktori-console-token': 'owner-token' };
      const action = { type: 'enqueue', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId: 'phase-one', title: 'Verify arithmetic', instruction: 'Private task instruction: verify arithmetic only.' };
      const send = (payload, headers = ownerHeaders, url = '/api/console/manager-connected') => app.inject({ method: 'POST', url, headers, payload });
      expect((await send(action, {})).statusCode).toBe(403);
      expect((await send(action)).statusCode).toBe(200);
      expect((await send(action)).json().state.managerConnected.requests).toHaveLength(1);
      expect((await send({ type: 'claim', id: action.id })).statusCode).toBe(400);
      expect((await send({ type: 'complete', id: action.id, threadId, summary: 'Fake result' })).statusCode).toBe(400);
      expect((await send({ type: 'claim', id: action.id }, ownerHeaders, '/api/manager-connected/relay')).statusCode).toBe(403);
      // Prevents a browser from acknowledging/closing a decision or replacing
      // an owner's durable choice while the private Manager is unavailable.
      const decision = { type: 'decision_create', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', scope: { productId: 'factory', planId: 'console-plan', phaseId: 'batch-two' }, problem: 'Choose a default.', cause: { basis: 'observed', summary: 'A display default is needed.' }, evidence: [{ label: 'Observed UI' }], accountableOwner: 'owner', recommendedNextAction: 'Record a bounded response.', impact: 'No dispatch or authority changes.', capability: 'supported', action: { kind: 'record_owner_response', label: 'Record response for Manager observation' }, options: [{ id: 'collapsed', label: 'Collapsed' }, { id: 'expanded', label: 'Expanded' }] };
      await store.operate(decision);
      const response = { type: 'record_owner_response', id: decision.id, responseId: 'collapsed', idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', expectedRevision: 1 };
      const decisionSend = (payload, headers = ownerHeaders) => app.inject({ method: 'POST', url: '/api/console/manager-connected/decision', headers, payload });
      expect((await decisionSend(response, {})).statusCode).toBe(403);
      expect((await decisionSend({ type: 'decision_acknowledge', id: decision.id, expectedRevision: 1 })).statusCode).toBe(400);
      expect((await decisionSend(response)).json().decision).toMatchObject({ state: 'pending_manager_ack', ownerResponse: { optionId: 'collapsed' } });
      expect((await decisionSend({ ...response, responseId: 'expanded' })).statusCode).toBe(409);
      const state = (await app.inject('/api/console/state')).body;
      expect(state).not.toContain(token);
      expect(state).not.toContain(action.instruction);
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      remove = await writeManagerRelayConnection(join(root, 'manager'), origin, token);
      const path = join(root, 'manager', 'relay-connection.json');
      expect((await callManagerRelay(path, { type: 'decision_acknowledge', id: decision.id, expectedRevision: 3 })).decision).toMatchObject({ state: 'manager_acknowledged' });
      expect(JSON.parse(await readFile(path, 'utf8')).origin).toBe(origin);
      const claim = await callManagerRelay(path, { type: 'claim', id: action.id });
      expect(JSON.stringify(claim)).toContain(action.instruction);
      await expect(callManagerRelay(path, { type: 'claim', id: action.id })).rejects.toThrow();
      await callManagerRelay(path, { type: 'submitted', id: action.id });
      await expect(callManagerRelay(path, { type: 'complete', id: action.id, threadId: '33333333-3333-4333-8333-333333333333', summary: 'Wrong source' })).rejects.toThrow();
      await callManagerRelay(path, { type: 'complete', id: action.id, threadId, summary: 'Arithmetic verified by implementer' });
      const reported = await callManagerRelay(path, { type: 'state' });
      expect(JSON.stringify(reported)).toContain('not_evaluated');
      expect(JSON.stringify(reported)).toContain('Arithmetic verified by implementer');
    } finally { await remove?.(); await app.close(); await store.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });
});
