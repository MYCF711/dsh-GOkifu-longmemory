#!/usr/bin/env node
// 台账自证（2026-11-02 audit-02 教训）：MAINTENANCE.md 里写的数字，必须能被命令当场复现。
// 两轮审计都栽在"文档说了不实的话"，所以把它机械化：数字对不上就退出 1。
//
// 核对项：
//   1. 版本：`main = X.Y.Z` 必须等于 package.json 的 version
//   2. 测试：`**N 条**（P pass / F fail / S skip）` 必须等于 `node --test` 实测
//   3. 语料：`claim N` / `**N 卷**` 必须等于 `cli audit --json`
//   4. AGENTS §7 仍是指针、且不含"条测试"
//   5. 发布物：CHANGELOG 有当前版本段（check.mjs 已覆盖，这里再守一次）
//
// 用法：node scripts/ledger-check.mjs [--json] [--no-tests]（--no-tests 跳过较慢的 node --test）
// 退出码：0 全部一致；1 有不一致；2 环境不齐（没有 store 时只跳过语料项并标注）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

export function parseLedger(text) {
  const version = /main\s*=\s*(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
  const tests = /\*\*(\d+)\s*条\*\*（(\d+)\s*pass\s*\/\s*(\d+)\s*fail\s*\/\s*(\d+)\s*skip）/.exec(text);
  const claim = /claim\s*(\d+)/.exec(text)?.[1] ?? null;
  const threads = /\*\*(\d+)\s*卷\*\*/.exec(text)?.[1] ?? null;
  const episodes = /\|\s*语料\s*\|\s*(\d+)\s*局/.exec(text)?.[1] ?? null;
  const a2 = /A2\s*\*\*(\d+(?:\.\d+)?)%\*\*/.exec(text)?.[1] ?? null;
  const a4 = /A4\s*p50\s*\*\*(\d+(?:\.\d+)?)ms[^*]*\*\*/.exec(text)?.[1] ?? null;
  const stampText = /\[本\]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(text)?.[1] ?? null;
  return {
    version,
    tests: tests ? { total: Number(tests[1]), pass: Number(tests[2]), fail: Number(tests[3]), skip: Number(tests[4]) } : null,
    claim: claim !== null ? Number(claim) : null,
    threads: threads !== null ? Number(threads) : null,
    episodes: episodes !== null ? Number(episodes) : null,
    a2: a2 !== null ? Number(a2) : null,
    a4: a4 !== null ? Number(a4) : null,
    stamp: stampText,
  };
}

export function compare(ledger, actual) {
  const has = (v) => Number.isFinite(v);
  const bad = [];
  if (ledger.version && actual.version && ledger.version !== actual.version) bad.push(`版本：台账 ${ledger.version} vs package ${actual.version}`);
  if (ledger.tests && actual.tests) {
    for (const k of ['total', 'pass', 'fail', 'skip']) {
      if (ledger.tests[k] !== actual.tests[k]) bad.push(`测试 ${k}：台账 ${ledger.tests[k]} vs 实测 ${actual.tests[k]}`);
    }
  }
  if (has(ledger.claim) && has(actual.claim) && ledger.claim !== actual.claim) bad.push(`claim：台账 ${ledger.claim} vs 实测 ${actual.claim}`);
  if (has(ledger.threads) && has(actual.threads) && ledger.threads !== actual.threads) bad.push(`卷：台账 ${ledger.threads} vs 实测 ${actual.threads}`);
  if (has(ledger.episodes) && has(actual.episodes) && ledger.episodes !== actual.episodes) bad.push(`局数：台账 ${ledger.episodes} vs 实测 ${actual.episodes}`);
  // 波动量给容差（同一命令两次测量：A4 p50 抖 ±0.5ms，A2 随语料微动 ±0.5pp）
  // A2 在 26.5–26.8% 之间随 pipeline 时间窗微动（2026-11-02 实测抖动 ±0.15pp）⇒ 容差 0.5pp
  if (has(ledger.a2) && has(actual.a2) && Math.abs(ledger.a2 - actual.a2) > 0.5) bad.push(`A2：台账 ${ledger.a2}% vs 实测 ${actual.a2}%（容差 0.5pp）`);
  // A4 单次抖动可达 ±2ms（GC/冷热），台账写的是 3 次中位数 ⇒ 容差 3ms（已在台账注明）
  if (has(ledger.a4) && has(actual.a4) && Math.abs(ledger.a4 - actual.a4) > 3) bad.push(`A4 p50：台账 ${ledger.a4}ms vs 实测 ${actual.a4}ms（容差 3ms，单次抖动）`);
  return bad;
}

/** --full 的加严项：缺测点/陈旧/解析失败都算不一致（fail-closed）。 */
export function fullCheck(ledger, bad, { now = Date.now() } = {}) {
  const out = [...bad];
  if (ledger.tests === null) out.push('台账缺测试行');
  if (ledger.stamp === null) out.push('台账缺 [本] 时点');
  else {
    const t = Date.parse(`${ledger.stamp.replace(' ', 'T')}:00`);
    if (!Number.isFinite(t)) out.push(`台账时点不可解析：${ledger.stamp}`);
    else if (now - t > 20 * 60 * 1000) out.push(`台账时点过旧：${ledger.stamp}（>20 分钟，先跑 ledger-sync）`);
  }
  if (ledger.a2 === null || ledger.a4 === null) out.push('台账缺 A2/A4 实测值');
  if (ledger.episodes === null) out.push('台账缺局数');
  return out;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const json = process.argv.includes('--json');
  const full = process.argv.includes('--full');
  const skipTests = process.argv.includes('--no-tests') && !full;
  let badParseTests = false;
  const ledger = parseLedger(read('MAINTENANCE.md'));
  const actual = { version: JSON.parse(read('package.json')).version, tests: null, claim: null, threads: null, episodes: null, a2: null, a4: null };
  if (!skipTests) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['--test'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
      const t = /\u2139 tests (\d+)[\s\S]*?\u2139 pass (\d+)[\s\S]*?\u2139 fail (\d+)[\s\S]*?\u2139 skipped (\d+)/.exec(stdout);
      if (t) actual.tests = { total: Number(t[1]), pass: Number(t[2]), fail: Number(t[3]), skip: Number(t[4]) };
      else badParseTests = true;
    } catch (error) {
      // node --test 有失败用例时 execFile 会抛错，但 stdout 里仍有计数 —— 必须解析，不能当 n/a
      const text = String(error?.stdout ?? '');
      const t = /ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)[\s\S]*?ℹ skipped (\d+)/.exec(text);
      if (t) actual.tests = { total: Number(t[1]), pass: Number(t[2]), fail: Number(t[3]), skip: Number(t[4]) };
      else { actual.tests = null; badParseTests = true; }
      console.error(`ledger-check: node --test 有失败或解析失败（${String(error?.message ?? error).slice(0, 80)}）`);
    }
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(REPO, 'scripts', 'cli.mjs'), 'audit', '--json'], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 });
    const a = JSON.parse(stdout);
    actual.claim = a.claims?.total ?? null;
    actual.threads = a.threads?.total ?? a.threads ?? null;
  } catch { /* 没 store 就跳过语料核对，下面标注 */ }
  try {
    const { createStore } = await import('../src/rooms/persist.mjs');
    actual.episodes = createStore({ root: path.join(HOME, 'memory-context') }).list('episodes').length;
  } catch { actual.episodes = null; }
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(REPO, 'scripts', 'm5-report.mjs'), '--json'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
    const j = JSON.parse(stdout);
    const a2 = j.axes?.A2?.value;
    const a4 = j.axes?.A4?.value;
    actual.a2 = Number.isFinite(a2) ? Number((a2 * 100).toFixed(2)) : null;
    actual.a4 = Number.isFinite(a4) ? Number(a4.toFixed(2)) : null;
  } catch { actual.a2 = null; actual.a4 = null; }
  // 安装指南不得写死版本号/测试条数（2026-11-02 audit-04：这正是「按它安装」最先读到的文件）
  try {
    const guide = read('docs/安装指南.md');
    if (/\d+\.\d+\.\d+/.test(guide)) bad.push('docs/安装指南.md：不要写死版本号（指向 MAINTENANCE）');
    if (/\d+\s*条/.test(guide)) bad.push('docs/安装指南.md：不要写死测试条数（指向 MAINTENANCE）');
  } catch { /* 没这文件就不管 */ }
  // AGENTS §7 指针 + 不含测试条数
  const agents = read('AGENTS.md');
  const sec7 = agents.slice(agents.indexOf('## 7 ·'), agents.indexOf('## 8 ·'));
  const agentsOk = agents.includes('本节的旧快照会过期') && !sec7.includes('条测试');
  let bad = compare(ledger, actual);
  if (badParseTests) bad.push('测试计数解析失败（fail-closed）');
  if (full) bad = fullCheck(ledger, bad);
  if (!agentsOk) bad.push('AGENTS §7：指针缺失或写回了测试条数');
  if (!read('CHANGELOG.md').includes(`## ${actual.version}`)) bad.push(`CHANGELOG 缺 ${actual.version} 段`);

  const out = { ledger, actual, agentsOk, skippedCorpus: actual.claim === null, ok: bad.length === 0, bad };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`ledger-check：台账 ${ledger.version} · 测试 ${ledger.tests ? `${ledger.tests.total}/${ledger.tests.pass}/${ledger.tests.fail}/${ledger.tests.skip}` : 'n/a'} · claim ${ledger.claim} · 卷 ${ledger.threads}${out.skippedCorpus ? '（无 store，跳过语料核对）' : ''}`);
    console.log(`实测：版本 ${actual.version} · 测试 ${actual.tests ? `${actual.tests.total}/${actual.tests.pass}/${actual.tests.fail}/${actual.tests.skip}` : 'n/a'} · claim ${actual.claim} · 卷 ${actual.threads}`);
    for (const b of bad) console.error(`ERR ${b}`);
    console.log(out.ok ? 'ledger-check: PASS' : 'ledger-check: FAIL（台账与实测不一致）');
  }
  process.exit(out.ok ? 0 : 1);
}
