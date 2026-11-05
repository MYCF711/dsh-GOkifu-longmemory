#!/usr/bin/env node
// T292 · 子代理局的失败教训有没有真的归并到父局（只读）。
//
// 背景：AGENTS §5 陷阱 10「子代理会话不应独立成记忆节点（归并到父局）」。
// T291 测出 726 个子代理局、0 个 claim；本刀验证"归并"是否真的发生。
//
// 判据（机械）：子代理局日志里的**失败原文**（`tool/result` 里的 error 行）
// 是否出现在**父局 claim** 的 `support[].quote` 里（归一化后包含）。
//
// 用法：node scripts/subagent-merge-audit.mjs [--sample 30] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { readFrames, parseEvents } from '../src/rooms/logread.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}
const norm = (s) => String(s ?? '').replace(/\r\n|\r/g, '\n').replace(/\u00a0/g, ' ').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(2)}%` : 'n/a');

/** 从事件里抽**失败原文**（tool/result 的 error/文本，前 120 字）。 */
export function failureTexts(events, limit = 5) {
  const out = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (String(ev?.type ?? '') !== 'tool/result') continue;
    const raw = JSON.stringify(ev?.data ?? {});
    if (!/error|failed|exception|ENOENT|EACCES|cannot|not found/i.test(raw)) continue;
    const i0 = raw.indexOf('"text":"');
    let candidate = raw.slice(0, 200);
    if (i0 >= 0) {
      const i1 = raw.indexOf('"', i0 + 8);
      const seg = i1 > i0 ? raw.slice(i0 + 8, Math.min(i1, i0 + 220)) : '';
      if (seg.length >= 20) candidate = seg.split('\n').join(' ').split('\\"').join('"');
    }
    const text = norm(candidate);
    if (text.length < 20) continue;
    out.push(text.slice(0, 120));
    if (out.length >= limit) break;
  }
  return out;
}

export function audit({ store, home = defaultHome(), sample = 30 } = {}) {
  const episodes = store.list('episodes').map((e) => e.record).filter(Boolean);
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const bySession = new Map(episodes.map((e) => [String(e.sessionId ?? ''), e]));
  const claimsByEp = new Map();
  for (const c of claims) for (const s of Array.isArray(c.support) ? c.support : []) {
    const ep = String(s?.episode ?? ''); if (!ep) continue;
    if (!claimsByEp.has(ep)) claimsByEp.set(ep, []);
    claimsByEp.get(ep).push({ claimId: c.id, quote: norm(s?.quote ?? ''), text: norm(c.text ?? '') });
  }
  const subs = episodes.filter((e) => Number(e.delegationDepth ?? 0) > 0 && Number(e.signals?.failures ?? 0) > 0);
  const totalFailures = subs.reduce((s, e) => s + Number(e.signals?.failures ?? 0), 0);
  const rows = [];
  let checked = 0;
  let merged = 0;
  let orphan = 0;
  for (const ep of subs.slice(0, sample)) {
    const rawParent = String(ep.parentSessionId ?? '');
    const parent = bySession.get(rawParent) ?? bySession.get(rawParent.replace(/^session-/, '')) ?? null;
    if (!parent) { orphan += 1; continue; }
    let events = [];
    try {
      const logPath = ep?.closure?.logPath;
      const abs = logPath ? (path.isAbsolute(logPath) ? logPath : path.join(home, logPath)) : null;
      if (abs && fs.existsSync(abs)) {
        const fr = readFrames(fs.readFileSync(abs));
        events = parseEvents(Array.isArray(fr) ? fr : fr?.frames ?? [])?.events ?? [];
      }
    } catch { /* 读不到按空处理 */ }
    const fails = failureTexts(events, 3);
    const parentClaims = claimsByEp.get(parent.id) ?? [];
    for (const f of fails) {
      checked += 1;
      const key = f.slice(0, 60);
      const hit = parentClaims.find((c) => c.quote.includes(key) || c.text.includes(key) || (key.length > 40 && (c.quote.includes(key.slice(0, 40)) || c.text.includes(key.slice(0, 40)))));
      if (hit) merged += 1;
      if (rows.length < 40) rows.push({ subEpisode: ep.id, parent: parent.id, failures: Number(ep.signals?.failures ?? 0), parentClaims: parentClaims.length, text: f.slice(0, 80), mergedTo: hit?.claimId ?? null });
    }
  }
  return {
    version: 1, generatedAt: Date.now(),
    episodes: episodes.length, subEpisodes: episodes.filter((e) => Number(e.delegationDepth ?? 0) > 0).length,
    subsWithFailures: subs.length, totalFailures,
    sampled: Math.min(sample, subs.length), checked, merged, orphan,
    mergeRate: checked ? merged / checked : null,
    rows,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = audit({ store, home, sample: Number(opt('sample', '30')) });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(`T292 · 子代理局失败归并 · 局 ${r.episodes}（子代理 ${r.subEpisodes}，有失败 ${r.subsWithFailures}，失败总数 ${r.totalFailures}）`);
  console.log(`抽样 ${r.sampled} 局 · 检查失败 ${r.checked} 条 · **归并 ${r.merged}（${pct(r.merged, r.checked)}）** · 找不到父局 ${r.orphan}`);
  console.log('\n逐条（子代理失败原文 vs 父局 claim）：');
  for (const x of r.rows.slice(0, 12)) console.log(`  ${x.subEpisode} → 父 ${x.parent} · 失败${x.failures} · 父局 claim ${x.parentClaims} · ${x.mergedTo ? `归并到 ${x.mergedTo}` : '**未归并**'} · 「${x.text.slice(0, 60)}」`);
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/subagent-merge-audit.mjs')) {
  main().then((c) => { process.exitCode = c; }).catch((e) => { console.error(`归并审计失败：${String(e?.message ?? e)}`); process.exitCode = 2; });
}
