import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ConfigValidationError, resolveFactoryConfig } from '../../src/config/index.ts';

const BASE_CONFIG = {
  factory: {
    id: 'acme-factory',
    name: 'Acme Factory',
    defaults: {
      providerId: 'codex',
      environmentId: 'local',
      budget: {
        maxConcurrentRuns: 1,
        maxRetries: 1,
        maxRuntimeMinutes: 60,
        maxTokens: 40_000,
        strictSpending: true,
      },
    },
  },
  providers: [
    {
      id: 'codex',
      kind: 'codex',
      capabilities: ['native', 'isolated', 'subagents', 'token-limit'],
    },
    {
      id: 'cursor',
      kind: 'cursor',
      capabilities: ['native'],
    },
  ],
  environments: [
    { id: 'local', kind: 'local' },
    { id: 'preview', kind: 'preview' },
  ],
  products: [
    { id: 'web', name: 'Web' },
  ],
  pods: [
    { id: 'web-pod', productId: 'web' },
  ],
};

function withConfig(change) {
  return change(structuredClone(BASE_CONFIG));
}

describe('resolveFactoryConfig', () => {
  it('resolves a solo product from safe factory defaults', () => {
    const resolved = resolveFactoryConfig(BASE_CONFIG);

    expect(resolved.products).toEqual([
      expect.objectContaining({
        id: 'web',
        providerId: 'codex',
        environmentId: 'local',
        budget: expect.objectContaining({ maxRetries: 1, strictSpending: true }),
        authority: expect.objectContaining({
          requireIndependentReview: true,
          mergeAuthority: 'human',
          productionReleaseAuthority: 'human',
          allowSeparateBilling: false,
        }),
      }),
    ]);
    expect(resolved.pods).toEqual([
      expect.objectContaining({ id: 'web-pod', productId: 'web', providerId: 'codex' }),
    ]);
    expect(resolved.providers).toContainEqual(expect.objectContaining({ id: 'codex', kind: 'codex' }));
    expect(resolved.environments).toContainEqual(expect.objectContaining({ id: 'local', kind: 'local' }));
  });

  it('distinguishes an explicit false and zero from omitted sparse overrides', () => {
    const resolved = resolveFactoryConfig(withConfig((config) => {
      config.products[0].overrides = {
        budget: { maxRetries: 0 },
        authority: {
          requireIndependentReview: false,
          riskAcknowledgements: {
            requireIndependentReview: 'The owner accepts merge without an independent review.',
          },
        },
      };
      return config;
    }));

    expect(resolved.products[0].budget.maxRetries).toBe(0);
    expect(resolved.products[0].authority.requireIndependentReview).toBe(false);
    expect(resolved.products[0].authority.requireIntentApproval).toBe(true);
  });

  it('distinguishes an explicit empty capability list from an omitted one', () => {
    const resolved = resolveFactoryConfig(withConfig((config) => {
      config.factory.defaults.requiredCapabilities = ['subagents'];
      config.products[0].overrides = { requiredCapabilities: [] };
      return config;
    }));

    expect(resolved.products[0].requiredCapabilities).toEqual([]);
  });

  it('inherits optional custom role assignments without changing authority', () => {
    const before = resolveFactoryConfig(BASE_CONFIG);
    const resolved = resolveFactoryConfig(withConfig((config) => {
      config.providers.push({ id: 'review-provider', kind: 'codex', capabilities: ['native', 'token-limit'] });
      config.factory.defaults.roleAssignments = [
        { role: 'manager', providerId: 'codex', model: 'gpt-manager', reasoning: 'high', rolePrompt: 'Keep the decision log current.\nDo not change authority.' },
        { role: 'release_captain', providerId: 'review-provider' },
      ];
      config.pods[0].overrides = { roleAssignments: [] };
      return config;
    }));

    expect(resolved.factory.defaults.roleAssignments).toEqual([
      { role: 'manager', providerId: 'codex', model: 'gpt-manager', reasoning: 'high', rolePrompt: 'Keep the decision log current.\nDo not change authority.' },
      { role: 'release_captain', providerId: 'review-provider' },
    ]);
    expect(resolved.products[0].roleAssignments).toEqual(resolved.factory.defaults.roleAssignments);
    expect(resolved.pods[0].roleAssignments).toEqual([]);
    expect(resolved.factory.defaults.authority).toEqual(before.factory.defaults.authority);
    expect(resolved.products[0].authority).toEqual(before.products[0].authority);
  });

  it('keeps role assignments absent for existing configurations and rejects malformed assignments', () => {
    const existing = resolveFactoryConfig(BASE_CONFIG);
    expect(existing.factory.defaults).not.toHaveProperty('roleAssignments');
    expect(existing.products[0]).not.toHaveProperty('roleAssignments');
    expect(existing.pods[0]).not.toHaveProperty('roleAssignments');

    const invalid = [
      [{ role: 'Bad Role', providerId: 'codex' }, /lowercase role slug/],
      [[{ role: 'builder', providerId: 'codex' }, { role: 'builder', providerId: 'cursor' }], /duplicates role/],
      [{ role: 'builder', providerId: 'missing' }, /unknown provider/],
      [{ role: 'builder', providerId: 'codex', model: 'x'.repeat(129) }, /bounded non-empty string/],
      [{ role: 'builder', providerId: 'codex', reasoning: 'ultra' }, /must be "low", "medium", or "high"/],
      [{ role: 'builder', providerId: 'codex', rolePrompt: 7 }, /rolePrompt: must be a string/],
      [{ role: 'builder', providerId: 'codex', rolePrompt: 'x'.repeat(16_001) }, /rolePrompt: must be a string/],
      [{ role: 'builder', providerId: 'codex', command: 'forbidden' }, /not a supported setting/],
    ];
    for (const [assignments, expected] of invalid) {
      expect(() => resolveFactoryConfig(withConfig((config) => { config.factory.defaults.roleAssignments = Array.isArray(assignments) ? assignments : [assignments]; return config; }))).toThrow(expected);
    }
  });

  it('treats a blank role prompt as disabled without rewriting nonblank multiline input', () => {
    const resolved = resolveFactoryConfig(withConfig((config) => {
      config.factory.defaults.roleAssignments = [
        { role: 'builder', providerId: 'codex', rolePrompt: '  \n\t' },
        { role: 'reviewer', providerId: 'codex', rolePrompt: '\nRead the exact candidate.\n' },
      ];
      return config;
    }));

    expect(resolved.factory.defaults.roleAssignments).toEqual([
      { role: 'builder', providerId: 'codex' },
      { role: 'reviewer', providerId: 'codex', rolePrompt: '\nRead the exact candidate.\n' },
    ]);
  });

  it('does not invent a pod for a product that has none', () => {
    const resolved = resolveFactoryConfig(withConfig((config) => {
      config.products.push({
        id: 'api',
        name: 'API',
        overrides: { environmentId: 'preview' },
      });
      return config;
    }));

    expect(resolved.products.map((product) => product.id)).toEqual(['web', 'api']);
    expect(resolved.pods.map((pod) => pod.productId)).toEqual(['web']);
  });

  it('rejects an unknown provider at the exact override path', () => {
    expect(() => resolveFactoryConfig(withConfig((config) => {
      config.products[0].overrides = { providerId: 'missing-provider' };
      return config;
    }))).toThrow(/products\[0\]\.overrides\.providerId: unknown provider "missing-provider"/);
  });

  it('rejects a provider that cannot satisfy the selected execution profile', () => {
    expect(() => resolveFactoryConfig(withConfig((config) => {
      config.pods[0].overrides = {
        providerId: 'cursor',
        executionProfile: 'isolated',
      };
      return config;
    }))).toThrow(/pods\[0\]\.overrides\.executionProfile: provider "cursor" does not support capability "isolated"/);
  });

  it('rejects strict budgets when the selected provider cannot enforce token limits', () => {
    expect(() => resolveFactoryConfig(withConfig((config) => {
      config.factory.defaults.providerId = 'cursor';
      return config;
    }))).toThrow(/products\[0\]\.budget\.strictSpending: provider "cursor" does not support capability "token-limit"/);
  });

  it('rejects an unacknowledged authority relaxation instead of widening it silently', () => {
    expect(() => resolveFactoryConfig(withConfig((config) => {
      config.products[0].overrides = {
        authority: { mergeAuthority: 'coordinator' },
      };
      return config;
    }))).toThrow(/products\[0\]\.overrides\.authority\.mergeAuthority: relaxation requires a non-empty risk acknowledgement/);
  });

  it('requires an acknowledgement before granting a deployment permission', () => {
    expect(() => resolveFactoryConfig(withConfig((config) => {
      config.products[0].overrides = {
        authority: { allowPreviewDeployment: true },
      };
      return config;
    }))).toThrow(/products\[0\]\.overrides\.authority\.allowPreviewDeployment: relaxation requires a non-empty risk acknowledgement/);
  });

  it('treats an explicit empty environment id as invalid instead of inheriting a default', () => {
    expect(() => resolveFactoryConfig(withConfig((config) => {
      config.products[0].overrides = { environmentId: '' };
      return config;
    }))).toThrow(/products\[0\]\.overrides\.environmentId: must be a non-empty string/);
  });

  it('loads the documented solo and multi-product configurations', async () => {
    const exampleDirectory = new URL('../../examples/config/', import.meta.url);
    const solo = JSON.parse(await readFile(new URL('solo.json', exampleDirectory), 'utf8'));
    const multiProduct = JSON.parse(await readFile(new URL('multi-product.json', exampleDirectory), 'utf8'));

    expect(resolveFactoryConfig(solo).products).toHaveLength(1);
    const resolvedMultiProduct = resolveFactoryConfig(multiProduct);
    expect(resolvedMultiProduct.products).toHaveLength(2);
    expect(resolvedMultiProduct.pods).toHaveLength(1);
  });

  it('exposes structured validation errors for programmatic callers', () => {
    try {
      resolveFactoryConfig({});
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.issues[0]).toEqual(expect.objectContaining({ path: 'factory' }));
    }
  });
});
