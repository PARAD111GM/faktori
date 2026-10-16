import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

// Model-authored, human-uncalibrated full adoption fixture. Public identity
// is a labelled local process fixture, never evidence of an actual public host.
// No provider, model, registry, network, release or account operation occurs.
process.umask(0o077);
const cliPath = resolve(process.env.FAKTORI_ACCEPT_CLI ?? 'src/cli.ts');
const extension = cliPath.endsWith('.js') ? 'js' : 'ts';
const moduleURL = pathToFileURL(join(dirname(cliPath), 'production', `live-product.${extension}`));
const { observeProductBaseline, adoptProductBaseline, beginProductIncrement, productBaselineObservationScopeDigest, readProductLiveJournal } = await import(moduleURL.href);
const { captureCandidateSnapshot, verifyCandidateRuntime } = await import(new URL(`../verification/index.${extension}`, moduleURL).href);
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4000000 }));
await mkdir(resolve('.build/existing-product-adoption'), { recursive: true, mode: 0o700 });
const root = await mkdtemp(resolve('.build/existing-product-adoption/run-')); await chmod(root, 0o700);
const save = async (path, value) => { const bytes = JSON.stringify(value); await writeFile(path, bytes, { mode: 0o600 }); return { path, digest: hash(bytes) }; };
const environment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C' };
const steps = []; const pass = name => steps.push({ name, status: 'passed' });
const candidatePath = join(root, 'candidate'); await mkdir(candidatePath, { mode: 0o700 });
const serverPath = join(candidatePath, 'server.mjs'), probePath = join(candidatePath, 'probe.mjs');
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
  console.log(JSON.stringify({format:'faktori.product-live-check/v1',...state.identity,checks:{authenticated:true,persistence:true,compatibility:true,recovery:true,outcome:true,outcomeText:'Local process fixture: scoped retained item, shared completion, old-client shape, restart and restored SQLite row observed; no public production qualification.'}}));
 }
}
`, { mode: 0o600 });
const sourceFiles = await Promise.all([serverPath, probePath].map(async path => ({ path, digest: hash(await readFile(path)) })));
const snapshot = await captureCandidateSnapshot(candidatePath);
const verificationConfig = { format: 'faktori.candidate-verification/v1', execution: { nativeAccessApproved: true, approvedBy: 'fixture-owner' }, candidate: { path: candidatePath, expectedDigest: snapshot.candidateDigest }, startup: { command: process.execPath, args: ['server.mjs'] }, identity: { command: process.execPath, args: ['probe.mjs', 'native-identity'] }, check: { command: process.execPath, args: ['probe.mjs', 'native-check'] }, environment, negativeControls: [{ id: 'scope-defect', environment: { FAULT_SCOPE: '1' }, expectedFailureCode: 'household-scope' }], limits: { startupTimeoutMs: 10000, checkTimeoutMs: 10000, shutdownTimeoutMs: 3000, outputMaxBytes: 65536 } };
const verification = await verifyCandidateRuntime(verificationConfig);
assert.equal(verification.passed, true, JSON.stringify(verification));
const verificationBinding = await save(join(root, 'verification.json'), verification);
const verificationConfiguration = await save(join(root, 'verification-configuration.json'), verificationConfig);
// The runtime observer has its own sealed entry point outside the source
// snapshot: fresh adoption must not silently execute replacement code there.
const observerPath = join(root, 'observer.mjs');
await writeFile(observerPath, await readFile(probePath), { mode: 0o600 });
const observerBinding = { path: observerPath, digest: hash(await readFile(observerPath)) };
const artifact = await save(join(root, 'oci-config.json'), { architecture: 'amd64', os: 'linux', config: { Labels: { qualification: 'local-process-fixture-only' } }, rootfs: { type: 'layers', diff_ids: [] } });
const manifest = await save(join(root, 'oci-manifest.json'), { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: artifact.digest, size: (await readFile(artifact.path)).length }, layers: [] });
const expected = { productId: 'external-fixture', environment: 'public_production', candidateDigest: snapshot.candidateDigest, sourceRevision: hash(stable(sourceFiles)), artifactDigest: artifact.digest, schemaRevision: '2', sourceReference: `file:${candidatePath}`, artifactReference: 'fixture://oci-image-config', platforms: ['web', 'ios', 'android'], supportedClients: [{ reference: 'fixture://old-web', revision: '1' }, { reference: 'fixture://native', revision: '1' }], contracts: [{ reference: 'fixture://household-api', revision: '1' }], targetOrigin: 'https://fixture.example.invalid', resourceId: 'local-process-fixture-only', releaseManifestDigest: manifest.digest };
const release = { format: 'faktori.external-hosted-release/v1', id: 'fixture-release', productId: expected.productId, ownerId: 'fixture-owner', approved: true, releaseAuthority: 'owner_recorded_external_release', workspacePath: candidatePath, expected, source: { candidatePath, files: sourceFiles }, manifest, verificationConfiguration, evaluatorFiles: [sourceFiles[1]], observerFiles: [observerBinding] };
const configuration = await save(join(root, 'external-release.json'), release);
const metadata = join(root, 'metadata.json');
const { sourceReference, artifactReference, platforms, supportedClients, contracts, ...liveIdentity } = expected;
await save(metadata, liveIdentity);
const runtime = join(root, 'runtime.json'), database = join(root, 'data.sqlite'), restored = join(root, 'restored.sqlite'), journal = join(root, 'live.jsonl');
let child;
async function start() {
 await rm(runtime,{force:true});
 child = spawn(process.execPath,[serverPath,runtime,database,metadata],{cwd:candidatePath,env:environment,stdio:['ignore','pipe','pipe']});
 let errors=''; child.stderr.on('data',x=>{errors+=x;});
 for(let i=0;i<200;i++){try{JSON.parse(await readFile(runtime));return;}catch{} if(child.exitCode!==null)throw Error(errors);await new Promise(r=>setTimeout(r,10));}
 throw Error('fixture startup timed out');
}
async function stop() { if(!child || child.exitCode!==null)return;const stopped=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');let timer;try{await Promise.race([stopped,new Promise((_,rej)=>{timer=setTimeout(()=>{child.kill('SIGKILL');rej(Error('cleanup timeout'));},3000);})]);}finally{clearTimeout(timer);} }
const count = async()=>{try{return(await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').length;}catch{return 0;}};
const head = async()=>(await readProductLiveJournal(journal)).at(-1)?.digest??null;
const request = async(id, journalPath=journal)=>{const r={format:'faktori.product-baseline-observation/v1',profile:'external_hosted',id,productId:expected.productId,ownerId:'fixture-owner',environment:'public_production',journalPath,expectedParentDigest:journalPath===journal?await head():null,receipts:{configuration,verification:verificationBinding,artifact},expected,observer:{cwd:candidatePath,identity:{command:process.execPath,args:[observerPath,'public-identity',runtime]},check:{command:process.execPath,args:[observerPath,'public-check',runtime,restored]},environment,limits:{timeoutMs:5000,outputMaxBytes:65536},approval:{nativeAccessApproved:true,approvedBy:'fixture-owner',scope:'read_only_target',scopeDigest:hash('pending')}}};r.observer.approval.scopeDigest=productBaselineObservationScopeDigest(r);return r;};
const adoption = async(id,observationId)=>({format:'faktori.product-baseline-adoption/v1',id,productId:expected.productId,ownerId:'fixture-owner',journalPath:journal,observationId,expectedParentDigest:await head(),approved:true});
const rejects = async(fn,pattern)=>assert.rejects(fn,pattern);
try {
 await start(); await stop(); await start();
 const db=new DatabaseSync(database,{readOnly:true});try{await backup(db,restored);}finally{db.close();}await chmod(restored,0o600);
 pass('genuine_native_runtime_and_seeded_scope_defect_with_restart_restore');
 const req=await request('observe-external');
 // All mismatches are tested at the same external boundary before any command.
 const before=await count();
 const bad={...req,id:'bad-manifest',expected:{...expected,releaseManifestDigest:artifact.digest}};bad.observer={...req.observer,approval:{...req.observer.approval,scopeDigest:productBaselineObservationScopeDigest(bad)}};
 await rejects(()=>observeProductBaseline(bad),/characterization|manifest/);
 const forged=await save(join(root,'forged-verification.json'),{...verification,configurationDigest:hash('unrelated')});
 const wrongVerifier={...req,id:'bad-verifier',receipts:{...req.receipts,verification:forged}};wrongVerifier.observer={...req.observer,approval:{...req.observer.approval,scopeDigest:productBaselineObservationScopeDigest(wrongVerifier)}};
 await rejects(()=>observeProductBaseline(wrongVerifier),/exact qualified native/);
 const legacy={...req,id:'no-external-profile'};delete legacy.profile;legacy.expected={...expected,sourceRevision:'a'.repeat(40)};delete legacy.expected.targetOrigin;delete legacy.expected.resourceId;delete legacy.expected.releaseManifestDigest;legacy.observer={...req.observer,approval:{...req.observer.approval,scopeDigest:productBaselineObservationScopeDigest(legacy)}};
 await rejects(()=>observeProductBaseline(legacy),/Lean|lean|configuration|format/);
 // A sealed filename in a later unused argv slot cannot qualify node -e.
 const bypassConfig=await save(join(root,'bypass-verification-configuration.json'),{...verificationConfig,check:{command:process.execPath,args:['-e','console.log("unrelated pass")',probePath]}});
 const bypassRelease=await save(join(root,'bypass-release.json'),{...release,verificationConfiguration:bypassConfig});
 const bypass={...req,id:'unused-evaluator-bypass',receipts:{...req.receipts,configuration:bypassRelease}};bypass.observer={...req.observer,approval:{...req.observer.approval,scopeDigest:productBaselineObservationScopeDigest(bypass)}};
 await rejects(()=>observeProductBaseline(bypass),/actual script at argv/);
 const observerBypass={...req,id:'unused-observer-bypass',observer:{...req.observer,identity:{command:process.execPath,args:['-e','console.log("unrelated identity")',observerPath]}}};observerBypass.observer.approval={...req.observer.approval,scopeDigest:productBaselineObservationScopeDigest(observerBypass)};
 await rejects(()=>observeProductBaseline(observerBypass),/actual script at argv/);
 assert.equal(await count(),before);
 pass('manifest_verifier_unused_evaluator_observer_bypasses_denied_without_weakening_managed_profile');
 const reqPath=(await save(join(root,'observation-request.json'),req)).path;
 assert.deepEqual(cli('product','observation-scope',reqPath),{scopeDigest:req.observer.approval.scopeDigest,executionStarted:false});
 const observed=cli('product','observe',reqPath);assert.equal(observed.status,'passed');assert.equal(observed.basis,'externally_released_and_observed_runtime');assert.equal(observed.externalRelease.factoryPublicationClaimed,false);assert.equal(observed.productionReady,false);
 const observationCalls=await count();assert.deepEqual(cli('product','observe',reqPath),observed);assert.equal(await count(),observationCalls);
 const conflict={...req,expected:{...expected,schemaRevision:'3'}};conflict.observer={...req.observer,approval:{...req.observer.approval,scopeDigest:productBaselineObservationScopeDigest(conflict)}};
 await rejects(()=>observeProductBaseline(conflict),/conflicting retry/);
 pass('controller_characterization_actual_observation_and_exact_zero_effect_replay');
 const adopt=await adoption('adopt-external',observed.id);
 const originalObserver=await readFile(observerPath);await writeFile(observerPath,Buffer.concat([originalObserver,Buffer.from('\n// replacement at the same approved path\n')]));
 const changedCalls=await count();await rejects(()=>adoptProductBaseline({...adopt,id:'changed-observer'}),/digest mismatch/);await rejects(()=>observeProductBaseline(req),/digest mismatch/);assert.equal(await count(),changedCalls);await writeFile(observerPath,originalObserver);
 const casCalls=await count();await rejects(()=>adoptProductBaseline({...adopt,id:'stale-parent',expectedParentDigest:null}),/stale journal parent/);assert.equal(await count(),casCalls);
 const adopted=cli('product','adopt',(await save(join(root,'adopt-request.json'),adopt)).path);assert.equal(adopted.environment,'public_production');assert.equal(adopted.productionReady,false);
 const adoptionCalls=await count();assert.deepEqual(await adoptProductBaseline(adopt),adopted);assert.equal(await count(),adoptionCalls);
 const next={format:'faktori.product-increment-start/v1',id:'next-discovery',productId:expected.productId,ownerId:'fixture-owner',journalPath:journal,adoptionId:adopted.id,expectedParentDigest:await head(),sessionId:'next-discovery',historyPath:join(root,'history.jsonl'),rawIdea:'Let the existing household review completion history while preserving old clients and all retained records.',ideaSource:{reference:'fixture://owner-request',revision:'1'}};
 const session=cli('product','next-discovery',(await save(join(root,'next-request.json'),next)).path);assert.equal(session.mode,'live_increment');assert.equal(session.rawIdea,next.rawIdea);assert.equal(session.existingProduct.baseline.revision,expected.sourceRevision);assert.equal(session.existingProduct.deployedArtifact.revision,artifact.digest);assert.deepEqual(session.platforms,expected.platforms);assert.ok(session.existingProduct.notes.some(n=>n.text.includes('old-web')&&n.text.includes('schema revision: 2')));assert.ok(session.existingProduct.notes.some(n=>n.text.includes('not an owner-selected priority')));
 const history=await readFile(next.historyPath);const incrementCalls=await count();assert.deepEqual(await beginProductIncrement(next),session);assert.equal(await count(),incrementCalls);assert.deepEqual(await readFile(next.historyPath),history);
 pass('sealed_observer_drift_denial_fresh_adoption_requested_discovery_preserves_baseline_clients_contracts_schema_outcome');
 // Reread proof: mutate the sealed observer path while fresh adoption is in flight.
 const drift=await adoption('drift-adoption',observed.id);await writeFile(join(root,'delay'),'delay',{mode:0o600});
 const pending=adoptProductBaseline(drift);const captured=pending.then(()=>({passed:true}),error=>({error}));
 for(let i=0;i<200;i++){try{await readFile(join(root,'delay.ready'));break;}catch{}await new Promise(r=>setTimeout(r,10));}
 const original=await readFile(observerPath);await writeFile(observerPath,Buffer.concat([original,Buffer.from('\n// concurrent code replacement\n')]));
 assert.match((await captured).error?.message??'',/digest mismatch/);await writeFile(observerPath,original);await rm(join(root,'delay'));await rm(join(root,'delay.ready'));
 const driftCalls=await count();await rejects(()=>adoptProductBaseline(drift),/incomplete/);assert.equal(await count(),driftCalls);
 pass('post_observer_sealed_dependency_drift_and_interrupted_intent_zero_relaunch');
 // A chain at the known revision cap must fail before observation effects.
 const capped=join(root,'full.jsonl');let previous=null;const lines=[];
 for(let i=0;i<400;i++){const body={format:'faktori.product-live-journal/v1',id:`entry-${i}`,kind:'observation',productId:expected.productId,revision:i+1,previousDigest:previous,requestDigest:hash('fixture'),recordedAt:'2026-10-13T00:00:00.000Z',payload:{fixture:'capacity-only'}};const entry={...body,digest:hash(stable(body))};previous=entry.digest;lines.push(JSON.stringify(entry));}
 await writeFile(capped,lines.join('\n')+'\n',{mode:0o600});const capReq=await request('capacity',capped);capReq.expectedParentDigest=previous;
 const cappedCalls=await count();await rejects(()=>observeProductBaseline(capReq),/capacity/);assert.equal(await count(),cappedCalls);
 pass('known_capacity_denied_before_effects');
 // Actual target drift is not converted into a successful owner declaration.
 await save(metadata,{...liveIdentity,resourceId:'different-local-resource'});await stop();await start();
 const stale=await request('stale-target');const denied=await observeProductBaseline(stale);assert.equal(denied.status,'failed');
 await rejects(async()=>adoptProductBaseline(await adoption('reject-stale',denied.id)),/matching passed/);
 pass('actual_origin_resource_manifest_identity_mismatch_cannot_be_adopted');
 await save(join(root,'report.json'),{format:'faktori.existing-product-adoption-acceptance/v1',status:'passed',scope:'local process/SQLite fixture only; model-authored human-uncalibrated; no actual public runtime proof',steps,moduleDigest:hash(await readFile(moduleURL)),evaluatorDigest:hash(await readFile(new URL(import.meta.url))),journalDigest:hash(await readFile(journal))});
 console.log(JSON.stringify({status:'passed',scope:'local fixture only; no public production claim',steps:steps.length,artifactsDirectory:root}));
} finally {await stop();}
