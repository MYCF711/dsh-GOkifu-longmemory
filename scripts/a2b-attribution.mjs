#!/usr/bin/env node
// T237 · self/root 考卷（n=69）的**逐条归因**：为什么"该局任务原话 → 该局自身教训"召回只有 13%。
//
// 只读：store.list/get + 棋谱（walk 会读，但只读）。零模型调用。
//
// ── 五类归因（机械、互斥、按优先级判定）───────────────────────────────────
//   A · 信号太泛     判别词 < 2（如「处理一下」「继续」）⇒ 任何检索都不可能命中
//   B · 信号错位     有实体级重合（路径/包名/命令片段），但**判别词**重合 = 0
//                    （中文任务原话 vs 英文错误文本/路径 ⇒ 词面不交集）
//   C · 目标不存在   实体级重合也 = 0 ⇒ 该局任务在库里没有可召回的 claim（**不是系统的错**）
//   D · 主题没抽到   claim 与任务有词面重合，但 walk 从未命中该 claim 支撑的**那一局**
//                    （episode 主题没抽到 ⇒ 检索入口就不存在）
//   E · walk 漏掉     walk 命中了该局，但该 claim 没进卡片（排序/limit/budget 刷掉）
//
// 判定顺序：命中(strict) > A > (B|C|D|E)。互斥由顺序保证。
//
// 用法：node scripts/a2b-attribution.mjs [--json] [--episode ep-xxx] [--store <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache, walkFromSignals } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';
import { buildExam, discriminativeTokens, overlapCount } from './a2b-holdout.mjs';

export const ATTRIBUTION_VERSION = 1;
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 实体级判别（比 discriminativeTokens 更松：≥3 字符 + 中文二元组）。 */
export function entityTokens(text) {
  const raw = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const tok of raw.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (tok.length >= 3 && tok !== 'path') out.add(tok);
  }
  // 中文二元组（词面重合在中文里靠 2-gram 才抓得到）
  const cjk = raw.replace(/[^\u4e00-\u9fff]+/g, ' ');
  for (const run of cjk.split(' ')) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 中文感知的字面重合（ASCII 词 ≥4 + 中文二元组）：用于判"claim 与任务到底有没有词面交集"。 */
export function contentOverlap(signal, text) {
  const hay = String(text ?? '').toLowerCase();
  let n = 0;
  for (const tok of discriminativeTokens(signal)) if (hay.includes(tok)) n += 1;
  const cjk = String(signal ?? '').toLowerCase().replace(/[^一-鿿]+/g, ' ');
  for (const run of cjk.split(' ')) {
    for (let i = 0; i + 2 <= run.length; i += 1) if (hay.includes(run.slice(i, i + 2))) n += 1;
  }
  return n;
}

export function entityOverlap(a, b) {
  const ta = entityTokens(a);
  const tb = String(b ?? '').toLowerCase();
  let n = 0;
  for (const tok of ta) if (tb.includes(tok)) n += 1;
  return n;
}

/**
 * 五类归因（纯函数）。
 * @param {{signal:string, expectedClaimIds:string[], claimById:Map, walkEpisodes:Set<string>,
 *          renderedClaimIds:Set<string>, strictHit:boolean}} p
 */
export function classifySelfFailure({ signal = '', expectedClaimIds = [], claimById = new Map(), walkEpisodes = new Set(), renderedClaimIds = new Set(), hitClaimIds = new Set(), strictHit = false } = {}) {
  if (strictHit) return { code: 'hit', why: '严格命中（related 且与信号 ≥2 判别词重合）' };
  const sigEntity = entityTokens(signal);
  const shortSignal = String(signal ?? '').trim().length < 12;
  let bestToken = 0;
  let bestEntity = 0;
  let bestClaimId = null;
  let relatedButNotRendered = false;
  let supportEpisodeHit = false;
  for (const id of expectedClaimIds) {
    const claim = claimById.get(String(id));
    if (!claim) continue;
    const tok = contentOverlap(signal, claim.text ?? '');
    const ent = [...sigEntity].filter((t) => String(claim.text ?? '').toLowerCase().includes(t)).length;
    if (tok > bestToken) { bestToken = tok; bestClaimId = String(id); }
    if (ent > bestEntity) bestEntity = ent;
    const eps = (Array.isArray(claim.support) ? claim.support : []).map((s) => String(s?.episode ?? ''));
    if (!renderedClaimIds.has(String(id))) relatedButNotRendered = true;
    if (eps.some((ep) => walkEpisodes.has(ep))) supportEpisodeHit = true;
  }
  if (shortSignal) {
    return { code: 'A', why: `信号太泛/太短（${String(signal).trim().length} 字）：${JSON.stringify(String(signal).trim().slice(0, 40))}`, bestToken, bestEntity };
  }
  if (bestToken >= 1) {
    // 精确化：**词面最重合的那条** claim 是不是 walk 的候选（hits）
    //   是 ⇒ 它被 limit/budget 刷掉了（E · walk 漏掉）
    //   否 ⇒ 它从没进过候选集（D · 主题/索引没抽到）
    // 判据：**该局是否被 walk 命中**（命中 ⇒ claim 是候选，只是没进 top-N）。
    // 不能看"claim 在不在 hits 里"——hits 本身被 limit=5 截断，会人为放大 D 类。
    const inHits = supportEpisodeHit;
    return {
      code: inHits ? 'E' : 'D',
      why: inHits
        ? `该局被 walk 命中，词面最重合的 claim（${bestClaimId}，${bestToken} 个重合）是候选，但被 limit/排序刷出 top-5`
        : `词面最重合的 claim（${bestClaimId ?? '?'}，${bestToken} 个重合）所在的那一局**从未被 walk 命中**（主题没抽到）`,
      bestToken,
      bestEntity,
    };
  }
  if (bestEntity >= 1) {
    return { code: 'B', why: `信号错位：判别词重合 0，只有 ${bestEntity} 个实体级重合（路径/包名/中文二元组）`, bestToken, bestEntity };
  }
  return { code: 'C', why: '目标不存在：该局 claim 与任务原话既无判别词重合、也无实体级重合', bestToken, bestEntity };
}

/** 跑 69 条 self/root 并逐条归因。 */
export function attributeSelfRoot({ store, home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home', only = null } = {}) {
  const exam = buildExam({ store, home });
  const items = exam.items.filter((x) => x.kind === 'self' && x.signalSource === 'root' && (!only || x.episode === only));
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const claimById = new Map(claims.map((c) => [String(c.id), c]));
  const cache = createWalkCache(store);
  const rows = [];
  for (const item of items) {
    const at = Number.isFinite(item.at) ? item.at : Date.now();
    const signal = signalFromText(item.signal, { at });
    if (item.scopeKey) signal.scopeKey = item.scopeKey;
    const walk = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit: 5, budgetTokens: 500, cache });
    const card = buildMemoryCard({ cache, signal, walkResult: walk, store, scope: item.scopeKey, now: at, limit: 5, budgetTokens: 500 });
    const rendered = (card.claims ?? []).map((c) => String(c.claimId ?? '')).filter(Boolean);
    const renderedSet = new Set(rendered);
    const walkEpisodes = new Set();
    for (const hit of Array.isArray(walk?.hits) ? walk.hits : []) {
      const cid = typeof hit?.claim === 'string' ? hit.claim : (typeof hit?.claimId === 'string' ? hit.claimId : null);
      if (!cid) continue;
      const rec = claimById.get(cid);
      for (const s of Array.isArray(rec?.support) ? rec.support : []) if (s?.episode) walkEpisodes.add(String(s.episode));
      if (hit?.episode) walkEpisodes.add(String(hit.episode));
    }
    const expected = (item.expected?.claimIds ?? []).map(String);
    let strictHit = false;
    for (const id of expected) {
      if (!renderedSet.has(id)) continue;
      const rec = claimById.get(id);
      if (overlapCount(item.signal, rec?.text ?? '') >= 2) { strictHit = true; break; }
    }
    const hitIds = new Set((Array.isArray(walk?.hits) ? walk.hits : []).map((h) => (typeof h?.claim === 'string' ? h.claim : (typeof h?.claimId === 'string' ? h.claimId : null))).filter(Boolean));
    const v = classifySelfFailure({ signal: item.signal, expectedClaimIds: expected, claimById, walkEpisodes, renderedClaimIds: renderedSet, hitClaimIds: hitIds, strictHit });
    rows.push({
      episode: item.episode,
      signal: String(item.signal).replace(/\s+/g, ' ').slice(0, 40),
      expectedClaims: expected.length,
      rendered: rendered.length,
      walkHits: Array.isArray(walk?.hits) ? walk.hits.length : 0,
      matchedTopics: Array.isArray(walk?.matched?.topics) ? walk.matched.topics.length : 0,
      strictHit,
      code: v.code,
      why: v.why,
      bestToken: v.bestToken ?? 0,
      bestEntity: v.bestEntity ?? 0,
      sampleExpected: expected.slice(0, 3),
    });
  }
  const counts = {};
  for (const r of rows) counts[r.code] = (counts[r.code] ?? 0) + 1;
  const failures = rows.filter((r) => r.code !== 'hit');
  const realFailures = failures.filter((r) => !['A', 'C'].includes(r.code));
  return {
    version: ATTRIBUTION_VERSION,
    n: rows.length,
    counts,
    hit: counts.hit ?? 0,
    failures: failures.length,
    realFailures: realFailures.length,
    rows,
  };
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(2)}%` : 'n/a');

export function formatReport(r) {
  const lines = [];
  lines.push(`T237 · self/root 归因 · n=${r.n} · 严格命中 ${r.hit}（${pct(r.hit, r.n)}）· 未命中 ${r.failures}`);
  lines.push(`其中"该召回却没召回"（A/C 之外）= ${r.realFailures} 条`);
  lines.push('');
  lines.push('| 类 | 条数 | 占未命中 | 含义 |');
  lines.push('|---|---|---|---|');
  const meaning = {
    A: '信号太泛（判别词 <2）', B: '信号错位（只有实体级重合）', C: '目标不存在（无任何重合，不算系统的错）',
    D: '主题没抽到（walk 没命中该局）', E: 'walk 漏掉（命中该局但 claim 没进卡）',
  };
  for (const code of ['A', 'B', 'C', 'D', 'E']) {
    const n = r.counts[code] ?? 0;
    if (!n) continue;
    lines.push(`| **${code}** | ${n} | ${pct(n, r.failures)} | ${meaning[code]} |`);
  }
  lines.push('');
  for (const code of ['A', 'B', 'C', 'D', 'E']) {
    const list = r.rows.filter((x) => x.code === code).slice(0, 3);
    if (!list.length) continue;
    lines.push(`### ${code} 类例子（${(r.counts[code] ?? 0)} 条中前 ${list.length} 条）`);
    for (const x of list) {
      lines.push(`- \`${x.episode}\` · 任务「${x.signal}」· 期望 ${x.expectedClaims} 条 · 渲染 ${x.rendered} 条 · walk 命中 ${x.walkHits} · 判别词重合 best=${x.bestToken} / 实体 ${x.bestEntity}`);
      lines.push(`  - ${x.why}`);
      lines.push(`  - 可回溯 claimId 示例：\`${x.sampleExpected.join('`, `')}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = attributeSelfRoot({ store, home, only: opt('episode', null) });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(formatReport(r));
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/a2b-attribution.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`归因失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}
