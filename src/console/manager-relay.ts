import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ManagerConnectedStore } from '../manager-connected/index.ts';

/** Private transport for an active Manager, not a desktop API or agent launcher. */
export function registerManagerRelay(app: FastifyInstance, store: ManagerConnectedStore, token: string): void {
  app.post('/api/manager-connected/relay', async (request, reply) => {
    // Browsers use the owner channel. Never accept its token on the relay channel.
    if (request.headers.origin !== undefined || !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '')) return reply.code(403).send({ error: 'relay_origin_rejected' });
    const expected = Buffer.from(`Bearer ${token}`);
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return reply.code(401).send({ error: 'relay_authentication_required' });
    const action = request.body as { type?: unknown } | null;
    if (!action || typeof action !== 'object') return reply.code(400).send({ error: 'invalid_relay_action' });
    if (action.type === 'state') return { snapshot: store.snapshot() };
    if (!['heartbeat', 'claim', 'submitted', 'complete'].includes(String(action.type))) return reply.code(400).send({ error: 'unsupported_relay_action' });
    try { return await store.operate(action); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : 'relay_operation_failed' }); }
  });
}

export function newManagerRelayToken(): string { return randomBytes(32).toString('hex'); }

/** File contents are never returned to the browser or printed by Console startup. */
export async function writeManagerRelayConnection(directory: string, origin: string, token: string): Promise<() => Promise<void>> {
  const path = join(directory, 'relay-connection.json');
  // Reject symlinks and unexpected file permissions rather than overwriting them.
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('unsafe_relay_connection_file');
    await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ format: 'faktori.manager-relay/v1', origin, token })); await file.sync(); }
  finally { await file.close(); }
  return async () => { await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); };
}

export async function callManagerRelay(connectionPath: string, action: unknown): Promise<unknown> {
  const info = await lstat(connectionPath);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('relay connection must be a private owner-owned regular file');
  const connection = JSON.parse(await readFile(connectionPath, 'utf8')) as { format?: string; origin?: string; token?: string };
  if (connection.format !== 'faktori.manager-relay/v1' || typeof connection.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.origin) || typeof connection.token !== 'string' || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error('invalid relay connection');
  const response = await fetch(`${connection.origin}/api/manager-connected/relay`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.token}` }, body: JSON.stringify(action),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `relay HTTP ${response.status}`);
  return result;
}
