import type { ProviderFinalResult, RunIntent, UsageTelemetry, WorkerIdentity } from '../runtime/contracts.ts';
import type {
  ProviderCurrentContext,
  ProviderNormalizedEvent,
  ProviderRunResult,
  ProviderSessionBinding,
  ProviderTurnLifecycle,
} from './contracts.ts';
import { providerContextIsAuthorized } from './contracts.ts';

/** The small, injected boundary around the vendor-owned Codex executable. */
export interface CodexProcessRunner {
  run(request: CodexProcessRequest): Promise<CodexProcessResult>;
  terminate?(request: CodexTerminationRequest): Promise<CodexTerminationResult>;
}

export interface CodexProcessRequest {
  runId: string;
  command: 'codex';
  args: string[];
  /** This is an operational path and must not be copied into public evidence. */
  cwd: string;
  timeoutMs: number;
  /** Exact allowlisted environment; the runner must not inherit the host environment. */
  environment: Readonly<Record<string, string>>;
  /** Supplied by delivery when it needs a durable worker-start boundary. */
  lifecycle?: CodexProcessLifecycle;
}

export type CodexProcessLifecycle = ProviderTurnLifecycle;

export interface CodexProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr?: string;
  /** True only when the wrapper deliberately stopped its child process. */
  terminated?: boolean;
}

export interface CodexTerminationRequest {
  runId: string;
  /** The same private operational cwd used for launch. */
  cwd: string;
  /** Required for coordinator-authorized termination of an active worker. */
  lifecycle?: CodexProcessLifecycle;
}

export interface CodexTerminationResult {
  /** A wrapper or process-group exit is not a vendor-native receipt. */
  processTerminated: boolean;
  nativeCancellationReceipt?: boolean;
}

export interface CodexAdapterLimits {
  maxRuntimeMinutes: number;
  maxTokens: number;
  maxRetries: number;
}

export interface CodexAdapterOptions {
  runner: CodexProcessRunner;
  limits: CodexAdapterLimits;
  /** Selected execution-profile environment, supplied by the coordinator. */
  environment: Readonly<Record<string, string>>;
  /** Defaults to the observed compatible Phase 0 runtime model. */
  compatibleModels?: readonly string[];
}

/** Current packet contents are separately bound to the immutable RunIntent reference. */
export type CodexCurrentContext = ProviderCurrentContext;

/** Coordinator-recorded provenance required to resume a disposable native session. */
export type CodexSessionBinding = ProviderSessionBinding;

export interface CodexProviderCapabilities {
  resume: true;
  usage: 'reported_or_partial_when_emitted';
  approvalReplies: false;
  questions: false;
  nativeSandbox: 'unavailable';
  nativeCancellationReceipt: 'unavailable';
}

export type CodexNormalizedEvent = ProviderNormalizedEvent;

export type CodexRunResult = ProviderRunResult;

type Outcome = ProviderFinalResult['outcome'];
type JsonRecord = Record<string, unknown>;
type LifecycleObservation = { started: boolean; callbackFailed: boolean };

const OUTCOMES = new Set<Outcome>([
  'completed',
  'unchanged_verified',
  'denied',
  'authentication_required',
  'quota_exhausted',
  'failed',
  'cancelled',
  'interrupted_uncertain',
  'unavailable',
]);

const CAPABILITIES: CodexProviderCapabilities = Object.freeze({
  resume: true,
  usage: 'reported_or_partial_when_emitted',
  approvalReplies: false,
  questions: false,
  nativeSandbox: 'unavailable',
  nativeCancellationReceipt: 'unavailable',
});

const SUCCESS_OUTCOMES = new Set<Outcome>(['completed', 'unchanged_verified']);
const NATIVE_SUCCESS_TERMINAL_TYPES = new Set(['turn.completed']);
const ERROR_EVENT_TYPES = new Set(['error', 'turn.failed', 'turn.cancelled']);
const MAX_ERROR_EVIDENCE_LENGTH = 320;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asFiniteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nested(recordValue: JsonRecord, key: string): JsonRecord | undefined {
  return record(recordValue[key]) ? recordValue[key] : undefined;
}

function firstString(event: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asNonEmptyString(event[key]);
    if (value) return value;
  }
  return undefined;
}

function sanitizeErrorEvidence(value: string): string | undefined {
  const compact = value
    .replace(/(?:bearer|token|api[_-]?key|authorization)\s*[=:]?\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\/(?:Users|home)\/[^\s,;]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length > 0 ? compact.slice(0, MAX_ERROR_EVIDENCE_LENGTH) : undefined;
}

function errorFields(event: JsonRecord): { code?: string; message?: string } | undefined {
  const type = asNonEmptyString(event.type)?.toLowerCase();
  if (!type || !ERROR_EVENT_TYPES.has(type)) return undefined;
  const payload = nested(event, 'error');
  const errorAsText = asNonEmptyString(event.error);
  const code = firstString(event, ['code', 'error_code']) ?? (payload ? firstString(payload, ['code', 'error_code']) : undefined);
  const message = firstString(event, ['message']) ?? (payload ? firstString(payload, ['message', 'detail']) : undefined) ?? errorAsText;
  return code || message ? { code, message } : undefined;
}

function classifyKnownError(code: string | undefined, message: string | undefined): Outcome | undefined {
  const joined = `${code ?? ''} ${message ?? ''}`.toLowerCase();
  if (/auth|login|credential/.test(joined)) return 'authentication_required';
  if (/quota|rate.?limit|usage.?limit|capacity/.test(joined)) return 'quota_exhausted';
  if (/permission|denied|approval.?required/.test(joined)) return 'denied';
  if (/cancel/.test(joined)) return 'cancelled';
  if (/unavailable|not.?installed|spawn/.test(joined)) return 'unavailable';
  if (/interrupt|terminated|killed/.test(joined)) return 'interrupted_uncertain';
  return undefined;
}

function explicitSuccessOutcome(event: JsonRecord): Outcome | undefined {
  if (!NATIVE_SUCCESS_TERMINAL_TYPES.has(asNonEmptyString(event.type) ?? '')) return undefined;
  const outcome = event.outcome;
  return typeof outcome === 'string' && SUCCESS_OUTCOMES.has(outcome as Outcome) ? outcome as Outcome : undefined;
}

function usageFromEvent(event: JsonRecord): UsageTelemetry | undefined {
  const source = nested(event, 'usage') ?? nested(event, 'token_usage');
  if (!source) return undefined;
  const inputTokens = asFiniteNonNegativeInteger(source.input_tokens ?? source.inputTokens);
  const cachedInputTokens = asFiniteNonNegativeInteger(source.cached_input_tokens ?? source.cachedInputTokens);
  const outputTokens = asFiniteNonNegativeInteger(source.output_tokens ?? source.outputTokens);
  const reasoningTokens = asFiniteNonNegativeInteger(source.reasoning_tokens ?? source.reasoningTokens);
  const present = [inputTokens, cachedInputTokens, outputTokens, reasoningTokens].filter((value) => value !== undefined).length;
  if (present === 0) return { availability: 'unavailable', unavailableReason: 'provider emitted usage without token fields' };
  const expected = 3;
  return {
    availability: present >= expected ? 'reported' : 'partially_reported',
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    reportedBy: 'codex.exec.json',
    ...(present >= expected ? {} : { unavailableReason: 'provider did not emit all token categories' }),
  };
}

function sessionFromEvent(event: JsonRecord): string | undefined {
  const direct = firstString(event, ['thread_id', 'threadId', 'session_id', 'sessionId']);
  if (direct) return direct;
  return firstString(nested(event, 'thread') ?? {}, ['id', 'thread_id', 'session_id']);
}

function summaryFromEvent(event: JsonRecord): string | undefined {
  const direct = firstString(event, ['last_agent_message', 'summary', 'message', 'text']);
  if (direct) return direct;
  const item = nested(event, 'item');
  return item ? firstString(item, ['text', 'message', 'summary']) : undefined;
}

function verificationFromEvent(event: JsonRecord): string[] | undefined {
  if (!Array.isArray(event.verification)) return undefined;
  const verification = event.verification.filter((value): value is string => typeof value === 'string' && value.length > 0);
  return verification.length > 0 ? verification : undefined;
}

function nativeReceiptFromEvent(event: JsonRecord): boolean {
  return event.native_cancellation_receipt === true || event.nativeCancellationReceipt === true;
}

function boundedFailure(reason: string): ProviderFinalResult {
  return {
    outcome: 'unavailable',
    summary: reason,
    usage: { availability: 'unavailable', unavailableReason: reason },
    nativeCancellationReceipt: false,
  };
}

function validateIntent(intent: RunIntent, limits: CodexAdapterLimits, compatibleModels: ReadonlySet<string>): string | undefined {
  if (intent.execution.providerId !== 'codex') return 'run intent is not assigned to the codex provider';
  if (!asNonEmptyString(intent.execution.workspacePath)) return 'run intent has no recorded workspace path';
  if (!compatibleModels.has(intent.execution.model)) return 'run intent model is not in the configured compatible model set';
  if (!Number.isInteger(intent.attempt) || intent.attempt < 1 || intent.attempt > limits.maxRetries + 1) return 'run attempt exceeds the configured retry bound';
  if (intent.budget.maxRuntimeMinutes < 1 || intent.budget.maxRuntimeMinutes > limits.maxRuntimeMinutes) return 'run runtime exceeds the configured runtime bound';
  if (intent.budget.estimatedTokens < 0 || intent.budget.estimatedTokens > limits.maxTokens) return 'run token estimate exceeds the configured token bound';
  return undefined;
}

function contextPrompt(intent: RunIntent, currentContext: CodexCurrentContext): string | undefined {
  if (currentContext.packetRevision !== intent.context.packetRevision || currentContext.digest !== intent.context.digest) {
    return undefined;
  }
  return currentContext.prompt.trim().length > 0 ? currentContext.prompt : undefined;
}

function contextMatchesIntent(intent: RunIntent, currentContext: CodexCurrentContext): boolean {
  return currentContext.packetRevision === intent.context.packetRevision && currentContext.digest === intent.context.digest;
}

function validEnvironment(environment: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(environment);
  return entries.length > 0 && entries.every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\u0000'));
}

function validSessionBinding(intent: RunIntent, binding: CodexSessionBinding): boolean {
  const scope = binding.sourceScope;
  return asNonEmptyString(binding.sessionId) !== undefined
    && asNonEmptyString(binding.sourceRunId) !== undefined
    && asNonEmptyString(binding.sourceContext.packetRevision) !== undefined
    && asNonEmptyString(binding.sourceContext.digest) !== undefined
    && scope !== null
    && typeof scope === 'object'
    && asNonEmptyString(scope.factoryId) === intent.target.factoryId
    && asNonEmptyString(scope.productId) === intent.target.productId
    && asNonEmptyString(scope.repository) === intent.target.repository
    && asNonEmptyString(scope.workspaceId) === intent.execution.workspaceId
    && asNonEmptyString(scope.workspacePath) === intent.execution.workspacePath
    && asNonEmptyString(scope.providerId) === intent.execution.providerId;
}

function observedLifecycle(lifecycle: CodexProcessLifecycle): { lifecycle: CodexProcessLifecycle; observation: LifecycleObservation } {
  const observation: LifecycleObservation = { started: false, callbackFailed: false };
  return {
    observation,
    lifecycle: {
      async onStarted(worker: WorkerIdentity): Promise<void> {
        if (observation.started) {
          observation.callbackFailed = true;
          throw new Error('Codex process runner reported more than one worker start');
        }
        try {
          await lifecycle.onStarted(worker);
          observation.started = true;
        } catch (error) {
          observation.callbackFailed = true;
          throw error;
        }
      },
      ...(lifecycle.onTerminationRequired === undefined ? {} : {
        async onTerminationRequired(worker: WorkerIdentity, reason: 'timeout' | 'output_limit' | 'cancelled'): Promise<void> {
          try {
            await lifecycle.onTerminationRequired?.(worker, reason);
          } catch (error) {
            observation.callbackFailed = true;
            throw error;
          }
        },
      }),
    },
  };
}

function lifecycleFinal(final: ProviderFinalResult, observation: LifecycleObservation | undefined): ProviderFinalResult {
  if (observation?.callbackFailed) {
    return { ...final, outcome: 'interrupted_uncertain', summary: 'worker lifecycle callback failed before a durable start receipt was confirmed', nativeCancellationReceipt: false };
  }
  if (observation !== undefined && !observation.started && SUCCESS_OUTCOMES.has(final.outcome)) {
    return { ...final, outcome: 'interrupted_uncertain', summary: 'Codex process returned without a durable worker-start receipt', nativeCancellationReceipt: false };
  }
  return final;
}

function timeoutMs(intent: RunIntent): number {
  return intent.budget.maxRuntimeMinutes * 60_000;
}

function baseArgs(model: string): string[] {
  // Deliberately do not supply --sandbox, --dangerously-bypass-approvals-and-sandbox,
  // --add-dir, or any approval-widening configuration. Native behavior is unproven.
  return ['--json', '--model', model];
}

function parseEvents(stdout: string): { events: CodexNormalizedEvent[]; malformedEventCount: number } {
  const events: CodexNormalizedEvent[] = [];
  let malformedEventCount = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!record(value) || !asNonEmptyString(value.type)) {
        malformedEventCount += 1;
        continue;
      }
      events.push({ type: asNonEmptyString(value.type) as string, raw: value });
    } catch {
      malformedEventCount += 1;
    }
  }
  return { events, malformedEventCount };
}

function finalFrom(events: CodexNormalizedEvent[], malformedEventCount: number, processResult: CodexProcessResult): { final: ProviderFinalResult; errorEvidence?: string } {
  let observedError: Outcome | undefined;
  let explicitSuccess: Outcome | undefined;
  let recognizedSuccessTerminal = false;
  let errorEvidence: string | undefined;
  let sessionId: string | undefined;
  let summary: string | undefined;
  let verification: string[] | undefined;
  let usage: UsageTelemetry | undefined;
  let nativeCancellationReceipt = false;

  for (const event of events) {
    const type = asNonEmptyString(event.raw.type);
    recognizedSuccessTerminal = recognizedSuccessTerminal || (type !== undefined && NATIVE_SUCCESS_TERMINAL_TYPES.has(type));
    explicitSuccess = explicitSuccessOutcome(event.raw) ?? explicitSuccess;
    const fields = errorFields(event.raw);
    if (fields) {
      observedError = classifyKnownError(fields.code, fields.message) ?? 'failed';
      errorEvidence = sanitizeErrorEvidence([fields.code, fields.message].filter((value): value is string => value !== undefined).join(': ')) ?? errorEvidence;
    }
    sessionId = sessionFromEvent(event.raw) ?? sessionId;
    summary = summaryFromEvent(event.raw) ?? summary;
    verification = verificationFromEvent(event.raw) ?? verification;
    usage = usageFromEvent(event.raw) ?? usage;
    nativeCancellationReceipt = nativeReceiptFromEvent(event.raw) || nativeCancellationReceipt;
  }

  const stderrEvidence = processResult.exitCode !== 0 ? sanitizeErrorEvidence(processResult.stderr ?? '') : undefined;
  const stderrOutcome = processResult.exitCode !== 0 ? classifyKnownError(undefined, stderrEvidence) : undefined;
  let outcome: Outcome;
  if (processResult.terminated || processResult.exitCode === null) outcome = 'interrupted_uncertain';
  else if (processResult.exitCode !== 0 && observedError && !SUCCESS_OUTCOMES.has(observedError)) outcome = observedError;
  else if (processResult.exitCode !== 0 && stderrOutcome) outcome = stderrOutcome;
  // A nonzero exit is never a successful provider receipt, even if an event claimed one.
  else if (processResult.exitCode !== 0) outcome = 'failed';
  else if (observedError === 'cancelled' && !nativeCancellationReceipt) outcome = 'interrupted_uncertain';
  else if (observedError) outcome = observedError;
  // Success requires a recognized native terminal event plus a clean JSONL stream and exit 0.
  else if (!recognizedSuccessTerminal || malformedEventCount > 0) outcome = 'failed';
  else if (explicitSuccess === 'unchanged_verified' && !verification) outcome = 'failed';
  else outcome = explicitSuccess ?? 'completed';

  return {
    final: {
      outcome,
      ...(sessionId ? { sessionId } : {}),
      ...(summary ? { summary } : {}),
      ...(verification ? { verification } : {}),
      ...(errorEvidence ?? stderrEvidence ? { summary: errorEvidence ?? stderrEvidence } : {}),
      usage: usage ?? { availability: 'unavailable', unavailableReason: 'Codex JSONL did not emit usage telemetry' },
      nativeCancellationReceipt,
    },
    ...(errorEvidence ?? stderrEvidence ? { errorEvidence: errorEvidence ?? stderrEvidence } : {}),
  };
}

/**
 * Bounded adapter for the unmodified `codex exec --json` transport.
 *
 * This adapter intentionally reports provider results only. It neither grants
 * coordinator authority nor treats a provider response as permission to act.
 */
export class CodexAdapter {
  readonly capabilities = CAPABILITIES;
  readonly #runner: CodexProcessRunner;
  readonly #limits: CodexAdapterLimits;
  readonly #compatibleModels: ReadonlySet<string>;
  readonly #environment: Readonly<Record<string, string>>;

  constructor(options: CodexAdapterOptions) {
    this.#runner = options.runner;
    this.#limits = options.limits;
    this.#compatibleModels = new Set(options.compatibleModels ?? ['gpt-5.5']);
    this.#environment = Object.freeze({ ...options.environment });
  }

  async start(intent: RunIntent, currentContext: CodexCurrentContext, lifecycle?: CodexProcessLifecycle): Promise<CodexRunResult> {
    const prompt = contextPrompt(intent, currentContext);
    const invalid = validateIntent(intent, this.#limits, this.#compatibleModels)
      ?? (validEnvironment(this.#environment) ? undefined : 'a nonempty controlled execution environment is required')
      ?? (contextMatchesIntent(intent, currentContext) ? undefined : 'current context reference does not match the run intent')
      ?? (prompt ? undefined : 'current context packet and prompt are required')
      ?? (providerContextIsAuthorized(intent, currentContext) ? undefined : 'current context prompt payload is not authorized by the run intent');
    if (invalid) return this.#unavailable('start', invalid);
    return this.#execute('start', intent, ['exec', ...baseArgs(intent.execution.model), prompt as string], lifecycle);
  }

  async resume(intent: RunIntent, sessionBinding: CodexSessionBinding, currentContext: CodexCurrentContext, lifecycle?: CodexProcessLifecycle): Promise<CodexRunResult> {
    const prompt = contextPrompt(intent, currentContext);
    const invalid = validateIntent(intent, this.#limits, this.#compatibleModels)
      ?? (validEnvironment(this.#environment) ? undefined : 'a nonempty controlled execution environment is required')
      ?? (contextMatchesIntent(intent, currentContext) ? undefined : 'current context reference does not match the run intent')
      ?? (validSessionBinding(intent, sessionBinding) ? undefined : 'an explicit coordinator-recorded session binding is required for resume; --last is forbidden')
      ?? (prompt ? undefined : 'current context packet and prompt are required')
      ?? (providerContextIsAuthorized(intent, currentContext) ? undefined : 'current context prompt payload is not authorized by the run intent');
    if (invalid) return this.#unavailable('resume', invalid);
    return this.#execute('resume', intent, ['exec', 'resume', ...baseArgs(intent.execution.model), sessionBinding.sessionId, prompt as string], lifecycle);
  }

  async cancel(intent: RunIntent, lifecycle?: CodexProcessLifecycle): Promise<ProviderFinalResult> {
    const invalid = validateIntent(intent, this.#limits, this.#compatibleModels)
      ?? (validEnvironment(this.#environment) ? undefined : 'a nonempty controlled execution environment is required');
    if (invalid) return boundedFailure(invalid);
    if (!this.#runner.terminate) {
      return {
        outcome: 'unavailable',
        summary: 'the injected process runner cannot terminate a Codex worker',
        usage: { availability: 'unavailable', unavailableReason: 'no process termination transport' },
        nativeCancellationReceipt: false,
      };
    }
    try {
      const result = await this.#runner.terminate({
        runId: intent.runId,
        cwd: intent.execution.workspacePath,
        ...(lifecycle === undefined ? {} : { lifecycle }),
      });
      if (result.nativeCancellationReceipt) {
        return {
          outcome: 'cancelled',
          summary: 'native cancellation receipt observed',
          usage: { availability: 'unavailable', unavailableReason: 'cancellation does not supply usage telemetry' },
          nativeCancellationReceipt: true,
        };
      }
      return {
        outcome: result.processTerminated ? 'interrupted_uncertain' : 'failed',
        summary: result.processTerminated ? 'wrapper termination observed without a native Codex cancellation receipt' : 'wrapper could not confirm worker termination',
        usage: { availability: 'unavailable', unavailableReason: 'cancellation does not supply usage telemetry' },
        nativeCancellationReceipt: false,
      };
    } catch {
      return {
        outcome: 'interrupted_uncertain',
        summary: 'process termination threw before a native Codex cancellation receipt was observed',
        usage: { availability: 'unavailable', unavailableReason: 'cancellation transport failed' },
        nativeCancellationReceipt: false,
      };
    }
  }

  async #execute(command: 'start' | 'resume', intent: RunIntent, args: string[], suppliedLifecycle?: CodexProcessLifecycle): Promise<CodexRunResult> {
    try {
      const observed = suppliedLifecycle === undefined ? undefined : observedLifecycle(suppliedLifecycle);
      const result = await this.#runner.run({
        runId: intent.runId,
        command: 'codex',
        args,
        // The actual OS cwd is part of the recovery identity. Do not substitute
        // a convenience process cwd, provider session cwd, or inferred checkout.
        cwd: intent.execution.workspacePath,
        timeoutMs: timeoutMs(intent),
        environment: this.#environment,
        ...(observed === undefined ? {} : { lifecycle: observed.lifecycle }),
      });
      const parsed = parseEvents(result.stdout);
      const normalized = finalFrom(parsed.events, parsed.malformedEventCount, result);
      const final = lifecycleFinal(normalized.final, observed?.observation);
      return { command, sessionId: final.sessionId, ...parsed, ...normalized, final };
    } catch {
      return this.#unavailable(command, 'Codex process transport was unavailable before a receipt was observed');
    }
  }

  #unavailable(command: 'start' | 'resume', reason: string): CodexRunResult {
    return { command, events: [], malformedEventCount: 0, final: boundedFailure(reason) };
  }
}
