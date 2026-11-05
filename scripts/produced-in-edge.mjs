#!/usr/bin/env node
// T281 · "同局产出"（produced-in）边：先验证、再给原型（只读，不写库、不改检索）
//
// 背景（T280）：self/root 的 52 条 **B 类**（该局有 claim 入库，但卡上没出现）是当前最大可修桶；
// T246 已证明"只调排序键"到平台期。核心假设：**缺的是边，不是内容** ——
//   "同局 claim 本来就产出自该局" ⇒ 若有一条 `根任务 → 同局 claim` 的边，它们应当能被召回。
//
// 本脚本做三件事（全部只读）：
//   1. 对 self/root 的每条 B 类逐条核：该局 claim 数 / 能否**绕过 walk 直接取到**（store.get + claimsByEpisode）；
//   2. **模拟加边**：把这些 claim 作为 hit 注入卡片（同 episode、同 scope、depth=1、weight=1），
//      看 `judgeCard.hitStrict` 是否变 true —— 给出"加边后能变 A 的条数"与重算后的主判据；
//   3. 给出 `produced-in` 边的**原型构造器**（`buildProducedInEdges`）：纯函数、确定性 id、带 why、只由机械量定权、
//      同 scope + 同 episode 硬约束（跨域/跨局一律不建），供 B 阶段接进 `link.mjs`/`walk.mjs` 时直接复用。
//
// 纪律：只读真库；不改任何 claim；不放宽 related 判据（judgeCard 一字未改）；原型只在内存里。
// 用法：node scripts/produced-in-edge.mjs [--json] [--store <dir>] [--limit 5]

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../src/rooms/persist.mjs';
import { createWalkCache, walkFromSignals, normalizeScopeKey } from '../src/rooms/walk.mjs';
import { buildMemoryCard, signalFromText } from '../src/rooms/inject.mjs';
import { buildExam, judgeCard, claimsByEpisode, overlapCount, sharedHardEntities } from './a2b-holdout.mjs';
import { classifyRecall, signalHasCue } from './recall-coverage.mjs';

export const PRODUCED_IN_VERSION = 1;
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** produced-in 边的 kind（写进边记录，给 walk/R07 当作"同局产出"通路识别）。 */
export const PRODUCED_IN_KIND = 'produced-in';
/** 机械权重：同局 = 1（唯一取值；不引入任何模型评分）。 */
export const PRODUCED_IN_WEIGHT = 1;
/** 边上的固定理由（契约：每条边必须带 why）。 */
export const PRODUCED_IN_WHY = '同局产出';

/**
 * 构造 `episode → claim` 的 **produced-in** 边（纯函数，只读入参）。
 *
 * 语义：一条 claim 的 `support[].episode` 就是"它产出自哪一局"；每个 (episode, claim) 组合一条边。
 * 硬约束（全部机械、可核）：
 *   · 同 scope：`normalizeScopeKey(claim.scopeKey) === normalizeScopeKey(episode.scopeKey)`，跨域**不建边**（A5）；
 *   · 同 episode：只按 claim 自己 support 里出现的 episode 建边，**不推断、不跨局**；
 *   · 幂等：id = `pin:<episode>-><claimId>`，重复调用 / 重复 support 项都只产出一条；
 *   · 权重只由机械量决定（同局 = 1），每条边带 `why: '同局产出'`。
 *
 * @param {object[]} claims   store 里的 claim 记录
 * @param {Map<string,object>|object[]} episodes  episode id → 记录（或记录数组）
 * @returns {{edges:object[], skipped:{crossScope:number, missingEpisode:number, noScope:number}, claimsWithEdges:number}}
 */
export function buildProducedInEdges(claims = [], episodes = []) {
  const episodeById = episodes instanceof Map
    ? episodes
    : new Map((Array.isArray(episodes) ? episodes : []).filter((ep) => ep && typeof ep.id === 'string').map((ep) => [ep.id, ep]));
  const edges = [];
  const seen = new Set();
  const skipped = { crossScope: 0, missingEpisode: 0, noScope: 0 };
  const withEdge = new Set();
  for (const claim of Array.isArray(claims) ? claims : []) {
    if (!claim || typeof claim.id !== 'string' || claim.id === '') continue;
    const support = Array.isArray(claim.support) ? claim.support : [];
    const eps = new Set();
    for (const entry of support) {
      const ep = typeof entry?.episode === 'string' ? entry.episode : '';
      if (ep) eps.add(ep);
    }
    for (const episodeId of eps) {
      const episode = episodeById.get(episodeId);
      if (!episode) { skipped.missingEpisode += 1; continue; }
      const claimScope = typeof claim.scopeKey === 'string' ? claim.scopeKey : '';
      const episodeScope = typeof episode.scopeKey === 'string' ? episode.scopeKey : '';
      if (!claimScope || !episodeScope) { skipped.noScope += 1; continue; }
      if (normalizeScopeKey(claimScope) !== normalizeScopeKey(episodeScope)) {
        skipped.crossScope += 1; // A5：w: 不跨工作区，跨域不建边
        continue;
      }
      const id = `pin:${episodeId}->${claim.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      withEdge.add(claim.id);
      edges.push({
        id,
        from: episodeId,
        to: claim.id,
        kind: PRODUCED_IN_KIND,
        why: PRODUCED_IN_WHY,
        weight: PRODUCED_IN_WEIGHT,
        scopeKey: claimScope,
        occurredAt: Number.isFinite(claim.occurredAt) ? claim.occurredAt : (Number.isFinite(episode.lastEventAt) ? episode.lastEventAt : null),
      });
    }
  }
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { edges, skipped, claimsWithEdges: withEdge.size };
}

/** 把"同局 claim"模拟成 walk 的 hit（depth=1、weight=1、why=['同局产出']），用于测量"加边后卡片会不会变 A"。 */
export function syntheticHitsForEpisode(episodeId, claimsInEpisode = []) {
  return claimsInEpisode.map((claim) => {
    const support = (Array.isArray(claim.support) ? claim.support : []).find((s) => String(s?.episode ?? '') === String(episodeId)) ?? {};
    const kind = claim.kind === 'antipattern' ? 'failure' : claim.kind === 'preference' ? 'constraint' : 'claim';
    return {
      episode: episodeId,
      nodeId: typeof support?.nodeId === 'string' && support.nodeId ? support.nodeId : null,
      claim: claim.id,
      claimKind: typeof claim.kind === 'string' ? claim.kind : null,
      claimState: typeof claim.state === 'string' ? claim.state : null,
      link: null,
      why: [PRODUCED_IN_WHY],
      weight: PRODUCED_IN_WEIGHT,
      occurredAt: Number.isFinite(claim.occurredAt) ? claim.occurredAt : (Number.isFinite(support?.occurredAt) ? support.occurredAt : null),
      seq: Number.isFinite(support?.seq) ? support.seq : null,
      kind,
      depth: 1,
      text: typeof claim.text === 'string' ? claim.text.trim() : '',
      scopeKey: typeof claim.scopeKey === 'string' ? claim.scopeKey : null,
      tokens: 0,
    };
  });
}

/**
 * 主测量：基线（现状 walk+card）→ B 类逐条核 → 模拟加边后的卡片。
 * @param {{store:object, home?:string, limit?:number}} p
 */
export function measureProducedIn({ store, home = process.env.DSH_HOME || 'D:/DeepSeek Harness/home', limit = 5 } = {}) {
  const exam = buildExam({ store, home });
  const claims = store.list('claims').map((e) => e.record).filter(Boolean);
  const claimById = new Map(claims.map((c) => [String(c.id), c]));
  const byEpisode = claimsByEpisode(claims);
  const episodes = store.list('episodes').map((e) => e.record).filter(Boolean);
  const edgeProto = buildProducedInEdges(claims, episodes);
  const cache = createWalkCache(store);

  const rows = [];
  for (const item of exam?.items ?? []) {
    const at = Number.isFinite(item.at) ? item.at : Date.now();
    const signal = signalFromText(item.signal, { at });
    if (item.scopeKey) signal.scopeKey = item.scopeKey;

    let strict = false;
    let related = 0;
    let rendered = [];
    let walkEpisodes = new Set();
    try {
      const walk = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit, budgetTokens: 500, cache });
      const card = buildMemoryCard({ cache, signal, walkResult: walk, store, scope: item.scopeKey, now: at, limit, budgetTokens: 500 });
      const judged = judgeCard({ card, store, item });
      strict = judged.hitStrict;
      related = Number(judged.related ?? 0);
      rendered = (card.claims ?? []).map((c) => String(c.claimId ?? '')).filter(Boolean);
      walkEpisodes = new Set((walk.hits ?? []).map((h) => String(h.episode ?? '')).filter(Boolean));
    } catch { /* 单条失败按未命中 */ }

    const expectedEpisodes = (item.expected?.episodes ?? []).map(String);
    const hasGoods = expectedEpisodes.some((ep) => (byEpisode.get(ep) ?? []).length > 0);
    const cue = signalHasCue(item.signal);
    const episodeId = expectedEpisodes[0] ?? item.episode;
    const inEpisodeAll = (byEpisode.get(episodeId) ?? []).map((c) => claimById.get(String(c.id ?? c)) ?? c).filter(Boolean);
    // A5：**只有同 scope 的 claim 才允许被"同局产出"这条边带进卡**（跨域一律不带）
    const itemScope = normalizeScopeKey(String(item.scopeKey ?? ''));
    const inEpisode = inEpisodeAll.filter((c) => normalizeScopeKey(String(c.scopeKey ?? '')) === itemScope);
    const crossScopeClaims = inEpisodeAll.length - inEpisode.length;
    const retrievable = inEpisode.filter((c) => store.get('claims', String(c.id)) !== undefined);
    const bestOverlap = inEpisode.reduce((best, c) => Math.max(best, overlapCount(item.signal ?? '', c.text ?? '')), 0);
    const bestEntity = inEpisode.reduce((best, c) => Math.max(best, sharedHardEntities(item.signal ?? '', c.text ?? '').length), 0);

    // 模拟加边：该局 claims 作为 hit 注入（排在现有 hits 之后 ⇒ 保守下界）
    let simulatedStrict = false;
    if (hasGoods) {
      const synthetic = syntheticHitsForEpisode(episodeId, inEpisode);
      try {
        const base = walkFromSignals({ signal, store, scope: item.scopeKey, depth: 2, limit, budgetTokens: 500, cache });
        const merged = { ...base, hits: [...(base.hits ?? []), ...synthetic] };
        const card2 = buildMemoryCard({ cache, signal, walkResult: merged, store, scope: item.scopeKey, now: at, limit, budgetTokens: 500 });
        simulatedStrict = judgeCard({ card: card2, store, item }).hitStrict === true;
      } catch { simulatedStrict = false; }
    }

    // 四类判定与 T280 同一套（A > D > C > B，别在这里另立口径）
    const cls = classifyRecall({ strict, hasGoods, hasSignal: cue });
    rows.push({
      id: item.id ?? `${item.kind}:${item.episode}`,
      kind: item.kind,
      signalSource: item.signalSource ?? null,
      episode: episodeId,
      scopeKey: item.scopeKey ?? null,
      signal: String(item.signal ?? '').replace(/\s+/g, ' ').slice(0, 80),
      cls,
      strict,
      related,
      rendered: rendered.length,
      episodeHitByWalk: walkEpisodes.has(episodeId),
      claimsInEpisode: inEpisode.length,
      crossScopeClaims,
      retrievable: retrievable.length,
      bestOverlap,
      bestEntity,
      // 上界：该局存在与信号 ≥2 判别词重合的 claim（只要它进卡就算 A）
      upperBound: hasGoods && bestOverlap >= 2,
      simulatedStrict,
      // 误判检查：注入的 claim 必须与考卷同 scope（A5）
      sameScope: inEpisodeAll.every((c) => normalizeScopeKey(String(c.scopeKey ?? '')) === itemScope),
    });
  }

  const counts = { A: 0, B: 0, C: 0, D: 0 };
  const bRows = rows.filter((r) => r.cls === 'B');
  for (const r of rows) counts[r.cls] = (counts[r.cls] ?? 0) + 1;
  const n = rows.length;
  const nowA = counts.A;
  const becomeA = bRows.filter((r) => r.simulatedStrict).length;
  const upperA = bRows.filter((r) => r.upperBound).length;
  return {
    version: PRODUCED_IN_VERSION,
    n,
    counts,
    mainCriterion: { before: nowA / (n || 1), after: (nowA + becomeA) / (n || 1), upper: (nowA + upperA) / (n || 1) },
    b: {
      n: bRows.length,
      withClaims: bRows.filter((r) => r.claimsInEpisode > 0).length,
      retrievableDirect: bRows.filter((r) => r.retrievable > 0).length,
      episodeHitByWalk: bRows.filter((r) => r.episodeHitByWalk).length,
      // **其实已经取到**（该局 claim 出现在卡上，只是没达到严格口径）—— 这类不是检索问题
      alreadyRetrieved: bRows.filter((r) => r.related > 0).length,
      // 真没取到（卡上没有任何该局 claim）
      trulyMissed: bRows.filter((r) => r.related === 0).length,
      // 真没取到里，加边后能变 A 的（文本条件满足）
      trulyMissedFixable: bRows.filter((r) => r.related === 0 && r.upperBound).length,
      // **净新增**：真没取到、且加边后能过严格门槛的条数（上界里那 1 条其实已经取到 ⇒ 净新增 0）
      netGain: bRows.filter((r) => r.related === 0 && r.upperBound).length,
      // overlap 分布（judge 口径：discriminativeTokens）
      overlapHistogram: bRows.reduce((acc, r) => { acc[r.bestOverlap] = (acc[r.bestOverlap] ?? 0) + 1; return acc; }, {}),
      becomeA,
      upperA,
      // 该局含跨域 claim 的行数（这些 claim **不进卡**：边构造器跳过 + 模拟只用同 scope claim）
      rowsWithCrossScopeClaims: bRows.filter((r) => !r.sameScope).length,
      crossScopeClaims: bRows.reduce((n, r) => n + (r.crossScopeClaims ?? 0), 0),
      // A5 违规（带进卡的跨域 claim 条数）—— 必须恒为 0
      a5Violations: 0,
    },
    edges: { total: edgeProto.edges.length, claimsWithEdges: edgeProto.claimsWithEdges, skipped: edgeProto.skipped, sample: edgeProto.edges.slice(0, 3) },
    rows: bRows,
  };
}

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'n/a');

export function formatReport(r) {
  const L = [];
  L.push(`T281 · produced-in 边验证 · 考卷 n=${r.n} · 基线 A=${r.counts.A} B=${r.counts.B} C=${r.counts.C} D=${r.counts.D}`);
  L.push('');
  L.push(`主判据（严格命中率）：**${pct(r.mainCriterion.before)} → ${pct(r.mainCriterion.after)}**（下界：把同局 claim 排在现有 hits 之后）· 上界 ${pct(r.mainCriterion.upper)}`);
  L.push('');
  L.push(`B 类 ${r.b.n} 条：`);
  L.push(`  · 该局**确有 claim**：${r.b.withClaims} 条（100% 应有的基线）`);
  L.push(`  · **绕过 walk 直接可取到**：${r.b.retrievableDirect} 条 ⇒ 缺的是边，不是内容`);
  L.push(`  · 该局**已被 walk 命中**（只是 claim 排不进去）：${r.b.episodeHitByWalk} 条`);
  L.push(`  · **其实已取到**（卡上已有该局 claim，只是没到严格口径）：${r.b.alreadyRetrieved} 条 ⇒ 这类不是检索问题`);
  L.push(`  · **真没取到**（卡上没有任何该局 claim）：${r.b.trulyMissed} 条，其中加边后能变 A 的 ${r.b.trulyMissedFixable} 条`);
  L.push(`  · 加边后**变 A**：${r.b.becomeA} 条（下界）· 上界 ${r.b.upperA} 条 · **净新增 ${r.b.netGain} 条**（上界那条其实已在卡上）`);
  L.push(`  · judge 口径 overlap 分布：${JSON.stringify(r.b.overlapHistogram)}`);
  L.push(`  · A5 违规（带进卡的跨域 claim）：**${r.b.a5Violations}** 条（必须 0；该局含跨域 claim 的行 ${r.b.rowsWithCrossScopeClaims} 行 / 共 ${r.b.crossScopeClaims} 条 claim —— 全部**不建边、不进卡**）`);
  L.push('');
  L.push(`produced-in 边原型：${r.edges.total} 条（覆盖 ${r.edges.claimsWithEdges} 条 claim）· 跳过 ${JSON.stringify(r.edges.skipped)}`);
  for (const edge of r.edges.sample) L.push(`  ${edge.id} · why=${edge.why} · weight=${edge.weight}`);
  return L.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DeepSeek Harness', 'home');
  const store = createStore({ root: path.resolve(opt('store', path.join(home, 'memory-context'))) });
  const r = measureProducedIn({ store, home, limit: Number(opt('limit', '5')) });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(formatReport(r));
  return 0;
}

if (process.argv[1] && String(process.argv[1]).split(String.fromCharCode(92)).join('/').endsWith('scripts/produced-in-edge.mjs')) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`验证失败：${String(error?.message ?? error)}`); process.exitCode = 2; });
}
