import { isAbsolute, relative, resolve, sep } from 'node:path';
import { assembleContextPacket, type ContextPacket, type SourceRecord } from '../context/index.ts';
import { parseLeanLoopConfiguration, type LeanLoopConfiguration, type ManagerLoopVerificationCommand } from '../loop/index.ts';
import { compileProductHierarchy, inspectProductDefinition, type ProductDefinition } from './discovery.ts';

type Data = Record<string, unknown>;
type Platform = 'web' | 'ios' | 'android';
export interface ProductArtifactBinding { path: string; digest: string }
export interface ProductReleaseTarget {
  platform: Platform;
  environment: string;
  resourceRevision: string;
  releaseOwner: string;
  artifactContract: string;
  distributionContract: string;
  postDeployAcceptance: string;
  rollbackPlan: string;
}
export interface ProductCompatibilityPlan {
  baselineRevision: string;
  supportedClientContract: string;
  migrationPlan: string;
  regressionAcceptance: string;
  concurrentWorkBoundary: string;
}
export interface ProductReleasePlan {
  targets: ProductReleaseTarget[];
  compatibility?: ProductCompatibilityPlan;
}
/** Values come from the execution owner, never from discovery estimates. */
export interface ProductExecutionBindings {
  loopId: string;
  workspace: LeanLoopConfiguration['workspace'];
  artifactsDirectory: string;
  approval: LeanLoopConfiguration['approval'];
  candidate: LeanLoopConfiguration['candidate'];
  provider: LeanLoopConfiguration['provider'];
  roleRoutes: LeanLoopConfiguration['roleRoutes'];
  review: LeanLoopConfiguration['review'];
  toolchain: LeanLoopConfiguration['toolchain'];
  limits: LeanLoopConfiguration['limits'];
  acceptanceCommand: ManagerLoopVerificationCommand;
  repairApproval?: LeanLoopConfiguration['repairApproval'];
  subscriptionRouting?: LeanLoopConfiguration['subscriptionRouting'];
}
export interface ProductDeliveryRequest {
  format: 'faktori.product-delivery-request/v1';
  definitionDigest: string;
  definitionArtifact?: ProductArtifactBinding;
  requestArtifact?: ProductArtifactBinding;
  execution?: Partial<ProductExecutionBindings>;
  releasePlan?: ProductReleasePlan;
}
/** The raw input accepted by the existing loop CLI; normalized `phases` are internal. */
export type ProductDeliveryLoopInput = Omit<LeanLoopConfiguration, 'phases'> & { verification: ManagerLoopVerificationCommand[] };
export interface ProductDeliveryCompilation {
  format: 'faktori.product-delivery-compilation/v1';
  status: 'needs_bindings' | 'ready_for_loop';
  productId: string;
  definitionRevision: string;
  definitionDigest: string;
  requiredBindings: Array<{ path: string; kind: 'decision' | 'capability'; reason: string }>;
  capabilityObservations: Array<{ capability: string; status: 'declared' | 'unknown' | 'unavailable'; detail: string }>;
  platformContract: ProductDefinition['platforms'];
  releasePlan?: ProductReleasePlan;
  context?: ContextPacket;
  artifactHandoff: {
    definitionDigest: string;
    dependencies: LeanLoopConfiguration['candidate']['dependencies'];
    requirementIds: string[];
    scenarioIds: string[];
    authority: 'caller_supplied';
    resourceEvidence: 'declared_not_observed';
    releaseEvidence: 'pending';
  };
  leanConfiguration?: ProductDeliveryLoopInput;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
function boundRequest(value: unknown, path = 'request', depth = 0, budget = { nodes: 0, bytes: 0 }, ancestors = new Set<object>()): void {
  if (++budget.nodes > 20000 || depth > 20) throw new Error(`${path} exceeds request size/depth limits`);
  if (typeof value === 'string') budget.bytes += Buffer.byteLength(value);
  if (budget.bytes > 1_000_000) throw new Error('request exceeds one megabyte of text');
  if (value === null || typeof value !== 'object') {
    if (!['string', 'number', 'boolean', 'undefined'].includes(typeof value) && value !== null) throw new Error(`${path} must be JSON data`);
    return;
  }
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} must be plain JSON`);
  if (Array.isArray(value) && value.length > 200) throw new Error(`${path} exceeds 200 entries`);
  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!('value' in descriptor)) throw new Error(`${path}.${key} accessors are not supported`);
    boundRequest(descriptor.value, `${path}.${key}`, depth + 1, budget, ancestors);
  }
  ancestors.delete(value);
}
function data(value: unknown, path: string): Data {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} must be a plain object`);
  return value as Data;
}
function fields(input: Data, allowed: string[], path: string): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`${path}.${key} is not supported`);
}
function text(value: unknown, path: string, maximum = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new Error(`${path} must be non-empty text of at most ${maximum} characters`);
  return value;
}
function artifact(value: unknown, path: string): ProductArtifactBinding {
  const input = data(value, path);
  fields(input, ['path', 'digest'], path);
  const filePath = text(input.path, `${path}.path`, 4096);
  const digest = text(input.digest, `${path}.digest`, 71);
  if (!isAbsolute(filePath) || !DIGEST.test(digest)) throw new Error(`${path} requires an absolute file path and sha256 digest`);
  return { path: filePath, digest };
}
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const input = value as Data;
  return `{${Object.keys(input).filter((key) => input[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(input[key])}`).join(',')}}`;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) freeze(child);
  }
  return value;
}

/** Pure compilation. Does not read files, probe providers, approve work or launch commands. */
export function compileProductDelivery(definitionInput: unknown, requestInput: unknown): ProductDeliveryCompilation {
  boundRequest(requestInput);
  const inspected = inspectProductDefinition(definitionInput);
  const definition = inspected.definition;
  const request = data(requestInput, 'request');
  fields(request, ['format', 'definitionDigest', 'definitionArtifact', 'requestArtifact', 'execution', 'releasePlan'], 'request');
  if (request.format !== 'faktori.product-delivery-request/v1') throw new Error('request.format must be faktori.product-delivery-request/v1');
  if (request.definitionDigest !== inspected.definitionDigest) throw new Error('request.definitionDigest does not match the inspected product definition');
  const requiredBindings: ProductDeliveryCompilation['requiredBindings'] = [];
  const need = (path: string, kind: 'decision' | 'capability', reason: string): void => { requiredBindings.push({ path, kind, reason }); };
  if (!inspected.readyForDesign) need('definition', 'decision', 'Resolve blocking discovery questions and obtain owner acceptance of this exact definition before implementation.');
  if (definition.existingProduct && !REVISION.test(definition.existingProduct.baseline.revision) && !DIGEST.test(definition.existingProduct.baseline.revision)) {
    need('definition.existingProduct.baseline.revision', 'decision', 'Existing-product execution needs an exact deployed baseline revision or artifact digest; a branch, tag or planning label is insufficient.');
  }
  const included = new Set(definition.scope.includedRequirementIds);
  const requirements = definition.requirements.filter((item) => item.status === 'accepted' && included.has(item.id));
  const relevantScenarios = definition.acceptanceScenarios.filter((item) => item.status === 'accepted' && item.requirementIds.some((id) => included.has(id)));
  for (const scenario of relevantScenarios) {
    if (scenario.requirementIds.some((id) => !included.has(id))) need(`definition.acceptanceScenarios.${scenario.id}`, 'decision', 'Split cross-scope acceptance scenarios or explicitly include their requirements; compilation cannot extend accepted execution scope.');
  }
  const scenarios = relevantScenarios.filter((item) => item.requirementIds.every((id) => included.has(id)));
  if (requirements.length === 0 || scenarios.length === 0) need('definition.acceptanceScenarios', 'decision', 'A coherent feature needs accepted requirements and linked behavior acceptance scenarios.');

  const definitionArtifact = request.definitionArtifact === undefined ? undefined : artifact(request.definitionArtifact, 'request.definitionArtifact');
  const requestArtifact = request.requestArtifact === undefined ? undefined : artifact(request.requestArtifact, 'request.requestArtifact');
  if (!definitionArtifact) need('definitionArtifact', 'decision', 'Bind the accepted definition file by absolute path and its current file-byte digest.');
  if (!requestArtifact) need('requestArtifact', 'decision', 'Bind the owner execution/release request file by absolute path and its current file-byte digest.');
  const execution = request.execution === undefined ? {} : data(request.execution, 'request.execution');
  const executionFields = ['loopId', 'workspace', 'artifactsDirectory', 'approval', 'candidate', 'provider', 'roleRoutes', 'review', 'toolchain', 'limits', 'acceptanceCommand', 'repairApproval', 'subscriptionRouting'];
  fields(execution, executionFields, 'request.execution');
  for (const key of executionFields.filter((key) => !['repairApproval', 'subscriptionRouting'].includes(key))) {
    if (execution[key] === undefined) need(`execution.${key}`, 'decision', 'Supply the execution owner binding; discovery cannot infer execution authority or resource configuration.');
  }
  if (execution.workspace !== undefined && data(execution.workspace, 'execution.workspace').nativeAccessApproved !== true) need('execution.workspace.nativeAccessApproved', 'decision', 'Native workspace access requires explicit owner authority.');
  if (execution.workspace !== undefined) {
    const workspacePath = data(execution.workspace, 'execution.workspace').path;
    if (typeof workspacePath === 'string' && isAbsolute(workspacePath)) {
      for (const [bindingPath, binding] of [['definitionArtifact', definitionArtifact], ['requestArtifact', requestArtifact]] as const) {
        if (!binding) continue;
        const location = relative(resolve(workspacePath), resolve(binding.path));
        if (!location || location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) need(bindingPath, 'decision', 'Copy this approved immutable handoff file inside the approved worker workspace and bind its bytes there; existing worker authority does not permit outside-workspace reads.');
      }
    }
  }
  if (execution.approval !== undefined) {
    const approval = data(execution.approval, 'execution.approval');
    if (approval.approved !== true || approval.scopeRevision !== definition.revision) need('execution.approval', 'decision', 'Execution approval must be supplied by the owner and bound to this definition revision.');
  }
  if (execution.repairApproval !== undefined) {
    const approval = data(execution.repairApproval, 'execution.repairApproval');
    if (approval.approved !== true || approval.scopeRevision !== definition.revision) need('execution.repairApproval', 'decision', 'Repair authority must bind the same accepted definition revision.');
  }
  if (execution.candidate !== undefined && data(execution.candidate, 'execution.candidate').inputCompleteness !== 'complete') need('execution.candidate.inputCompleteness', 'decision', 'Resolve missing candidate inputs before compiling an execution configuration.');
  const capabilityObservations: ProductDeliveryCompilation['capabilityObservations'] = [
    { capability: 'workspace_and_dependencies', status: 'unknown', detail: 'Exact base revision, file digests, access and dependency revisions are checked by existing loop preflight.' },
    { capability: 'platform_build_and_release', status: 'unknown', detail: 'A declared release contract is not an observed build, signing, deployment or live acceptance receipt.' },
  ];
  if (execution.provider !== undefined) {
    const provider = data(execution.provider, 'execution.provider');
    capabilityObservations.push({ capability: 'provider_quota', status: provider.knownQuota === 'available' ? 'declared' : provider.knownQuota === 'exhausted' ? 'unavailable' : 'unknown', detail: 'Caller quota declaration; provider availability is checked by existing execution preflight.' });
    if (provider.knownQuota === 'exhausted') need('execution.provider.knownQuota', 'capability', 'The configured provider is exhausted; do not switch to separately billed inference.');
  }

  let releasePlan: ProductReleasePlan | undefined;
  if (request.releasePlan === undefined) {
    need('releasePlan', 'decision', 'Name target environments, release owners, exact resource revisions, artifact/distribution contracts, acceptance and rollback.');
  } else {
    const plan = data(request.releasePlan, 'releasePlan');
    fields(plan, ['targets', 'compatibility'], 'releasePlan');
    if (!Array.isArray(plan.targets) || plan.targets.length > 3) throw new Error('releasePlan.targets must contain at most three platform contracts');
    const targets = plan.targets.map((value, index): ProductReleaseTarget => {
      const path = `releasePlan.targets[${index}]`;
      const target = data(value, path);
      fields(target, ['platform', 'environment', 'resourceRevision', 'releaseOwner', 'artifactContract', 'distributionContract', 'postDeployAcceptance', 'rollbackPlan'], path);
      if (!['web', 'ios', 'android'].includes(String(target.platform))) throw new Error(`${path}.platform is invalid`);
      const resourceRevision = text(target.resourceRevision, `${path}.resourceRevision`, 128);
      if (!REVISION.test(resourceRevision) && !DIGEST.test(resourceRevision)) throw new Error(`${path}.resourceRevision must be an exact Git revision or sha256 configuration digest`);
      return {
        platform: target.platform as Platform, resourceRevision,
        environment: text(target.environment, `${path}.environment`, 512), releaseOwner: text(target.releaseOwner, `${path}.releaseOwner`, 128),
        artifactContract: text(target.artifactContract, `${path}.artifactContract`), distributionContract: text(target.distributionContract, `${path}.distributionContract`),
        postDeployAcceptance: text(target.postDeployAcceptance, `${path}.postDeployAcceptance`), rollbackPlan: text(target.rollbackPlan, `${path}.rollbackPlan`),
      };
    });
    const seen = new Set<Platform>();
    for (const target of targets) {
      if (seen.has(target.platform) || !definition.platforms.targets.includes(target.platform)) throw new Error('releasePlan.targets must name each selected platform once and no additional platform');
      seen.add(target.platform);
    }
    for (const platform of definition.platforms.targets) if (!seen.has(platform)) need(`releasePlan.targets.${platform}`, 'decision', 'Provide the selected platform build/distribution/release contract.');
    let compatibility: ProductCompatibilityPlan | undefined;
    if (plan.compatibility !== undefined) {
      const input = data(plan.compatibility, 'releasePlan.compatibility');
      fields(input, ['baselineRevision', 'supportedClientContract', 'migrationPlan', 'regressionAcceptance', 'concurrentWorkBoundary'], 'releasePlan.compatibility');
      compatibility = {
        baselineRevision: text(input.baselineRevision, 'releasePlan.compatibility.baselineRevision', 128),
        supportedClientContract: text(input.supportedClientContract, 'releasePlan.compatibility.supportedClientContract'),
        migrationPlan: text(input.migrationPlan, 'releasePlan.compatibility.migrationPlan'), regressionAcceptance: text(input.regressionAcceptance, 'releasePlan.compatibility.regressionAcceptance'),
        concurrentWorkBoundary: text(input.concurrentWorkBoundary, 'releasePlan.compatibility.concurrentWorkBoundary'),
      };
      if (!definition.existingProduct) throw new Error('A new-product delivery cannot introduce an existing-product baseline');
      if (compatibility.baselineRevision !== definition.existingProduct.baseline.revision) throw new Error('releasePlan.compatibility baseline does not match accepted existing-product discovery');
    } else if (definition.existingProduct) need('releasePlan.compatibility', 'decision', 'Bind the accepted deployed baseline, supported clients/contracts, migration and regression plan, and concurrent work ownership.');
    releasePlan = { targets, ...(compatibility ? { compatibility } : {}) };
  }

  const dependencies: LeanLoopConfiguration['candidate']['dependencies'] = [];
  if (execution.candidate !== undefined) {
    const declared = data(execution.candidate, 'execution.candidate').dependencies;
    if (!Array.isArray(declared)) throw new Error('execution.candidate.dependencies must be an explicit array');
    // The existing parser validates and copies all of these before use.
    dependencies.push(...structuredClone(declared) as LeanLoopConfiguration['candidate']['dependencies']);
  }
  if (dependencies.some((item) => ['product-definition', 'product-delivery-request'].includes(item.id))) throw new Error('Execution dependencies must not override compiler-owned artifact dependency IDs');
  if (definitionArtifact) dependencies.push({ id: 'product-definition', kind: 'file', ...definitionArtifact });
  if (requestArtifact) dependencies.push({ id: 'product-delivery-request', kind: 'file', ...requestArtifact });

  const hierarchy = inspected.readyForDesign ? structuredClone(compileProductHierarchy(definition)) : undefined;
  let context = hierarchy ? assembleContextPacket(hierarchy, definition.productId) : undefined;
  const briefConstraints = [
    'Implement only the accepted included requirements as one coherent outcome. Use their linked behavior scenarios for one feature-sized acceptance command. Accepted out-of-scope requirements and model proposals in the definition are not implementation authority.',
    'Publication, merge and release remain subject to existing owner authority; no separately billed provider fallback. Preserve the pinned handoff files without edits.',
  ];
  // This brief is consumed by the actual existing worker/reviewer prompt. The
  // returned rich context alone would not carry these facts into execution.
  const workerHandoff = {
    definition: { productId: definition.productId, revision: definition.revision, digest: inspected.definitionDigest, artifact: definitionArtifact },
    executionAndReleaseArtifact: requestArtifact,
    includedRequirementIds: [...included],
    inheritedConstraints: context ? [...context.constraints.global, ...context.constraints.ancestors, ...context.constraints.local] : [],
    users: definition.users.filter((entry) => entry.status === 'accepted'),
    outcomes: definition.outcomes.filter((entry) => entry.status === 'accepted'),
    journeys: definition.journeys.filter((entry) => entry.status === 'accepted' && entry.requirementIds.some((id) => included.has(id))).map((entry) => ({ ...entry, requirementIds: entry.requirementIds.filter((id) => included.has(id)) })),
    roles: definition.roles.filter((entry) => entry.status === 'accepted'),
    data: definition.data.filter((entry) => entry.status === 'accepted'),
    integrations: definition.integrations.filter((entry) => entry.status === 'accepted'),
    resources: definition.resources.filter((entry) => entry.status === 'accepted'),
    platforms: definition.platforms,
    existingProduct: definition.existingProduct,
    releasePlan,
  };
  const handoffText = stable(workerHandoff);
  const chunkSize = 3500;
  const chunkCount = Math.ceil(handoffText.length / chunkSize);
  if (chunkCount + briefConstraints.length + 1 > 100) {
    need('definition.scope', 'decision', 'The complete inherited execution handoff exceeds the existing bounded brief limit; obtain a smaller coherent accepted slice rather than truncate constraints.');
  } else {
    for (let index = 0; index < chunkCount; index++) briefConstraints.push(`Complete accepted handoff JSON part ${index + 1}/${chunkCount} (concatenate parts in order): ${handoffText.slice(index * chunkSize, (index + 1) * chunkSize)}`);
    briefConstraints.push('Read the pinned definition and execution/release artifacts at the explicit workspace paths above for complete source provenance. Their file dependencies must remain unchanged; stop on a missing or mismatched artifact.');
    if (briefConstraints.length > 100) need('definition.scope', 'decision', 'The complete inherited execution handoff exceeds the existing bounded brief limit; obtain a smaller coherent accepted slice rather than truncate constraints.');
  }
  let leanConfiguration: ProductDeliveryLoopInput | undefined;
  if (requiredBindings.length === 0 && hierarchy) {
    const command = data(execution.acceptanceCommand, 'execution.acceptanceCommand');
    fields(command, ['command', 'args'], 'execution.acceptanceCommand');
    const { acceptanceCommand: _acceptanceCommand, ...operationalExecution } = execution;
    const parsed = parseLeanLoopConfiguration({
      ...operationalExecution, format: 'faktori.lean-loop/v1', profile: 'implementation',
      candidate: { ...data(execution.candidate, 'execution.candidate'), dependencies },
      implementationBrief: { approved: true, objective: definition.rawIdea, constraints: briefConstraints },
      requirements: requirements.map(({ id, text: requirementText }) => ({ id, text: requirementText })),
      acceptanceCriteria: scenarios.map((scenario) => ({ id: scenario.id, requirementIds: scenario.requirementIds, expectedOutcome: `Given ${scenario.given}; when ${scenario.when}; then ${scenario.then}` })),
      verification: [command],
    });
    const { phases, ...rawConfiguration } = parsed;
    leanConfiguration = { ...rawConfiguration, verification: phases[0].verification };
    const revision = definition.revision;
    const source = (id: string, value: string): SourceRecord => ({ id, text: value, revision });
    const nodeId = `delivery.${parsed.loopId}`;
    if (hierarchy.nodes.some((node) => node.id === nodeId)) throw new Error('Delivery node identity conflicts with product hierarchy');
    hierarchy.nodes.push({
      id: nodeId, kind: 'executable', label: `Implement ${definition.productId}`, parentId: definition.productId,
      objective: source(`${nodeId}.objective`, definition.rawIdea),
      criteria: leanConfiguration.acceptanceCriteria.map((criterion) => source(criterion.id, criterion.expectedOutcome)),
      constraints: briefConstraints.map((constraint, index) => source(`${nodeId}.constraint.${index}`, constraint)), designReferences: [],
      artifacts: dependencies.map((dependency) => source(`artifact.${dependency.id}`, stable(dependency))),
      commands: [{ command: stable(phases[0].verification[0]), revision }],
      authority: [source(`${nodeId}.approval`, stable(parsed.approval))],
      evidenceRequirements: [source(`${nodeId}.evidence`, 'Existing Lean loop independent review and candidate acceptance; publication, merge, exact-revision deployment and observed behavior remain pending.')],
    });
    context = assembleContextPacket(hierarchy, nodeId);
  }
  return freeze({
    format: 'faktori.product-delivery-compilation/v1', status: leanConfiguration ? 'ready_for_loop' : 'needs_bindings',
    productId: definition.productId, definitionRevision: definition.revision, definitionDigest: inspected.definitionDigest,
    requiredBindings, capabilityObservations, platformContract: definition.platforms, ...(releasePlan ? { releasePlan } : {}), ...(context ? { context } : {}),
    artifactHandoff: { definitionDigest: inspected.definitionDigest, dependencies, requirementIds: requirements.map((item) => item.id), scenarioIds: scenarios.map((item) => item.id), authority: 'caller_supplied', resourceEvidence: 'declared_not_observed', releaseEvidence: 'pending' },
    ...(leanConfiguration ? { leanConfiguration } : {}),
  });
}

/** Refuses pending handoffs; returned JSON can be passed to `faktori loop run`. */
export function serializeProductDeliveryLoop(compilation: ProductDeliveryCompilation): ProductDeliveryLoopInput {
  if (compilation.status !== 'ready_for_loop' || !compilation.leanConfiguration) throw new Error('Product delivery is missing required owner bindings');
  return compilation.leanConfiguration;
}
