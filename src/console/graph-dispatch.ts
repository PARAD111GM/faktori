import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { planGraphDelivery, type GraphDeliveryInput } from '../integrations/delivery-graph.ts';
import type { ManagerConnectedStore } from '../manager-connected/index.ts';
import { readSprintReadiness } from '../sprint/readiness.ts';
import { validateWorkScope, type ScopedWorkAssignment, type WorkCatalog } from './work-management.ts';

const MAX_PACKET_BYTES = 1024 * 1024;

export interface GraphDispatchConfiguration { path: string; readinessPath: string; }

interface FrontierAssignment {
  nodeId: string;
  sessionId: string;
  scope: ScopedWorkAssignment;
  title: string;
  instruction: string;
}

interface GraphDispatchPacket {
  format: 'faktori.graph-dispatch/v1';
  sprintRevision: string;
  catalogRevision: string;
  graph: GraphDeliveryInput;
  assignments: FrontierAssignment[];
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}_invalid`);
  return value as Record<string, unknown>;
}
function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`${field}_invalid`);
  return value;
}
function exact(input: Record<string, unknown>, keys: readonly string[], field: string): void {
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))) throw new Error(`${field}_invalid`);
}

/** Reads controller files fail-closed; neither browser input nor symlinks select them. */
async function privateJson(path: string, field: string): Promise<{ value: unknown; bytes: Buffer }> {
  if (!isAbsolute(path)) throw new Error(`${field}_path_invalid`);
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_PACKET_BYTES || (details.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && details.uid !== process.getuid())) throw new Error(`${field}_unsafe`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PACKET_BYTES || stat.dev !== details.dev || stat.ino !== details.ino) throw new Error(`${field}_changed`);
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) throw new Error(`${field}_changed`);
    return { value: JSON.parse(bytes.toString('utf8')) as unknown, bytes };
  } finally { await handle.close(); }
}

function packet(value: unknown): GraphDispatchPacket {
  const input = record(value, 'graph_dispatch_packet');
  exact(input, ['format', 'sprintRevision', 'catalogRevision', 'graph', 'assignments'], 'graph_dispatch_packet');
  if (input.format !== 'faktori.graph-dispatch/v1') throw new Error('graph_dispatch_packet_invalid');
  if (!Array.isArray(input.assignments) || input.assignments.length === 0 || input.assignments.length > 256) throw new Error('graph_dispatch_packet_invalid');
  const assignments = input.assignments.map((item, index) => {
    const mapping = record(item, `graph_dispatch_assignment_${index}`);
    exact(mapping, ['nodeId', 'sessionId', 'scope', 'title', 'instruction'], `graph_dispatch_assignment_${index}`);
    return { nodeId: boundedText(mapping.nodeId, 'nodeId', 128), sessionId: boundedText(mapping.sessionId, 'sessionId', 128),
      scope: mapping.scope as ScopedWorkAssignment, title: boundedText(mapping.title, 'title', 256), instruction: boundedText(mapping.instruction, 'instruction', 16_000) };
  });
  if (new Set(assignments.map(item => item.nodeId)).size !== assignments.length) throw new Error('graph_dispatch_assignment_duplicate');
  return { format: input.format, sprintRevision: boundedText(input.sprintRevision, 'sprintRevision', 256),
    catalogRevision: boundedText(input.catalogRevision, 'catalogRevision', 128), graph: input.graph as GraphDeliveryInput, assignments };
}

function stableRequestId(graphRevision: string, sprintBinding: string, ticketKey: string, sessionId: string, context: unknown): string {
  return `graph-${createHash('sha256').update(JSON.stringify({ graphRevision, sprintBinding, ticketKey, sessionId, context })).digest('hex').slice(0, 48)}`;
}

export interface GraphDispatchResult {
  enqueued: number;
  duplicate: number;
  receipts: Array<{ nodeId: string; requestId: string; status: 'enqueued' | 'duplicate' | 'failed'; detail?: string }>;
}

export interface GraphDispatchOptions { reconcileExisting?: boolean; }

function sameScope(left: ScopedWorkAssignment | undefined, right: ScopedWorkAssignment): boolean {
  return left?.productId === right.productId && left.planId === right.planId && left.phaseId === right.phaseId && left.ticketId === right.ticketId;
}

function mappedTicket(catalog: WorkCatalog, scope: ScopedWorkAssignment, ticketKey: string): boolean {
  const ticket = catalog.projects.find(project => project.productId === scope.productId)?.plans.find(plan => plan.id === scope.planId)
    ?.phases.find(phase => phase.id === scope.phaseId)?.tickets.find(candidate => candidate.id === scope.ticketId);
  return ticket !== undefined && (ticketKey === ticket.id || ticketKey === ticket.issueKey);
}

/**
 * Applies only live relay reservation state to a cloned graph input. It never
 * turns a report into dependency/acceptance evidence and never changes packet
 * bytes, context, or the readiness binding used for durable enqueue.
 */
function overlayRelayState(input: GraphDeliveryInput, assignments: readonly FrontierAssignment[], catalog: WorkCatalog, catalogRevision: string, store: ManagerConnectedStore): GraphDeliveryInput {
  const graph = structuredClone(input);
  const byNode = new Map(assignments.map(assignment => [assignment.nodeId, assignment]));
  const active = new Set<string>();
  const terminal = new Set<string>();
  for (const request of store.snapshot().requests) {
    if (!request.scope) continue;
    const registration = graph.registrations.find(candidate => {
      const assignment = byNode.get(candidate.nodeId);
      if (!assignment) return false;
      let scope: ScopedWorkAssignment;
      try { scope = validateWorkScope(catalog, assignment.scope); } catch { return false; }
      const session = store.snapshot().sessions.find(candidateSession => candidateSession.id === assignment.sessionId);
      return mappedTicket(catalog, scope, candidate.delivery.ticket.key)
        && session !== undefined && session.productId === scope.productId && session.planId === scope.planId && session.phaseId === scope.phaseId && session.ticketId === scope.ticketId
        && request.sessionId === assignment.sessionId && request.assignment.productId === session.productId && request.assignment.planId === session.planId
        && request.assignment.phaseId === session.phaseId && request.assignment.ticketId === session.ticketId && sameScope(request.scope, scope);
    });
    const coding = /^(builder|implementer)$/i.test(request.assignment.role);
    if (!registration) {
      if (coding && ['queued', 'claimed', 'submitted', 'uncertain'].includes(request.status)) throw new Error('graph_relay_reconciliation_required');
      continue;
    }
    if (['queued', 'claimed', 'submitted', 'uncertain'].includes(request.status)) active.add(registration.nodeId);
    else if (request.status === 'completed' || request.status === 'cancelled') terminal.add(registration.nodeId);
  }
  for (const registration of graph.registrations) {
    if (active.has(registration.nodeId)) registration.delivery.ticket.workState = 'coding';
    else if (terminal.has(registration.nodeId)) registration.delivery.ticket.workState = 'review';
  }
  return graph;
}

export async function enqueueGraphFrontier(configuration: GraphDispatchConfiguration, catalog: WorkCatalog, catalogRevision: string, store: ManagerConnectedStore, catalogPath: string, options: GraphDispatchOptions = {}): Promise<GraphDispatchResult> {
  const packetFile = await privateJson(configuration.path, 'graph_dispatch_packet');
  const input = packet(packetFile.value);
  if (input.catalogRevision !== catalogRevision) throw new Error('catalog_revision_conflict');
  const readinessFile = await privateJson(configuration.readinessPath, 'sprint_readiness');
  const readiness = record(readinessFile.value, 'sprint_readiness');
  if (readiness.revision !== input.sprintRevision || !Array.isArray(readiness.artifactBindings)) throw new Error('sprint_readiness_binding_missing');
  // The same artifact verification runs at claim, even if the observer has not
  // refreshed yet. Reapproving new catalog bytes changes the queued binding too.
  if (!isAbsolute(catalogPath) || !readiness.artifactBindings.some(value => {
    const binding = value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    return binding?.path === resolve(catalogPath) && binding.sha256 === catalogRevision;
  })) throw new Error('graph_dispatch_catalog_not_readiness_bound');
  const packetPath = resolve(configuration.path);
  const packetDigest = createHash('sha256').update(packetFile.bytes).digest('hex');
  if (!readiness.artifactBindings.some(value => { const binding = value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    return binding?.path === packetPath && binding.sha256 === packetDigest; })) throw new Error('graph_dispatch_packet_not_readiness_bound');
  const readinessReport = await readSprintReadiness(configuration.readinessPath, undefined, store.snapshot().manager.threadId);
  if (!readinessReport.ready || readinessReport.revision !== input.sprintRevision) throw new Error('sprint_admission_blocked');
  const readinessDigest = createHash('sha256').update(readinessFile.bytes).digest('hex');
  if (readinessReport.bindingDigest !== readinessDigest) throw new Error('sprint_readiness_changed');
  // Reject a packet replacement racing readiness validation; its changed digest
  // must be issued through a new readiness revision rather than selecting old work.
  const afterReadiness = await privateJson(configuration.path, 'graph_dispatch_packet');
  if (!afterReadiness.bytes.equals(packetFile.bytes)) throw new Error('graph_dispatch_packet_changed');
  const graph = options.reconcileExisting ? overlayRelayState(input.graph, input.assignments, catalog, input.catalogRevision, store) : input.graph;
  const plan = planGraphDelivery(graph);
  if (plan.graphRevision !== input.sprintRevision) throw new Error('graph_revision_sprint_revision_mismatch');
  const assignments = new Map(input.assignments.map(item => [item.nodeId, item]));
  if (plan.frontier.some(item => !assignments.has(item.nodeId))) throw new Error('graph_frontier_assignment_missing');
  // Validate the entire selected frontier before the first durable queue write.
  const prepared = plan.frontier.map(item => {
    const assignment = assignments.get(item.nodeId)!;
    const scope = validateWorkScope(catalog, assignment.scope);
    const ticket = catalog.projects.find(project => project.productId === scope.productId)?.plans.find(plan => plan.id === scope.planId)
      ?.phases.find(phase => phase.id === scope.phaseId)?.tickets.find(candidate => candidate.id === scope.ticketId);
    if (!ticket || (item.ticketKey !== ticket.id && item.ticketKey !== ticket.issueKey)) throw new Error('graph_ticket_scope_mismatch');
    const session = store.snapshot().sessions.find(candidate => candidate.id === assignment.sessionId);
    if (!session || session.productId !== scope.productId || session.planId !== scope.planId || session.phaseId !== scope.phaseId || session.ticketId !== scope.ticketId) throw new Error('session_scope_mismatch');
    const context = JSON.stringify(item.context);
    if (context.length > 12_000) throw new Error('graph_context_too_large');
    const instruction = `${assignment.instruction}\n\nApproved graph context:\n${context}`;
    if (instruction.length > 16_000) throw new Error('graph_instruction_too_large');
    return { item, assignment, scope, instruction, requestId: stableRequestId(plan.graphRevision, readinessReport.bindingDigest!, item.ticketKey, assignment.sessionId, item.context) };
  });
  let enqueued = 0; let duplicate = 0;
  const receipts: GraphDispatchResult['receipts'] = [];
  for (const preparedItem of prepared) {
    try {
      const result = await store.operate({ type: 'enqueue', id: preparedItem.requestId, sessionId: preparedItem.assignment.sessionId,
        title: preparedItem.assignment.title, instruction: preparedItem.instruction, catalogRevision: input.catalogRevision, scope: preparedItem.scope,
        expectedSprintBinding: readinessReport.bindingDigest });
      if (result.type !== 'enqueue') throw new Error('graph_dispatch_enqueue_failed');
      if (result.duplicate) { duplicate += 1; receipts.push({ nodeId: preparedItem.item.nodeId, requestId: preparedItem.requestId, status: 'duplicate' }); }
      else { enqueued += 1; receipts.push({ nodeId: preparedItem.item.nodeId, requestId: preparedItem.requestId, status: 'enqueued' }); }
    } catch (error) {
      receipts.push({ nodeId: preparedItem.item.nodeId, requestId: preparedItem.requestId, status: 'failed', detail: error instanceof Error ? error.message : 'enqueue_failed' });
      break;
    }
  }
  return { enqueued, duplicate, receipts };
}
