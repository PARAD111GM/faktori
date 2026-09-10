import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Match INSTALL.md's bounded concurrency; real subprocess journeys can
    // exceed Vitest's 5s default. Product execution limits remain separate.
    maxWorkers: 4,
    testTimeout: 15_000,
    include: ['tests/**/*.test.mjs'],
    exclude: ['fixtures/**', 'node_modules/**'],
  },
});
