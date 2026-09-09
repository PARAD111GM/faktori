import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type { QueuedMessage, RunSnapshot } from '../runtime/contracts.ts';
import type { DurableCoordinator } from '../runtime/coordinator.ts';
import { coordinatorGMState } from '../gm/coordinator-store.ts';
import { projectStructuredBlocker, structuredBlockersFromEvents, type StructuredBlocker } from '../diagnostics/blockers.ts';
import type { PreflightResult } from '../diagnostics/preflight.ts';
import type { ConsoleSettings } from './settings.ts';
import type { ConsoleSettingsEditor } from './settings-edit.ts';
import type { ManagerLoopObserver } from './manager-loop-observer.ts';

export type ConsoleCommand =
  | { type: 'start_work'; workItemId: string }
  | { type: 'message'; runId: string; body: string }
  | { type: 'answer'; runId: string; requestId: string; answer: string }
  | { type: 'cancel'; runId: string; reason: string }
  | { type: 'resume'; runId: string }
  | { type: 'pause_admission'; paused: boolean }
  | { type: 'open_record'; runId: string };

export interface ConsoleCommandRequest {
  commandId: string;
  command: ConsoleCommand;
}

export interface ConsoleOwnerActions {
  startWork?(workItemId: string): Promise<{ runId: string; detail?: string }>;
  answer?(runId: string, requestId: string, answer: string): Promise<{ detail?: string }>;
  cancel?(runId: string, reason: string): Promise<{ detail?: string }>;
  resume?(runId: string): Promise<{ detail?: string }>;
  openRecord?(runId: string): Promise<{ url: string }>;
}

export interface ConsoleServiceOptions {
  coordinator: DurableCoordinator;
  /** A local session secret delivered only in the loopback Console document. */
  commandToken: string;
  /** Exact browser origins that may issue commands. Wildcards are intentionally unsupported. */
  allowedOrigins: string[];
  ownerActions?: ConsoleOwnerActions;
  hierarchy?: {
    factory?: { id: string; name: string };
    products: Array<{ id: string; name: string }>;
    pods: Array<{ id: string; productId: string }>;
    workItems: Array<{ id: string; label: string; productId: string; podId?: string; dependsOnWorkItemIds: string[] }>;
  };
  /** Optional diagnostic source. It is projected as read-only sanitized state. */
  blockers?: () => readonly StructuredBlocker[];
  preflight?: PreflightResult;
  /** Validated, allowlisted settings safe for the read-only browser projection. */
  settings?: ConsoleSettings;
  settingsEditor?: ConsoleSettingsEditor;
  /** Server-owned observer for explicitly configured Manager Loop artifact directories. */
  managerLoopObserver?: ManagerLoopObserver;
  assetsDirectory?: string;
  now?: () => Date;
  /** Test seam for the local append-only journal watcher. */
  eventPollIntervalMs?: number;
}

type RecordedCommand = {
  commandId: string;
  command: ConsoleCommand;
  status: 'accepted' | 'completed' | 'denied' | 'failed';
  observedAt: string;
  result?: Record<string, unknown>;
};

const MAX_COMMAND_ID = 128;
const MAX_MESSAGE = 16_000;
const MAX_REASON = 1_024;
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const UNSAFE_TEXT = /(?:bearer\s+|authorization|api[_ -]?key|credential|secret|session[_ -]?id|\/Users\/|\\Users\\|\.codex|\.claude)/i;

function installedAssetsDirectory(): string {
  // Works in source and in the packed dist/ tree: both resolve to package-root console/dist.
  return resolve(join(fileURLToPath(new URL('.', import.meta.url)), '../../console/dist'));
}

function htmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) throw new Error(`${field} must be a bounded non-empty string`);
  return value;
}

function safeText(value: unknown, limit = 2_000): string | undefined {
  return typeof value === 'string' && value.length <= limit && !UNSAFE_TEXT.test(value) ? value : undefined;
}

function equalToken(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCommand(value: unknown): ConsoleCommand {
  const input = object(value);
  if (input === undefined) throw new Error('Console command must be an object');
  const type = input?.type;
  if (type === 'start_work') return { type, workItemId: text(input.workItemId, 'workItemId', 256) };
  if (type === 'message') return { type, runId: text(input.runId, 'runId', 256), body: text(input.body, 'body', MAX_MESSAGE) };
  if (type === 'answer') return { type, runId: text(input.runId, 'runId', 256), requestId: text(input.requestId, 'requestId', 256), answer: text(input.answer, 'answer', MAX_MESSAGE) };
  if (type === 'cancel') return { type, runId: text(input.runId, 'runId', 256), reason: text(input.reason, 'reason', MAX_REASON) };
  if (type === 'resume') return { type, runId: text(input.runId, 'runId', 256) };
  if (type === 'pause_admission' && typeof input.paused === 'boolean') return { type, paused: input.paused };
  if (type === 'open_record') return { type, runId: text(input.runId, 'runId', 256) };
  throw new Error('unsupported Console command');
}

function parseRequest(value: unknown): ConsoleCommandRequest {
  const input = object(value);
  return { commandId: text(input?.commandId, 'commandId', MAX_COMMAND_ID), command: parseCommand(input?.command) };
}

function publicProviderRequests(coordinator: DurableCoordinator, runId: string): Array<Record<string, unknown>> {
  const requests = new Map<string, Record<string, unknown>>();
  for (const event of coordinator.journal.events()) {
    if (event.runId !== runId || (event.kind !== 'provider.requested' && event.kind !== 'provider.request.answered')) continue;
    const request = object(event.data.request);
    const requestId = safeText(request?.requestId, 256);
    if (requestId === undefined) continue;
    if (event.kind === 'provider.requested') {
      const method = safeText(request?.method, 256);
      const prompt = safeText(request?.prompt, 1_000);
      if (method === undefined || prompt === undefined) continue;
      const options = Array.isArray(request?.options) ? request.options.map((item) => safeText(item, 128)).filter((item): item is string => item !== undefined) : [];
      requests.set(requestId, { requestId, method, prompt, options, status: 'pending', observedAt: safeText(request?.observedAt, 128) });
    } else {
      const prior = requests.get(requestId);
      if (prior !== undefined) requests.set(requestId, { ...prior, status: request?.status === 'answered' ? 'answered' : 'timed_out' });
    }
  }
  return [...requests.values()];
}

function publicRun(coordinator: DurableCoordinator, snapshot: RunSnapshot): Record<string, unknown> {
  const result = snapshot.providerResult;
  const usage = result?.usage;
  return {
    runId: snapshot.intent.runId,
    workItem: snapshot.intent.workItem,
    target: {
      factoryId: snapshot.intent.target.factoryId,
      productId: snapshot.intent.target.productId,
      podId: snapshot.intent.target.podId,
      repository: snapshot.intent.target.repository,
      branch: snapshot.intent.target.branch,
      baseRevision: snapshot.intent.target.baseRevision,
      expectedRevision: snapshot.intent.target.expectedRevision,
    },
    provider: snapshot.intent.execution.providerId,
    model: snapshot.intent.execution.model,
    profile: snapshot.intent.execution.profile,
    state: snapshot.state,
    createdAt: snapshot.intent.createdAt,
    reservation: snapshot.reservation,
    authority: { epoch: snapshot.authorityEpoch, revoked: snapshot.authorityRevoked },
    recovery: snapshot.recovery.map((requirement) => ({
      recoveryId: requirement.recoveryId,
      reason: requirement.reason,
      priorState: requirement.priorState,
      unresolvedOperationIds: requirement.unresolvedOperationIds,
      requiredAt: requirement.requiredAt,
    })),
    messages: snapshot.messages.map((message) => ({ messageId: message.messageId, createdAt: message.createdAt, delivery: message.delivery })),
    providerRequests: publicProviderRequests(coordinator, snapshot.intent.runId),
    result: result === undefined ? undefined : {
      outcome: result.outcome,
      summary: safeText(result.summary),
      revision: safeText(result.revision, 512),
      verification: (result.verification ?? []).map((item) => safeText(item, 512)).filter((item): item is string => item !== undefined),
      usage,
    },
  };
}

function commandRecord(event: { kind: string; data: Record<string, unknown> }): RecordedCommand | undefined {
  if (event.kind !== 'console.command') return undefined;
  const record = object(event.data.command);
  if (record === undefined || typeof record.commandId !== 'string' || typeof record.status !== 'string' || typeof record.observedAt !== 'string') return undefined;
  try {
    return {
      commandId: text(record.commandId, 'commandId', MAX_COMMAND_ID),
      command: parseCommand(record.command),
      status: record.status as RecordedCommand['status'],
      observedAt: record.observedAt,
      ...(object(record.result) === undefined ? {} : { result: object(record.result) }),
    };
  } catch { return undefined; }
}

function currentPause(records: readonly RecordedCommand[]): boolean {
  const latest = [...records].reverse().find((record) => record.command.type === 'pause_admission' && record.status === 'completed');
  return latest?.command.type === 'pause_admission' ? latest.command.paused : false;
}

function commandRunId(command: ConsoleCommand): string {
  return 'runId' in command ? command.runId : 'factory';
}

function contentSecurityPolicy(): string {
  return "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'";
}

function hierarchyState(snapshots: RunSnapshot[], configured: ConsoleServiceOptions['hierarchy']): Record<string, unknown> {
  const factoryId = configured?.factory?.id ?? snapshots[0]?.intent.target.factoryId ?? 'factory';
  const products = new Map((configured?.products ?? []).map((product) => [product.id, product.name]));
  const pods = new Map((configured?.pods ?? []).map((pod) => [pod.id, pod.productId]));
  for (const snapshot of snapshots) {
    products.set(snapshot.intent.target.productId, products.get(snapshot.intent.target.productId) ?? snapshot.intent.target.productId);
    if (snapshot.intent.target.podId !== undefined) pods.set(snapshot.intent.target.podId, snapshot.intent.target.productId);
  }
  const configuredWork = new Map((configured?.workItems ?? []).map((work) => [work.id, work]));
  for (const snapshot of snapshots) {
    if (!configuredWork.has(snapshot.intent.workItem.id)) configuredWork.set(snapshot.intent.workItem.id, {
      id: snapshot.intent.workItem.id,
      label: snapshot.intent.workItem.id,
      productId: snapshot.intent.target.productId,
      ...(snapshot.intent.target.podId === undefined ? {} : { podId: snapshot.intent.target.podId }),
      dependsOnWorkItemIds: [],
    });
  }
  const latestState = new Map<string, string>();
  for (const snapshot of snapshots) latestState.set(snapshot.intent.workItem.id, snapshot.state);
  const nodes: Array<Record<string, unknown>> = [{ id: `factory:${factoryId}`, kind: 'factory', label: configured?.factory?.name ?? factoryId }];
  const parentEdges: Array<{ from: string; to: string }> = [];
  for (const [productId, name] of products) {
    nodes.push({ id: `product:${productId}`, kind: 'product', label: name, productId });
    parentEdges.push({ from: `factory:${factoryId}`, to: `product:${productId}` });
  }
  for (const [podId, productId] of pods) {
    nodes.push({ id: `pod:${podId}`, kind: 'pod', label: podId, productId, podId });
    parentEdges.push({ from: `product:${productId}`, to: `pod:${podId}` });
  }
  const dependencyEdges: Array<{ from: string; to: string }> = [];
  for (const work of configuredWork.values()) {
    nodes.push({ id: `work:${work.id}`, kind: 'work_item', label: work.label, productId: work.productId, ...(work.podId === undefined ? {} : { podId: work.podId }), state: latestState.get(work.id) ?? 'not_started' });
    parentEdges.push({ from: work.podId === undefined ? `product:${work.productId}` : `pod:${work.podId}`, to: `work:${work.id}` });
    for (const dependency of work.dependsOnWorkItemIds) dependencyEdges.push({ from: `work:${work.id}`, to: `work:${dependency}` });
  }
  return {
    factoryId,
    nodes,
    parentEdges,
    dependencyEdges,
    filters: {
      products: [...products].map(([id, name]) => ({ id, name })),
      pods: [...pods].map(([id, productId]) => ({ id, productId })),
    },
  };
}

/**
 * Loopback-only API and static Console host. The browser receives a redacted
 * projection; commands are authenticated, origin-checked, durable and replay-safe.
 */
export function createConsoleService(options: ConsoleServiceOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 32_768 });
  const events = new EventEmitter();
  const now = options.now ?? (() => new Date());
  let commandTail: Promise<unknown> = Promise.resolve();
  let settingsTail: Promise<unknown> = Promise.resolve();
  let observedEventCount = options.coordinator.journal.events().length;
  const journalPoll = setInterval(() => {
    const count = options.coordinator.journal.events().length;
    if (count === observedEventCount) return;
    observedEventCount = count;
    events.emit('state');
  }, options.eventPollIntervalMs ?? 200);
  journalPoll.unref();
  const unsubscribeManagerLoops = options.managerLoopObserver?.onChange(() => events.emit('state'));
  options.managerLoopObserver?.start();

  function records(): RecordedCommand[] {
    return options.coordinator.journal.events().map(commandRecord).filter((value): value is RecordedCommand => value !== undefined);
  }

  function state(): Record<string, unknown> {
    const snapshots = options.coordinator.snapshots();
    const usages = snapshots.map((snapshot) => snapshot.providerResult?.usage).filter((value) => value !== undefined);
    const reported = usages.filter((usage) => usage.availability !== 'unavailable');
    const knownTokens = reported.reduce((sum, usage) => sum + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), 0);
    const reservedTokens = snapshots.filter((snapshot) => snapshot.reservation.status === 'held' || snapshot.reservation.status === 'uncertain')
      .reduce((sum, snapshot) => sum + snapshot.reservation.estimatedTokens, 0);
    const waiting = snapshots.filter((snapshot) => snapshot.state === 'blocked' || snapshot.state === 'reconciling');
    return {
      format: 'faktori.console-state/v1', observedAt: now().toISOString(), stale: false,
      admissionPaused: currentPause(records()),
      runs: snapshots.map((snapshot) => publicRun(options.coordinator, snapshot)),
      managerLoops: options.managerLoopObserver?.summaries() ?? [],
      blockers: [...structuredBlockersFromEvents(options.coordinator.journal.events()), ...(options.blockers?.() ?? []).map(projectStructuredBlocker).filter((blocker): blocker is StructuredBlocker => blocker !== undefined)]
        .filter((blocker, index, values) => values.findIndex((candidate) => candidate.blockerId === blocker.blockerId) === index),
      ...(options.preflight === undefined ? {} : { preflight: options.preflight }),
      ...(options.settings === undefined ? {} : { settings: { ...options.settings, ...(options.settingsEditor === undefined ? {} : { persistence: options.settingsEditor.status() }) } }),
      hierarchy: hierarchyState(snapshots, options.hierarchy),
      overview: { activeRuns: snapshots.filter((snapshot) => ['admitted', 'launching', 'running', 'cancelling', 'reconciling'].includes(snapshot.state)).length, waitingDecisions: waiting.length, failedRuns: snapshots.filter((snapshot) => snapshot.state === 'failed').length },
      resources: { knownUsageTokens: knownTokens, reportedUsageCount: reported.length, unavailableUsageCount: usages.length - reported.length, reservedTokens, unavailableMeasurements: usages.filter((usage) => usage.availability === 'unavailable').length, queueAge: snapshots.filter((snapshot) => snapshot.state === 'queued' || snapshot.state === 'admitted').map((snapshot) => ({ runId: snapshot.intent.runId, createdAt: snapshot.intent.createdAt })) },
      factoryGM: coordinatorGMState(options.coordinator),
    };
  }

  function secureHeaders(reply: FastifyReply): void {
    reply.header('Cache-Control', 'no-store').header('Content-Security-Policy', contentSecurityPolicy()).header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
  }

  function commandAuthorized(request: FastifyRequest, reply: FastifyReply): boolean {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !options.allowedOrigins.includes(origin)) {
      reply.code(403).send({ error: 'console_origin_rejected' });
      return false;
    }
    if (!equalToken(options.commandToken, request.headers['x-faktori-console-token'])) {
      reply.code(401).send({ error: 'console_authentication_required' });
      return false;
    }
    return true;
  }

  async function record(command: RecordedCommand): Promise<void> {
    await options.coordinator.record('console.command', commandRunId(command.command), { command });
  }

  async function execute(request: ConsoleCommandRequest): Promise<RecordedCommand> {
    const priorRecords = records().filter((record) => record.commandId === request.commandId);
    const previous = priorRecords.at(-1);
    if (previous !== undefined) {
      if (JSON.stringify(previous.command) !== JSON.stringify(request.command)) {
        return { commandId: request.commandId, command: request.command, status: 'failed', observedAt: now().toISOString(), result: { detail: 'command_id_payload_conflict' } };
      }
      return previous;
    }
    const accepted: RecordedCommand = { commandId: request.commandId, command: request.command, status: 'accepted', observedAt: now().toISOString() };
    await record(accepted);
    try {
      let result: Record<string, unknown> = {};
      if (request.command.type === 'start_work') {
        if (currentPause(records())) throw new Error('admission_paused');
        if (options.ownerActions?.startWork === undefined) throw new Error('start_work_unavailable');
        result = await options.ownerActions.startWork(request.command.workItemId);
      } else if (request.command.type === 'message') {
        const snapshot = options.coordinator.snapshot(request.command.runId);
        if (snapshot === undefined) throw new Error('run_not_found');
        const message: QueuedMessage = { messageId: `console-message-${request.commandId}`, runId: request.command.runId, createdAt: now().toISOString(), delivery: 'next_turn', body: request.command.body };
        await options.coordinator.queueMessage(message);
        result = { messageId: message.messageId };
      } else if (request.command.type === 'answer') {
        if (options.ownerActions?.answer === undefined) throw new Error('answer_unsupported_by_provider');
        result = await options.ownerActions.answer(request.command.runId, request.command.requestId, request.command.answer);
      } else if (request.command.type === 'cancel') {
        if (options.ownerActions?.cancel === undefined) throw new Error('cancel_unavailable');
        result = await options.ownerActions.cancel(request.command.runId, request.command.reason);
      } else if (request.command.type === 'resume') {
        if (options.ownerActions?.resume === undefined) throw new Error('resume_unsupported_by_provider');
        result = await options.ownerActions.resume(request.command.runId);
      } else if (request.command.type === 'open_record') {
        if (options.ownerActions?.openRecord === undefined) throw new Error('authoritative_record_unavailable');
        result = await options.ownerActions.openRecord(request.command.runId);
      }
      const completed: RecordedCommand = { ...accepted, status: 'completed', observedAt: now().toISOString(), ...(Object.keys(result).length === 0 ? {} : { result }) };
      await record(completed);
      events.emit('state');
      return completed;
    } catch (error) {
      const failed: RecordedCommand = { ...accepted, status: 'failed', observedAt: now().toISOString(), result: { detail: safeText(error instanceof Error ? error.message : String(error)) ?? 'command_failed' } };
      await record(failed);
      events.emit('state');
      return failed;
    }
  }

  app.addHook('onSend', async (_request, reply) => { secureHeaders(reply); });
  app.addHook('onClose', async () => {
    clearInterval(journalPoll);
    unsubscribeManagerLoops?.();
    options.managerLoopObserver?.close();
  });
  app.get('/api/console/state', async () => state());
  app.get('/api/console/events', async (request, reply) => {
    secureHeaders(reply);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'Cache-Control': 'no-store' });
    const push = (): void => { reply.raw.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`); };
    push(); events.on('state', push);
    request.raw.on('close', () => events.off('state', push));
    return reply;
  });
  app.post('/api/console/commands', async (request, reply) => {
    if (!commandAuthorized(request, reply)) return reply;
    let command: ConsoleCommandRequest;
    try { command = parseRequest(request.body); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'invalid_command' }); }
    const next = commandTail.then(() => execute(command), () => execute(command));
    commandTail = next.catch(() => undefined);
    const completed = await next;
    return reply.code(completed.status === 'failed' ? 409 : 200).send({ command: completed, state: state() });
  });
  const settingsFailure = (reply: FastifyReply, error: unknown): FastifyReply => {
    const message = error instanceof Error ? error.message : 'invalid_settings_request';
    if (message === 'settings_revision_conflict') return reply.code(409).send({ error: message });
    if (message === 'settings_save_confirmation_required' || message.startsWith('settings_risk_acknowledgement_required:')) return reply.code(400).send({ error: message });
    if (message === 'settings_editing_requires_factory_configuration') return reply.code(409).send({ error: message });
    if (message.startsWith('draft.') || message.startsWith('draft ') || message.startsWith('settings request ') || message.startsWith('revision ') || message.startsWith('acknowledgedRiskIds ') || message === 'product and pod identities are read-only' || message === 'runtime routes are read-only') {
      return reply.code(400).send({ error: message });
    }
    if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ConfigValidationError')) return reply.code(400).send({ error: 'settings_validation_failed' });
    return reply.code(500).send({ error: 'settings_operation_failed' });
  };
  const queueSettings = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = settingsTail.then(operation, operation);
    settingsTail = next.catch(() => undefined);
    return next;
  };
  app.post('/api/console/settings/edit', async (request, reply) => {
    if (!commandAuthorized(request, reply)) return reply;
    if (options.settingsEditor === undefined) return reply.code(409).send({ error: 'settings_editing_unavailable' });
    try { return await queueSettings(() => options.settingsEditor?.edit() as Promise<Awaited<ReturnType<NonNullable<typeof options.settingsEditor>['edit']>>>); } catch (error) { return settingsFailure(reply, error); }
  });
  app.post('/api/console/settings/preview', async (request, reply) => {
    if (!commandAuthorized(request, reply)) return reply;
    if (options.settingsEditor === undefined) return reply.code(409).send({ error: 'settings_editing_unavailable' });
    try { return await queueSettings(() => options.settingsEditor?.preview(request.body) as Promise<Awaited<ReturnType<NonNullable<typeof options.settingsEditor>['preview']>>>); } catch (error) { return settingsFailure(reply, error); }
  });
  app.post('/api/console/settings/save', async (request, reply) => {
    if (!commandAuthorized(request, reply)) return reply;
    if (options.settingsEditor === undefined) return reply.code(409).send({ error: 'settings_editing_unavailable' });
    try {
      const saved = await queueSettings(() => options.settingsEditor?.save(request.body) as Promise<Awaited<ReturnType<NonNullable<typeof options.settingsEditor>['save']>>>);
      events.emit('state');
      return saved;
    } catch (error) { return settingsFailure(reply, error); }
  });
  app.get('/*', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const path = String(params['*'] ?? '');
    const configuredRoot = resolve(options.assetsDirectory ?? installedAssetsDirectory());
    const candidate = resolve(join(configuredRoot, path.length === 0 ? 'index.html' : normalize(path)));
    if (!candidate.startsWith(`${configuredRoot}/`) && candidate !== configuredRoot) return reply.code(404).send();
    try {
      const root = await realpath(configuredRoot);
      const details = await lstat(candidate);
      if (details.isSymbolicLink() || !details.isFile()) return reply.code(404).send();
      const resolvedCandidate = await realpath(candidate);
      if (!resolvedCandidate.startsWith(`${root}/`)) return reply.code(404).send();
      const body = await readFile(resolvedCandidate);
      if (extname(resolvedCandidate) !== '.html') return reply.type(MIME[extname(resolvedCandidate)] ?? 'application/octet-stream').send(body);
      const document = body.toString('utf8').replace('</head>', `<meta name="faktori-console-token" content="${htmlAttribute(options.commandToken)}"></head>`);
      return reply.type('text/html; charset=utf-8').send(document);
    } catch { return reply.code(404).send(); }
  });
  return app;
}

export function consoleCommandToken(): string {
  return createHash('sha256').update(randomUUID()).digest('base64url');
}
