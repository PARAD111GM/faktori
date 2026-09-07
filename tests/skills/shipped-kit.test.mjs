import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifySkillKit } from '../../scripts/verify-skill-kit.mjs';

describe('shipped skill kit', () => {
  it('ships every routed skill with usable, self-contained resources', async () => {
    const result = await verifySkillKit(process.cwd());
    expect(result.skills).toHaveLength(15);
    expect(result.providers).toEqual(['claude', 'codex', 'cursor']);
  });

  it('rejects an unresolved resource instead of packaging a broken playbook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'faktori-skill-contract-'));
    try {
      await mkdir(join(root, 'skills', 'test'), { recursive: true });
      await mkdir(join(root, 'provider-entrymaps'), { recursive: true });
      await writeFile(join(root, 'provider-entrymaps', 'source.json'), JSON.stringify({ skills: ['test'], providers: {} }));
      await writeFile(join(root, 'skills', 'test', 'SKILL.md'), '---\nname: faktori-test\ndescription: This skill should be used when verifying a change.\n---\n# Test\nRead [evidence](assets/missing.md).\n');
      await expect(verifySkillKit(root)).rejects.toThrow(/missing.md/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves a route for each lifecycle outcome without requiring every skill per task', async () => {
    const source = JSON.parse(await readFile('provider-entrymaps/source.json', 'utf8'));
    for (const stage of ['plan', 'design', 'build', 'test', 'deploy', 'maintain']) {
      expect(source.routes.some((route) => route.skill === stage)).toBe(true);
    }
    expect(source.routes.find((route) => route.skill === 'interview').skipWhen).toBeTruthy();
    expect(source.routes.find((route) => route.skill === 'review').when).toBeTruthy();
  });
});
