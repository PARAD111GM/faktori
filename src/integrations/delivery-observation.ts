import { inspectDeliveryConnections, parseDeliveryConnections, type DeliveryInspectDependencies, type DeliveryInspection } from './delivery-inspect.ts';
import type { RegisteredDelivery } from './delivery-sync.ts';

/**
 * Refresh registered delivery identities from Jira/GitHub, retaining only
 * controller-supplied review/deployment/acceptance evidence. This does not infer
 * independent review from a GitHub summary or product acceptance from a deploy.
 */
export async function observeDeliveryForSynchronization(
  connections: unknown,
  registrations: readonly RegisteredDelivery[],
  dependencies: DeliveryInspectDependencies = {},
) {
  const config = parseDeliveryConnections(connections);
  for (const registration of registrations) {
    const prs = [...(registration.pullRequest ? [registration.pullRequest] : []), ...(registration.pullRequests ?? [])];
    if (prs.length !== 1 || !config.connections.some(connection => connection.ticketKey === registration.ticket.key
      && connection.repository === registration.repository.repository && connection.repository === prs[0]!.repository
      && connection.pullRequest === prs[0]!.number)) throw new Error('delivery_observation_registration_mismatch');
  }
  return reconcileDeliveryInspection(await inspectDeliveryConnections(config, dependencies), registrations, new Date().toISOString());
}

/** A deterministic join; the inspection argument must come from the controller. */
export function reconcileDeliveryInspection(inspection: DeliveryInspection, registrations: readonly RegisteredDelivery[], observedAt: string) {
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('delivery_observation_time_invalid');
  const deliveries: RegisteredDelivery[] = [];
  const unavailable: Array<{ ticketKey: string; reason: string }> = [];
  const reject = (ticketKey: string, reason: string) => { unavailable.push({ ticketKey, reason }); };
  for (const registration of registrations) {
    const key = registration.ticket.key;
    if (registrations.filter(item => item.ticket.key === key).length !== 1) { reject(key, 'ticket_identity_ambiguous'); continue; }
    if (inspection.sprint.state !== 'available') { reject(key, 'sprint_observation_unavailable'); continue; }
    const tickets = inspection.sprint.issues.filter(item => item.key === key);
    if (tickets.length !== 1) { reject(key, 'ticket_not_in_observed_sprint'); continue; }
    const registeredPrs = [...(registration.pullRequest ? [registration.pullRequest] : []), ...(registration.pullRequests ?? [])];
    const observedPrs = inspection.pullRequests.filter(item => item.ticketKey === key);
    if (registeredPrs.length !== 1 || observedPrs.length !== 1) { reject(key, 'pull_request_identity_ambiguous'); continue; }
    const retained = registeredPrs[0]!;
    const current = observedPrs[0]!;
    if (!registration.repository.registered || current.repository !== registration.repository.repository
      || current.repository !== retained.repository || current.pullRequest !== retained.number) { reject(key, 'pull_request_identity_mismatch'); continue; }
    if (current.state !== 'available' || !current.headCommit || current.closed !== false || typeof current.merged !== 'boolean'
      || current.checks === undefined) { reject(key, 'pull_request_closed_or_unavailable'); continue; }
    const ticket = tickets[0]!;
    deliveries.push({
      repository: structuredClone(registration.repository),
      ticket: { ...structuredClone(registration.ticket), status: ticket.status, rank: ticket.rank },
      pullRequest: {
        repository: current.repository, number: current.pullRequest, headCommit: current.headCommit, merged: current.merged,
        ...(current.mergeCommit ? { mergeCommit: current.mergeCommit } : {}),
        evidence: [
          ...retained.evidence.filter(item => item.kind === 'review' && item.commit === current.headCommit).map(item => structuredClone(item)),
          ...current.checks.map(check => ({ kind: 'check' as const, commit: current.headCommit!, source: check.name,
            verdict: check.state === 'SUCCESS' ? 'passed' as const : check.state === 'FAILURE' ? 'failed' as const : 'pending' as const,
            observedAt })),
        ],
        ...(retained.deployment?.revision === current.mergeCommit ? { deployment: structuredClone(retained.deployment) } : {}),
        ...(retained.stagingAcceptance?.revision === current.mergeCommit ? { stagingAcceptance: structuredClone(retained.stagingAcceptance) } : {}),
      },
    });
  }
  return { deliveries, transitionsByTicket: inspection.transitionsByTicket, unavailable };
}
