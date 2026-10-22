import { createHash } from 'node:crypto';

export type SpikeResourceKind = 'workspace' | 'provider' | 'deployment' | 'database' | 'verification' | 'incident';
export type SpikeResourceStatus = 'unknown' | 'proposed' | 'owner_selected';

export interface AttendedSpikeResource {
  kind: SpikeResourceKind;
  status: SpikeResourceStatus;
  reference?: string;
}

export interface AttendedSpikeRequest {
  format: 'faktori.attended-spike-request/v1';
  spikeId: string;
  rawIdea?: string;
  ownerId?: string;
  constraints?: string[];
  resources?: AttendedSpikeResource[];
}

const stages = [
  { id: 'requirements_discovery', skill: 'interview', requiredArtifacts: ['owner-authored-raw-idea', 'discovery-decisions'], requiredEvidence: ['owner-confirmed-requirements'] },
  { id: 'shaping', skill: 'shaping', requiredArtifacts: ['shaped-outcome', 'scope-and-non-goals'], requiredEvidence: ['owner-accepted-shape'] },
  { id: 'plan', skill: 'plan', requiredArtifacts: ['implementation-plan'], requiredEvidence: ['dependency-and-recovery-review'] },
  { id: 'design', skill: 'design', requiredArtifacts: ['technical-design'], requiredEvidence: ['design-review'] },
  { id: 'build', skill: 'build', requiredArtifacts: ['implementation'], requiredEvidence: ['source-revision'] },
  { id: 'test', skill: 'test', requiredArtifacts: ['verification-results'], requiredEvidence: ['reproducible-test-receipts'] },
  { id: 'review', skill: 'review', requiredArtifacts: ['independent-review'], requiredEvidence: ['review-disposition'] },
  { id: 'deploy', skill: 'deploy', requiredArtifacts: ['release-record'], requiredEvidence: ['authorized-deployment-and-live-check'] },
  { id: 'maintain', skill: 'maintain', requiredArtifacts: ['operations-and-recovery-record'], requiredEvidence: ['observed-maintenance-outcome'] },
] as const;

export interface AttendedSpikePreparation {
  format: 'faktori.attended-spike-preparation/v1';
  spikeId: string;
  requestDigest: string;
  status: 'needs_idea' | 'prepared_for_discovery';
  executionReady: false;
  productionReady: false;
  resourceEvidence: 'declared_not_observed';
  rawIdea?: string;
  ownerId?: string;
  constraints: string[];
  resources: AttendedSpikeResource[];
  unresolvedDecisions: string[];
  stages: Array<{
    id: string;
    state: 'not_started';
    skillPath: string;
    requiredArtifacts: string[];
    requiredEvidence: string[];
  }>;
  interventionTemplate: {
    stage: string;
    reason: string;
    humanAction: string;
    automationGap: string;
    evidenceReference: string;
  };
}

type RecordValue = Record<string, unknown>;
const resourceKinds = new Set<SpikeResourceKind>(['workspace', 'provider', 'deployment', 'database', 'verification', 'incident']);
const requiredResourceKinds: SpikeResourceKind[] = ['workspace', 'provider', 'deployment', 'database', 'verification', 'incident'];
const resourceStatuses = new Set<SpikeResourceStatus>(['unknown', 'proposed', 'owner_selected']);
const inputFields = new Set(['format', 'spikeId', 'rawIdea', 'ownerId', 'constraints', 'resources']);

function record(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as RecordValue;
}

function exactFields(value: RecordValue, allowed: Set<string>, label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${label} contains unknown field: ${unexpected[0]}`);
}

function boundedText(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'} of at most ${max} characters`);
  }
  return value;
}

function id(value: unknown, label: string, max: number): string {
  const result = boundedText(value, label, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) throw new Error(`${label} must contain only letters, numbers, dot, underscore, or hyphen`);
  return result;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const objectValue = value as RecordValue;
  return `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${stable(objectValue[key])}`).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function parseRequest(value: unknown): AttendedSpikeRequest {
  const input = record(value, 'request');
  exactFields(input, inputFields, 'request');
  if (input.format !== 'faktori.attended-spike-request/v1') throw new Error('request.format must be faktori.attended-spike-request/v1');
  const spikeId = id(input.spikeId, 'spikeId', 64);
  const rawIdea = input.rawIdea === undefined ? undefined : boundedText(input.rawIdea, 'rawIdea', 4000, true);
  const ownerId = input.ownerId === undefined ? undefined : id(input.ownerId, 'ownerId', 128);
  const constraints = input.constraints === undefined ? [] : input.constraints;
  if (!Array.isArray(constraints) || constraints.length > 32) throw new Error('constraints must be an array with at most 32 entries');
  const copiedConstraints = constraints.map((item, index) => boundedText(item, `constraints[${index}]`, 500));
  const resources = input.resources === undefined ? [] : input.resources;
  if (!Array.isArray(resources) || resources.length > 32) throw new Error('resources must be an array with at most 32 entries');
  const seenResourceKinds = new Set<SpikeResourceKind>();
  const copiedResources = resources.map((item, index) => {
    const resource = record(item, `resources[${index}]`);
    exactFields(resource, new Set(['kind', 'status', 'reference']), `resources[${index}]`);
    if (typeof resource.kind !== 'string' || !resourceKinds.has(resource.kind as SpikeResourceKind)) throw new Error(`resources[${index}].kind is invalid`);
    if (typeof resource.status !== 'string' || !resourceStatuses.has(resource.status as SpikeResourceStatus)) throw new Error(`resources[${index}].status is invalid`);
    const kind = resource.kind as SpikeResourceKind;
    if (seenResourceKinds.has(kind)) throw new Error(`resources contains duplicate kind: ${kind}`);
    seenResourceKinds.add(kind);
    const reference = resource.reference === undefined ? undefined : boundedText(resource.reference, `resources[${index}].reference`, 512);
    return { kind, status: resource.status as SpikeResourceStatus, ...(reference === undefined ? {} : { reference }) };
  });
  return { format: 'faktori.attended-spike-request/v1', spikeId, ...(rawIdea === undefined ? {} : { rawIdea }), ...(ownerId === undefined ? {} : { ownerId }), constraints: copiedConstraints, resources: copiedResources };
}

/** Builds a deterministic, data-only preparation artifact. It performs no discovery or readiness checks. */
export function prepareAttendedSpike(value: unknown): AttendedSpikePreparation {
  const request = parseRequest(value);
  const constraints = request.constraints ?? [];
  const resources = request.resources ?? [];
  const unresolvedDecisions: string[] = [];
  if (request.rawIdea === undefined || request.rawIdea.trim() === '') unresolvedDecisions.push('raw_idea');
  if (request.ownerId === undefined) unresolvedDecisions.push('owner');
  for (const kind of requiredResourceKinds) {
    const resource = resources.find((candidate) => candidate.kind === kind);
    if (resource?.status !== 'owner_selected' || resource.reference === undefined || resource.reference.trim() === '') {
      unresolvedDecisions.push(`resource:${kind}`);
    }
  }
  unresolvedDecisions.push('execution_authority', 'deployment_authority', 'resource_policy', 'approved_command_handoff');
  const output: AttendedSpikePreparation = {
    format: 'faktori.attended-spike-preparation/v1',
    spikeId: request.spikeId,
    requestDigest: createHash('sha256').update(stable(request)).digest('hex'),
    status: request.rawIdea !== undefined && request.rawIdea.trim() !== '' ? 'prepared_for_discovery' : 'needs_idea',
    executionReady: false,
    productionReady: false,
    resourceEvidence: 'declared_not_observed',
    ...(request.rawIdea === undefined ? {} : { rawIdea: request.rawIdea }),
    ...(request.ownerId === undefined ? {} : { ownerId: request.ownerId }),
    constraints: [...constraints],
    resources: resources.map((resource) => ({ ...resource })),
    unresolvedDecisions,
    stages: stages.map((stage) => ({ id: stage.id, state: 'not_started', skillPath: `skills/${stage.skill}/SKILL.md`, requiredArtifacts: [...stage.requiredArtifacts], requiredEvidence: [...stage.requiredEvidence] })),
    interventionTemplate: { stage: '', reason: '', humanAction: '', automationGap: '', evidenceReference: '' },
  };
  return deepFreeze(output);
}
