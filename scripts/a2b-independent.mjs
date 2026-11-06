#!/usr/bin/env node
// T314 · 主判据的**独立实现**（G3：换实现复算同一个数）
//
// 纪律：**不 import `scripts/a2b-holdout.mjs`**（那就不叫独立实现了）。
// 可以复用产品代码：`src/rooms/walk.mjs`（取卡）与 `src/rooms/inject.mjs`（建卡）——那是产品，不是判据。
//
// 判据**自己写**：
//   related = 卡片里某条 claim 的 support 含该局
//   重合     = 中文 bigram（df/N ≤ 2% 才算判别性）+ 英文/数字 token（≥4 字）
//   strict   = related && (bigram ≥2 || token ≥2)
//
// 用法：node scripts/a2b-independent.mjs [--exam evidence/a2b-holdout.json] [--json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache, walkFromSignals } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MAX_DF_RATIO = 0.02;

/** 中文 bigram（2 字滑窗）+ 英文/数字 token（≥4 字，路径整体保留）。 */
export function myTerms(text) {
  const src = String(text ?? '');
  const out = new Set();
  for (const run of src.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  for (const tok of src.toLowerCase().split(/[^a-z0-9_./-]+/)) if (tok.length >= 4) out.add(tok);
  return out;
}

/** 词表 df（出现在多少条 claim 里）+ N。 */
export function buildDf(claimTexts) {
  const df = new Map();
  let n = 0;
  for (const t of claimTexts) {
    if (!t) continue;
    n += 1;
    for (const term of myTerms(t)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return { df, n };
}

/** 判据核心（自己写，独立于 a2b-holdout）。 */
export function judge({ signal, claimText, related, df, n }) {
  if (!related) return { strict: false, overlap: 0, terms: 0 };
  const hay = String(claimText ?? '').toLowerCase();
  let overlap = 0;
  let terms = 0;
  for (const term of myTerms(signal)) {
    terms += 1;
    if (!hay.includes(term)) continue;
    const d = df.get(term) ?? 0;
    const discriminative = n > 0 ? d / n <= MAX_DF_RATIO : true;
    if (discriminative) overlap += 1;
  }
  return { strict: overlap >= 2, overlap, terms };
}

export function run({ store, examPath = path.join(REPO_ROOT, 'evidence', 'a2b-holdout.json'), limit = 5 } = {}) {
  const exam = JSON.parse(fs.readFileSync(examPath, 'utf8'));
  const items = Array.isArray(exam.results) ? exam.results : [];
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const { df, n } = buildDf(claims.map((c) => String(c.text ?? '')));
  const cache = createWalkCache(store);
  const claimsCount = claims.length;
  const examClaimsCount = Number.isFinite(exam.claimsCount) ? Number(exam.claimsCount) : null;
  let missingAt = 0;
  const out = [];
  for (const item of items) {
    // T315：用考卷里**钉死**的 at（缺省才回退到当前时间，并记警告）
    const at = Number.isFinite(item.at) ? Number(item.at) : Date.now();
    if (!Number.isFinite(item.at)) missingAt += 1;
    const sig = signalFromText(item.signal, { at });
    if (item.scopeKey) sig.scopeKey = item.scopeKey;
    const walk = walkFromSignals({ signal: sig, store, scope: item.scopeKey, depth: 2, limit, budgetTokens: 500, cache });
    const card = buildMemoryCard({ cache, signal: sig, walkResult: walk, store, scope: item.scopeKey, now: at, limit, budgetTokens: 500 });
    let hit = false;
    let best = { overlap: 0, terms: 0 };
    for (const row of Array.isArray(card?.claims) ? card.claims : []) {
      const id = String(row?.claimId ?? '');
      if (!id) continue;
      const rec = store.get('claims', id);
      const related = (Array.isArray(rec?.support) ? rec.support : []).some((s) => String(s?.episode ?? '') === String(item.episode));
      if (!related) continue;
      const j = judge({ signal: item.signal, claimText: String(rec?.text ?? ''), related, df, n });
      if (j.overlap > best.overlap) best = j;
      if (j.strict) { hit = true; break; }
    }
    out.push({ itemId: item.itemId, episode: item.episode, kind: item.kind, mine: hit, main: Boolean(item.hitStrict), overlap: best.overlap, terms: best.terms, rendered: (card?.claims ?? []).length });
  }
  const mineHits = out.filter((x) => x.mine).length;
  const mainHits = out.filter((x) => x.main).length;
  const disagree = out.filter((x) => x.mine !== x.main);
  return { n: out.length, mineHits, mainHits, claimsCount, examClaimsCount, storeChanged: examClaimsCount !== null && examClaimsCount !== claimsCount, missingAt, agree: out.length - disagree.length, disagree, rows: out, mainRate: mainHits / out.length, mineRate: mineHits / out.length };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home';
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = run({ store, examPath: path.resolve(opt('exam', path.join(REPO_ROOT, 'evidence', 'a2b-holdout.json'))) });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  console.log(`T314 · 独立实现复算 · 考卷 ${r.n} 条`);
  console.log(`我的实现：严格 ${r.mineHits}/${r.n} = ${pct(r.mineRate)}`);
  console.log(`主判据  ：严格 ${r.mainHits}/${r.n} = ${pct(r.mainRate)}`);
  console.log(`一致 ${r.agree}/${r.n} · 不一致 ${r.disagree.length}`);
  console.log(`库规模：考卷 ${r.examClaimsCount ?? 'n/a'} vs 当前 ${r.claimsCount}${r.storeChanged ? ' ⇒ **库变了，不是同一次测量**' : '（一致）'} · 缺 at 的题 ${r.missingAt}`);
  for (const d of r.disagree.slice(0, 20)) console.log(`  ✗ ${d.itemId} · 我=${d.mine ? '中' : '不中'} 主=${d.main ? '中' : '不中'} · overlap=${d.overlap} · ${d.episode}`);
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/a2b-independent.mjs')) {
  main().then((c) => { process.exitCode = c; }).catch((e) => { console.error(`独立复算失败：${String(e?.message ?? e)}`); process.exitCode = 2; });
}
