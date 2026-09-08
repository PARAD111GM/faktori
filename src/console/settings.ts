import type { Authority, Budget, EnvironmentKind, ExecutionProfile, FactoryRoleAssignment, ProviderCapability, ResolvedFactoryConfiguration } from '../config/index.ts';
import type { AdmissionLimits } from '../runtime/index.ts';
import type { LocalConsoleConfiguration, LocalProviderRoute } from './startup.ts';

export type ConsoleProviderId = 'codex' | 'claude' | 'cursor';

export interface ConsoleSettingsScope {
  providerId: string;
  environmentId: string;
  executionProfile: ExecutionProfile;
  requiredCapabilities: ProviderCapability[];
  budget: Budget;
  authority: Authority;
  roleAssignments?: FactoryRoleAssignment[];
}

export interface ConsoleSettings {
  format: 'faktori.console-settings/v1';
  factory: {
    id: string;
    name: string;
    defaults?: ConsoleSettingsScope;
  };
  providers: Array<{
    id: ConsoleProviderId;
    configured: boolean;
    configuredIds: string[];
    enabled: boolean;
    authentication: {
      status: 'unknown';
      detail: string;
    };
    capabilities: ProviderCapability[];
    routes: Array<{
      profile: 'native' | 'isolated';
      compatibleModels?: string[];
    }>;
  }>;
  products: Array<ConsoleSettingsScope & {
    id: string;
    name: string;
    pods: Array<ConsoleSettingsScope & { id: string }>;
  }>;
  environments: Array<{ id: string; kind: EnvironmentKind }>;
  resourceLimits: AdmissionLimits;
  recovery: {
    configured: boolean;
    routineActions: string[];
  };
  persistence?: {
    editable: boolean;
    loadedRevision: string;
    savedRevision: string;
    restartRequired: boolean;
  };
}

const PROVIDERS: ConsoleProviderId[] = ['codex', 'claude', 'cursor'];

function providerKind(id: ConsoleProviderId): ResolvedFactoryConfiguration['providers'][number]['kind'] {
  return id === 'claude' ? 'claude-code' : id;
}

function routeSummary(route: LocalProviderRoute): ConsoleSettings['providers'][number]['routes'][number] {
  return {
    profile: route.profile,
    ...('compatibleModels' in route ? { compatibleModels: [...route.compatibleModels] } : {}),
  };
}

function scopeSummary(scope: ResolvedFactoryConfiguration['factory']['defaults']): ConsoleSettingsScope {
  return {
    providerId: scope.providerId,
    environmentId: scope.environmentId,
    executionProfile: scope.executionProfile,
    requiredCapabilities: [...scope.requiredCapabilities],
    budget: {
      maxConcurrentRuns: scope.budget.maxConcurrentRuns,
      maxRetries: scope.budget.maxRetries,
      maxRuntimeMinutes: scope.budget.maxRuntimeMinutes,
      maxTokens: scope.budget.maxTokens,
      strictSpending: scope.budget.strictSpending,
    },
    authority: {
      requireIntentApproval: scope.authority.requireIntentApproval,
      requireSpecificationApproval: scope.authority.requireSpecificationApproval,
      requireIndependentReview: scope.authority.requireIndependentReview,
      mergeAuthority: scope.authority.mergeAuthority,
      productionReleaseAuthority: scope.authority.productionReleaseAuthority,
      allowPreviewDeployment: scope.authority.allowPreviewDeployment,
      allowLocalDeployment: scope.authority.allowLocalDeployment,
      allowSeparateBilling: scope.authority.allowSeparateBilling,
    },
    ...(scope.roleAssignments === undefined ? {} : { roleAssignments: scope.roleAssignments.map((assignment) => ({ role: assignment.role, providerId: assignment.providerId, ...(assignment.model === undefined ? {} : { model: assignment.model }), ...(assignment.reasoning === undefined ? {} : { reasoning: assignment.reasoning }) })) }),
  };
}

/**
 * Produce the browser-safe settings summary from validated owner configuration.
 * This is an allowlist: provider environments, nonces, tools, commands, local
 * paths, credentials, tokens and browser-origin configuration never cross it.
 */
export function createConsoleSettings(configuration: LocalConsoleConfiguration): ConsoleSettings {
  const catalog = configuration.factoryConfiguration;
  const runtimeRoutes = configuration.runtime?.providers ?? [];
  const routineActions = configuration.runtime?.gm?.configuredRoutineActions ?? [];

  return {
    format: 'faktori.console-settings/v1',
    factory: {
      id: configuration.factoryId,
      name: catalog?.factory.name ?? configuration.factoryId,
      ...(catalog === undefined ? {} : { defaults: scopeSummary(catalog.factory.defaults) }),
    },
    providers: PROVIDERS.map((id) => {
      const catalogEntries = catalog?.providers.filter((provider) => provider.kind === providerKind(id)) ?? [];
      const routes = runtimeRoutes.filter((route) => route.id === id).map(routeSummary);
      return {
        id,
        configured: catalogEntries.length > 0,
        configuredIds: catalogEntries.map((provider) => provider.id),
        enabled: routes.length > 0,
        authentication: {
          status: 'unknown',
          detail: 'Authentication is verified only by the provider-owned flow, not by Console settings.',
        },
        capabilities: [...new Set(catalogEntries.flatMap((provider) => provider.capabilities))],
        routes,
      };
    }),
    products: (catalog?.products ?? []).map((product) => ({
      id: product.id,
      name: product.name,
      ...scopeSummary(product),
      pods: catalog?.pods.filter((pod) => pod.productId === product.id).map((pod) => ({ id: pod.id, ...scopeSummary(pod) })) ?? [],
    })),
    environments: catalog?.environments.map((environment) => ({ id: environment.id, kind: environment.kind })) ?? [],
    resourceLimits: {
      maxConcurrentRuns: configuration.limits.maxConcurrentRuns,
      maxRetries: configuration.limits.maxRetries,
      maxRuntimeMinutes: configuration.limits.maxRuntimeMinutes,
      maxTokens: configuration.limits.maxTokens,
      strictSpending: configuration.limits.strictSpending,
      strictSpendingSupported: configuration.limits.strictSpendingSupported,
    },
    recovery: {
      configured: routineActions.length > 0,
      routineActions: [...routineActions],
    },
  };
}
