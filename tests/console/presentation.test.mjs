import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
let server;
let presentation;

beforeAll(async () => {
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  presentation = await server.ssrLoadModule('/console/src/main.tsx');
});

afterAll(async () => {
  await server?.close();
});

describe('Console presentation contract', () => {
  it('shows loop acceptance, repair history and stale records without offering unsafe controls', async () => {
    const { ManagerLoops } = await server.ssrLoadModule('/console/src/manager-loops.tsx');
    const loops = [{ id: 'quality-loop', productId: 'product-a', status: 'blocked', stale: true,
      completedPhases: ['foundation'], currentStage: { phaseId: 'feature', kind: 'repair', round: 1 },
      stages: [{ phaseId: 'feature', kind: 'review', round: 0, outcome: 'completed', decision: 'repair', verification: 'passed', completedAt: '2026-09-09T12:00:00Z' },
        { phaseId: 'feature', kind: 'repair', round: 1, outcome: 'failed', completedAt: '2026-09-09T12:01:00Z' }],
      reason: '<script>blocked</script>' }];
    const html = renderToStaticMarkup(createElement(ManagerLoops, { loops }));
    expect(html).toContain('foundation');
    expect(html).toContain('feature / repair');
    expect(html).toContain('feature / review');
    expect(html).toContain('Decision: repair');
    expect(html).toContain('Verification: passed');
    expect(html).toContain('1</strong> repair attempts');
    expect(html).toContain('This projection may be stale');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<button');
    const scoped = renderToStaticMarkup(createElement(ManagerLoops, { loops, filter: { productId: 'other', podId: '' } }));
    expect(scoped).not.toContain('quality-loop');
    expect(scoped).toContain('No connected loops in this scope');
    const overview = renderToStaticMarkup(createElement(presentation.Overview, { state: { managerLoops: loops }, runs: [], selectRun() {} }));
    expect(overview).toContain('At a glance');
    expect(overview).not.toContain('quality-loop');
    expect(overview).not.toContain('Running activity');
  });
  it('offers flexible role assignments without implying merge authority', async () => {
    const { RoleAssignments } = await server.ssrLoadModule('/console/src/role-assignments.tsx');
    const settings = {providers:[{id:'codex',configuredIds:['my-codex']}]};
    const html = renderToStaticMarkup(createElement(RoleAssignments, {settings, assignments:[{role:'merge-captain',providerId:'my-codex',model:'model-a',reasoning:'high'}], onChange() {}}));
    expect(html).toContain('my-codex');
    expect(html).toContain('model-a');
    expect(html).toContain('Remove role merge-captain');
    expect(html).toContain('+ manager');
    expect(html).toContain('+ Custom role');
    expect(html).toContain('does not change merge authority');
    const empty = renderToStaticMarkup(createElement(RoleAssignments, {settings}));
    expect(empty).toContain('No roles assigned');
    expect(empty).not.toContain('<input');
    expect(empty).toContain('Unlabelled work uses builder');
    const unsupported = renderToStaticMarkup(createElement(RoleAssignments, {settings: {providers:[{id:'cursor',configuredIds:['cursor-team']}]}, assignments:[{role:'builder',providerId:'cursor-team',reasoning:'high'}]}));
    expect(unsupported).toContain('cannot apply explicit role model or reasoning overrides');
  });
  it('renders scoped run counts without promoting absent usage telemetry to zero', () => {
    const runs = [
      {
        runId: 'run-visible',
        workItem: { id: 'work-visible' },
        target: { factoryId: 'factory', productId: 'product-a', podId: 'pod-a', repository: 'owner/repo' },
        state: 'running',
        createdAt: '2026-09-08T12:00:00.000Z',
        reservation: { estimatedTokens: 125, status: 'held' },
      },
      {
        runId: 'run-other-product',
        workItem: { id: 'work-other' },
        target: { factoryId: 'factory', productId: 'product-b', podId: 'pod-b' },
        state: 'failed',
        reservation: { estimatedTokens: 900, status: 'held' },
      },
    ];
    const filter = { productId: 'product-a', podId: 'pod-a' };
    const visibleRuns = runs.filter((run) => presentation.runMatches(run, filter));
    const state = {
      admissionPaused: false,
      blockers: [],
      resources: { knownUsageTokens: 0, reportedUsageCount: 0, unavailableMeasurements: 2 },
    };

    const html = renderToStaticMarkup(createElement(presentation.Overview, { state, runs: visibleRuns, selectRun() {} }));

    expect(html).toContain('At a glance');
    expect(html).not.toContain('1 scoped runs');
    expect(html).not.toContain('Scoped reservations');
    expect(html).not.toContain('900');
    expect(html).toContain('Cross-project catalog facts, not live activity.');

    const factoryHtml = renderToStaticMarkup(createElement(presentation.Factory, {
      state: { resources: { knownUsageTokens: 0, reportedUsageCount: 0, unavailableMeasurements: 0 } },
      runs: [],
      submit() {},
    }));
    expect(factoryHtml).toContain('Known reported usage</dt><dd>Unavailable</dd>');
    expect(factoryHtml).toContain('Reported measurements</dt><dd>0</dd>');
    expect(factoryHtml).toContain('Unavailable measurements</dt><dd>0</dd>');
  });

  it('keeps legacy scope controls labeled while placing project selection inside Work', async () => {
    const filterHtml = renderToStaticMarkup(createElement(presentation.ScopeFilters, {
      hierarchy: { filters: { products: [{ id: 'product-a', name: 'Product A' }], pods: [{ id: 'pod-a', productId: 'product-a' }] } },
      filter: { productId: '', podId: '' },
      setFilter() {},
    }));
    const source = await readFile(join(root, 'console/src/main.tsx'), 'utf8');

    expect(filterHtml).toContain('<span>Product</span>');
    expect(filterHtml).toContain('<span>Pod</span>');
    expect(filterHtml).toContain('All products');
    expect(filterHtml).toContain('All pods');
    expect(source).toContain("const primaryViews = ['overview', 'projects', 'decisions', 'work', 'sessions', 'factory', 'settings'] as const;");
    expect(source).toContain('>Project<select');
    expect(source).not.toContain("{view !== 'settings' && <ScopeFilters");
    expect(source).toContain('className="session-key"');
    expect(source).toContain('className="header-controls"');
  });

  it('renders a populated run detail with its real controls, evidence, and pending provider request', () => {
    const run = {
      runId: 'run-detail',
      workItem: { id: 'work-detail' },
      target: { repository: 'owner/repo' },
      provider: 'codex',
      model: 'configured-model',
      profile: 'native',
      state: 'blocked',
      createdAt: '2026-09-08T12:00:00.000Z',
      reservation: { status: 'held' },
      authority: { epoch: 4, revoked: false },
      messages: [{ messageId: 'message-1', createdAt: '2026-09-08T12:01:00.000Z', delivery: 'queued' }],
      providerRequests: [{ requestId: 'request-1', method: 'permission', prompt: 'Allow the bounded check?', options: ['Allow', 'Deny'], status: 'pending', observedAt: '2026-09-08T12:02:00.000Z' }],
      result: { outcome: 'blocked', summary: 'Waiting for owner input.', verification: ['Typecheck observed'] },
    };

    const html = renderToStaticMarkup(createElement(presentation.RunDetail, { run, blockers: [], submit() {} }));

    expect(html).toContain('run-detail');
    expect(html).toContain('configured-model');
    expect(html).toContain('Typecheck observed');
    expect(html).toContain('Allow the bounded check?');
    expect(html).toContain('Open authoritative record');
    expect(html).toContain('Queue instruction');
    expect(html).toContain('Resume if eligible');
    expect(html).toContain('Cancel run');
  });

  it('finds work by ID, provider, and readable status without losing the original runs', () => {
    const runs = [
      { runId: 'r-1', workItem: { id: 'task-alpha' }, provider: 'codex', state: 'running' },
      { runId: 'r-2', workItem: { id: 'task-beta' }, provider: 'claude', state: 'quota_exhausted' },
    ];
    expect(presentation.filterWorkRuns(runs, '  CODEX ')).toEqual([runs[0]]);
    expect(presentation.filterWorkRuns(runs, 'task-beta')).toEqual([runs[1]]);
    expect(presentation.filterWorkRuns(runs, 'quota exhausted')).toEqual([runs[1]]);
    expect(presentation.filterWorkRuns(runs, 'missing')).toEqual([]);
    expect(presentation.filterWorkRuns(runs, '')).toEqual(runs);
    expect(runs).toHaveLength(2);
  });

  it('restores supported pages after refresh and safely defaults unknown links', () => {
    expect(presentation.viewFromHash('#work')).toBe('work');
    expect(presentation.viewFromHash('#factory')).toBe('factory');
    expect(presentation.viewFromHash('#run')).toBe('run');
    expect(presentation.viewFromHash('#settings')).toBe('settings');
    expect(presentation.viewFromHash('#unknown')).toBe('overview');
  });

  it('shows provider configuration without claiming authentication or offering fake saves', async () => {
    const { Settings } = await server.ssrLoadModule('/console/src/settings.tsx');
    const settings = {
      factory: { id: 'factory', name: 'Test factory' },
      providers: [{ id: 'codex', configured: true, enabled: false, authentication: { status: 'unknown', detail: 'Login has not been checked.' }, capabilities: ['native'], routes: [] }],
      products: [], environments: [{ id: 'local', kind: 'local' }],
      resourceLimits: { maxConcurrentRuns: 2, maxTokens: 0, strictSpending: true },
      recovery: { configured: false, routineActions: [] },
    };
    const html = renderToStaticMarkup(createElement(Settings, { settings }));
    expect(html).toContain('Catalog only');
    expect(html).toContain('Unverified');
    expect(html).toContain('No runtime route');
    expect(html).toContain('Currently running');
    expect(html).toContain('Concurrent runs');
    expect(html).not.toContain('Save changes');
    const missing = renderToStaticMarkup(createElement(Settings));
    expect(missing).toContain('Settings unavailable');
  });

  it('explains how to restore settings editing when the running Console has no factory catalog', async () => {
    const { Settings } = await server.ssrLoadModule('/console/src/settings.tsx');
    const html = renderToStaticMarkup(createElement(Settings, { settings: {
      factory: { id: 'factory', name: 'Factory', catalogConfigured: false },
      providers: [], products: [], environments: [],
      resourceLimits: { maxConcurrentRuns: 1, maxRetries: 0, maxRuntimeMinutes: 1, maxTokens: 0, strictSpending: false, strictSpendingSupported: false },
      recovery: { configured: false, routineActions: [] },
      generalManager: { mode: 'not_configured', reviewRouteCount: 0 },
    } }));
    expect(html).toContain('Factory settings need a catalog');
    expect(html).toContain('Restore factory settings');
    expect(html).toContain('factoryConfiguration');
    expect(html).toContain('factory.id');
    expect(html).toContain('cannot select a file or import a catalog from the browser');
    expect(html).not.toContain('Your factory, configured');
  });

  it('offers persistent editing only when supported and identifies specific reviewed changes', async () => {
    const { SettingsEditor, changes, settingsEditorError } = await server.ssrLoadModule('/console/src/settings-editor.tsx');
    const html = renderToStaticMarkup(createElement(SettingsEditor, { settings: {}, token: '', onSaved() {} }));
    expect(html).toContain('Edit settings');
    expect(html).toContain('Saved settings take effect after the Console is restarted');
    expect(changes({limits:{maxConcurrentRuns:1}}, {limits:{maxConcurrentRuns:2}})).toEqual(['limits.maxConcurrentRuns: 1 → 2']);
    expect(changes({limits:{maxTokens:0}}, {limits:{maxTokens:0}})).toEqual([]);
    expect(settingsEditorError('settings_editing_requires_factory_configuration', 409)).toContain('started without its factory catalog');
    expect(settingsEditorError('settings_editing_requires_factory_configuration', 409)).not.toContain('settings_editing_requires_factory_configuration');
  });

});
