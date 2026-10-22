import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
await mkdir(resolve('.build/native-product-cycle'),{recursive:true,mode:0o700});
const root=await mkdtemp(resolve('.build/native-product-cycle/run-'));await chmod(root,0o700);
const save=async(path,value,canonical=false)=>{const bytes=canonical?serializeProductDesign(value):JSON.stringify(value);await writeFile(path,bytes,{mode:0o600});return{path,digest:hash(bytes)};};
const environment={PATH:`${dirname(process.execPath)}:/usr/bin:/bin`,LANG:'C'};
const steps=[];const pass=name=>steps.push({name,status:'passed'});
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
const apkPath=join(root,'synthetic-native.apk'),appPath=join(root,'Synthetic.app');
await mkdir(appPath,{mode:0o700});await mkdir(join(appPath,'assets'),{mode:0o700});
await writeFile(join(appPath,'Synthetic'),'synthetic fixture executable, never installed',{mode:0o700});
await writeFile(join(appPath,'assets','bundle'),'synthetic JS fixture',{mode:0o600});
const apk=await open(apkPath,'wx',0o600);try{await apk.truncate(12*1024*1024);await apk.write(Buffer.from('synthetic APK fixture'),0,21,0);}finally{await apk.close();}
const artifacts=[await captureNativeArtifact({path:apkPath,kind:'android_apk_file'}),await captureNativeArtifact({path:appPath,kind:'ios_app_directory'})];
const sealRequest=await save(join(root,'seal-request.json'),{path:apkPath,kind:'android_apk_file'});
assert.deepEqual(cli('product','native-artifact-seal',sealRequest.path),artifacts[0]);
pass('large sparse APK and canonical iOS tree sealed via API and CLI with bounded reads');
await symlink(apkPath,join(appPath,'alias'));await assert.rejects(captureNativeArtifact({path:appPath,kind:'ios_app_directory'}),/symlink/);await unlink(join(appPath,'alias'));
await link(apkPath,join(root,'hard.apk'));await assert.rejects(captureNativeArtifact({path:apkPath,kind:'android_apk_file'}),/regular-file/);await unlink(join(root,'hard.apk'));
pass('symlink/hardlink artifact aliases denied');
const sourceFiles=await Promise.all((await readdir(candidatePath)).sort().map(async name=>{const path=join(candidatePath,name);return{path,digest:hash(await readFile(path))};}));
const snapshot=await captureCandidateSnapshot(candidatePath);
const verificationConfig={format:'faktori.candidate-verification/v1',execution:{nativeAccessApproved:true,approvedBy:'synthetic-owner'},candidate:{path:candidatePath,expectedDigest:snapshot.candidateDigest},startup:{command:process.execPath,args:['server.mjs']},identity:{command:process.execPath,args:['probe.mjs','native-identity']},check:{command:process.execPath,args:['probe.mjs','native-check']},environment,negativeControls:[{id:'scope-defect',environment:{FAULT_SCOPE:'1'},expectedFailureCode:'household-scope'}],limits:{startupTimeoutMs:10000,checkTimeoutMs:10000,shutdownTimeoutMs:3000,outputMaxBytes:65536}};
const verification=await verifyCandidateRuntime(verificationConfig);assert.equal(verification.passed,true,JSON.stringify(verification));
const verificationBinding=await save(join(root,'verification.json'),verification);
const verificationConfiguration=await save(join(root,'verification-configuration.json'),verificationConfig);
pass('genuine existing runtime verifier healthy and seeded household-scope defect with confirmed cleanup');
const observerPath=join(root,'observer.mjs');await writeFile(observerPath,await readFile(probePath),{mode:0o600});
const observerBinding={path:observerPath,digest:hash(await readFile(observerPath))};
const nativeTargets=targets.map((platform,index)=>({platform,applicationId:`dev.faktori.fixture.${platform}`,buildVersion:'fixture-1',nativeRuntimeVersion:'synthetic-runtime-1',operatingSystemVersion:'synthetic-os-1',executionTarget:platform==='ios'?'ios_simulator':'android_emulator',signing:platform==='ios'?'ad_hoc_simulator':'android_debug',distribution:'local_only',artifactDigest:artifacts[index].digest}));
const expected={productId:definition.productId,environment:'local_qualification',candidateDigest:snapshot.candidateDigest,sourceRevision:nativeDeliveryDigest(sourceFiles),artifactDigest:nativeDeliveryDigest(nativeTargets),schemaRevision:'2',sourceReference:`file:${candidatePath}`,artifactReference:'fixture://native-artifacts',platforms:targets,supportedClients:[{reference:'fixture://native-clients',revision:'1'}],contracts:[{reference:'fixture://shared-api',revision:`sha256:${'b'.repeat(64)}`}],nativeTargets,nativeBackend:{origin:'http://127.0.0.1:43210',artifactDigest:hash('synthetic backend fixture'),schemaRevision:'2',contractRevision:`sha256:${'b'.repeat(64)}`}};
const release={format:'faktori.native-local-delivery/v1',id:'native-fixture-release',productId:expected.productId,ownerId:'synthetic-owner',approved:true,releaseAuthority:'owner_native_local_observation',workspacePath:candidatePath,expected,source:{candidatePath,files:sourceFiles},verificationConfiguration,evaluatorFiles:[sourceFiles.find(f=>f.path===probePath)],observerFiles:[observerBinding],definition:definitionBinding,design:designBinding,designApproval:approvalBinding,artifacts};
const configuration=await save(join(root,'native-release.json'),release);
const metadata=join(root,'metadata.json');
const {sourceReference,artifactReference,platforms,supportedClients,contracts,...liveIdentity}=expected;await save(metadata,liveIdentity);
const runtime=join(root,'runtime.json'),database=join(root,'data.sqlite'),restored=join(root,'restored.sqlite'),journal=join(root,'live.jsonl');
let child;
async function start(){await rm(runtime,{force:true});child=spawn(process.execPath,[serverPath,runtime,database,metadata],{cwd:candidatePath,env:environment,stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',x=>errors+=x);for(let i=0;i<200;i++){try{JSON.parse(await readFile(runtime));return;}catch{}if(child.exitCode!==null)throw Error(errors);await new Promise(r=>setTimeout(r,10));}throw Error('fixture startup timeout');}
async function stop(){if(!child||child.exitCode!==null)return;const current=child;await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('fixture cleanup timeout')),4000);current.once('exit',()=>{clearTimeout(timeout);resolve();});current.kill('SIGTERM');});}
const request={format:'faktori.product-baseline-observation/v1',profile:'native_local',id:'observe-1',productId:expected.productId,ownerId:'synthetic-owner',environment:'local_qualification',journalPath:journal,expectedParentDigest:null,receipts:{configuration,verification:verificationBinding},expected,observer:{cwd:candidatePath,identity:{command:process.execPath,args:[observerPath,'live-identity',runtime]},check:{command:process.execPath,args:[observerPath,'live-check',runtime,restored]},environment,limits:{timeoutMs:10000,outputMaxBytes:65536},approval:{nativeAccessApproved:true,approvedBy:'synthetic-owner',scope:'read_only_target',scopeDigest:hash('pending')}}};
const scope=r=>{r.observer.approval.scopeDigest=productBaselineObservationScopeDigest(r);return r;};scope(request);
const readCalls=async()=>{try{return(await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').length;}catch{return 0;}};
try{
 await start();await stop();await start();
 const db=new DatabaseSync(database);await backup(db,restored);db.close();
 pass('actual local process/SQLite restart and backup persistence');
 for(const variant of ['public','physical','store','owner','artifact','observer','design','proof']){
  const bad=structuredClone(request);bad.id=`denied-${variant}`;let edited;
  if(variant==='public')bad.environment=bad.expected.environment='public_production';
  else if(variant==='physical')bad.expected.nativeTargets[0].executionTarget='physical_device';
  else if(variant==='store')bad.expected.nativeTargets[0].distribution='store';
  else if(variant==='owner')bad.observer.approval.approvedBy='foreign-owner';
  else if(variant==='artifact'){const h=await open(apkPath,'r+');try{await h.write(Buffer.from('changed'),0,7,0);}finally{await h.close();}edited='artifact';}
  else{const c=structuredClone(release);if(variant==='observer')c.observerFiles=[];if(variant==='design')c.designApproval=definitionBinding;if(variant==='proof')c.verificationConfiguration=definitionBinding;bad.receipts.configuration=await save(join(root,`bad-${variant}.json`),c);}
  const before=await readCalls();await assert.rejects(observeProductBaseline(scope(bad)));assert.equal(await readCalls(),before);
  if(edited){const h=await open(apkPath,'r+');try{await h.write(Buffer.from('synthetic APK fixture'),0,21,0);}finally{await h.close();}}
 }
 pass('public/physical/store tier, owner, artifact, observer, accepted design and verifier bypass denied before commands');
 const initial=await save(join(root,'observation-request.json'),request);
 const observed=cli('product','observe',initial.path);assert.equal(observed.status,'passed');assert.equal(observed.productionReady,false);assert.equal(observed.nativeDelivery.distributionQualified,false);assert.deepEqual(observed.nativeDelivery.targets,nativeTargets);
 const count=await readCalls();assert.deepEqual(await observeProductBaseline(request),observed);assert.equal(await readCalls(),count);
 pass('installed-compatible CLI observation with explicit native local tier and duplicate-free exact replay');
 let entries=await readProductLiveJournal(journal);
 const adoption={format:'faktori.product-baseline-adoption/v1',id:'adopt-1',productId:expected.productId,ownerId:'synthetic-owner',journalPath:journal,observationId:request.id,expectedParentDigest:entries.at(-1).digest,approved:true};
 await adoptProductBaseline(adoption);const afterAdopt=await readCalls();await adoptProductBaseline(adoption);assert.equal(await readCalls(),afterAdopt);
 pass('fresh observation at owner adoption and no duplicate retry');
 entries=await readProductLiveJournal(journal);
 const increment={format:'faktori.product-increment-start/v1',id:'increment-1',productId:expected.productId,ownerId:'synthetic-owner',journalPath:journal,adoptionId:adoption.id,expectedParentDigest:entries.at(-1).digest,sessionId:'next-native-feature',historyPath:join(root,'next-discovery.jsonl'),rawIdea:'Owner requests shared categories while preserving existing native clients',ideaSource:{reference:'fixture://owner/next-feature',revision:'1'}};
 const nextRequest=await save(join(root,'next-request.json'),increment);const next=cli('product','next-discovery',nextRequest.path);assert.deepEqual(next.platforms,targets);assert.ok(JSON.stringify(next).includes('Physical devices, production signing and distribution are not qualified'));assert.ok(JSON.stringify(next).includes(expected.sourceRevision));const afterNext=await readCalls();assert.deepEqual(await beginProductIncrement(increment),next);assert.equal(await readCalls(),afterNext);
 pass('next owner feature discovery retains adopted native/backend/client/tier context and exact retry');
 const observerBytes=await readFile(observerPath);await writeFile(observerPath,Buffer.concat([observerBytes,Buffer.from('\n// replacement')]),{mode:0o600});await assert.rejects(adoptProductBaseline(adoption),/digest/);await assert.rejects(beginProductIncrement(increment),/digest/);await writeFile(observerPath,observerBytes,{mode:0o600});
 pass('observer replacement invalidates adopted and next-cycle exact retry without execution');
 const changed=await open(apkPath,'r+');try{await changed.write(Buffer.from('changed'),0,7,0);}finally{await changed.close();}await assert.rejects(adoptProductBaseline(adoption),/artifact/);const repaired=await open(apkPath,'r+');try{await repaired.write(Buffer.from('synthetic APK fixture'),0,21,0);}finally{await repaired.close();}
 pass('large artifact drift blocks adoption replay');
 const stale={...request,id:'stale',expectedParentDigest:null};await assert.rejects(observeProductBaseline(scope(stale)),/stale/);
 entries=await readProductLiveJournal(journal);const uncertain={...request,id:'uncertain',expectedParentDigest:entries.at(-1).digest};scope(uncertain);
 const uncertainMarker=join(root,`.live-operation-${createHash('sha256').update(`${journal}:${uncertain.id}`).digest('hex')}.json`);
 await writeFile(uncertainMarker,JSON.stringify({status:'intended'}),{mode:0o600});const beforeUncertain=await readCalls();await assert.rejects(observeProductBaseline(uncertain),/incomplete/);assert.equal(await readCalls(),beforeUncertain);
 pass('stale parent and retained incomplete intent reject uncertain duplicate observer launch');
 // A post-observation artifact mutation must leave intent but no accepted record.
 const mutationCode=observerBytes.toString().replace("const [mode, stateArg, recoveryPath]", "const [mode, stateArg, recoveryPath, artifactToMutate]").replace("if (mode.endsWith('identity'))", "if (mode==='live-check' && artifactToMutate) writeFileSync(artifactToMutate,'mutated native fixture',{mode:0o700});\nif (mode.endsWith('identity'))");
 await writeFile(observerPath,mutationCode,{mode:0o600});
 const driftRelease={...release,observerFiles:[{path:observerPath,digest:hash(mutationCode)}]};const driftConfig=await save(join(root,'drift-release.json'),driftRelease);
 const drift={...request,id:'post-drift',receipts:{...request.receipts,configuration:driftConfig},expectedParentDigest:entries.at(-1).digest,observer:{...request.observer,check:{command:process.execPath,args:[observerPath,'live-check',runtime,restored,join(appPath,'Synthetic')]}}};scope(drift);
 await assert.rejects(observeProductBaseline(drift),/artifact/);assert.equal((await readProductLiveJournal(journal)).length,entries.length);const driftCalls=await readCalls();await assert.rejects(observeProductBaseline(drift));assert.equal(await readCalls(),driftCalls);
 pass('post-observer artifact drift preserves uncertain intent and prevents acceptance/relaunch');
 await stop();
 const report={format:'faktori.native-product-cycle-acceptance/v1',passed:true,steps,cliPath,evaluatorDigest:hash(await readFile(new URL(import.meta.url))),sourceFiles:await Promise.all(['native-delivery','live-product','delivery','index'].map(async name=>{const path=join(dirname(cliPath),'production',`${name}.${extension}`);return{path,digest:hash(await readFile(path))};})),limitations:['Synthetic controller native JSON/payloads only; no actual iOS/Android runtime, signing or distribution proof','Model-authored human-uncalibrated evaluator; no model, cloud, SDK, device or store effects']};
 await save(join(root,'report.json'),report);console.log(JSON.stringify({passed:true,steps:steps.length,report:join(root,'report.json')}));
}finally{await stop();}
