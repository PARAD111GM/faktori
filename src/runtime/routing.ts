import { createHash } from 'node:crypto';

export type CostTier = 'economical' | 'senior' | 'paid';
export type CapacityFreshness = 'fresh' | 'stale' | 'unknown';
export type ExternalAccountPressure = 'none' | 'observed' | 'unknown';
export type RouteAdmissionStatus = 'admitted' | 'blocked';
export type ReservationTerminalStatus = 'consumed' | 'released' | 'uncertain';

/** A deliberately small journal seam. The coordinator adapter belongs to the composition root. */
export interface RoutingJournalPort {
  events(): readonly RoutingEvent[];
  append(record: RoutingEvent): Promise<void>;
}

export interface RouteTaskClassPolicy {
  /** Ordered, configured route ids. This evaluator never invents a model choice. */
  routePreference: string[];
  /** Stale/unknown account data can only use an explicitly economical fallback. */
  allowUnknownEconomical?: boolean;
  /** New work leaves configured completion headroom; completion/review classes opt out explicitly. */
  usesCompletionReserve?: boolean;
}

export interface RoutingPolicy {
  policyRevision: string;
  taskClasses: Record<string, RouteTaskClassPolicy>;
  completionReserveByPool?: Record<string, number>;
  unknownEconomicalMaxActiveByPool?: Record<string, number>;
  /** Provider-native threshold, only used where the pool unit is known. */
  minimumFreshAvailableUnitsByPool?: Record<string, number>;
  strictBudget?: boolean;
  /** Capability/model evidence older than this is stale rather than silently trusted. */
  maxEvidenceAgeMs: number;
  /** Paid routes remain off unless this and request-specific authority both permit them. */
  allowPaidRoutes?: boolean;
}

export interface RouteCandidate {
  routeId: string;
  providerId: string;
  accountPoolId: string;
  model: string;
  costTier: CostTier;
  taskClasses: string[];
  capabilities: string[];
  subscriptionEligible: boolean;
  capabilityObservedAt: string;
  modelObservedAt: string;
}

/** Provider-native capacity. Percentages and token guesses are intentionally absent. */
export interface CapacityObservation {
  accountPoolId: string;
  providerId: string;
  nativeUnit: string;
  /** A new reading may already include prior consumption; never subtract it twice. */
  snapshotId: string;
  limitUnits?: number;
  availableUnits?: number;
  resetAt?: string;
  observedAt: string;
  source: string;
  availabilityAccounting?: 'includes_active_faktori_reservations' | 'excludes_active_faktori_reservations' | 'unknown';
  externalPressure?: ExternalAccountPressure;
}

export interface RoutingRequest {
  /** Durable execution identity, used to reconcile terminal receipts after a restart. */
  runId?: string;
  workItemId: string;
  workItemRevision: string;
  role: string;
  contextRevision: string;
  attempt: number;
  taskClass: string;
  requiredCapabilities: string[];
  requestedAt: string;
  priority?: number;
  /** Explicit owner allowance for a premium route with non-fresh capacity. */
  explicitCapacityAllowance?: { authorityRevision: string; units: number };
  /** Explicit authority is required even when policy permits paid routing. */
  paidAuthority?: { authorityRevision: string; routeIds: string[] };
  /** Informational only. It is never converted into a native allowance debit. */
  advisoryEstimate?: { value: number; unit: string };
  /** Present only where task cost and the observed native unit are actually comparable. */
  nativeCapacityEstimate?: { value: number; nativeUnit: string };
}

export interface RouteReservation {
  reservationId: string;
  attemptId: string;
  accountPoolId: string;
  nativeUnit: string;
  units: number;
  kind: 'native-estimate' | 'concurrency-slot';
  capacitySnapshotId?: string;
  status: 'held' | ReservationTerminalStatus;
}

export interface RouteDecision {
  status: RouteAdmissionStatus;
  reason: string;
  attemptId: string;
  reservationId?: string;
  routeId?: string;
  providerId?: string;
  accountPoolId?: string;
  model?: string;
  capacityFreshness: CapacityFreshness;
  nativeUnit?: string;
  externalPressure?: ExternalAccountPressure;
  advisoryEstimate?: RoutingRequest['advisoryEstimate'];
}

export type RoutingEvent =
  | { format: 'faktori.routing-event/v1'; type: 'routing.admitted'; eventId: string; occurredAt: string; attemptId: string; request: RoutingRequest; decision: RouteDecision; reservation: RouteReservation }
  | { format: 'faktori.routing-event/v1'; type: 'routing.blocked'; eventId: string; occurredAt: string; attemptId: string; request: RoutingRequest; decision: RouteDecision }
  | { format: 'faktori.routing-event/v1'; type: 'routing.reservation-terminal'; eventId: string; occurredAt: string; attemptId: string; reservationId: string; outcome: string; status: ReservationTerminalStatus };

export interface RoutingAdmissionResult {
  decision: RouteDecision;
  reservation?: RouteReservation;
  replayed: boolean;
}

export interface RoutingClock { now(): Date; }

const SYSTEM_CLOCK: RoutingClock = { now: () => new Date() };

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function identifier(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice(0, 32)}`;
}

function validNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > 256) throw new Error(`${name}_invalid`);
}

function parseTime(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validUnits(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function validateRequest(request: RoutingRequest): void {
  if (request.runId !== undefined) validNonEmpty(request.runId, 'run_id');
  for (const [name, value] of Object.entries({ workItemId: request.workItemId, workItemRevision: request.workItemRevision, role: request.role, contextRevision: request.contextRevision, taskClass: request.taskClass, requestedAt: request.requestedAt })) validNonEmpty(value, name);
  if (!Number.isSafeInteger(request.attempt) || request.attempt < 1) throw new Error('attempt_invalid');
  if (!Array.isArray(request.requiredCapabilities) || request.requiredCapabilities.some((value) => typeof value !== 'string' || value.length === 0)) throw new Error('required_capabilities_invalid');
  if (parseTime(request.requestedAt) === undefined) throw new Error('requested_at_invalid');
  if (request.priority !== undefined && (!Number.isSafeInteger(request.priority) || request.priority < 0 || request.priority > 100)) throw new Error('priority_invalid');
  if (request.explicitCapacityAllowance !== undefined) {
    validNonEmpty(request.explicitCapacityAllowance.authorityRevision, 'allowance_authority');
    if (!Number.isSafeInteger(request.explicitCapacityAllowance.units) || request.explicitCapacityAllowance.units < 1) throw new Error('explicit_capacity_allowance_invalid');
  }
  if (request.advisoryEstimate !== undefined && (!Number.isFinite(request.advisoryEstimate.value) || request.advisoryEstimate.value < 0 || request.advisoryEstimate.unit.trim().length === 0)) throw new Error('advisory_estimate_invalid');
  if (request.nativeCapacityEstimate !== undefined && (!Number.isSafeInteger(request.nativeCapacityEstimate.value) || request.nativeCapacityEstimate.value < 1 || request.nativeCapacityEstimate.nativeUnit.trim().length === 0)) throw new Error('native_capacity_estimate_invalid');
}

function validatePolicy(policy: RoutingPolicy): void {
  validNonEmpty(policy.policyRevision, 'policy_revision');
  if (!Number.isSafeInteger(policy.maxEvidenceAgeMs) || policy.maxEvidenceAgeMs < 0) throw new Error('max_evidence_age_invalid');
  for (const [name, value] of Object.entries(policy.taskClasses)) {
    validNonEmpty(name, 'task_class');
    if (!Array.isArray(value.routePreference) || value.routePreference.length === 0 || value.routePreference.some((routeId) => typeof routeId !== 'string' || routeId.length === 0)) throw new Error(`task_class_${name}_route_preference_invalid`);
    if (value.usesCompletionReserve !== undefined && typeof value.usesCompletionReserve !== 'boolean') throw new Error(`task_class_${name}_completion_reserve_invalid`);
  }
  for (const units of [...Object.values(policy.completionReserveByPool ?? {}), ...Object.values(policy.unknownEconomicalMaxActiveByPool ?? {}), ...Object.values(policy.minimumFreshAvailableUnitsByPool ?? {})]) if (!validUnits(units)) throw new Error('routing_capacity_policy_invalid');
}

function observationFor(route: RouteCandidate, observations: readonly CapacityObservation[]): CapacityObservation | undefined {
  const matching = observations.filter((candidate) => candidate.accountPoolId === route.accountPoolId && candidate.providerId === route.providerId)
    .sort((left, right) => (parseTime(right.observedAt) ?? -Infinity) - (parseTime(left.observedAt) ?? -Infinity));
  return matching[0];
}

function freshness(observation: CapacityObservation | undefined, now: number, maxAge: number): CapacityFreshness {
  if (observation === undefined) return 'unknown';
  const observedAt = parseTime(observation.observedAt);
  if (observedAt === undefined || now - observedAt > maxAge) return 'stale';
  if (observation.resetAt !== undefined && (parseTime(observation.resetAt) ?? -Infinity) <= now) return 'stale';
  return 'fresh';
}

function isActive(event: RoutingEvent): event is Extract<RoutingEvent, { type: 'routing.admitted' }> {
  return event.type === 'routing.admitted';
}

function isDecision(event: RoutingEvent): event is Extract<RoutingEvent, { type: 'routing.admitted' | 'routing.blocked' }> {
  return event.type === 'routing.admitted' || event.type === 'routing.blocked';
}

function reservationStatus(events: readonly RoutingEvent[], attemptId: string): RouteReservation['status'] | undefined {
  const admission = events.find((event): event is Extract<RoutingEvent, { type: 'routing.admitted' }> => event.type === 'routing.admitted' && event.attemptId === attemptId);
  if (admission === undefined) return undefined;
  const terminal = events.filter((event): event is Extract<RoutingEvent, { type: 'routing.reservation-terminal' }> => event.type === 'routing.reservation-terminal' && event.attemptId === attemptId).at(-1);
  return terminal?.status ?? admission.reservation.status;
}

function activeReservations(events: readonly RoutingEvent[], poolId: string): RouteReservation[] {
  return events.filter(isActive)
    .filter((event) => event.reservation.accountPoolId === poolId)
    // A concurrency slot is released at a known terminal outcome. Consumed
    // native estimates are accounted only against the identical source snapshot
    // below; retaining a finished slot would permanently starve unfresh work.
    .filter((event) => ['held', 'uncertain'].includes(reservationStatus(events, event.attemptId) ?? 'held'))
    .map((event) => event.reservation);
}

function sameSnapshotConsumedNativeReservations(events: readonly RoutingEvent[], poolId: string, nativeUnit: string, snapshotId: string): RouteReservation[] {
  return events.filter(isActive)
    .filter((event) => event.reservation.accountPoolId === poolId && event.reservation.kind === 'native-estimate'
      && event.reservation.nativeUnit === nativeUnit && event.reservation.capacitySnapshotId === snapshotId)
    .filter((event) => reservationStatus(events, event.attemptId) === 'consumed')
    .map((event) => event.reservation);
}

/**
 * Deterministic, local admission policy. It makes no provider call and records
 * only native-unit/slot holds, preserving uncertainty for composition to show.
 */
export class SubscriptionRoutingController {
  readonly #journal: RoutingJournalPort;
  readonly #clock: RoutingClock;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: { journal: RoutingJournalPort; clock?: RoutingClock }) {
    this.#journal = options.journal;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
  }

  admit(request: RoutingRequest, policy: RoutingPolicy, candidates: readonly RouteCandidate[], observations: readonly CapacityObservation[]): Promise<RoutingAdmissionResult> {
    const work = async (): Promise<RoutingAdmissionResult> => this.admitExclusive(request, policy, candidates, observations);
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  observeTerminal(input: { attemptId: string; outcome: string }): Promise<RouteReservation | undefined> {
    const work = async (): Promise<RouteReservation | undefined> => {
      validNonEmpty(input.attemptId, 'attempt_id');
      validNonEmpty(input.outcome, 'outcome');
      const events = this.#journal.events();
      const admission = events.find((event): event is Extract<RoutingEvent, { type: 'routing.admitted' }> => event.type === 'routing.admitted' && event.attemptId === input.attemptId);
      if (admission === undefined) return undefined;
      const current = reservationStatus(events, input.attemptId);
      // An uncertain worker can later provide an actual terminal receipt. It
      // remains held until then, but that receipt is allowed to reconcile it.
      if (current !== 'held' && !(current === 'uncertain' && input.outcome !== 'interrupted_uncertain' && input.outcome !== 'unavailable')) return { ...admission.reservation, status: current ?? admission.reservation.status };
      const status: ReservationTerminalStatus = input.outcome === 'interrupted_uncertain' || input.outcome === 'unavailable'
        ? 'uncertain'
        : input.outcome === 'denied' || input.outcome === 'authentication_required' || input.outcome === 'cancelled'
          ? 'released'
          : 'consumed';
      await this.#journal.append({ format: 'faktori.routing-event/v1', type: 'routing.reservation-terminal', eventId: identifier('routing_terminal', { attemptId: input.attemptId, outcome: input.outcome, status }), occurredAt: this.#clock.now().toISOString(), attemptId: input.attemptId, reservationId: admission.reservation.reservationId, outcome: input.outcome, status });
      return { ...admission.reservation, status };
    };
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  private async admitExclusive(request: RoutingRequest, policy: RoutingPolicy, candidates: readonly RouteCandidate[], observations: readonly CapacityObservation[]): Promise<RoutingAdmissionResult> {
    validateRequest(request); validatePolicy(policy);
    const attemptId = identifier('routing_attempt', { runId: request.runId, workItemId: request.workItemId, workItemRevision: request.workItemRevision, role: request.role, contextRevision: request.contextRevision, attempt: request.attempt, policyRevision: policy.policyRevision });
    const events = this.#journal.events();
    const prior = events.filter(isDecision).find((event) => event.attemptId === attemptId);
    if (prior !== undefined) {
      if (stable(prior.request) !== stable(request)) throw new Error('routing_attempt_identity_conflict');
      return prior.type === 'routing.admitted' ? { decision: prior.decision, reservation: { ...prior.reservation, status: reservationStatus(events, attemptId) ?? prior.reservation.status }, replayed: true } : { decision: prior.decision, replayed: true };
    }
    const classPolicy = policy.taskClasses[request.taskClass];
    if (classPolicy === undefined) return this.block(request, attemptId, 'task_class_not_configured', 'unknown');
    const now = this.#clock.now().getTime();
    const byId = new Map(candidates.map((candidate) => [candidate.routeId, candidate]));
    let blockedReason = 'no_qualified_configured_route';
    let lastFreshness: CapacityFreshness = 'unknown';
    for (const routeId of classPolicy.routePreference) {
      const route = byId.get(routeId);
      if (route === undefined || !route.taskClasses.includes(request.taskClass) || !route.subscriptionEligible || !request.requiredCapabilities.every((capability) => route.capabilities.includes(capability))) { blockedReason = 'route_capability_or_subscription_unavailable'; continue; }
      const capabilityObservedAt = parseTime(route.capabilityObservedAt);
      const modelObservedAt = parseTime(route.modelObservedAt);
      if (capabilityObservedAt === undefined || modelObservedAt === undefined || capabilityObservedAt > now || modelObservedAt > now) { blockedReason = 'route_capability_evidence_future_or_invalid'; continue; }
      if (now - capabilityObservedAt > policy.maxEvidenceAgeMs || now - modelObservedAt > policy.maxEvidenceAgeMs) { blockedReason = 'route_capability_evidence_stale'; continue; }
      if (route.costTier === 'paid' && (!policy.allowPaidRoutes || request.paidAuthority === undefined || !request.paidAuthority.routeIds.includes(route.routeId))) { blockedReason = 'paid_route_requires_explicit_authority'; continue; }
      const observation = observationFor(route, observations);
      if (observation !== undefined) {
        validNonEmpty(observation.nativeUnit, 'native_unit'); validNonEmpty(observation.snapshotId, 'capacity_snapshot_id');
        if (!validUnits(observation.limitUnits) || !validUnits(observation.availableUnits) || parseTime(observation.observedAt) === undefined) throw new Error('capacity_observation_invalid');
        if ((parseTime(observation.observedAt) ?? Infinity) > now) { blockedReason = 'capacity_observation_future'; continue; }
      }
      const capacity = freshness(observation, now, policy.maxEvidenceAgeMs);
      lastFreshness = capacity;
      const pressure = observation?.externalPressure ?? 'unknown';
      const active = activeReservations(events, route.accountPoolId);
      const explicitAllowance = request.explicitCapacityAllowance?.units ?? 0;
      if (capacity === 'fresh') {
        const estimate = request.nativeCapacityEstimate;
        if (observation?.availableUnits === undefined) { blockedReason = 'fresh_capacity_not_observable'; continue; }
        if (policy.strictBudget && estimate === undefined) { blockedReason = 'strict_budget_native_capacity_estimate_required'; continue; }
        if (policy.strictBudget && !route.capabilities.includes('strict-native-budget')) { blockedReason = 'strict_budget_enforcement_unavailable'; continue; }
        if (policy.strictBudget && observation.availabilityAccounting !== 'includes_active_faktori_reservations' && active.some(reservation => reservation.kind !== 'native-estimate' || reservation.nativeUnit !== estimate?.nativeUnit)) { blockedReason = 'strict_budget_active_consumption_unknown'; continue; }
        if (estimate !== undefined && estimate.nativeUnit !== observation?.nativeUnit) { blockedReason = 'native_capacity_unit_mismatch'; continue; }
        if (estimate !== undefined) {
          const reserve = classPolicy.usesCompletionReserve === false ? 0 : policy.completionReserveByPool?.[route.accountPoolId] ?? 0;
          // Newer observations cannot be assumed to include still-active work.
          // Only an explicit provider accounting declaration may suppress that
          // debit. Finished consumption is retained solely for the identical
          // snapshot, whose availability cannot have incorporated it yet.
          const activeNative = active.filter((reservation) => reservation.kind === 'native-estimate' && reservation.nativeUnit === estimate.nativeUnit);
          const pendingNative = (observation.availabilityAccounting === 'includes_active_faktori_reservations' ? [] : activeNative)
            .concat(sameSnapshotConsumedNativeReservations(events, route.accountPoolId, estimate.nativeUnit, observation.snapshotId))
            .reduce((sum, reservation) => sum + reservation.units, 0);
          if (observation.availableUnits - pendingNative - reserve + explicitAllowance < estimate.value) { blockedReason = 'completion_capacity_reserved'; continue; }
        } else {
          const reserve = classPolicy.usesCompletionReserve === false ? 0 : policy.completionReserveByPool?.[route.accountPoolId] ?? 0;
          if (observation.availableUnits <= reserve || observation.availableUnits < (policy.minimumFreshAvailableUnitsByPool?.[route.accountPoolId] ?? 0)) {
            blockedReason = 'fresh_capacity_below_configured_threshold'; continue;
          }
          // A fresh percentage/credit reading is not a task-cost estimate.
          // Bound untranslatable work by slots even with fresh observations.
          const limit = policy.unknownEconomicalMaxActiveByPool?.[route.accountPoolId] ?? 1;
          if (active.length >= limit) { blockedReason = 'untranslated_capacity_slot_limit_reached'; continue; }
        }
      } else {
        if (policy.strictBudget) { blockedReason = 'strict_budget_capacity_not_fresh'; continue; }
        if (explicitAllowance === 0) {
          if (route.costTier !== 'economical' || classPolicy.allowUnknownEconomical !== true) { blockedReason = 'premium_capacity_requires_fresh_evidence'; continue; }
          const limit = policy.unknownEconomicalMaxActiveByPool?.[route.accountPoolId] ?? 0;
          if (active.length >= limit) { blockedReason = 'unknown_capacity_economical_limit_reached'; continue; }
        }
      }
      const estimated = request.nativeCapacityEstimate;
      const nativeUnit = estimated?.nativeUnit ?? 'concurrency-slot';
      const reservation: RouteReservation = { reservationId: identifier('routing_reservation', { attemptId, accountPoolId: route.accountPoolId, nativeUnit }), attemptId, accountPoolId: route.accountPoolId, nativeUnit, units: estimated?.value ?? 1, kind: estimated === undefined ? 'concurrency-slot' : 'native-estimate', ...(estimated === undefined || observation === undefined ? {} : { capacitySnapshotId: observation.snapshotId }), status: 'held' };
      const decision: RouteDecision = { status: 'admitted', reason: capacity === 'fresh' ? 'configured_qualified_route_with_capacity' : explicitAllowance > 0 ? 'explicit_owner_allowance_under_unfresh_capacity' : 'bounded_economical_fallback_under_unfresh_capacity', attemptId, reservationId: reservation.reservationId, routeId: route.routeId, providerId: route.providerId, accountPoolId: route.accountPoolId, model: route.model, capacityFreshness: capacity, nativeUnit, externalPressure: pressure, ...(request.advisoryEstimate === undefined ? {} : { advisoryEstimate: request.advisoryEstimate }) };
      await this.#journal.append({ format: 'faktori.routing-event/v1', type: 'routing.admitted', eventId: identifier('routing_admitted', { attemptId, decision, reservation }), occurredAt: this.#clock.now().toISOString(), attemptId, request, decision, reservation });
      return { decision, reservation, replayed: false };
    }
    return this.block(request, attemptId, blockedReason, lastFreshness);
  }

  private async block(request: RoutingRequest, attemptId: string, reason: string, capacityFreshness: CapacityFreshness): Promise<RoutingAdmissionResult> {
    const decision: RouteDecision = { status: 'blocked', reason, attemptId, capacityFreshness, ...(request.advisoryEstimate === undefined ? {} : { advisoryEstimate: request.advisoryEstimate }) };
    await this.#journal.append({ format: 'faktori.routing-event/v1', type: 'routing.blocked', eventId: identifier('routing_blocked', { attemptId, reason }), occurredAt: this.#clock.now().toISOString(), attemptId, request, decision });
    return { decision, replayed: false };
  }
}
