// R11b view —— 邻域视图（18×18：有界节点 + 必带 frontier）
//
// ── 契约（方案.md §14.1/§14.3/§14.6；AGENTS.md §11 R11「邻域遍历」）──
// 职责：以「当前节点」为中心，从**调用方给的视图对象**里切出一块有界邻域：
//       ≤ maxNodes 个节点（默认 324 = 18×18 的隐喻）、边只保留两端都在邻域里的、
//       **边界边（一端在邻域里、另一端不在）全部进 frontier** —— agent 不够时顺着 frontier 再调一次。
// 入口：buildNeighborhood({ center, view, maxNodes = 324, maxEdges = 2000, depth = 1 })
//   center = { kind: 'episode' | 'claim' | 'library', id }
//            · episode / claim：普通记忆节点为中心；
//            · library：知识库巨型节点（见 §14.6），默认展开成子节点（kind: "note"）。
//            其余 kind（topic / note / 任意串）⇒ throw Error('bad-argument: …')。
//   view   = 与 src/rooms/inject.mjs 的 collectEntries 同一种视图对象（**不新造视图**），
//            本房间消费的字段（都是可选，缺哪个就少哪类节点/边；文件末尾有对照表）：
//              episodesById   Map|{[id]:rec}   棋谱记录（id/scopeKey/topics/l0/lastEventAt/signals…）
//              claimsById     Map|{[id]:rec}   claim 记录（id/scopeKey/text/kind/support/occurredAt…）
//              topicsById     Map|{[id]:rec}   主题记录（id/kind/key/df/lastSeenAt…）
//              links          Array           相关边（a.episode / b.episode / topics / why / weight）
//              linksFromEpisode Function|Map  没有 links 时按棋谱惰性取边（link[]）
//              library / libraryNotes / libraryCount / libraryEdges —— 知识库巨型节点用（§14.6）
//            · inject.mjs 的 storeView **没有** topicsById / links（只有 episodesById / claimsById），
//              用那种视图调用时：只有棋谱/claim 节点 + claim→棋谱 support 边；主题节点与棋谱↔棋谱边需要调用方补字段。
//            · scopeKey 的作用域过滤见下；没有 scopeKey 的节点（主题/知识库/子文档）不参与跨域判定。
//   maxNodes = 324 硬上限；超过 ⇒ 夹到 324 且结果 clamped:true。≤0 抬到 1（中心总在）。
//   depth    = 默认 1（只取直接相连），上限 2；>2 夹到 2，<0 抬到 0；depth=0 表示只看中心本身（其余全落 frontier）。
//
// 输出（**JSON 安全**：没有 Map / undefined / 函数）：
//   {
//     center: { kind, id },
//     nodes: [{ kind, id, label, occurredAt, weight }],   // label ≤120 字、单行
//     edges: [{ kind, from, to, why, weight }],           // 只保留两端都在 nodes 里的边
//     frontier: [{ kind, from, to, why }],                // 边界边：一端在 nodes、另一端不在
//     counts: { nodes, edges, frontier },
//     truncated: { nodes: bool, edges: bool },
//     clamped: bool
//   }
// 深度与权重（机械，无模型判断）：
//   · 邻域按**无向图**处理；边的 from/to 规范化为 id 字典序（同一对节点永远同向，确定性）。
//   · 节点 weight：中心恒 1；其余 = 到达它的边的 weight × 0.5^(depth-1)，再夹到 ≤0.99
//     （保证中心排在首位）。因此 depth=2 的节点权重 ≤ depth=1 的一半。
//   · 边的 weight：link 用记录里的 weight；claim↔棋谱 support 边 = 0.85；
//     棋谱↔主题 mention 边 = 0.6（主题有 idfNorm 时用它，缺省 0.6）；知识库边 = 0.9。
// 排序（写死，同输入同输出）：weight 降序 → id 升序（边没有 id，用 `from|to|kind` 代替）。
// 截断：
//   · nodes：候选按排序取前 maxNodes；被砍掉的节点，其连向已选节点的边自然落进 frontier。
//   · edges：两端都在邻域里的边按排序取前 maxEdges（默认 2000）。
//   · frontier：边界边按排序取前 maxEdges；因此 truncated.edges 也涵盖 frontier 被砍的情况。
//   · 若 center 在视图里找不到（比如库还没入档 / id 打错）⇒ 返回空结构（nodes/edges/frontier 皆空），不抛。
// 作用域（方案 §14.3「A5 跨作用域仍为 0」）：
//   filterScope = view.scope → view.scopeKey → center 记录的 scopeKey；都没有 ⇒ 不做过滤（无从比较）。
//   调用方当前作用域优先：u: 用户层的 claim 在真实工作区里可见，用 w: 当基准才看得到它的证据。
//   filterScope 是 `u:` 时间 ⇒ 也不做工作区过滤（u: 本来就跨工作区，否则 claim 成孤岛）。
//   节点/边**带 scopeKey** 且与 centerScope 不可见（isScopeVisible，复用 R12 的实现）⇒ 一律不进
//   nodes / edges / frontier。不带 scopeKey 的主题/知识库/子文档不受此限。
// 知识库巨型节点（§14.6，2026-11-04 补充裁定）：
//   · kind "library"，默认 id "lib:docs/调研"；label「调研知识库（N 篇）」，N 取
//     view.library.count → view.libraryCount → notes.length（**都没有就只写「调研知识库」，不编数字**）。
//   · 它**只在两种情况**出现：① center 就是它；② 视图里有边显式指向它（view.libraryEdges）。
//     绝不因为"它很大"自动塞进任何邻域；它按普通节点参与 maxNodes / frontier 规则。
//   · center=library 且 depth ≥1 时展开成子节点：kind "note"、id "note:<相对路径>"、
//     label = 文档标题（优先 view 给的 title；没有就用文件名去掉扩展名），**不带正文**。
// 错误语义：center 不是对象 / kind 不在 episode|claim|library / id 不是非空字符串 ⇒
//   `new Error('bad-argument: …')`（前缀固定）。其它情况一律返回结构、不抛（坏条目跳过）。
// 纯函数：不 import `node:fs` / `node:path`，不读盘、不写盘、不调模型；只用调用方给的 view。
//   唯一 import 是 R12 的纯文本/作用域工具（clipLine / singleLine / isScopeVisible），
//   不 import gates.mjs（R13 依赖全部房间，反向 import 会成环）。
//
// view 字段 → 结果里能出现的节点/边（对照表）：
//   episodesById / claimsById                 ⇒ episode / claim 节点
//   episode.topics[]（棋谱记录自带）           ⇒ topic 节点 + mention 边
//   claim.support[].episode                   ⇒ support 边（claim ↔ 棋谱）
//   links 或 linksFromEpisode                  ⇒ 棋谱↔棋谱边（shared-topic / same-error / same-file …）
//   library / libraryNotes / libraryCount      ⇒ library 节点（及其 note 子节点）
//   libraryEdges                               ⇒ 显式连到知识库的边（主题/claim ↔ 知识库）
//   topicsById 只用于补全主题节点的 df / lastSeenAt（没有也能用棋谱上的内嵌主题对象建节点）。
//
// 已知处理不了的边界（明确写出来，不假装）：
//   · 主题记录里的 `episodes` 在本机 store 里是**数字**（df 计数），不是数组 ⇒ 主题↔棋谱边只从
//     `episode.topics[]` 一侧建立，不反推（反推需要一份全量反查表，属于调用方的视图构建责任）。
//   · 没有正文：note 节点只带标题；claim 节点的 label 是 claim 原文的**截断前缀**（clipLine 会加 `…`），
//     需要逐字原文请按 id 去 store 取（SDK 的 get / claims/<id>.json）。
//   · 一个节点在同一对端点之间有多条边（多个 why）时全部保留（kind+from+to+why 去重，weight 取最大）。
//   · frontier 只给 {kind, from, to, why}（契约如此），不带 weight；需要权重就顺着 from 再调一次。

import { clipLine, singleLine, isScopeVisible } from './inject.mjs';

/** 默认值（18×18 = 324 节点；边数上限独立）。 */
export const VIEW_DEFAULTS = Object.freeze({ maxNodes: 324, maxEdges: 2000, depth: 1 });

/** 节点硬上限（18×18 的隐喻，不是几何限制）。 */
export const MAX_VIEW_NODES = 324;

/** 深度硬上限。 */
export const MAX_VIEW_DEPTH = 2;

/** 知识库巨型节点（方案 §14.6 固定 id）。 */
export const LIBRARY_ID = 'lib:docs/调研';
export const LIBRARY_TITLE = '调研知识库';
export const NOTE_ID_PREFIX = 'note:';

/** 结果里可能出现的节点种类。 */
export const VIEW_NODE_KINDS = Object.freeze(['episode', 'claim', 'topic', 'library', 'note']);

/** 各条边的机械权重（link 边用它自己的 weight，不在这里）。 */
export const VIEW_EDGE_WEIGHT = Object.freeze({ support: 0.85, mention: 0.6, library: 0.9, contains: 0.9, link: 0.6 });

const LABEL_MAX = 120;
const WHY_MAX = 160;
const CENTER_CAP = 0.99; // 非中心节点的权重上限，保证中心排首位

// ---------------------------------------------------------------------------
// 小工具（纯函数）
// ---------------------------------------------------------------------------

function badArgument(message) {
  return new Error(`bad-argument: ${message}`);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/** epoch ms → `YYYY-MM-DD`（UTC；与 R07 formatDay(ms,'UTC') 同口径）。 */
function dayOf(ms) {
  if (!isFiniteNumber(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 去掉 store 列表项包的那层 `{id, path, record}`；普通记录原样返回。 */
function unwrap(item) {
  if (item && typeof item === 'object' && item.record && typeof item.record === 'object') return item.record;
  return item;
}

/** 数组按 id 建索引（WeakMap 记忆化：视图对象按约定是只读的，同一数组只扫一遍）。 */
const ARRAY_INDEX = new WeakMap();
function indexPathOf(list) {
  let index = ARRAY_INDEX.get(list);
  if (index) return index;
  index = new Map();
  for (const item of list) {
    const rec = unwrap(item);
    if (rec && typeof rec === 'object' && typeof rec.id === 'string' && rec.id !== '') index.set(rec.id, rec);
  }
  ARRAY_INDEX.set(list, index);
  return index;
}

/** Map / {get} / 普通对象 / 数组 → 一条记录；拿不到返回 null。 */
function lookup(table, id) {
  if (!table || typeof id !== 'string' || id === '') return null;
  if (Array.isArray(table)) return indexPathOf(table).get(id) ?? null;
  if (typeof table.get === 'function') {
    try { return unwrap(table.get(id)) ?? null; } catch { return null; }
  }
  if (typeof table === 'object') return unwrap(table[id]) ?? null;
  return null;
}

/**
 * 取一张“按 id 索引”的表：主字段优先，数组别名兜底。
 * 主字段 = inject 视图里的 `*ById`；别名 = `view.episodes` / `view.claims` / `view.topics`（夹具常用数组写法）。
 * 注意 inject 的 storeView 自带 `claims: [...]`（投影后的 claim 数组），这里正好还能当 claimsById 用。
 */
function tableOf(view, primary, alias) {
  const main = view?.[primary];
  if (main != null) return main;
  return view?.[alias] ?? null;
}

/** Map / 数组 / 普通对象 → 记录数组（跳过 null 与没有 id 的）。 */
function recordsOf(table) {
  if (!table) return [];
  const out = [];
  const push = (value) => {
    const rec = unwrap(value);
    if (rec && typeof rec === 'object' && typeof rec.id === 'string' && rec.id !== '') out.push(rec);
  };
  if (Array.isArray(table)) {
    for (const item of table) push(item);
    return out;
  }
  if (typeof table.get === 'function' && typeof table.forEach === 'function') {
    for (const [, value] of table) push(value);
    return out;
  }
  if (typeof table === 'object') {
    for (const key of Object.keys(table)) push(table[key]);
  }
  return out;
}

/** id 前缀 → 节点种类（只有本房间会产出的 id 形状）。 */
export function nodeKindOfId(id) {
  const s = typeof id === 'string' ? id : '';
  if (s.startsWith('ep-')) return 'episode';
  if (s.startsWith('c-')) return 'claim';
  if (s.startsWith('t:')) return 'topic';
  if (s.startsWith('lib:')) return 'library';
  if (s.startsWith(NOTE_ID_PREFIX)) return 'note';
  return null;
}

/** 节点自身的时间戳（occurredAt 一等字段；缺就是 null，不拿入档时间冒充）。 */
function occurredAtOf(kind, rec) {
  if (!rec) return null;
  if (kind === 'episode') {
    for (const key of ['lastEventAt', 'endedAt', 'startedAt', 'firstEventAt']) {
      if (isFiniteNumber(rec[key])) return rec[key];
    }
    return null;
  }
  if (kind === 'claim') {
    if (isFiniteNumber(rec.occurredAt)) return rec.occurredAt;
    const support = Array.isArray(rec.support) ? rec.support : [];
    for (const entry of support) if (entry && isFiniteNumber(entry.occurredAt)) return entry.occurredAt;
    return null;
  }
  if (kind === 'topic') {
    for (const key of ['lastSeenAt', 'firstSeenAt']) if (isFiniteNumber(rec[key])) return rec[key];
    return null;
  }
  return isFiniteNumber(rec.occurredAt) ? rec.occurredAt : null;
}

/** 节点标签：一律单行、≤120 字；没有 l0/l1 的棋谱用「棋谱 id · 日期 · fail=n」机械拼。 */
function labelOf(kind, rec) {
  if (!rec) return null;
  if (kind === 'episode') {
    const text = singleLine(rec.l0 ?? '') || singleLine(rec.l1 ?? '');
    if (text) return clipLine(text, LABEL_MAX);
    const bits = [`棋谱 ${rec.id}`];
    const day = dayOf(occurredAtOf('episode', rec));
    if (day) bits.push(day);
    const failures = isFiniteNumber(rec?.signals?.failures) ? rec.signals.failures : 0;
    if (failures > 0) bits.push(`fail=${failures}`);
    return clipLine(bits.join(' · '), LABEL_MAX);
  }
  if (kind === 'claim') {
    const text = singleLine(rec.text ?? '');
    return clipLine(text || `claim ${rec.id}`, LABEL_MAX);
  }
  if (kind === 'topic') {
    const key = singleLine(rec.key ?? rec.id ?? '');
    const kindTag = typeof rec.kind === 'string' && rec.kind ? `${rec.kind}: ` : '';
    return clipLine(`${kindTag}${key}`, LABEL_MAX);
  }
  if (kind === 'library') {
    return clipLine(singleLine(rec.label ?? LIBRARY_TITLE), LABEL_MAX);
  }
  if (kind === 'note') {
    return clipLine(singleLine(rec.title ?? rec.label ?? rec.path ?? rec.id), LABEL_MAX);
  }
  return clipLine(singleLine(rec.id ?? ''), LABEL_MAX);
}

/** 文件名去掉扩展名（note 的兜底标题；不读盘，只切路径串）。 */
function fileNameOf(relPath) {
  const s = singleLine(relPath ?? '');
  const base = s.split('/').pop() ?? s;
  return base.replace(/\.[A-Za-z0-9]+$/, '') || base;
}

/** 主题 mention 边的权重：有 idfNorm 用 idfNorm（0..1），否则 0.6。 */
function mentionWeight(topic) {
  if (isFiniteNumber(topic?.idfNorm)) return Math.max(0, Math.min(1, topic.idfNorm));
  return VIEW_EDGE_WEIGHT.mention;
}

function whyOf(link) {
  const raw = typeof link?.why === 'string' ? link.why : '';
  if (raw) return clipLine(raw, WHY_MAX);
  const topics = Array.isArray(link?.topics) ? link.topics.map(String).filter(Boolean) : [];
  return clipLine(topics.join(', ') || String(link?.kind ?? 'link'), WHY_MAX);
}

// ---------------------------------------------------------------------------
// 图：从 view 建出节点表 + 边表（只读视图对象，不碰磁盘）
// ---------------------------------------------------------------------------

/**
 * @param {object} view
 * @param {string|null} centerScope 当前作用域（null = 不做跨域过滤）
 * @param {string} centerKind
 * @returns {{nodes: Map, edges: Array, adjacency: Map}}
 */
function buildGraph(view, centerScope, centerKind, centerId = '') {
  const nodes = new Map();
  const edges = [];
  const edgeByKey = new Map();
  const adjacency = new Map();

  const scopeAllowed = (scopeKey) => {
    const raw = typeof scopeKey === 'string' ? scopeKey.trim() : '';
    if (raw === '') return true; // 不带 scopeKey 的节点/边不参与跨域判定
    if (!centerScope) return true; // 没有可比的作用域 ⇒ 不过滤（由调用方保证）
    return isScopeVisible(raw, centerScope);
  };

  const addNode = (id, kind, rec) => {
    if (typeof id !== 'string' || id === '') return null;
    if (nodes.has(id)) return nodes.get(id);
    // 中心是调用方点名的那个节点：即使它自己的 scope 与当前作用域不同也包含（不因此在邻域里带上别人）
    if (id !== centerId && rec && !scopeAllowed(rec.scopeKey)) return null;
    const node = {
      kind,
      id,
      label: labelOf(kind, rec) ?? clipLine(id, LABEL_MAX),
      occurredAt: occurredAtOf(kind, rec),
      record: rec ?? null, // 内部用，不出口（输出前会剥掉）
    };
    nodes.set(id, node);
    return node;
  };

  const addEdge = (kind, a, b, why, weight, scopeKey = null) => {
    if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '' || a === b) return;
    if (!nodes.has(a) || !nodes.has(b)) return; // 只有两端都成立时记边
    if (!scopeAllowed(scopeKey)) return;
    const [from, to] = a < b ? [a, b] : [b, a]; // 无向图：from/to 规范成字典序
    const reason = clipLine(why ?? '', WHY_MAX) || String(kind);
    const w = isFiniteNumber(weight) ? round4(Math.max(0, weight)) : VIEW_EDGE_WEIGHT.link;
    const key = `${kind}\u0000${from}\u0000${to}\u0000${reason}`;
    const prev = edgeByKey.get(key);
    if (prev) {
      if (w > prev.weight) prev.weight = w;
      return;
    }
    const edge = { kind, from, to, why: reason, weight: w };
    edgeByKey.set(key, edge);
    edges.push(edge);
    for (const [here, there] of [[from, to], [to, from]]) {
      if (!adjacency.has(here)) adjacency.set(here, []);
      adjacency.get(here).push({ other: there, kind, why: reason, weight: w });
    }
  };

  // ---- 1) 棋谱节点 + 棋谱↔主题 mention 边 ----
  const episodes = recordsOf(tableOf(view, 'episodesById', 'episodes'));
  for (const episode of episodes) {
    if (!addNode(episode.id, 'episode', episode)) continue;
    const topics = Array.isArray(episode.topics) ? episode.topics : [];
    for (const topic of topics) {
      if (!topic || typeof topic.id !== 'string' || topic.id === '') continue;
      const rec = lookup(tableOf(view, 'topicsById', 'topics'), topic.id) ?? topic;
      if (!addNode(topic.id, 'topic', rec)) continue;
      addEdge('mention', episode.id, topic.id, topic.key ?? rec?.key ?? topic.id, mentionWeight(rec));
    }
  }

  // ---- 2) claim 节点 + claim↔棋谱 support 边 ----
  const claims = recordsOf(tableOf(view, 'claimsById', 'claims'));
  for (const claim of claims) {
    if (!addNode(claim.id, 'claim', claim)) continue;
    const support = Array.isArray(claim.support) ? claim.support : [];
    for (const entry of support) {
      const episodeId = typeof entry?.episode === 'string' ? entry.episode : '';
      if (episodeId === '' || !episodeById(episodeId)) continue; // 棋谱不在视图里就不连（不凭空造节点）
      addEdge('support', claim.id, episodeId, `${claim.kind ?? 'claim'} claim`, VIEW_EDGE_WEIGHT.support);
    }
  }

  function episodeById(id) {
    const rec = lookup(tableOf(view, 'episodesById', 'episodes'), id);
    if (!rec) return null;
    return addNode(id, 'episode', rec) ? rec : null;
  }

  // ---- 3) 棋谱↔棋谱边（links / linksFromEpisode）----
  const linkRecords = [];
  if (Array.isArray(view?.links)) linkRecords.push(...view.links);
  else if (view?.links && typeof view.links.forEach === 'function' && typeof view.links.get !== 'function') {
    for (const item of view.links) linkRecords.push(item);
  }
  if (!linkRecords.length && view?.linksFromEpisode) {
    const seen = new Set();
    for (const episode of episodes) {
      let list = null;
      try {
        list = typeof view.linksFromEpisode === 'function'
          ? view.linksFromEpisode(episode.id)
          : lookup(view.linksFromEpisode, episode.id);
      } catch { list = null; }
      for (const item of Array.isArray(list) ? list : []) {
        const link = unwrap(item);
        if (!link || typeof link !== 'object') continue;
        const key = typeof link.id === 'string' ? `id:${link.id}` : `${link?.a?.episode}>${link?.b?.episode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        linkRecords.push(link);
      }
    }
  }
  for (const raw of linkRecords) {
    const link = unwrap(raw);
    if (!link || typeof link !== 'object') continue;
    const a = typeof link?.a?.episode === 'string' ? link.a.episode : '';
    const b = typeof link?.b?.episode === 'string' ? link.b.episode : '';
    if (a === '' || b === '' || a === b) continue;
    if (!episodeById(a) || !episodeById(b)) continue;
    addEdge(link.kind ?? 'link', a, b, whyOf(link), isFiniteNumber(link.weight) ? link.weight : VIEW_EDGE_WEIGHT.link, link.scopeKey ?? null);
  }

  // ---- 4) 知识库巨型节点：只在被显式指到时出现（§14.6）----
  const libraryId = typeof view?.library?.id === 'string' && view.library.id ? view.library.id : LIBRARY_ID;
  const libraryRec = {
    id: libraryId,
    label: libraryLabel(view),
    occurredAt: isFiniteNumber(view?.library?.occurredAt) ? view.library.occurredAt : null,
  };
  const libraryEdges = Array.isArray(view?.libraryEdges) ? view.libraryEdges : [];
  for (const raw of libraryEdges) {
    const edge = unwrap(raw);
    if (!edge || typeof edge !== 'object') continue;
    const from = typeof edge.from === 'string' ? edge.from : '';
    const to = typeof edge.to === 'string' ? edge.to : '';
    if (from === '' || to === '') continue;
    if (from !== libraryId && to !== libraryId) continue; // 不是知识库的边：不在这里处理
    // 两端按 id 形状补出节点（主题/claim/棋谱/知识库）；有一端补不出来就只跳过这一条边
    let ok = true;
    for (const id of [from, to]) {
      if (id === libraryId) {
        if (!addNode(libraryId, 'library', libraryRec)) { ok = false; break; }
        continue;
      }
      const kind = nodeKindOfId(id);
      if (!kind) { ok = false; break; } // 无法识别的 id
      const rec = kind === 'topic'
        ? lookup(tableOf(view, 'topicsById', 'topics'), id)
        : kind === 'claim'
          ? lookup(tableOf(view, 'claimsById', 'claims'), id)
          : kind === 'episode' ? episodeById(id) : null;
      if (!addNode(id, kind, rec)) { ok = false; break; }
    }
    if (!ok) continue;
    addEdge(edge.kind ?? 'library', from, to, edge.why ?? LIBRARY_TITLE, isFiniteNumber(edge.weight) ? edge.weight : VIEW_EDGE_WEIGHT.library);
  }

  // ---- 5) center 就是知识库：按 depth 展开成 note 子节点 ----
  if (centerKind === 'library') {
    if (!addNode(libraryId, 'library', libraryRec)) return { nodes, edges, adjacency };
    for (const note of libraryNotes(view)) {
      const noteId = `${NOTE_ID_PREFIX}${note.path}`;
      const rec = { id: noteId, title: note.title || fileNameOf(note.path), path: note.path, occurredAt: note.occurredAt ?? null };
      if (!addNode(noteId, 'note', rec)) continue;
      addEdge('contains', libraryId, noteId, LIBRARY_TITLE, VIEW_EDGE_WEIGHT.contains);
    }
  }

  return { nodes, edges, adjacency };
}

/** 知识库 label：有数字才写「（N 篇）」，没有就只写标题（不编数字）。 */
function libraryLabel(view) {
  const count = (() => {
    const explicit = view?.library?.count;
    if (isFiniteNumber(explicit)) return explicit;
    if (isFiniteNumber(view?.libraryCount)) return view.libraryCount;
    const notes = libraryNotes(view);
    return notes.length > 0 ? notes.length : null;
  })();
  const title = typeof view?.library?.title === 'string' && view.library.title ? view.library.title : LIBRARY_TITLE;
  return count == null ? singleLine(title) : `${singleLine(title)}（${count} 篇）`;
}

/** 子文档清单：字符串路径 / {path,title,occurredAt} 两种写法都收；去重、按 path 升序。 */
function libraryNotes(view) {
  const raw = Array.isArray(view?.library?.notes)
    ? view.library.notes
    : Array.isArray(view?.libraryNotes) ? view.libraryNotes : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const path = typeof item === 'string' ? item : typeof item?.path === 'string' ? item.path : '';
    if (path === '' || seen.has(path)) continue;
    seen.add(path);
    out.push({
      path,
      title: typeof item === 'object' && item && typeof item.title === 'string' ? item.title : '',
      occurredAt: typeof item === 'object' && item && isFiniteNumber(item.occurredAt) ? item.occurredAt : null,
    });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// 邻居排序（确定性）：weight 降序 → id 升序
// ---------------------------------------------------------------------------

function sortNeighbors(list) {
  list.sort((a, b) => (b.weight - a.weight) || (a.other < b.other ? -1 : a.other > b.other ? 1 : 0) || (a.kind < b.kind ? -1 : 1));
  return list;
}

function compareEdges(a, b) {
  if (b.weight !== a.weight) return b.weight - a.weight;
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.why < b.why ? -1 : a.why > b.why ? 1 : 0;
}

function clampOption(value, fallback, lo, hi) {
  const n = isFiniteNumber(value) ? Math.floor(value) : fallback;
  const clamped = n > hi;
  return { value: Math.min(hi, Math.max(lo, clamped ? hi : n)), clamped };
}

// ---------------------------------------------------------------------------
// buildNeighborhood
// ---------------------------------------------------------------------------

/**
 * 以当前节点为中心切一块有界邻域。
 * @param {object} p
 * @param {{kind:string, id:string}} p.center
 * @param {object} p.view                与 R12 collectEntries 同一种视图对象（字段见文件头）
 * @param {number} [p.maxNodes=324]      节点上限（硬上限 324）
 * @param {number} [p.maxEdges=2000]     边/边界边上限
 * @param {number} [p.depth=1]           跳数（0..2；默认 1）
 * @returns {{center:{kind:string,id:string}, nodes:Array, edges:Array, frontier:Array,
 *            counts:{nodes:number,edges:number,frontier:number},
 *            truncated:{nodes:boolean,edges:boolean}, clamped:boolean}}
 */
export function buildNeighborhood({ center, view, maxNodes = VIEW_DEFAULTS.maxNodes, maxEdges = VIEW_DEFAULTS.maxEdges, depth = VIEW_DEFAULTS.depth } = {}) {
  // ---- 参数校验（只有结构性问题才抛；数值一律夹紧）----
  if (center === null || typeof center !== 'object' || Array.isArray(center)) {
    throw badArgument('center 必须是对象 {kind, id}');
  }
  const centerKind = typeof center.kind === 'string' ? center.kind : '';
  if (!['episode', 'claim', 'library'].includes(centerKind)) {
    throw badArgument(`center.kind 不支持：${JSON.stringify(center.kind)}（只支持 episode | claim | library）`);
  }
  if (typeof center.id !== 'string' || center.id.trim() === '') {
    throw badArgument('center.id 必须是非空字符串');
  }
  const centerId = center.id.trim();

  const nodesOpt = clampOption(maxNodes, VIEW_DEFAULTS.maxNodes, 1, MAX_VIEW_NODES);
  const edgesOpt = clampOption(maxEdges, VIEW_DEFAULTS.maxEdges, 0, 1000000);
  const depthOpt = clampOption(depth, VIEW_DEFAULTS.depth, 0, MAX_VIEW_DEPTH);
  const maxNodesValue = nodesOpt.value;
  const maxEdgesValue = edgesOpt.value;
  const maxDepth = depthOpt.value;
  const clamped = isFiniteNumber(maxNodes) && maxNodes > MAX_VIEW_NODES;

  const empty = () => ({
    center: { kind: centerKind, id: centerId },
    nodes: [],
    edges: [],
    frontier: [],
    counts: { nodes: 0, edges: 0, frontier: 0 },
    truncated: { nodes: false, edges: false },
    clamped,
  });

  if (!view || typeof view !== 'object') return empty();

  // ---- center 记录与作用域 ----
  const centerRecord = (() => {
    if (centerKind === 'episode') return lookup(tableOf(view, 'episodesById', 'episodes'), centerId);
    if (centerKind === 'claim') return lookup(tableOf(view, 'claimsById', 'claims'), centerId);
    return { id: centerId }; // library：作用域来自 view.scope / view.scopeKey
  })();
  if (!centerRecord) return empty();
  // 作用域优先级：**调用方当前作用域**（view.scope / view.scopeKey）> center 记录自己的 scopeKey。
  // 理由：u: 用户层的 claim/主题在真实工作区里可见，若拿 u: 当过滤基准，它的 w: 证据会全被挡掉
  // （实测：u:owner claim 为中心时邻域只剩它自己）。调用方不给 scope 时才退回 center 记录。
  const scopeHint = typeof view.scope === 'string' && view.scope.trim() !== ''
    ? view.scope
    : (typeof view.scopeKey === 'string' && view.scopeKey.trim() !== '' ? view.scopeKey : null);
  const scopeCandidate = scopeHint ?? (typeof centerRecord.scopeKey === 'string' && centerRecord.scopeKey.trim() !== '' ? centerRecord.scopeKey : null);
  // `u:` 用户层是**跨工作区**的（一条 u: claim 的证据天然分布在多个工作区）：
  // 拿 u: 当过滤基准会把它的 w: 证据全挡掉，claim 变成孤岛。所以作用域是 u: 时**不做工作区过滤**
  // （调用方真想要某工作区的视图，就传 view.scope = w:…）。
  const rawCenterScope = scopeCandidate && String(scopeCandidate).trim().toLowerCase().startsWith('u:') ? null : scopeCandidate;

  const graph = buildGraph(view, rawCenterScope, centerKind, centerId);
  const { nodes, adjacency } = graph;
  if (!nodes.has(centerId)) return empty();

  // ---- BFS（深度 ≤2；同一层先排序 ⇒ 首达边确定）----
  for (const list of adjacency.values()) sortNeighbors(list);
  const depthOf = new Map([[centerId, 0]]);
  const viaWeight = new Map([[centerId, 1]]);
  let level = [centerId];
  for (let d = 0; d < maxDepth && level.length; d += 1) {
    const next = [];
    for (const id of level) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (depthOf.has(neighbor.other)) continue;
        depthOf.set(neighbor.other, d + 1);
        viaWeight.set(neighbor.other, neighbor.weight);
        next.push(neighbor.other);
      }
    }
    next.sort();
    level = next;
  }

  // ---- 节点权重与排序（中心恒 1；其余按跳数衰减、上限 0.99）----
  const weightOf = new Map();
  for (const [id, d] of depthOf) {
    if (id === centerId) { weightOf.set(id, 1); continue; }
    const edgeWeight = isFiniteNumber(viaWeight.get(id)) ? viaWeight.get(id) : VIEW_EDGE_WEIGHT.link;
    const decayed = edgeWeight * 0.5 ** Math.max(0, d - 1);
    weightOf.set(id, round4(Math.min(CENTER_CAP, Math.max(0, decayed))));
  }
  const candidates = [...depthOf.keys()].filter((id) => nodes.has(id));
  candidates.sort((a, b) => (weightOf.get(b) - weightOf.get(a)) || (a < b ? -1 : a > b ? 1 : 0));
  const selectedIds = candidates.slice(0, maxNodesValue);
  const selected = new Set(selectedIds);

  const outputNodes = selectedIds.map((id) => {
    const node = nodes.get(id);
    return {
      kind: node.kind,
      id: node.id,
      label: node.label,
      occurredAt: isFiniteNumber(node.occurredAt) ? node.occurredAt : null,
      weight: weightOf.get(id) ?? 0,
    };
  });

  // ---- 边：内部边（两端都在）与边界边（一端在 ⇒ frontier）----
  const internal = [];
  const boundary = [];
  for (const edge of graph.edges) {
    const inFrom = selected.has(edge.from);
    const inTo = selected.has(edge.to);
    if (inFrom && inTo) internal.push(edge);
    else if (inFrom || inTo) boundary.push(edge);
  }
  internal.sort(compareEdges);
  boundary.sort(compareEdges);
  const keptEdges = internal.slice(0, maxEdgesValue).map((edge) => ({ kind: edge.kind, from: edge.from, to: edge.to, why: edge.why, weight: edge.weight }));
  const frontier = boundary.slice(0, maxEdgesValue).map((edge) => ({ kind: edge.kind, from: edge.from, to: edge.to, why: edge.why }));

  return {
    center: { kind: centerKind, id: centerId },
    nodes: outputNodes,
    edges: keptEdges,
    frontier,
    counts: { nodes: outputNodes.length, edges: keptEdges.length, frontier: frontier.length },
    truncated: {
      nodes: candidates.length > outputNodes.length,
      edges: internal.length > keptEdges.length || boundary.length > frontier.length,
    },
    clamped,
  };
}

export default { buildNeighborhood, VIEW_DEFAULTS, MAX_VIEW_NODES, MAX_VIEW_DEPTH, LIBRARY_ID, LIBRARY_TITLE, NOTE_ID_PREFIX, VIEW_NODE_KINDS, VIEW_EDGE_WEIGHT, nodeKindOfId };
