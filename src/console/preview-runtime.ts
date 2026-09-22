import { isAbsolute } from 'node:path';

import type { DurableCoordinator } from '../runtime/coordinator.ts';
import {
  PersistentPreviewService,
  type PreviewFeedbackOperation,
  type PreviewRegistration,
  type PreviewSnapshot,
} from '../preview/index.ts';
import { deliveryJournal } from './delivery-journal.ts';

export interface PersistentPreviewRuntimeConfiguration {
  format: 'faktori.persistent-preview-runtime/v1';
  registrations: PreviewRegistration[];
  /** Browser requests name one server-configured operation ID only. */
  operations: PersistentPreviewOperation[];
}

export type PersistentPreviewOperation =
  | { id: string; previewId: string; kind: 'start' | 'stop' | 'verify' }
  | { id: string; previewId: string; kind: 'feedback'; feedback: PreviewFeedbackOperation }
  | { id: string; previewId: string; kind: 'candidate_update'; registration: PreviewRegistration };

export interface PersistentPreviewRuntimeSnapshot {
  registrations: number;
  previews: PreviewSnapshot[];
  operationIds: string[];
  operations: Array<{ id: string; previewId: string; kind: PersistentPreviewOperation['kind'] }>;
  browserInput: 'operation_id_or_bounded_feedback';
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, field: string, max = 4_000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) throw new Error(`${field}_invalid`);
  return value;
}
function id(value: unknown, field: string): string {
  const answer = text(value, field, 128);
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(answer)) throw new Error(`${field}_invalid`);
  return answer;
}
function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${field}_invalid`);
}
function command(value: unknown, field: string): { command: string; args: string[] } {
  const input = object(value); if (!input) throw new Error(`${field}_invalid`);
  exact(input, ['command', 'args'], field);
  const executable = text(input.command, `${field}.command`, 4_000);
  if (!isAbsolute(executable) || !Array.isArray(input.args) || input.args.length > 100) throw new Error(`${field}_invalid`);
  return { command: executable, args: input.args.map((item, index) => text(item, `${field}.args.${index}`, 32_768)) };
}
function registration(value: unknown, field: string): PreviewRegistration {
  const input = object(value); if (!input) throw new Error(`${field}_invalid`);
  const allowed = ['id', 'featureId', 'implementerId', 'ownerApprovedBy', 'worktree', 'candidateRevision', 'url', 'startup', 'identity', 'environment', 'browserContexts', 'limits'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error(`${field}_invalid`);
  const environment = object(input.environment);
  if (!environment || Object.values(environment).some(item => typeof item !== 'string')) throw new Error(`${field}.environment_invalid`);
  const contexts = object(input.browserContexts); const agent = object(contexts?.agent); const human = object(contexts?.human);
  if (!contexts || !agent || !human) throw new Error(`${field}.browserContexts_invalid`);
  exact(agent, ['contextId', 'role'], `${field}.browserContexts.agent`); exact(human, ['contextId', 'role'], `${field}.browserContexts.human`);
  const limits = input.limits === undefined ? undefined : object(input.limits);
  if (input.limits !== undefined && (!limits || Object.keys(limits).some(key => !['identityTimeoutMs', 'shutdownTimeoutMs', 'outputMaxBytes'].includes(key))
    || Object.values(limits).some(item => !Number.isInteger(item)))) throw new Error(`${field}.limits_invalid`);
  const worktree = text(input.worktree, `${field}.worktree`); if (!isAbsolute(worktree)) throw new Error(`${field}.worktree_invalid`);
  return {
    id: id(input.id, `${field}.id`), featureId: id(input.featureId, `${field}.featureId`), implementerId: id(input.implementerId, `${field}.implementerId`), ownerApprovedBy: text(input.ownerApprovedBy, `${field}.ownerApprovedBy`, 256),
    worktree, candidateRevision: text(input.candidateRevision, `${field}.candidateRevision`, 512), url: text(input.url, `${field}.url`), startup: command(input.startup, `${field}.startup`), identity: command(input.identity, `${field}.identity`),
    environment: environment as Record<string, string>, browserContexts: { agent: { contextId: id(agent.contextId, `${field}.browserContexts.agent.contextId`), role: agent.role === 'agent' ? 'agent' : (() => { throw new Error(`${field}.browserContexts.agent.role_invalid`); })() }, human: { contextId: id(human.contextId, `${field}.browserContexts.human.contextId`), role: human.role === 'human' ? 'human' : (() => { throw new Error(`${field}.browserContexts.human.role_invalid`); })() } },
    ...(limits === undefined ? {} : { limits: limits as PreviewRegistration['limits'] }),
  };
}
function feedback(value: unknown, field: string): PreviewFeedbackOperation {
  const input = object(value); if (!input) throw new Error(`${field}_invalid`);
  const kind = input.kind;
  if (kind === 'requested') { exact(input, ['kind', 'itemId', 'featureId', 'implementerId', 'summary', 'revision'], field); return { kind, itemId: id(input.itemId, `${field}.itemId`), featureId: id(input.featureId, `${field}.featureId`), implementerId: id(input.implementerId, `${field}.implementerId`), summary: text(input.summary, `${field}.summary`, 2_000), revision: text(input.revision, `${field}.revision`, 512) }; }
  if (kind === 'applied' || kind === 'confirmed') { exact(input, ['kind', 'itemId', 'featureId', 'implementerId', 'revision'], field); return { kind, itemId: id(input.itemId, `${field}.itemId`), featureId: id(input.featureId, `${field}.featureId`), implementerId: id(input.implementerId, `${field}.implementerId`), revision: text(input.revision, `${field}.revision`, 512) }; }
  throw new Error(`${field}_invalid`);
}

/** Redacts pasted credentials and local host paths before feedback reaches the journal or browser projection. */
export function redactPreviewFeedbackSummary(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[redacted credential]')
    .replace(/\b(password|passphrase|api[ _-]?key|access[ _-]?token|token)\s*[:=]\s*[^\s,;]+/gi, '$1: [redacted credential]')
    .replace(/(?:\/[Uu]sers|\/home|\/private|\/var|\/tmp)\/[^\s,;]+/g, '[redacted local path]')
    .replace(/[A-Za-z]:\\(?:Users|home|private|var|tmp)\\[^\s,;]+/g, '[redacted local path]');
  return redacted.trim() || '[redacted sensitive feedback]';
}

export function parsePersistentPreviewRuntimeConfiguration(value: unknown): PersistentPreviewRuntimeConfiguration {
  const input = object(value); if (!input) throw new Error('preview_runtime_configuration_invalid');
  exact(input, ['format', 'registrations', 'operations'], 'preview_runtime_configuration');
  if (input.format !== 'faktori.persistent-preview-runtime/v1' || !Array.isArray(input.registrations) || !Array.isArray(input.operations) || input.registrations.length > 100 || input.operations.length > 1_000) throw new Error('preview_runtime_configuration_invalid');
  const registrations = input.registrations.map((item, index) => registration(item, `preview_runtime.registrations.${index}`));
  if (new Set(registrations.map(item => item.id)).size !== registrations.length) throw new Error('preview_runtime_registration_duplicate');
  const registered = new Set(registrations.map(item => item.id));
  const operations = input.operations.map((value, index): PersistentPreviewOperation => {
    const item = object(value); if (!item) throw new Error(`preview_runtime.operations.${index}_invalid`);
    const kind = item.kind; const operationId = id(item.id, `preview_runtime.operations.${index}.id`); const previewId = id(item.previewId, `preview_runtime.operations.${index}.previewId`);
    if (!registered.has(previewId)) throw new Error('preview_runtime_operation_unknown_preview');
    if (kind === 'start' || kind === 'stop' || kind === 'verify') { exact(item, ['id', 'previewId', 'kind'], `preview_runtime.operations.${index}`); return { id: operationId, previewId, kind }; }
    if (kind === 'feedback') { exact(item, ['id', 'previewId', 'kind', 'feedback'], `preview_runtime.operations.${index}`); return { id: operationId, previewId, kind, feedback: feedback(item.feedback, `preview_runtime.operations.${index}.feedback`) }; }
    if (kind === 'candidate_update') { exact(item, ['id', 'previewId', 'kind', 'registration'], `preview_runtime.operations.${index}`); const next = registration(item.registration, `preview_runtime.operations.${index}.registration`); if (next.id !== previewId) throw new Error('preview_runtime_candidate_update_id_mismatch'); return { id: operationId, previewId, kind, registration: next }; }
    throw new Error(`preview_runtime.operations.${index}_invalid`);
  });
  if (new Set(operations.map(item => item.id)).size !== operations.length) throw new Error('preview_runtime_operation_duplicate');
  return { format: 'faktori.persistent-preview-runtime/v1', registrations, operations };
}

/** Server-owned facade: browser input selects an approved operation ID and nothing else. */
export class PersistentPreviewRuntime {
  readonly configuration: PersistentPreviewRuntimeConfiguration;
  readonly previews: PersistentPreviewService;
  #started = false;

  constructor(options: { coordinator: DurableCoordinator; configuration: PersistentPreviewRuntimeConfiguration }) {
    this.configuration = parsePersistentPreviewRuntimeConfiguration(options.configuration);
    this.previews = new PersistentPreviewService({ journal: deliveryJournal(options.coordinator, 'preview') });
  }
  async start(): Promise<PersistentPreviewRuntimeSnapshot> {
    if (!this.#started) {
      for (const registration of this.configuration.registrations) await this.previews.register(registration);
      this.#started = true;
    }
    return this.snapshot();
  }
  async snapshot(): Promise<PersistentPreviewRuntimeSnapshot> {
    const operations = this.configuration.operations.map(item => ({ id: item.id, previewId: item.previewId, kind: item.kind }));
    if (!this.#started) return { registrations: this.configuration.registrations.length, previews: [], operationIds: operations.map(item => item.id), operations, browserInput: 'operation_id_or_bounded_feedback' };
    return { registrations: this.configuration.registrations.length, previews: await this.previews.snapshot() as PreviewSnapshot[], operationIds: operations.map(item => item.id), operations, browserInput: 'operation_id_or_bounded_feedback' };
  }
  async command(operationId: string): Promise<PreviewSnapshot> {
    if (!this.#started) throw new Error('preview_runtime_not_started');
    const operation = this.configuration.operations.find(item => item.id === operationId);
    if (!operation) throw new Error('preview_operation_not_allowlisted');
    if (operation.kind === 'start') return this.previews.start(operation.previewId);
    if (operation.kind === 'stop') return this.previews.stop(operation.previewId);
    if (operation.kind === 'verify') return this.previews.snapshot(operation.previewId) as Promise<PreviewSnapshot>;
    if (operation.kind === 'feedback') return this.previews.feedback(operation.previewId, operation.feedback);
    if (operation.kind === 'candidate_update') {
      await this.previews.register(operation.registration);
      return this.previews.snapshot(operation.previewId) as Promise<PreviewSnapshot>;
    }
    throw new Error('preview_operation_invalid');
  }
  /** A human review request only records bounded feedback; it cannot run a command. */
  async requestFeedback(previewId: string, input: { itemId: string; summary: string; revision: string }): Promise<PreviewSnapshot> {
    const preview = await this.#preview(previewId);
    if (input.revision !== preview.candidateRevision) throw new Error('preview_feedback_revision_stale');
    if (!input.summary.trim() || input.summary.length > 2_000) throw new Error('preview_feedback_summary_invalid');
    return this.previews.feedback(previewId, { kind: 'requested', itemId: input.itemId, summary: redactPreviewFeedbackSummary(input.summary), revision: input.revision, featureId: preview.featureId, implementerId: preview.implementerId });
  }
  /** Confirmation accepts only a previously applied feedback revision. */
  async confirmFeedback(previewId: string, input: { itemId: string; revision: string }): Promise<PreviewSnapshot> {
    const preview = await this.#preview(previewId);
    if (input.revision !== preview.candidateRevision) throw new Error('preview_feedback_revision_stale');
    return this.previews.feedback(previewId, { kind: 'confirmed', itemId: input.itemId, revision: input.revision, featureId: preview.featureId, implementerId: preview.implementerId });
  }
  async shutdown(): Promise<void> {
    if (!this.#started) return;
    const previews = await this.previews.snapshot() as PreviewSnapshot[];
    for (const preview of previews) if (['starting', 'running', 'stopping', 'invalidated'].includes(preview.state)) await this.previews.stop(preview.id);
  }
  async #preview(previewId: string): Promise<PreviewSnapshot> {
    if (!this.#started) throw new Error('preview_runtime_not_started');
    if (!this.configuration.registrations.some(item => item.id === previewId)) throw new Error('preview_not_registered');
    return this.previews.snapshot(previewId) as Promise<PreviewSnapshot>;
  }
}
