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

import { HARD_KINDS, SOFT_KINDS, isGenericErrorKey } from './topic.mjs';

export const LINK_KIND_ORDER = Object.freeze(['shared-topic', 'same-error', 'same-file']);

export const DEFAULT_LINK_OPTIONS = Object.freeze({
  maxOccurrencesPerTopic: 3,   // 每个 (棋谱, 主题) 最多记几条 mention
  maxMentions: 20000,          // 全局上限，防单次全量跑爆内存
  sameError: true,
  sameFile: true,
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

  const episodeOrder = [...eps].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 0; i < episodeOrder.length; i += 1) {
    for (let j = i + 1; j < episodeOrder.length; j += 1) {
      const ea = episodeOrder[i];
      const eb = episodeOrder[j];
      const va = views.get(ea.id);
      const vb = views.get(eb.id);

      const hardA = [];
      const softA = [];
      for (const view of va.occById.values()) {
        const df = va.df(view.id);
        // error 有专属边（same-error / same-file），不参与 shared-topic
        if (HARD_KINDS.has(view.kind) && view.kind !== 'error' && hardLinkEligible(df, N)) hardA.push(view);
        if (SOFT_KINDS.has(view.kind) && linkEligible(df, N)) softA.push(view);
      }
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
          a: { episode: ea.id },
          b: { episode: eb.id },
          kind: 'shared-topic',
          topics: sharedHard.map((t) => t.id),
          why: sharedHard.map((t) => t.key).join(', '),
          weight: 1,
          occurredAt: Number.isFinite(at) ? at : (ea.startedAt ?? null),
        });
        continue; // 硬边命中即定边；软边只用于无硬边时的候选
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
          a: { episode: ea.id },
          b: { episode: eb.id },
          kind: 'shared-topic',
          topics: sharedSoft.map((t) => t.id),
          why: sharedSoft.map((t) => t.key).join(', '),
          weight: round4(0.5 * mean),
          occurredAt: Number.isFinite(at) ? at : (ea.startedAt ?? null),
        });
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

  return { mentions, links, stats };
}

export default { buildLinks, idfNorm, LINK_KIND_ORDER };
