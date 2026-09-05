import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startCandidate, stopCandidate } from '../../task-board/test/browser-contract.mjs';

test('browser feature contract: due-date editing, persistence, and strict overdue boundary', { timeout: 20_000 }, async () => {
  const store = join(await mkdtemp(join(tmpdir(), 'faktori-due-date-feature-')), 'tasks.json');
  let candidate = await startCandidate(new URL('../src/server.mjs', import.meta.url).pathname, store);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(1_500);
  try {
    await page.goto(candidate.url, { waitUntil: 'networkidle' });
    for (const title of ['Yesterday task', 'Today task', 'Completed yesterday', 'No due date']) {
      const response = await page.request.post(`${candidate.url}/api/tasks`, { data: { title } });
      assert.equal(response.status(), 201);
    }
    await page.reload({ waitUntil: 'networkidle' });
    await setDueDate(page, 'Yesterday task', '2026-09-03');
    await setDueDate(page, 'Today task', '2026-09-04');
    await setDueDate(page, 'Completed yesterday', '2026-09-03');
    await page.getByRole('button', { name: 'Toggle Completed yesterday' }).click();
    await page.locator('button[aria-label="Toggle Completed yesterday"][aria-pressed="true"]').waitFor();
    await page.getByRole('button', { name: 'Overdue tasks' }).click();
    await dueVisible(page, 'Yesterday task');
    await dueVisible(page, 'Completed yesterday');
    assert.equal(await page.getByRole('button', { name: 'Toggle Today task' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Toggle No due date' }).count(), 0);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Overdue tasks' }).click();
    await dueVisible(page, 'Yesterday task');
    await stopCandidate(candidate);
    candidate = await startCandidate(new URL('../src/server.mjs', import.meta.url).pathname, store);
    await page.goto(candidate.url, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Overdue tasks' }).click();
    await dueVisible(page, 'Completed yesterday');
  } finally {
    await stopCandidate(candidate);
    await browser.close();
  }
});

async function setDueDate(page, title, value) {
  await page.getByRole('button', { name: `Set due date ${title}` }).click();
  const input = page.getByLabel(`Due date ${title}`);
  await input.fill(value);
  await input.press('Enter');
  await page.getByText(`Due: ${value}`, { exact: true }).waitFor();
}

async function dueVisible(page, title) {
  await page.getByRole('button', { name: `Toggle ${title}` }).waitFor();
}
