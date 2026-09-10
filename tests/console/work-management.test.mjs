import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DurableCoordinator } from '../../src/runtime/coordinator.ts';
import { ManagerConnectedStore } from '../../src/manager-connected/index.ts';
import { createConsoleService } from '../../src/console/service.ts';
import { WorkCatalogObserver, parseWorkCatalog, sanitizeArtifactContentForProjection } from '../../src/console/work-management.ts';

const roots = [];
const opened = [];
const IDS = {
  manager: '019c89ea-34b1-7f65-8c96-0f496bb5a001',
  session: '019c89ea-34b1-7f65-8c96-0f496bb5a002',
  request: '019c89ea-34b1-7f65-8c96-0f496bb5b101',
};

async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'faktori-work-management-'));
  roots.push(directory);
  return directory;
}

function catalog(overrides = {}) {
  return {
    format: 'faktori.work-catalog/v1',
    projects: [{ productId: 'faktori', title: 'Catalog title', goal: 'Ship an honest Console.', artifacts: [], plans: [{ id: 'console-plan', order: 1, title: 'Console plan', goal: 'Understand work.', phases: [{ id: 'batch-one', order: 1, title: 'Batch one', goal: 'Build the seam.', acceptance: 'Projection is truthful.', tickets: [{ id: 'CWM-006', order: 1, title: 'Catalog graph', goal: 'Validate it.', dependencies: [] }] }] }] }],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async ({ app, store, coordinator }) => { await app?.close(); await store?.close(); await coordinator?.release(); coordinator?.close(); }));
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('work catalog boundary', () => {
  it('rejects invalid dependency graph boundaries instead of manufacturing a project tree', () => {
    const cyclic = catalog();
    cyclic.projects[0].plans[0].phases[0].tickets.push({ id: 'CWM-007', order: 2, title: 'Cycle', goal: 'Nope.', dependencies: ['CWM-006'] });
    cyclic.projects[0].plans[0].phases[0].tickets[0].dependencies = ['CWM-007'];
    expect(() => parseWorkCatalog(cyclic)).toThrow(/cycle/);
    expect(() => parseWorkCatalog(catalog({ projects: [{ ...catalog().projects[0], artifactHome: '/private/home', artifacts: [{ id: 'intent', title: 'Intent', role: 'intent', path: '../secret' }] }] }))).toThrow(/safe relative path/);
  });

  it('keeps the last valid snapshot and its revision when a hot reload is malformed', async () => {
    const directory = await root();
    const path = join(directory, 'work.json');
    await writeFile(path, JSON.stringify(catalog()), 'utf8');
    const observer = await WorkCatalogObserver.open({ path }, new Map([['faktori', 'Configured Faktori']]));
    const first = observer.snapshot();
    expect(first).toMatchObject({ status: 'available', projects: [{ title: 'Configured Faktori' }] });
    await writeFile(path, '{broken', 'utf8');
    await observer.refresh();
    expect(observer.snapshot()).toMatchObject({ status: 'stale', revision: first.revision, projects: [{ productId: 'faktori' }] });
    await writeFile(path, JSON.stringify(catalog({ projects: [{ ...catalog().projects[0], title: 'Changed catalog title' }] })), 'utf8');
    await observer.refresh();
    expect(observer.snapshot()).toMatchObject({ status: 'available', projects: [{ title: 'Configured Faktori' }] });
    expect(observer.snapshot().revision).not.toBe(first.revision);
  });

  it('keeps artifact metadata but fails content closed when descriptor-anchored traversal is unavailable', async () => {
    const directory = await root();
    const home = join(directory, 'artifacts');
    const path = join(directory, 'work.json');
    await mkdir(home);
    await writeFile(join(home, 'intent.md'), '# Intent\nKeep this bounded.', 'utf8');
    const withArtifact = catalog({ projects: [{ ...catalog().projects[0], artifactHome: home, artifacts: [{ id: 'intent', title: 'Intent', role: 'intent', path: 'intent.md' }] }] });
    await writeFile(path, JSON.stringify(withArtifact), 'utf8');
    const observer = await WorkCatalogObserver.open({ path });
    const projected = observer.snapshot().projects[0].artifacts[0];
    if (process.platform === 'linux') expect(projected).toMatchObject({ status: 'available', content: '# Intent\nKeep this bounded.' });
    else expect(projected).toMatchObject({ status: 'unavailable', error: 'artifact_content_unavailable_without_dirfd_traversal' });
    expect(JSON.stringify(observer.snapshot())).not.toContain(home);
    await symlink(join(home, 'intent.md'), join(home, 'linked.md'));
    await writeFile(path, JSON.stringify(catalog({ projects: [{ ...catalog().projects[0], artifactHome: home, artifacts: [{ id: 'intent', title: 'Intent', role: 'intent', path: 'linked.md' }] }] })), 'utf8');
    await observer.refresh();
    expect(observer.snapshot().projects[0].artifacts[0].status).toBe('unavailable');
  });

  it('redacts every public absolute-path form before artifact text reaches the browser', () => {
    const projected = sanitizeArtifactContentForProjection('safe\n/Users/nathan/private\n/home/nathan/private\n/private/tmp/item\nC:\\Users\\nathan\\private\n\\\\server\\share\\private');
    expect(projected).toBe('safe\n[redacted]\n[redacted]\n[redacted]\n[redacted]\n[redacted]');
  });

  it('projects an explicit owner snapshot without following an artifact path', async () => {
    const directory = await root();
    const path = join(directory, 'work.json');
    await writeFile(path, JSON.stringify(catalog({ projects: [{ ...catalog().projects[0], artifacts: [{ id: 'plan', title: 'Accepted plan', role: 'plan', path: 'never-read.md', content: 'Owner snapshot\n/private/owner-only', sourceRevision: 'catalog-r7', snapshotAt: '2026-09-09T12:00:00.000Z' }] }] })), 'utf8');
    const observer = await WorkCatalogObserver.open({ path });
    const artifact = observer.snapshot().projects[0].artifacts[0];
    expect(artifact).toMatchObject({ status: 'available', contentBasis: 'owner_snapshot', content: 'Owner snapshot\n[redacted]', sourceRevision: 'catalog-r7', snapshotAt: '2026-09-09T12:00:00.000Z' });
    expect(artifact.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(observer.snapshot())).not.toContain('/private/owner-only');
  });
});

describe('scoped manager requests', () => {
  it('requires current scope for a new request, snapshots it immutably, and permits only identical replay after reload', async () => {
    const directory = await root();
    const catalogPath = join(directory, 'work.json');
    await writeFile(catalogPath, JSON.stringify(catalog()), 'utf8');
    const observer = await WorkCatalogObserver.open({ path: catalogPath });
    const coordinator = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(directory, 'ops.jsonl'), projectionPath: join(directory, 'projection.sqlite'), identity: { instanceId: 'test', pid: process.pid, processStartedAt: 'now' }, limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 5, maxTokens: 500, strictSpending: false, strictSpendingSupported: false } });
    await coordinator.claim();
    const store = await ManagerConnectedStore.open({ directory: join(directory, 'manager'), manager: { threadId: IDS.manager, title: 'Manager' }, sessions: [{ id: 'phase-one', threadId: IDS.session, title: 'Phase one', role: 'implementer', productId: 'faktori', planId: 'console-plan', phaseId: 'batch-one', ticketId: 'CWM-006' }] });
    const app = createConsoleService({ coordinator, commandToken: 'owner-token', allowedOrigins: ['http://127.0.0.1:43177'], managerConnected: { store, relayToken: 'a'.repeat(64) }, workCatalogObserver: observer });
    opened.push({ app, store, coordinator });
    const headers = { origin: 'http://127.0.0.1:43177', 'x-faktori-console-token': 'owner-token' };
    const action = { type: 'enqueue', id: IDS.request, sessionId: 'phase-one', title: 'Verify catalog', instruction: 'Report only.', catalogRevision: observer.snapshot().revision, scope: { productId: 'faktori', planId: 'console-plan', phaseId: 'batch-one', ticketId: 'CWM-006' } };
    expect((await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: { ...action, scope: { ...action.scope, phaseId: 'wrong' } } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: action })).statusCode).toBe(200);
    expect(store.snapshot().requests[0]).toMatchObject({ catalogRevision: action.catalogRevision, scope: action.scope });
    expect(store.snapshot().requests[0]).not.toHaveProperty('report');
    const state = (await app.inject('/api/console/state')).json();
    expect(state.activity.find((item) => item.source === 'request')).toMatchObject({ requestId: IDS.request, productId: 'faktori', planId: 'console-plan', phaseId: 'batch-one', ticketId: 'CWM-006' });
    expect(state.activity.find((item) => item.source === 'request').summary).toMatch(/queued for Manager-mediated delivery/);
    await writeFile(catalogPath, '{broken', 'utf8');
    await observer.refresh();
    expect((await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: { ...action, id: '019c89ea-34b1-7f65-8c96-0f496bb5b102' } })).json().error).toBe('work_catalog_stale');
    expect((await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: action })).statusCode).toBe(200);
    await writeFile(catalogPath, JSON.stringify(catalog({ projects: [{ ...catalog().projects[0], title: 'Reloaded' }] })), 'utf8');
    await observer.refresh();
    expect((await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: action })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/console/manager-connected', headers, payload: { ...action, scope: { ...action.scope, ticketId: undefined } } })).statusCode).toBe(409);
  });
});
