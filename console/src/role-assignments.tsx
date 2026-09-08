import type { ConsoleSettings } from '../../src/console/settings.ts';

import type { FactoryRoleAssignment as RoleAssignment } from '../../src/config/index.ts';
export const suggestedRoles = ['manager', 'builder', 'reviewer', 'merge-captain', 'designer', 'tester', 'deployer', 'maintainer'];

export function RoleAssignments({ assignments = [], onChange, settings }: { assignments?: RoleAssignment[]; onChange?: (next: RoleAssignment[]) => void; settings: ConsoleSettings }) {
  const editing = onChange !== undefined;
  const providerOptions = settings.providers.flatMap((provider) => (provider.configuredIds ?? []).map((id) => ({id, label: `${id} (${provider.id === 'claude' ? 'Claude Code' : provider.id})`})));
  const update = (index: number, patch: Partial<RoleAssignment>) => onChange?.(assignments.map((assignment, i) => i === index ? {...assignment, ...patch} : assignment));
  const add = (role: string) => onChange?.([...assignments, {role, providerId: providerOptions[0]?.id ?? ''}]);
  return <section className="role-assignments" aria-label="Role assignments">
    <h3>Role assignments</h3><p>Assign a provider and optional model to each responsibility. Roles are optional; one provider can fill several roles. These preferences do not grant permissions or launch agents.</p>
    {assignments.length === 0 && <p className="quiet">No roles assigned. {editing ? 'Choose a suggested role or add your own.' : 'Open Edit settings to assign your team.'}</p>}
    <div className="role-list">{assignments.map((assignment,index) => <div className="role-row" key={index}>{editing ? <>
      <label>Role<input aria-label={`Role ${index+1}: Name`} value={assignment.role} pattern="[a-z][a-z0-9]*([-_][a-z0-9]+)*" maxLength={64} required placeholder="e.g. builder" onChange={(event) => update(index,{role:event.target.value})} /></label>
      <label>Provider<select aria-label={`Role ${index+1}: Provider`} value={assignment.providerId} required onChange={(event) => update(index,{providerId:event.target.value})}><option value="">Choose provider</option>{!providerOptions.some((provider) => provider.id === assignment.providerId) && assignment.providerId && <option value={assignment.providerId}>{assignment.providerId}</option>}{providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
      <label>Model<input aria-label={`Role ${index+1}: Model`} value={assignment.model ?? ''} placeholder="Route default" maxLength={128} onChange={(event) => update(index,{model:event.target.value || undefined})} /></label>
      <label>Reasoning<select aria-label={`Role ${index+1}: Reasoning`} value={assignment.reasoning ?? ''} onChange={(event) => update(index,{reasoning:(event.target.value || undefined) as RoleAssignment['reasoning']})}><option value="">Provider default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <button type="button" aria-label={`Remove role ${assignment.role || index+1}`} onClick={() => onChange(assignments.filter((_,i) => i !== index))}>Remove</button>
    </> : <><strong>{assignment.role.replaceAll('-', ' ')}</strong><span>{assignment.providerId}</span><span>{assignment.model || 'Route default'}</span><small>{assignment.reasoning ? `${assignment.reasoning} reasoning` : 'Provider-default reasoning'}</small></>}</div>)}</div>
    {editing && <><div className="role-suggestions" aria-label="Suggested roles">{suggestedRoles.filter((role) => !assignments.some((assignment) => assignment.role === role)).map((role) => <button type="button" key={role} onClick={() => add(role)}>+ {role.replaceAll('-', ' ')}</button>)}<button type="button" onClick={() => add('')}>+ Custom role</button></div><p className="quiet">Use lowercase names with hyphens for custom roles. Model and reasoning availability depends on the selected provider and its configured runtime route.</p></>}
    {assignments.some((assignment) => assignment.role === 'merge-captain') && <p className="notice">Assigning a merge captain does not change merge authority. A human approval policy still requires human approval.</p>}
  </section>;
}
