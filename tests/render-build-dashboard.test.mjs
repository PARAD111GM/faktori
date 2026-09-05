import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const command = join(root, 'scripts', 'render-build-dashboard.mjs');

test('renders the complete construction dashboard from checklist history and sanitized usage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faktori-dashboard-'));
  const checklist = join(dir, 'checklist.json');
  const summary = join(dir, 'summary.json');
  const output = join(dir, 'dashboard.html');
  const tickets = Array.from({ length: 32 }, (_, number) => {
    const phase = Math.floor(number / 4);
    const index = number % 4;
    return { id: `F${phase}-${String(index + 1).padStart(2, '0')}`, phase, title: `Ticket ${phase}-${index + 1}`, status: 'not_started', dependencies: [], owner: { role: 'specialist', agentId: `agent-${phase}-${index + 1}`, model: 'gpt-5.6-terra', reasoning: 'high' } };
  });
  tickets[0].status = 'complete';
  tickets[1].status = 'blocked';
  await writeFile(checklist, JSON.stringify({ schemaVersion: 1, project: { currentPhase: 0, phaseBudgets: { '0': 100 } }, tickets, history: [{ at: '2026-09-04T00:00:00Z', ticketId: 'F0-01', from: 'in_progress', to: 'complete' }, { at: '2026-09-04T00:01:00Z', ticketId: 'F0-01', from: 'complete', to: 'in_progress', reason: 'reopened' }, { at: '2026-09-04T00:02:00Z', ticketId: 'F0-01', from: 'in_progress', to: 'split', reason: 'split' }] }));
  await writeFile(summary, JSON.stringify({ schemaVersion: 1, phase: 0, actual: { input: 50, output: null, cached: 20, reasoning: null, total: 70 }, estimated: { total: 5 }, models: [{ model: 'gpt-5.6-terra', reasoning: 'high', recordCount: 1 }], unknown: [{ ticket: 'F0-03', reason: 'telemetry:unknown' }], budget: { estimate: 100, percentUsed: 70 }, notices: [{ threshold: 70 }] }));
  const result = spawnSync(process.execPath, [command, '--checklist', checklist, '--summary', summary, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const html = await readFile(output, 'utf8');
  assert.match(html, /1 of 32 complete/);
  assert.match(html, /70%/);
  assert.match(html, /F0-02/);
  assert.match(html, /Current phase: 0/);
  assert.match(html, /Blockers/);
  assert.match(html, /Completion history/);
  assert.match(html, /Token consumption chart/);
  assert.match(html, /gpt-5\.6-terra\/high/);
  assert.match(html, /agent-0-2/);
  assert.match(html, /70 tokens/);
  assert.match(html, /Input: 50 tokens/);
  assert.match(html, /Output: unknown/);
  assert.match(html, /Cached: 20 tokens/);
  assert.match(html, /Reasoning: unknown/);
  assert.doesNotMatch(html, /\/Users\//);
});
