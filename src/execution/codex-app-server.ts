import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { NativeWorkerIdentity } from '../runtime/contracts.ts';
import type { ProviderTurnLifecycle } from '../providers/contracts.ts';
import type { NativeIdentityProbe } from './index.ts';

type Json = Record<string, unknown>;
export const CODEX_APP_SERVER_PROTOCOL_VERSION = '0.162.0-alpha.17.2';
export interface NativeMcpExclusionBinding { path: string; sha256: string }
export interface NativeMcpExclusionManifest {
  format: 'faktori.native-mcp-exclusion/v1';
  protocolVersion: typeof CODEX_APP_SERVER_PROTOCOL_VERSION;
  serverNames: string[];
}
/** Raw CLI path segments are not TOML quoted keys. Dots, quotes and controls
 * are excluded; each full override is passed as one shell-free argv token. */
export async function readNativeMcpExclusionManifest(binding: NativeMcpExclusionBinding): Promise<NativeMcpExclusionManifest> {
  if (!isAbsolute(binding.path) || !/^[a-f0-9]{64}$/.test(binding.sha256) || await realpath(binding.path) !== binding.path) throw new Error('native_mcp_manifest_binding_invalid');
  const handle = await open(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 65536 || (before.mode & 0o077) !== 0 || typeof process.getuid === 'function' && before.uid !== process.getuid()) throw new Error('native_mcp_manifest_unavailable');
    const buffer = Buffer.alloc(65537); let position = 0;
    while (position < buffer.length) { const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position); if (!bytesRead) break; position += bytesRead; }
    const raw = buffer.subarray(0, position), after = await handle.stat(), named = await lstat(binding.path);
    if (position > 65536 || position !== before.size || !named.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode || before.uid !== after.uid || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== after.dev || named.ino !== after.ino || named.size !== after.size || named.mode !== after.mode || named.uid !== after.uid || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs || createHash('sha256').update(raw).digest('hex') !== binding.sha256) throw new Error('native_mcp_manifest_changed');
    const m = appServerRecord(JSON.parse(raw.toString('utf8')));
    if (Object.keys(m).some(k => !['format', 'protocolVersion', 'serverNames'].includes(k)) || m.format !== 'faktori.native-mcp-exclusion/v1' || m.protocolVersion !== CODEX_APP_SERVER_PROTOCOL_VERSION || !Array.isArray(m.serverNames) || m.serverNames.length > 400 || !m.serverNames.every(n => typeof n === 'string' && /^[A-Za-z0-9_@/-]{1,100}$/.test(n)) || new Set(m.serverNames).size !== m.serverNames.length) throw new Error('native_mcp_manifest_invalid');
    return m as unknown as NativeMcpExclusionManifest;
  } finally { await handle.close(); }
}
export function appServerRecord(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('native_protocol_invalid');
  return value as Json;
}
export interface CodexAppServerConnection {
  worker: NativeWorkerIdentity;
  /** Safe mode metadata only; account identifiers remain in private capture. */
  nativeAccountMode?: 'chatgpt';
  /** Exact manifest actually applied by this transport before process spawn. */
  mcpExclusion?: { sha256: string; serverNames: readonly string[] };
  request(method: string, params: Json, timeoutMs?: number): Promise<Json>;
  subscribe(listener: (method: string, params: Json) => void): () => void;
  close(reason?: 'timeout' | 'output_limit' | 'cancelled'): Promise<void>;
  /** Exact captured protocol bytes are private, never public Console evidence. */
  capture(): { stdout: string; stderr: string };
}
export interface CodexAppServerTransport {
  connect(cwd: string, lifecycle?: ProviderTurnLifecycle): Promise<CodexAppServerConnection>;
}
export interface CodexAppServerStdioOptions {
  executable: string;
  environment: Readonly<Record<string, string>>;
  runNonce: string;
  identityProbe: Pick<NativeIdentityProbe, 'inspect' | 'inspectProcessGroup'>;
  killProcessGroup(group: number, signal: NodeJS.Signals): void;
  maxOutputBytes: number;
  mcpExclusion?: NativeMcpExclusionBinding;
  /** Internal whole-feature fixture seam; production uses the installed executable. */
  spawn?: typeof spawn;
}
const METHODS = new Set(['initialize', 'account/read', 'mcpServerStatus/list', 'thread/start', 'thread/resume', 'thread/read', 'thread/goal/get', 'thread/goal/set', 'turn/start', 'turn/interrupt', 'thread/turns/list']);
const ENV = new Set(['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Supported by the pinned 0.162 app-server parser and offline config schema.
 * User/project config and rules still participate: these overrides do not
 * claim ambient-config, toolchain, credential-store or filesystem isolation. */
export const CODEX_APP_SERVER_ARGUMENTS: readonly string[] = Object.freeze([
  'app-server', '--stdio', '--strict-config',
  '--disable', 'memories', '--disable', 'apps', '--disable', 'plugins',
  '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--disable', 'hooks',
  '--disable', 'browser_use', '--disable', 'computer_use',
  '--disable', 'skill_mcp_dependency_install',
  '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
  '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
  '-c', 'apps._default.enabled=false', '-c', 'analytics.enabled=false',
]);

/** One owned stdio process per bounded turn; never connects to a desktop daemon. */
export class CodexAppServerStdioTransport implements CodexAppServerTransport {
  readonly options: CodexAppServerStdioOptions;
  #connected = false;
  constructor(options: CodexAppServerStdioOptions) {
    if (!options.environment.HOME || !options.environment.PATH || Object.entries(options.environment).some(([k, v]) => !ENV.has(k) || typeof v !== 'string' || v.includes('\0'))
      || !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1024 || options.maxOutputBytes > 8_000_000) throw new Error('native_transport_configuration_invalid');
    this.options = options;
  }
  async connect(cwd: string, lifecycle?: ProviderTurnLifecycle): Promise<CodexAppServerConnection> {
    if (this.#connected) throw new Error('native_transport_already_connected');
    this.#connected = true;
    const o = this.options;
    let manifest: NativeMcpExclusionManifest | undefined;
    try {
      manifest = o.mcpExclusion ? await readNativeMcpExclusionManifest(o.mcpExclusion) : undefined;
      if (o.mcpExclusion) {
        const workspace = await realpath(cwd), contains = (a: string, b: string) => { const r = relative(a, b); return r === '' || r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
        if (contains(workspace, o.mcpExclusion.path) || contains(o.mcpExclusion.path, workspace)) throw new Error('native_mcp_manifest_overlaps_workspace');
      }
    } catch (error) { this.#connected = false; throw error; }
    const mcpArgs = manifest?.serverNames.flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]) ?? [];
    const child = (o.spawn ?? spawn)(o.executable, [...CODEX_APP_SERVER_ARGUMENTS, ...mcpArgs], { cwd, env: { ...o.environment }, stdio: 'pipe', detached: true }) as ChildProcessWithoutNullStreams;
    let worker: NativeWorkerIdentity | undefined;
    let nextId = 0, stdout = '', stderr = '', buffer = '', total = 0, exited = false, failure: Error | undefined;
    const waiting = new Map<number, { resolve(value: Json): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    const listeners = new Set<(method: string, params: Json) => void>();
    const notifications: Array<{ method: string; params: Json }> = [];
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
    const fail = (reason: string) => {
      failure ??= new Error(reason);
      for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(failure); }
      waiting.clear();
      for (const listener of listeners) listener('faktori/transportFailed', { reason });
    };
    child.on('error', () => fail('native_process_failed'));
    child.on('close', () => { exited = true; fail('native_transport_disconnected'); });
    child.stdin.on('error', () => fail('native_transport_disconnected'));
    child.stderr.on('data', (chunk: Buffer) => { total += chunk.length; if (total > o.maxOutputBytes) return fail('native_output_limit'); stderr += errDecoder.write(chunk); });
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length; if (total > o.maxOutputBytes) return fail('native_output_limit');
      const decoded = outDecoder.write(chunk); stdout += decoded; buffer += decoded;
      if (Buffer.byteLength(buffer) > o.maxOutputBytes) return fail('native_output_limit');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const m = appServerRecord(JSON.parse(line));
          if (m.id !== undefined && typeof m.method === 'string') {
            // No automatic approval, dynamic tool or questionnaire replies.
            child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Factory profile does not authorize server requests' } }) + '\n');
            fail('native_interaction_required'); continue;
          }
          if (m.id !== undefined) {
            if (typeof m.id !== 'number') return fail('native_protocol_invalid');
            const entry = waiting.get(m.id); if (!entry) return fail('native_unexpected_rpc_response');
            waiting.delete(m.id); clearTimeout(entry.timer);
            if (m.error !== undefined) entry.reject(new Error('native_rpc_rejected'));
            else entry.resolve(appServerRecord(m.result));
          } else if (typeof m.method === 'string') {
            const params = appServerRecord(m.params); notifications.push({ method: m.method, params });
            for (const listener of listeners) listener(m.method, params);
          } else fail('native_protocol_invalid');
        } catch { fail('native_protocol_invalid'); }
      }
    });
    const same = async () => {
      if (!worker) return false;
      const p = await o.identityProbe.inspect(worker.pid);
      return p && !('status' in p) && p.running && p.processStartedAt === worker.processStartedAt && p.processGroupId === worker.processGroupId;
    };
    let closePromise: Promise<void> | undefined;
    const closeOwned = async (reason: 'timeout' | 'output_limit' | 'cancelled') => {
      child.stdin.end();
      for (let n = 0; n < 20 && !exited; n++) await delay(25);
      if (!exited && worker) {
        if (!await same()) throw new Error('native_close_identity_uncertain');
        await lifecycle?.onTerminationRequired?.(worker, reason);
        if (await same()) o.killProcessGroup(worker.processGroupId, 'SIGTERM');
        for (let n = 0; n < 20 && !exited; n++) await delay(25);
        if (!exited && await same()) o.killProcessGroup(worker.processGroupId, 'SIGKILL');
        for (let n = 0; n < 20 && !exited; n++) await delay(25);
      }
      const group = worker && await o.identityProbe.inspectProcessGroup?.(worker.processGroupId);
      this.#connected = false;
      if (!exited || !group || !('status' in group && group.status === 'absent') && !('members' in group && group.members.every(p => !p.running))) throw new Error('native_close_group_uncertain');
    };
    const close = (reason: 'timeout' | 'output_limit' | 'cancelled' = 'cancelled') => closePromise ??= Promise.resolve().then(() => closeOwned(reason));
    try {
      if (!child.pid) throw new Error('native_process_failed');
      const observed = await o.identityProbe.inspect(child.pid);
      if (!observed || 'status' in observed || !observed.running || observed.pid !== child.pid) throw new Error('native_worker_identity_unavailable');
      worker = { kind: 'native', pid: child.pid, processStartedAt: observed.processStartedAt, processGroupId: observed.processGroupId, runNonce: o.runNonce };
      await lifecycle?.onStarted(worker);
      const connection: CodexAppServerConnection = {
        worker,
        ...(manifest ? { mcpExclusion: { sha256: o.mcpExclusion!.sha256, serverNames: Object.freeze([...manifest.serverNames]) } } : {}),
        request: async (method, params, timeoutMs = 5000) => {
          if (!METHODS.has(method) || failure || exited || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw failure ?? new Error('native_request_unavailable');
          const id = ++nextId;
          return new Promise<Json>((resolve, reject) => {
            const timer = setTimeout(() => { waiting.delete(id); fail('native_rpc_timeout'); reject(new Error('native_rpc_timeout')); }, timeoutMs);
            waiting.set(id, { resolve, reject, timer });
            child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) fail('native_transport_disconnected'); });
          });
        },
        subscribe(listener) { listeners.add(listener); for (const n of notifications) listener(n.method, n.params); if (failure) listener('faktori/transportFailed', { reason: failure.message }); return () => listeners.delete(listener); }, close,
        capture: () => ({ stdout, stderr }),
      };
      await connection.request('initialize', { clientInfo: { name: 'faktori-native-supervision', version: '1' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      // No login, refresh, token export or API-provider fallback. A native
      // ChatGPT account must be observed before any persistent thread effect.
      const auth = await connection.request('account/read', { refreshToken: false });
      if (!auth.account || typeof auth.account !== 'object' || Array.isArray(auth.account) || appServerRecord(auth.account).type !== 'chatgpt' || auth.requiresOpenaiAuth !== true) throw new Error('native_chatgpt_account_required');
      connection.nativeAccountMode = 'chatgpt';
      return connection;
    } catch (error) { await close().catch(() => {}); throw error; }
  }
}
