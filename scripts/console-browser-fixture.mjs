import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsoleService } from '../src/console/service.ts';
import { DurableCoordinator } from '../src/runtime/coordinator.ts';

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
  target: { factoryId: 'factory', productId: 'product', repository: 'example/faktori', branch: 'browser-proof', baseRevision: 'base', expectedRevision: 'head' },
  context: { packetRevision: 'packet@1', digest: 'packet' },
  execution: { profile: 'native', workspaceId: 'browser-workspace', workspacePath: '/private/fixture/workspace', providerId: 'codex', model: 'fixture', approvedInputDigests: [] },
  budget: { reservationId: 'browser-reservation', maxRuntimeMinutes: 5, estimatedTokens: 10, status: 'held' },
  authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
  attempt: 1, createdAt: '2026-09-05T00:00:00.000Z',
});
const token = 'browser-fixture-local-token';
const port = 43719;
const app = createConsoleService({ coordinator, commandToken: token, allowedOrigins: [`http://127.0.0.1:${port}`], assetsDirectory: join(process.cwd(), 'console', 'dist') });
const url = await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`${JSON.stringify({ url, token, runId: 'browser-run' })}\n`);

const close = async () => { await app.close(); await coordinator.release(); coordinator.close(); await rm(root, { recursive: true, force: true }); };
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
await new Promise(() => {});
