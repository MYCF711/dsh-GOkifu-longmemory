#!/usr/bin/env node
// T246 · 把 T237 归因里的 **E 类**（"walk 漏掉"）再拆五档，回答"还能靠排序修好吗"。
//
// 只读：store.list/get + 棋谱（walk 只读）。零模型调用、不写库。
//
// ── 五档（机械、互斥、按优先级判定）─────────────────────────────────────────
//   E5 · inject 预算   理想 claim **进了 walk 的 top-5 hits**，但卡片预算收敛时被丢掉 ⇒ 属 inject 层
//   E4 · 合并组选错人   理想 claim 是某个合并节点的成员，该组被 walk 命中，但选了**别的成员**（pickMergeMember）
//   E3 · 不是候选       理想 claim **不在** targetClaims（limit=∞ 的候选表里都没有）⇒ 本质是 D 类（主题/文本通路没到）
//   E2 · overlap 更低   理想 claim 是候选，但它的 overlap **比 top-5 的最低 overlap 还低**（提第一键反而更吃亏）
//   E1 · overlap 打平   理想 claim 是候选、overlap 不低于 top-5 的最低值，仍被 tie-break（depth/repeat/weight/occurredAt）刷掉
//
// 判定顺序：E5 > E4 > E3 > E2 > E1（先证明"它进了哪一层"，再谈排序）。
//
// 口径：
//   · overlap = **walk 自己的排序键口径**（`mergeSignalNeedles`：signal.terms + entities[].key，小写包含），
//     不是 `a2b-holdout` 的 contentOverlap —— 排序看哪个键，就按哪个键归因；
//   · 候选表 = `walkFromSignals(limit=100000, budget=1e9)` 的 hits（同一条 walk 通路，只是不截断）；
//   · "top-5" = 真实卡片口径 `limit=5, budget=500` 的 hits；"渲染" = `buildMemoryCard` 的 claims。
//
// 用法：`node scripts/a2b-attribution-e2.mjs [--json] [--store <dir>] [--episode ep-xxx]`

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache, walkFromSignals, CLASS_RANK } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';
import { attributeSelfRoot } from './a2b-attribution.mjs';
import { buildExam } from './a2b-holdout.mjs';

export const ATTRIBUTION_E2_VERSION = 1;

/** walk 的排序键口径（与 `walk.mjs` 的 `mergeSignalNeedles` 逐字一致；只读副本，别在这里改口径）。 */
export function walkNeedles(signal) {
  const out = new Set();
  for (const term of Array.isArray(signal?.terms) ? signal.terms : []) {
    const v = String(term ?? '').trim().toLowerCase();
    if (v) out.add(v);
  }
  for (const entity of Array.isArray(signal?.entities) ? signal.entities : []) {
    const v = String(entity?.key ?? '').trim().toLowerCase();
    if (v) out.add(v);
  }
  return [...out];
}

/** overlap = 判别词在文本里出现的个数（walk 排序键 `_tokOverlap` 的同一口径）。 */
export function overlapOf(needles, text) {
  const hay = String(text ?? '').toLowerCase();
  if (!hay) return 0;
  let n = 0;
  for (const needle of needles) if (hay.includes(needle)) n += 1;
  return n;
}

/**
 * 理想 claim 卡在哪一个 tie-break 键（与 `compareHits` 的顺序逐字对应，只读副本）。
 * 只比较"排在它上面、且紧挨着的那一条"——要挤进 top-5，它必须先赢这一条。
 */
export function blockingKey(ideal, above, idealOverlap = null, aboveOverlap = null) {
  if (!ideal || !above) return null;
  // T240 起 overlap 是第一键：先比它（E2 的 blockedBy 就是它）
  if (Number.isFinite(idealOverlap) && Number.isFinite(aboveOverlap) && idealOverlap !== aboveOverlap) return 'overlap';
  const classOf = (hit) => CLASS_RANK[hit?.kind] ?? 9;
  if (classOf(ideal) !== classOf(above)) return 'class';
  if (ideal.depth !== above.depth) return 'depth';
  const repA = Number.isFinite(ideal.repeat) ? ideal.repeat : 1;
  const repB = Number.isFinite(above.repeat) ? above.repeat : 1;
  if (repA !== repB) return 'repeat';
  if (above.weight !== ideal.weight) return 'weight';
  const timeA = Number.isFinite(ideal.occurredAt) ? ideal.occurredAt : Number.NEGATIVE_INFINITY;
  const timeB = Number.isFinite(above.occurredAt) ? above.occurredAt : Number.NEGATIVE_INFINITY;
  if (timeA !== timeB) return 'occurredAt';
  return 'id';
}

/** 合并节点索引：成员 id → 合并节点 claim。 */
function mergeIndex(claims) {
  const byMember = new Map();
  for (const claim of claims) {
    const members = Array.isArray(claim?.merge?.members) ? claim.merge.members : null;
    if (!members || typeof claim.id !== 'string') continue;
    for (const id of members) if (typeof id === 'string' && id) byMember.set(id, claim);
  }
  return byMember;
}

/**
 * 对 E 类每一行做二次归因。
 * @param {{store:object, home?:string, only?:string|null}} p
 */
export function attributeE2({ store, home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home', only = null } = {}) {
  const base = attributeSelfRoot({ store, home, only });
  const eRows = base.rows.filter((row) => row.code === 'E');
  const claims = store.list('claims').map((entry) => entry.record).filter(Boolean);
  const claimById = new Map(claims.map((claim) => [String(claim.id), claim]));
  const byMember = mergeIndex(claims);
  const cache = createWalkCache(store);

  // 用 episode 反查考卷 item（signal / scopeKey / at）
  const exam = base.exam ?? buildExam({ store, home });

  const rows = [];
  for (const eRow of eRows) {
    const item = exam?.items?.find((x) => x.episode === eRow.episode);
    if (!item) {
      rows.push({ ...eRow, e2: 'E3', e2why: '考卷里找不到该 episode（归因脚本口径漂移）', idealId: null, idealOverlap: null, top5: [] });
      continue;
    }
    const at = Number.isFinite(item.at) ? item.at : Date.now();
    const signal = signalFromText(item.signal, { at });
    if (item.scopeKey) signal.scopeKey = item.scopeKey;
    const needles = walkNeedles(signal);

    const walk5 = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit: 5, budgetTokens: 500, cache });
    const walkAll = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit: 100000, budgetTokens: 1_000_000_000, cache });
    const card = buildMemoryCard({ cache, signal, walkResult: walk5, store, scope: item.scopeKey, now: at, limit: 5, budgetTokens: 500 });

    const idOf = (hit) => (typeof hit?.claim === 'string' ? hit.claim : (typeof hit?.claimId === 'string' ? hit.claimId : null));
    const hit5 = (Array.isArray(walk5.hits) ? walk5.hits : []).map(idOf).filter(Boolean);
    const hitAll = (Array.isArray(walkAll.hits) ? walkAll.hits : []).map(idOf).filter(Boolean);
    const rendered = new Set((card.claims ?? []).map((c) => String(c.claimId ?? '')).filter(Boolean));
    const top5 = hit5.map((id) => {
      const rec = claimById.get(id);
      const hit = (walk5.hits ?? []).find((h) => idOf(h) === id);
      return { id, overlap: overlapOf(needles, rec?.text ?? hit?.text ?? ''), text: String(rec?.text ?? hit?.text ?? '').slice(0, 60) };
    });

    // 理想 claim = 期望集合里 overlap 最高的那条（与 T237 同一取法）
    const expected = (item.expected?.claimIds ?? []).map(String);
    let idealId = null;
    let idealOverlap = -1;
    for (const id of expected) {
      const rec = claimById.get(id);
      if (!rec) continue;
      const ov = overlapOf(needles, rec.text ?? '');
      if (ov > idealOverlap) { idealOverlap = ov; idealId = id; }
    }
    if (!idealId) {
      rows.push({ ...eRow, e2: 'E3', e2why: '期望集合里的 claim 都不在库里（无法再归因）', idealId: null, idealOverlap: null, top5 });
      continue;
    }
    const inCandidates = hitAll.includes(idealId);
    const rank = inCandidates ? hitAll.indexOf(idealId) : null;
    // 排在它上一位的那条命中（要进 top-5 必须先赢它）
    const allHits = Array.isArray(walkAll.hits) ? walkAll.hits : [];
    const aboveHit = rank !== null && rank > 0 ? allHits[rank - 1] : null;
    const idealHit = rank !== null ? allHits[rank] : null;
    const aboveOverlap = aboveHit ? overlapOf(needles, claimById.get(idOf(aboveHit))?.text ?? aboveHit.text ?? '') : null;
    const blockedBy = rank !== null && rank > 0 ? blockingKey(idealHit, aboveHit, idealOverlap, aboveOverlap) : null;
    const top5Min = top5.length ? Math.min(...top5.map((x) => x.overlap)) : null;

    const wasRendered = rendered.has(idealId);
    let e2;
    let e2why;
    if (hit5.includes(idealId) && !rendered.has(idealId)) {
      e2 = 'E5';
      e2why = `进了 walk 的 top-5（rank ${hit5.indexOf(idealId) + 1}），但卡片预算收敛时被丢掉`;
    } else if (!inCandidates && byMember.has(idealId)) {
      const node = byMember.get(idealId);
      const groupHit = hit5.includes(node.id) || (Array.isArray(node.merge?.members) ? node.merge.members : []).some((id) => hit5.includes(id));
      if (groupHit) {
        e2 = 'E4';
        e2why = `合并组 ${node.id} 被命中，但 pickMergeMember 选了别的成员（组内 ${node.merge.members.length} 个）`;
      } else {
        e2 = 'E3';
        e2why = '合并组的成员，但该组整体没进候选（主题/文本通路没到）';
      }
    } else if (!inCandidates) {
      e2 = 'E3';
      e2why = '不在 targetClaims（limit=∞ 的候选表里也没有）⇒ 本质是 D 类';
    } else if (wasRendered) {
      // 已经渲染进卡：T237 的严格口径要求"与信号 ≥2 判别词重合"，没达标就记成 E —— 这不是排序问题
      e2 = idealOverlap < (top5Min ?? 0) ? 'E2' : 'E1';
      e2why = `**其实已渲染进卡**（rank ${rank + 1}）：只是与信号 <2 判别词重合，没达到考卷的严格口径 —— 排序不背锅`;
    } else if (idealOverlap < (top5Min ?? 0)) {
      e2 = 'E2';
      e2why = `overlap ${idealOverlap} < top-5 最低 ${top5Min}（判别词没进它的文本，提第一键反而更吃亏）`;
    } else {
      e2 = 'E1';
      e2why = `候选 rank ${rank + 1}，overlap ${idealOverlap} ≥ top-5 最低 ${top5Min}：被 tie-break（depth/repeat/weight/occurredAt）刷掉`;
    }

    rows.push({
      episode: eRow.episode,
      signal: eRow.signal,
      strictHit: eRow.strictHit,
      rendered: eRow.rendered,
      walkHits: eRow.walkHits,
      idealId,
      idealOverlap,
      rank: rank === null ? null : rank + 1,
      overlapRanked: hitAll.length,
      top5,
      top5Min,
      e2,
      e2why,
      wasRendered,
      blockedBy,
      idealText: String(claimById.get(idealId)?.text ?? '').slice(0, 60),
    });
  }

  const counts = {};
  for (const row of rows) counts[row.e2] = (counts[row.e2] ?? 0) + 1;
  const rankingFixable = rows.filter((row) => !row.wasRendered && row.e2 === 'E1');
  const signalFixable = rows.filter((row) => !row.wasRendered && row.e2 === 'E2');
  return {
    version: ATTRIBUTION_E2_VERSION,
    n: rows.length,
    counts,
    renderedButNotStrict: rows.filter((row) => row.wasRendered).length,
    rankingFixable: rankingFixable.length,
    signalFixable: signalFixable.length,
    blockedBy: rows.reduce((acc, row) => {
      const key = `${row.e2}/${row.blockedBy ?? (row.wasRendered ? 'rendered' : '-')}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    rows,
  };
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

export function formatReport(r) {
  const lines = [];
  lines.push(`T246 · E 类二次归因 · n=${r.n}`);
  lines.push('');
  lines.push(`- 其实**已渲染进卡**（考卷严格口径 <2 判别词，非排序问题）：**${r.renderedButNotStrict} 条**`);
  lines.push(`- **还能靠排序修好**（候选被 tie-break 刷掉、未渲染）：**${r.rankingFixable} 条**`);
  lines.push(`- 只能靠**信号/词面**修（overlap 本身更低、未渲染）：**${r.signalFixable} 条**`);
  lines.push('');
  lines.push('| 档 | 条数 | 占比 | 含义 |');
  lines.push('|---|---|---|---|');
  const meaning = {
    E1: 'overlap 打平，被 tie-break（depth/repeat/weight/occurredAt）刷掉',
    E2: 'overlap 比通用错误更低（判别词没进它的文本）',
    E3: '不是候选（= D 类：主题/文本通路没到）',
    E4: '合并组被命中但选了别的成员',
    E5: '进了 top-5，被 inject 预算丢掉',
  };
  for (const code of ['E1', 'E2', 'E3', 'E4', 'E5']) {
    const n = r.counts[code] ?? 0;
    lines.push(`| **${code}** | ${n} | ${pct(n, r.n)} | ${meaning[code]} |`);
  }
  lines.push('');
  for (const code of ['E1', 'E2', 'E3', 'E4', 'E5']) {
    const list = r.rows.filter((row) => row.e2 === code).slice(0, 2);
    if (!list.length) continue;
    lines.push(`### ${code}（${(r.counts[code] ?? 0)} 条中前 ${list.length} 条）`);
    for (const row of list) {
      lines.push(`- \`${row.episode}\` · 任务「${row.signal}」`);
      lines.push(`  - 期望最优 claim \`${row.idealId}\`（overlap=${row.idealOverlap}，候选 rank=${row.rank ?? 'n/a'}/${row.overlapRanked}）· 正文：${row.idealText}`);
      lines.push(`  - 挤掉它的 top-5 overlap：${row.top5.map((x) => `${x.id}=${x.overlap}`).join(' · ') || '(空)'}`);
      lines.push(`  - ${row.e2why}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = attributeE2({ store, home, only: opt('episode', null) });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(formatReport(r));
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/a2b-attribution-e2.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`归因失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}
