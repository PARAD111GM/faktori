import { createHash } from 'node:crypto';
import { assembleContextPacket, validateHierarchy, type HierarchyDocument, type ContextPacket } from '../context/index.ts';
import { planDeliverySynchronization, type RegisteredDelivery, type DeliverySyncPlan, type DeliverySyncPolicy, type DiscoveredJiraTransition } from './delivery-sync.ts';

export interface DependencyObservation {
  edgeId: string;
  /** Digest binds the contract and upstream context, not a Jira status name. */
  dependencyDigest: string;
  state: 'satisfied' | 'unsatisfied' | 'unknown';
  evidence: string;
}
export interface GraphDeliveryInput {
  hierarchy: unknown;
  registrations: Array<{ nodeId: string; delivery: RegisteredDelivery }>;
  observations: DependencyObservation[];
  policy: DeliverySyncPolicy;
  transitionsByTicket: Readonly<Record<string, readonly DiscoveredJiraTransition[]>>;
}

/** Includes upstream lineage and declared contracts, excludes unrelated siblings. */
export function dependencyEvidenceDigest(hierarchyInput: unknown, edgeId: string): string {
  const hierarchy = validateHierarchy(hierarchyInput);
  return digestEdge(hierarchy, edgeId);
}
function digestEdge(hierarchy: HierarchyDocument, edgeId: string): string {
  const edge = hierarchy.dependencies.find(e => e.id === edgeId);
  if (!edge) throw new Error('Dependency observation references an unknown edge');
  const memo = new Map<string, string>();
  const upstreamDigest = (id: string): string => {
    const prior = memo.get(id); if (prior) return prior;
    const { hierarchyRevision: _revision, ...context } = assembleContextPacket(hierarchy, id);
    const inputs = hierarchy.dependencies.filter(e => e.fromId === id).sort((a, b) => a.id.localeCompare(b.id))
      .map(e => ({ edge: e, upstream: upstreamDigest(e.toId) }));
    const result = hash({ context, inputs }); memo.set(id, result); return result;
  };
  return hash({ edge, upstream: upstreamDigest(edge.toId) });
}
function hash(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

/**
 * Graph-backed read-only planning. The hierarchy is the dependency authority;
 * Jira rank only orders the resulting frontier. Observations are controller
 * evidence references, not agent claims of completion. No inference or effects.
 */
export function planGraphDelivery(input: GraphDeliveryInput): DeliverySyncPlan & {
  graphRevision: string; frontier: Array<{ nodeId: string; ticketKey: string; context: ContextPacket }>;
  blockedEdges: Array<{ nodeId: string; edgeId: string; reason: string }>;
} {
  const hierarchy = validateHierarchy(input.hierarchy);
  if (!Array.isArray(input.registrations) || input.registrations.length > 1000 || !Array.isArray(input.observations) || input.observations.length > 5000)
    throw new Error('Graph delivery registrations and observations must be bounded arrays');
  const nodes = new Map(hierarchy.nodes.map(n => [n.id, n]));
  const registered = new Map<string, string>();
  for (const entry of input.registrations) {
    if (nodes.get(entry.nodeId)?.kind !== 'executable' || registered.has(entry.nodeId)) throw new Error('Every registered ticket must map to one unique executable graph node');
    registered.set(entry.nodeId, entry.delivery.ticket.key);
  }
  if (new Set(registered.values()).size !== registered.size) throw new Error('A ticket cannot map to multiple graph nodes');
  const blockedEdges: Array<{ nodeId: string; edgeId: string; reason: string }> = [];
  const deliveries = input.registrations.map(({ nodeId, delivery }): RegisteredDelivery => {
    const dependencies = hierarchy.dependencies.filter(e => e.fromId === nodeId).map(edge => {
      const observations = input.observations.filter(o => o.edgeId === edge.id);
      const observation = observations[0];
      const satisfied = observations.length === 1 && observation?.state === 'satisfied'
        && typeof observation.evidence === 'string' && observation.evidence.trim().length > 0
        && observation.dependencyDigest === digestEdge(hierarchy, edge.id);
      if (!satisfied) blockedEdges.push({ nodeId, edgeId: edge.id, reason: 'dependency_evidence_missing_ambiguous_or_changed' });
      return { key: registered.get(edge.toId) ?? edge.toId, state: satisfied ? 'resolved' as const : 'unknown' as const };
    });
    // A newly observed Jira blocker cannot disappear just because the graph
    // projection has not caught up. Stop that node until its edges reconcile.
    for (const dependency of delivery.ticket.dependencies) {
      const existing = dependencies.find(d => d.key === dependency.key);
      if (!existing) {
        dependencies.push({ key: dependency.key, state: 'unknown' });
        blockedEdges.push({ nodeId, edgeId: dependency.key, reason: 'tracker_dependency_missing_from_graph' });
      } else if (dependency.state !== 'resolved') {
        existing.state = 'unknown';
        blockedEdges.push({ nodeId, edgeId: dependency.key, reason: 'tracker_dependency_not_resolved' });
      }
    }
    // Flat status flags never override revision-bound graph evidence.
    return { ...delivery, ticket: { ...delivery.ticket, dependencies } };
  });
  const plan = planDeliverySynchronization({ deliveries, policy: input.policy, transitionsByTicket: input.transitionsByTicket });
  const blockedNodes = new Set(blockedEdges.map(e => e.nodeId));
  const blockedTickets = new Set(input.registrations.filter(r => blockedNodes.has(r.nodeId)).map(r => r.delivery.ticket.key));
  const selected = new Set(plan.coding.selected);
  return { ...plan, instructions: plan.instructions.map(instruction => instruction.kind === 'transition' && blockedTickets.has(instruction.ticketKey)
      ? { id: instruction.id, kind: 'blocked' as const, ticketKey: instruction.ticketKey, repository: instruction.repository, reason: 'graph_dependency_evidence_not_satisfied' }
      : instruction), graphRevision: hierarchy.revision, blockedEdges,
    frontier: input.registrations.filter(r => selected.has(r.delivery.ticket.key)).map(r => ({
      nodeId: r.nodeId, ticketKey: r.delivery.ticket.key, context: assembleContextPacket(hierarchy, r.nodeId),
    })) };
}
