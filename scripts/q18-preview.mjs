#!/usr/bin/env node
// Q18 预演（只读）：用「跨项目唯先例」冻结考卷，分别在 A（关）/ B（开）两种口径下测量。
// 输出：覆盖 / 严格 / 展示命中（displayed = 卡片行里真的出现了当年那一局）。写 evidence/q18-preview.md。
//
// 用法：node scripts/q18-preview.mjs [--json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  for (const flag of [false, true]) {
    const r = measureA2b({ store, report, splitAt: SPLIT, cache, limit: 60, frozen: crossSet, walkOpts: { allowCrossScopeClass: flag } });
    out.cross[flag ? 'B' : 'A'] = { n: r.n, cover: r.recall, strict: r.recallSpecific, displayed: r.recallDisplayed };
  }
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
lines.push('');
lines.push('## 读法');
lines.push('- **展示命中**才是"卡片里真的出现了当年那一局"；A 口径下它必须为 0（同域证据闸）；');
lines.push('- 严格口径衡量"claim 文本对得上"，与出处行是否跨域无关，因此 A/B 可能相同；');
lines.push('- 若 B 的展示命中 > 0 且 A = 0，则 Q18=B 的收益可量化；否则说明放开也不产生可见收益。');
const md = lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
fs.writeFileSync(OUT, md);
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else console.log(md);
