import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// One combined greenfield/live feature journey. The executable is a local
// protocol fixture, never a real provider/account or native product acceptance.
const cliPath = resolve(process.env.FAKTORI_ACCEPT_CLI ?? 'src/cli.ts');
const ext = cliPath.endsWith('.js') ? 'js' : 'ts';
const production = join(dirname(cliPath), 'production');
const kitRoot = dirname(dirname(cliPath));
const { importProductDesignDraft, productDesignDraftSources, productDesignDraftOutputSchema, renderProductDesignDraftPrompt } = await import(pathToFileURL(join(production, `design-draft.${ext}`)).href);
const { runProductDesignDraft } = await import(pathToFileURL(join(production, `design-provider.${ext}`)).href);
const { inspectProductDefinition } = await import(pathToFileURL(join(production, `discovery.${ext}`)).href);
const { productDesignDigest, serializeProductDesign, inspectProductDesign, compileProductDesignHandoff } = await import(pathToFileURL(join(production, `design.${ext}`)).href);
const { runLeanLoop } = await import(pathToFileURL(join(dirname(cliPath), `loop/index.${ext}`)).href);
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4_000_000 }));
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const save = async (path, value) => { const bytes = typeof value === 'string' ? value : JSON.stringify(value); await writeFile(path, bytes, { mode: 0o600 }); return { path, digest: hash(bytes) }; };
await mkdir(resolve('.build/design-draft-acceptance'), { recursive: true, mode: 0o700 });
const root = await realpath(await mkdtemp(resolve('.build/design-draft-acceptance/run-')));
await chmod(root, 0o700);
const targets = ['web', 'ios', 'android'];
const sharedAreas = ['domain', 'api', 'auth', 'data', 'integration', 'error', 'environment', 'migration', 'monitoring'];
const targetAreas = ['ui', 'navigation', 'device', 'runtime', 'release'];
const results = [];
function makeDesign(definition, digest) {
  const requirementIds = definition.scope.includedRequirementIds;
  const record = (id, text) => ({ id, text, sourceIds: ['owner-brief'] });
  const decisions = sharedAreas.map(area => ({ ...record(area, `${area}: household-owned persistence contract; errors retain edits; migration and rollback preserve live data`), area, target: 'shared', applicability: area === 'integration' ? 'not_applicable' : 'applicable', rationale: area === 'integration' ? 'No third-party service in the accepted scope' : 'One shared domain/backend contract supports all clients', requirementIds, apiContractIds: [], ...(area === 'api' ? { contract: { id: 'household-api-v1', text: 'GET /items and POST /items accept validated names and stable idempotency keys. Session auth and household membership gate both. Replies expose stable IDs; denied/error replies never claim persistence.', revision: `sha256:${'b'.repeat(64)}` } } : {}) }));
  decisions.push(...targets.flatMap(target => targetAreas.map(area => ({ ...record(`${target}-${area}`, `${target} ${area}: uses household-api-v1; native UI and platform navigation, device permissions and distribution are explicit target concerns`), area, target, applicability: 'applicable', rationale: 'Share domain/API revision while retaining native UI and owner-selected runtime/distribution', requirementIds, apiContractIds: ['api'] }))));
  const experiences = targets.map(platform => ({ ...record(`${platform}-shopping`, 'Sign in, open household list, add, recover and reload'), journeyId: 'shopping', platform, requirementIds, informationArchitecture: 'Authentication -> household list with existing items and add form', navigation: 'Back preserves the saved list; sign out clears private client state; reconnect refreshes the household', accessibility: 'Keyboard and native assistive navigation; meaningful labels; move focus to validation; announce errors and loading; preserve readable contrast and scaling', visualReference: { applicability: 'referenced', rationale: 'Preserve the owner requested calm list layout; source is a declaration, prototype observation pending', sourceIds: ['owner-brief'] }, states: ['loading', 'empty', 'success', 'error', 'denied', 'recovery'].map(kind => ({ kind, behavior: { loading: 'Busy indicator; preserve draft and disable duplicate submit', empty: 'Explain no saved items; add remains available', success: 'Display only saved authorized items after backend confirmation', error: 'Preserve draft; validation or server failure announced with retry', denied: 'Prompt sign in; never expose another household list', recovery: 'Retry same immutable save ID/payload, then refresh exactly once' }[kind], scenarioIds: definition.acceptanceScenarios.filter(s => kind === 'success' ? s.kind === 'positive' : kind === 'error' ? s.kind === 'negative' : kind === 'recovery' ? s.kind === 'recovery' : false).map(s => s.id) })) }));
  const groups = [['save', ['persist-items', 'valid-items']], ['recover-isolate', ['save-recovery', 'household-isolation']], ['accessibility', ['accessible-list']]];
  const slices = groups.map(([id, requirementIds]) => ({ ...record(id, `Complete ${id} user behavior across domain, backend, data and each target UI`), journeyIds: ['shopping'], requirementIds, scenarioIds: definition.acceptanceScenarios.filter(s => s.requirementIds.every(r => requirementIds.includes(r))).map(s => s.id), platforms: targets, decisionIds: decisions.map(d => d.id), layers: ['domain', 'backend', 'data', 'ui', 'runtime'], owner: 'synthetic-implementation-owner', verification: 'One complete signed-in backend/client journey including negative and recovery scenarios; evidence remains pending', releaseEvidence: 'Exact artifact/config revision, client/backend compatibility, distribution, observed regression and compatible rollback required after separate owner release authority', dependsOn: id === 'recover-isolate' ? [{ sliceId: 'save', contract: { id: 'saved-item-contract', text: 'Consume only stable IDs and idempotent saved-item results from household-api-v1; do not copy provider workspace state', revision: `sha256:${'b'.repeat(64)}` } }] : [] }));
  const design = { format: 'faktori.product-design/v1', productId: definition.productId, revision: 'design-1', definitionDigest: digest, sources: productDesignDraftSources(definition), experiences, decisions, tradeoffs: [{ ...record('native-choice', 'Reuse domain/backend while retaining target UI'), decisionIds: ['api', 'ios-ui', 'android-ui'], alternatives: ['Separate incompatible APIs would duplicate compatibility and migration risks'], consequence: 'Platform UI/device/release still require independent observed qualification' }], openQuestions: [], slices };
  if (definition.existingProduct) { const live = definition.existingProduct; design.compatibility = { baselineRevision: live.baseline.revision, supportedClientIds: live.supportedClients.map(r => r.id), contractIds: live.contracts.map(r => r.id), schemaConstraintIds: live.schemaConstraints.map(r => r.id), concurrentWorkIds: live.concurrentWork.map(r => r.id), migrationDecisionId: 'migration', regressionScenarioIds: definition.acceptanceScenarios.map(s => s.id) }; }
  return design;
}
const executable = join(root, 'fixture-codex.mjs');
await writeFile(executable, `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args=process.argv.slice(2), scenario=JSON.parse(readFileSync('scenario.json','utf8'));
let prior='';try{prior=readFileSync('calls.jsonl','utf8')}catch{}
const attempt=prior.trim()?prior.trim().split('\\n').length+1:1;
if(!['--ignore-user-config','--ignore-rules','--strict-config','--output-schema','--output-last-message'].every(flag=>args.includes(flag))||!args.includes('sandbox_mode="read-only"')||!args.includes('approval_policy="never"'))process.exit(9);
if(process.env.OPENAI_API_KEY||process.env.NODE_OPTIONS||process.env.FAKTORI_DESIGN_NONFORWARDED)process.exit(10);
const prompt=args.at(-1);
if(attempt===2&&(!prompt.includes('UNTRUSTED DATA')||!prompt.includes('CORRECTION DATA')||!prompt.includes('Unknown')))process.exit(11);
const schema=JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
function strictSchema(value){
  if(!value||typeof value!=='object')return;
  if(value.type==='object'&&(value.additionalProperties!==false||JSON.stringify([...value.required].sort())!==JSON.stringify(Object.keys(value.properties).sort())))process.exit(12);
  for(const child of Object.values(value))if(child&&typeof child==='object')strictSchema(child);
}
strictSchema(schema);
function matches(value,schema){
  if(schema.anyOf)return schema.anyOf.some(variant=>matches(value,variant));
  if(schema.enum&&!schema.enum.includes(value))return false;
  if(schema.type==='object')return value&&typeof value==='object'&&!Array.isArray(value)&&schema.required.every(key=>key in value)&&Object.keys(value).every(key=>key in schema.properties)&&Object.entries(value).every(([key,child])=>matches(child,schema.properties[key]));
  if(schema.type==='array')return Array.isArray(value)&&value.length<=(schema.maxItems??Infinity)&&value.every(child=>matches(child,schema.items));
  if(schema.type==='string')return typeof value==='string'&&value.length>=(schema.minLength??0)&&value.length<=(schema.maxLength??Infinity);
  return true;
}
appendFileSync('calls.jsonl',JSON.stringify({attempt,contextBytes:Buffer.byteLength(prompt),environmentKeys:Object.keys(process.env)})+'\\n');
await new Promise(resolve=>setTimeout(resolve,500));
const response=JSON.parse(readFileSync('response.json','utf8'));
if(attempt===1)response.design.experiences[0].states[2].scenarioIds=['missing-scenario'];
if(!matches(response,schema))process.exit(13);
writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(response));
if(scenario.mode==='auth'||scenario.mode==='quota'){process.stdout.write(JSON.stringify({type:'turn.failed',error:{code:scenario.mode==='auth'?'authentication_required':'quota_exceeded',message:scenario.mode}})+'\\n');process.exitCode=1}
else if(scenario.mode==='uncertain')process.kill(process.pid,'SIGTERM');
else process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:30}})+'\\n');
`, { mode: 0o700 });
const calls = async workspace => { try { return (await readFile(join(workspace, 'calls.jsonl'), 'utf8')).trim().split('\n').length; } catch { return 0; } };
const marker = process.env.FAKTORI_DESIGN_NONFORWARDED;
process.env.FAKTORI_DESIGN_NONFORWARDED = 'synthetic-marker';
try {
  for (const mode of ['new', 'live', 'stale', 'auth', 'quota', 'uncertain', 'default-zero', 'incomplete']) {
    const workspace = join(root, mode); await mkdir(workspace, { mode: 0o700 });
    const artifactsDirectory = join(workspace, 'artifacts'); await mkdir(artifactsDirectory, { mode: 0o700 });
    const definition = JSON.parse(await readFile(join(kitRoot, 'examples/production/product-definition.json'), 'utf8'));
    const accepted = (id, text) => ({ id, text, sourceIds: ['owner-brief'], status: 'accepted' });
    definition.platforms.targets = targets;
    definition.platforms.deviceEnvelope = [accepted('device-envelope', 'Owner selected synthetic phone OS envelope; physical proof pending')];
    definition.platforms.nativeCapabilities = [accepted('native-capabilities', 'Native UI and accessibility; no sensitive permission')];
    definition.platforms.distribution = [accepted('native-distribution', 'Local qualification only; signing/publication unapproved')];
    definition.scope.exclusions[0].text = 'Billing and invitations excluded';
    for (const requirement of definition.requirements) requirement.platforms = targets;
    for (const scenario of definition.acceptanceScenarios) scenario.platforms = targets;
    if (mode === 'live') definition.existingProduct = { baseline: { reference: 'synthetic://deployed-source', revision: 'a'.repeat(40) }, deployedArtifact: accepted('deployed-image', 'Owner declared prior image, observed proof separate'), supportedClients: [accepted('v1-clients', 'Keep web/iOS/Android clients')], contracts: [accepted('v1-api', 'Preserve API IDs')], schemaConstraints: [accepted('v1-schema', 'Additive changes preserve data')], incidents: [], telemetry: [], concurrentWork: [accepted('other-work', 'Other worker owns billing')] };
    const inspected = inspectProductDefinition(definition); assert.equal(inspected.readyForDesign, true);
    const definitionDigest = inspected.definitionDigest;
    const design = makeDesign(definition, definitionDigest);
    const response = { definitionDigest, design }, bytes = Buffer.from(JSON.stringify(response));
    const definitionPath = (await save(join(workspace, 'definition.json'), definition)).path;
    const before = await readFile(definitionPath);
    await save(join(workspace, 'response.json'), response); await save(join(workspace, 'scenario.json'), { mode });
    const config = { definitionPath, expectedDefinitionDigest: definitionDigest, proposalId: `design-${mode}`, workspacePath: workspace, artifactsDirectory, provider: { kind: 'codex', executable, model: 'synthetic', reasoning: 'medium', contextIsolation: 'bounded', nativeAccessApproved: true }, limits: { maxRuntimeMinutes: 1, maxRetries: mode === 'default-zero' ? 0 : 1, maxOutputBytes: 4096, maxResponseBytes: 64000 } };
    const prompt = renderProductDesignDraftPrompt(definition); assert.ok(prompt.includes(definition.rawIdea));
    assert.deepEqual(productDesignDraftOutputSchema(definition).properties.definitionDigest.enum, [definitionDigest]);
    if (mode === 'incomplete') {
      await mkdir(join(artifactsDirectory, `design-${hash(config.proposalId).slice(7)}`), { mode: 0o700 });
      for (let replay = 0; replay < 2; replay++) {
        const result = await runProductDesignDraft(config); assert.equal(result.status, 'rejected'); assert.equal(result.attempts, 0); assert.equal(await calls(workspace), 0);
      }
      assert.deepEqual(await readFile(definitionPath), before);
      results.push({ mode, status: 'explicit_recovery_required', attempts: 0, replayCalls: 0 }); continue;
    }
    const pending = runProductDesignDraft(config);
    if (mode === 'stale') {
      for (let i = 0; i < 100 && !await calls(workspace); i++) await new Promise(resolve => setTimeout(resolve, 20));
      await writeFile(definitionPath, Buffer.concat([before, Buffer.from('\n')]), { mode: 0o600 });
    }
    const result = await pending;
    const repair = ['new', 'live'].includes(mode);
    assert.equal(result.status, repair ? 'proposed' : ['auth', 'quota', 'uncertain'].includes(mode) ? 'provider_failed' : 'rejected', JSON.stringify(result));
    assert.equal(result.attempts, repair ? 2 : 1); assert.equal(await calls(workspace), repair ? 2 : 1);
    if (mode !== 'stale') assert.deepEqual(await readFile(definitionPath), before);
    if (!repair) { results.push({ mode, status: result.status, attempts: result.attempts, retrySuppressed: true }); continue; }
    const draft = result.draft;
    assert.equal(draft.authority, 'none'); assert.equal(draft.readyForDelivery, false); assert.equal(draft.productionReady, false);
    assert.equal(inspectProductDesign(definition, draft.design).readyForDelivery, false);
    const sourceBytes = await readFile(draft.source.reference.slice(5));
    assert.equal(draft.source.revision, hash(sourceBytes)); assert.deepEqual(draft, importProductDesignDraft(definition, { expectedDefinitionDigest: definitionDigest, sourceReference: draft.source.reference, responseBytes: sourceBytes }));
    const context1 = JSON.parse(await readFile(join(result.artifactsDirectory, 'attempt-1/attempt-context.json'), 'utf8'));
    const context2 = JSON.parse(await readFile(join(result.artifactsDirectory, 'attempt-2/attempt-context.json'), 'utf8'));
    assert.notEqual(context1.approvedInputDigest, context2.approvedInputDigest);
    assert.equal(context2.correction.priorSource.revision, hash(await readFile(join(result.artifactsDirectory, 'attempt-1/model-response.json'))));
    assert.equal(JSON.parse(await readFile(join(result.artifactsDirectory, 'attempt-1/attempt-intent.json'), 'utf8')).workItem.role, 'product_designer');
    const replay = await runProductDesignDraft(config); assert.equal(replay.status, 'already_recorded'); assert.equal(replay.attempts, 0); assert.equal(await calls(workspace), 2);
    await assert.rejects(runProductDesignDraft({ ...config, provider: { ...config.provider, reasoning: 'high' } }), /conflicts/); assert.equal(await calls(workspace), 2);
    const pure = { expectedDefinitionDigest: definitionDigest, sourceReference: 'synthetic://retained-response', responseBytes: bytes };
    const deny = mutate => { const forged = structuredClone(response); mutate(forged); assert.throws(() => importProductDesignDraft(definition, { ...pure, responseBytes: Buffer.from(JSON.stringify(forged)) })); };
    deny(value => { value.approval = { status: 'accepted' }; });
    deny(value => { value.design.ownerDecisions = []; });
    deny(value => { value.design.experiences.pop(); });
    deny(value => { value.design.sources[0].reference = 'synthetic://fabricated-observation'; });
    deny(value => { value.design.slices[0].dependsOn = [{ sliceId: value.design.slices[1].id, contract: { id: 'cycle', text: 'Cycle', revision: '1' } }]; });
    deny(value => { value.design.experiences[0].states[2].scenarioIds = ['forged']; });
    deny(value => { value.design.tradeoffs[0].id = 'design.openQuestions.bypass'; value.design.tradeoffs[0].sourceIds = ['forged-source']; value.design.tradeoffs[0].decisionIds = ['forged-decision']; });
    deny(value => {
      value.design.tradeoffs[0].id = 'design.openQuestions.collision'; value.design.tradeoffs[0].sourceIds = ['forged-source'];
      value.design.openQuestions.push({ id: 'collision.sourceIds', text: 'Unknown, unaccepted or outside-scope identity: forged-source', sourceIds: ['owner-brief'] });
    });
    const unresolved = structuredClone(response);
    unresolved.design.openQuestions.push({ id: 'owner-taste-question', text: 'Owner choice remains unresolved; preserve it without an invented answer.', sourceIds: ['owner-brief'] });
    const unresolvedDraft = importProductDesignDraft(definition, { ...pure, responseBytes: Buffer.from(JSON.stringify(unresolved)) });
    assert.equal(unresolvedDraft.unresolvedQuestions.length, 1); assert.equal(unresolvedDraft.readyForDelivery, false);
    if (mode === 'live') deny(value => { value.design.compatibility.supportedClientIds = []; });
    assert.throws(() => importProductDesignDraft(definition, { ...pure, expectedDefinitionDigest: '0'.repeat(64) }), /Stale/);
    const canonicalDesign = await save(join(workspace, 'design.json'), serializeProductDesign(draft.design));
    const approval = { ownerId: 'synthetic-owner', reference: 'synthetic://owner/separate-design-approval', revision: '1', status: 'accepted', definitionDigest, designDigest: productDesignDigest(draft.design) };
    assert.equal(inspectProductDesign(definition, draft.design, approval).readyForDelivery, true);
    const deliveryRequest = { format: 'faktori.product-delivery-request/v1', definitionDigest, definitionArtifact: { path: definitionPath, digest: hash(before) }, execution: { loopId: `synthetic-design-${mode}`, workspace: { path: workspace, nativeAccessApproved: true }, artifactsDirectory: join(workspace, 'loop'), approval: { approved: true, approvedBy: 'synthetic-owner', scopeRevision: definition.revision }, candidate: { baseRevision: 'a'.repeat(40), dependencies: [], environmentInputs: [], inputCompleteness: 'complete' }, provider: { kind: 'codex', executable: '/synthetic/never-executed/codex', model: 'synthetic', reasoning: 'medium', contextIsolation: 'bounded', knownQuota: 'unknown' }, roleRoutes: { implementer: [{ id: 'builder', model: 'synthetic', reasoning: 'medium', suitability: 'bounded', availability: 'available', justification: 'Fixture compilation only' }], reviewer: [{ id: 'reviewer', model: 'synthetic', reasoning: 'medium', suitability: 'bounded', availability: 'available', justification: 'Independent future review' }] }, review: { sensitive: false, requiredPasses: 1 }, toolchain: [], limits: { maxRuntimeMinutes: 1, maxTokens: 0, maxRepairRounds: 0 }, acceptanceCommand: { command: process.execPath, args: ['synthetic-never-executed.mjs'] } }, releasePlan: { targets: targets.map(platform => ({ platform, environment: 'synthetic-local-only', resourceRevision: 'b'.repeat(40), releaseOwner: 'synthetic-owner', artifactContract: 'Pinned artifact and API revision', distributionContract: 'Future local qualification; release unapproved', postDeployAcceptance: 'Persisted authorized recovery', rollbackPlan: 'Compatible prior artifact with retained database' })), ...(mode === 'live' ? { compatibility: { baselineRevision: definition.existingProduct.baseline.revision, supportedClientContract: 'Keep existing clients/API', migrationPlan: 'Additive migration with rollback', regressionAcceptance: 'Full existing journeys', concurrentWorkBoundary: 'Preserve billing worker' } } : {}) } };
    const request = { format: 'faktori.product-design-handoff-request/v1', designDigest: draft.designDigest, designArtifact: canonicalDesign, approval, deliveryRequest };
    deliveryRequest.requestArtifact = await save(join(workspace, 'handoff.json'), request);
    const compiled = compileProductDesignHandoff(definition, draft.design, request);
    assert.equal(compiled.status, 'ready_for_loop', JSON.stringify(compiled.requiredBindings));
    const loop = await runLeanLoop(compiled.delivery.leanConfiguration); assert.equal(loop.status, 'blocked');
    const preflight = JSON.parse(await readFile(join(workspace, 'loop/preflight.json'), 'utf8'));
    assert.equal(preflight.checks.find(check => check.id === 'dependency.product-design').passed, true);
    assert.equal(preflight.checks.find(check => check.id === 'provider.executable').passed, false);
    assert.equal(await calls(workspace), 2);
    const responsePath = await save(join(workspace, 'import-response.json'), response);
    assert.deepEqual(cli('product', 'import-design', definitionPath, responsePath.path, definitionDigest), importProductDesignDraft(definition, { ...pure, sourceReference: `file:${responsePath.path}` }));
    const cliPrompt = cli('product', 'design-prompt', definitionPath); assert.equal(cliPrompt.prompt, prompt);
    await writeFile(draft.source.reference.slice(5), '{}', { mode: 0o600 }); await assert.rejects(runProductDesignDraft(config), /changed/); assert.equal(await calls(workspace), 2);
    assert.deepEqual(await readFile(definitionPath), before);
    results.push({ mode, status: 'proposed_then_separately_accepted_and_compiled', attempts: 2, replayCalls: 0, preflight: 'design_dependency_passed_execution_blocked', tamperAndAuthorityDenied: true });
  }
  const report = { format: 'faktori.design-draft-feature-qualification/v1', status: 'passed', evaluatorAuthority: 'model-authored-human-uncalibrated', provider: 'local-protocol-fixture-only', runtimeEvidence: 'existing dependency preflight only; UI/native/device/hosting not run', cliPath, cliDigest: hash(await readFile(cliPath)), draftModuleDigest: hash(await readFile(join(production, `design-draft.${ext}`))), providerModuleDigest: hash(await readFile(join(production, `design-provider.${ext}`))), results };
  await save(join(root, 'acceptance.json'), report); console.log(`PASS: full greenfield/live design draft+repair+owner handoff; ${join(root, 'acceptance.json')}`);
} finally { if (marker === undefined) delete process.env.FAKTORI_DESIGN_NONFORWARDED; else process.env.FAKTORI_DESIGN_NONFORWARDED = marker; }
