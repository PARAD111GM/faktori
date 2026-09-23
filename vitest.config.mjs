import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real subprocess/native-install journeys contend on the host. Bound test
    // concurrency below the installation ceiling; product limits are separate.
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['tests/**/*.test.mjs'],
    exclude: ['fixtures/**', 'node_modules/**'],
  },
});
