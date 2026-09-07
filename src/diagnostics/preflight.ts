import {
  ConfigValidationError,
  resolveFactoryConfig,
  type FactoryConfiguration,
  type ProviderCapability,
  type ResolvedFactoryConfiguration,
} from '../config/index.ts';

/** A data-only readiness record. It deliberately contains no launch authority. */
export type PreflightCheckStatus = 'pass' | 'fail' | 'unavailable' | 'not_tested';
export type PreflightSection = 'configuration' | 'console' | 'execution' | 'resources' | 'provider' | 'integrations' | 'live_evidence';
export type ObservationBasis = 'configuration' | 'observed' | 'not_observed';
export type ObservationFreshness = 'current' | 'stale' | 'unknown' | 'not_applicable';

export interface PreflightScope {
  factoryId: string;
  productId: string;
  podId?: string;
}

export interface PreflightCheck {
  id: string;
  section: PreflightSection;
  status: PreflightCheckStatus;
  basis: ObservationBasis;
  freshness: ObservationFreshness;
  scope: PreflightScope;
  remediation: string;
}

export interface PreflightResult {
  format: 'faktori.preflight-result/v1';
  scope: PreflightScope;
  checks: PreflightCheck[];
  summary: Record<PreflightCheckStatus, number>;
  status: 'ready' | 'partial' | 'blocked';
  /** True only when every prerequisite and revision-bound live-evidence check passed. It is not an admission lease. */
  executionReady: boolean;
  liveExecutionVerified: boolean;
  /** A Console projection may be useful even while execution remains blocked. */
  projectionReady: boolean;
}

type InputRecord = Record<string, unknown>;
type Target = PreflightScope;
type Observation = { id?: unknown; status?: unknown; basis?: unknown; freshness?: unknown; scope?: unknown };

const CAPABILITIES = new Set<ProviderCapability>(['isolated', 'native', 'subagents', 'token-limit']);
const STATUSES = new Set<PreflightCheckStatus>(['pass', 'fail', 'unavailable', 'not_tested']);
const FRESHNESS = new Set<ObservationFreshness>(['current', 'stale', 'unknown', 'not_applicable']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE = /(?:bearer|authorization|credential|password|secret|token|api[_-]?key|\.codex|\.claude|\.env|\.npmrc|\.netrc|\.ssh|\.gnupg|\.aws|(?:^|[\/])(?:Users|home)(?:[\/]|$))/i;
const CREDENTIAL_SIGNATURE = /(?:\bsk-(?:(?:proj|live|test)-)?[A-Za-z0-9_-]{8,}|\b(?:[rs]k_(?:live|test)|whsec)_[A-Za-z0-9]{8,}|\b(?:gh[opusr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bxox[aboprs]-[A-Za-z0-9-]{10,}|\bnpm_[A-Za-z0-9]{12,}|\bpypi-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const SECTIONS: Array<Exclude<PreflightSection, 'configuration' | 'console' | 'provider' | 'live_evidence'>> = ['execution', 'resources', 'integrations'];

function record(value: unknown): InputRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as InputRecord : undefined;
}

function requiredText(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) && !SENSITIVE.test(value) && !CREDENTIAL_SIGNATURE.test(value) ? value : undefined;
}

function safeRevision(value: unknown): string | undefined {
  return typeof value === 'string' && (/^[a-f0-9]{7,64}$/i.test(value) || /^[A-Za-z][A-Za-z0-9._-]{0,63}(?:@[0-9]{1,12})?$/.test(value)) && !SENSITIVE.test(value) && !CREDENTIAL_SIGNATURE.test(value)
    ? value
    : undefined;
}

function targetFrom(value: unknown): Target | undefined {
  const input = record(value);
  const factoryId = requiredText(input?.factoryId);
  const productId = requiredText(input?.productId);
  const podId = input?.podId === undefined ? undefined : requiredText(input.podId);
  if (factoryId === undefined || productId === undefined || (input?.podId !== undefined && podId === undefined)) return undefined;
  return { factoryId, productId, ...(podId === undefined ? {} : { podId }) };
}

function redactedScope(target: Target | undefined): PreflightScope {
  return target ?? { factoryId: 'unresolved', productId: 'unresolved' };
}

function remediation(section: PreflightSection, status: PreflightCheckStatus): string {
  if (status === 'pass') return 'No action required.';
  if (section === 'configuration') return 'Correct the declared factory configuration and target, then rerun the read-only preflight.';
  if (section === 'console') return 'Provide a current, target-scoped projection prerequisite observation.';
  if (section === 'execution') return 'Provide a current, target-scoped execution prerequisite observation; do not launch a provider from preflight.';
  if (section === 'resources') return 'Provide a current budget and resource-compatibility observation; unknown telemetry must remain unknown.';
  if (section === 'provider') return 'Record a current capability observation for the configured provider; do not infer it from login or provider kind.';
  if (section === 'integrations') return 'Provide current integration prerequisite observations without invoking an integration action.';
  return 'Attach current revision-bound evidence or leave this optional evidence explicitly not tested.';
}

function check(id: string, section: PreflightSection, status: PreflightCheckStatus, basis: ObservationBasis, freshness: ObservationFreshness, scope: PreflightScope, fixedRemediation?: string): PreflightCheck {
  return { id, section, status, basis, freshness, scope, remediation: fixedRemediation ?? remediation(section, status) };
}

function statusOf(value: unknown): PreflightCheckStatus | undefined {
  return typeof value === 'string' && STATUSES.has(value as PreflightCheckStatus) ? value as PreflightCheckStatus : undefined;
}

function freshnessOf(value: unknown): ObservationFreshness {
  return typeof value === 'string' && FRESHNESS.has(value as ObservationFreshness) ? value as ObservationFreshness : 'unknown';
}

function scopeMatches(value: unknown, expected: PreflightScope): boolean {
  const candidate = targetFrom(value);
  return candidate !== undefined
    && candidate.factoryId === expected.factoryId
    && candidate.productId === expected.productId
    && candidate.podId === expected.podId;
}

function observedCheck(id: string, section: PreflightSection, observation: Observation | undefined, scope: PreflightScope): PreflightCheck {
  if (observation === undefined) return check(id, section, 'not_tested', 'not_observed', 'unknown', scope);
  const status = statusOf(observation.status);
  const freshness = freshnessOf(observation.freshness);
  if (status === undefined) return check(id, section, 'fail', 'observed', freshness, scope);
  if (observation.scope === undefined || !scopeMatches(observation.scope, scope)) return check(id, section, 'unavailable', 'observed', freshness, scope);
  if (status === 'pass' && freshness !== 'current' && freshness !== 'not_applicable') return check(id, section, 'unavailable', 'observed', freshness, scope);
  // JSON assertions are diagnostic input, not trusted measurements. A claimed
  // success therefore remains explicitly unverified until a future read
  // adapter supplies independently bound evidence. Negative observations stay
  // fail-closed and retain their remediation value.
  if (status === 'pass') return check(id, section, 'not_tested', 'observed', 'unknown', scope);
  return check(id, section, status, 'observed', freshness, scope);
}

function sectionChecks(section: Exclude<PreflightSection, 'configuration' | 'console' | 'provider' | 'live_evidence'>, value: unknown, scope: PreflightScope): PreflightCheck[] {
  const input = record(value);
  if (input === undefined) return [observedCheck(`${section}.observed`, section, undefined, scope)];
  const prerequisites = input.prerequisites;
  if (!Array.isArray(prerequisites)) return [check(`${section}.invalid_input`, section, 'fail', 'observed', 'unknown', scope)];
  if (prerequisites.length === 0) return [observedCheck(`${section}.observed`, section, undefined, scope)];
  const seen = new Set<string>();
  const output: PreflightCheck[] = [];
  for (const item of prerequisites) {
    const observation = record(item);
    const localId = requiredText(observation?.id);
    if (observation === undefined || localId === undefined || seen.has(localId)) {
      output.push(check(`${section}.invalid_input`, section, 'fail', 'observed', 'unknown', scope));
      continue;
    }
    seen.add(localId);
    output.push(observedCheck(`${section}.${localId}`, section, observation, scope));
  }
  return output;
}

function configuredTarget(config: ResolvedFactoryConfiguration, target: Target): { providerId: string; executionProfile: 'isolated' | 'native'; requiredCapabilities: ProviderCapability[]; strictSpending: boolean } | undefined {
  if (config.factory.id !== target.factoryId) return undefined;
  const item = target.podId === undefined
    ? config.products.find((product) => product.id === target.productId)
    : config.pods.find((pod) => pod.id === target.podId && pod.productId === target.productId);
  if (item === undefined) return undefined;
  return { providerId: item.providerId, executionProfile: item.executionProfile, requiredCapabilities: item.requiredCapabilities, strictSpending: item.budget.strictSpending };
}

function providerChecks(input: InputRecord, config: ResolvedFactoryConfiguration, target: Target, scope: PreflightScope): PreflightCheck[] {
  const selected = configuredTarget(config, target);
  if (selected === undefined) return [check('provider.target', 'provider', 'fail', 'configuration', 'not_applicable', scope)];
  const profile = record(input.profile);
  const requestedProfile = profile?.executionProfile;
  const profileCheck = requestedProfile === undefined || requestedProfile === selected.executionProfile
    ? check('provider.execution_profile', 'provider', 'pass', 'configuration', 'not_applicable', scope)
    : check('provider.execution_profile', 'provider', 'fail', 'configuration', 'not_applicable', scope);
  const configured = config.providers.find((provider) => provider.id === selected.providerId);
  if (configured === undefined) return [profileCheck, check('provider.configured', 'provider', 'fail', 'configuration', 'not_applicable', scope)];
  const requestedCapabilities = Array.isArray(profile?.requiredCapabilities)
    ? profile.requiredCapabilities.filter((value): value is ProviderCapability => typeof value === 'string' && CAPABILITIES.has(value as ProviderCapability))
    : [];
  const requestedCapabilitiesValid = profile?.requiredCapabilities === undefined
    || (Array.isArray(profile.requiredCapabilities) && requestedCapabilities.length === profile.requiredCapabilities.length);
  const requiredCapabilities: ProviderCapability[] = [
    selected.executionProfile,
    ...selected.requiredCapabilities,
    ...requestedCapabilities,
    ...(selected.strictSpending ? ['token-limit' as ProviderCapability] : []),
  ];
  const required = [...new Set<ProviderCapability>(requiredCapabilities)];
  const providerObservations = Array.isArray(input.providers) ? input.providers.map(record).filter((item): item is InputRecord => item !== undefined) : [];
  const observedProvider = providerObservations.find((item) => item.providerId === selected.providerId);
  const capabilities = Array.isArray(observedProvider?.capabilities) ? observedProvider.capabilities.map(record).filter((item): item is InputRecord => item !== undefined) : [];
  const output = [profileCheck];
  if (!requestedCapabilitiesValid) output.push(check('provider.requested_capabilities', 'provider', 'fail', 'configuration', 'not_applicable', scope));
  for (const capability of required) {
    if (!configured.capabilities.includes(capability)) {
      output.push(check(`provider.${capability}.configured`, 'provider', 'fail', 'configuration', 'not_applicable', scope));
      continue;
    }
    const matching = capabilities.filter((item) => item.capability === capability);
    const selectedObservation = matching.find((item) => item.status === 'fail')
      ?? matching.find((item) => item.status === 'unavailable')
      ?? matching.find((item) => item.status === 'not_tested')
      ?? matching.find((item) => item.status === 'pass')
      ?? matching[0];
    output.push(observedCheck(`provider.${capability}.observed`, 'provider', selectedObservation, scope));
  }
  return output;
}

function liveEvidenceChecks(value: unknown, expectedRevisionValue: unknown, scope: PreflightScope): PreflightCheck[] {
  if (value === undefined) return [observedCheck('live_evidence.observed', 'live_evidence', undefined, scope)];
  const input = record(value);
  const evidence = input === undefined ? undefined : input.evidence;
  if (!Array.isArray(evidence)) return [check('live_evidence.invalid_input', 'live_evidence', 'fail', 'observed', 'unknown', scope)];
  if (evidence.length === 0) return [observedCheck('live_evidence.observed', 'live_evidence', undefined, scope)];
  const expectedRevision = safeRevision(expectedRevisionValue);
  return evidence.map((item) => {
    const observation = record(item);
    const localId = requiredText(observation?.id);
    const revision = safeRevision(observation?.revision);
    if (localId === undefined || (observation?.status === 'pass' && (revision === undefined || expectedRevision === undefined))) {
      return check('live_evidence.invalid_input', 'live_evidence', 'fail', 'observed', 'unknown', scope);
    }
    return observation?.status === 'pass' && revision !== expectedRevision
      ? check(`live_evidence.${localId}`, 'live_evidence', 'fail', 'observed', 'unknown', scope)
      : observedCheck(`live_evidence.${localId}`, 'live_evidence', observation, scope);
  });
}

/**
 * Evaluates only caller-supplied facts. This function performs no I/O, starts
 * no providers, and returns no approvals, commands, paths, prompts, or secrets.
 */
export function evaluatePreflight(value: unknown): PreflightResult {
  const input = record(value);
  const target = targetFrom(input?.target);
  const scope = redactedScope(target);
  const checks: PreflightCheck[] = [];
  if (input === undefined || input.format !== 'faktori.preflight/v1' || target === undefined) {
    checks.push(check('configuration.contract', 'configuration', 'fail', 'configuration', 'not_applicable', scope));
  }
  let resolved: ResolvedFactoryConfiguration | undefined;
  if (input !== undefined) {
    try {
      resolved = resolveFactoryConfig(input.configuration as FactoryConfiguration);
      checks.push(check('configuration.valid', 'configuration', 'pass', 'configuration', 'not_applicable', scope));
    } catch (error) {
      // ConfigValidationError details can contain caller strings; never emit them.
      void (error instanceof ConfigValidationError);
      checks.push(check('configuration.valid', 'configuration', 'fail', 'configuration', 'not_applicable', scope));
    }
  } else {
    checks.push(check('configuration.valid', 'configuration', 'fail', 'configuration', 'not_applicable', scope));
  }
  if (resolved !== undefined && target !== undefined) {
    checks.push(configuredTarget(resolved, target) === undefined
      ? check('configuration.target', 'configuration', 'fail', 'configuration', 'not_applicable', scope)
      : check('configuration.target', 'configuration', 'pass', 'configuration', 'not_applicable', scope));
  } else {
    checks.push(check('configuration.target', 'configuration', 'fail', 'configuration', 'not_applicable', scope));
  }
  if (input !== undefined && resolved !== undefined && target !== undefined) checks.push(...providerChecks(input, resolved, target, scope));
  else checks.push(check('provider.observed', 'provider', 'not_tested', 'not_observed', 'unknown', scope));
  checks.push(check('console.installed_projection', 'console', 'not_tested', 'not_observed', 'unknown', scope, 'Run preflight against the owner-controlled local Console configuration so the existing projection can be inspected read-only.'));
  for (const section of SECTIONS) checks.push(...sectionChecks(section, input?.[section], scope));
  checks.push(...liveEvidenceChecks(input?.liveEvidence, input?.expectedRevision, scope));
  const summary: Record<PreflightCheckStatus, number> = { pass: 0, fail: 0, unavailable: 0, not_tested: 0 };
  for (const item of checks) summary[item.status] += 1;
  const executionReady = checks.length > 0 && checks.every((item) => item.status === 'pass');
  const liveChecks = checks.filter((item) => item.section === 'live_evidence');
  const liveExecutionVerified = liveChecks.length > 0 && liveChecks.every((item) => item.status === 'pass');
  const projectionRelevant = checks.filter((item) => item.section === 'configuration' || item.section === 'console');
  const projectionReady = projectionRelevant.length > 0 && projectionRelevant.every((item) => item.status === 'pass');
  const status = checks.some((item) => item.status === 'fail' || item.status === 'unavailable')
    ? 'blocked'
    : checks.some((item) => item.status === 'not_tested') ? 'partial' : 'ready';
  return { format: 'faktori.preflight-result/v1', scope, checks, summary, status, executionReady, liveExecutionVerified, projectionReady };
}
