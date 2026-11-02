#!/usr/bin/env node
// D5 遥测报表（只读）：读影子目录的 repeat-hint.jsonl，给出「二次命中」触发情况。
// 用途：真注入上线后，评估"同类失败 ≥2 次才补卡"的触发频率、类别分布与 token 成本；误报需人工抽样。
//
// 用法：node scripts/repeat-report.mjs [--dir <shadowDir>] [--json]
// 退出码：0 有数据；2 没有台账（不伪造 0）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');

export function summarize(lines) {
  const rows = (Array.isArray(lines) ? lines : []).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((r) => r && r.kind === 'repeat-hint');
  const byClass = new Map();
  let tokens = 0;
  let tokensCount = 0;
  const digests = new Set();
  for (const row of rows) {
    const cls = row.cls ?? '(unknown)';
    byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    if (Number.isFinite(row.tokens)) { tokens += row.tokens; tokensCount += 1; }
    if (row.digest) digests.add(row.digest);
  }
  return {
    total: rows.length,
    sessions: digests.size,
    byClass: [...byClass.entries()].sort((a, b) => b[1] - a[1]),
    tokensAvg: tokensCount ? Math.round(tokens / tokensCount) : null,
    firstAt: rows.length ? Math.min(...rows.map((r) => r.at).filter(Number.isFinite)) : null,
    lastAt: rows.length ? Math.max(...rows.map((r) => r.at).filter(Number.isFinite)) : null,
  };
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invoked) {
  const dirIdx = process.argv.indexOf('--dir');
  const dir = dirIdx >= 0 ? process.argv[dirIdx + 1] : path.join(HOME, 'memory-context-shadow');
  const file = path.join(dir, 'repeat-hint.jsonl');
  if (!fs.existsSync(file)) {
    console.error(`没有 D5 遥测台账：${file}（还没真注入过，或影子目录不同）`);
    process.exit(2);
  }
  const lines = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean);
  const out = summarize(lines);
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`D5 二次命中遥测：${out.total} 次 · 涉及会话(digest) ${out.sessions} · token 均值 ${out.tokensAvg ?? 'n/a'}`);
    for (const [cls, n] of out.byClass) console.log(`- ${cls} · ${n} 次`);
    if (out.firstAt) console.log(`时间范围：${new Date(out.firstAt).toISOString()} → ${new Date(out.lastAt).toISOString()}`);
  }
}
