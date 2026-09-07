#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, ...args], { cwd, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `npm ${args[0]} failed`);
  return result.stdout;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} ${args.join(' ')} failed`);
  return result.stdout;
}

const scratch = await mkdtemp(join(tmpdir(), 'faktori-packed-cli-'));
try {
  const packResult = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root));
  const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  if (!packed?.filename) throw new Error('npm pack did not report a tarball filename');
  const tarball = join(scratch, packed.filename);
  const entries = run('tar', ['-tf', tarball], scratch).split('\n').filter(Boolean);
  const requiredEntries = [
    'package/dist/maintenance/index.js',
    'package/dist/maintenance/backup.js',
    'package/dist/maintenance/update.js',
    'package/dist/diagnostics/index.js',
    'package/dist/diagnostics/local-preflight.js',
    'package/dist/diagnostics/preflight.js',
    'package/dist/runtime/run-manifest.js',
    'package/docs/maintenance/README.md',
    'package/docs/maintenance/compatibility.md',
    'package/examples/maintenance/README.md',
    'package/examples/maintenance/restore-request.json',
  ];
  for (const entry of requiredEntries) if (!entries.includes(entry)) throw new Error(`packed public kit is missing ${entry}`);
  const forbiddenEntry = entries.find((entry) => /(^|\/)(?:\.env(?:\.|$)|node_modules|\.codex|\.git)(?:\/|$)/.test(entry));
  if (forbiddenEntry) throw new Error(`packed public kit contains private entry ${forbiddenEntry}`);
  for (const entry of entries.filter((item) => /\.(?:js|json|md|ts|yml|yaml|txt)$/.test(item))) {
    const content = run('tar', ['-xOf', tarball, entry], scratch);
    if (/\/(?:Users|home)\/[^\s"']+/.test(content)) throw new Error(`packed public content contains a private machine path (${entry})`);
    if (/(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"']+["']/i.test(content)) throw new Error(`packed public content contains a credential-looking value (${entry})`);
  }
  const consumer = join(scratch, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"name":"faktori-pack-smoke","private":true}\n');
  runNpm(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', tarball], consumer);

  const importResult = spawnSync(process.execPath, ['--input-type=module', '-e', "const runtime=await import('faktori/runtime'); const diagnostics=await import('faktori/diagnostics'); const transports=await import('faktori/execution/transports'); const maintenance=await import('faktori/maintenance'); if(typeof runtime.CoordinatorCodexDelivery!=='function'||typeof runtime.createRunManifest!=='function'||typeof diagnostics.evaluatePreflight!=='function'||typeof transports.DockerCodexProcessRunner!=='function'||typeof maintenance.createFactoryBackup!=='function'||typeof maintenance.previewRuntimeUpdate!=='function') process.exit(2)"], {
    cwd: consumer,
    encoding: 'utf8',
  });
  if (importResult.status !== 0) throw new Error(importResult.stderr || importResult.stdout || 'installed runtime exports failed');

  const executable = join(consumer, 'node_modules', '.bin', 'faktori');
  const configPath = join(consumer, 'solo.json');
  await writeFile(configPath, await readFile(join(consumer, 'node_modules', 'faktori', 'examples', 'config', 'solo.json')));
  const result = spawnSync(executable, ['--help'], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
  if (result.status !== 0 || !result.stdout.includes('faktori backup create') || !result.stdout.includes('faktori update preview') || !result.stdout.includes('faktori run manifest') || !result.stdout.includes('faktori preflight')) throw new Error(result.stderr || result.stdout || 'installed Faktori CLI help failed');
  const configResult = spawnSync(executable, ['config', 'resolve', configPath], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
  if (configResult.status !== 0) throw new Error(configResult.stderr || configResult.stdout || 'installed Faktori CLI failed');
  const resolved = JSON.parse(configResult.stdout);
  if (resolved.factory?.id !== 'solo-studio' || resolved.products?.length !== 1) throw new Error('installed Faktori CLI returned an unexpected resolved configuration');

  const projection = join(scratch, 'runtime.sqlite');
  const runtimeResult = spawnSync(executable, [
    'runtime',
    'rebuild',
    join(consumer, 'node_modules', 'faktori', 'examples', 'runtime', 'interrupted-run.jsonl'),
    projection,
  ], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
  if (runtimeResult.status !== 0) throw new Error(runtimeResult.stderr || runtimeResult.stdout || 'installed runtime rebuild failed');
  const runtime = JSON.parse(runtimeResult.stdout);
  if (runtime.eventCount !== 2 || runtime.snapshots?.[0]?.state !== 'launching' || runtime.snapshots[0].unresolvedEffects?.[0]?.operationId !== 'example-launch') {
    throw new Error('installed runtime rebuild returned an unexpected recovery projection');
  }
  const sourceJournal = join(consumer, 'node_modules', 'faktori', 'examples', 'runtime', 'interrupted-run.jsonl');
  const sourceBefore = await readFile(sourceJournal, 'utf8');
  const manifestResult = spawnSync(executable, ['run', 'manifest', sourceJournal, 'example-run'], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
  if (manifestResult.status !== 0) throw new Error(manifestResult.stderr || manifestResult.stdout || 'installed run manifest failed');
  const manifest = JSON.parse(manifestResult.stdout);
  if (manifest.format !== 'faktori.run-manifest/v1' || !/^[a-f0-9]{64}$/.test(manifest.contentDigest) || JSON.stringify(manifest).includes('/workspace') || await readFile(sourceJournal, 'utf8') !== sourceBefore) {
    throw new Error('installed run manifest did not preserve the redacted read-only contract');
  }
  const packagedPreflightRequest = JSON.parse(await readFile(join(consumer, 'node_modules', 'faktori', 'examples', 'diagnostics', 'preflight-projection.json'), 'utf8'));
  const preflightPath = join(scratch, 'installed-preflight.json');
  await writeFile(preflightPath, JSON.stringify({
    format: 'faktori.preflight-installation/v1',
    request: packagedPreflightRequest,
    installation: { factoryId: 'example-factory', projectionPath: projection },
  }));
  const preflightResult = spawnSync(executable, ['preflight', preflightPath], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
  if (preflightResult.status !== 0) throw new Error(preflightResult.stderr || preflightResult.stdout || 'installed preflight failed');
  const preflight = JSON.parse(preflightResult.stdout);
  if (preflight.format !== 'faktori.preflight-result/v1' || preflight.status !== 'partial' || preflight.projectionReady !== true || preflight.executionReady !== false || preflight.liveExecutionVerified !== false) {
    throw new Error('installed preflight returned an unexpected readiness report');
  }

  const ownerRoot = join(scratch, 'owner-factory');
  await mkdir(join(ownerRoot, 'config'), { recursive: true });
  const canonicalOwnerRoot = await realpath(ownerRoot);
  await writeFile(join(ownerRoot, 'operations.jsonl'), '');
  await writeFile(join(ownerRoot, 'config', 'local-console.json'), `${JSON.stringify({
    factoryId: 'packed-factory',
    journalPath: join(canonicalOwnerRoot, 'operations.jsonl'),
    projectionPath: join(canonicalOwnerRoot, 'projection.sqlite'),
    commandToken: 'must-not-enter-backup',
  }, null, 2)}\n`);
  const backupRequest = join(scratch, 'backup-request.json');
  await writeFile(backupRequest, `${JSON.stringify({
    format: 'faktori.backup-request/v1', factoryId: 'packed-factory', sourceRoot: canonicalOwnerRoot,
    runtimeVersion: '0.0.0', stateFormatVersion: 1, journalPath: 'operations.jsonl',
    configurationPaths: ['config'], artifactPaths: [], operationalPaths: ['operations.jsonl'],
    projectionPaths: ['projection.sqlite'], credentialPaths: [],
  }, null, 2)}\n`);
  const backupRoot = join(scratch, 'backup');
  const backupRun = spawnSync(executable, ['backup', 'create', backupRequest, backupRoot], { cwd: consumer, encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
  if (backupRun.status !== 0 || JSON.parse(backupRun.stdout).files?.length !== 2) throw new Error(backupRun.stderr || backupRun.stdout || 'installed backup create failed');
  const backedUpConfig = JSON.parse(await readFile(join(backupRoot, 'files', 'config', 'local-console.json'), 'utf8'));
  if ('commandToken' in backedUpConfig) throw new Error('installed backup exported a local Console command token');
  const restoreRoot = join(scratch, 'restored-factory');
  const restoreRequest = join(scratch, 'restore-request.json');
  await writeFile(restoreRequest, `${JSON.stringify({ format: 'faktori.restore-request/v1', destinationRoot: restoreRoot, expectedFactoryId: 'packed-factory', expectedSourceRoot: canonicalOwnerRoot, rebindConfigurationPaths: true }, null, 2)}\n`);
  const restoreRun = spawnSync(executable, ['backup', 'restore', backupRoot, restoreRequest], { cwd: consumer, encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
  if (restoreRun.status !== 0) throw new Error(restoreRun.stderr || restoreRun.stdout || 'installed backup restore failed');
  const restored = JSON.parse(restoreRun.stdout);
  const restoredConfig = JSON.parse(await readFile(join(restored.destinationRoot, 'config', 'local-console.json'), 'utf8'));
  if (restored.admissionBlocked !== false || restoredConfig.journalPath !== join(restored.destinationRoot, 'operations.jsonl')) throw new Error('installed restore did not preserve the safe relocation contract');

  const managedRoot = join(scratch, 'managed-runtime');
  await mkdir(managedRoot);
  const initializationRequest = join(scratch, 'initialize-request.json');
  await writeFile(initializationRequest, `${JSON.stringify({ format: 'faktori.update-request/v1', installationRoot: managedRoot, candidateRoot: join(consumer, 'node_modules', 'faktori') }, null, 2)}\n`);
  const initializedRun = spawnSync(executable, ['update', 'initialize', initializationRequest], { cwd: consumer, encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
  if (initializedRun.status !== 0) throw new Error(initializedRun.stderr || initializedRun.stdout || 'installed update initialization failed');
  const initialized = JSON.parse(initializedRun.stdout);
  const selectedRun = spawnSync(join(managedRoot, '.faktori', 'releases', initialized.activeEntrypoint), ['--help'], { cwd: managedRoot, encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
  if (selectedRun.status !== 0 || !selectedRun.stdout.includes('faktori update preview')) throw new Error(selectedRun.stderr || selectedRun.stdout || 'managed installed entrypoint failed');
  const managedJournal = join(managedRoot, 'managed-proof.jsonl');
  await writeFile(managedJournal, '');
  const managedRuntime = spawnSync(join(managedRoot, '.faktori', 'releases', initialized.activeEntrypoint), ['runtime', 'rebuild', managedJournal, join(managedRoot, 'managed-proof.sqlite')], { cwd: managedRoot, encoding: 'utf8', env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` } });
  if (managedRuntime.status !== 0 || JSON.parse(managedRuntime.stdout).eventCount !== 0) throw new Error(managedRuntime.stderr || managedRuntime.stdout || 'managed installed runtime dependency proof failed');
  process.stdout.write(`Packed CLI verified with ${process.version}: ${packed.filename}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
