import { describe, expect, it } from 'vitest';
import { evaluateSprintReadiness, SPRINT_CHECKS } from '../../src/sprint/readiness.ts';
import { ManagerConnectedStore } from '../../src/manager-connected/index.ts';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const now = new Date('2026-09-11T12:00:00Z');
function document() {
  return { format: 'faktori.sprint-readiness/v1', sprintId: 'sprint-1', revision: 'r1', mode: 'attended',
    managerThreadId: 'manager', targets: [{ workItemId: 'T-1', threadId: 'builder' }],
    checks: SPRINT_CHECKS.filter(id => id !== 'manager_wakeup').map(id => ({ id, state: 'passed',
      revision: 'r1', owner: 'Foreman', evidence: 'receipt:verified-1',
      source: id.includes('goal') ? 'platform' : 'controller',
      observedAt: '2026-09-11T11:59:00Z', validUntil: '2026-09-11T13:00:00Z',
      ...(id.startsWith('builder_') ? { workItemId: 'T-1', threadId: 'builder' } : {}),
      ...(id === 'foreman_goal' ? { threadId: 'manager' } : {}),
    })) };
}
describe('sprint admission', () => {
  it('enforces readiness at actual relay enqueue and rechecks before claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-sprint-'));
    await chmod(root, 0o700);
    const path = join(root, 'readiness.json');
    const manager = '00000000-0000-4000-8000-000000000001';
    const builder = '00000000-0000-4000-8000-000000000002';
    const input = document(); input.managerThreadId = manager; input.targets[0].threadId = builder;
    const intent = join(root, 'INTENT.md'); await writeFile(intent, 'Approved intent');
    input.artifactBindings = [{ path: intent, sha256: createHash('sha256').update('Approved intent').digest('hex') }];
    for (const c of input.checks) { c.observedAt = new Date(Date.now() - 1000).toISOString(); c.validUntil = new Date(Date.now() + 60000).toISOString();
      if (c.id.startsWith('builder_')) c.threadId = builder;
      if (c.id === 'foreman_goal') c.threadId = manager;
    }
    const store = await ManagerConnectedStore.open({ directory: join(root, 'relay'), sprintReadinessPath: path,
      manager: { threadId: manager, title: 'Foreman' }, sessions: [{ id: 'builder', threadId: builder, title: 'Builder', role: 'implementer', productId: 'product', ticketId: 'T-1' }] });
    const action = { type: 'enqueue', id: 'test-request', sessionId: 'builder', title: 'Implement ticket', instruction: 'Read approved context then implement.' };
    try {
      await expect(store.operate(action)).rejects.toMatchObject({ code: 'sprint_admission_blocked' });
      expect(store.snapshot().requests).toHaveLength(0);
      await writeFile(path, JSON.stringify(input), { mode: 0o600 });
      expect((await store.sprintReadiness()).ready).toBe(true);
      const foreign = structuredClone(input);
      foreign.managerThreadId = 'other-manager'; foreign.checks.find(c => c.id === 'foreman_goal').threadId = 'other-manager';
      await writeFile(path, JSON.stringify(foreign));
      expect(await store.sprintReadiness()).toMatchObject({ ready: false, blockers: expect.arrayContaining([expect.objectContaining({ id: 'foreman_identity' })]) });
      await writeFile(path, JSON.stringify(input));
      await store.operate(action);
      await expect(store.operate({ ...action, id: 'duplicate-ticket' })).rejects.toMatchObject({ code: 'sprint_assignment_busy' });
      await writeFile(intent, 'Changed intent');
      await expect(store.operate({ type: 'claim', id: 'test-request' })).rejects.toMatchObject({ code: 'sprint_admission_blocked' });
      await writeFile(intent, 'Approved intent');
      input.checks.find(c => c.id === 'slack').state = 'failed';
      await writeFile(path, JSON.stringify(input));
      await expect(store.operate({ type: 'claim', id: 'test-request' })).rejects.toMatchObject({ code: 'sprint_admission_blocked' });
      expect(store.snapshot().requests[0].status).toBe('queued');
      // Fresh passing evidence cannot retroactively approve the queued context.
      input.checks.find(c => c.id === 'slack').state = 'passed';
      input.checks[0].validUntil = new Date(Date.now() + 120000).toISOString();
      await writeFile(path, JSON.stringify(input));
      expect((await store.sprintReadiness()).ready).toBe(true);
      await expect(store.operate({ type: 'claim', id: 'test-request' })).rejects.toMatchObject({ code: 'sprint_admission_blocked' });
      await store.operate({ type: 'cancel', id: 'test-request' });
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('admits only current correlated observations and never treats a prompt as a native goal', () => {
    const input = document();
    expect(evaluateSprintReadiness(input, { workItemId: 'T-1', threadId: 'builder' }, now).ready).toBe(true);
    input.checks.find(c => c.id === 'builder_goal').source = 'agent_report';
    expect(evaluateSprintReadiness(input, { workItemId: 'T-1', threadId: 'builder' }, now)).toMatchObject({ ready: false,
      blockers: expect.arrayContaining([expect.objectContaining({ id: 'builder_goal' })]) });
    expect(evaluateSprintReadiness(document(), { workItemId: 'T-1', threadId: 'other' }, now).ready).toBe(false);
  });
  it('blocks missing, stale, failed, mismatched and duplicate evidence without overrides', () => {
    for (const change of [d => d.checks.pop(), d => d.checks[0].validUntil = now.toISOString(),
      d => d.checks[0].state = 'failed', d => d.revision = 'r2', d => d.checks.push(d.checks[0])]) {
      const input = document(); change(input);
      expect(evaluateSprintReadiness(input, { workItemId: 'T-1', threadId: 'builder' }, now).ready).toBe(false);
    }
  });
  it('requires wake-up proof for unattended execution and exposes attended-only explicitly', () => {
    const input = document(); input.mode = 'unattended';
    expect(evaluateSprintReadiness(input, undefined, now)).toMatchObject({ ready: false,
      blockers: expect.arrayContaining([expect.objectContaining({ id: 'manager_wakeup' })]) });
    expect(evaluateSprintReadiness(document(), undefined, now)).toMatchObject({ ready: true, mode: 'attended' });
  });
  it('uses only applicable checks for the admission deadline', () => {
    const input = document();
    input.checks.push({ ...input.checks[0], id: 'manager_wakeup', validUntil: '2026-09-11T11:00:00Z' });
    input.checks.push({ ...input.checks.find(c => c.id === 'builder_goal'), threadId: 'unrelated', validUntil: '2026-09-11T11:00:00Z' });
    expect(evaluateSprintReadiness(input, undefined, now)).toMatchObject({ ready: true, validUntil: '2026-09-11T13:00:00.000Z' });
  });
});
