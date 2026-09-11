import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const SPRINT_CHECKS = ['intent', 'scope', 'ticket_reconciliation', 'dependencies', 'ready_queue',
  'shared_files', 'execution_environment', 'jira', 'github', 'slack', 'review_policy', 'merge_owner',
  'staging_access', 'foreman_goal', 'completion_transport', 'manager_wakeup', 'builder_goal', 'builder_artifacts'] as const;
type CheckId = typeof SPRINT_CHECKS[number];
export interface SprintAdmissionTarget { workItemId: string; threadId: string; managerThreadId?: string; }
export interface SprintReadinessReport {
  ready: boolean; mode: 'attended' | 'unattended' | 'unconfigured'; sprintId?: string; revision?: string;
  blockers: Array<{ id: string; owner: string; problem: string; nextAction: string }>;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 1024; }
function stamp(value: unknown): number { return typeof value === 'string' ? Date.parse(value) : NaN; }
const LABELS: Record<CheckId, string> = {
  intent: 'Approved project intent', scope: 'Bounded sprint outcome and acceptance', ticket_reconciliation: 'Reconciled sprint tickets',
  dependencies: 'Verified dependencies', ready_queue: 'Eligible replacement work', shared_files: 'Shared-file ownership',
  execution_environment: 'Executable tools and environment', jira: 'Ticket management capability', github: 'Repository and PR capability',
  slack: 'Notification delivery capability', review_policy: 'Substantive reviewer and approved policy', merge_owner: 'Merge authority',
  staging_access: 'Staging verification access', foreman_goal: 'Active Foreman native goal', completion_transport: 'Verified completion transport',
  manager_wakeup: 'Verified idle-Foreman wake-up', builder_goal: 'Active builder native goal', builder_artifacts: 'Builder artifact-read receipt',
};

/** Consumes controller-owned observations, never a browser approval or worker self-report.
 * This evaluator verifies correlation/freshness, not the authenticity of an external platform.
 * Producers must retain the referenced observation; a source label alone is not platform proof.
 */
export function evaluateSprintReadiness(value: unknown, target?: SprintAdmissionTarget, now = new Date()): SprintReadinessReport {
  const input = record(value);
  const blockers: SprintReadinessReport['blockers'] = [];
  const blocked = (id: string, problem: string, owner = 'Foreman') => blockers.push({ id, owner, problem,
    nextAction: `Verify ${LABELS[id as CheckId] ?? id}, record current evidence for the approved sprint revision, then retry admission.` });
  if (!input || input.format !== 'faktori.sprint-readiness/v1' || !text(input.sprintId) || !text(input.revision)
    || !text(input.managerThreadId) || !Array.isArray(input.checks) || input.checks.length > 1000
    || !Array.isArray(input.targets) || input.targets.length > 1000 || !['attended', 'unattended'].includes(String(input.mode))) {
    blocked('configuration', 'Sprint readiness is missing or invalid. Configure the controller-owned readiness record.');
    return { ready: false, mode: 'unconfigured', blockers };
  }
  const mode = input.mode as 'attended' | 'unattended';
  if (target?.managerThreadId !== undefined && input.managerThreadId !== target.managerThreadId)
    blocked('foreman_goal', 'The readiness record belongs to a different Foreman task.');
  if (!Number.isFinite(now.getTime())) blocked('clock', 'Readiness clock is unavailable.');
  if (target && input.targets.filter(v => { const t = record(v); return t?.workItemId === target.workItemId && t.threadId === target.threadId; }).length !== 1)
    blocked('assignment', 'This ticket and task are not uniquely registered for the sprint.');
  for (const id of SPRINT_CHECKS) {
    if (id === 'manager_wakeup' && mode === 'attended') continue;
    if (id.startsWith('builder_') && !target) continue;
    const matches = input.checks.map(record).filter(c => c?.id === id && (!id.startsWith('builder_')
      || (c.workItemId === target?.workItemId && c.threadId === target?.threadId)));
    const c = matches[0];
    const valid = matches.length === 1 && c && c.state === 'passed' && c.revision === input.revision
      && text(c.owner) && text(c.evidence) && ['controller', 'platform', 'owner_decision'].includes(String(c.source))
      && stamp(c.observedAt) <= now.getTime() && stamp(c.validUntil) > now.getTime();
    const goalValid = !id.endsWith('_goal') || (c?.source === 'platform'
      && c.threadId === (id === 'foreman_goal' ? input.managerThreadId : target?.threadId));
    if (!valid || !goalValid) blocked(id, `${LABELS[id]} has no unique, current passing observation.`, text(c?.owner) ? c.owner : 'Foreman');
  }
  if (!target) {
    if (input.targets.length === 0) blocked('assignment', 'No builder assignments are registered for this sprint.');
    for (const value of input.targets) {
      const t = record(value);
      if (!t || !text(t.workItemId) || !text(t.threadId)) { blocked('assignment', 'A builder assignment is invalid.'); continue; }
      const result = evaluateSprintReadiness(input, { workItemId: t.workItemId, threadId: t.threadId }, now);
      for (const b of result.blockers.filter(b => b.id.startsWith('builder_') || b.id === 'assignment')) {
        if (!blockers.some(existing => existing.id === b.id)) blockers.push(b);
      }
    }
  }
  return { ready: blockers.length === 0, mode, sprintId: input.sprintId, revision: input.revision, blockers };
}

/** Private local file is a controller configuration boundary, not an upload API. */
export async function readSprintReadiness(path: string, target?: SprintAdmissionTarget): Promise<SprintReadinessReport> {
  if (!isAbsolute(path)) throw new Error('Sprint readiness path must be absolute');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Sprint readiness requires a private owner-owned bounded file');
    const input = JSON.parse(await handle.readFile('utf8')) as unknown;
    const report = evaluateSprintReadiness(input, target);
    const bindings = record(input)?.artifactBindings;
    let artifactsMatch = Array.isArray(bindings) && bindings.length > 0 && bindings.length <= 100;
    if (artifactsMatch) {
      for (const binding of bindings as unknown[]) {
        const item = record(binding);
        if (!item || !text(item.path) || !isAbsolute(item.path) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) { artifactsMatch = false; break; }
        let artifact;
        try {
          artifact = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await artifact.stat();
          if (!stat.isFile() || stat.size > 1024 * 1024 || createHash('sha256').update(await artifact.readFile()).digest('hex') !== item.sha256) artifactsMatch = false;
        } catch { artifactsMatch = false; }
        finally { await artifact?.close(); }
        if (!artifactsMatch) break;
      }
    }
    if (!artifactsMatch) {
      report.ready = false;
      report.blockers.push({ id: 'artifact_revisions', owner: 'Foreman', problem: 'Required project files are missing or differ from the admitted artifact revisions.',
        nextAction: 'Restore the approved files, or review their changes and issue fresh revision-bound readiness and builder-read evidence.' });
    }
    return report;
  } finally { await handle.close(); }
}

export async function requireSprintReadiness(path: string, target: SprintAdmissionTarget): Promise<void> {
  const report = await readSprintReadiness(path, target);
  if (!report.ready) throw new Error(`Sprint admission blocked: ${report.blockers.map(b => b.problem).join(' ')}`);
}
