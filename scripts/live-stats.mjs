#!/usr/bin/env node
// A3 心跳汇总（2026-11-03）：读 <store>/live-stats.jsonl，证明"插件真的在宿主里跑过"。
// 用法：node scripts/live-stats.mjs [--store <dir>] [--json] [--tail 10]
// 退出码：0 有数据；2 没有台账（插件还没跑过 / liveStats 关掉了）。

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
const storeRoot = path.resolve(opt('store', path.join(HOME, 'memory-context')));
const json = argv.includes('--json');
const tailN = Number(opt('tail', '10'));
const file = path.join(storeRoot, 'live-stats.jsonl');

if (!fs.existsSync(file)) {
  console.error(`没有心跳台账：${file}（插件没在宿主里跑过，或 liveStats 被关掉）`);
  process.exit(2);
}
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);
const byAction = {};
const byReason = {};
const tokens = [];
for (const r of rows) {
  byAction[r.action ?? '?'] = (byAction[r.action ?? '?'] ?? 0) + 1;
  if (r.reason) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  if (Number.isFinite(r.tokens)) tokens.push(r.tokens);
}
tokens.sort((a, b) => a - b);
const p = (q) => (tokens.length ? tokens[Math.min(tokens.length - 1, Math.floor(q * tokens.length))] : null);
const summary = {
  file,
  lines: rows.length,
  firstAt: rows[0]?.at ?? null,
  lastAt: rows[rows.length - 1]?.at ?? null,
  actions: byAction,
  reasons: byReason,
  tokens: { n: tokens.length, p50: p(0.5), p95: p(0.95), max: tokens.length ? tokens[tokens.length - 1] : null },
  shadow: rows.filter((r) => r.shadow === true).length,
};
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`A3 心跳：${file}`);
  console.log(`共 ${summary.lines} 行 · ${new Date(summary.firstAt).toLocaleString()} → ${new Date(summary.lastAt).toLocaleString()} · shadow ${summary.shadow} 行`);
  console.log(`动作：${Object.entries(byAction).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  if (Object.keys(byReason).length) console.log(`原因：${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  console.log(`tokens：p50 ${summary.tokens.p50} · p95 ${summary.tokens.p95} · max ${summary.tokens.max}`);
  for (const r of rows.slice(-tailN)) console.log(`- ${new Date(r.at).toLocaleTimeString()} ${r.action} ${r.reason ?? ''} ${r.tokens ?? ''}`);
}
