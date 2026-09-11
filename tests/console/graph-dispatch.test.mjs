import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createConsoleService } from '../../src/console/service.ts';
import { ManagerConnectedStore } from '../../src/manager-connected/index.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';
import { SPRINT_CHECKS } from '../../src/sprint/readiness.ts';
import { WorkCatalogObserver } from '../../src/console/work-management.ts';

const roots = []; const opened = [];
const ids = { manager: '019c89ea-34b1-7f65-8c96-0f496bb5a001', builder: '019c89ea-34b1-7f65-8c96-0f496bb5a002' };
afterEach(async () => { await Promise.all(opened.splice(0).map(async ({ app, store, coordinator }) => { await app.close(); await store.close(); await coordinator.release(); coordinator.close(); })); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const catalog = { format: 'faktori.work-catalog/v1', projects: [{ productId: 'faktori', title: 'Faktori', goal: 'Ship.', artifacts: [], plans: [{ id: 'console-plan', order: 1, title: 'Console', goal: 'Ship.', phases: [{ id: 'batch-one', order: 1, title: 'Batch', goal: 'Ship.', acceptance: 'Works.', tickets: [{ id: 'CWM-006', order: 1, title: 'Graph', goal: 'Queue it.', dependencies: [] }] }] }] }] };
function graph() { const source = id => ({ id, text: id, revision: 'r1' }); return { hierarchy: { revision: 'r1', globalConstraints: [], nodes: [{ id: 'node-1', kind: 'executable', label: 'Graph work', objective: source('objective'), criteria: [source('criteria')], designReferences: [], artifacts: [source('artifact')], commands: [], authority: [], evidenceRequirements: [] }], dependencies: [] }, registrations: [{ nodeId: 'node-1', delivery: { ticket: { key: 'CWM-006', rank: 1, status: 'To Do', workState: 'idle', dependencies: [] }, repository: { repository: 'owner/repo', branch: 'main', registered: true } } }], observations: [], transitionsByTicket: {}, policy: { eligibleCodingStatuses: ['To Do'], protectedStatuses: [], maxConcurrentCoding: 1 } }; }

describe('owner graph frontier enqueue', () => {
  it('queues only the configured packet frontier idempotently and claim rechecks its packet binding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-graph-dispatch-')); roots.push(directory); await chmod(directory, 0o700);
    const catalogPath = join(directory, 'catalog.json'); const packetPath = join(directory, 'graph.json'); const readinessPath = join(directory, 'readiness.json');
    await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    const packet = { format: 'faktori.graph-dispatch/v1', sprintRevision: 'r1', catalogRevision: '', graph: graph(), assignments: [{ nodeId: 'node-1', sessionId: 'builder', scope: { productId: 'faktori', planId: 'console-plan', phaseId: 'batch-one', ticketId: 'CWM-006' }, title: 'Implement graph ticket', instruction: 'Implement the assigned ticket.' }] };
    const observer = await WorkCatalogObserver.open({ path: catalogPath }); packet.catalogRevision = observer.snapshot().revision;
    await writeFile(packetPath, JSON.stringify(packet), { mode: 0o600 });
    const packetDigest = createHash('sha256').update(await readFile(packetPath)).digest('hex');
    const now = new Date(); const checks = SPRINT_CHECKS.filter(id => id !== 'manager_wakeup').map(id => ({ id, state: 'passed', revision: 'r1', owner: 'Foreman', evidence: 'receipt:current', source: id.endsWith('_goal') ? 'platform' : 'controller', observedAt: new Date(now - 1_000).toISOString(), validUntil: new Date(now.getTime() + 60_000).toISOString(), ...(id.startsWith('builder_') ? { workItemId: 'CWM-006', threadId: ids.builder } : {}), ...(id === 'foreman_goal' ? { threadId: ids.manager } : {}) }));
    const readiness = { format: 'faktori.sprint-readiness/v1', sprintId: 'sprint', revision: 'r1', mode: 'attended', managerThreadId: ids.manager, targets: [{ workItemId: 'CWM-006', threadId: ids.builder }], artifactBindings: [{ path: packetPath, sha256: packetDigest }], checks };
    await writeFile(readinessPath, JSON.stringify(readiness), { mode: 0o600 });
    const coordinator = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(directory, 'ops.jsonl'), projectionPath: join(directory, 'projection.sqlite'), identity: { instanceId: 'test', pid: process.pid, processStartedAt: 'now' }, limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 5, maxTokens: 100, strictSpending: false, strictSpendingSupported: false } }); await coordinator.claim();
    const store = await ManagerConnectedStore.open({ directory: join(directory, 'manager'), sprintReadinessPath: readinessPath, manager: { threadId: ids.manager, title: 'Foreman' }, sessions: [{ id: 'builder', threadId: ids.builder, title: 'Builder', role: 'implementer', productId: 'faktori', planId: 'console-plan', phaseId: 'batch-one', ticketId: 'CWM-006' }] });
    const app = createConsoleService({ coordinator, commandToken: 'owner-token', allowedOrigins: ['http://127.0.0.1:43177'], managerConnected: { store, relayToken: 'a'.repeat(64) }, workCatalogObserver: observer, graphDispatch: { path: packetPath, readinessPath } }); opened.push({ app, store, coordinator });
    const headers = { origin: 'http://127.0.0.1:43177', 'x-faktori-console-token': 'owner-token' };
    expect((await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: { type: 'enqueue_frontier', graph: {} } })).statusCode).toBe(409);
    const first = await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: { type: 'enqueue_frontier' } }); expect(first.statusCode).toBe(200); expect(first.json().result).toMatchObject({ enqueued: 1, duplicate: 0, receipts: [expect.objectContaining({ status: 'enqueued' })] });
    const second = await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: { type: 'enqueue_frontier' } }); expect(second.json().result).toMatchObject({ enqueued: 0, duplicate: 1 }); expect(store.snapshot().requests).toHaveLength(1);
    // These packet/catalog failures happen before another durable queue write.
    const wrongTicket = structuredClone(packet); wrongTicket.graph.registrations[0].delivery.ticket.key = 'OTHER-1';
    await writeFile(packetPath, JSON.stringify(wrongTicket)); readiness.artifactBindings[0].sha256 = createHash('sha256').update(await readFile(packetPath)).digest('hex'); await writeFile(readinessPath, JSON.stringify(readiness));
    expect((await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: { type: 'enqueue_frontier' } })).statusCode).toBe(409); expect(store.snapshot().requests).toHaveLength(1);
    await writeFile(packetPath, JSON.stringify(packet)); readiness.artifactBindings[0].sha256 = createHash('sha256').update(await readFile(packetPath)).digest('hex'); await writeFile(readinessPath, JSON.stringify(readiness));
    const staleCatalog = structuredClone(catalog); staleCatalog.projects[0].title = 'New catalog revision'; await writeFile(catalogPath, JSON.stringify(staleCatalog)); await observer.refresh();
    expect((await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: { type: 'enqueue_frontier' } })).statusCode).toBe(409); expect(store.snapshot().requests).toHaveLength(1);
    await writeFile(packetPath, JSON.stringify({ ...packet, catalogRevision: 'changed' }));
    await expect(store.operate({ type: 'claim', id: store.snapshot().requests[0].id })).rejects.toMatchObject({ code: 'sprint_admission_blocked' });
  });
});
