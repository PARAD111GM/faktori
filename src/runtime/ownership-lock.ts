import { constants, lstat, open, unlink } from 'node:fs/promises';

/** Serialize lock-path changes across coordinator, maintenance and recovery.
 * An interrupted guard is deliberately not reclaimed automatically.
 */
export async function withOwnershipLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const guardPath = `${lockPath}.recovery-lock`;
  const handle = await open(guardPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    .catch(() => { throw new Error('Another ownership operation is active or unresolved; investigate the recovery-lock before retrying'); });
  try { return await operation(); }
  finally {
    const held = await handle.stat();
    await handle.close();
    const current = await lstat(guardPath);
    if (current.dev !== held.dev || current.ino !== held.ino) throw new Error('Ownership guard changed; refusing to remove it');
    await unlink(guardPath);
  }
}
