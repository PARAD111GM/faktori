import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { DurableCoordinator } from '../runtime/coordinator.ts';
import type { RunIntent } from '../runtime/contracts.ts';
import {
  SubscriptionRoutingController,
  type CapacityObservation, type RouteCandidate, type RoutingEvent, type RoutingPolicy, type RoutingRequest,
} from '../runtime/routing.ts';
import { deliveryJournal } from './delivery-journal.ts';

export interface SubscriptionRoutingBinding {
  taskClass: string;
  requiredCapabilities?: string[];
  /** Only accepted when a provider probe gave a comparable native unit. */
  nativeCapacityEstimate?: RoutingRequest['nativeCapacityEstimate'];
  explicitCapacityAllowance?: RoutingRequest['explicitCapacityAllowance'];
  paidAuthority?: RoutingRequest['paidAuthority'];
}

export interface SubscriptionRoutingConfiguration {
  policy: RoutingPolicy;
  candidates: RouteCandidate[];
  observations: CapacityObservation[];
  /** Optional owner-owned evidence export; refreshed without inference before admission. */
  observationsPath?: string;
  bindings: Record<string, SubscriptionRoutingBinding>;
}

function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function text(value: unknown, name: string, max = 256): string { if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`${name}_invalid`); return value; }
function time(value: unknown, name: string): void { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name}_invalid`); }
function units(value: unknown, name: string): void { if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) throw new Error(`${name}_invalid`); }

function validateCandidate(value: unknown): void {
  const route = object(value); if (!route) throw new Error('routing_candidate_invalid');
  for (const key of ['routeId', 'providerId', 'accountPoolId', 'model', 'capabilityObservedAt', 'modelObservedAt']) text(route[key], `routing_candidate_${key}`);
  if (!['economical', 'senior', 'paid'].includes(String(route.costTier)) || typeof route.subscriptionEligible !== 'boolean'
    || !Array.isArray(route.taskClasses) || !route.taskClasses.every(item => typeof item === 'string' && item.length > 0)
    || !Array.isArray(route.capabilities) || !route.capabilities.every(item => typeof item === 'string' && item.length > 0)) throw new Error('routing_candidate_invalid');
  time(route.capabilityObservedAt, 'routing_capability_observed_at'); time(route.modelObservedAt, 'routing_model_observed_at');
}

/** Validates actual provider observations; it deliberately does not infer a capacity unit from a percentage. */
export function validateCapacityObservation(value: unknown): asserts value is CapacityObservation {
  const observation = object(value); if (!observation) throw new Error('routing_observation_invalid');
  for (const key of ['accountPoolId', 'providerId', 'nativeUnit', 'snapshotId', 'source']) text(observation[key], `routing_observation_${key}`);
  time(observation.observedAt, 'routing_observation_observed_at');
  if (observation.resetAt !== undefined) time(observation.resetAt, 'routing_observation_reset_at');
  units(observation.limitUnits, 'routing_observation_limit_units'); units(observation.availableUnits, 'routing_observation_available_units');
  if (observation.externalPressure !== undefined && !['none', 'observed', 'unknown'].includes(String(observation.externalPressure))) throw new Error('routing_observation_external_pressure_invalid');
  if (observation.availabilityAccounting !== undefined && !['includes_active_faktori_reservations', 'excludes_active_faktori_reservations', 'unknown'].includes(String(observation.availabilityAccounting))) throw new Error('routing_observation_accounting_invalid');
}

function validateBinding(workItemId: string, binding: unknown, policy: RoutingPolicy): asserts binding is SubscriptionRoutingBinding {
  const parsed = object(binding); if (!parsed || !workItemId.trim()) throw new Error('routing_work_binding_invalid');
  const taskClass = text(parsed.taskClass, 'routing_task_class');
  if (!policy.taskClasses[taskClass]) throw new Error('routing_work_binding_invalid');
  if (parsed.requiredCapabilities !== undefined && (!Array.isArray(parsed.requiredCapabilities) || parsed.requiredCapabilities.some(item => typeof item !== 'string' || item.length === 0))) throw new Error('routing_work_binding_invalid');
  const estimate = object(parsed.nativeCapacityEstimate);
  if (parsed.nativeCapacityEstimate !== undefined && (!estimate || !Number.isSafeInteger(estimate.value) || (estimate.value as number) < 1 || typeof estimate.nativeUnit !== 'string' || estimate.nativeUnit.length === 0)) throw new Error('routing_native_capacity_estimate_invalid');
  const allowance = object(parsed.explicitCapacityAllowance);
  if (parsed.explicitCapacityAllowance !== undefined && (!allowance || !Number.isSafeInteger(allowance.units) || (allowance.units as number) < 1 || typeof allowance.authorityRevision !== 'string' || allowance.authorityRevision.length === 0)) throw new Error('routing_explicit_allowance_invalid');
  const paid = object(parsed.paidAuthority);
  if (parsed.paidAuthority !== undefined && (!paid || typeof paid.authorityRevision !== 'string' || !Array.isArray(paid.routeIds) || paid.routeIds.some(item => typeof item !== 'string' || item.length === 0))) throw new Error('routing_paid_authority_invalid');
}

export function parseSubscriptionRouting(value: unknown): SubscriptionRoutingConfiguration {
  const input = object(value); const allowed = new Set(['policy', 'candidates', 'observations', 'observationsPath', 'bindings']);
  if (!input || Object.keys(input).some(key => !allowed.has(key))) throw new Error('routing_configuration_invalid');
  const policy = object(input.policy);
  if (!policy || typeof policy.policyRevision !== 'string' || !object(policy.taskClasses) || !Number.isSafeInteger(policy.maxEvidenceAgeMs) || (policy.maxEvidenceAgeMs as number) < 0) throw new Error('routing_configuration_invalid');
  if (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.length > 64 || !Array.isArray(input.observations) || input.observations.length > 64 || !object(input.bindings)) throw new Error('routing_configuration_invalid');
  if (input.observationsPath !== undefined && (typeof input.observationsPath !== 'string' || !isAbsolute(input.observationsPath))) throw new Error('routing_observations_path_invalid');
  input.candidates.forEach(validateCandidate); input.observations.forEach(validateCapacityObservation);
  if (new Set(input.candidates.map(candidate => (candidate as RouteCandidate).routeId)).size !== input.candidates.length) throw new Error('routing_duplicate_route');
  const typed = input as unknown as SubscriptionRoutingConfiguration;
  for (const [id, binding] of Object.entries(typed.bindings)) validateBinding(id, binding, typed.policy);
  return structuredClone(typed);
}

async function capacityObservations(config: SubscriptionRoutingConfiguration): Promise<CapacityObservation[]> {
  if (!config.observationsPath) return config.observations;
  const handle = await open(config.observationsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 131_072 || (before.mode & 0o077) !== 0 || typeof process.getuid === 'function' && before.uid !== process.getuid()) throw new Error('routing_observations_unsafe');
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (bytes.length !== before.size || before.mtimeMs !== after.mtimeMs) throw new Error('routing_observations_changed');
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!Array.isArray(value) || value.length > 64) throw new Error('routing_observations_invalid');
    value.forEach(validateCapacityObservation);
    return value;
  } finally { await handle.close(); }
}

export class ConsoleSubscriptionRouting {
  readonly controller: SubscriptionRoutingController;
  readonly #configuration: SubscriptionRoutingConfiguration;
  readonly #journal;

  constructor(coordinator: DurableCoordinator, configuration: SubscriptionRoutingConfiguration) {
    this.#configuration = configuration; this.#journal = deliveryJournal<RoutingEvent>(coordinator, 'routing');
    this.controller = new SubscriptionRoutingController({ journal: this.#journal });
  }

  async select(intent: RunIntent, contextRevision: string, eligibleRoute: (route: RouteCandidate) => boolean): Promise<RunIntent> {
    const binding = this.#configuration.bindings[intent.workItem.id];
    if (!binding) throw new Error('routing_work_binding_missing');
    const request: RoutingRequest = {
      runId: intent.runId, workItemId: intent.workItem.id, workItemRevision: intent.workItem.revision, role: intent.workItem.role ?? 'builder',
      contextRevision, attempt: intent.attempt, taskClass: binding.taskClass, requestedAt: intent.createdAt,
      requiredCapabilities: [...new Set([intent.execution.profile, ...(binding.requiredCapabilities ?? [])])],
      advisoryEstimate: { value: intent.budget.estimatedTokens, unit: 'tokens' },
      ...(binding.nativeCapacityEstimate ? { nativeCapacityEstimate: binding.nativeCapacityEstimate } : {}),
      ...(binding.explicitCapacityAllowance ? { explicitCapacityAllowance: binding.explicitCapacityAllowance } : {}),
      ...(binding.paidAuthority && intent.authority.policy.allowSeparateBilling ? { paidAuthority: binding.paidAuthority } : {}),
    };
    let observations: CapacityObservation[];
    try { observations = await capacityObservations(this.#configuration); }
    catch { observations = []; } // An unsafe or invalid file never becomes fresh evidence.
    const result = await this.controller.admit(request, this.#configuration.policy, this.#configuration.candidates.filter(eligibleRoute), observations);
    if (result.decision.status !== 'admitted' || !result.decision.providerId || !result.decision.model) throw new Error(`routing_blocked:${result.decision.reason}`);
    return { ...intent, execution: { ...intent.execution, providerId: result.decision.providerId, model: result.decision.model } };
  }

  async terminal(runId: string, outcome: string): Promise<void> {
    const event = this.#journal.events().filter((record): record is Extract<RoutingEvent, { type: 'routing.admitted' }> => record.type === 'routing.admitted' && record.request.runId === runId).at(-1);
    if (event !== undefined) await this.controller.observeTerminal({ attemptId: event.attemptId, outcome });
  }

  snapshot(): { configured: true; policyRevision: string; decisions: Array<Record<string, unknown>> } {
    const latest = new Map<string, Record<string, unknown>>();
    for (const event of this.#journal.events()) if ('decision' in event) latest.set(event.attemptId, { runId: event.request.runId, workItemId: event.request.workItemId, role: event.request.role, taskClass: event.request.taskClass, ...event.decision, observedAt: event.occurredAt });
    return { configured: true, policyRevision: this.#configuration.policy.policyRevision, decisions: [...latest.values()] };
  }
}
