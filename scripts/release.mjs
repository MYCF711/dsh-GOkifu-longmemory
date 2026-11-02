#!/usr/bin/env node
// 受控发布：只发 GitHub Release + annotated tag，不发 npm。
// 用法：node scripts/release.mjs [--dry-run]
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dry = process.argv.includes('--dry-run');
const requireCi = process.argv.includes('--require-ci');
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

// 必需检查：CI 结论必须成功（--require-ci 时阻断；否则只告警）
try {
  const headSha = out('git rev-parse HEAD');
  const raw = execSync(`gh run list --commit ${headSha} --limit 1 --json conclusion,status,workflowName`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const runs = JSON.parse(raw);
  const latest = Array.isArray(runs) ? runs[0] : null;
  if (!latest) {
    console.warn('release: 该提交没有 CI 运行记录');
    if (requireCi) process.exit(1);
  } else if (latest.conclusion !== 'success') {
    console.warn(`release: CI 结论是 ${latest.conclusion ?? latest.status}（${latest.workflowName}）`);
    if (requireCi) { console.error('release: --require-ci 要求 CI 成功，已中止'); process.exit(1); }
  } else {
    console.log(`release: CI 通过（${latest.workflowName}）`);
  }
} catch (error) {
  console.warn(`release: 无法查询 CI（${String(error?.message ?? error).slice(0, 120)}）`);
  if (requireCi) process.exit(1);
}
if (out('git tag -l ' + tag)) { console.error(`release: tag ${tag} 已存在`); process.exit(1); }

// 台账自证（2026-11-02 audit-02 教训）：发版前必须证明 MAINTENANCE 的数字能复现。
if (!process.argv.includes('--no-ledger')) {
  try {
    out('node scripts/ledger-check.mjs --no-tests');
  } catch (error) {
    console.error('release: ledger-check 失败（台账与实测不一致），先修台账再发版；确需跳过用 --no-ledger');
    process.exit(1);
  }
}

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
