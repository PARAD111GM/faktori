import type { LocalConsoleConfiguration } from '../console/startup.ts';

/**
 * An offline inventory of setup facts. It never probes a provider, executes a
 * GM review, contacts Jira, or reads credential values, so it cannot certify
 * live readiness or completion.
 */
export type SetupReadinessStatus = 'configured' | 'verified' | 'unavailable' | 'deferred';

export interface SetupReadinessCheck {
  id: string;
  status: SetupReadinessStatus;
  remediation: string;
}

export interface SetupReadinessResult {
  format: 'faktori.setup-readiness-result/v1';
  checks: SetupReadinessCheck[];
  /** Supported providers are listed separately so an owner can distinguish an unselected provider from a selected-but-unrouted one. */
  providerSelection: Array<{ id: 'codex' | 'claude' | 'cursor'; selected: boolean; runtimeRoute: boolean }>;
  summary: Record<SetupReadinessStatus, number>;
  /** `complete` is always false for this offline report; observed evidence belongs in preflight and bounded exercises. */
  complete: false;
  status: 'blocked' | 'incomplete';
}

type Environment = Readonly<Record<string, string | undefined>>;

function check(id: string, status: SetupReadinessStatus, remediation: string): SetupReadinessCheck {
  return { id, status, remediation };
}

function runtimeProviderId(kind: NonNullable<LocalConsoleConfiguration['factoryConfiguration']>['providers'][number]['kind']): 'codex' | 'claude' | 'cursor' {
  return kind === 'claude-code' ? 'claude' : kind;
}

/**
 * Report declared setup without authorizing or attempting any repair. A
 * configured value only means the local Console configuration supplied it;
 * every verification count remains zero until separate observed evidence is
 * recorded through the appropriate runtime/preflight path.
 */
export function evaluateSetupReadiness(configuration: LocalConsoleConfiguration, environment: Environment = process.env): SetupReadinessResult {
  const checks: SetupReadinessCheck[] = [];
  const runtime = configuration.runtime;
  const gm = runtime?.gm;

  checks.push(gm === undefined
    ? check('gm.runtime', 'unavailable', 'Configure an owner-approved GM runtime route before expecting Factory GM review behavior.')
    : check('gm.runtime', 'configured', 'GM runtime is declared; run a separately approved bounded review to obtain observed evidence.'));
  checks.push(gm?.mode === 'nightly' && gm.schedule?.enabled === true
    ? check('gm.scheduling', 'configured', 'Nightly GM scheduling is declared; render, install, and observe the local scheduler separately before treating it as verified.')
    : check('gm.scheduling', 'unavailable', 'Configure and explicitly enable a nightly GM schedule, or keep GM review manual. This report does not enable either path.'));

  const sources = configuration.jiraSources ?? [];
  checks.push(sources.length === 0
    ? check('jira.sources', 'unavailable', 'No Jira project source is configured. Add an owner-approved Jira source only if this factory uses Jira; this report does not create one.')
    : check('jira.sources', 'configured', 'Jira project sources are declared; connectivity and permissions require separate observed evidence.'));
  for (const source of sources) {
    checks.push(check(`jira.${source.id}.project_source`, 'configured', 'The Jira project source is declared; run a read-only observed sync separately to verify access.'));
    const authorizationPresent = typeof environment[source.authorizationEnv] === 'string' && environment[source.authorizationEnv]!.trim().length > 0;
    checks.push(authorizationPresent
      ? check(`jira.${source.id}.authorization_environment`, 'configured', 'The Jira authorization environment variable is present. Its value is never printed, stored, or verified by this report.')
      : check(`jira.${source.id}.authorization_environment`, 'unavailable', `Set the configured Jira authorization environment variable ${source.authorizationEnv} in the Console service environment, then run a separate read-only sync to verify access.`));
  }

  const catalog = configuration.factoryConfiguration;
  checks.push(catalog === undefined
    ? check('providers.catalog', 'unavailable', 'No resolved factory provider catalog is attached to this Console configuration, so runtime routes cannot be compared to selected providers.')
    : check('providers.catalog', 'configured', 'The resolved factory provider catalog is attached; provider execution still requires separate observed evidence.'));
  const routes = runtime?.providers ?? [];
  checks.push(routes.length === 0
    ? check('providers.runtime_routes', 'unavailable', 'No provider runtime routes are configured. Add only owner-approved routes; this report does not enable providers.')
    : check('providers.runtime_routes', 'configured', 'Provider runtime routes are declared; route declarations are not authentication or execution evidence.'));
  if (catalog !== undefined) for (const provider of catalog.providers) {
    const providerId = runtimeProviderId(provider.kind);
    const routed = routes.some((route) => route.id === providerId);
    checks.push(routed
      ? check(`provider.${provider.id}.runtime_route`, 'configured', 'A matching runtime provider route is declared; authenticate and run a bounded approved exercise separately to verify it.')
      : check(`provider.${provider.id}.runtime_route`, 'unavailable', `The cataloged ${provider.kind} provider has no matching runtime route. Configure it explicitly or do not treat this catalog entry as executable.`));
  }

  const providerSelection = (['codex', 'claude', 'cursor'] as const).map((id) => ({
    id,
    selected: catalog?.providers.some((provider) => runtimeProviderId(provider.kind) === id) ?? false,
    runtimeRoute: routes.some((route) => route.id === id),
  }));

  const summary: Record<SetupReadinessStatus, number> = { configured: 0, verified: 0, unavailable: 0, deferred: 0 };
  for (const item of checks) summary[item.status] += 1;
  return {
    format: 'faktori.setup-readiness-result/v1',
    checks,
    providerSelection,
    summary,
    complete: false,
    status: summary.unavailable > 0 ? 'blocked' : 'incomplete',
  };
}
