#!/usr/bin/env node
// T280 · 召回覆盖率归因（只读）：主判据 34.21% 是被"真召回缺陷"还是"库里没货"拉低的？
//
// 对考卷（scripts/a2b-holdout.mjs 的 buildExam）的**每条**判四类：
//   A · 有货且取到   严格命中（judgeCard.hitStrict）
//   B · 有货但没取到 该局**有** claim 入库（support[].episode === 该局），但卡上没出现 ⇒ **真召回缺陷**
//   C · 无货可召     该局**没有**任何 claim 入库 ⇒ **覆盖不足**
//   D · 题目无判别性 信号里没有可用线索（判别词 < 2 且无硬实体）⇒ 题目本身不合格
//
// 判定顺序（互斥）：A > D > C > B。
// 纪律：只读；不改任何 claim；不改检索。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache, walkFromSignals } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';
import { buildExam, judgeCard, discriminativeTokens, hardEntities, claimsByEpisode } from './a2b-holdout.mjs';

export const COVERAGE_VERSION = 1;
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function defaultHome(env = process.env) {
  return path.resolve(env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || '.', 'DeepSeek Harness', 'home'));
}

/**
 * 四类判定（纯函数）。
 * @param {{strict:boolean, hasGoods:boolean, hasSignal:boolean}} p
 */
export function classifyRecall({ strict = false, hasGoods = false, hasSignal = true } = {}) {
  if (strict) return 'A';
  if (!hasSignal) return 'D';
  if (!hasGoods) return 'C';
  return 'B';
}

/** 该局是否真的有 claim 入库（support[].episode === 该局）。 */
export function episodeHasClaims(byEpisode, episodeId) {
  const list = byEpisode?.get?.(String(episodeId ?? ''));
  return Array.isArray(list) && list.length > 0;
}

/** 信号是否含可用线索（判别词 ≥2 或 ≥1 硬实体）。 */
export function signalHasCue(signal) {
  return discriminativeTokens(signal).length >= 2 || hardEntities(signal).size >= 1;
}

export function measure({ store, home = defaultHome(), limit = 5, cache = null } = {}) {
  const exam = buildExam({ store, home });
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const byEpisode = claimsByEpisode(claims);
  const walkCache = cache ?? createWalkCache(store);
  const rows = [];
  for (const item of exam?.items ?? []) {
    const at = Number.isFinite(item.at) ? item.at : Date.now();
    const text = item.signal;
    if (!text) continue;
    const signal = signalFromText(text, { at });
    if (item.scopeKey) signal.scopeKey = item.scopeKey;
    let strict = false;
    let rendered = 0;
    try {
      const walk = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit, budgetTokens: 500, cache: walkCache });
      const card = buildMemoryCard({ cache: walkCache, signal, walkResult: walk, store, scope: item.scopeKey, now: at, limit, budgetTokens: 500 });
      const judged = judgeCard({ card, store, item });
      strict = judged.hitStrict;
      rendered = judged.rendered;
    } catch { /* 单条失败按未命中处理 */ }
    const expectedEpisodes = item.expected?.episodes ?? [];
    const hasGoods = expectedEpisodes.some((ep) => episodeHasClaims(byEpisode, ep));
    const cue = signalHasCue(text);
    const cls = classifyRecall({ strict, hasGoods, hasSignal: cue });
    rows.push({
      id: item.id ?? `${item.kind}:${item.episode}`,
      kind: item.kind,
      signalSource: item.signalSource ?? null,
      episode: item.episode,
      expectedEpisodes: expectedEpisodes.length,
      hasGoods,
      hasSignal: cue,
      strict,
      rendered,
      cls,
      signal: String(text).replace(/\s+/g, ' ').slice(0, 80),
    });
  }
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of rows) counts[r.cls] = (counts[r.cls] ?? 0) + 1;
  const n = rows.length;
  const byKind = {};
  for (const r of rows) {
    const k = r.kind === 'repeat' ? 'repeat' : (r.signalSource ?? 'self');
    byKind[k] = byKind[k] ?? { n: 0, A: 0, B: 0, C: 0, D: 0 };
    byKind[k].n += 1;
    byKind[k][r.cls] += 1;
  }
  return { version: COVERAGE_VERSION, n, counts, byKind, rows, claims: claims.length, episodesWithClaims: byEpisode.size };
}

/** C 类人工核：该局真的没货？（返回每个 episode 的 claim 数 + episode 是否存在） */
export function verifyNoGoods({ store, episodes = [] } = {}) {
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const out = [];
  for (const epId of episodes) {
    const ep = store.get('episodes', epId);
    const hits = claims.filter((c) => (Array.isArray(c.support) ? c.support : []).some((s) => String(s?.episode ?? '') === String(epId)));
    out.push({
      episode: epId,
      episodeExists: Boolean(ep),
      state: ep?.state ?? null,
      claimsInLibrary: hits.length,
      claimIds: hits.slice(0, 5).map((c) => c.id),
    });
  }
  return out;
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(2)}%` : 'n/a');

export function formatReport(r) {
  const L = [];
  L.push(`T280 · 召回覆盖率归因 · 考卷 n=${r.n}`);
  L.push('');
  L.push('| 类 | 含义 | 条数 | 占比 |');
  L.push('|---|---|---|---|');
  L.push(`| **A** | 有货且取到（严格命中） | ${r.counts.A} | ${pct(r.counts.A, r.n)} |`);
  L.push(`| **B** | 有货但没取到（**真召回缺陷**） | ${r.counts.B} | ${pct(r.counts.B, r.n)} |`);
  L.push(`| **C** | 无货可召（**覆盖不足**） | ${r.counts.C} | ${pct(r.counts.C, r.n)} |`);
  L.push(`| **D** | 题目无判别性 | ${r.counts.D} | ${pct(r.counts.D, r.n)} |`);
  L.push('');
  L.push('按题型：');
  for (const [k, v] of Object.entries(r.byKind)) L.push(`  ${k}: n=${v.n} A=${v.A} B=${v.B} C=${v.C} D=${v.D}`);
  return L.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = defaultHome();
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = measure({ store, home, limit: Number(opt('limit', '5')) });
  const cEpisodes = r.rows.filter((x) => x.cls === 'C').map((x) => x.episode);
  const verify = argv.includes('--verify-c') ? verifyNoGoods({ store, episodes: [...new Set(cEpisodes)].slice(0, Number(opt('sample', '5'))) }) : null;
  if (argv.includes('--json')) { console.log(JSON.stringify({ ...r, verify }, null, 2)); return 0; }
  console.log(formatReport(r));
  if (verify) {
    console.log('');
    console.log('C 类人工核（该局真的没货？）：');
    for (const v of verify) console.log(`  ${v.episode} · 库中存在=${v.episodeExists} · state=${v.state} · 该局 claim 数=${v.claimsInLibrary}${v.claimIds.length ? ` (${v.claimIds.join(',')})` : ''}`);
  }
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/recall-coverage.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`归因失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}
