import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Authority, Budget, ExecutionProfile, ProviderCapability, ResolvedFactoryConfiguration } from '../config/index.ts';
import type { AdmissionLimits } from '../runtime/index.ts';
import type { LocalConsoleConfiguration } from './startup.ts';
import type { ConsoleProviderId, ConsoleSettingsScope } from './settings.ts';

export interface ConsoleSettingsDraft {
  factoryName: string;
  providers: ConsoleProviderId[];
  defaults: ConsoleSettingsScope;
  limits: ConsoleEditableLimits;
  products: Array<{ id: string; name: string; overrides: ConsoleSettingsScope }>;
  pods: Array<{ id: string; productId: string; overrides: ConsoleSettingsScope }>;
  routeModels: Array<{ providerId: 'codex' | 'claude'; profile: 'native' | 'isolated'; compatibleModels: string[] }>;
}

export type ConsoleEditableLimits = Omit<AdmissionLimits, 'strictSpendingSupported'>;

export interface ConsoleSettingsRisk {
  id: string;
  kind: 'authority_relaxation' | 'budget_relaxation' | 'access_relaxation';
  path: string;
  summary: string;
}

export interface ConsoleSettingsEditView {
  revision: string;
  draft: ConsoleSettingsDraft;
  restartRequired: boolean;
}

export interface ConsoleSettingsPreview extends ConsoleSettingsEditView {
  changed: boolean;
  risks: ConsoleSettingsRisk[];
}

export interface ConsoleSettingsEditor {
  status(): { editable: boolean; loadedRevision: string; savedRevision: string; restartRequired: boolean };
  edit(): Promise<ConsoleSettingsEditView>;
  preview(input: unknown): Promise<ConsoleSettingsPreview>;
  save(input: unknown): Promise<ConsoleSettingsPreview>;
}

type JsonObject = Record<string, unknown>;
type Validator = (value: unknown) => LocalConsoleConfiguration;

const PROVIDERS: ConsoleProviderId[] = ['codex', 'claude', 'cursor'];
const CAPABILITIES: ProviderCapability[] = ['isolated', 'native', 'subagents', 'token-limit'];
const AUTHORITY_KEYS: Array<keyof Authority> = ['requireIntentApproval', 'requireSpecificationApproval', 'requireIndependentReview', 'mergeAuthority', 'productionReleaseAuthority', 'allowPreviewDeployment', 'allowLocalDeployment', 'allowSeparateBilling'];
const BUDGET_KEYS: Array<keyof Budget> = ['maxConcurrentRuns', 'maxRetries', 'maxRuntimeMinutes', 'maxTokens', 'strictSpending'];
const SCOPE_KEYS = ['providerId', 'environmentId', 'executionProfile', 'requiredCapabilities', 'budget', 'authority'] as const;
const STANDARD_PROVIDERS: Record<ConsoleProviderId, { id: string; kind: 'codex' | 'claude-code' | 'cursor'; capabilities: ProviderCapability[] }> = {
  codex: { id: 'codex', kind: 'codex', capabilities: ['isolated', 'native', 'subagents', 'token-limit'] },
  claude: { id: 'claude', kind: 'claude-code', capabilities: ['native', 'subagents'] },
  cursor: { id: 'cursor', kind: 'cursor', capabilities: ['native'] },
};
const DEFAULT_AUTHORITY: Authority = { requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true, mergeAuthority: 'human', productionReleaseAuthority: 'human', allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false };

function object(value: unknown, path: string, keys?: readonly string[]): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const result = value as JsonObject;
  if (keys !== undefined) {
    const unknown = Object.keys(result).filter((key) => !keys.includes(key));
    if (unknown.length > 0) throw new Error(`${path} contains unsupported fields: ${unknown.join(', ')}`);
  }
  return result;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) throw new Error(`${path} must be a bounded non-empty string`);
  return value;
}

function strings<T extends string>(value: unknown, path: string, allowed?: readonly T[]): T[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const result = value.map((item, index) => text(item, `${path}[${index}]`) as T);
  if (new Set(result).size !== result.length || (allowed !== undefined && result.some((item) => !allowed.includes(item)))) throw new Error(`${path} contains duplicate or unsupported values`);
  return result;
}

function integer(value: unknown, path: string, minimum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`${path} must be an integer greater than or equal to ${minimum}`);
  return Number(value);
}

function budget(value: unknown, path: string): Budget {
  const item = object(value, path, BUDGET_KEYS);
  if (typeof item.strictSpending !== 'boolean') throw new Error(`${path}.strictSpending must be boolean`);
  return { maxConcurrentRuns: integer(item.maxConcurrentRuns, `${path}.maxConcurrentRuns`, 1), maxRetries: integer(item.maxRetries, `${path}.maxRetries`, 0), maxRuntimeMinutes: integer(item.maxRuntimeMinutes, `${path}.maxRuntimeMinutes`, 1), maxTokens: integer(item.maxTokens, `${path}.maxTokens`, 0), strictSpending: item.strictSpending };
}

function authority(value: unknown, path: string): Authority {
  const item = object(value, path, AUTHORITY_KEYS);
  for (const key of AUTHORITY_KEYS) {
    if ((key === 'mergeAuthority' || key === 'productionReleaseAuthority') ? !['human', 'coordinator'].includes(String(item[key])) : typeof item[key] !== 'boolean') throw new Error(`${path}.${key} is invalid`);
  }
  return item as unknown as Authority;
}

function scope(value: unknown, path: string): ConsoleSettingsScope {
  const item = object(value, path, SCOPE_KEYS);
  const executionProfile = item.executionProfile;
  if (executionProfile !== 'native' && executionProfile !== 'isolated') throw new Error(`${path}.executionProfile is invalid`);
  return { providerId: text(item.providerId, `${path}.providerId`), environmentId: text(item.environmentId, `${path}.environmentId`), executionProfile, requiredCapabilities: strings(item.requiredCapabilities, `${path}.requiredCapabilities`, CAPABILITIES), budget: budget(item.budget, `${path}.budget`), authority: authority(item.authority, `${path}.authority`) };
}

function limits(value: unknown): ConsoleEditableLimits {
  const item = object(value, 'draft.limits', ['maxConcurrentRuns', 'maxRetries', 'maxRuntimeMinutes', 'maxTokens', 'strictSpending']);
  if (typeof item.strictSpending !== 'boolean') throw new Error('draft.limits.strictSpending must be boolean');
  return { maxConcurrentRuns: integer(item.maxConcurrentRuns, 'draft.limits.maxConcurrentRuns', 1), maxRetries: integer(item.maxRetries, 'draft.limits.maxRetries', 0), maxRuntimeMinutes: integer(item.maxRuntimeMinutes, 'draft.limits.maxRuntimeMinutes', 1), maxTokens: integer(item.maxTokens, 'draft.limits.maxTokens', 0), strictSpending: item.strictSpending };
}

function parseDraft(value: unknown): ConsoleSettingsDraft {
  const item = object(value, 'draft', ['factoryName', 'providers', 'defaults', 'limits', 'products', 'pods', 'routeModels']);
  if (!Array.isArray(item.products) || !Array.isArray(item.pods) || !Array.isArray(item.routeModels)) throw new Error('draft products, pods, and routeModels must be arrays');
  return {
    factoryName: text(item.factoryName, 'draft.factoryName'),
    providers: strings(item.providers, 'draft.providers', PROVIDERS),
    defaults: scope(item.defaults, 'draft.defaults'),
    limits: limits(item.limits),
    products: item.products.map((value, index) => { const row = object(value, `draft.products[${index}]`, ['id', 'name', 'overrides']); return { id: text(row.id, `draft.products[${index}].id`), name: text(row.name, `draft.products[${index}].name`), overrides: scope(row.overrides, `draft.products[${index}].overrides`) }; }),
    pods: item.pods.map((value, index) => { const row = object(value, `draft.pods[${index}]`, ['id', 'productId', 'overrides']); return { id: text(row.id, `draft.pods[${index}].id`), productId: text(row.productId, `draft.pods[${index}].productId`), overrides: scope(row.overrides, `draft.pods[${index}].overrides`) }; }),
    routeModels: item.routeModels.map((value, index) => { const row = object(value, `draft.routeModels[${index}]`, ['providerId', 'profile', 'compatibleModels']); if ((row.providerId !== 'codex' && row.providerId !== 'claude') || (row.profile !== 'native' && row.profile !== 'isolated')) throw new Error(`draft.routeModels[${index}] route is invalid`); return { providerId: row.providerId, profile: row.profile, compatibleModels: strings(row.compatibleModels, `draft.routeModels[${index}].compatibleModels`) }; }),
  };
}

function revision(content: string): string { return createHash('sha256').update(content).digest('hex'); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function rawObject(value: unknown, path: string): JsonObject { return object(value, path); }

function scopeDraft(value: ResolvedFactoryConfiguration['factory']['defaults']): ConsoleSettingsScope {
  return { providerId: value.providerId, environmentId: value.environmentId, executionProfile: value.executionProfile, requiredCapabilities: [...value.requiredCapabilities], budget: { ...value.budget }, authority: { ...value.authority } };
}

function toDraft(configuration: LocalConsoleConfiguration): ConsoleSettingsDraft {
  const catalog = configuration.factoryConfiguration;
  if (catalog === undefined) throw new Error('settings_editing_requires_factory_configuration');
  return {
    factoryName: catalog.factory.name,
    providers: PROVIDERS.filter((id) => catalog.providers.some((provider) => provider.kind === STANDARD_PROVIDERS[id].kind)),
    defaults: scopeDraft(catalog.factory.defaults),
    limits: { maxConcurrentRuns: configuration.limits.maxConcurrentRuns, maxRetries: configuration.limits.maxRetries, maxRuntimeMinutes: configuration.limits.maxRuntimeMinutes, maxTokens: configuration.limits.maxTokens, strictSpending: configuration.limits.strictSpending },
    products: catalog.products.map((product) => ({ id: product.id, name: product.name, overrides: scopeDraft(product) })),
    pods: catalog.pods.map((pod) => ({ id: pod.id, productId: pod.productId, overrides: scopeDraft(pod) })),
    routeModels: (configuration.runtime?.providers ?? []).filter((route): route is Extract<typeof route, { id: 'codex' | 'claude' }> => route.id !== 'cursor').map((route) => ({ providerId: route.id, profile: route.profile, compatibleModels: [...route.compatibleModels] })),
  };
}

function setOrDelete(target: JsonObject, key: string, value: unknown, inherited: unknown): void {
  if (same(value, inherited)) delete target[key]; else target[key] = clone(value);
}

function relaxesAuthority(key: keyof Authority, before: Authority[keyof Authority], after: Authority[keyof Authority]): boolean {
  if (key === 'mergeAuthority' || key === 'productionReleaseAuthority') return before === 'human' && after === 'coordinator';
  if (key === 'allowPreviewDeployment' || key === 'allowLocalDeployment' || key === 'allowSeparateBilling') return before === false && after === true;
  return before === true && after === false;
}

function recordAuthorityAcknowledgement(target: JsonObject, key: keyof Authority, inherited: Authority, desired: Authority): void {
  const acknowledgements = rawObject(target.riskAcknowledgements ?? {}, 'authority.riskAcknowledgements');
  if (relaxesAuthority(key, inherited[key], desired[key])) acknowledgements[key] = `Acknowledged through Console settings risk settings:authority_relaxation:${key}.`;
  else delete acknowledgements[key];
  if (Object.keys(acknowledgements).length === 0) delete target.riskAcknowledgements; else target.riskAcknowledgements = acknowledgements;
}

function patchScope(target: JsonObject, baseline: ConsoleSettingsScope, desired: ConsoleSettingsScope, inherited: ConsoleSettingsScope): void {
  for (const key of ['providerId', 'environmentId', 'executionProfile', 'requiredCapabilities'] as const) if (!same(desired[key], baseline[key])) setOrDelete(target, key, desired[key], inherited[key]);
  const budgetTarget = rawObject(target.budget ?? {}, 'budget');
  for (const key of BUDGET_KEYS) if (!same(desired.budget[key], baseline.budget[key])) setOrDelete(budgetTarget, key, desired.budget[key], inherited.budget[key]);
  if (Object.keys(budgetTarget).length === 0) delete target.budget; else target.budget = budgetTarget;
  const authorityTarget = rawObject(target.authority ?? {}, 'authority');
  for (const key of AUTHORITY_KEYS) if (!same(desired.authority[key], baseline.authority[key])) {
    setOrDelete(authorityTarget, key, desired.authority[key], inherited.authority[key]);
    recordAuthorityAcknowledgement(authorityTarget, key, inherited.authority, desired.authority);
  }
  if (Object.keys(authorityTarget).length === 0) delete target.authority; else target.authority = authorityTarget;
}

function patchFactoryDefaults(target: JsonObject, baseline: ConsoleSettingsScope, desired: ConsoleSettingsScope): void {
  for (const key of ['providerId', 'environmentId', 'executionProfile', 'requiredCapabilities'] as const) if (!same(desired[key], baseline[key])) target[key] = clone(desired[key]);
  const budgetTarget = rawObject(target.budget ?? {}, 'factory defaults budget');
  for (const key of BUDGET_KEYS) if (!same(desired.budget[key], baseline.budget[key])) budgetTarget[key] = desired.budget[key];
  if (Object.keys(budgetTarget).length > 0) target.budget = budgetTarget;
  const authorityTarget = rawObject(target.authority ?? {}, 'factory defaults authority');
  for (const key of AUTHORITY_KEYS) if (!same(desired.authority[key], baseline.authority[key])) {
    authorityTarget[key] = desired.authority[key];
    recordAuthorityAcknowledgement(authorityTarget, key, DEFAULT_AUTHORITY, desired.authority);
  }
  if (Object.keys(authorityTarget).length > 0) target.authority = authorityTarget;
}

function routeKey(value: { providerId: string; profile: string }): string { return `${value.providerId}:${value.profile}`; }

function applyDraft(raw: JsonObject, current: LocalConsoleConfiguration, baseline: ConsoleSettingsDraft, desired: ConsoleSettingsDraft, validate: Validator): { raw: JsonObject; configuration: LocalConsoleConfiguration } {
  const next = clone(raw);
  const factoryConfiguration = rawObject(next.factoryConfiguration, 'factoryConfiguration');
  const factory = rawObject(factoryConfiguration.factory, 'factoryConfiguration.factory');
  factory.name = desired.factoryName;
  const defaults = rawObject(factory.defaults ?? {}, 'factoryConfiguration.factory.defaults');
  patchFactoryDefaults(defaults, baseline.defaults, desired.defaults);
  factory.defaults = defaults;
  factoryConfiguration.factory = factory;
  const providerEntries = Array.isArray(factoryConfiguration.providers) ? factoryConfiguration.providers : [];
  for (const id of PROVIDERS) {
    const wasIncluded = baseline.providers.includes(id);
    const included = desired.providers.includes(id);
    if (wasIncluded && !included) factoryConfiguration.providers = (Array.isArray(factoryConfiguration.providers) ? factoryConfiguration.providers : []).filter((entry) => rawObject(entry, 'provider').kind !== STANDARD_PROVIDERS[id].kind);
    if (!wasIncluded && included) (factoryConfiguration.providers as unknown[]).push(clone(STANDARD_PROVIDERS[id]));
  }
  if (factoryConfiguration.providers === undefined) factoryConfiguration.providers = providerEntries;
  next.factoryConfiguration = factoryConfiguration;
  next.limits = { ...rawObject(next.limits, 'limits'), maxConcurrentRuns: desired.limits.maxConcurrentRuns, maxRetries: desired.limits.maxRetries, maxRuntimeMinutes: desired.limits.maxRuntimeMinutes, maxTokens: desired.limits.maxTokens, strictSpending: desired.limits.strictSpending };

  const rawProducts = factoryConfiguration.products;
  const rawPods = factoryConfiguration.pods;
  if (!Array.isArray(rawProducts) || !Array.isArray(rawPods)) throw new Error('factoryConfiguration products and pods must be arrays');
  if (!same(desired.products.map(({ id }) => id), baseline.products.map(({ id }) => id)) || !same(desired.pods.map(({ id, productId }) => ({ id, productId })), baseline.pods.map(({ id, productId }) => ({ id, productId })))) throw new Error('product and pod identities are read-only');

  const currentCatalog = current.factoryConfiguration as ResolvedFactoryConfiguration;
  for (const desiredProduct of desired.products) {
    const before = baseline.products.find((item) => item.id === desiredProduct.id) as typeof desiredProduct;
    const rawProduct = rawObject(rawProducts.find((item) => rawObject(item, 'product').id === desiredProduct.id), `product ${desiredProduct.id}`);
    rawProduct.name = desiredProduct.name;
    const overrides = rawObject(rawProduct.overrides ?? {}, `product ${desiredProduct.id}.overrides`);
    patchScope(overrides, before.overrides, desiredProduct.overrides, desired.defaults);
    if (Object.keys(overrides).length === 0) delete rawProduct.overrides; else rawProduct.overrides = overrides;
  }
  const afterProducts = validate(next).factoryConfiguration as ResolvedFactoryConfiguration;
  for (const desiredPod of desired.pods) {
    const before = baseline.pods.find((item) => item.id === desiredPod.id) as typeof desiredPod;
    const rawPod = rawObject(rawPods.find((item) => rawObject(item, 'pod').id === desiredPod.id), `pod ${desiredPod.id}`);
    const overrides = rawObject(rawPod.overrides ?? {}, `pod ${desiredPod.id}.overrides`);
    const inherited = afterProducts.products.find((item) => item.id === desiredPod.productId);
    if (inherited === undefined) throw new Error(`pod ${desiredPod.id} product is unavailable`);
    patchScope(overrides, before.overrides, desiredPod.overrides, scopeDraft(inherited));
    if (Object.keys(overrides).length === 0) delete rawPod.overrides; else rawPod.overrides = overrides;
  }

  const runtime = rawObject(next.runtime ?? {}, 'runtime');
  const rawRoutes = Array.isArray(runtime.providers) ? runtime.providers : runtime.provider === undefined ? [] : [runtime.provider];
  const baselineKeys = baseline.routeModels.map(routeKey).sort();
  if (!same(desired.routeModels.map(routeKey).sort(), baselineKeys)) throw new Error('runtime routes are read-only');
  for (const modelRoute of desired.routeModels) {
    const route = rawObject(rawRoutes.find((candidate) => { const item = rawObject(candidate, 'runtime route'); return `${item.id}:${item.profile ?? 'native'}` === routeKey(modelRoute); }), `runtime route ${routeKey(modelRoute)}`);
    route.compatibleModels = [...modelRoute.compatibleModels];
  }
  const configuration = validate(next);
  return { raw: next, configuration };
}

function risks(current: ConsoleSettingsDraft, next: ConsoleSettingsDraft): ConsoleSettingsRisk[] {
  const found: ConsoleSettingsRisk[] = [];
  const add = (kind: ConsoleSettingsRisk['kind'], path: string, summary: string): void => { found.push({ id: `settings:${kind}:${path}`, kind, path, summary }); };
  const budgetSummary: Record<'maxConcurrentRuns' | 'maxRetries' | 'maxRuntimeMinutes' | 'maxTokens', string> = {
    maxConcurrentRuns: 'Allow more simultaneous runs, increasing peak compute and quota use.',
    maxRetries: 'Allow more retries, increasing the compute and quota spent on failing work.',
    maxRuntimeMinutes: 'Allow runs to continue longer before stopping, increasing maximum resource use.',
    maxTokens: 'Allow more tokens per run, increasing potential provider quota or billed usage.',
  };
  const compareScope = (path: string, before: ConsoleSettingsScope, after: ConsoleSettingsScope): void => {
    for (const key of ['requireIntentApproval', 'requireSpecificationApproval', 'requireIndependentReview'] as const) if (before.authority[key] && !after.authority[key]) add('authority_relaxation', `${path}.authority.${key}`, `Disable ${key}`);
    for (const key of ['allowPreviewDeployment', 'allowLocalDeployment', 'allowSeparateBilling'] as const) if (!before.authority[key] && after.authority[key]) add('authority_relaxation', `${path}.authority.${key}`, `Enable ${key}`);
    for (const key of ['mergeAuthority', 'productionReleaseAuthority'] as const) if (before.authority[key] === 'human' && after.authority[key] === 'coordinator') add('authority_relaxation', `${path}.authority.${key}`, `Delegate ${key} to the coordinator`);
    for (const key of ['maxConcurrentRuns', 'maxRetries', 'maxRuntimeMinutes', 'maxTokens'] as const) if (after.budget[key] > before.budget[key]) add('budget_relaxation', `${path}.budget.${key}`, budgetSummary[key]);
    if (before.budget.strictSpending && !after.budget.strictSpending) add('budget_relaxation', `${path}.budget.strictSpending`, 'Disable strict spending, so the selected provider may report usage without enforcing a hard spending guarantee.');
    if (before.executionProfile === 'isolated' && after.executionProfile === 'native') add('access_relaxation', `${path}.executionProfile`, 'Move execution from isolated to native');
    if (before.requiredCapabilities.some((capability) => !after.requiredCapabilities.includes(capability))) add('access_relaxation', `${path}.requiredCapabilities`, 'Remove required provider capabilities');
    if (before.providerId !== after.providerId) add('access_relaxation', `${path}.providerId`, 'Change the selected provider');
    if (before.environmentId !== after.environmentId) add('access_relaxation', `${path}.environmentId`, 'Change the selected environment');
  };
  compareScope('defaults', current.defaults, next.defaults);
  for (const product of next.products) compareScope(`products.${product.id}`, (current.products.find((item) => item.id === product.id) as typeof product).overrides, product.overrides);
  for (const pod of next.pods) compareScope(`pods.${pod.id}`, (current.pods.find((item) => item.id === pod.id) as typeof pod).overrides, pod.overrides);
  for (const key of ['maxConcurrentRuns', 'maxRetries', 'maxRuntimeMinutes', 'maxTokens'] as const) if (next.limits[key] > current.limits[key]) add('budget_relaxation', `limits.${key}`, budgetSummary[key]);
  if (current.limits.strictSpending && !next.limits.strictSpending) add('budget_relaxation', 'limits.strictSpending', 'Disable strict spending, so the coordinator cannot promise a hard spending limit.');
  return found;
}

export class FileConsoleSettingsEditor implements ConsoleSettingsEditor {
  readonly #path: string;
  readonly #validate: Validator;
  readonly #loadedRevision: string;
  #savedRevision: string;

  constructor(options: { path: string; loadedContent: string; validate: Validator }) {
    this.#path = options.path; this.#validate = options.validate; this.#loadedRevision = revision(options.loadedContent); this.#savedRevision = this.#loadedRevision;
  }

  status(): ReturnType<ConsoleSettingsEditor['status']> { return { editable: true, loadedRevision: this.#loadedRevision, savedRevision: this.#savedRevision, restartRequired: this.#savedRevision !== this.#loadedRevision }; }

  async #current(): Promise<{ content: string; revision: string; raw: JsonObject; configuration: LocalConsoleConfiguration; draft: ConsoleSettingsDraft }> {
    const content = await readFile(this.#path, 'utf8');
    const raw = object(JSON.parse(content) as unknown, 'Console configuration');
    const configuration = this.#validate(raw);
    return { content, revision: revision(content), raw, configuration, draft: toDraft(configuration) };
  }

  async edit(): Promise<ConsoleSettingsEditView> { const current = await this.#current(); this.#savedRevision = current.revision; return { revision: current.revision, draft: current.draft, restartRequired: current.revision !== this.#loadedRevision }; }

  async #prepare(value: unknown, save: boolean): Promise<{ preview: ConsoleSettingsPreview; raw: JsonObject; content: string }> {
    const input = object(value, 'settings request', save ? ['revision', 'draft', 'confirm', 'acknowledgedRiskIds'] : ['revision', 'draft']);
    const expected = text(input.revision, 'revision');
    const current = await this.#current();
    if (expected !== current.revision) throw new Error('settings_revision_conflict');
    const desired = parseDraft(input.draft);
    const applied = applyDraft(current.raw, current.configuration, current.draft, desired, this.#validate);
    const nextDraft = toDraft(applied.configuration);
    const identifiedRisks = risks(current.draft, nextDraft);
    const changed = !same(applied.raw, current.raw);
    if (save) {
      if (input.confirm !== true) throw new Error('settings_save_confirmation_required');
      const acknowledged = strings(input.acknowledgedRiskIds, 'acknowledgedRiskIds');
      const missing = identifiedRisks.filter((risk) => !acknowledged.includes(risk.id));
      if (missing.length > 0) throw new Error(`settings_risk_acknowledgement_required:${missing.map((risk) => risk.id).join(',')}`);
    }
    return { preview: { revision: current.revision, draft: nextDraft, changed, restartRequired: changed || current.revision !== this.#loadedRevision, risks: identifiedRisks }, raw: applied.raw, content: current.content };
  }

  async preview(value: unknown): Promise<ConsoleSettingsPreview> { return (await this.#prepare(value, false)).preview; }

  async save(value: unknown): Promise<ConsoleSettingsPreview> {
    const prepared = await this.#prepare(value, true);
    if (!prepared.preview.changed) return prepared.preview;
    const source = await stat(this.#path);
    const temporary = join(dirname(this.#path), `.${basename(this.#path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', source.mode);
      try { await handle.writeFile(`${JSON.stringify(prepared.raw, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      // Recheck after the replacement is fully staged, immediately before the
      // atomic rename. Service requests are serialized, so a competing save
      // observes the replacement revision and conflicts instead of overwriting.
      if (revision(await readFile(this.#path, 'utf8')) !== prepared.preview.revision) throw new Error('settings_revision_conflict');
      await rename(temporary, this.#path);
    } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    const savedContent = await readFile(this.#path, 'utf8');
    this.#savedRevision = revision(savedContent);
    return { ...prepared.preview, revision: this.#savedRevision, restartRequired: this.#savedRevision !== this.#loadedRevision };
  }
}
