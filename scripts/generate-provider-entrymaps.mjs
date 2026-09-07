import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'provider-entrymaps', 'source.json');
const outputDir = path.join(root, 'provider-entrymaps', 'generated');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const lines = ['# Faktori provider entry map', '', `Shared lifecycle source: [${source.sharedSource}](../../${source.sharedSource})`, '', 'Skills:'];
for (const skill of source.skills) lines.push(`- [${skill}](../../skills/${skill}/SKILL.md)`);
lines.push('', '## Select only the needed skill', '', 'Use the same canonical skill on every provider. Load its referenced resources only when applicable. Do not run every skill for every task. Skill instructions do not grant runtime or publishing authority.', '', '| Request | Skill |', '| --- | --- |');
for (const route of source.routes ?? []) lines.push(`| ${route.when}${route.skipWhen ? ` Skip when: ${route.skipWhen}` : ''} | [${route.skill}](../../skills/${route.skill}/SKILL.md) |`);
lines.push('', 'Read [skill kit operation](../../docs/skills.md) for installation, handoffs, and evidence limits. Resolve these links relative to this file, not the product checkout.');
lines.push('', 'Provider entry:');
for (const [provider, value] of Object.entries(source.providers)) lines.push(`- **${provider}**: ${value.entry}`);
const body = `${lines.join('\n')}\n`;

function expected(provider) {
  return `# Faktori ${provider} entry map\n\n${body}`;
}

const check = process.argv.includes('--check');
const failures = [];
for (const provider of Object.keys(source.providers).sort()) {
  const target = path.join(outputDir, `${provider}.md`);
  const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (actual !== expected(provider)) failures.push(path.relative(root, target));
  if (!check) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(target, expected(provider));
  }
}
if (check && failures.length) {
  console.error(`Provider entry maps drifted: ${failures.join(', ')}`);
  process.exitCode = 1;
} else if (check) {
  console.log('Provider entry maps are current.');
}
