#!/usr/bin/env node
/**
 * gate.mjs —— **一条命令跑完全部门禁**（重构 A 期，docs/重构-繁复收敛.md §2 M5 / §4 期 A）。
 *
 * 为什么要有它：交付前要跑的东西散在六条命令里（check / 全量单测 / patrol / metrics-guard /
 * ledger-check --full / tag-audit），命令与顺序靠人记 —— 漏跑一条就等于没验，而"全绿"又说不清
 * 到底跑了哪几条。这里把它们收成一条，逐门打印 PASS/FAIL + 耗时，末尾聚合退出码。
 *
 * **本文件只封装，不改任何判据**：
 *   · 红/绿一律由各门自己的脚本决定（退出码 + 该门自己打印的通过标记）；
 *   · 这里不做任何加减、不重写门槛、不跳过任何门；
 *   · 每门除了退出码 0，还要求输出里出现该门自己的通过标记 —— 光有退出码 0 不算过：
 *     「命令没报错但什么都没检查」也是一种红（fail-closed）。
 *   · 每门有进程级超时上限（timeoutMs）。超时按失败算，理由同上：挂住 = 没验出结论。
 *
 * 用法：
 *   node scripts/gate.mjs --fast                  # check + 单测（全量 test/*.test.mjs，排除真库 e2e）
 *   node scripts/gate.mjs --full                  # 全部门（默认；另加 patrol / metrics-guard / ledger-check --full / tag-audit）
 *   node scripts/gate.mjs --fast --only tests     # 只跑某一门（复现单门失败用；--only 支持逗号分隔多个）
 *   node scripts/gate.mjs --list                  # 只打印门清单，不跑
 *
 * 退出码：0 所选门全部通过；1 任一门失败/超时/判据消失；2 参数错误。
 *
 * 档位（与任务书一致）：
 *   --fast = `node scripts/check.mjs` + 相关单测（不含真库 e2e）
 *   --full = 再加 `node --test "test/*.test.mjs"`、`node scripts/patrol.mjs`、
 *            `node scripts/metrics-guard.mjs`、`node scripts/ledger-check.mjs --full`、`node scripts/tag-audit.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/** 与 CI / ledger-check / package.json 的测试口径完全一致（同一条 glob）。 */
export const TEST_GLOB = 'test/*.test.mjs';

/** fast 档排除的"真库 e2e"：跑起来会读本机真实 memory-context 的那些（按文件名 `*.e2e.test.mjs` 识别）。 */
export const FAST_E2E_PATTERN = /\.e2e\./;

const USAGE = [
  '用法：node scripts/gate.mjs [--fast | --full] [--only <id[,id]>] [--list]',
  '  --fast            快档：check + 单测（排除真库 e2e）',
  '  --full            全部门（默认）',
  '  --only <id,...>   只跑指定门（复现单门失败用）',
  '  --list            打印门清单后退出',
].join('\n');

const stripAnsi = (text) => String(text ?? '').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

/** 只给显示用：`node scripts/x.mjs --flag`。 */
const quoteArg = (arg) => (/[\s*?"'()]/.test(arg) ? `"${arg}"` : arg);
export function commandOf(gate, mode) {
  return ['node', ...gate.argv(mode)].map(quoteArg).join(' ');
}

/** 单测汇总（与 ledger-check / deliverability 同一套解析口径）。 */
export function parseTestSummary(text) {
  const m = /\u2139 tests (\d+)[\s\S]*?\u2139 pass (\d+)[\s\S]*?\u2139 fail (\d+)[\s\S]*?\u2139 skipped (\d+)/.exec(String(text ?? ''));
  if (!m) return null;
  return { total: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]), skip: Number(m[4]) };
}

/** fast 档的测试文件清单：test/*.test.mjs 减去 *.e2e.test.mjs（排序稳定，便于复现与断言）。 */
export function fastTestFiles({ testDir = path.join(ROOT, 'test') } = {}) {
  return fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith('.test.mjs') && !FAST_E2E_PATTERN.test(name))
    .sort()
    .map((name) => `test/${name}`);
}

/** 测试门的 node 参数：fast = 显式文件清单（不含 e2e）；full = 与 CI 同一条 glob。 */
export function testsArgv(mode) {
  if (mode === 'fast') {
    const files = fastTestFiles();
    if (files.length === 0) throw new Error('test/ 下没有可跑的单测（fast 档清单为空）');
    return ['--test', ...files];
  }
  return ['--test', TEST_GLOB];
}

/** 单测门判据：fail 必须 0、且至少跑了 1 条（0 条 = 没测）。 */
export function judgeTestOutput(out) {
  const s = parseTestSummary(out);
  if (s === null) return { ok: false, note: '输出里没有 node --test 汇总（判据消失？）' };
  const note = `tests ${s.total} · pass ${s.pass} · fail ${s.fail} · skip ${s.skip}`;
  return { ok: s.fail === 0 && s.total > 0, note };
}

/**
 * 门禁清单（顺序 = 从便宜到贵，失败先看到便宜的）。
 * `modes` 决定哪档跑它；`expect` 是该门自己的通过标记（正则或 `(out) => ({ ok, note })`）。
 * ★ 清单被 test/gate-runner.test.mjs 逐项钉死：删掉/改名/改命令都会红（tombstone）。
 */
export const GATES = Object.freeze([
  {
    id: 'check',
    name: '仓库自检（私有/版本/CHANGELOG/房间/脱敏/边界）',
    modes: Object.freeze(['fast', 'full']),
    argv: () => ['scripts/check.mjs'],
    repro: 'node scripts/check.mjs',
    expect: /check: PASS/,
    timeoutMs: 120_000,
  },
  {
    id: 'tests',
    name: '单测（fast=排除真库 e2e；full=node --test "test/*.test.mjs"）',
    modes: Object.freeze(['fast', 'full']),
    argv: (mode) => testsArgv(mode),
    repro: (mode) => (mode === 'fast' ? 'node scripts/gate.mjs --fast --only tests' : `node --test "${TEST_GLOB}"`),
    expect: judgeTestOutput,
    timeoutMs: 1_800_000,
  },
  {
    id: 'patrol',
    name: '巡检（心跳 + 宿主 A5/A6 + 主判据 A2b + 语义不变量 + 归并率）',
    modes: Object.freeze(['full']),
    argv: () => ['scripts/patrol.mjs'],
    repro: 'node scripts/patrol.mjs',
    // patrol 本身不设退出码（只打印结论表）⇒ 判据取它自己那行结论，不另立门槛。
    expect: (out) => {
      const plain = stripAnsi(out);
      if (/结论：.*全绿/.test(plain)) return { ok: true, note: '结论全绿' };
      const line = (plain.match(/结论：[^\n]*/) ?? [])[0];
      return { ok: false, note: line === undefined ? '输出里没有结论行（判据消失？）' : line.trim() };
    },
    timeoutMs: 3_600_000,
  },
  {
    id: 'metrics-guard',
    name: '指标护栏（A2b 主判据 + A1/A5/A6/A4 约束）',
    modes: Object.freeze(['full']),
    argv: () => ['scripts/metrics-guard.mjs'],
    repro: 'node scripts/metrics-guard.mjs',
    expect: /metrics-guard PASS/,
    timeoutMs: 3_600_000,
  },
  {
    id: 'ledger-check',
    name: '台账自证（版本/测试数/语料/发布物，--full）',
    modes: Object.freeze(['full']),
    argv: () => ['scripts/ledger-check.mjs', '--full'],
    repro: 'node scripts/ledger-check.mjs --full',
    expect: /ledger-check: PASS/,
    timeoutMs: 3_600_000,
  },
  {
    id: 'tag-audit',
    name: 'tag 审计（tag 名 ⇔ 提交里的 version）',
    modes: Object.freeze(['full']),
    argv: () => ['scripts/tag-audit.mjs'],
    repro: 'node scripts/tag-audit.mjs',
    expect: /tag-audit: PASS/,
    timeoutMs: 600_000,
  },
]);

export const MODES = Object.freeze(['fast', 'full']);

/** 档位 ⇒ 门清单。 */
export function selectGates(mode) {
  if (!MODES.includes(mode)) throw new Error(`未知档位：${mode}`);
  return GATES.filter((gate) => gate.modes.includes(mode));
}

export function reproOf(gate, mode) {
  return typeof gate.repro === 'function' ? gate.repro(mode) : gate.repro;
}

/** 判据求值：正则 ⇒ 必须命中；函数 ⇒ 用它自己的 { ok, note }（缺席即红）。 */
export function judgeOutput(gate, out) {
  const text = String(out ?? '');
  if (typeof gate.expect === 'function') return gate.expect(text);
  const hit = gate.expect.test(text);
  return { ok: hit, note: hit ? undefined : '输出里没有通过标记（判据消失？）' };
}

/** 跑一门：spawnSync + 判据。退出码非 0 或判据不命中 ⇒ 红；超时 ⇒ 红（fail-closed）。 */
export function runOneGate(gate, mode) {
  const argv = gate.argv(mode);
  const started = Date.now();
  const res = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: gate.timeoutMs,
  });
  const ms = Date.now() - started;
  const out = `${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`;
  const timedOut = res.error?.code === 'ETIMEDOUT';
  const status = typeof res.status === 'number' ? res.status : null;
  const verdict = judgeOutput(gate, out);
  const ok = timedOut !== true && status === 0 && verdict.ok === true;
  let note = verdict.note;
  if (timedOut) note = `超时（>${Math.round(gate.timeoutMs / 1000)}s）`;
  // 退出码非 0 时把 exit 摆在最前面：门的真实原因（ERR 行）在下面 failureDetail 里，结论行别只说"判据没了"。
  else if (status !== 0) note = verdict.note ? `exit=${status} · ${verdict.note}` : `exit=${status}`;
  return { id: gate.id, name: gate.name, ok, ms, status, timedOut, note, out, repro: reproOf(gate, mode) };
}

export function runGates({ mode = 'full', gates = selectGates(mode), run = runOneGate } = {}) {
  return gates.map((gate) => run(gate, mode));
}

/** 退出码聚合：**空清单不算绿**（一门都没跑 ≠ 通过），任一门不 ok ⇒ 1。 */
export function exitCodeOf(results) {
  if (!Array.isArray(results) || results.length === 0) return 1;
  return results.every((r) => r.ok === true) ? 0 : 1;
}

export function summarize(results, mode = 'full') {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((r) => r.ok !== true);
  const totalMs = list.reduce((sum, r) => sum + (Number.isFinite(r.ms) ? r.ms : 0), 0);
  return {
    mode,
    total: list.length,
    passed: list.length - failed.length,
    failed,
    totalMs,
    ok: list.length > 0 && failed.length === 0,
  };
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

export function formatGateLine(r) {
  const mark = r.ok === true ? '✓ PASS' : '✗ FAIL';
  return `  ${mark}  ${r.id.padEnd(13)} ${secs(r.ms).padStart(8)}  ${r.name}${r.note ? ` — ${r.note}` : ''}`;
}

/** 失败门把"为什么红"贴出来，省掉再跑一遍：失败用例行 + 输出尾部。 */
export function failureDetail(r) {
  const plain = stripAnsi(r.out);
  const lines = plain.split('\n').map((line) => line.trimEnd());
  const hints = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('✖') || line.startsWith('not ok') || line.startsWith('ERR '))
    .slice(0, 8);
  const tail = lines.filter((line) => line.trim() !== '').slice(-12);
  const out = [`     ↳ 失败门 ${r.id}：exit=${r.status ?? 'null'}${r.timedOut ? ' · 超时' : ''}`];
  for (const hint of hints) out.push(`     ↳ ${hint}`);
  out.push('     ↳ 输出尾部：');
  for (const line of tail) out.push(`     | ${line}`);
  return out;
}

export function formatSummary(s) {
  const head = `${s.ok ? '✅' : '❌'} gate: ${s.passed}/${s.total} 门通过 · 总用时 ${secs(s.totalMs)}（--${s.mode}）`;
  if (s.ok) return [head];
  const out = [head, '失败门：'];
  for (const r of s.failed) {
    out.push(`  · ${r.id} —— ${r.note ?? '未知原因'}`);
    out.push(`    复现：${r.repro}`);
  }
  return out;
}

export function parseArgs(argv = []) {
  const parsed = { mode: 'full', only: null, list: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fast') parsed.mode = 'fast';
    else if (arg === '--full') parsed.mode = 'full';
    else if (arg === '--list') parsed.list = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--only') {
      const value = String(argv[i + 1] ?? '');
      i += 1;
      const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return { error: '--only 后面要跟门 id（逗号分隔）' };
      parsed.only = ids;
    } else return { error: `不认识的参数：${arg}` };
  }
  return parsed;
}

/**
 * 入口。`deps.run` / `deps.out` 可注入，供单测断言聚合逻辑而不真跑门禁。
 * @returns {number} 退出码
 */
export function main(argv = process.argv.slice(2), { run = runOneGate, out = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    out(USAGE);
    return 0;
  }
  if (parsed.error) {
    out(`gate: ${parsed.error}`);
    out(USAGE);
    return 2;
  }
  if (parsed.list) {
    for (const gate of GATES) {
      const tiers = gate.modes.join('/');
      out(`  ${gate.id.padEnd(13)} [${tiers}]  ${reproOf(gate, gate.modes[gate.modes.length - 1])}`);
    }
    return 0;
  }
  let gates = selectGates(parsed.mode);
  if (parsed.only) {
    const known = new Map(GATES.map((gate) => [gate.id, gate]));
    const unknown = parsed.only.filter((id) => !known.has(id));
    if (unknown.length) {
      out(`gate: 不认识的门 id：${unknown.join(', ')}（可选：${GATES.map((g) => g.id).join(' / ')}）`);
      return 2;
    }
    const picked = parsed.only.map((id) => known.get(id));
    const notInMode = picked.filter((gate) => !gate.modes.includes(parsed.mode));
    if (notInMode.length) {
      out(`gate: 这些门不在 --${parsed.mode} 里：${notInMode.map((g) => g.id).join(', ')}`);
      return 2;
    }
    gates = picked;
  }
  out(`gate --${parsed.mode}：${gates.length} 门（${gates.map((g) => g.id).join(' / ')}）`);
  // 逐门即时打印：全量档最慢的两门各要十分钟量级，不能等全部跑完才出第一行。
  const results = [];
  for (const gate of gates) {
    const r = run(gate, parsed.mode);
    results.push(r);
    out(formatGateLine(r));
    if (r.ok !== true) for (const line of failureDetail(r)) out(line);
  }
  const summary = summarize(results, parsed.mode);
  for (const line of [''].concat(formatSummary(summary))) out(line);
  return exitCodeOf(results);
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) process.exitCode = main();