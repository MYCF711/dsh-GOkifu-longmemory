// R05 link —— 多粒度相关边（每条边必须带 why 与 weight）
//
// 契约：docs/数据契约.md §4（mention / link）、AGENTS.md §4.3、方案.md §4.2–§4.3、§4.6。
//
// 三层边（全部机械，无模型判断、无向量检索）：
//   棋谱↔主题   mention：抽取命中（R04 给的 occurrences）
//   棋谱↔棋谱   link：共享 ≥1 硬主题（repo/scaffold/dependency/tool/file/domain）
//                     或共享 ≥2 判别性软主题（term/goal，df≥2 且 df<N）
//   节点↔节点   link：同一 error 原文 / 同一文件 + 同一错误
//
// 权重（只由机械量决定）：
//   硬边 = 1；软边 = 0.5 × IDF 归一（归一后 ∈ (0,1)）；same-error / same-file = 1。
// IDF：idf = ln((N+1)/(df+0.5))，idfNorm = idf / ln(N+2) ∈ [0,1]（与 R04 computeDf 同式）。
//
// 「通用主题不建边」：df === N 的主题每局都有（如 tool:bash），它不提供判别信息，
// 因此只保留在 mention 里，不参与棋谱↔棋谱建边（否则 N 局两两全连，图退化成一张全连图）。
//
// P1-2（2026-11-28）：**生成期从「两两全量配对」改成「端点对限定」**。
// 上游依据（代码级）：Graphiti `edge_operations.py#_pair_search_filter` / `find_exact_duplicate_edge`
// —— 边的候选检索只在**同一对端点**内进行，搜索空间不随全图增长；这也是它敢做在线增量的根因[外]。
// 本仓旧实现把每一对 (A,B) 都过一遍判据；判据本身（硬/软主题是否共享）只与本对端点有关，所以
// 可以先把「可能产出边」的局对算出来，再只对这些对跑判据：
//   · 硬边候选 = 共享 ≥1 个**可建边硬主题**（非 error、判别性通过）的局对；
//   · 软边候选 = 共享 ≥2 个**可建边软主题**的局对。
// 两条之外的对，判据必然一个都不命中 ⇒ 边集合与全量配对**逐条相同**（test/link-pairs.test.mjs 钉住）。
// 稠密语料下候选集合可能反而比全量更大（每个主题都是高 df），此时退回全量遍历：两条路结果等价，
// 取的只是更省的那条（`options.pairStrategy: 'full'` 可显式走旧口径，用于对照/回滚）。

import { HARD_KINDS, SOFT_KINDS, isGenericErrorKey } from './topic.mjs';
// task-9 / P0-4：每局边数上限的唯一权威值在 `./limits.mjs`（上游对应：Graphiti 无存量级边上限，
// 只约束候选/批次；本仓 D10 自设 16，理由写在那张表里）。
import { MAX_LINKS_PER_EPISODE } from './limits.mjs';

export const LINK_KIND_ORDER = Object.freeze(['shared-topic', 'same-error', 'same-file']);

export const DEFAULT_LINK_OPTIONS = Object.freeze({
  maxOccurrencesPerTopic: 3,   // 每个 (棋谱, 主题) 最多记几条 mention
  maxMentions: 20000,          // 全局上限，防单次全量跑爆内存
  sameError: true,
  sameFile: true,
  // D10（2026-11-20，主人裁定走方案③）：**不再物化团边**。
  // 真库实测：636 个局撑起 12.5 万条边（中位数每局 330 条），其中 97.4% 是 weight=1 的硬边。
  // 边是"团"：N 局共享同一文件/同一报错 ⇒ N² 条边，而 walk 深度 ≤2、每层 limit 5，用不到这么多。
  // 做法：每局最多保留 `maxLinksPerEpisode` 条边（按 weight 降序、同重按 occurredAt 新的优先，再按 id 稳定排序）。
  // 这只是**截断候选**，不改任何判据；被截掉的邻居仍可由 `holdersByTopic`（walk cache 里已有）按需展开。
  // 值来自 `./limits.mjs` 的 MAX_LINKS_PER_EPISODE（单一来源，不在本文件写第二份）。
  maxLinksPerEpisode: MAX_LINKS_PER_EPISODE,
  // P1-2：生成期候选范围。'scoped' = 只枚举可能产出边的端点对（默认）；
  // 'full' = 旧的全量两两配对（对照/回滚用，输出与 'scoped' 逐条等价）。
  pairStrategy: 'scoped',
});

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 与 R04 computeDf 同式的 IDF 归一化（0..1）。 */
export function idfNorm(df, n) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return clamp(Math.log((n + 1) / (df + 0.5)) / Math.log(n + 2), 0, 1);
}

// 硬主题参与「棋谱↔棋谱」建边的最小判别性：出现在 ≤ max(2, ⌈10% 语料⌉) 局里。
// 理由（机械，无模型判断）：echo/bash/ls/grep 这类通用命令几乎每局都有，
// 拿它们建边会把 N 局两两连成一张全连图（实测 90 局时 74% 的棋谱对被连中）。
// 这条规则把「同一条命令」收窄为「同一条**判别性**命令」，与方案 §4.2 的
// 「判别性词（IDF 加权、通用词停用）」同一口径。df 仍出现在 mention 里，不丢证据。
export const HARD_MAX_DF_RATIO = 0.1;
export const HARD_MIN_DF_CAP = 2;

/** 判别性判据（硬/软共用一条）：至少两局共有、且不是「几乎人人都有」。 */
export function linkEligible(df, n) {
  if (!Number.isFinite(df) || !Number.isFinite(n) || n <= 0) return false;
  return df >= 2 && df < n && df <= Math.max(HARD_MIN_DF_CAP, Math.ceil(n * HARD_MAX_DF_RATIO));
}

export const hardLinkEligible = linkEligible;

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function kindRank(kind) {
  const i = LINK_KIND_ORDER.indexOf(kind);
  return i === -1 ? LINK_KIND_ORDER.length : i;
}

/**
 * 把入参 topics 归一成 id → {kind,key} 查表（容错：{n,topics,byId} / 数组 / null）。
 */
function normalizeTopicTable(topics) {
  const map = new Map();
  if (!topics) return map;
  if (topics instanceof Map) {
    for (const [k, v] of topics) if (v) map.set(k, v);
    return map;
  }
  if (Array.isArray(topics)) {
    for (const t of topics) if (t?.id) map.set(t.id, t);
    return map;
  }
  if (topics.byId instanceof Map) {
    for (const [k, v] of topics.byId) if (v) map.set(k, v);
  }
  if (Array.isArray(topics.topics)) {
    for (const t of topics.topics) if (t?.id) map.set(t.id, t);
  }
  return map;
}

function sideKey(side) {
  return `${side.episode}${side.nodeId ? `:${side.nodeId}` : ''}${side.edgeId ? `:e${side.edgeId}` : ''}`;
}

function firstOccurrence(topic) {
  const occ = Array.isArray(topic?.occurrences) ? topic.occurrences : [];
  return [...occ].sort((a, b) => {
    const sa = Number.isFinite(a?.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
    const sb = Number.isFinite(b?.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
    return sa - sb;
  })[0] ?? null;
}

/**
 * 构建多层相关边。
 * @param {object} p
 * @param {Array}  p.episodes  每项需含 {id, topics:[R04 主题…]}(可含 scopeKey/startedAt)
 * @param {object|Array} [p.topics] R04.computeDf 的输出（或主题数组）；缺省时只用 episodes 里的 kind/key
 * @param {object} [p.options]
 * @returns {{mentions:Array, links:Array, stats:object}}
 */
/**
 * D10：把"团边"裁成"每局最多 k 条"（主人裁定方案③的第一步）。
 * 排序键：weight 降序 → occurredAt 降序（新的优先）→ id 升序（稳定，保证幂等）。
 * 对称裁剪：任一端已达上限就丢弃这条边，从而让**每个局的度数**都有上界。
 */
export function capLinksPerEpisode(links, k) {
  const limit = Number.isFinite(k) && k > 0 ? Math.floor(k) : Infinity;
  if (!Number.isFinite(limit)) return links;
  const sorted = [...links].sort((x, y) => (
    (Number(y.weight) || 0) - (Number(x.weight) || 0)
    || (Number(y.occurredAt) || 0) - (Number(x.occurredAt) || 0)
    || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0)
  ));
  const degree = new Map();
  const kept = [];
  for (const link of sorted) {
    const a = link?.a?.episode;
    const b = link?.b?.episode;
    if (typeof a !== 'string' || typeof b !== 'string') { kept.push(link); continue; }
    const da = degree.get(a) ?? 0;
    const db = degree.get(b) ?? 0;
    if (da >= limit || db >= limit) continue;
    degree.set(a, da + 1);
    degree.set(b, db + 1);
    kept.push(link);
  }
  return kept;
}

/**
 * P1-2「端点对限定」：只枚举**可能产出棋谱↔棋谱边**的局对，替代两两全量遍历。
 *
 * 候选判据（与建边判据同源，只是提前到枚举阶段）：
 *   · 硬：共享 ≥1 个可建边硬主题（判别性通过、且不是 error）⇒ 这一对必是候选；
 *   · 软：共享 ≥2 个可建边软主题 ⇒ 这一对是候选（逐主题累加交集计数，不展开第二次交集）。
 * 两条都不满足的对，第 3 步的判据一个也不会命中 ⇒ 不枚举它们不改变边集合。
 *
 * 成本闸：候选的登记代价 = Σ C(df,2)（硬主题 + 软主题）。若它已不低于「全量两两」的 C(N,2)，
 * 说明语料很稠密，退回全量遍历反而更省 —— 两条路输出等价，这里只选便宜的那条。
 *
 * @param {Map<string,{hard:Array,soft:Array}>} pairView 每局的可建边主题（只与本局有关）
 * @param {number} pairSpace 全量两两对数 C(N,2)
 * @param {string[]} dupIds 同一个 id 出现多次的棋谱（旧口径会产出一条自连边，这里保留同等行为）
 * @returns {string[]|null} 升序的 `a\u0000b` 键（a ≤ b）；null ⇒ 调用方走全量遍历
 */
function endpointPairKeys(pairView, pairSpace, dupIds = []) {
  const hardHolders = new Map(); // topicId -> [episodeId…]
  const softHolders = new Map();
  for (const [epId, view] of pairView) {
    for (const t of view.hard) {
      const arr = hardHolders.get(t.id);
      if (arr) arr.push(epId); else hardHolders.set(t.id, [epId]);
    }
    for (const t of view.soft) {
      const arr = softHolders.get(t.id);
      if (arr) arr.push(epId); else softHolders.set(t.id, [epId]);
    }
  }
  const c2 = (m) => (m * (m - 1)) / 2;
  let work = 0;
  for (const h of hardHolders.values()) work += c2(h.length);
  for (const h of softHolders.values()) work += c2(h.length);
  if (work > pairSpace) return null;

  const keyOf = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const pairs = new Set();
  for (const h of hardHolders.values()) {
    for (let i = 0; i < h.length; i += 1) {
      for (let j = i + 1; j < h.length; j += 1) pairs.add(keyOf(h[i], h[j]));
    }
  }
  const softShared = new Map(); // pairKey -> 共享的可建边软主题数
  for (const h of softHolders.values()) {
    for (let i = 0; i < h.length; i += 1) {
      for (let j = i + 1; j < h.length; j += 1) {
        const k = keyOf(h[i], h[j]);
        softShared.set(k, (softShared.get(k) ?? 0) + 1);
      }
    }
  }
  for (const [k, n] of softShared) if (n >= 2) pairs.add(k);
  for (const id of dupIds) pairs.add(`${id}\u0000${id}`); // 同 id 重复 ⇒ 旧口径的一条自连边
  // `\u0000` 小于任何可见字符 ⇒ 键序等价于 (a, b) 字典序，与全量循环的 (i<j) 顺序一致。
  return [...pairs].sort();
}

export function buildLinks({ episodes = [], topics = null, options = {} } = {}) {
  const opts = { ...DEFAULT_LINK_OPTIONS, ...options };
  const eps = (Array.isArray(episodes) ? episodes : []).filter((e) => e && e.id);
  const N = eps.length;
  const table = normalizeTopicTable(topics);

  // ---- 1. 每局的视图：主题 id 集合、df（本局语料内重算，保证内部一致）、出现位置 ----
  const views = new Map();
  for (const ep of eps) {
    const own = Array.isArray(ep.topics) ? ep.topics : [];
    const occById = new Map();
    for (const t of own) {
      if (!t || !t.id) continue;
      const ref = table.get(t.id);
      const view = {
        id: t.id,
        kind: ref?.kind ?? t.kind,
        key: ref?.key ?? t.key,
        occurrences: Array.isArray(t.occurrences) ? t.occurrences : [],
      };
      if (!occById.has(t.id)) occById.set(t.id, view);
      else if (view.occurrences.length > occById.get(t.id).occurrences.length) occById.set(t.id, view);
    }
    views.set(ep.id, { episode: ep, occById, df: null });
  }

  // df：出现该主题的棋谱数（契约 §4）
  const dfMap = new Map();
  for (const v of views.values()) {
    for (const id of v.occById.keys()) dfMap.set(id, (dfMap.get(id) ?? 0) + 1);
  }
  for (const v of views.values()) {
    v.df = (id) => dfMap.get(id) ?? 0;
    v.idfNorm = (id) => idfNorm(dfMap.get(id) ?? 0, N);
  }

  // ---- 2. mentions：棋谱/节点 ↔ 主题 ----
  const mentions = [];
  for (const ep of eps) {
    const v = views.get(ep.id);
    for (const view of v.occById.values()) {
      const hard = HARD_KINDS.has(view.kind);
      const weightRaw = hard ? 1 : 0.5 * v.idfNorm(view.id);
      const occ = [...view.occurrences]
        .sort((a, b) => ((a?.seq ?? 0) - (b?.seq ?? 0)) || ((a?.occurredAt ?? 0) - (b?.occurredAt ?? 0)))
        .slice(0, opts.maxOccurrencesPerTopic);
      for (const o of occ) {
        if (mentions.length >= opts.maxMentions) break;
        const from = { episode: ep.id };
        if (o?.nodeId) from.nodeId = o.nodeId;
        if (o?.edgeId) from.edgeId = o.edgeId;
        mentions.push({
          from,
          topic: view.id,
          seq: Number.isFinite(o?.seq) ? o.seq : null,
          quote: String(o?.quote ?? ''),
          weight: round4(weightRaw),
          occurredAt: Number.isFinite(o?.occurredAt) ? o.occurredAt : null,
        });
      }
    }
  }
  mentions.sort((a, b) => (sideKey(a.from) < sideKey(b.from) ? -1 : sideKey(a.from) > sideKey(b.from) ? 1 : 0)
    || ((a.seq ?? 0) - (b.seq ?? 0))
    || (a.topic < b.topic ? -1 : 1));

  // ---- 3. 棋谱 ↔ 棋谱：共享硬主题 / ≥2 判别性软主题 ----
  const links = [];
  const seen = new Set();
  const push = (link) => {
    const key = `${link.kind}|${sideKey(link.a)}|${sideKey(link.b)}|${link.why}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  // 每局的可建边主题（**只看这一局**，与对端无关）：
  //   hard = 判别性通过、且不是 error 的硬主题（error 有专属边，不参与 shared-topic）
  //   soft = 判别性通过的软主题
  // 判据里没有「对端」这一项 ⇒ 一次性算好；旧实现是每对端点都重算一遍（O(N²·主题数)）。
  const pairView = new Map();
  for (const [epId, v] of views) {
    const hard = [];
    const soft = [];
    for (const view of v.occById.values()) {
      const df = v.df(view.id);
      if (HARD_KINDS.has(view.kind) && view.kind !== 'error' && hardLinkEligible(df, N)) hard.push(view);
      if (SOFT_KINDS.has(view.kind) && linkEligible(df, N)) soft.push(view);
    }
    pairView.set(epId, { hard, soft });
  }

  /** 单对端点定边（判据与重构前逐条一致，只是入参改成预计算的主题视图）。 */
  const linkPair = (aId, bId) => {
    const va = views.get(aId);
    const vb = views.get(bId);
    const { hard: hardA, soft: softA } = pairView.get(aId);

    const sharedHard = hardA.filter((t) => vb.occById.has(t.id));
    if (sharedHard.length) {
      sharedHard.sort((x, y) => (va.idfNorm(y.id) - va.idfNorm(x.id)) || (x.key < y.key ? -1 : 1));
      const primaryA = firstOccurrence(sharedHard[0]);
      const primaryB = firstOccurrence(vb.occById.get(sharedHard[0].id));
      const at = Math.min(
        Number.isFinite(primaryA?.occurredAt) ? primaryA.occurredAt : Infinity,
        Number.isFinite(primaryB?.occurredAt) ? primaryB.occurredAt : Infinity,
      );
      push({
        a: { episode: aId },
        b: { episode: bId },
        kind: 'shared-topic',
        topics: sharedHard.map((t) => t.id),
        why: sharedHard.map((t) => t.key).join(', '),
        weight: 1,
        occurredAt: Number.isFinite(at) ? at : (va.episode.startedAt ?? null),
      });
      return; // 硬边命中即定边；软边只用于无硬边时的候选
    }

    const sharedSoft = softA.filter((t) => vb.occById.has(t.id));
    if (sharedSoft.length >= 2) {
      sharedSoft.sort((x, y) => (va.idfNorm(y.id) - va.idfNorm(x.id)) || (x.key < y.key ? -1 : 1));
      const mean = sharedSoft.reduce((s, t) => s + va.idfNorm(t.id), 0) / sharedSoft.length;
      const primaryA = firstOccurrence(sharedSoft[0]);
      const primaryB = firstOccurrence(vb.occById.get(sharedSoft[0].id));
      const at = Math.min(
        Number.isFinite(primaryA?.occurredAt) ? primaryA.occurredAt : Infinity,
        Number.isFinite(primaryB?.occurredAt) ? primaryB.occurredAt : Infinity,
      );
      push({
        a: { episode: aId },
        b: { episode: bId },
        kind: 'shared-topic',
        topics: sharedSoft.map((t) => t.id),
        why: sharedSoft.map((t) => t.key).join(', '),
        weight: round4(0.5 * mean),
        occurredAt: Number.isFinite(at) ? at : (va.episode.startedAt ?? null),
      });
    }
  };

  // 候选范围：默认「端点对限定」（P1-2）；'full' 走旧的全量两两（对照/回滚）。
  const pairSpace = N > 1 ? (N * (N - 1)) / 2 : 0; // N=0 时别算出 -0（Object.is 上与 0 不等）
  const requestedStrategy = opts.pairStrategy === 'full' ? 'full' : 'scoped';
  let pairsExamined = 0;
  let candidatePairs = null;
  if (requestedStrategy === 'scoped') {
    const idCount = new Map();
    for (const ep of eps) idCount.set(ep.id, (idCount.get(ep.id) ?? 0) + 1);
    const dupIds = [...idCount].filter(([, c]) => c > 1).map(([id]) => id);
    candidatePairs = endpointPairKeys(pairView, pairSpace, dupIds);
  }
  if (candidatePairs) {
    for (const key of candidatePairs) {
      const cut = key.indexOf('\u0000');
      pairsExamined += 1;
      linkPair(key.slice(0, cut), key.slice(cut + 1));
    }
  } else {
    // 全量两两：对照/回滚路径，以及语料过稠时（候选登记比全扫更贵）的回退。
    const episodeOrder = [...eps].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = 0; i < episodeOrder.length; i += 1) {
      for (let j = i + 1; j < episodeOrder.length; j += 1) {
        pairsExamined += 1;
        linkPair(episodeOrder[i].id, episodeOrder[j].id);
      }
    }
  }

  // ---- 4. 节点 ↔ 节点：同一 error 原文 / 同一文件 + 同一错误 ----
  if (opts.sameError || opts.sameFile) {
    const errorIndex = new Map(); // errorTopicId -> [{episode, occ, view}]
    const fileErrorIndex = new Map(); // `${fileId}\u0000${errorId}` -> [{episode, occFile, occErr}]
    for (const ep of eps) {
      const v = views.get(ep.id);
      const errorIds = [];
      for (const view of v.occById.values()) {
        if (view.kind !== 'error') continue;
        // 「exit code 1」这类合成标记只说明命令失败，不构成「同一报错原文」
        if (isGenericErrorKey(view.key)) continue;
        // 类级主题（class:*）只用于「跨会话共享同类坑」的 shared-topic 边；
        // 它不能冒充「同一报错原文」，否则同一对棋谱会出现两条 same-error（2026-11-02 实测）。
        if (String(view.key).startsWith('class:')) continue;
        const occ = firstOccurrence(view);
        if (!occ) continue;
        errorIds.push({ id: view.id, key: view.key, occ });
        if (!errorIndex.has(view.id)) errorIndex.set(view.id, []);
        errorIndex.get(view.id).push({ episode: ep.id, occ, key: view.key });
      }
      for (const view of v.occById.values()) {
        if (view.kind !== 'file') continue;
        const occFile = firstOccurrence(view);
        if (!occFile) continue;
        for (const err of errorIds) {
          const key = `${view.id}\u0000${err.id}`;
          if (!fileErrorIndex.has(key)) fileErrorIndex.set(key, []);
          fileErrorIndex.get(key).push({ episode: ep.id, occFile, occErr: err.occ, fileKey: view.key, errKey: err.key });
        }
      }
    }

    const nodeSide = (epId, occ) => {
      const side = { episode: epId };
      if (occ?.nodeId) side.nodeId = occ.nodeId;
      if (occ?.edgeId) side.edgeId = occ.edgeId;
      return side;
    };

    if (opts.sameError) {
      for (const [errorId, holders] of errorIndex) {
        const sorted = [...holders].sort((a, b) => (a.episode < b.episode ? -1 : a.episode > b.episode ? 1 : 0));
        for (let i = 0; i < sorted.length; i += 1) {
          for (let j = i + 1; j < sorted.length; j += 1) {
            const A = sorted[i];
            const B = sorted[j];
            if (A.episode === B.episode) continue;
            const at = Math.min(
              Number.isFinite(A.occ?.occurredAt) ? A.occ.occurredAt : Infinity,
              Number.isFinite(B.occ?.occurredAt) ? B.occ.occurredAt : Infinity,
            );
            push({
              a: nodeSide(A.episode, A.occ),
              b: nodeSide(B.episode, B.occ),
              kind: 'same-error',
              topics: [errorId],
              why: A.key,
              weight: 1,
              occurredAt: Number.isFinite(at) ? at : null,
            });
          }
        }
      }
    }

    if (opts.sameFile) {
      for (const [combo, holders] of fileErrorIndex) {
        const [fileId, errorId] = combo.split('\u0000');
        void fileId;
        const sorted = [...holders].sort((a, b) => (a.episode < b.episode ? -1 : a.episode > b.episode ? 1 : 0));
        for (let i = 0; i < sorted.length; i += 1) {
          for (let j = i + 1; j < sorted.length; j += 1) {
            const A = sorted[i];
            const B = sorted[j];
            if (A.episode === B.episode) continue;
            const at = Math.min(
              Number.isFinite(A.occErr?.occurredAt) ? A.occErr.occurredAt : Infinity,
              Number.isFinite(B.occErr?.occurredAt) ? B.occErr.occurredAt : Infinity,
            );
            push({
              a: nodeSide(A.episode, A.occErr),
              b: nodeSide(B.episode, B.occErr),
              kind: 'same-file',
              topics: [fileId, errorId],
              why: `${A.fileKey}, ${A.errKey}`,
              weight: 1,
              occurredAt: Number.isFinite(at) ? at : null,
            });
          }
        }
      }
    }
  }

  // ---- 5. 稳定排序 ----
  links.sort((a, b) => (kindRank(a.kind) - kindRank(b.kind))
    || (a.a.episode < b.a.episode ? -1 : a.a.episode > b.a.episode ? 1 : 0)
    || (a.b.episode < b.b.episode ? -1 : a.b.episode > b.b.episode ? 1 : 0)
    || (String(a.why) < String(b.why) ? -1 : String(a.why) > String(b.why) ? 1 : 0));

  const stats = {
    episodes: N,
    mentions: mentions.length,
    links: links.length,
    byKind: Object.fromEntries(LINK_KIND_ORDER.map((k) => [k, links.filter((l) => l.kind === k).length])),
    universalTopics: [...dfMap.entries()].filter(([, df]) => df >= N && N > 0).length,
  };

  // D10：每局边数上限（对称保留 —— 一条边占两端各一个名额，按较紧的一端裁剪）。
  // 幂等：同一输入两次跑结果完全相同（排序键含 id，无随机）。
  const capped = capLinksPerEpisode(links, opts.maxLinksPerEpisode);
  const finalStats = capped.length === links.length
    ? stats
    : { ...stats, linksBeforeCap: links.length, linksAfterCap: capped.length };
  const out = { mentions, links: capped, stats: finalStats };
  // 诊断（`options.diagnostics: true` 才返回，默认输出形状不变）：
  //   pairSpace     全量两两的对数 C(N,2)
  //   pairsExamined 实际跑过判据的端点数（端点对限定下 = candidatePairs.length）
  //   candidatePairs 端点对限定算出的候选对数（走全量时为 null）
  // 它是「生成期候选范围」的唯一可观测量：删掉端点对过滤 ⇒ pairsExamined 会等于 pairSpace。
  if (opts.diagnostics) {
    out.scan = {
      requested: requestedStrategy,
      effective: candidatePairs ? 'scoped' : 'full',
      pairSpace,
      candidatePairs: candidatePairs ? candidatePairs.length : null,
      pairsExamined,
    };
  }
  return out;
}

export default { buildLinks, idfNorm, LINK_KIND_ORDER };
