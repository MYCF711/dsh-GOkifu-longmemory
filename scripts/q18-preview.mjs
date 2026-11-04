#!/usr/bin/env node
// Q18 预演（只读）：用「跨项目唯先例」冻结考卷，分别在 A（关）/ B（开）两种口径下测量。
// 输出：覆盖 / 严格 / 展示命中（displayed = 卡片行里真的出现了当年那一局）+ **逐条配对** 与精确 McNemar。
// 写 evidence/q18-preview.md。
//
// 用法：node scripts/q18-preview.mjs [--json]
//
// 2026-11-04（0.126.0）：加 invoked 守卫 —— 之前是"导入即执行"，单测一 import 就会去跑 runEval，
// 在 CI（没有 $DSH_HOME 语料）直接炸。纯函数（exactMcNemar/pairedCompare）必须能脱离语料被测试。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runEval } from './eval.mjs';
import { measureA2b } from './m5-report.mjs';
import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache } from '../src/rooms/walk.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const SPLIT = Date.parse('2026-11-02T00:00:00Z');
const MAIN = path.join(REPO, 'evidence', 'a2b-set.json');
const CROSS = path.join(REPO, 'evidence', 'a2b-set-cross.json');
const OUT = path.join(REPO, 'evidence', 'q18-preview.md');

const pct = (x) => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');

/** 精确 McNemar（双侧）：只看不一致对，P = 2 * P(X ≤ min(b,c))，X~Bin(n=b+c, 0.5)。 */
export function exactMcNemar(a, b) {
  const n = a + b;
  if (n === 0) return 1;
  const k = Math.min(a, b);
  let tail = 0;
  let c = 1; // C(n, i) 递推
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) c = (c * (n - i + 1)) / i;
    tail += c;
  }
  return Math.min(1, 2 * (tail / 2 ** n));
}

/** 配对比较两条 sampled（同一冻结集、同顺序）：返回 2×2 与检验。 */
export function pairedCompare(sampledA, sampledB) {
  const n = Math.min(sampledA?.length ?? 0, sampledB?.length ?? 0);
  let bothOk = 0; let onlyA = 0; let onlyB = 0; let bothFail = 0;
  for (let i = 0; i < n; i += 1) {
    const a = sampledA[i]?.specific === true;
    const b = sampledB[i]?.specific === true;
    if (a && b) bothOk += 1;
    else if (a && !b) onlyA += 1;
    else if (!a && b) onlyB += 1;
    else bothFail += 1;
  }
  return { n, bothOk, onlyA, onlyB, bothFail, p: exactMcNemar(onlyA, onlyB) };
}

export async function runPreview({ argv = [], write = true } = {}) {
  const report = await runEval({ dataRoot: HOME, splitAt: SPLIT });
  const store = createStore({ root: path.join(HOME, 'memory-context') });
  const cache = createWalkCache(store);
  const mainSet = fs.existsSync(MAIN) ? JSON.parse(fs.readFileSync(MAIN, 'utf8')) : null;
  const crossSet = fs.existsSync(CROSS) ? JSON.parse(fs.readFileSync(CROSS, 'utf8')) : null;

  const out = { main: null, cross: {} };
  if (mainSet) {
    const m = measureA2b({ store, report, splitAt: SPLIT, cache, limit: 60, frozen: mainSet });
    out.main = { n: m.n, cover: m.recall, strict: m.recallSpecific, displayed: m.recallDisplayed };
  }
  if (crossSet) {
    const sampled = {};
    for (const flag of [false, true]) {
      const r = measureA2b({ store, report, splitAt: SPLIT, cache, limit: 60, frozen: crossSet, walkOpts: { allowCrossScopeClass: flag } });
      const key = flag ? 'B' : 'A';
      sampled[key] = r.sampled;
      out.cross[key] = { n: r.n, cover: r.recall, strict: r.recallSpecific, displayed: r.recallDisplayed };
    }
    // 2026-11-04（T117）：聚合率会掩盖"谁翻转了"。同一批考卷做**配对**比较 + 精确 McNemar。
    if (sampled.A && sampled.B) out.cross.paired = pairedCompare(sampled.A, sampled.B);
  }

  const lines = [];
  lines.push('# Q18 预演：跨项目唯先例考卷（只读）');
  lines.push('');
  lines.push(`- 生成于 ${new Date().toISOString()} · 切点 ${new Date(SPLIT).toISOString()}`);
  lines.push(`- 主考卷 ${mainSet?.count ?? '?'} 条 · 跨项目考卷 ${crossSet?.count ?? '?'} 条`);
  lines.push('');
  lines.push('| 考卷 / 口径 | n | 覆盖 | 严格 | **展示命中** |');
  lines.push('|---|---|---|---|---|');
  if (out.main) lines.push(`| 主考卷（现状） | ${out.main.n} | ${pct(out.main.cover)} | ${pct(out.main.strict)} | ${pct(out.main.displayed)} |`);
  for (const key of ['A', 'B']) {
    const r = out.cross[key];
    if (r) lines.push(`| 跨项目 · Q18=${key} | ${r.n} | ${pct(r.cover)} | ${pct(r.strict)} | **${pct(r.displayed)}** |`);
  }
  if (out.cross.paired) {
    const q = out.cross.paired;
    lines.push('');
    lines.push('## 配对比较（同一批考卷，逐条看谁翻转）');
    lines.push('');
    lines.push('| 2×2（严格口径） | 条数 |');
    lines.push('|---|---|');
    lines.push(`| A、B 都对 | ${q.bothOk} |`);
    lines.push(`| 只有 A 对（开闸把它弄丢了） | **${q.onlyA}** |`);
    lines.push(`| 只有 B 对（开闸救回来的） | **${q.onlyB}** |`);
    lines.push(`| 都不对 | ${q.bothFail} |`);
    lines.push('');
    lines.push(`精确 McNemar（双侧）p = **${q.p.toFixed(4)}**（不一致对 n=${q.onlyA + q.onlyB}；n 太小时只能抓大坑，不能证小胜）。`);
  }
  lines.push('');
  lines.push('## 读法');
  lines.push('- **展示命中**才是"卡片里真的出现了当年那一局"；A 口径下它必须为 0（同域证据闸）；');
  lines.push('- 严格口径衡量"claim 文本对得上"，与出处行是否跨域无关，因此 A/B 可能相同；');
  lines.push('- 若 B 的展示命中 > 0 且 A = 0，则 Q18=B 的收益可量化；否则说明放开也不产生可见收益。');
  const md = lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
  if (write) fs.writeFileSync(OUT, md);
  if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else console.log(md);
  return out;
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) await runPreview({ argv: process.argv.slice(2) });
