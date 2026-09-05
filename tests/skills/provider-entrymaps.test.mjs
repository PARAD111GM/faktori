import { execFileSync } from 'node:child_process';
import { describe, it } from 'vitest';

describe('provider entry maps', () => {
  it('are generated from the maintained source without drift', () => {
    execFileSync(process.execPath, ['scripts/generate-provider-entrymaps.mjs', '--check'], { cwd: process.cwd(), stdio: 'inherit' });
  });
});
