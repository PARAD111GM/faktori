import { HelpHeading, HelpSummary } from "./section-help.tsx";
import { useEffect, useRef, useState } from 'react';
import type { ConsoleSettings, ConsoleSettingsScope } from '../../src/console/settings.ts';
import { ValueControls } from './settings-controls.tsx';
import { RoleAssignments } from './role-assignments.tsx';
import type { ConsoleSettingsDraft as Draft, ConsoleSettingsEditView as Snapshot, ConsoleSettingsPreview as Preview } from '../../src/console/settings-edit.ts';
const names = {codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor'};
const errors: Record<string,string> = {
  settings_revision_conflict: 'Configuration changed since you opened this editor. Close and reopen it to load the latest version; your changes have not been saved.',
  settings_validation_failed: 'The proposed settings are not a valid configuration. Check provider assignments, required capabilities, and approval policies, then review again.',
  settings_operation_failed: 'The configuration file could not be accessed or saved. Check the local service and file permissions, then reopen the editor.',
  console_authentication_required: 'Your Console session is no longer authorized. Reload the page or update the local command token.',
  settings_editing_unavailable: 'This service does not support persistent settings editing. Restart it from an owner-controlled configuration file.',
  settings_editing_requires_factory_configuration: 'This Console was started without its factory catalog, so there are no factory settings to edit. Add the approved factory configuration to the local Console file and restart the Console.',
};

export function settingsEditorError(error: unknown, status?: number): string {
  return typeof error === 'string' ? (errors[error] ?? (status === undefined ? error : `Settings request failed (${status})`)) : 'Settings request failed.';
}

function ScopeControls({scope, update, settings, label}: {scope: ConsoleSettingsScope; update: (next: ConsoleSettingsScope) => void; settings: ConsoleSettings; label: string}) {
  return <>
    <RoleAssignments assignments={scope.roleAssignments} settings={settings} onChange={(roleAssignments) => update({...scope,roleAssignments})} />
    <div className="settings-form-grid">
      <label>Provider<input aria-label={`${label}: Provider`} value={scope.providerId} onChange={(e) => update({...scope, providerId: e.target.value})} required /><small>Use a configured provider ID; validation checks the assignment.</small></label>
      <label>Environment<select aria-label={`${label}: Environment`} value={scope.environmentId} onChange={(e) => update({...scope, environmentId: e.target.value})}><option value="">Not assigned</option>{settings.environments.map((env) => <option key={env.id} value={env.id}>{env.id} ({env.kind})</option>)}</select></label>
      <label>Execution profile<select aria-label={`${label}: Execution profile`} value={scope.executionProfile} onChange={(e) => update({...scope, executionProfile: e.target.value as 'native'|'isolated'})}><option value="isolated">Isolated container</option><option value="native">Native host</option></select><small>Native execution uses the worker’s host permissions.</small></label>
    </div>
    <details><HelpSummary scope="settings-editor">Limits</HelpSummary><ValueControls prefix={label} values={scope.budget} onChange={(key, value) => update({...scope, budget:{...scope.budget, [key]:value}})} /></details>
    <details><HelpSummary scope="settings-editor">Approval & deployment policy</HelpSummary><ValueControls prefix={label} values={scope.authority} onChange={(key, value) => update({...scope, authority:{...scope.authority, [key]:value}})} /></details>
    <details><HelpSummary scope="settings-editor">Required capabilities</HelpSummary><div className="settings-form-grid">{(['isolated','native','subagents','token-limit'] as const).map((capability) => <label className="settings-toggle" key={capability}><span>{capability}</span><input aria-label={`${label}: ${capability}`} type="checkbox" checked={scope.requiredCapabilities.includes(capability)} onChange={(e) => update({...scope, requiredCapabilities:e.target.checked ? [...scope.requiredCapabilities, capability] : scope.requiredCapabilities.filter((item) => item !== capability)})} /></label>)}</div></details>
  </>;
}

export function SettingsEditor({settings, token, onSaved}: {settings: ConsoleSettings; token: string; onSaved: () => void}) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [draft, setDraft] = useState<Draft>();
  const [preview, setPreview] = useState<Preview>();
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);
  async function request<T>(operation: string, payload: object): Promise<T> {
    if (!token) throw new Error('Enter your local command token in Console connection before editing.');
    const response = await fetch(`/api/console/settings/${operation}`, {method:'POST', headers:{'Content-Type':'application/json','X-Faktori-Console-Token':token}, body:JSON.stringify(payload)});
    const body = await response.json();
    if (!response.ok) throw new Error(settingsEditorError(body.error, response.status));
    return body as T;
  }
  async function perform(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {await action();} catch (cause) {setError(cause instanceof Error ? cause.message : 'Settings request failed.');}
    finally {inFlight.current = false; setBusy(false);}
  }
  function change(next: Draft) {setDraft(next); setPreview(undefined); setAcknowledged([]); setMessage('');}
  function close() {setDraft(undefined); setSnapshot(undefined); setPreview(undefined); setError('');}
  const roleSettings = draft ? {...settings, providers: settings.providers.filter((provider) => draft.providers.includes(provider.id)).map((provider) => ({...provider, configuredIds: provider.configuredIds?.length ? provider.configuredIds : [provider.id]}))} : settings;
  const dirty = draft && snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.draft);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return <section className="panel settings-editor">
    <div className="panel-heading"><div><HelpHeading level={2} scope="settings-editor">Configure your factory</HelpHeading><p>Review changes before saving. Saved settings take effect after the Console is restarted.</p></div>{!draft && <button className="primary" disabled={busy} onClick={() => void perform(async () => {const next = await request<Snapshot>('edit', {}); setSnapshot(next); setDraft(structuredClone(next.draft)); setMessage('');})}>{busy ? 'Opening…' : 'Edit settings'}</button>}</div>
    {message && <p className="settings-success" role="status">{message}</p>}
    {error && <p className="alert" role="alert">{error}</p>}
    {draft && snapshot && <form onSubmit={(event) => {event.preventDefault(); void perform(async () => {setPreview(await request<Preview>('preview', {revision:snapshot.revision, draft})); setAcknowledged([]);});}}>
      <fieldset disabled={busy || !!preview}>
        <label>Factory name<input value={draft.factoryName} required maxLength={160} onChange={(event) => change({...draft, factoryName:event.target.value})} /></label>
        <HelpHeading level={3} scope="settings-editor">Provider catalog</HelpHeading><p>Choose which providers the factory can reference. Adding one here does not install its CLI, sign in, or create an execution route.</p>
        <div className="settings-form-grid">{(['codex','claude','cursor'] as const).map((provider) => <label className="settings-toggle" key={provider}><span>{names[provider]}</span><input type="checkbox" checked={draft.providers.includes(provider)} onChange={(e) => change({...draft, providers:e.target.checked ? [...draft.providers,provider] : draft.providers.filter((id) => id !== provider)})} /></label>)}</div>
        {draft.routeModels.length > 0 && <><HelpHeading level={3} scope="settings-editor">Compatible models</HelpHeading>{draft.routeModels.map((route,index) => <label key={`${route.providerId}-${route.profile}`}>{names[route.providerId]} · {route.profile}<input value={route.compatibleModels.join(', ')} onChange={(e) => change({...draft,routeModels:draft.routeModels.map((item,i) => i === index ? {...item, compatibleModels:e.target.value.split(',').map((model) => model.trim())} : item)})} /><small>Comma-separated model names for the existing execution route.</small></label>)}</>}
        <details className="settings-edit-section" open><HelpSummary scope="settings-editor">Factory defaults</HelpSummary><ScopeControls settings={roleSettings} label="Factory defaults" scope={draft.defaults} update={(defaults) => change({...draft,defaults})} /></details>
        <details className="settings-edit-section"><HelpSummary scope="settings-editor">Coordinator limits</HelpSummary><p>These limit admission independently of product defaults.</p><ValueControls prefix="Coordinator" values={draft.limits} onChange={(key,value) => change({...draft,limits:{...draft.limits,[key]:value}})} /></details>
        {draft.products.map((product,index) => <details className="settings-edit-section" key={product.id}><HelpSummary scope="settings-editor">Product: {product.name}</HelpSummary><label>Product name<input required value={product.name} onChange={(e) => change({...draft,products:draft.products.map((item,i) => i === index ? {...item,name:e.target.value} : item)})} /></label><ScopeControls settings={roleSettings} label={`Product ${product.id}`} scope={product.overrides} update={(overrides) => change({...draft,products:draft.products.map((item,i) => i === index ? {...item,overrides} : item)})} /></details>)}
        {draft.pods.map((pod,index) => <details className="settings-edit-section" key={pod.id}><HelpSummary scope="settings-editor">Pod: {pod.id}</HelpSummary><ScopeControls settings={roleSettings} label={`Pod ${pod.id}`} scope={pod.overrides} update={(overrides) => change({...draft,pods:draft.pods.map((item,i) => i === index ? {...item,overrides} : item)})} /></details>)}
      </fieldset>
      {!preview && <div className="settings-actions"><button type="submit" disabled={busy || !dirty}>{busy ? 'Validating…' : 'Review changes'}</button><button type="button" disabled={busy} onClick={close}>Discard changes</button></div>}
      {preview && <section className="settings-review" aria-label="Review settings changes"><HelpHeading level={3} scope="settings-editor">Review changes</HelpHeading><p>{preview.changed ? 'The configuration is valid. Saving updates the configuration file, not running workers.' : 'No changes to save.'}</p><ul className="settings-change-list">{changes(snapshot.draft, preview.draft).map((line) => <li key={line}>{line}</li>)}</ul>{preview.risks.map((risk) => <label className="settings-risk" key={risk.id}><input type="checkbox" checked={acknowledged.includes(risk.id)} onChange={(e) => setAcknowledged(e.target.checked ? [...acknowledged,risk.id] : acknowledged.filter((id) => id !== risk.id))} /><span><strong>{risk.summary}</strong><small>{risk.path} — I understand and approve this consequence.</small></span></label>)}<div className="settings-actions"><button type="button" disabled={busy || !preview.changed || preview.risks.some((risk) => !acknowledged.includes(risk.id))} onClick={() => void perform(async () => {const saved = await request<Preview>('save', {revision:preview.revision,draft,confirm:true,acknowledgedRiskIds:acknowledged}); close(); setMessage(saved.restartRequired ? 'Saved to configuration. Restart the Console to apply these changes; the settings below still show what is currently running.' : 'Configuration saved. No restart is needed.'); onSaved();})}>{busy ? 'Saving…' : 'Confirm & save'}</button><button type="button" disabled={busy} onClick={() => setPreview(undefined)}>Back to editing</button><button type="button" disabled={busy} onClick={close}>Discard changes</button></div></section>}
    </form>}
  </section>;
}

export function changes(before: unknown, after: unknown, path = ''): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) return Object.keys(after).flatMap((key) => changes((before as Record<string,unknown>)[key], (after as Record<string,unknown>)[key], path ? `${path}.${key}` : key));
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length && after.every((item) => item && typeof item === 'object')) return after.flatMap((item,index) => changes(before[index], item, `${path}.${item.id ?? index}`));
  return [`${path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`];
}
