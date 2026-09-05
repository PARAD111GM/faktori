import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

export async function startCandidate(serverPath, dataFile) {
  const child = spawn(process.execPath, [serverPath, dataFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`candidate server did not report a port: ${stderr}`)), 5_000);
    child.stdout.once('data', (chunk) => {
      clearTimeout(timer);
      const value = Number(String(chunk).trim().split(/\s+/)[0]);
      if (!Number.isInteger(value) || value < 1) reject(new Error(`candidate server reported invalid port: ${chunk}`));
      else resolve(value);
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`candidate server exited before ready (${code}): ${stderr}`)); });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

export async function stopCandidate(candidate) {
  if (!candidate || candidate.child.exitCode !== null) return;
  const exited = new Promise((resolve) => candidate.child.once('exit', resolve));
  candidate.child.kill();
  await exited;
}

export async function exerciseTaskBoard({ serverPath, dataFile }) {
  let candidate = await startCandidate(serverPath, dataFile);
  let browser;
  try {
    const preflight = await fetch(candidate.url);
    if (!preflight.ok) throw new Error(`candidate UI root returned ${preflight.status}`);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(1_500);
    page.setDefaultNavigationTimeout(1_500);
    await page.goto(candidate.url, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'New task' }).waitFor();
    const add = page.getByRole('button', { name: 'Add task' });
    const newTask = page.getByRole('textbox', { name: 'New task' });
    await newTask.fill('Ship browser contract');
    await newTask.press('Enter');
    await assertTask(page, 'Ship browser contract');

    await newTask.fill('discard this');
    await newTask.press('Escape');
    assert.equal(await newTask.inputValue(), '');
    assert.equal(await add.isVisible(), true);

    await page.getByRole('button', { name: 'Edit Ship browser contract' }).click();
    const edit = page.getByRole('textbox', { name: 'Edit Ship browser contract' });
    await edit.fill('Cancelled edit');
    await edit.press('Escape');
    await assertTask(page, 'Ship browser contract');

    await page.getByRole('button', { name: 'Edit Ship browser contract' }).click();
    await page.getByRole('textbox', { name: 'Edit Ship browser contract' }).fill('Persisted task');
    await page.getByRole('textbox', { name: 'Edit Ship browser contract' }).press('Enter');
    await assertTask(page, 'Persisted task');

    const toggle = page.getByRole('button', { name: 'Toggle Persisted task' });
    await toggle.focus();
    await page.keyboard.press('Space');
    await page.locator('button[aria-label="Toggle Persisted task"][aria-pressed="true"]').waitFor();
    await page.getByRole('button', { name: 'Open tasks' }).click();
    assert.equal(await page.getByText('Persisted task', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Completed tasks' }).click();
    await assertTask(page, 'Persisted task');

    await toggle.focus();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Open tasks' }).click();
    await assertTask(page, 'Persisted task');
    await page.locator('button[aria-label="Toggle Persisted task"][aria-pressed="false"]').waitFor();
    await page.getByRole('button', { name: 'Completed tasks' }).click();
    assert.equal(await page.getByText('Persisted task', { exact: true }).count(), 0);

    await page.getByRole('button', { name: 'All tasks' }).click();
    const textFilter = page.getByRole('textbox', { name: 'Filter tasks' });
    await textFilter.fill('PERSISTED');
    await assertTask(page, 'Persisted task');
    await textFilter.fill('does not match');
    assert.equal(await page.getByText('Persisted task', { exact: true }).count(), 0);
    await textFilter.fill('');
    await toggle.focus();
    await page.keyboard.press('Space');
    await page.locator('button[aria-label="Toggle Persisted task"][aria-pressed="true"]').waitFor();

    await page.reload({ waitUntil: 'networkidle' });
    await assertTask(page, 'Persisted task');
    await stopCandidate(candidate);
    candidate = await startCandidate(serverPath, dataFile);
    await page.goto(candidate.url, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Completed tasks' }).click();
    await assertTask(page, 'Persisted task');
    await page.getByRole('button', { name: 'Delete Persisted task' }).click();
    assert.equal(await page.getByText('Persisted task', { exact: true }).count(), 0);
  } finally {
    await stopCandidate(candidate);
    await browser?.close();
  }
}

async function assertTask(page, title) {
  const toggle = page.getByRole('button', { name: `Toggle ${title}` });
  await toggle.waitFor();
  assert.equal(await toggle.count(), 1);
}
