import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleConsultationRuntime } from '../../src/console/consultation-runtime.ts';
import { parseSubscriptionRouting } from '../../src/console/subscription-routing.ts';
import { DurableCoordinator } from '../../src/runtime/coordinator.ts';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'faktori-consultation-runtime-')); roots.push(root);
  const coordinator = await DurableCoordinator.open({ factoryId: 'factory', journalPath: join(root, 'operations.jsonl'), projectionPath: join(root, 'projection.sqlite'), identity: { instanceId: 'test', pid: 1, processStartedAt: 'now' }, limits: { maxConcurrentRuns: 2, maxRetries: 0, maxRuntimeMinutes: 10, maxTokens: 0, strictSpending: false, strictSpendingSupported: false } });
  await coordinator.claim();
  await coordinator.admit({ format: 'faktori.run-intent/v1', runId: 'builder-run', admissionKey: 'builder-admission', workItem: { id: 'feature', revision: 'feature@1', role: 'builder' }, target: { factoryId: 'factory', productId: 'product', repository: 'owner/repo', branch: 'feature', baseRevision: 'base', expectedRevision: 'head' }, context: { packetRevision: 'packet@1', digest: 'packet' }, execution: { profile: 'native', workspaceId: 'workspace', workspacePath: '/workspace', providerId: 'provider', model: 'builder', approvedInputDigests: [] }, budget: { reservationId: 'reserve', maxRuntimeMinutes: 5, estimatedTokens: 0, status: 'held' }, authority: { authorityRevision: 'authority@1', epoch: 1, scopeDigest: 'scope', policy: { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false } }, attempt: 1, createdAt: '2026-09-22T12:00:00.000Z' });
  return coordinator;
}

function packet() { return { workItemId: 'feature', workItemRevision: 'feature@1', originalBuilderId: 'builder-1', policyRevision: 'routing@1', failureKind: 'engineering', outputLimit: 1000, objective: 'Repair feature.', exactRevision: 'head', contracts: [{ path: 'docs/contract.md', digest: 'contract' }], files: [{ path: 'src/feature.ts', digest: 'source' }], reproduction: 'input fails', attempts: [{ hypothesis: 'parser rejects valid input', result: 'still fails' }], question: 'What is the minimal repair?', requestedOutput: 'diagnosis and patch' }; }

describe('console consultation composition', () => {
  it('persists callback intent before dispatching and only resumes the mapped original builder', async () => {
    const coordinator = await fixture(); let resumed;
    const runtime = new ConsoleConsultationRuntime({ coordinator, mappings: [{ originalBuilderId: 'builder-1', workItemId: 'feature', runId: 'builder-run', workItemRevision: 'feature@1', exactRevision: 'head', seniorTemplateId: 'senior-template', resumeTarget: 'builder-session' }], dispatch: {
      dispatchSenior: async ({ request, seniorTemplateId }) => { expect(seniorTemplateId).toBe('senior-template'); expect(coordinator.snapshot('builder-run').unresolvedEffects).toHaveLength(1); return { outcome: 'completed', diagnosis: 'parser guard missing', proposal: 'guard optional field', verificationSteps: ['reproduce'] }; },
      resumeBuilder: async input => { resumed = input; expect(input.resumeTarget).toBe('builder-session'); },
    } });
    const result = await runtime.consult(packet());
    expect(result).toMatchObject({ status: 'completed', plan: { originalBuilderId: 'builder-1', proposal: 'guard optional field' } });
    expect(resumed.plan.consultationId).toBe(result.plan.consultationId);
    expect(runtime.recover()).toEqual([]);
    await coordinator.release(); coordinator.close();
  });

  it('rejects a capacity observation without a durable source snapshot identity', () => {
    expect(() => parseSubscriptionRouting({ policy: { policyRevision: 'routing@1', maxEvidenceAgeMs: 1, taskClasses: { routine: { routePreference: ['economical'] } } }, candidates: [{ routeId: 'economical', providerId: 'provider', accountPoolId: 'pool', model: 'model', costTier: 'economical', taskClasses: ['routine'], capabilities: ['native'], subscriptionEligible: true, capabilityObservedAt: '2026-09-22T12:00:00.000Z', modelObservedAt: '2026-09-22T12:00:00.000Z' }], observations: [{ accountPoolId: 'pool', providerId: 'provider', nativeUnit: 'percent', availableUnits: 10, observedAt: '2026-09-22T12:00:00.000Z', source: 'provider' }], bindings: { feature: { taskClass: 'routine' } } })).toThrow('routing_observation_snapshotId_invalid');
  });
});
