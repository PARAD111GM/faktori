#!/usr/bin/env node
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill resource must not be a symlink: ${path}`);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
    else throw new Error(`Unsupported skill resource: ${path}`);
  }
  return output;
}

/** Validate the source or installed kit without writing or executing skill content. */
export async function verifySkillKit(root) {
  const source = JSON.parse(await readFile(join(root, 'provider-entrymaps/source.json'), 'utf8'));
  if (!Array.isArray(source.skills) || new Set(source.skills).size !== source.skills.length) throw new Error('Invalid skill catalog');
  const directories = (await readdir(join(root, 'skills'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (JSON.stringify(directories) !== JSON.stringify([...source.skills].sort())) throw new Error('Catalog and shipped skills disagree');
  for (const skill of source.skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) throw new Error('Unsafe skill directory');
    const directory = resolve(root, 'skills', skill);
    const body = await readFile(join(directory, 'SKILL.md'), 'utf8');
    const header = body.match(/^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/);
    if (!header || header[1] !== `faktori-${skill}` || !/This skill should be used when/i.test(header[2])) throw new Error(`Invalid trigger metadata: ${skill}`);
    if (body.split(/\s+/).length >= 5000 || /\[TODO:|Structuring This Skill|This is a placeholder/.test(body)) throw new Error(`Unfinished or oversized skill: ${skill}`);
    for (const file of await files(directory)) {
      if (!file.endsWith('.md')) continue;
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (/^https?:\/\//.test(target) || target.startsWith('#')) continue;
        const path = resolve(dirname(file), target.split('#')[0]);
        const within = relative(directory, path);
        if (within === '..' || within.startsWith(`..${sep}`) || resolve(path) === resolve(directory, '..')) throw new Error(`Skill link escapes its distributable: ${file}: ${target}`);
        try { if (!(await lstat(path)).isFile()) throw new Error('not a file'); }
        catch { throw new Error(`Missing skill resource: ${file}: ${target}`); }
      }
    }
  }
  for (const route of source.routes ?? []) if (!source.skills.includes(route.skill) || !route.when) throw new Error('Invalid skill route');
  if (source.skills.includes('update')) {
    for (const entry of ['.claude/commands/faktori-update.md', '.cursor/commands/faktori-update.md', '.agents/skills/faktori-update/SKILL.md']) {
      const body = await readFile(join(root, entry), 'utf8');
      if (!body.includes('skills/update/SKILL.md')) throw new Error(`Update entry does not load canonical skill: ${entry}`);
    }
  }
  const providers = Object.keys(source.providers).sort();
  for (const provider of providers) {
    const path = join(root, 'provider-entrymaps/generated', `${provider}.md`);
    const map = await readFile(path, 'utf8');
    for (const skill of source.skills) if (!map.includes(`../../skills/${skill}/SKILL.md`)) throw new Error(`Missing ${skill} in ${provider} map`);
  }
  return { skills: [...source.skills], providers };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifySkillKit(resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')));
    console.log(`Skill kit verified: ${result.skills.length} skills; ${result.providers.join(', ')} entry maps.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
