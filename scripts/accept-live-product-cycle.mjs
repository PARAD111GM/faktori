import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

// One owned local authenticated/persistent A→B cycle. There is no synthetic
// GitHub publication, merge, public delivery receipt or real-user authority.
const cliPath = resolve(process.env.FAKTORI_ACCEPT_CLI ?? 'src/cli.ts');
const extension = cliPath.endsWith('.js') ? 'js' : 'ts';
const moduleURL = pathToFileURL(join(dirname(cliPath), 'production', `live-product.${extension}`));
const { observeProductBaseline, adoptProductBaseline, beginProductIncrement, productBaselineObservationScopeDigest, readProductLiveJournal } = await import(moduleURL.href);
const { verifyCandidateRuntime, captureCandidateSnapshot } = await import(new URL(`../verification/index.${extension}`, moduleURL).href);
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4000000 }));
await mkdir(resolve('.build/live-product-cycle'), { recursive: true, mode: 0o700 });
const root = await realpath(await mkdtemp(resolve('.build/live-product-cycle/run-'))); await chmod(root, 0o700);
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
const digest = value => hash(stable(value));
const save = async (path, value) => { const bytes = JSON.stringify(value); await writeFile(path, bytes, { mode: 0o600 }); return { path, digest: hash(bytes) }; };
const credentialPath = join(root, 'private-credential.json');
const bearer = randomBytes(32).toString('base64url'); await save(credentialPath, { bearer });
const statePath = join(root, 'runtime.json'), dataPath = join(root, 'durable.sqlite'), recoveryPath = join(root, 'recovery.json'), journalPath = join(root, 'product-live.jsonl');
const children = new Set();
process.umask(0o077);
const nodeEnvironment = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C' };
const steps = [];
const pass = (name, detail) => steps.push({ name, status: 'passed', detail });
const serverSource = featureB => String.raw`
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const featureB = ${featureB};
process.umask(0o077);
const scratch = process.env.FAKTORI_VERIFY_DIRECTORY;
const statePath = process.env.RUNTIME_STATE || join(scratch, 'runtime.json');
const db = new DatabaseSync(process.env.DATABASE_PATH || join(scratch, 'data.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL); PRAGMA journal_mode=WAL;');
if (featureB && !db.prepare('PRAGMA table_info(items)').all().some(c => c.name === 'completed')) db.exec('ALTER TABLE items ADD COLUMN completed INTEGER NOT NULL DEFAULT 0');
const credential = JSON.parse(readFileSync(process.env.CREDENTIAL_FILE, 'utf8')).bearer;
const release = JSON.parse(readFileSync(process.env.RELEASE_INFO, 'utf8'));
const identity = { productId: 'local-household', environment: 'local_qualification', candidateDigest: process.env.FAKTORI_VERIFY_CANDIDATE_DIGEST || release.candidateDigest, sourceRevision: release.sourceRevision, artifactDigest: 'sha256:' + createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), schemaRevision: featureB ? '2' : '1' };
const reply = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  if (req.url === '/identity') return reply(res, 200, identity);
  // This intentional defect is activated ONLY by the existing verifier's
  // owner-controlled negative environment, never by a production release.
  if (req.headers.authorization !== 'Bearer ' + credential && !(process.env.FAULT_ANONYMOUS === '1' && req.url === '/api/items')) return reply(res, 401, { error: 'Sign in required' });
  if (req.method === 'GET' && req.url === '/api/items') return reply(res, 200, { items: db.prepare('SELECT id,name FROM items ORDER BY id').all() });
  if (req.method === 'GET' && req.url === '/api/items-v2' && featureB) return reply(res, 200, { items: db.prepare('SELECT id,name,completed FROM items ORDER BY id').all() });
  if (req.method === 'POST' && req.url === '/api/items') {
    let bytes = ''; for await (const chunk of req) { bytes += chunk; if (bytes.length > 2048) return reply(res, 413, {}); }
    const { name } = JSON.parse(bytes); if (!name || typeof name !== 'string') return reply(res, 400, {});
    const id = randomUUID(); db.prepare('INSERT INTO items (id,name) VALUES (?,?)').run(id, name); return reply(res, 201, { id, name });
  }
  if (req.method === 'POST' && req.url.startsWith('/complete/') && featureB) { db.prepare('UPDATE items SET completed=1 WHERE id=?').run(req.url.slice('/complete/'.length)); return reply(res, 200, { ok: true }); }
  return reply(res, 404, {});
});
server.listen(0, '127.0.0.1', () => writeFileSync(statePath, JSON.stringify({ endpoint: 'http://127.0.0.1:' + server.address().port, identity }), { mode: 0o600 }));
process.on('SIGTERM', () => { server.close(() => { db.close(); process.exit(0); }); server.closeIdleConnections(); });
`;
const probeSource = String.raw`
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [mode, explicitState, explicitCredential, recovery, slow] = process.argv.slice(2);
const statePath = explicitState || join(process.env.FAKTORI_VERIFY_DIRECTORY, 'runtime.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const local = mode.startsWith('local-');
if (local) appendFileSync(join(dirname(statePath), 'observer-calls.jsonl'), JSON.stringify({ mode }) + '\n', { mode: 0o600 });
const current = await fetch(state.endpoint + '/identity').then(r => r.json());
if (mode === 'verify-identity') { console.log(JSON.stringify({ format: 'faktori.runtime-identity/v1', runId: process.env.FAKTORI_VERIFY_RUN_ID, candidateDigest: current.candidateDigest, variant: process.env.FAKTORI_VERIFY_VARIANT, endpoint: state.endpoint })); }
else if (mode === 'local-identity') console.log(JSON.stringify({ format: 'faktori.product-live-identity/v1', ...current }));
else {
  const credential = JSON.parse(readFileSync(explicitCredential || process.env.CREDENTIAL_FILE, 'utf8')).bearer;
  const headers = { authorization: 'Bearer ' + credential };
  const anonymous = await fetch(state.endpoint + '/api/items');
  if (mode === 'verify-check') {
    let status = anonymous.status === 401 ? 'passed' : 'failed';
    if (status === 'passed') {
      const saved = await fetch(state.endpoint + '/api/items', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'verified-item' }) }); assert.equal(saved.status, 201);
      assert.ok((await fetch(state.endpoint + '/api/items', { headers }).then(r => r.json())).items.some(i => i.name === 'verified-item'));
    }
    console.log(JSON.stringify({ format: 'faktori.runtime-check/v1', runId: process.env.FAKTORI_VERIFY_RUN_ID, candidateDigest: current.candidateDigest, variant: process.env.FAKTORI_VERIFY_VARIANT, status, ...(status === 'failed' ? { failureCode: 'anonymous-access' } : {}) }));
  } else {
    assert.equal(anonymous.status, 401);
    const list = await fetch(state.endpoint + '/api/items', { headers }).then(r => r.json()); assert.ok(list.items.some(i => i.name === 'a-base'));
    assert.ok(list.items.every(i => Object.keys(i).sort().join(',') === 'id,name'));
    const recovered = JSON.parse(readFileSync(recovery, 'utf8')); const db = new DatabaseSync(recovered.databasePath, { readOnly: true });
    try { assert.ok(db.prepare('SELECT name FROM items').all().some(i => i.name === 'a-base')); } finally { db.close(); }
    if (current.schemaRevision === '2') assert.ok((await fetch(state.endpoint + '/api/items-v2', { headers }).then(r => r.json())).items.some(i => i.name === 'a-base' && i.completed === 1));
    if (slow === 'slow') { writeFileSync(join(dirname(statePath), 'observer-delay.json'), '{}', { mode: 0o600 }); await new Promise(r => setTimeout(r, 400)); }
    console.log(JSON.stringify({ format: 'faktori.product-live-check/v1', ...current, checks: { authenticated: true, persistence: true, compatibility: true, recovery: true, outcome: true, outcomeText: current.schemaRevision === '2' ? 'The retained household item can be completed while old clients/data remain compatible.' : 'The authenticated existing household item survives restart and disposable restore.' } }));
  }
}
`;
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
  let timer; try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Owned local runtime cleanup timed out')); }, 5000); })]); } finally { clearTimeout(timer); children.delete(child); }
}
async function start(candidate, info, database = dataPath, state = statePath) {
  await rm(state, { force: true });
  const child = spawn(process.execPath, [join(candidate, 'server.mjs')], { cwd: candidate, env: { ...nodeEnvironment, RUNTIME_STATE: state, DATABASE_PATH: database, CREDENTIAL_FILE: credentialPath, RELEASE_INFO: info }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  for (let i = 0; i < 200; i++) { try { const runtime = JSON.parse(await readFile(state, 'utf8')); if ((await fetch(runtime.endpoint + '/identity')).ok) return { child, endpoint: runtime.endpoint }; } catch {} if (child.exitCode !== null) throw new Error(`Owned runtime exited: ${errors}`); await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Owned local runtime did not become ready');
}
const git = (cwd, args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Local qualification', '-c', 'user.email=local-qualification@example.invalid', ...args], { cwd, env: { ...nodeEnvironment, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function candidate(name, featureB) {
  const directory = join(root, name); await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'server.mjs'), serverSource(featureB), { mode: 0o600 }); await writeFile(join(directory, 'probe.mjs'), probeSource, { mode: 0o600 });
  git(directory, ['init', '-b', 'main']); git(directory, ['add', 'server.mjs', 'probe.mjs']); git(directory, ['commit', '-m', `Owned local ${name} qualification`]);
  const sourceRevision = git(directory, ['rev-parse', 'HEAD']); const snapshot = await captureCandidateSnapshot(directory);
  const artifactDigest = hash(await readFile(join(directory, 'server.mjs'))); const info = join(root, `${name}-release-info.json`);
  await save(info, { sourceRevision, candidateDigest: snapshot.candidateDigest });
  const verification = await verifyCandidateRuntime({ format: 'faktori.candidate-verification/v1', execution: { nativeAccessApproved: true, approvedBy: 'synthetic-owner' }, candidate: { path: directory, expectedDigest: snapshot.candidateDigest }, startup: { command: process.execPath, args: ['server.mjs'] }, identity: { command: process.execPath, args: ['probe.mjs', 'verify-identity'] }, check: { command: process.execPath, args: ['probe.mjs', 'verify-check'] }, environment: { ...nodeEnvironment, CREDENTIAL_FILE: credentialPath, RELEASE_INFO: info }, negativeControls: [{ id: 'anonymous-defect', environment: { FAULT_ANONYMOUS: '1' }, expectedFailureCode: 'anonymous-access' }], limits: { startupTimeoutMs: 10000, checkTimeoutMs: 10000, shutdownTimeoutMs: 3000, outputMaxBytes: 65536 } });
  const verificationBinding = await save(join(root, `${name}-verification.json`), verification);
  assert.equal(verification.passed, true, JSON.stringify(verification));
  const route = { id: 'not-launched', model: 'synthetic', reasoning: 'medium', suitability: 'bounded', availability: 'available', justification: 'No provider is launched by this local continuity qualification' };
  const config = { format: 'faktori.lean-loop/v1', loopId: `local-cycle-${name.toLowerCase()}`, profile: 'validation_only', workspace: { path: directory, nativeAccessApproved: true }, artifactsDirectory: join(root, `${name}-loop-artifacts`), approval: { approved: true, approvedBy: 'synthetic-owner', scopeRevision: name }, candidate: { baseRevision: sourceRevision, dependencies: [], environmentInputs: [], inputCompleteness: 'complete' }, provider: { kind: 'codex', executable: '/unselected-not-launched/codex', model: 'synthetic', reasoning: 'medium', contextIsolation: 'bounded', knownQuota: 'unknown' }, roleRoutes: { implementer: [route], reviewer: [route] }, requirements: [{ id: 'continuity', text: 'Keep authorized persistent household data and old client behavior' }], acceptanceCriteria: [{ id: 'continuity-acceptance', requirementIds: ['continuity'], expectedOutcome: 'Actual authenticated old-client/data and compatible recovery journey passes' }], verification: [{ command: process.execPath, args: ['probe.mjs', 'verify-check'] }], toolchain: [], review: { sensitive: false, requiredPasses: 1 }, limits: { maxRuntimeMinutes: 1, maxTokens: 0, maxRepairRounds: 0 } };
  return { directory, info, sourceRevision, artifactDigest, candidateDigest: snapshot.candidateDigest, configuration: await save(join(root, `${name}-configuration.json`), config), verification: verificationBinding };
}
const api = async (endpoint, url, options = {}) => { const res = await fetch(endpoint + url, { ...options, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...options.headers } }); assert.ok(res.ok, `${url}: ${res.status}`); return res.json(); };
const head = async () => (await readProductLiveJournal(journalPath)).at(-1)?.digest ?? null;
const count = async () => { try { return (await readFile(join(root, 'observer-calls.jsonl'), 'utf8')).trim().split('\n').length; } catch { return 0; } };
async function observation(c, id, journal = journalPath, slow = false) {
  const request = { format: 'faktori.product-baseline-observation/v1', id, productId: 'local-household', ownerId: 'synthetic-owner', environment: 'local_qualification', journalPath: journal, expectedParentDigest: journal === journalPath ? await head() : null, receipts: { configuration: c.configuration, verification: c.verification }, expected: { productId: 'local-household', environment: 'local_qualification', candidateDigest: c.candidateDigest, sourceRevision: c.sourceRevision, artifactDigest: c.artifactDigest, schemaRevision: c === B ? '2' : '1', sourceReference: `git:${c.directory}`, artifactReference: `file:${join(c.directory, 'server.mjs')}`, platforms: ['web'], supportedClients: [{ reference: 'local://old-web-client', revision: '1' }], contracts: [{ reference: 'local://household-api', revision: '1' }] }, observer: { cwd: c.directory, identity: { command: process.execPath, args: [join(c.directory, 'probe.mjs'), 'local-identity', statePath] }, check: { command: process.execPath, args: [join(c.directory, 'probe.mjs'), 'local-check', statePath, credentialPath, recoveryPath, ...(slow ? ['slow'] : [])] }, environment: nodeEnvironment, limits: { timeoutMs: 5000, outputMaxBytes: 65536 }, approval: { nativeAccessApproved: true, approvedBy: 'synthetic-owner', scope: 'read_only_target', scopeDigest: hash('pending') } } };
  request.observer.approval.scopeDigest = productBaselineObservationScopeDigest(request); return request;
}
const requestPath = async (name, request) => (await save(join(root, `${name}.json`), request)).path;
const adoptionRequest = async (id, observationId) => ({ format: 'faktori.product-baseline-adoption/v1', id, productId: 'local-household', ownerId: 'synthetic-owner', journalPath, observationId, expectedParentDigest: await head(), approved: true });
const incrementRequest = async (id, adoptionId, rawIdea) => ({ format: 'faktori.product-increment-start/v1', id, productId: 'local-household', ownerId: 'synthetic-owner', journalPath, adoptionId, expectedParentDigest: await head(), sessionId: id, historyPath: join(root, `${id}.jsonl`), rawIdea, ideaSource: { reference: `local://owner/${id}`, revision: '1' }, platforms: ['web'] });
let A, B, running;
try {
  A = await candidate('A', false); B = await candidate('B', true);
  pass('existing_verifier_real_runtime_and_seeded_defect', 'Actual CandidateVerificationResult for A and B, with confirmed cleanup and detected anonymous-access defect; no model or publication receipts');
  running = await start(A.directory, A.info);
  const original = await api(running.endpoint, '/api/items', { method: 'POST', body: JSON.stringify({ name: 'a-base' }) });
  await stop(running.child); running = await start(A.directory, A.info);
  assert.ok((await api(running.endpoint, '/api/items')).items.some(i => i.id === original.id));
  const snapshotPath = join(root, 'backup.sqlite'); const db = new DatabaseSync(dataPath, { readOnly: true }); try { await backup(db, snapshotPath); } finally { db.close(); }
  const restoredPath = join(root, 'restored.sqlite'); const snapshot = new DatabaseSync(snapshotPath, { readOnly: true }); try { await backup(snapshot, restoredPath); } finally { snapshot.close(); }
  const restored = await start(A.directory, A.info, restoredPath, join(root, 'restored-runtime.json'));
  assert.ok((await api(restored.endpoint, '/api/items')).items.some(i => i.id === original.id)); await stop(restored.child);
  await save(recoveryPath, { databasePath: restoredPath, sourceArtifact: A.artifactDigest, environment: 'local_qualification', passed: true });
  const reqA = await observation(A, 'observe-A'); const reqAPath = await requestPath('observe-A', reqA);
  assert.deepEqual(cli('product', 'observation-scope', reqAPath), { scopeDigest: reqA.observer.approval.scopeDigest, executionStarted: false });
  const obsA = cli('product', 'observe', reqAPath); assert.equal(obsA.status, 'passed'); assert.equal(obsA.basis, 'qualified_local_runtime'); assert.equal(obsA.productionReady, false);
  const callsA = await count(); assert.deepEqual(cli('product', 'observe', reqAPath), obsA); assert.equal(await count(), callsA);
  const adoptA = await adoptionRequest('adopt-A', obsA.id); const adoptedA = cli('product', 'adopt', await requestPath('adopt-A', adoptA)); assert.equal(adoptedA.environment, 'local_qualification'); assert.equal(adoptedA.productionReady, false);
  const nextA = await incrementRequest('feature-B-discovery', adoptedA.id, 'Let household members mark an existing list item complete without breaking current clients or stored items.');
  const nextAPath = await requestPath('next-A', nextA); const sessionA = cli('product', 'next-discovery', nextAPath);
  assert.equal(sessionA.mode, 'live_increment'); assert.equal(sessionA.rawIdea, nextA.rawIdea); assert.equal(sessionA.existingProduct.baseline.revision, A.sourceRevision); assert.equal(sessionA.existingProduct.deployedArtifact.revision, A.artifactDigest); assert.ok(sessionA.existingProduct.notes.some(n => n.text.includes('local_qualification')));
  const historyA = await readFile(nextA.historyPath); assert.deepEqual(cli('product', 'next-discovery', nextAPath), sessionA); assert.deepEqual(await readFile(nextA.historyPath), historyA);
  pass('A_observe_adopt_resume_next_discovery', 'Authenticated persistent A, restart/disposable restore, durable local-only adoption, exact idempotent replay and explicit owner feature seed');
  await assert.rejects(observeProductBaseline({ ...reqA, id: 'stale-parent' }), /stale journal/);
  const publicRequest = await observation(A, 'not-public'); publicRequest.environment = 'public_production'; publicRequest.expected.environment = 'public_production'; publicRequest.observer.approval.scopeDigest = productBaselineObservationScopeDigest(publicRequest);
  await assert.rejects(observeProductBaseline(publicRequest), /public adoption requires/);
  await stop(running.child); running = await start(B.directory, B.info); await api(running.endpoint, `/complete/${original.id}`, { method: 'POST' });
  const oldClient = await api(running.endpoint, '/api/items'); assert.deepEqual(oldClient.items.find(i => i.id === original.id), original);
  assert.equal((await api(running.endpoint, '/api/items-v2')).items.find(i => i.id === original.id).completed, 1);
  await stop(running.child); running = await start(B.directory, B.info); assert.equal((await api(running.endpoint, '/api/items-v2')).items.find(i => i.id === original.id).completed, 1);
  const staleIncrement = await incrementRequest('stale-A-increment', adoptedA.id, 'Explicit owner change while the old runtime baseline is stale.');
  await assert.rejects(beginProductIncrement(staleIncrement), /runtime identity differs/);
  await assert.rejects(readFile(staleIncrement.historyPath), { code: 'ENOENT' });
  const reqB = await observation(B, 'observe-B'); const obsB = cli('product', 'observe', await requestPath('observe-B', reqB)); assert.equal(obsB.status, 'passed');
  const adoptB = await adoptionRequest('adopt-B', obsB.id); const adoptedB = cli('product', 'adopt', await requestPath('adopt-B', adoptB));
  const nextB = await incrementRequest('next-owner-change', adoptedB.id, 'Add an owner-requested quantity field while preserving both supported clients and completed item data.');
  const sessionB = cli('product', 'next-discovery', await requestPath('next-B', nextB)); assert.equal(sessionB.existingProduct.baseline.revision, B.sourceRevision); assert.equal(sessionB.existingProduct.deployedArtifact.revision, B.artifactDigest); assert.ok(sessionB.existingProduct.notes.some(n => n.text.includes('schema revision: 2'))); assert.deepEqual(await readFile(nextA.historyPath), historyA);
  pass('B_additive_feature_old_client_data_outcome_next_cycle', 'Actual additive A→B migration retains original item ID/name and old API; completion survives restart; observed outcome and B schema/artifact/source seed next owner request');
  const verificationBytes = await readFile(B.verification.path);
  const slow = await observation(B, 'observe-delayed', journalPath, true); const delayed = await observeProductBaseline(slow); assert.equal(delayed.status, 'passed');
  const delayedAdoption = await adoptionRequest('adopt-delayed-tamper', delayed.id);
  const marker = join(root, 'observer-delay.json'); await rm(marker, { force: true });
  const pending = adoptProductBaseline(delayedAdoption);
  for (let i = 0; i < 200; i++) { try { await readFile(marker); break; } catch {} await new Promise(r => setTimeout(r, 10)); }
  await writeFile(B.verification.path, Buffer.concat([verificationBytes, Buffer.from(' ')]));
  await assert.rejects(pending, /receipt byte digest mismatch/); await writeFile(B.verification.path, verificationBytes);
  const countAfterTamper = await count(); await assert.rejects(adoptProductBaseline(delayedAdoption), /prior live operation is incomplete/); assert.equal(await count(), countAfterTamper);
  const delayedAdoptOk = await adoptionRequest('adopt-delayed-recovered', delayed.id); await adoptProductBaseline(delayedAdoptOk);
  const delayedIncrement = await incrementRequest('next-tamper-denial', delayedAdoptOk.id, 'Explicit owner follow-up held until receipt mutation is reconciled.'); await rm(marker, { force: true });
  const pendingIncrement = beginProductIncrement(delayedIncrement);
  for (let i = 0; i < 200; i++) { try { await readFile(marker); break; } catch {} await new Promise(r => setTimeout(r, 10)); }
  await writeFile(B.verification.path, Buffer.concat([verificationBytes, Buffer.from(' ')])); await assert.rejects(pendingIncrement, /receipt byte digest mismatch/); await writeFile(B.verification.path, verificationBytes);
  await assert.rejects(readFile(delayedIncrement.historyPath), { code: 'ENOENT' });
  pass('post_observer_receipt_revalidation', 'Actual concurrent verification receipt mutation blocks adoption and next discovery; no premature history and no automatic corrective command replay');
  const persistence = await observation(B, 'observe-persistence-failure'); await chmod(journalPath, 0o400);
  await assert.rejects(observeProductBaseline(persistence), /EACCES|permission denied/); await chmod(journalPath, 0o600);
  const afterFailure = await count(); await assert.rejects(observeProductBaseline(persistence), /prior live operation is incomplete/); assert.equal(await count(), afterFailure);
  pass('durable_intent_on_persistence_failure', 'Actual journal write denial after observation leaves durable intent; identical retry performs no observer commands');
  const fullPath = join(root, 'capacity.jsonl'); const full = [];
  for (let i = 0; i < 400; i++) { const body = { format: 'faktori.product-live-journal/v1', id: `capacity-${i}`, kind: 'observation', productId: 'local-household', revision: i + 1, previousDigest: full.at(-1)?.digest ?? null, requestDigest: hash(`capacity-${i}`), recordedAt: '2026-10-13T12:00:00.000Z', payload: { status: 'failed', basis: 'synthetic-capacity-control-not-release-evidence' } }; full.push({ ...body, digest: digest(body) }); }
  await writeFile(fullPath, full.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  const capacityRequest = await observation(B, 'capacity-denial', fullPath); capacityRequest.expectedParentDigest = full.at(-1).digest;
  const beforeCapacity = await count(); await assert.rejects(observeProductBaseline(capacityRequest), /journal capacity/); assert.equal(await count(), beforeCapacity);
  pass('capacity_before_effects', 'A separately labeled full 400-record capacity control rejects before observer execution; no release or adoption evidence synthesized');
  const incompletePath = join(root, 'incomplete.jsonl'); await writeFile(incompletePath, (await readFile(journalPath)).subarray(0, -1), { mode: 0o600 }); await assert.rejects(readProductLiveJournal(incompletePath), /incomplete journal/);
  assert.deepEqual(cli('product', 'live-journal', journalPath), await readProductLiveJournal(journalPath));
  const journal = await readFile(journalPath, 'utf8'); assert.ok(!journal.includes(bearer)); assert.ok(!journal.includes('published')); assert.deepEqual(await readFile(nextA.historyPath), historyA);
  const report = { format: 'faktori.live-product-cycle-qualification/v1', status: 'passed', evaluatorAuthority: 'model-authored-human-uncalibrated', environment: 'local_qualification', publication: 'not_run', publicRuntime: 'not_verified', mobile: 'not_retested', originalArtifact: A.artifactDigest, featureArtifact: B.artifactDigest, sourceA: A.sourceRevision, sourceB: B.sourceRevision, steps };
  await save(join(root, 'acceptance.json'), report); console.log(JSON.stringify({ status: report.status, environment: report.environment, evidence: join(root, 'acceptance.json'), steps: steps.map(s => s.name) }));
} finally { for (const child of [...children]) await stop(child); await rm(credentialPath, { force: true }); }
