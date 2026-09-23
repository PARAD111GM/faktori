import { describe, expect, it } from 'vitest';

import { RoleQueueController } from '../../src/workflow/index.ts';

const now = '2026-09-22T12:00:00.000Z';

function policy(builderWip = 3) {
  return {
    format: 'faktori.role-queue-policy/v1', revision: 'queues@1', stages: [
      { stageId: 'needs_specification', role: 'planner', statusIds: ['spec'], entryGuards: [], maxWip: 1 },
      { stageId: 'ready_to_build', role: 'builder', statusIds: ['build'], entryGuards: ['approved-spec'], maxWip: builderWip },
      { stageId: 'ready_for_review', role: 'reviewer', statusIds: ['review'], entryGuards: ['candidate'], maxWip: 1 },
      { stageId: 'human_review', role: 'human', statusIds: ['human'], entryGuards: ['review'], maxWip: 1 },
      { stageId: 'ready_to_release', role: 'release', statusIds: ['release'], entryGuards: ['human-accepted'], maxWip: 1 },
      { stageId: 'staging_acceptance', role: 'acceptance', statusIds: ['staging'], entryGuards: ['deployment'], maxWip: 1 },
      { stageId: 'done', role: 'acceptance', statusIds: ['done'], entryGuards: ['accepted'], maxWip: 0 },
    ],
  };
}

function snapshot(overrides = {}) {
  const candidate = {
    workItemId: 'work-1', executionScope: 'faktori-test-project', trackerStatusId: 'build', revision: 'candidate@1', rank: 4,
    queuedAt: '2026-09-20T12:00:00.000Z', dependencies: [], entryEvidence: [{ guardId: 'approved-spec', revision: 'candidate@1', observedAt: now }],
    runtime: { workItemId: 'runtime-work-1', runId: 'run-1' },
  };
  return {
    format: 'faktori.role-queue-source/v1', revision: 'source@1', candidates: [candidate],
    readiness: { authorityRevision: 'readiness@1', observedAt: now, automatic: { ready: true, blockers: [] }, transport: { ready: true, blockers: [] }, witness: { ready: true, blockers: [] } },
    ...overrides,
  };
}

function fixture(initial = snapshot(), builderWip = 3, clock = () => new Date(now)) {
  let current = structuredClone(initial);
  const events = [];
  const launches = [];
  const controller = new RoleQueueController({
    policy: policy(builderWip), source: { observe: async () => structuredClone(current) },
    journal: { events: () => structuredClone(events), append: async (event) => { events.push(structuredClone(event)); } },
    executor: {
      launch: async (assignment) => { launches.push(assignment); return { status: 'running', workerId: `worker-${assignment.attempt}` }; },
      inspect: async () => ({ status: 'unknown', reason: 'transport did not return a durable receipt' }),
    },
    now: clock, eventId: (() => { let id = 0; return () => `event-${++id}`; })(),
  });
  return { controller, events, launches, set(value) { current = structuredClone(value); } };
}

describe('role queue controller', () => {
  it('expires cached readiness and rejects future attestations without launching work', async () => {
    let time = Date.parse(now);
    const state = fixture(snapshot(), 3, () => new Date(time));
    const options = { mode: 'automatic', excludedScopes: ['faktori-test-project'] };
    await state.controller.evaluate(options);
    time += 120_000;
    const expired = await state.controller.evaluate(options);
    expect(expired.changed).toBe(true);
    expect(expired.blockers).toContainEqual(expect.objectContaining({ code: 'automatic_readiness_stale_or_future' }));
    expect(state.launches).toEqual([]);
    const future = snapshot();
    future.readiness.observedAt = new Date(time + 1).toISOString();
    state.set(future);
    expect((await state.controller.evaluate({ mode: 'automatic' })).blockers).toContainEqual(expect.objectContaining({ code: 'automatic_readiness_stale_or_future' }));
    expect(state.events).toEqual([]);
    future.readiness.observedAt = new Date(time).toISOString();
    state.set(future);
    expect((await state.controller.evaluate({ mode: 'automatic' })).launches).toHaveLength(1);
  });

  it('does not let completed tickets consume downstream WIP', async () => {
    const initial = snapshot();
    initial.candidates.push({ ...initial.candidates[0], workItemId: 'done-work', trackerStatusId: 'done',
      runtime: { workItemId: 'done-runtime', runId: 'done-run' }, entryEvidence: [{ guardId: 'accepted', revision: 'candidate@1', observedAt: now }] });
    const state = fixture(initial);
    expect((await state.controller.evaluate({ mode: 'attended' })).launches.map(item => item.workItemId)).toEqual(['work-1']);
  });

  it('holds disappeared, changed and uncertain workers until observed terminal, including shared-file ownership', async () => {
    const initial = snapshot(); initial.candidates[0].sharedFileKey = 'integration-files';
    const state = fixture(initial, 1);
    const first = await state.controller.evaluate({ mode: 'attended' });
    const original = first.launches[0];
    const replacement = { ...initial.candidates[0], revision: 'candidate@2', runtime: { workItemId: 'replacement', runId: 'replacement-run' }, entryEvidence: [{ guardId: 'approved-spec', revision: 'candidate@2', observedAt: now }] };
    state.set(snapshot({ revision: 'source@2', candidates: [replacement] }));
    expect((await state.controller.evaluate({ mode: 'attended' })).blockers).toContainEqual(expect.objectContaining({ code: 'prior_worker_requires_reconciliation' }));
    await state.controller.reconcile(); // Unknown process is not a dead process.
    state.set(snapshot({ revision: 'source@3', candidates: [{ ...replacement, workItemId: 'another-work' }] }));
    expect((await state.controller.evaluate({ mode: 'attended' })).launches).toEqual([]);
    expect(state.launches).toHaveLength(1);
    // A trusted execution observation releases capacity without accepting a stale ticket callback.
    state.events.push({ format: 'faktori.workflow-event/v1', eventId: 'terminal-observation', occurredAt: now,
      kind: 'launch_observed', data: { assignmentId: original.assignmentId, observation: { status: 'completed' } } });
    expect((await state.controller.evaluate({ mode: 'attended' })).launches.map(item => item.workItemId)).toEqual(['another-work']);
  });

  it('atomically claims ranked dependency-ready work, persists intent before launch, and skips an unchanged poll', async () => {
    const { controller, events, launches } = fixture();
    const [first, duplicate] = await Promise.all([controller.evaluate({ mode: 'automatic' }), controller.evaluate({ mode: 'automatic' })]);

    expect(first.launches).toHaveLength(1);
    expect(duplicate).toMatchObject({ changed: false, launches: [] });
    expect(launches).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual(['claim', 'launch_intended', 'launch_observed']);
    expect(events[1].data.assignmentId).toBe(events[0].data.assignment.assignmentId);
  });

  it('does not cache shadow mode as attended work and frees a completed builder slot for unchanged-source replacement work', async () => {
    const state = fixture(snapshot(), 1);
    expect((await state.controller.evaluate({ mode: 'shadow' })).launches).toEqual([]);
    const attended = await state.controller.evaluate({ mode: 'attended' });
    expect(attended.launches).toHaveLength(1);
    const first = attended.launches[0];
    expect(await state.controller.recordReceipt({ assignmentId: first.assignmentId, candidateRevision: 'candidate@1', sequence: 1, status: 'completed', evidenceRevision: 'candidate@1' })).toEqual({ applied: true });
    state.set(snapshot({ candidates: [snapshot().candidates[0], {
      ...snapshot().candidates[0], workItemId: 'work-2', revision: 'candidate@2', rank: 2, queuedAt: '2026-09-21T12:00:00.000Z',
      entryEvidence: [{ guardId: 'approved-spec', revision: 'candidate@2', observedAt: now }], runtime: { workItemId: 'runtime-work-2', runId: 'run-2' },
    }] }));
    const replacement = await state.controller.evaluate({ mode: 'attended' });
    expect(replacement.launches).toHaveLength(1);
    expect(replacement.launches[0].workItemId).toBe('work-2');
  });

  it('hard-caps a builder stage at three workers', () => {
    expect(() => fixture(snapshot(), 4)).toThrow('role_queue_builder_wip_limit_exceeded');
  });

  it('requires source-attested automatic readiness and excludes a legacy-owned execution scope', async () => {
    const unavailable = snapshot({ revision: 'source@unready', readiness: { authorityRevision: 'readiness@2', observedAt: now, automatic: { ready: false, blockers: ['owner policy disabled'] }, transport: { ready: false, blockers: ['goal bridge missing'] }, witness: { ready: false, blockers: ['no connected receipt'] } } });
    const blocked = fixture(unavailable);
    const result = await blocked.controller.evaluate({ mode: 'automatic' });
    expect(result.launches).toEqual([]);
    expect(result.blockers.map((item) => item.code)).toEqual(expect.arrayContaining(['automatic_automatic_capability_missing', 'automatic_transport_capability_missing', 'automatic_witness_capability_missing']));

    const owned = fixture(snapshot({ revision: 'source@owned' }));
    const excluded = await owned.controller.evaluate({ mode: 'attended', excludedScopes: ['faktori-test-project'] });
    expect(excluded.launches).toEqual([]);
    expect(excluded.blockers).toContainEqual(expect.objectContaining({ code: 'execution_scope_owned_by_legacy_dispatch' }));
  });

  it('rejects stale and out-of-order worker callbacks, then creates a new stage assignment from current evidence', async () => {
    const state = fixture();
    const first = await state.controller.evaluate({ mode: 'attended' });
    const assignment = first.launches[0];
    expect(await state.controller.recordReceipt({ assignmentId: assignment.assignmentId, candidateRevision: 'candidate@old', sequence: 1, status: 'completed', evidenceRevision: 'candidate@old' })).toEqual({ applied: false, reason: 'stale_candidate_revision' });
    state.set(snapshot({ revision: 'source@stale-stage', candidates: [{
      ...snapshot().candidates[0], trackerStatusId: 'review', entryEvidence: [{ guardId: 'candidate', revision: 'candidate@1', observedAt: now }],
    }] }));
    expect(await state.controller.recordReceipt({ assignmentId: assignment.assignmentId, candidateRevision: 'candidate@1', sequence: 1, status: 'completed', evidenceRevision: 'candidate@1' })).toEqual({ applied: false, reason: 'receipt_not_current_authority_state' });
    state.set(snapshot({ revision: 'source@build-current' }));
    expect(await state.controller.recordReceipt({ assignmentId: assignment.assignmentId, candidateRevision: 'candidate@1', sequence: 2, status: 'completed', evidenceRevision: 'candidate@1' })).toEqual({ applied: true });
    expect(await state.controller.recordReceipt({ assignmentId: assignment.assignmentId, candidateRevision: 'candidate@1', sequence: 1, status: 'failed', evidenceRevision: 'candidate@1' })).toEqual({ applied: false, reason: 'duplicate_or_out_of_order_receipt' });

    state.set(snapshot({ revision: 'source@2', candidates: [{
      ...snapshot().candidates[0], trackerStatusId: 'review', entryEvidence: [{ guardId: 'candidate', revision: 'candidate@1', observedAt: now }],
    }] }));
    const review = await state.controller.evaluate({ mode: 'automatic' });
    expect(review.launches).toHaveLength(1);
    expect(review.launches[0]).toMatchObject({ stageId: 'ready_for_review', role: 'reviewer', attempt: 2 });
  });

  it('reconciles an interrupted launch intent as uncertain and never starts a duplicate worker', async () => {
    const state = fixture();
    const assignment = { assignmentId: 'queue-recovered', operationId: 'queue-launch-recovered', workItemId: 'work-1', executionScope: 'faktori-test-project', stageId: 'ready_to_build', role: 'builder', attempt: 1, candidateRevision: 'candidate@1', sourceRevision: 'source@1', policyRevision: 'queues@1', runtime: { workItemId: 'runtime-work-1', runId: 'run-1' } };
    state.events.push(
      { format: 'faktori.workflow-event/v1', eventId: 'claim', occurredAt: now, kind: 'claim', data: { assignment } },
      { format: 'faktori.workflow-event/v1', eventId: 'intent', occurredAt: now, kind: 'launch_intended', data: { assignmentId: assignment.assignmentId, operationId: assignment.operationId, assignment } },
    );

    const blockers = await state.controller.reconcile();
    expect(blockers).toContainEqual(expect.objectContaining({ code: 'launch_reconciled_without_relaunch' }));
    expect(state.launches).toEqual([]);
    expect(state.events.at(-1)).toMatchObject({ kind: 'launch_observed', data: { observation: { status: 'uncertain' } } });
  });
});
