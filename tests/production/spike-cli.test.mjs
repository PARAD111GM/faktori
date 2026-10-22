import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;
const cli = join(root, 'src/cli.ts');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });

describe('public preparation CLI contract', () => {
  it('reports incomplete preparation without changing the example', async () => {
    const path = join(root, 'examples/production/attended-spike.json');
    const before = await readFile(path, 'utf8');
    const result = run('spike', 'prepare', path);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'needs_idea', executionReady: false, productionReady: false, resourceEvidence: 'declared_not_observed' });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(run('spike', 'prepare', path, 'launch').status).toBe(1);
  });

  it('preserves raw intent and rejects a launch-shaped request without echoing a secret value', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'faktori-spike-cli-'));
    try {
      const path = join(directory, 'request.json');
      const request = { format: 'faktori.attended-spike-request/v1', spikeId: 'raw-idea', rawIdea: 'Help neighbors share groceries' };
      await writeFile(path, JSON.stringify(request));
      const result = run('spike', 'prepare', path);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ rawIdea: request.rawIdea, status: 'prepared_for_discovery', executionReady: false });
      await writeFile(path, JSON.stringify({ ...request, command: 'should-not-execute', token: 'private-test-value' }));
      const denied = run('spike', 'prepare', path);
      expect(denied.status).toBe(1);
      expect(denied.stderr).toContain('unknown field');
      expect(denied.stdout + denied.stderr).not.toContain('private-test-value');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
