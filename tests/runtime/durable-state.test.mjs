import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DurableCoordinator } from '../../src/runtime/coordinator.ts';
import {
  AppendOnlyJournal,
  JournalCorruptionError,
  JournalDuplicateConflictError,
} from '../../src/runtime/journal.ts';
import { RuntimeSemanticConflictError, SqliteProjection } from '../../src/runtime/sqlite-projection.ts';

async function fixtureDirectory() {
  return mkdtemp(join(tmpdir(), 'faktori-runtime-'));
}

function intent(runId, admissionKey = `admission-${runId}`, estimatedTokens = 20, attempt = 1) {
  return {
    format: 'faktori.run-intent/v1',
    runId,
    admissionKey,
    workItem: { id: `work-${runId}`, revision: 'work@1' },
    target: { factoryId: 'factory', productId: 'product', repository: 'org/repo', branch: 'build/phase-2', baseRevision: 'base', expectedRevision: 'expected' },
    context: { packetRevision: 'packet@1', digest: 'context-digest' },
    execution: { profile: 'native', workspaceId: 'workspace', workspacePath: '/private/tmp/job', providerId: 'codex', model: 'gpt-5.5', approvedInputDigests: [] },
    budget: { reservationId: `reservation-${runId}`, maxRuntimeMinutes: 10, estimatedTokens, status: 'held' },
    authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } },
    attempt,
    createdAt: '2026-09-04T00:00:00.000Z',
  };
}

function coordinatorOptions(directory, suffix = 'one', probe = {}) {
  return {
    factoryId: 'factory',
    journalPath: join(directory, 'operations.jsonl'),
    projectionPath: join(directory, `projection-${suffix}.sqlite`),
    identity: { instanceId: `instance-${suffix}`, pid: suffix === 'one' ? 101 : 202, processStartedAt: `2026-09-04T00:00:0${suffix === 'one' ? '1' : '2'}.000Z`, processGroupId: 'group', executableDigest: 'runtime@1' },
    limits: { maxConcurrentRuns: 2, maxRetries: 1, maxRuntimeMinutes: 30, maxTokens: 50, strictSpending: true, strictSpendingSupported: true },
    processProbe: {
      coordinator: async () => probe.coordinator ?? 'dead',
      worker: async () => probe.worker ?? 'dead',
    },
  };
}

describe('append-only journal recovery', () => {
  it('truncates only an unterminated tail and retains committed records', async () => {
    const directory = await fixtureDirectory();
    try {
      const path = join(directory, 'operations.jsonl');
      const journal = await AppendOnlyJournal.open(path, { random: { eventId: () => 'event-1' } });
      await journal.append(journal.event('run-1', 'run.admitted', { intent: intent('run-1') }));
      await writeFile(path, `${await readFile(path, 'utf8')}{"half":`, 'utf8');

      const reopened = await AppendOnlyJournal.open(path);

      expect(reopened.events()).toHaveLength(1);
      expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('blocks malformed committed data and conflicting duplicate event ids', async () => {
    const directory = await fixtureDirectory();
    try {
      const badPath = join(directory, 'bad.jsonl');
      await writeFile(badPath, '{"half":}\n', 'utf8');
      await expect(AppendOnlyJournal.open(badPath)).rejects.toBeInstanceOf(JournalCorruptionError);

      const duplicatePath = join(directory, 'duplicate.jsonl');
      const journal = await AppendOnlyJournal.open(duplicatePath, { random: { eventId: () => 'same-id' } });
      const first = journal.event('run-1', 'run.admitted', { intent: intent('run-1') });
      await journal.append(first);
      await expect(journal.append({ ...first, data: { intent: intent('other') } })).rejects.toBeInstanceOf(JournalDuplicateConflictError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects non-JSON nested values and isolates stored records from caller mutations', async () => {
    const directory = await fixtureDirectory();
    try {
      const path = join(directory, 'isolated.jsonl');
      const journal = await AppendOnlyJournal.open(path);
      const invalid = { format: 'faktori.run-event/v1', eventId: 'invalid', runId: 'run-invalid', occurredAt: '2026-09-04T00:00:00.000Z', kind: 'provider.event', data: { nested: { notSerializable: undefined } } };
      await expect(journal.append(invalid)).rejects.toThrow(/cannot contain undefined/);

      const original = journal.event('run-immutable', 'run.admitted', { intent: intent('run-immutable') }, 'immutable');
      await journal.append(original);
      original.data.intent.workItem.id = 'caller-mutated';
      const exposed = journal.events();
      exposed[0].data.intent.workItem.id = 'returned-value-mutated';
      expect(journal.events()[0].data.intent.workItem.id).toBe('work-run-immutable');
      const reopened = await AppendOnlyJournal.open(path);
      expect(reopened.events()[0].data.intent.workItem.id).toBe('work-run-immutable');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('SQLite projection', () => {
  it('is rebuildable from authoritative events, including terminal and unresolved work', async () => {
    const directory = await fixtureDirectory();
    try {
      const journal = await AppendOnlyJournal.open(join(directory, 'operations.jsonl'));
      const admitted = journal.event('run-1', 'run.admitted', { intent: intent('run-1') }, 'admitted');
      const intended = journal.event('run-1', 'effect.intended', { effect: { operationId: 'launch-1', kind: 'worker.launch', identityKey: 'worker:1', requestedAt: '2026-09-04T00:00:01.000Z', requestDigest: 'request' } }, 'intended');
      const final = journal.event('run-2', 'run.admitted', { intent: intent('run-2') }, 'admitted-2');
      const receipt = journal.event('run-2', 'provider.final', { result: { outcome: 'completed', usage: { availability: 'unavailable', unavailableReason: 'provider did not report usage' }, nativeCancellationReceipt: false } }, 'final');
      for (const event of [admitted, intended, final, receipt]) await journal.append(event);

      const projection = new SqliteProjection(join(directory, 'projection.sqlite'));
      projection.rebuild(journal.events());
      const before = projection.snapshots();
      projection.rebuild(journal.events());

      expect(projection.snapshots()).toEqual(before);
      expect(projection.snapshot('run-1')).toEqual(expect.objectContaining({ state: 'launching', unresolvedEffects: [expect.objectContaining({ operationId: 'launch-1' })] }));
      expect(projection.snapshot('run-2')).toEqual(expect.objectContaining({ state: 'succeeded' }));
      projection.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses append order, not timestamps or random event ids, as the operational sequence', async () => {
    const directory = await fixtureDirectory();
    try {
      const journal = await AppendOnlyJournal.open(join(directory, 'ordered.jsonl'));
      await journal.append(journal.event('run-ordered', 'run.admitted', { intent: intent('run-ordered') }, 'z-first'));
      await journal.append(journal.event('run-ordered', 'provider.final', { result: { outcome: 'completed', usage: { availability: 'unavailable', unavailableReason: 'unknown' }, nativeCancellationReceipt: false } }, 'a-second'));
      const projection = new SqliteProjection(join(directory, 'ordered.sqlite'));
      projection.rebuild(journal.events());
      expect(projection.snapshot('run-ordered')).toEqual(expect.objectContaining({ state: 'succeeded' }));
      projection.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('makes canonical run-intent replay inert after revocation while conflicting reuse blocks reconstruction', async () => {
    const directory = await fixtureDirectory();
    try {
      const journal = await AppendOnlyJournal.open(join(directory, 'replay.jsonl'));
      const firstIntent = intent('run-replay');
      await journal.append(journal.event('run-replay', 'run.admitted', { intent: firstIntent }, 'admit-first'));
      await journal.append(journal.event('run-replay', 'authority.revoked', { epoch: 2 }, 'revoke'));
      await journal.append(journal.event('run-replay', 'run.admitted', { intent: firstIntent }, 'admit-replay'));
      const projection = new SqliteProjection(join(directory, 'replay.sqlite'));
      projection.rebuild(journal.events());
      expect(projection.snapshot('run-replay')).toEqual(expect.objectContaining({ state: 'cancelling', authorityRevoked: true, authorityEpoch: 2 }));
      projection.close();

      const conflict = await AppendOnlyJournal.open(join(directory, 'run-conflict.jsonl'));
      await conflict.append(conflict.event('run-conflict', 'run.admitted', { intent: intent('run-conflict') }, 'run-first'));
      const changed = intent('run-conflict');
      changed.execution.model = 'different-model';
      await conflict.append(conflict.event('run-conflict', 'run.admitted', { intent: changed }, 'run-conflict-fresh-event-id'));
      const brokenProjection = new SqliteProjection(join(directory, 'run-conflict.sqlite'));
      expect(() => brokenProjection.rebuild(conflict.events())).toThrow(RuntimeSemanticConflictError);
      const liveProjection = new SqliteProjection(join(directory, 'run-conflict-live.sqlite'));
      liveProjection.apply(conflict.events()[0]);
      expect(() => liveProjection.apply(conflict.events()[1])).toThrow(RuntimeSemanticConflictError);
      brokenProjection.close();
      liveProjection.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('makes identical effect-operation replay inert and blocks conflicting operation reuse', async () => {
    const directory = await fixtureDirectory();
    try {
      const effect = { operationId: 'operation-1', kind: 'worker.launch', identityKey: 'worker:1', requestedAt: '2026-09-04T00:00:01.000Z', requestDigest: 'request-one' };
      const journal = await AppendOnlyJournal.open(join(directory, 'effect-replay.jsonl'));
      await journal.append(journal.event('run-effect', 'run.admitted', { intent: intent('run-effect') }, 'effect-admit'));
      await journal.append(journal.event('run-effect', 'effect.intended', { effect }, 'effect-first'));
      await journal.append(journal.event('run-effect', 'effect.receipt', { receipt: { operationId: 'operation-1', observedAt: '2026-09-04T00:00:02.000Z', outcome: 'completed' } }, 'effect-receipt'));
      await journal.append(journal.event('run-effect', 'effect.intended', { effect }, 'effect-identical-replay'));
      const projection = new SqliteProjection(join(directory, 'effect-replay.sqlite'));
      projection.rebuild(journal.events());
      expect(projection.snapshot('run-effect')).toEqual(expect.objectContaining({ unresolvedEffects: [] }));
      projection.close();

      const conflict = await AppendOnlyJournal.open(join(directory, 'effect-conflict.jsonl'));
      await conflict.append(conflict.event('run-effect-conflict', 'run.admitted', { intent: intent('run-effect-conflict') }, 'effect-conflict-admit'));
      await conflict.append(conflict.event('run-effect-conflict', 'effect.intended', { effect }, 'effect-conflict-first'));
      await conflict.append(conflict.event('run-effect-conflict', 'effect.intended', { effect: { ...effect, requestDigest: 'changed-request' } }, 'effect-conflict-second'));
      const brokenProjection = new SqliteProjection(join(directory, 'effect-conflict.sqlite'));
      expect(() => brokenProjection.rebuild(conflict.events())).toThrow(RuntimeSemanticConflictError);
      brokenProjection.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('durable coordinator ownership and admission', () => {
  it('requires claimed ownership for every coordinator record mutation', async () => {
    const directory = await fixtureDirectory();
    try {
      const coordinator = await DurableCoordinator.open(coordinatorOptions(directory));
      await expect(coordinator.record('coordinator.heartbeat', 'factory', {})).rejects.toThrow(/must claim exclusive ownership/);
      await expect(coordinator.admit(intent('unclaimed'))).rejects.toThrow(/must claim exclusive ownership/);
      await coordinator.claim();
      await coordinator.record('coordinator.heartbeat', 'factory', {});
      await coordinator.release();
      coordinator.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses stale-lock reclamation when the exact probed lock changes before deletion', async () => {
    const directory = await fixtureDirectory();
    try {
      const stale = await DurableCoordinator.open(coordinatorOptions(directory, 'one'));
      await stale.claim();
      stale.close();
      const options = coordinatorOptions(directory, 'two', { coordinator: 'dead' });
      options.beforeStaleLockDelete = async () => {
        await writeFile(`${options.journalPath}.coordinator-lock`, `${JSON.stringify({ instanceId: 'replacement', pid: 303, processStartedAt: '2026-09-04T00:01:00.000Z' })}\n`, 'utf8');
      };
      const contender = await DurableCoordinator.open(options);
      await expect(contender.claim()).rejects.toThrow(/lock changed after stale-owner probe/);
      expect(await readFile(`${options.journalPath}.coordinator-lock`, 'utf8')).toContain('replacement');
      contender.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serializes duplicate/concurrent admission and atomically reserves capacity', async () => {
    const directory = await fixtureDirectory();
    try {
      const coordinator = await DurableCoordinator.open(coordinatorOptions(directory));
      await coordinator.claim();
      const [first, duplicate, second] = await Promise.all([
        coordinator.admit(intent('run-1')),
        coordinator.admit(intent('run-1')),
        coordinator.admit(intent('run-2', 'admission-run-2', 40)),
      ]);

      expect(first.accepted).toBe(true);
      expect(duplicate).toEqual(expect.objectContaining({ accepted: true, snapshot: expect.objectContaining({ intent: expect.objectContaining({ runId: 'run-1' }) }) }));
      expect(second).toEqual({ accepted: false, reason: 'token_reservation_exceeded' });
      expect(coordinator.snapshots()).toHaveLength(1);
      await coordinator.release();
      coordinator.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a semantic effect conflict before it can poison the authoritative journal', async () => {
    const directory = await fixtureDirectory();
    try {
      const coordinator = await DurableCoordinator.open(coordinatorOptions(directory));
      await coordinator.claim();
      await coordinator.admit(intent('run-effect-guard'));
      const effect = { operationId: 'guarded-operation', kind: 'worker.launch', identityKey: 'worker:guarded', requestedAt: '2026-09-04T00:00:01.000Z', requestDigest: 'request-one' };
      await coordinator.recordEffectIntent('run-effect-guard', effect);
      const before = coordinator.journal.events();

      await expect(coordinator.recordEffectIntent('run-effect-guard', { ...effect, requestDigest: 'conflicting-request' })).rejects.toThrow(RuntimeSemanticConflictError);
      expect(coordinator.journal.events()).toEqual(before);

      await coordinator.release();
      coordinator.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses unsupported strict spending, retry/runtime excess, and treats unavailable usage as unknown', async () => {
    const directory = await fixtureDirectory();
    try {
      const options = coordinatorOptions(directory);
      options.limits.strictSpendingSupported = false;
      const coordinator = await DurableCoordinator.open(options);
      await coordinator.claim();
      expect(await coordinator.admit(intent('strict'))).toEqual({ accepted: false, reason: 'strict_spending_capability_unavailable' });
      options.limits.strictSpendingSupported = true;
      expect(await coordinator.admit(intent('retry', 'retry-key', 10, 3))).toEqual({ accepted: false, reason: 'retry_limit_exceeded' });
      const tooLong = intent('runtime');
      tooLong.budget.maxRuntimeMinutes = 31;
      expect(await coordinator.admit(tooLong)).toEqual({ accepted: false, reason: 'runtime_limit_exceeded' });
      await coordinator.release();
      coordinator.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps terminal held or uncertain reservations charged until explicitly released and never reuses ids', async () => {
    const directory = await fixtureDirectory();
    try {
      const options = coordinatorOptions(directory);
      options.limits.maxTokens = 50;
      const coordinator = await DurableCoordinator.open(options);
      await coordinator.claim();
      await coordinator.admit(intent('terminal-held', 'terminal-held', 30));
      await coordinator.record('provider.final', 'terminal-held', { result: { outcome: 'completed', usage: { availability: 'unavailable', unavailableReason: 'not reported' }, nativeCancellationReceipt: false } });
      expect(await coordinator.admit(intent('blocked-by-held', 'blocked-by-held', 25))).toEqual({ accepted: false, reason: 'token_reservation_exceeded' });
      const reused = intent('duplicate-reservation', 'duplicate-reservation', 1);
      reused.budget.reservationId = 'reservation-terminal-held';
      expect(await coordinator.admit(reused)).toEqual({ accepted: false, reason: 'reservation_id_already_exists' });
      await coordinator.record('reservation.released', 'terminal-held', { status: 'released' });
      expect(await coordinator.admit(intent('released-capacity', 'released-capacity', 25))).toEqual(expect.objectContaining({ accepted: true }));
      await coordinator.release();
      coordinator.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains interrupted worker capacity until recovery proves the recorded identity dead', async () => {
    const directory = await fixtureDirectory();
    try {
      const options = coordinatorOptions(directory, 'one', { worker: 'unknown' });
      options.limits.maxConcurrentRuns = 1;
      const coordinator = await DurableCoordinator.open(options);
      await coordinator.claim();
      await coordinator.admit(intent('interrupted-worker'));
      await coordinator.record('worker.started', 'interrupted-worker', { worker: { kind: 'native', pid: 404, processStartedAt: '2026-09-04T00:00:00.000Z', processGroupId: 404, runNonce: 'still-unknown' } });
      await coordinator.record('provider.final', 'interrupted-worker', { result: { outcome: 'interrupted_uncertain', usage: { availability: 'unavailable', unavailableReason: 'interrupted' }, nativeCancellationReceipt: false } });
      expect(await coordinator.admit(intent('capacity-blocked', 'capacity-blocked', 1))).toEqual({ accepted: false, reason: 'concurrency_limit_exceeded' });
      await coordinator.recover();
      expect(coordinator.snapshot('interrupted-worker')).toEqual(expect.objectContaining({ state: 'reconciling' }));
      await coordinator.release();
      coordinator.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('will not reclaim a surviving, PID-reused, or unknown coordinator and blocks unknown worker recovery', async () => {
    const directory = await fixtureDirectory();
    try {
      const first = await DurableCoordinator.open(coordinatorOptions(directory, 'one'));
      await first.claim();
      await first.admit(intent('run-ghost'));
      const second = await DurableCoordinator.open(coordinatorOptions(directory, 'two', { coordinator: 'alive' }));
      await expect(second.claim()).rejects.toThrow(/heartbeat expiry is not authority/);
      second.close();
      await first.record('worker.started', 'run-ghost', { worker: { kind: 'native', pid: 101, processStartedAt: 'different-process-start', processGroupId: 101, runNonce: 'nonce' } });
      // The recorded start time is part of the identity. A probe that cannot prove the exact worker is dead blocks work.
      const restored = await DurableCoordinator.open(coordinatorOptions(directory, 'two', { worker: 'mismatch' }));
      await first.release();
      await restored.claim();
      const recovered = await restored.recover();
      expect(recovered[0]).toEqual(expect.objectContaining({ state: 'reconciling' }));
      expect(restored.journal.events().some((event) => event.kind === 'effect.unresolved' && event.data.reason === 'worker_mismatch')).toBe(true);
      await restored.release();
      first.close();
      restored.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps an unknown worker blocked instead of treating missing telemetry as a safe retry', async () => {
    const directory = await fixtureDirectory();
    try {
      const coordinator = await DurableCoordinator.open(coordinatorOptions(directory, 'one', { worker: 'unknown' }));
      await coordinator.claim();
      await coordinator.admit(intent('run-unknown'));
      await coordinator.record('worker.started', 'run-unknown', { worker: { kind: 'native', pid: 303, processStartedAt: '2026-09-04T00:00:00.000Z', processGroupId: 303, runNonce: 'unknown-worker' } });
      await coordinator.recover();
      expect(coordinator.snapshot('run-unknown')).toEqual(expect.objectContaining({ state: 'reconciling' }));
      expect(coordinator.journal.events()).toContainEqual(expect.objectContaining({ kind: 'effect.unresolved', data: expect.objectContaining({ reason: 'worker_unknown' }) }));
      await coordinator.release();
      coordinator.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
