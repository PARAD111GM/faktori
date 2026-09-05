import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) values[key] = true;
    else { values[key] = value; index += 1; }
  }
  return values;
}

export async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function canonicalTickets() {
  return Array.from({ length: 8 }, (_, phase) => Array.from({ length: 4 }, (_, offset) => `F${phase}-${String(offset + 1).padStart(2, '0')}`)).flat();
}
