// The parser deliberately accepts unknown JSON and validates it into these contracts.
// Its implementation stays data-oriented so every sparse-property presence check remains exact.
type Issue = { path: string; message: string };
type InputRecord = Record<string, unknown>;
type ResolvedScope = { providerId?: string; environmentId?: string; executionProfile: ExecutionProfile; requiredCapabilities: ProviderCapability[] };
type ResolvedProduct = { id?: string; name?: string } & ResolvedScope & { budget: Budget; authority: Authority; roleAssignments?: FactoryRoleAssignment[] };
type ResolvedPod = { id?: string; productId?: string } & ResolvedScope & { budget: Budget; authority: Authority; roleAssignments?: FactoryRoleAssignment[] };
export type ProviderKind = 'claude-code' | 'codex' | 'cursor';
export type ProviderCapability = 'isolated' | 'native' | 'subagents' | 'token-limit';
export type EnvironmentKind = 'local' | 'preview' | 'production';
export type ExecutionProfile = 'isolated' | 'native';
export interface Budget { maxConcurrentRuns: number; maxRetries: number; maxRuntimeMinutes: number; maxTokens: number; strictSpending: boolean; }
export interface Authority { requireIntentApproval: boolean; requireSpecificationApproval: boolean; requireIndependentReview: boolean; mergeAuthority: 'human' | 'coordinator'; productionReleaseAuthority: 'human' | 'coordinator'; allowPreviewDeployment: boolean; allowLocalDeployment: boolean; allowSeparateBilling: boolean; }
export interface FactoryRoleAssignment { role: string; providerId: string; model?: string; reasoning?: 'low' | 'medium' | 'high'; rolePrompt?: string; }
export type BudgetOverride = Partial<Budget>;
export type AuthorityOverride = Partial<Authority> & { riskAcknowledgements?: Partial<Record<keyof Authority, string>> };
export interface ScopeOverride { providerId?: string; environmentId?: string; executionProfile?: ExecutionProfile; requiredCapabilities?: ProviderCapability[]; }
export interface TargetOverrides extends ScopeOverride { budget?: BudgetOverride; authority?: AuthorityOverride; roleAssignments?: FactoryRoleAssignment[]; }
export interface FactoryConfiguration { factory: { id: string; name: string; defaults?: TargetOverrides }; providers: Array<{ id: string; kind: ProviderKind; capabilities: ProviderCapability[] }>; environments: Array<{ id: string; kind: EnvironmentKind }>; products: Array<{ id: string; name: string; overrides?: TargetOverrides }>; pods: Array<{ id: string; productId: string; overrides?: TargetOverrides }>; }
export interface ResolvedTarget extends Required<ScopeOverride> { budget: Budget; authority: Authority; roleAssignments?: FactoryRoleAssignment[]; }
export interface ResolvedFactoryConfiguration { factory: { id: string; name: string; defaults: ResolvedTarget }; providers: FactoryConfiguration['providers']; environments: FactoryConfiguration['environments']; products: Array<{ id: string; name: string } & ResolvedTarget>; pods: Array<{ id: string; productId: string } & ResolvedTarget>; }

/** @typedef {'claude-code' | 'codex' | 'cursor'} ProviderKind */
/** @typedef {'isolated' | 'native' | 'subagents' | 'token-limit'} ProviderCapability */
/** @typedef {'local' | 'preview' | 'production'} EnvironmentKind */
/** @typedef {'isolated' | 'native'} ExecutionProfile */

const PROVIDER_KINDS = new Set(['claude-code', 'codex', 'cursor']);
const CAPABILITIES = new Set(['isolated', 'native', 'subagents', 'token-limit']);
const ENVIRONMENT_KINDS = new Set(['local', 'preview', 'production']);
const EXECUTION_PROFILES = new Set(['isolated', 'native']);

const DEFAULT_BUDGET = Object.freeze({
  maxConcurrentRuns: 1,
  maxRetries: 0,
  maxRuntimeMinutes: 60,
  maxTokens: 0,
  strictSpending: true,
});

const DEFAULT_AUTHORITY = Object.freeze({
  requireIntentApproval: true,
  requireSpecificationApproval: true,
  requireIndependentReview: true,
  mergeAuthority: 'human',
  productionReleaseAuthority: 'human',
  allowPreviewDeployment: false,
  allowLocalDeployment: false,
  allowSeparateBilling: false,
});

const BUDGET_KEYS = new Set(Object.keys(DEFAULT_BUDGET));
const AUTHORITY_KEYS = new Set([...Object.keys(DEFAULT_AUTHORITY), 'riskAcknowledgements']);
const SCOPE_KEYS = new Set(['providerId', 'environmentId', 'executionProfile', 'requiredCapabilities']);

/** A validation error that names every invalid configuration path. */
export class ConfigValidationError extends Error {
  issues: Issue[];
  /** @param {{ path: string, message: string }[]} issues */
  constructor(issues: Issue[]) {
    super(`Invalid factory configuration:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'ConfigValidationError';
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
function addIssue(issues: Issue[], path: string, message: string): void {
  issues.push({ path, message });
}

/** @param {unknown} value @param {string} path @param {{ path: string, message: string }[]} issues */
function record(value: unknown, path: string, issues: Issue[]): InputRecord {
  if (isRecord(value)) return value;
  addIssue(issues, path, 'must be an object');
  return {};
}

/** @param {Record<string, unknown>} value @param {Set<string>} allowed @param {string} path @param {{ path: string, message: string }[]} issues */
function rejectUnknownKeys(value: InputRecord, allowed: Set<string>, path: string, issues: Issue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addIssue(issues, `${path}.${key}`, 'is not a supported setting');
  }
}

/** @param {unknown} value @param {string} path @param {{ path: string, message: string }[]} issues */
function requiredString(value: unknown, path: string, issues: Issue[]): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    addIssue(issues, path, 'must be a non-empty string');
    return undefined;
  }
  return value;
}

/** @param {unknown} value @param {string} path @param {{ path: string, message: string }[]} issues */
function stringArray(value: unknown, path: string, issues: Issue[]): string[] {
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'must be an array');
    return [];
  }
  return value.map((item, index) => requiredString(item, `${path}[${index}]`, issues)).filter((item): item is string => item !== undefined);
}

/** @param {unknown} value @param {string} path @param {{ path: string, message: string }[]} issues */
function positiveInteger(value: unknown, path: string, issues: Issue[]): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    addIssue(issues, path, 'must be an integer greater than or equal to 1');
    return undefined;
  }
  return value;
}

/** @param {unknown} value @param {string} path @param {{ path: string, message: string }[]} issues */
function nonNegativeInteger(value: unknown, path: string, issues: Issue[]): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    addIssue(issues, path, 'must be a non-negative integer');
    return undefined;
  }
  return value;
}

/** @param {Record<string, unknown> | undefined} base @param {unknown} sparse @param {string} path @param {{ path: string, message: string }[]} issues */
function mergeBudget(base: Partial<Budget> | undefined, sparse: unknown, path: string, issues: Issue[]): Budget {
  const result = { ...DEFAULT_BUDGET, ...(base ?? {}) };
  if (sparse === undefined) return result;
  const override = record(sparse, path, issues);
  rejectUnknownKeys(override, BUDGET_KEYS, path, issues);

  if (hasOwn(override, 'maxConcurrentRuns')) {
    const value = positiveInteger(override.maxConcurrentRuns, `${path}.maxConcurrentRuns`, issues);
    if (value !== undefined) result.maxConcurrentRuns = value;
  }
  if (hasOwn(override, 'maxRetries')) {
    const value = nonNegativeInteger(override.maxRetries, `${path}.maxRetries`, issues);
    if (value !== undefined) result.maxRetries = value;
  }
  if (hasOwn(override, 'maxRuntimeMinutes')) {
    const value = positiveInteger(override.maxRuntimeMinutes, `${path}.maxRuntimeMinutes`, issues);
    if (value !== undefined) result.maxRuntimeMinutes = value;
  }
  if (hasOwn(override, 'maxTokens')) {
    const value = nonNegativeInteger(override.maxTokens, `${path}.maxTokens`, issues);
    if (value !== undefined) result.maxTokens = value;
  }
  if (hasOwn(override, 'strictSpending')) {
    if (typeof override.strictSpending !== 'boolean') addIssue(issues, `${path}.strictSpending`, 'must be a boolean');
    else result.strictSpending = override.strictSpending;
  }
  return result;
}

/** @param {string} key @param {unknown} next @param {unknown} previous */
function relaxesAuthority(key: string, next: unknown, previous: unknown): boolean {
  if (key === 'mergeAuthority' || key === 'productionReleaseAuthority') return previous === 'human' && next === 'coordinator';
  if (key === 'allowPreviewDeployment' || key === 'allowLocalDeployment' || key === 'allowSeparateBilling') {
    return previous === false && next === true;
  }
  return previous === true && next === false;
}

/** @param {Record<string, unknown>} acknowledgements @param {string} key */
function hasAcknowledgement(acknowledgements: InputRecord, key: string): boolean {
  const acknowledgement = acknowledgements[key];
  return typeof acknowledgement === 'string' && acknowledgement.trim().length > 0;
}

/** @param {Record<string, unknown> | undefined} base @param {unknown} sparse @param {string} path @param {{ path: string, message: string }[]} issues */
function mergeAuthority(base: Partial<Authority> | undefined, sparse: unknown, path: string, issues: Issue[]): Authority {
  const result = { ...DEFAULT_AUTHORITY, ...(base ?? {}) };
  if (sparse === undefined) return result;
  const override = record(sparse, path, issues);
  rejectUnknownKeys(override, AUTHORITY_KEYS, path, issues);
  const acknowledgements = isRecord(override.riskAcknowledgements) ? override.riskAcknowledgements : {};
  if (hasOwn(override, 'riskAcknowledgements') && !isRecord(override.riskAcknowledgements)) {
    addIssue(issues, `${path}.riskAcknowledgements`, 'must be an object keyed by the relaxed authority setting');
  }

  for (const key of Object.keys(DEFAULT_AUTHORITY) as Array<keyof Authority>) {
    if (!hasOwn(override, key)) continue;
    const next = override[key];
    const previous = result[key];
    const isBoolean = typeof previous === 'boolean';
    const valid = isBoolean
      ? typeof next === 'boolean'
      : (next === 'human' || next === 'coordinator');
    if (!valid) {
      addIssue(issues, `${path}.${key}`, isBoolean ? 'must be a boolean' : 'must be "human" or "coordinator"');
      continue;
    }
    if (relaxesAuthority(key, next, previous) && !hasAcknowledgement(acknowledgements, key)) {
      addIssue(issues, `${path}.${key}`, 'relaxation requires a non-empty risk acknowledgement');
      continue;
    }
    if (key === 'mergeAuthority' || key === 'productionReleaseAuthority') {
      result[key] = next === 'coordinator' ? 'coordinator' : 'human';
    } else {
      result[key] = next === true;
    }
  }
  return result;
}

/** @param {Record<string, unknown> | undefined} base @param {unknown} sparse @param {string} path @param {{ path: string, message: string }[]} issues */
function mergeScope(base: Partial<ScopeOverride> | undefined, sparse: unknown, path: string, issues: Issue[]): ResolvedScope {
  const result = {
    providerId: base?.providerId,
    environmentId: base?.environmentId,
    executionProfile: base?.executionProfile ?? 'isolated',
    requiredCapabilities: [...(base?.requiredCapabilities ?? [])],
  };
  if (sparse === undefined) return result;
  const override = record(sparse, path, issues);
  for (const key of ['providerId', 'environmentId'] as const) {
    if (!hasOwn(override, key)) continue;
    const value = requiredString(override[key], `${path}.${key}`, issues);
    if (value !== undefined) result[key] = value;
  }
  if (hasOwn(override, 'executionProfile')) {
    if (typeof override.executionProfile !== 'string' || !EXECUTION_PROFILES.has(override.executionProfile)) {
      addIssue(issues, `${path}.executionProfile`, 'must be "isolated" or "native"');
    } else result.executionProfile = override.executionProfile === 'native' ? 'native' : 'isolated';
  }
  if (hasOwn(override, 'requiredCapabilities')) {
    const capabilities = stringArray(override.requiredCapabilities, `${path}.requiredCapabilities`, issues);
    capabilities.forEach((capability, index) => {
      if (!CAPABILITIES.has(capability)) addIssue(issues, `${path}.requiredCapabilities[${index}]`, `unsupported capability "${capability}"`);
    });
    result.requiredCapabilities = capabilities.filter((capability): capability is ProviderCapability => CAPABILITIES.has(capability));
  }
  return result;
}

/** @param {Map<string, { id: string, kind: string, capabilities: string[] }>} providers @param {Map<string, { id: string, kind: string }>} environments @param {{ providerId?: string, environmentId?: string, executionProfile: string, requiredCapabilities: string[], budget: Record<string, unknown> }} target @param {string} path @param {{ path: string, message: string }[]} issues @param {{ providerId?: string, environmentId?: string, executionProfile?: string, requiredCapabilities?: string }} [sourcePaths] */
function validateResolvedTarget(providers: Map<string, { id: string; capabilities: ProviderCapability[] }>, environments: Map<string, unknown>, target: ResolvedScope & { budget: Budget }, path: string, issues: Issue[], sourcePaths: Partial<Record<keyof ScopeOverride, string>> = {}): void {
  const providerPath = sourcePaths.providerId ?? `${path}.providerId`;
  const environmentPath = sourcePaths.environmentId ?? `${path}.environmentId`;
  const executionProfilePath = sourcePaths.executionProfile ?? `${path}.executionProfile`;
  const requiredCapabilitiesPath = sourcePaths.requiredCapabilities ?? `${path}.requiredCapabilities`;
  if (!target.providerId) addIssue(issues, providerPath, 'must resolve from factory defaults or an explicit override');
  if (!target.environmentId) addIssue(issues, environmentPath, 'must resolve from factory defaults or an explicit override');
  const provider = target.providerId ? providers.get(target.providerId) : undefined;
  if (target.providerId && !provider) addIssue(issues, providerPath, `unknown provider "${target.providerId}"`);
  if (target.environmentId && !environments.has(target.environmentId)) addIssue(issues, environmentPath, `unknown environment "${target.environmentId}"`);
  if (!provider) return;
  const required = new Set([target.executionProfile, ...target.requiredCapabilities]);
  if (target.budget.strictSpending) required.add('token-limit');
  for (const capability of required) {
    if (provider.capabilities.includes(capability)) continue;
    const capabilityPath = capability === target.executionProfile
      ? executionProfilePath
      : capability === 'token-limit'
        ? `${path}.budget.strictSpending`
        : requiredCapabilitiesPath;
    addIssue(issues, capabilityPath, `provider "${provider.id}" does not support capability "${capability}"`);
  }
}

function mergeRoleAssignments(base: FactoryRoleAssignment[] | undefined, sparse: unknown, path: string, providers: Map<string, unknown>, issues: Issue[]): FactoryRoleAssignment[] | undefined {
  if (sparse === undefined) return base?.map((assignment) => ({ ...assignment }));
  if (!Array.isArray(sparse)) {
    addIssue(issues, path, 'must be an array');
    return base?.map((assignment) => ({ ...assignment }));
  }
  const roles = new Set<string>();
  const assignments: FactoryRoleAssignment[] = [];
  sparse.forEach((value, index) => {
    const itemPath = `${path}[${index}]`;
    const assignment = record(value, itemPath, issues);
    rejectUnknownKeys(assignment, new Set(['role', 'providerId', 'model', 'reasoning', 'rolePrompt']), itemPath, issues);
    const role = requiredString(assignment.role, `${itemPath}.role`, issues);
    const providerId = requiredString(assignment.providerId, `${itemPath}.providerId`, issues);
    if (role !== undefined && (role.length > 64 || !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(role))) addIssue(issues, `${itemPath}.role`, 'must be a lowercase role slug of at most 64 characters');
    if (role !== undefined && roles.has(role)) addIssue(issues, `${itemPath}.role`, `duplicates role "${role}"`);
    if (role !== undefined) roles.add(role);
    if (providerId !== undefined && !providers.has(providerId)) addIssue(issues, `${itemPath}.providerId`, `unknown provider "${providerId}"`);
    const model = assignment.model;
    if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0 || model.length > 128)) addIssue(issues, `${itemPath}.model`, 'must be a bounded non-empty string');
    const reasoning = assignment.reasoning;
    if (reasoning !== undefined && reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high') addIssue(issues, `${itemPath}.reasoning`, 'must be "low", "medium", or "high"');
    const rolePrompt = assignment.rolePrompt;
    if (rolePrompt !== undefined && (typeof rolePrompt !== 'string' || rolePrompt.length > 16_000)) addIssue(issues, `${itemPath}.rolePrompt`, 'must be a string of at most 16000 characters');
    if (role !== undefined && providerId !== undefined) assignments.push({ role, providerId, ...(typeof model === 'string' && model.trim().length > 0 && model.length <= 128 ? { model } : {}), ...(reasoning === 'low' || reasoning === 'medium' || reasoning === 'high' ? { reasoning } : {}), ...(typeof rolePrompt === 'string' && rolePrompt.trim().length > 0 && rolePrompt.length <= 16_000 ? { rolePrompt } : {}) });
  });
  return assignments;
}

/**
 * Parse and resolve a versioned factory configuration. A missing property inherits;
 * a present property is always validated, including false, zero, and empty values.
 *
 * @param {unknown} configuration
 */
export function resolveFactoryConfig(configuration: unknown): ResolvedFactoryConfiguration;
export function resolveFactoryConfig(configuration: unknown) {
  const issues: Issue[] = [];
  const config = record(configuration, 'configuration', issues);
  const factory = record(config.factory, 'factory', issues);
  const factoryId = requiredString(factory.id, 'factory.id', issues);
  const factoryName = requiredString(factory.name, 'factory.name', issues);
  const defaults = factory.defaults === undefined ? {} : record(factory.defaults, 'factory.defaults', issues);
  rejectUnknownKeys(defaults, new Set(['providerId', 'environmentId', 'executionProfile', 'requiredCapabilities', 'budget', 'authority', 'roleAssignments']), 'factory.defaults', issues);

  const providers = new Map();
  const providerValues = Array.isArray(config.providers) ? config.providers : [];
  if (!Array.isArray(config.providers)) addIssue(issues, 'providers', 'must be an array');
  providerValues.forEach((value, index) => {
    const path = `providers[${index}]`;
    const provider = record(value, path, issues);
    rejectUnknownKeys(provider, new Set(['id', 'kind', 'capabilities']), path, issues);
    const id = requiredString(provider.id, `${path}.id`, issues);
    if (typeof provider.kind !== 'string' || !PROVIDER_KINDS.has(provider.kind)) addIssue(issues, `${path}.kind`, 'must be "claude-code", "codex", or "cursor"');
    const capabilities = stringArray(provider.capabilities, `${path}.capabilities`, issues);
    capabilities.forEach((capability, capabilityIndex) => {
      if (!CAPABILITIES.has(capability)) addIssue(issues, `${path}.capabilities[${capabilityIndex}]`, `unsupported capability "${capability}"`);
    });
    if (id) {
      if (providers.has(id)) addIssue(issues, `${path}.id`, `duplicates provider "${id}"`);
      else providers.set(id, { id, kind: provider.kind, capabilities });
    }
  });

  const environments = new Map();
  const environmentValues = Array.isArray(config.environments) ? config.environments : [];
  if (!Array.isArray(config.environments)) addIssue(issues, 'environments', 'must be an array');
  environmentValues.forEach((value, index) => {
    const path = `environments[${index}]`;
    const environment = record(value, path, issues);
    rejectUnknownKeys(environment, new Set(['id', 'kind']), path, issues);
    const id = requiredString(environment.id, `${path}.id`, issues);
    if (typeof environment.kind !== 'string' || !ENVIRONMENT_KINDS.has(environment.kind)) addIssue(issues, `${path}.kind`, 'must be "local", "preview", or "production"');
    if (id) {
      if (environments.has(id)) addIssue(issues, `${path}.id`, `duplicates environment "${id}"`);
      else environments.set(id, { id, kind: environment.kind });
    }
  });

  const factoryScope = mergeScope(undefined, defaults, 'factory.defaults', issues);
  const factoryBudget = mergeBudget(undefined, defaults.budget, 'factory.defaults.budget', issues);
  const factoryAuthority = mergeAuthority(undefined, defaults.authority, 'factory.defaults.authority', issues);
  const factoryRoleAssignments = mergeRoleAssignments(undefined, defaults.roleAssignments, 'factory.defaults.roleAssignments', providers, issues);

  const productIds = new Set();
  const products: ResolvedProduct[] = [];
  const productValues = Array.isArray(config.products) ? config.products : [];
  if (!Array.isArray(config.products) || productValues.length === 0) addIssue(issues, 'products', 'must be a non-empty array');
  productValues.forEach((value, index) => {
    const path = `products[${index}]`;
    const product = record(value, path, issues);
    rejectUnknownKeys(product, new Set(['id', 'name', 'overrides']), path, issues);
    const id = requiredString(product.id, `${path}.id`, issues);
    const name = requiredString(product.name, `${path}.name`, issues);
    if (id) {
      if (productIds.has(id)) addIssue(issues, `${path}.id`, `duplicates product "${id}"`);
      productIds.add(id);
    }
    const overrides = product.overrides === undefined ? {} : record(product.overrides, `${path}.overrides`, issues);
    rejectUnknownKeys(overrides, new Set([...SCOPE_KEYS, 'budget', 'authority', 'roleAssignments']), `${path}.overrides`, issues);
    const scope = mergeScope(factoryScope, overrides, `${path}.overrides`, issues);
    const budget = mergeBudget(factoryBudget, overrides.budget, `${path}.overrides.budget`, issues);
    const authority = mergeAuthority(factoryAuthority, overrides.authority, `${path}.overrides.authority`, issues);
    const roleAssignments = mergeRoleAssignments(factoryRoleAssignments, overrides.roleAssignments, `${path}.overrides.roleAssignments`, providers, issues);
    validateResolvedTarget(providers, environments, { ...scope, budget }, path, issues, {
      providerId: hasOwn(overrides, 'providerId') ? `${path}.overrides.providerId` : undefined,
      environmentId: hasOwn(overrides, 'environmentId') ? `${path}.overrides.environmentId` : undefined,
      executionProfile: hasOwn(overrides, 'executionProfile') ? `${path}.overrides.executionProfile` : undefined,
      requiredCapabilities: hasOwn(overrides, 'requiredCapabilities') ? `${path}.overrides.requiredCapabilities` : undefined,
    });
    products.push({ id, name, ...scope, budget, authority, ...(roleAssignments === undefined ? {} : { roleAssignments }) });
  });

  const resolvedProducts = new Map(products.filter((product) => product.id).map((product) => [product.id, product]));
  const podIds = new Set();
  const pods: ResolvedPod[] = [];
  const podValues = Array.isArray(config.pods) ? config.pods : [];
  if (!Array.isArray(config.pods)) addIssue(issues, 'pods', 'must be an array');
  podValues.forEach((value, index) => {
    const path = `pods[${index}]`;
    const pod = record(value, path, issues);
    rejectUnknownKeys(pod, new Set(['id', 'productId', 'overrides']), path, issues);
    const id = requiredString(pod.id, `${path}.id`, issues);
    const productId = requiredString(pod.productId, `${path}.productId`, issues);
    if (id) {
      if (podIds.has(id)) addIssue(issues, `${path}.id`, `duplicates pod "${id}"`);
      podIds.add(id);
    }
    const product = productId ? resolvedProducts.get(productId) : undefined;
    if (productId && !product) addIssue(issues, `${path}.productId`, `unknown product "${productId}"`);
    const overrides = pod.overrides === undefined ? {} : record(pod.overrides, `${path}.overrides`, issues);
    rejectUnknownKeys(overrides, new Set([...SCOPE_KEYS, 'budget', 'authority', 'roleAssignments']), `${path}.overrides`, issues);
    const scope = mergeScope(product ?? factoryScope, overrides, `${path}.overrides`, issues);
    const budget = mergeBudget(product?.budget ?? factoryBudget, overrides.budget, `${path}.overrides.budget`, issues);
    const authority = mergeAuthority(product?.authority ?? factoryAuthority, overrides.authority, `${path}.overrides.authority`, issues);
    const roleAssignments = mergeRoleAssignments(product?.roleAssignments ?? factoryRoleAssignments, overrides.roleAssignments, `${path}.overrides.roleAssignments`, providers, issues);
    validateResolvedTarget(providers, environments, { ...scope, budget }, path, issues, {
      providerId: hasOwn(overrides, 'providerId') ? `${path}.overrides.providerId` : undefined,
      environmentId: hasOwn(overrides, 'environmentId') ? `${path}.overrides.environmentId` : undefined,
      executionProfile: hasOwn(overrides, 'executionProfile') ? `${path}.overrides.executionProfile` : undefined,
      requiredCapabilities: hasOwn(overrides, 'requiredCapabilities') ? `${path}.overrides.requiredCapabilities` : undefined,
    });
    pods.push({ id, productId, ...scope, budget, authority, ...(roleAssignments === undefined ? {} : { roleAssignments }) });
  });

  if (issues.length > 0) throw new ConfigValidationError(issues);
  return {
    factory: { id: factoryId, name: factoryName, defaults: { ...factoryScope, budget: factoryBudget, authority: factoryAuthority, ...(factoryRoleAssignments === undefined ? {} : { roleAssignments: factoryRoleAssignments }) } },
    providers: [...providers.values()].map((provider) => ({ ...provider, capabilities: [...provider.capabilities] })),
    environments: [...environments.values()],
    products,
    pods,
  };
}
