import type { DurableCoordinator } from '../runtime/coordinator.ts';
import { deliveryJournal } from './delivery-journal.ts';

export type WorkAttribution = Record<string, { featureId: string; acceptanceRevision: string; workClass: 'planning' | 'implementation' | 'consultation' | 'review' | 'verification' | 'rework' | 'coordination' }>;
export function parseWorkAttribution(value: unknown): WorkAttribution {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 5000) throw new Error('work_attribution_invalid');
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z0-9._:-]{1,128}$/i.test(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(field => !['featureId', 'acceptanceRevision', 'workClass'].includes(field))
      || !/^[a-z0-9._:-]{1,128}$/i.test(entry.featureId) || typeof entry.acceptanceRevision !== 'string' || !entry.acceptanceRevision.length || entry.acceptanceRevision.length > 256
      || !['planning', 'implementation', 'consultation', 'review', 'verification', 'rework', 'coordination'].includes(entry.workClass)) throw new Error('work_attribution_binding_invalid');
  }
  return structuredClone(value) as WorkAttribution;
}
function sameBinding(left: WorkAttribution[string], right: WorkAttribution[string]): boolean {
  return left.featureId === right.featureId && left.acceptanceRevision === right.acceptanceRevision && left.workClass === right.workClass;
}
/** Attribution and acceptance scope cannot be renamed to improve the denominator. */
export async function registerWorkAttribution(coordinator: DurableCoordinator, input: WorkAttribution): Promise<WorkAttribution> {
  const configured = parseWorkAttribution(input);
  const journal = deliveryJournal<{ eventId: string; workItemId: string; binding: WorkAttribution[string] }>(coordinator, 'feature');
  const existing = journal.events();
  const bindings: WorkAttribution = Object.fromEntries(existing.map(event => [event.workItemId, event.binding]));
  const scopes = new Map(existing.map(event => [event.binding.featureId, event.binding.acceptanceRevision]));
  for (const [workItemId, binding] of Object.entries(configured)) {
    if (bindings[workItemId] && !sameBinding(bindings[workItemId], binding)) throw new Error('feature_attribution_is_immutable');
    if (scopes.has(binding.featureId) && scopes.get(binding.featureId) !== binding.acceptanceRevision) throw new Error('feature_acceptance_scope_is_immutable');
    scopes.set(binding.featureId, binding.acceptanceRevision);
  }
  for (const [workItemId, binding] of Object.entries(configured)) {
    if (!bindings[workItemId]) await journal.append({ eventId: `attribution:${workItemId}`, workItemId, binding });
    bindings[workItemId] = binding;
  }
  return bindings;
}
