/**
 * Complete synthetic Console journey. Run with the pinned Node 24 toolchain after
 * `npm run console:build`: node scripts/accept-console-experience.mjs
 * Owns its temporary journal, service, browser and random loopback port. It never
 * launches a provider or uses the separately running browser fixture.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createConsoleService } from '../src/console/service.ts';
import { WorkCatalogObserver } from '../src/console/work-management.ts';
import { ManagerConnectedStore } from '../src/manager-connected/index.ts';
import { DurableCoordinator } from '../src/runtime/coordinator.ts';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runStamp = new Date().toISOString().replaceAll(':', '-');
const evidence = join(workspace, 'output/playwright/console-experience', runStamp);
const reportDirectory = join(workspace, '.build/polish-v0218');
const reportPath = join(reportDirectory, 'console-experience.json');
const startedAt = new Date().toISOString();
const report = {
  format: 'faktori.console-experience-acceptance/v1', startedAt, status: 'running',
  scope: 'Synthetic loopback service and built Console; no provider launch, account, deployment or installed-runtime proof.',
  limits: 'Desktop Chromium at CSS viewport sizes; no physical-device, Safari, actual browser zoom or provider/runtime activation proof. Settings are populated read-only synthetic configuration.',
  viewports: [], checks: [], screenshots: [], pageErrors: [], externalRequests: [],
};
let browser;
let app;
let coordinator;
let managerStore;
let temporary;
let currentPage;
const check = (name, detail) => report.checks.push({ name, status: 'passed', ...(detail ? { detail } : {}) });
const views = ['overview', 'projects', 'artifacts', 'decisions', 'work', 'sessions', 'factory', 'settings'];
const token = 'synthetic-console-acceptance-only';
const runId = 'console-acceptance-run';
const workId = 'console-acceptance-work';
const longIdentifier = 'responsive-evidence-' + 'bounded-reference-'.repeat(9);
const calls = { start: 0, answer: [], cancel: 0, resume: 0, record: 0 };

async function screenshot(page, name) {
  const path = join(evidence, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  report.screenshots.push(path);
}

async function noOverflow(page, description) {
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(geometry.document <= geometry.viewport + 1 && geometry.body <= geometry.viewport + 1,
    `${description}: horizontal page overflow ${JSON.stringify(geometry)}`);
}

function contrastRatio(foreground, background) {
  const luminance = color => {
    const components = color.match(/[\d.]+/g)?.map(Number);
    assert.ok(components && components.length >= 3 && (components.length === 3 || components[3] === 1), `Expected opaque browser color: ${color}`);
    const linear = components.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function projectControlLegibility(page, width) {
  const runButton = page.getByRole('button', { name: `Open run ${runId}`, exact: true });
  const results = [];
  for (const state of ['rest', 'hover']) {
    if (state === 'hover') await runButton.hover();
    const colors = await runButton.evaluate(button => ({
      background: getComputedStyle(button).backgroundColor,
      text: [getComputedStyle(button).color, ...Array.from(button.querySelectorAll('span'), child => getComputedStyle(child).color)],
      height: button.getBoundingClientRect().height,
    }));
    const ratios = colors.text.map(color => contrastRatio(color, colors.background));
    assert.ok(ratios.every(ratio => ratio >= 4.5), `${width}px open-run ${state} text contrast: ${JSON.stringify({ ...colors, ratios })}`);
    if (width <= 760) assert.ok(colors.height >= 44, `${width}px open-run touch target must be at least 44px`);
    results.push({ state, ratios, height: colors.height });
  }
  const badges = await page.locator('.project-card .panel-heading > .state').evaluateAll(elements => elements.map(element => ({ text: element.textContent, whiteSpace: getComputedStyle(element).whiteSpace })));
  assert.ok(badges.length > 0 && badges.every(badge => badge.whiteSpace === 'nowrap'), `${width}px project status pills keep their words intact: ${JSON.stringify(badges)}`);
  check(`${width}px populated project controls meet text contrast, phone touch size and status word integrity`, { button: results, badges });
  await page.getByRole('button', { name: 'Refresh catalog', exact: true }).hover();
}

async function navigate(page, view) {
  const navigation = page.getByRole('navigation', { name: 'Console views' });
  await navigation.getByRole('button', { name: view, exact: true }).click();
  await expect(page.locator('.topbar h1')).toContainText(view[0].toUpperCase() + view.slice(1));
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(navigation.getByRole('button', { name: view, exact: true })).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => page.evaluate(() => location.hash.split('?')[0])).toBe(`#${view}`);
}

async function pendingCleared(page) {
  await expect(page.locator('.pending')).toHaveCount(0);
}

async function setToken(page, value) {
  await navigate(page, 'settings');
  const details = page.locator('details.session-key');
  if (!await details.getAttribute('open').then(value => value !== null)) await details.locator('summary').click({ position: { x: 12, y: 12 } });
  await page.getByLabel('Local command token', { exact: true }).fill(value);
}

async function openRun(page) {
  await navigate(page, 'projects');
  await page.getByRole('button', { name: /Open project/ }).first().click();
  await page.getByRole('button', { name: `Open run ${runId}`, exact: true }).click();
  await expect(page.locator('.topbar h1')).toContainText('Run detail');
}

async function keyboardHelp(page, width) {
  const trigger = page.getByRole('button', { name: 'About Overview', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Overview', exact: true });
  await expect(dialog).toBeVisible();
  const focusCycle = [];
  for (let index = 0; index < 4; index++) {
    await page.keyboard.press('Tab');
    const focus = await dialog.evaluate(element => ({ inDialog: element.contains(document.activeElement), documentFocus: document.activeElement === document.body, tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }));
    focusCycle.push(focus);
    // Chromium can move to browser chrome between the last/first native-modal
    // controls (activeElement becomes body); background page controls stay inert.
    assert.ok(focus.inDialog || focus.documentFocus, `Modal must not focus background controls: ${JSON.stringify(focus)}`);
  }
  report.checks.push({ name: `${width}px native help dialog focus cycle`, status: 'passed', detail: focusCycle });
  await noOverflow(page, `${width} help dialog`);
  await screenshot(page, `${width}-help-dialog`);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

try {
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Use the repository-pinned Node 24 toolchain');
  await access(join(workspace, 'console/dist/index.html'));
  const builtDocument = await readFile(join(workspace, 'console/dist/index.html'), 'utf8');
  const builtDigest = createHash('sha256').update(builtDocument).digest('hex');
  report.build = { documentSha256: builtDigest, assets: [...builtDocument.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]) };
  await mkdir(evidence, { recursive: true });
  await mkdir(reportDirectory, { recursive: true });
  temporary = await mkdtemp(join(tmpdir(), 'faktori-console-experience-'));
  const limits = { maxConcurrentRuns: 2, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 100, strictSpending: false, strictSpendingSupported: false };
  const policy = { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false };
  coordinator = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(temporary, 'operations.jsonl'), projectionPath: join(temporary, 'projection.sqlite'), identity: { instanceId: 'console-acceptance', pid: process.pid, processStartedAt: startedAt }, limits });
  await coordinator.claim();
  await coordinator.admit({
    format: 'faktori.run-intent/v1', runId, admissionKey: 'synthetic-admission',
    workItem: { id: workId, revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'console', podId: 'console-ui', repository: 'example/synthetic-console', branch: longIdentifier, baseRevision: 'base', expectedRevision: 'head' },
    context: { packetRevision: 'packet@1', digest: 'packet' },
    execution: { profile: 'native', workspaceId: 'synthetic-workspace', workspacePath: join(temporary, 'never-launched'), providerId: 'codex', model: 'synthetic-only', approvedInputDigests: [] },
    budget: { reservationId: 'synthetic-reservation', maxRuntimeMinutes: 5, estimatedTokens: 10, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy }, attempt: 1, createdAt: startedAt,
  });
  for (const requestId of ['permission-allow', 'permission-deny']) await coordinator.record('provider.requested', runId, { request: { requestId, method: 'session/request_permission', prompt: `Synthetic bounded permission ${requestId}. ${longIdentifier}`, options: ['allow-once', 'deny'], status: 'pending', observedAt: startedAt } });
  const catalogPath = join(temporary, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify({ format: 'faktori.work-catalog/v1', projects: [{
    productId: 'console', title: 'Synthetic Console project', goal: `Verify an attended Console journey. ${longIdentifier}`,
    artifacts: [{ id: 'intent', title: 'Synthetic INTENT', role: 'intent', path: 'INTENT.md', content: `# Synthetic intent\n${longIdentifier}\nBrowser evidence only; no product acceptance is inferred.`, sourceRevision: longIdentifier, snapshotAt: startedAt }],
    plans: [{ id: 'console-plan', order: 1, title: 'Responsive Console plan', goal: 'Keep controls usable at each viewport.', phases: [{ id: 'console-phase', order: 1, title: 'Attended browser review', goal: 'Inspect populated details.', acceptance: 'Navigation, recovery and command replay preserve identity.', tickets: [{ id: workId, order: 1, title: `Inspect command and permission flow ${longIdentifier}`, goal: 'Retain bounded owner authority.', dependencies: [], status: 'in_progress', runIds: [runId] }] }] }],
  }] }));
  const workCatalogObserver = await WorkCatalogObserver.open({ path: catalogPath, timezone: 'UTC' });
  const store = managerStore = await ManagerConnectedStore.open({ directory: join(temporary, 'manager'), manager: { threadId: '00000000-0000-4000-8000-000000000001', title: 'Synthetic attended manager' }, sessions: [{ id: 'synthetic-session', threadId: '00000000-0000-4000-8000-000000000002', title: `Synthetic Console reviewer ${longIdentifier}`, role: 'Attended reviewer', productId: 'console', planId: 'console-plan', phaseId: 'console-phase', ticketId: workId }] });
  await store.operate({ type: 'decision_create', id: 'synthetic-decision', scope: { productId: 'console', planId: 'console-plan', phaseId: 'console-phase', ticketId: workId }, problem: `Review the retained synthetic permission request. ${longIdentifier}`, cause: { basis: 'observed', summary: 'The synthetic request awaits an owner response.' }, evidence: [{ label: 'Synthetic browser fixture', summary: longIdentifier }], accountableOwner: 'owner', recommendedNextAction: 'Open the retained run and inspect its bounded response options.', impact: 'Only synthetic local records are affected.', capability: 'supported', action: { kind: 'answer_provider_request', label: 'Open synthetic provider request', target: { runId, requestId: 'permission-allow' } }, options: [{ id: 'inspect', label: 'Inspect retained request' }, { id: 'defer', label: 'Defer for owner review' }] });
  const scope = { providerId: 'codex', environmentId: 'local', executionProfile: 'native', requiredCapabilities: [], budget: { maxRuntimeMinutes: 5, maxTokens: 100 }, authority: policy, roleAssignments: [] };
  const allowedOrigins = [];
  app = createConsoleService({
    coordinator, commandToken: token, allowedOrigins, assetsDirectory: join(workspace, 'console/dist'), workCatalogObserver,
    managerConnected: { store, relayToken: 'synthetic-relay-unused' },
    hierarchy: { factory: { id: 'factory', name: 'Synthetic browser factory' }, products: [{ id: 'console', name: 'Synthetic Console project' }], pods: [{ id: 'console-ui', productId: 'console' }], workItems: [{ id: workId, label: 'Synthetic browser journey', productId: 'console', podId: 'console-ui', dependsOnWorkItemIds: [] }] },
    settings: { format: 'faktori.console-settings/v1', factory: { id: 'factory', name: 'Synthetic browser factory', catalogConfigured: true, defaults: scope }, providers: ['codex', 'claude', 'cursor'].map(id => ({ id, configured: true, configuredIds: [id], enabled: false, authentication: { status: 'unknown', detail: 'Synthetic catalog only; no provider account is contacted.' }, capabilities: [], routes: [] })), products: [{ ...scope, id: 'console', name: 'Synthetic Console project', pods: [{ ...scope, id: 'console-ui' }] }], environments: [{ id: 'local', kind: 'local' }], resourceLimits: limits, recovery: { configured: false, routineActions: [] }, generalManager: { mode: 'not_configured', reviewRouteCount: 0 } },
    ownerActions: {
      async startWork(id) { assert.equal(id, workId); calls.start++; return { runId, detail: 'synthetic_only_no_launch' }; },
      async answer(id, requestId, answer) {
        assert.equal(id, runId); assert.ok(['permission-allow', 'permission-deny'].includes(requestId)); assert.ok(['allow-once', 'deny'].includes(answer));
        calls.answer.push({ requestId, answer });
        await coordinator.record('provider.request.answered', id, { request: { requestId, method: 'session/request_permission', status: 'answered', observedAt: new Date().toISOString() } });
        return { detail: 'synthetic_answer_recorded' };
      },
      async cancel(id) { assert.equal(id, runId); calls.cancel++; return { detail: 'synthetic_cancel_recorded' }; },
      async resume(id) { assert.equal(id, runId); calls.resume++; return { detail: 'synthetic_resume_recorded' }; },
      async openRecord(id) { assert.equal(id, runId); calls.record++; return { url: `${allowedOrigins[0]}/#run` }; },
    },
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  allowedOrigins.push(url);
  report.service = { kind: 'owned-synthetic', host: '127.0.0.1', dynamicPort: true };
  browser = await chromium.launch({ headless: true });
  report.runtime = { node: process.versions.node, browser: browser.version() };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : (report.externalRequests.push(route.request().url()), route.abort()));
  context.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message)));
  const page = currentPage = await context.newPage();
  page.setDefaultTimeout(8_000);

  // Hold the state response to observe loading, then fail state and SSE separately.
  let releaseState;
  const stateGate = new Promise(resolve => { releaseState = resolve; });
  await page.route('**/api/console/state', async route => { await stateGate; await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic_state_unavailable"}' }); });
  await page.route('**/api/console/events', route => route.abort('failed'));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Connecting to your factory', exact: true })).toBeVisible();
  await screenshot(page, '390-loading');
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await expect(page.locator('.loading-skeleton span')).toHaveCount(3);
  const animationDurations = await page.locator('.loading-skeleton span').evaluateAll(elements => elements.map(element => getComputedStyle(element).animationDuration));
  assert.ok(animationDurations.every(value => value.split(',').every(duration => parseFloat(duration) <= 0.01)), `Reduced-motion loading animations: ${animationDurations}`);
  releaseState();
  await expect(page.getByRole('heading', { name: 'Connection unavailable', exact: true })).toBeVisible();
  await noOverflow(page, 'Failed initial connection');
  await screenshot(page, '390-initial-state-failed');
  await page.unroute('**/api/console/state');
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.locator('.connection')).toContainText('Disconnected');
  await expect(page.locator('.topbar h1')).toContainText('Overview');
  await screenshot(page, '390-sse-disconnected');
  await page.unroute('**/api/console/events');
  await expect(page.locator('.connection')).toContainText('Connected to factory', { timeout: 10_000 });
  check('Initial loading, failed state, failed SSE and automatic SSE recovery');
  check('Reduced-motion loading feedback', animationDurations);

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    const tested = { width, views: [], populatedDetails: [] };
    for (const view of views) {
      await navigate(page, view);
      await noOverflow(page, `${width} ${view}`);
      const boxes = await page.getByRole('navigation', { name: 'Console views' }).getByRole('button').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { x: Math.round(rect.x), y: Math.round(rect.y), width: rect.width, height: rect.height }; }));
      assert.equal(boxes.length, 8);
      assert.equal(new Set(boxes.map(box => box.x)).size, width <= 760 ? 4 : 1, `${width}: coherent navigation columns`);
      assert.equal(new Set(boxes.map(box => box.y)).size, width <= 760 ? 2 : 8, `${width}: coherent navigation rows`);
      assert.ok(boxes.every(box => box.width > 0 && box.height >= 40), `${width}: navigation hit areas`);
      if (width <= 760) {
        if (view === 'settings') await page.locator('details.session-key').evaluate(element => { element.open = true; });
        const smallInputs = await page.locator('input, select, textarea').evaluateAll(elements => elements.filter(element => element.getClientRects().length > 0 && !['checkbox', 'radio'].includes(element.type) && parseFloat(getComputedStyle(element).fontSize) < 16).map(element => ({ tag: element.tagName, label: element.getAttribute('aria-label') ?? element.name, size: getComputedStyle(element).fontSize })));
        assert.deepEqual(smallInputs, [], `${width} ${view}: mobile inputs must prevent focus zoom`);
      }
      if (view === 'projects') {
        await page.getByRole('button', { name: /Open project/ }).first().click();
        await expect(page.getByRole('button', { name: `Open run ${runId}`, exact: true })).toBeVisible();
        await projectControlLegibility(page, width);
        await noOverflow(page, `${width} populated project detail`);
        await screenshot(page, `${width}-project-detail`);
        tested.populatedDetails.push('project with plan, phase, ticket, artifact and long identifiers');
      }
      await screenshot(page, `${width}-${view}`);
      tested.views.push(view);
    }
    await openRun(page);
    await expect(page.getByRole('button', { name: 'Send response', exact: true })).toHaveCount(2);
    if (width <= 760) {
      const runInputSizes = await page.locator('.run-workspace input, .run-workspace select, .run-workspace textarea').evaluateAll(elements => elements.filter(element => element.getClientRects().length > 0).map(element => parseFloat(getComputedStyle(element).fontSize)));
      assert.ok(runInputSizes.length >= 3 && runInputSizes.every(size => size >= 16), `${width}: run permission/instruction inputs prevent focus zoom`);
    }
    await noOverflow(page, `${width} populated run detail`);
    await screenshot(page, `${width}-run-detail`);
    tested.populatedDetails.push('run with permission forms and instruction controls');
    await navigate(page, 'overview');
    await keyboardHelp(page, width);
    await navigate(page, 'artifacts');
    const beforeSkip = page.url();
    await page.getByRole('link', { name: 'Skip to content', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#console-content')).toBeFocused();
    assert.equal(page.url(), beforeSkip, 'Skip link preserves current view and hash');
    await expect(page.locator('.topbar h1')).toContainText('Artifacts');
    report.viewports.push(tested);
  }
  check('All eight views, populated project/run details, coherent navigation and no page overflow at five widths');
  check('Help dialog keyboard access, background control exclusion, Escape and return focus at five widths');
  check('Skip link keeps selected view and focuses content at five widths');
  check('Visible phone form inputs use at least 16px text');

  for (const viewport of [{ width: 844, height: 390, description: 'landscape' }, { width: 720, height: 500, description: '200-percent-equivalent-css-viewport' }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const view of views) {
      await navigate(page, view);
      await noOverflow(page, `${viewport.description} ${view}`);
    }
    const settingsButton = page.getByRole('navigation', { name: 'Console views' }).getByRole('button', { name: 'settings', exact: true });
    await settingsButton.focus();
    await page.keyboard.press('Enter');
    await expect(settingsButton).toHaveAttribute('aria-current', 'page');
    const reachable = await settingsButton.boundingBox();
    assert.ok(reachable && reachable.y >= 0 && reachable.y + reachable.height <= viewport.height + 1, `${viewport.description}: final navigation control scrolls into viewport`);
    await settingsButton.click();
    await screenshot(page, `${viewport.width}x${viewport.height}-${viewport.description}-settings`);
    check(`${viewport.description}: all views fit and Settings is keyboard/click reachable`, { width: viewport.width, height: viewport.height, actualBrowserZoom: false });
  }

  // Commands use the actual service auth/journal and synthetic owner actions.
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/console/commands' && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await setToken(page, '');
  await navigate(page, 'work');
  const beforeMissing = requests.length;
  await page.getByLabel('Eligible work ID', { exact: true }).fill(workId);
  await page.getByRole('button', { name: 'Start work', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Add your local command token');
  assert.equal(requests.length, beforeMissing, 'Missing token must not dispatch');
  await expect(page.getByLabel('Eligible work ID', { exact: true })).toHaveValue(workId);
  await expect(page.locator('#command-feedback')).toBeFocused();
  await page.getByRole('button', { name: 'Open connection settings', exact: true }).click();
  await expect(page.getByLabel('Local command token', { exact: true })).toBeFocused();
  await page.getByLabel('Local command token', { exact: true }).fill('incorrect-synthetic-token');
  await navigate(page, 'factory');
  await page.getByRole('button', { name: 'Pause admission', exact: true }).click();
  await expect(page.locator('.pending')).toContainText('401');
  const denied = requests.at(-1);
  assert.equal(coordinator.journal.events().filter(event => event.kind === 'console.command').length, 0, 'Rejected auth cannot mutate command journal');
  await screenshot(page, '390-command-authentication-denied');
  await setToken(page, token);
  await page.getByRole('button', { name: 'Replay safely', exact: true }).click();
  await pendingCleared(page);
  assert.equal(requests.at(-1).commandId, denied.commandId, 'Retry retains command identity after auth denial');
  await navigate(page, 'factory');
  await expect(page.getByRole('button', { name: 'Resume admission', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume admission', exact: true }).click();
  await pendingCleared(page);
  check('Missing token recovery, denied auth without mutation, same-identity authorized replay and admission controls');

  await navigate(page, 'work');
  await page.getByLabel('Eligible work ID', { exact: true }).fill(workId);
  await page.getByRole('button', { name: 'Start work', exact: true }).click();
  await pendingCleared(page);
  assert.equal(calls.start, 1, 'Only the synthetic start callback runs');
  await openRun(page);
  const permissionForms = page.locator('.provider-request');
  await permissionForms.filter({ hasText: 'permission-allow' }).getByRole('combobox').selectOption('allow-once');
  await permissionForms.filter({ hasText: 'permission-allow' }).getByRole('button', { name: 'Send response', exact: true }).click();
  await expect(permissionForms).toHaveCount(1);
  await permissionForms.getByRole('combobox').selectOption('deny');
  await permissionForms.getByRole('button', { name: 'Send response', exact: true }).click();
  await expect(permissionForms).toHaveCount(0);
  assert.deepEqual(calls.answer, [{ requestId: 'permission-allow', answer: 'allow-once' }, { requestId: 'permission-deny', answer: 'deny' }]);
  check('Synthetic start command and both explicit permission outcomes');

  let lostReply;
  await page.route('**/api/console/commands', async route => {
    const body = route.request().postDataJSON();
    if (body.command.type !== 'message' || lostReply) return route.continue();
    lostReply = body;
    const delivered = await route.fetch();
    assert.equal(delivered.status(), 200, 'Server committed before synthetic reply loss');
    await route.abort('failed');
  });
  await page.getByLabel('Send instruction for the next provider turn', { exact: true }).fill('Synthetic bounded instruction, never delivered to a provider.');
  await page.getByRole('button', { name: 'Queue instruction', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Replay safely', exact: true })).toBeVisible();
  await screenshot(page, '390-committed-command-reply-lost');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Replay safely', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Replay safely', exact: true }).click();
  await pendingCleared(page);
  assert.equal(requests.at(-1).commandId, lostReply.commandId, 'Replay after reload preserves original identity');
  const messages = coordinator.snapshot(runId).messages;
  assert.equal(messages.filter(message => message.messageId === `console-message-${lostReply.commandId}`).length, 1, 'Response loss and retry cannot queue instruction twice');
  await page.unroute('**/api/console/commands');
  check('Committed command reply loss, persistent pending recovery after reload and one-effect same-identity replay');

  await openRun(page);
  await page.getByRole('button', { name: 'Resume if eligible', exact: true }).click();
  await pendingCleared(page);
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await pendingCleared(page);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open authoritative record', exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  assert.equal(new URL(popup.url()).origin, url, 'Record opens only the synthetic local service');
  await popup.close();
  await pendingCleared(page);
  assert.deepEqual({ start: calls.start, resume: calls.resume, cancel: calls.cancel, record: calls.record }, { start: 1, resume: 1, cancel: 1, record: 1 });
  check('Remaining run commands complete through synthetic callbacks without provider launch');
  assert.deepEqual(report.externalRequests, [], 'No external browser traffic');
  assert.deepEqual(report.pageErrors, [], 'No uncaught runtime page errors');
  assert.equal(createHash('sha256').update(await readFile(join(workspace, 'console/dist/index.html'), 'utf8')).digest('hex'), builtDigest, 'Built Console document must stay frozen throughout acceptance');
  check('No external requests or uncaught browser runtime errors');
  report.commandRequests = requests.map(({ commandId, command }) => ({ commandId, type: command.type }));
  report.syntheticEffects = calls;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
  if (currentPage && !currentPage.isClosed()) await screenshot(currentPage, 'failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await app?.close().catch(() => {});
  await managerStore?.close().catch(() => {});
  if (coordinator) { await coordinator.release().catch(() => {}); coordinator.close(); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  report.completedAt = new Date().toISOString();
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(reportDirectory, `console-experience-${runStamp}.json`), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: report.status, report: reportPath, screenshots: report.screenshots.length, ...(report.failure ? { failure: report.failure.message } : {}) }) + '\n');
}
