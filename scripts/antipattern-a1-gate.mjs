#!/usr/bin/env node
// T323 · A1 门：只有"真失败"才进 antipattern（知识库 73 的最小修法①）
//
// 背景（T310/T311）：1105 条 antipattern 里 **49.7% 连错误都不是**（命令输出噪声、方案标题、无错误的流水账）。
// 根因：抽取规则 `if (snippet) return snippet` —— 有片段就当失败，从不问"这里到底有没有一次真失败"。
//
// A1 判据（= T311b 的行级定位，**同一套**，不复制第二份）：
//   · 行首 `Error:` / `XxxError:` / `Exception:`（该行 ≤400 字）
//   · 独占一行的非零 `[exit code: N]`
//   · **不算**：`=== 当前 IME ===`、`=== 方案 1 ===`、无错误的流水账
//
// 只读：不写库；本脚本只测量（--apply 留给未来，且只许打 tmp/ 副本）。
//
// 用法：
//   node scripts/antipattern-a1-gate.mjs
//   node scripts/antipattern-a1-gate.mjs --json
//   node scripts/antipattern-a1-gate.mjs --evidence evidence/T323-a1-gate.md

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { failureLineOf } from './extract-recovery.mjs';

const HOME = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';

/**
 * A1 门（纯函数）：这条 claim 的文本里**有没有一次真失败**。
 * 兼容 `class:xxx · Error: …` 这类合并文本 —— 按 ` · ` 切段后**逐段**判（段内仍要求行首）。
 * @returns {{pass:boolean, line:string|null, reason:string|null}}
 */
export function a1Gate(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { pass: false, line: null, reason: 'empty' };
  const segments = raw.includes(' · ') ? raw.split(' · ') : [raw];
  for (const seg of segments) {
    const hit = failureLineOf(seg);
    if (hit) return { pass: true, line: hit.line, reason: hit.reason };
  }
  return { pass: false, line: null, reason: 'no-failure-line' };
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
  const rows = anti.map((c) => {
    const g = a1Gate(c.text);
    return { id: c.id, state: c.state ?? null, pass: g.pass, line: g.line, reason: g.reason, text: String(c.text ?? '').slice(0, 120) };
  });
  const passed = rows.filter((r) => r.pass).length;
  const rejected = rows.length - passed;
  const stats = {
    antipatterns: rows.length,
    passed,
    rejected,
    passRate: rows.length ? passed / rows.length : null,
    rejectRate: rows.length ? rejected / rows.length : null,
  };

  if (argv.includes('--json')) console.log(JSON.stringify({ stats, rejected: rows.filter((r) => !r.pass) }, null, 2));
  else {
    console.log('A1 门（只有真失败才进 antipattern）· 只读');
    console.log(`antipattern ${stats.antipatterns} 条 · 过门 ${stats.passed} · 排除 ${stats.rejected} · 排除率 ${(stats.rejectRate * 100).toFixed(2)}%`);
    for (const r of rows.filter((x) => !x.pass).slice(0, 5)) console.log(`- 排除 ${r.id}：${JSON.stringify(r.text.slice(0, 70))}`);
    for (const r of rows.filter((x) => x.pass).slice(0, 3)) console.log(`+ 保留 ${r.id}：${JSON.stringify(r.text.slice(0, 70))}`);
  }

  const evidencePath = opt(argv, 'evidence', null);
  if (evidencePath) {
    fs.writeFileSync(path.resolve(evidencePath), renderEvidence({ stats, rows }), 'utf8');
    if (!argv.includes('--json')) console.log(`evidence: ${path.relative(process.cwd(), path.resolve(evidencePath))}`);
  }
  return 0;
}

function renderEvidence({ stats, rows }) {
  const rejected = rows.filter((r) => !r.pass);
  const kept = rows.filter((r) => r.pass);
  const lines = [];
  lines.push('# T323 · 抽取加 A1 门（只有"真失败"才进 antipattern）');
  lines.push('');
  lines.push(`> \`[本] ${new Date().toISOString()}\` · **只读**（不写库）· 未跑全量测试、未重启 DSH。`);
  lines.push('> 判据 = T311b 的行级定位（**同一套**，`scripts/extract-recovery.mjs` 的 `failureLineOf`，不复制第二份）。');
  lines.push('');
  lines.push('## 0 · 一句话');
  lines.push('');
  lines.push(`**加 A1 门后排除 ${stats.rejected} / ${stats.antipatterns} 条（${(stats.rejectRate * 100).toFixed(2)}%）**；`
    + `剩下的 ${stats.passed} 条里还有 ${rejected.length ? '少量' : '0 条'}需要人工看（见 §3）。`);
  lines.push('');
  lines.push('## 1 · 前后对照');
  lines.push('');
  lines.push('```');
  lines.push(`加门前：antipattern ${stats.antipatterns} 条，其中"连错误都不是"49.70%（T310 实测）`);
  lines.push(`加门后：过门 ${stats.passed} 条（${(stats.passRate * 100).toFixed(2)}%）· 排除 ${stats.rejected} 条（${(stats.rejectRate * 100).toFixed(2)}%）`);
  lines.push('```');
  lines.push('');
  lines.push('## 2 · 被排除的样本（前 10）');
  lines.push('');
  for (const r of rejected.slice(0, 10)) lines.push(`- \`${r.id}\` ${JSON.stringify(r.text.slice(0, 80))}`);
  if (!rejected.length) lines.push('**0 条**。');
  lines.push('');
  lines.push('## 3 · 过门的样本（前 10）');
  lines.push('');
  for (const r of kept.slice(0, 10)) lines.push(`- \`${r.id}\`（${r.reason}）${JSON.stringify((r.line ?? r.text).slice(0, 80))}`);
  if (!kept.length) lines.push('**0 条**。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href : false;
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`antipattern-a1-gate 失败：${String(err?.message ?? err)}`);
    process.exitCode = 2;
  }
}
