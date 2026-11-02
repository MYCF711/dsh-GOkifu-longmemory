// R06 thread —— 线索 / 棋书（藤的可读视图；多对多；不是容器）
//
// ── 契约（AGENTS §4.4 / §11 R06、docs/数据契约.md §4、方案 §4.5、§4.10）──
// 职责：把**同一作用域里共享同一个判别性主题**的棋谱聚成一卷，供索引与顺藤摸瓜使用。
// 入口：buildThreads({episodes, links, topics, options}) → {threads, assignments, stats}
// 输入：
//   episodes  = [{ id:"ep-…", scopeKey:"w:…", startedAt|occurredAt|firstEventAt,
//                  topics:[R04 主题…] }]（topics 可缺省 = 本局没有主题）
//   links     = R05 buildLinks().links（可选；只用来计数与审计，不决定成员）
//   topics    = R04 computeDf() 的输出（{n, topics, byId}）或主题数组（可选；补 kind/key）
// 输出每条卷：
//   { id:"th-<hash8>", title, scopeKey, topics:["t:…"], kifus:["ep-…"], parentThreadId:null,
//     state:"open", createdAt, updatedAt, kind, links, kifuCount }
//   - kifus 按 occurredAt（= startedAt/firstEventAt）升序；同一时刻按 id 升序（稳定、可复算）。
//   - createdAt = 卷内最早 occurredAt，updatedAt = 最晚 occurredAt（**都由证据时间派生**，不取 Date.now()）。
//   - title 逐字取主题 key（模型读的，做人不一定好看）；kind 是主题种类，便于消费方分组。
//   - links = 卷内棋谱之间、kind=="shared-topic" 的相关边条数（机械计数，只作审计/并列时的次序依据，不参与晋升）。
// 成卷规则（全机械，无模型判断）：
//   1. 只在**同一 scopeKey** 内成卷（方案 §4.10：w: 层不跨工作区；u: 层由 R09 的跨工作区印证规则负责）。
//   2. 主题必须**判别性**：df ≥ minKifus(2)，且通过 R05 的 linkEligible(df, N)
//      （df < N 且 df ≤ max(2, ⌈10%N⌉)）——与 R05 建边同一阈值（S8）。
//      理由：`tool:bash` 这类 df = N 的主题让任何一局都属于同一卷，卷就退化成「全体」。
//   3. 卷内**至少 minKifus(2) 局**；一局可同时属于多卷（多对多）；没有判别性主题的局不单独成卷。
// 删除语义：卷是视图 —— 删卷不删谱，重建同一批棋谱会得到同一批卷（纯函数、无隐藏状态）。
// 错误语义：入参不是对象 ⇒ throw ThreadError('thread/input')。
// 允许依赖：R05（linkEligible）+ node: 内置模块。禁止依赖：R01/R02/R03/R04 的直接导出、上游包、模型调用。

import { createHash } from 'node:crypto';

import { linkEligible } from './link.mjs';

export class ThreadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ThreadError';
    this.code = code;
  }
}

export const DEFAULT_THREAD_OPTIONS = Object.freeze({
  minKifus: 2,        // 卷内最少棋谱数（= 契约 §4 topic.df 的下限）
  maxTitleChars: 80,  // title 上限（逐字 key，超长才截断）
  maxDf: null,        // 非空时覆盖判别性上限（只做上限，不下调 df≥minKifus）
});

function hash8(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 8);
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** 一局的发生时间：occurredAt 优先，其次 startedAt / firstEventAt（R00 三字段口径）。 */
export function episodeOccurredAt(episode) {
  for (const key of ['occurredAt', 'startedAt', 'firstEventAt']) {
    if (Number.isFinite(episode?.[key])) return episode[key];
  }
  return null;
}

/** scopeKey 归一（缺省视为未知工作区，仍可成卷但不与其它作用域混卷）。 */
function scopeOf(episode) {
  const raw = episode?.scopeKey;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'w:unknown';
}

/** 主题表归一：接受 Map / 数组 / computeDf 的输出；只用于补 kind/key。 */
function normalizeTopicTable(topics) {
  const map = new Map();
  if (!topics) return map;
  if (topics instanceof Map) {
    for (const [id, t] of topics) if (t) map.set(id, t);
    return map;
  }
  if (Array.isArray(topics)) {
    for (const t of topics) if (t?.id) map.set(t.id, t);
    return map;
  }
  if (topics.byId instanceof Map) {
    for (const [id, t] of topics.byId) if (t) map.set(id, t);
  }
  if (Array.isArray(topics.topics)) {
    for (const t of topics.topics) if (t?.id) map.set(t.id, t);
  }
  return map;
}

function byOccurredThenId(a, b) {
  const ta = Number.isFinite(a.at) ? a.at : Number.POSITIVE_INFINITY;
  const tb = Number.isFinite(b.at) ? b.at : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 构建线索（棋书）卷。
 * @param {object} p
 * @param {Array}  p.episodes 每项需含 id / scopeKey / topics
 * @param {Array}  [p.links]  R05 的相关边（可选）
 * @param {object|Array} [p.topics] R04.computeDf 的输出或主题数组（可选）
 * @param {object} [p.options]
 * @returns {{threads:Array, assignments:Array<{episode:string, threadIds:string[]}>, stats:object}}
 */
export function buildThreads({ episodes = [], links = [], topics = null, options = {} } = {}) {
  if (episodes === null || typeof episodes !== 'object') {
    throw new ThreadError('thread: input must be an object {episodes, links, topics}', 'thread/input');
  }
  const opts = { ...DEFAULT_THREAD_OPTIONS, ...options };
  if (!Number.isFinite(opts.minKifus) || opts.minKifus < 2) opts.minKifus = 2;

  const eps = (Array.isArray(episodes) ? episodes : [])
    .filter((e) => e && typeof e.id === 'string' && e.id !== '')
    .map((e) => ({ episode: e, id: e.id, scopeKey: scopeOf(e), at: episodeOccurredAt(e) }));
  const N = eps.length;
  const table = normalizeTopicTable(topics);

  // ---- 1. 每局的主题视图（id → {id, kind, key}）----
  for (const view of eps) {
    const map = new Map();
    for (const t of Array.isArray(view.episode?.topics) ? view.episode.topics : []) {
      if (!t || typeof t.id !== 'string' || t.id === '') continue;
      if (map.has(t.id)) continue;
      const ref = table.get(t.id);
      const kind = ref?.kind ?? t.kind ?? null;
      const key = ref?.key ?? t.key ?? null;
      map.set(t.id, { id: t.id, kind, key });
    }
    view.topics = map;
  }

  // ---- 2. df（本批语料内重算，保证内部一致）----
  const df = new Map();
  for (const view of eps) {
    for (const id of view.topics.keys()) df.set(id, (df.get(id) ?? 0) + 1);
  }

  // ---- 3. 判别性：df ≥ minKifus 且（默认）通过 R05 的判别性阈值 ----
  const eligible = (id) => {
    const d = df.get(id) ?? 0;
    if (d < opts.minKifus) return false;
    // 类级错误主题（class:*）是「棋书」的主卷：同一类坑天然跨很多局，
    // 不套「df ≤ 10%」的判别性阈值，否则最该成册的那一类永远不成卷（2026-11-02）。
    if (String(id).includes('class:') || String(id).startsWith('t:error:')) {
      return true;
    }
    if (Number.isFinite(opts.maxDf)) return d <= opts.maxDf;
    return linkEligible(d, N);
  };

  // ---- 4. 按 (scopeKey, topic) 聚卷 ----
  const groups = new Map();
  for (const view of eps) {
    for (const topic of view.topics.values()) {
      if (!eligible(topic.id)) continue;
      const key = `${view.scopeKey}\u0000${topic.id}`;
      let group = groups.get(key);
      if (!group) {
        group = { scopeKey: view.scopeKey, topic, kifus: [] };
        groups.set(key, group);
      }
      // 同一 (棋谱, 主题) 只入卷一次（一局在一卷里只出现一次）
      if (!group.kifus.some((k) => k.id === view.id)) group.kifus.push(view);
    }
  }

  // ---- 5. 卷内棋谱排序 + 计数 ----
  const linksList = (Array.isArray(links) ? links : []).filter((l) => l && l.a && l.b);
  const threads = [];
  const threadIdsByEpisode = new Map();

  for (const group of groups.values()) {
    const kifus = [...group.kifus].sort(byOccurredThenId);
    if (kifus.length < opts.minKifus) continue; // 同 scope 内不足 2 局 ⇒ 不成卷

    const kifuIds = kifus.map((k) => k.id);
    const kifuSet = new Set(kifuIds);
    const intraLinks = linksList.filter((l) => l.kind === 'shared-topic'
      && kifuSet.has(l.a.episode) && kifuSet.has(l.b.episode)).length;

    const times = kifus.map((k) => k.at).filter((t) => Number.isFinite(t));
    const key = group.topic.key ?? group.topic.id;
    const id = `th-${hash8(`${group.scopeKey}\u0000${group.topic.id}`)}`;

    threads.push({
      id,
      title: clip(key, opts.maxTitleChars),
      scopeKey: group.scopeKey,
      kind: group.topic.kind ?? null,
      topics: [group.topic.id],
      kifus: kifuIds,
      parentThreadId: null,
      state: 'open',
      createdAt: times.length ? Math.min(...times) : null,
      updatedAt: times.length ? Math.max(...times) : null,
      links: intraLinks,
      kifuCount: kifuIds.length,
      // N9（2026-11-02）：卷首摘要 —— 机械拼接（类名 · 局数 · 最近日期 · 代表棋谱 l0），不调模型。
      headline: [key, `${kifuIds.length} 局`, times.length ? `最近 ${new Date(Math.max(...times)).toISOString().slice(0, 10)}` : '无日期', kifus[0]?.episode?.l0 ? `代表：${String(kifus[0].episode.l0).replace(/\s+/g, ' ').slice(0, 60)}` : null].filter(Boolean).join(' · '),
    });

    for (const kifuId of kifuIds) {
      if (!threadIdsByEpisode.has(kifuId)) threadIdsByEpisode.set(kifuId, []);
      threadIdsByEpisode.get(kifuId).push(id);
    }
  }

  threads.sort((a, b) => (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0)
    || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const assignments = eps
    .map((view) => ({
      episode: view.id,
      threadIds: [...(threadIdsByEpisode.get(view.id) ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    }))
    .sort((a, b) => (a.episode < b.episode ? -1 : a.episode > b.episode ? 1 : 0));

  const byKind = {};
  for (const t of threads) {
    const k = String(t.kind ?? 'unknown');
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  const stats = {
    episodes: N,
    threads: threads.length,
    topicsEligible: new Set(threads.flatMap((t) => t.topics)).size,
    episodesInThreads: assignments.filter((a) => a.threadIds.length > 0).length,
    multiMembership: assignments.filter((a) => a.threadIds.length >= 2).length,
    episodesWithoutThread: assignments.filter((a) => a.threadIds.length === 0).length,
    byKind,
  };

  return { threads, assignments, stats };
}

export default { buildThreads, episodeOccurredAt, DEFAULT_THREAD_OPTIONS };
