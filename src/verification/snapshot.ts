import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
export interface CandidateSnapshot {
  format: 'faktori.candidate-snapshot/v1';
  candidateDigest: string;
  fileCount: number;
  totalBytes: number;
  /** Only root Git administration metadata is excluded. Symlinks are rejected. */
  excludedMetadata: ['.git'];
}
interface Entry { path: string; kind: 'directory' | 'file'; mode: number; bytes?: number; digest?: string }
const hash = (value: string | Buffer): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function inventory(source: string, destination?: string): Promise<CandidateSnapshot> {
  if (!isAbsolute(source)) throw new Error('candidate_path_must_be_absolute');
  const root = await realpath(source);
  if ((await lstat(source)).isSymbolicLink()) throw new Error('candidate_symlink_not_supported');
  if (!(await lstat(root)).isDirectory()) throw new Error('candidate_must_be_directory');
  const entries: Entry[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  async function walk(directory: string): Promise<void> {
    const names = (await readdir(join(root, directory))).sort();
    for (const name of names) {
      if (directory === '' && name === '.git') continue;
      if (entries.length >= MAX_ENTRIES) throw new Error('candidate_entry_limit_exceeded');
      const path = directory ? `${directory}/${name}` : name;
      const absolute = join(root, path);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`candidate_symlink_not_supported:${path}`);
      const actual = await realpath(absolute);
      const within = relative(root, actual);
      if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('candidate_path_escaped');
      const mode = info.mode & 0o777;
      if (info.isDirectory()) {
        entries.push({ path, kind: 'directory', mode });
        if (destination) await mkdir(join(destination, path), { mode: 0o700 });
        await walk(path);
        if (destination) await chmod(join(destination, path), mode);
      } else if (info.isFile()) {
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        let data: Buffer;
        try {
          if (!(await handle.stat()).isFile()) throw new Error('candidate_file_changed');
          const chunks: Buffer[] = [];
          let length = 0;
          for (;;) {
            const chunk = Buffer.alloc(64 * 1024);
            const { bytesRead } = await handle.read(chunk);
            if (!bytesRead) break;
            length += bytesRead;
            if (length > MAX_FILE_BYTES || totalBytes + length > MAX_BYTES) throw new Error('candidate_byte_limit_exceeded');
            chunks.push(chunk.subarray(0, bytesRead));
          }
          data = Buffer.concat(chunks);
        } finally { await handle.close(); }
        totalBytes += data.length;
        fileCount += 1;
        entries.push({ path, kind: 'file', mode, bytes: data.length, digest: hash(data) });
        if (destination) {
          await writeFile(join(destination, path), data, { flag: 'wx', mode });
          await chmod(join(destination, path), mode);
        }
      } else throw new Error(`candidate_special_file_not_supported:${path}`);
    }
  }
  await walk('');
  return { format: 'faktori.candidate-snapshot/v1', candidateDigest: hash(JSON.stringify(entries)), fileCount, totalBytes, excludedMetadata: ['.git'] };
}

export async function captureCandidateSnapshot(path: string): Promise<CandidateSnapshot> {
  return inventory(path);
}

/** Copies bytes, never links. Caller owns a new empty destination. */
export async function copyCandidateSnapshot(source: string, destination: string, expectedDigest: string): Promise<CandidateSnapshot> {
  if (resolve(source) === resolve(destination)) throw new Error('candidate_snapshot_must_be_separate');
  const before = await inventory(source);
  if (before.candidateDigest !== expectedDigest) throw new Error('candidate_digest_mismatch');
  const copied = await inventory(source, destination);
  const after = await inventory(source);
  const snapshot = await inventory(destination);
  if ([copied, after, snapshot].some(item => item.candidateDigest !== expectedDigest)) throw new Error('candidate_changed_during_snapshot');
  return snapshot;
}
