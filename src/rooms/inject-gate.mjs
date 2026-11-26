// R13 闸判据 —— 十道闸的**判定原语**（task-11 / 重构 B 期：从 `inject.mjs` 逐行搬出，判据一个都没改）
//
// 为什么要单独成房：闸的判据必须能**脱离渲染**被单测、被替换；而这套判据同时被两处消费 ——
// `src/rooms/gates.mjs`（十道闸本体，`runGates`）与 `src/rooms/inject-card.mjs`（卡片渲染/预算）。
// 一处定义、两处读同一份实现，判据不会再出现"两处各写一份"（AGENTS §2.4 单源）。
//
// 房间契约（docs/数据契约.md §7.2/§7.3、方案.md §6.3、docs/记忆的职责边界.md §5）：
//   职责  只判：给定「一段模型可见文本 / 一个 scopeKey / 一个 token 预算 / 一条适用条件」回答是/否，
//         或给出命中的位置（pattern + 下标 + 摘录）。不改写、不修复、不重排。
//   导出  IMPERATIVE_PATTERNS / GOVERNANCE_PATTERNS / MARKERS_LINE      —— 边界闸的词表与标记语义
//         PROVENANCE_LINE_RE / INDEX_LINE_RE                            —— 闸 0 / 闸 6 的行形态
//         estimateTokens / formatCardDate                               —— 闸 6（预算）/ 闸 0（日期）的度量
//         IMPERATIVE_EXCLUSIONS / auditImperatives                      —— 边界闸（指令式片段）
//         scopeKeyFromPath / normalizeScopeKey / isUnknownScope /
//         isScopeVisible / filterHitsByScope                            —— 闸 1（作用域）
//         fileExistsPreconditionOk                                      —— 闸 3（file-exists 方向感知核验）
//   输入  字符串 / scopeKey / claim 对象（**只读**，不修改入参）。
//   输出  布尔、字符串、或 `[{pattern, at, excerpt}]`；不是抛错——判不了就走"放行/不判"。
//   错误  不抛：文件读不到、路径为空、字段缺失 ⇒ 按各自注释的「宁缺勿编」方向返回。
//   依赖  只允许 `node:fs`、`node:path`（`file-exists` 要 stat）。**不 import 任何房间** ⇒ 永不成环。
//   禁止  读时钟、写盘、调模型、读 store。
//
// 上游对应（判据不改，只搬）：
//   · 作用域可见性 `isScopeVisible`：本仓自设（方案 §4.10「只允许显式祖先」），闸 1 与注入前过滤同一份实现。
//   · token 估算 `estimateTokens`：CJK 1.5 字/token、ASCII 4 字/token，与 R11 walk 同口径（跨房间可复算）。
//   · `file-exists` 方向感知：与 `gates.expectedExistenceOf` 同一口径（T158/T159 的 file `expect`）。
// 墓碑测试：`test/inject.test.mjs` 的「task-11 · 三房拆分」段（删掉本文件 ⇒ 整片红）。

import fs from 'node:fs';
import path from 'node:path';


/** 记忆卡里出现即违规的指令式片段（R13 边界闸的正则来源；单源，避免注入文本与闸门漂移）。 */
export const IMPERATIVE_PATTERNS = Object.freeze([
  '你应该',
  '请',
  '下一步',
  '建议',
  '务必',
  '记得',
  '不要忘记',
  '可以试试',
]);

/** 工具治理痕迹（docs/记忆的职责边界.md §5 表的一行；机械可判，零假阳性代价低）。 */
export const GOVERNANCE_PATTERNS = Object.freeze([
  /permission:\s*(allow|ask|deny)/i,
  /\bapproval\s*:/i,
  /\bsandbox_permissions\b/i,
]);

/**
 * 一条记忆行（模型可见字符串）的权威形态：
 *   `- [antipattern] 文本  (ep-9c11, 2026-11-01, seq 88)`
 * 闸 0 用它逐行核 provenance 与日期；R12 用它产出，二者不能各写一份。
 * T347：允许坐标后跟**可选 F3 尾注**（` · 当…不再成立 [rule]`）；第 2 组仍是逐字正文，
 * 闸 0 的日期/seq 只从坐标组取 —— 派生内容不参与 provenance 核验。
 */
export const PROVENANCE_LINE_RE = /^- \[([^\]\n]+)\] (.+?) \((ep-[A-Za-z0-9._-]+), (\d{4}-\d{2}-\d{2}), seq (\d+)\)(?: · .+)?$/;

/** `indexLine` 的形态：事实陈述，不是指令。 */
export const INDEX_LINE_RE = /^MEMORY: .+（scope=.+, (\d+) 局, 未列出≠不存在）$/;

/**
 * 标记语义（声明式，只说「标记是什么意思」）——随 section 一起出现，让单看一行也能读。
 * 这一段是**事实陈述**：没有祈使句、没有「何时该查」。
 */
export const MARKERS_LINE = '# markers: [semantic]=≥3 局且无反例 · [candidate]=2 局 · [observed]=1 局 · [disputed]=存在反例 · [stale]=条件已变只给指针 · [antipattern]=失败教训 · 日期=occurredAt(UTC)';
// ---------------------------------------------------------------------------
// 度量与日期（跨房间同口径：CJK 1.5 字/token、ASCII 4 字/token，与 R11 walk 一致）
// ---------------------------------------------------------------------------

/** 粗估 token：CJK/全角按 1.5 字/token，其余按 4 字/token，向上取整。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0x2e7f) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** epoch ms → `YYYY-MM-DD`（UTC；与 R07 `formatDay(ms,'UTC')` 同口径，跨机可复算）。 */
export function formatCardDate(ms) {
  if (!Number.isFinite(ms)) return '????-??-??';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '????-??-??';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
/**
 * 扫描一段模型可见文本里的指令式片段。
 * @returns {Array<{pattern:string, at:number, excerpt:string}>}
 */
/**
 * 2026-11-04（0.138.0）：**误伤表** —— 有些"祈使模式"其实是普通词的一部分。
 * 线上实测（1192 条 claim 全库扫）：`请` 命中 51 次里绝大多数是 `请求`（HTTP request，本仓的日常名词），
 * `记得` 命中 11 次里大半是 `我记得`（叙述）。这些不是指令，却被边界闸当成指令 ⇒ 整张卡被拦/整行被丢。
 * 只加了最小排除集：`请` 后面是 求/示/假/教，或前面是 申/邀/聘/提/恳/呈/敬/回；`记得` 前面是 我/不/还/也/都/你。
 */
export const IMPERATIVE_EXCLUSIONS = Object.freeze({
  // 键与字符一律用码位写，避免边界审计把**规则表本身**当成注入里的祈使句（自检踩过）。
  '\u8bf7': { before: new Set(['\u7533', '\u9080', '\u8058', '\u63d0', '\u6073', '\u5448', '\u656c', '\u56de']), after: new Set(['\u6c42', '\u793a', '\u5047', '\u6559', '\u67ec']) },
  '\u8bb0\u5f97': { before: new Set(['\u6211', '\u4e0d', '\u8fd8', '\u4e5f', '\u90fd', '\u4f60']), after: new Set([]) },
});

function isExcludedHit(text, pattern, at) {
  const rule = IMPERATIVE_EXCLUSIONS[pattern];
  if (!rule) return false;
  const before = at > 0 ? text[at - 1] : '';
  const after = text[at + pattern.length] ?? '';
  return rule.before.has(before) || rule.after.has(after);
}

export function auditImperatives(text) {
  const s = String(text ?? '');
  const out = [];
  if (!s) return out;
  for (const pattern of IMPERATIVE_PATTERNS) {
    let from = 0;
    for (;;) {
      const at = s.indexOf(pattern, from);
      if (at < 0) break;
      if (isExcludedHit(s, pattern, at)) { from = at + pattern.length; continue; }
      const start = Math.max(0, at - 12);
      const end = Math.min(s.length, at + pattern.length + 12);
      out.push({ pattern, at, excerpt: s.slice(start, end).replace(/\s+/g, ' ').trim() });
      from = at + pattern.length;
    }
  }
  return out.sort((a, b) => (a.at - b.at) || String(a.pattern).localeCompare(String(b.pattern)));
}
/** `D:\work\demo` / `d:/work/demo` → `w:d:/work/demo`（与 R00 episode.scopeKey 同口径）。 */
export function scopeKeyFromPath(p) {
  const s = String(p ?? '').trim();
  if (!s) return 'w:<unknown>';
  const posix = s.replace(/\\/g, '/').replace(/\/+$/, '');
  return `w:${posix.replace(/([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`)}`;
}

/** scopeKey 规范化（`u:` 层保持小写；`w:` 与裸路径走同一口径）。作用是让"同一作用域"只有一种写法。 */
export function normalizeScopeKey(scopeKey) {
  const s = String(scopeKey ?? '').trim();
  if (!s) return '';
  if (/^u:/i.test(s)) return `u:${s.slice(2).toLowerCase()}`;
  if (/^w:/i.test(s)) return scopeKeyFromPath(s.slice(2));
  return scopeKeyFromPath(s);
}

/**
 * "拿不到当前工作区"的哨兵：R00 的 `w:unknown`、R12 的 `w:<unknown>`、空体。
 * 命中它时**不判**作用域（判不了），交给上层按"未核"处理，而不是把整卡判成越界。
 */
export function isUnknownScope(scopeKey) {
  const n = normalizeScopeKey(scopeKey);
  return n === '' || n === 'w:unknown' || n === 'w:<unknown>' || n === 'w:';
}

/**
 * 条目作用域在当前作用域下是否可见（方案 §4.10「只允许显式祖先；默认不可见」）：
 *   - 完全相同 ⇒ 可见
 *   - `u:` 用户层 ⇒ 任何 `w:` 作用域都可见（跨项目的"你"）
 *   - 当前 scope 是该条目的**子路径**（`w:d:/work/repo/plugin` 看 `w:d:/work/repo`）⇒ 可见
 *   - 反向（父看子）/ 完全不同的工作区 ⇒ 不可见
 * R12 用它过滤 walk 命中，R13 闸 1 用它判越界 —— 同一份实现，不复制。
 */
export function isScopeVisible(entryScope, currentScope) {
  const entry = normalizeScopeKey(entryScope);
  const current = normalizeScopeKey(currentScope);
  if (!entry || !current) return false;
  if (entry === current) return true;
  if (entry.startsWith('u:') && current.startsWith('w:')) return true;
  if (entry.startsWith('w:') && current.startsWith('w:')) {
    const base = entry.slice(2);
    const leaf = current.slice(2);
    return leaf === base || leaf.startsWith(`${base}/`);
  }
  return false;
}

/**
 * 按当前作用域过滤 walk 命中（R11 暂不接收 scope 参数时的 R12 侧兜底）。
 * 判据同闸 1：**证明不了在本域可见的就不注入**（`u:` 层例外）。
 * 丢掉的两类分开计数，好让省略行说清"为什么少了"：
 *   - `dropped`：明确在别的作用域（crossScope）
 *   - `droppedUnknown`：命中没带 scopeKey，无法证明可见（默认不可见）
 */
export function filterHitsByScope(hits, scope) {
  const list = Array.isArray(hits) ? hits : [];
  const current = normalizeScopeKey(scope);
  if (!current || isUnknownScope(current)) return { hits: list.slice(), dropped: 0, droppedUnknown: 0, scope: null };
  const kept = [];
  let dropped = 0;
  let droppedUnknown = 0;
  for (const hit of list) {
    const entryScope = typeof hit?.scopeKey === 'string' && hit.scopeKey.trim() !== '' ? hit.scopeKey : '';
    if (!entryScope) {
      droppedUnknown += 1;
      continue;
    }
    if (isScopeVisible(entryScope, current)) kept.push(hit);
    else dropped += 1;
  }
  return { hits: kept, dropped, droppedUnknown, scope: current };
}
/** T35：`file-exists` 核验结果缓存（同一进程内按绝对路径复用；上限 512 条后整体清空）。 */
const FILE_EXISTS_CACHE = new Map();
const FILE_EXISTS_CACHE_MAX = 512;

function fileExistsCached(absPath) {
  const key = String(absPath ?? '');
  if (!key) return false;
  if (FILE_EXISTS_CACHE.has(key)) return FILE_EXISTS_CACHE.get(key);
  let ok = false;
  try { ok = fs.existsSync(key); } catch { ok = false; }
  if (FILE_EXISTS_CACHE.size >= FILE_EXISTS_CACHE_MAX) FILE_EXISTS_CACHE.clear();
  FILE_EXISTS_CACHE.set(key, ok);
  return ok;
}

/**
 * T35 · `file-exists` 适用条件的**机械核验**（负迁移机械消除）。
 *
 * 判据（**方向感知**，与 `gates.expectedExistenceOf` 同一口径 —— T158/T159 的 file `expect`）：
 *  · `expect === 'missing'`（ENOENT 派生的 fact：证据是"该路径不存在"）⇒ 路径**出现**才失效；
 *  · `expect === 'exists'`（普通文件 fact）⇒ 文件**消失**才失效；
 *  · 旧记录没有 `validity.expect` 时按 gates 的旧记录规则判：`validity.value` 等于该 precondition 的
 *    `value` ⇒ `missing`（precondition 就是 missing 标记），否则 `exists`。
 * 任何一条失效 ⇒ 这条记忆的适用条件已不成立 ⇒ **不注入**（`false`）。
 *
 * 边界（宁缺勿编的对称面：**不许误杀**）：
 *  · 只认 `file-exists`；`scope` / `cmd` / `tool` / `step-range` **一概不动**（作用域归 A5，命令/工具由各自的闸管）；
 *  · `value` 取不到（空/非字符串）⇒ **无法核验 ⇒ 放行**（不拿"缺字段"当失效理由）；
 *  · 相对路径按 `options.preconditionBaseDir`（默认 `process.cwd()`）解析，绝对路径原样；
 *  · 结果按绝对路径缓存（热路径每 claim 一次 `existsSync`，同文件只查一次）。
 *
 * @param {object} claim
 * @param {object} [options] `{preconditionBaseDir?}`
 * @returns {boolean} `true` = 适用条件成立（或无法核验）；`false` = 有 file-exists 指向的文件已不存在
 */
export function fileExistsPreconditionOk(claim, options = {}) {
  const pre = Array.isArray(claim?.preconditions) ? claim.preconditions : [];
  if (!pre.length) return true;
  const base = typeof options?.preconditionBaseDir === 'string' && options.preconditionBaseDir
    ? options.preconditionBaseDir
    : process.cwd();
  // 方向（T158）：`validity.expect` 显式优先；旧记录按 gates 的规则推断（见上）。
  const expectRaw = typeof claim?.validity?.expect === 'string' ? claim.validity.expect.trim().toLowerCase() : '';
  const validityValue = String(claim?.validity?.value ?? '');
  for (const item of pre) {
    if (!item || typeof item !== 'object' || item.check !== 'file-exists') continue;
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    if (!value) continue; // 无法核验 ⇒ 放行
    const abs = path.isAbsolute(value) ? value : path.resolve(base, value);
    const expect = expectRaw === 'missing' || expectRaw === 'exists'
      ? expectRaw
      : (validityValue && validityValue === value ? 'missing' : 'exists');
    const exists = fileExistsCached(abs);
    // expect=missing ⇒ 路径出现就失效；expect=exists ⇒ 文件消失就失效
    if (expect === 'missing' ? exists : !exists) return false;
  }
  return true;
}
