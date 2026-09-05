import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exerciseTaskBoard } from './browser-contract.mjs';

test('browser contract: CRUD, keyboard, filters, reload, and server restart persist', { timeout: 20_000 }, async () => {
  const store = join(await mkdtemp(join(tmpdir(), 'faktori-task-board-')), 'tasks.json');
  await exerciseTaskBoard({ serverPath: new URL('../src/server.mjs', import.meta.url).pathname, dataFile: store });
});
