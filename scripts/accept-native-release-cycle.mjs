import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile, open, symlink, link, unlink, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

// Model-authored, human-uncalibrated controller fixture. Native payloads and
// mobile observation JSON are labelled synthetic. No SDK/device/signing/model,
// network/deployment/store operation is performed. Actual SQLite/process and
// artifact bytes are observed; this never supplies mobile runtime proof.
process.umask(0o077);
const cliPath=resolve(process.env.FAKTORI_ACCEPT_CLI??'src/cli.ts');
const extension=cliPath.endsWith('.js')?'js':'ts';
const moduleURL=pathToFileURL(join(dirname(cliPath),'production',`live-product.${extension}`));
const {observeProductBaseline,adoptProductBaseline,beginProductIncrement,productBaselineObservationScopeDigest,readProductLiveJournal}=await import(moduleURL);
const {captureNativeArtifact,nativeDeliveryDigest}=await import(new URL(`./native-delivery.${extension}`,moduleURL));
const {inspectProductDefinition}=await import(new URL(`./discovery.${extension}`,moduleURL));
const {productDesignDigest,serializeProductDesign,inspectProductDesign}=await import(new URL(`./design.${extension}`,moduleURL));
const {captureCandidateSnapshot,verifyCandidateRuntime}=await import(new URL(`../verification/index.${extension}`,moduleURL));
const kitRoot=dirname(dirname(cliPath));
const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const cli=(...args)=>JSON.parse(execFileSync(process.execPath,[cliPath,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:4000000}));
await mkdir(resolve('.build/native-release-cycle'),{recursive:true,mode:0o700});
const root=await mkdtemp(resolve('.build/native-release-cycle/run-'));await chmod(root,0o700);
const save=async(path,value,canonical=false)=>{const bytes=canonical?serializeProductDesign(value):JSON.stringify(value);await writeFile(path,bytes,{mode:0o600});return{path,digest:hash(bytes)};};
const {prepareNativeRelease,prepareNativeReleaseUpload,executeNativeRelease,inspectNativeRelease,reconcileNativeRelease,nativeReleaseApprovalScopeDigest}=await import(new URL(`./native-release.${extension}`,moduleURL));
const environment={PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,LANG:'C'};
const steps=[];const pass=name=>steps.push({name,status:'passed'});
const startedAt=Date.now();
const targets=['android','ios'];
const sharedAreas=['domain','api','auth','data','integration','error','environment','migration','monitoring'];
const targetAreas=['ui','navigation','device','runtime','release'];
function makeDesign(definition, digest) {
  const requirementIds = definition.scope.includedRequirementIds;
  const record = (id, text) => ({ id, text, sourceIds: ['owner-taste'] });
  const decisions = sharedAreas.map(area => ({ ...record(area, `${area}: household-owned persistence contract; errors retain edits; migration and rollback preserve live data`), area, target: 'shared', applicability: area === 'integration' ? 'not_applicable' : 'applicable', rationale: area === 'integration' ? 'No third-party service in the accepted scope' : 'One shared domain/backend contract supports all clients', requirementIds, apiContractIds: [], ...(area === 'api' ? { contract: { id: 'household-api-v1', text: 'GET /items and POST /items accept validated names and stable idempotency keys. Session auth and household membership gate both. Replies expose stable IDs; denied/error replies never claim persistence.', revision: `sha256:${'b'.repeat(64)}` } } : {}) }));
  decisions.push(...targets.flatMap(target => targetAreas.map(area => ({ ...record(`${target}-${area}`, `${target} ${area}: uses household-api-v1; native UI and platform navigation, device permissions and distribution are explicit target concerns`), area, target, applicability: 'applicable', rationale: 'Share domain/API revision while retaining native UI and owner-selected runtime/distribution', requirementIds, apiContractIds: ['api'] }))));
  const experiences = targets.map(platform => ({ ...record(`${platform}-shopping`, 'Sign in, open household list, add, recover and reload'), journeyId: 'shopping', platform, requirementIds, informationArchitecture: 'Authentication -> household list with existing items and add form', navigation: 'Back preserves the saved list; sign out clears private client state; reconnect refreshes the household', accessibility: 'Keyboard and native assistive navigation; meaningful labels; move focus to validation; announce errors and loading; preserve readable contrast and scaling', visualReference: { applicability: 'referenced', rationale: 'Preserve the owner requested calm list layout; source is a declaration, prototype observation pending', sourceIds: ['owner-taste'] }, states: ['loading', 'empty', 'success', 'error', 'denied', 'recovery'].map(kind => ({ kind, behavior: { loading: 'Busy indicator; preserve draft and disable duplicate submit', empty: 'Explain no saved items; add remains available', success: 'Display only saved authorized items after backend confirmation', error: 'Preserve draft; validation or server failure announced with retry', denied: 'Prompt sign in; never expose another household list', recovery: 'Retry same immutable save ID/payload, then refresh exactly once' }[kind], scenarioIds: definition.acceptanceScenarios.filter(s => kind === 'success' ? s.kind === 'positive' : kind === 'error' ? s.kind === 'negative' : kind === 'recovery' ? s.kind === 'recovery' : false).map(s => s.id) })) }));
  const groups = [['save', ['persist-items', 'valid-items']], ['recover-isolate', ['save-recovery', 'household-isolation']], ['accessibility', ['accessible-list']]];
  const slices = groups.map(([id, requirementIds]) => ({ ...record(id, `Complete ${id} user behavior across domain, backend, data and each target UI`), journeyIds: ['shopping'], requirementIds, scenarioIds: definition.acceptanceScenarios.filter(s => s.requirementIds.every(r => requirementIds.includes(r))).map(s => s.id), platforms: targets, decisionIds: decisions.map(d => d.id), layers: ['domain', 'backend', 'data', 'ui', 'runtime'], owner: 'synthetic-implementation-owner', verification: 'One complete signed-in backend/client journey including negative and recovery scenarios; evidence remains pending', releaseEvidence: 'Exact artifact/config revision, client/backend compatibility, distribution, observed regression and compatible rollback required after separate owner release authority', dependsOn: id === 'recover-isolate' ? [{ sliceId: 'save', contract: { id: 'saved-item-contract', text: 'Consume only stable IDs and idempotent saved-item results from household-api-v1; do not copy provider workspace state', revision: `sha256:${'b'.repeat(64)}` } }] : [] }));
  const design = { format: 'faktori.product-design/v1', productId: definition.productId, revision: 'design-1', definitionDigest: digest, sources: [{ id: 'owner-taste', reference: 'synthetic://owner/design-direction', revision: 'taste-1' }], experiences, decisions, tradeoffs: [{ ...record('native-choice', 'Reuse domain/backend while retaining target UI'), decisionIds: ['api', 'ios-ui', 'android-ui'], alternatives: ['Separate incompatible APIs would duplicate compatibility and migration risks'], consequence: 'Platform UI/device/release still require independent observed qualification' }], openQuestions: [], slices };
  if (definition.existingProduct) { const live = definition.existingProduct; design.compatibility = { baselineRevision: live.baseline.revision, supportedClientIds: live.supportedClients.map(r => r.id), contractIds: live.contracts.map(r => r.id), schemaConstraintIds: live.schemaConstraints.map(r => r.id), concurrentWorkIds: live.concurrentWork.map(r => r.id), migrationDecisionId: 'migration', regressionScenarioIds: definition.acceptanceScenarios.map(s => s.id) }; }
  return design;
}
function approval(definitionDigest, design) { return { ownerId: 'synthetic-owner', reference: 'synthetic://owner/design-acceptance', revision: 'acceptance-1', status: 'accepted', definitionDigest, designDigest: productDesignDigest(design) }; }

const candidatePath=join(root,'candidate');await mkdir(candidatePath,{mode:0o700});
const serverPath=join(candidatePath,'server.mjs'),probePath=join(candidatePath,'probe.mjs');
await writeFile(serverPath, String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [stateArg, databaseArg, identityArg] = process.argv.slice(2);
const statePath = stateArg || join(process.env.FAKTORI_VERIFY_DIRECTORY, 'runtime.json');
const databasePath = databaseArg || join(process.env.FAKTORI_VERIFY_DIRECTORY, 'data.sqlite');
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,household TEXT,name TEXT,done INTEGER);');
db.prepare('INSERT OR IGNORE INTO items VALUES (?,?,?,?)').run('original', 'household-a', 'retained-item', 1);
db.prepare('INSERT OR IGNORE INTO items VALUES (?,?,?,?)').run('other', 'household-b', 'private-other', 0);
const identity = identityArg ? JSON.parse(readFileSync(identityArg, 'utf8')) : {candidateDigest:process.env.FAKTORI_VERIFY_CANDIDATE_DIGEST};
writeFileSync(statePath, JSON.stringify({ identity, databasePath, defective:process.env.FAULT_SCOPE === '1', pid:process.pid }), {mode:0o600});
const timer = setInterval(()=>{},1000);
process.on('SIGTERM',()=>{clearInterval(timer);db.close();process.exit(0);});
`, { mode: 0o600 });
await writeFile(probePath, String.raw`
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [mode, stateArg, recoveryPath] = process.argv.slice(2);
const statePath = stateArg || join(process.env.FAKTORI_VERIFY_DIRECTORY,'runtime.json');
const state = JSON.parse(readFileSync(statePath,'utf8'));
process.kill(state.pid,0); // actual current fixture process, not an owner pass bit
const native = mode.startsWith('native-');
if (!native) appendFileSync(join(dirname(statePath),'calls.jsonl'),JSON.stringify({mode})+'\n',{mode:0o600});
if (mode.endsWith('identity')) console.log(JSON.stringify(native ? {format:'faktori.runtime-identity/v1',runId:process.env.FAKTORI_VERIFY_RUN_ID,candidateDigest:state.identity.candidateDigest,variant:process.env.FAKTORI_VERIFY_VARIANT} : {format:'faktori.product-live-identity/v1',...state.identity}));
else {
 const db = new DatabaseSync(state.databasePath,{readOnly:true});
 let failed;
 try {
  // The same actual SQL boundary is exercised healthy and with a seeded defect.
  const items = state.defective ? db.prepare('SELECT * FROM items').all() : db.prepare('SELECT * FROM items WHERE household=?').all('household-a');
  if (items.length!==1 || items[0].household!=='household-a') failed='household-scope';
  if (!failed) {
   assert.equal(items[0].name,'retained-item'); assert.equal(items[0].done,1);
   assert.deepEqual(items.map(({id,name})=>({id,name})),[{id:'original',name:'retained-item'}]);
  }
 } finally {db.close();}
 if (native) console.log(JSON.stringify({format:'faktori.runtime-check/v1',runId:process.env.FAKTORI_VERIFY_RUN_ID,candidateDigest:state.identity.candidateDigest,variant:process.env.FAKTORI_VERIFY_VARIANT,status:failed?'failed':'passed',...(failed?{failureCode:failed}:{})}));
 else {
  assert.equal(failed,undefined);
  const restored = new DatabaseSync(recoveryPath,{readOnly:true});
  try {assert.equal(restored.prepare('SELECT done FROM items WHERE id=?').get('original').done,1);} finally {restored.close();}
  const delay = join(dirname(statePath),'delay');
  if (existsSync(delay)) {writeFileSync(delay+'.ready','ready',{mode:0o600});await new Promise(r=>setTimeout(r,350));}
  console.log(JSON.stringify({format:'faktori.product-live-check/v1',...state.identity,nativeChecks:{nativeUI:true,lifecycle:true,artifactIdentity:true,signingIdentity:true,backendCompatibility:true},checks:{authenticated:true,persistence:true,compatibility:true,recovery:true,outcome:true,outcomeText:'Local process fixture: scoped retained item, shared completion, old-client shape, restart and restored SQLite row observed; no public production qualification.'}}));
 }
}
`, { mode: 0o600 });

const definition=JSON.parse(await readFile(join(kitRoot,'examples/production/product-definition.json'),'utf8'));
definition.platforms.targets=targets;
const accepted=(id,text)=>({id,text,sourceIds:['owner-brief'],status:'accepted'});
definition.platforms.deviceEnvelope=[accepted('envelope','Synthetic local simulator/emulator envelope; no actual device assertion')];
definition.platforms.nativeCapabilities=[accepted('capabilities','Native UI and lifecycle contract; actual mobile runtime proof is separate')];
definition.platforms.distribution=[accepted('distribution','Local qualification only; no physical device or store qualification')];
for(const r of definition.requirements)r.platforms=targets;
for(const s of definition.acceptanceScenarios)s.platforms=targets;
const discovered=inspectProductDefinition(definition);assert.equal(discovered.readyForDesign,true);
const design=makeDesign(definition,discovered.definitionDigest),ownerApproval=approval(discovered.definitionDigest,design);
assert.equal(inspectProductDesign(definition,design,ownerApproval).readyForDelivery,true);
const definitionBinding=await save(join(candidatePath,'definition.json'),definition);
const designBinding=await save(join(candidatePath,'design.json'),design,true);
const approvalBinding=await save(join(candidatePath,'design-approval.json'),ownerApproval);
pass('accepted native definition/canonical design and separate owner approval');
const sourceFiles=await Promise.all((await readdir(candidatePath)).sort().map(async name=>{const path=join(candidatePath,name);return{path,digest:hash(await readFile(path))};}));
const snapshot=await captureCandidateSnapshot(candidatePath);
const verificationConfig={format:'faktori.candidate-verification/v1',execution:{nativeAccessApproved:true,approvedBy:'synthetic-owner'},candidate:{path:candidatePath,expectedDigest:snapshot.candidateDigest},startup:{command:process.execPath,args:['server.mjs']},identity:{command:process.execPath,args:['probe.mjs','native-identity']},check:{command:process.execPath,args:['probe.mjs','native-check']},environment,negativeControls:[{id:'scope-defect',environment:{FAULT_SCOPE:'1'},expectedFailureCode:'household-scope'}],limits:{startupTimeoutMs:10000,checkTimeoutMs:10000,shutdownTimeoutMs:3000,outputMaxBytes:65536}};
const verification=await verifyCandidateRuntime(verificationConfig);assert.equal(verification.passed,true,JSON.stringify(verification));
const verificationBinding=await save(join(root,'verification.json'),verification);
const verificationConfiguration=await save(join(root,'verification-configuration.json'),verificationConfig);
pass('genuine existing runtime verifier healthy and seeded household-scope defect with confirmed cleanup');
const observerPath=join(root,'observer.mjs');await writeFile(observerPath,await readFile(probePath),{mode:0o600});
const observerBinding={path:observerPath,digest:hash(await readFile(observerPath))};

const output=join(root,'release-output');await mkdir(output,{mode:0o700});
const wrapper=join(root,'protected-release.mjs'),fixturePath=join(root,'fixture.json'),ledger=join(root,'effects.jsonl'),storeStatus=join(root,'store-status.json');
await writeFile(wrapper,String.raw`
import { readFileSync,writeFileSync,appendFileSync,existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [mode,configPath,resultOverride]=process.argv.slice(2),c=JSON.parse(readFileSync(configPath,'utf8'));
const {captureNativeArtifact}=await import(pathToFileURL(c.artifactModule));
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const effect=()=>appendFileSync(c.ledger,JSON.stringify({mode,operationId:process.env.FAKTORI_RELEASE_OPERATION_ID})+'\n',{mode:0o600});
if(mode==='build'){effect();for(const t of c.targets)writeFileSync(t.artifactPath,'SYNTHETIC '+t.platform+' archive; NOT valid IPA/AAB or native signing',{mode:0o600,flag:'wx'});console.log('synthetic vendor stdout is discarded');}
else if(mode==='upload'){effect();if(existsSync(c.failMarker))process.exit(9);}
else{
 const targets=[];for(const t of c.targets)targets.push({...t,artifact:await captureNativeArtifact({path:t.artifactPath,kind:t.artifactKind}),artifactByteDigest:sha(readFileSync(t.artifactPath))});
 const common={operationId:process.env.FAKTORI_RELEASE_OPERATION_ID,evidenceClass:'synthetic_fixture',productId:c.productId,ownerId:c.ownerId,candidateDigest:c.candidateDigest,sourceRevision:c.sourceRevision,targets};
 const o=mode==='signing'?{format:'faktori.native-signing-observation/v1',...common,backend:c.backend,accountAuthenticated:false,signingVerified:false,artifactFormatVerified:false}:{format:'faktori.native-distribution-observation/v1',...common,status:JSON.parse(readFileSync(c.storeStatus,'utf8')).status,providerReceiptId:'synthetic-provider-receipt'};
 writeFileSync(resultOverride||(mode==='signing'?c.buildResult:c.uploadResult),JSON.stringify(o),{flag:'wx',mode:0o600});
}
`,{mode:0o600});
const executableHash=createHash('sha256');for await(const chunk of createReadStream(process.execPath,{highWaterMark:256*1024}))executableHash.update(chunk);
const nodeBinding={path:process.execPath,digest:'sha256:'+executableHash.digest('hex')};
const releaseTargets=targets.map(platform=>({platform,applicationId:'dev.faktori.fixture.'+platform,buildVersion:'fixture-1',nativeRuntimeVersion:'synthetic-runtime-1',accountId:'synthetic-account',publisherId:'synthetic-publisher',signingFingerprint:hash('synthetic-upload-signing'),distributionSigningFingerprint:hash('synthetic-store-signing'),track:platform==='ios'?'testflight':'play_internal',artifactPath:join(output,platform==='ios'?'synthetic.ipa':'synthetic.aab'),artifactKind:platform==='ios'?'ios_ipa_file':'android_aab_file'}));
const backend={origin:'http://127.0.0.1:43210',artifactDigest:hash('synthetic backend fixture'),schemaRevision:'2',contractRevision:'sha256:'+'b'.repeat(64)};
const buildResult=join(output,'signing.json'),uploadResult=join(output,'distribution.json'),failMarker=join(root,'late-upload-failure');
const fixture={productId:definition.productId,ownerId:'synthetic-owner',candidateDigest:snapshot.candidateDigest,sourceRevision:nativeDeliveryDigest(sourceFiles),backend,targets:releaseTargets,artifactModule:new URL('./native-delivery.'+extension,moduleURL).pathname,ledger,storeStatus,buildResult,uploadResult,failMarker};
const fixtureBinding=await save(fixturePath,fixture);await save(storeStatus,{status:'review_pending'});
const wrapperBinding={path:wrapper,digest:hash(await readFile(wrapper))},protectedCode=[nodeBinding,wrapperBinding,fixtureBinding];
const command=mode=>({executable:process.execPath,args:[wrapper,mode,fixturePath],cwd:candidatePath,environment,timeoutMs:10000,stdoutMaxBytes:1000000,stderrMaxBytes:1000000});
const runtime=join(root,'runtime.json'),database=join(root,'data.sqlite'),restored=join(root,'restored.sqlite'),metadata=join(root,'metadata.json'),journal=join(root,'live.jsonl');
const runtimeObserver={identity:{command:process.execPath,args:[observerPath,'live-identity',runtime]},check:{command:process.execPath,args:[observerPath,'live-check',runtime,restored]},environment,limits:{timeoutMs:10000,outputMaxBytes:65536},codeFiles:[nodeBinding,observerBinding]};
const cfg={format:'faktori.native-release-configuration/v1',id:'native-fixture-release',productId:definition.productId,ownerId:'synthetic-owner',evidenceClass:'synthetic_fixture',workspacePath:candidatePath,outputDirectory:output,candidateDigest:snapshot.candidateDigest,sourceRevision:nativeDeliveryDigest(sourceFiles),source:{candidatePath,files:sourceFiles},definition:definitionBinding,design:designBinding,designApproval:approvalBinding,verificationConfiguration,verification:verificationBinding,evaluatorFiles:[sourceFiles.find(f=>f.path===probePath)],observerFiles:[observerBinding],runtimeObserver,backend,supportedClients:[{reference:'fixture://native-clients',revision:'1'}],contracts:[{reference:'fixture://shared-api',revision:backend.contractRevision}],targets:releaseTargets,build:{command:command('build'),observer:command('signing'),codeFiles:protectedCode,resultPath:buildResult},upload:{command:command('upload'),observer:command('distribution'),codeFiles:protectedCode,resultPath:uploadResult}};
const configBinding=await save(join(root,'configuration.json'),cfg);
const prepareRequest=await save(join(root,'prepare.json'),{format:'faktori.native-release-prepare/v1',configuration:configBinding});
const plan=cli('product','native-release-prepare',prepareRequest.path),planBinding=await save(join(root,'plan.json'),plan);
assert.equal(plan.effectsApproved,false);assert.equal(plan.productionReady,false);
const effects=async()=>{try{return(await readFile(ledger,'utf8')).trim().split('\n').filter(Boolean);}catch{return[];}};
assert.equal((await effects()).length,0);
const unqualifiedWorkspace=join(root,'unqualified-workspace');await mkdir(unqualifiedWorkspace,{mode:0o700});
for(const seeded of ['environment','argv','code','runtime-credential','candidate-cwd']){const bad=structuredClone(cfg);if(seeded==='environment')bad.build.command.environment.TOKEN='synthetic-credential';if(seeded==='argv')bad.build.command.args.push('--password','synthetic-credential');if(seeded==='code')bad.upload.codeFiles[1].digest=hash('different protected code');if(seeded==='runtime-credential')bad.runtimeObserver.environment.PASSWORD='synthetic-credential';if(seeded==='candidate-cwd'){bad.workspacePath=unqualifiedWorkspace;for(const phase of ['build','upload'])for(const operation of ['command','observer'])bad[phase][operation].cwd=unqualifiedWorkspace;}const b=await save(join(root,'seed-'+seeded+'.json'),bad);await assert.rejects(prepareNativeRelease({format:'faktori.native-release-prepare/v1',configuration:b}));}
const fifo=join(root,'protected-code-fifo');execFileSync('/usr/bin/mkfifo',['-m','600',fifo],{env:environment});const fifoCfg=structuredClone(cfg);fifoCfg.upload.codeFiles.push({path:fifo,digest:hash('fifo')});const fifoBinding=await save(join(root,'seed-fifo.json'),fifoCfg),fifoStarted=Date.now();await assert.rejects(prepareNativeRelease({format:'faktori.native-release-prepare/v1',configuration:fifoBinding}),/regular file/);assert.ok(Date.now()-fifoStarted<5000);await unlink(fifo);
assert.equal((await effects()).length,0);pass('zero-effect accepted source preparation; credential and executable binding seeds denied');
const effectApproval=async(phase,p,name)=>save(join(root,name+'.json'),{format:'faktori.native-release-approval/v1',phase,ownerId:'synthetic-owner',decisionId:name,approved:true,nativeAccessApproved:true,planDigest:p.digest,scopeDigest:nativeReleaseApprovalScopeDigest(phase,p)});
const buildApproval=await effectApproval('build_sign_export',plan,'build-owner-decision');
const buildDir=join(root,'build-receipts');await mkdir(buildDir,{mode:0o700});
const buildRequest={format:'faktori.native-release-execute/v1',phase:'build_sign_export',plan:planBinding,approval:buildApproval,receiptDirectory:buildDir},buildRequestBinding=await save(join(root,'build-request.json'),buildRequest);
const built=cli('product','native-release-build',buildRequestBinding.path);assert.equal(built.status,'candidate_prepared');assert.equal(built.nativeSigningQualified,false);assert.equal(built.targets.length,2);assert.equal((await effects()).length,1);
assert.deepEqual(await executeNativeRelease(buildRequest),built);assert.equal((await effects()).length,1);
const builtBinding={path:join(buildDir,'build_sign_export.receipt.json'),digest:hash(await readFile(join(buildDir,'build_sign_export.receipt.json')))};
const up=await save(join(root,'upload-prepare.json'),{format:'faktori.native-release-upload-prepare/v1',plan:planBinding,buildReceipt:builtBinding}),uploadPlan=cli('product','native-release-upload-prepare',up.path),uploadPlanBinding=await save(join(root,'upload-plan.json'),uploadPlan);
assert.deepEqual(uploadPlan.targets,built.targets);assert.equal(uploadPlan.uploadApproved,false);
const uploadDir=join(root,'upload-receipts');await mkdir(uploadDir,{mode:0o700});
await assert.rejects(executeNativeRelease({format:'faktori.native-release-execute/v1',phase:'upload',plan:uploadPlanBinding,approval:buildApproval,receiptDirectory:uploadDir}));assert.equal((await effects()).length,1);
pass('actual archive bytes sealed before separate upload approval; build permission cannot upload; exact build replay no effect');
const uploadApproval=await effectApproval('upload',uploadPlan,'upload-owner-decision');
const uploadRequest={format:'faktori.native-release-execute/v1',phase:'upload',plan:uploadPlanBinding,approval:uploadApproval,receiptDirectory:uploadDir},ur=await save(join(root,'upload-request.json'),uploadRequest),pending=cli('product','native-release-upload',ur.path);
assert.equal(pending.status,'submitted_pending_review');assert.equal((await effects()).length,2);assert.deepEqual(await executeNativeRelease(uploadRequest),pending);assert.equal((await effects()).length,2);
const pendingBinding={path:join(uploadDir,'upload.receipt.json'),digest:hash(await readFile(join(uploadDir,'upload.receipt.json')))};
const baseExpected={productId:definition.productId,environment:'local_qualification',candidateDigest:snapshot.candidateDigest,sourceRevision:plan.sourceRevision,artifactDigest:nativeDeliveryDigest(built.targets),schemaRevision:'2',sourceReference:'file:'+candidatePath,artifactReference:'fixture://synthetic-distribution-only',platforms:targets,supportedClients:cfg.supportedClients,contracts:cfg.contracts,nativeReleasedTargets:built.targets,nativeBackend:backend,nativeReleaseReceiptDigest:pendingBinding.digest};
const releaseConfig=(receipt,expected)=>({format:'faktori.native-release-observation/v1',id:'owner-native-distribution',approved:true,releaseAuthority:'owner_native_distribution_observation',productId:definition.productId,ownerId:'synthetic-owner',workspacePath:candidatePath,expected,releasePlan:planBinding,releaseReceipt:receipt,source:cfg.source,verificationConfiguration,evaluatorFiles:cfg.evaluatorFiles,observerFiles:cfg.observerFiles});
const requestFor=async(receipt,expected,name)=>{const configuration=await save(join(root,name+'-configuration.json'),releaseConfig(receipt,expected));const {codeFiles,...observer}=runtimeObserver;const r={format:'faktori.product-baseline-observation/v1',profile:'native_release',id:name,productId:definition.productId,ownerId:'synthetic-owner',environment:expected.environment,journalPath:journal,expectedParentDigest:null,receipts:{configuration,verification:verificationBinding},expected,observer:{...observer,cwd:candidatePath,approval:{nativeAccessApproved:true,approvedBy:'synthetic-owner',scope:'read_only_target',scopeDigest:hash('pending')}}};r.observer.approval.scopeDigest=productBaselineObservationScopeDigest(r);return r;};
await assert.rejects(observeProductBaseline(await requestFor(pendingBinding,baseExpected,'pending-denial')),/pending/);assert.equal((await effects()).length,2);
await save(storeStatus,{status:'available'});
const recoveryResult=join(output,'recovery-distribution.json'),inspection={observer:{...command('distribution'),args:[wrapper,'distribution',fixturePath,recoveryResult]},codeFiles:protectedCode,resultPath:recoveryResult},scopeDigest=nativeDeliveryDigest({receipt:pendingBinding,inspection});
const inspectionApproval=await save(join(root,'inspect-owner.json'),{format:'faktori.native-release-inspection-approval/v1',ownerId:'synthetic-owner',decisionId:'inspect-owner',approved:true,nativeAccessApproved:true,scope:'read_only_target',scopeDigest});
const recoveryDir=join(root,'recovery-receipts');await mkdir(recoveryDir,{mode:0o700});
const recoveryRequest={format:'faktori.native-release-reconcile/v1',receipt:pendingBinding,inspection,approval:inspectionApproval,receiptDirectory:recoveryDir},rr=await save(join(root,'recovery-request.json'),recoveryRequest),recovered=cli('product','native-release-reconcile',rr.path);
assert.equal(recovered.status,'distribution_available');assert.equal(recovered.effectRetryAllowed,false);assert.equal((await effects()).length,2);assert.deepEqual(await reconcileNativeRelease(recoveryRequest),recovered);
const recoveredBinding={path:join(recoveryDir,'reconciliation.json'),digest:hash(await readFile(join(recoveryDir,'reconciliation.json')))};assert.equal(JSON.parse(await readFile(pendingBinding.path)).status,'submitted_pending_review');
pass('pending review never adopted; same-operation read-only reconciliation becomes available without second upload');
const expected={...baseExpected,nativeReleaseReceiptDigest:recoveredBinding.digest},request=await requestFor(recoveredBinding,expected,'observe-release');
const {sourceReference,artifactReference,platforms,supportedClients,contracts,...liveIdentity}=expected;await save(metadata,liveIdentity);
let child;
async function start(){await rm(runtime,{force:true});child=spawn(process.execPath,[serverPath,runtime,database,metadata],{cwd:candidatePath,env:environment,stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',x=>errors+=x);for(let i=0;i<200;i++){try{JSON.parse(await readFile(runtime));return;}catch{}if(child.exitCode!==null)throw Error(errors);await new Promise(r=>setTimeout(r,10));}throw Error('fixture startup timeout');}
async function stop(){if(!child||child.exitCode!==null)return;const current=child;await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('fixture cleanup timeout')),4000);current.once('exit',()=>{clearTimeout(timeout);resolve();});current.kill('SIGTERM');});}
const calls=async()=>{try{return(await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).length;}catch{return 0;}};
try{
 await start();await stop();await start();const db=new DatabaseSync(database);await backup(db,restored);db.close();
 const relabeled=await requestFor(recoveredBinding,{...expected,environment:'beta_distribution'},'false-beta');await assert.rejects(observeProductBaseline(relabeled),/relabeled/);assert.equal(await calls(),0);
 const obsReq=await save(join(root,'observation-request.json'),request),observed=cli('product','observe',obsReq.path);assert.equal(observed.status,'passed');assert.equal(observed.environment,'local_qualification');assert.equal(observed.nativeRelease.factoryPublicationClaimed,false);
 const n=await calls();assert.deepEqual(await observeProductBaseline(request),observed);assert.equal(await calls(),n);
 let entries=await readProductLiveJournal(journal);const adopt={format:'faktori.product-baseline-adoption/v1',id:'adopt-release',productId:definition.productId,ownerId:'synthetic-owner',journalPath:journal,observationId:request.id,expectedParentDigest:entries.at(-1).digest,approved:true};
 const adopted=await adoptProductBaseline(adopt);assert.equal(adopted.environment,'local_qualification');const a=await calls();await adoptProductBaseline(adopt);assert.equal(await calls(),a);
 entries=await readProductLiveJournal(journal);const next={format:'faktori.product-increment-start/v1',id:'next-release',productId:definition.productId,ownerId:'synthetic-owner',journalPath:journal,adoptionId:adopt.id,expectedParentDigest:entries.at(-1).digest,sessionId:'next-native-release',historyPath:join(root,'next-discovery.jsonl'),rawIdea:'Owner requests categories preserving native identity and shared backend',ideaSource:{reference:'fixture://owner/requested-next-feature',revision:'1'}};
 const nr=await save(join(root,'next-request.json'),next),session=cli('product','next-discovery',nr.path);assert.ok(JSON.stringify(session).includes('synthetic qualification remains local'));assert.ok(JSON.stringify(session).includes(expected.sourceRevision));const nx=await calls();await beginProductIncrement(next);assert.equal(await calls(),nx);
 pass('fresh scoped runtime, restart/SQLite restore, adoption/CAS and requested discovery preserve local synthetic release baseline');
 const bad={...liveIdentity,nativeReleasedTargets:structuredClone(liveIdentity.nativeReleasedTargets)};bad.nativeReleasedTargets[0].accountId='foreign-account';await save(metadata,bad);await stop();await start();
 const mismatch={...request,id:'mismatched-runtime',journalPath:join(root,'mismatch.jsonl')},failed=await observeProductBaseline(mismatch);assert.equal(failed.status,'failed');await assert.rejects(adoptProductBaseline({...adopt,id:'mismatch-adopt',journalPath:mismatch.journalPath,observationId:mismatch.id,expectedParentDigest:(await readProductLiveJournal(mismatch.journalPath)).at(-1).digest}),/passed/);await save(metadata,liveIdentity);await stop();await start();
 const wrapperBytes=await readFile(wrapper);await writeFile(wrapper,Buffer.concat([wrapperBytes,Buffer.from('\n// drift')]),{mode:0o600});const before=await calls();await assert.rejects(adoptProductBaseline(adopt),/bytes changed/);await assert.rejects(beginProductIncrement(next),/bytes changed/);assert.equal(await calls(),before);await writeFile(wrapper,wrapperBytes,{mode:0o600});
 pass('actual seeded account mismatch and protected command drift deny adoption and next-cycle replay');
 const interruptedDir=join(root,'interrupted-receipts');await mkdir(interruptedDir,{mode:0o700});await save(join(interruptedDir,'upload.intent.json'),{format:'faktori.native-release-intent/v1',phase:'upload',status:'synthetic interrupted before terminal receipt'});
 const interrupted={...uploadRequest,receiptDirectory:interruptedDir},ir=await save(join(root,'interrupted-request.json'),interrupted);assert.throws(()=>cli('product','native-release-upload',ir.path));assert.equal((await effects()).length,2);
 const inspected=await inspectNativeRelease({format:'faktori.native-release-inspect/v1',phase:'upload',receiptDirectory:interruptedDir});assert.equal(inspected.recovery,'inspect_only_no_retry');assert.equal(inspected.executionStarted,false);
 const inspectionCustody=join(root,'inspection-redaction');await mkdir(inspectionCustody,{mode:0o700});await save(join(inspectionCustody,'upload.intent.json'),{format:'faktori.native-release-intent/v1',phase:'upload',password:'synthetic-inspection-secret'});const sanitized=await inspectNativeRelease({format:'faktori.native-release-inspect/v1',phase:'upload',receiptDirectory:inspectionCustody});assert.ok(!JSON.stringify(sanitized).includes('synthetic-inspection-secret'));assert.equal(sanitized.intent.integrityQualified,false);
 pass('fresh-process interrupted intent inspection rejects duplicate upload without authority restoration');
 const uncertainOutput=join(root,'uncertain-output');await mkdir(uncertainOutput,{mode:0o700});
 const uncertainTargets=releaseTargets.map(t=>({...t,buildVersion:'fixture-uncertain',artifactPath:join(uncertainOutput,t.platform==='ios'?'synthetic.ipa':'synthetic.aab')}));
 const uncertainFixture={...fixture,targets:uncertainTargets,buildResult:join(uncertainOutput,'signing.json'),uploadResult:join(uncertainOutput,'distribution.json')};
 const ufb=await save(join(root,'uncertain-fixture.json'),uncertainFixture),uCode=[nodeBinding,wrapperBinding,ufb],uCommand=mode=>({...command(mode),args:[wrapper,mode,ufb.path]});
 const uc={...cfg,id:'uncertain-release',outputDirectory:uncertainOutput,targets:uncertainTargets,build:{command:uCommand('build'),observer:uCommand('signing'),codeFiles:uCode,resultPath:uncertainFixture.buildResult},upload:{command:uCommand('upload'),observer:uCommand('distribution'),codeFiles:uCode,resultPath:uncertainFixture.uploadResult}};
 const ucb=await save(join(root,'uncertain-configuration.json'),uc),uPlan=await prepareNativeRelease({format:'faktori.native-release-prepare/v1',configuration:ucb}),upb=await save(join(root,'uncertain-plan.json'),uPlan);
 const ubdir=join(root,'uncertain-build');await mkdir(ubdir,{mode:0o700});const uba=await effectApproval('build_sign_export',uPlan,'uncertain-build-owner');
 assert.equal((await executeNativeRelease({format:'faktori.native-release-execute/v1',phase:'build_sign_export',plan:upb,approval:uba,receiptDirectory:ubdir})).status,'candidate_prepared');
 const ubr={path:join(ubdir,'build_sign_export.receipt.json'),digest:hash(await readFile(join(ubdir,'build_sign_export.receipt.json')))},uUpload=await prepareNativeReleaseUpload({format:'faktori.native-release-upload-prepare/v1',plan:upb,buildReceipt:ubr}),uub=await save(join(root,'uncertain-upload-plan.json'),uUpload),uua=await effectApproval('upload',uUpload,'uncertain-upload-owner');
 await writeFile(failMarker,'synthetic post-submission failure',{mode:0o600});const uud=join(root,'uncertain-upload');await mkdir(uud,{mode:0o700});
 const unknown={format:'faktori.native-release-execute/v1',phase:'upload',plan:uub,approval:uua,receiptDirectory:uud},unk=await save(join(root,'uncertain-request.json'),unknown),unknownReceipt=cli('product','native-release-upload',unk.path);
 assert.equal(unknownReceipt.status,'uncertain');assert.equal(unknownReceipt.automaticRetryAllowed,false);assert.equal((await effects()).length,4);
 assert.throws(()=>cli('product','native-release-upload',unk.path));const otherDirectory=join(root,'duplicate-unknown');await mkdir(otherDirectory,{mode:0o700});await assert.rejects(executeNativeRelease({...unknown,receiptDirectory:otherDirectory}),/already claimed/);assert.equal((await effects()).length,4);
 assert.equal((await inspectNativeRelease({format:'faktori.native-release-inspect/v1',phase:'upload',receiptDirectory:uud})).receipt.status,'uncertain');
 pass('actual fixture post-effect failure retained uncertain; fresh CLI and changed receipt directory cannot duplicate submission');
 const retained=await readFile(builtBinding.path,'utf8');assert.ok(!retained.includes('synthetic vendor stdout'));assert.ok(!retained.includes('synthetic-credential'));
 const sourcePaths=[new URL('./native-release.'+extension,moduleURL).pathname,new URL('./native-delivery.'+extension,moduleURL).pathname,moduleURL.pathname,cliPath,new URL(import.meta.url).pathname];
 const report={format:'faktori.native-release-acceptance/v1',passed:true,evaluation:'model-authored-human-uncalibrated',root,elapsedMs:Date.now()-startedAt,steps,sourceBindings:await Promise.all(sourcePaths.map(async path=>({path,digest:hash(await readFile(path))}))),proofBindings:[configBinding,planBinding,builtBinding,uploadPlanBinding,pendingBinding,recoveredBinding],effects:await effects(),actualStoreCommands:0,actualNativeSigning:false,actualMobileRuntime:false,productionReady:false};
 await save(join(root,'report.json'),report);console.log(JSON.stringify({passed:true,root,steps}));
}finally{await stop();}

