import { describe, expect, it } from 'vitest';

import { SubscriptionRoutingController } from '../../src/runtime/routing.ts';

function journal() {
  const records = [];
  return { records, events: () => records.map((item) => structuredClone(item)), append: async (item) => { records.push(structuredClone(item)); } };
}

const now = '2026-09-22T12:00:00.000Z';
const clock = { now: () => new Date(now) };
const policy = {
  policyRevision: 'routing@1', maxEvidenceAgeMs: 60_000,
  taskClasses: { routine: { routePreference: ['economic', 'senior'], allowUnknownEconomical: true }, planning: { routePreference: ['senior'] } },
  completionReserveByPool: { shared: 0 }, unknownEconomicalMaxActiveByPool: { shared: 1 },
};
const routes = [
  { routeId: 'economic', providerId: 'provider', accountPoolId: 'shared', model: 'economical-id', costTier: 'economical', taskClasses: ['routine'], capabilities: ['native'], subscriptionEligible: true, capabilityObservedAt: now, modelObservedAt: now },
  { routeId: 'senior', providerId: 'provider', accountPoolId: 'shared', model: 'senior-id', costTier: 'senior', taskClasses: ['routine', 'planning'], capabilities: ['native'], subscriptionEligible: true, capabilityObservedAt: now, modelObservedAt: now },
];
function request(id, attempt = 1, extra = {}) {
  return { workItemId: id, workItemRevision: `${id}@1`, role: 'builder', contextRevision: 'packet@1', attempt, taskClass: 'routine', requiredCapabilities: ['native'], requestedAt: now, ...extra };
}
function capacity(snapshotId = 'capacity@1', availableUnits = 1) {
  return [{ accountPoolId: 'shared', providerId: 'provider', nativeUnit: 'credits', snapshotId, availableUnits, limitUnits: 10, observedAt: now, source: 'provider-native', externalPressure: 'observed' }];
}

describe('subscription-aware routing', () => {
  it('blocks an exhausted fresh pool and bounds fresh capacity without a translatable estimate', async () => {
    const port = journal(); const controller = new SubscriptionRoutingController({ journal: port, clock });
    expect((await controller.admit(request('exhausted'), policy, routes, capacity('empty', 0))).decision.status).toBe('blocked');
    const first = await controller.admit(request('fresh-one'), policy, routes, capacity('fresh', 10));
    expect(first.decision.status).toBe('admitted');
    expect((await controller.admit(request('fresh-two'), policy, routes, capacity('fresh', 10))).decision).toMatchObject({ status: 'blocked', reason: 'untranslated_capacity_slot_limit_reached' });
    await controller.observeTerminal({ attemptId: first.decision.attemptId, outcome: 'completed' });
    expect((await controller.admit(request('fresh-three'), policy, routes, capacity('fresh', 10))).decision.status).toBe('admitted');
  });

  it('uses configured economical route and serializes two shared-pool admissions without duplicating a native reservation', async () => {
    const port = journal(); const controller = new SubscriptionRoutingController({ journal: port, clock });
    const first = controller.admit(request('one', 1, { nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } }), policy, routes, capacity());
    const second = controller.admit(request('two', 1, { nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } }), policy, routes, capacity());
    const [left, right] = await Promise.all([first, second]);
    expect(left.decision).toMatchObject({ status: 'admitted', routeId: 'economic', capacityFreshness: 'fresh', externalPressure: 'observed' });
    expect(right.decision).toMatchObject({ status: 'blocked', reason: 'completion_capacity_reserved' });
    expect(port.records.filter((event) => event.type === 'routing.admitted')).toHaveLength(1);
    expect(left.reservation).toMatchObject({ kind: 'native-estimate', nativeUnit: 'credits', units: 1, capacitySnapshotId: 'capacity@1' });
  });

  it('serializes an estimated admission behind an untranslatable slot hold and replays the block', async () => {
    const port = journal(); const controller = new SubscriptionRoutingController({ journal: port, clock });
    const first = await controller.admit(request('unestimated-first'), policy, routes, capacity('mixed@1', 10));
    expect(first.reservation).toMatchObject({ kind: 'concurrency-slot', status: 'held' });

    const estimated = request('estimated-second', 1, { nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } });
    const blocked = await controller.admit(estimated, policy, routes, capacity('mixed@1', 10));
    expect(blocked.decision).toMatchObject({ status: 'blocked', reason: 'untranslated_capacity_slot_limit_reached' });
    expect(await controller.admit(estimated, policy, routes, capacity('mixed@1', 10))).toMatchObject({ replayed: true, decision: blocked.decision });

    await controller.observeTerminal({ attemptId: first.decision.attemptId, outcome: 'completed' });
    expect((await controller.admit(request('estimated-after-terminal', 1, { nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } }), policy, routes, capacity('mixed@2', 10))).decision.status).toBe('admitted');
  });

  it('replays a durable admission, keeps uncertain capacity held, and stops subtracting it after a newer source snapshot', async () => {
    const port = journal(); const controller = new SubscriptionRoutingController({ journal: port, clock });
    const input = request('one', 1, { nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } });
    const first = await controller.admit(input, policy, routes, capacity());
    const replay = await controller.admit(input, policy, routes, capacity());
    expect(replay).toMatchObject({ replayed: true, decision: first.decision });
    expect(await controller.observeTerminal({ attemptId: first.decision.attemptId, outcome: 'interrupted_uncertain' })).toMatchObject({ status: 'uncertain' });
    expect(await controller.observeTerminal({ attemptId: first.decision.attemptId, outcome: 'completed' })).toMatchObject({ status: 'consumed' });
    const blocked = await controller.admit(request('two', 1, { nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } }), policy, routes, capacity());
    expect(blocked.decision.reason).toBe('completion_capacity_reserved');
    const later = await controller.admit(request('three', 1, { nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } }), policy, routes, capacity('capacity@2'));
    expect(later.decision.status).toBe('admitted');
  });

  it('allows only bounded economical work with unknown capacity and does not convert advisory tokens into native allowance', async () => {
    const port = journal(); const controller = new SubscriptionRoutingController({ journal: port, clock });
    const first = await controller.admit(request('one', 1, { advisoryEstimate: { value: 999999, unit: 'tokens' } }), policy, routes, []);
    expect(first).toMatchObject({ decision: { status: 'admitted', capacityFreshness: 'unknown', routeId: 'economic', advisoryEstimate: { value: 999999, unit: 'tokens' } }, reservation: { kind: 'concurrency-slot', nativeUnit: 'concurrency-slot', units: 1 } });
    const economicalOnly = { ...policy, taskClasses: { routine: { routePreference: ['economic'], allowUnknownEconomical: true } } };
    const second = await controller.admit(request('two'), economicalOnly, [routes[0]], []);
    expect(second.decision.reason).toBe('unknown_capacity_economical_limit_reached');
    const planning = await controller.admit(request('three', 1, { taskClass: 'planning' }), policy, routes, []);
    expect(planning.decision.reason).toBe('premium_capacity_requires_fresh_evidence');
  });

  it('releases a completed concurrency slot, but preserves an uncertain native hold across a newer unaccounted snapshot', async () => {
    const port = journal(); const controller = new SubscriptionRoutingController({ journal: port, clock });
    const first = await controller.admit(request('slot-one'), policy, routes, []);
    await controller.observeTerminal({ attemptId: first.decision.attemptId, outcome: 'completed' });
    const replacement = await controller.admit(request('slot-two'), policy, routes, []);
    expect(replacement.decision).toMatchObject({ status: 'admitted', routeId: 'economic', capacityFreshness: 'unknown' });
    await controller.observeTerminal({ attemptId: replacement.decision.attemptId, outcome: 'completed' });

    const held = await controller.admit(request('native-one', 1, { nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } }), policy, routes, capacity('capacity@1', 1));
    await controller.observeTerminal({ attemptId: held.decision.attemptId, outcome: 'interrupted_uncertain' });
    const newerUnaccounted = await controller.admit(request('native-two', 1, { nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } }), policy, routes,
      [{ ...capacity('capacity@2', 1)[0], availabilityAccounting: 'unknown' }]);
    expect(newerUnaccounted.decision).toMatchObject({ status: 'blocked', reason: 'completion_capacity_reserved' });
  });

  it('requires observable and translatable fresh capacity, and rejects future evidence', async () => {
    const port = journal(); const controller = new SubscriptionRoutingController({ journal: port, clock });
    const noAvailable = await controller.admit(request('senior', 1, { taskClass: 'planning' }), policy, routes,
      [{ ...capacity()[0], availableUnits: undefined }]);
    expect(noAvailable.decision).toMatchObject({ status: 'blocked', reason: 'fresh_capacity_not_observable' });

    const strict = await controller.admit(request('strict', 1), { ...policy, strictBudget: true, taskClasses: { routine: { routePreference: ['economic'] } } }, [routes[0]], capacity());
    expect(strict.decision).toMatchObject({ status: 'blocked', reason: 'strict_budget_native_capacity_estimate_required' });

    const economicalOnly = { ...policy, taskClasses: { routine: { routePreference: ['economic'] } } };
    const futureRoute = { ...routes[0], capabilityObservedAt: '2026-09-22T12:01:00.000Z' };
    const future = await controller.admit(request('future'), economicalOnly, [futureRoute], capacity());
    expect(future.decision).toMatchObject({ status: 'blocked', reason: 'route_capability_evidence_future_or_invalid' });
    const futureObservation = await controller.admit(request('future-capacity'), economicalOnly, [routes[0]], [{ ...capacity()[0], observedAt: '2026-09-22T12:01:00.000Z' }]);
    expect(futureObservation.decision).toMatchObject({ status: 'blocked', reason: 'capacity_observation_future' });
  });

  it('uses owner allowance for an unfresh senior route and lets a completion class consume reserved capacity', async () => {
    const port = journal(); const controller = new SubscriptionRoutingController({ journal: port, clock });
    const seniorOnly = { ...policy, taskClasses: { planning: { routePreference: ['senior'] } } };
    const explicitlyAllowed = await controller.admit(request('allowed-senior', 1, { taskClass: 'planning', explicitCapacityAllowance: { authorityRevision: 'owner@1', units: 1 } }), seniorOnly, [routes[1]], []);
    expect(explicitlyAllowed.decision).toMatchObject({ status: 'admitted', routeId: 'senior', capacityFreshness: 'unknown' });
    await controller.observeTerminal({ attemptId: explicitlyAllowed.decision.attemptId, outcome: 'completed' });

    const reservePolicy = { ...policy, completionReserveByPool: { shared: 1 }, taskClasses: {
      routine: { routePreference: ['economic'], usesCompletionReserve: true },
      review: { routePreference: ['senior'], usesCompletionReserve: false },
    } };
    const build = await controller.admit(request('new-build', 1, { nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } }), reservePolicy, [routes[0]], capacity('reserve@1', 1));
    expect(build.decision).toMatchObject({ status: 'blocked', reason: 'completion_capacity_reserved' });
    const review = await controller.admit(request('review', 1, { taskClass: 'review', nativeCapacityEstimate: { value: 1, nativeUnit: 'credits' } }), reservePolicy,
      [{ ...routes[1], taskClasses: ['review'] }], capacity('reserve@1', 1));
    expect(review.decision).toMatchObject({ status: 'admitted', routeId: 'senior' });
  });

  it('never sends a paid route without explicit route authority', async () => {
    const port = journal(); const controller = new SubscriptionRoutingController({ journal: port, clock });
    const paid = [{ ...routes[0], routeId: 'paid', model: 'configured-paid-id', costTier: 'paid' }];
    const paidPolicy = { ...policy, allowPaidRoutes: true, taskClasses: { routine: { routePreference: ['paid'] } } };
    const result = await controller.admit(request('paid'), paidPolicy, paid, capacity());
    expect(result.decision).toMatchObject({ status: 'blocked', reason: 'paid_route_requires_explicit_authority' });
  });
});
