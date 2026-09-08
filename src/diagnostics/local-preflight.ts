import { isAbsolute } from 'node:path';

import { inspectProjectionReadOnly } from '../runtime/sqlite-projection.ts';
import { evaluatePreflight, type PreflightCheck, type PreflightCheckStatus, type PreflightResult } from './preflight.ts';

type InputRecord = Record<string, unknown>;

function record(value: unknown): InputRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as InputRecord : undefined;
}

/**
 * Binds pure preflight checks to one actual local SQLite projection. The file
 * is opened read-only with fileMustExist; this function never creates, repairs,
 * truncates, launches, installs, authenticates, or reaches the network.
 */
export function evaluateInstalledPreflight(value: unknown, installationValue: unknown): PreflightResult {
  const installation = record(installationValue);
  const factoryId = typeof installation?.factoryId === 'string' ? installation.factoryId : 'unresolved';
  const projectionPath = typeof installation?.projectionPath === 'string' && isAbsolute(installation.projectionPath)
    ? installation.projectionPath
    : undefined;
  const result = evaluatePreflight(value);
  const inspection = projectionPath === undefined ? 'invalid' : inspectProjectionReadOnly(projectionPath, factoryId);
  let replacement: PreflightCheck;
  if (factoryId === 'unresolved' || factoryId !== result.scope.factoryId) {
    replacement = { id: 'console.installed_projection', section: 'console', status: 'fail', basis: 'observed', freshness: 'not_applicable', scope: result.scope, remediation: 'Select a local Console configuration whose factory matches the requested target, then rerun preflight.' };
  } else if (inspection === 'ready') {
    replacement = { id: 'console.installed_projection', section: 'console', status: 'pass', basis: 'observed', freshness: 'current', scope: result.scope, remediation: 'No action required.' };
  } else if (inspection === 'missing') {
    replacement = { id: 'console.installed_projection', section: 'console', status: 'fail', basis: 'observed', freshness: 'not_applicable', scope: result.scope, remediation: 'Create the local SQLite projection from the authoritative journal with faktori runtime rebuild, then rerun preflight.' };
  } else {
    replacement = { id: 'console.installed_projection', section: 'console', status: 'fail', basis: 'observed', freshness: 'not_applicable', scope: result.scope, remediation: 'Rebuild the invalid local SQLite projection from the authoritative journal with faktori runtime rebuild, then rerun preflight.' };
  }
  const checks = result.checks.map((item) => item.id === 'console.installed_projection' ? replacement : item);
  const summary: Record<PreflightCheckStatus, number> = { pass: 0, fail: 0, unavailable: 0, not_tested: 0 };
  for (const item of checks) summary[item.status] += 1;
  const projectionRelevant = checks.filter((item) => item.section === 'configuration' || item.section === 'console');
  const projectionReady = projectionRelevant.length > 0 && projectionRelevant.every((item) => item.status === 'pass');
  const status = checks.some((item) => item.status === 'fail' || item.status === 'unavailable')
    ? 'blocked'
    : checks.some((item) => item.status === 'not_tested') ? 'partial' : 'ready';
  return { ...result, checks, summary, status, projectionReady };
}

/** CLI envelope: diagnostics plus a local path used only by the read-only inspector. */
export function evaluateInstalledPreflightDocument(value: unknown): PreflightResult {
  const input = record(value);
  if (input?.format !== 'faktori.preflight-installation/v1') return evaluatePreflight(value);
  return evaluateInstalledPreflight(input.request, input.installation);
}
