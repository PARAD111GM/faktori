import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// One disposable full feature journey. The example's decisions are illustrative,
// never owner authority for a real product or permission to launch a provider.
const root = await realpath(await mkdtemp(join(tmpdir(), 'faktori-production-slice-')));
const cliPath = process.env.FAKTORI_ACCEPT_CLI ?? 'src/cli.ts';
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const save = async (name, value) => { const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path; };
try {
  const seed = JSON.parse(await readFile('examples/production/discovery-session.json', 'utf8'));
  const seedPath = await save('idea.json', seed);
  const session = cli('discovery', 'session', seedPath);
  assert.equal(session.mode, 'new_product');
  assert.equal(session.mobileCodebase, 'shared_native');
  const sessionPath = await save('session.json', session);
  const history = join(root, 'discovery.jsonl');
  cli('discovery', 'save', sessionPath, history);
  cli('discovery', 'save', sessionPath, history);
  const answerPath = await save('answer.json', { id: 'owner-answer', questionId: session.questions[0].id, ownerId: seed.ownerId, text: 'Synthetic acceptance answer: field technicians are the first users.', disposition: 'answered', source: { reference: 'synthetic://owner-answer', revision: '1' }, recordedAt: '2026-10-12T12:00:00.000Z' });
  const answered = cli('discovery', 'answer', history, answerPath);
  assert.equal(answered.revision, 2);
  assert.equal(cli('discovery', 'resume', history).answers.length, 1);
  assert.equal(cli('discovery', 'prompt', history).outputSchema.properties.status.enum[0], 'proposed');
  const beforeNative = await readFile(history, 'utf8');
  const unapprovedNative = await save('unapproved-native.json', {
    historyPath: history, proposalId: 'native.unapproved', workspacePath: root, artifactsDirectory: root,
    provider: { kind: 'codex', executable: process.execPath, model: 'synthetic', reasoning: 'high', contextIsolation: 'bounded', nativeAccessApproved: false },
    limits: { maxRuntimeMinutes: 1, maxRetries: 0, maxOutputBytes: 4096, maxResponseBytes: 1024 },
  });
  assert.throws(() => cli('discovery', 'propose', unapprovedNative));
  assert.throws(() => cli('discovery', 'draft', unapprovedNative));
  assert.equal(await readFile(history, 'utf8'), beforeNative);
  assert.throws(() => cli('discovery', 'save', sessionPath, history));
  const modelPath = await save('model-output.json', { status: 'proposed', text: 'Investigate technicians offline workflow before choosing architecture.', questions: [{ text: 'Must technicians record work offline?', topic: 'native', id: 'model.offline' }] });
  const imported = cli('discovery', 'import-proposal', history, modelPath, 'discovery.model.1');
  assert.equal(imported.revision, 3);
  assert.equal(imported.modelProposals[0].status, 'proposed');
  assert.equal(imported.modelProposals[0].source.reference, `file:${modelPath}`);
  assert.match(imported.modelProposals[0].source.revision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(cli('discovery', 'import-proposal', history, modelPath, 'discovery.model.1').revision, 3);
  await save('model-output.json', { status: 'proposed', text: 'spoofed acceptance', questions: [], ownerId: 'fixture-owner' });
  assert.throws(() => cli('discovery', 'import-proposal', history, modelPath, 'discovery.model.2'));
  const definition = JSON.parse(await readFile('examples/production/product-definition.json', 'utf8'));
  const definitionPath = await save('definition.json', definition);
  const inspected = cli('discovery', 'inspect', definitionPath);
  assert.equal(inspected.readyForDesign, true);
  assert.equal(inspected.productionReady, false);
  const hierarchy = cli('discovery', 'hierarchy', definitionPath);
  assert.equal(hierarchy.nodes[0].kind, 'planning');
  cli('discovery', 'context', definitionPath, definition.productId);
  const request = { format: 'faktori.product-delivery-request/v1', definitionDigest: inspected.definitionDigest };
  const requestPath = await save('delivery.json', request);
  assert.equal(cli('product', 'compile', definitionPath, requestPath).status, 'needs_bindings');
  const pending = structuredClone(definition);
  delete pending.definitionDecisionId;
  const pendingPath = await save('pending.json', pending);
  const pendingInspection = cli('discovery', 'inspect', pendingPath);
  const pendingRequest = await save('pending-request.json', { ...request, definitionDigest: pendingInspection.definitionDigest });
  assert.equal(cli('product', 'compile', pendingPath, pendingRequest).status, 'needs_bindings');
  request.execution = {
    loopId: 'synthetic-slice', workspace: { path: root, nativeAccessApproved: true }, artifactsDirectory: join(root, 'artifacts'),
    approval: { approved: true, approvedBy: 'synthetic-fixture-only', scopeRevision: definition.revision },
    candidate: { baseRevision: 'a'.repeat(40), dependencies: [], environmentInputs: [], inputCompleteness: 'complete' },
    provider: { kind: 'codex', model: 'gpt-6.1-sol', reasoning: 'high', contextIsolation: 'bounded', executable: '/synthetic/not-executed/codex', knownQuota: 'unknown' },
    roleRoutes: {
      implementer: [{ id: 'sol', model: 'gpt-6.1-sol', reasoning: 'high', suitability: 'bounded', availability: 'available', justification: 'Synthetic integration exercises complex execution compilation only.' }],
      reviewer: [{ id: 'review-sol', model: 'gpt-6.1-sol', reasoning: 'high', suitability: 'bounded', availability: 'available', justification: 'Synthetic independent review binding for sensitive isolation acceptance.' }],
    },
    review: { sensitive: false, requiredPasses: 1 }, toolchain: [],
    limits: { maxRuntimeMinutes: 5, maxTokens: 0, maxRepairRounds: 1 },
    acceptanceCommand: { command: process.execPath, args: ['scripts/accept-full-product.mjs'] },
  };
  request.releasePlan = { targets: [{ platform: 'web', environment: 'synthetic-only', resourceRevision: 'b'.repeat(40), releaseOwner: 'fixture-owner', artifactContract: 'revision-pinned image', distributionContract: 'owner-approved HTTPS target', postDeployAcceptance: 'full signed-in persistence and isolation journey', rollbackPlan: 'restore pinned image and compatible database' }] };
  await save('delivery.json', request);
  const compiled = cli('product', 'compile', definitionPath, requestPath);
  assert.equal(compiled.status, 'ready_for_loop');
  assert.equal(compiled.artifactHandoff.resourceEvidence, 'declared_not_observed');
  const loop = cli('product', 'loop-config', definitionPath, requestPath);
  assert.equal(loop.verification.length, 1);
  assert.equal(loop.requirements.length, definition.scope.includedRequirementIds.length);
  assert.equal(loop.candidate.dependencies.length, 2);
  assert.equal(loop.phases, undefined);
  assert.ok(loop.implementationBrief.constraints.some(value => value.includes('household')));
  assert.ok(loop.implementationBrief.constraints.some(value => value.includes(definitionPath)));
  const { parseLeanLoopConfiguration } = await import(process.env.FAKTORI_ACCEPT_MODULE ? pathToFileURL(process.env.FAKTORI_ACCEPT_MODULE).href : '../src/loop/index.ts');
  parseLeanLoopConfiguration(loop);
  request.definitionDigest = '0'.repeat(64);
  await save('delivery.json', request);
  assert.throws(() => cli('product', 'compile', definitionPath, requestPath));
  const operations = cli('product', 'operations', 'examples/production/product-operations.json');
  assert.equal(operations.productionReady, false);
  assert.ok(operations.blockers.length > 0);
  const ledger = join(root, 'interventions.jsonl');
  const entry = { id: 'missing-target', spikeId: 'synthetic', stage: 'resources', occurredAt: '2026-10-12T12:00:00.000Z', actor: 'fixture-operator', reason: 'No deployment authority supplied', action: 'Continue local preparation', outcome: 'not_verified', evidenceRefs: ['synthetic://operations-report'] };
  const entryPath = await save('entry.json', entry);
  cli('spike', 'intervention', ledger, entryPath);
  cli('spike', 'intervention', ledger, entryPath);
  assert.equal(cli('spike', 'interventions', ledger).length, 1);
  const alias = join(root, 'ledger-alias.jsonl');
  await symlink(ledger, alias);
  assert.throws(() => cli('spike', 'intervention', alias, entryPath));
  await save('entry.json', { ...entry, action: 'conflicting retry' });
  assert.throws(() => cli('spike', 'intervention', ledger, entryPath));
  console.log('PASS: discovery → scoped context → pinned loop handoff → operations blockers → durable intervention resume. Synthetic local compiler acceptance; providers and deployment unrun.');
} finally { await rm(root, { recursive: true, force: true }); }

await import('./accept-definition-draft.mjs');
await import('./accept-product-design.mjs');
