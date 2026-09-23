import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OUTPUT = 64 * 1024;

export interface CodexGoalObservation {
  format: 'faktori.codex-goal-observation/v1';
  threadId: string;
  observedAt: string;
  status: 'active' | 'inactive' | 'missing' | 'unavailable';
  reason?: 'invalid_task_id' | 'timeout' | 'process_failed' | 'protocol_error' | 'output_limit';
  goal?: { status: string; objectivePresent: boolean };
}

/** `spawn` is an internal test seam; callers receive no provider-control capability. */
export interface ObserveCodexGoalOptions {
  timeoutMs?: number;
  /** @internal */ executable?: string;
  /** @internal */ spawn?: typeof spawnProcess;
}

function unavailable(threadId: string, reason: CodexGoalObservation['reason'] = 'protocol_error'): CodexGoalObservation {
  return { format: 'faktori.codex-goal-observation/v1', threadId, observedAt: new Date().toISOString(), status: 'unavailable', reason };
}
function parseGoal(value: unknown, threadId: string): CodexGoalObservation['goal'] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  if (envelope.goal === null || typeof envelope.goal !== 'object' || Array.isArray(envelope.goal)) return undefined;
  const goal = envelope.goal as Record<string, unknown>;
  if (goal.threadId !== threadId || !['active', 'complete', 'blocked'].includes(String(goal.status))
    || typeof goal.objective !== 'string' || goal.objective.trim().length === 0 || goal.objective.length > 4000) return undefined;
  return { status: String(goal.status), objectivePresent: typeof goal.objective === 'string' && goal.objective.trim().length > 0 };
}

/**
 * A single, read-only app-server observation. It never scans history or emits
 * any goal mutation method; malformed/protocol failures fail closed.
 */
export async function observeCodexGoal(threadId: string, options: ObserveCodexGoalOptions = {}): Promise<CodexGoalObservation> {
  if (!THREAD_ID.test(threadId)) return unavailable(threadId, 'invalid_task_id');
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) return unavailable(threadId);
  const spawn = options.spawn ?? spawnProcess;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(options.executable ?? 'codex', ['app-server'], { stdio: 'pipe', shell: false });
    const process = child;
    const result = await new Promise<CodexGoalObservation>((resolve) => {
      let settled = false; let lineBuffer = ''; let totalBytes = 0; let initialized = false; let exited = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: CodexGoalObservation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.stdin.end();
        if (!exited) {
          process.kill();
          killTimer = setTimeout(() => { if (!exited) process.kill('SIGKILL'); }, 1000);
          killTimer.unref();
        }
        // Keep error handlers and drain streams until exit: late vendor errors
        // must not become uncaught exceptions after an observation is returned.
        resolve(value);
      };
      const timer = setTimeout(() => finish(unavailable(threadId, 'timeout')), timeoutMs);
      const send = (id: number, method: string, params?: Record<string, unknown>) => {
        const line = JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n';
        process.stdin.write(line, (error) => { if (error) finish(unavailable(threadId)); });
      };
      process.on('error', () => finish(unavailable(threadId, 'process_failed')));
      process.on('exit', () => { exited = true; clearTimeout(killTimer); if (!settled) finish(unavailable(threadId, 'process_failed')); });
      process.stdin.on('error', () => finish(unavailable(threadId, 'process_failed')));
      process.stderr.on('data', () => { /* Deliberately never expose vendor stderr. */ });
      process.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        totalBytes += chunk.byteLength; if (totalBytes > MAX_OUTPUT) return finish(unavailable(threadId, 'output_limit'));
        const lines = (lineBuffer + chunk.toString('utf8')).split('\n'); lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          let message: Record<string, unknown>;
          try { const parsed = JSON.parse(line) as unknown; if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return finish(unavailable(threadId)); message = parsed as Record<string, unknown>; } catch { return finish(unavailable(threadId)); }
          if (message.id === 1) { if (initialized || message.error !== undefined || message.result === undefined) return finish(unavailable(threadId)); initialized = true; process.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`); send(2, 'thread/goal/get', { threadId }); continue; }
          if (message.id === 2) {
            if (!initialized || message.error !== undefined) return finish(unavailable(threadId));
            if (message.result !== null && typeof message.result === 'object' && !Array.isArray(message.result) && (message.result as Record<string, unknown>).goal === null) return finish({ format: 'faktori.codex-goal-observation/v1', threadId, observedAt: new Date().toISOString(), status: 'missing' });
            const goal = parseGoal(message.result, threadId);
            return finish(goal === undefined ? unavailable(threadId)
              : { format: 'faktori.codex-goal-observation/v1', threadId, observedAt: new Date().toISOString(), status: goal.status === 'active' ? 'active' : 'inactive', goal });
          }
          // Vendor notifications are not responses to this query. They may
          // arrive during initialization, but never authorize a result.
          if (message.id === undefined && typeof message.method === 'string') continue;
          return finish(unavailable(threadId));
        }
      });
      send(1, 'initialize', { clientInfo: { name: 'faktori', version: '1' }, capabilities: {} });
    });
    return result;
  } catch { child?.kill(); return unavailable(threadId, 'process_failed'); }
}
