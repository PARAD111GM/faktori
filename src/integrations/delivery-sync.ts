import type { ActionAdmissionResult, ControllerActionAdmission } from '../actions/index.ts';
import type { CommitEvidence } from './progression.ts';
import { evaluateCommitProgression } from './progression.ts';
import type { JiraHttpClient, JiraTransition } from './jira.ts';

/**
 * Controller-side recovery planner. It observes delivery state and prepares
 * deterministic next steps; it neither talks to GitHub nor performs a Jira
 * write. A caller that wants to execute a proposed transition must provide a
 * signed action to ControllerActionAdmission.
 */

export type DeliveryDependencyState = 'resolved' | 'unresolved' | 'unknown';
export type DeliveryWorkState = 'idle' | 'coding' | 'review';

export interface RegisteredDeliveryTicket {
  key: string;
  status: string;
  rank: number;
  workState: DeliveryWorkState;
  dependencies: readonly { key: string; state: DeliveryDependencyState }[];
}

export interface RegisteredDeliveryRepository {
  repository: string;
  branch: string;
  registered: boolean;
}

export interface RegisteredDeliveryPullRequest {
  repository: string;
  number: number;
  /** Immutable PR head observed from GitHub, not a branch name. */
  headCommit: string;
  /** Author is deliberately absent: eligibility never depends on who opened it. */
  evidence: readonly CommitEvidence[];
  merged: boolean;
  mergeCommit?: string;
  deployment?: { revision: string; verified: boolean };
  /** Separate product/staging acceptance, explicitly bound to the merge revision. */
  stagingAcceptance?: { revision: string; verified: boolean };
}

export interface RegisteredDelivery {
  ticket: RegisteredDeliveryTicket;
  repository: RegisteredDeliveryRepository;
  /** Legacy convenience for one observed PR. Multiple identities must be explicit below. */
  pullRequest?: RegisteredDeliveryPullRequest;
  /** Zero or one registered PR identity is admissible for a ticket. */
  pullRequests?: readonly RegisteredDeliveryPullRequest[];
}

/** IDs are read from Jira at run time, never embedded in delivery policy. */
export interface DiscoveredJiraTransition extends JiraTransition {
  name: string;
}

export interface DeliverySyncPolicy {
  /** Only tickets in these owner-configured statuses may consume a coding slot. */
  eligibleCodingStatuses: readonly string[];
  /** Jira states owned by a human workflow must remain untouched. */
  protectedStatuses: readonly string[];
  /** Target *names*, matched to live transition discovery. IDs are never configured here. */
  readyForDeploymentStatus?: string;
  /** Deployment evidence can reach only this configured operational state. */
  deployedStatus?: string;
  /** Requires separate merge-revision-bound staging acceptance evidence. */
  acceptedStatus?: string;
  requiredCheckSources?: readonly string[];
  maxConcurrentCoding: number;
}

export type DeliverySyncInstruction =
  | { id: string; kind: 'start_coding'; ticketKey: string; repository: string; reason: 'eligible_before_capacity' }
  | { id: string; kind: 'transition'; ticketKey: string; repository: string; fromStatus: string; toStatus: string; transitionId: string; reason: 'exact_head_ready_for_human_merge' | 'merge_and_deployment_verified' | 'merge_deployment_and_staging_accepted' }
  | { id: string; kind: 'observe'; ticketKey: string; repository: string; reason: string }
  | { id: string; kind: 'blocked'; ticketKey: string; repository: string; reason: string };

export interface DeliverySyncPlan {
  format: 'faktori.delivery-sync-plan/v1';
  coding: { active: number; capacity: number; eligibleBeforeCapacity: readonly string[]; selected: readonly string[] };
  instructions: readonly DeliverySyncInstruction[];
}

function nonEmpty(value: string): boolean { return value.trim().length > 0; }
function stableId(ticketKey: string, kind: string, suffix = ''): string { return `delivery-sync:${ticketKey}:${kind}${suffix.length === 0 ? '' : `:${suffix}`}`; }
function transitionFor(targetStatus: string | undefined, transitions: readonly DiscoveredJiraTransition[]): DiscoveredJiraTransition | undefined {
  if (targetStatus === undefined || !nonEmpty(targetStatus)) return undefined;
  // Jira's human-facing transition label often differs from its destination
  // status (for example, "Complete work" -> "Done"). The discovered target
  // status is the stable workflow fact used by the planner.
  return transitions.find((candidate) => candidate.targetStatus === targetStatus);
}

function hasUnresolvedDependency(ticket: RegisteredDeliveryTicket): boolean {
  // An absent observation is not evidence of resolution.
  return ticket.dependencies.some((dependency) => dependency.state !== 'resolved');
}

function validRegistration(entry: RegisteredDelivery): string | undefined {
  if (!nonEmpty(entry.ticket.key) || !nonEmpty(entry.repository.repository) || !nonEmpty(entry.repository.branch)) return 'registered_identity_invalid';
  if (!entry.repository.registered) return 'repository_not_registered';
  const pullRequests = observedPullRequests(entry);
  if (pullRequests.length > 1) return 'pull_request_identity_ambiguous';
  if (pullRequests[0] !== undefined && pullRequests[0].repository !== entry.repository.repository) return 'pull_request_repository_identity_mismatch';
  return undefined;
}

function observedPullRequests(entry: RegisteredDelivery): readonly RegisteredDeliveryPullRequest[] {
  return [...(entry.pullRequest === undefined ? [] : [entry.pullRequest]), ...(entry.pullRequests ?? [])];
}

/**
 * Build an ordered plan from registered identities and observations. Candidate
 * eligibility is calculated completely before capacity is applied, so a
 * blocked earlier ticket never consumes a slot. Existing review work is not
 * coding capacity and cannot prevent an eligible ticket from starting.
 */
export function planDeliverySynchronization(input: {
  deliveries: readonly RegisteredDelivery[];
  /** Transitions are discovered per issue; a ticket cannot borrow another ticket's ID. */
  transitionsByTicket: Readonly<Record<string, readonly DiscoveredJiraTransition[] | undefined>>;
  policy: DeliverySyncPolicy;
}): DeliverySyncPlan {
  if (!Number.isInteger(input.policy.maxConcurrentCoding) || input.policy.maxConcurrentCoding < 0) throw new Error('maxConcurrentCoding must be a non-negative integer');
  const sorted = [...input.deliveries].sort((left, right) => left.ticket.rank - right.ticket.rank || left.ticket.key.localeCompare(right.ticket.key));
  const activeCoding = sorted.filter((entry) => entry.ticket.workState === 'coding').length;
  const instructions: DeliverySyncInstruction[] = [];
  const candidates: RegisteredDelivery[] = [];
  const ticketCounts = new Map<string, number>();
  for (const entry of sorted) ticketCounts.set(entry.ticket.key, (ticketCounts.get(entry.ticket.key) ?? 0) + 1);

  for (const entry of sorted) {
    const { ticket, repository } = entry;
    const pullRequest = observedPullRequests(entry)[0];
    if ((ticketCounts.get(ticket.key) ?? 0) !== 1) {
      instructions.push({ id: stableId(ticket.key, 'blocked'), kind: 'blocked', ticketKey: ticket.key, repository: repository.repository, reason: 'ticket_identity_ambiguous' });
      continue;
    }
    const identityProblem = validRegistration(entry);
    if (identityProblem !== undefined) {
      instructions.push({ id: stableId(ticket.key, 'blocked'), kind: 'blocked', ticketKey: ticket.key, repository: repository.repository, reason: identityProblem });
      continue;
    }
    if (input.policy.protectedStatuses.includes(ticket.status)) {
      instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: 'protected_human_status' });
      continue;
    }
    if (pullRequest !== undefined) {
      if (!nonEmpty(pullRequest.headCommit)) {
        instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: 'pull_request_head_unknown' });
        continue;
      }
      if (!pullRequest.merged) {
        const progression = evaluateCommitProgression(pullRequest.headCommit, pullRequest.evidence, { requiredCheckSources: input.policy.requiredCheckSources });
        if (progression.state !== 'ready_for_human_merge') {
          instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: `exact_head_${progression.state}` });
          continue;
        }
        const transition = transitionFor(input.policy.readyForDeploymentStatus, input.transitionsByTicket[ticket.key] ?? []);
        if (transition === undefined) {
          instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: 'ready_for_deployment_transition_unknown' });
        } else if (ticket.status !== transition.targetStatus) {
          instructions.push({ id: stableId(ticket.key, 'transition', transition.id), kind: 'transition', ticketKey: ticket.key, repository: repository.repository, fromStatus: ticket.status, toStatus: transition.targetStatus, transitionId: transition.id, reason: 'exact_head_ready_for_human_merge' });
        }
        continue;
      }
      if (pullRequest.mergeCommit === undefined || !nonEmpty(pullRequest.mergeCommit)) {
        instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: 'merge_sha_unknown' });
        continue;
      }
      if (pullRequest.deployment === undefined || !pullRequest.deployment.verified || pullRequest.deployment.revision !== pullRequest.mergeCommit) {
        instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: 'verified_merge_deployment_unknown' });
        continue;
      }
      const transitions = input.transitionsByTicket[ticket.key] ?? [];
      const accepted = transitionFor(input.policy.acceptedStatus, transitions);
      if (accepted !== undefined && pullRequest.stagingAcceptance?.verified === true && pullRequest.stagingAcceptance.revision === pullRequest.mergeCommit) {
        if (ticket.status !== accepted.targetStatus) instructions.push({ id: stableId(ticket.key, 'transition', accepted.id), kind: 'transition', ticketKey: ticket.key, repository: repository.repository, fromStatus: ticket.status, toStatus: accepted.targetStatus, transitionId: accepted.id, reason: 'merge_deployment_and_staging_accepted' });
        continue;
      }
      const deployed = transitionFor(input.policy.deployedStatus, transitions);
      if (deployed === undefined) {
        instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: 'deployed_transition_unknown' });
      } else if (ticket.status !== deployed.targetStatus) {
        instructions.push({ id: stableId(ticket.key, 'transition', deployed.id), kind: 'transition', ticketKey: ticket.key, repository: repository.repository, fromStatus: ticket.status, toStatus: deployed.targetStatus, transitionId: deployed.id, reason: 'merge_and_deployment_verified' });
      } else if (input.policy.acceptedStatus !== undefined && (pullRequest.stagingAcceptance?.verified !== true || pullRequest.stagingAcceptance.revision !== pullRequest.mergeCommit)) {
        instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: 'merge_revision_bound_staging_acceptance_unknown' });
      }
      continue;
    }
    if (ticket.workState === 'coding') {
      instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: 'coding_already_active' });
      continue;
    }
    if (ticket.workState === 'review') {
      instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: 'review_waiting_for_pull_request_observation' });
      continue;
    }
    if (!input.policy.eligibleCodingStatuses.includes(ticket.status)) {
      instructions.push({ id: stableId(ticket.key, 'observe'), kind: 'observe', ticketKey: ticket.key, repository: repository.repository, reason: 'ticket_status_not_eligible_for_coding' });
      continue;
    }
    if (hasUnresolvedDependency(ticket)) {
      instructions.push({ id: stableId(ticket.key, 'blocked'), kind: 'blocked', ticketKey: ticket.key, repository: repository.repository, reason: 'dependency_unresolved_or_unknown' });
      continue;
    }
    candidates.push(entry);
  }

  const freeSlots = Math.max(0, input.policy.maxConcurrentCoding - activeCoding);
  for (const entry of candidates.slice(0, freeSlots)) {
    instructions.push({ id: stableId(entry.ticket.key, 'start'), kind: 'start_coding', ticketKey: entry.ticket.key, repository: entry.repository.repository, reason: 'eligible_before_capacity' });
  }
  return {
    format: 'faktori.delivery-sync-plan/v1',
    coding: { active: activeCoding, capacity: input.policy.maxConcurrentCoding, eligibleBeforeCapacity: candidates.map((entry) => entry.ticket.key), selected: candidates.slice(0, freeSlots).map((entry) => entry.ticket.key) },
    instructions,
  };
}

export interface SignedDeliveryTransition {
  instructionId: string;
  /** Must be a signed ActionRequest whose actionId is this exact instruction ID. */
  request: unknown;
}

export interface DeliveryTransitionExecution {
  instructionId: string;
  ticketKey: string;
  result: 'executed' | 'skipped';
  receipt?: ActionAdmissionResult['receipt'];
  reason?: string;
}

function actionBindingMatches(instruction: Extract<DeliverySyncInstruction, { kind: 'transition' }>, request: unknown): boolean {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return false;
  const item = request as Record<string, unknown>;
  const scope = item.scope;
  return item.actionId === instruction.id && scope !== null && typeof scope === 'object' && !Array.isArray(scope)
    && (scope as Record<string, unknown>).allowedOperation === 'jira.issue.transition';
}

/**
 * The executor intentionally accepts only signed requests and routes each
 * through existing action admission. It has no `authorized` boolean and no
 * direct Jira client, so it cannot bypass durable intent, current authority,
 * idempotency, or the controller's sealed Jira operation resolver.
 */
export async function executePlannedDeliveryTransitions(plan: DeliverySyncPlan, bindings: readonly SignedDeliveryTransition[], admission: Pick<ControllerActionAdmission, 'admit'>): Promise<DeliveryTransitionExecution[]> {
  const byInstruction = new Map<string, SignedDeliveryTransition[]>();
  for (const binding of bindings) byInstruction.set(binding.instructionId, [...(byInstruction.get(binding.instructionId) ?? []), binding]);
  const results: DeliveryTransitionExecution[] = [];
  for (const instruction of plan.instructions) {
    if (instruction.kind !== 'transition') continue;
    const matched = byInstruction.get(instruction.id) ?? [];
    if (matched.length !== 1 || !actionBindingMatches(instruction, matched[0].request)) {
      results.push({ instructionId: instruction.id, ticketKey: instruction.ticketKey, result: 'skipped', reason: matched.length === 0 ? 'signed_action_missing' : 'signed_action_binding_invalid_or_ambiguous' });
      continue;
    }
    const admitted = await admission.admit(matched[0].request);
    results.push({ instructionId: instruction.id, ticketKey: instruction.ticketKey, result: admitted.accepted ? 'executed' : 'skipped', receipt: admitted.receipt, ...(admitted.accepted ? {} : { reason: admitted.reason ?? 'action_not_admitted' }) });
  }
  return results;
}

export interface JiraSprintIssue {
  key: string;
  rank: number;
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done' | 'unknown';
  /** Raw dependency-link identities; direction remains caller-configured. */
  dependencyLinks: readonly { type: string; inwardIssueKey?: string; outwardIssueKey?: string }[];
}

export type JiraSprintRead =
  | { state: 'available'; sprintId: string; issues: readonly JiraSprintIssue[] }
  | { state: 'unknown'; reason: string };

const JIRA_NUMBER = /^[1-9][0-9]{0,17}$/;
const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]*$/;
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim().length > 0 ? value : undefined; }
function numberId(value: unknown): string | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && JIRA_NUMBER.test(value) ? value : undefined; }

/** Bounded read-only adapter for rank-ordered active sprint observation. */
export class JiraActiveSprintReadAdapter {
  readonly #client: JiraHttpClient;
  constructor(client: JiraHttpClient) { this.#client = client; }

  async read(boardId: string): Promise<JiraSprintRead> {
    if (!JIRA_NUMBER.test(boardId)) throw new Error('Jira board ID must be a positive bounded integer');
    const active = await this.#client.request({ method: 'GET', path: `/rest/agile/1.0/board/${boardId}/sprint?state=active&maxResults=50`, headers: { Accept: 'application/json' } });
    if (active.status !== 200) return { state: 'unknown', reason: `active_sprint_unavailable_http_${active.status}` };
    const values = object(active.body)?.values;
    if (!Array.isArray(values)) return { state: 'unknown', reason: 'active_sprint_response_unknown' };
    const ids = values.map((item) => numberId(object(item)?.id)).filter((item): item is string => item !== undefined);
    if (ids.length !== 1 || values.length !== 1) return { state: 'unknown', reason: ids.length === 0 ? 'active_sprint_missing' : 'active_sprint_ambiguous' };
    const issues: JiraSprintIssue[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 10; page += 1) {
      const response = await this.#client.request({ method: 'GET', path: `/rest/agile/1.0/sprint/${ids[0]}/issue?fields=status,issuelinks&maxResults=100&startAt=${page * 100}`, headers: { Accept: 'application/json' } });
      if (response.status !== 200) return { state: 'unknown', reason: `sprint_issues_unavailable_http_${response.status}` };
      const body = object(response.body);
      const pageIssues = body?.issues;
      const total = body?.total;
      if (!Array.isArray(pageIssues) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total > 1_000 || pageIssues.length > 100) return { state: 'unknown', reason: 'sprint_issues_response_unknown' };
      for (const item of pageIssues) {
        const parsed = sprintIssue(item, issues.length + 1);
        if (parsed === undefined || seen.has(parsed.key)) return { state: 'unknown', reason: 'sprint_issue_identity_unknown' };
        seen.add(parsed.key);
        issues.push(parsed);
      }
      if (issues.length >= total) return { state: 'available', sprintId: ids[0], issues };
      if (pageIssues.length === 0) return { state: 'unknown', reason: 'sprint_issues_pagination_unknown' };
    }
    return { state: 'unknown', reason: 'sprint_issues_bounded_limit_reached' };
  }

  async transitions(issueKey: string): Promise<readonly DiscoveredJiraTransition[] | undefined> {
    if (!JIRA_KEY.test(issueKey)) throw new Error('Jira issue key must be a bounded key');
    const response = await this.#client.request({ method: 'GET', path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, headers: { Accept: 'application/json' } });
    if (response.status !== 200) return undefined;
    const transitions = object(response.body)?.transitions;
    if (!Array.isArray(transitions)) return undefined;
    const found: DiscoveredJiraTransition[] = [];
    for (const item of transitions) {
      const record = object(item);
      const id = string(record?.id);
      const name = string(record?.name);
      const targetStatus = string(object(record?.to)?.name);
      if (id === undefined || name === undefined || targetStatus === undefined) return undefined;
      found.push({ id, name, targetStatus });
    }
    return found;
  }
}

function sprintIssue(value: unknown, rank: number): JiraSprintIssue | undefined {
  const item = object(value);
  const key = string(item?.key);
  const fields = object(item?.fields);
  const status = string(object(fields?.status)?.name);
  const category = string(object(object(fields?.status)?.statusCategory)?.key);
  const rawLinks = fields?.issuelinks;
  if (key === undefined || !JIRA_KEY.test(key) || status === undefined || !Array.isArray(rawLinks)) return undefined;
  const dependencyLinks: { type: string; inwardIssueKey?: string; outwardIssueKey?: string }[] = [];
  for (const raw of rawLinks) {
    const link = object(raw);
    const type = string(object(link?.type)?.name);
    const inwardIssueKey = string(object(link?.inwardIssue)?.key);
    const outwardIssueKey = string(object(link?.outwardIssue)?.key);
    if (type === undefined || (inwardIssueKey === undefined && outwardIssueKey === undefined)
      || (inwardIssueKey !== undefined && !JIRA_KEY.test(inwardIssueKey)) || (outwardIssueKey !== undefined && !JIRA_KEY.test(outwardIssueKey))) return undefined;
    dependencyLinks.push({ type, ...(inwardIssueKey === undefined ? {} : { inwardIssueKey }), ...(outwardIssueKey === undefined ? {} : { outwardIssueKey }) });
  }
  return { key, rank, status, statusCategory: category === 'new' || category === 'indeterminate' || category === 'done' ? category : 'unknown', dependencyLinks };
}
