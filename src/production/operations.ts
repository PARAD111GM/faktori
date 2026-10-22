import { createHash } from 'node:crypto';

export type OperationsPlatform = 'web' | 'ios' | 'android';
export type ProductOperationsReference = string;

export interface ProductOperationsRequest {
  format: 'faktori.product-operations-request/v1';
  product: { id: string; revision: string };
  candidate: { id: string; revision: string; sourceRevision: string };
  platforms: OperationsPlatform[];
  /** Native iOS and Android default to a single shared cross-platform codebase. */
  mobileCodebase?: { reference: string; shared: boolean; exceptionRationale?: string };
  targets?: {
    web?: { hosting: string; runtime: string; database: string; domainTls: string; accountOwner: string; credentialCustody: string };
    ios?: { build: string; signing: string; distribution: string; storeAccount: string; accountOwner: string };
    android?: { build: string; signing: string; distribution: string; storeAccount: string; accountOwner: string };
    integrations?: string[];
    monthlyRuntimeEstimate?: string;
    spendingAuthority?: string;
  };
  dataPolicy?: {
    classifications: Array<{ dataClass: string; allowedModelData: string; retention: string }>;
    providerRegionRestrictions?: string;
  };
  recovery?: { backupPolicy: string; restoreEvidence: string; disposableRestoreTarget: string; recoveryObjectives: string };
  compatibility?: {
    migrationStrategy: 'expand_contract' | 'not_applicable' | 'unresolved';
    supportedClients: string[];
    compatibilityEvidence: string;
    destructiveChangeRecovery?: string;
  };
  security?: {
    authorizationEvidence: string;
    dependencyInventory: string;
    secretsScanEvidence: string;
    evaluatorEvidence: string;
    privacyTermsReview: string;
  };
  incident?: {
    primaryOwner: string;
    backupOwner: string;
    notificationRoute: string;
    coverage: string;
    responseObjectives: string;
    rollbackOrForwardFixAuthority: string;
  };
  limits?: {
    iterationCeiling: number;
    concurrencyLimit: number;
    monthlySpendCeiling: string;
    attentionAllowance: string;
    responseWindow: string;
    escalationPolicy: string;
  };
}

export interface ProductOperationsInspection {
  format: 'faktori.product-operations-inspection/v1';
  requestDigest: string;
  planStatus: 'incomplete' | 'declared_for_independent_review';
  evidenceState: 'declared_not_observed';
  executionReady: false;
  productionReady: false;
  blockers: string[];
  declared: {
    productId: string;
    productRevision: string;
    candidateId: string;
    candidateRevision: string;
    sourceRevision: string;
    platforms: OperationsPlatform[];
    sharedMobileCodebase: boolean | null;
  };
}

type Obj = Record<string, unknown>;
const platforms = new Set<OperationsPlatform>(['web', 'ios', 'android']);
const topFields = new Set(['format', 'product', 'candidate', 'platforms', 'mobileCodebase', 'targets', 'dataPolicy', 'recovery', 'compatibility', 'security', 'incident', 'limits']);

function object(value: unknown, path: string, optional = false): Obj | undefined {
  if (value === undefined && optional) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${path} must be a plain object`);
  return value as Obj;
}
function exact(value: Obj, fields: string[], path: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw new Error(`${path} contains unknown field: ${unknown}`);
}
function safeText(value: unknown, path: string, max = 512): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${path} must be bounded non-empty text`);
  if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i.test(value)) throw new Error(`${path} must contain a reference, not a secret or environment value`);
  return value;
}
function revision(value: unknown, path: string): string {
  const text = safeText(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(text)) throw new Error(`${path} must be a revision identifier`);
  return text;
}
function requiredRef(input: Obj | undefined, key: string, path: string, blockers: string[]): void {
  const value = input?.[key];
  if (value === undefined || value === null || value === '') blockers.push(`${path}.${key}: provide an owner-approved resource or evidence reference`);
  else safeText(value, `${path}.${key}`);
}
function section(input: Obj | undefined, fields: string[], path: string, blockers: string[]): void {
  if (!input) { blockers.push(`${path}: provide the required plan and evidence references`); return; }
  exact(input, fields, path);
  for (const field of fields) requiredRef(input, field, path, blockers);
}
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Obj;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

/** Inspects a bounded product release plan. It validates declarations and never observes systems or grants release authority. */
export function inspectProductOperations(value: unknown): ProductOperationsInspection {
  const input = object(value, 'request')!;
  exact(input, [...topFields], 'request');
  if (input.format !== 'faktori.product-operations-request/v1') throw new Error('request.format must be faktori.product-operations-request/v1');
  const product = object(input.product, 'product')!; exact(product, ['id', 'revision'], 'product');
  const candidate = object(input.candidate, 'candidate')!; exact(candidate, ['id', 'revision', 'sourceRevision'], 'candidate');
  const productId = safeText(product.id, 'product.id', 128);
  const productRevision = revision(product.revision, 'product.revision');
  const candidateId = safeText(candidate.id, 'candidate.id', 128);
  const candidateRevision = revision(candidate.revision, 'candidate.revision');
  const sourceRevision = revision(candidate.sourceRevision, 'candidate.sourceRevision');
  if (!Array.isArray(input.platforms) || input.platforms.length < 1 || input.platforms.length > 3) throw new Error('platforms must contain one to three supported platforms');
  const selected = input.platforms.map((value, index) => {
    if (typeof value !== 'string' || !platforms.has(value as OperationsPlatform)) throw new Error(`platforms[${index}] is unsupported`);
    return value as OperationsPlatform;
  });
  if (new Set(selected).size !== selected.length) throw new Error('platforms must not contain duplicates');
  const blockers: string[] = [];
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceRevision)) blockers.push('candidate.sourceRevision: bind an exact Git commit before independent release review');
  const targets = object(input.targets, 'targets', true);
  if (targets) exact(targets, ['web', 'ios', 'android', 'integrations', 'monthlyRuntimeEstimate', 'spendingAuthority'], 'targets');
  for (const platform of selected) {
    const fields = platform === 'web'
      ? ['hosting', 'runtime', 'database', 'domainTls', 'accountOwner', 'credentialCustody']
      : ['build', 'signing', 'distribution', 'storeAccount', 'accountOwner'];
    const target = object(targets?.[platform], `targets.${platform}`, true);
    section(target, fields, `targets.${platform}`, blockers);
  }
  if (selected.includes('ios') || selected.includes('android')) {
    const mobile = object(input.mobileCodebase, 'mobileCodebase', true);
    if (!mobile) blockers.push('mobileCodebase: declare the shared native iOS/Android codebase or a product-specific separate-codebase exception');
    else {
      exact(mobile, ['reference', 'shared', 'exceptionRationale'], 'mobileCodebase');
      requiredRef(mobile, 'reference', 'mobileCodebase', blockers);
      if (typeof mobile.shared !== 'boolean') throw new Error('mobileCodebase.shared must be boolean');
      if (!mobile.shared && (typeof mobile.exceptionRationale !== 'string' || mobile.exceptionRationale.trim() === '')) blockers.push('mobileCodebase.exceptionRationale: explain the product-specific separate native codebase exception');
      if (mobile.exceptionRationale !== undefined) safeText(mobile.exceptionRationale, 'mobileCodebase.exceptionRationale', 1000);
    }
  } else if (input.mobileCodebase !== undefined) throw new Error('mobileCodebase is only valid for native platforms');
  const integrations = targets?.integrations;
  if (integrations !== undefined) {
    if (!Array.isArray(integrations) || integrations.length > 32) throw new Error('targets.integrations must contain at most 32 references');
    integrations.forEach((entry, index) => safeText(entry, `targets.integrations[${index}]`));
  }
  for (const key of ['monthlyRuntimeEstimate', 'spendingAuthority']) requiredRef(targets, key, 'targets', blockers);

  const data = object(input.dataPolicy, 'dataPolicy', true);
  if (!data) blockers.push('dataPolicy: classify product data and state allowed model data');
  else {
    exact(data, ['classifications', 'providerRegionRestrictions'], 'dataPolicy');
    if (!Array.isArray(data.classifications) || data.classifications.length < 1 || data.classifications.length > 32) throw new Error('dataPolicy.classifications must contain one to 32 entries');
    data.classifications.forEach((entry, index) => section(object(entry, `dataPolicy.classifications[${index}]`)!, ['dataClass', 'allowedModelData', 'retention'], `dataPolicy.classifications[${index}]`, blockers));
    requiredRef(data, 'providerRegionRestrictions', 'dataPolicy', blockers);
  }
  const recovery = object(input.recovery, 'recovery', true);
  section(recovery, ['backupPolicy', 'restoreEvidence', 'disposableRestoreTarget', 'recoveryObjectives'], 'recovery', blockers);
  const compatibility = object(input.compatibility, 'compatibility', true);
  if (!compatibility) blockers.push('compatibility: document migration and supported-client compatibility');
  else {
    exact(compatibility, ['migrationStrategy', 'supportedClients', 'compatibilityEvidence', 'destructiveChangeRecovery'], 'compatibility');
    if (!['expand_contract', 'not_applicable', 'unresolved'].includes(String(compatibility.migrationStrategy))) throw new Error('compatibility.migrationStrategy is invalid');
    if (compatibility.migrationStrategy === 'unresolved') blockers.push('compatibility.migrationStrategy: resolve migration compatibility strategy');
    if (!Array.isArray(compatibility.supportedClients) || compatibility.supportedClients.length > 64) throw new Error('compatibility.supportedClients must contain at most 64 references');
    if (compatibility.supportedClients.length === 0) blockers.push('compatibility.supportedClients: list supported client versions or state that no clients are supported');
    compatibility.supportedClients.forEach((entry, index) => safeText(entry, `compatibility.supportedClients[${index}]`));
    requiredRef(compatibility, 'compatibilityEvidence', 'compatibility', blockers);
    if (compatibility.destructiveChangeRecovery !== undefined) safeText(compatibility.destructiveChangeRecovery, 'compatibility.destructiveChangeRecovery');
  }
  const security = object(input.security, 'security', true);
  section(security, ['authorizationEvidence', 'dependencyInventory', 'secretsScanEvidence', 'evaluatorEvidence', 'privacyTermsReview'], 'security', blockers);
  const incident = object(input.incident, 'incident', true);
  section(incident, ['primaryOwner', 'backupOwner', 'notificationRoute', 'coverage', 'responseObjectives', 'rollbackOrForwardFixAuthority'], 'incident', blockers);
  const limits = object(input.limits, 'limits', true);
  if (!limits) blockers.push('limits: set owner-approved resource, iteration, and attention limits');
  else {
    exact(limits, ['iterationCeiling', 'concurrencyLimit', 'monthlySpendCeiling', 'attentionAllowance', 'responseWindow', 'escalationPolicy'], 'limits');
    for (const key of ['iterationCeiling', 'concurrencyLimit']) {
      const amount = limits[key];
      if (!Number.isInteger(amount) || Number(amount) < 1 || Number(amount) > 1000) throw new Error(`limits.${key} must be an integer from 1 to 1000`);
    }
    for (const key of ['monthlySpendCeiling', 'attentionAllowance', 'responseWindow', 'escalationPolicy']) requiredRef(limits, key, 'limits', blockers);
  }
  // Declarations and evidence pointers are not live observations or authorization receipts.
  blockers.push('acceptance: independently observe security, recovery, compatibility, target resources, and exact deployed artifact before release');
  return Object.freeze({
    format: 'faktori.product-operations-inspection/v1',
    requestDigest: createHash('sha256').update(stable(input)).digest('hex'),
    planStatus: blockers.length === 1 ? 'declared_for_independent_review' : 'incomplete',
    evidenceState: 'declared_not_observed', executionReady: false, productionReady: false,
    blockers,
    declared: { productId, productRevision, candidateId, candidateRevision, sourceRevision, platforms: selected, sharedMobileCodebase: selected.includes('ios') || selected.includes('android') ? ((input.mobileCodebase as Obj | undefined)?.shared === true) : null },
  });
}
