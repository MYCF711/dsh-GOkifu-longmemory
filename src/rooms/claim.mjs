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

import os from 'node:os';

import path from 'node:path';



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

// D2（2026-11-02）：同类协议错误合并成一条 antipattern。

// 只合并「环境/协议」类，不合并代码语法或模块缺失（那些要保留具体原文）。

const ERROR_CLASSES = [

  ['fs-read-before-write', /file has not been read|file changed since it was read|file no longer exists/i],

  ['tool-unavailable', /unknown tool|tool .* not found|unknown command/i],

  ['policy-human-turn', /requires a direct human turn/i],

  ['sandbox-limit', /team member limit|tool call aborted|timed out after/i],

  ['web-search-empty', /web_search_tool_result blocks/i],
  ['module-missing', /cannot find module|err_module_not_found/i],
  ['permission-denied', /EACCES|EPERM|permission denied/i],
  ['timeout', /timed out|timeout|ETIMEDOUT/i],

];

/**
 * T38 · 扩类（**来自真库实际分布**，每类都有机械判据；排在原 8 类**之后**，不改旧类行为）：
 *
 * | 类 | 判据（正则） | 真库命中 |
 * |---|---|---|
 * | agent-not-found    | `active teammate … not found` / `task space not found` | 154 |
 * | file-not-found     | `ENOENT` / `FileNotFoundError` / `no such file or directory` | 124 |
 * | syntax-error       | `SyntaxError` / `syntax error`（含 bash `-c`） | 120 |
 * | search-io-error    | `grep/glob search failed … io error` | 39 |
 * | network            | `failed to connect` / `unable to access` / `ECONNREFUSED` / `ENOTFOUND` / 非公网 IP | 18 |
 * | type-error         | `TypeError` | 41 |
 * | arg-out-of-range   | `offset N is out of range` | 9 |
 * | git-not-repo       | `not a git repository` | 14 |
 * | path-not-directory | `not a directory` | 8 |
 * | regex-error        | `regex parse error` / `PatternError` / `unterminated character set` | 11 |
 * | python-exception   | `AttributeError` / `KeyError` / `UnicodeEncodeError` / `IndexError` / `ValueError` | 29 |
 *
 * 纪律：**只加机械判据**（正则/关键词），不"看着像"；命中数由 `tmp/t38-dist.mjs` 在真库上复核。
 *
 * **默认关闭**（`extended` 默认 `false`）：扩类只服务**洞见层标注**（T37 的 `recoveryInsightClass` 显式
 * 传 `{extended:true}`），**不参与 claim 合并** —— `errorKeyOf` / `ensureClassClaims` / 插件的
 * `errorClassKeyOf` 仍只认原 8 类「环境/协议」类（D2 的「代码语法/模块缺失保留具体原文」契约不变）。
 * 需要扩类时显式开；关掉时行为与原 8 类**逐字节一致**（tombstone）。
 */
const ERROR_CLASSES_EXTENDED = [
  ['agent-not-found', /active teammate [^\n]* not found|task space not found/i],
  ['file-not-found', /enoent|filenotfounderror|no such file or directory/i],
  ['syntax-error', /\bsyntaxerror\b|syntax error/i],
  ['search-io-error', /(?:grep|glob) search failed[^\n]*io error|io error for operation/i],
  ['network', /failed to connect|unable to access|could not resolve host|non-public ip address|ECONNREFUSED|ENOTFOUND|socket hang up/i],
  ['type-error', /\btypeerror\b/i],
  ['arg-out-of-range', /out of range for "|offset \d+ is out of range/i],
  ['git-not-repo', /not a git repository/i],
  ['path-not-directory', /not a directory/i],
  ['regex-error', /regex parse error|patternerror|unterminated character set|invalid regular expression/i],
  ['python-exception', /\b(?:AttributeError|KeyError|UnicodeEncodeError|IndexError|ValueError)\b/],
];




/** 已知的「环境/协议」错误类；返回 null 表示保持原签名（不合并）。 */

export function classifyErrorClass(text, { extended = false } = {}) {

  const s = String(text ?? '');

  for (const [name, re] of ERROR_CLASSES) if (re.test(s)) return name;

  // T38：扩类（关掉 ⇒ 与原 8 类逐字节一致）
  if (!extended) return null;

  for (const [name, re] of ERROR_CLASSES_EXTENDED) if (re.test(s)) return name;

  return null;

}

/** T38：坑类名单（原 8 类 + 扩类；单一来源，供文档/测试引用）。 */
export const ERROR_CLASS_NAMES = Object.freeze([
  ...ERROR_CLASSES.map(([name]) => name),
  ...ERROR_CLASSES_EXTENDED.map(([name]) => name),
]);



export function errorKeyOf(text, maxLen = 200) {

  let s = errorLineOf(text);

  if (!s) return '';

  s = s

    .replace(/"(?:[A-Za-z]:[\\/]|\/)[^"]*"/g, '"<path>"')

    .replace(/(?:[A-Za-z]:[\\/])[^\s"',;)]*/g, '<path>')

    .replace(/\s+/g, ' ')

    .trim();

  const cls = classifyErrorClass(s);

  if (cls) return `class:${cls}`;

  return clip(s, maxLen);

}



// 合成失败标记：只说「命令失败」，不说明「错在哪」，也不构成可复用反模式

// （与 R05 对 same-error 的处理同口径：「exit code 1」这类标记不建同错边）。

const GENERIC_ERROR_KEY_RE = /^(?:\(no output\)\s*)?\[?exit code:? \d+\]?$/i;



/** 只有合成失败标记、没有错误内容的失败不构成 antipattern。 */

export function isGenericErrorText(text) {

  return GENERIC_ERROR_KEY_RE.test(String(text ?? '').trim());

}



/** 路径的"方言"（T159）。只描述**证据原文里怎么写**，不猜用户意图。 */
export const PATH_FLAVORS = Object.freeze(['windows', 'unc', 'msys-drive', 'msys-tmp', 'posix', 'relative']);

/**
 * 分类一条证据路径的写法。
 * - `windows`：`C:\x` / `c:/x`
 * - `unc`：`\\host\share\x`
 * - `msys-drive`：Git Bash 的盘符挂载 `/c/x`、`/d/x`（可无损还原）
 * - `msys-tmp`：Git Bash 的 `/tmp/x`（还原到本机临时目录）
 * - `posix`：其他 POSIX 绝对路径（`/主工作区/x`、`/大小`）——**无法还原**，只能标记
 * - `relative`：相对路径
 */
export function classifyPathFlavor(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return 'relative';
  if (/^[A-Za-z]:[\\/]/.test(s)) return 'windows';
  if (/^\\\\/.test(s)) return 'unc';
  if (/^\/[A-Za-z](\/|$)/.test(s)) return 'msys-drive';
  if (/^\/tmp(\/|$)/.test(s)) return 'msys-tmp';
  if (s.startsWith('/')) return 'posix';
  return 'relative';
}

function slash(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

/**
 * 写侧路径归一（T159），**只影响新写入**：
 * - `msys-drive`：`/d/x` → `d:/x`（与 `extractPaths` 的既有归一一致）
 * - `msys-tmp`：`/tmp/x` → `<TEMP>/x`（Git Bash 的 `/tmp` 就是本机临时目录，不是盘根）
 * - `windows`/`unc`：只统一分隔符与盘符大小写
 * - `posix`：**原值保留** + `pathFlavor:'posix'`（读侧据此判"无法核验"，而不是解析到盘根）
 * - `relative`：原值保留
 * @param {string} raw
 * @param {{tmpDir?:string|null}} [opts]
 * @returns {{value:string, pathFlavor:string, rawValue:string|null}}
 */
export function normalizeEvidencePath(raw, opts = {}) {
  const s = String(raw ?? '').trim();
  const pathFlavor = classifyPathFlavor(s);
  const normalizedFor = (p) => slash(p).replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`).replace(/[.,;:]+$/, '');
  if (s === '') return { value: '', pathFlavor: 'relative', rawValue: null };
  if (pathFlavor === 'msys-drive') {
    const m = /^\/([A-Za-z])(\/.*)?$/.exec(s);
    const value = normalizedFor(`${m[1].toLowerCase()}:${m[2] ?? ''}`);
    return { value, pathFlavor, rawValue: value === s ? null : s };
  }
  if (pathFlavor === 'msys-tmp') {
    const rest = s.replace(/^\/tmp\/?/, '');
    const tmpDir = typeof opts.tmpDir === 'string' && opts.tmpDir !== '' ? opts.tmpDir : os.tmpdir();
    const value = normalizedFor(rest === '' ? tmpDir : path.join(tmpDir, rest));
    return { value, pathFlavor, rawValue: s };
  }
  if (pathFlavor === 'windows' || pathFlavor === 'unc') {
    const value = pathFlavor === 'unc' ? s : normalizedFor(s);
    return { value, pathFlavor, rawValue: value === s ? null : s };
  }
  // posix / relative：不猜挂载点，原值保留（读侧靠 pathFlavor 判"不可核验"）
  return { value: s, pathFlavor, rawValue: null };
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

/**
 * 代表文本（2026-11-02 审计 P1-2）：类级 claim 必须始终带 `class:<name> · ` 前缀。
 * 建组与"遇到更早支撑"两条路径都走这里 —— 否则文本会随输入顺序变化。
 */
export function representativeTextFor(kind, key, rawQuote, maxQuote = 200) {
  const line = errorLineOf(String(rawQuote ?? ''));
  const body = kind === 'antipattern' && String(key ?? '').startsWith('class:') ? `${key} · ${line}` : line;
  return clip(body, maxQuote);
}

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

        representativeText: representativeTextFor('antipattern', key, rawQuote, opts.maxQuote),

        representativeAt: at,

        validity: { type: 'none', value: null },

        preconditions: [],

        // T343：F3 失效条件（文本派生；判不出就不挂，不编）
        ...(f?.falsifiableWhen ? { falsifiableWhen: f.falsifiableWhen } : {}),

      });

      if (at < g.representativeAt) {

        g.representativeAt = at;

        g.representativeText = representativeTextFor(g.kind, g.key, rawQuote, opts.maxQuote);

      }

      // T343：首条支撑没派生出失效条件、而这条有 ⇒ 只补空（不覆盖已有；只增不改）
      if (!g.falsifiableWhen && f?.falsifiableWhen) g.falsifiableWhen = f.falsifiableWhen;

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

      // T159（2026-11-05）：写侧路径归一。证据原文里的 Git Bash 路径（`/tmp/x`、`/d/x`）
      // 若原样入库，读侧 `resolveValidityPath` 会把 `/tmp/x` 当当前盘根的 `D:\tmp\x`，
      // 于是"文件出现了"可能是**另一个文件**（真机：`/tmp/pr1-comment.json` 命中 `D:\tmp\…`）。
      // 归一后：`/tmp/x` → `<TEMP>\x`；`/d/x` → `d:/x`；归不了的 POSIX 路径留原值 + 打 `pathFlavor`。
      const evidence = normalizeEvidencePath(path);
      // 分组键仍用**原文路径**：claim id = hash(kind,key,scope)，换 key 会让老条目换个 id 重生。
      const g = ensure('fact', `file\u0000${path}`, ep.scopeKey, {

        representativeText: clip(errorLineOf(rawQuote), opts.maxQuote),

        representativeAt: at,

        // T158a + T159：ENOENT 派生的 fact 语义是「证据时刻该路径不存在」⇒ 方向位 missing。
        // probeValidity 按 expect 判：仍不存在 = ok；文件出现了 = stale（file-appeared）。
        // T159 额外记路径形态（pathFlavor / rawValue），归档侧才能把 Git Bash 的 /tmp/… 与盘根区分开。
        validity: {
          type: 'file',
          value: evidence.value,
          expect: 'missing',
          pathFlavor: evidence.pathFlavor,
          ...(evidence.rawValue ? { rawValue: evidence.rawValue } : {}),
        },

        preconditions: [{

          check: 'file-exists',

          value: evidence.value,

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

      // T343：F3 失效条件（文本派生）。判不出的 claim 不带该字段 ⇒ 输出与旧版逐字节一致。
      ...(g.falsifiableWhen ? { falsifiableWhen: g.falsifiableWhen } : {}),

      occurredAt,

      recordedAt: Number.isFinite(now) ? now : null,

      validFrom: Number.isFinite(occurredAt) ? occurredAt : null,

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



/**

 * N10（2026-11-02）：把「人纠错」（L4）机械地回填到 claim。

 * 只做两件事：给目标 claim 追加 counter 证据、把状态标成 disputed；

 * **不改写原文、不改 support、不删条目**（AGENTS §2.3 只增不改）。

 */

export function applyAdjudications({ claims = [], adjudications = [], now = null } = {}) {

  const list = Array.isArray(claims) ? claims : [];

  const byId = new Map(list.filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));

  const applied = [];

  for (const record of Array.isArray(adjudications) ? adjudications : []) {

    if (!record || record.decision !== 'correct') continue;

    if (record.level !== 'L4-human-correction') continue;

    const target = byId.get(String(record.target ?? ''));

    if (!target) continue;

    const evidence = Array.isArray(record.votes) ? record.votes.flatMap((v) => (Array.isArray(v?.evidence) ? v.evidence : [])) : [];

    const note = evidence[0]?.quote ?? String(record.note ?? '').trim();
    const quote = note || '人纠正';

    if (!Array.isArray(target.counter)) target.counter = [];

    const seen = new Set(target.counter.map((x) => `${x?.episode}${x?.seq}${x?.quote}`));

    const key = `human:owner${Number(record.at) || 0}${quote}`;

    if (!seen.has(key)) {

      target.counter.push({ episode: 'human:owner', threadId: null, nodeId: null, edgeId: null, seq: Number.isFinite(record.at) ? record.at : null, quote, occurredAt: Number.isFinite(record.at) ? record.at : null });

    }

    if (target.state !== 'invalidated') target.state = 'disputed';

    target.counters = { ...(target.counters ?? {}), counter: target.counter.length };

    if (Number.isFinite(record.at)) {
      target.correctedAt = record.at;
      // N1（2026-11-02）：人纠错即「有效期终点」；旧值不覆盖更早的终点。
      const prev = Number.isFinite(target.validTo) ? target.validTo : Infinity;
      target.validTo = Math.min(prev, record.at);
    }

    applied.push(target.id);

  }

  return { applied, claims: list, at: now };

}



/**
 * 类级章节自愈（2026-11-02）：给「有多局支撑、却缺类级 claim」的错误类补一条类级 claim。
 * 只增不改：不删、不改写已有 claim；同输入同输出（id 由类名 + 作用域决定，重复归档幂等）。
 */
export function ensureClassClaims({ claims = [], minSupport = 2, maxQuote = 200 } = {}) {
  const list = (Array.isArray(claims) ? claims : []).filter((c) => c && typeof c.id === 'string');
  const byClass = new Map();
  for (const claim of list) {
    if (String(claim.kind ?? '') !== 'antipattern') continue; // 契约 §12：只巩固反模式
    const text = String(claim.text ?? '');
    if (text.startsWith('class:')) continue;
    const key = errorKeyOf(text);
    if (!String(key).startsWith('class:')) continue;
    const name = key.slice('class:'.length);
    const group = byClass.get(name) ?? { name, claims: [], episodes: new Set(), scopes: new Map(), supports: [] };
    group.claims.push(claim);
    for (const s of Array.isArray(claim.support) ? claim.support : []) {
      if (!s?.episode) continue;
      group.episodes.add(String(s.episode));
      group.supports.push({ claim, support: s });
      group.scopes.set(String(claim.scopeKey ?? ''), (group.scopes.get(String(claim.scopeKey ?? '')) ?? 0) + 1);
    }
    byClass.set(name, group);
  }
  const existing = new Set(list.filter((c) => String(c.text ?? '').startsWith('class:')).map((c) => `${c.scopeKey ?? ''}${String(c.text).split(' · ')[0]}`));
  const added = [];
  for (const group of byClass.values()) {
    if (group.episodes.size < minSupport) continue;
    const scopeKey = [...group.scopes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'u:owner';
    const headline = `class:${group.name}`;
    if (existing.has(`${scopeKey}${headline}`)) continue;
    const ordered = [...group.supports].sort((a, b) => (a.support?.occurredAt ?? Infinity) - (b.support?.occurredAt ?? Infinity));
    const representative = ordered[0];
    const support = [];
    const seen = new Set();
    for (const item of ordered) {
      const s = item.support;
      const key = [s.episode, s.seq, s.quote].join('');
      if (seen.has(key)) continue;
      seen.add(key);
      support.push({ episode: s.episode, threadId: s.threadId ?? null, nodeId: s.nodeId ?? null, edgeId: s.edgeId ?? null, seq: Number.isFinite(s.seq) ? s.seq : null, quote: clip(String(s.quote ?? ''), maxQuote), occurredAt: Number.isFinite(s.occurredAt) ? s.occurredAt : null });
    }
    const times = support.map((s) => s.occurredAt).filter((t) => Number.isFinite(t));
    added.push({
      id: `c-${hash8(`class-merge${group.name}${scopeKey}`)}`,
      kind: 'antipattern',
      text: `${headline} · ${clip(errorLineOf(representative?.claim?.text ?? ''), maxQuote)}`,
      scopeKey,
      threadIds: [],
      state: support.length >= minSupport ? 'candidate' : 'observed',
      support,
      counter: [],
      validity: { type: 'none', value: null },
      preconditions: [{ check: 'scope', value: scopeKey, why: '类级章节：证据只覆盖该作用域（排版口径同其他 claim）' }],
      occurredAt: times.length ? Math.min(...times) : null,
      validFrom: times.length ? Math.min(...times) : null,
      validTo: null,
      recordedAt: null,
      supersedes: null,
      counters: { support: support.length, counter: 0, injections: 0, lastInjectedAt: null },
    });
  }
  return { claims, added };
}

export default { promoteClaim, applyAdjudications, ensureClassClaims, errorKeyOf, errorLineOf, isGenericErrorText, extractPaths, extractVersionLiterals, isIndependentEpisode, hasIndependentPair, DEFAULT_CLAIM_OPTIONS };

