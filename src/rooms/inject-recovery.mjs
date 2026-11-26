// R12 取数与记录 —— 信号 / store 视图 / 降级 walk / 恢复事实 / trial / 影子记录 + `inject` CLI
// （task-14 / 重构 G 期：从 `inject-card.mjs` **逐行搬出**，判据一个都没改）
//
// 四房分工（`inject.mjs` 仍是转发垫片，导出面一字不变）：
//   `inject-gate.mjs`     —— 十道闸 + 预算/来源/行形态的**判据**（单源实现）
//   `inject-card.mjs`     —— **渲染侧**：hit → 记忆行 → 记忆卡（+ token 预算裁剪）
//   `inject-recovery.mjs` —— **本文件**：取数与记录侧
//   `inject-slot.mjs`     —— 槽位幂等账本
//
// 本房装的是原 `inject-card.mjs` 的第 ③④⑤ 块，以及它们（和条目构造）共用的**取数原语**：
//   ③ 恢复事实（T28/T30/T31/T34/T37）—— 读会话日志 / 归档层索引，给失败 claim 找「同一主体后来成功」；
//   ④ trial（T33）—— 观察窗里原地复发还是后来修好：**只记录、不退役**；
//   ⑤ 影子记录 + `inject` CLI —— 只写 `evidence/shadow/`（拒写 `$DSH_HOME`），并跑十道闸打印结果；
//   · 取数原语：`signalFromText`（当前会话 → 检索输入）、`storeView`（store 的只读投影）、
//     `RANK`/`rankOf`（次序单一来源）、`degradedWalk`（R11 walk 缺位时的等价物）。
//   后四样不是渲染判据，搬家只为让 `inject-card.mjs` 真的只剩 ①②（≤1,200 行）。
//
// 依赖方向：本房**不静态 import `inject-card.mjs`** —— `runInject` 里用 `await import` 取渲染入口
// （与 `./persist.mjs` / `./gates.mjs` 同一个做法，避免两房互为静态依赖成环）；
// `inject-card.mjs` 静态 import 本房 ⇒ 单向、无环。
//
// 判据一字未改：每条注释里的数值/口径、每个函数的实现都按原文件逐行搬运（只换了文件边界）。
// 墓碑测试：`test/inject.test.mjs` 的「task-14 · 取数房」段 —— 删掉本文件 ⇒ 该段与整片测试一起红。
//
// 三条铁律（与卡片房同源）：只陈述事实（无祈使句）/ 每条带 provenance 与 occurredAt 绝对日期 / shadow 只写证据目录。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecoveryIndex, findRecoveryFact, RECOVERY_FACT_KINDS } from './extract.mjs';
import { readFrames, parseEvents } from './logread.mjs';
import { readRecoveryIndex, readTrials, appendTrials } from './persist.mjs';
import { classifyErrorClass } from './claim.mjs';
import { ENTRY_LIMIT, BUDGET_TOKENS } from './limits.mjs';
// task-11：闸判据全部从 `inject-gate.mjs` 读（单源；本房不再持有第二份实现）。
import { estimateTokens, formatCardDate, filterHitsByScope, scopeKeyFromPath } from './inject-gate.mjs';

// task-14：`CARD_VERSION` 定义在本房而不是卡片房 —— 影子记录的默认 `version` 就是它，
// `InjectError` 是写盘错误的类型（两者在 ⑤ 里用）。放这里让两房依赖保持单向：
// `inject-card.mjs` → 本房（卡片房再把它们原样转出，对外导出面不变）。
/** 卡片格式版本（`buildMemoryCard` 的 `cardVersion` 与 shadow 记录的 `version` 同一个来源）。 */
export const CARD_VERSION = 1;

/** 影子模式的落点（仓库内 `evidence/shadow/`）—— 相对路径与文件名分开写，便于守卫按目录核对。 */
export const SHADOW_DIR_REL = path.join('evidence', 'shadow');
export const SHADOW_FILE = 'shadow.jsonl';

export class InjectError extends Error {
  constructor(message, code = 'inject/error', detail = null) {
    super(message);
    this.name = 'InjectError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// 信号：当前会话 → 检索输入（契约 §7.1）
// ---------------------------------------------------------------------------

/** CJK 2-gram 的停用表（只丢无判别力的虚词/套话；不做语义判断）。 */
const STOP_TERMS = new Set([
  '这个', '那个', '时候', '问题', '需要', '可以', '如果', '因为', '所以', '然后', '现在',
  '我们', '你们', '他们', '已经', '还是', '就是', '什么', '怎么', '一个', '没有', '不是',
  '这些', '那些', '以及', '并且', '但是', '不过', '一下', '这里', '那里', '这样', '那样',
]);

/**
 * 根消息文本 → signal（纯机械：ASCII 词 + CJK 2-gram + 路径/域名/错误码实体）。
 * 不判断「像不像主题」，也不调模型：词表由 R04 主题索引去对齐。
 */
export function signalFromText(text, { at = null, kind = 'root-message' } = {}) {
  const raw = String(text ?? '');
  const terms = new Set();
  for (const m of raw.matchAll(/[A-Za-z][A-Za-z0-9_./@-]{2,}/g)) terms.add(m[0].toLowerCase());
  for (const run of raw.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const g = run.slice(i, i + 2);
      if (!STOP_TERMS.has(g)) terms.add(g);
    }
  }

  const entities = [];
  const seen = new Set();
  const addEntity = (kindName, key) => {
    const k = String(key ?? '').replace(/[，。；、）】\],.;:!?]+$/, '');
    if (k.length < 2) return;
    const sig = `${kindName}\u0000${k}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entities.push({ kind: kindName, key: k });
  };
  for (const m of raw.matchAll(/[A-Za-z]:[\\/][^\s"'`，。；）]+/g)) addEntity('file', m[0]);
  for (const m of raw.matchAll(/https?:\/\/([^\s/"'`）]+)/gi)) addEntity('domain', m[1]);
  for (const m of raw.matchAll(/\b(?:[a-z0-9][a-z0-9-]*\.)+(?:com|cn|org|net|io|dev|app|ai)\b/gi)) addEntity('domain', m[0]);
  for (const m of raw.matchAll(/\bE[A-Z]{3,}\b|\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/g)) addEntity('error', m[0]);

  return {
    kind: typeof kind === 'string' && kind ? kind : 'root-message',
    terms: [...terms].sort(),
    entities,
    at: Number.isFinite(at) ? at : null,
  };
}

// ---------------------------------------------------------------------------
// store 读视图（只读；只用 list/get/counts 三个方法，缺 store 时全部降级为空）
// ---------------------------------------------------------------------------

const VIEW_CACHE = new WeakMap();

export function storeView(store, cache = null) {
  if (cache && typeof cache === 'object') {
    const hit = VIEW_CACHE.get(cache);
    if (hit) return hit;
  }
  const view = {
    indexPath: null,
    episodeCount: 0,
    claims: [],
    claimsById: new Map(),
    claimsByEpisode: new Map(),
    episodesById: new Map(),
    missing: true,
  };
  if (!store || typeof store.list !== 'function') return view;
  view.missing = false;
  view.indexPath = typeof store.indexPath === 'string' ? store.indexPath : null;

  try {
    const counts = typeof store.counts === 'function' ? store.counts() : null;
    if (counts && Number.isFinite(counts.episodes)) view.episodeCount = counts.episodes;
  } catch { /* 计数失败不阻塞注入：0 局如实写 0 */ }

  try {
    const claimItems = cache?.claims ? cache.claims.map((rec) => ({ record: rec })) : store.list('claims');
    for (const item of claimItems) {
      const rec = item?.record;
      if (!rec || typeof rec.text !== 'string') continue;
      const claim = {
        id: typeof rec.id === 'string' ? rec.id : (item.id ?? null),
        kind: typeof rec.kind === 'string' ? rec.kind : 'fact',
        state: typeof rec.state === 'string' ? rec.state : 'observed',
        text: rec.text,
        occurredAt: Number.isFinite(rec.occurredAt) ? rec.occurredAt : null,
        support: Array.isArray(rec.support) ? rec.support.filter((s) => s && typeof s === 'object') : [],
        // Q19-B 需要 hard/soft 区分；投影时别把 level 丢掉（2026-11-03 实测踩过）
        level: typeof rec.level === 'string' ? rec.level : null,
        // T162a：合并节点标记（consolidate 写的 merge.members / representative）；没有就 null。
        merge: rec.merge && typeof rec.merge === 'object' ? rec.merge : null,
        // T345：F3 失效条件（文本派生）。**投影必须带上**，否则卡上永远看不到（2026-11-06 实测踩过）。
        falsifiableWhen: rec.falsifiableWhen && typeof rec.falsifiableWhen === 'object' ? rec.falsifiableWhen : null,
      };
      view.claims.push(claim);
      if (claim.id) view.claimsById.set(claim.id, claim);
      const episodes = new Set(claim.support.map((s) => String(s.episode ?? '')).filter(Boolean));
      for (const ep of episodes) {
        if (!view.claimsByEpisode.has(ep)) view.claimsByEpisode.set(ep, []);
        view.claimsByEpisode.get(ep).push(claim);
      }
    }
  } catch { /* 坏条目跳过：注入宁可少一条，也不抛 */ }

  try {
    const episodeItems = cache?.episodes ? cache.episodes.map((rec) => ({ record: rec })) : store.list('episodes');
    for (const item of episodeItems) {
      const rec = item?.record;
      if (rec && typeof rec.id === 'string') view.episodesById.set(rec.id, rec);
    }
  } catch { /* 同上 */ }

  if (cache && typeof cache === 'object') VIEW_CACHE.set(cache, view);
  return view;
}

// ---------------------------------------------------------------------------
// 取数原语：次序（失败教训在最前；降级 walk 与条目排序共用这一份，单一来源）
// ---------------------------------------------------------------------------

const RANK = Object.freeze({
  antipattern: 0,
  failure: 0.5,
  preference: 1,
  rule: 1,
  constraint: 1.5,
  fact: 2,
  pointer: 2,
  pattern: 3,
  joseki: 3,
});

export function rankOf(kind) {
  return Number.isFinite(RANK[kind]) ? RANK[kind] : 2;
}

// ---------------------------------------------------------------------------
// 降级 walk（R11 未落地时的等价物：词面命中 → 主题 → 棋局，深度 1）
// 只读 store；不写盘；命中 why 必填 —— 与 R11 同一份 hit 形态，R12 无需区分来源。
// ---------------------------------------------------------------------------

/**
 * @param {{signal:object, store:object, limit?:number}} p
 * @returns {{hits:Array, path:Array, omitted:{count:number,reason:string}, tokens:number,
 *            depth:number, degraded:true}}
 */
export function degradedWalk({ signal = null, store = null, limit = ENTRY_LIMIT, cache = null } = {}) {
  const view = storeView(store, cache);
  const needles = [];
  for (const t of Array.isArray(signal?.terms) ? signal.terms : []) {
    const s = String(t ?? '').trim().toLowerCase();
    if (s.length >= 2) needles.push(s);
  }
  for (const e of Array.isArray(signal?.entities) ? signal.entities : []) {
    const s = String(e?.key ?? '').trim().toLowerCase();
    if (s.length >= 2) needles.push(s);
  }

  const hits = [];
  const pathRows = [];
  const omitted = { count: 0, reason: '' };
  if (!needles.length || view.missing) {
    omitted.reason = needles.length ? 'store 不可读' : 'signal 无可用词条';
    return { hits, path: pathRows, omitted, tokens: 0, depth: 1, degraded: true };
  }

  let topicRecords = [];
  try {
    topicRecords = typeof store.list === 'function'
      ? (cache?.topics ?? store.list('topics').map((x) => x?.record)).filter((r) => r && typeof r.key === 'string')
      : [];
  } catch {
    topicRecords = [];
  }

  const matched = topicRecords
    .map((t) => {
      const key = t.key.toLowerCase();
      const hitNeedle = needles.find((n) => key === n || key.includes(n) || n.includes(key));
      return hitNeedle ? { topic: t, needle: hitNeedle } : null;
    })
    .filter(Boolean)
    .sort((a, b) => ((a.topic.df ?? 0) - (b.topic.df ?? 0)) || String(a.topic.key).localeCompare(String(b.topic.key)));

  if (!matched.length) {
    omitted.reason = '主题索引无命中';
    return { hits, path: pathRows, omitted, tokens: 0, depth: 1, degraded: true };
  }

  const seen = new Set();
  for (const { topic, needle } of matched.slice(0, 3)) {
    for (const epId of Array.isArray(topic.episodes) ? topic.episodes : []) {
      const rec = view.episodesById.get(epId) ?? null;
      const occurredAt = Number.isFinite(rec?.startedAt) ? rec.startedAt : (rec?.firstEventAt ?? null);
      const key = `${epId}\u0000${topic.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const failures = Number(rec?.signals?.failures ?? 0);
      hits.push({
        episode: epId,
        link: null,
        why: [topic.key],
        weight: 1 / Math.max(1, Number(topic.df) || 1),
        occurredAt: Number.isFinite(occurredAt) ? occurredAt : null,
        seq: Number.isFinite(rec?.closure?.seqFrom) ? rec.closure.seqFrom : null,
        kind: failures > 0 ? 'failure' : 'episode',
        depth: 1,
        needle,
        // 与 R11 walk 的 hit 同形态：带棋谱自己的 scopeKey，R12/R13 判作用域时用
        scopeKey: typeof rec?.scopeKey === 'string' ? rec.scopeKey : null,
      });
      pathRows.push({ from: signal?.kind ?? 'signal', to: topic.key, why: [topic.key] });
    }
  }

  hits.sort((a, b) => (rankOf(a.kind) - rankOf(b.kind))
    || ((b.occurredAt ?? 0) - (a.occurredAt ?? 0))
    || String(a.episode).localeCompare(String(b.episode))
    // T317：最后一级 = claimId 字典序（episode 指针没有 claimId，空串排前）—— 稳定排序的总序保证
    || String(a.claim ?? a.claimId ?? '').localeCompare(String(b.claim ?? b.claimId ?? '')));

  if (hits.length > limit) {
    omitted.count = hits.length - limit;
    omitted.reason = `超出 ${limit} 条`;
    hits.length = limit;
  }

  return {
    hits,
    path: pathRows.slice(0, 3),
    omitted,
    tokens: hits.reduce((s, h) => s + estimateTokens(`${h.episode} ${(h.why ?? []).join(' ')}`), 0),
    depth: 1,
    degraded: true,
  };
}

// ---------------------------------------------------------------------------
// ③ 恢复事实（T28/T30/T31/T34/T37）：同一主体后来成功 ⇒ 卡行尾注「恢复」
// ---------------------------------------------------------------------------

/**
 * T37 · 恢复事实的「洞见层」：这条恢复事实属于**哪一类坑**。
 *
 * 机械来源（按优先级，全都不成 ⇒ `null`，**不编**）：
 *  ① `claim.class` / `claim.errorClass` 字段（数据里若将来带就直接用）；
 *  ② claim 文本的 `class:<slug>` 前缀（类级章节 claim 的既有形态）；
 *  ③ 仓库既有分类器 `classifyErrorClass`（`claim.mjs`；**扩类** 19 类，仅洞见层用）对 claim 原文的机械判定。
 * 返回值统一成 `class:<slug>`；没有类 ⇒ null（卡行与不加洞见层时**逐字节一致**）。
 * @param {object} claim
 * @returns {string|null}
 */
export function recoveryInsightClass(claim) {
  const explicit = claim?.class ?? claim?.errorClass ?? null;
  const norm = (v) => {
    const t = String(v ?? '').trim().toLowerCase();
    if (!t) return null;
    if (/^class:[a-z0-9][a-z0-9-]*$/.test(t)) return t;
    if (/^[a-z0-9][a-z0-9-]*$/.test(t)) return `class:${t}`;
    return null;
  };
  const fromField = norm(explicit);
  if (fromField) return fromField;
  const m = /^class:([a-z0-9][a-z0-9-]*)/i.exec(String(claim?.text ?? '').trim());
  if (m) return `class:${m[1].toLowerCase()}`;
  const derived = classifyErrorClass(claim?.text, { extended: true });
  return derived ? `class:${derived}` : null;
}

/** T28：恢复事实的缓存（按日志文件 size+mtime 失效；只存**派生索引**，不存事件原文）。 */
const RECOVERY_INDEX_CACHE = new Map();
const RECOVERY_INDEX_CACHE_MAX = 24;
/**
 * 读时派生的**成本上限**：>8 MB 的会话日志不在注入热路径上解析（大日志解一局要 1–2 s，20 张卡就能把
 * 报告工具拖慢一倍；不确定性来源也更大）。这是**确定性规则**（只看文件大小），不随缓存状态漂移。
 * 代价：这类长会话里的恢复事实读不到（实测全量 38 条里少 19 条，见 evidence/T28 §4）。
 * 正解是归档时落恢复索引（本刀可写路径不含），届时这条上限可以删掉。
 */
const RECOVERY_MAX_LOG_BYTES = 8 * 1024 * 1024;

/** 读一局的会话日志 → 恢复索引（只读；读不到/解析失败 ⇒ null，绝不抛）。 */
function recoveryIndexForLog(logPath) {
  let st;
  try { st = fs.statSync(logPath); } catch { return null; }
  if (st.size > RECOVERY_MAX_LOG_BYTES) return null;
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = RECOVERY_INDEX_CACHE.get(logPath);
  if (hit && hit.key === key) return hit.index;
  try {
    const parsed = parseEvents(readFrames(fs.readFileSync(logPath)));
    const index = buildRecoveryIndex(Array.isArray(parsed?.events) ? parsed.events : []);
    if (RECOVERY_INDEX_CACHE.size >= RECOVERY_INDEX_CACHE_MAX) {
      const oldest = RECOVERY_INDEX_CACHE.keys().next().value;
      RECOVERY_INDEX_CACHE.delete(oldest);
    }
    RECOVERY_INDEX_CACHE.set(logPath, { key, index });
    return index;
  } catch {
    return null;
  }
}

/**
 * T30：恢复索引的进程内缓存（key = size+mtime；索引是派生数据，变了自动失效）。
 * 索引条目 = 归档层预先算好的恢复事实；**只读**，查不到再走 T28 的读时派生。
 */
const RECOVERY_SIDECAR_CACHE = new Map();

function loadRecoveryIndexCached(storeRoot) {
  if (typeof storeRoot !== 'string' || !storeRoot) return null;
  let st;
  try { st = fs.statSync(path.join(storeRoot, 'recovery-index.json')); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = RECOVERY_SIDECAR_CACHE.get(storeRoot);
  if (hit && hit.key === key) return hit.index;
  const index = readRecoveryIndex(storeRoot);
  RECOVERY_SIDECAR_CACHE.set(storeRoot, { key, index });
  return index;
}

/**
 * T30：先查归档层索引（`claimId` 键）。校验：种类合法、seq/at 有值、episode 对得上、
 * 失败原文前缀与卡上引文**兼容**（同一 claim 的多个 support 不串用）。
 * 任何一项不满足 ⇒ `null`（交给读时派生兜底，不猜）。
 */
function indexedRecoveryFact({ claim, src, storeRoot }) {
  const index = loadRecoveryIndexCached(storeRoot);
  if (!index) return null;
  const ep = String(src?.episode ?? '');
  const srcSeq = Number(src?.seq);
  // ① 精确键（归档层按每条 support 记的）：卡上出处与索引一一对应，不需要前缀校验
  const supportKey = ep && Number.isFinite(srcSeq) ? `${ep}:${srcSeq}` : null;
  const viaSupport = supportKey ? index.supports?.[supportKey] : null;
  if (viaSupport && viaSupport.claimId === String(claim?.id ?? '')) {
    if (RECOVERY_FACT_KINDS.includes(viaSupport.kind) && Number.isFinite(viaSupport.seq) && Number.isFinite(viaSupport.at)) {
      return { kind: viaSupport.kind, seq: viaSupport.seq, at: viaSupport.at, failureSeq: Number.isFinite(viaSupport.failureSeq) ? viaSupport.failureSeq : null };
    }
    return null;
  }
  // ② claimId 兜底（旧索引 / 渲染的 support 没进 supports 时）：再校验 episode + 引文前缀
  const entry = index.entries?.[String(claim?.id ?? '')];
  if (!entry) return null;
  if (!RECOVERY_FACT_KINDS.includes(entry.kind)) return null;
  if (!Number.isFinite(entry.seq) || !Number.isFinite(entry.at)) return null;
  if (typeof entry.episode === 'string' && entry.episode && ep && entry.episode !== ep) return null;
  const quote = String(src?.quote ?? claim?.text ?? '').replace(/…$/, '').trim().slice(0, 60);
  const prefix = String(entry.prefix ?? '').replace(/…$/, '').trim();
  if (prefix && quote && !(quote.startsWith(prefix) || prefix.startsWith(quote))) return null;
  return { kind: entry.kind, seq: entry.seq, at: entry.at, failureSeq: Number.isFinite(entry.failureSeq) ? entry.failureSeq : null };
}

/**
 * T28/T30：给一条**失败 claim**找「同一主体后来成功」的事实。
 * 只对 `kind === 'antipattern'` 生效；**索引优先，读时派生兜底**；都没有 ⇒ null（卡行逐字节不变）。
 */
export function recoveryFactOf({ claim, src, options, logFallback = true }) {
  if (!claim || claim.kind !== 'antipattern') return null;
  if (options?.recoveryOnCard === false) return null;
  const storeRoot = typeof options?.recoveryStoreRoot === 'string' ? options.recoveryStoreRoot : null;
  const indexed = indexedRecoveryFact({ claim, src, storeRoot });
  if (indexed) return indexed;
  // T31：指针候选只查索引（成本上限）；正文行才回退到读时派生（T28）。
  if (!logFallback) return null;
  const base = typeof options?.recoveryBaseDir === 'string' ? options.recoveryBaseDir : null;
  if (!base) return null;
  const ep = options?.episodesById?.get?.(String(src?.episode ?? '')) ?? null;
  const rel = typeof ep?.closure?.logPath === 'string' ? ep.closure.logPath : null;
  if (!rel) return null;
  const logPath = path.isAbsolute(rel) ? rel : path.join(base, rel);
  const index = recoveryIndexForLog(logPath);
  if (!index) return null;
  const quote = typeof src?.quote === 'string' && src.quote ? src.quote : String(claim?.text ?? '');
  // 卡上出处 seq = 该 support 的事件序号（同一段错误在一局里重复出现时用它挑最近的一条）。
  const nearSeq = Number.isFinite(Number(src?.seq)) ? Number(src.seq) : null;
  return findRecoveryFact(index, quote, { nearSeq });
}

/** T28：恢复事实的尾注文案（**只写事实，不写「你该这么做」**；AGENTS §2.1）。 */
export function recoverySuffix(recovery, recoveryClass = null) {
  if (!recovery || !RECOVERY_FACT_KINDS.includes(recovery.kind)) return '';
  if (!Number.isFinite(recovery.seq) || !Number.isFinite(recovery.at)) return '';
  const date = formatCardDate(recovery.at);
  if (!date || date.startsWith('????')) return '';
  // T37：洞见层 —— 有坑类就把它标在「恢复」后面的括号里（事实形式，不是祈使句）。
  const cls = typeof recoveryClass === 'string' && /^class:[a-z0-9][a-z0-9-]*$/.test(recoveryClass) ? `（${recoveryClass}）` : '';
  if (recovery.kind === 'same-file-write-ok') return ` · 恢复${cls}：后于 ${date} 同一文件写入成功（seq ${recovery.seq}）`;
  // T34：**同工具族**是最弱档 —— 文案必须写清"同工具族"，不许写成"同一命令"（否则是编）；
  // T37：坑类与档位一起标（`（同工具族 · class:x）`），两者不混。
  const tierTag = recovery.kind === 'same-tool' ? `同工具族${cls ? ` · ${recoveryClass}` : ''}` : null;
  if (recovery.kind === 'same-tool') return ` · 恢复（${tierTag}）：后于 ${date} 同工具族后来成功（seq ${recovery.seq}）`;
  const label = recovery.kind === 'same-command-exit-0' ? '同一命令成功（exit 0' : '同一命令重跑（无失败输出';
  return ` · 恢复${cls}：后于 ${date} ${label}, seq ${recovery.seq}）`;
}

// ---------------------------------------------------------------------------
// ④ trial（T33）：上次注入之后，同一主体是原地复发还是后来修好 —— 只记录、不退役
// ---------------------------------------------------------------------------

/** T33：trial 的三种结果（单一来源；只记录、不参与可见性/退役）。 */
export const TRIAL_OUTCOMES = Object.freeze(['recurred', 'avoided', 'unknown']);

/**
 * T33 · trial 的机械判据：**上一次注入（since）之后**，同一主体发生了什么？
 *
 *  · `recurred` —— claim 的 `support` 里有 `occurredAt > since` 的（同一错误签名在后续局里**再次出现**）；
 *  · `avoided`  —— T30 恢复事实（同一主体后来成功）的 `at > since`（**后来修好了**）；
 *  · `unknown`  —— 观察窗里两种证据都没有（不猜）。
 *
 * 有多条后继证据时取**最早**的那条（离注入最近），保证可复现；`since` 缺失 ⇒ `unknown`。
 * @param {{claim:object, recovery?:object|null, since?:number|null}} input
 * @returns {{outcome:string, evidenceEpisode:string|null, evidenceSeq:number|null, evidenceAt:number|null}}
 */
export function trialOutcomeOf({ claim, recovery = null, since = null, until = null } = {}) {
  const sinceTs = Number.isFinite(since) ? Number(since) : null;
  const untilTs = Number.isFinite(until) ? Number(until) : null;
  if (!claim || sinceTs === null) return { outcome: 'unknown', evidenceEpisode: null, evidenceSeq: null, evidenceAt: null };
  const supports = (Array.isArray(claim.support) ? claim.support : [])
    .filter((sup) => Number.isFinite(sup?.occurredAt) && Number(sup.occurredAt) > sinceTs && (untilTs === null || Number(sup.occurredAt) <= untilTs))
    .sort((a, b) => Number(a.occurredAt) - Number(b.occurredAt));
  if (supports.length) {
    const first = supports[0];
    return {
      outcome: 'recurred',
      evidenceEpisode: typeof first?.episode === 'string' ? first.episode : null,
      evidenceSeq: Number.isFinite(Number(first?.seq)) ? Number(first.seq) : null,
      evidenceAt: Number(first.occurredAt),
    };
  }
  if (recovery && Number.isFinite(recovery.at) && Number(recovery.at) > sinceTs && (untilTs === null || Number(recovery.at) <= untilTs)) {
    return {
      outcome: 'avoided',
      evidenceEpisode: typeof recovery.episode === 'string' ? recovery.episode : null,
      evidenceSeq: Number.isFinite(recovery.seq) ? recovery.seq : null,
      evidenceAt: Number(recovery.at),
    };
  }
  return { outcome: 'unknown', evidenceEpisode: null, evidenceSeq: null, evidenceAt: null };
}

/**
 * T33 · 注入时结算 trial：**只记录、不退役**（Zep 也是先攒 trial）。
 *
 * 语义：本次注入时，把**上一次注入**（`since`）到现在这段观察窗里的结果写一条记录。
 *  · `since` 取自 `trials.jsonl` 里该 claim 最近一条的 `at`（= 上次观察/注入时间）；
 *    没有记录时退回 `claim.counters.lastInjectedAt`；**两者都没有 ⇒ 本次是首次注入，只开 trial、不写记录**。
 *  · 恢复事实只查**索引**（`recovery-index.json`，T30）—— 热路径不解日志。
 *  · 幂等：同一 `(claimId, injectedAt)` 只写一条（`appendTrials` 去重）。
 * @returns {{appended:number, skipped:number, records:number, path?:string, reason?:string}}
 */
export function recordInjectionTrials({ storeRoot, claims = [], at = null } = {}) {
  if (typeof storeRoot !== 'string' || !storeRoot) return { appended: 0, skipped: 0, records: 0, reason: 'no-store' };
  if (!Number.isFinite(at)) return { appended: 0, skipped: 0, records: 0, reason: 'no-clock' };
  const list = (Array.isArray(claims) ? claims : []).filter((c) => c && c.kind === 'antipattern' && typeof c.id === 'string' && c.id);
  if (!list.length) return { appended: 0, skipped: 0, records: 0, reason: 'no-antipattern' };
  const { records } = readTrials(storeRoot);
  const lastByClaim = new Map();
  for (const row of records) {
    const prev = lastByClaim.get(row.claimId);
    if (!prev || Number(row.at) > prev) lastByClaim.set(row.claimId, Number(row.at));
  }
  const index = loadRecoveryIndexCached(storeRoot);
  const rows = [];
  for (const claim of list) {
    const fromTrials = lastByClaim.get(claim.id);
    // 注意：`Number(null) === 0` 是合法数字 —— 必须按「正数才是注入时间」判（0 / null / 缺失 = 从未注入）
    const rawInjectedAt = claim?.counters?.lastInjectedAt;
    const fromClaim = typeof rawInjectedAt === 'number' && Number.isFinite(rawInjectedAt) && rawInjectedAt > 0 ? rawInjectedAt : null;
    const since = Number.isFinite(fromTrials) ? fromTrials : fromClaim;
    if (!Number.isFinite(since) || Number(at) <= since) continue; // 首次注入 ⇒ 只开 trial
    const entry = index?.entries?.[claim.id] ?? null;
    const recovery = entry && Number.isFinite(entry.at)
      ? { kind: entry.kind, seq: entry.seq, at: entry.at, episode: typeof entry.episode === 'string' ? entry.episode : null }
      : null;
    const outcome = trialOutcomeOf({ claim, recovery, since, until: at });
    rows.push({
      claimId: claim.id,
      injectedAt: since,
      outcome: outcome.outcome,
      evidenceEpisode: outcome.evidenceEpisode,
      evidenceSeq: outcome.evidenceSeq,
      at: Number(at),
    });
  }
  return { ...appendTrials(storeRoot, rows), records: rows.length };
}

// ---------------------------------------------------------------------------
// shadow：只记录，不注入
// ---------------------------------------------------------------------------

/** shadow 目录的默认值（仓库内 evidence/shadow/，不是 <DSH_HOME>）。 */
export function defaultShadowDir() {
  return fileURLToPath(new URL(`../../${SHADOW_DIR_REL}/`, import.meta.url));
}

/**
 * 硬守卫：shadow 不得写进 `$DSH_HOME`（铁律：不写 <DSH_HOME>）。
 * 也不许写进 <DSH_HOME> 的 sessions / chess-context / memory-context（原件只读）。
 */
export function assertSafeShadowDir(dir, { dshHome = null } = {}) {
  const target = path.resolve(String(dir ?? ''));
  if (!dir || String(dir).trim() === '') {
    throw new InjectError('inject: writeShadow 需要 dir', 'inject/missing-dir');
  }
  const home = dshHome ?? process.env.DSH_HOME ?? null;
  if (!home) return target;
  const rel = path.relative(path.resolve(String(home)), target);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) {
    throw new InjectError(
      `inject: shadow 目录不得位于 $DSH_HOME 内（${target}）—— 影子模式只写仓库 evidence/shadow/`,
      'inject/shadow-in-dsh-home',
      { dir: target, dshHome: String(home) },
    );
  }
  return target;
}

/**
 * 追加一条 shadow 记录（JSONL）。**不注入**任何模型上下文，也不写 <DSH_HOME>。
 * @param {{dir?:string, card:object, signal?:object|null, at?:number|null, version?:number, dshHome?:string|null}} p
 */
export function writeShadow({ dir = null, card = null, signal = null, at = null, version = CARD_VERSION, dshHome = null } = {}) {
  if (!card || typeof card !== 'object') {
    throw new InjectError('inject: writeShadow 需要 card', 'inject/missing-card');
  }
  if (card.shadow !== true) {
    throw new InjectError('inject: writeShadow 只收 shadow 卡（card.shadow !== true 拒绝落记录）', 'inject/not-shadow');
  }
  const target = assertSafeShadowDir(dir ?? defaultShadowDir(), { dshHome });
  const when = Number.isFinite(at) ? at : Date.now();
  const record = {
    version: Number.isFinite(version) ? version : CARD_VERSION,
    mode: 'shadow',
    injected: false,
    at: when,
    atIso: new Date(when).toISOString(),
    signal: signal ?? null,
    card,
  };
  const file = path.join(target, SHADOW_FILE);
  fs.mkdirSync(target, { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  fs.appendFileSync(file, line, 'utf8');
  return { ok: true, path: file, dir: target, appended: 1, bytes: Buffer.byteLength(line, 'utf8') };
}

/** 读回 shadow 记录（坏尾不抛：崩溃截断的最后一行丢弃并计数）。 */
export function readShadow({ dir = null, limit = null } = {}) {
  const target = path.resolve(dir ?? defaultShadowDir());
  const file = path.join(target, SHADOW_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { records: [], parsed: 0, missing: true, path: file };
  }
  const records = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  const sliced = Number.isFinite(limit) && limit >= 0 ? records.slice(-limit) : records;
  return { records: sliced, parsed: records.length, badLines, missing: false, path: file };
}

// ---------------------------------------------------------------------------
// CLI：inject --shadow --signal "<文本>" [--store <dir>] [--json]
// ---------------------------------------------------------------------------

/** R11 walk 存在就用它（兼容 walkFromSignals / walk 两个导出名），缺失走降级。 */
async function loadWalkRoom() {
  try {
    const mod = await import('./walk.mjs');
    if (typeof mod?.walkFromSignals === 'function') return mod.walkFromSignals;
    if (typeof mod?.walk === 'function') return mod.walk;
    return null;
  } catch {
    return null;
  }
}

function formatInjectText({ card, gates, signal, walk, shadow }) {
  const lines = [];
  const gateOk = gates?.ok ? 'OK' : 'FAIL';
  // T3：只有真的出现指针行才多打这一段（没有指针行 ⇒ 输出与旧版逐字节一致）。
  const pointerCount = Number.isFinite(card.pointerCount) ? card.pointerCount : 0;
  const tierText = pointerCount > 0 ? ` · 交付 ${card.tier}（指针 ${pointerCount}/${card.claims.length}）` : '';
  lines.push(`inject · shadow=true（只记录，未注入模型上下文）· 命中 ${card.hitCount} · 渲染 ${card.claims.length} · tokens ${card.tokens}/${card.budgetTokens} · gates ${gateOk}${tierText}`);
  lines.push(`signal: kind=${signal.kind} · terms=${signal.terms.length} · entities=${signal.entities.length}${signal.terms.length ? ` · ${signal.terms.slice(0, 8).join(', ')}` : ''}`);
  const crossScope = Number.isFinite(card.crossScope) ? card.crossScope : 0;
  const crossScopeWalk = Number.isFinite(card.crossScopeWalk) ? card.crossScopeWalk : 0;
  const unknownScope = Number.isFinite(card.unknownScope) ? card.unknownScope : 0;
  const hitTotal = Number.isFinite(walk.hitCount) ? walk.hitCount : (walk.hits?.length ?? 0);
  const inScope = Array.isArray(walk.hits) ? walk.hits.length : 0;
  lines.push(`walk: ${walk.degraded ? '降级（R11 walk 未落地：词面命中 → 主题 → 棋局，深度 1）' : `R11 walk（深度 ${walk.depth ?? walk.maxDepth ?? '?'}）`} · 命中 ${hitTotal} · 同域 ${inScope}${(crossScope + crossScopeWalk) ? ` · 跨域已滤 ${crossScope + crossScopeWalk}` : ''}${unknownScope ? ` · 作用域未知 ${unknownScope}` : ''}`);
  lines.push('');
  lines.push(card.indexLine);
  if (card.section) {
    lines.push(card.section);
  } else {
    lines.push('（未命中：零展开；未列出 ≠ 不存在）');
  }
  lines.push('');
  if (shadow) lines.push(`shadow: ${shadow.path}（追加 ${shadow.appended} 行）`);
  else lines.push('shadow: 未写（加 --shadow 才落 evidence/shadow/）');
  if (gates?.ok) {
    const unver = Array.isArray(gates?.checks?.unverified) ? gates.checks.unverified : [];
    const unverText = unver.length ? ` · unverified ${unver.reduce((n, u) => n + (u.count ?? 0), 0)}（${[...new Set(unver.map((u) => `闸${u.gate}`))].join('/')}）` : '';
    lines.push(`gates: OK（10 道闸 + 边界：0 错${unverText}）`);
  } else {
    lines.push(`gates: FAIL（${gates?.errors?.length ?? 0} 错）`);
    for (const e of (gates?.errors ?? []).slice(0, 10)) lines.push(`  - [闸${e.gate}] ${e.code}: ${JSON.stringify(e.detail ?? null)}`);
  }
  return lines.join('\n');
}

/**
 * CLI 入口（由 src/rooms/cli.mjs 的 inject 分支调用；也可单测）。
 * @returns {Promise<{code:number, stdout:string, stderr:string, card?:object, gates?:object}>}
 */
export async function runInject({ flags = {}, positional = [], root = '' } = {}) {
  const storeRoot = path.resolve(String(flags.store ?? path.join(root || '.', 'memory-context')));
  if (!fs.existsSync(storeRoot)) {
    return { code: 2, stdout: '', stderr: `记忆库不存在：${storeRoot}（先跑 node scripts/archive.mjs --store <dir>）` };
  }

  const rawSignal = typeof flags.signal === 'string' && flags.signal !== '' ? flags.signal : (positional[0] ?? '');
  if (!String(rawSignal).trim()) {
    return { code: 2, stdout: '', stderr: '用法：inject --shadow --signal "<文本>" [--store <dir>] [--json]' };
  }

  const { createStore } = await import('./persist.mjs');
  // task-14：渲染入口在卡片房 —— 用 `await import` 取（本房不静态 import 它，保持依赖单向、无环）。
  const { buildMemoryCard, POINTER_TIER_DEFAULT } = await import('./inject-card.mjs');

  const store = createStore({ root: storeRoot, bundle: true }); // T62

  const at = Date.now();
  const signal = signalFromText(rawSignal, { at, kind: typeof flags.kind === 'string' ? flags.kind : 'root-message' });
  signal.scopeKey = scopeKeyFromPath(process.cwd());
  const scope = signal.scopeKey;

  let walk = null;
  let walkError = null;
  const walkFn = await loadWalkRoom();
  if (walkFn) {
    try {
      // `scope` 一起传：R11 支持按作用域过滤时直接用；不支持时被忽略，由下面的 R12 侧过滤兜底。
      walk = walkFn({ signal, store, scope, depth: 2, limit: ENTRY_LIMIT, budgetTokens: BUDGET_TOKENS }) ?? null;
    } catch (err) {
      walkError = String(err?.message ?? err);
      walk = null;
    }
  }
  if (!walk) walk = degradedWalk({ signal, store, limit: ENTRY_LIMIT });

  // R12 侧兜底：证明不了在本域可见的命中一律不注入（方案 §4.10 默认不可见；闸 1 同判据）。
  const hitCountRaw = Array.isArray(walk.hits) ? walk.hits.length : 0;
  const scoped = filterHitsByScope(walk.hits ?? [], scope);
  // R11 若已按作用域过滤（它自己记在 dropped/omitted 里），R12 侧过滤就是兜底（通常为 0）；
  // 两边计数不重叠：walk 拒掉的根本没进 hits，所以不会和 scoped.dropped 重复。
  const walkDropped = walk?.dropped && typeof walk.dropped === 'object' ? walk.dropped : {};
  const walkCross = (Number.isFinite(walkDropped.crossScope) ? walkDropped.crossScope : 0)
    + (Number.isFinite(walkDropped.scopeMissing) ? walkDropped.scopeMissing : 0);

  // 之后一律用过滤后的 walk：hitCount 记过滤前的全量，hits 记真正会进卡的。
  walk = {
    ...walk,
    hitCount: hitCountRaw,
    hits: scoped.hits,
    crossScope: scoped.dropped,
    unknownScope: scoped.droppedUnknown,
    crossScopeWalk: walkCross,
  };

  const card = buildMemoryCard({
    signal,
    walkResult: walk,
    store,
    scope,
    now: at,
    droppedCrossScope: scoped.dropped,
    droppedUnknownScope: scoped.droppedUnknown,
    walkCrossScope: walkCross,
    // T3：`--pointer-tier` 打开三级交付的第二级（**生产默认已开**，见 `POINTER_TIER_DEFAULT`）；
    // `--no-pointer-tier` 显式回到两级 —— 它同时是 A/B 对照的入口：同一批输入跑两遍，
    // 比 `card.tokens` 与 `card.section` 的差。
    pointerTier: flags['no-pointer-tier'] === true ? false : POINTER_TIER_DEFAULT,
  });
  // store + scope 一起传：闸 1/2/3/4/5/7 才能真的核（否则只是 unverified）。
  const { runGates } = await import('./gates.mjs');
  const gates = runGates({ card, walkResult: walk, store, scope });

  let shadow = null;
  let shadowError = null;
  if (flags.shadow) {
    try {
      const dir = typeof flags['shadow-dir'] === 'string' && flags['shadow-dir']
        ? flags['shadow-dir']
        : defaultShadowDir();
      shadow = writeShadow({ dir, card, signal, at });
    } catch (err) {
      shadowError = String(err?.message ?? err);
    }
  }

  if (flags.json) {
    return {
      code: gates.ok && !shadowError ? 0 : 1,
      stdout: JSON.stringify({
        ok: gates.ok && !shadowError,
        scope: signal.scopeKey,
        signal,
        walk: {
          hits: walk.hits?.length ?? 0,
          hitTotal: Number.isFinite(walk.hitCount) ? walk.hitCount : (walk.hits?.length ?? 0),
          crossScope: Number.isFinite(walk.crossScope) ? walk.crossScope : 0,
          unknownScope: Number.isFinite(walk.unknownScope) ? walk.unknownScope : 0,
          crossScopeWalk: Number.isFinite(walk.crossScopeWalk) ? walk.crossScopeWalk : 0,
          depth: walk.depth ?? walk.maxDepth ?? null,
          degraded: Boolean(walk.degraded),
          error: walkError,
        },
        card,
        gates,
        shadow,
        shadowError,
      }, null, 2),
      stderr: shadowError ? `shadow 写入失败：${shadowError}` : '',
      card,
      gates,
    };
  }

  return {
    code: gates.ok && !shadowError ? 0 : 1,
    stdout: formatInjectText({ card, gates, signal, walk, shadow }),
    stderr: shadowError ? `shadow 写入失败：${shadowError}` : '',
    card,
    gates,
  };
}
