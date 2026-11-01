#!/usr/bin/env node
// 受控发布：只发 GitHub Release + annotated tag，不发 npm。
// 用法：node scripts/release.mjs [--dry-run]
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// 从 CHANGELOG 抽出当前版本段落作为 release notes
const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith(`## ${pkg.version}`));
if (start < 0) { console.error(`release: CHANGELOG 缺 ${pkg.version} 段`); process.exit(1); }
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith('## ')) { end = i; break; }
const dir = mkdtempSync(join(tmpdir(), 'kifuin-rel-'));
const notesPath = join(dir, 'notes.md');
writeFileSync(notesPath, lines.slice(start, end).join('\n'));

if (dry) {
  console.log(`[dry-run] git tag -a ${tag} -m ${tag}`);
  console.log(`[dry-run] git push origin ${tag}`);
  console.log(`[dry-run] gh release create ${tag} --title ${tag} --notes-file ${notesPath}`);
  process.exit(0);
}

run(`git tag -a ${tag} -m ${tag}`);
run(`git push origin ${tag}`);
run(`gh release create ${tag} --title ${tag} --notes-file ${notesPath}`);
console.log(`released ${tag} (no npm publish)`);
