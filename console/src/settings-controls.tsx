export const settingLabels: Record<string, string> = {
  maxConcurrentRuns: 'Concurrent runs', maxRetries: 'Retries per run', maxRuntimeMinutes: 'Runtime limit (minutes)',
  maxTokens: 'Token limit', strictSpending: 'Strict spending', strictSpendingSupported: 'Strict spending supported',
  requireIntentApproval: 'Require intent approval', requireSpecificationApproval: 'Require specification approval',
  requireIndependentReview: 'Require independent review', mergeAuthority: 'Merge authority', productionReleaseAuthority: 'Production release authority',
  allowPreviewDeployment: 'Allow preview deployment', allowLocalDeployment: 'Allow local deployment', allowSeparateBilling: 'Allow separate billing',
};

export function ValueControls({ values, onChange, prefix }: { values: object; onChange: (key: string, value: boolean | number | string) => void; prefix: string }) {
  return <div className="settings-form-grid">{Object.entries(values).filter(([key]) => key in settingLabels && key !== 'strictSpendingSupported').map(([key, value]) => <label key={key} className={typeof value === 'boolean' ? 'settings-toggle' : ''}>
    <span>{settingLabels[key]}</span>
    {typeof value === 'boolean' ? <input aria-label={`${prefix}: ${settingLabels[key]}`} type="checkbox" checked={value} onChange={(event) => onChange(key, event.target.checked)} /> : typeof value === 'number' ? <input aria-label={`${prefix}: ${settingLabels[key]}`} required type="number" min={key === 'maxConcurrentRuns' || key === 'maxRuntimeMinutes' ? 1 : 0} step="1" value={Number.isFinite(value) ? value : ''} onChange={(event) => onChange(key, event.target.valueAsNumber)} /> : <select aria-label={`${prefix}: ${settingLabels[key]}`} value={value} onChange={(event) => onChange(key, event.target.value)}><option value="human">Human</option><option value="coordinator">Coordinator</option></select>}
  </label>)}</div>;
}
