import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exerciseTaskBoard } from '../../task-board/test/browser-contract.mjs';

test('base task-board contract: CRUD, keyboard, filters, reload, and server restart persist', { timeout: 20_000 }, async () => {
  const store = join(await mkdtemp(join(tmpdir(), 'faktori-due-date-base-')), 'tasks.json');
  await exerciseTaskBoard({ serverPath: new URL('../src/server.mjs', import.meta.url).pathname, dataFile: store });
});
