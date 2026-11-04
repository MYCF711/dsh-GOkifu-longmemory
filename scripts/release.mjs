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
// 2026-11-04（0.143.x）：只看**已跟踪文件**的改动。未跟踪文件是并行队友正在写的 WIP，
// 它们进不了本次 commit、也进不了 tag 指向的树 —— 用它挡发布属于误伤（今晚真被挡了一次）。
const dirty = out('git status --porcelain').split('\n').filter((l) => l && !l.startsWith('??'));
if (dirty.length) { console.error(`release: 工作树不干净（已跟踪文件有改动）：${dirty.join(' | ')}`); process.exit(1); }
const untracked = out('git status --porcelain').split('\n').filter((l) => l.startsWith('??'));
if (untracked.length) console.log(`release: 注意 —— 有 ${untracked.length} 个未跟踪文件（队友 WIP），不计入本次发布`);
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
try {
  out('node scripts/ledger-check.mjs --full');
} catch (error) {
  console.error('release: ledger-check --full 失败（台账与实测不一致或时点过旧）。先跑 node scripts/ledger-sync.mjs 再发版。');
  process.exit(1);
}

// tag 审计（2026-11-04 教训，0.118.0）：`v0.116.0` 曾指到 PR 前的分支提交 —— 那个提交的内容已是 0.117.0。
// tag 名 / 内容版本 / Release 标题三者互不对应，而 check / ledger-check / CI 全都只看工作树，看不见 tag。
try {
  out('node scripts/tag-audit.mjs --quiet');
} catch {
  console.error('release: tag 审计未通过（有 tag 与内容版本错位）。先跑 node scripts/tag-audit.mjs 看明细，修好再发版。');
  process.exit(1);
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
// 2026-11-03：GitHub API 会间歇 502/503，发布步骤必须自带重试，且失败信息要可读。
function createRelease(tag, notesPath) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      run(`gh release create ${tag} --title ${tag} --notes-file "${notesPath}"`);
      return true;
    } catch (error) {
      const msg = String(error?.stderr ?? error?.message ?? error).split(String.fromCharCode(10)).filter(Boolean).slice(0, 2).join(' | ');
      console.error(`release: 第 ${attempt} 次创建 Release 失败：${msg.slice(0, 240)}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000 * attempt);
    }
  }
  return false;
}

if (!createRelease(tag, notesPath)) {
  console.error(`release: tag ${tag} 已推出，但 GitHub Release 未能创建（API 持续故障）。恢复后运行：`);
  console.error(`  gh release create ${tag} --title ${tag} --notes-file "${notesPath}"`);
  process.exit(0);
}
console.log(`released ${tag} (no npm publish)`);
