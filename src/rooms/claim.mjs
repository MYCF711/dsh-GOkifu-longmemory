// R09 claim —— 参考层：事实 / 反模式 / 偏好（带 evidence / validity / preconditions）
//
// ── 契约（AGENTS §4.8 / §11 R09、docs/数据契约.md §4、方案 §4.8、§5.1、§5.3、§4.10）──
// 职责：把 R03 抽出的机械证据（失败边 / 用户约束句 / 动作里字面写着的版本与路径）
//       归并成**带逐字引文的主张**，并只给到 M2 的两档状态：observed / candidate。
// 入口：promoteClaim({episodes, signals, now, options}) → {claims, stats}
// 输入：
//   episodes = [{ id:"ep-…", sessionId, parentSessionId|null, scopeKey, startedAt|occurredAt,
//                 signals? }]
//   signals  = 按棋谱 id 的 R03.extractSignals 输出（Map | {epId: 信号} | [{episode,…}] |
//              [{episode, signals}] | 单条信号）；另接受可选的 `signals.facts`
//              （每条 {seq, quote, text?, validity:{type,value}, nodeId?, edgeId?, occurredAt?}，
//               由上游机械产出物填，本模块只做校验与归并，**不凭空生成**）
// 每条 claim：
//   { id:"c-<hash8>", kind, text, scopeKey, threadIds:[],
//     state:"observed"|"candidate",
//     support:[{episode, threadId:null, nodeId, edgeId, seq, quote}], counter:[…],
//     validity:{type:"none"|"file"|"commit"|"version", value},
//     preconditions:[{check, value, why}],
//     occurredAt, recordedAt, validFrom:null, validTo:null,
//     counters:{support, counter, injections:0, lastInjectedAt:null},
//     supersedes:null, level? }
// 三类机械来源：
//   ① 失败边 → kind="antipattern"：按**归一后的错误原文**归并（路径 → `<path>`），
//      text 取最早支撑局那条错误原文（逐字，≤200 字）。动作侧证据通过 support.edgeId 回指棋谱边。
//   ② 用户约束句 → kind="preference"：text = 用户原话（逐字，R03 已切句），保留 level(hard|soft)。
//   ③ 事实 → kind="fact"：
//      a) 失败边里带 ENOENT / "No such file or directory" 且能取出路径 ⇒ validity{type:"file", value:path}
//         （「证据时刻该文件不存在」；读侧 stat 到文件出现即判 stale —— 方案 §5.3）
//      b) 动作原文里**字面写着**版本（`name@x.y.z` 或 `version=x.y.z`）⇒ validity{type:"version", value}
//      c) signals.facts 里上游给的条目（逐条校验后并入）
// 状态（只两档，M2 不产生 semantic/disputed/invalidated/stale）：
//   candidate ⇔ 支撑来自 ≥2 局**独立**棋谱（不同 sessionId 且非父子）且 counter 为空；否则 observed。
// 作用域（方案 §4.10，纯机械）：
//   同一 text 在**≥2 个不同工作区**被独立印证 ⇒ scopeKey = "u:<user>"（用户层）；否则留在 w: 层。
// 反例（方案 §5.2「反例优先」）：
//   文件类事实若在**更晚时间**有成功边触到同一路径（文件已存在）⇒ 记 counter；有 counter 不升 candidate。
//   只用可机械核的事实产生 counter，不做语义矛盾判断。
// 不变量：
//   - 无 quote 不产出；无 seq 不产出；无 occurredAt 不产出（缺时间 = 假记忆）。
//   - 计数不是打分：counters 只记可数事实，**不参与排序/晋升**，本模块也不产出任何分数。
//   - 纯函数：同一输入两次同结果；recordedAt 只取入参 now（缺省 null，绝不拿 Date.now() 冒充）。
// 错误语义：入参不是对象 ⇒ throw ClaimError('claim/input')；未知 validity.type ⇒ 该条被丢弃并计数。
// 允许依赖：R00（episode 形状）+ node: 内置模块。禁止依赖：模型调用、上游包、R03/R04/R05/R08 的直接导出。

import { createHash } from 'node:crypto';

export class ClaimError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ClaimError';
    this.code = code;
  }
}

export const CLAIM_KINDS = Object.freeze(['fact', 'rule', 'antipattern', 'preference', 'pattern']);
export const VALIDITY_TYPES = Object.freeze(['none', 'file', 'commit', 'version']);
export const PRECONDITION_CHECKS = Object.freeze(['file-exists', 'cmd', 'tool', 'scope', 'step-range']);

export const DEFAULT_CLAIM_OPTIONS = Object.freeze({
  minSupport: 2,        // 升 candidate 的独立支撑局数下限（方案 §5.1 晋升阶梯）
  user: 'owner',        // 用户层 id（方案 §4.10；不用机器名/哈希）
  maxQuote: 200,        // 每条 quote / text 的上限（码点）
  crossScopePromotion: true, // 跨 ≥2 工作区独立印证 ⇒ 升 u: 层
});

function hash8(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 8);
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/** 错误标记（与 R04 同口径：只认「这行是错误」的机械形态）。 */
const ERROR_MARKER_RE = /(?:[A-Z][A-Za-z]*)?Error\b\s*:|ENOENT|EACCES|EPERM|EEXIST|ECONNREFUSED|ETIMEDOUT|ERR_[A-Z0-9_]+|\[exit code: \d+\]|\bexit code \d+\b|Cannot find module|No such file or directory/;

/** 取「错误行」原文（逐字，未归一）；取不到则返回首行。 */
export function errorLineOf(text) {
  const lines = stripAnsi(text).replace(/\\n/g, '\n').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 12)) if (ERROR_MARKER_RE.test(line)) return line;
  return lines[0] ?? '';
}

/**
 * 错误原文归一（**只用于归并键**，不改写证据）：
 * 去 ANSI、取错误行、引号内绝对路径与裸盘符路径 → `<path>`、压空白、截 200。
 */
export function errorKeyOf(text, maxLen = 200) {
  let s = errorLineOf(text);
  if (!s) return '';
  s = s
    .replace(/"(?:[A-Za-z]:[\\/]|\/)[^"]*"/g, '"<path>"')
    .replace(/(?:[A-Za-z]:[\\/])[^\s"',;)]*/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(s, maxLen);
}

// 合成失败标记：只说「命令失败」，不说明「错在哪」，也不构成可复用反模式
// （与 R05 对 same-error 的处理同口径：「exit code 1」这类标记不建同错边）。
const GENERIC_ERROR_KEY_RE = /^(?:\(no output\)\s*)?\[?exit code:? \d+\]?$/i;

/** 只有合成失败标记、没有错误内容的失败不构成 antipattern。 */
export function isGenericErrorText(text) {
  return GENERIC_ERROR_KEY_RE.test(String(text ?? '').trim());
}

/** 文本里的绝对路径（引号包裹优先，允许空格；其次裸 token）。 */
export function extractPaths(text) {
  const out = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(/["'`]((?:[A-Za-z]:[\\/]|\/)[^"'`]{2,240})["'`]/g)) out.push(m[1]);
  for (const m of s.matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\s"',;:)]+/g)) out.push(m[0]);
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`)
    .replace(/[.,;:]+$/, '').replace(/\/{2,}/g, '/');
  return [...new Set(out.map(norm).filter((p) => p.length >= 3))];
}

/** 版本字面量（只认**原文写着**的版本，不做推断）。 */
export function extractVersionLiterals(text) {
  const out = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(/\b((?:@[A-Za-z0-9_.-]+\/)?[A-Za-z][A-Za-z0-9_.-]{1,60})@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)\b/g)) {
    out.push({ name: m[1], version: m[2], text: `${m[1]}@${m[2]}`, value: `${m[1]}@${m[2]}` });
  }
  for (const m of s.matchAll(/\bversion\s*[=:]\s*["']?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/gi)) {
    out.push({ name: null, version: m[1], text: m[0].replace(/\s+/g, ' ').trim(), value: m[1] });
  }
  const seen = new Set();
  return out.filter((v) => (seen.has(v.text) ? false : seen.add(v.text)));
}

/** 棋谱的事件时间（occurredAt 一侧）。 */
function episodeAt(ep) {
  for (const key of ['occurredAt', 'startedAt', 'firstEventAt']) {
    if (Number.isFinite(ep?.[key])) return ep[key];
  }
  return null;
}

function sessionOf(ep) {
  return typeof ep?.sessionId === 'string' && ep.sessionId ? ep.sessionId : ep.id;
}

/** 两局独立（方案 §5.1a 前两条）：不同 sessionId 且非父子。 */
export function isIndependentEpisode(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const sa = sessionOf(a);
  const sb = sessionOf(b);
  if (sa === sb) return false;
  if (a.parentSessionId && a.parentSessionId === sb) return false;
  if (b.parentSessionId && b.parentSessionId === sa) return false;
  return true;
}

export function hasIndependentPair(list) {
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (isIndependentEpisode(list[i], list[j])) return true;
    }
  }
  return false;
}

/** 信号归一：接受 Map / {epId: 信号} / [{episode,…}] / [{episode, signals}] / 单条信号。 */
function normalizeSignals(signals, episodes) {
  const out = new Map();
  if (!signals) {
    for (const ep of episodes) if (ep?.signals && ep.id) out.set(ep.id, ep.signals);
    return out;
  }
  if (signals instanceof Map) {
    for (const [id, sig] of signals) if (sig) out.set(id, sig);
    return out;
  }
  if (Array.isArray(signals)) {
    for (const item of signals) {
      if (!item || typeof item !== 'object') continue;
      const id = item.episode?.id ?? item.episode ?? item.episodeId ?? item.id ?? null;
      const sig = item.signals ?? item;
      if (typeof id === 'string' && sig) out.set(id, sig);
    }
    return out;
  }
  if (typeof signals === 'object') {
    const looksLikeOne = Array.isArray(signals.successes) || Array.isArray(signals.failures) || Array.isArray(signals.constraints);
    if (looksLikeOne) {
      if (episodes.length === 1 && episodes[0].id) out.set(episodes[0].id, signals);
      return out;
    }
    for (const [id, sig] of Object.entries(signals)) if (sig && typeof sig === 'object') out.set(id, sig);
  }
  return out;
}

function supportEntry({ episode, nodeId, edgeId, seq, quote, occurredAt = null }) {
  return {
    episode,
    threadId: null,
    nodeId: nodeId ?? null,
    edgeId: edgeId ?? null,
    seq,
    quote,
    // occurredAt 是硬字段（方案 §4.9 双时钟）；契约 §4.8 允许新增字段。
    occurredAt: Number.isFinite(occurredAt) ? occurredAt : null,
  };
}

function supportKeyOf(s) {
  return `${s.episode}\u0000${s.seq}\u0000${s.edgeId ?? ''}\u0000${s.quote}`;
}

/**
 * 提炼 claim（事实 / 反模式 / 偏好）。
 * @param {{episodes?:Array, signals?:any, now?:number|null, options?:object}} input
 * @returns {{claims:Array, stats:object}}
 */
export function promoteClaim({ episodes = [], signals = null, now = null, options = {} } = {}) {
  if (episodes === null || typeof episodes !== 'object') {
    throw new ClaimError('claim: input must be an object {episodes, signals}', 'claim/input');
  }
  const opts = { ...DEFAULT_CLAIM_OPTIONS, ...options };
  const minSupport = Math.max(2, Number.isFinite(opts.minSupport) ? opts.minSupport : 2);
  const userScope = `u:${String(opts.user ?? 'owner') || 'owner'}`;

  const eps = (Array.isArray(episodes) ? episodes : [])
    .filter((e) => e && typeof e.id === 'string' && e.id !== '')
    .map((e) => ({ ...e, scopeKey: typeof e.scopeKey === 'string' && e.scopeKey ? e.scopeKey : 'w:unknown', at: episodeAt(e) }));
  const byId = new Map(eps.map((e) => [e.id, e]));
  const sigs = normalizeSignals(signals, eps);
  const dropped = { noQuote: 0, noSeq: 0, noTime: 0, noPath: 0, badValidity: 0, empty: 0, generic: 0 };

  // 原始分组：kind + 归并键 + scopeKey → 累积
  const groups = new Map();
  const ensure = (kind, key, scopeKey, seed) => {
    const gid = `${kind}\u0000${key}\u0000${scopeKey}`;
    let g = groups.get(gid);
    if (!g) {
      g = { kind, key, scopeKey, ...seed, supports: [], counters: [], episodes: new Set() };
      groups.set(gid, g);
    }
    return g;
  };
  const addSupport = (g, ep, entry) => {
    const s = supportEntry(entry);
    if (!g.supports.some((x) => supportKeyOf(x) === supportKeyOf(s))) g.supports.push(s);
    g.episodes.add(ep.id);
  };

  // ---- 1. 失败边 → antipattern（按归一错误原文归并）----
  for (const ep of eps) {
    const sig = sigs.get(ep.id);
    if (!sig) continue;
    for (const f of Array.isArray(sig.failures) ? sig.failures : []) {
      if (!f) continue;
      const rawQuote = String(f.quote ?? '').trim();
      if (!rawQuote) { dropped.noQuote += 1; continue; }
      if (!Number.isFinite(f.seq)) { dropped.noSeq += 1; continue; }
      const key = errorKeyOf(rawQuote);
      if (!key) { dropped.empty += 1; continue; }
      if (isGenericErrorText(key)) { dropped.generic += 1; continue; }
      const at = Number.isFinite(f.occurredAt) ? f.occurredAt : ep.at;
      if (!Number.isFinite(at)) { dropped.noTime += 1; continue; }
      const g = ensure('antipattern', key, ep.scopeKey, {
        representativeText: clip(errorLineOf(rawQuote), opts.maxQuote),
        representativeAt: at,
        validity: { type: 'none', value: null },
        preconditions: [],
      });
      if (at < g.representativeAt) {
        g.representativeAt = at;
        g.representativeText = clip(errorLineOf(rawQuote), opts.maxQuote);
      }
      addSupport(g, ep, { episode: ep.id, nodeId: f.nodeId, edgeId: f.edgeId, seq: f.seq, quote: clip(rawQuote, opts.maxQuote), occurredAt: at });
    }
  }

  // ---- 2. 用户约束句 → preference（逐字）----
  for (const ep of eps) {
    const sig = sigs.get(ep.id);
    if (!sig) continue;
    for (const c of Array.isArray(sig.constraints) ? sig.constraints : []) {
      if (!c) continue;
      const rawQuote = String(c.quote ?? '').trim();
      if (!rawQuote) { dropped.noQuote += 1; continue; }
      if (!Number.isFinite(c.seq)) { dropped.noSeq += 1; continue; }
      const at = Number.isFinite(c.occurredAt) ? c.occurredAt : ep.at;
      if (!Number.isFinite(at)) { dropped.noTime += 1; continue; }
      const g = ensure('preference', rawQuote.replace(/\s+/g, ' '), ep.scopeKey, {
        representativeText: clip(rawQuote, opts.maxQuote),
        representativeAt: at,
        validity: { type: 'none', value: null },
        preconditions: [],
        level: c.level ?? null,
      });
      if (at < g.representativeAt) {
        g.representativeAt = at;
        g.representativeText = clip(rawQuote, opts.maxQuote);
      }
      if (g.level === null && c.level) g.level = c.level;
      addSupport(g, ep, { episode: ep.id, nodeId: c.nodeId, edgeId: c.edgeId, seq: c.seq, quote: clip(rawQuote, opts.maxQuote), occurredAt: at });
    }
  }

  // ---- 3a. 文件事实：ENOENT 类失败 + 可提取路径 ----
  const fileFacts = [];
  for (const ep of eps) {
    const sig = sigs.get(ep.id);
    if (!sig) continue;
    for (const f of Array.isArray(sig.failures) ? sig.failures : []) {
      if (!f) continue;
      const rawQuote = String(f.quote ?? '').trim();
      if (!rawQuote || !Number.isFinite(f.seq)) continue;
      // 只从**那一行** ENOENT 原文里取路径与 text：错误片段可能多行，别把别的行的路径当成本条证据
      const errLine = stripAnsi(rawQuote).replace(/\n/g, '\n').split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /ENOENT|No such file or directory/i.test(l)) ?? '';
      if (!errLine) continue;
      const paths = extractPaths(errLine);
      if (!paths.length) { dropped.noPath += 1; continue; }
      const at = Number.isFinite(f.occurredAt) ? f.occurredAt : ep.at;
      if (!Number.isFinite(at)) { dropped.noTime += 1; continue; }
      const path = paths[0];
      const g = ensure('fact', `file\u0000${path}`, ep.scopeKey, {
        representativeText: clip(errorLineOf(rawQuote), opts.maxQuote),
        representativeAt: at,
        validity: { type: 'file', value: path },
        preconditions: [{
          check: 'file-exists',
          value: path,
          why: '该条记录的是证据时刻「此路径不存在」；该路径出现即不再成立（方案 §5.3）',
        }],
      });
      if (at < g.representativeAt) {
        g.representativeAt = at;
        g.representativeText = clip(errLine, opts.maxQuote);
      }
      addSupport(g, ep, { episode: ep.id, nodeId: f.nodeId, edgeId: f.edgeId, seq: f.seq, quote: clip(errLine, opts.maxQuote), occurredAt: at });
      fileFacts.push({ g, path, episode: ep.id });
    }
  }

  // ---- 3b. 版本事实：动作原文里字面写着版本 ----
  for (const ep of eps) {
    const sig = sigs.get(ep.id);
    if (!sig) continue;
    const buckets = [
      ...(Array.isArray(sig.successes) ? sig.successes : []),
      ...(Array.isArray(sig.unsettled) ? sig.unsettled : []),
      ...(Array.isArray(sig.failures) ? sig.failures : []),
    ];
    for (const e of buckets) {
      if (!e) continue;
      const rawQuote = String(e.quote ?? '').trim();
      if (!rawQuote || !Number.isFinite(e.seq)) continue;
      for (const v of extractVersionLiterals(rawQuote)) {
        const at = Number.isFinite(e.occurredAt) ? e.occurredAt : ep.at;
        if (!Number.isFinite(at)) { dropped.noTime += 1; continue; }
        const g = ensure('fact', `version\u0000${v.value}`, ep.scopeKey, {
          representativeText: clip(v.text, opts.maxQuote),
          representativeAt: at,
          validity: { type: 'version', value: v.value },
          preconditions: [{
            check: 'scope',
            value: ep.scopeKey,
            why: '版本字面量只在它被反引用的那次运行里可核（w: 层）',
          }],
        });
        if (at < g.representativeAt) {
          g.representativeAt = at;
          g.representativeText = clip(v.text, opts.maxQuote);
        }
        addSupport(g, ep, { episode: ep.id, nodeId: e.nodeId, edgeId: e.edgeId, seq: e.seq, quote: clip(v.text, opts.maxQuote), occurredAt: at });
      }
    }
  }

  // ---- 3c. 上游机械产出的 facts（只校验，不生成）----
  for (const ep of eps) {
    const sig = sigs.get(ep.id);
    if (!sig || !Array.isArray(sig.facts)) continue;
    for (const fact of sig.facts) {
      if (!fact || typeof fact !== 'object') continue;
      const rawQuote = String(fact.quote ?? '').trim();
      if (!rawQuote) { dropped.noQuote += 1; continue; }
      if (!Number.isFinite(fact.seq)) { dropped.noSeq += 1; continue; }
      const type = fact.validity?.type;
      if (!VALIDITY_TYPES.includes(type)) { dropped.badValidity += 1; continue; }
      const at = Number.isFinite(fact.occurredAt) ? fact.occurredAt : ep.at;
      if (!Number.isFinite(at)) { dropped.noTime += 1; continue; }
      const text = clip(String(fact.text ?? errorLineOf(rawQuote)), opts.maxQuote);
      const g = ensure('fact', `given\u0000${text}`, ep.scopeKey, {
        representativeText: text,
        representativeAt: at,
        validity: { type, value: fact.validity?.value ?? null },
        preconditions: Array.isArray(fact.preconditions)
          ? fact.preconditions.filter((p) => p && PRECONDITION_CHECKS.includes(p.check))
          : [],
      });
      if (at < g.representativeAt) {
        g.representativeAt = at;
        g.representativeText = text;
      }
      addSupport(g, ep, { episode: ep.id, nodeId: fact.nodeId, edgeId: fact.edgeId, seq: fact.seq, quote: clip(rawQuote, opts.maxQuote), occurredAt: at });
    }
  }

  // ---- 4. 文件事实的反例：更晚的成功边触到同一路径 ⇒ 文件已出现 ----
  for (const { g, path } of fileFacts) {
    const factAt = g.representativeAt;
    for (const ep of eps) {
      const sig = sigs.get(ep.id);
      if (!sig) continue;
      for (const e of Array.isArray(sig.successes) ? sig.successes : []) {
        if (!e || !Number.isFinite(e.seq)) continue;
        const rawQuote = String(e.quote ?? '').trim();
        if (!rawQuote) continue;
        if (!extractPaths(rawQuote).includes(path)) continue;
        const at = Number.isFinite(e.occurredAt) ? e.occurredAt : ep.at;
        if (!Number.isFinite(at) || at <= factAt) continue;
        const entry = supportEntry({ episode: ep.id, nodeId: e.nodeId, edgeId: e.edgeId, seq: e.seq, quote: clip(rawQuote, opts.maxQuote), occurredAt: at });
        if (!g.counters.some((x) => supportKeyOf(x) === supportKeyOf(entry))) g.counters.push(entry);
      }
    }
  }

  // ---- 5. 跨工作区印证 ⇒ 升 u: 层；否则按 w: 层各自成条 ----
  const byKindKey = new Map();
  for (const g of groups.values()) {
    const id = `${g.kind}\u0000${g.key}`;
    if (!byKindKey.has(id)) byKindKey.set(id, []);
    byKindKey.get(id).push(g);
  }

  const merged = [];
  for (const list of byKindKey.values()) {
    // 排序后再合并：决定 representative 与 id 的是 scopeKey 字典序，不受入参顺序影响
    list.sort((a, b) => (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0));
    const scopes = new Set(list.map((g) => g.scopeKey));
    const allEpisodes = [...new Map(list.flatMap((g) => [...g.episodes]).map((id) => [id, byId.get(id)])).values()].filter(Boolean);
    if (opts.crossScopePromotion && scopes.size >= 2 && hasIndependentPair(allEpisodes)) {
      const first = list[0];
      merged.push({
        kind: first.kind,
        key: first.key,
        scopeKey: userScope,
        representativeText: first.representativeText,
        representativeAt: Math.min(...list.map((g) => g.representativeAt)),
        validity: first.validity,
        preconditions: [
          ...first.preconditions,
          { check: 'scope', value: userScope, why: '跨 ≥2 个不同工作区被独立印证后才升到用户层（方案 §4.10）' },
        ],
        level: first.level ?? null,
        supports: list.flatMap((g) => g.supports),
        counters: list.flatMap((g) => g.counters),
        episodes: new Set(list.flatMap((g) => [...g.episodes])),
      });
    } else {
      for (const g of list) merged.push(g);
    }
  }

  // ---- 6. 定案：状态 / 排序 / 计数 ----
  const claims = [];
  for (const g of merged) {
    const supportEpisodes = [...new Set(g.supports.map((s) => s.episode))]
      .map((id) => byId.get(id))
      .filter(Boolean);
    // 独立：支撑局里存在一对独立（不同 sessionId、非父子）；计数按**棋盘**数，不按边数。
    const independent = hasIndependentPair(supportEpisodes);
    const counters = g.counters;
    const isCandidate = independent && supportEpisodes.length >= minSupport && counters.length === 0;
    const times = g.supports.map((s) => s.occurredAt).filter((t) => Number.isFinite(t));
    // support 里的 occurredAt 由 sig 提供；缺省时用棋谱时间兜底
    const fallbackTimes = supportEpisodes.map((e) => e.at).filter((t) => Number.isFinite(t));
    const occurredAt = times.length ? Math.min(...times) : (fallbackTimes.length ? Math.min(...fallbackTimes) : g.representativeAt);

    const preconditions = g.preconditions.length
      ? g.preconditions
      : [{ check: 'scope', value: g.scopeKey, why: '证据只覆盖该作用域（w: 层不自动上升，方案 §4.10）' }];

    const claim = {
      id: `c-${hash8(`${g.kind}\u0000${g.key}\u0000${g.scopeKey}`)}`,
      kind: g.kind,
      text: g.representativeText,
      scopeKey: g.scopeKey,
      threadIds: [],
      state: isCandidate ? 'candidate' : 'observed',
      // 排序按 (棋谱, seq)：seq 只在单局内单调，跨局比 seq 没有意义（方案 §4.9）
      support: [...g.supports].sort((a, b) => (a.episode < b.episode ? -1 : a.episode > b.episode ? 1 : 0) || (a.seq - b.seq)),
      counter: [...counters].sort((a, b) => (a.episode < b.episode ? -1 : a.episode > b.episode ? 1 : 0) || (a.seq - b.seq)),
      validity: g.validity,
      preconditions,
      occurredAt,
      recordedAt: Number.isFinite(now) ? now : null,
      validFrom: null,
      validTo: null,
      counters: {
        support: supportEpisodes.length,
        counter: counters.length,
        injections: 0,
        lastInjectedAt: null,
      },
      supersedes: null,
    };
    if (g.kind === 'preference' && g.level) claim.level = g.level;
    claims.push(claim);
  }

  claims.sort((a, b) => (CLAIM_KINDS.indexOf(a.kind) - CLAIM_KINDS.indexOf(b.kind))
    || (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0)
    || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)
    || (a.id < b.id ? -1 : 1));

  const byKind = {};
  const byState = { observed: 0, candidate: 0 };
  for (const c of claims) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    byState[c.state] = (byState[c.state] ?? 0) + 1;
  }
  const stats = {
    episodes: eps.length,
    claims: claims.length,
    byKind,
    byState,
    withCounter: claims.filter((c) => c.counter.length > 0).length,
    promotedToUser: claims.filter((c) => c.scopeKey === userScope).length,
    dropped,
  };

  return { claims, stats };
}

export default { promoteClaim, errorKeyOf, errorLineOf, isGenericErrorText, extractPaths, extractVersionLiterals, isIndependentEpisode, hasIndependentPair, DEFAULT_CLAIM_OPTIONS };
