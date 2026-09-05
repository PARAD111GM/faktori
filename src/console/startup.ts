import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { AdmissionLimits, CoordinatorIdentity, DurableCoordinator } from '../runtime/index.ts';
import { CoordinatorProviderDelivery, DurableCoordinator as Coordinator } from '../runtime/index.ts';
import { CodexAdapter } from '../providers/codex.ts';
import type { CodexProcessRunner } from '../providers/codex.ts';
import { providerContextPayloadDigest, type ProviderCurrentContext } from '../providers/contracts.ts';
import { NativeCodexProcessRunner, NativeIdentityProbe } from '../execution/transports.ts';
import { CoordinatorGMStore, FactoryGM, type GMHealthSignal } from '../gm/index.ts';
import { createConsoleOwnerActions } from './owner-actions.ts';
import { consoleCommandToken, createConsoleService, type ConsoleOwnerActions } from './service.ts';
import type { RunIntent, WorkerIdentity } from '../runtime/contracts.ts';

export interface LocalConsoleConfiguration {
  factoryId: string;
  journalPath: string;
  projectionPath: string;
  port: number;
  /** Local session secret. It is read from the local config and never logged. */
  commandToken?: string;
  allowedOrigins: string[];
  limits: AdmissionLimits;
  runtime?: DeterministicConsoleRuntimeConfiguration;
}

/**
 * Explicit deterministic runtime wiring for installation conformance. It is
 * intentionally not a substitute for a vendor CLI login or live-provider proof.
 * It proves the installed Console reaches the real coordinator→delivery→adapter
 * path without creating an external provider run.
 */
export interface DeterministicConsoleRuntimeConfiguration {
  provider: { id: 'codex'; environment: Record<string, string>; compatibleModels: string[]; runNonce: string };
  workItems: Array<{ workItemId: string; intent: RunIntent; context: ProviderCurrentContext }>;
  gm?: { instructions: { revision: string; content: string }; diagnosisResponse?: unknown; configuredRoutineActions?: Array<'refresh_projection' | 'reconcile_unresolved_operations' | 'prune_expired_console_commands'> };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function absolutePath(value: unknown, field: string): string {
  const path = requiredText(value, field);
  if (!isAbsolute(path)) throw new Error(`${field} must be an absolute local path`);
  return path;
}

function limits(value: unknown): AdmissionLimits {
  const input = object(value);
  const names = ['maxConcurrentRuns', 'maxRetries', 'maxRuntimeMinutes', 'maxTokens'] as const;
  if (input === undefined || names.some((name) => !Number.isInteger(input[name]) || Number(input[name]) < 0)
    || !Number.isInteger(input.maxConcurrentRuns) || Number(input.maxConcurrentRuns) < 1
    || !Number.isInteger(input.maxRuntimeMinutes) || Number(input.maxRuntimeMinutes) < 1
    || typeof input.strictSpending !== 'boolean' || typeof input.strictSpendingSupported !== 'boolean') {
    throw new Error('limits must contain bounded coordinator limits and strict-spending capability');
  }
  return input as unknown as AdmissionLimits;
}

function runtime(value: unknown, factoryId: string): DeterministicConsoleRuntimeConfiguration | undefined {
  if (value === undefined) return undefined;
  const input = object(value); const provider = object(input?.provider);
  if (provider?.id !== 'codex' || !object(provider.environment) || !Array.isArray(provider.compatibleModels) || !provider.compatibleModels.every((item) => typeof item === 'string' && item.trim()) || typeof provider.runNonce !== 'string' || provider.runNonce.trim().length === 0) throw new Error('runtime.provider must explicitly configure Codex CLI, a controlled environment, compatible models, and a run nonce');
  if (!Array.isArray(input?.workItems)) throw new Error('runtime must include explicit eligible workItems');
  const workItems = input.workItems.map((item) => {
    const candidate = object(item); const intent = candidate?.intent as RunIntent | undefined; const context = candidate?.context as ProviderCurrentContext | undefined;
    if (typeof candidate?.workItemId !== 'string' || intent?.format !== 'faktori.run-intent/v1' || intent.target?.factoryId !== factoryId || intent.execution?.providerId !== 'codex' || !context || typeof context.prompt !== 'string' || providerContextPayloadDigest(context) === '' || !intent.execution.approvedInputDigests?.includes(providerContextPayloadDigest(context))) throw new Error('runtime work item must contain a factory-bound Codex intent and exact approved context');
    return { workItemId: candidate.workItemId, intent, context };
  });
  const gmInput = object(input.gm);
  const gm = gmInput === undefined ? undefined : { instructions: { revision: requiredText(object(gmInput.instructions)?.revision, 'runtime.gm.instructions.revision'), content: requiredText(object(gmInput.instructions)?.content, 'runtime.gm.instructions.content') }, ...(gmInput.diagnosisResponse === undefined ? {} : { diagnosisResponse: gmInput.diagnosisResponse }), ...(Array.isArray(gmInput.configuredRoutineActions) ? { configuredRoutineActions: gmInput.configuredRoutineActions as DeterministicConsoleRuntimeConfiguration['gm'] extends infer _ ? Array<'refresh_projection' | 'reconcile_unresolved_operations' | 'prune_expired_console_commands'> : never } : {}) };
  return { provider: { id: 'codex', environment: provider.environment as Record<string, string>, compatibleModels: provider.compatibleModels as string[], runNonce: provider.runNonce }, workItems, ...(gm === undefined ? {} : { gm }) };
}

/** Explicit test seam. Production startup never supplies a transcript or mock runner. */
export interface LocalConsoleDependencies { codexRunner?: CodexProcessRunner; }

/** Parse the owner-controlled local service config; browser input never reaches this boundary. */
export function parseLocalConsoleConfiguration(value: unknown): LocalConsoleConfiguration {
  const input = object(value);
  if (input === undefined) throw new Error('Console configuration must be an object');
  if (!Number.isInteger(input.port) || Number(input.port) < 0 || Number(input.port) > 65_535) throw new Error('port must be a loopback TCP port');
  if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length === 0 || !input.allowedOrigins.every((origin) => typeof origin === 'string' && /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin))) {
    throw new Error('allowedOrigins must be non-empty exact loopback HTTP origins');
  }
  const commandToken = input.commandToken === undefined ? undefined : requiredText(input.commandToken, 'commandToken');
  const factoryId = requiredText(input.factoryId, 'factoryId');
  return { factoryId, journalPath: absolutePath(input.journalPath, 'journalPath'), projectionPath: absolutePath(input.projectionPath, 'projectionPath'), port: Number(input.port), commandToken, allowedOrigins: [...new Set(input.allowedOrigins)], limits: limits(input.limits), ...(runtime(input.runtime, factoryId) === undefined ? {} : { runtime: runtime(input.runtime, factoryId) }) };
}

export interface StartedConsole {
  coordinator: DurableCoordinator;
  app: ReturnType<typeof createConsoleService>;
  url: string;
  gm?: FactoryGM;
  close(): Promise<void>;
}

function configuredOwnerActions(coordinator: DurableCoordinator, configuration: DeterministicConsoleRuntimeConfiguration, dependencies: LocalConsoleDependencies): ConsoleOwnerActions {
  const runner = dependencies.codexRunner ?? new NativeCodexProcessRunner({
    identityProbe: new NativeIdentityProbe({ cwd: process.cwd(), env: configuration.provider.environment }), runNonce: configuration.provider.runNonce,
  });
  const adapter = new CodexAdapter({
    limits: coordinator.limits, environment: configuration.provider.environment, compatibleModels: configuration.provider.compatibleModels,
    runner,
  });
  const delivery = new CoordinatorProviderDelivery({ coordinator, adapter, providerId: 'codex', terminateWorker: async () => { throw new Error('deterministic provider has no live worker to terminate'); } });
  const entries = new Map(configuration.workItems.map((entry) => [entry.workItemId, entry]));
  return createConsoleOwnerActions(coordinator, {
    intentForWorkItem: async (workItemId) => entries.get(workItemId)?.intent,
    startAdmittedRun: async (runId) => { const entry = [...entries.values()].find((candidate) => candidate.intent.runId === runId); if (!entry) throw new Error('admitted work item context is unavailable'); const result = await delivery.deliver({ runId, context: entry.context }); return { detail: `provider_${result.final.outcome}` }; },
  });
}

export async function startLocalConsole(configuration: LocalConsoleConfiguration, ownerActions?: ConsoleOwnerActions, dependencies: LocalConsoleDependencies = {}): Promise<StartedConsole> {
  const identity: CoordinatorIdentity = { instanceId: `console-${process.pid}-${Date.now()}`, pid: process.pid, processStartedAt: new Date().toISOString() };
  const coordinator = await Coordinator.open({ factoryId: configuration.factoryId, journalPath: configuration.journalPath, projectionPath: configuration.projectionPath, identity, limits: configuration.limits });
  await coordinator.claim();
  const configuredActions = configuration.runtime === undefined ? undefined : configuredOwnerActions(coordinator, configuration.runtime, dependencies);
  const gm = configuration.runtime?.gm === undefined ? undefined : new FactoryGM({ factoryId: configuration.factoryId, instructions: configuration.runtime.gm.instructions, store: new CoordinatorGMStore(coordinator), ...(configuration.runtime.gm.diagnosisResponse === undefined ? {} : { diagnosis: { diagnose: async () => configuration.runtime!.gm!.diagnosisResponse } }), configuredRoutineActions: configuration.runtime.gm.configuredRoutineActions });
  const app = createConsoleService({ coordinator, commandToken: configuration.commandToken ?? consoleCommandToken(), allowedOrigins: configuration.allowedOrigins, ownerActions: configuredActions ?? ownerActions });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: configuration.port });
    return {
      coordinator, app, url: address, ...(gm === undefined ? {} : { gm }),
      async close(): Promise<void> { await app.close(); await coordinator.release(); coordinator.close(); },
    };
  } catch (error) {
    await app.close(); await coordinator.release(); coordinator.close();
    throw error;
  }
}

export async function startLocalConsoleFromFile(path: string): Promise<StartedConsole> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return startLocalConsole(parseLocalConsoleConfiguration(parsed));
}
