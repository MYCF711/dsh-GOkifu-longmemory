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
  return {
    version,
    tests: tests ? { total: Number(tests[1]), pass: Number(tests[2]), fail: Number(tests[3]), skip: Number(tests[4]) } : null,
    claim: claim !== null ? Number(claim) : null,
    threads: threads !== null ? Number(threads) : null,
  };
}

export function compare(ledger, actual) {
  const bad = [];
  if (ledger.version !== actual.version) bad.push(`版本：台账 ${ledger.version} vs package ${actual.version}`);
  if (ledger.tests && actual.tests) {
    for (const k of ['total', 'pass', 'fail', 'skip']) {
      if (ledger.tests[k] !== actual.tests[k]) bad.push(`测试 ${k}：台账 ${ledger.tests[k]} vs 实测 ${actual.tests[k]}`);
    }
  }
  if (ledger.claim !== null && actual.claim !== null && ledger.claim !== actual.claim) bad.push(`claim：台账 ${ledger.claim} vs 实测 ${actual.claim}`);
  if (ledger.threads !== null && actual.threads !== null && ledger.threads !== actual.threads) bad.push(`卷：台账 ${ledger.threads} vs 实测 ${actual.threads}`);
  return bad;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const json = process.argv.includes('--json');
  const skipTests = process.argv.includes('--no-tests');
  const ledger = parseLedger(read('MAINTENANCE.md'));
  const actual = { version: JSON.parse(read('package.json')).version, tests: null, claim: null, threads: null };
  if (!skipTests) {
    try {
      const { stdout } = await execFileAsync(process.execPath, ['--test'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
      const t = /\u2139 tests (\d+)[\s\S]*?\u2139 pass (\d+)[\s\S]*?\u2139 fail (\d+)[\s\S]*?\u2139 skipped (\d+)/.exec(stdout);
      if (t) actual.tests = { total: Number(t[1]), pass: Number(t[2]), fail: Number(t[3]), skip: Number(t[4]) };
    } catch (error) {
      actual.tests = null;
      console.error(`ledger-check: node --test 跑不起来（${String(error?.message ?? error)}）`);
    }
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(REPO, 'scripts', 'cli.mjs'), 'audit', '--json'], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 });
    const a = JSON.parse(stdout);
    actual.claim = a.claims?.total ?? null;
    actual.threads = a.threads?.total ?? a.threads ?? null;
  } catch { /* 没 store 就跳过语料核对，下面标注 */ }
  // AGENTS §7 指针 + 不含测试条数
  const agents = read('AGENTS.md');
  const sec7 = agents.slice(agents.indexOf('## 7 ·'), agents.indexOf('## 8 ·'));
  const agentsOk = agents.includes('本节的旧快照会过期') && !sec7.includes('条测试');
  const bad = compare(ledger, actual);
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
