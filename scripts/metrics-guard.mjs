#!/usr/bin/env node
// 指标护栏（本机跑，CI 无语料）：把六轴与 A2b 的关键值钉成门槛，低于门槛直接退出 1。
//
// 用法：node scripts/metrics-guard.mjs [--strict 0.65] [--json]
// 依赖：本机 $DSH_HOME 的语料与 memory-context（CI 上不跑，入 PR 时用 check.mjs 的结构检查兜底）。
//
// 门槛（2026-11-02 基线，改动需在 PR 里说明并更新本文件）：
//   A1 负迁移 ≤ 5%（硬上限）
//   A5 越界   = 0
//   A6 溯源   = 100%
//   A4 p50    ≤ 50ms
//   A2b 严格  ≥ 0.55（样本仅 18 条，1 条 = 5.6pp；2026-11-02 观察到同 store 下 0.611–0.667 的跳动）
//   A2b 覆盖  = 1.00（上限参考）

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');

// 2026-11-03：除了"绝对下限 0.55"，再加**回归线**（相对冻结基线最多掉 10pp）。
// 只卡下限的话，84.2% 掉到 56% 也算 PASS —— 那是"慢慢烂掉"的典型形态。
const LIMITS = {
  a1Max: 0.05,
  a5Max: 0,
  a6Min: 1,
  a4p50MaxMs: 50,
  a2bStrictMin: 0.55,
  a2bCoverMin: 1,
  a2bStrictRef: 0.8421052631578947,
  a2bStrictDropMax: 0.1,
};

export function judge(report, limits = LIMITS) {
  const axes = report?.axes ?? report ?? {};
  const fails = [];
  const a1 = axes.A1?.value;
  // m5-report 的 A1.detail.validityCoverage 是对象 {withValidity, rendered, ratio}；
  // 也兼容直接给数字的旧形态。ratio===0 ⇒ 空转（2026-11-02 审计 P1-5）。
  const covRaw = axes.A1?.detail?.validityCoverage ?? axes.A1?.validityCoverage ?? null;
  const a1Coverage = Number.isFinite(covRaw) ? covRaw : (Number.isFinite(covRaw?.ratio) ? covRaw.ratio : null);
  const a1Vacuous = Number.isFinite(a1) && (a1Coverage === null
    ? Boolean(axes.A1?.caveat && String(axes.A1.caveat).includes('空转'))
    : a1Coverage === 0);
  const a5 = axes.A5?.value;
  const a6 = axes.A6?.value;
  const a4 = axes.A4?.value;
  const recall = axes.A2?.detail?.injectionRecall ?? {};
  const strict = recall.recallSpecific;
  const cover = recall.recall;
  // A4.value 的单位就是 ms（m5-report 里 unit:'ms'）；不再乘 1000。
  const p50 = typeof a4 === 'number' ? a4 : null;
  if (!Number.isFinite(a1) || a1 > limits.a1Max) fails.push(`A1 负迁移 ${a1} > ${limits.a1Max}`);
  // A1=0 但覆盖率 0 ⇒ 空转：不判失败，但必须显式标注（2026-11-02 审计 P1-5）
  if (!Number.isFinite(a5) || a5 > limits.a5Max) fails.push(`A5 越界 ${a5} != 0`);
  if (!Number.isFinite(a6) || a6 < limits.a6Min) fails.push(`A6 溯源 ${a6} < ${limits.a6Min}`);
  if (Number.isFinite(p50) && p50 > limits.a4p50MaxMs) fails.push(`A4 p50 ${p50.toFixed(2)}ms > ${limits.a4p50MaxMs}ms`);
  if (!Number.isFinite(strict) || strict < limits.a2bStrictMin) fails.push(`A2b 严格 ${strict} < ${limits.a2bStrictMin}`);
  else if (Number.isFinite(limits.a2bStrictRef) && strict < limits.a2bStrictRef - (limits.a2bStrictDropMax ?? 0.1)) {
    fails.push(`A2b 严格 ${strict.toFixed(4)} 比冻结基线 ${limits.a2bStrictRef.toFixed(4)} 掉了 ${((limits.a2bStrictRef - strict) * 100).toFixed(1)}pp（>${((limits.a2bStrictDropMax ?? 0.1) * 100).toFixed(0)}pp）`);
  }
  if (!Number.isFinite(cover) || cover < limits.a2bCoverMin) fails.push(`A2b 覆盖 ${cover} < ${limits.a2bCoverMin}`);
  return { ok: fails.length === 0, fails, values: { a1, a1Vacuous, a1Coverage, a5, a6, p50, a2bStrict: strict, a2bCover: cover, a2bN: recall.n ?? null } };
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const strictIdx = argv.indexOf('--strict');
  const limits = { ...LIMITS };
  if (strictIdx >= 0 && Number.isFinite(Number(argv[strictIdx + 1]))) limits.a2bStrictMin = Number(argv[strictIdx + 1]);
  const json = argv.includes('--json');
  // 2026-11-04：本机实测过 m5 --json **间歇性静默死亡**（一次 patrol 里报 "Command failed"，重跑又正常）。
  // 原实现把 m5 的 stderr 吞了、把 JSON.parse 失败和子进程失败混成一句 "采集失败"，等于把可诊断信息丢掉。
  // 现在：分别记 exitCode / stderr / stdout 尾部，落 tmp/m5-raw.json 供事后看；只对"exit≠0 且 stderr 为空"
  // 这种静默死亡重试一次（重试很贵，别对真错误反复跑）。
  const collect = async () => {
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(REPO, 'scripts/m5-report.mjs'), '--json'], { cwd: REPO, env: process.env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (error) => resolve({ exitCode: null, stdout, stderr: `${stderr}${String(error?.message ?? error)}` }));
      child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }));
    });
    const tail = (text, n = 600) => String(text ?? '').trim().slice(-n);
    let report = null;
    let parseError = null;
    try { report = JSON.parse(r.stdout); } catch (error) { parseError = String(error?.message ?? error); }
    return { ...r, report, parseError, tail };
  };
  let got = await collect();
  if (!got.report && got.exitCode !== 0 && !got.tail(got.stderr)) {
    console.error('metrics-guard: m5 静默死亡（exit≠0 且 stderr 为空），重试一次…');
    got = await collect();
  }
  if (!got.report) {
    try {
      fs.mkdirSync(path.join(REPO, 'tmp'), { recursive: true });
      fs.writeFileSync(path.join(REPO, 'tmp/m5-raw.json'), `${got.stdout ?? ''}`);
      fs.writeFileSync(path.join(REPO, 'tmp/m5-raw.stderr.txt'), `${got.stderr ?? ''}`);
    } catch { /* 证据写失败不影响报错 */ }
    console.error(`metrics-guard: 采集失败 · exit=${got.exitCode ?? 'n/a'}${got.parseError ? ` · JSON 解析：${got.parseError}` : ''}`);
    if (got.tail(got.stderr)) console.error(`  m5 stderr 尾部：${got.tail(got.stderr)}`);
    if (got.parseError && got.tail(got.stdout)) console.error(`  m5 stdout 尾部：${got.tail(got.stdout, 300)}`);
    console.error('  原始输出已落 tmp/m5-raw.json 与 tmp/m5-raw.stderr.txt');
    process.exit(2);
  }
  const report = got.report;
  const verdict = judge(report, limits);
  const out = { at: new Date().toISOString(), root: HOME, limits, ...verdict };
  try {
    fs.mkdirSync(path.join(REPO, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(REPO, 'evidence/metrics-guard.json'), JSON.stringify(out, null, 2) + '\n');
  } catch { /* 证据写失败不影响判定 */ }
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`metrics-guard ${verdict.ok ? 'PASS' : 'FAIL'} · A1=${out.values.a1}${out.values.a1Vacuous ? '（空转：validity 覆盖 0）' : ''} A5=${out.values.a5} A6=${out.values.a6} A2b严格=${out.values.a2bStrict}（n=${out.values.a2bN}） 覆盖=${out.values.a2bCover} p50=${Number.isFinite(out.values.p50) ? out.values.p50.toFixed(2) + 'ms' : 'n/a'}`);
    for (const f of verdict.fails) console.error(`ERR ${f}`);
  }
  process.exit(verdict.ok ? 0 : 1);
}
