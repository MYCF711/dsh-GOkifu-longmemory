#!/usr/bin/env node
// T291 · 全库覆盖率测量（只读）：848 局里有多少局产出过 claim？
//
// 与"召回率"是两个东西：召回率 = 有货的题里取到多少；覆盖率 = 有多少局真的有货。
// 考卷的 C 类恒为 0（buildExam 只对有 claim 的局出题）⇒ 必须单独量这一刀。
//
// 用法：node scripts/coverage-audit.mjs [--json] [--sample 10]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(2)}%` : 'n/a');
const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (arr, q) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** 单局的"为什么没有 claim"归因（机械）。 */
export function whyNoClaim(ep, claimsById) {
  const depth = Number(ep?.delegationDepth ?? 0);
  const failures = Number(ep?.signals?.failures ?? 0);
  const successes = Number(ep?.signals?.successes ?? 0);
  const tools = Array.isArray(ep?.signals?.tools) ? ep.signals.tools.length : 0;
  const seqFrom = Number(ep?.closure?.seqFrom ?? 0);
  const seqTo = Number(ep?.closure?.seqTo ?? 0);
  const events = Number.isFinite(seqTo - seqFrom) && seqTo >= seqFrom ? seqTo - seqFrom + 1 : 0;
  const reasons = [];
  if (depth > 0) reasons.push(`子代理局(depth=${depth})`);
  if (events > 0 && events < 12) reasons.push(`太短(${events} 事件)`);
  if (failures === 0 && successes === 0) reasons.push('无失败/成功信号');
  if (tools === 0) reasons.push('无工具调用');
  return { depth, failures, successes, tools, events, reasons: reasons.length ? reasons : ['其它（需人工看）'] };
}

export function audit({ store, home = defaultHome(), sample = 10 } = {}) {
  const episodes = store.list('episodes').map((e) => e.record).filter(Boolean);
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const byEp = new Map();
  for (const c of claims) for (const s of Array.isArray(c.support) ? c.support : []) {
    const ep = String(s?.episode ?? ''); if (!ep) continue;
    byEp.set(ep, (byEp.get(ep) ?? 0) + 1);
  }
  const counts = episodes.map((ep) => byEp.get(ep.id) ?? 0);
  const withClaims = counts.filter((n) => n > 0).length;
  const zero = episodes.filter((ep) => (byEp.get(ep.id) ?? 0) === 0);
  // 按 scope
  const byScope = new Map();
  for (const ep of episodes) {
    const sc = String(ep.scopeKey ?? '(none)');
    const o = byScope.get(sc) ?? { scope: sc, episodes: 0, withClaims: 0, claims: 0 };
    o.episodes += 1;
    const n = byEp.get(ep.id) ?? 0;
    o.claims += n;
    if (n > 0) o.withClaims += 1;
    byScope.set(sc, o);
  }
  const scopeRows = [...byScope.values()].map((o) => ({ ...o, rate: o.episodes ? o.withClaims / o.episodes : 0 })).sort((a, b) => b.episodes - a.episodes);
  // 无 claim 抽样
  const samples = zero.slice(0, sample).map((ep) => ({ id: ep.id, scope: ep.scopeKey, ...whyNoClaim(ep, byEp) }));
  // 原因聚合
  const reasonAgg = {};
  for (const ep of zero) for (const r of whyNoClaim(ep, byEp).reasons) reasonAgg[r] = (reasonAgg[r] ?? 0) + 1;
  return {
    version: 1, generatedAt: Date.now(),
    episodes: episodes.length, claims: claims.length,
    withClaims, coverage: episodes.length ? withClaims / episodes.length : null,
    zero, zeroIds: zero.map((e) => e.id),
    dist: { median: median(counts), p90: quantile(counts, 0.9), max: Math.max(0, ...counts), mean: counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0 },
    scopes: scopeRows, samples, reasonAgg,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = audit({ store, home, sample: Number(opt('sample', '10')) });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(`T291 · 全库覆盖率 · 局 ${r.episodes} · claim ${r.claims}`);
  console.log(`有 claim 的局 ${r.withClaims}/${r.episodes} = **${pct(r.withClaims, r.episodes)}** · 为 0 的局 ${r.zero.length}`);
  console.log(`每局 claim 数：median ${r.dist.median} · p90 ${r.dist.p90} · max ${r.dist.max} · mean ${r.dist.mean.toFixed(2)}`);
  console.log('\n按 scope（top 15）：');
  for (const s of r.scopes.slice(0, 15)) console.log(`  ${s.scope} · 局 ${s.episodes} · 有 claim ${s.withClaims} (${pct(s.withClaims, s.episodes)}) · claim ${s.claims}`);
  console.log('\n无 claim 局原因聚合（可多选）：');
  for (const [k, v] of Object.entries(r.reasonAgg).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log('\n抽样 10 个无 claim 局：');
  for (const s of r.samples) console.log(`  ${s.id} · ${s.scope} · depth=${s.depth} · 失败=${s.failures} 成功=${s.successes} 工具=${s.tools} 事件=${s.events} ⇒ ${s.reasons.join(' / ')}`);
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/coverage-audit.mjs')) {
  main().then((c) => { process.exitCode = c; }).catch((e) => { console.error(`覆盖率测量失败：${String(e?.message ?? e)}`); process.exitCode = 2; });
}
