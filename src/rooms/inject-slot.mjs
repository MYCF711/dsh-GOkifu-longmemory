// inject-slot —— 注入**槽位幂等账本**（task-11 / 重构 B 期；方案 P0-1「按 slot 幂等覆盖 + 内容 hash 判等」）
//
// 要解决的问题（有实测，不是推测）：注入去重原先只靠 `apply()` 内的内存集合 `injectedIds`。
// 宿主 `session/end-seed` ⇒ 下一轮 agent 重建 ⇒ 插件**重新 apply** ⇒ 那个集合是新的空集
// ⇒ 同一张卡重投。会话 `aa0b0da9`（16 turn / 15 个 end-seed）实测 **10/10 次重复注入**，
// 对照会话 `2dbed42d`（0 个 end-seed）只注入 **1** 次（evidence/T49-already-in-context.md §六）。
// 结论：**判重键的生命周期短于“注入这件事”的生命周期** —— 键在内存里，注入在上下文里。
//
// 上游做法（P0-1 的依据）：
//   · Letta `rebuild_system_prompt`：记忆串没变就 `return`，不重建、不重投
//     （原话 "Updates to the memory header should not trigger a rebuild, since that will
//      simply flood recall storage with excess messages"）[外]
//   · Anthropic 前缀缓存：改早前内容 ⇒ 该层及其后全废；**只追加尾部**才全命中 [外]
//   本房把这两条落成机械判据：同 slot + **内容 hash 相同** ⇒ 不注入、不写账本；
//   hash 变了 ⇒ **覆盖同一条记录**（`seq+1`），而不是追加一个新块。
//
// 账本形状（持久化到 sidecar `<storeRoot>/inject-slots.json`，不进会话日志）：
//   { version: 1,
//     slots: { "<sessionId>\u001f<slotId>": { slotId, contentHash, seq, at } } }
//   · 键 = 会话 + 槽位：一个会话的「记忆卡槽」只有一条记录，所以"覆盖"是**改同一个键**，不会越写越多；
//   · `seq` = 这个槽被真实注入过几次（首次 1，覆盖时 +1）—— 计数不是打分（AGENTS §2.3）；
//   · `contentHash` = 注入正文的 sha256（判等用，不存正文：账本是索引，不是内容副本）；
//   · `at` = 记账时刻（epoch ms，只用于淘汰与审计）。
//
// ---------------------------------------------------------------------------
// 第二本账（P0-2「去重键 = 内容身份」）：`<storeRoot>/claim-evidence.json`
// ---------------------------------------------------------------------------
// 槽位账本判的是**整张卡**（同 slot + 同正文 hash）。它挡不住"同一批证据换个渲染"这一类重复：
// 卡的正文一变（多一行 / 次序变了 / 索引行的局数变了），hash 就变 ⇒ 整张卡重投，卡上那些
// **模型已经看过的行**又被复述一遍。上游给出的判据是**内容身份**而不是文本：
//   · Mem0 现行 = `hashlib.md5(text)` + 只跟 `top_k=10` 检索结果比对 ⇒ issue #7123
//     「1 小时内同一事实 8 条近重复」：文本哈希挡不住复述，top-k 窗口挡不住历史。
//   · Cognee 用 `uuid5(内容)` 做内容寻址（同一份内容永远同一个地址）⇒ 幂等是**键**给的，不是窗口给的。
// 本账把"一份证据"的地址写成**来源身份** `(scopeKey, episodeId, seq, claimId)`：
//   · 同一 claim 的同一 seq 证据被重复抽取/重复注入 ⇒ 身份相同 ⇒ 命中；
//   · 同文本不同来源 ⇒ 身份不同（episode / seq / claimId 任一不同）⇒ **各自保留**。
//     **这正是与"文本哈希"的关键差别**：md5(text) 会把两个来源的同文事实并成一条。
//
// 账本形状：
//   { version: 1,
//     identities: { "<scopeKey>\u001f<episodeId>\u001f<seq>\u001f<claimId>":
//                     { scopeKey, episodeId, seq, claimId, lineHash, times, at } } }
//   · `lineHash` = **渲染行**（`- [marker] 正文 (ep, 日期, seq N)`，含坐标）的 sha256 —— 用来回答
//     "这份证据现在还在本轮上下文里吗"（压缩掉了 ⇒ 该重注，那是必要重注，不是浪费）。仍不存正文。
//   · `times` = 这条身份被真实注入过几次（覆盖时 +1；计数不是打分）。
//   · 键里带 seq：同一 claim 的不同 seq 是**两份证据**，不合并（与 claim 级去重互补）。
//   · 缺字段用最接近的稳定键：`claimId` 缺 ⇒ `-`（棋谱指针行），`seq` 缺 ⇒ `-`，`scopeKey` 缺 ⇒ `-`；
//     episode 与 claim 两者都缺 ⇒ 空键（定位不到，不记账）。
//
// 判重窗口：**只来自这本持久账本**（+ "还在上下文里"这一条机械事实），不吃本轮 walk 的 top-k；
// 所以跨 apply（`session/end-seed` 后重建）/ 跨重启都成立。
//
// 契约：
//   职责  判「这一槽这次要不要注入」（整卡）+ 判「这份证据是不是已投且仍在上下文里」（逐条）+ 记账（持久、幂等、可回滚）。
//   导出  INJECT_SLOT_ID / INJECT_SLOT_LEDGER_FILE / INJECT_SLOT_LEDGER_VERSION /
//         INJECT_SLOT_IDEMPOTENT_ENV / SLOT_LEDGER_MAX / SlotLedgerError /
//         slotIdempotencyEnabled / slotContentHash / slotKeyOf / emptySlotLedger / lookupSlot /
//         slotContentPresent / pruneSlotLedger / planSlotWrite / readSlotLedger / writeSlotLedger /
//         recordSlot / slotSeen（槽位）；
//         CLAIM_EVIDENCE_FILE / CLAIM_EVIDENCE_VERSION / CLAIM_EVIDENCE_MAX /
//         CLAIM_EVIDENCE_IDEMPOTENT_ENV / claimEvidenceEnabled / evidenceLineHash /
//         claimIdentityOf / claimEvidenceKeyOf / emptyClaimEvidenceLedger / lookupEvidence /
//         evidencePresent / contextLineHashes / cardEvidenceItems / pruneEvidenceLedger /
//         planEvidenceWrite / readClaimEvidenceLedger / writeClaimEvidenceLedger / recordEvidence /
//         evidenceSeen / restatedEvidenceOf（内容身份）。
//   输入  纯函数部分只吃普通对象（账本 + 参数）；I/O 部分只吃 `{storeRoot}`（**不读 store 本体**）。
//   输出  `{ledger, entry, written, reason}` / 账本对象 / 布尔；I/O 版多 `path`。
//   错误  **不认识的 `version` / 坏 JSON ⇒ 抛 `SlotLedgerError`（不许静默降级）**；
//         文件不存在 ⇒ 空账本（首次运行不是错误）。写盘失败向上抛，由调用方决定是否继续注入。
//   依赖  `node:crypto` / `node:fs` / `node:path`。**零项目依赖** ⇒ 可被任何房间 import、也不成环。
//   禁止  读时钟（`at` 由调用方给）、调模型、读会话日志、写 store 本体。
//
// 回滚：`KIFU_INJECT_SLOT_IDEMPOTENT=0` ⇒ `slotIdempotencyEnabled()` 为 false，
// 插件退回旧的进程内去重（行为与 0.8.x 一致）；账本文件保留不动，随时可再开。
//       `KIFU_CLAIM_EVIDENCE_IDEMPOTENT=0` 单独关掉内容身份去重（槽位账本照旧生效）。
//
// 并发：读-改-写 + 原子替换（`<file>.tmp-<pid>-<n>` → `rename`）。单进程宿主下足够；
// 同一 store 被多进程同时注入时最后一次写胜出（丢的只是审计记录，不会丢注入正确性）。
// 墓碑测试：`test/inject-slot.test.mjs`（删掉本文件 ⇒ 整片红）。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 账本文件名（落在 `storeRoot` 根下，与 `live-stats.jsonl` / `trials.jsonl` 同级；不参与 manifest 校验）。 */
export const INJECT_SLOT_LEDGER_FILE = 'inject-slots.json';

/** 账本格式版本。**读侧不认识就抛**（与 persist 的 `unsupported version` 语义一致）。 */
export const INJECT_SLOT_LEDGER_VERSION = 1;

/** 内容身份账本的文件名（sidecar 根，与 `inject-slots.json` 同级；不参与 manifest 校验）。 */
export const CLAIM_EVIDENCE_FILE = 'claim-evidence.json';

/** 内容身份账本的格式版本。**读侧不认识就抛**（同一套拒绝语义）。 */
export const CLAIM_EVIDENCE_VERSION = 1;

/** 回滚开关：`KIFU_CLAIM_EVIDENCE_IDEMPOTENT=0` ⇒ 关掉"内容身份"这一档去重（槽位账本不受影响）。 */
export const CLAIM_EVIDENCE_IDEMPOTENT_ENV = 'KIFU_CLAIM_EVIDENCE_IDEMPOTENT';

/**
 * 身份账本最多保留多少条证据。
 * 为什么有上限：证据是**只增**的（每投一条卡上的行就多一条身份），不淘汰就是无界文件。
 * 淘汰判据是机械的（`at` 新→旧，同 `at` 按键名排序，确定可复现），不是"重要性"。
 * 数值取 4096：一张卡 ≤5 行、一个会话通常注入 1 张 ⇒ 覆盖本机数百局注入量；文件仍是百 KB 级。
 */
export const CLAIM_EVIDENCE_MAX = 4096;

/** 记忆卡在上下文里的槽位 id（单一来源；插件与测试都读它，不各写一份字面量）。 */
export const INJECT_SLOT_ID = 'memory-card';

/** 回滚开关：`KIFU_INJECT_SLOT_IDEMPOTENT=0` ⇒ 走旧的进程内去重。 */
export const INJECT_SLOT_IDEMPOTENT_ENV = 'KIFU_INJECT_SLOT_IDEMPOTENT';

/**
 * 账本最多保留多少个槽（按 `at` 新的留）。
 * 为什么要上限：会话是**只增**的（一个会话一个槽），不淘汰就是个无界增长的文件。
 * 淘汰判据是机械的（`at` 新→旧，同 at 按键名排序，结果确定可复现），不是"重要性"。
 * 数值取 512：一个会话一个槽，够覆盖本机 30 天内的会话量（实测最忙一天 17 个会话）。
 */
export const SLOT_LEDGER_MAX = 512;

/** 账本读写错误（`code` 是给调用方判的分支键，`detail` 只放不含正文的诊断信息）。 */
export class SlotLedgerError extends Error {
  constructor(message, code = 'slot/error', detail = null) {
    super(message);
    this.name = 'SlotLedgerError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 槽位幂等是否开启（回滚开关）。
 * 只认 `'0'` / `'false'` 为关闭 —— 未设置一律开启（默认值 = 新行为；星号与 D5 的 `!== false` 陷阱相反，
 * 这里**显式**写出允许的关闭值，避免"未设置被当成关闭"）。
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function slotIdempotencyEnabled(env = process.env) {
  const raw = env ? env[INJECT_SLOT_IDEMPOTENT_ENV] : undefined;
  const v = String(raw ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false');
}

/**
 * 注入正文的内容 hash（sha256，小写十六进制）。
 * 只吃文本，不吃时间/序号 —— 同样的正文必须得到同样的 hash（否则幂等就无从判）。
 * @param {string} text
 * @returns {string}
 */
export function slotContentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * 槽位键：`<sessionId>\u001f<slotId>`（`\u001f` = 单元分隔符，两个 id 都是普通标识符里不会出现的字符）。
 * @param {string} sessionId
 * @param {string} [slotId]
 * @returns {string}
 */
export function slotKeyOf(sessionId, slotId = INJECT_SLOT_ID) {
  const s = String(sessionId ?? '');
  const slot = typeof slotId === 'string' && slotId ? slotId : INJECT_SLOT_ID;
  if (!s) return '';
  return `${s}\u001f${slot}`;
}

/** 空账本（每次返回新对象，调用方可以随便改）。 */
export function emptySlotLedger() {
  return { version: INJECT_SLOT_LEDGER_VERSION, slots: {} };
}

/** 账本是否合法（结构层面；不认识 ⇒ 判 null，由调用方按"没记录"处理）。 */
function slotsOf(ledger) {
  return ledger && typeof ledger === 'object' && ledger.slots && typeof ledger.slots === 'object' ? ledger.slots : {};
}

/**
 * 查一个槽的记账（没有 ⇒ `null`）。
 * @param {object} ledger
 * @param {string} sessionId
 * @param {string} [slotId]
 * @returns {{slotId:string, contentHash:string, seq:number, at:number|null}|null}
 */
export function lookupSlot(ledger, sessionId, slotId = INJECT_SLOT_ID) {
  const key = slotKeyOf(sessionId, slotId);
  if (!key) return null;
  const entry = slotsOf(ledger)[key];
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.contentHash !== 'string' || !entry.contentHash) return null;
  return {
    slotId: typeof entry.slotId === 'string' && entry.slotId ? entry.slotId : slotId,
    contentHash: entry.contentHash,
    seq: Number.isFinite(entry.seq) ? entry.seq : 1,
    at: Number.isFinite(entry.at) ? entry.at : null,
  };
}

/**
 * 记账内容**是否仍在本轮上下文里**（纯函数）：
 * 给一组「模型可见的文本」，任一文本的 hash 等于账本 hash ⇒ 同一份内容还在上下文里。
 *
 * 为什么这条判据必须有：卡可能被压缩掉（T49 ②）——内容不在上下文里时**该重投**
 * （那是"必要重注"，不是浪费）；内容还在上下文里时再投一次必然是浪费（A1.redundant 的分子）。
 * @param {object|null} entry `lookupSlot` 的返回
 * @param {string[]} texts
 * @returns {boolean}
 */
export function slotContentPresent(entry, texts = []) {
  if (!entry || typeof entry.contentHash !== 'string' || !entry.contentHash) return false;
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== 'string' || !text) continue;
    if (slotContentHash(text) === entry.contentHash) return true;
  }
  return false;
}

/**
 * 淘汰（纯函数）：按 `at` 新→旧保留前 `max` 个槽；同 `at` 按键名排序，结果确定。
 * @param {object} ledger
 * @param {number} [max]
 * @returns {object} 新账本（不改入参）
 */
export function pruneSlotLedger(ledger, max = SLOT_LEDGER_MAX) {
  const slots = slotsOf(ledger);
  const keys = Object.keys(slots);
  const limit = Number.isFinite(max) && max >= 0 ? max : SLOT_LEDGER_MAX;
  if (keys.length <= limit) return { version: INJECT_SLOT_LEDGER_VERSION, slots: { ...slots } };
  const rank = (k) => (Number.isFinite(slots[k]?.at) ? Number(slots[k].at) : 0);
  keys.sort((a, b) => (rank(b) - rank(a)) || String(a).localeCompare(String(b)));
  const kept = {};
  for (const k of keys.slice(0, limit)) kept[k] = slots[k];
  return { version: INJECT_SLOT_LEDGER_VERSION, slots: kept };
}

/**
 * 记账计划（**纯函数**，本房的核心判据）：
 *   · 同 slot + hash 相同 ⇒ `written:false`，账本**一个字节都不变**（不注入、不写）；
 *   · 同 slot + hash 不同 ⇒ 覆盖同一条（`seq+1`）；
 *   · 没有槽 ⇒ 新建（`seq:1`）。
 * @param {object} ledger
 * @param {{sessionId:string, slotId?:string, contentHash:string, at?:number|null, max?:number}} input
 * @returns {{ledger:object, entry:object|null, written:boolean, reason:string}}
 */
export function planSlotWrite(ledger, { sessionId, slotId = INJECT_SLOT_ID, contentHash, at = null, max = SLOT_LEDGER_MAX } = {}) {
  const key = slotKeyOf(sessionId, slotId);
  if (!key) return { ledger, entry: null, written: false, reason: 'slot/no-session' };
  const hash = typeof contentHash === 'string' ? contentHash : '';
  if (!hash) return { ledger, entry: null, written: false, reason: 'slot/no-hash' };
  const prev = lookupSlot(ledger, sessionId, slotId);
  if (prev && prev.contentHash === hash) {
    return { ledger, entry: prev, written: false, reason: 'slot/unchanged' };
  }
  const entry = {
    slotId: typeof slotId === 'string' && slotId ? slotId : INJECT_SLOT_ID,
    contentHash: hash,
    seq: prev ? prev.seq + 1 : 1,
    at: Number.isFinite(at) ? Number(at) : null,
  };
  const next = { version: INJECT_SLOT_LEDGER_VERSION, slots: { ...slotsOf(ledger), [key]: entry } };
  return {
    ledger: pruneSlotLedger(next, max),
    entry,
    written: true,
    reason: prev ? 'slot/overwritten' : 'slot/created',
  };
}

function ledgerPathOf(storeRoot, file) {
  const root = String(storeRoot ?? '');
  if (!root) return null;
  return path.join(root, typeof file === 'string' && file ? file : INJECT_SLOT_LEDGER_FILE);
}

/**
 * 读账本。文件不存在 ⇒ 空账本（首次运行）；版本不认识 / JSON 坏 ⇒ **抛**（不静默降级）。
 * @param {{storeRoot:string, file?:string}} input
 * @returns {object} 账本
 */
export function readSlotLedger({ storeRoot, file = INJECT_SLOT_LEDGER_FILE } = {}) {
  const abs = ledgerPathOf(storeRoot, file);
  if (!abs) return emptySlotLedger();
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptySlotLedger();
    throw new SlotLedgerError(`slot: 账本读不出来（${abs}）：${String(error?.message ?? error)}`, 'slot/read-failed', { path: abs });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SlotLedgerError(`slot: 账本不是合法 JSON（${abs}）：${String(error?.message ?? error)}`, 'slot/invalid', { path: abs });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SlotLedgerError(`slot: 账本形状不对（${abs}）`, 'slot/invalid', { path: abs });
  }
  if (parsed.version !== INJECT_SLOT_LEDGER_VERSION) {
    throw new SlotLedgerError(
      `slot: unsupported ledger version ${JSON.stringify(parsed.version)} (期望 ${INJECT_SLOT_LEDGER_VERSION})`,
      'slot/unsupported-version',
      { found: parsed.version, expected: INJECT_SLOT_LEDGER_VERSION, path: abs },
    );
  }
  const slots = parsed.slots && typeof parsed.slots === 'object' ? parsed.slots : {};
  return { version: parsed.version, slots };
}

let tmpSeq = 0;

/**
 * 原子写账本（`.tmp-*` → rename；键名排序，同样的内容 ⇒ 同样的字节）。
 * @param {{storeRoot:string, ledger:object, file?:string}} input
 * @returns {{path:string, bytes:number, slots:number}}
 */
export function writeSlotLedger({ storeRoot, ledger, file = INJECT_SLOT_LEDGER_FILE } = {}) {
  const abs = ledgerPathOf(storeRoot, file);
  if (!abs) throw new SlotLedgerError('slot: 写账本需要 storeRoot', 'slot/no-store');
  const slots = slotsOf(ledger);
  const ordered = {};
  for (const key of Object.keys(slots).sort()) ordered[key] = slots[key];
  const body = `${JSON.stringify({ version: INJECT_SLOT_LEDGER_VERSION, slots: ordered })}\n`;
  tmpSeq += 1;
  const tmp = `${abs}.tmp-${process.pid}-${tmpSeq}`;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉也不影响主流程 */ }
    throw new SlotLedgerError(`slot: 账本写不进去（${abs}）：${String(error?.message ?? error)}`, 'slot/write-failed', { path: abs });
  }
  return { path: abs, bytes: Buffer.byteLength(body, 'utf8'), slots: Object.keys(ordered).length };
}

/**
 * 记一笔账（读 → 规划 → 只在**确实变了**时写）。
 * 返回值直接说明"这次到底写没写"，让调用方能断言"hash 相同 ⇒ 不写"。
 * @param {{storeRoot:string, sessionId:string, slotId?:string, contentHash:string, at?:number|null, file?:string, max?:number}} input
 * @returns {{written:boolean, entry:object|null, reason:string, path:string|null, seq:number|null}}
 */
export function recordSlot({ storeRoot, sessionId, slotId = INJECT_SLOT_ID, contentHash, at = null, file = INJECT_SLOT_LEDGER_FILE, max = SLOT_LEDGER_MAX } = {}) {
  const ledger = readSlotLedger({ storeRoot, file });
  const plan = planSlotWrite(ledger, { sessionId, slotId, contentHash, at, max });
  if (!plan.written) return { written: false, entry: plan.entry, reason: plan.reason, path: ledgerPathOf(storeRoot, file), seq: plan.entry?.seq ?? null };
  const out = writeSlotLedger({ storeRoot, ledger: plan.ledger, file });
  return { written: true, entry: plan.entry, reason: plan.reason, path: out.path, seq: plan.entry?.seq ?? null };
}

/**
 * 查一个槽的记账（I/O 版便利函数；读写失败一律向上抛，由调用方决定降级）。
 * @param {{storeRoot:string, sessionId:string, slotId?:string, file?:string}} input
 * @returns {{slotId:string, contentHash:string, seq:number, at:number|null}|null}
 */
export function slotSeen({ storeRoot, sessionId, slotId = INJECT_SLOT_ID, file = INJECT_SLOT_LEDGER_FILE } = {}) {
  return lookupSlot(readSlotLedger({ storeRoot, file }), sessionId, slotId);
}

// ---------------------------------------------------------------------------
// 记忆侧去重：**内容身份**账本（P0-2）
//
// 身份 = `(scopeKey, episodeId, seq, claimId)` —— 来源身份，不是文本哈希。
//   · 同 claim 同 seq 证据被重复抽取/重复注入 ⇒ 身份相同 ⇒ 命中（跳过）；
//   · 同文本不同 episode ⇒ 身份不同 ⇒ 各自保留。
// 判重窗口只来自这本持久账本 + "那一行还在本轮上下文里"这条机械事实，**不吃本轮 top-k**。
// ---------------------------------------------------------------------------

/** 身份键的分隔符（`\u001f` = 单元分隔符；scopeKey/episodeId/claimId 里都不会出现）。 */
const EV_SEP = '\u001f';

/** 缺字段的占位符（稳定键：同一个"缺"永远同一个键，不随调用顺序变）。 */
const EV_MISSING = '-';

/** 缺省文件名（集中一处，读写两侧共用；测试/迁移可覆盖）。 */
const EV_DEFAULT_FILE = CLAIM_EVIDENCE_FILE;

/**
 * 内容身份去重是否开启（回滚开关；只认 `'0'` / `'false'` 为关闭，未设置 = 开启）。
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function claimEvidenceEnabled(env = process.env) {
  const raw = env ? env[CLAIM_EVIDENCE_IDEMPOTENT_ENV] : undefined;
  const v = String(raw ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false');
}

/**
 * 渲染行（卡上那一行，含 `(episode, 日期, seq N)` 坐标）的内容 hash。
 * 用途只有一个：回答"这份证据现在还在本轮上下文里吗"。空白归一（行尾空格不算改内容）；
 * 空行 ⇒ 空串（不参与比对）。
 * @param {string} line
 * @returns {string}
 */
export function evidenceLineHash(line) {
  const normalized = String(line ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * 归一化身份三要素（缺字段 ⇒ 稳定占位符）。
 * `seq` 只认 ≥1 的整数（seq 是 1 基的；`seq: 0` 等于"不知道在哪"，按缺失处理）。
 * @param {{scopeKey?:string, episodeId?:string, seq?:number, claimId?:string}} input
 * @returns {{scopeKey:string, episodeId:string, seq:number|string, claimId:string}}
 */
export function claimIdentityOf(input = {}) {
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : EV_MISSING);
  return {
    scopeKey: text(input?.scopeKey),
    episodeId: text(input?.episodeId),
    seq: Number.isFinite(input?.seq) && Number(input.seq) >= 1 ? Math.trunc(Number(input.seq)) : EV_MISSING,
    claimId: text(input?.claimId),
  };
}

/**
 * 身份键 = `scopeKey\u001fepisodeId\u001fseq\u001fclaimId`。
 * episode 与 claim 都缺 ⇒ 空键（定位不到任何来源，不记账、也不判重）。
 * @param {{scopeKey?:string, episodeId?:string, seq?:number, claimId?:string}} identity
 * @returns {string}
 */
export function claimEvidenceKeyOf(identity) {
  const id = claimIdentityOf(identity);
  if (id.episodeId === EV_MISSING && id.claimId === EV_MISSING) return '';
  return [id.scopeKey, id.episodeId, id.seq, id.claimId].join(EV_SEP);
}

/** 空身份账本（每次返回新对象；调用方可以随便改）。 */
export function emptyClaimEvidenceLedger() {
  return { version: CLAIM_EVIDENCE_VERSION, identities: {} };
}

/** 账本里的 identities 表（结构不合法 ⇒ 空表；由调用方按"没记录"处理）。 */
function identitiesOf(ledger) {
  return ledger && typeof ledger === 'object' && ledger.identities && typeof ledger.identities === 'object'
    ? ledger.identities
    : {};
}

/**
 * 查一份证据身份的记账（没有 ⇒ `null`）。
 * @param {object} ledger
 * @param {{scopeKey?:string, episodeId?:string, seq?:number, claimId?:string}} identity
 * @returns {{scopeKey:string, episodeId:string, seq:number|string, claimId:string, lineHash:string, times:number, at:number|null}|null}
 */
export function lookupEvidence(ledger, identity) {
  const key = claimEvidenceKeyOf(identity);
  if (!key) return null;
  const entry = identitiesOf(ledger)[key];
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.lineHash !== 'string' || !entry.lineHash) return null;
  const id = claimIdentityOf(entry);
  return {
    ...id,
    lineHash: entry.lineHash,
    times: Number.isFinite(entry.times) ? Number(entry.times) : 1,
    at: Number.isFinite(entry.at) ? Number(entry.at) : null,
  };
}

/**
 * 记账的那一行**是否还在给定的一组行 hash 里**（= 模型现在还能看见它）。
 * 在 ⇒ 再投一次必然是复述；不在（被压缩掉了）⇒ 那是"必要重注"，不许拦。
 * @param {object|null} entry `lookupEvidence` 的返回
 * @param {Set<string>|string[]} lineHashes
 * @returns {boolean}
 */
export function evidencePresent(entry, lineHashes) {
  if (!entry || typeof entry.lineHash !== 'string' || !entry.lineHash) return false;
  const set = lineHashes instanceof Set
    ? lineHashes
    : new Set(Array.isArray(lineHashes) ? lineHashes.filter((h) => typeof h === 'string' && h) : []);
  return set.has(entry.lineHash);
}

/**
 * 一组消息文本 → 它们包含的**行 hash 集合**（纯函数）。
 * 只喂我们自己投出去的卡正文（调用方负责挑选），所以这组 hash 代表"模型已经看见的行"。
 * @param {string[]} texts
 * @returns {Set<string>}
 */
export function contextLineHashes(texts = []) {
  const set = new Set();
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== 'string' || !text) continue;
    for (const line of text.split('\n')) {
      const hash = evidenceLineHash(line);
      if (hash) set.add(hash);
    }
  }
  return set;
}

/**
 * 记忆卡 → 每行的内容身份（纯函数；`card.claims[].line` 是渲染出来的那一行）。
 * 缺 `line` / 缺出处来源的行不进清单（无源不入：它本来也进不了卡）。
 * @param {object} card `buildMemoryCard` 的返回
 * @param {string} scopeKey 收下这张卡的作用域（身份的作用域维度）
 * @returns {Array<{scopeKey:string, episodeId:string, seq:number|string, claimId:string, lineHash:string}>}
 */
export function cardEvidenceItems(card, scopeKey = null) {
  const rows = Array.isArray(card?.claims) ? card.claims : [];
  const items = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const lineHash = evidenceLineHash(row.line);
    if (!lineHash) continue;
    const identity = claimIdentityOf({
      scopeKey,
      episodeId: row.source?.episode,
      seq: Number(row.source?.seq),
      claimId: typeof row.claimId === 'string' ? row.claimId : null,
    });
    const key = claimEvidenceKeyOf(identity);
    if (!key) continue;
    items.push({ ...identity, lineHash });
  }
  return items;
}

/**
 * 淘汰（纯函数）：按 `at` 新→旧保留前 `max` 条；同 `at` 按键名排序，结果确定。
 * @param {object} ledger
 * @param {number} [max]
 * @returns {object} 新账本（不改入参）
 */
export function pruneEvidenceLedger(ledger, max = CLAIM_EVIDENCE_MAX) {
  const identities = identitiesOf(ledger);
  const keys = Object.keys(identities);
  const limit = Number.isFinite(max) && max >= 0 ? max : CLAIM_EVIDENCE_MAX;
  if (keys.length <= limit) return { version: CLAIM_EVIDENCE_VERSION, identities: { ...identities } };
  const rank = (k) => (Number.isFinite(identities[k]?.at) ? Number(identities[k].at) : 0);
  keys.sort((a, b) => (rank(b) - rank(a)) || String(a).localeCompare(String(b)));
  const kept = {};
  for (const k of keys.slice(0, limit)) kept[k] = identities[k];
  return { version: CLAIM_EVIDENCE_VERSION, identities: kept };
}

/**
 * 记账计划（**纯函数**，本账的核心判据）：
 *   · 身份已在账 + `lineHash` 相同 ⇒ `written:false`，账本**一个字节都不变**；
 *   · 身份已在账 + `lineHash` 变了 ⇒ 覆盖同一条（`times+1`，同一份证据换了渲染，不是新证据）；
 *   · 身份不在账 ⇒ 新建（`times:1`）。
 * @param {object} ledger
 * @param {{identity:object, lineHash:string, at?:number|null, max?:number}} input
 * @returns {{ledger:object, entry:object|null, written:boolean, reason:string}}
 */
export function planEvidenceWrite(ledger, { identity, lineHash, at = null, max = CLAIM_EVIDENCE_MAX } = {}) {
  const key = claimEvidenceKeyOf(identity);
  if (!key) return { ledger, entry: null, written: false, reason: 'evidence/no-identity' };
  const hash = typeof lineHash === 'string' ? lineHash : '';
  if (!hash) return { ledger, entry: null, written: false, reason: 'evidence/no-hash' };
  const prev = lookupEvidence(ledger, identity);
  if (prev && prev.lineHash === hash) {
    return { ledger, entry: prev, written: false, reason: 'evidence/unchanged' };
  }
  const id = claimIdentityOf(identity);
  const entry = { ...id, lineHash: hash, times: prev ? prev.times + 1 : 1, at: Number.isFinite(at) ? Number(at) : null };
  const next = { version: CLAIM_EVIDENCE_VERSION, identities: { ...identitiesOf(ledger), [key]: entry } };
  return {
    ledger: pruneEvidenceLedger(next, max),
    entry,
    written: true,
    reason: prev ? 'evidence/overwritten' : 'evidence/created',
  };
}

/**
 * 读身份账本。文件不存在 ⇒ 空账本（首次运行）；版本不认识 / JSON 坏 ⇒ **抛**（不静默降级）。
 * @param {{storeRoot:string, file?:string}} input
 * @returns {object} 账本
 */
export function readClaimEvidenceLedger({ storeRoot, file = EV_DEFAULT_FILE } = {}) {
  const abs = ledgerPathOf(storeRoot, file);
  if (!abs) return emptyClaimEvidenceLedger();
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyClaimEvidenceLedger();
    throw new SlotLedgerError(`evidence: 身份账本读不出来（${abs}）：${String(error?.message ?? error)}`, 'evidence/read-failed', { path: abs });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SlotLedgerError(`evidence: 身份账本不是合法 JSON（${abs}）：${String(error?.message ?? error)}`, 'evidence/invalid', { path: abs });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SlotLedgerError(`evidence: 身份账本形状不对（${abs}）`, 'evidence/invalid', { path: abs });
  }
  if (parsed.version !== CLAIM_EVIDENCE_VERSION) {
    throw new SlotLedgerError(
      `evidence: unsupported ledger version ${JSON.stringify(parsed.version)} (期望 ${CLAIM_EVIDENCE_VERSION})`,
      'evidence/unsupported-version',
      { found: parsed.version, expected: CLAIM_EVIDENCE_VERSION, path: abs },
    );
  }
  return { version: parsed.version, identities: identitiesOf(parsed) };
}

/**
 * 原子写身份账本（`.tmp-*` → rename；键名排序，同样的内容 ⇒ 同样的字节）。
 * @param {{storeRoot:string, ledger:object, file?:string}} input
 * @returns {{path:string, bytes:number, identities:number}}
 */
export function writeClaimEvidenceLedger({ storeRoot, ledger, file = EV_DEFAULT_FILE } = {}) {
  const abs = ledgerPathOf(storeRoot, file);
  if (!abs) throw new SlotLedgerError('evidence: 写身份账本需要 storeRoot', 'evidence/no-store');
  const identities = identitiesOf(ledger);
  const ordered = {};
  for (const key of Object.keys(identities).sort()) ordered[key] = identities[key];
  const body = `${JSON.stringify({ version: CLAIM_EVIDENCE_VERSION, identities: ordered })}\n`;
  tmpSeq += 1;
  const tmp = `${abs}.tmp-${process.pid}-${tmpSeq}`;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, abs);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉也不影响主流程 */ }
    throw new SlotLedgerError(`evidence: 身份账本写不进去（${abs}）：${String(error?.message ?? error)}`, 'evidence/write-failed', { path: abs });
  }
  return { path: abs, bytes: Buffer.byteLength(body, 'utf8'), identities: Object.keys(ordered).length };
}

/**
 * 批量记一笔账（读一次 → 逐条规划 → 只在**确实变了**时写一次）。
 * 一张卡有多行，逐条 `recordSlot` 会把文件读改写 N 次；这里收成一次。
 * @param {{storeRoot:string, items:Array<object>, at?:number|null, file?:string, max?:number}} input
 * @returns {{written:boolean, writtenCount:number, entries:number, reasons:string[], path:string|null, identities?:number}}
 */
export function recordEvidence({ storeRoot, items = [], at = null, file = EV_DEFAULT_FILE, max = CLAIM_EVIDENCE_MAX } = {}) {
  const list = Array.isArray(items) ? items.filter((x) => x && typeof x === 'object') : [];
  let ledger = readClaimEvidenceLedger({ storeRoot, file });
  const reasons = [];
  let writtenCount = 0;
  for (const item of list) {
    const plan = planEvidenceWrite(ledger, { identity: item, lineHash: item?.lineHash, at, max });
    reasons.push(plan.reason);
    if (!plan.written) continue;
    ledger = plan.ledger;
    writtenCount += 1;
  }
  const abs = ledgerPathOf(storeRoot, file);
  if (!writtenCount) return { written: false, writtenCount: 0, entries: list.length, reasons, path: abs };
  const out = writeClaimEvidenceLedger({ storeRoot, ledger, file });
  return { written: true, writtenCount, entries: list.length, reasons, path: out.path, identities: out.identities };
}

/**
 * 查一份证据身份（I/O 版便利函数；读写失败一律向上抛，由调用方决定降级）。
 * @param {{storeRoot:string, identity:object, file?:string}} input
 * @returns {object|null}
 */
export function evidenceSeen({ storeRoot, identity, file = EV_DEFAULT_FILE } = {}) {
  return lookupEvidence(readClaimEvidenceLedger({ storeRoot, file }), identity);
}

/**
 * **这一组证据是不是"全是复述"**（纯函数，本账的判据收口）：
 * 每一条都 ① 在持久账本里，且 ② 记账的那一行还在给定的一组上下文行 hash 里 ⇒ `restated:true`。
 * 任一条不满足（新证据 / 被压缩掉了）⇒ `restated:false`（**fail-open**：宁可多投，不许吞卡）。
 * @param {object} ledger
 * @param {Array<object>} items 每项含身份 + `lineHash`（可用 `cardEvidenceItems` 造）
 * @param {Set<string>|string[]} lineHashes 当前上下文里我们自己投过的行 hash（见 `contextLineHashes`）
 * @returns {{restated:boolean, checked:number, freshCount:number, fresh:string[]}}
 */
export function restatedEvidenceOf(ledger, items = [], lineHashes = []) {
  const list = Array.isArray(items) ? items.filter((x) => x && typeof x === 'object') : [];
  const set = lineHashes instanceof Set ? lineHashes : contextLineHashes(lineHashes);
  const fresh = [];
  for (const item of list) {
    const entry = lookupEvidence(ledger, item);
    if (!entry || !evidencePresent(entry, set)) fresh.push(claimEvidenceKeyOf(item));
  }
  return {
    restated: list.length > 0 && fresh.length === 0,
    checked: list.length,
    freshCount: fresh.length,
    fresh,
  };
}

export default {
  INJECT_SLOT_LEDGER_FILE,
  INJECT_SLOT_LEDGER_VERSION,
  INJECT_SLOT_ID,
  INJECT_SLOT_IDEMPOTENT_ENV,
  SLOT_LEDGER_MAX,
  SlotLedgerError,
  slotIdempotencyEnabled,
  slotContentHash,
  slotKeyOf,
  emptySlotLedger,
  lookupSlot,
  slotContentPresent,
  pruneSlotLedger,
  planSlotWrite,
  readSlotLedger,
  writeSlotLedger,
  recordSlot,
  slotSeen,
  // P0-2：内容身份账本（记忆侧去重）
  CLAIM_EVIDENCE_FILE,
  CLAIM_EVIDENCE_VERSION,
  CLAIM_EVIDENCE_MAX,
  CLAIM_EVIDENCE_IDEMPOTENT_ENV,
  claimEvidenceEnabled,
  evidenceLineHash,
  claimIdentityOf,
  claimEvidenceKeyOf,
  emptyClaimEvidenceLedger,
  lookupEvidence,
  evidencePresent,
  contextLineHashes,
  cardEvidenceItems,
  pruneEvidenceLedger,
  planEvidenceWrite,
  readClaimEvidenceLedger,
  writeClaimEvidenceLedger,
  recordEvidence,
  evidenceSeen,
  restatedEvidenceOf,
};