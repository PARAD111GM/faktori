import { createHash } from 'node:crypto';

type RecordValue = Record<string, unknown>;

export interface WitnessedDeliveryRequest {
  id: string;
  status: string;
  completedAt?: string;
  report?: { delivery?: string; productAcceptance?: string };
}

export interface WitnessedDeliveryBlocker {
  id: string;
  owner: 'Foreman' | 'Owner';
  problem: string;
  nextAction: string;
}

export interface WitnessedDeliveryReport {
  ready: boolean;
  /** The digest excludes the witness itself so a retained receipt can bind its configuration without a hash cycle. */
  configurationDigest?: string;
  validUntil?: string;
  blockers: WitnessedDeliveryBlocker[];
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function text(value: unknown, max = 1024): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function timestamp(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const input = value as RecordValue;
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stable(input[key])}`).join(',')}}`;
}

/**
 * The witness lives in the controller-owned readiness record. Excluding it
 * gives producers one deterministic digest over the admission configuration,
 * including revision and artifact bindings, without a self-referential hash.
 */
export function witnessedDeliveryConfigurationDigest(readiness: unknown): string | undefined {
  const input = record(readiness);
  if (!input) return undefined;
  const { witnessedDelivery: _witnessedDelivery, ...configuration } = input;
  return createHash('sha256').update(stable(configuration)).digest('hex');
}

function blocker(id: string, owner: WitnessedDeliveryBlocker['owner'], problem: string, nextAction: string): WitnessedDeliveryBlocker {
  return { id, owner, problem, nextAction };
}

/**
 * Provider-neutral unattended-dispatch admission. A Manager completion merely
 * proves callback delivery; independent candidate, runtime, and
 * delivery-or-staging observations plus an owner acceptance are still needed.
 * This function reads no provider and grants no capability.
 */
export function evaluateWitnessedDelivery(readiness: unknown, requests: readonly WitnessedDeliveryRequest[], catalogRevision: string, now = new Date()): WitnessedDeliveryReport {
  const input = record(readiness);
  const configurationDigest = witnessedDeliveryConfigurationDigest(readiness);
  if (!input || input.mode !== 'unattended') return { ready: true, ...(configurationDigest ? { configurationDigest } : {}), blockers: [] };
  if (!Number.isFinite(now.getTime())) return { ready: false, ...(configurationDigest ? { configurationDigest } : {}), blockers: [blocker('witness_clock_unavailable', 'Foreman', 'The witnessed delivery clock is unavailable.', 'Restore a valid controller clock before evaluating unattended admission.')] };
  const blockers: WitnessedDeliveryBlocker[] = [];
  const witness = record(input.witnessedDelivery);
  if (!witness) return { ready: false, ...(configurationDigest ? { configurationDigest } : {}), blockers: [blocker('witness_missing', 'Foreman', 'Unattended graph dispatch has no witnessed delivery record.', 'Complete and retain a witnessed journey, then record its revision-bound evidence and owner acceptance.')] };
  const fail = (id: string, owner: WitnessedDeliveryBlocker['owner'], problem: string, nextAction: string) => blockers.push(blocker(id, owner, problem, nextAction));
  if (witness.format !== 'faktori.witnessed-delivery/v1' || !text(witness.sprintRevision, 256)
    || !text(witness.catalogRevision, 128) || !text(witness.configurationDigest, 64) || !/^[a-f0-9]{64}$/.test(witness.configurationDigest)
    || !record(witness.journey) || !record(witness.ownerAcceptance) || !Array.isArray(witness.validations)
    || witness.validations.length === 0 || witness.validations.length > 32 || !text(witness.validUntil, 64)) {
    fail('witness_invalid', 'Foreman', 'The witnessed delivery record is malformed.', 'Replace it with the current faktori.witnessed-delivery/v1 record; do not override this admission gate.');
    return { ready: false, ...(configurationDigest ? { configurationDigest } : {}), blockers };
  }
  if (witness.sprintRevision !== input.revision || witness.catalogRevision !== catalogRevision || witness.configurationDigest !== configurationDigest) {
    fail('witness_configuration_mismatch', 'Foreman', 'The witnessed journey is not bound to this sprint revision, catalog revision, and readiness configuration.', 'Re-run or re-attest the witnessed journey against the current admitted configuration.');
  }
  const validUntil = timestamp(witness.validUntil);
  if (!Number.isFinite(validUntil) || validUntil <= now.getTime()) {
    fail('witness_stale', 'Foreman', 'The witnessed delivery evidence is expired or has no valid deadline.', 'Collect a fresh completed witnessed journey and current owner acceptance.');
  }
  const journey = witness.journey as RecordValue;
  if (!text(journey.requestId, 256) || !['completed', 'failed', 'unknown'].includes(String(journey.state)) || !text(journey.completedAt, 64)
    || !Number.isFinite(timestamp(journey.completedAt)) || timestamp(journey.completedAt) > now.getTime()) {
    fail('witness_journey_invalid', 'Foreman', 'The witnessed journey does not identify a completed retained request.', 'Record the durable Manager-Connected request ID and its exact completion time.');
  } else if (journey.state !== 'completed') {
    fail(`witness_journey_${String(journey.state)}`, 'Foreman', `The witnessed journey is ${String(journey.state)}, not completed.`, 'Resolve the journey to a verified completed state; failed or unknown journeys never authorize unattended dispatch.');
  } else {
    const matches = requests.filter(request => request.id === journey.requestId);
    const request = matches[0];
    if (matches.length !== 1 || request?.status !== 'completed' || !Number.isFinite(timestamp(request?.completedAt)) || timestamp(request?.completedAt) > now.getTime() || request.completedAt !== journey.completedAt
      || request.report?.delivery !== 'reported') {
      fail('witness_completion_unverified', 'Foreman', 'The retained Manager-Connected request does not prove this witnessed completion.', 'Restore or reconcile the exact completed request and Manager report; a request ID alone is insufficient.');
    }
  }
  const validationKinds = new Map<string, RecordValue[]>();
  for (const item of witness.validations as unknown[]) {
    const validation = record(item);
    if (!validation || !text(validation.kind, 64) || !['passed', 'failed', 'unknown'].includes(String(validation.state))
      || !text(validation.evidence, 1024) || !text(validation.observedAt, 64) || !Number.isFinite(timestamp(validation.observedAt)) || timestamp(validation.observedAt) > now.getTime()) {
      fail('witness_validation_invalid', 'Foreman', 'A witnessed validation is malformed, future-dated, or lacks retained evidence.', 'Record bounded current evidence for each required validation.');
      continue;
    }
    const entries = validationKinds.get(validation.kind) ?? [];
    entries.push(validation); validationKinds.set(validation.kind, entries);
  }
  const requirePassed = (kind: string, label: string) => {
    const entries = validationKinds.get(kind) ?? [];
    if (entries.length !== 1) return fail(`witness_${kind}_missing`, 'Foreman', `The witnessed journey has no unique ${label} validation.`, `Retain one current ${label} result in the witnessed delivery record.`);
    if (entries[0].state !== 'passed') fail(`witness_${kind}_${String(entries[0].state)}`, 'Foreman', `The ${label} validation is ${String(entries[0].state)}.`, `Resolve the ${label} result to passed; failed or unknown evidence never authorizes unattended dispatch.`);
  };
  requirePassed('candidate', 'candidate verification');
  requirePassed('runtime', 'runtime verification');
  const delivery = validationKinds.get('delivery') ?? [];
  const staging = validationKinds.get('staging') ?? [];
  if (delivery.length === 0 && staging.length === 0) {
    fail('witness_delivery_or_staging_missing', 'Foreman', 'The witnessed journey has no delivery or staging acceptance validation.', 'Retain at least one current passed delivery or staging acceptance result; optional repository and tool evidence may be added separately.');
  }
  for (const [kind, entries] of [['delivery', delivery], ['staging', staging]] as const) {
    if (entries.length > 1) fail(`witness_${kind}_duplicate`, 'Foreman', `The witnessed journey has duplicate ${kind} acceptance validations.`, `Retain one current ${kind} acceptance result.`);
    else if (entries.length === 1 && entries[0].state !== 'passed') fail(`witness_${kind}_${String(entries[0].state)}`, 'Foreman', `The ${kind} acceptance validation is ${String(entries[0].state)}.`, `Resolve the ${kind} acceptance to passed before enabling unattended dispatch.`);
  }
  for (const [kind, entries] of validationKinds) {
    if (['candidate', 'runtime', 'delivery', 'staging'].includes(kind)) continue;
    const nonPassing = entries.find(entry => entry.state !== 'passed');
    if (nonPassing) {
      fail(`witness_${kind}_${String(nonPassing.state)}`, 'Foreman', `The configured ${kind} validation is ${String(nonPassing.state)}.`, `Resolve the configured ${kind} validation to passed or remove it from the witnessed delivery record.`);
    }
  }
  const ownerAcceptance = witness.ownerAcceptance as RecordValue;
  if (!['accepted', 'denied', 'unknown'].includes(String(ownerAcceptance.state)) || !text(ownerAcceptance.owner, 256)
    || !text(ownerAcceptance.evidence, 1024) || !text(ownerAcceptance.observedAt, 64) || !Number.isFinite(timestamp(ownerAcceptance.observedAt)) || timestamp(ownerAcceptance.observedAt) > now.getTime()) {
    fail('witness_owner_acceptance_invalid', 'Owner', 'Owner acceptance is missing, malformed, or future-dated.', 'Record a current explicit owner acceptance with retained evidence for this configuration.');
  } else if (ownerAcceptance.state !== 'accepted') {
    fail(`witness_owner_${String(ownerAcceptance.state)}`, 'Owner', `Owner acceptance is ${String(ownerAcceptance.state)}.`, 'Obtain an explicit accepted owner decision after reviewing the witnessed evidence; denied or unknown does not authorize dispatch.');
  }
  return { ready: blockers.length === 0, ...(configurationDigest ? { configurationDigest } : {}), ...(Number.isFinite(validUntil) ? { validUntil: new Date(validUntil).toISOString() } : {}), blockers };
}
