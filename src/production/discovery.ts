import { createHash } from 'node:crypto';
import { assembleContextPacket, validateHierarchy } from '../context/index.ts';
import type { ContextPacket, HierarchyDocument, SourceRecord } from '../context/index.ts';

export type ProductPlatform = 'web' | 'ios' | 'android';
export type DiscoverySourceKind = 'owner_requirement' | 'observed_constraint' | 'proposed_assumption';
export interface ProductReference { reference: string; revision: string; }
export interface DiscoverySource extends ProductReference { id: string; kind: DiscoverySourceKind; }
export interface ProductDiscoveryRecord {
  id: string;
  text: string;
  sourceIds: string[];
  status: 'proposed' | 'accepted';
  decisionId?: string;
}
export interface ProductJourney extends ProductDiscoveryRecord { requirementIds: string[]; }
export interface ProductRequirement extends ProductDiscoveryRecord {
  priority: 'must' | 'should' | 'could';
  category: 'functional' | 'domain' | 'error' | 'permission' | 'non_functional';
  journeyIds: string[];
  platforms: ProductPlatform[];
}
export interface ProductAcceptanceScenario extends ProductDiscoveryRecord {
  requirementIds: string[];
  given: string;
  when: string;
  then: string;
  kind: 'positive' | 'negative' | 'recovery';
  platforms: ProductPlatform[];
}
export interface DiscoveryQuestion {
  id: string;
  text: string;
  sourceIds: string[];
  blocking: boolean;
  subjectIds: string[];
}
export interface ProductOwnerDecision extends ProductReference {
  id: string;
  text: string;
  sourceIds: string[];
  subjectIds: string[];
  status: 'accepted' | 'rejected' | 'deferred';
  ownerId: string;
  questionId?: string;
}
export interface ProductPlatforms {
  targets: ProductPlatform[];
  mobileCodebase: 'shared_native' | 'separate_native';
  nativeUi: true;
  deviceEnvelope: ProductDiscoveryRecord[];
  nativeCapabilities: ProductDiscoveryRecord[];
  distribution: ProductDiscoveryRecord[];
  exceptionDecisionId?: string;
}
export interface ExistingProductDefinition {
  baseline: ProductReference;
  deployedArtifact: ProductDiscoveryRecord;
  supportedClients: ProductDiscoveryRecord[];
  contracts: ProductDiscoveryRecord[];
  schemaConstraints: ProductDiscoveryRecord[];
  incidents: ProductDiscoveryRecord[];
  telemetry: ProductDiscoveryRecord[];
  concurrentWork: ProductDiscoveryRecord[];
}
export interface ProductDefinition {
  format: 'faktori.product-definition/v1';
  productId: string;
  revision: string;
  rawIdea: string;
  intentRef: ProductReference;
  sources: DiscoverySource[];
  users: ProductDiscoveryRecord[];
  outcomes: ProductDiscoveryRecord[];
  journeys: ProductJourney[];
  requirements: ProductRequirement[];
  roles: ProductDiscoveryRecord[];
  data: ProductDiscoveryRecord[];
  integrations: ProductDiscoveryRecord[];
  resources: ProductDiscoveryRecord[];
  constraints: ProductDiscoveryRecord[];
  platforms: ProductPlatforms;
  scope: { includedRequirementIds: string[]; exclusions: ProductDiscoveryRecord[] };
  assumptions: ProductDiscoveryRecord[];
  openQuestions: DiscoveryQuestion[];
  ownerDecisions: ProductOwnerDecision[];
  modelProposals: ProductDiscoveryRecord[];
  acceptanceScenarios: ProductAcceptanceScenario[];
  definitionDecisionId?: string;
  existingProduct?: ExistingProductDefinition;
}
export interface ProductDiscoveryInspection {
  definition: ProductDefinition;
  definitionDigest: string;
  readyForDesign: boolean;
  executionReady: false;
  productionReady: false;
  evidenceStatus: 'declared_not_verified';
  acceptedRequirementIds: string[];
  unresolvedQuestions: DiscoveryQuestion[];
}
export class ProductDefinitionValidationError extends Error {
  readonly issues: Array<{ path: string; message: string }>;
  constructor(path: string, message: string) {
    super(`Invalid product definition: ${path}: ${message}`);
    this.name = 'ProductDefinitionValidationError';
    this.issues = [{ path, message }];
  }
}

type Input = Record<string, unknown>;
const platforms = ['web', 'ios', 'android'] as const;
const baseFields = ['id', 'text', 'sourceIds', 'status', 'decisionId'];
const maxItems = 200;
function fail(path: string, message: string): never { throw new ProductDefinitionValidationError(path, message); }

// Fail closed before recursive normalization. This also rejects getters, cycles,
// exotic objects and oversized direct API inputs, not just serialized JSON.
function boundInput(value: unknown, path = 'definition', depth = 0, state = { nodes: 0, bytes: 0 }, ancestors = new Set<object>()): void {
  if (++state.nodes > 20000 || depth > 20) fail(path, 'exceeds the bounded document size/depth');
  if (typeof value === 'string') state.bytes += Buffer.byteLength(value);
  if (state.bytes > 1_000_000) fail(path, 'exceeds one megabyte of text');
  if (value === null || typeof value !== 'object') return;
  if (ancestors.has(value)) fail(path, 'must not contain cycles');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) fail(path, 'must be plain JSON');
  if (Array.isArray(value) && value.length > maxItems) fail(path, `must contain at most ${maxItems} entries`);
  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!('value' in descriptor)) fail(`${path}.${key}`, 'accessors are not supported');
    boundInput(descriptor.value, `${path}.${key}`, depth + 1, state, ancestors);
  }
  ancestors.delete(value);
}
function object(value: unknown, path: string, keys: readonly string[]): Input {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const result = value as Input;
  for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${path}.${key}`, 'is not a supported field');
  return result;
}
function text(value: unknown, path: string, limit = 8000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) fail(path, `must be non-empty text of at most ${limit} characters`);
  return value;
}
function id(value: unknown, path: string): string {
  const result = text(value, path, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) fail(path, 'must contain only letters, digits, dot, underscore or hyphen');
  return result;
}
function choice<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(path, `must be one of ${values.join(', ')}`);
  return value as T;
}
function list<T>(value: unknown, path: string, parse: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value) || value.length > maxItems) fail(path, `must be an array of at most ${maxItems} entries`);
  return value.map((entry, index) => parse(entry, `${path}[${index}]`));
}
function ids(value: unknown, path: string): string[] {
  const result = list(value, path, id);
  if (new Set(result).size !== result.length) fail(path, 'must not contain duplicate references');
  return result;
}
function targets(value: unknown, path: string): ProductPlatform[] {
  const result = list(value, path, (entry, location) => choice(entry, location, platforms));
  if (new Set(result).size !== result.length) fail(path, 'must not contain duplicate platforms');
  return result;
}
function reference(value: unknown, path: string): ProductReference {
  const result = object(value, path, ['reference', 'revision']);
  return { reference: text(result.reference, `${path}.reference`, 2048), revision: text(result.revision, `${path}.revision`, 256) };
}
function sourced(value: unknown, path: string, extraFields: readonly string[] = []): ProductDiscoveryRecord {
  const result = object(value, path, [...baseFields, ...extraFields]);
  const sourceIds = ids(result.sourceIds, `${path}.sourceIds`);
  if (!sourceIds.length) fail(`${path}.sourceIds`, 'must name at least one source');
  return {
    id: id(result.id, `${path}.id`), text: text(result.text, `${path}.text`), sourceIds,
    status: choice(result.status, `${path}.status`, ['proposed', 'accepted']),
    ...(result.decisionId === undefined ? {} : { decisionId: id(result.decisionId, `${path}.decisionId`) }),
  };
}
function records(value: unknown, path: string): ProductDiscoveryRecord[] { return list(value, path, sourced); }
function proposed(value: unknown, path: string): ProductDiscoveryRecord {
  const result = sourced(value, path);
  if (result.status !== 'proposed' || result.decisionId !== undefined) fail(path, 'assumptions/model proposals must remain proposed; record an owner decision and an accepted requirement separately');
  return result;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const result = value as Input;
  return `{${Object.keys(result).sort().map((key) => `${JSON.stringify(key)}:${stable(result[key])}`).join(',')}}`;
}

/** Parse a portable discovery artifact without inventing answers or granting authority. */
export function parseProductDefinition(value: unknown): ProductDefinition {
  boundInput(value);
  const input = object(value, 'definition', ['format', 'productId', 'revision', 'rawIdea', 'intentRef', 'sources', 'users', 'outcomes', 'journeys', 'requirements', 'roles', 'data', 'integrations', 'resources', 'constraints', 'platforms', 'scope', 'assumptions', 'openQuestions', 'ownerDecisions', 'modelProposals', 'acceptanceScenarios', 'definitionDecisionId', 'existingProduct']);
  if (input.format !== 'faktori.product-definition/v1') fail('format', 'must be faktori.product-definition/v1');
  const platformInput = object(input.platforms, 'platforms', ['targets', 'mobileCodebase', 'nativeUi', 'deviceEnvelope', 'nativeCapabilities', 'distribution', 'exceptionDecisionId']);
  if (platformInput.nativeUi !== true) fail('platforms.nativeUi', 'must be true; WebView wrappers do not satisfy native mobile delivery');
  const scopeInput = object(input.scope, 'scope', ['includedRequirementIds', 'exclusions']);
  const definition: ProductDefinition = {
    format: 'faktori.product-definition/v1', productId: id(input.productId, 'productId'), revision: text(input.revision, 'revision', 256), rawIdea: text(input.rawIdea, 'rawIdea'), intentRef: reference(input.intentRef, 'intentRef'),
    sources: list(input.sources, 'sources', (entry, path) => {
      const source = object(entry, path, ['id', 'kind', 'reference', 'revision']);
      return { id: id(source.id, `${path}.id`), kind: choice(source.kind, `${path}.kind`, ['owner_requirement', 'observed_constraint', 'proposed_assumption']), reference: text(source.reference, `${path}.reference`, 2048), revision: text(source.revision, `${path}.revision`, 256) };
    }),
    users: records(input.users, 'users'), outcomes: records(input.outcomes, 'outcomes'),
    journeys: list(input.journeys, 'journeys', (entry, path) => {
      const item = entry as Input;
      return { ...sourced(entry, path, ['requirementIds']), requirementIds: ids(item.requirementIds, `${path}.requirementIds`) };
    }),
    requirements: list(input.requirements, 'requirements', (entry, path) => {
      const base = sourced(entry, path, ['priority', 'category', 'journeyIds', 'platforms']);
      const item = entry as Input;
      return { ...base, priority: choice(item.priority, `${path}.priority`, ['must', 'should', 'could']), category: choice(item.category, `${path}.category`, ['functional', 'domain', 'error', 'permission', 'non_functional']), journeyIds: ids(item.journeyIds, `${path}.journeyIds`), platforms: targets(item.platforms, `${path}.platforms`) };
    }),
    roles: records(input.roles, 'roles'), data: records(input.data, 'data'), integrations: records(input.integrations, 'integrations'), resources: records(input.resources, 'resources'), constraints: records(input.constraints, 'constraints'),
    platforms: {
      targets: targets(platformInput.targets, 'platforms.targets'), mobileCodebase: choice(platformInput.mobileCodebase ?? 'shared_native', 'platforms.mobileCodebase', ['shared_native', 'separate_native']), nativeUi: true,
      deviceEnvelope: records(platformInput.deviceEnvelope, 'platforms.deviceEnvelope'), nativeCapabilities: records(platformInput.nativeCapabilities, 'platforms.nativeCapabilities'), distribution: records(platformInput.distribution, 'platforms.distribution'),
      ...(platformInput.exceptionDecisionId === undefined ? {} : { exceptionDecisionId: id(platformInput.exceptionDecisionId, 'platforms.exceptionDecisionId') }),
    },
    scope: { includedRequirementIds: ids(scopeInput.includedRequirementIds, 'scope.includedRequirementIds'), exclusions: records(scopeInput.exclusions, 'scope.exclusions') },
    assumptions: list(input.assumptions, 'assumptions', proposed), modelProposals: list(input.modelProposals, 'modelProposals', proposed),
    openQuestions: list(input.openQuestions, 'openQuestions', (entry, path) => {
      const question = object(entry, path, ['id', 'text', 'sourceIds', 'blocking', 'subjectIds']);
      if (typeof question.blocking !== 'boolean') fail(`${path}.blocking`, 'must be boolean');
      return { id: id(question.id, `${path}.id`), text: text(question.text, `${path}.text`), sourceIds: ids(question.sourceIds, `${path}.sourceIds`), blocking: question.blocking, subjectIds: ids(question.subjectIds, `${path}.subjectIds`) };
    }),
    ownerDecisions: list(input.ownerDecisions, 'ownerDecisions', (entry, path) => {
      const decision = object(entry, path, ['id', 'text', 'sourceIds', 'subjectIds', 'status', 'ownerId', 'reference', 'revision', 'questionId']);
      return { id: id(decision.id, `${path}.id`), text: text(decision.text, `${path}.text`), sourceIds: ids(decision.sourceIds, `${path}.sourceIds`), subjectIds: ids(decision.subjectIds, `${path}.subjectIds`), status: choice(decision.status, `${path}.status`, ['accepted', 'rejected', 'deferred']), ownerId: id(decision.ownerId, `${path}.ownerId`), reference: text(decision.reference, `${path}.reference`, 2048), revision: text(decision.revision, `${path}.revision`, 256), ...(decision.questionId === undefined ? {} : { questionId: id(decision.questionId, `${path}.questionId`) }) };
    }),
    acceptanceScenarios: list(input.acceptanceScenarios, 'acceptanceScenarios', (entry, path) => {
      const base = sourced(entry, path, ['requirementIds', 'given', 'when', 'then', 'kind', 'platforms']);
      const item = entry as Input;
      return { ...base, requirementIds: ids(item.requirementIds, `${path}.requirementIds`), given: text(item.given, `${path}.given`), when: text(item.when, `${path}.when`), then: text(item.then, `${path}.then`), kind: choice(item.kind, `${path}.kind`, ['positive', 'negative', 'recovery']), platforms: targets(item.platforms, `${path}.platforms`) };
    }),
    ...(input.definitionDecisionId === undefined ? {} : { definitionDecisionId: id(input.definitionDecisionId, 'definitionDecisionId') }),
  };
  if (input.existingProduct !== undefined) {
    const existing = object(input.existingProduct, 'existingProduct', ['baseline', 'deployedArtifact', 'supportedClients', 'contracts', 'schemaConstraints', 'incidents', 'telemetry', 'concurrentWork']);
    definition.existingProduct = {
      baseline: reference(existing.baseline, 'existingProduct.baseline'), deployedArtifact: sourced(existing.deployedArtifact, 'existingProduct.deployedArtifact'), supportedClients: records(existing.supportedClients, 'existingProduct.supportedClients'), contracts: records(existing.contracts, 'existingProduct.contracts'), schemaConstraints: records(existing.schemaConstraints, 'existingProduct.schemaConstraints'), incidents: records(existing.incidents, 'existingProduct.incidents'), telemetry: records(existing.telemetry, 'existingProduct.telemetry'), concurrentWork: records(existing.concurrentWork, 'existingProduct.concurrentWork'),
    };
  }
  validateReferences(definition);
  return freeze(definition);
}

function allRecords(definition: ProductDefinition): ProductDiscoveryRecord[] {
  const existing = definition.existingProduct;
  return [...definition.users, ...definition.outcomes, ...definition.journeys, ...definition.requirements, ...definition.roles, ...definition.data, ...definition.integrations, ...definition.resources, ...definition.constraints, ...definition.platforms.deviceEnvelope, ...definition.platforms.nativeCapabilities, ...definition.platforms.distribution, ...definition.scope.exclusions, ...definition.assumptions, ...definition.modelProposals, ...definition.acceptanceScenarios, ...(existing ? [existing.deployedArtifact, ...existing.supportedClients, ...existing.contracts, ...existing.schemaConstraints, ...existing.incidents, ...existing.telemetry, ...existing.concurrentWork] : [])];
}
function validateReferences(definition: ProductDefinition): void {
  const records = allRecords(definition);
  const identities = new Set([definition.productId]);
  for (const entry of [...definition.sources, ...records, ...definition.openQuestions, ...definition.ownerDecisions]) {
    if (identities.has(entry.id)) fail(entry.id, 'duplicates an identity in this definition');
    identities.add(entry.id);
  }
  const sources = new Map(definition.sources.map((entry) => [entry.id, entry]));
  const decisions = new Map(definition.ownerDecisions.map((entry) => [entry.id, entry]));
  const requirements = new Map(definition.requirements.map((entry) => [entry.id, entry]));
  const journeys = new Map(definition.journeys.map((entry) => [entry.id, entry]));
  const questionIds = new Set(definition.openQuestions.map((entry) => entry.id));
  function knownReferences(references: string[], known: { has(key: string): boolean }, path: string): void {
    for (const ref of references) if (!known.has(ref)) fail(path, `unknown reference ${ref}`);
  }
  for (const entry of [...records, ...definition.openQuestions, ...definition.ownerDecisions]) knownReferences(entry.sourceIds, sources, `${entry.id}.sourceIds`);
  for (const decision of definition.ownerDecisions) {
    knownReferences(decision.subjectIds, identities, `${decision.id}.subjectIds`);
    if (!decision.sourceIds.some((sourceId) => sources.get(sourceId)?.kind === 'owner_requirement')) fail(`${decision.id}.sourceIds`, 'owner decisions require an owner_requirement source');
    if (decision.questionId && !questionIds.has(decision.questionId)) fail(`${decision.id}.questionId`, 'must reference an open question');
  }
  for (const question of definition.openQuestions) knownReferences(question.subjectIds, identities, `${question.id}.subjectIds`);
  for (const entry of records) {
    const decision = entry.decisionId ? decisions.get(entry.decisionId) : undefined;
    if (entry.decisionId && (!decision || decision.status !== 'accepted' || !decision.subjectIds.includes(entry.id) || decision.revision !== definition.revision)) fail(`${entry.id}.decisionId`, 'must name an accepted owner decision for this record at this definition revision');
    if (entry.status === 'accepted' && !decision && !entry.sourceIds.some((sourceId) => ['owner_requirement', 'observed_constraint'].includes(sources.get(sourceId)?.kind ?? ''))) fail(`${entry.id}.status`, 'a model proposal cannot become an accepted fact without a separate owner decision');
  }
  for (const journey of definition.journeys) knownReferences(journey.requirementIds, requirements, `${journey.id}.requirementIds`);
  for (const requirement of definition.requirements) {
    knownReferences(requirement.journeyIds, journeys, `${requirement.id}.journeyIds`);
    if (!requirement.platforms.length || requirement.platforms.some((platform) => !definition.platforms.targets.includes(platform))) fail(`${requirement.id}.platforms`, 'must name at least one selected product target');
    for (const journeyId of requirement.journeyIds) if (!journeys.get(journeyId)?.requirementIds.includes(requirement.id)) fail(`${requirement.id}.journeyIds`, 'must agree with the journey requirement map');
  }
  for (const journey of definition.journeys) for (const requirementId of journey.requirementIds) if (!requirements.get(requirementId)?.journeyIds.includes(journey.id)) fail(`${journey.id}.requirementIds`, 'must agree with the requirement journey map');
  knownReferences(definition.scope.includedRequirementIds, requirements, 'scope.includedRequirementIds');
  for (const scenario of definition.acceptanceScenarios) {
    knownReferences(scenario.requirementIds, requirements, `${scenario.id}.requirementIds`);
    if (!scenario.requirementIds.length || !scenario.platforms.length || scenario.platforms.some((platform) => !definition.platforms.targets.includes(platform))) fail(scenario.id, 'scenarios must map requirements and selected platforms');
    for (const platform of scenario.platforms) if (!scenario.requirementIds.some((requirementId) => requirements.get(requirementId)?.platforms.includes(platform))) fail(`${scenario.id}.platforms`, 'scenario platform must be supported by a mapped requirement');
  }
  if (definition.definitionDecisionId) {
    const decision = decisions.get(definition.definitionDecisionId);
    if (!decision || decision.status !== 'accepted' || decision.revision !== definition.revision || !decision.subjectIds.includes(definition.productId)) fail('definitionDecisionId', 'must name accepted owner approval of this product at this definition revision');
  }
  if (definition.platforms.mobileCodebase === 'separate_native') {
    const exception = decisions.get(definition.platforms.exceptionDecisionId ?? '');
    if (!exception || exception.status !== 'accepted' || exception.revision !== definition.revision || !exception.subjectIds.includes(definition.productId)) fail('platforms.exceptionDecisionId', 'separate native codebases require an accepted product-specific owner exception');
  } else if (definition.platforms.exceptionDecisionId !== undefined) fail('platforms.exceptionDecisionId', 'only separate_native uses an exception');
}

/** Semantic digest of validated normalized content; object key order is irrelevant. */
export function productDefinitionDigest(input: unknown): string {
  return createHash('sha256').update(stable(parseProductDefinition(input))).digest('hex');
}

/** Determine the next bounded decisions. No model/provider call or external effect. */
export function inspectProductDefinition(input: unknown): ProductDiscoveryInspection {
  const definition = parseProductDefinition(input);
  const resolved = new Set(definition.ownerDecisions.filter((decision) => decision.status !== 'deferred' && decision.revision === definition.revision).map((decision) => decision.questionId).filter((value): value is string => value !== undefined));
  const unresolvedQuestions = definition.openQuestions.filter((question) => !resolved.has(question.id)).map((question) => ({ ...question }));
  const generatedIds = new Set([...definition.sources, ...allRecords(definition), ...definition.ownerDecisions, ...definition.openQuestions].map((entry) => entry.id));
  function ask(label: string, message: string, subjectIds: string[], blocking = true): void {
    let questionId = `discovery.${label}`;
    while (generatedIds.has(questionId)) questionId += '.next';
    generatedIds.add(questionId);
    unresolvedQuestions.push({ id: questionId, text: message, sourceIds: [], blocking, subjectIds });
  }
  if (!definition.definitionDecisionId) ask('owner_acceptance', 'Which owner decision accepts this product definition revision?', [definition.productId]);
  for (const section of ['users', 'outcomes', 'journeys', 'requirements', 'roles', 'data', 'integrations'] as const) if (!definition[section].length) ask(section, `What are the essential ${section} for the next design slice, or what is their explicit applicability?`, [definition.productId]);
  if (!definition.platforms.targets.length) ask('platforms', 'Which of web, iOS and Android are in scope?', [definition.productId]);
  if (!definition.scope.includedRequirementIds.length) ask('scope', 'Which requirements belong to the next complete delivery slice?', [definition.productId]);
  const included = new Set(definition.scope.includedRequirementIds);
  const scopedRecords = allRecords(definition).filter((entry) => !definition.assumptions.includes(entry) && !definition.modelProposals.includes(entry) && (!definition.requirements.includes(entry as ProductRequirement) || included.has(entry.id)) && (!definition.acceptanceScenarios.includes(entry as ProductAcceptanceScenario) || (entry as ProductAcceptanceScenario).requirementIds.some((requirementId) => included.has(requirementId))));
  for (const entry of scopedRecords) if (entry.status !== 'accepted') ask(`accept.${entry.id}`, `Is this proposed record accepted, excluded, or still unresolved: ${entry.text}`, [entry.id]);
  const relevantSubjects = new Set([definition.productId, ...scopedRecords.map((entry) => entry.id)]);
  for (const subjectId of relevantSubjects) {
    const decisions = definition.ownerDecisions.filter((decision) => decision.revision === definition.revision && decision.subjectIds.includes(subjectId));
    const rejected = decisions.some((decision) => decision.status === 'rejected');
    if (rejected && (decisions.some((decision) => decision.status === 'accepted') || scopedRecords.some((entry) => entry.id === subjectId && entry.status === 'accepted'))) ask(`conflict.${subjectId}`, `Owner rejection conflicts with accepted scope for ${subjectId}; which decision or scope amendment supersedes it?`, [subjectId]);
  }
  for (const requirement of definition.requirements.filter((entry) => included.has(entry.id))) {
    for (const platform of requirement.platforms) if (!definition.acceptanceScenarios.some((scenario) => scenario.status === 'accepted' && scenario.requirementIds.includes(requirement.id) && scenario.platforms.includes(platform))) ask(`coverage.${requirement.id}.${platform}`, `What independently verifiable ${platform} scenario establishes requirement ${requirement.id}?`, [requirement.id]);
  }
  for (const category of ['error', 'permission', 'non_functional'] as const) if (!definition.requirements.some((entry) => included.has(entry.id) && entry.category === category)) ask(`consider.${category}`, `What ${category.replace('_', ' ')} behavior or explicit applicability decision does this slice need?`, [definition.productId], false);
  if (definition.platforms.targets.some((platform) => platform !== 'web')) {
    for (const section of ['deviceEnvelope', 'distribution'] as const) if (!definition.platforms[section].length) ask(`mobile.${section}`, `What ${section} constraints and ownership apply to native mobile delivery?`, [definition.productId]);
  }
  if (definition.existingProduct) {
    for (const section of ['supportedClients', 'contracts', 'schemaConstraints', 'concurrentWork'] as const) if (!definition.existingProduct[section].length) ask(`baseline.${section}`, `What existing-product ${section} constraints apply, or why are they inapplicable?`, [definition.productId]);
  }
  // Accepted decisions resolving explicit questions are retained on resume. Stable
  // ordering prioritizes consequential owner questions, preserving input order.
  unresolvedQuestions.sort((a, b) => Number(b.blocking) - Number(a.blocking));
  return freeze({ definition, definitionDigest: createHash('sha256').update(stable(definition)).digest('hex'), readyForDesign: !unresolvedQuestions.some((question) => question.blocking), executionReady: false, productionReady: false, evidenceStatus: 'declared_not_verified', acceptedRequirementIds: definition.requirements.filter((entry) => entry.status === 'accepted').map((entry) => entry.id), unresolvedQuestions });
}

/** Bridge accepted discovery into the existing context contract, planning only. */
export function compileProductHierarchy(input: unknown): HierarchyDocument {
  const inspection = inspectProductDefinition(input);
  if (!inspection.readyForDesign) fail('discovery', `resolve blocking questions before compiling: ${inspection.unresolvedQuestions.filter((question) => question.blocking).map((question) => question.id).join(', ')}`);
  const definition = inspection.definition;
  const included = new Set(definition.scope.includedRequirementIds);
  const asSource = (entry: ProductDiscoveryRecord): SourceRecord => ({ id: entry.id, text: entry.text, revision: definition.revision });
  const criteria = (requirementIds: Set<string>): SourceRecord[] => definition.acceptanceScenarios.filter((scenario) => scenario.status === 'accepted' && scenario.requirementIds.some((requirementId) => requirementIds.has(requirementId))).map((scenario) => ({ id: scenario.id, text: `${scenario.text}\nGiven ${scenario.given}\nWhen ${scenario.when}\nThen ${scenario.then}`, revision: definition.revision }));
  const baseline = definition.existingProduct;
  const constraints = [...definition.requirements.filter((entry) => included.has(entry.id)), ...definition.constraints, ...definition.scope.exclusions, ...definition.platforms.deviceEnvelope, ...definition.platforms.nativeCapabilities, ...definition.platforms.distribution, ...(baseline ? [baseline.deployedArtifact, ...baseline.supportedClients, ...baseline.contracts, ...baseline.schemaConstraints, ...baseline.concurrentWork] : [])].map(asSource);
  return validateHierarchy({
    revision: definition.revision,
    globalConstraints: [],
    nodes: [
      { id: definition.productId, kind: 'planning', label: 'Product', objective: { id: `${definition.productId}.intent`, text: definition.rawIdea, revision: definition.revision }, criteria: criteria(included), constraints, designReferences: [], artifacts: [{ id: `${definition.productId}.definition`, text: `Product definition ${inspection.definitionDigest}; intent ${definition.intentRef.reference}@${definition.intentRef.revision}${baseline ? `; baseline ${baseline.baseline.reference}@${baseline.baseline.revision}` : ''}`, revision: definition.revision }], commands: [], authority: [], evidenceRequirements: [{ id: `${definition.productId}.evidence`, text: 'Independent scenario verification at the candidate revision; owner acceptance is declared, not an observed execution or release receipt.', revision: definition.revision }] },
      ...definition.journeys.filter((journey) => journey.requirementIds.some((requirementId) => included.has(requirementId))).map((journey) => ({ id: `journey.${journey.id}`, kind: 'planning', label: 'Feature', parentId: definition.productId, objective: asSource(journey), criteria: criteria(new Set(journey.requirementIds.filter((requirementId) => included.has(requirementId)))), constraints: [], designReferences: [], artifacts: [], commands: [], authority: [], evidenceRequirements: [] })),
    ],
    dependencies: [],
  });
}

export function assembleProductContext(input: unknown, nodeId: string): ContextPacket {
  return assembleContextPacket(compileProductHierarchy(input), nodeId);
}
