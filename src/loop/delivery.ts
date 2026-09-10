import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type DeliveryGateId = 'local_acceptance' | 'publication' | 'review' | 'merge' | 'deployment' | 'staging_verification';
export type DeliveryGateStatus = 'pending' | 'passed' | 'failed' | 'unobserved';
export interface LoopDeliverySummary {
  gates: Array<{ id: DeliveryGateId; label: string; status: DeliveryGateStatus; evidenceUrl?: string; observedAt?: string }>;
  nextAction: { label: string; role: string; url?: string };
  issue?: string;
}
type Data = Record<string, unknown>;
const GATES: Array<[DeliveryGateId, string, string, string]> = [
  ['local_acceptance', 'Local acceptance', 'Awaiting local acceptance', 'manager'],
  ['publication', 'Publication', 'Awaiting publication', 'publication_owner'],
  ['review', 'External review', 'Awaiting external review', 'reviewer'],
  ['merge', 'Merge', 'Awaiting merge approval', 'merge_captain'],
  ['deployment', 'Deployment', 'Awaiting deployment', 'release_owner'],
  ['staging_verification', 'Staging verification', 'Awaiting staging verification', 'acceptance_owner'],
];
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
function data(value: unknown): Data { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}; }
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.href : undefined; } catch { return undefined; }
}

export async function readDeliveryRecord(path: string, limit = 65536): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('delivery_record_invalid');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('delivery_record_invalid');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('delivery_record_unreadable');
  } finally { await handle?.close(); }
}

function acceptance(state: unknown): { loopId?: string; digest?: string } {
  const input = data(state);
  const stages = Array.isArray(input.stages) ? input.stages : [];
  const last = data([...stages].reverse().find((stage) => ['manager_accept', 'deterministic_accept'].includes(String(data(stage).kind))));
  const digest = data(last.evidence).contentDigest;
  if (last.kind === 'deterministic_accept') {
    const response = data(last.response), receipt = data(response.receipt), actor = data(receipt.actor), evidence = data(receipt.evidence), candidate = data(evidence.candidate);
    if (receipt.format !== 'faktori.lean-acceptance-receipt/v1' || receipt.accepted !== true || actor.kind !== 'deterministic' || actor.id !== 'faktori.lean.accept/v1'
      || receipt.loopId !== input.loopId || receipt.stageId !== last.stageId || response.evidenceDigest !== digest || candidate.contentDigest !== digest
      || !Array.isArray(evidence.reviewStageIds) || evidence.reviewStageIds.length < 1) return { ...(typeof input.loopId === 'string' ? { loopId: input.loopId } : {}) };
  }
  return { ...(typeof input.loopId === 'string' ? { loopId: input.loopId } : {}), ...(typeof digest === 'string' && DIGEST.test(digest) ? { digest } : {}) };
}

function publishedBinding(value: unknown, state: unknown): { digest: string; commit: string; url: string } | undefined {
  const receipt = data(value), loop = data(receipt.loop), binding = data(receipt.binding), pr = data(receipt.pr);
  const accepted = acceptance(state);
  const url = safeUrl(pr.url);
  if (receipt.format !== 'faktori.loop-publication-receipt/v1' || !['published', 'reconciled'].includes(String(receipt.status))
    || data(state).status !== 'succeeded' || !accepted.digest || loop.loopId !== accepted.loopId || loop.acceptedEvidenceDigest !== accepted.digest
    || typeof binding.expectedRevision !== 'string' || !SHA.test(binding.expectedRevision) || pr.headRefOid !== binding.expectedRevision
    || pr.headRefName !== binding.branch || pr.baseRefName !== binding.baseRefName || !url) return undefined;
  // Only canonical GitHub PR links matching the sealed repository are projected.
  if (new URL(url).hostname !== 'github.com' || new URL(url).pathname !== `/${binding.repository}/pull/${pr.number}` || !Number.isInteger(pr.number) || Number(pr.number) < 1) return undefined;
  return { digest: accepted.digest, commit: binding.expectedRevision, url };
}

/** Observation only. No gate here grants publication, merge or deployment authority. */
export function projectLoopDelivery(state: unknown, publication?: unknown, delivery?: unknown, unreadable = false): LoopDeliverySummary {
  const input = data(state);
  const gates: LoopDeliverySummary['gates'] = GATES.map(([id, label]) => ({ id, label, status: 'unobserved' }));
  const accepted = acceptance(state);
  gates[0]!.status = input.status === 'succeeded' && accepted.digest ? 'passed' : ['failed', 'blocked', 'interrupted_uncertain'].includes(String(input.status)) ? 'failed' : input.status === 'running' ? 'pending' : 'unobserved';
  if (input.status === 'succeeded' && accepted.digest) gates[1]!.status = 'pending';
  let issue = unreadable ? 'Delivery records need reconciliation; unreadable evidence was not accepted.' : undefined;
  const bound = publishedBinding(publication, state);
  const receipt = data(publication);
  if (bound) { gates[1]!.status = 'passed'; gates[1]!.evidenceUrl = bound.url; }
  else if (publication !== undefined) {
    const accepted = acceptance(state), loop = data(receipt.loop);
    const matches = receipt.format === 'faktori.loop-publication-receipt/v1' && accepted.digest !== undefined && accepted.digest === loop.acceptedEvidenceDigest && accepted.loopId === loop.loopId;
    if (matches && ['blocked', 'failed', 'uncertain'].includes(String(receipt.status))) gates[1]!.status = 'failed';
    else if (!(matches && receipt.status === 'intended')) issue = 'Publication evidence does not match the accepted work; reconciliation is required.';
  }
  if (delivery !== undefined) {
    const evidence = data(delivery);
    if (!bound || evidence.format !== 'faktori.loop-delivery/v1' || evidence.loopId !== input.loopId || evidence.acceptedEvidenceDigest !== bound.digest || evidence.reviewedCommit !== bound.commit || !Array.isArray(evidence.gates)) {
      issue = 'Delivery evidence is missing or belongs to another revision; reconciliation is required.';
    } else {
      for (const gate of gates.slice(2)) {
        const entry = data(evidence.gates.find((candidate) => data(candidate).id === gate.id));
        const url = safeUrl(entry.evidenceUrl);
        if (['pending', 'failed', 'passed'].includes(String(entry.status)) && url && typeof entry.recordedBy === 'string' && ID.test(entry.recordedBy) && typeof entry.observedAt === 'string' && Number.isFinite(Date.parse(entry.observedAt))) {
          gate.status = entry.status as DeliveryGateStatus;
          gate.evidenceUrl = url;
          gate.observedAt = new Date(entry.observedAt as string).toISOString();
        }
      }
    }
  }
  const nextIndex = gates.findIndex((gate) => gate.status !== 'passed');
  const definition = GATES[nextIndex];
  const nextAction = issue ? { label: 'Reconcile delivery evidence', role: 'factory_owner' }
    : definition ? { label: gates[nextIndex]!.status === 'failed' ? `Resolve ${definition[1].toLowerCase()} failure` : definition[2], role: definition[3], ...(gates[nextIndex]!.evidenceUrl || bound?.url ? { url: gates[nextIndex]!.evidenceUrl ?? bound!.url } : {}) }
      : { label: 'Recorded staging verification complete', role: 'acceptance_owner', ...(bound ? { url: bound.url } : {}) };
  return { gates, nextAction, ...(issue ? { issue } : {}) };
}

/** Explicit owner CLI evidence entry, not a provider claim or automatic approval. */
export async function recordLoopDeliveryEvidence(value: unknown): Promise<LoopDeliverySummary> {
  const input = data(value);
  if (input.format !== 'faktori.loop-delivery-record/v1' || input.confirmed !== true || typeof input.artifactsDirectory !== 'string' || !isAbsolute(input.artifactsDirectory)
    || typeof input.recordedBy !== 'string' || !ID.test(input.recordedBy) || typeof input.reviewedCommit !== 'string' || !SHA.test(input.reviewedCommit)
    || !GATES.slice(2).some(([id]) => id === input.gate) || !['pending', 'passed', 'failed'].includes(String(input.status)) || !safeUrl(input.evidenceUrl)) throw new Error('invalid confirmed delivery evidence request');
  const lockPath = join(input.artifactsDirectory, 'delivery.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  const temporary = join(input.artifactsDirectory, `.delivery-${randomUUID()}.json`);
  try {
    const state = await readDeliveryRecord(join(input.artifactsDirectory, 'state.json'), 1024 * 1024);
    const publication = await readDeliveryRecord(join(input.artifactsDirectory, 'publication.json'));
    const binding = publishedBinding(publication, state);
    if (!binding || binding.commit !== input.reviewedCommit) throw new Error('delivery evidence requires an observed publication at the requested reviewed commit');
    const existing = await readDeliveryRecord(join(input.artifactsDirectory, 'delivery.json'));
    const prior = data(existing);
    if (existing !== undefined && (prior.format !== 'faktori.loop-delivery/v1' || prior.loopId !== data(state).loopId || prior.reviewedCommit !== binding.commit || prior.acceptedEvidenceDigest !== binding.digest || !Array.isArray(prior.gates))) throw new Error('existing delivery evidence needs reconciliation');
    const gates = (Array.isArray(prior.gates) ? prior.gates : []).filter((entry) => data(entry).id !== input.gate);
    gates.push({ id: input.gate, status: input.status, evidenceUrl: safeUrl(input.evidenceUrl), recordedBy: input.recordedBy, observedAt: new Date().toISOString(), basis: 'owner_recorded' });
    const document = { format: 'faktori.loop-delivery/v1', loopId: data(state).loopId, acceptedEvidenceDigest: binding.digest, reviewedCommit: binding.commit, gates };
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(document, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(input.artifactsDirectory, 'delivery.json'));
    return projectLoopDelivery(state, publication, document);
  } finally {
    try { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}
