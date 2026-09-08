import type { ReactNode } from 'react';
import type { ConsoleSettings } from '../../src/console/settings.ts';

const providerNames = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor' };
const labels: Record<string, string> = {
  maxConcurrentRuns: 'Concurrent runs', maxRetries: 'Retries per run', maxRuntimeMinutes: 'Runtime limit (minutes)',
  maxTokens: 'Token limit', strictSpending: 'Strict spending', strictSpendingSupported: 'Strict spending supported',
  requireIntentApproval: 'Intent approval', requireSpecificationApproval: 'Specification approval',
  requireIndependentReview: 'Independent review', mergeAuthority: 'Merge authority', productionReleaseAuthority: 'Production release authority',
  allowPreviewDeployment: 'Preview deployment allowed', allowLocalDeployment: 'Local deployment allowed', allowSeparateBilling: 'Separate billing allowed',
};

function Fields({ values }: { values: object }) {
  return <dl className="settings-fields">{Object.entries(values).filter(([key]) => key in labels).map(([key, value]) => <div key={key}><dt>{labels[key]}</dt><dd>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : typeof value === 'number' ? value.toLocaleString() : String(value)}</dd></div>)}</dl>;
}

export function Settings({ settings, connectionSettings }: { settings?: ConsoleSettings; connectionSettings?: ReactNode }) {
  if (!settings) return <section className="workspace"><section className="panel"><h2>Settings unavailable</h2><p>This Console service has not published its configuration. Update and restart the local service to display provider and factory settings.</p>{connectionSettings}</section></section>;
  return <section className="workspace settings-page">
    <section className="panel settings-intro"><div><h2>Your factory, configured</h2><p>{settings.factory.name} · Factory-wide settings, independent of the Work filters.</p></div><span className="settings-badge">Read-only configuration</span></section>
    <section className="settings-providers" aria-label="Providers">{settings.providers.map((provider) => <article className="panel provider-card" key={provider.id}>
      <div className="panel-heading"><h2>{providerNames[provider.id]}</h2><span className={`settings-badge ${provider.enabled ? 'route-enabled' : ''}`}>{provider.enabled ? 'Execution configured' : provider.configured ? 'Catalog only' : 'Not configured'}</span></div>
      <dl className="settings-fields"><div><dt>Factory catalog</dt><dd>{provider.configured ? 'Included' : 'Not included'}</dd></div><div><dt>Login status</dt><dd>Unverified</dd></div><div><dt>Execution profile</dt><dd>{provider.routes.map((route) => route.profile).join(', ') || 'No runtime route'}</dd></div><div><dt>Compatible models</dt><dd>{provider.routes.flatMap((route) => route.compatibleModels ?? []).join(', ') || 'Not specified'}</dd></div></dl>
      <p className="settings-footnote">{provider.authentication.detail}</p>
      <details><summary>Declared capabilities</summary><p>{provider.capabilities.join(', ') || 'No capabilities declared.'}</p></details>
    </article>)}</section>
    {settings.factory.defaults && <section className="panel panel-support"><h2>Factory defaults</h2><div className="settings-assignment"><span>Provider <strong>{settings.factory.defaults.providerId || 'Not assigned'}</strong></span><span>Environment <strong>{settings.factory.defaults.environmentId || 'Not assigned'}</strong></span><span>Profile <strong>{settings.factory.defaults.executionProfile}</strong></span></div><details><summary>Default limits & approval policy</summary><div className="settings-grid"><Fields values={settings.factory.defaults.budget} /><Fields values={settings.factory.defaults.authority} /></div></details></section>}
    <div className="settings-grid">
      <section className="panel panel-support"><h2>Resources & limits</h2><p>Coordinator limits currently loaded by this service.</p><Fields values={settings.resourceLimits} /><p className="settings-footnote">Configuration limits are not usage measurements or subscription balances.</p></section>
      <section className="panel"><h2>Environments & maintenance</h2><dl className="settings-fields">{settings.environments.map((environment) => <div key={environment.id}><dt>{environment.id}</dt><dd>{environment.kind}</dd></div>)}<div><dt>Routine maintenance</dt><dd>{settings.recovery.configured ? 'Configured' : 'Not configured'}</dd></div></dl><p className="settings-footnote">{settings.recovery.routineActions.join(', ').replaceAll('_', ' ') || 'No routine maintenance actions are configured.'} This does not imply rollback is enabled.</p></section>
    </div>
    <section className="panel"><h2>Products & pod configuration</h2><p>Resolved assignments and policies, including inherited values.</p>{settings.products.length === 0 ? <p>No product configuration was supplied.</p> : settings.products.map((product) => <details className="settings-product" key={product.id} open><summary>{product.name}<span>{product.pods.length} pod{product.pods.length === 1 ? '' : 's'}</span></summary><div className="settings-assignment"><span>Provider <strong>{product.providerId || 'Not assigned'}</strong></span><span>Environment <strong>{product.environmentId || 'Not assigned'}</strong></span><span>Profile <strong>{product.executionProfile}</strong></span></div><details><summary>Product limits & approval policy</summary><div className="settings-grid"><Fields values={product.budget} /><Fields values={product.authority} /></div></details>{product.pods.map((pod) => <details className="settings-pod" key={pod.id}><summary>{pod.id}</summary><p>Provider: {pod.providerId || 'Not assigned'} · Environment: {pod.environmentId || 'Not assigned'} · Profile: {pod.executionProfile}</p><div className="settings-grid"><Fields values={pod.budget} /><Fields values={pod.authority} /></div></details>)}</details>)}</section>
    <div className="settings-grid"><section className="panel panel-support"><h2>Change configuration</h2><p>Ask your setup agent to update the owner-controlled factory configuration, validate it, and restart the Console with the approved settings. This page shows the loaded configuration; editing a file alone does not change the running service.</p><p>Provider login stays in each provider’s own CLI. Faktori never asks for subscription credentials here.</p></section><section className="panel"><h2>Console connection</h2><p>Local command authorization for this browser session.</p>{connectionSettings}</section></div>
  </section>;
}
