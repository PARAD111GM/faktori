// Hierarchy input is untrusted JSON; these are the durable normalized contracts.
type Issue = { path: string; message: string };
type InputRecord = Record<string, unknown>;
type SourceOptions = { approved?: boolean; refinement?: boolean };
type InternalNode = Omit<HierarchyNode, 'kind' | 'constraints' | 'designReferences'> & { kind: HierarchyNodeKind | undefined; constraints: Constraint[]; designReferences: Array<SourceRecord & Partial<ApprovedDesignReference>>; path: string };
type InternalDependency = DependencyLink & { path: string };
export type HierarchyNodeKind = 'planning' | 'executable';
export interface SourceRecord { id: string; text: string; revision: string; }
export interface Constraint extends SourceRecord { refinesConstraintId?: string; }
export interface ApprovedDesignReference extends SourceRecord { approved: true; }
export interface CommandRecord { command: string; revision: string; }
export interface HierarchyNode { id: string; kind: HierarchyNodeKind; label: string; parentId?: string; objective: SourceRecord; criteria: SourceRecord[]; constraints?: Constraint[]; designReferences: ApprovedDesignReference[]; artifacts: SourceRecord[]; commands: CommandRecord[]; authority: SourceRecord[]; evidenceRequirements: SourceRecord[]; }
export interface DependencyLink { id: string; fromId: string; toId: string; contract: SourceRecord; }
export interface HierarchyDocument { revision: string; globalConstraints: SourceRecord[]; nodes: HierarchyNode[]; dependencies: DependencyLink[]; }
export interface PacketSource extends SourceRecord { sourceNodeId: string; sourceRevision: string; }
export interface ContextPacket { hierarchyRevision: string; node: Pick<HierarchyNode, 'id' | 'kind' | 'label' | 'parentId'>; objective: PacketSource; criteria: PacketSource[]; constraints: { global: PacketSource[]; ancestors: PacketSource[]; local: PacketSource[] }; dependencyContracts: Array<{ id: string; dependsOnNodeId: string; contract: PacketSource }>; designReferences: PacketSource[]; artifacts: PacketSource[]; commands: Array<CommandRecord & { sourceNodeId: string; sourceRevision: string }>; authority: PacketSource[]; evidenceRequirements: PacketSource[]; }

const NODE_KINDS = new Set(['planning', 'executable']);

/** Error with all actionable hierarchy-validation issues. */
export class HierarchyValidationError extends Error {
  issues: Issue[];
  /** @param {{ path: string, message: string }[]} issues */
  constructor(issues: Issue[]) {
    super(`Invalid hierarchy:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'HierarchyValidationError';
    this.issues = issues;
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value: unknown): value is InputRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {string} key */
function hasOwn(value: InputRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** @param {{ path: string, message: string }[]} issues @param {string} path @param {string} message */
function issue(issues: Issue[], path: string, message: string): void {
  issues.push({ path, message });
}

/** @param {unknown} value @param {string} path @param {{ path: string, message: string }[]} issues */
function record(value: unknown, path: string, issues: Issue[]): InputRecord {
  if (isRecord(value)) return value;
  issue(issues, path, 'must be an object');
  return {};
}

/** @param {Record<string, unknown>} value @param {Set<string>} keys @param {string} path @param {{ path: string, message: string }[]} issues */
function rejectUnknownKeys(value: InputRecord, keys: Set<string>, path: string, issues: Issue[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) issue(issues, `${path}.${key}`, 'is not a supported setting');
  }
}

/** @param {unknown} value @param {string} path @param {{ path: string, message: string }[]} issues */
function requiredString(value: unknown, path: string, issues: Issue[]): string {
  if (typeof value !== 'string' || value.length === 0) {
    issue(issues, path, 'must be a non-empty string');
    return '';
  }
  return value;
}

/** @param {unknown} value @param {string} path @param {{ path: string, message: string }[]} issues @param {{ approved?: boolean, refinement?: boolean }} [options] */
function sourceRecord(value: unknown, path: string, issues: Issue[], options: SourceOptions = {}): SourceRecord & Partial<ApprovedDesignReference & Constraint> {
  const source = record(value, path, issues);
  const keys = new Set(['id', 'text', 'revision']);
  if (options.approved) keys.add('approved');
  if (options.refinement) keys.add('refinesConstraintId');
  rejectUnknownKeys(source, keys, path, issues);
  const id = requiredString(source.id, `${path}.id`, issues);
  const text = requiredString(source.text, `${path}.text`, issues);
  const revision = requiredString(source.revision, `${path}.revision`, issues);
  let approved: true | undefined;
  if (options.approved) {
    if (source.approved !== true) issue(issues, `${path}.approved`, 'must be true; unapproved design references cannot enter a context packet');
    approved = true;
  }
  let refinesConstraintId: string | undefined;
  if (options.refinement && hasOwn(source, 'refinesConstraintId')) {
    refinesConstraintId = requiredString(source.refinesConstraintId, `${path}.refinesConstraintId`, issues);
  }
  return { id, text, revision, ...(options.approved ? { approved } : {}), ...(options.refinement && refinesConstraintId ? { refinesConstraintId } : {}) };
}

/** @param {unknown} value @param {string} path @param {{ path: string, message: string }[]} issues @param {{ approved?: boolean, refinement?: boolean }} [options] */
function sourceArray(value: unknown, path: string, issues: Issue[], options: SourceOptions = {}): Array<SourceRecord & Partial<ApprovedDesignReference & Constraint>> {
  if (!Array.isArray(value)) {
    issue(issues, path, 'must be an array');
    return [];
  }
  return value.map((entry, index) => sourceRecord(entry, `${path}[${index}]`, issues, options));
}

/** @param {unknown} value @param {string} path @param {{ path: string, message: string }[]} issues */
function commands(value: unknown, path: string, issues: Issue[]): CommandRecord[] {
  if (!Array.isArray(value)) {
    issue(issues, path, 'must be an array');
    return [];
  }
  return value.map((entry, index) => {
    const command = record(entry, `${path}[${index}]`, issues);
    rejectUnknownKeys(command, new Set(['command', 'revision']), `${path}[${index}]`, issues);
    return {
      command: requiredString(command.command, `${path}[${index}].command`, issues),
      revision: requiredString(command.revision, `${path}[${index}].revision`, issues),
    };
  });
}

/** @param {string} startId @param {Map<string, { parentId?: string }>} nodes */
function ancestorIds(startId: string, nodes: Map<string, { parentId?: string }>): string[] {
  const ids = [];
  const seen = new Set([startId]);
  let parentId = nodes.get(startId)?.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    ids.unshift(parentId);
    parentId = nodes.get(parentId)?.parentId;
  }
  return ids;
}

/** @param {Map<string, { id?: string, parentId?: string, path: string }>} nodes @param {{ path: string, message: string }[]} issues */
function rejectParentCycles(nodes: Map<string, InternalNode>, issues: Issue[]): void {
  const visited = new Set();
  const visiting = new Set();
  const stack: string[] = [];
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    stack.push(id);
    const parentId = nodes.get(id)?.parentId;
    if (parentId && nodes.has(parentId)) {
      if (visiting.has(parentId)) {
        const start = stack.indexOf(parentId);
        const cycle = [...stack.slice(start), parentId];
        const closingNode = nodes.get(parentId);
        if (closingNode) issue(issues, `${closingNode.path}.parentId`, `introduces a parent cycle ${cycle.join(' -> ')}`);
      } else visit(parentId);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of nodes.keys()) visit(id);
}

/** @param {{ id?: string, fromId?: string, toId?: string, path: string }[]} dependencies @param {Set<string>} nodeIds @param {{ path: string, message: string }[]} issues */
function rejectDependencyCycles(dependencies: InternalDependency[], nodeIds: Set<string>, issues: Issue[]): void {
  const outgoing = new Map();
  for (const dependency of dependencies) {
    if (!dependency.fromId || !dependency.toId || !nodeIds.has(dependency.fromId) || !nodeIds.has(dependency.toId)) continue;
    const existing = outgoing.get(dependency.fromId) ?? [];
    existing.push(dependency);
    outgoing.set(dependency.fromId, existing);
  }
  const visited = new Set();
  const visiting = new Set();
  const stack: string[] = [];
  function visit(nodeId: string): void {
    if (visited.has(nodeId) || visiting.has(nodeId)) return;
    visiting.add(nodeId);
    stack.push(nodeId);
    for (const dependency of outgoing.get(nodeId) ?? []) {
      if (visiting.has(dependency.toId)) {
        const start = stack.indexOf(dependency.toId);
        const cycleTail = [...stack.slice(start), dependency.toId];
        const cycle = [nodeId, ...cycleTail.slice(0, -1), nodeId];
        issue(issues, `${dependency.path}.toId`, `introduces a dependency cycle ${cycle.join(' -> ')}`);
      } else visit(dependency.toId);
    }
    stack.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
  }
  for (const nodeId of nodeIds) visit(nodeId);
}

/** @param {Record<string, unknown>} source @param {string} sourceNodeId */
function packetSource(source: SourceRecord, sourceNodeId: string): PacketSource {
  return { ...source, sourceNodeId, sourceRevision: source.revision };
}

/**
 * Validate the durable, versioned work hierarchy. Node kind is structural and
 * cannot be inferred from a user-facing label.
 *
 * @param {unknown} document
 */
export function validateHierarchy(document: unknown): HierarchyDocument;
export function validateHierarchy(document: unknown): HierarchyDocument {
  const issues: Issue[] = [];
  const input = record(document, 'hierarchy', issues);
  rejectUnknownKeys(input, new Set(['revision', 'globalConstraints', 'nodes', 'dependencies']), 'hierarchy', issues);
  const revision = requiredString(input.revision, 'revision', issues);
  const globalConstraints = sourceArray(input.globalConstraints, 'globalConstraints', issues);
  const nodeValues = Array.isArray(input.nodes) ? input.nodes : [];
  if (!Array.isArray(input.nodes) || nodeValues.length === 0) issue(issues, 'nodes', 'must be a non-empty array');

  const nodes: InternalNode[] = [];
  const nodeMap = new Map<string, InternalNode>();
  nodeValues.forEach((value, index) => {
    const path = `nodes[${index}]`;
    const node = record(value, path, issues);
    rejectUnknownKeys(node, new Set(['id', 'kind', 'label', 'parentId', 'objective', 'criteria', 'constraints', 'designReferences', 'artifacts', 'commands', 'authority', 'evidenceRequirements']), path, issues);
    const id = requiredString(node.id, `${path}.id`, issues);
    if (typeof node.kind !== 'string' || !NODE_KINDS.has(node.kind)) issue(issues, `${path}.kind`, 'must be "planning" or "executable"');
    const kind: HierarchyNodeKind | undefined = node.kind === 'planning' || node.kind === 'executable' ? node.kind : undefined;
    const label = requiredString(node.label, `${path}.label`, issues);
    let parentId = undefined;
    if (hasOwn(node, 'parentId')) parentId = requiredString(node.parentId, `${path}.parentId`, issues);
    const normalized = {
      id,
      kind,
      label,
      parentId,
      objective: sourceRecord(node.objective, `${path}.objective`, issues),
      criteria: sourceArray(node.criteria, `${path}.criteria`, issues),
      constraints: sourceArray(node.constraints ?? [], `${path}.constraints`, issues, { refinement: true }),
      designReferences: sourceArray(node.designReferences, `${path}.designReferences`, issues, { approved: true }),
      artifacts: sourceArray(node.artifacts, `${path}.artifacts`, issues),
      commands: commands(node.commands, `${path}.commands`, issues),
      authority: sourceArray(node.authority, `${path}.authority`, issues),
      evidenceRequirements: sourceArray(node.evidenceRequirements, `${path}.evidenceRequirements`, issues),
      path,
    };
    if (id) {
      if (nodeMap.has(id)) issue(issues, `${path}.id`, `duplicates node "${id}"`);
      else nodeMap.set(id, normalized);
    }
    nodes.push(normalized);
  });

  for (const node of nodes) {
    if (node.parentId && !nodeMap.has(node.parentId)) issue(issues, `${node.path}.parentId`, `unknown node "${node.parentId}"`);
  }
  rejectParentCycles(nodeMap, issues);

  for (const node of nodes) {
    if (!node.id) continue;
    const ancestorConstraintIds = new Set();
    for (const ancestorId of ancestorIds(node.id, nodeMap)) {
      for (const constraint of nodeMap.get(ancestorId)?.constraints ?? []) ancestorConstraintIds.add(constraint.id);
    }
    node.constraints.forEach((constraint, index) => {
      const path = `${node.path}.constraints[${index}]`;
      if (constraint.id && ancestorConstraintIds.has(constraint.id)) {
        issue(issues, `${path}.id`, `cannot redefine accepted ancestor constraint "${constraint.id}"`);
      }
      if (constraint.refinesConstraintId && !ancestorConstraintIds.has(constraint.refinesConstraintId)) {
        issue(issues, `${path}.refinesConstraintId`, `must reference an accepted ancestor constraint, not "${constraint.refinesConstraintId}"`);
      }
    });
  }

  const dependencyValues = Array.isArray(input.dependencies) ? input.dependencies : [];
  if (!Array.isArray(input.dependencies)) issue(issues, 'dependencies', 'must be an array');
  const dependencyIds = new Set<string>();
  const dependencies = dependencyValues.map((value, index) => {
    const path = `dependencies[${index}]`;
    const dependency = record(value, path, issues);
    rejectUnknownKeys(dependency, new Set(['id', 'fromId', 'toId', 'contract']), path, issues);
    const id = requiredString(dependency.id, `${path}.id`, issues);
    const fromId = requiredString(dependency.fromId, `${path}.fromId`, issues);
    const toId = requiredString(dependency.toId, `${path}.toId`, issues);
    const contract = sourceRecord(dependency.contract, `${path}.contract`, issues);
    if (id) {
      if (dependencyIds.has(id)) issue(issues, `${path}.id`, `duplicates dependency "${id}"`);
      dependencyIds.add(id);
    }
    if (fromId && !nodeMap.has(fromId)) issue(issues, `${path}.fromId`, `unknown node "${fromId}"`);
    if (toId && !nodeMap.has(toId)) issue(issues, `${path}.toId`, `unknown node "${toId}"`);
    if (fromId && toId && fromId === toId) issue(issues, `${path}.toId`, 'cannot depend on the same node');
    return { id, fromId, toId, contract, path };
  });
  rejectDependencyCycles(dependencies, new Set(nodeMap.keys()), issues);

  if (issues.length > 0) throw new HierarchyValidationError(issues);
  return {
    revision,
    globalConstraints,
    nodes: nodes.filter((node): node is InternalNode & { kind: HierarchyNodeKind; designReferences: ApprovedDesignReference[] } => node.kind !== undefined && node.designReferences.every((reference) => reference.approved === true)).map(({ path, ...node }) => node),
    dependencies: dependencies.map(({ path, ...dependency }) => dependency),
  };
}

/**
 * Return the smallest context packet needed by a node. Sibling material appears
 * only as the contract on a declared dependency, never as that sibling's packet.
 *
 * @param {unknown} document
 * @param {string} nodeId
 */
export function assembleContextPacket(document: unknown, nodeId: string): ContextPacket;
export function assembleContextPacket(document: unknown, nodeId: string) {
  const hierarchy = validateHierarchy(document);
  const node = hierarchy.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new HierarchyValidationError([{ path: 'nodeId', message: `unknown node "${nodeId}"` }]);
  const nodes = new Map(hierarchy.nodes.map((candidate) => [candidate.id, candidate]));
  const ancestors = ancestorIds(nodeId, nodes).map((ancestorId) => nodes.get(ancestorId)).filter((ancestor): ancestor is HierarchyNode => ancestor !== undefined);
  const lineage = [...ancestors, node];
  const ancestorConstraints = ancestors.flatMap((ancestor) => (ancestor.constraints ?? []).map((constraint) => packetSource(constraint, ancestor.id)));
  const approvedDesignReferences = lineage
    .flatMap((candidate) => candidate.designReferences.map((reference) => packetSource(reference, candidate.id)));
  const dependencyContracts = hierarchy.dependencies
    .filter((dependency) => dependency.fromId === nodeId)
    .map((dependency) => ({
      id: dependency.id,
      dependsOnNodeId: dependency.toId,
      contract: packetSource(dependency.contract, dependency.toId),
    }));

  return {
    hierarchyRevision: hierarchy.revision,
    node: { id: node.id, kind: node.kind, label: node.label, parentId: node.parentId },
    objective: packetSource(node.objective, node.id),
    criteria: node.criteria.map((criterion) => packetSource(criterion, node.id)),
    constraints: {
      global: hierarchy.globalConstraints.map((constraint) => packetSource(constraint, 'global')),
      ancestors: ancestorConstraints,
      local: (node.constraints ?? []).map((constraint) => packetSource(constraint, node.id)),
    },
    dependencyContracts,
    designReferences: approvedDesignReferences,
    artifacts: lineage.flatMap((candidate) => candidate.artifacts.map((artifact) => packetSource(artifact, candidate.id))),
    commands: lineage.flatMap((candidate) => candidate.commands.map((command) => ({ ...command, sourceNodeId: candidate.id, sourceRevision: command.revision }))),
    authority: lineage.flatMap((candidate) => candidate.authority.map((authority) => packetSource(authority, candidate.id))),
    evidenceRequirements: lineage.flatMap((candidate) => candidate.evidenceRequirements.map((evidence) => packetSource(evidence, candidate.id))),
  };
}
