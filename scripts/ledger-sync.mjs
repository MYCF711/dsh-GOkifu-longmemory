#!/usr/bin/env node
// 台账同步（2026-11-02 audit-03）：把 MAINTENANCE.md 的「测试 / 六轴 / 语料」三行
// 用现场实测值重写，并打上真实时点。人工抄数字 = 漂移之源，这里换成生成。
//
// 用法：node scripts/ledger-sync.mjs [--dry-run]
// 之后：node scripts/ledger-check.mjs --full 校验；发版闸会强制跑 --full。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const dry = process.argv.includes('--dry-run');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const pct = (x, digits = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : 'n/a');

/**
 * 测试口径（T224）：**与 CI 完全一致** —— `node --test "test/*.test.mjs"`（glob 由 node 自己展开，不经 shell）。
 *
 * 为什么不用裸 `--test`（2026-11-05 发版卡住的根因）：
 *   ① 裸 `--test` 按"test 目录"约定递归发现 `test/` 下的全部 `.mjs`，把**不是测试的辅助脚本**
 *      （如 `test/run.mjs`）也算成一条 ⇒ 比 CI 多 1 条（760 vs 759），台账永远对不上；
 *   ② 它还会递归进 `tmp/`，把 agent 留下的**旧契约测试副本**（`tmp/` 下的 `*.test.mjs`）再跑一遍
 *      —— 那些副本里的红是"已被新契约取代"的，不是真红。
 * 所以两个脚本（sync / check）统一用这个 glob，且都不许再出现裸 `['--test']`。
 */
const TEST_GLOB = 'test/*.test.mjs';

/**
 * `tmp/` 下的 `*.test.mjs` 一律**不计入**：返回相对路径，调用方告警。
 * 让 CI 红的是守卫 `test/ledger-tmp-guard.test.mjs`（本脚本只负责"不把它算进台账"）。
 */
function findTmpTestCopies() {
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(path.relative(REPO, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(REPO, 'tmp'));
  return out;
}

async function measure() {
  const out = {};
  const copies = findTmpTestCopies();
  if (copies.length > 0) {
    console.error(`ledger-sync: 发现 tmp/ 下 ${copies.length} 个 *.test.mjs（旧契约副本）——已跳过、不计入：${copies.slice(0, 3).join(', ')}${copies.length > 3 ? ' …' : ''}`);
  }
  try {
    const r = await execFileAsync(process.execPath, ['--test', TEST_GLOB], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    const t = /\u2139 tests (\d+)[\s\S]*?\u2139 pass (\d+)[\s\S]*?\u2139 fail (\d+)[\s\S]*?\u2139 skipped (\d+)/.exec(r.stdout);
    out.tests = t ? { total: +t[1], pass: +t[2], fail: +t[3], skip: +t[4] } : null;
  } catch (error) {
    const text = String(error?.stdout ?? '');
    const t = /\u2139 tests (\d+)[\s\S]*?\u2139 pass (\d+)[\s\S]*?\u2139 fail (\d+)[\s\S]*?\u2139 skipped (\d+)/.exec(text);
    out.tests = t ? { total: +t[1], pass: +t[2], fail: +t[3], skip: +t[4] } : null;
  }
  // 延迟抖动大（GC/冷热）：跑 3 次取中位数，并在台账注明
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    try {
      const r = await execFileAsync(process.execPath, [path.join(REPO, 'scripts', 'm5-report.mjs'), '--json'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
      runs.push(JSON.parse(r.stdout).axes ?? {});
    } catch { /* 单次失败忽略 */ }
  }
  if (runs.length === 0) out.axes = null;
  else {
    const pick = (key, field = 'value') => {
      const vals = runs.map((x) => x?.[key]?.[field]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
      return vals.length ? vals[Math.floor(vals.length / 2)] : undefined;
    };
    out.axes = { ...runs[0] };
    for (const key of ['A1', 'A2', 'A4', 'A5', 'A6']) {
      const v = pick(key);
      if (v !== undefined) out.axes[key] = { ...out.axes[key], value: v };
    }
  }
  try {
    const r = await execFileAsync(process.execPath, [path.join(REPO, 'scripts', 'cli.mjs'), 'audit', '--json'], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 });
    out.audit = JSON.parse(r.stdout);
  } catch { out.audit = null; }
  // 局数：audit 不提供，直接读 store（只读）
  try {
    const { createStore } = await import('../src/rooms/persist.mjs');
    const store = createStore({ root: path.join(HOME, 'memory-context') });
    out.episodes = store.list('episodes').length;
  } catch { out.episodes = null; }
  return out;
}

const m = await measure();
const at = stamp();
const lines = [];

if (m.tests) {
  lines.push({ key: '测试', text: `| 测试 | **${m.tests.total} 条**（${m.tests.pass} pass / ${m.tests.fail} fail / ${m.tests.skip} skip）[本] ${at} |` });
} else {
  console.error('ledger-sync: node --test 解析失败，保持原样');
}
const a = m.axes ?? {};
const a1Coverage = a.A1?.detail?.validityCoverage ?? null;
const a1Ratio = Number.isFinite(a1Coverage) ? a1Coverage : (Number.isFinite(a1Coverage?.ratio) ? a1Coverage.ratio : null);
const a1Note = a1Ratio === 0 ? `（空转：validity 覆盖 ${a1Coverage.withValidity ?? '?'} 中 0 条被渲染，0% 不代表无风险）` : '';
if (m.axes) {
  // T225：p50 是**统计量**（GC / 磁盘缓存 / 调度都会让它抖 5–10ms），台账与实测**不做绝对相等比对**，
  // 只按量级校验（`ledger-check.mjs` 的 `a4MagnitudeOk`：台账 ≤ max(实测×2, 实测+20ms)，且实测 ≤ 50ms）。
  // 这句跟着模板走，否则下次 sync 就把台账行旁那行注记擦掉了。
  lines.push({ key: '六轴', text: `| 六轴 | A1 **${pct(a.A1?.value)}${a1Note}** · A2 **${pct(a.A2?.value)}** · A3 ${a.A3?.status ?? 'n/a'} · A4 p50 **${Number.isFinite(a.A4?.value) ? a.A4.value.toFixed(2) + 'ms' : 'n/a'}（3 次中位数，单次抖动 ±2ms）**（p50 是抖动量，按量级校验：台账 ≤ max(实测×2, 实测+20ms)） · A5 **${pct(a.A5?.value)}** · A6 **${pct(a.A6?.value)}** \`[本] ${at} · node scripts/m5-report.mjs\` |` });
}
const au = m.audit;
if (au && Number.isFinite(m.episodes)) {
  lines.push({ key: '语料', text: `| 语料 | ${m.episodes} 局 / **${au.threads?.total ?? au.threads} 卷** / **claim ${au.claims?.total ?? '?'}**（有效期已止 ${au.claims?.expired ?? '?'}；26 条为 0.58 前历史记录，无 \`validFrom\` 但都有 \`occurredAt\`，归档不回溯改写）\`[本] ${at} · node scripts/cli.mjs audit + store\` |` });
} else {
  console.error('ledger-sync: cli audit 不可用（无 store？），语料行保持原样');
}

const file = path.join(REPO, 'MAINTENANCE.md');
const rows = new Map(lines.map((r) => [r.key, r.text]));
// 行级重写（不用正则替换：replacement 里的反引号/$ 会触发 replace 的特殊展开）
const original = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10));
const kept = [];
let corpusInserted = false;
for (const line of original) {
  const key = rows.size ? [...rows.keys()].find((k) => line.startsWith(`| ${k} |`)) : null;
  if (!key) { kept.push(line); continue; }
  if (key === '语料') {
    if (!corpusInserted) { kept.push(rows.get('语料')); corpusInserted = true; }
    continue;
  }
  kept.push(rows.get(key)); // 测试 / 六轴：用新行替换旧行
}
if (!corpusInserted && rows.has('语料')) {
  const idx = kept.findIndex((l) => l.startsWith('| 当天覆盖 |'));
  kept.splice(idx >= 0 ? idx : kept.length, 0, rows.get('语料'));
}
const text = kept.join(String.fromCharCode(10));
if (dry) {
  for (const r of lines) console.log(`[dry-run] ${r.text}`);
} else {
  fs.writeFileSync(file, text);
  for (const r of lines) console.log(`synced ${r.key} @ ${at}`);
}
