import { randomUUID } from 'node:crypto';

import type { ProviderFinalResult, RunIntent, UsageTelemetry, WorkerIdentity } from '../runtime/contracts.ts';
import type {
  ProviderCurrentContext,
  ProviderNormalizedEvent,
  ProviderRunResult,
  ProviderSessionBinding,
  ProviderTurnLifecycle,
} from './contracts.ts';
import { providerContextIsAuthorized } from './contracts.ts';

/** The small, injected boundary around the vendor-owned Claude executable. */
export interface ClaudeProcessRunner {
  run(request: ClaudeProcessRequest): Promise<ClaudeProcessResult>;
  terminate?(request: ClaudeTerminationRequest): Promise<ClaudeTerminationResult>;
}

export interface ClaudeProcessRequest {
  runId: string;
  command: 'claude';
  args: string[];
  /** Private operational path; never copy it into public evidence. */
  cwd: string;
  timeoutMs: number;
  /** Exact allowlisted environment; the runner must not inherit the host environment. */
  environment: Readonly<Record<string, string>>;
  lifecycle?: ClaudeProcessLifecycle;
}

export type ClaudeProcessLifecycle = ProviderTurnLifecycle;

export interface ClaudeProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr?: string;
  /** True only when the wrapper deliberately stopped its child process. */
  terminated?: boolean;
}

export interface ClaudeTerminationRequest {
  runId: string;
  cwd: string;
  lifecycle?: ClaudeProcessLifecycle;
}

export interface ClaudeTerminationResult {
  /** A wrapper or process-group exit is not a vendor-native receipt. */
  processTerminated: boolean;
  nativeCancellationReceipt?: boolean;
}

export interface ClaudeAdapterLimits {
  maxRuntimeMinutes: number;
  maxTokens: number;
  maxRetries: number;
}

export interface ClaudeAdapterOptions {
  runner: ClaudeProcessRunner;
  limits: ClaudeAdapterLimits;
  /** Selected execution-profile environment, supplied by the coordinator. */
  environment: Readonly<Record<string, string>>;
  /** Explicitly approved model identifiers for this execution profile. */
  compatibleModels: readonly string[];
  /** Tool names constrained by the selected profile. An empty list suppresses all tools. */
  allowedTools: readonly string[];
  /** Only the observed manual mode is supported by this adapter. */
  permissionMode?: 'manual';
  /** Injectable only for deterministic tests; production defaults to randomUUID. */
  createSessionId?: () => string;
}

export type ClaudeCurrentContext = ProviderCurrentContext;
export type ClaudeSessionBinding = ProviderSessionBinding;
export type ClaudeNormalizedEvent = ProviderNormalizedEvent;
export type ClaudeRunResult = ProviderRunResult;

export interface ClaudeProviderCapabilities {
  resume: true;
  usage: 'reported_or_partial_when_emitted';
  approvalReplies: false;
  questions: false;
  permissions: 'tool_suppression_only';
  nativeCancellationReceipt: 'unavailable';
}

type Outcome = ProviderFinalResult['outcome'];
type JsonRecord = Record<string, unknown>;
type LifecycleObservation = { started: boolean; callbackFailed: boolean };

const SUCCESS_OUTCOMES = new Set<Outcome>(['completed', 'unchanged_verified']);
const MAX_ERROR_EVIDENCE_LENGTH = 320;
const CAPABILITIES: ClaudeProviderCapabilities = Object.freeze({
  resume: true,
  usage: 'reported_or_partial_when_emitted',
  approvalReplies: false,
  questions: false,
  permissions: 'tool_suppression_only',
  nativeCancellationReceipt: 'unavailable',
});

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asFiniteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nested(value: JsonRecord, key: string): JsonRecord | undefined {
  return record(value[key]) ? value[key] : undefined;
}

function firstString(value: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = asNonEmptyString(value[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function sanitizeErrorEvidence(value: string): string | undefined {
  const compact = value
    .replace(/(?:bearer\s+|token\s*[=:]?\s*|api[_-]?key\s*[=:]?\s*|authorization\s*(?:[=:]\s*|bearer\s+)?)[^\s,;]+/gi, '[redacted]')
    .replace(/\/(?:Users|home)\/[^\s,;]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.length === 0 ? undefined : compact.slice(0, MAX_ERROR_EVIDENCE_LENGTH);
}

function classifyKnownError(code: string | undefined, message: string | undefined): Outcome | undefined {
  const joined = `${code ?? ''} ${message ?? ''}`.toLowerCase();
  if (/auth|login|credential|oauth/.test(joined)) return 'authentication_required';
  if (/quota|rate.?limit|usage.?limit|capacity|overloaded/.test(joined)) return 'quota_exhausted';
  if (/permission|denied|approval.?required|tool.?not.?allowed/.test(joined)) return 'denied';
  if (/cancel/.test(joined)) return 'cancelled';
  if (/unavailable|not.?installed|spawn/.test(joined)) return 'unavailable';
  if (/interrupt|terminated|killed/.test(joined)) return 'interrupted_uncertain';
  return undefined;
}

function sessionFromEvent(event: JsonRecord): string | undefined {
  const direct = firstString(event, ['session_id', 'sessionId']);
  if (direct) return direct;
  return firstString(nested(event, 'session') ?? {}, ['id', 'session_id']);
}

function summaryFromEvent(event: JsonRecord): string | undefined {
  return firstString(event, ['result', 'summary', 'message', 'text'])
    ?? firstString(nested(event, 'message') ?? {}, ['text', 'content']);
}

function verificationFromEvent(event: JsonRecord): string[] | undefined {
  if (!Array.isArray(event.verification)) return undefined;
  const verification = event.verification.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return verification.length > 0 ? verification : undefined;
}

function errorFromEvent(event: JsonRecord): { code?: string; message?: string } | undefined {
  const type = asNonEmptyString(event.type)?.toLowerCase();
  if (type !== 'result' && type !== 'error') return undefined;
  const error = nested(event, 'error');
  const denial = Array.isArray(event.permission_denials) && event.permission_denials.length > 0;
  const errored = event.is_error === true || type === 'error' || denial;
  if (!errored) return undefined;
  const code = denial
    ? 'permission_denied'
    : firstString(event, ['error_code', 'code', 'subtype']) ?? (error ? firstString(error, ['code', 'error_code', 'type']) : undefined);
  const message = firstString(event, ['result', 'message', 'error']) ?? (error ? firstString(error, ['message', 'detail']) : undefined)
    ?? (denial ? 'provider reported tool permission denial' : undefined);
  return code || message ? { code, message } : { message: 'Claude stream emitted an unclassified error result' };
}

function usageFromEvent(event: JsonRecord): UsageTelemetry | undefined {
  const source = nested(event, 'usage') ?? nested(event, 'token_usage');
  if (!source) return undefined;
  const inputTokens = asFiniteNonNegativeInteger(source.input_tokens ?? source.inputTokens);
  const cachedInputTokens = asFiniteNonNegativeInteger(
    source.cache_read_input_tokens ?? source.cacheReadInputTokens ?? source.cached_input_tokens ?? source.cachedInputTokens,
  );
  const outputTokens = asFiniteNonNegativeInteger(source.output_tokens ?? source.outputTokens);
  const reasoningTokens = asFiniteNonNegativeInteger(source.reasoning_tokens ?? source.reasoningTokens);
  const present = [inputTokens, cachedInputTokens, outputTokens, reasoningTokens].filter((value) => value !== undefined).length;
  if (present === 0) return { availability: 'unavailable', unavailableReason: 'provider emitted usage without token fields' };
  return {
    availability: inputTokens !== undefined && outputTokens !== undefined ? 'reported' : 'partially_reported',
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    reportedBy: 'claude.print.stream-json',
    ...(inputTokens !== undefined && outputTokens !== undefined ? {} : { unavailableReason: 'provider did not emit both input and output tokens' }),
  };
}

function boundedFailure(reason: string): ProviderFinalResult {
  return {
    outcome: 'unavailable',
    summary: reason,
    usage: { availability: 'unavailable', unavailableReason: reason },
    nativeCancellationReceipt: false,
  };
}

function validLimits(limits: ClaudeAdapterLimits): boolean {
  return Number.isInteger(limits.maxRuntimeMinutes) && limits.maxRuntimeMinutes > 0
    && Number.isInteger(limits.maxTokens) && limits.maxTokens >= 0
    && Number.isInteger(limits.maxRetries) && limits.maxRetries >= 0;
}

function validEnvironment(environment: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(environment);
  return entries.length > 0 && entries.every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\u0000'));
}

function validToolNames(tools: readonly string[]): boolean {
  return tools.every((tool) => typeof tool === 'string' && tool.trim().length > 0 && !/[\u0000\r\n]/.test(tool));
}

function validateIntent(intent: RunIntent, limits: ClaudeAdapterLimits, compatibleModels: ReadonlySet<string>): string | undefined {
  if (!validLimits(limits)) return 'configured Claude limits are invalid';
  if (intent.execution.providerId !== 'claude') return 'run intent is not assigned to the claude provider';
  if (!asNonEmptyString(intent.execution.workspacePath)) return 'run intent has no recorded workspace path';
  if (!compatibleModels.has(intent.execution.model)) return 'run intent model is not in the configured compatible model set';
  if (!Number.isInteger(intent.attempt) || intent.attempt < 1 || intent.attempt > limits.maxRetries + 1) return 'run attempt exceeds the configured retry bound';
  if (!Number.isInteger(intent.budget.maxRuntimeMinutes) || intent.budget.maxRuntimeMinutes < 1 || intent.budget.maxRuntimeMinutes > limits.maxRuntimeMinutes) return 'run runtime exceeds the configured runtime bound';
  if (!Number.isInteger(intent.budget.estimatedTokens) || intent.budget.estimatedTokens < 0 || intent.budget.estimatedTokens > limits.maxTokens) return 'run token estimate exceeds the configured token bound';
  return undefined;
}

function contextPrompt(intent: RunIntent, currentContext: ClaudeCurrentContext): string | undefined {
  if (currentContext.packetRevision !== intent.context.packetRevision || currentContext.digest !== intent.context.digest) return undefined;
  return currentContext.prompt.trim().length > 0 ? currentContext.prompt : undefined;
}

function validSessionBinding(intent: RunIntent, binding: ClaudeSessionBinding): boolean {
  const scope = binding.sourceScope;
  return asNonEmptyString(binding.sessionId) !== undefined
    && asNonEmptyString(binding.sourceRunId) !== undefined
    && asNonEmptyString(binding.sourceContext.packetRevision) !== undefined
    && asNonEmptyString(binding.sourceContext.digest) !== undefined
    && asNonEmptyString(scope.factoryId) === intent.target.factoryId
    && asNonEmptyString(scope.productId) === intent.target.productId
    && asNonEmptyString(scope.repository) === intent.target.repository
    && asNonEmptyString(scope.workspaceId) === intent.execution.workspaceId
    && asNonEmptyString(scope.workspacePath) === intent.execution.workspacePath
    && asNonEmptyString(scope.providerId) === intent.execution.providerId;
}

function observedLifecycle(lifecycle: ClaudeProcessLifecycle): { lifecycle: ClaudeProcessLifecycle; observation: LifecycleObservation } {
  const observation: LifecycleObservation = { started: false, callbackFailed: false };
  return {
    observation,
    lifecycle: {
      async onStarted(worker: WorkerIdentity): Promise<void> {
        if (observation.started) {
          observation.callbackFailed = true;
          throw new Error('Claude process runner reported more than one worker start');
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
  if (observation?.callbackFailed) return { ...final, outcome: 'interrupted_uncertain', summary: 'worker lifecycle callback failed before a durable start receipt was confirmed', nativeCancellationReceipt: false };
  if (observation !== undefined && !observation.started && SUCCESS_OUTCOMES.has(final.outcome)) {
    return { ...final, outcome: 'interrupted_uncertain', summary: 'Claude process returned without a durable worker-start receipt', nativeCancellationReceipt: false };
  }
  return final;
}

function parseEvents(stdout: string): { events: ClaudeNormalizedEvent[]; malformedEventCount: number } {
  const events: ClaudeNormalizedEvent[] = [];
  let malformedEventCount = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (!record(event) || !asNonEmptyString(event.type)) {
        malformedEventCount += 1;
        continue;
      }
      events.push({ type: event.type as string, raw: event });
    } catch {
      malformedEventCount += 1;
    }
  }
  return { events, malformedEventCount };
}

function finalFrom(events: ClaudeNormalizedEvent[], malformedEventCount: number, processResult: ClaudeProcessResult, expectedSessionId: string): { final: ProviderFinalResult; errorEvidence?: string } {
  let observedError: Outcome | undefined;
  let errorEvidence: string | undefined;
  let terminalResult = false;
  let sessionId: string | undefined;
  let summary: string | undefined;
  let verification: string[] | undefined;
  let usage: UsageTelemetry | undefined;

  for (const event of events) {
    const type = asNonEmptyString(event.raw.type)?.toLowerCase();
    terminalResult = terminalResult || type === 'result';
    const fields = errorFromEvent(event.raw);
    if (fields) {
      observedError = classifyKnownError(fields.code, fields.message) ?? 'failed';
      errorEvidence = sanitizeErrorEvidence([fields.code, fields.message].filter((value): value is string => value !== undefined).join(': ')) ?? errorEvidence;
    }
    sessionId = sessionFromEvent(event.raw) ?? sessionId;
    summary = sanitizeErrorEvidence(summaryFromEvent(event.raw) ?? '') ?? summary;
    verification = verificationFromEvent(event.raw) ?? verification;
    usage = usageFromEvent(event.raw) ?? usage;
  }

  const stderrEvidence = processResult.exitCode !== 0 ? sanitizeErrorEvidence(processResult.stderr ?? '') : undefined;
  const stderrOutcome = processResult.exitCode !== 0 ? classifyKnownError(undefined, stderrEvidence) : undefined;
  let outcome: Outcome;
  if (processResult.terminated || processResult.exitCode === null) outcome = 'interrupted_uncertain';
  else if (processResult.exitCode !== 0 && observedError && !SUCCESS_OUTCOMES.has(observedError)) outcome = observedError;
  else if (processResult.exitCode !== 0 && stderrOutcome) outcome = stderrOutcome;
  else if (processResult.exitCode !== 0) outcome = 'failed';
  // A wrapper interruption is never promoted by a terminal stream record.
  else if (observedError === 'cancelled') outcome = 'interrupted_uncertain';
  else if (observedError) outcome = observedError;
  else if (!terminalResult || malformedEventCount > 0) outcome = 'failed';
  else if (sessionId !== undefined && sessionId !== expectedSessionId) outcome = 'failed';
  else outcome = 'completed';

  return {
    final: {
      outcome,
      ...(outcome === 'completed' || sessionId === expectedSessionId ? { sessionId: expectedSessionId } : {}),
      ...(summary ? { summary } : {}),
      ...(verification ? { verification } : {}),
      ...(errorEvidence ?? stderrEvidence ? { summary: errorEvidence ?? stderrEvidence } : {}),
      usage: usage ?? { availability: 'unavailable', unavailableReason: 'Claude stream JSON did not emit usage telemetry' },
      nativeCancellationReceipt: false,
    },
    ...(errorEvidence ?? stderrEvidence ? { errorEvidence: errorEvidence ?? stderrEvidence } : {}),
  };
}

/**
 * Bounded adapter for the unmodified Claude Code print/streaming-JSON transport.
 * It reports observations only; provider text and tool suppression never grant authority.
 */
export class ClaudeAdapter {
  readonly capabilities = CAPABILITIES;
  readonly #runner: ClaudeProcessRunner;
  readonly #limits: ClaudeAdapterLimits;
  readonly #compatibleModels: ReadonlySet<string>;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #allowedTools: readonly string[];
  readonly #createSessionId: () => string;

  constructor(options: ClaudeAdapterOptions) {
    this.#runner = options.runner;
    this.#limits = { ...options.limits };
    this.#compatibleModels = new Set(options.compatibleModels);
    this.#environment = Object.freeze({ ...options.environment });
    this.#allowedTools = Object.freeze([...options.allowedTools]);
    this.#createSessionId = options.createSessionId ?? randomUUID;
  }

  async start(intent: RunIntent, currentContext: ClaudeCurrentContext, lifecycle?: ClaudeProcessLifecycle): Promise<ClaudeRunResult> {
    const prompt = contextPrompt(intent, currentContext);
    const sessionId = asNonEmptyString(this.#createSessionId());
    const invalid = validateIntent(intent, this.#limits, this.#compatibleModels)
      ?? (validEnvironment(this.#environment) ? undefined : 'a nonempty controlled execution environment is required')
      ?? (validToolNames(this.#allowedTools) ? undefined : 'configured Claude tool names are invalid')
      ?? (sessionId ? undefined : 'Claude session creation did not return an explicit session ID')
      ?? (prompt ? undefined : 'current context packet and prompt are required')
      ?? (providerContextIsAuthorized(intent, currentContext) ? undefined : 'current context prompt payload is not authorized by the run intent');
    if (invalid) return this.#unavailable('start', invalid);
    return this.#execute('start', intent, sessionId as string, this.#baseArgs(intent.execution.model, ['--session-id', sessionId as string], prompt as string), lifecycle);
  }

  async resume(intent: RunIntent, sessionBinding: ClaudeSessionBinding, currentContext: ClaudeCurrentContext, lifecycle?: ClaudeProcessLifecycle): Promise<ClaudeRunResult> {
    const prompt = contextPrompt(intent, currentContext);
    const invalid = validateIntent(intent, this.#limits, this.#compatibleModels)
      ?? (validEnvironment(this.#environment) ? undefined : 'a nonempty controlled execution environment is required')
      ?? (validToolNames(this.#allowedTools) ? undefined : 'configured Claude tool names are invalid')
      ?? (validSessionBinding(intent, sessionBinding) ? undefined : 'an explicit coordinator-recorded session binding is required for resume; --continue is forbidden')
      ?? (prompt ? undefined : 'current context packet and prompt are required')
      ?? (providerContextIsAuthorized(intent, currentContext) ? undefined : 'current context prompt payload is not authorized by the run intent');
    if (invalid) return this.#unavailable('resume', invalid);
    const sessionId = sessionBinding.sessionId as string;
    return this.#execute('resume', intent, sessionId, this.#baseArgs(intent.execution.model, ['--resume', sessionId], prompt as string), lifecycle);
  }

  async cancel(intent: RunIntent, lifecycle?: ClaudeProcessLifecycle): Promise<ProviderFinalResult> {
    const invalid = validateIntent(intent, this.#limits, this.#compatibleModels)
      ?? (validEnvironment(this.#environment) ? undefined : 'a nonempty controlled execution environment is required');
    if (invalid) return boundedFailure(invalid);
    if (!this.#runner.terminate) return boundedFailure('the injected process runner cannot terminate a Claude worker');
    try {
      const result = await this.#runner.terminate({ runId: intent.runId, cwd: intent.execution.workspacePath, ...(lifecycle === undefined ? {} : { lifecycle }) });
      return {
        outcome: result.processTerminated ? 'interrupted_uncertain' : 'failed',
        summary: result.processTerminated
          ? 'wrapper termination observed without a native Claude cancellation receipt'
          : 'wrapper could not confirm worker termination',
        usage: { availability: 'unavailable', unavailableReason: 'cancellation does not supply usage telemetry' },
        nativeCancellationReceipt: false,
      };
    } catch {
      return {
        outcome: 'interrupted_uncertain',
        summary: 'process termination threw before a native Claude cancellation receipt was observed',
        usage: { availability: 'unavailable', unavailableReason: 'cancellation transport failed' },
        nativeCancellationReceipt: false,
      };
    }
  }

  #baseArgs(model: string, sessionArgs: string[], prompt: string): string[] {
    // No --continue, --add-dir, bypass permission flag, fallback model, MCP configuration,
    // background execution, or configuration override is supplied by this adapter.
    return [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', 'manual', '--tools', this.#allowedTools.join(','), '--model', model,
      ...sessionArgs, prompt,
    ];
  }

  async #execute(command: 'start' | 'resume', intent: RunIntent, expectedSessionId: string, args: string[], suppliedLifecycle?: ClaudeProcessLifecycle): Promise<ClaudeRunResult> {
    try {
      const observed = suppliedLifecycle === undefined ? undefined : observedLifecycle(suppliedLifecycle);
      const result = await this.#runner.run({
        runId: intent.runId,
        command: 'claude',
        args,
        cwd: intent.execution.workspacePath,
        timeoutMs: intent.budget.maxRuntimeMinutes * 60_000,
        environment: this.#environment,
        ...(observed === undefined ? {} : { lifecycle: observed.lifecycle }),
      });
      const parsed = parseEvents(result.stdout);
      const normalized = finalFrom(parsed.events, parsed.malformedEventCount, result, expectedSessionId);
      const final = lifecycleFinal(normalized.final, observed?.observation);
      return { command, sessionId: final.sessionId, ...parsed, ...normalized, final };
    } catch {
      return this.#unavailable(command, 'Claude process transport was unavailable before a receipt was observed');
    }
  }

  #unavailable(command: 'start' | 'resume', reason: string): ClaudeRunResult {
    return { command, events: [], malformedEventCount: 0, final: boundedFailure(reason) };
  }
}
