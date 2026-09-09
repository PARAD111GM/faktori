import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleService } from '../src/console/service.ts';
import { DurableCoordinator } from '../src/runtime/coordinator.ts';
import { JiraObserver } from '../src/console/jira-observer.ts';

const root = await mkdtemp(join(tmpdir(), 'faktori-console-browser-'));
const coordinator = await DurableCoordinator.open({
  factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'),
  identity: { instanceId: 'browser-fixture', pid: process.pid, processStartedAt: new Date().toISOString() },
  limits: { maxConcurrentRuns: 2, maxRetries: 1, maxRuntimeMinutes: 10, maxTokens: 100, strictSpending: false, strictSpendingSupported: false },
});
await coordinator.claim();
await coordinator.admit({
  format: 'faktori.run-intent/v1', runId: 'browser-run', admissionKey: 'browser-admission',
  workItem: { id: 'browser-work', revision: 'work@1' },
  target: { factoryId: 'factory', productId: 'console', podId: 'console-ui', repository: 'example/faktori', branch: 'browser-proof', baseRevision: 'base', expectedRevision: 'head' },
  context: { packetRevision: 'packet@1', digest: 'packet' },
  execution: { profile: 'native', workspaceId: 'browser-workspace', workspacePath: '/private/fixture/workspace', providerId: 'codex', model: 'fixture', approvedInputDigests: [] },
  budget: { reservationId: 'browser-reservation', maxRuntimeMinutes: 5, estimatedTokens: 10, status: 'held' },
  authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
  attempt: 1, createdAt: '2026-09-05T00:00:00.000Z',
});
await coordinator.record('provider.requested', 'browser-run', {
  request: {
    requestId: 'number:7',
    method: 'session/request_permission',
    prompt: 'Allow the bounded browser verification step?',
    options: ['allow-once', 'deny'],
    status: 'pending',
    observedAt: new Date().toISOString(),
  },
});
const token = 'browser-fixture-local-token';
const port = 43719;
// Explicit browser-test data; this observer never contacts a real tracker.
const jiraObserver = new JiraObserver([{ id: 'browser-jira', baseUrl: 'https://jira.example', projectKey: 'DEMO', authorizationEnv: 'FAKTORI_BROWSER_TEST_AUTH', productId: 'console', podId: 'console-ui' }], {
  environment: { FAKTORI_BROWSER_TEST_AUTH: 'Bearer browser-test-only' },
  fetcher: async () => new Response(JSON.stringify({ isLast: true, issues: [
    { key: 'DEMO-1', fields: { summary: 'Verify keyboard navigation', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, assignee: { displayName: 'Test owner' }, updated: '2026-09-09T10:00:00Z' } },
    { key: 'DEMO-2', fields: { summary: 'Review release evidence', status: { name: 'In Review', statusCategory: { key: 'indeterminate' } }, assignee: null, updated: '2026-09-09T09:00:00Z' } },
  ] }), { status: 200 }),
});
await jiraObserver.refresh();
const app = createConsoleService({
  coordinator,
  jiraObserver,
  commandToken: token,
  allowedOrigins: [`http://127.0.0.1:${port}`],
  assetsDirectory: join(process.cwd(), 'console', 'dist'),
  hierarchy: {
    factory: { id: 'factory', name: 'Browser proof factory' },
    products: [{ id: 'console', name: 'Console' }, { id: 'runtime', name: 'Runtime' }],
    pods: [{ id: 'console-ui', productId: 'console' }, { id: 'provider-runtime', productId: 'runtime' }],
    workItems: [
      { id: 'browser-work', label: 'Browser verification', productId: 'console', podId: 'console-ui', dependsOnWorkItemIds: ['runtime-work'] },
      { id: 'runtime-work', label: 'Installed provider runtime', productId: 'runtime', podId: 'provider-runtime', dependsOnWorkItemIds: [] },
    ],
  },
  ownerActions: {
    async answer(runId, requestId) {
      await coordinator.record('provider.request.answered', runId, { request: { requestId, method: 'session/request_permission', status: 'answered', observedAt: new Date().toISOString() } });
      return { detail: 'provider_request_answered' };
    },
  },
});
const url = await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`${JSON.stringify({ url, token, runId: 'browser-run' })}\n`);

const close = async () => { await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); };
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
await new Promise(() => {});
