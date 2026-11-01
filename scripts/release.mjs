#!/usr/bin/env node
// 受控发布：只发 GitHub Release + annotated tag，不发 npm。
// 用法：node scripts/release.mjs [--dry-run]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dry = process.argv.includes('--dry-run');
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tag = `v${pkg.version}`;

const branch = out('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') { console.error(`release: 必须在 main 上（当前 ${branch}）`); process.exit(1); }
if (out('git status --porcelain')) { console.error('release: 工作树不干净'); process.exit(1); }
run('git fetch origin main');
if (out('git rev-parse HEAD') !== out('git rev-parse origin/main')) {
  console.error('release: HEAD 与 origin/main 不一致'); process.exit(1);
}
run('node scripts/check.mjs');
if (out('git tag -l ' + tag)) { console.error(`release: tag ${tag} 已存在`); process.exit(1); }

const notes = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  .split('\n').slice(1).join('\n');

if (dry) { console.log(`[dry-run] git tag -a ${tag} -m ${tag}`); console.log(`[dry-run] git push origin ${tag}`); console.log(`[dry-run] gh release create ${tag} --title ${tag} --notes <CHANGELOG>`); process.exit(0); }

run(`git tag -a ${tag} -m ${tag}`);
run(`git push origin ${tag}`);
run(`gh release create ${tag} --title ${tag} --notes-file <(sed -n '/## ${pkg.version}/,/^## /p' CHANGELOG.md)`);
console.log(`released ${tag} (no npm publish)`);
