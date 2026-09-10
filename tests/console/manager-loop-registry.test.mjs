import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ManagerLoopObserver } from '../../src/console/manager-loop-observer.ts';
import { ManagerLoopRegistry } from '../../src/console/manager-loop-registry.ts';
import { createConsoleService } from '../../src/console/service.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

function source(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.artifactsDirectory !== 'string') throw new Error('invalid_source');
  return { id: value.id, artifactsDirectory: value.artifactsDirectory, ...(typeof value.productId === 'string' ? { productId: value.productId } : {}), ...(typeof value.podId === 'string' ? { podId: value.podId } : {}), ...(typeof value.usageExportPath === 'string' ? { usageExportPath: value.usageExportPath } : {}) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'faktori-loop-registry-'));
  const artifactsRoot = join(root, 'artifacts');
  const artifacts = join(artifactsRoot, 'registered-loop');
  await mkdir(artifacts, { recursive: true });
  await mkdir(join(root, 'controller'));
  const registry = await ManagerLoopRegistry.open({ path: join(root, 'controller', 'registrations.json'), allowedArtifactRoots: [artifactsRoot], validate: source });
  const coordinator = await DurableCoordinator.open({
    factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'),
    identity: { instanceId: 'registry-test', pid: 101, processStartedAt: 'now' },
    limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 0, strictSpending: false, strictSpendingSupported: false },
  });
  await coordinator.claim();
  return { root, artifactsRoot, artifacts, registry, coordinator };
}

describe('Manager Loop hot registration', () => {
  it('persists a root-bounded registration exactly once and immediately adds its cached observer source', async () => {
    const { root, artifacts, registry, coordinator } = await fixture();
    const observer = new ManagerLoopObserver({ sources: [] });
    const app = createConsoleService({ coordinator, commandToken: 'local-token', allowedOrigins: ['http://127.0.0.1:4173'], managerLoopObserver: observer, managerLoopRegistry: registry });
    const headers = { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'local-token' };
    const body = { id: 'lean-proof', artifactsDirectory: artifacts, productId: 'product' };
    try {
      expect((await app.inject({ method: 'POST', url: '/api/console/manager-loops/register', payload: body })).statusCode).toBe(403);
      const first = await app.inject({ method: 'POST', url: '/api/console/manager-loops/register', headers, payload: body });
      expect(first.statusCode).toBe(200);
      expect(first.json().created).toBe(true);
      expect(first.json().state.managerLoops).toEqual([expect.objectContaining({ id: 'lean-proof', status: 'unavailable', reason: 'state_missing' })]);
      const second = await app.inject({ method: 'POST', url: '/api/console/manager-loops/register', headers, payload: body });
      expect(second.statusCode).toBe(200);
      expect(second.json().created).toBe(false);
      expect(observer.sources()).toHaveLength(1);
      const persisted = JSON.parse(await readFile(join(root, 'controller', 'registrations.json'), 'utf8'));
      expect(persisted.registrations).toEqual([expect.objectContaining({ id: body.id, productId: body.productId, artifactsDirectory: expect.stringContaining('/artifacts/registered-loop') })]);
      const restarted = await ManagerLoopRegistry.open({ path: join(root, 'controller', 'registrations.json'), allowedArtifactRoots: [join(root, 'artifacts')], validate: source });
      expect(restarted.sources()).toEqual([expect.objectContaining({ id: body.id, productId: body.productId, artifactsDirectory: expect.stringContaining('/artifacts/registered-loop') })]);
    } finally { await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a browser-selected directory outside the owner configured roots', async () => {
    const { root, registry, coordinator } = await fixture();
    const observer = new ManagerLoopObserver({ sources: [] });
    const app = createConsoleService({ coordinator, commandToken: 'local-token', allowedOrigins: ['http://127.0.0.1:4173'], managerLoopObserver: observer, managerLoopRegistry: registry });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/console/manager-loops/register', headers: { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'local-token' }, payload: { id: 'outside', artifactsDirectory: root } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('manager_loop_registration_outside_allowlisted_roots');
      expect(observer.sources()).toEqual([]);
    } finally { await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('rejects an explicitly registered usage export outside the owner configured roots', async () => {
    const { root, artifacts, registry, coordinator } = await fixture();
    const outsideExport = join(root, 'outside-usage.jsonl');
    await writeFile(outsideExport, '{"telemetry":"unknown"}\n');
    try {
      await expect(registry.register({ id: 'outside-export', artifactsDirectory: artifacts, usageExportPath: outsideExport })).rejects.toThrow('manager_loop_registration_outside_allowlisted_roots');
      expect(registry.sources()).toEqual([]);
    } finally { await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('does not follow a registered directory replaced by a symlink', async () => {
    const { root, artifacts, registry, coordinator } = await fixture();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'state.json'), JSON.stringify({ format: 'faktori.manager-loop-state/v1', loopId: 'sealed', status: 'succeeded', updatedAt: '2026-09-09T00:00:00Z', completedPhases: [], stages: [] }));
    const registered = await registry.register({ id: 'sealed', artifactsDirectory: artifacts });
    const observer = new ManagerLoopObserver({ sources: [registered.source] });
    try {
      await rm(artifacts, { recursive: true, force: true });
      await symlink(outside, artifacts);
      await observer.poll();
      expect(observer.summaries()).toEqual([expect.objectContaining({ id: 'sealed', status: 'unavailable', reason: 'artifacts_not_directory' })]);
    } finally { observer.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('does not treat a missing persisted source as an empty registry', async () => {
    const { root, artifacts, registry, coordinator } = await fixture();
    try {
      await registry.register({ id: 'persisted', artifactsDirectory: artifacts });
      await rm(artifacts, { recursive: true, force: true });
      await expect(ManagerLoopRegistry.open({ path: join(root, 'controller', 'registrations.json'), allowedArtifactRoots: [join(root, 'artifacts')], validate: source })).rejects.toThrow();
      expect(JSON.parse(await readFile(join(root, 'controller', 'registrations.json'), 'utf8')).registrations).toHaveLength(1);
    } finally { await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); }
  });
});
