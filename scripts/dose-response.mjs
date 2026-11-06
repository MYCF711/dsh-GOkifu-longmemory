#!/usr/bin/env node
// T306 · 剂量-反应：按"记忆强度"分层的同错复发率（只读）
//
// 记忆强度 = 库里有**多少条 claim** 引用了这个失败签名（0 / 1 / 2-3 / 4+）。
// 若复发率随强度**单调下降** ⇒ 支持"记忆有用"；无单调性或上升 ⇒ 不能证明（如实报）。
// 分层档位**先定死**（0 / 1 / 2-3 / 4+），跑之前不许改。
//
// 用法：node scripts/dose-response.mjs [--json] [--episodes 20]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';
import { collectFailures, recurrenceOf, wilson } from './ablation-recurrence.mjs';

export const BUCKETS = Object.freeze([
  { key: '0（无记忆）', lo: 0, hi: 0 },
  { key: '1', lo: 1, hi: 1 },
  { key: '2-3', lo: 2, hi: 3 },
  { key: '4+', lo: 4, hi: Infinity },
]);

export function bucketOfStrength(n) {
  const v = Number(n);
  // 缺失/非数字/负数一律按 0（无记忆）——**不许静默进高档**（否则会伪造剂量-反应）
  if (!Number.isFinite(v) || v < 0) return '0（无记忆）';
  for (const b of BUCKETS) if (v >= b.lo && v <= b.hi) return b.key;
  return '4+';
}

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(2)}%`);

export function measure({ store, home, episodes = 20 } = {}) {
  const allEpisodes = store.list('episodes').map((e) => e.record).filter(Boolean);
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const claimTexts = claims.map((c) => String(c.text ?? '')).filter(Boolean);
  const selfScope = 'w:d:/deepseek harness/default-workspace/长期记忆系统';
  const pool = allEpisodes
    .filter((e) => String(e.scopeKey ?? '').toLowerCase() !== selfScope)
    .filter((e) => Number(e.delegationDepth ?? 0) === 0)
    .sort((a, b) => Number(b?.signals?.failures ?? 0) - Number(a?.signals?.failures ?? 0))
    .slice(0, episodes);
  const rows = [];
  for (const ep of pool) {
    let events = [];
    try {
      const lp = ep?.closure?.logPath;
      const abs = lp ? (path.isAbsolute(lp) ? lp : path.join(home, lp)) : null;
      if (abs && fs.existsSync(abs)) {
        const fr = readFrames(fs.readFileSync(abs));
        events = parseEvents(Array.isArray(fr) ? fr : fr?.frames ?? [])?.events ?? [];
      }
    } catch { events = []; }
    const failures = collectFailures(events);
    const { first, recur } = recurrenceOf(failures);
    for (const [sig, seq] of first) {
      const strength = claimTexts.filter((t) => t.includes(sig.slice(0, 40))).length;
      rows.push({ episode: ep.id, sig, seq, strength, bucket: bucketOfStrength(strength), recurred: (recur.get(sig) ?? 0) > 0 });
    }
  }
  const table = BUCKETS.map((b) => {
    const rs = rows.filter((r) => r.bucket === b.key);
    const hits = rs.filter((r) => r.recurred).length;
    return { key: b.key, n: rs.length, recurred: hits, rate: rs.length ? hits / rs.length : null, wilson: wilson(hits, rs.length) };
  });
  // 单调性：从"0"到"4+"逐段比较（允许平台，但不得上升）
  let monotone = true;
  const reasons = [];
  for (let i = 1; i < table.length; i += 1) {
    const prev = table[i - 1];
    const cur = table[i];
    if (prev.rate === null || cur.rate === null) { reasons.push(`${cur.key}: 空层`); continue; }
    if (cur.rate > prev.rate + 1e-9) { monotone = false; reasons.push(`${cur.key} 上升（${pct(prev.rate)} → ${pct(cur.rate)}）`); }
  }
  return { version: 1, generatedAt: Date.now(), episodes: pool.length, signatures: rows.length, table, monotone, reasons, rows };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = measure({ store, home, episodes: Number(opt('episodes', '20')) });
  if (argv.includes('--json')) { console.log(JSON.stringify({ ...r, rows: r.rows.slice(0, 50) }, null, 2)); return 0; }
  console.log(`T306 · 剂量-反应（记忆强度 → 复发率）· 局 ${r.episodes} · 签名 ${r.signatures}`);
  console.log('| 记忆强度 | n | 复发 | 复发率 | Wilson 95% |');
  console.log('|---|---|---|---|---|');
  for (const t of r.table) console.log(`| **${t.key}** | ${t.n} | ${t.recurred} | **${pct(t.rate)}** | [${pct(t.wilson.lower)}, ${pct(t.wilson.upper)}] |`);
  console.log(`\n单调下降？**${r.monotone ? '是' : '否'}**${r.reasons.length ? ` · ${r.reasons.join('；')}` : ''}`);
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/dose-response.mjs')) {
  main().then((c) => { process.exitCode = c; }).catch((e) => { console.error(`剂量-反应测量失败：${String(e?.message ?? e)}`); process.exitCode = 2; });
}
