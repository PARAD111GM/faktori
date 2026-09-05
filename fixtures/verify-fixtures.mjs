import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const repository = join(root, '..');
// Browser tests enforce their own 20s cap; this grace period permits runner teardown.
const timeoutMs = 25_000;

for (const line of (await readFile(join(root, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
  const [expected, ...parts] = line.trim().split(/\s+/);
  const file = join(repository, parts.join(' '));
  const actual = createHash('sha256').update(await readFile(file)).digest('hex');
  if (actual !== expected) throw new Error(`checksum mismatch: ${file}`);
}

function run(name, cwd, command, args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => reject(new Error(`${name} spawn failure: ${error.message}`)));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${name} harness timeout after ${timeoutMs}ms`));
      if (signal) return reject(new Error(`${name} harness signal: ${signal}`));
      resolve({ code, output });
    });
  });
}

async function expectedRed({ name, cwd, command, args, testName, reason, environment }) {
  const result = await run(name, cwd, command, args, environment);
  if (result.code === 0) throw new Error(`${name} unexpectedly passed; frozen starter is not red`);
  if (!result.output.includes(testName)) throw new Error(`${name} harness failure: missing expected test name ${testName}\n${result.output}`);
  if (!result.output.includes(reason)) throw new Error(`${name} harness failure: missing expected failure reason ${reason}`);
  if (!/fail(?:ed)? 1\b|FAILED/.test(result.output)) throw new Error(`${name} harness failure: expected exactly one assertion failure`);
  console.log(`EXPECTED RED: ${name}`);
}

async function expectedGreen({ name, cwd, command, args }) {
  const result = await run(name, cwd, command, args);
  if (result.code !== 0) throw new Error(`${name} failed unexpectedly:\n${result.output}`);
  console.log(`GREEN: ${name}`);
}

const node = process.execPath;
await expectedRed({ name: 'task-board starter', cwd: join(root, 'task-board'), command: node, args: ['--test', 'test/acceptance.test.mjs'], testName: 'browser contract: CRUD, keyboard, filters, reload, and server restart persist', reason: 'candidate UI root returned 404' });
await expectedGreen({ name: 'due-dates base contract', cwd: join(root, 'due-dates'), command: node, args: ['--test', 'test/base-contract.test.mjs'] });
await expectedRed({ name: 'due-dates feature starter', cwd: join(root, 'due-dates'), command: node, args: ['--test', 'test/acceptance.test.mjs'], testName: 'browser feature contract: due-date editing, persistence, and strict overdue boundary', reason: 'Set due date Yesterday task' });
const pytestEnvironment = { PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' };
const pytestProbe = await run('pytest probe', join(root, 'python-date-boundary'), 'pytest', ['--version'], pytestEnvironment);
if (pytestProbe.code !== 0) throw new Error('python boundary harness failure: pytest executable unavailable');
await expectedRed({ name: 'python boundary starter', cwd: join(root, 'python-date-boundary'), command: 'pytest', args: ['-q'], testName: 'test_boundary_today_is_not_overdue', reason: 'AssertionError', environment: pytestEnvironment });
console.log('GREEN: checksums verified; expected RED and base GREEN contracts reproduced');
