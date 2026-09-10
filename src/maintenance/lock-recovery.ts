import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFile, lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { withOwnershipLock } from '../runtime/ownership-lock.ts';

function fail(message: string): never { throw new Error(`Lock recovery refused: ${message}`); }

function ownerStatus(pid: number): 'alive' | 'dead' | 'unknown' {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}

async function inspect(journalPath: string) {
  if (typeof journalPath !== 'string' || !isAbsolute(journalPath)) fail('an absolute journal path is required');
  const journal = await realpath(journalPath);
  if (!(await lstat(journal)).isFile()) fail('journal must be a regular file');
  const lockPath = `${journal}.coordinator-lock`;
  const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 16_384) fail('lock must be a small regular file');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(lockPath);
    if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
      || before.ctimeMs !== after.ctimeMs || before.size !== after.size) fail('lock changed during inspection; inspect again');
    let identity;
    try { identity = JSON.parse(bytes.toString('utf8')); } catch { fail('lock identity is malformed; manual investigation is required'); }
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
      || typeof identity.instanceId !== 'string' || !identity.instanceId
      || typeof identity.processStartedAt !== 'string' || !identity.processStartedAt) {
      fail('lock identity is incomplete; manual investigation is required');
    }
    const lockToken = createHash('sha256').update(`${before.dev}:${before.ino}:${before.ctimeMs}:`).update(bytes).digest('hex');
    return { lockPath, lockToken, pid: identity.pid as number, ownerStatus: ownerStatus(identity.pid), bytes };
  } finally { await handle.close(); }
}

/** Offline inspection never treats age, PID reuse or permission denial as death. */
export async function inspectCoordinatorLock(journalPath: string) {
  const { bytes: _bytes, ...result } = await inspect(journalPath);
  return { format: 'faktori.lock-inspection/v1', ...result,
    nextAction: result.ownerStatus === 'dead'
      ? 'Stop automatic restarts and confirm admission is quiesced, then submit this exact lockToken to backup recover-lock.'
      : 'Do not recover: stop the owner normally or resolve unavailable process visibility, then inspect again.' };
}

/** Requires a quiesced local host. Does not stop processes or repair journals. */
export async function recoverCoordinatorLock(input: unknown) {
  if (!input || typeof input !== 'object') fail('a recovery request is required');
  const request = input as Record<string, unknown>;
  if (request.format !== 'faktori.lock-recovery-request/v1' || request.admissionQuiesced !== true
    || typeof request.journalPath !== 'string' || typeof request.expectedLockToken !== 'string') {
    fail('provide format, absolute journalPath, expectedLockToken and admissionQuiesced: true after stopping automatic restarts');
  }
  const journalPath = request.journalPath;
  const initial = await inspect(journalPath);
  if (initial.lockToken !== request.expectedLockToken) fail('lock differs from the inspected identity; inspect again');
  if (initial.ownerStatus !== 'dead') fail(`owner is ${initial.ownerStatus}; only confirmed process absence permits recovery`);
  return withOwnershipLock(initial.lockPath, async () => {
    const current = await inspect(journalPath);
    if (current.lockToken !== initial.lockToken || current.ownerStatus !== 'dead') fail('ownership changed; nothing was removed');
    const evidencePath = `${initial.lockPath}.recovered-${randomUUID()}`;
    await copyFile(initial.lockPath, evidencePath, constants.COPYFILE_EXCL);
    const evidence = await open(evidencePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await evidence.sync(); } finally { await evidence.close(); }
    const confirmed = await inspect(journalPath);
    if (confirmed.lockToken !== initial.lockToken || confirmed.ownerStatus !== 'dead'
      || !(await readFile(evidencePath)).equals(initial.bytes)) {
      fail(`ownership changed; lock retained. Inspection evidence: ${evidencePath}`);
    }
    await unlink(initial.lockPath);
    return { format: 'faktori.lock-recovery/v1', recovered: true, lockPath: initial.lockPath,
      evidencePath, nextAction: 'Retry backup while admission and automatic restarts remain stopped. No journal or workers were modified.' };
  });
}
