import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { resolveFactoryConfig, type FactoryConfiguration, type ResolvedFactoryConfiguration } from '../config/index.ts';
import type { AdmissionLimits, CoordinatorIdentity, DurableCoordinator, ProcessProbe, ProcessStatus } from '../runtime/index.ts';
import { CoordinatorProviderDelivery, DurableCoordinator as Coordinator } from '../runtime/index.ts';
import { CodexAdapter } from '../providers/codex.ts';
import type { CodexProcessRunner } from '../providers/codex.ts';
import { ClaudeAdapter, type ClaudeProcessRunner } from '../providers/claude.ts';
import { CursorAcpAdapter, type CursorAcpTransport } from '../providers/cursor.ts';
import { providerContextPayloadDigest, type ProviderCurrentContext, type ProviderSessionBinding, type ProviderTurnAdapter, type SupportedProviderId } from '../providers/contracts.ts';
import { buildDockerExecutionPlan, type ContainerIdentityProbe, type CredentialProfile, type NativeIdentityProbe as NativeIdentityProbeContract } from '../execution/index.ts';
import { NativeClaudeProcessRunner } from '../execution/claude-process.ts';
import { CursorAcpStdioTransport } from '../execution/cursor-acp-stdio.ts';
import { BoundedCommandRunner, DockerCliIdentityProbe, DockerCliRunner, DockerCodexProcessRunner, NativeCodexProcessRunner, NativeIdentityProbe } from '../execution/transports.ts';
import { CoordinatorGMHealthObserver, CoordinatorGMStore, FactoryGM, type GMProviderDiagnosisPort } from '../gm/index.ts';
import { observeDurableDockerTermination, observeDurableNativeTermination, prepareDurableDockerTermination, prepareDurableNativeTermination, type DurableDockerTerminationPreparation, type DurableNativeTerminationPreparation } from '../runtime/cancellation.ts';
import { createConsoleOwnerActions } from './owner-actions.ts';
import { ConsoleProviderRequestBroker } from './provider-requests.ts';
import { consoleCommandToken, createConsoleService, type ConsoleOwnerActions } from './service.ts';
import type { RunIntent, WorkerIdentity } from '../runtime/contracts.ts';
import { evaluateInstalledPreflight } from '../diagnostics/local-preflight.ts';
import type { PreflightResult } from '../diagnostics/preflight.ts';
import { createConsoleSettings } from './settings.ts';
import { FileConsoleSettingsEditor, type ConsoleSettingsEditor } from './settings-edit.ts';
import { ManagerLoopObserver, type ManagerLoopSource } from './manager-loop-observer.ts';
import { ManagerLoopRegistry } from './manager-loop-registry.ts';
import { JiraObserver, parseJiraSources, type JiraSource } from './jira-observer.ts';
import { ManagerConnectedStore, parseManagerConnectedConfig, type ManagerConnectedConfig } from '../manager-connected/index.ts';
import { newManagerRelayToken, writeManagerRelayConnection } from './manager-relay.ts';

export interface LocalConsoleConfiguration {
  factoryId: string;
  journalPath: string;
  projectionPath: string;
  port: number;
  /** Local session secret. It is read from the local config and never logged. */
  commandToken?: string;
  allowedOrigins: string[];
  limits: AdmissionLimits;
  factoryConfiguration?: ResolvedFactoryConfiguration;
  preflight?: PreflightResult;
  runtime?: LocalConsoleRuntimeConfiguration;
  /** Owner-allowlisted, server-only Manager Loop artifact directories. */
  managerLoops: ManagerLoopSource[];
  /** Optional controller-owned persistence for hot, allowlisted loop sources. */
  managerLoopRegistry?: { path: string; allowedArtifactRoots: string[] };
  /** Read-only tracker sources; credentials remain in server environment. */
  jiraSources?: JiraSource[];
  managerConnected?: ManagerConnectedConfig;
}

export type LocalProviderRoute =
  | { id: 'codex'; profile: 'native'; environment: Record<string, string>; compatibleModels: string[]; runNonce: string; contextIsolation: 'host' | 'bounded' }
  | { id: 'codex'; profile: 'isolated'; environment: Record<string, string>; compatibleModels: string[]; runNonce: string; docker: { image: string; scratchRoot: string; controlStoragePaths: string[]; allowedSharedScratchRoots?: string[]; approvedInputs: Array<{ path: string; label?: string }>; credentialProfile?: CredentialProfile; networkMode: 'none' | 'bridge'; resources: { memoryBytes: number; cpuCount: number; pids: number }; allowUnsandboxedCodexInsideValidatedContainer: boolean } }
  | { id: 'claude'; profile: 'native'; environment: Record<string, string>; compatibleModels: string[]; allowedTools: string[]; runNonce: string }
  | { id: 'cursor'; profile: 'native'; environment: Record<string, string>; requestTimeoutMs: number; runNonce: string };

/** Owner-controlled provider routes. Browser commands can select only these IDs. */
export interface LocalConsoleRuntimeConfiguration {
  providers: LocalProviderRoute[];
  workItems: Array<{ workItemId: string; intent: RunIntent; context: ProviderCurrentContext; dependsOnWorkItemIds: string[] }>;
  resumePlans: Array<{ sourceRunId: string; targetWorkItemId: string }>;
  gm?: {
    instructions: { revision: string; content: string };
    /** Owner-approved scope template; controller supplies only bounded journal-derived diagnosis context. */
    diagnosisTemplate: { intent: RunIntent };
    configuredRoutineActions?: Array<'refresh_projection' | 'reconcile_unresolved_operations' | 'prune_expired_console_commands'>;
  };
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

function managerLoopSource(value: unknown, index: number, catalog?: ResolvedFactoryConfiguration): ManagerLoopSource {
  const allowedKeys = new Set(['id', 'artifactsDirectory', 'productId', 'podId', 'usageExportPath', 'references']);
  const loopIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
  const scopeIdPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/;
  const input = object(value);
  if (input === undefined || Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error(`managerLoops[${index}] has unsupported fields`);
  const id = requiredText(input.id, `managerLoops[${index}].id`);
  if (!loopIdPattern.test(id)) throw new Error(`managerLoops[${index}].id must match the Manager Loop lowercase slug format`);
  const productId = input.productId === undefined ? undefined : requiredText(input.productId, `managerLoops[${index}].productId`);
  const podId = input.podId === undefined ? undefined : requiredText(input.podId, `managerLoops[${index}].podId`);
  if (productId !== undefined && !scopeIdPattern.test(productId)) throw new Error(`managerLoops[${index}].productId must be a bounded identifier`);
  if (podId !== undefined && !scopeIdPattern.test(podId)) throw new Error(`managerLoops[${index}].podId must be a bounded identifier`);
  if (podId !== undefined && productId === undefined) throw new Error(`managerLoops[${index}].podId requires productId so the loop remains visible under product filters`);
  if (catalog !== undefined && productId !== undefined && !catalog.products.some((product) => product.id === productId)) throw new Error(`managerLoops[${index}].productId must reference a configured product`);
  if (catalog !== undefined && podId !== undefined) {
    const pod = catalog.pods.find((candidate) => candidate.id === podId);
    if (pod === undefined || (productId !== undefined && pod.productId !== productId)) throw new Error(`managerLoops[${index}].podId must reference a configured pod in the selected product`);
  }
  const references = object(input.references);
  const referenceKeys = new Set(['ticket', 'feature', 'candidate', 'pullRequest', 'pullRequestMerged', 'deploymentAccepted', 'shared', 'workInProgress']);
  if (references !== undefined && Object.keys(references).some((key) => !referenceKeys.has(key))) throw new Error(`managerLoops[${index}].references has unsupported fields`);
  const safeReferences = references === undefined ? undefined : Object.fromEntries(Object.entries(references).filter(([key, item]) => (
    ['ticket', 'feature', 'candidate', 'pullRequest'].includes(key) ? typeof item === 'string' && scopeIdPattern.test(item) : typeof item === 'boolean'
  )));
  return {
    id, artifactsDirectory: absolutePath(input.artifactsDirectory, `managerLoops[${index}].artifactsDirectory`),
    ...(productId === undefined ? {} : { productId }), ...(podId === undefined ? {} : { podId }),
    ...(input.usageExportPath === undefined ? {} : { usageExportPath: absolutePath(input.usageExportPath, `managerLoops[${index}].usageExportPath`) }),
    ...(safeReferences === undefined || Object.keys(safeReferences).length === 0 ? {} : { references: safeReferences }),
  };
}

function managerLoopSources(value: unknown, catalog?: ResolvedFactoryConfiguration): ManagerLoopSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('managerLoops must be an array of at most 100 configured loops');
  const sources = value.map((item, index) => managerLoopSource(item, index, catalog));
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error('managerLoops ids must be unique');
  if (new Set(sources.map((source) => source.artifactsDirectory)).size !== sources.length) throw new Error('managerLoops artifact directories must be unique');
  return sources;
}

function managerLoopRegistry(value: unknown): LocalConsoleConfiguration['managerLoopRegistry'] {
  if (value === undefined) return undefined;
  const input = object(value);
  if (input === undefined || Object.keys(input).some((key) => key !== 'path' && key !== 'allowedArtifactRoots') || !Array.isArray(input.allowedArtifactRoots) || input.allowedArtifactRoots.length === 0) throw new Error('managerLoopRegistry must contain path and non-empty allowedArtifactRoots only');
  const roots = input.allowedArtifactRoots.map((root, index) => absolutePath(root, `managerLoopRegistry.allowedArtifactRoots[${index}]`));
  if (new Set(roots).size !== roots.length) throw new Error('managerLoopRegistry.allowedArtifactRoots must be unique');
  return { path: absolutePath(input.path, 'managerLoopRegistry.path'), allowedArtifactRoots: roots };
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

function providerRoute(value: unknown): LocalProviderRoute {
  const route = object(value);
  if (route === undefined) throw new Error('runtime provider route must be an object');
  const id = route?.id;
  const profile = route.profile ?? 'native';
  const environment = object(route?.environment);
  const compatibleModels = route?.compatibleModels;
  const runNonce = requiredText(route?.runNonce, 'runtime.providers.runNonce');
  if ((id !== 'codex' && id !== 'claude' && id !== 'cursor') || (profile !== 'native' && profile !== 'isolated') || environment === undefined
    || !Object.values(environment).every((item) => typeof item === 'string')) {
    throw new Error('runtime provider route must name codex, claude, or cursor with a controlled string environment');
  }
  if (profile === 'isolated') {
    if (id !== 'codex') throw new Error('only the shipped Codex transport currently supports an isolated provider route');
    if (!Array.isArray(compatibleModels) || !compatibleModels.every((item) => typeof item === 'string' && item.trim().length > 0)) throw new Error('isolated Codex route requires explicit compatibleModels');
    const docker = object(route.docker);
    const resources = object(docker?.resources);
    if (docker === undefined || !Array.isArray(docker.controlStoragePaths) || docker.controlStoragePaths.length === 0 || !docker.controlStoragePaths.every((item) => typeof item === 'string' && isAbsolute(item))
      || !Array.isArray(docker.approvedInputs) || !['none', 'bridge'].includes(String(docker.networkMode)) || typeof docker.allowUnsandboxedCodexInsideValidatedContainer !== 'boolean'
      || resources === undefined || !Number.isInteger(resources.memoryBytes) || Number(resources.memoryBytes) < 1 || !Number.isFinite(resources.cpuCount) || Number(resources.cpuCount) <= 0 || !Number.isInteger(resources.pids) || Number(resources.pids) < 1) {
      throw new Error('isolated Codex route requires bounded Docker image, paths, inputs, networking, resources, and inner-sandbox policy');
    }
    const approvedInputs = docker.approvedInputs.map((item) => {
      const input = object(item);
      const path = absolutePath(input?.path, 'runtime.providers.docker.approvedInputs.path');
      return { path, ...(input?.label === undefined ? {} : { label: requiredText(input.label, 'runtime.providers.docker.approvedInputs.label') }) };
    });
    const credentialInput = object(docker.credentialProfile);
    if (credentialInput?.containerUser !== undefined && credentialInput.containerUser !== 'controller') {
      throw new Error('runtime.providers.docker.credentialProfile.containerUser must be "controller" when selected');
    }
    if (credentialInput?.ephemeralHomeFiles !== undefined && (!Array.isArray(credentialInput.ephemeralHomeFiles)
      || !credentialInput.ephemeralHomeFiles.every((item) => typeof item === 'string'))) {
      throw new Error('runtime.providers.docker.credentialProfile.ephemeralHomeFiles must be an array of filenames');
    }
    const credentialProfile = credentialInput === undefined ? undefined : {
      profileId: requiredText(credentialInput.profileId, 'runtime.providers.docker.credentialProfile.profileId'),
      path: absolutePath(credentialInput.path, 'runtime.providers.docker.credentialProfile.path'),
      environmentVariable: requiredText(credentialInput.environmentVariable, 'runtime.providers.docker.credentialProfile.environmentVariable'),
      ...(credentialInput.writable === true ? { writable: true } : {}),
      ...(credentialInput.containerUser === 'controller' ? { containerUser: 'controller' as const } : {}),
      ...(credentialInput.ephemeralHomeFiles === undefined ? {} : { ephemeralHomeFiles: credentialInput.ephemeralHomeFiles as string[] }),
    };
    const allowedRoots = docker.allowedSharedScratchRoots;
    if (allowedRoots !== undefined && (!Array.isArray(allowedRoots) || !allowedRoots.every((item) => typeof item === 'string' && isAbsolute(item)))) throw new Error('isolated Codex allowed shared scratch roots must be absolute paths');
    return { id, profile, environment: environment as Record<string, string>, compatibleModels: compatibleModels as string[], runNonce, docker: { image: requiredText(docker.image, 'runtime.providers.docker.image'), scratchRoot: absolutePath(docker.scratchRoot, 'runtime.providers.docker.scratchRoot'), controlStoragePaths: docker.controlStoragePaths as string[], ...(allowedRoots === undefined ? {} : { allowedSharedScratchRoots: allowedRoots as string[] }), approvedInputs, ...(credentialProfile === undefined ? {} : { credentialProfile }), networkMode: docker.networkMode as 'none' | 'bridge', resources: { memoryBytes: Number(resources.memoryBytes), cpuCount: Number(resources.cpuCount), pids: Number(resources.pids) }, allowUnsandboxedCodexInsideValidatedContainer: docker.allowUnsandboxedCodexInsideValidatedContainer } };
  }
  if (id === 'cursor') {
    if (!Number.isInteger(route.requestTimeoutMs) || Number(route.requestTimeoutMs) < 1) throw new Error('Cursor route requires a positive requestTimeoutMs');
    return { id, profile, environment: environment as Record<string, string>, requestTimeoutMs: Number(route.requestTimeoutMs), runNonce };
  }
  if (!Array.isArray(compatibleModels) || !compatibleModels.every((item) => typeof item === 'string' && item.trim().length > 0)) throw new Error(`${id} route requires explicit compatibleModels`);
  if (id === 'claude') {
    if (!Array.isArray(route.allowedTools) || !route.allowedTools.every((item) => typeof item === 'string' && item.trim().length > 0)) throw new Error('Claude route requires an explicit allowedTools array');
    return { id, profile, environment: environment as Record<string, string>, compatibleModels: compatibleModels as string[], allowedTools: route.allowedTools as string[], runNonce };
  }
  const contextIsolation = route.contextIsolation ?? 'host';
  if (contextIsolation !== 'host' && contextIsolation !== 'bounded') throw new Error('native Codex route contextIsolation must be host or bounded');
  return { id, profile, environment: environment as Record<string, string>, compatibleModels: compatibleModels as string[], runNonce, contextIsolation };
}

function runtime(value: unknown, factoryId: string): LocalConsoleRuntimeConfiguration | undefined {
  if (value === undefined) return undefined;
  const input = object(value);
  const rawProviders = Array.isArray(input?.providers) ? input.providers : input?.provider === undefined ? [] : [input.provider];
  if (rawProviders.length === 0) throw new Error('runtime must include at least one provider route');
  const providers = rawProviders.map(providerRoute);
  if (new Set(providers.map((provider) => `${provider.id}:${provider.profile}`)).size !== providers.length) throw new Error('runtime provider route ID/profile pairs must be unique');
  const providerRoutes = new Set(providers.map((provider) => `${provider.id}:${provider.profile}`));
  if (!Array.isArray(input?.workItems)) throw new Error('runtime must include explicit eligible workItems');
  const workItems = input.workItems.map((item) => {
    const candidate = object(item); const intent = candidate?.intent as RunIntent | undefined; const context = candidate?.context as ProviderCurrentContext | undefined;
    if (typeof candidate?.workItemId !== 'string' || candidate.workItemId.trim().length === 0 || intent?.format !== 'faktori.run-intent/v1' || intent.target?.factoryId !== factoryId || !providerRoutes.has(`${intent.execution?.providerId}:${intent.execution?.profile}`) || (intent.workItem.role !== undefined && (typeof intent.workItem.role !== 'string' || intent.workItem.role.length > 64 || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(intent.workItem.role))) || (intent.execution.reasoning !== undefined && !['low', 'medium', 'high'].includes(intent.execution.reasoning)) || !context || typeof context.prompt !== 'string' || providerContextPayloadDigest(context) === '' || !intent.execution.approvedInputDigests?.includes(providerContextPayloadDigest(context))) throw new Error('runtime work item must contain a factory-bound intent, configured provider/profile route, optional valid role/reasoning, and exact approved context');
    if (candidate.dependsOnWorkItemIds !== undefined && (!Array.isArray(candidate.dependsOnWorkItemIds) || !candidate.dependsOnWorkItemIds.every((dependency) => typeof dependency === 'string' && dependency.trim().length > 0))) throw new Error('runtime work-item dependencies must be explicit work-item IDs');
    return { workItemId: candidate.workItemId, intent, context, dependsOnWorkItemIds: [...new Set((candidate.dependsOnWorkItemIds ?? []) as string[])] };
  });
  if (new Set(workItems.map((item) => item.workItemId)).size !== workItems.length || new Set(workItems.map((item) => item.intent.runId)).size !== workItems.length) throw new Error('runtime work-item and run IDs must be unique');
  const workItemIds = new Set(workItems.map((item) => item.workItemId));
  if (workItems.some((item) => item.dependsOnWorkItemIds.some((dependency) => !workItemIds.has(dependency) || dependency === item.workItemId))) throw new Error('runtime work-item dependency must reference a different configured work item');
  if (input.resumePlans !== undefined && !Array.isArray(input.resumePlans)) throw new Error('runtime.resumePlans must be an array');
  const resumePlans = (input.resumePlans ?? []).map((item) => {
    const candidate = object(item);
    const sourceRunId = requiredText(candidate?.sourceRunId, 'runtime.resumePlans.sourceRunId');
    const targetWorkItemId = requiredText(candidate?.targetWorkItemId, 'runtime.resumePlans.targetWorkItemId');
    if (!workItemIds.has(targetWorkItemId)) throw new Error('runtime resume plan must reference a configured target work item');
    return { sourceRunId, targetWorkItemId };
  });
  if (new Set(resumePlans.map((item) => item.sourceRunId)).size !== resumePlans.length) throw new Error('runtime resume source run IDs must be unique');
  const gmInput = object(input.gm);
  const gm = gmInput === undefined ? undefined : (() => {
    const template = object(gmInput.diagnosisTemplate);
    const intent = template?.intent as RunIntent | undefined;
    if (intent?.format !== 'faktori.run-intent/v1' || intent.target.factoryId !== factoryId || intent.execution.profile !== 'native'
      || !providerRoutes.has(`${intent.execution.providerId}:${intent.execution.profile}`)) throw new Error('runtime GM diagnosis template must contain a factory-bound intent on a configured provider/profile route');
    return {
      instructions: { revision: requiredText(object(gmInput.instructions)?.revision, 'runtime.gm.instructions.revision'), content: requiredText(object(gmInput.instructions)?.content, 'runtime.gm.instructions.content') },
      diagnosisTemplate: { intent },
      ...(Array.isArray(gmInput.configuredRoutineActions) ? { configuredRoutineActions: gmInput.configuredRoutineActions as Array<'refresh_projection' | 'reconcile_unresolved_operations' | 'prune_expired_console_commands'> } : {}),
    };
  })();
  return { providers, workItems, resumePlans, ...(gm === undefined ? {} : { gm }) };
}

/** Explicit test seam. Production startup never supplies a transcript or mock runner. */
export interface LocalConsoleDependencies {
  /** Test-only seams; production startup always constructs the native implementations. */
  codexRunner?: CodexProcessRunner;
  claudeRunner?: ClaudeProcessRunner;
  cursorTransport?: CursorAcpTransport;
  providerAdapters?: Partial<Record<SupportedProviderId, ProviderTurnAdapter>>;
  nativeIdentityProbe?: NativeIdentityProbeContract;
  /** Test/host seam for the Console coordinator process itself. */
  coordinatorIdentityProbe?: NativeIdentityProbeContract;
  healthPollIntervalMs?: number;
  /** Server-owned edit boundary; only file startup configures this in production. */
  settingsEditor?: ConsoleSettingsEditor;
}

function observedNativeProcess(value: Awaited<ReturnType<NativeIdentityProbeContract['inspect']>>): value is Exclude<typeof value, { status: 'absent' | 'unknown' } | undefined> {
  return value !== undefined && 'pid' in value;
}

function localProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

async function localCoordinatorOwnership(dependencies: LocalConsoleDependencies): Promise<{ identity: CoordinatorIdentity; processProbe: ProcessProbe }> {
  const identityProbe = dependencies.coordinatorIdentityProbe ?? new NativeIdentityProbe({
    commands: new BoundedCommandRunner(),
    cwd: process.cwd(),
    env: localProcessEnvironment(),
  });
  const self = await identityProbe.inspect(process.pid);
  if (!observedNativeProcess(self) || self.pid !== process.pid || !self.running) {
    throw new Error('Console cannot establish its exact native process identity; coordinator ownership is unavailable');
  }
  const classify = async (identity: Pick<CoordinatorIdentity, 'pid' | 'processStartedAt' | 'processGroupId'>): Promise<ProcessStatus> => {
    const processList = await identityProbe.inspectAll?.();
    if (processList !== undefined) {
      if ('status' in processList) return 'unknown';
      const listed = processList.find((entry) => entry.pid === identity.pid);
      if (listed === undefined) return 'dead';
      if (listed.processStartedAt !== identity.processStartedAt
        || (identity.processGroupId !== undefined && listed.processGroupId !== identity.processGroupId)) return 'mismatch';
      return listed.running ? 'alive' : 'dead';
    }
    const observed = await identityProbe.inspect(identity.pid);
    if (!observedNativeProcess(observed)) return observed?.status === 'absent' ? 'dead' : 'unknown';
    if (observed.processStartedAt !== identity.processStartedAt
      || (identity.processGroupId !== undefined && observed.processGroupId !== identity.processGroupId)) return 'mismatch';
    return observed.running ? 'alive' : 'dead';
  };
  return {
    identity: {
      instanceId: `console-${process.pid}-${Date.now()}`,
      pid: process.pid,
      processStartedAt: self.processStartedAt,
      processGroupId: self.processGroupId,
    },
    processProbe: {
      coordinator: classify,
      // Coordinator PID absence is sufficient only for the coordinator lock.
      // Worker recovery must retain its group-aware transport-specific proof.
      worker: async () => 'unknown',
    },
  };
}

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
  const journalPath = absolutePath(input.journalPath, 'journalPath');
  const projectionPath = absolutePath(input.projectionPath, 'projectionPath');
  const factoryConfiguration = input.factoryConfiguration === undefined ? undefined : resolveFactoryConfig(input.factoryConfiguration as FactoryConfiguration);
  if (factoryConfiguration !== undefined && factoryConfiguration.factory.id !== factoryId) throw new Error('factoryConfiguration must resolve to the Console factoryId');
  const preflightInput = object(input.preflightRequest);
  if (preflightInput !== undefined && factoryConfiguration !== undefined) {
    const requestedConfiguration = resolveFactoryConfig(preflightInput.configuration as FactoryConfiguration);
    if (JSON.stringify(requestedConfiguration) !== JSON.stringify(factoryConfiguration)) throw new Error('preflightRequest configuration must match the selected Console factoryConfiguration');
  }
  const preflight = input.preflightRequest === undefined ? undefined : evaluateInstalledPreflight(input.preflightRequest, { factoryId, projectionPath });
  if (preflight !== undefined && preflight.scope.factoryId !== 'unresolved' && preflight.scope.factoryId !== factoryId) throw new Error('preflightRequest must target the Console factoryId');
  const configuredRuntime = runtime(input.runtime, factoryId);
  const managerLoops = managerLoopSources(input.managerLoops, factoryConfiguration);
  const registry = managerLoopRegistry(input.managerLoopRegistry);
  const jiraSources = parseJiraSources(input.jiraSources, factoryConfiguration);
  const managerConnected = input.managerConnected === undefined ? undefined : parseManagerConnectedConfig(input.managerConnected);
  if (managerConnected && factoryConfiguration) for (const session of managerConnected.sessions) {
    if (!factoryConfiguration.products.some((product) => product.id === session.productId)) throw new Error('managerConnected session must reference a configured product');
    if (session.podId && !factoryConfiguration.pods.some((pod) => pod.id === session.podId && pod.productId === session.productId)) throw new Error('managerConnected session pod must belong to its product');
  }
  return { factoryId, journalPath, projectionPath, port: Number(input.port), commandToken, allowedOrigins: [...new Set(input.allowedOrigins)], limits: limits(input.limits), managerLoops, ...(registry === undefined ? {} : { managerLoopRegistry: registry }), jiraSources, ...(managerConnected ? { managerConnected } : {}), ...(factoryConfiguration === undefined ? {} : { factoryConfiguration }), ...(preflight === undefined ? {} : { preflight }), ...(configuredRuntime === undefined ? {} : { runtime: configuredRuntime }) };
}

export interface StartedConsole {
  coordinator: DurableCoordinator;
  app: ReturnType<typeof createConsoleService>;
  url: string;
  gm?: FactoryGM;
  close(): Promise<void>;
}

interface ConfiguredRuntime {
  ownerActions: ConsoleOwnerActions;
  diagnosis?: GMProviderDiagnosisPort;
  diagnosisWorkItemIds: ReadonlySet<string>;
  shutdown(): Promise<void>;
}

function sameWorker(left: WorkerIdentity | undefined, right: WorkerIdentity): boolean {
  if (left === undefined || left.kind !== right.kind) return false;
  return left.kind === 'native' && right.kind === 'native'
    ? left.pid === right.pid && left.processStartedAt === right.processStartedAt && left.processGroupId === right.processGroupId && left.runNonce === right.runNonce
    : left.kind === 'container' && right.kind === 'container' && left.containerId === right.containerId && left.containerStartedAt === right.containerStartedAt && left.runNonce === right.runNonce;
}

function providerRouteKey(providerId: string, profile: string): string {
  return `${providerId}:${profile}`;
}

function runtimeProviderId(kind: ResolvedFactoryConfiguration['providers'][number]['kind']): SupportedProviderId {
  return kind === 'claude-code' ? 'claude' : kind;
}

function roleRoutedEntry(
  entry: LocalConsoleRuntimeConfiguration['workItems'][number],
  catalog: ResolvedFactoryConfiguration | undefined,
  routes: readonly LocalProviderRoute[],
  useBuilderDefault: boolean,
): LocalConsoleRuntimeConfiguration['workItems'][number] {
  const explicitRole = entry.intent.workItem.role;
  const role = explicitRole ?? (useBuilderDefault ? 'builder' : undefined);
  if (role === undefined) return entry;
  const target = entry.intent.target;
  const scope = target.podId === undefined
    ? catalog?.products.find((product) => product.id === target.productId)
    : catalog?.pods.find((pod) => pod.id === target.podId && pod.productId === target.productId);
  const assignment = scope?.roleAssignments?.find((candidate) => candidate.role === role);
  if (assignment === undefined) {
    if (explicitRole !== undefined) throw new Error(`role_assignment_not_configured:${role}`);
    return entry;
  }
  const provider = catalog?.providers.find((candidate) => candidate.id === assignment.providerId);
  if (provider === undefined) throw new Error(`role_assignment_provider_not_configured:${role}`);
  const requiredCapabilities = new Set([entry.intent.execution.profile, ...(scope?.requiredCapabilities ?? []), ...((scope?.budget.strictSpending ?? false) ? ['token-limit' as const] : [])]);
  if ([...requiredCapabilities].some((capability) => !provider.capabilities.includes(capability))) throw new Error(`role_assignment_provider_capability_unavailable:${role}`);
  const providerId = runtimeProviderId(provider.kind);
  const route = routes.find((candidate) => candidate.id === providerId && candidate.profile === entry.intent.execution.profile);
  if (route === undefined) throw new Error(`role_assignment_route_unavailable:${role}`);
  if (providerId === 'cursor' && assignment.model !== undefined) throw new Error(`role_assignment_model_unsupported:${role}`);
  const model = assignment.model ?? entry.intent.execution.model;
  if ('compatibleModels' in route && !route.compatibleModels.includes(model)) throw new Error(`role_assignment_model_unavailable:${role}`);
  const reasoning = assignment.reasoning ?? entry.intent.execution.reasoning;
  if (providerId === 'cursor' && reasoning !== undefined) throw new Error(`role_assignment_reasoning_unsupported:${role}`);
  return {
    ...entry,
    intent: {
      ...structuredClone(entry.intent),
      workItem: { ...entry.intent.workItem, role },
      execution: {
        ...entry.intent.execution,
        providerId,
        model,
        ...(reasoning === undefined ? {} : { reasoning }),
      },
    },
  };
}

function gmDiagnosisPrompt(request: Parameters<GMProviderDiagnosisPort['diagnose']>[0]): string {
  return JSON.stringify({
    task: 'faktori_factory_health_diagnosis',
    findingId: request.findingId,
    findingKey: request.findingKey,
    instructionRevision: request.instructionRevision,
    instructions: request.instructions,
    category: request.category,
    occurrenceCount: request.occurrenceCount,
    latestSummary: request.latestSummary,
    outputContract: { format: 'json', maxCharacters: request.maxOutputCharacters, fields: ['summary', 'recommendations'] },
  });
}

function consoleHierarchy(configuration: LocalConsoleConfiguration): NonNullable<Parameters<typeof createConsoleService>[0]['hierarchy']> {
  const catalog = configuration.factoryConfiguration;
  const entries = configuration.runtime?.workItems ?? [];
  const intentIdByConfiguredId = new Map(entries.map((entry) => [entry.workItemId, entry.intent.workItem.id]));
  return {
    ...(catalog === undefined ? {} : { factory: { id: catalog.factory.id, name: catalog.factory.name } }),
    products: catalog?.products.map((product) => ({ id: product.id, name: product.name })) ?? [],
    pods: catalog?.pods.map((pod) => ({ id: pod.id, productId: pod.productId })) ?? [],
    workItems: entries.map((entry) => ({
      id: entry.intent.workItem.id,
      label: entry.workItemId,
      productId: entry.intent.target.productId,
      ...(entry.intent.target.podId === undefined ? {} : { podId: entry.intent.target.podId }),
      dependsOnWorkItemIds: entry.dependsOnWorkItemIds.map((dependency) => intentIdByConfiguredId.get(dependency) as string),
    })),
  };
}

function configuredRuntime(coordinator: DurableCoordinator, configuration: LocalConsoleRuntimeConfiguration, dependencies: LocalConsoleDependencies, catalog?: ResolvedFactoryConfiguration): ConfiguredRuntime {
  const nativeProbes = new Map<string, NativeIdentityProbeContract>();
  const containerProbes = new Map<string, ContainerIdentityProbe>();
  const adapters = new Map<string, ProviderTurnAdapter>();
  const cursorRoute = configuration.providers.find((route) => route.id === 'cursor');
  const requestBroker = cursorRoute === undefined ? undefined : new ConsoleProviderRequestBroker({ coordinator, timeoutMs: cursorRoute.requestTimeoutMs });
  for (const route of configuration.providers) {
    const key = providerRouteKey(route.id, route.profile);
    const injected = dependencies.providerAdapters?.[route.id];
    const commands = new BoundedCommandRunner();
    if (injected !== undefined) {
      adapters.set(key, injected);
      continue;
    }
    if (route.profile === 'isolated') {
      const docker = new DockerCliRunner({ commands, cwd: process.cwd(), env: route.environment });
      const identityProbe = new DockerCliIdentityProbe({ commands, cwd: process.cwd(), env: route.environment });
      containerProbes.set(key, identityProbe);
      const runner = new DockerCodexProcessRunner({
        docker,
        identityProbe,
        runNonce: route.runNonce,
        allowUnsandboxedCodexInsideValidatedContainer: route.docker.allowUnsandboxedCodexInsideValidatedContainer,
        planFor: (request) => buildDockerExecutionPlan({
          runId: request.runId,
          workspacePath: request.cwd,
          command: request.command,
          args: request.args,
          environment: request.environment,
          approvedInputs: route.docker.approvedInputs,
          ...(route.docker.credentialProfile === undefined ? {} : { credentialProfile: route.docker.credentialProfile }),
          networkMode: route.docker.networkMode,
          limits: { maxRuntimeSeconds: Math.max(1, Math.ceil(request.timeoutMs / 1_000)), ...route.docker.resources },
        }, {
          image: route.docker.image,
          scratchRoot: route.docker.scratchRoot,
          controlStoragePaths: route.docker.controlStoragePaths,
          ...(route.docker.allowedSharedScratchRoots === undefined ? {} : { allowedSharedScratchRoots: route.docker.allowedSharedScratchRoots }),
        }),
      });
      adapters.set(key, new CodexAdapter({ limits: coordinator.limits, environment: route.environment, compatibleModels: route.compatibleModels, runner }));
      continue;
    }
    const identityProbe = dependencies.nativeIdentityProbe ?? new NativeIdentityProbe({ commands, cwd: process.cwd(), env: route.environment });
    nativeProbes.set(key, identityProbe);
    if (route.id === 'codex') {
      const runner = dependencies.codexRunner ?? new NativeCodexProcessRunner({ identityProbe, runNonce: route.runNonce });
      adapters.set(key, new CodexAdapter({ limits: coordinator.limits, environment: route.environment, compatibleModels: route.compatibleModels, contextIsolation: route.contextIsolation, runner }));
      continue;
    }
    if (route.id === 'claude') {
      const runner = dependencies.claudeRunner ?? new NativeClaudeProcessRunner({ identityProbe, runNonce: route.runNonce });
      adapters.set(key, new ClaudeAdapter({ limits: coordinator.limits, environment: route.environment, compatibleModels: route.compatibleModels, allowedTools: route.allowedTools, runner }));
      continue;
    }
    if (identityProbe.inspectProcessGroup === undefined) throw new Error('Cursor provider route requires native process-group inspection');
    const cursorProbe = { inspect: (pid: number) => identityProbe.inspect(pid), inspectProcessGroup: (groupId: number) => identityProbe.inspectProcessGroup!(groupId) };
    const transport = dependencies.cursorTransport ?? new CursorAcpStdioTransport({ environment: route.environment, identityProbe: cursorProbe, killProcessGroup: (groupId, signal) => commands.killProcessGroup(groupId, signal), runNonce: route.runNonce });
    adapters.set(key, new CursorAcpAdapter({ transport, limits: { ...coordinator.limits, requestTimeoutMs: route.requestTimeoutMs }, ...(requestBroker === undefined ? {} : { replyPolicy: requestBroker.replyPolicy() }) }));
  }
  const entries = new Map(configuration.workItems.map((entry) => [entry.workItemId, entry]));
  const routedByRunId = new Map<string, LocalConsoleRuntimeConfiguration['workItems'][number]>();
  const resumePlans = new Map(configuration.resumePlans.map((plan) => [plan.sourceRunId, plan.targetWorkItemId]));
  const reservedWorkItems = new Set([...resumePlans.values()]);
  const prepared = new Map<string,
    | { kind: 'native'; reason: string; value: DurableNativeTerminationPreparation; identityProbe: NativeIdentityProbeContract }
    | { kind: 'container'; reason: string; value: DurableDockerTerminationPreparation; identityProbe: ContainerIdentityProbe }
  >();
  const active = new Map<string, CoordinatorProviderDelivery>();
  const background = new Set<Promise<unknown>>();
  const deliveries = new Map<string, CoordinatorProviderDelivery>();
  for (const route of configuration.providers) {
    const key = providerRouteKey(route.id, route.profile);
    const adapter = adapters.get(key);
    const nativeIdentityProbe = nativeProbes.get(key);
    const containerIdentityProbe = containerProbes.get(key);
    if (adapter === undefined || (route.profile === 'native' ? nativeIdentityProbe === undefined && dependencies.providerAdapters?.[route.id] === undefined : containerIdentityProbe === undefined && dependencies.providerAdapters?.[route.id] === undefined)) throw new Error(`provider route ${key} could not be constructed`);
    deliveries.set(key, new CoordinatorProviderDelivery({
      coordinator,
      adapter,
      providerId: route.id,
      terminateWorker: async (worker, reason) => {
        const snapshot = coordinator.snapshots().find((candidate) => candidate.intent.execution.providerId === route.id && candidate.intent.execution.profile === route.profile && sameWorker(candidate.worker, worker));
        if (snapshot === undefined) throw new Error('active durable worker could not be resolved for termination');
        const prior = prepared.get(snapshot.intent.runId);
        if (prior !== undefined) {
          if (prior.reason !== reason || !sameWorker(prior.value.identity, worker)) throw new Error('native termination was repeated with conflicting authority');
          return;
        }
        if (worker.kind === 'native') {
          if (nativeIdentityProbe === undefined) throw new Error('native termination probe is unavailable');
          const value = await prepareDurableNativeTermination({ coordinator, runId: snapshot.intent.runId, identity: worker, identityProbe: nativeIdentityProbe, reason });
          prepared.set(snapshot.intent.runId, { kind: 'native', reason, value, identityProbe: nativeIdentityProbe });
        } else {
          if (containerIdentityProbe === undefined) throw new Error('container termination probe is unavailable');
          const value = await prepareDurableDockerTermination({ coordinator, runId: snapshot.intent.runId, identity: worker, identityProbe: containerIdentityProbe, reason });
          prepared.set(snapshot.intent.runId, { kind: 'container', reason, value, identityProbe: containerIdentityProbe });
        }
      },
    }));
  }

  async function observePrepared(runId: string): Promise<void> {
    const pending = prepared.get(runId);
    if (pending === undefined) return;
    prepared.delete(runId);
    if (pending.kind === 'native') await observeDurableNativeTermination({ coordinator, runId, preparation: pending.value, identityProbe: pending.identityProbe, reason: pending.reason, operationId: pending.value.operationId });
    else await observeDurableDockerTermination({ coordinator, runId, preparation: pending.value, identityProbe: pending.identityProbe, reason: pending.reason, operationId: pending.value.operationId });
  }

  async function deliver(entry: LocalConsoleRuntimeConfiguration['workItems'][number], resume?: ProviderSessionBinding): Promise<Awaited<ReturnType<CoordinatorProviderDelivery['deliver']>>> {
    const delivery = deliveries.get(providerRouteKey(entry.intent.execution.providerId, entry.intent.execution.profile));
    if (delivery === undefined) throw new Error('configured provider delivery route is unavailable');
    active.set(entry.intent.runId, delivery);
    try {
      const result = await delivery.deliver({ runId: entry.intent.runId, context: entry.context, ...(resume === undefined ? {} : { resume }) });
      await observePrepared(entry.intent.runId);
      return result;
    } finally {
      active.delete(entry.intent.runId);
    }
  }

  function launch(entry: LocalConsoleRuntimeConfiguration['workItems'][number], resume?: ProviderSessionBinding): void {
    const turn = deliver(entry, resume);
    background.add(turn);
    void turn.catch(() => undefined).finally(() => background.delete(turn));
  }

  const ownerActions = createConsoleOwnerActions(coordinator, {
    intentForWorkItem: async (workItemId) => {
      if (reservedWorkItems.has(workItemId)) return undefined;
      const entry = entries.get(workItemId);
      if (entry === undefined) return undefined;
      const existing = coordinator.snapshot(entry.intent.runId);
      const routed = existing === undefined
        ? roleRoutedEntry(entry, catalog, configuration.providers, true)
        : { ...entry, intent: existing.intent };
      routedByRunId.set(routed.intent.runId, routed);
      return routed.intent;
    },
    startAdmittedRun: async (runId) => {
      const entry = routedByRunId.get(runId);
      if (entry === undefined) throw new Error('admitted work item context is unavailable');
      launch(entry);
      return { detail: 'provider_delivery_started' };
    },
    cancelRun: async (runId, reason) => {
      const delivery = active.get(runId);
      if (delivery === undefined) throw new Error('run_has_no_active_provider_delivery');
      const result = await delivery.cancel(runId);
      await observePrepared(runId);
      return { detail: `provider_${result.outcome}` };
    },
    resumeRun: async (sourceRunId) => {
      const targetId = resumePlans.get(sourceRunId);
      const configuredEntry = targetId === undefined ? undefined : entries.get(targetId);
      const source = coordinator.snapshot(sourceRunId);
      const sessionId = source?.providerResult?.sessionId;
      if (configuredEntry === undefined || source === undefined || sessionId === undefined) throw new Error('trusted_explicit_resume_plan_unavailable');
      const priorTarget = coordinator.snapshot(configuredEntry.intent.runId);
      const entry = priorTarget === undefined ? configuredEntry : { ...configuredEntry, intent: priorTarget.intent };
      const admitted = await coordinator.admit(entry.intent);
      if (!admitted.accepted) throw new Error(admitted.reason ?? 'resume_target_admission_rejected');
      const binding: ProviderSessionBinding = {
        sessionId,
        sourceRunId,
        sourceContext: source.intent.context,
        sourceScope: {
          factoryId: source.intent.target.factoryId,
          productId: source.intent.target.productId,
          repository: source.intent.target.repository,
          workspaceId: source.intent.execution.workspaceId,
          workspacePath: source.intent.execution.workspacePath,
          providerId: source.intent.execution.providerId as SupportedProviderId,
        },
      };
      launch(entry, binding);
      return { detail: `provider_resume_started:${entry.intent.runId}` };
    },
    ...(requestBroker === undefined ? {} : { answerRequest: (runId: string, requestId: string, answer: string) => requestBroker.answer(runId, requestId, answer) }),
  });

  const diagnosis: GMProviderDiagnosisPort | undefined = configuration.gm === undefined ? undefined : {
    diagnose: async (request) => {
      const prompt = gmDiagnosisPrompt(request);
      const suffix = createHash('sha256').update(request.findingKey).digest('hex').slice(0, 24);
      const template = configuration.gm!.diagnosisTemplate.intent;
      const context: ProviderCurrentContext = {
        packetRevision: template.context.packetRevision,
        digest: `sha256:${createHash('sha256').update(`faktori-gm-context:${prompt}`).digest('hex')}`,
        prompt,
      };
      const intent: RunIntent = {
        ...structuredClone(template),
        runId: `gm-diagnosis-${suffix}`,
        admissionKey: `gm-diagnosis-${suffix}`,
        context: { packetRevision: context.packetRevision, digest: context.digest },
        execution: { ...template.execution, approvedInputDigests: [providerContextPayloadDigest(context)] },
        budget: { ...template.budget, reservationId: `gm-diagnosis-${suffix}`, status: 'held' },
        attempt: 1,
      };
      const entry = roleRoutedEntry({ workItemId: intent.workItem.id, intent, context, dependsOnWorkItemIds: [] }, catalog, configuration.providers, false);
      const admitted = await coordinator.admit(entry.intent);
      if (!admitted.accepted) throw new Error(admitted.reason ?? 'GM diagnosis admission rejected');
      const result = await deliver(entry);
      if (!['completed', 'unchanged_verified'].includes(result.final.outcome) || typeof result.final.summary !== 'string' || result.final.summary.length > request.maxOutputCharacters) throw new Error('GM diagnosis provider result was not a bounded successful JSON summary');
      return JSON.parse(result.final.summary) as unknown;
    },
  };

  return {
    ownerActions,
    ...(diagnosis === undefined ? {} : { diagnosis }),
    diagnosisWorkItemIds: new Set(configuration.gm === undefined ? [] : [configuration.gm.diagnosisTemplate.intent.workItem.id]),
    async shutdown(): Promise<void> {
      requestBroker?.close();
      await Promise.allSettled([...active].map(async ([runId, delivery]) => { await delivery.cancel(runId); await observePrepared(runId); }));
      await Promise.allSettled([...background]);
    },
  };
}

export async function startLocalConsole(configuration: LocalConsoleConfiguration, ownerActions?: ConsoleOwnerActions, dependencies: LocalConsoleDependencies = {}): Promise<StartedConsole> {
  const { identity, processProbe } = await localCoordinatorOwnership(dependencies);
  const coordinator = await Coordinator.open({ factoryId: configuration.factoryId, journalPath: configuration.journalPath, projectionPath: configuration.projectionPath, identity, limits: configuration.limits, processProbe });
  await coordinator.claim();
  let configured: ConfiguredRuntime | undefined;
  let gm: FactoryGM | undefined;
  let observer: CoordinatorGMHealthObserver | undefined;
  let app: ReturnType<typeof createConsoleService> | undefined;
  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let managerStore: ManagerConnectedStore | undefined;
  let managerLoopRegistry: ManagerLoopRegistry | undefined;
  let removeRelayConnection: (() => Promise<void>) | undefined;
  try {
    // Reconstruct and quarantine unresolved work before any configured runtime
    // can admit or launch a new worker. Unknown identity is a blocker, never
    // evidence that a worker disappeared.
    await coordinator.recover();
    configured = configuration.runtime === undefined ? undefined : configuredRuntime(coordinator, configuration.runtime, dependencies, configuration.factoryConfiguration);
    gm = configuration.runtime?.gm === undefined ? undefined : new FactoryGM({ factoryId: configuration.factoryId, instructions: configuration.runtime.gm.instructions, store: new CoordinatorGMStore(coordinator), ...(configured?.diagnosis === undefined ? {} : { diagnosis: configured.diagnosis }), configuredRoutineActions: configuration.runtime.gm.configuredRoutineActions });
    observer = gm === undefined ? undefined : new CoordinatorGMHealthObserver({ coordinator, gm, excludedWorkItemIds: configured?.diagnosisWorkItemIds });
    managerLoopRegistry = configuration.managerLoopRegistry === undefined ? undefined : await ManagerLoopRegistry.open({
      ...configuration.managerLoopRegistry,
      reservedSources: configuration.managerLoops,
      validate: (source) => managerLoopSource(source, 0, configuration.factoryConfiguration),
    });
    const registeredLoops = managerLoopRegistry?.sources() ?? [];
    const allLoopSources = [...configuration.managerLoops, ...registeredLoops];
    if (new Set(allLoopSources.map((source) => source.id)).size !== allLoopSources.length || new Set(allLoopSources.map((source) => source.artifactsDirectory)).size !== allLoopSources.length) throw new Error('persisted manager loop registration conflicts with configured source');
    const managerLoopObserver = new ManagerLoopObserver({ sources: allLoopSources });
    await managerLoopObserver.poll();
    const jiraObserver = new JiraObserver(configuration.jiraSources ?? []);
    managerStore = configuration.managerConnected ? await ManagerConnectedStore.open(configuration.managerConnected) : undefined;
    const relayToken = newManagerRelayToken();
    app = createConsoleService({ coordinator, commandToken: configuration.commandToken ?? consoleCommandToken(), allowedOrigins: configuration.allowedOrigins, ownerActions: configured?.ownerActions ?? ownerActions, hierarchy: consoleHierarchy(configuration), preflight: configuration.preflight, settings: createConsoleSettings(configuration), settingsEditor: dependencies.settingsEditor, managerLoopObserver, ...(managerLoopRegistry ? { managerLoopRegistry } : {}), jiraObserver, ...(managerStore ? { managerConnected: { store: managerStore, relayToken } } : {}) });
    const listeningApp = app;
    pollInterval = observer === undefined ? undefined : setInterval(() => { void observer?.poll(); }, dependencies.healthPollIntervalMs ?? 250);
    pollInterval?.unref();
    const address = await listeningApp.listen({ host: '127.0.0.1', port: configuration.port });
    if (configuration.managerConnected) removeRelayConnection = await writeManagerRelayConnection(configuration.managerConnected.directory, address, relayToken);
    await observer?.poll();
    return {
      coordinator, app: listeningApp, url: address, ...(gm === undefined ? {} : { gm }),
      async close(): Promise<void> {
        if (pollInterval !== undefined) clearInterval(pollInterval);
        await listeningApp.close();
        await configured?.shutdown();
        await observer?.settle();
        await removeRelayConnection?.();
        await managerStore?.close();
        await coordinator.release();
        coordinator.close();
      },
    };
  } catch (error) {
    if (pollInterval !== undefined) clearInterval(pollInterval);
    await app?.close();
    await configured?.shutdown();
    await removeRelayConnection?.();
    await managerStore?.close();
    await coordinator.release(); coordinator.close();
    throw error;
  }
}

export async function startLocalConsoleFromFile(path: string, dependencies: LocalConsoleDependencies = {}): Promise<StartedConsole> {
  const content = await readFile(path, 'utf8');
  const parsed = JSON.parse(content) as unknown;
  const configuration = parseLocalConsoleConfiguration(parsed);
  const settingsEditor = new FileConsoleSettingsEditor({ path, loadedContent: content, validate: parseLocalConsoleConfiguration });
  return startLocalConsole(configuration, undefined, { ...dependencies, settingsEditor });
}
