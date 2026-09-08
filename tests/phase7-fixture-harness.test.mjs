import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertNode24,
  parseArguments,
  prewarmChromium,
  runBoundedCommand,
  runFixtureHarness,
} from '../scripts/run-phase7-fixture-harness.mjs';

test('requires the pinned Node 24 major version', () => {
  assert.equal(assertNode24('24.20.0'), '24.20.0');
  assert.throws(() => assertNode24('22.16.0'), /requires Node 24/);
});

test('accepts only an explicit evidence path override', () => {
  assert.equal(parseArguments(['--evidence', 'proof.json']).evidencePath.endsWith('/proof.json'), true);
  assert.throws(() => parseArguments(['--channel', 'chrome']), /Unknown argument/);
  assert.throws(() => parseArguments(['--evidence']), /requires a path/);
});

test('prewarms and closes the resolved Chromium executable', async () => {
  let launchedWith;
  let closed = 0;
  const result = await prewarmChromium({
    browser: {
      executablePath: () => '/trusted/chromium',
      launch: async (options) => {
        launchedWith = options;
        return { close: async () => { closed += 1; } };
      },
    },
    accessFile: async (path) => assert.equal(path, '/trusted/chromium'),
  });
  assert.deepEqual(launchedWith, { channel: 'chromium', headless: true });
  assert.equal(closed, 1);
  assert.equal(result.executablePath, '/trusted/chromium');
});

test('bounds a local child process and reports its timeout without changing fixture limits', async () => {
  const result = await runBoundedCommand({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1_000)'],
    cwd: process.cwd(),
    timeoutMs: 25,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test('uses one explicit browser environment for prewarm evidence and the unchanged fixture runner', async () => {
  let command;
  const timestamps = ['2026-09-06T00:00:00.000Z', '2026-09-06T00:00:01.000Z'];
  const evidence = await runFixtureHarness({
    nodeVersion: '24.20.0',
    now: () => timestamps.shift(),
    loadRuntime: async () => ({ browser: {}, version: '1.63.0', packagePath: '/trusted/playwright/package.json' }),
    prewarm: async ({ browser }) => {
      assert.deepEqual(browser, {});
      return { channel: 'chromium', executablePath: '/trusted/chromium', timeoutMs: 10_000 };
    },
    runCommand: async (input) => {
      command = input;
      return { exitCode: 0, signal: null, timedOut: false, durationMs: 12, stdout: 'fixture output', stderr: '' };
    },
  });
  assert.deepEqual(command.environment, { PLAYWRIGHT_CHANNEL: 'chromium' });
  assert.equal(command.timeoutMs, 120_000);
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.fixture.frozenBrowserTestTimeoutMs, 20_000);
  assert.equal(evidence.fixture.frozenHarnessChildTimeoutMs, 25_000);
  assert.equal(evidence.playwright.executablePath, '/trusted/chromium');
});
