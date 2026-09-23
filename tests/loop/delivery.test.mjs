import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectLoopDelivery, readDeliveryRecord, recordLoopDeliveryEvidence } from '../../src/loop/delivery.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const commit = 'b'.repeat(40);
const state = { format: 'faktori.manager-loop-state/v1', loopId: 'pilot', status: 'succeeded', stages: [{ kind: 'manager_accept', evidence: { contentDigest: digest } }] };
const publication = { format: 'faktori.loop-publication-receipt/v1', status: 'published', loop: { loopId: 'pilot', acceptedEvidenceDigest: digest }, binding: { repository: 'example/product', branch: 'feat/pilot', baseRefName: 'main', expectedRevision: commit }, pr: { number: 4, url: 'https://github.com/example/product/pull/4', headRefName: 'feat/pilot', headRefOid: commit, baseRefName: 'main' } };

describe('delivery evidence and next action', () => {
  it('requires the observed deployed revision to match an explicit merge revision, not the PR head or health alone', () => {
    const mergeCommit = 'c'.repeat(40);
    const gate = (id, extra = {}) => ({ id, status: 'passed', evidenceUrl: publication.pr.url, recordedBy: 'owner', observedAt: '2026-09-13T00:00:00Z', ...extra });
    const doc = (deployment) => ({ format: 'faktori.loop-delivery/v1', loopId: 'pilot', acceptedEvidenceDigest: digest, reviewedCommit: commit, gates: [gate('review'), gate('merge', { mergeCommit }), gate('deployment', deployment)] });
    for (const missingOrWrong of [{}, { deployedRevision: commit }, { deployedRevision: 'd'.repeat(40) }]) {
      expect(projectLoopDelivery(state, publication, doc(missingOrWrong)).gates[4].status).not.toBe('passed');
    }
    expect(projectLoopDelivery(state, publication, doc({ deployedRevision: mergeCommit })).gates[4].status).toBe('passed');
    expect(projectLoopDelivery(state, publication, doc({ deployedRevision: mergeCommit })).gates[5].status).toBe('unobserved');
  });
  it('separates local acceptance from delivery and never treats an arbitrary or stale PR receipt as publication', () => {
    const local = projectLoopDelivery(state);
    expect(local.gates.map(({ status }) => status)).toEqual(['passed', 'pending', 'unobserved', 'unobserved', 'unobserved', 'unobserved']);
    expect(local.nextAction).toEqual({ label: 'Awaiting publication', role: 'publication_owner' });
    expect(projectLoopDelivery(state, publication).nextAction).toEqual({ label: 'Awaiting external review', role: 'reviewer', url: publication.pr.url });
    for (const bad of [{ ...publication, binding: { ...publication.binding, expectedRevision: 'c'.repeat(40) } }, { ...publication, pr: { ...publication.pr, url: 'https://evil.example/pull/4' } }, { ...publication, loop: { ...publication.loop, acceptedEvidenceDigest: `sha256:${'d'.repeat(64)}` } }]) {
      const result = projectLoopDelivery(state, bad);
      expect(result.gates[1].status).not.toBe('passed');
      expect(result.nextAction.label).toContain('Reconcile');
    }
    expect(projectLoopDelivery(state, { ...publication, status: 'uncertain', detail: 'Bearer private' }).nextAction).toEqual({ label: 'Resolve publication failure', role: 'publication_owner' });
    expect(JSON.stringify(projectLoopDelivery(state, { ...publication, status: 'failed', detail: 'Bearer private' }))).not.toContain('private');
  });

  it('records explicit revision-bound owner evidence without merging, deploying or duplicating a gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-'));
    try {
      await writeFile(join(root, 'state.json'), JSON.stringify(state));
      await writeFile(join(root, 'publication.json'), JSON.stringify(publication));
      const request = { format: 'faktori.loop-delivery-record/v1', artifactsDirectory: root, reviewedCommit: commit, recordedBy: 'owner', confirmed: true, gate: 'review', status: 'passed', evidenceUrl: publication.pr.url };
      const reviewed = await recordLoopDeliveryEvidence(request);
      expect(reviewed.nextAction.label).toBe('Awaiting merge approval');
      expect(reviewed.gates.slice(3).every(({ status }) => status === 'unobserved')).toBe(true);
      await recordLoopDeliveryEvidence(request);
      const stored = JSON.parse(await readFile(join(root, 'delivery.json'), 'utf8'));
      expect(stored.gates).toHaveLength(1);
      expect(stored.gates[0].basis).toBe('owner_recorded');
      const before = await readFile(join(root, 'delivery.json'), 'utf8');
      await expect(recordLoopDeliveryEvidence({ ...request, reviewedCommit: 'c'.repeat(40) })).rejects.toThrow(/reviewed commit/);
      await expect(recordLoopDeliveryEvidence({ ...request, confirmed: false })).rejects.toThrow(/confirmed/);
      await expect(recordLoopDeliveryEvidence({ ...request, gate: 'merge' })).rejects.toThrow(/mergeCommit/);
      expect(await readFile(join(root, 'delivery.json'), 'utf8')).toBe(before);
      const mergeCommit = 'e'.repeat(40);
      await recordLoopDeliveryEvidence({ ...request, gate: 'merge', mergeCommit });
      const merged = await readFile(join(root, 'delivery.json'), 'utf8');
      await expect(recordLoopDeliveryEvidence({ ...request, gate: 'deployment', deployedRevision: commit })).rejects.toThrow(/matching deployment/);
      expect(await readFile(join(root, 'delivery.json'), 'utf8')).toBe(merged);
      const deployed = await recordLoopDeliveryEvidence({ ...request, gate: 'deployment', deployedRevision: mergeCommit });
      expect(deployed.gates[4].status).toBe('passed');
      expect(deployed.gates[5].status).toBe('unobserved');
      const rejected = await recordLoopDeliveryEvidence({ ...request, status: 'failed' });
      expect(rejected.nextAction).toEqual({ label: 'Resolve external review failure', role: 'reviewer', url: publication.pr.url });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects linked delivery files and shows missing evidence as unobserved rather than passed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-delivery-link-'));
    try {
      await writeFile(join(root, 'private.json'), '{"secret":"not for the Console"}');
      await symlink(join(root, 'private.json'), join(root, 'delivery.json'));
      await expect(readDeliveryRecord(join(root, 'delivery.json'))).rejects.toThrow('delivery_record_unreadable');
      const result = projectLoopDelivery(state, undefined, undefined, true);
      expect(result.gates.slice(2).every(({ status }) => status === 'unobserved')).toBe(true);
      expect(result.nextAction.role).toBe('factory_owner');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
