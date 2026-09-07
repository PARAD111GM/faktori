// Provisioning accepts untrusted values at its public boundary and binds every
// effect to immutable proposal and approval revisions before changing local state.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { ResolvedFactoryConfiguration } from '../config/index.ts';

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type InputRecord = Record<PropertyKey, unknown>;
type Issue = { path: string; message: string };

export interface ProvisioningIssue { path: string; message: string }
export interface DiscoveryRecord {
  format: 'faktori.discovery/v1';
  id: string;
  factoryId: string;
  inventory: JsonObject;
  interview: JsonObject;
  unknowns: string[];
  revision: string;
}
export interface LocalConfigEffect {
  id: string;
  kind: 'local-config';
  target: string;
  description: string;
}
export interface LocalGitRepositoryEffect {
  id: string;
  kind: 'local-git-repository';
  target: string;
  description: string;
  productId: string;
  source?: {
    path: string;
    digest: string;
    fileCount: number;
  };
}
export interface LocalProductRegistrationEffect {
  id: string;
  kind: 'local-product-registration';
  target: string;
  description: string;
  productId: string;
  previousConfigurationRevision: string;
  configurationRevision: string;
  product: JsonObject;
}
export interface RemoteProviderEffect {
  id: string;
  kind: 'remote-provider';
  target: string;
  description: string;
  transport: 'fake';
  status: 'pending';
  reason: string;
}
export type ProvisioningEffect = LocalConfigEffect | LocalGitRepositoryEffect | LocalProductRegistrationEffect | RemoteProviderEffect;
export interface ProvisioningRisk {
  id: string;
  productId: string;
  field: string;
  selected: JsonValue;
  safeDefault: JsonValue;
  consequence: string;
}
export interface ProvisioningProposal {
  format: 'faktori.provisioning-proposal/v1';
  id: string;
  discoveryRevision: string;
  configurationRevision: string;
  factory: { id: string; name: string };
  components: Record<string, string>;
  effects: ProvisioningEffect[];
  costs: JsonObject;
  humanWorkload: string[];
  tradeoffs: string[];
  risks: ProvisioningRisk[];
  change?: {
    kind: 'add-product';
    productId: string;
    previousConfigurationRevision: string;
  };
  revision: string;
}
export interface ProvisioningApproval {
  format: 'faktori.provisioning-approval/v1';
  proposalRevision: string;
  configurationRevision: string;
  approverId: string;
  effectIds: string[];
  confirmedRiskIds: string[];
  riskAcknowledgements: Record<string, string>;
  revision: string;
}
export type ProvisioningOperationStatus = 'intended' | 'completed' | 'reconciled' | 'blocked' | 'failed' | 'pending';
export interface ProvisioningOperation {
  operationId: string;
  proposalRevision: string;
  effectId: string;
  effect: ProvisioningEffect;
  status: ProvisioningOperationStatus;
  targetState?: 'missing' | 'present';
  target?: string;
  reason?: string;
  supported?: false;
  transport?: 'fake';
}
export interface ProvisioningJournalEntry extends ProvisioningOperation {
  format: 'faktori.provisioning-journal/v1';
}
export interface BeforeEffectEvent { operationId: string; effect: ProvisioningEffect; target?: string }
export interface BeforeGitInitEvent { effect: LocalGitRepositoryEffect; target: string }
export interface BeforeProductRegistrationWriteEvent { effect: LocalProductRegistrationEffect; target: string }
export interface AfterEffectEvent { operationId: string; effect: ProvisioningEffect; observed: EffectOutcome }
export interface ProvisioningCallbacks {
  onBeforeEffect?: (event: BeforeEffectEvent) => void;
  onBeforeGitInit?: (event: BeforeGitInitEvent) => void;
  onBeforeProductRegistrationWrite?: (event: BeforeProductRegistrationWriteEvent) => void;
  onAfterEffect?: (event: AfterEffectEvent) => void;
}
export interface DiscoveryInput {
  factoryId: string;
  id?: string;
  inventory?: JsonObject;
  interview?: JsonObject;
  unknowns?: string[];
}
export interface ProvisioningProposalInput {
  discovery: DiscoveryRecord;
  resolvedConfig: ResolvedFactoryConfiguration;
  componentVersions: Record<string, string>;
  costs?: JsonObject;
  humanWorkload?: string[];
  tradeoffs?: string[];
  localProductSources?: Record<string, string>;
  remoteEffects?: Array<{ id: string; target: string; description: string }>;
  change?: {
    kind: 'add-product';
    productId: string;
    previousResolvedConfig: ResolvedFactoryConfiguration;
  };
}
export interface ProvisioningApprovalInput {
  proposalRevision: string;
  configurationRevision: string;
  approverId: string;
  effectIds: string[];
  confirmedRiskIds?: string[];
  riskAcknowledgements?: Record<string, string>;
}
export interface ApproveProvisioningInput {
  proposal: ProvisioningProposal;
  approval: ProvisioningApprovalInput;
}
export interface ProvisionApprovedInput extends ProvisioningCallbacks {
  proposal: ProvisioningProposal;
  approval: ProvisioningApproval;
  resolvedConfig: ResolvedFactoryConfiguration;
  root: string;
  previousResolvedConfig?: ResolvedFactoryConfiguration;
  remoteTransport?: FakeRemoteTransport;
}
export type ProvisionApprovedNewProductInput = ProvisionApprovedInput;
export interface ProductPreviewInput {
  resolvedConfig: ResolvedFactoryConfiguration;
  product: JsonObject & { id: string; providerId?: string; environmentId?: string };
  incrementalCost?: JsonValue;
}

interface ValidatedResolvedConfig {
  value: JsonObject;
  factory: { id: string; name: string; defaults: { providerId?: string; environmentId?: string } };
  products: Array<{ id: string; authority: JsonObject }>;
  pods: Array<{ id: string; productId: string }>;
}
interface ValidatedProductAddition {
  change: NonNullable<ProvisioningProposal['change']>;
  product: JsonObject;
}
interface LocalOutcome {
  status: 'completed' | 'reconciled' | 'blocked' | 'failed';
  target: string;
  reason?: string;
}
export interface PendingRemoteOutcome {
  operationId: string;
  status: 'pending';
  supported: false;
  transport: 'fake';
  reason: string;
}
export type EffectOutcome = LocalOutcome | PendingRemoteOutcome;
export interface RemoteOperationRequest extends RemoteProviderEffect { operationId: string }

const JOURNAL_FORMAT = 'faktori.provisioning-journal/v1';
const FAKE_TRANSPORT: unique symbol = Symbol('faktori.phase1.fake-remote-transport');
const SAFE_AUTHORITY: Readonly<Record<string, JsonValue>> = Object.freeze({
  requireIndependentReview: true,
  mergeAuthority: 'human',
  productionReleaseAuthority: 'human',
  allowSeparateBilling: false,
});

export interface FakeRemoteTransport {
  readonly kind: 'fake';
  readonly [FAKE_TRANSPORT]: true;
  apply(effect: RemoteOperationRequest): PendingRemoteOutcome;
}

export class ProvisioningValidationError extends Error {
  issues: Issue[];
  constructor(message: string, issues: Issue[] = []) {
    super(message);
    this.name = 'ProvisioningValidationError';
    this.issues = issues;
  }
}

function fail(path: string, message: string): never {
  throw new ProvisioningValidationError(`${path}: ${message}`, [{ path, message }]);
}

function isRecord(value: unknown): value is InputRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, path: string): InputRecord {
  if (!isRecord(value)) fail(path, 'must be an object');
  return value;
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmpty(value, path);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value.map((entry, index) => nonEmpty(entry, `${path}[${index}]`));
}

function normalizeJson(value: unknown, path: string, ancestors = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must contain only finite JSON numbers');
    return value;
  }
  if (typeof value !== 'object') fail(path, 'must contain only JSON values');
  if (ancestors.has(value)) fail(path, 'must not contain a circular reference');
  ancestors.add(value);
  let normalized: JsonValue;
  if (Array.isArray(value)) {
    normalized = value.map((entry, index) => normalizeJson(entry, `${path}[${index}]`, ancestors));
  } else {
    const object: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      object[key] = normalizeJson(entry, `${path}.${key}`, ancestors);
    }
    normalized = object;
  }
  ancestors.delete(value);
  return normalized;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(value: unknown, path: string): JsonObject {
  const normalized = normalizeJson(value, path);
  if (!isJsonObject(normalized)) fail(path, 'must be a JSON object');
  return normalized;
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  const input = record(value, path);
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input).sort(([left], [right]) => left.localeCompare(right))) {
    normalized[key] = nonEmpty(entry, `${path}.${key}`);
  }
  return normalized;
}

function stable(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stable);
  if (isJsonObject(value)) {
    const result: JsonObject = {};
    for (const key of Object.keys(value).sort()) result[key] = stable(value[key]);
    return result;
  }
  return value;
}

function digest(value: unknown, path = 'value'): string {
  return createHash('sha256').update(JSON.stringify(stable(normalizeJson(value, path)))).digest('hex');
}

function validateResolvedConfig(value: unknown): ValidatedResolvedConfig {
  const normalized = jsonObject(value, 'resolvedConfig');
  const factoryInput = record(normalized.factory, 'resolvedConfig.factory');
  const factoryId = nonEmpty(factoryInput.id, 'resolvedConfig.factory.id');
  const factoryName = optionalString(factoryInput.name, 'resolvedConfig.factory.name') ?? factoryId;
  const defaultsInput = factoryInput.defaults === undefined ? {} : record(factoryInput.defaults, 'resolvedConfig.factory.defaults');
  const defaults = {
    providerId: optionalString(defaultsInput.providerId, 'resolvedConfig.factory.defaults.providerId'),
    environmentId: optionalString(defaultsInput.environmentId, 'resolvedConfig.factory.defaults.environmentId'),
  };
  if (!Array.isArray(normalized.products) || !Array.isArray(normalized.pods)) {
    fail('resolvedConfig', 'must contain factory, products, and pods');
  }
  const products = normalized.products.map((entry, index) => {
    const product = record(entry, `resolvedConfig.products[${index}]`);
    return {
      id: nonEmpty(product.id, `resolvedConfig.products[${index}].id`),
      authority: product.authority === undefined ? {} : jsonObject(product.authority, `resolvedConfig.products[${index}].authority`),
    };
  });
  const pods = normalized.pods.map((entry, index) => {
    const pod = record(entry, `resolvedConfig.pods[${index}]`);
    return {
      id: nonEmpty(pod.id, `resolvedConfig.pods[${index}].id`),
      productId: nonEmpty(pod.productId, `resolvedConfig.pods[${index}].productId`),
    };
  });
  return { value: normalized, factory: { id: factoryId, name: factoryName, defaults }, products, pods };
}

function discoveryPayload(recordValue: DiscoveryRecord): Omit<DiscoveryRecord, 'revision'> {
  return {
    format: recordValue.format,
    id: recordValue.id,
    factoryId: recordValue.factoryId,
    inventory: recordValue.inventory,
    interview: recordValue.interview,
    unknowns: recordValue.unknowns,
  };
}

function validateDiscovery(value: unknown): DiscoveryRecord {
  const input = record(value, 'discovery');
  if (input.format !== 'faktori.discovery/v1') fail('discovery.format', 'must be "faktori.discovery/v1"');
  const discovery: DiscoveryRecord = {
    format: 'faktori.discovery/v1',
    id: nonEmpty(input.id, 'discovery.id'),
    factoryId: nonEmpty(input.factoryId, 'discovery.factoryId'),
    inventory: jsonObject(input.inventory, 'discovery.inventory'),
    interview: jsonObject(input.interview, 'discovery.interview'),
    unknowns: stringArray(input.unknowns, 'discovery.unknowns'),
    revision: nonEmpty(input.revision, 'discovery.revision'),
  };
  if (discovery.revision !== digest(discoveryPayload(discovery), 'discovery')) {
    fail('discovery.revision', 'does not match the discovery contents');
  }
  return discovery;
}

function proposalPayload(proposal: ProvisioningProposal): Omit<ProvisioningProposal, 'revision'> {
  return {
    format: proposal.format,
    id: proposal.id,
    discoveryRevision: proposal.discoveryRevision,
    configurationRevision: proposal.configurationRevision,
    factory: proposal.factory,
    components: proposal.components,
    effects: proposal.effects,
    costs: proposal.costs,
    humanWorkload: proposal.humanWorkload,
    tradeoffs: proposal.tradeoffs,
    risks: proposal.risks,
    ...(proposal.change === undefined ? {} : { change: proposal.change }),
  };
}

function approvalPayload(approval: ProvisioningApproval): Omit<ProvisioningApproval, 'revision'> {
  return {
    format: approval.format,
    proposalRevision: approval.proposalRevision,
    configurationRevision: approval.configurationRevision,
    approverId: approval.approverId,
    effectIds: approval.effectIds,
    confirmedRiskIds: approval.confirmedRiskIds,
    riskAcknowledgements: approval.riskAcknowledgements,
  };
}

function exactIds(actual: unknown, expected: string[], path: string): string[] {
  const sortedActual = stringArray(actual, path).sort();
  const sortedExpected = [...expected].sort();
  if (new Set(sortedActual).size !== sortedActual.length || JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    fail(path, 'must confirm every current item exactly once');
  }
  return sortedExpected;
}

function validateEffect(value: unknown, path: string): ProvisioningEffect {
  const input = record(value, path);
  const common = {
    id: nonEmpty(input.id, `${path}.id`),
    target: nonEmpty(input.target, `${path}.target`),
    description: nonEmpty(input.description, `${path}.description`),
  };
  if (input.kind === 'local-config') return { ...common, kind: 'local-config' };
  if (input.kind === 'local-git-repository') {
    const sourceInput = input.source === undefined ? undefined : record(input.source, `${path}.source`);
    const source = sourceInput === undefined ? undefined : {
      path: nonEmpty(sourceInput.path, `${path}.source.path`),
      digest: nonEmpty(sourceInput.digest, `${path}.source.digest`),
      fileCount: Number.isInteger(sourceInput.fileCount) && Number(sourceInput.fileCount) >= 0
        ? Number(sourceInput.fileCount)
        : fail(`${path}.source.fileCount`, 'must be a non-negative integer'),
    };
    return { ...common, kind: 'local-git-repository', productId: nonEmpty(input.productId, `${path}.productId`), ...(source === undefined ? {} : { source }) };
  }
  if (input.kind === 'local-product-registration') {
    return {
      ...common,
      kind: 'local-product-registration',
      productId: nonEmpty(input.productId, `${path}.productId`),
      previousConfigurationRevision: nonEmpty(input.previousConfigurationRevision, `${path}.previousConfigurationRevision`),
      configurationRevision: nonEmpty(input.configurationRevision, `${path}.configurationRevision`),
      product: jsonObject(input.product, `${path}.product`),
    };
  }
  if (input.kind === 'remote-provider') {
    if (input.transport !== 'fake' || input.status !== 'pending') {
      fail(path, 'remote effects must remain pending through the fake transport in Phase 1');
    }
    return {
      ...common,
      kind: 'remote-provider',
      transport: 'fake',
      status: 'pending',
      reason: nonEmpty(input.reason, `${path}.reason`),
    };
  }
  fail(`${path}.kind`, 'must be a supported provisioning effect kind');
}

function validateRisk(value: unknown, path: string): ProvisioningRisk {
  const input = record(value, path);
  return {
    id: nonEmpty(input.id, `${path}.id`),
    productId: nonEmpty(input.productId, `${path}.productId`),
    field: nonEmpty(input.field, `${path}.field`),
    selected: normalizeJson(input.selected, `${path}.selected`),
    safeDefault: normalizeJson(input.safeDefault, `${path}.safeDefault`),
    consequence: nonEmpty(input.consequence, `${path}.consequence`),
  };
}

function validateProposal(value: unknown): ProvisioningProposal {
  const input = record(value, 'proposal');
  if (input.format !== 'faktori.provisioning-proposal/v1') fail('proposal', 'must be a Faktori provisioning proposal');
  const factoryInput = record(input.factory, 'proposal.factory');
  if (!Array.isArray(input.effects)) fail('proposal.effects', 'must be an array');
  if (!Array.isArray(input.risks)) fail('proposal.risks', 'must be an array');
  const changeInput = input.change === undefined ? undefined : record(input.change, 'proposal.change');
  const change = changeInput === undefined ? undefined : {
    kind: changeInput.kind === 'add-product' ? 'add-product' as const : fail('proposal.change.kind', 'must be "add-product"'),
    productId: nonEmpty(changeInput.productId, 'proposal.change.productId'),
    previousConfigurationRevision: nonEmpty(changeInput.previousConfigurationRevision, 'proposal.change.previousConfigurationRevision'),
  };
  const proposal: ProvisioningProposal = {
    format: 'faktori.provisioning-proposal/v1',
    id: nonEmpty(input.id, 'proposal.id'),
    discoveryRevision: nonEmpty(input.discoveryRevision, 'proposal.discoveryRevision'),
    configurationRevision: nonEmpty(input.configurationRevision, 'proposal.configurationRevision'),
    factory: {
      id: nonEmpty(factoryInput.id, 'proposal.factory.id'),
      name: nonEmpty(factoryInput.name, 'proposal.factory.name'),
    },
    components: stringRecord(input.components, 'proposal.components'),
    effects: input.effects.map((effect, index) => validateEffect(effect, `proposal.effects[${index}]`)),
    costs: jsonObject(input.costs, 'proposal.costs'),
    humanWorkload: stringArray(input.humanWorkload, 'proposal.humanWorkload'),
    tradeoffs: stringArray(input.tradeoffs, 'proposal.tradeoffs'),
    risks: input.risks.map((risk, index) => validateRisk(risk, `proposal.risks[${index}]`)),
    ...(change === undefined ? {} : { change }),
    revision: nonEmpty(input.revision, 'proposal.revision'),
  };
  const effectIds = proposal.effects.map((effect) => effect.id);
  if (new Set(effectIds).size !== effectIds.length) fail('proposal.effects', 'must have unique effect IDs');
  const riskIds = proposal.risks.map((risk) => risk.id);
  if (new Set(riskIds).size !== riskIds.length) fail('proposal.risks', 'must have unique risk IDs');
  if (proposal.revision !== digest(proposalPayload(proposal), 'proposal')) {
    fail('proposal.revision', 'does not match the concrete proposal contents');
  }
  return proposal;
}

function authorityRisks(resolvedConfig: ValidatedResolvedConfig, productIds?: ReadonlySet<string>): ProvisioningRisk[] {
  const risks: ProvisioningRisk[] = [];
  for (const product of resolvedConfig.products) {
    if (productIds !== undefined && !productIds.has(product.id)) continue;
    for (const [field, safeValue] of Object.entries(SAFE_AUTHORITY)) {
      const selected = product.authority[field];
      if (selected !== undefined && selected !== safeValue) {
        risks.push({
          id: `authority:${product.id}:${field}`,
          productId: product.id,
          field,
          selected,
          safeDefault: safeValue,
          consequence: `Product ${product.id} relaxes ${field} from the factory safe default.`,
        });
      }
    }
  }
  return risks;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(stable(normalizeJson(left, 'comparison.left')))
    === JSON.stringify(stable(normalizeJson(right, 'comparison.right')));
}

function validateProductAddition(value: unknown, next: ValidatedResolvedConfig): ValidatedProductAddition | undefined {
  if (value === undefined) return undefined;
  const input = record(value, 'change');
  if (input.kind !== 'add-product') fail('change.kind', 'must be "add-product"');
  const productId = nonEmpty(input.productId, 'change.productId');
  const previous = validateResolvedConfig(input.previousResolvedConfig);
  if (!sameJson(previous.value.factory, next.value.factory)
    || !sameJson(previous.value.providers, next.value.providers)
    || !sameJson(previous.value.environments, next.value.environments)
    || !sameJson(previous.value.pods, next.value.pods)) {
    fail('change', 'add-product must preserve factory defaults, providers, environments, and every existing pod');
  }
  if (previous.products.some((product) => product.id === productId)) fail('change.productId', 'already exists in the approved factory');
  if (next.products.length !== previous.products.length + 1) fail('change', 'must add exactly one product');
  const previousProducts = new Map((previous.value.products as JsonValue[]).map((entry, index) => {
    const product = record(entry, `change.previousResolvedConfig.products[${index}]`);
    return [nonEmpty(product.id, `change.previousResolvedConfig.products[${index}].id`), product] as const;
  }));
  const nextProducts = new Map((next.value.products as JsonValue[]).map((entry, index) => {
    const product = record(entry, `resolvedConfig.products[${index}]`);
    return [nonEmpty(product.id, `resolvedConfig.products[${index}].id`), product] as const;
  }));
  for (const [id, product] of previousProducts) {
    if (!nextProducts.has(id) || !sameJson(product, nextProducts.get(id))) fail('change', `existing product ${id} changed`);
  }
  const added = nextProducts.get(productId);
  if (added === undefined) fail('change.productId', 'does not identify the one added product');
  const extraIds = [...nextProducts.keys()].filter((id) => !previousProducts.has(id));
  if (extraIds.length !== 1 || extraIds[0] !== productId) fail('change', 'must add only the named product');
  return {
    change: {
      kind: 'add-product',
      productId,
      previousConfigurationRevision: digest(previous.value, 'change.previousResolvedConfig'),
    },
    product: jsonObject(added, 'change.product'),
  };
}

interface SourceSnapshot {
  path: string;
  digest: string;
  fileCount: number;
  files: Array<{ relativePath: string; digest: string; mode: number }>;
}

function sourceSnapshot(sourcePath: string): SourceSnapshot {
  if (!isAbsolute(sourcePath)) fail('localProductSources', 'source paths must be absolute');
  if (!existsSync(sourcePath)) fail('localProductSources', `source does not exist: ${sourcePath}`);
  const rootStat = lstatSync(sourcePath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('localProductSources', 'source must be a real directory, not a symlink');
  const root = realpathSync(sourcePath);
  const files: SourceSnapshot['files'] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === '.git') continue;
      const path = resolve(directory, name);
      const relativePath = prefix === '' ? name : `${prefix}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail('localProductSources', `source contains symlink: ${relativePath}`);
      if (stat.isDirectory()) { walk(path, relativePath); continue; }
      if (!stat.isFile()) fail('localProductSources', `source contains unsupported entry: ${relativePath}`);
      const bytes = readRegularFileNoFollow(path, relativePath);
      files.push({ relativePath, digest: createHash('sha256').update(bytes).digest('hex'), mode: stat.mode & 0o777 });
    }
  };
  walk(root, '');
  return { path: root, digest: digest(files, 'localProductSources.manifest'), fileCount: files.length, files };
}

function readRegularFileNoFollow(path: string, label: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) fail('localProductSources', `source contains unsupported entry: ${label}`);
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof ProvisioningValidationError) throw error;
    fail('localProductSources', `source file could not be read safely: ${label}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validatedLocalProductSources(value: unknown, resolvedConfig: ValidatedResolvedConfig): Map<string, SourceSnapshot> {
  if (value === undefined) return new Map();
  const sources = record(value, 'localProductSources');
  const productIds = new Set(resolvedConfig.products.map((product) => product.id));
  const result = new Map<string, SourceSnapshot>();
  for (const [productId, pathValue] of Object.entries(sources).sort(([left], [right]) => left.localeCompare(right))) {
    if (!productIds.has(productId)) fail(`localProductSources.${productId}`, 'does not name a configured product');
    result.set(productId, sourceSnapshot(nonEmpty(pathValue, `localProductSources.${productId}`)));
  }
  return result;
}

function productRepositoryEffect(productId: string, source: SourceSnapshot | undefined): LocalGitRepositoryEffect {
  return {
    id: `local:product-repository:${productId}`,
    kind: 'local-git-repository',
    productId,
    target: `products/${productId}`,
    description: source === undefined
      ? `Initialize and commit the local Git scaffold for product ${productId}.`
      : `Copy the approved ${source.fileCount}-file source snapshot, then initialize and commit the local Git repository for product ${productId}.`,
    ...(source === undefined ? {} : { source: { path: source.path, digest: source.digest, fileCount: source.fileCount } }),
  };
}

function localEffects(resolvedConfig: ValidatedResolvedConfig, sources: Map<string, SourceSnapshot>, addition?: ValidatedProductAddition): ProvisioningEffect[] {
  if (addition !== undefined) {
    for (const productId of sources.keys()) {
      if (productId !== addition.change.productId) fail(`localProductSources.${productId}`, 'an add-product proposal may import only the named new product');
    }
    const productId = addition.change.productId;
    return [
      {
        id: `local:product-registration:${productId}`,
        kind: 'local-product-registration',
        productId,
        target: `config/product-revisions/${addition.change.previousConfigurationRevision}.json`,
        description: `Register approved product ${productId} without changing factory defaults, existing products, repositories, or pods.`,
        previousConfigurationRevision: addition.change.previousConfigurationRevision,
        configurationRevision: digest(resolvedConfig.value, 'resolvedConfig'),
        product: addition.product,
      },
      productRepositoryEffect(productId, sources.get(productId)),
    ];
  }
  const effects: ProvisioningEffect[] = [{
    id: 'local:factory-profile',
    kind: 'local-config',
    target: 'config/factory-profile.json',
    description: 'Write the owner-controlled factory profile with the approved revision and component locks.',
  }];
  for (const product of resolvedConfig.products) {
    effects.push(productRepositoryEffect(product.id, sources.get(product.id)));
  }
  return effects;
}

/** Creates a durable, credential-free record of discovery and interview answers. */
export function createDiscoveryRecord(input: DiscoveryInput): DiscoveryRecord;
export function createDiscoveryRecord(input: unknown): DiscoveryRecord;
export function createDiscoveryRecord(input: unknown): DiscoveryRecord {
  const value = record(input, 'discovery');
  const factoryId = nonEmpty(value.factoryId, 'discovery.factoryId');
  const inventory = jsonObject(value.inventory ?? {}, 'discovery.inventory');
  const interview = jsonObject(value.interview ?? {}, 'discovery.interview');
  const unknowns = value.unknowns === undefined ? [] : stringArray(value.unknowns, 'discovery.unknowns');
  const payload: Omit<DiscoveryRecord, 'revision'> = {
    format: 'faktori.discovery/v1',
    id: optionalString(value.id, 'discovery.id')
      ?? `discovery-${digest({ factoryId, inventory, interview }, 'discovery').slice(0, 16)}`,
    factoryId,
    inventory,
    interview,
    unknowns,
  };
  return { ...payload, revision: digest(payload, 'discovery') };
}

/** Produces the concrete plan; remote effects remain explicitly unsupported. */
export function createProvisioningProposal(input: ProvisioningProposalInput): ProvisioningProposal;
export function createProvisioningProposal(input: unknown): ProvisioningProposal;
export function createProvisioningProposal(input: unknown): ProvisioningProposal {
  const value = record(input, 'proposal request');
  const discovery = validateDiscovery(value.discovery);
  const resolvedConfig = validateResolvedConfig(value.resolvedConfig);
  if (discovery.factoryId !== resolvedConfig.factory.id) fail('discovery.factoryId', 'must match the proposed factory');
  const componentVersions = stringRecord(value.componentVersions, 'componentVersions');
  if (Object.keys(componentVersions).length === 0) fail('componentVersions', 'must lock at least one component version');
  const remoteValues = value.remoteEffects === undefined ? [] : value.remoteEffects;
  if (!Array.isArray(remoteValues)) fail('remoteEffects', 'must be an array');
  const addition = validateProductAddition(value.change, resolvedConfig);
  const sources = validatedLocalProductSources(value.localProductSources, resolvedConfig);
  const effects = localEffects(resolvedConfig, sources, addition);
  for (const [index, remoteValue] of remoteValues.entries()) {
    const remote = record(remoteValue, `remoteEffects[${index}]`);
    const remoteId = nonEmpty(remote.id, `remoteEffects[${index}].id`);
    effects.push({
      id: `remote:${remoteId}`,
      kind: 'remote-provider',
      target: nonEmpty(remote.target, `remoteEffects[${index}].target`),
      description: nonEmpty(remote.description, `remoteEffects[${index}].description`),
      transport: 'fake',
      status: 'pending',
      reason: 'Remote provisioning is unsupported in Phase 1; no provider effect was attempted.',
    });
  }
  const effectIds = effects.map((effect) => effect.id);
  if (new Set(effectIds).size !== effectIds.length) fail('remoteEffects', 'must produce unique concrete effect IDs');
  const configurationRevision = digest(resolvedConfig.value, 'resolvedConfig');
  const costs = value.costs === undefined
    ? jsonObject({
      recurring: 'unknown',
      incrementalProducts: Object.fromEntries((addition === undefined
        ? resolvedConfig.products
        : resolvedConfig.products.filter((product) => product.id === addition.change.productId))
        .map((product) => [product.id, 'unknown'])),
    }, 'costs')
    : jsonObject(value.costs, 'costs');
  const payload: Omit<ProvisioningProposal, 'revision'> = {
    format: 'faktori.provisioning-proposal/v1',
    id: `proposal-${digest({ factoryId: resolvedConfig.factory.id, discovery: discovery.revision, configurationRevision, effects }, 'proposal').slice(0, 16)}`,
    discoveryRevision: discovery.revision,
    configurationRevision,
    factory: { id: resolvedConfig.factory.id, name: resolvedConfig.factory.name },
    components: componentVersions,
    effects,
    costs,
    humanWorkload: value.humanWorkload === undefined
      ? ['Review this proposal and confirm its concrete local effects.']
      : stringArray(value.humanWorkload, 'humanWorkload'),
    tradeoffs: value.tradeoffs === undefined
      ? ['Remote resources remain pending until a supported provider transport is implemented.']
      : stringArray(value.tradeoffs, 'tradeoffs'),
    risks: authorityRisks(resolvedConfig, addition === undefined ? undefined : new Set([addition.change.productId])),
    ...(addition === undefined ? {} : { change: addition.change }),
  };
  return { ...payload, revision: digest(payload, 'proposal') };
}

/** Returns a human-readable proposal without making filesystem or provider changes. */
export function renderProvisioningProposal(value: ProvisioningProposal): string;
export function renderProvisioningProposal(value: unknown): string;
export function renderProvisioningProposal(value: unknown): string {
  const proposal = validateProposal(value);
  const bullets = (items: string[]): string => items.map((item) => `- ${item}`).join('\n') || '- None';
  const effectLines = proposal.effects
    .map((effect) => `- \`${effect.id}\` — ${effect.description} (${effect.kind}${effect.kind === 'remote-provider' ? `; ${effect.status}` : ''})`)
    .join('\n');
  const costs = Object.entries(proposal.costs)
    .map(([name, cost]) => `- ${name}: ${typeof cost === 'string' ? cost : JSON.stringify(cost)}`)
    .join('\n');
  const risks = proposal.risks.length === 0
    ? '- No authority relaxations.'
    : proposal.risks.map((risk) => `- \`${risk.id}\`: ${risk.consequence}`).join('\n');
  const change = proposal.change === undefined
    ? ''
    : `\n## Existing-factory change\n\n- Add product \`${proposal.change.productId}\` after configuration \`${proposal.change.previousConfigurationRevision}\`.\n- Preserve factory defaults, existing products, repositories, and pods; create zero implicit pods.\n`;
  return `# Provisioning proposal: ${proposal.factory.name}\n\nRevision: \`${proposal.revision}\`\nConfiguration revision: \`${proposal.configurationRevision}\`\n${change}\n## Locked components\n\n${Object.entries(proposal.components).map(([name, version]) => `- ${name}: \`${version}\``).join('\n')}\n\n## Concrete effects\n\n${effectLines}\n\n## Cost\n\n${costs}\n\n## Human workload\n\n${bullets(proposal.humanWorkload)}\n\n## Tradeoffs\n\n${bullets(proposal.tradeoffs)}\n\n## Risk acknowledgements required\n\n${risks}\n`;
}

/** Binds confirmation to one unchanged proposal, configuration, effect set, and risk set. */
export function approveProvisioningProposal(input: ApproveProvisioningInput): ProvisioningApproval;
export function approveProvisioningProposal(input: unknown): ProvisioningApproval;
export function approveProvisioningProposal(input: unknown): ProvisioningApproval {
  const value = record(input, 'approval request');
  const proposal = validateProposal(value.proposal);
  const requested = record(value.approval, 'approval');
  if (requested.proposalRevision !== proposal.revision) {
    fail('approval.proposalRevision', 'does not match the current proposal revision');
  }
  if (requested.configurationRevision !== proposal.configurationRevision) {
    fail('approval.configurationRevision', 'does not match the proposal configuration revision');
  }
  const expectedEffects = proposal.effects.map((effect) => effect.id).sort();
  exactIds(requested.effectIds, expectedEffects, 'approval.effectIds');
  const confirmedRisks = requested.confirmedRiskIds === undefined
    ? []
    : stringArray(requested.confirmedRiskIds, 'approval.confirmedRiskIds').sort();
  const expectedRisks = proposal.risks.map((risk) => risk.id).sort();
  if (new Set(confirmedRisks).size !== confirmedRisks.length || JSON.stringify(confirmedRisks) !== JSON.stringify(expectedRisks)) {
    fail('approval.confirmedRiskIds', 'must renew confirmation for every current risk relaxation');
  }
  const acknowledgements = requested.riskAcknowledgements === undefined
    ? {}
    : stringRecord(requested.riskAcknowledgements, 'approval.riskAcknowledgements');
  if (JSON.stringify(Object.keys(acknowledgements).sort()) !== JSON.stringify(expectedRisks)) {
    fail('approval.riskAcknowledgements', 'must acknowledge every current risk exactly once');
  }
  const payload: Omit<ProvisioningApproval, 'revision'> = {
    format: 'faktori.provisioning-approval/v1',
    proposalRevision: proposal.revision,
    configurationRevision: proposal.configurationRevision,
    approverId: nonEmpty(requested.approverId, 'approval.approverId'),
    effectIds: expectedEffects,
    confirmedRiskIds: expectedRisks,
    riskAcknowledgements: acknowledgements,
  };
  return { ...payload, revision: digest(payload, 'approval') };
}

/** Makes it explicit and unforgeable that this transport cannot create resources. */
export function createFakeRemoteTransport(): FakeRemoteTransport {
  const transport: FakeRemoteTransport = {
    kind: 'fake',
    [FAKE_TRANSPORT]: true,
    apply(effect: RemoteOperationRequest): PendingRemoteOutcome {
      return {
        operationId: effect.operationId,
        status: 'pending',
        supported: false,
        transport: 'fake',
        reason: 'Remote provisioning is unsupported in Phase 1; no remote effect was simulated.',
      };
    },
  };
  return Object.freeze(transport);
}

function isFakeRemoteTransport(value: unknown): value is FakeRemoteTransport {
  return isRecord(value) && value[FAKE_TRANSPORT] === true && value.kind === 'fake' && typeof value.apply === 'function';
}

function journalPath(root: string): string {
  return targetPath(root, '.faktori/provisioning/operations.jsonl');
}

function appendJournal(root: string, entry: ProvisioningOperation): void {
  const path = journalPath(root);
  ensureParentInsideRoot(root, path);
  const journalEntry: ProvisioningJournalEntry = { format: JOURNAL_FORMAT, ...entry };
  appendFileSync(path, `${JSON.stringify(journalEntry)}\n`, 'utf8');
}

function operationStatus(value: unknown, path: string): ProvisioningOperationStatus {
  if (value === 'intended' || value === 'completed' || value === 'reconciled' || value === 'blocked' || value === 'failed' || value === 'pending') {
    return value;
  }
  fail(path, 'must be a supported provisioning operation status');
}

function validateJournalOperation(value: unknown, path: string): ProvisioningJournalEntry {
  const input = record(value, path);
  if (input.format !== JOURNAL_FORMAT) fail(`${path}.format`, `must be "${JOURNAL_FORMAT}"`);
  const targetState = input.targetState === undefined
    ? undefined
    : input.targetState === 'missing' || input.targetState === 'present'
      ? input.targetState
      : fail(`${path}.targetState`, 'must be "missing" or "present"');
  const target = optionalString(input.target, `${path}.target`);
  const reason = optionalString(input.reason, `${path}.reason`);
  if (input.supported !== undefined && input.supported !== false) fail(`${path}.supported`, 'must be false');
  if (input.transport !== undefined && input.transport !== 'fake') fail(`${path}.transport`, 'must be "fake"');
  return {
    format: JOURNAL_FORMAT,
    operationId: nonEmpty(input.operationId, `${path}.operationId`),
    proposalRevision: nonEmpty(input.proposalRevision, `${path}.proposalRevision`),
    effectId: nonEmpty(input.effectId, `${path}.effectId`),
    effect: validateEffect(input.effect, `${path}.effect`),
    status: operationStatus(input.status, `${path}.status`),
    ...(targetState === undefined ? {} : { targetState }),
    ...(target === undefined ? {} : { target }),
    ...(reason === undefined ? {} : { reason }),
    ...(input.supported === false ? { supported: false } : {}),
    ...(input.transport === 'fake' ? { transport: 'fake' } : {}),
  };
}

function priorOperations(root: string): Map<string, ProvisioningOperation> {
  const path = journalPath(root);
  if (!existsSync(path)) return new Map();
  const latest = new Map<string, ProvisioningOperation>();
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const isIncompleteTrailingRecord = index === lines.length - 1 && !content.endsWith('\n');
      if (isIncompleteTrailingRecord) {
        const validPrefix = lines.slice(0, index).join('\n');
        truncateSync(path, Buffer.byteLength(validPrefix === '' ? '' : `${validPrefix}\n`));
        break;
      }
      fail('journal', `contains malformed record at line ${index + 1}`);
    }
    const operation = validateJournalOperation(parsed, `journal[${index}]`);
    latest.set(operation.operationId, operation);
  }
  return latest;
}

function realProvisioningRoot(root: string): string {
  mkdirSync(root, { recursive: true });
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('root', 'must be a real directory, not a symlink');
  return realpathSync(root);
}

function assertNoSymlinkComponents(root: string, path: string): void {
  const inside = relative(root, path);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) fail('effect.target', 'escapes the provisioning root');
  let current = root;
  for (const component of inside.split(sep)) {
    current = resolve(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      fail('effect.target', `contains symlink component "${relative(root, current)}"`);
    }
  }
}

function targetPath(root: string, target: string): string {
  if (target === '') fail('effect.target', 'must be a non-empty relative path');
  const path = resolve(root, target);
  assertNoSymlinkComponents(root, path);
  return path;
}

function ensureParentInsideRoot(root: string, path: string): void {
  const parent = dirname(path);
  assertNoSymlinkComponents(root, parent);
  mkdirSync(parent, { recursive: true });
  assertNoSymlinkComponents(root, parent);
  const realParent = realpathSync(parent);
  if (realParent !== root && !realParent.startsWith(`${root}${sep}`)) {
    fail('effect.target', 'parent resolves outside the provisioning root');
  }
}

function profileContents(proposal: ProvisioningProposal): string {
  return `${JSON.stringify({
    format: 'faktori.factory-profile/v1',
    factory: proposal.factory,
    proposalRevision: proposal.revision,
    configurationRevision: proposal.configurationRevision,
    components: proposal.components,
  }, null, 2)}\n`;
}

interface ApprovedFactoryState {
  factory: { id: string; name: string };
  components: Record<string, string>;
  baseConfigurationRevision: string;
  configurationRevision: string;
}

function registrationPayload(effect: LocalProductRegistrationEffect, proposal: ProvisioningProposal): JsonObject {
  return {
    format: 'faktori.product-registration/v1',
    factory: proposal.factory,
    productId: effect.productId,
    previousConfigurationRevision: effect.previousConfigurationRevision,
    configurationRevision: effect.configurationRevision,
    proposalRevision: proposal.revision,
    product: effect.product,
  };
}

function registrationContents(effect: LocalProductRegistrationEffect, proposal: ProvisioningProposal): string {
  const payload = registrationPayload(effect, proposal);
  return `${JSON.stringify({ ...payload, revision: digest(payload, 'productRegistration') }, null, 2)}\n`;
}

function parseRegistration(value: unknown, path: string): {
  productId: string;
  previousConfigurationRevision: string;
  configurationRevision: string;
  revision: string;
  payload: JsonObject;
} {
  const input = record(value, path);
  if (input.format !== 'faktori.product-registration/v1') fail(`${path}.format`, 'must be a Faktori product registration');
  const factory = jsonObject(input.factory, `${path}.factory`);
  const payload: JsonObject = {
    format: 'faktori.product-registration/v1',
    factory,
    productId: nonEmpty(input.productId, `${path}.productId`),
    previousConfigurationRevision: nonEmpty(input.previousConfigurationRevision, `${path}.previousConfigurationRevision`),
    configurationRevision: nonEmpty(input.configurationRevision, `${path}.configurationRevision`),
    proposalRevision: nonEmpty(input.proposalRevision, `${path}.proposalRevision`),
    product: jsonObject(input.product, `${path}.product`),
  };
  const revision = nonEmpty(input.revision, `${path}.revision`);
  if (revision !== digest(payload, 'productRegistration')) fail(`${path}.revision`, 'does not match the registration contents');
  return {
    productId: payload.productId as string,
    previousConfigurationRevision: payload.previousConfigurationRevision as string,
    configurationRevision: payload.configurationRevision as string,
    revision,
    payload,
  };
}

function approvedFactoryState(root: string): ApprovedFactoryState {
  const profilePath = targetPath(root, 'config/factory-profile.json');
  if (!existsSync(profilePath)) fail('root', 'does not contain an approved factory profile');
  const profile = record(JSON.parse(readRegularFileNoFollow(profilePath, 'config/factory-profile.json').toString('utf8')), 'factoryProfile');
  if (profile.format !== 'faktori.factory-profile/v1') fail('factoryProfile.format', 'must be a Faktori factory profile');
  const factoryInput = record(profile.factory, 'factoryProfile.factory');
  const factory = {
    id: nonEmpty(factoryInput.id, 'factoryProfile.factory.id'),
    name: nonEmpty(factoryInput.name, 'factoryProfile.factory.name'),
  };
  const components = stringRecord(profile.components, 'factoryProfile.components');
  const baseConfigurationRevision = nonEmpty(profile.configurationRevision, 'factoryProfile.configurationRevision');
  const registrationsRoot = targetPath(root, 'config/product-revisions');
  if (!existsSync(registrationsRoot)) return { factory, components, baseConfigurationRevision, configurationRevision: baseConfigurationRevision };
  if (!lstatSync(registrationsRoot).isDirectory()) fail('productRegistrations', 'must be a real directory');
  const byPrevious = new Map<string, ReturnType<typeof parseRegistration>>();
  for (const name of readdirSync(registrationsRoot).sort()) {
    if (!name.endsWith('.json')) fail('productRegistrations', `contains unsupported entry: ${name}`);
    const path = targetPath(root, `config/product-revisions/${name}`);
    const registration = parseRegistration(JSON.parse(readRegularFileNoFollow(path, `config/product-revisions/${name}`).toString('utf8')), `productRegistrations.${name}`);
    if (name !== `${registration.previousConfigurationRevision}.json`) fail('productRegistrations', `filename does not match previous revision for ${registration.productId}`);
    if (registration.payload.factory === undefined || !sameJson(registration.payload.factory, factory)) fail('productRegistrations', `factory mismatch in ${name}`);
    if (byPrevious.has(registration.previousConfigurationRevision)) fail('productRegistrations', 'contains a configuration-revision fork');
    byPrevious.set(registration.previousConfigurationRevision, registration);
  }
  let configurationRevision = baseConfigurationRevision;
  const visited = new Set<string>();
  while (byPrevious.has(configurationRevision)) {
    const registration = byPrevious.get(configurationRevision) as ReturnType<typeof parseRegistration>;
    if (visited.has(registration.revision)) fail('productRegistrations', 'contains a revision cycle');
    visited.add(registration.revision);
    configurationRevision = registration.configurationRevision;
  }
  if (visited.size !== byPrevious.size) fail('productRegistrations', 'contains a disconnected revision chain');
  return { factory, components, baseConfigurationRevision, configurationRevision };
}

/** Returns the latest approval-bound configuration revision without mutating the factory. */
export function readApprovedConfigurationRevision(rootValue: string): string {
  const root = nonEmpty(rootValue, 'root');
  if (!isAbsolute(root) || !existsSync(root)) fail('root', 'must be an existing absolute factory root');
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('root', 'must be a real directory, not a symlink');
  return approvedFactoryState(realpathSync(root)).configurationRevision;
}

function isExactGitRepository(path: string): boolean {
  const result = spawnSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  try { return realpathSync(result.stdout.trim()) === realpathSync(path); }
  catch { return false; }
}

function hasGitHead(path: string): boolean {
  return spawnSync('git', ['-C', path, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).status === 0;
}

function configureProductCommitIdentity(path: string): string | undefined {
  for (const [key, value] of [['user.name', 'Faktori Agent'], ['user.email', 'faktori@localhost']]) {
    const result = spawnSync('git', ['-C', path, 'config', '--local', key, value], { encoding: 'utf8' });
    if (result.status !== 0) return result.stderr.trim() || `git config ${key} failed`;
  }
  return undefined;
}

function commitInitialProduct(path: string): string | undefined {
  const add = spawnSync('git', ['-C', path, 'add', '--all'], { encoding: 'utf8' });
  if (add.status !== 0) return add.stderr.trim() || 'git add failed';
  const commit = spawnSync('git', [
    '-C', path,
    '-c', 'user.name=Faktori Bootstrap',
    '-c', 'user.email=faktori@localhost',
    '-c', 'commit.gpgSign=false',
    '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '--allow-empty', '-m', 'chore: initialize product',
  ], { encoding: 'utf8' });
  return commit.status === 0 ? undefined : commit.stderr.trim() || 'initial git commit failed';
}

function existingSourceFiles(root: string): Map<string, { digest: string; mode: number }> {
  const snapshot = sourceSnapshot(root);
  return new Map(snapshot.files.map((file) => [file.relativePath, { digest: file.digest, mode: file.mode }]));
}

function copyApprovedSource(effect: LocalGitRepositoryEffect, target: string, provisioningRoot: string): LocalOutcome | undefined {
  if (effect.source === undefined) return undefined;
  let current: SourceSnapshot;
  try {
    current = sourceSnapshot(effect.source.path);
  } catch (error) {
    return { status: 'failed', target: effect.target, reason: error instanceof Error ? error.message : String(error) };
  }
  if (current.digest !== effect.source.digest || current.fileCount !== effect.source.fileCount) {
    return { status: 'blocked', target: effect.target, reason: 'Approved source snapshot changed after proposal; create and approve a new proposal.' };
  }
  const existing = existingSourceFiles(target);
  const approved = new Map(current.files.map((file) => [file.relativePath, file]));
  for (const [relativePath, file] of existing) {
    const expected = approved.get(relativePath);
    if (expected === undefined || expected.digest !== file.digest || expected.mode !== file.mode) {
      return { status: 'blocked', target: effect.target, reason: `Existing product scaffold differs from the approved source at ${relativePath}; it was not overwritten.` };
    }
  }
  for (const file of current.files) {
    if (existing.has(file.relativePath)) continue;
    const destination = resolve(target, file.relativePath);
    ensureParentInsideRoot(provisioningRoot, destination);
    const bytes = readRegularFileNoFollow(resolve(current.path, file.relativePath), file.relativePath);
    if (createHash('sha256').update(bytes).digest('hex') !== file.digest) {
      return { status: 'blocked', target: effect.target, reason: `Approved source changed while copying ${file.relativePath}; no unverified bytes were imported.` };
    }
    try {
      writeFileSync(destination, bytes, { flag: 'wx', mode: file.mode });
    } catch (error) {
      const afterRace = existsSync(destination) ? readRegularFileNoFollow(destination, file.relativePath) : undefined;
      if (afterRace === undefined || createHash('sha256').update(afterRace).digest('hex') !== file.digest) {
        return { status: 'blocked', target: effect.target, reason: `Product scaffold changed concurrently at ${file.relativePath}; it was not overwritten.` };
      }
    }
  }
  const copied = sourceSnapshot(target);
  if (copied.digest !== effect.source.digest || copied.fileCount !== effect.source.fileCount) {
    return { status: 'blocked', target: effect.target, reason: 'Copied product scaffold does not match the approved source snapshot; Git initialization was refused.' };
  }
  return undefined;
}

function executeLocalEffect(
  root: string,
  effect: LocalConfigEffect | LocalGitRepositoryEffect | LocalProductRegistrationEffect,
  proposal: ProvisioningProposal,
  priorOperation: ProvisioningOperation | undefined,
  onBeforeGitInit: ((event: BeforeGitInitEvent) => void) | undefined,
  onBeforeProductRegistrationWrite: ((event: BeforeProductRegistrationWriteEvent) => void) | undefined,
): LocalOutcome {
  const path = targetPath(root, effect.target);
  if (effect.kind === 'local-config') {
    const contents = profileContents(proposal);
    if (existsSync(path)) {
      if (readFileSync(path, 'utf8') === contents) return { status: 'reconciled', target: effect.target };
      return { status: 'blocked', target: effect.target, reason: 'Existing owner-controlled profile differs; it was not overwritten.' };
    }
    ensureParentInsideRoot(root, path);
    try {
      writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
      return { status: 'completed', target: effect.target };
    } catch {
      if (existsSync(path) && readFileSync(path, 'utf8') === contents) {
        return { status: 'reconciled', target: effect.target };
      }
      return { status: 'blocked', target: effect.target, reason: 'Owner-controlled factory profile appeared concurrently and differs; it was not overwritten.' };
    }
  }
  if (effect.kind === 'local-product-registration') {
    const contents = registrationContents(effect, proposal);
    if (existsSync(path)) {
      if (readRegularFileNoFollow(path, effect.target).toString('utf8') === contents) return { status: 'reconciled', target: effect.target };
      return { status: 'blocked', target: effect.target, reason: 'A different product addition claimed the approved configuration revision; the existing registration was not overwritten.' };
    }
    const currentRevision = approvedFactoryState(root).configurationRevision;
    if (currentRevision !== effect.previousConfigurationRevision) {
      return { status: 'blocked', target: effect.target, reason: 'Approved factory configuration changed; create and approve a new add-product proposal.' };
    }
    ensureParentInsideRoot(root, path);
    onBeforeProductRegistrationWrite?.({ effect, target: path });
    try {
      writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
      return { status: 'completed', target: effect.target };
    } catch {
      if (existsSync(path) && readRegularFileNoFollow(path, effect.target).toString('utf8') === contents) {
        return { status: 'reconciled', target: effect.target };
      }
      return { status: 'blocked', target: effect.target, reason: 'A different product addition claimed the approved configuration revision; no competing registration was written.' };
    }
  }
  if (existsSync(path) && isExactGitRepository(path)) {
    if (priorOperation?.status !== 'intended' || priorOperation.targetState !== 'missing') {
      return { status: 'blocked', target: effect.target, reason: 'Target was already a Git repository before this approved operation; it was not adopted implicitly.' };
    }
    if (effect.source !== undefined) {
      const copied = sourceSnapshot(path);
      if (copied.digest !== effect.source.digest || copied.fileCount !== effect.source.fileCount) {
        return { status: 'blocked', target: effect.target, reason: 'Interrupted product repository does not match the approved source snapshot.' };
      }
    }
    if (!hasGitHead(path)) {
      const commitError = commitInitialProduct(path);
      if (commitError !== undefined) return { status: 'failed', target: effect.target, reason: commitError };
    }
    const identityError = configureProductCommitIdentity(path);
    if (identityError !== undefined) return { status: 'failed', target: effect.target, reason: identityError };
    return { status: 'reconciled', target: effect.target };
  }
  if (existsSync(path)) {
    const resumableLeaf = (priorOperation?.status === 'intended' || priorOperation?.status === 'blocked' || priorOperation?.status === 'failed')
      && priorOperation.targetState === 'missing'
      && lstatSync(path).isDirectory();
    if (!resumableLeaf) {
      return { status: 'blocked', target: effect.target, reason: 'Target exists but is not a Git repository; it was not replaced.' };
    }
  } else {
    ensureParentInsideRoot(root, path);
    mkdirSync(path, { recursive: false });
    assertNoSymlinkComponents(root, path);
  }
  const sourceOutcome = copyApprovedSource(effect, path, root);
  if (sourceOutcome !== undefined) return sourceOutcome;
  onBeforeGitInit?.({ effect, target: path });
  if (effect.source !== undefined) {
    const beforeGit = sourceSnapshot(path);
    if (beforeGit.digest !== effect.source.digest || beforeGit.fileCount !== effect.source.fileCount) {
      return { status: 'blocked', target: effect.target, reason: 'Product scaffold changed after the approved copy; Git initialization was refused.' };
    }
  }
  assertNoSymlinkComponents(root, path);
  const init = spawnSync('git', ['init', '--quiet', '--initial-branch=main', path], { encoding: 'utf8' });
  if (init.status !== 0) return { status: 'failed', target: effect.target, reason: init.stderr.trim() || 'git init failed' };
  const commitError = commitInitialProduct(path);
  if (commitError !== undefined) return { status: 'failed', target: effect.target, reason: commitError };
  const identityError = configureProductCommitIdentity(path);
  if (identityError !== undefined) return { status: 'failed', target: effect.target, reason: identityError };
  return { status: 'completed', target: effect.target };
}

function observeCompletedLocalEffect(
  root: string,
  effect: LocalConfigEffect | LocalGitRepositoryEffect | LocalProductRegistrationEffect,
  proposal: ProvisioningProposal,
): LocalOutcome {
  const path = targetPath(root, effect.target);
  if (effect.kind === 'local-config') {
    if (!existsSync(path)) return { status: 'blocked', target: effect.target, reason: 'Drift detected: approved factory profile is missing; it was not recreated.' };
    if (readFileSync(path, 'utf8') !== profileContents(proposal)) {
      return { status: 'blocked', target: effect.target, reason: 'Drift detected: owner-controlled factory profile changed; it was not overwritten.' };
    }
    return { status: 'reconciled', target: effect.target };
  }
  if (effect.kind === 'local-product-registration') {
    if (!existsSync(path)) return { status: 'blocked', target: effect.target, reason: 'Drift detected: approved product registration is missing.' };
    if (readRegularFileNoFollow(path, effect.target).toString('utf8') !== registrationContents(effect, proposal)) {
      return { status: 'blocked', target: effect.target, reason: 'Drift detected: approved product registration changed; it was not overwritten.' };
    }
    return { status: 'reconciled', target: effect.target };
  }
  if (!existsSync(path) || !isExactGitRepository(path)) {
    return { status: 'blocked', target: effect.target, reason: 'Drift detected: approved Git repository is missing or changed; it was not recreated.' };
  }
  return { status: 'reconciled', target: effect.target };
}

function assertPriorOperationMatches(
  operation: ProvisioningOperation,
  proposal: ProvisioningProposal,
  effect: ProvisioningEffect,
): void {
  if (operation.proposalRevision !== proposal.revision || operation.effectId !== effect.id) {
    fail('journal', `operation ${operation.operationId} is not bound to the current proposal effect`);
  }
  if (digest(operation.effect, 'journal.effect') !== digest(effect, 'proposal.effect')) {
    fail('journal', `operation ${operation.operationId} records a different effect for the same identity`);
  }
}

function validateApproval(value: unknown): ProvisioningApproval {
  const input = record(value, 'approval');
  if (input.format !== 'faktori.provisioning-approval/v1') fail('approval', 'must be a provisioning approval');
  const approval: ProvisioningApproval = {
    format: 'faktori.provisioning-approval/v1',
    proposalRevision: nonEmpty(input.proposalRevision, 'approval.proposalRevision'),
    configurationRevision: nonEmpty(input.configurationRevision, 'approval.configurationRevision'),
    approverId: nonEmpty(input.approverId, 'approval.approverId'),
    effectIds: stringArray(input.effectIds, 'approval.effectIds'),
    confirmedRiskIds: stringArray(input.confirmedRiskIds, 'approval.confirmedRiskIds'),
    riskAcknowledgements: stringRecord(input.riskAcknowledgements, 'approval.riskAcknowledgements'),
    revision: nonEmpty(input.revision, 'approval.revision'),
  };
  if (approval.revision !== digest(approvalPayload(approval), 'approval')) {
    fail('approval.revision', 'does not match the approval contents');
  }
  return approval;
}

function assertApproval(
  proposalValue: unknown,
  approvalValue: unknown,
  resolvedConfigValue: unknown,
): { proposal: ProvisioningProposal; approval: ProvisioningApproval; resolvedConfig: ValidatedResolvedConfig } {
  const proposal = validateProposal(proposalValue);
  const resolvedConfig = validateResolvedConfig(resolvedConfigValue);
  if (proposal.configurationRevision !== digest(resolvedConfig.value, 'resolvedConfig')) {
    fail('resolvedConfig', 'changed after proposal approval; create and approve a new proposal');
  }
  const approval = validateApproval(approvalValue);
  if (approval.proposalRevision !== proposal.revision || approval.configurationRevision !== proposal.configurationRevision) {
    fail('approval', 'is not bound to this exact proposal and configuration revision');
  }
  exactIds(approval.effectIds, proposal.effects.map((effect) => effect.id), 'approval.effectIds');
  const riskIds = proposal.risks.map((risk) => risk.id);
  exactIds(approval.confirmedRiskIds, riskIds, 'approval.confirmedRiskIds');
  if (JSON.stringify(Object.keys(approval.riskAcknowledgements).sort()) !== JSON.stringify([...riskIds].sort())) {
    fail('approval.riskAcknowledgements', 'must acknowledge every current risk exactly once');
  }
  for (const riskId of riskIds) nonEmpty(approval.riskAcknowledgements[riskId], `approval.riskAcknowledgements.${riskId}`);
  return { proposal, approval, resolvedConfig };
}

function optionalBeforeEffectCallback(value: unknown): ((event: BeforeEffectEvent) => void) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') fail('onBeforeEffect', 'must be a function');
  return (event) => { value(event); };
}

function optionalBeforeGitInitCallback(value: unknown): ((event: BeforeGitInitEvent) => void) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') fail('onBeforeGitInit', 'must be a function');
  return (event) => { value(event); };
}

function optionalBeforeProductRegistrationWriteCallback(value: unknown): ((event: BeforeProductRegistrationWriteEvent) => void) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') fail('onBeforeProductRegistrationWrite', 'must be a function');
  return (event) => { value(event); };
}

function optionalAfterEffectCallback(value: unknown): ((event: AfterEffectEvent) => void) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') fail('onAfterEffect', 'must be a function');
  return (event) => { value(event); };
}

/**
 * Applies approved local effects under an explicit root. Intent is journaled
 * before each effect, and interrupted identities are reconciled on rerun.
 */
export function provisionApprovedProposal(input: ProvisionApprovedInput): { journal: string; operations: ProvisioningOperation[] };
export function provisionApprovedProposal(input: unknown): { journal: string; operations: ProvisioningOperation[] };
export function provisionApprovedProposal(input: unknown): { journal: string; operations: ProvisioningOperation[] } {
  const value = record(input, 'approved provisioning bundle');
  const { proposal, resolvedConfig } = assertApproval(value.proposal, value.approval, value.resolvedConfig);
  const root = nonEmpty(value.root, 'root');
  if (!isAbsolute(root)) fail('root', 'must be an absolute dedicated provisioning root');
  if (proposal.change !== undefined && !existsSync(root)) fail('root', 'product new requires an existing approved factory root');
  const remoteTransport = value.remoteTransport ?? createFakeRemoteTransport();
  if (!isFakeRemoteTransport(remoteTransport)) fail('remoteTransport', 'only the explicit fake transport is supported in Phase 1');
  const onBeforeEffect = optionalBeforeEffectCallback(value.onBeforeEffect);
  const onBeforeGitInit = optionalBeforeGitInitCallback(value.onBeforeGitInit);
  const onBeforeProductRegistrationWrite = optionalBeforeProductRegistrationWriteCallback(value.onBeforeProductRegistrationWrite);
  const onAfterEffect = optionalAfterEffectCallback(value.onAfterEffect);
  const realRoot = realProvisioningRoot(root);
  if (proposal.change !== undefined) {
    const addition = validateProductAddition({
      kind: proposal.change.kind,
      productId: proposal.change.productId,
      previousResolvedConfig: value.previousResolvedConfig,
    }, resolvedConfig);
    if (addition === undefined || !sameJson(addition.change, proposal.change)) fail('proposal.change', 'does not match the supplied previous and next configurations');
    const localEffects = proposal.effects.filter((effect) => effect.kind !== 'remote-provider');
    const repository = localEffects.filter((effect): effect is LocalGitRepositoryEffect => effect.kind === 'local-git-repository');
    const registrations = localEffects.filter((effect): effect is LocalProductRegistrationEffect => effect.kind === 'local-product-registration');
    const expectedRegistrationTarget = `config/product-revisions/${proposal.change.previousConfigurationRevision}.json`;
    if (localEffects.length !== 2
      || localEffects[0]?.kind !== 'local-product-registration'
      || localEffects[1]?.kind !== 'local-git-repository'
      || repository.length !== 1 || registrations.length !== 1
      || repository[0].id !== `local:product-repository:${proposal.change.productId}`
      || repository[0].productId !== proposal.change.productId
      || repository[0].target !== `products/${proposal.change.productId}`
      || registrations[0].id !== `local:product-registration:${proposal.change.productId}`
      || registrations[0].productId !== proposal.change.productId
      || registrations[0].target !== expectedRegistrationTarget
      || registrations[0].previousConfigurationRevision !== proposal.change.previousConfigurationRevision
      || registrations[0].configurationRevision !== proposal.configurationRevision
      || !sameJson(registrations[0].product, addition.product)) {
      fail('proposal.effects', 'add-product must contain only the named repository and configuration registration local effects');
    }
    const approved = approvedFactoryState(realRoot);
    if (!sameJson(approved.factory, proposal.factory) || !sameJson(approved.components, proposal.components)) {
      fail('root', 'approved factory identity or component locks differ; existing factory state was not changed');
    }
    if (approved.configurationRevision !== proposal.change.previousConfigurationRevision
      && approved.configurationRevision !== proposal.configurationRevision) {
      fail('root', 'approved factory configuration changed; create and approve a new add-product proposal');
    }
  }
  const prior = priorOperations(realRoot);
  const operations: ProvisioningOperation[] = [];
  for (const effect of proposal.effects) {
    const operationId = `provision:${proposal.revision}:${effect.id}`;
    const previous = prior.get(operationId);
    if (previous !== undefined) assertPriorOperationMatches(previous, proposal, effect);
    if (previous?.status === 'pending') {
      operations.push(previous);
      continue;
    }
    if ((previous?.status === 'completed' || previous?.status === 'reconciled') && effect.kind !== 'remote-provider') {
      const observed = observeCompletedLocalEffect(realRoot, effect, proposal);
      const outcome: ProvisioningOperation = {
        operationId,
        proposalRevision: proposal.revision,
        effectId: effect.id,
        effect,
        ...observed,
      };
      appendJournal(realRoot, outcome);
      operations.push(outcome);
      continue;
    }
    const path = effect.kind === 'remote-provider' ? undefined : targetPath(realRoot, effect.target);
    const intended: ProvisioningOperation = {
      operationId,
      proposalRevision: proposal.revision,
      effectId: effect.id,
      status: 'intended',
      targetState: path !== undefined && existsSync(path) ? 'present' : 'missing',
      effect,
    };
    appendJournal(realRoot, intended);
    onBeforeEffect?.({ operationId, effect, ...(path === undefined ? {} : { target: path }) });
    const observed: EffectOutcome = effect.kind === 'remote-provider'
      ? remoteTransport.apply({ ...effect, operationId })
      : executeLocalEffect(realRoot, effect, proposal, previous, onBeforeGitInit, onBeforeProductRegistrationWrite);
    onAfterEffect?.({ operationId, effect, observed });
    const outcome: ProvisioningOperation = { ...intended, ...observed, operationId };
    appendJournal(realRoot, outcome);
    operations.push(outcome);
    if (proposal.change !== undefined
      && effect.kind === 'local-product-registration'
      && outcome.status !== 'completed'
      && outcome.status !== 'reconciled') break;
  }
  return { journal: journalPath(realRoot), operations };
}

/** Applies only an explicitly approved add-product proposal to an existing factory. */
export function provisionApprovedNewProduct(input: ProvisionApprovedNewProductInput): { journal: string; operations: ProvisioningOperation[] };
export function provisionApprovedNewProduct(input: unknown): { journal: string; operations: ProvisioningOperation[] };
export function provisionApprovedNewProduct(input: unknown): { journal: string; operations: ProvisioningOperation[] } {
  const value = record(input, 'approved new-product bundle');
  const proposal = validateProposal(value.proposal);
  if (proposal.change?.kind !== 'add-product') fail('proposal.change', 'product new requires an add-product proposal');
  return provisionApprovedProposal(value);
}

export interface ProductPreview {
  product: JsonObject;
  inheritsFactoryDefaults: true;
  incrementalCost: JsonValue;
  podsCreated: 0;
}

/** Shows inherited configuration and incremental cost without adding a pod. */
export function previewNewProduct(input: ProductPreviewInput): ProductPreview;
export function previewNewProduct(input: unknown): ProductPreview;
export function previewNewProduct(input: unknown): ProductPreview {
  const value = record(input, 'product preview request');
  const resolvedConfig = validateResolvedConfig(value.resolvedConfig);
  const product = jsonObject(value.product, 'product');
  const productId = nonEmpty(product.id, 'product.id');
  if (resolvedConfig.products.some((existing) => existing.id === productId)) fail('product.id', 'already exists');
  const providerId = optionalString(product.providerId, 'product.providerId') ?? resolvedConfig.factory.defaults.providerId;
  const environmentId = optionalString(product.environmentId, 'product.environmentId') ?? resolvedConfig.factory.defaults.environmentId;
  const resolvedProduct: JsonObject = { ...product, id: productId };
  if (providerId !== undefined) resolvedProduct.providerId = providerId;
  if (environmentId !== undefined) resolvedProduct.environmentId = environmentId;
  return {
    product: resolvedProduct,
    inheritsFactoryDefaults: true,
    incrementalCost: normalizeJson(value.incrementalCost ?? 'unknown', 'incrementalCost'),
    podsCreated: 0,
  };
}
