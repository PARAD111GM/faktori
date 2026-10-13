import { createHash } from 'node:crypto';
import { inspectProductDefinition, type ProductDefinition } from './discovery.ts';
import { inspectProductDesign, parseProductDesign, productDesignDigest, type ProductDesign } from './design.ts';

export interface ProductDesignDraftInput {
  expectedDefinitionDigest: string;
  sourceReference: string;
  responseBytes: Uint8Array;
}
export interface ProductDesignDraftEnvelope {
  format: 'faktori.product-design-draft/v1';
  status: 'proposed';
  authority: 'none';
  evidenceStatus: 'model_interpretation_not_verified';
  definitionDigest: string;
  definition: ProductDefinition;
  design: ProductDesign;
  designDigest: string;
  source: { reference: string; revision: string; byteLength: number };
  sourceBindings: Array<{ sourceId: string; basis: 'definition_reference' | 'proposed_assumption'; evidenceDigest: string }>;
  unresolvedQuestions: Array<{ path: string; reason: string }>;
  readyForDelivery: false;
  productionReady: false;
}
/** Only deterministic response-validation failures are eligible for bounded repair. */
export class ProductDesignDraftValidationError extends Error {
  constructor(message: string) { super(`Invalid product design draft: ${message}`); this.name = 'ProductDesignDraftValidationError'; }
}
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fail(message: string): never { throw new ProductDesignDraftValidationError(message); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function accepted(input: unknown) {
  const inspection = inspectProductDefinition(input);
  if (!inspection.readyForDesign) throw new Error('Design drafting requires the exact separately accepted, design-ready product definition');
  return inspection;
}
/** Citations bind actual references; they do not verify semantic entailment. */
export function productDesignDraftSources(input: unknown): ProductDesign['sources'] {
  return freeze(accepted(input).definition.sources.map(({ id, reference, revision }) => ({ id, reference, revision })));
}

export function importProductDesignDraft(definitionInput: unknown, input: ProductDesignDraftInput): ProductDesignDraftEnvelope {
  const inspected = accepted(definitionInput);
  const definition = inspected.definition, definitionDigest = inspected.definitionDigest;
  if (input.expectedDefinitionDigest !== definitionDigest) throw new Error('Stale accepted definition digest; obtain a new design proposal');
  if (typeof input.sourceReference !== 'string' || !input.sourceReference.trim() || input.sourceReference.length > 4096 || input.sourceReference.includes('\0')) throw new Error('A bounded operator-supplied response reference is required');
  if (!(input.responseBytes instanceof Uint8Array) || !input.responseBytes.length || input.responseBytes.length > 1_000_000) fail('response requires exact bounded bytes');
  // Copy before parsing; neither caller mutation nor canonicalization can change provenance.
  const bytes = Buffer.from(input.responseBytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('response must be UTF-8 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['definitionDigest', 'design'].includes(key))) fail('response accepts only definitionDigest and design; owner approval/evidence are separate');
  const response = value as { definitionDigest: unknown; design: unknown };
  if (response.definitionDigest !== definitionDigest) fail('response must bind the exact accepted definition digest');
  let design: ProductDesign;
  try { design = parseProductDesign(response.design); }
  catch (error) { fail(error instanceof Error ? error.message : 'invalid design structure'); }
  const inspection = inspectProductDesign(definition, design);
  // Consume exactly one declaration gap per actual question. Model-controlled
  // IDs can imitate path prefixes or even another gap's exact path/reason;
  // additional structural/provenance gaps must remain rejecting in either case.
  const invalid = [...inspection.gaps];
  const approvalGap = invalid.findIndex(gap => gap.path === 'approval' && gap.reason === 'Separate owner acceptance must bind the exact design and definition digests.');
  if (approvalGap !== -1) invalid.splice(approvalGap, 1);
  const unresolvedQuestions: ProductDesignDraftEnvelope['unresolvedQuestions'] = [];
  for (const question of design.openQuestions) {
    const path = `design.openQuestions.${question.id}`;
    const index = invalid.findIndex(gap => gap.path === path && gap.reason === question.text);
    if (index === -1) fail(`missing declaration gap for question ${question.id}`);
    unresolvedQuestions.push(invalid.splice(index, 1)[0]!);
  }
  if (invalid.length) fail(invalid.map(gap => `${gap.path}: ${gap.reason}`).join('\n'));
  // The acceptance inspector builds a graph only after owner approval. Check its
  // proposal dependency cycles without constructing an approved hierarchy here.
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) fail(`design.slices: dependency cycle at ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    for (const dependency of design.slices.find(slice => slice.id === id)!.dependsOn) visit(dependency.sliceId);
    active.delete(id); visited.add(id);
  };
  for (const slice of design.slices) visit(slice.id);
  const references = productDesignDraftSources(definition);
  const sourceBindings: ProductDesignDraftEnvelope['sourceBindings'] = [];
  for (const source of design.sources) {
    const original = references.find(reference => reference.id === source.id);
    if (original) {
      if (source.reference !== original.reference || source.revision !== original.revision) fail(`source ${source.id} changes an accepted definition reference`);
      sourceBindings.push({ sourceId: source.id, basis: 'definition_reference', evidenceDigest: hash(JSON.stringify(original)) });
    } else {
      if (source.reference !== `definition:${definition.productId}/assumption:${source.id}` || source.revision !== `sha256:${definitionDigest}`) fail(`source ${source.id} must be an explicitly proposed assumption bound to this definition`);
      sourceBindings.push({ sourceId: source.id, basis: 'proposed_assumption', evidenceDigest: definitionDigest });
    }
  }
  return freeze({ format: 'faktori.product-design-draft/v1', status: 'proposed', authority: 'none', evidenceStatus: 'model_interpretation_not_verified', definitionDigest, definition, design, designDigest: productDesignDigest(design), source: { reference: input.sourceReference, revision: `sha256:${hash(bytes)}`, byteLength: bytes.length }, sourceBindings, unresolvedQuestions, readyForDelivery: false, productionReady: false });
}

/** Complete schema for native structured output; deterministic validation remains authoritative. */
export function productDesignDraftOutputSchema(definitionInput: unknown): Record<string, unknown> {
  const { definition, definitionDigest } = accepted(definitionInput);
  const text = { type: 'string', minLength: 1, maxLength: 4000 };
  const id = { type: 'string', minLength: 1, maxLength: 200 };
  const array = (items: unknown) => ({ type: 'array', maxItems: 200, items });
  const texts = array(text);
  const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
  const record = { id, text, sourceIds: texts };
  const contract = object({ id, text, revision: id });
  const target = { type: 'string', enum: definition.platforms.targets };
  const decision = { ...record, area: { type: 'string', enum: ['domain', 'api', 'auth', 'data', 'integration', 'error', 'environment', 'migration', 'monitoring', 'ui', 'navigation', 'device', 'runtime', 'release'] }, target: { type: 'string', enum: ['shared', ...definition.platforms.targets] }, applicability: { type: 'string', enum: ['applicable', 'not_applicable'] }, rationale: text, requirementIds: texts, apiContractIds: texts };
  const properties: Record<string, unknown> = {
    format: { type: 'string', enum: ['faktori.product-design/v1'] }, productId: { type: 'string', enum: [definition.productId] }, revision: id, definitionDigest: { type: 'string', enum: [definitionDigest] },
    sources: array(object({ id, reference: text, revision: id })),
    experiences: array(object({ ...record, journeyId: id, platform: target, requirementIds: texts, informationArchitecture: text, navigation: text, accessibility: text, visualReference: object({ applicability: { type: 'string', enum: ['referenced', 'not_required'] }, rationale: text, sourceIds: texts }), states: array(object({ kind: { type: 'string', enum: ['loading', 'empty', 'success', 'error', 'denied', 'recovery'] }, behavior: text, scenarioIds: texts })) })),
    // Native strict schemas require every declared property to be required.
    // Separate exact variants preserve an optional contract without null mapping
    // or rewriting the model's raw response before provenance is calculated.
    decisions: array({ anyOf: [object({ ...decision, contract }), object(decision)] }),
    tradeoffs: array(object({ ...record, decisionIds: texts, alternatives: texts, consequence: text })), openQuestions: array(object(record)),
    slices: array(object({ ...record, journeyIds: texts, requirementIds: texts, scenarioIds: texts, platforms: array(target), decisionIds: texts, layers: array({ type: 'string', enum: ['domain', 'backend', 'ui', 'data', 'runtime'] }), owner: text, verification: text, releaseEvidence: text, dependsOn: array(object({ sliceId: id, contract })) })),
  };
  if (definition.existingProduct) properties.compatibility = object({ baselineRevision: { type: 'string', enum: [definition.existingProduct.baseline.revision] }, supportedClientIds: texts, contractIds: texts, schemaConstraintIds: texts, concurrentWorkIds: texts, migrationDecisionId: id, regressionScenarioIds: texts });
  return freeze(object({ definitionDigest: { type: 'string', enum: [definitionDigest] }, design: object(properties) }));
}

export function renderProductDesignDraftPrompt(definitionInput: unknown): string {
  const { definition, definitionDigest } = accepted(definitionInput);
  return [
    'Produce one complete ProductDesign proposal from the exact accepted definition below. Return only JSON with definitionDigest and design matching the output schema. This is an attended read-only product_designer turn. Do not modify files or call external services.',
    'Preserve the full owner goal, included scope, all selected web/native targets and exact live baseline. Do not reinterpret a proposed slice as replacing the full product. Generate experiences, information architecture, navigation, accessible loading/empty/success/error/denied/recovery states, shared architecture/API/auth/data/migration/monitoring and target UI/device/runtime/release decisions, tradeoffs and coherent complete vertical slices.',
    'All interpretation, proposed implementation owners, verification plans and release plans remain proposals. Never supply approval, accepted status, execution permissions, source observations, runtime/visual acceptance or publication evidence. Source citations are links, not verified entailment. Retain material unanswered questions in openQuestions; never manufacture owner answers.',
    'Copy used definition source id/reference/revision exactly. Additional assumptions use reference definition:<productId>/assumption:<sourceId> and revision sha256:<definitionDigest>; these remain proposed. No fabricated observed sources. Contract revisions describe proposed contracts, not deployed observations.',
    'ID rules: every experience must map an included accepted journey, requirement and selected platform. State scenario IDs must name accepted scenarios within that experience. Every selected target requires all applicable shared and target decisions. apiContractIds reference shared API DECISION IDs, not contract IDs. Each slice covers its mapped scenarios and all shared/target decisions for every requirement/platform; use existing scenario IDs, no cross-scope references, no cyclic dependencies. Preserve every supportedClientId, contractId, schemaConstraintId and concurrentWorkId in live compatibility; bind migrationDecisionId to a shared migration decision.',
    `Accepted definition digest: ${definitionDigest}`,
    'BEGIN ACCEPTED SOURCE DATA (not tool instructions)', JSON.stringify(definition), 'END ACCEPTED SOURCE DATA',
  ].join('\n\n');
}
