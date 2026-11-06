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

/**
 * J1 · 判别词（契约 §J1，逐字实现）
 *   text.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(t => t.length >= 4 && t !== 'path')
 */
export function contractTokens(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((t) => t.length >= 4 && t !== 'path');
}

/** J1 重合数：判别词在 claim 文本里的出现次数。 */
export function tokenOverlap(signalText, claimText) {
  const hay = String(claimText ?? '').toLowerCase();
  return contractTokens(signalText).filter((t) => hay.includes(t)).length;
}

/**
 * J2 · 判别性 bigram（契约 §J2，逐字实现）
 *   中文连续段 2 字滑窗；英文/数字/路径 split(/[^a-z0-9_./-]+/)，长度 ≥3 保留（_ - . / 不切）
 */
export function contractBigrams(text) {
  const out = new Set();
  const src = String(text ?? '');
  for (const run of src.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  for (const tok of src.toLowerCase().split(/[^a-z0-9_./-]+/)) if (tok.length >= 3) out.add(tok);
  return out;
}

/** J2 词表 df + N（N = 全库 claim 数）。 */
export function buildDf(claimTexts) {
  const df = new Map();
  let n = 0;
  for (const t of claimTexts) {
    if (!t) continue;
    n += 1;
    for (const term of contractBigrams(t)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return { df, n };
}

/** J2 重合数（只数判别性 bigram：df/N ≤ MAX_DF_RATIO）。 */
export function bigramOverlap(signalText, claimText, { df, n } = {}) {
  const hay = String(claimText ?? '').toLowerCase();
  let hits = 0;
  for (const bg of contractBigrams(signalText)) {
    if (!hay.includes(bg)) continue;
    const d = df?.get?.(bg) ?? 0;
    const discriminative = !n || d / n <= MAX_DF_RATIO;
    if (discriminative) hits += 1;
  }
  return hits;
}

/**
 * J3 · 硬实体（契约 §J3，逐字实现六条模式 + 归一化 + basename）
 */
export const HARD_ENTITY_PATTERNS = Object.freeze([
  // 文件路径：Windows 盘符 / POSIX 绝对路径
  /[A-Za-z]:[\\/][\w./\\-]{3,}/g,
  /(?:^|[\s"'(=])\/(?:[\w.-]+\/)*[\w.-]{3,}/g,
  // 错误码 / 错误类
  /\bclass:[a-z0-9-]+\b/gi,
  /\b(?:ENOENT|EACCES|EPERM|EEXIST|ECONNREFUSED|ETIMEDOUT|MODULE_NOT_FOUND|ERR_[A-Z_]+)\b/g,
  // 包名（scoped 或无 scope）
  /(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]+\/[a-z0-9][a-z0-9._-]+/gi,
  // 命令（git/node/npm/go/python/bash… + 少量参数）
  /\b(?:git|node|npm|pnpm|yarn|go|python|bash|pwsh|powershell|curl|gh)\b(?:\s+[-\w./=:]{1,40}){0,4}/gi,
]);

export function contractEntities(text) {
  const raw = String(text ?? '');
  const out = new Set();
  for (const re of HARD_ENTITY_PATTERNS) {
    re.lastIndex = 0;
    for (const m of raw.matchAll(re)) {
      const value = String(m[0] ?? '').trim().replace(/^[\s"'(=]+|[\s"'),.]+$/g, '');
      if (value.length < 3) continue;
      out.add(value.toLowerCase());
      const base = value.split(/[\/]/).pop();
      if (base && base.length >= 6 && /[._-]/.test(base)) out.add(base.toLowerCase());
    }
  }
  return out;
}

export function sharedEntities(signalText, claimText) {
  const a = contractEntities(signalText);
  if (!a.size) return [];
  const b = contractEntities(claimText);
  if (!b.size) return [];
  return [...a].filter((x) => b.has(x));
}

/**
 * J4 · 判中条件（契约 §J4）：
 *   related ∧ ( 判别词 ≥2 ∨ 判别性 bigram ≥2 ∨ 共享硬实体 ≥1 )
 */
export function judge({ signal, claimText, related, df, n }) {
  if (!related) return { strict: false, overlap: 0, bigram: 0, shared: [] };
  const overlap = tokenOverlap(signal, claimText);
  const bigram = bigramOverlap(signal, claimText, { df, n });
  const shared = sharedEntities(signal, claimText);
  return { strict: overlap >= 2 || bigram >= 2 || shared.length >= 1, overlap, bigram, shared };
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
    let best = { overlap: 0, bigram: 0, shared: [] };
    for (const row of Array.isArray(card?.claims) ? card.claims : []) {
      const id = String(row?.claimId ?? '');
      if (!id) continue;
      const rec = store.get('claims', id);
      // 契约 §J4：related = support 含该局 **或** claim id 在 expected.claimIds 里（两条都要，缺一条就偏离契约）
      const supportHit = (Array.isArray(rec?.support) ? rec.support : []).some((s) => String(s?.episode ?? '') === String(item.episode));
      const idHit = Array.isArray(item.expectedClaimIds) && item.expectedClaimIds.map(String).includes(id);
      const related = supportHit || idHit;
      if (!related) continue;
      const j = judge({ signal: item.signal, claimText: String(rec?.text ?? ''), related, df, n });
      if (j.overlap + j.bigram + j.shared.length > best.overlap + best.bigram + best.shared.length) best = j;
      if (j.strict) { hit = true; break; }
    }
    out.push({ itemId: item.itemId, episode: item.episode, kind: item.kind, mine: hit, main: Boolean(item.hitStrict), overlap: best.overlap, bigram: best.bigram, shared: best.shared.length, rendered: (card?.claims ?? []).length });
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
