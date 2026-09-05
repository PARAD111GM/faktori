import type { DurableCoordinator } from '../runtime/coordinator.ts';
import type { GMFinding, GMImprovementProposal, DurableGMStore } from './index.ts';

const UNSAFE_TEXT = /(?:bearer\s+|authorization|api[_ -]?key|credential|secret|session[_ -]?id|\/Users\/|\\Users\\|\.codex|\.claude)/i;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safe(value: unknown): boolean {
  if (typeof value === 'string') return value.length <= 16_000 && !UNSAFE_TEXT.test(value);
  if (Array.isArray(value)) return value.every(safe);
  const record = object(value);
  return record === undefined ? value === null || typeof value === 'boolean' || typeof value === 'number' : Object.values(record).every(safe);
}

function finding(value: unknown): GMFinding | undefined {
  const candidate = object(value);
  if (candidate?.format !== 'faktori.gm-finding/v1' || typeof candidate.findingId !== 'string' || typeof candidate.findingKey !== 'string'
    || typeof candidate.factoryId !== 'string' || typeof candidate.category !== 'string' || !safe(candidate)) return undefined;
  return candidate as unknown as GMFinding;
}

function proposal(value: unknown): GMImprovementProposal | undefined {
  const candidate = object(value);
  if (candidate?.format !== 'faktori.gm-improvement/v1' || typeof candidate.proposalId !== 'string' || typeof candidate.findingId !== 'string'
    || candidate.status !== 'proposed' || candidate.authority !== 'requires_approval' || !safe(candidate)) return undefined;
  return candidate as unknown as GMImprovementProposal;
}

/** Read-only current GM projection, rebuilt entirely from coordinator journal records. */
export function coordinatorGMState(coordinator: DurableCoordinator): { findings: GMFinding[]; improvements: GMImprovementProposal[] } {
  const findings = new Map<string, GMFinding>();
  const improvements = new Map<string, GMImprovementProposal>();
  for (const event of coordinator.journal.events()) {
    if (event.kind === 'gm.finding.upserted') {
      const parsed = finding(event.data.finding);
      if (parsed !== undefined) findings.set(parsed.findingKey, structuredClone(parsed));
    }
    if (event.kind === 'gm.improvement.proposed') {
      const parsed = proposal(event.data.proposal);
      if (parsed !== undefined) improvements.set(parsed.proposalId, structuredClone(parsed));
    }
  }
  return { findings: [...findings.values()], improvements: [...improvements.values()] };
}

/** Durable GM store backed by the same append-only coordinator journal as runs and actions. */
export class CoordinatorGMStore implements DurableGMStore {
  readonly #coordinator: DurableCoordinator;

  constructor(coordinator: DurableCoordinator) { this.#coordinator = coordinator; }

  async findingByKey(key: string): Promise<GMFinding | undefined> {
    return coordinatorGMState(this.#coordinator).findings.find((item) => item.findingKey === key);
  }

  async upsertFinding(value: GMFinding): Promise<void> {
    const parsed = finding(value);
    if (parsed === undefined || parsed.factoryId !== this.#coordinator.factoryId) throw new Error('GM finding is invalid, unsafe, or belongs to another factory');
    await this.#coordinator.record('gm.finding.upserted', this.#coordinator.factoryId, { finding: parsed });
  }

  async appendImprovement(value: GMImprovementProposal): Promise<void> {
    const parsed = proposal(value);
    if (parsed === undefined) throw new Error('GM improvement proposal is invalid or unsafe');
    const existing = coordinatorGMState(this.#coordinator).improvements.find((item) => item.proposalId === parsed.proposalId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(parsed)) throw new Error('GM improvement proposal id conflicts with a different durable proposal');
      return;
    }
    await this.#coordinator.record('gm.improvement.proposed', this.#coordinator.factoryId, { proposal: parsed });
  }
}
