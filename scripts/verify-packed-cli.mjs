#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

const scratch = await mkdtemp(join(tmpdir(), 'faktori-packed-cli-'));
try {
  const packResult = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root));
  const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  if (!packed?.filename) throw new Error('npm pack did not report a tarball filename');
  const tarball = join(scratch, packed.filename);
  const consumer = join(scratch, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"name":"faktori-pack-smoke","private":true}\n');
  runNpm(['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', tarball], consumer);

  const executable = join(consumer, 'node_modules', '.bin', 'faktori');
  const result = spawnSync(executable, ['config', 'resolve', join(root, 'examples', 'config', 'solo.json')], {
    cwd: consumer,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'installed Faktori CLI failed');
  const resolved = JSON.parse(result.stdout);
  if (resolved.factory?.id !== 'solo-studio' || resolved.products?.length !== 1) {
    throw new Error('installed Faktori CLI returned an unexpected resolved configuration');
  }
  process.stdout.write(`Packed CLI verified with ${process.version}: ${packed.filename}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
