import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { ManagerLoopSource } from './manager-loop-observer.ts';

const FORMAT = 'faktori.manager-loop-registrations/v1';

export interface ManagerLoopRegistryOptions {
  path: string;
  allowedArtifactRoots: readonly string[];
  reservedSources?: readonly ManagerLoopSource[];
  validate(source: unknown): ManagerLoopSource;
}

export interface ManagerLoopRegistrationResult {
  source: ManagerLoopSource;
  created: boolean;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..`) && !isAbsolute(path));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Stores browser-requested registrations in a controller-owned file. Inputs are
 * resolved against existing owner-configured roots before persistence, so the
 * browser cannot turn the observer into a filesystem reader.
 */
export class ManagerLoopRegistry {
  readonly #path: string;
  readonly #roots: readonly string[];
  readonly #validate: (source: unknown) => ManagerLoopSource;
  readonly #reservedSources: readonly ManagerLoopSource[];
  #sources: ManagerLoopSource[];
  #tail: Promise<void> = Promise.resolve();

  private constructor(options: ManagerLoopRegistryOptions, roots: readonly string[], sources: ManagerLoopSource[]) {
    this.#path = options.path;
    this.#roots = roots;
    this.#validate = options.validate;
    this.#reservedSources = options.reservedSources?.map((source) => ({ ...source })) ?? [];
    this.#sources = sources;
  }

  static async open(options: ManagerLoopRegistryOptions): Promise<ManagerLoopRegistry> {
    if (!isAbsolute(options.path)) throw new Error('managerLoopRegistry.path must be an absolute local path');
    if (!Array.isArray(options.allowedArtifactRoots) || options.allowedArtifactRoots.length === 0) throw new Error('managerLoopRegistry.allowedArtifactRoots must be a non-empty array');
    const parent = await realpath(dirname(options.path));
    const path = resolve(parent, options.path.slice(dirname(options.path).length + 1));
    const roots = await Promise.all(options.allowedArtifactRoots.map(async (root) => {
      if (!isAbsolute(root)) throw new Error('managerLoopRegistry.allowedArtifactRoots must be absolute local paths');
      const resolved = await realpath(root);
      const details = await lstat(resolved);
      if (!details.isDirectory()) throw new Error('managerLoopRegistry.allowedArtifactRoots must name existing directories');
      return resolved;
    }));
    if (new Set(roots).size !== roots.length) throw new Error('managerLoopRegistry.allowedArtifactRoots must be unique');
    const sources = await ManagerLoopRegistry.#read(path, options.validate, roots);
    return new ManagerLoopRegistry({ ...options, path }, roots, sources);
  }

  static async #read(path: string, validate: (source: unknown) => ManagerLoopSource, roots: readonly string[]): Promise<ManagerLoopSource[]> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size > 1024 * 1024) throw new Error('manager_loop_registry_invalid');
      const input = object(JSON.parse(await handle.readFile({ encoding: 'utf8' })) as unknown);
      if (input?.format !== FORMAT || !Array.isArray(input.registrations)) throw new Error('manager_loop_registry_invalid');
      const sources = await Promise.all(input.registrations.map(async (entry) => ManagerLoopRegistry.#trusted(validate(entry), roots)));
      if (new Set(sources.map((source) => source.id)).size !== sources.length || new Set(sources.map((source) => source.artifactsDirectory)).size !== sources.length) throw new Error('manager_loop_registry_invalid');
      return sources;
    } finally { await handle?.close(); }
  }

  static async #trusted(source: ManagerLoopSource, roots: readonly string[]): Promise<ManagerLoopSource> {
    const resolved = await realpath(source.artifactsDirectory);
    const details = await lstat(resolved);
    const root = roots.find((candidate) => inside(candidate, resolved));
    if (!details.isDirectory() || root === undefined) throw new Error('manager_loop_registration_outside_allowlisted_roots');
    let usageExportPath: string | undefined;
    if (source.usageExportPath !== undefined) {
      const exported = await realpath(source.usageExportPath);
      const exportDetails = await lstat(exported);
      if (!exportDetails.isFile() || !inside(root, exported)) throw new Error('manager_loop_registration_outside_allowlisted_roots');
      usageExportPath = exported;
    }
    return { ...source, artifactsDirectory: resolved, ...(usageExportPath === undefined ? {} : { usageExportPath }), observationRoot: root };
  }

  sources(): ManagerLoopSource[] { return structuredClone(this.#sources); }

  async register(value: unknown): Promise<ManagerLoopRegistrationResult> {
    let resolveResult!: (result: ManagerLoopRegistrationResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<ManagerLoopRegistrationResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.#tail = this.#tail.catch(() => undefined).then(async () => {
      try {
        const source = await ManagerLoopRegistry.#trusted(this.#validate(value), this.#roots);
        const sameId = this.#sources.find((item) => item.id === source.id) ?? this.#reservedSources.find((item) => item.id === source.id);
        const sameDirectory = this.#sources.find((item) => item.artifactsDirectory === source.artifactsDirectory) ?? this.#reservedSources.find((item) => item.artifactsDirectory === source.artifactsDirectory);
        if (sameId || sameDirectory) {
          if (sameId?.artifactsDirectory === source.artifactsDirectory && sameDirectory?.id === source.id
            && sameId.productId === source.productId && sameId.podId === source.podId) resolveResult({ source: structuredClone(sameId), created: false });
          else throw new Error('manager_loop_registration_conflict');
          return;
        }
        const next = [...this.#sources, source];
        await this.#write(next);
        this.#sources = next;
        resolveResult({ source: structuredClone(source), created: true });
      } catch (error) { rejectResult(error); }
    });
    return result;
  }

  async #write(sources: readonly ManagerLoopSource[]): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      const registrations = sources.map(({ observationRoot: _observationRoot, ...source }) => source);
      await handle.writeFile(`${JSON.stringify({ format: FORMAT, registrations }, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temporary, this.#path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    } finally { await handle?.close(); }
  }
}
