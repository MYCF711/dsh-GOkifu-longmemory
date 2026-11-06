#!/usr/bin/env node
// T325 · 混合输出的判据（知识库 74 的最小修法）：判"段内最终结论"(R2) + 强制 X3 依赖链
//
// 背景（T323/T324）：A1 门排除了 53.76% 的噪声，但过门的 511 条里仍有
//   `ok verify: OK … rebuild: FAIL` 这类**混合输出**。按知识库 74：
//   R2（失败占主导）已满足、R1（主体明确）部分满足、**R3（依赖链可判）普遍缺失** ⇒ 不可复用。
//
// 本脚本（只读）做两件事：
//   ① **R2 段内最终结论**：同一段里既有成功又有失败 ⇒ 取**最后一个结论**；
//      **上游成功不抵消下游失败**（GNU make 语义：`ok a` 之后 `FAIL b` ⇒ 失败）。
//   ② **X3 依赖链**：必须说得出"这个失败导致谁不可用"（目标/文件/测试名，从失败行里机械取）；
//      取不出 ⇒ `observed`（**不进注入**，不许为了覆盖率编）。
//
// 用法：node scripts/mixed-output-gate.mjs [--json] [--evidence <path>]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { a1Gate } from './antipattern-a1-gate.mjs';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';

/** 结论标记：成功侧 / 失败侧（顺序即优先级，实际按**行内位置**取最后一条）。 */
const SUCCESS_RE = /(?:^|\s)(?:ok\s+\S+|\u2714\b|\bPASS\b|\bSUCCESS\b|compiled successfully|Build succeeded|exit code:?\s*0)/i;
const FAILURE_RE = /(?:\u2716|\u2717|\bFAIL(?:ED|URE)?\b|\bnot ok\s+\d+|\b(?:[A-Za-z_]*Error|Exception)\s*:|\bexit code:?\s*[1-9]\d*)/;

/**
 * 段内最终结论（R2）。**取最后一个结论标记**，不因前后顺序而抵消。
 * @returns {'failure'|'success'|null}
 */
export function finalConclusion(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  let last = null;
  for (const line of lines) {
    if (FAILURE_RE.test(line)) last = 'failure';
    else if (SUCCESS_RE.test(line)) last = 'success';
  }
  return last;
}

/**
 * X3 依赖链：从**失败行**里机械取"谁不可用"（目标 / 文件 / 测试名）。
 * 取不出 ⇒ null（调用方标 `observed`，不编）。
 * @returns {{subject:string, kind:'target'|'file'|'test'}|null}
 */
export function dependencyChainOf(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!FAILURE_RE.test(line)) continue;
    // 文件路径（最可靠）
    const f = /(?:[A-Za-z]:)?[/\\][\w./\\-]{3,}\.(?:m?js|cjs|ts|tsx|json|md|ya?ml|go|py|txt)/.exec(line);
    if (f) return { subject: f[0], kind: 'file' };
    // `FAIL <target>` / `✗ <target>` / `not ok N - <name>`
    const t = /^(?:\u2716|\u2717|FAIL(?:ED)?\b|not ok\s+\d+(?:\s*-\s*)?)\s*([^\s:(\u2014-]{2,80})/.exec(line);
    if (t && t[1]) return { subject: t[1], kind: 'target' };
    // `Error: <msg>` 里的引号主体
    const q = /["'`]([^"'`]{3,80})["'`]/.exec(line);
    if (q && q[1]) return { subject: q[1], kind: 'file' };
  }
  return null;
}

/** 单条 claim 的判定。 */
export function gateClaim(text) {
  const a1 = a1Gate(text);
  if (!a1.pass) return { ...a1, verdict: 'rejected-a1', chain: null, state: 'rejected' };
  const conclusion = finalConclusion(a1.line ?? text);
  if (conclusion !== 'failure') return { pass: false, line: a1.line, reason: 'final-conclusion-success', verdict: 'rejected-r2', chain: null, state: 'rejected' };
  const chain = dependencyChainOf(a1.line ?? text);
  if (!chain) return { pass: true, line: a1.line, reason: 'no-x3', verdict: 'observed', chain: null, state: 'observed' };
  return { pass: true, line: a1.line, reason: 'reusable', verdict: 'reusable', chain, state: 'reusable' };
}

function opt(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function main(argv = process.argv.slice(2)) {
  const storeRoot = path.resolve(opt(argv, 'store', path.join(HOME, 'memory-context')));
  if (!fs.existsSync(storeRoot)) { console.error(`没有 store：${storeRoot}`); return 2; }
  const store = createStore({ root: storeRoot });
  const claims = store.list('claims').map((x) => x?.record).filter(Boolean);
  const anti = claims.filter((c) => String(c?.kind ?? '') === 'antipattern');
  const rows = anti.map((c) => ({ id: c.id, text: String(c.text ?? '').slice(0, 160), ...gateClaim(c.text) }));
  const a1Pass = rows.filter((r) => r.verdict !== 'rejected-a1' && r.reason !== 'no-failure-line');
  const reusable = a1Pass.filter((r) => r.state === 'reusable');
  const observed = a1Pass.filter((r) => r.state === 'observed');
  const stats = {
    antipatterns: rows.length,
    a1Pass: a1Pass.length,
    reusable: reusable.length,
    observed: observed.length,
    x3Rate: a1Pass.length ? reusable.length / a1Pass.length : null,
  };
  if (argv.includes('--json')) console.log(JSON.stringify({ stats, rows: a1Pass }, null, 2));
  else {
    console.log('混合输出判据（R2 最终结论 + X3 依赖链）· 只读');
    console.log(`antipattern ${stats.antipatterns} 条 · 过 A1 门 ${stats.a1Pass} 条 ⇒ 可复用（有 X3）${stats.reusable} · 只能 observed ${stats.observed} · X3 覆盖率 ${(stats.x3Rate * 100).toFixed(2)}%`);
    for (const r of reusable.slice(0, 5)) console.log(`+ ${r.id} → ${r.chain.kind}:${r.chain.subject}`);
    for (const r of observed.slice(0, 5)) console.log(`- ${r.id}（observed）${JSON.stringify(r.text.slice(0, 70))}`);
  }
  const evidencePath = opt(argv, 'evidence', null);
  if (evidencePath) {
    fs.writeFileSync(path.resolve(evidencePath), renderEvidence({ stats, reusable, observed, rows }), 'utf8');
    if (!argv.includes('--json')) console.log(`evidence: ${path.relative(process.cwd(), path.resolve(evidencePath))}`);
  }
  return 0;
}

function renderEvidence({ stats, reusable, observed, rows }) {
  const lines = [];
  lines.push('# T325 · 混合输出判据（R2 段内最终结论 + X3 依赖链）');
  lines.push('');
  lines.push(`> \`[本] ${new Date().toISOString()}\` · **只读**（不写库）· 未跑全量测试、未重启 DSH。`);
  lines.push('> 判据来源：知识库 74（R1/R2/R3）+ GNU make 语义（上游成功不抵消下游失败）。');
  lines.push('');
  lines.push('## 0 · 一句话');
  lines.push('');
  lines.push(`**过 A1 门的 ${stats.a1Pass} 条里，${stats.reusable} 条能补上 X3（可复用），${stats.observed} 条补不出 ⇒ 标 \`observed\` 不进注入（X3 覆盖率 ${(stats.x3Rate * 100).toFixed(2)}%）。**`);
  lines.push('');
  lines.push('## 1 · 汇总');
  lines.push('');
  lines.push('```');
  lines.push(`antipattern ${stats.antipatterns} · 过 A1 门 ${stats.a1Pass}`);
  lines.push(`可复用（有 X3）${stats.reusable} · 只能 observed ${stats.observed}`);
  lines.push('```');
  lines.push('');
  lines.push('## 2 · 可复用样本（前 10，带依赖链）');
  lines.push('');
  for (const r of reusable.slice(0, 10)) lines.push(`- \`${r.id}\` → \`${r.chain.kind}:${r.chain.subject}\``);
  if (!reusable.length) lines.push('**0 条**。');
  lines.push('');
  lines.push('## 3 · 只能 observed 的样本（前 10）');
  lines.push('');
  for (const r of observed.slice(0, 10)) lines.push(`- \`${r.id}\` ${JSON.stringify(r.text.slice(0, 90))}`);
  if (!observed.length) lines.push('**0 条**。');
  lines.push('');
  lines.push('## 4 · R2 判定说明');
  lines.push('');
  lines.push('按**行内位置**取最后一个结论标记：`ok verify: OK … rebuild: FAIL` ⇒ 失败；'
    + '`rebuild: FAIL … ok verify` ⇒ 仍失败（FAIL 不因顺序抵消）。无任何结论标记 ⇒ 不是 A1 门放行的形态。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedDirectly) {
  try { process.exitCode = main(); } catch (err) { console.error(`mixed-output-gate 失败：${String(err?.message ?? err)}`); process.exitCode = 2; }
}
