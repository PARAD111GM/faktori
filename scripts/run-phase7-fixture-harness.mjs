#!/usr/bin/env node
/**
 * A repeatable, local-only envelope for the frozen Phase 7 fixture harness.
 *
 * The fixture bytes and their 20s/25s bounds remain in fixtures/. This script
 * only pins the browser selection, captures the effective runtime, and makes
 * the outer process tree bounded so two isolated runners can use the same
 * setup and evidence format.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRunner = join(repository, 'fixtures', 'verify-fixtures.mjs');
const channel = 'chromium';
const prewarmTimeoutMs = 10_000;
// This bounds the complete, multi-fixture process tree. It does not replace or
// extend the frozen 20s browser-test or 25s per-child harness limits.
const fixtureRunnerTimeoutMs = 120_000;

export function assertNode24(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  if (major !== 24) throw new Error(`Phase 7 fixture runner requires Node 24; found ${version}`);
  return version;
}

export function parseArguments(argv) {
  const options = { evidencePath: join(repository, '.build', 'phase-7-fixture-harness.json') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--evidence') throw new Error(`Unknown argument: ${argv[index]}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--evidence requires a path');
    options.evidencePath = resolve(value);
    index += 1;
  }
  return options;
}

async function installedPlaywright() {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('playwright/package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const { chromium } = await import('playwright');
  return { browser: chromium, version: packageJson.version, packagePath };
}

export async function prewarmChromium({ browser, timeoutMs = prewarmTimeoutMs, accessFile = access, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const executablePath = browser.executablePath();
  await accessFile(executablePath);

  let timedOut = false;
  let launchedBrowser;
  const launch = Promise.resolve(browser.launch({ channel, headless: true })).then(async (instance) => {
    launchedBrowser = instance;
    if (timedOut) await instance.close();
    return instance;
  });
  let timer;
  try {
    const instance = await Promise.race([
      launch,
      new Promise((_, reject) => {
        timer = setTimer(() => {
          timedOut = true;
          reject(new Error(`Chromium prewarm timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    await instance.close();
  } finally {
    clearTimer(timer);
    if (timedOut && launchedBrowser) await launchedBrowser.close();
  }
  return { channel, executablePath, timeoutMs };
}

function terminateProcessTree(child, signal) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may already have exited; use the direct handle below.
    }
  }
  child.kill?.(signal);
}

export function runBoundedCommand({ command, args, cwd, environment = {}, timeoutMs, spawnProcess = spawn, setTimer = setTimeout, clearTimer = clearTimeout, terminate = terminateProcessTree }) {
  return new Promise((resolveResult, rejectResult) => {
    const startedAt = Date.now();
    const child = spawnProcess(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceTimer;
    const timer = setTimer(() => {
      timedOut = true;
      terminate(child, 'SIGTERM');
      forceTimer = setTimer(() => terminate(child, 'SIGKILL'), 1_000);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimer(timer);
      clearTimer(forceTimer);
      rejectResult(error);
    });
    child.once('close', (code, signal) => {
      clearTimer(timer);
      clearTimer(forceTimer);
      resolveResult({
        command,
        args,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

export async function runFixtureHarness({ nodeVersion = process.versions.node, loadRuntime = installedPlaywright, prewarm = prewarmChromium, runCommand = runBoundedCommand, now = () => new Date().toISOString() } = {}) {
  assertNode24(nodeVersion);
  const startedAt = now();
  const runtime = await loadRuntime();
  const preflight = await prewarm({ browser: runtime.browser });
  const fixture = await runCommand({
    command: process.execPath,
    args: [fixtureRunner],
    cwd: repository,
    environment: { PLAYWRIGHT_CHANNEL: channel },
    timeoutMs: fixtureRunnerTimeoutMs,
  });
  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: now(),
    status: fixture.exitCode === 0 && !fixture.timedOut ? 'passed' : 'failed',
    node: { version: nodeVersion, requiredMajor: 24 },
    playwright: { version: runtime.version, packagePath: runtime.packagePath, ...preflight },
    fixture: {
      runner: 'fixtures/verify-fixtures.mjs',
      effectiveEnvironment: { PLAYWRIGHT_CHANNEL: channel },
      outerTimeoutMs: fixtureRunnerTimeoutMs,
      frozenBrowserTestTimeoutMs: 20_000,
      frozenHarnessChildTimeoutMs: 25_000,
      ...fixture,
    },
  };
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function main() {
  const { evidencePath } = parseArguments(process.argv.slice(2));
  let evidence;
  try {
    evidence = await runFixtureHarness();
  } catch (error) {
    evidence = {
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'preflight_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await writeEvidence(evidencePath, evidence);
  console.log(JSON.stringify({ evidencePath, status: evidence.status }));
  if (evidence.status !== 'passed') process.exitCode = evidence.fixture?.exitCode || 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
