import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { startLocalConsoleFromFile } from '../../src/console/startup.ts';

function identityProbe() {
  const current = { pid: process.pid, processStartedAt: 'settings-test-process', processGroupId: process.pid, running: true };
  return { inspect: async (pid) => pid === process.pid ? current : { status: 'absent' }, inspectAll: async () => [current] };
}

describe('editable Console settings', () => {
  it('previews and atomically saves only validated revision-bound settings while retaining private configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-settings-edit-'));
    const configPath = join(root, 'console.json');
    const factoryConfiguration = JSON.parse(await readFile(new URL('../../examples/config/solo.json', import.meta.url), 'utf8'));
    const original = {
      factoryId: 'solo-studio',
      factoryConfiguration,
      journalPath: join(root, 'operations.jsonl'),
      projectionPath: join(root, 'projection.sqlite'),
      port: 0,
      commandToken: 'settings-test-token',
      allowedOrigins: ['http://127.0.0.1:4173'],
      limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 45, maxTokens: 30_000, strictSpending: true, strictSpendingSupported: true },
      privateExtension: { apiKey: 'private-value-must-survive' },
    };
    await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`);
    const headers = { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'settings-test-token' };
    let started;
    try {
      started = await startLocalConsoleFromFile(configPath, { coordinatorIdentityProbe: identityProbe() });
      expect((await started.app.inject({ method: 'POST', url: '/api/console/settings/edit', headers: { 'x-faktori-console-token': 'settings-test-token' } })).statusCode).toBe(403);
      expect((await started.app.inject({ method: 'POST', url: '/api/console/settings/edit', headers: { ...headers, 'x-faktori-console-token': 'wrong' } })).statusCode).toBe(401);

      const edit = (await started.app.inject({ method: 'POST', url: '/api/console/settings/edit', headers })).json();
      expect(edit).toMatchObject({ revision: expect.any(String), restartRequired: false, draft: { factoryName: 'Solo Studio', providers: ['codex'], limits: { strictSpending: true } } });
      expect(edit.draft.limits).not.toHaveProperty('strictSpendingSupported');
      expect(JSON.stringify(edit)).not.toContain('private-value-must-survive');
      expect(JSON.stringify(edit)).not.toContain(configPath);

      const beforeNoop = await readFile(configPath, 'utf8');
      const noopPreview = await started.app.inject({ method: 'POST', url: '/api/console/settings/preview', headers, payload: { revision: edit.revision, draft: edit.draft } });
      expect(noopPreview.statusCode).toBe(200);
      expect(noopPreview.json()).toMatchObject({ changed: false, restartRequired: false, risks: [] });
      const noopSave = await started.app.inject({ method: 'POST', url: '/api/console/settings/save', headers, payload: { revision: edit.revision, draft: edit.draft, confirm: true, acknowledgedRiskIds: [] } });
      expect(noopSave.statusCode).toBe(200);
      expect(noopSave.json()).toMatchObject({ revision: edit.revision, changed: false, restartRequired: false });
      expect(await readFile(configPath, 'utf8')).toBe(beforeNoop);

      const unknown = await started.app.inject({ method: 'POST', url: '/api/console/settings/preview', headers, payload: { revision: edit.revision, draft: { ...edit.draft, commandToken: 'attempted-injection' } } });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error).toMatch(/unsupported fields/);
      expect(await readFile(configPath, 'utf8')).toBe(beforeNoop);

      await writeFile(configPath, `${beforeNoop}\n`);
      const stale = await started.app.inject({ method: 'POST', url: '/api/console/settings/save', headers, payload: { revision: edit.revision, draft: edit.draft, confirm: true, acknowledgedRiskIds: [] } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toEqual({ error: 'settings_revision_conflict' });

      const refreshed = (await started.app.inject({ method: 'POST', url: '/api/console/settings/edit', headers })).json();
      const changedDraft = structuredClone(refreshed.draft);
      changedDraft.factoryName = 'Renamed Studio';
      changedDraft.defaults.budget.maxTokens = 40_000;
      changedDraft.defaults.authority.requireIndependentReview = false;
      const previewResponse = await started.app.inject({ method: 'POST', url: '/api/console/settings/preview', headers, payload: { revision: refreshed.revision, draft: changedDraft } });
      expect(previewResponse.statusCode).toBe(200);
      const preview = previewResponse.json();
      expect(preview.changed).toBe(true);
      expect(preview.draft.products[0].overrides.budget.maxTokens).toBe(40_000);
      expect(preview.risks).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'budget_relaxation', path: 'defaults.budget.maxTokens' }),
        expect.objectContaining({ kind: 'authority_relaxation', path: 'defaults.authority.requireIndependentReview' }),
      ]));

      const unacknowledged = await started.app.inject({ method: 'POST', url: '/api/console/settings/save', headers, payload: { revision: refreshed.revision, draft: changedDraft, confirm: true, acknowledgedRiskIds: [] } });
      expect(unacknowledged.statusCode).toBe(400);
      expect(unacknowledged.json().error).toMatch(/settings_risk_acknowledgement_required/);
      const acknowledgedRiskIds = preview.risks.map((risk) => risk.id);
      const savedResponse = await started.app.inject({ method: 'POST', url: '/api/console/settings/save', headers, payload: { revision: refreshed.revision, draft: changedDraft, confirm: true, acknowledgedRiskIds } });
      expect(savedResponse.statusCode).toBe(200);
      const saved = savedResponse.json();
      expect(saved).toMatchObject({ revision: expect.any(String), changed: true, restartRequired: true });
      expect(saved.revision).not.toBe(refreshed.revision);

      const persisted = JSON.parse(await readFile(configPath, 'utf8'));
      expect(persisted.commandToken).toBe('settings-test-token');
      expect(persisted.privateExtension).toEqual({ apiKey: 'private-value-must-survive' });
      expect(persisted.limits.strictSpendingSupported).toBe(true);
      expect(persisted.factoryConfiguration.factory.name).toBe('Renamed Studio');
      expect(persisted.factoryConfiguration.factory.defaults.budget.maxTokens).toBe(40_000);
      expect(persisted.factoryConfiguration.products[0]).not.toHaveProperty('overrides');
      expect(persisted.factoryConfiguration.providers).toEqual(original.factoryConfiguration.providers);
      const liveState = (await started.app.inject({ method: 'GET', url: '/api/console/state' })).json();
      expect(liveState.settings.factory.name).toBe('Solo Studio');
      expect(liveState.settings.persistence).toMatchObject({ loadedRevision: expect.any(String), savedRevision: saved.revision, restartRequired: true });
      expect(JSON.stringify(liveState)).not.toContain('private-value-must-survive');

      await started.close();
      started = await startLocalConsoleFromFile(configPath, { coordinatorIdentityProbe: identityProbe() });
      const restartedState = (await started.app.inject({ method: 'GET', url: '/api/console/state' })).json();
      expect(restartedState.settings.factory.name).toBe('Renamed Studio');
      expect(restartedState.settings.factory.defaults.budget.maxTokens).toBe(40_000);
      expect(restartedState.settings.persistence).toMatchObject({ loadedRevision: saved.revision, savedRevision: saved.revision, restartRequired: false });
      await rm(configPath);
      const missingFile = await started.app.inject({ method: 'POST', url: '/api/console/settings/edit', headers });
      expect(missingFile.statusCode).toBe(500);
      expect(missingFile.json()).toEqual({ error: 'settings_operation_failed' });
      expect(missingFile.body).not.toContain(configPath);
    } finally {
      await started?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes same-revision saves so exactly one can replace the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-settings-race-'));
    const configPath = join(root, 'console.json');
    const factoryConfiguration = JSON.parse(await readFile(new URL('../../examples/config/solo.json', import.meta.url), 'utf8'));
    await writeFile(configPath, `${JSON.stringify({ factoryId: 'solo-studio', factoryConfiguration, journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), port: 0, commandToken: 'race-token', allowedOrigins: ['http://127.0.0.1:4173'], limits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 45, maxTokens: 30_000, strictSpending: true, strictSpendingSupported: true } }, null, 2)}\n`);
    const headers = { origin: 'http://127.0.0.1:4173', 'x-faktori-console-token': 'race-token' };
    let started;
    try {
      started = await startLocalConsoleFromFile(configPath, { coordinatorIdentityProbe: identityProbe() });
      const edit = (await started.app.inject({ method: 'POST', url: '/api/console/settings/edit', headers })).json();
      const first = structuredClone(edit.draft); first.factoryName = 'First writer';
      const second = structuredClone(edit.draft); second.factoryName = 'Second writer';
      const [left, right] = await Promise.all([
        started.app.inject({ method: 'POST', url: '/api/console/settings/save', headers, payload: { revision: edit.revision, draft: first, confirm: true, acknowledgedRiskIds: [] } }),
        started.app.inject({ method: 'POST', url: '/api/console/settings/save', headers, payload: { revision: edit.revision, draft: second, confirm: true, acknowledgedRiskIds: [] } }),
      ]);
      expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
      expect(['First writer', 'Second writer']).toContain(JSON.parse(await readFile(configPath, 'utf8')).factoryConfiguration.factory.name);
    } finally { await started?.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); }
  });
});
