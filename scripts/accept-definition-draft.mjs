import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// One complete greenfield/live definition handoff with authority/provenance
// denials. Synthetic owner statements are never authority for real execution.
const cliPath = process.env.FAKTORI_ACCEPT_CLI ?? 'src/cli.ts';
const modulePath = process.env.FAKTORI_ACCEPT_PRODUCTION_MODULE ?? (cliPath.endsWith('.js') ? join(dirname(resolve(cliPath)), 'production/index.js') : resolve('src/production/index.ts'));
const { importProductDefinitionDraft, productDefinitionDraftOwnerSources, productDiscoverySessionDigest, inspectProductDefinition } = await import(pathToFileURL(modulePath).href);
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const root = await realpath(await mkdtemp(join(tmpdir(), 'faktori-definition-draft-')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = async (name, value) => { const path = join(root, name); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); return path; };
const proposed = (id, text, sourceIds = ['owner.intent']) => ({ id, text, sourceIds, status: 'proposed' });
try {
  const template = JSON.parse(await readFile('examples/production/product-definition.json', 'utf8'));
  for (const mode of ['new_product', 'live_increment']) {
    const idea = { sessionId: `draft.${mode}`, productId: 'household-list', ownerId: 'synthetic-owner', rawIdea: 'A complete shared household list for web, native iOS and native Android, retaining the live product when present.', ideaSource: { reference: 'synthetic://owner/full-product-goal', revision: '1' }, platforms: ['web', 'ios', 'android'] };
    if (mode === 'live_increment') idea.existingProduct = { baseline: { reference: 'synthetic://live/source', revision: 'a'.repeat(40) }, deployedArtifact: { reference: 'synthetic://live/image', revision: 'sha256:' + 'b'.repeat(64) }, notes: [{ text: 'Retain existing web clients, API/database contracts, migration rollback and ongoing work.', source: { reference: 'synthetic://live/continuity', revision: '3' } }] };
    let session = cli('discovery', 'session', await save(`${mode}-idea.json`, idea));
    const history = join(root, `${mode}.jsonl`);
    cli('discovery', 'save', await save(`${mode}-session.json`, session), history);
    const answer = { id: 'users-original', questionId: 'interview.users', ownerId: idea.ownerId, text: 'Synthetic household members use all three clients.', disposition: 'answered', source: { reference: 'synthetic://owner/users-old', revision: '1' }, recordedAt: '2026-10-13T12:00:00.000Z' };
    session = cli('discovery', 'answer', history, await save(`${mode}-answer.json`, answer));
    const originalSource = productDefinitionDraftOwnerSources(session).find(source => source.id.startsWith('owner.answer.'));
    session = cli('discovery', 'answer', history, await save(`${mode}-corrected.json`, { ...answer, id: 'users-corrected', text: 'Synthetic household members and carers use all three clients.', source: { reference: 'synthetic://owner/users-current', revision: '2' } }));
    session = cli('discovery', 'answer', history, await save(`${mode}-unknown.json`, { ...answer, id: 'integration-unknown', questionId: 'interview.integrations', text: 'Integration applicability remains unknown.', disposition: 'unknown', source: { reference: 'synthetic://owner/unknown', revision: '1' } }));
    const before = await readFile(history);
    const digest = productDiscoverySessionDigest(session);
    const sources = productDefinitionDraftOwnerSources(session);
    const currentSource = sources.find(source => source.id.startsWith('owner.answer.'));
    assert.ok(currentSource); assert.ok(!sources.some(source => source.id === originalSource.id || source.reference === 'synthetic://owner/unknown'));
    const prompt = cli('discovery', 'definition-prompt', history);
    assert.ok(prompt.prompt.includes(idea.rawIdea));
    assert.deepEqual(prompt.outputSchema.properties.sessionDigest.enum, [digest]);
    assert.equal(Boolean(prompt.outputSchema.properties.definition.properties.existingProduct), mode === 'live_increment');
    const definition = structuredClone(template);
    delete definition.ownerDecisions; delete definition.definitionDecisionId;
    definition.rawIdea = idea.rawIdea; definition.intentRef = idea.ideaSource;
    function rewrite(value) {
      if (!value || typeof value !== 'object') return;
      if ('status' in value) value.status = 'proposed';
      if ('sourceIds' in value) value.sourceIds = value.sourceIds.map(id => id === 'owner-brief' ? 'owner.intent' : id);
      if ('platforms' in value && Array.isArray(value.platforms)) value.platforms = [...idea.platforms];
      for (const child of Object.values(value)) rewrite(child);
    }
    rewrite(definition);
    definition.sources = [sources.find(source => source.id === 'owner.intent'), currentSource, { id: 'research-proposal', kind: 'proposed_assumption', reference: `session:${session.sessionId}/assumption:research-proposal`, revision: `sha256:${digest}` }];
    definition.users[0].sourceIds = [currentSource.id];
    definition.platforms.targets = [...idea.platforms];
    definition.platforms.deviceEnvelope = [proposed('device-proposal', 'Supported device/OS envelope must be decided for native iOS/Android.')];
    definition.platforms.distribution = [proposed('store-proposal', 'Store ownership and distribution remain proposed owner decisions.')];
    definition.scope.exclusions[0].text = 'Invitations and billing may be excluded from the first proposed slice; all three clients remain in the full product goal.';
    if (idea.existingProduct) {
      definition.sources.push(...sources.filter(source => source.id.startsWith('owner.live.')));
      definition.existingProduct = { baseline: idea.existingProduct.baseline, deployedArtifact: proposed('live-deployed', 'Original owner-declared deployed artifact; not independently verified.', ['owner.live.deployed-artifact']), supportedClients: [proposed('live-clients', 'Preserve existing web clients.', ['owner.live.note.1'])], contracts: [proposed('live-contracts', 'Preserve existing API contracts.', ['owner.live.note.1'])], schemaConstraints: [proposed('live-schema', 'Preserve schema compatibility and establish rollback.', ['owner.live.note.1'])], concurrentWork: [proposed('live-work', 'Preserve concurrent changes.', ['owner.live.note.1'])], incidents: [], telemetry: [] };
    }
    const payload = { sessionDigest: digest, definition };
    const responsePath = await save(`${mode}-response.json`, payload);
    const bytes = await readFile(responsePath);
    const input = { expectedSessionDigest: digest, sourceReference: `file:${responsePath}`, responseBytes: bytes };
    const draft = cli('discovery', 'import-definition', history, responsePath, digest);
    assert.deepEqual(draft, importProductDefinitionDraft(session, input));
    assert.equal(draft.source.revision, `sha256:${hash(bytes)}`);
    assert.equal(draft.source.byteLength, bytes.length);
    assert.equal(draft.authority, 'none'); assert.equal(draft.evidenceStatus, 'model_interpretation_not_verified');
    assert.deepEqual(draft.definition.ownerDecisions, []);
    assert.deepEqual(draft.session, session);
    assert.ok(draft.unresolvedInterviewQuestionIds.includes('interview.integrations'));
    const inspection = cli('discovery', 'inspect', await save(`${mode}-definition.json`, draft.definition));
    assert.deepEqual(inspection, inspectProductDefinition(draft.definition));
    assert.equal(inspection.readyForDesign, false); assert.equal(inspection.executionReady, false); assert.equal(inspection.productionReady, false);
    assert.deepEqual(inspection.acceptedRequirementIds, []);
    assert.ok(inspection.unresolvedQuestions.some(question => question.text.includes('owner decision accepts')));
    assert.deepEqual(await readFile(history), before);
    assert.deepEqual(cli('discovery', 'import-definition', history, responsePath, digest), draft);
    assert.throws(() => importProductDefinitionDraft(session, { ...input, expectedSessionDigest: '0'.repeat(64) }), /stale/);
    const deny = mutate => { const forged = structuredClone(payload); mutate(forged); assert.throws(() => importProductDefinitionDraft(session, { ...input, responseBytes: Buffer.from(JSON.stringify(forged)) })); };
    deny(value => { value.sessionDigest = '0'.repeat(64); });
    deny(value => { value.definition.ownerDecisions = []; });
    deny(value => { value.definition.definitionDecisionId = 'forged'; });
    deny(value => { value.definition.users[0].status = 'accepted'; });
    deny(value => { value.definition.sources[0].kind = 'observed_constraint'; });
    deny(value => { value.definition.sources[1] = originalSource; value.definition.users[0].sourceIds = [originalSource.id]; });
    deny(value => { value.definition.sources[1].reference = 'synthetic://fabricated'; });
    deny(value => { value.definition.rawIdea = 'Silently replace the full goal'; });
    deny(value => { value.definition.platforms.targets = ['web']; });
    deny(value => { value.definition.sources[2].revision = 'sha256:' + '0'.repeat(64); });
    if (mode === 'live_increment') deny(value => { value.definition.existingProduct.baseline.revision = 'c'.repeat(40); });
    const compact = importProductDefinitionDraft(session, { ...input, responseBytes: Buffer.from(JSON.stringify(payload)) });
    assert.notEqual(compact.source.revision, draft.source.revision); assert.equal(compact.definitionDigest, draft.definitionDigest);
    const alias = join(root, `${mode}-response-alias.json`); await symlink(responsePath, alias);
    assert.throws(() => cli('discovery', 'import-definition', history, alias, digest));
    bytes.fill(0); assert.equal(draft.source.revision, `sha256:${hash(await readFile(responsePath))}`);
    console.log(`PASS: ${mode} raw idea → corrected/unknown owner answers → complete model draft → exact-byte import → unaccepted inspection; forged authority/provenance denied.`);
  }
} finally { await rm(root, { recursive: true, force: true }); }
