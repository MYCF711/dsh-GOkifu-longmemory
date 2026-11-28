// R15 persist —— sidecar 存储：原子写 / manifest + sha256 / journal / verify / rebuild
//
// ── 契约（docs/数据契约.md §6/§7，方案.md §4.11 可搬迁内核，AGENTS.md §11 R15）──
// 职责：把记忆条目落成一个**可拷贝的目录**：一个条目一个 JSON 文件、原子写、只增不改、
//       manifest 自描述 + 整目录 checksums、journal 追加审计、派生索引可重算。
// 入口：createStore({root, user, now}) -> store
//       另导出 deriveStore / sha256 / canonicalJson / encodeId / validateRelPath / relativizeSource
// 目录（root = <DSH_HOME>/memory-context/，测试用临时目录）：
//   episodes/ topics/ links/ threads/ joseki/ claims/ adjudications/ journal/  +  manifest.json + index.md
// 权威 vs 派生（§4.11 规则 5）：
//   权威 = episodes/ joseki/ claims/ adjudications/  —— 只能由入档方写入，rebuild **不重算**
//   派生 = topics/ links/ threads/ + index.md       —— 可从权威重算；丢了 rebuild 能补回
// 原子写：同目录 `.tmp-*` 临时文件 → fsync → rename 覆盖。崩溃最多留一个 .tmp，rebuild 会清掉，
//   且 .tmp 永不进入 manifest（不会被误当成条目）。
// 幂等：同一输入重放到同一 store ⇒ 文件字节相同、manifest 的 counts/checksums 相同、
//   updatedAt 不再变（无变更就不重写 manifest）、journal 不追加（journal 只记真实变更）。
//   条目的 `_store.createdAt/updatedAt` 是存储簿记，不参与"同一内容"判定。
// 双时态失效（T-15 / P1-1，Graphiti `_apply_temporal_invalidation` 同构）：`putMany('claims', …)`
//   在写盘**前**把「库内既有 + 本轮提交」合成一份视图交给 R09 的 `applyTemporalInvalidation` 判定；
//   被判失效的旧行只加 `invalidAt`（失效起点 = 新证据的 occurredAt）与 `expiredAt`（判定时刻），
//   **正文/证据/state 一字不改、行不删**（读侧照常读得到）；已判定过的标注粘住，重放不复位、不改口。
//   规则本体在 R09（纯函数），R15 只做库内合并与落盘（判据见 docs/数据契约.md §9.1）。
// 路径纪律（§4.11 规则 2）：store 内一切路径相对 root（manifest.checksums 的 key、条目文件名都是
//   相对路径）；**不存绝对路径**。来源文件（会话日志/棋谱）的绝对路径不入库：
//   一律存成相对 DSH_HOME 的路径 + `sourceRoot:"DSH_HOME"`，并带 `sourceStatus`。
// 原件缺失不失效（§4.11 规则 6）：sourceStatus:"missing" 只表示原件不在这台机器上，
//   条目照常读出、照常可注入，只是不可晋升/更新（缺证据）；**不改 state、不删除**。
// 错误语义：
//   - 未知 manifest 版本 ⇒ verify 返回 `manifest/unsupported-version`（不静默降级）；
//     写入侧 ensureCompatible 直接抛 PersistError('store/unsupported-version')。
//   - 未知 manifest **schema 版本**（`schemaVersion` 字段）⇒ verify 返回 `manifest/unsupported-schema-version`；
//     写入侧直接抛 PersistError('store/unsupported-schema-version')。缺该字段 = 老库（0）照常读，
//     下次 writeManifest 补上（一次性升级）。字段形状由 `test/golden/manifest.json` 快照守着。
//   - 缺 manifest / 坏 manifest ⇒ verify 返回 `manifest/missing` / `manifest/invalid` + hint rebuild。
//   - 条目不慎带绝对路径 ⇒ put 抛 `persist/absolute-path`（宁可不入馆，不写进搬不走的库）。
//   - journal 坏尾（崩溃截断）⇒ readJournal 丢尾行 + 计数，**不抛**；rebuild 仍可跑。
// 允许依赖：R00（棋谱形状）；R09 claim 的**纯函数** `applyTemporalInvalidation`（零 I/O，只做判定）；
//   派生重算时按需动态 import R04/R05/R07/R06（缺失则显式 skipped，
//   不假装成功）。零第三方依赖，只用 node: 内置模块。
//
// 用法（入档方）：
//   const store = createStore({ root: '<memoryRoot>' });
//   store.ensureDirs();
//   store.putMany('episodes', episodes, { at: now });   // 权威
//   const derived = await deriveStore({ episodes: store.list('episodes').map((e) => e.record), at: now });
//   store.replaceDerived('topics', derived.topics, { at: now });
//   store.writeIndex(derived.indexMd, { at: now });
//   store.writeManifest({ at: now });
//   store.verify();  // {ok, errors, warnings, ...}

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const STORE_VERSION = 1;
export const STORE_SCHEMA = 'dsh-kifuin/memory-store@1';

import { readKindBundleCached, writeKindBundle, WALK_BUNDLE_KINDS } from './walkbundle.mjs';
// T-15 / P1-1：双时态失效的**判据**只有一份，在 R09（纯函数、零 I/O）；R15 只负责把它接到写盘前。
import { applyTemporalInvalidation } from './claim.mjs';

/**
 * manifest.json 对外面 schema 版本（整数）。与 `version` 分工不同：
 * `version` = 库格式/布局版本（搬库契约），`schemaVersion` = **字段形状**版本（字段增删/改名/改类型才 +1）。
 * 两者都走「不认识就显式报错」，不许静默降级（AGENTS §2.3）。
 */
export const MANIFEST_SCHEMA_VERSION = 1;
/** 早期 manifest 没有 `schemaVersion` 字段 ⇒ 按这一版解释（老库照常能读，不是"当最新版"）。 */
export const MANIFEST_SCHEMA_VERSION_LEGACY = 0;
/** 读侧认识的全部 manifest schema 版本；不在表里 ⇒ 显式报错。 */
export const MANIFEST_SCHEMA_SUPPORTED = Object.freeze([MANIFEST_SCHEMA_VERSION_LEGACY, MANIFEST_SCHEMA_VERSION]);

/**
 * 一份 manifest 声明的 schema 版本（纯函数）。缺字段 ⇒ 老库版本；非整数原样返回（由闸判）。
 * @param {object|null} manifest
 * @returns {*}
 */
export function manifestSchemaVersionOf(manifest) {
  const raw = manifest?.schemaVersion;
  return raw === undefined ? MANIFEST_SCHEMA_VERSION_LEGACY : raw;
}

export const MANIFEST_FILE = 'manifest.json';
export const INDEX_FILE = 'index.md';
export const JOURNAL_REL = 'journal/archive.jsonl';
export const KIND_BUNDLE_DIR_T394 = '.cache';
export const META_KEY = '_store';
export const PATH_POLICY = 'relative';
export const DEFAULT_USER = 'owner';

/** 七个条目目录（一个条目一个 JSON 文件）。 */
export const ENTRY_KINDS = Object.freeze([
  'episodes',
  'topics',
  'links',
  'threads',
  'joseki',
  'claims',
  'adjudications',
]);
/** 权威：只能由入档方写，rebuild 不重算（§4.11 规则 5）。 */
export const AUTHORITATIVE_KINDS = Object.freeze(['episodes', 'joseki', 'claims', 'adjudications']);
/** 派生：可从权威重算（§4.11 规则 5）。 */
export const DERIVED_KINDS = Object.freeze(['topics', 'links', 'threads']);
/** T30：恢复索引 sidecar（`<root>/recovery-index.json`）——派生索引，可由归档层重算。 */
export const RECOVERY_INDEX_FILE = 'recovery-index.json';
/** T33：trial 记录（append-only JSONL；每条 = 上一次注入之后观察到的结果）。 */
export const TRIALS_FILE = 'trials.jsonl';
export const RECOVERY_INDEX_VERSION = 1;
/** store 里的全部目录（含 journal）。 */
export const STORE_DIRS = Object.freeze([...ENTRY_KINDS, 'journal']);

/** 条目里声明"来源路径"的字段名：这些字段一旦出现就必须是相对路径（§4.11 规则 2）。 */
const SOURCE_PATH_KEYS = Object.freeze(new Set([
  'logPath',
  'graphPath',
  'filePath',
  'sourcePath',
  'absolutePath',
]));

const ID_SAFE = /^[A-Za-z0-9._-]$/;
const MAX_ENCODED_ID = 180;
const MAX_PATH_SCAN_DEPTH = 6;

export class PersistError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'PersistError';
    this.code = code;
    if (details) this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 基础工具（纯函数）
// ---------------------------------------------------------------------------

/** sha256 → 小写十六进制（manifest 的 checksums 值就是它）。 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

/** 深排序后的 JSON：同一内容 ⇒ 同一字节串（幂等/checksums 的地基）。 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

/** 稳定落盘文本：深排序 + 2 空格缩进 + 结尾换行（人可读、机器可校验）。 */
export function stableText(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// T30 · 恢复索引（sidecar）：`<root>/recovery-index.json`
//
// 形状：`{version:1, entries:{ "c-xxx": {kind, seq, at, failureSeq, episode, prefix} },
//         supports:{ "ep-xxx:44262": {claimId, kind, seq, at, failureSeq, prefix} }, counts:{entries, supports}}`
//   · `entries` 按 claimId（卡按信号挑 support 时的兜底）；
//   · `supports` 按 (episode, supportSeq) **精确对应卡上出处**（首选，避免同一 claim 的多条 support 串用）。
// 纪律：
//   · **只增不改**：同一 claimId 已有条目 ⇒ 保留原值（差异只计数 `conflicts`，不覆盖）；
//   · **确定性字节**：没有 `generatedAt` 一类时钟字段，深排序（`stableText`）⇒ 同一输入重放两次字节相同；
//   · 原子写（同目录 `.tmp-*` → rename），崩溃不会留下半截 JSON。
// ---------------------------------------------------------------------------

/**
 * T33 · trial 记录：`<root>/trials.jsonl`（append-only，一行一条）。
 *
 * 记录形状：`{claimId, injectedAt, outcome: recurred|avoided|unknown, evidenceEpisode, evidenceSeq, at}`
 *   · `injectedAt` = **上一次**注入该 claim 的时间（trial 的起点）；
 *   · `at` = 本次观察时间（= 本次注入时间）；
 *   · 同一 `(claimId, injectedAt)` 只允许一条 —— 重放幂等。
 * 纪律：**只增不改**（追加写、不重写历史）；文件不存在 ⇒ 空（tombstone：行为与现状一致）。
 */
export function trialsPath(root) {
  return path.join(path.resolve(root), TRIALS_FILE);
}

/** 读 trials（坏行丢弃 + 计数；不存在 ⇒ records=[]、exists=false）。 */
export function readTrials(root) {
  const records = [];
  let badLines = 0;
  let raw = '';
  try {
    raw = fs.readFileSync(trialsPath(root), 'utf8');
  } catch {
    return { records, badLines, exists: false };
  }
  for (const line of raw.split(String.fromCharCode(10))) {
    const text = line.trim();
    if (!text) continue;
    try {
      const row = JSON.parse(text);
      if (row && typeof row.claimId === 'string' && row.claimId) records.push(row);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { records, badLines, exists: true };
}

/**
 * 追加 trial 记录（只增不改、幂等）。
 * @param {string} root store 根
 * @param {Array<object>} rows 候选记录
 * @returns {{appended:number, skipped:number, path:string}}
 */
export function appendTrials(root, rows = []) {
  const existing = readTrials(root);
  const seen = new Set(existing.records.map((r) => `${r.claimId}@${r.injectedAt}`));
  const out = [];
  let skipped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.claimId !== 'string' || !row.claimId) { skipped += 1; continue; }
    if (!Number.isFinite(row.injectedAt) || !Number.isFinite(row.at)) { skipped += 1; continue; }
    if (!['recurred', 'avoided', 'unknown'].includes(row.outcome)) { skipped += 1; continue; }
    const key = `${row.claimId}@${row.injectedAt}`;
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    out.push({
      claimId: row.claimId,
      injectedAt: row.injectedAt,
      outcome: row.outcome,
      evidenceEpisode: typeof row.evidenceEpisode === 'string' && row.evidenceEpisode ? row.evidenceEpisode : null,
      evidenceSeq: Number.isFinite(row.evidenceSeq) ? row.evidenceSeq : null,
      at: row.at,
    });
  }
  if (!out.length) return { appended: 0, skipped, path: trialsPath(root) };
  fs.mkdirSync(path.resolve(root), { recursive: true });
  const target = trialsPath(root);
  const text = out.map((row) => JSON.stringify(row)).join(String.fromCharCode(10)) + String.fromCharCode(10);
  fs.appendFileSync(target, text, 'utf8');
  return { appended: out.length, skipped, path: target };
}

/** 恢复索引文件路径（只读判定用；不创建目录）。 */
export function recoveryIndexPath(root) {
  return path.join(path.resolve(root), RECOVERY_INDEX_FILE);
}

/** 读恢复索引：不存在/坏 JSON/版本不认识/形状不对 ⇒ `null`（不抛，调用方回退）。 */
export function readRecoveryIndex(root) {
  try {
    const data = JSON.parse(fs.readFileSync(recoveryIndexPath(root), 'utf8'));
    if (!data || data.version !== RECOVERY_INDEX_VERSION) return null;
    if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 合并条目（纯函数，**只增不改**）。
 * @param {{version:number, entries:object}|null} prev 现有索引（null/坏 ⇒ 从空开始）
 * @param {Array<{claimId:string, kind:string, seq:number, at:number, failureSeq?:number|null, episode?:string|null, prefix?:string|null}>} facts
 * @returns {{index:object, added:number, kept:number, conflicts:number}}
 */
export function mergeRecoveryIndex(prev, facts = []) {
  const base = prev && prev.version === RECOVERY_INDEX_VERSION && prev.entries && typeof prev.entries === 'object'
    ? prev
    : { version: RECOVERY_INDEX_VERSION, entries: {} };
  const entries = { ...base.entries };
  const supports = { ...(base.supports ?? {}) };
  let added = 0;
  let kept = 0;
  let conflicts = 0;
  for (const fact of Array.isArray(facts) ? facts : []) {
    const claimId = fact && typeof fact.claimId === 'string' ? fact.claimId : '';
    if (!claimId) continue;
    if (!Number.isFinite(fact.seq) || !Number.isFinite(fact.at)) continue;
    if (typeof fact.kind !== 'string' || !fact.kind) continue;
    const entry = {
      kind: fact.kind,
      seq: fact.seq,
      at: fact.at,
      failureSeq: Number.isFinite(fact.failureSeq) ? fact.failureSeq : null,
      episode: typeof fact.episode === 'string' && fact.episode ? fact.episode : null,
      prefix: typeof fact.prefix === 'string' && fact.prefix ? fact.prefix : null,
    };
    // (episode, supportSeq) 精确键：卡按信号挑 support 时首选
    if (entry.episode && Number.isFinite(fact.supportSeq)) {
      const key = `${entry.episode}:${fact.supportSeq}`;
      if (Object.prototype.hasOwnProperty.call(supports, key)) {
        kept += 1;
        if (canonicalJson(supports[key]) !== canonicalJson({ ...entry, claimId })) conflicts += 1;
      } else {
        supports[key] = { claimId, ...entry };
        added += 1;
      }
    }
    // claimId 兜底键（卡渲染的 support 不在 supports 里时用；带 episode/prefix 校验）。
    // 同一 claim 的多条 support 各有各的事实 ⇒ claimId 只留**第一条**兜底，不把后续的算冲突。
    if (Object.prototype.hasOwnProperty.call(entries, claimId)) {
      kept += 1;
      continue;
    }
    entries[claimId] = entry;
    added += 1;
  }
  const index = {
    version: RECOVERY_INDEX_VERSION,
    entries,
    supports,
    counts: { entries: Object.keys(entries).length, supports: Object.keys(supports).length },
  };
  return { index, added, kept, conflicts };
}

/** 原子写恢复索引（确定性字节：`stableText` 深排序，无时钟）。 */
export function writeRecoveryIndex(root, index) {
  const dir = path.resolve(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, RECOVERY_INDEX_FILE);
  const tmp = path.join(dir, `.tmp-recovery-index-${process.pid}-${Date.now().toString(36)}`);
  const buf = Buffer.from(stableText(index), 'utf8');
  const fd = fs.openSync(tmp, 'w');
  try {
    let offset = 0;
    while (offset < buf.length) offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响主错误 */ }
    throw err;
  }
  return target;
}

/**
 * 条目 id → 文件名安全编码。`t:repo:deadbeef` 这类 id 含 Windows 非法字符 `:`，
 * 编码后为 `t%3Arepo%3Adeadbeef`（可逆、大小写稳定、UTF-8 逐字节编码）。
 */
export function encodeId(id) {
  const raw = String(id ?? '');
  if (raw === '') throw new PersistError('persist: empty entry id', 'persist/invalid-id');
  let out = '';
  for (const ch of raw) {
    if (ID_SAFE.test(ch)) out += ch;
    else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  if (out === '.' || out === '..') {
    throw new PersistError(`persist: unsafe entry id "${raw}"`, 'persist/invalid-id');
  }
  if (out.length > MAX_ENCODED_ID) {
    throw new PersistError(`persist: entry id too long (${out.length} > ${MAX_ENCODED_ID}): ${raw.slice(0, 40)}…`, 'persist/invalid-id');
  }
  return out;
}

/** 文件名 → 条目 id（encodeId 的逆）。坏名字抛 `persist/invalid-id`。 */
export function decodeId(encoded) {
  try {
    return decodeURIComponent(String(encoded ?? ''));
  } catch (err) {
    throw new PersistError(`persist: undecodable file name "${encoded}": ${String(err?.message ?? err)}`, 'persist/invalid-id');
  }
}

/**
 * 相对路径合法性（store 内路径纪律）：必须是 `/` 分隔的相对路径，不含盘符、不以 / 开头、
 * 不含 `..` 与空段、不含反斜杠。
 * @returns {{ok:boolean, reason:string|null}}
 */
export function validateRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return { ok: false, reason: 'empty' };
  if (rel.includes('\\')) return { ok: false, reason: 'backslash' };
  if (/^[A-Za-z]:/.test(rel)) return { ok: false, reason: 'drive-letter' };
  if (rel.startsWith('/') || rel.startsWith('//')) return { ok: false, reason: 'absolute' };
  if (path.isAbsolute(rel)) return { ok: false, reason: 'absolute' };
  const segments = rel.split('/');
  if (segments.some((s) => s === '')) return { ok: false, reason: 'empty-segment' };
  if (segments.some((s) => s === '..')) return { ok: false, reason: 'escaping' };
  if (segments.some((s) => s === '.')) return { ok: false, reason: 'dot-segment' };
  return { ok: true, reason: null };
}

/**
 * 绝对路径 → 相对 `base` 的 store 路径（正斜杠）。
 * 跨盘/非法输入返回 null（宁可不存，也不存一个搬不走的路径）。
 */
export function relativizeSource(absPath, base) {
  if (typeof absPath !== 'string' || absPath === '') return null;
  if (typeof base !== 'string' || base === '') return null;
  try {
    const rel = path.relative(path.resolve(base), path.resolve(absPath));
    if (rel === '') return null;
    const posix = rel.split(path.sep).join('/');
    return posix;
  } catch {
    return null;
  }
}

/** 相对路径 + base → 绝对路径（读原件时用；越界/绝对/含 `..` 一律返回 null）。 */
export function resolveSource(relPath, base) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  if (typeof base !== 'string' || base === '') return null;
  const segments = relPath.split('/');
  if (segments.some((s) => s === '..')) return null;
  if (relPath.includes('\\') || /^[A-Za-z]:/.test(relPath) || relPath.startsWith('/')) return null;
  const abs = path.resolve(base, relPath);
  const back = path.relative(path.resolve(base), abs);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) return null;
  return abs;
}

/** 来源原件在不在：`present` | `missing`（missing ≠ 失效，只是原件不在本机）。 */
export function sourceStatusOf(relPath, base) {
  const abs = resolveSource(relPath, base);
  if (!abs) return 'missing';
  try {
    return fs.statSync(abs).isFile() ? 'present' : 'missing';
  } catch {
    return 'missing';
  }
}

/** 递归找出"声明为路径"的字段里的绝对路径（返回 `a.closure.logPath` 这样的位置串）。 */
export function findPathViolations(record, depth = 0, prefix = '') {
  const out = [];
  if (depth > MAX_PATH_SCAN_DEPTH || record === null || typeof record !== 'object') return out;
  if (Array.isArray(record)) {
    record.forEach((item, i) => out.push(...findPathViolations(item, depth + 1, `${prefix}[${i}]`)));
    return out;
  }
  for (const [key, value] of Object.entries(record)) {
    const at = prefix === '' ? key : `${prefix}.${key}`;
    if (SOURCE_PATH_KEYS.has(key) && typeof value === 'string' && value !== '') {
      const check = validateRelPath(value);
      if (!check.ok) out.push(`${at} (${check.reason})`);
    }
    if (value && typeof value === 'object') out.push(...findPathViolations(value, depth + 1, at));
  }
  return out;
}

function stripVolatile(record) {
  if (!record || typeof record !== 'object') return record;
  const copy = { ...record };
  const meta = copy[META_KEY];
  if (meta && typeof meta === 'object') {
    const trimmed = { ...meta };
    delete trimmed.updatedAt;
    copy[META_KEY] = trimmed;
  }
  return copy;
}

/**
 * 内容等价判定（幂等的地基）：忽略存储簿记 `_store` 与流程时间戳 `updatedAt`。
 * 用于 dry-run 预估"会写几条"、以及测试断言"两次入档内容相同"。
 */
export function sameMemoryContent(a, b) {
  const strip = (record) => {
    if (!record || typeof record !== 'object') return record;
    const copy = { ...record };
    delete copy[META_KEY];
    delete copy.updatedAt;
    return copy;
  };
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

function sameExceptClocks(a, b) {
  if (!b) return false;
  if (canonicalJson(stripVolatile(a)) === canonicalJson(stripVolatile(b))) return true;
  // 生产者可能把"生成时刻"塞进 updatedAt：内容一样就不算变更
  return sameMemoryContent(a, b);
}

/** 这条校验错误是不是落在**权威**条目上（权威不能被重算，也就不能被 rebuild"盖章通过"）。 */
export function isAuthoritativeProblem(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.code === 'manifest/unsupported-version' || error.code === 'manifest/invalid') return false;
  // 契约版本闸（schemaVersion）同属"程序与库不匹配"，不归到权威条目漂移里。
  if (error.code === 'manifest/unsupported-schema-version') return false;
  const p = error.path;
  if (typeof p !== 'string') return false;
  if (error.code === 'counts/mismatch') return AUTHORITATIVE_KINDS.includes(p);
  return AUTHORITATIVE_KINDS.some((kind) => p === kind || p.startsWith(`${kind}/`));
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

async function loadOptional(url) {
  try {
    return await import(url);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// createStore
// ---------------------------------------------------------------------------

/**
 * 打开（必要时创建）一个 sidecar store。
 * @param {{root:string, user?:string, now?:number|(()=>number), version?:number, schemaVersion?:number}} opts
 *        root = 记忆库根目录（`<DSH_HOME>/memory-context/`，测试用临时目录）。
 *        now  = 时钟注入（测试可固定；默认 Date.now）。
 *        version / schemaVersion = 仅测试用的版本注入（模拟"更新/更旧的程序写的库"）。
 * @returns {object} store（方法见文件头与下方注释）
 */
export function createStore(opts = {}) {
  if (!opts || typeof opts.root !== 'string' || opts.root.trim() === '') {
    throw new PersistError('persist: createStore({root}) 需要 root', 'persist/missing-root');
  }
  const root = path.resolve(opts.root);
  const user = typeof opts.user === 'string' && opts.user !== '' ? opts.user : DEFAULT_USER;
  const version = Number.isFinite(opts.version) ? opts.version : STORE_VERSION;
  const schemaVersion = Number.isFinite(opts.schemaVersion) ? opts.schemaVersion : MANIFEST_SCHEMA_VERSION;
  const clock = typeof opts.now === 'function' ? opts.now : () => (Number.isFinite(opts.now) ? opts.now : Date.now());
  // T62：**可选**的单文件 bundle 快路径（只有生产路径 sdk/plugin 打开；测试默认关 —— 见 walkbundle.mjs 的复用判据）。
  const useBundle = opts.bundle === true;

  let tmpSeq = 0;

  const manifestPath = path.join(root, MANIFEST_FILE);
  const indexPath = path.join(root, INDEX_FILE);
  const journalPath = path.join(root, JOURNAL_REL);

  // ---- 基础路径 ----

  function entryRel(kind, id) {
    assertKind(kind);
    return `${kind}/${encodeId(id)}.json`;
  }

  function entryPath(kind, id) {
    return path.join(root, entryRel(kind, id));
  }

  function ensureDirs() {
    fs.mkdirSync(root, { recursive: true });
    for (const dir of STORE_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true });
    return STORE_DIRS.slice();
  }

  // ---- 原子写 ----

  // T398（2026-11-20）：**目录创建只做一次**。原来每条记录都 `mkdirSync(recursive)`，
  // 归档一轮 9,000 条 topics 就是 9,000 次 mkdir 系统调用（外加递归 stat）。
  // 目录集合在一次 store 生命周期内基本不变，记一下命中集合即可，语义不变
  // （目录被外部删掉时会出现 ENOENT —— 那时 fallback 重试一次 mkdir）。
  const DIRS_READY = new Set();
  function ensureDir(dir) {
    if (DIRS_READY.has(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    DIRS_READY.add(dir);
  }
  /** T398：缓存可能过期（目录被别人删了 / 测试清了临时目录）⇒ 失败时重建并重试一次。 */
  function withDir(dir, fn) {
    try {
      return fn();
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EPERM')) {
        DIRS_READY.delete(dir);
        fs.mkdirSync(dir, { recursive: true });
        DIRS_READY.add(dir);
        return fn();
      }
      throw err;
    }
  }

  /**
   * D9（2026-11-20，主人裁定）：**记录类写入不 fsync**（manifest / journal / index 仍 fsync）。
   * 依据：微基准带 fsync 5.91ms/条、不带 1.46ms/条（4 倍）。
   * 保证变化：进程崩溃无差别（OS 缓存仍落盘）；**断电**时记录文件可能"名字在、内容截断"——
   * 由 `verify()` 的 sha256 检出、`rebuild` 修复。一致性根（manifest/journal）仍 fsync。
   */
  function writeAtomic(absTarget, text, opts = {}) {
    const doFsync = opts.fsync !== false;
    const dir = path.dirname(absTarget);
    ensureDir(dir);
    tmpSeq += 1;
    const tmp = path.join(dir, `.tmp-${process.pid}-${tmpSeq}-${Date.now().toString(36)}`);
    const buf = Buffer.from(text, 'utf8');
    // T398：目录缓存命中时若目录已被外部删除 ⇒ 这里会 ENOENT，withDir 会重建并重试一次。
    withDir(dir, () => {
      const fd = fs.openSync(tmp, 'w');
      try {
        let offset = 0;
        while (offset < buf.length) offset += fs.writeSync(fd, buf, offset, buf.length - offset);
        if (doFsync) fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    });
    try {
      fs.renameSync(tmp, absTarget);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响主错误 */ }
      throw err;
    }
  }

  /** 清掉崩溃留下的 .tmp 文件（永远不是条目，删掉安全）。 */
  function cleanupTmp() {
    const removed = [];
    for (const dir of ['.', ...STORE_DIRS]) {
      const abs = path.join(root, dir);
      for (const name of readDirSafe(abs)) {
        if (!name.startsWith('.tmp-')) continue;
        try {
          fs.unlinkSync(path.join(abs, name));
          removed.push(dir === '.' ? name : `${dir}/${name}`);
        } catch { /* 被占用就下次再来 */ }
      }
    }
    return { removed };
  }

  // ---- manifest ----

  // T392（2026-11-20）：**manifest 读取记忆化** —— 这是归档跑不完的**真正元凶**。
  //
  // 实测：真库 `manifest.json` 4.53 MB；`ensureCompatible()` 在**每次 put** 里调用 `readManifest()`，
  // 即每条记录都要 `readFileSync(4.5MB)` + `JSON.parse` ⇒ 单条 ~26ms。
  // 2000 条「内容完全没变」的记录实测耗时 **53,478ms**（written=0, unchanged=2000），
  // 26,238 条 topics 写入 242 秒 —— 全部对得上。
  //
  // 做法：按 `(mtimeMs, size)` 记忆化。manifest 每次写入都是原子替换（换 inode / 改 mtime），
  // 所以这个戳能可靠失效；本进程自己写完 manifest 时也会主动清缓存。
  let MANIFEST_MEMO = null; // { stamp, result }
  const manifestStamp = () => {
    try {
      const st = fs.statSync(manifestPath);
      return `${st.mtimeMs}:${st.size}`;
    } catch { return null; }
  };

  function readManifest() {
    const stamp = manifestStamp();
    if (stamp !== null && MANIFEST_MEMO && MANIFEST_MEMO.stamp === stamp) return MANIFEST_MEMO.result;
    let raw;
    try {
      raw = fs.readFileSync(manifestPath, 'utf8');
    } catch {
      return { manifest: null, error: 'missing' };
    }
    let result;
    try {
      result = { manifest: JSON.parse(raw), error: null, raw };
    } catch (err) {
      result = { manifest: null, error: 'invalid', message: String(err?.message ?? err), raw };
    }
    if (stamp !== null) MANIFEST_MEMO = { stamp, result };
    return result;
  }

  /**
   * schema 版本闸（**写侧**）：不认识的字段形状必须显式报错，不许静默降级（契约 §7）。
   * 缺 `schemaVersion` = 老库（`MANIFEST_SCHEMA_VERSION_LEGACY`）⇒ 放行，下一次 writeManifest 补上该字段
   * （一次性升级，之后字节稳定）。
   */
  function assertManifestSchema(manifest) {
    const found = manifestSchemaVersionOf(manifest);
    if (!Number.isInteger(found) || !MANIFEST_SCHEMA_SUPPORTED.includes(found)) {
      throw new PersistError(
        `persist: unsupported manifest schemaVersion ${JSON.stringify(found)} (期望 ${schemaVersion})`,
        'store/unsupported-schema-version',
        { found, expected: schemaVersion },
      );
    }
    return found;
  }

  /** 写入侧的版本闸：不认识的版本必须明确报错，不许静默降级（契约 §7）。 */
  function ensureCompatible() {
    const { manifest, error } = readManifest();
    if (error === 'missing') return null;
    if (error === 'invalid') {
      throw new PersistError('persist: manifest.json 无法解析（先 rebuild 或人工修复）', 'store/manifest-invalid');
    }
    if (manifest?.version !== version) {
      throw new PersistError(
        `persist: unsupported manifest version ${JSON.stringify(manifest?.version)} (期望 ${version})`,
        'store/unsupported-version',
        { found: manifest?.version, expected: version },
      );
    }
    assertManifestSchema(manifest);
    return manifest;
  }

  /** 全目录快照：每个条目文件的 sha256 + 各 kind 条目数（一次遍历）。 */
  // T394（2026-11-20）：**checksum 缓存** —— manifest/verify 都对 6.3 万个文件重算 sha256，
  // 实测 `writeManifest` 36.6 秒、`verify` 32.1 秒，两次都是全量读盘 + 哈希。
  // 做法：按 `(mtimeMs, size)` 命中就复用上次的 sha256（内容没变 ⇒ sha 必然相同），
  // 只对变化的文件重算。缓存落盘在 `<root>/.cache/checksums.json`，跨进程复用。
  const CK_PATH = path.join(root, KIND_BUNDLE_DIR_T394, 'checksums.json');
  let CK_MEMO = null; // Map<rel, [mtimeMs, size, sha]>
  let CK_DIRTY = false;
  function loadCk() {
    if (CK_MEMO) return CK_MEMO;
    try {
      const raw = JSON.parse(fs.readFileSync(CK_PATH, 'utf8'));
      const files = raw && raw.version === 1 && raw.files && typeof raw.files === 'object' ? raw.files : {};
      CK_MEMO = new Map(Object.entries(files));
    } catch {
      CK_MEMO = new Map();
    }
    return CK_MEMO;
  }
  function saveCk() {
    if (!CK_DIRTY) return;
    try {
      fs.mkdirSync(path.dirname(CK_PATH), { recursive: true });
      const obj = Object.fromEntries(loadCk());
      const tmp = `${CK_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, files: obj }), 'utf8');
      fs.renameSync(tmp, CK_PATH);
      CK_DIRTY = false;
    } catch { /* 缓存写失败不影响正确性 */ }
  }
  /** 读文件并算 sha256；命中缓存就跳过读盘。返回 { buf, sha, bytes }。 */
  function checksumOf(abs, rel) {
    const st = statSafe(abs);
    const memo = loadCk();
    const hit = st?.isFile() ? memo.get(rel) : null;
    if (hit && hit[0] === st.mtimeMs && hit[1] === st.size) return { buf: null, sha: hit[2], bytes: st.size };
    const buf = fs.readFileSync(abs);
    const sha = sha256(buf);
    if (st?.isFile()) { memo.set(rel, [st.mtimeMs, st.size, sha]); CK_DIRTY = true; }
    return { buf, sha, bytes: buf.length };
  }

  function snapshot() {
    const files = new Map();
    const counts = {};
    const issues = [];
    let bytes = 0;
    for (const kind of ENTRY_KINDS) {
      const dir = path.join(root, kind);
      let n = 0;
      for (const name of readDirSafe(dir)) {
        if (name.startsWith('.tmp-')) {
          issues.push({ code: 'file/tmp', path: `${kind}/${name}` });
          continue;
        }
        if (!name.endsWith('.json')) {
          issues.push({ code: 'file/unknown', path: `${kind}/${name}` });
          continue;
        }
        const abs = path.join(dir, name);
        const rel = `${kind}/${name}`;
        const ck = checksumOf(abs, rel);
        bytes += ck.bytes;
        files.set(rel, ck.sha);
        n += 1;
      }
      counts[kind] = n;
    }
    const indexStat = statSafe(indexPath);
    if (indexStat?.isFile()) {
      const ck = checksumOf(indexPath, INDEX_FILE);
      bytes += ck.bytes;
      files.set(INDEX_FILE, ck.sha);
    }
    saveCk(); // T394：把本次算过/命中过的指纹落盘，下次跨进程复用
    return { files, counts, issues, bytes };
  }

  /**
   * 派生目录（topics/links/threads/）的 checksums 摘要 —— 增量派生的**状态校验**用。
   * 为什么不拿整份 manifest：权威侧（episodes/claims/joseki）的簿记变化与派生无关，
   * 用整份摘要会让增量路径每轮失效；只看派生目录才是"派生文件没被外人动过"的准确判据。
   * 成本：manifest 已在 readManifest 里记忆化，这里只是遍历 checksums 的键。
   */
  function derivedDigest() {
    const { manifest } = readManifest();
    const sums = manifest?.checksums && typeof manifest.checksums === 'object' ? manifest.checksums : {};
    const lines = [];
    for (const rel of Object.keys(sums).sort()) {
      if (!DERIVED_KINDS.some((kind) => rel.startsWith(`${kind}/`))) continue;
      lines.push(`${rel}:${sums[rel]}`);
    }
    return sha256(lines.join(String.fromCharCode(10)));
  }

  function sortedChecksums(files) {
    const out = {};
    for (const key of [...files.keys()].sort()) out[key] = files.get(key);
    return out;
  }

  /**
   * 写 manifest。**无变更不重写**（保持 updatedAt 稳定 ⇒ 两次入档 manifest 字节相同）。
   * @returns {{changed:boolean, manifest:object}}
   */
  function writeManifest(at) {
    ensureCompatible();
    const now = Number.isFinite(at) ? at : clock();
    const snap = snapshot();
    const previous = readManifest();
    const prev = previous.manifest;
    const next = {
      version,
      schemaVersion,
      schema: STORE_SCHEMA,
      user,
      createdAt: Number.isFinite(prev?.createdAt) ? prev.createdAt : now,
      updatedAt: now,
      pathPolicy: PATH_POLICY,
      counts: snap.counts,
      files: snap.files.size,
      bytes: snap.bytes,
      checksums: sortedChecksums(snap.files),
    };
    if (prev && canonicalJson({ ...prev, updatedAt: 0 }) === canonicalJson({ ...next, updatedAt: 0 })) {
      return { changed: false, manifest: prev };
    }
    writeAtomic(manifestPath, stableText(next));
    return { changed: true, manifest: next };
  }

  // ---- 条目读写 ----

  function assertKind(kind) {
    if (!ENTRY_KINDS.includes(kind)) {
      throw new PersistError(`persist: unknown kind "${kind}"（允许：${ENTRY_KINDS.join(' / ')}）`, 'persist/unknown-kind');
    }
  }

  function prepare(kind, record) {
    assertKind(kind);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new PersistError(`persist: ${kind} 条目必须是对象`, 'persist/invalid-record');
    }
    const id = record.id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new PersistError(`persist: ${kind} 条目缺 id（无 id 不入馆）`, 'persist/missing-id');
    }
    const violations = findPathViolations(record);
    if (violations.length > 0) {
      throw new PersistError(
        `persist: ${kind}/${id} 含绝对路径（搬库后会失效）：${violations.join(', ')}`,
        'persist/absolute-path',
        { violations },
      );
    }
    return record;
  }

  function readRecord(kind, id) {
    const abs = entryPath(kind, id);
    let raw;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new PersistError(
        `persist: ${kind}/${id} JSON 损坏：${String(err?.message ?? err)}`,
        'persist/corrupt-record',
      );
    }
  }

  // T393（2026-11-20）：**journal 批量落盘**。
  // 原来每条记录都 open + write + fsyncSync + close —— 单次 fsync 在 Windows 上毫秒级，
  // 上万条权威写入就是几十到上百秒。改为同批次内缓冲、批次结束一次写入 + 一次 fsync。
  // 数据文件本身仍是逐条原子写；journal 只用于崩溃后定位重放。
  let JOURNAL_BUF = [];
  let JOURNAL_BATCH = 0; // >0 表示在 putMany/replaceDerived 批次内，批次末统一 flush
  const JOURNAL_FLUSH_AT = 512;
  function flushJournal() {
    if (JOURNAL_BUF.length === 0) return;
    const payload = JOURNAL_BUF.join('');
    JOURNAL_BUF = [];
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const fd = fs.openSync(journalPath, 'a');
    try {
      fs.writeSync(fd, Buffer.from(payload, 'utf8'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  function appendJournal(entry) {
    const line = JSON.stringify({
      v: 1,
      schema: STORE_SCHEMA,
      at: entry.at,
      op: entry.op,
      kind: entry.kind,
      id: entry.id,
      path: entry.path,
      sha256: entry.sha256 ?? null,
      prevSha256: entry.prevSha256 ?? null,
    });
    JOURNAL_BUF.push(line + String.fromCharCode(10));
    // T393：批次内先攒着（批次末一次 fsync）；不属于任何批次（单条 put）则立刻落盘，
    // 保持"put 返回 = journal 已落盘"的原语义（R15 的幂等/截断恢复测试依赖这一点）。
    if (JOURNAL_BATCH === 0 || JOURNAL_BUF.length >= JOURNAL_FLUSH_AT) flushJournal();
  }

  /**
   * 读 journal。**坏尾不抛**：崩溃截断的最后一行丢掉并计数（journal 只是审计/恢复线索，
   * 不是权威数据；权威是各 kind 目录里的条目文件）。
   */
  function readJournal() {
    let raw;
    try {
      raw = fs.readFileSync(journalPath, 'utf8');
    } catch {
      return { records: [], parsed: 0, missing: true, dropped: { partialTail: 0, badLines: 0 } };
    }
    const records = [];
    let partialTail = 0;
    let badLines = 0;
    const segments = raw.split('\n');
    const endsWithNewline = raw.endsWith('\n');
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment.trim() === '') continue;
      const isTail = i === segments.length - 1;
      try {
        records.push(JSON.parse(segment));
      } catch {
        if (!endsWithNewline && isTail) partialTail += 1;
        else badLines += 1;
      }
    }
    return { records, parsed: records.length, missing: false, dropped: { partialTail, badLines } };
  }

  /**
   * 写一个条目（原子）。内容相同 ⇒ 不写、不追加 journal、返回 changed:false（幂等）。
   * @returns {{changed:boolean, id:string, path:string, sha256:string}}
   */
  function put(kind, record, putOpts = {}) {
    ensureCompatible();
    const rec = prepare(kind, record);
    const at = Number.isFinite(putOpts.at) ? putOpts.at : clock();
    const rel = entryRel(kind, rec.id);
    const abs = path.join(root, rel);

    // 读旧值（原文 + 解析）：坏 JSON 不许被静默覆盖（只增不改的底线）
    let prevRaw = null;
    try {
      prevRaw = fs.readFileSync(abs, 'utf8');
    } catch {
      prevRaw = null;
    }
    let previous = null;
    if (prevRaw !== null) {
      try {
        previous = JSON.parse(prevRaw);
      } catch (err) {
        throw new PersistError(
          `persist: ${kind}/${rec.id} 现有文件 JSON 损坏，拒绝覆盖：${String(err?.message ?? err)}`,
          'persist/corrupt-record',
        );
      }
    }

    const prevMeta = previous?.[META_KEY] && typeof previous[META_KEY] === 'object' ? previous[META_KEY] : null;
    const meta = rec[META_KEY] && typeof rec[META_KEY] === 'object' ? { ...rec[META_KEY] } : {};
    if (prevMeta && Number.isFinite(prevMeta.createdAt)) meta.createdAt = prevMeta.createdAt;
    if (!Number.isFinite(meta.createdAt)) meta.createdAt = at;
    const candidate = { ...rec, [META_KEY]: meta };

    // 首见时钟（第二时钟）不因重放而漂移：recordedAt/createdAt 取旧值
    if (previous) {
      for (const field of ['recordedAt', 'createdAt']) {
        if (previous[field] !== undefined) candidate[field] = previous[field];
      }
      // T-15：失效标注是"只增不改"的追加字段 ⇒ 已判定的不因重放/重算消失或改口。
      //   · expiredAt = **首次判定时刻**（历史判定不搬家）
      //   · invalidAt = 失效起点，证据累积只会更早 ⇒ 取更小的那个（两处都遵守同一条规则）
      if (Number.isFinite(previous.invalidAt)) {
        candidate.invalidAt = Number.isFinite(candidate.invalidAt)
          ? Math.min(previous.invalidAt, candidate.invalidAt)
          : previous.invalidAt;
      }
      if (Number.isFinite(previous.expiredAt)) candidate.expiredAt = previous.expiredAt;
    }
    if (sameExceptClocks(candidate, previous)) {
      // 同内容重放：不写盘、不追加 journal、不动 updatedAt（幂等）
      return { changed: false, id: rec.id, path: rel, sha256: sha256(prevRaw) };
    }

    const next = { ...rec, [META_KEY]: { ...meta, updatedAt: at } };
    const text = stableText(next);
    // D9：记录文件不 fsync（manifest/journal 仍 fsync）
    writeAtomic(abs, text, { fsync: false });
    const hash = sha256(text);
    appendJournal({
      at,
      op: 'put',
      kind,
      id: rec.id,
      path: rel,
      sha256: hash,
      prevSha256: prevRaw ? sha256(prevRaw) : null,
    });
    return { changed: true, id: rec.id, path: rel, sha256: hash };
  }

  /**
   * T-15 / P1-1：双时态失效的**写入侧规划**（判据本体在 R09 `applyTemporalInvalidation`，这里不做任何判断）。
   *
   * 为什么必须在写盘**前**算：判定要看「库内既有 + 本轮提交」的合成视图（新值到达 ⇒ 旧值失效；
   * 旧值这次才被本轮带进来 ⇒ 也要当场打区间），写完再算就要重写一遍，journal 会多出一倍条目。
   *
   * @param {object[]} incoming 本轮提交的 claims（顺序即写盘顺序）
   * @param {number|null} at 判定时刻
   * @returns {{incoming: object[], alsoWrite: object[], expired: {count:number, ids:string[], written:number}}}
   *   - `incoming`：本轮提交的条目（被判失效的已带上 invalidAt/expiredAt），长度与顺序不变
   *   - `alsoWrite`：**既有**条目里这次新被判失效、且不在本轮提交里的（只追加这两个字段）
   *   - `expired.written`：`alsoWrite` 里真的写盘（内容变了）的条数
   */
  function planClaimExpiry(incoming, at) {
    const stored = list('claims').map((entry) => entry.record).filter((r) => r && typeof r.id === 'string');
    const merged = new Map(stored.map((record) => [record.id, record]));
    for (const record of incoming) merged.set(record.id, record); // 本轮内容为准（与本轮写盘口径一致）
    const judged = applyTemporalInvalidation({ claims: [...merged.values()], now: Number.isFinite(at) ? at : clock() });
    const empty = { count: 0, ids: [], written: 0 };
    if (judged.expired.length === 0) return { incoming, alsoWrite: [], expired: empty };

    const nextById = new Map(judged.claims.map((claim) => [claim.id, claim]));
    const incomingIds = new Set(incoming.map((record) => record.id));
    const batch = incoming.map((record) => nextById.get(record.id) ?? record);
    const alsoWrite = [];
    const ids = [];
    for (const row of judged.expired) {
      if (!row.changed) continue; // 已判定过的标注不重复写（幂等）
      ids.push(row.id);
      if (incomingIds.has(row.id)) continue; // 本轮提交的条目走正常写盘路径
      // 盘面为准：`list()` 在生产 store 上可能来自 bundle 快照（同一进程里可能已旧），
      // 拿旧副本回写会把该条目的其他更新一起冲掉 ⇒ 这里逐条读原文再只加两个字段。
      const fresh = readRecord('claims', row.id) ?? nextById.get(row.id);
      if (!fresh) continue;
      alsoWrite.push({ ...fresh, invalidAt: row.invalidAt, expiredAt: row.expiredAt });
    }
    return { incoming: batch, alsoWrite, expired: { count: ids.length, ids, written: 0 } };
  }

  function putMany(kind, records, putOpts = {}) {
    const list = (Array.isArray(records) ? records : []).filter(Boolean);
    const ordered = [...list].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    const at = Number.isFinite(putOpts.at) ? putOpts.at : clock();
    JOURNAL_BATCH += 1;
    let results;
    let expiry = null;
    try {
      // 双时态失效只对 claim 生效（link 侧同类规则由 P1-2 独立落地，本 room 不越界）。
      const plan = kind === 'claims' && ordered.length > 0
        ? planClaimExpiry(ordered, at)
        : { incoming: ordered, alsoWrite: [], expired: { count: 0, ids: [], written: 0 } };
      results = plan.incoming.map((record) => put(kind, record, putOpts));
      const appended = plan.alsoWrite.map((record) => put(kind, record, putOpts));
      if (plan.expired.count > 0 || appended.length > 0) {
        expiry = { count: plan.expired.count, ids: plan.expired.ids, written: appended.filter((r) => r.changed).length };
      }
    } finally {
      JOURNAL_BATCH -= 1;
      flushJournal(); // T393：批次末统一落盘（一次 fsync）
    }
    const out = {
      kind,
      total: results.length,
      written: results.filter((r) => r.changed).length,
      unchanged: results.filter((r) => !r.changed).length,
      results,
    };
    // 只增字段：没发生双时态失效的批次返回值与旧版逐键相同（不凭空多出 expired 键）
    if (expiry) out.expired = expiry;
    return out;
  }

  function get(kind, id) {
    return readRecord(kind, id);
  }

  /**
   * 列出一个 kind 的条目。损坏文件不抛（默认 skip），带上 error 字段。
   * @returns {Array<{id:string, path:string, record:object|null, error?:string}>}
   */
  function list(kind, listOpts = {}) {
    assertKind(kind);
    // T62：bundle 命中就直接返回（真库 6.9 秒 → 不到 1 秒）。只在**生产 store** 上启用。
    const bundleOn = useBundle && !listOpts.strict && WALK_BUNDLE_KINDS.includes(kind);
    if (bundleOn) {
      // T374：`slim: true` ⇒ 只读精简字段（热路径用：stats / recent_failures 不需要 closure 数组）。
      const hit = readKindBundleCached(root, kind, { slim: listOpts.slim === true });
      if (hit) return hit.map((record) => ({ id: record?.id ?? null, path: `${kind}/${record?.id ?? ''}.json`, record }));
    }
    const dir = path.join(root, kind);
    const out = [];
    for (const name of readDirSafe(dir)) {
      if (name.startsWith('.') || !name.endsWith('.json')) continue;
      let id;
      try {
        id = decodeId(name.slice(0, -'.json'.length));
      } catch {
        out.push({ id: name, path: `${kind}/${name}`, record: null, error: 'invalid-id' });
        continue;
      }
      try {
        out.push({ id, path: `${kind}/${name}`, record: readRecord(kind, id) });
      } catch (err) {
        if (listOpts.strict) throw err;
        out.push({ id, path: `${kind}/${name}`, record: null, error: String(err?.code ?? err?.message ?? err) });
      }
    }
    // T62：慢路径读完补写 bundle（只有全绿才写 —— 有坏文件就不拿它当缓存，免得把错误固化）
    if (bundleOn && out.every((item) => item.record)) {
      try { writeKindBundle(root, kind, out.map((item) => item.record)); } catch { /* 缓存失败无所谓 */ }
    }
    return out;
  }

  /** 只有文件名层面的 id 列表（不解析内容，构建重算用）。 */
  function ids(kind) {
    assertKind(kind);
    const out = [];
    for (const name of readDirSafe(path.join(root, kind))) {
      if (name.startsWith('.') || !name.endsWith('.json')) continue;
      try {
        out.push(decodeId(name.slice(0, -'.json'.length)));
      } catch { /* 坏名跳过 */ }
    }
    return out;
  }

  function counts() {
    const out = {};
    for (const kind of ENTRY_KINDS) out[kind] = ids(kind).length;
    return out;
  }

  /**
   * 整目录替换一个**派生** kind：写新的 + 删掉本 kind 里不再需要的文件。
   * 只允许派生 kind（权威条目永远不删，只增不改）。
   */
  function replaceDerived(kind, records, opts = {}) {
    if (!DERIVED_KINDS.includes(kind)) {
      throw new PersistError(
        `persist: ${kind} 是权威目录，不能被 rebuild 替换（只增不改）`,
        'persist/authoritative-kind',
      );
    }
    const at = Number.isFinite(opts.at) ? opts.at : clock();
    const list = (Array.isArray(records) ? records : []).filter(Boolean);
    const wanted = new Set(list.map((r) => String(r.id)));
    JOURNAL_BATCH += 1;
    let written;
    try {
      written = putMany(kind, list, { at });
    } finally {
      JOURNAL_BATCH -= 1;
    }
    const removed = [];
    for (const id of ids(kind)) {
      if (wanted.has(id)) continue;
      const rel = entryRel(kind, id);
      try {
        fs.unlinkSync(path.join(root, rel));
        appendJournal({ at, op: 'delete', kind, id, path: rel, sha256: null });
        removed.push(rel);
      } catch { /* 删不掉就留着，下次 rebuild 再来 */ }
    }
    flushJournal(); // T393：删完再统一落盘
    return { kind, total: list.length, written: written.written, unchanged: written.unchanged, removed };
  }

  /**
   * 只删**显式给出**的派生 id（增量路径用：不做 `ids()` 全扫）。
   * 与 `replaceDerived` 的区别：这里没有"整目录替换"语义 —— 没点名的记录一条都不动。
   * @returns {{kind:string, removed:string[], skipped:string[]}}
   */
  function deleteDerived(kind, ids, delOpts = {}) {
    if (!DERIVED_KINDS.includes(kind)) {
      throw new PersistError(
        `persist: ${kind} 是权威目录，不能删除条目（只增不改）`,
        'persist/authoritative-kind',
      );
    }
    const at = Number.isFinite(delOpts.at) ? delOpts.at : clock();
    const removed = [];
    const failed = [];
    const list = Array.isArray(ids) ? ids : [];
    if (list.length === 0) return { kind, removed, skipped: failed };
    JOURNAL_BATCH += 1;
    try {
      for (const id of list) {
        const rel = entryRel(kind, id);
        try {
          fs.unlinkSync(path.join(root, rel));
          appendJournal({ at, op: 'delete', kind, id, path: rel, sha256: null });
          removed.push(rel);
        } catch {
          failed.push(id); // 删不掉就留着：下次增量/全量会再判一次，绝不假装删了
        }
      }
    } finally {
      JOURNAL_BATCH -= 1;
      flushJournal();
    }
    return { kind, removed, skipped: failed };
  }

  // ---- index.md ----

  function writeIndex(markdown, opts = {}) {
    if (typeof markdown !== 'string') return { changed: false, path: INDEX_FILE };
    const at = Number.isFinite(opts.at) ? opts.at : clock();
    let previous = null;
    try { previous = fs.readFileSync(indexPath, 'utf8'); } catch { /* 首次 */ }
    if (previous === markdown) return { changed: false, path: INDEX_FILE };
    writeAtomic(indexPath, markdown);
    appendJournal({ at, op: 'index', kind: 'index', id: INDEX_FILE, path: INDEX_FILE, sha256: sha256(markdown) });
    return { changed: true, path: INDEX_FILE, sha256: sha256(markdown) };
  }

  function readIndex() {
    try {
      return fs.readFileSync(indexPath, 'utf8');
    } catch {
      return null;
    }
  }

  // ---- verify ----

  /**
   * 校验 manifest 版本 / checksums / 必需文件 / 路径纪律 / 计数一致性。
   * @returns {{ok:boolean, errors:Array, warnings:Array, checked:object, counts:object}}
   */
  function verify() {
    const t0 = Date.now();
    const errors = [];
    const warnings = [];
    const manifestRead = readManifest();
    const manifest = manifestRead.manifest;

    if (manifestRead.error === 'missing') {
      errors.push({
        code: 'manifest/missing',
        path: MANIFEST_FILE,
        message: 'memoryRoot 里没有 manifest.json：不是已入馆的记忆库',
        hint: '在这个目录跑一次 rebuild（或重新入档）',
      });
    } else if (manifestRead.error === 'invalid') {
      errors.push({
        code: 'manifest/invalid',
        path: MANIFEST_FILE,
        message: `manifest.json 无法解析：${manifestRead.message ?? ''}`,
        hint: '人工修复或从备份恢复；不要手改条目来"凑"校验',
      });
    } else {
      if (manifest?.version !== STORE_VERSION) {
        errors.push({
          code: 'manifest/unsupported-version',
          path: MANIFEST_FILE,
          message: `未知 store 版本 ${JSON.stringify(manifest?.version)}（本程序支持 ${STORE_VERSION}）`,
          hint: '升级程序或用发出版本的程序打开；不允许静默降级',
        });
      }
      // schema 版本闸（读侧）：缺字段 = 老库（0）照常读；不在支持表里 ⇒ 显式报错。
      const manifestSchema = manifestSchemaVersionOf(manifest);
      if (!Number.isInteger(manifestSchema) || !MANIFEST_SCHEMA_SUPPORTED.includes(manifestSchema)) {
        errors.push({
          code: 'manifest/unsupported-schema-version',
          path: MANIFEST_FILE,
          message: `未知 manifest schemaVersion ${JSON.stringify(manifestSchema)}（本程序支持 ${MANIFEST_SCHEMA_SUPPORTED.join(' / ')}）`,
          hint: '升级程序或用发出版本的程序打开；不允许静默降级',
        });
      }
      if (manifest?.pathPolicy !== PATH_POLICY) {
        errors.push({
          code: 'manifest/path-policy',
          path: MANIFEST_FILE,
          message: `pathPolicy 必须是 "${PATH_POLICY}"，实际 ${JSON.stringify(manifest?.pathPolicy)}`,
        });
      }
      if (typeof manifest?.user !== 'string' || manifest.user === '') {
        errors.push({ code: 'manifest/user', path: MANIFEST_FILE, message: 'manifest.user 必须是非空字符串（默认 owner）' });
      }
      if (!Number.isFinite(manifest?.createdAt) || !Number.isFinite(manifest?.updatedAt)) {
        errors.push({ code: 'manifest/clock', path: MANIFEST_FILE, message: 'manifest.createdAt/updatedAt 必须是 epoch ms' });
      }
    }

    // 必需目录
    for (const dir of STORE_DIRS) {
      const st = statSafe(path.join(root, dir));
      if (!st?.isDirectory()) errors.push({ code: 'dir/missing', path: dir, message: `缺目录 ${dir}/` });
    }

    // checksums
    const checksums = manifest?.checksums && typeof manifest.checksums === 'object' ? manifest.checksums : {};
    let checkedFiles = 0;
    let checkedBytes = 0;
    const listed = new Set();
    for (const rel of Object.keys(checksums).sort()) {
      listed.add(rel);
      const check = validateRelPath(rel);
      if (!check.ok) {
        errors.push({
          code: 'path/absolute',
          path: rel,
          message: `manifest.checksums 的 key 必须是相对 root 的路径（${check.reason}）`,
          hint: '搬库契约 §4.11 规则 2',
        });
        continue;
      }
      const abs = path.join(root, rel);
      let buf;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        errors.push({ code: 'file/missing', path: rel, message: `清单里的文件不存在：${rel}` });
        continue;
      }
      checkedFiles += 1;
      checkedBytes += buf.length;
      const actual = sha256(buf);
      if (actual !== checksums[rel]) {
        errors.push({
          code: 'checksum/mismatch',
          path: rel,
          message: `内容被改动：${rel}（manifest ${String(checksums[rel]).slice(0, 12)}… / 实际 ${actual.slice(0, 12)}…）`,
          hint: '权威条目被改 = 只增不改被破坏；派生条目改 = 跑 rebuild 重算',
        });
      }
    }

    // 磁盘上未入清单的文件 + 计数一致性
    const actualCounts = {};
    for (const kind of ENTRY_KINDS) {
      let n = 0;
      for (const name of readDirSafe(path.join(root, kind))) {
        const rel = `${kind}/${name}`;
        if (name.startsWith('.tmp-')) {
          warnings.push({ code: 'file/tmp', path: rel, message: '崩溃残留的 .tmp（rebuild 会清掉）' });
          continue;
        }
        if (!name.endsWith('.json')) {
          warnings.push({ code: 'file/unknown', path: rel, message: '目录里的非条目文件（不进 manifest）' });
          continue;
        }
        n += 1;
        if (!listed.has(rel)) {
          errors.push({
            code: 'file/unlisted',
            path: rel,
            message: `${rel} 不在 manifest.checksums 里（入档被中断，或有人手放文件）`,
            hint: '跑 rebuild 重新生成清单',
          });
        }
      }
      actualCounts[kind] = n;
    }
    if (statSafe(indexPath)?.isFile() && !listed.has(INDEX_FILE)) {
      errors.push({ code: 'file/unlisted', path: INDEX_FILE, message: 'index.md 不在 manifest.checksums 里', hint: '跑 rebuild' });
    }
    if (manifest?.counts && typeof manifest.counts === 'object') {
      for (const kind of ENTRY_KINDS) {
        if (manifest.counts[kind] !== actualCounts[kind]) {
          errors.push({
            code: 'counts/mismatch',
            path: kind,
            message: `manifest.counts.${kind}=${JSON.stringify(manifest.counts[kind])}，实际 ${actualCounts[kind]} 个文件`,
            hint: '跑 rebuild',
          });
        }
      }
    }

    // 路径纪律：条目里声明的来源路径必须是相对路径（不存绝对路径）
    for (const entry of list('episodes')) {
      if (!entry.record) {
        warnings.push({ code: 'record/corrupt', path: entry.path, message: `条目 JSON 损坏：${entry.error}` });
        continue;
      }
      const violations = findPathViolations(entry.record);
      if (violations.length) {
        errors.push({
          code: 'path/absolute',
          path: entry.path,
          message: `条目含绝对路径：${violations.join(', ')}`,
          hint: '搬库契约 §4.11 规则 2：路径一律相对',
        });
      }
    }

    // journal 只做健康提示，不参与 checksums（append-only 审计，不是权威数据）
    const journal = readJournal();
    if (journal.dropped.partialTail > 0) {
      warnings.push({ code: 'journal/partial-tail', path: JOURNAL_REL, message: 'journal 尾行被截断（崩溃残留），已按前缀读取' });
    }
    if (journal.dropped.badLines > 0) {
      warnings.push({ code: 'journal/bad-lines', path: JOURNAL_REL, message: `journal 有 ${journal.dropped.badLines} 行无法解析` });
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      checked: {
        files: checkedFiles,
        bytes: checkedBytes,
        dirs: STORE_DIRS.filter((d) => statSafe(path.join(root, d))?.isDirectory()).length,
        journalRecords: journal.parsed,
      },
      counts: actualCounts,
      manifest: manifest
        ? { version: manifest.version, schemaVersion: manifestSchemaVersionOf(manifest), user: manifest.user, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, counts: manifest.counts, pathPolicy: manifest.pathPolicy }
        : null,
      elapsedMs: Date.now() - t0,
    };
  }

  // ---- rebuild ----

  /**
   * 从权威条目（episodes/joseki/claims/adjudications 里的 episodes 为主）重算派生：
   * topics/ links/ threads/ + index.md，然后重写 manifest。
   * @param {{derive?:object, at?:number}} opts derive 可注入（测试用），默认动态 import R04/R05/R07/R06
   * @returns {Promise<object>} 摘要（含 skipped：缺哪个房间就明说，不假装成功）
   */
  async function rebuild(opts = {}) {
    ensureCompatible();
    ensureDirs();
    const at = Number.isFinite(opts.at) ? opts.at : clock();
    const started = Date.now();

    // 权威条目坏了 ⇒ 拒绝重建索引并拒绝重写 manifest：
    // 否则 rebuild 会把"手改/损坏的权威内容"的 sha256 盖进 manifest，等于替篡改背书。
    const pre = verify();
    const manifestBroken = pre.errors.some((e) => e.code === 'manifest/missing' || e.code === 'manifest/invalid');
    const authoritativeProblems = pre.errors.filter(isAuthoritativeProblem);
    if (!manifestBroken && authoritativeProblems.length > 0) {
      return {
        refused: true,
        reason: 'authoritative-drift',
        errors: authoritativeProblems,
        hint: '权威条目只能由入档方从原件重建；先恢复/重新入档，再 rebuild（只增不改）',
        elapsedMs: Date.now() - started,
      };
    }

    const cleaned = cleanupTmp();

    const episodes = list('episodes')
      .filter((e) => e.record)
      .map((e) => e.record)
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

    const derived = await deriveStore({ episodes, derive: opts.derive ?? null, at });
    const result = { cleaned: cleaned.removed, derived: {}, skipped: derived.skipped };

    result.derived.topics = replaceDerived('topics', derived.topics, { at });
    result.derived.links = replaceDerived('links', derived.links, { at });
    if (Array.isArray(derived.threads)) {
      result.derived.threads = replaceDerived('threads', derived.threads, { at });
    } else {
      result.derived.threads = { kind: 'threads', skipped: true, total: 0, written: 0, unchanged: 0, removed: [] };
    }
    result.derived.index = typeof derived.indexMd === 'string'
      ? writeIndex(derived.indexMd, { at })
      : { changed: false, skipped: true };
    result.manifest = writeManifest(at);
    // 增量派生的状态缓存：rebuild 是全量口径 ⇒ 顺手把"这一版派生"的指纹记下来，
    // 下一次归档判定"谁变了"才是准的（不写也不会错，只是下一轮会退化成全量）。
    try {
      const activeEpisodes = episodes.filter((e) => (e.state ?? 'archived') === 'archived');
      const state = makeDeriveState({
        mode: 'full',
        n: activeEpisodes.length,
        episodes: activeEpisodes,
        counts: {
          episodes: activeEpisodes.length,
          topics: derived.topics.length,
          links: derived.links.length,
          threads: Array.isArray(derived.threads) ? derived.threads.length : null,
          mentions: derived.mentions.length,
          indexBytes: typeof derived.indexMd === 'string' ? Buffer.byteLength(derived.indexMd, 'utf8') : 0,
        },
        at,
      });
      state.derived = derivedDigest();
      result.deriveState = writeDeriveState(root, state);
    } catch (err) {
      result.deriveState = { error: String(err?.message ?? err) };
    }
    result.episodes = episodes.length;
    result.elapsedMs = Date.now() - started;
    return result;
  }

  return {
    // 身份与路径
    root,
    user,
    version,
    schemaVersion,
    manifestPath,
    indexPath,
    journalPath,
    indexRelPath: INDEX_FILE,
    journalRelPath: JOURNAL_REL,
    dirs: STORE_DIRS.slice(),
    // 基础
    ensureDirs,
    entryPath: (kind, id) => entryPath(kind, id),
    entryRelPath: (kind, id) => entryRel(kind, id),
    resolveWithin(rel) {
      const check = validateRelPath(rel);
      if (!check.ok) throw new PersistError(`persist: 非法相对路径 "${rel}"（${check.reason}）`, 'persist/invalid-path');
      return path.join(root, rel);
    },
    relativize: (absPath, base) => relativizeSource(absPath, base ?? root),
    // 写
    put,
    putMany,
    replaceDerived,
    deleteDerived,
    derivedDigest,
    readDeriveState: () => readDeriveState(root),
    writeDeriveState: (state) => writeDeriveState(root, state),
    appendJournal,
    writeIndex,
    writeManifest,
    cleanupTmp,
    // 读
    get,
    list,
    ids,
    counts,
    readIndex,
    readJournal,
    readManifest: () => readManifest(),
    snapshot,
    // 校验与重算
    verify,
    rebuild,
    // 只读工具（便于调用方不再 import 一遍）
    sha256,
    canonicalJson,
    clock,
  };
}

// ---------------------------------------------------------------------------
// 派生重算（R04/R05/R07/R06）：archive 与 rebuild 共用，保证"入档产物 = rebuild 产物"
// ---------------------------------------------------------------------------

function okObject(mod, names) {
  return Boolean(mod) && names.every((n) => typeof mod[n] === 'function');
}

/** 动态挂载派生房间（缺失时返回 null，由调用方显式 skipped）。 */
export async function loadDerivers() {
  const [topic, link, index, thread] = await Promise.all([
    loadOptional(new URL('./topic.mjs', import.meta.url)),
    loadOptional(new URL('./link.mjs', import.meta.url)),
    loadOptional(new URL('./index.mjs', import.meta.url)),
    loadOptional(new URL('./thread.mjs', import.meta.url)),
  ]);
  return { topic, link, index, thread };
}

/** 相关边的稳定 id：同一条边（kind + 两端 + why + topics）任何时候都得到同一个 id。 */
export function linkIdOf(link) {
  const key = canonicalJson([link.kind, link.a ?? null, link.b ?? null, link.why ?? '', link.topics ?? []]);
  return `link-${sha256(key).slice(0, 12)}`;
}

/** 把 R06/R08/R09 的返回统一成数组（成员各写各的返回形状，入档方不该崩）。 */
export function asRecordList(result, keys = []) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    for (const key of [...keys, 'items', 'records']) {
      if (Array.isArray(result[key])) return result[key];
    }
  }
  return [];
}

/**
 * 派生投影（R04/R05/R06/R07 → 落盘记录）：`deriveStore` 与 `deriveIncremental` 共用。
 *
 * D8（2026-11-20，主人裁定）：**`idfNorm` 不再落盘**。它是按全库局数归一化的派生值
 * （`idfNorm = f(df, N)`），每新增一局全库 topic 都会变，导致每轮归档把 9,000 个 topic 全量重写。
 * 只存 `df`（真实计数），需要时用 `idfNormOf(df, N)` 现算 —— 读的地方见 `src/rooms/cli.mjs`。
 *
 * @param {{withTopics:Array, table:object, mods:object, at:number, built:object, skipped:string[]}} p
 * @returns {{topicRecords:Array, linkRecords:Array, threads:Array|null, mentions:Array, indexMd:string|null}}
 */
function projectDerived({ withTopics, table, mods, at, built, skipped }) {
  const topicRecords = table.topics.map((t) => ({
    id: t.id,
    kind: t.kind,
    key: t.key,
    df: t.df,
    firstSeenAt: t.firstSeenAt,
    lastSeenAt: t.lastSeenAt,
    episodes: [...t.episodes].sort(),
  }));

  const linkRecords = built.links.map((l) => ({
    id: linkIdOf(l),
    kind: l.kind,
    a: l.a,
    b: l.b,
    topics: l.topics,
    why: l.why,
    weight: l.weight,
    occurredAt: l.occurredAt,
    episodes: [l.a?.episode, l.b?.episode].filter((x) => typeof x === 'string').sort(),
  }));

  let threads = null;
  if (!okObject(mods.thread, ['buildThreads'])) {
    skipped.push('threads: R06 thread 缺失（threads/ 保持原样）');
  } else {
    try {
      threads = asRecordList(mods.thread.buildThreads({ episodes: withTopics, links: built.links, topics: table, now: at }), ['threads']);
      threads = threads
        .filter((t) => t && typeof t.id === 'string')
        .map((t) => ({ ...t }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } catch (err) {
      skipped.push(`threads: R06 抛错（${String(err?.message ?? err)}）`);
      threads = null;
    }
  }

  let indexMd = null;
  if (!okObject(mods.index, ['renderIndex'])) {
    skipped.push('index.md: R07 index 缺失（不重写 index.md）');
  } else {
    indexMd = mods.index.renderIndex({
      episodes: withTopics,
      links: built.links,
      topics: table,
      mentions: built.mentions,
      generatedAt: null, // 不嵌时钟：同输入同输出（可复算、可校验）
      tz: 'UTC', // 跨机器一致（本地时区会随搬运而变，checksums 会漂）
    });
  }

  return { topicRecords, linkRecords, threads, mentions: built.mentions, indexMd };
}

/**
 * 从 episodes（权威）重算派生数据。
 * @param {{episodes:Array, derive?:object|null, at?:number}} p
 * @returns {Promise<{topics:Array, links:Array, threads:Array|null, mentions:Array, indexMd:string|null,
 *                    skipped:string[], active:number, stats:object|null}>}
 */
export async function deriveStore({ episodes = [], derive = null, at = Date.now() } = {}) {
  const mods = derive ?? (await loadDerivers());
  const skipped = [];
  // 只收独立成谱的局：folded-into:<父局> 的子代理局不参与建网（AGENTS §4.1「只收 depth=0」）
  const active = (Array.isArray(episodes) ? episodes : []).filter(
    (e) => e && typeof e.id === 'string' && (e.state ?? 'archived') === 'archived',
  );

  if (!okObject(mods.topic, ['computeDf', 'deriveScaffoldTopics']) || !okObject(mods.link, ['buildLinks'])) {
    skipped.push('topics/links: R04 topic 或 R05 link 缺失（派生未重算，旧文件保持原样）');
    return { topics: [], links: [], threads: null, mentions: [], indexMd: null, skipped, active: active.length, stats: null };
  }

  let perEpisode = active.map((e) => ({ episodeId: e.id, topics: Array.isArray(e.topics) ? e.topics : [] }));
  const missingTopics = active.filter((e) => !Array.isArray(e.topics)).length;
  if (missingTopics > 0) skipped.push(`topics: ${missingTopics} 局条目里没有 topics 字段（按空处理）`);
  perEpisode = mods.topic.deriveScaffoldTopics(perEpisode);
  const table = mods.topic.computeDf(perEpisode);
  const withTopics = active.map((e, i) => ({ ...e, topics: perEpisode[i].topics ?? [] }));
  const built = mods.link.buildLinks({ episodes: withTopics, topics: table });
  const projected = projectDerived({ withTopics, table, mods, at, built, skipped });
  const { topicRecords, linkRecords, threads, indexMd } = projected;

  return {
    topics: topicRecords,
    links: linkRecords,
    threads,
    mentions: built.mentions,
    indexMd,
    skipped,
    active: active.length,
    stats: {
      episodes: active.length,
      topics: topicRecords.length,
      links: linkRecords.length,
      mentions: built.mentions.length,
      threads: threads?.length ?? null,
      indexBytes: typeof indexMd === 'string' ? Buffer.byteLength(indexMd, 'utf8') : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 增量派生（P0-3）：**episode 是最小更新单位**
//
// 对标上游 Graphiti `add_episode`：只有本轮新增/内容变更的 episode 参与重算；
// 候选只取**同一对端点**（`_pair_search_filter` 的同义做法）；bulk upsert 只写本轮 resolved 的记录；
// 全量重建只有显式调用（这里 = `KIFU_ARCHIVE_FULL_DERIVE=1` 或状态缓存失效）。
//
// 三条落地判据（不许松）：
//   1. **正确性**：受影响区之外的主题/边/卷一个字都不动（`其余沿用库内既有记录`）；
//      受影响区按「成员集合真的变了」判定，不是按"上次跑完到现在过了多久"。
//   2. **删除只由 episode 变化驱动**：只有某条派生记录失去全部 episode 归属（或某对端点的边不再成立）
//      才会被删 —— 不因为"这一轮没算到它"而删。
//   3. **可回滚**：`KIFU_ARCHIVE_FULL_DERIVE=1` 走 `deriveStore` + `replaceDerived`（老路径）。
//
// 状态缓存 `<root>/.cache/derive-state.json`（**派生数据，可丢**）：缺了/对不上就走全量，
// 只让"有没有变化"这一步变便宜，绝不用它替代任何判据。
//   `{version, mode, n, derived:<派生目录 checksums 摘要>, counts:{…}, episodes:{epId: 指纹}}`
//
// 「受影响」怎么定（全部机械、可复算）：
//   · 主题：episode 的**派生主题集合**（含 scaffold）变了，或该 episode 进出活跃集；
//     外加「判别性上限」窗口内的主题（`max(2,⌈10%·N⌉)` 随 N 变 ⇒ 边界主题的可用性翻转）。
//   · 边：同一条边只可能因「端点之一变了」或「参与判定的主题 df 变了」而变
//     ⇒ 受影响 pair = 受影响主题的持有者两两配对 ∪ 变化 episode 相关的 pair。
//   · 卷：（scope, topic）分组的成员变了就重算；R06 的成卷规则一个字不改（直接调用）。
// ---------------------------------------------------------------------------

export const DERIVE_STATE_REL = '.cache/derive-state.json';
export const DERIVE_STATE_VERSION = 1;
/** 增量判定：受影响 episode 超过活跃集的这个比例就退回全量（全量此时也便宜，且更保守）。 */
export const DERIVE_SCOPED_MAX_RATIO = 0.25;

export function deriveStatePath(root) {
  return path.join(path.resolve(root), DERIVE_STATE_REL);
}

/** 读派生状态缓存；缺失/版本不符/形状不对 ⇒ null（调用方走全量）。 */
export function readDeriveState(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(deriveStatePath(root), 'utf8'));
    if (!raw || raw.version !== DERIVE_STATE_VERSION) return null;
    if (!Number.isFinite(raw.n) || raw.n < 0) return null;
    if (!raw.episodes || typeof raw.episodes !== 'object' || Array.isArray(raw.episodes)) return null;
    if (typeof raw.derived !== 'string' || raw.derived === '') return null;
    return raw;
  } catch {
    return null;
  }
}

/** 写派生状态缓存（原子替换；失败只是下次走全量，不影响正确性）。 */
export function writeDeriveState(root, state) {
  const dir = path.resolve(root);
  fs.mkdirSync(dir, { recursive: true });
  const target = deriveStatePath(dir);
  const tmp = path.join(dir, `.tmp-derive-state-${process.pid}-${Date.now().toString(36)}`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响主错误 */ }
    throw err;
  }
  return target;
}

/**
 * 一局棋谱的**派生输入指纹**：只覆盖派生真正读到的字段
 * （state / scopeKey / l0 / 时间窗 / 主题及其出现位置）。
 * `closure` `signals` 之类不参与派生，不进指纹 —— 否则权威侧簿记变化会引起假"变更"。
 */
export function episodeDeriveFingerprint(episode) {
  if (!episode || typeof episode.id !== 'string' || episode.id === '') return null;
  const times = ['occurredAt', 'startedAt', 'firstEventAt', 'endedAt', 'lastEventAt']
    .map((k) => (Number.isFinite(episode[k]) ? episode[k] : ''))
    .join(',');
  const rows = [];
  for (const t of Array.isArray(episode.topics) ? episode.topics : []) {
    if (!t || typeof t.id !== 'string') continue;
    let occKey = '';
    for (const o of Array.isArray(t.occurrences) ? t.occurrences : []) {
      occKey += `${o?.seq ?? ''}:${o?.occurredAt ?? ''}:${o?.nodeId ?? ''}:${o?.edgeId ?? ''};`;
    }
    rows.push(`${t.id}\u0001${t.kind ?? ''}\u0001${t.key ?? ''}\u0001${occKey}`);
  }
  return sha256([episode.state ?? 'archived', episode.scopeKey ?? '', episode.l0 ?? '', times, rows.join('\u0002')].join('\u0003')).slice(0, 32);
}

/** 判别性上限（与 R05 `linkEligible` 同式：df ≤ max(2, ⌈10%·N⌉)）。 */
function eligibilityCapOf(n) {
  return Math.max(2, Math.ceil((Number.isFinite(n) ? n : 0) * 0.1));
}

function sortedIdList(topics) {
  const ids = [];
  for (const t of Array.isArray(topics) ? topics : []) if (t && typeof t.id === 'string') ids.push(t.id);
  return ids.sort();
}

function sameTopicIdSet(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function byIdAsc(a, b) {
  return String(a?.id) < String(b?.id) ? -1 : String(a?.id) > String(b?.id) ? 1 : 0;
}

/**
 * 一局棋谱的主题视图（id → {id,kind,key,occurrences}）——与 R05 `buildLinks` 内部同一口径：
 * 同一 id 出现多次时取 occurrences 最长的那条。
 */
function episodeViews(episodes, table) {
  const views = new Map();
  for (const ep of episodes) {
    const occById = new Map();
    for (const t of Array.isArray(ep.topics) ? ep.topics : []) {
      if (!t || !t.id) continue;
      const ref = table.byId.get(t.id);
      const view = {
        id: t.id,
        kind: ref?.kind ?? t.kind,
        key: ref?.key ?? t.key,
        occurrences: Array.isArray(t.occurrences) ? t.occurrences : [],
      };
      if (!occById.has(t.id)) occById.set(t.id, view);
      else if (view.occurrences.length > occById.get(t.id).occurrences.length) occById.set(t.id, view);
    }
    views.set(ep.id, { episode: ep, occById });
  }
  return views;
}

function firstOccurrenceOf(topic) {
  const occ = Array.isArray(topic?.occurrences) ? topic.occurrences : [];
  return [...occ].sort((a, b) => {
    const sa = Number.isFinite(a?.seq) ? a.seq : Number.MAX_SAFE_INTEGER;
    const sb = Number.isFinite(b?.seq) ? b.seq : Number.MAX_SAFE_INTEGER;
    return sa - sb;
  })[0] ?? null;
}

function nodeSideOf(episodeId, occ) {
  const side = { episode: episodeId };
  if (occ?.nodeId) side.nodeId = occ.nodeId;
  if (occ?.edgeId) side.edgeId = occ.edgeId;
  return side;
}

/**
 * **一对端点**的全部相关边（shared-topic / same-error / same-file），规则逐条对齐 R05 `buildLinks`：
 * 只算这一对，不看别的对。这是「候选限定同一对端点」的落点 —— 全量口径由调用方传进来的
 * 全局 df 表与 N 保证（不重算全库两两配对）。
 * @returns {Array<{a:object,b:object,kind:string,topics:string[],why:string,weight:number,occurredAt:number|null}>}
 */
export function pairLinksOf(va, vb, n, mods, dfTable) {
  const linkEligible = mods.link.linkEligible;
  const idfNorm = mods.link.idfNorm;
  const hardKinds = mods.topic.HARD_KINDS;
  const softKinds = mods.topic.SOFT_KINDS;
  const out = [];
  if (!va || !vb) return out;
  const dfOf = (id) => {
    const t = dfTable?.get(id);
    return Number.isFinite(t?.df) ? t.df : 0;
  };
  const normOf = (id) => idfNorm(dfOf(id), n);

  // ---- 棋谱 ↔ 棋谱：共享硬主题（error 除外）优先，其次 ≥2 个判别性软主题 ----
  const hardA = [];
  const softA = [];
  for (const view of va.occById.values()) {
    const df = dfOf(view.id);
    if (hardKinds.has(view.kind) && view.kind !== 'error' && linkEligible(df, n)) hardA.push(view);
    if (softKinds.has(view.kind) && linkEligible(df, n)) softA.push(view);
  }
  const sharedHard = hardA.filter((t) => vb.occById.has(t.id));
  if (sharedHard.length) {
    sharedHard.sort((x, y) => (normOf(y.id) - normOf(x.id)) || (x.key < y.key ? -1 : 1));
    const primaryA = firstOccurrenceOf(sharedHard[0]);
    const primaryB = firstOccurrenceOf(vb.occById.get(sharedHard[0].id));
    const at = Math.min(
      Number.isFinite(primaryA?.occurredAt) ? primaryA.occurredAt : Infinity,
      Number.isFinite(primaryB?.occurredAt) ? primaryB.occurredAt : Infinity,
    );
    out.push({
      a: { episode: va.episode.id },
      b: { episode: vb.episode.id },
      kind: 'shared-topic',
      topics: sharedHard.map((t) => t.id),
      why: sharedHard.map((t) => t.key).join(', '),
      weight: 1,
      occurredAt: Number.isFinite(at) ? at : (va.episode.startedAt ?? null),
    });
  } else {
    const sharedSoft = softA.filter((t) => vb.occById.has(t.id));
    if (sharedSoft.length >= 2) {
      sharedSoft.sort((x, y) => (normOf(y.id) - normOf(x.id)) || (x.key < y.key ? -1 : 1));
      const mean = sharedSoft.reduce((s, t) => s + normOf(t.id), 0) / sharedSoft.length;
      const primaryA = firstOccurrenceOf(sharedSoft[0]);
      const primaryB = firstOccurrenceOf(vb.occById.get(sharedSoft[0].id));
      const at = Math.min(
        Number.isFinite(primaryA?.occurredAt) ? primaryA.occurredAt : Infinity,
        Number.isFinite(primaryB?.occurredAt) ? primaryB.occurredAt : Infinity,
      );
      out.push({
        a: { episode: va.episode.id },
        b: { episode: vb.episode.id },
        kind: 'shared-topic',
        topics: sharedSoft.map((t) => t.id),
        why: sharedSoft.map((t) => t.key).join(', '),
        weight: Math.round(0.5 * mean * 10000) / 10000,
        occurredAt: Number.isFinite(at) ? at : (va.episode.startedAt ?? null),
      });
    }
  }

  // ---- 节点 ↔ 节点：同一 error 原文 / 同一文件 + 同一错误 ----
  const isGeneric = mods.topic.isGenericErrorKey;
  const errorsOf = (view) => {
    const rows = [];
    for (const t of view.occById.values()) {
      if (t.kind !== 'error') continue;
      if (typeof isGeneric === 'function' && isGeneric(t.key)) continue;
      if (String(t.key).startsWith('class:')) continue;
      const occ = firstOccurrenceOf(t);
      if (!occ) continue;
      rows.push({ id: t.id, key: t.key, occ });
    }
    return rows;
  };
  const filesOf = (view) => {
    const rows = [];
    for (const t of view.occById.values()) {
      if (t.kind !== 'file') continue;
      const occ = firstOccurrenceOf(t);
      if (!occ) continue;
      rows.push({ id: t.id, key: t.key, occ });
    }
    return rows;
  };
  const errA = errorsOf(va);
  const errB = errorsOf(vb);
  const sharedErrors = errA.filter((x) => errB.some((y) => y.id === x.id));
  for (const err of sharedErrors) {
    const other = errB.find((y) => y.id === err.id);
    const at = Math.min(
      Number.isFinite(err.occ?.occurredAt) ? err.occ.occurredAt : Infinity,
      Number.isFinite(other.occ?.occurredAt) ? other.occ.occurredAt : Infinity,
    );
    out.push({
      a: nodeSideOf(va.episode.id, err.occ),
      b: nodeSideOf(vb.episode.id, other.occ),
      kind: 'same-error',
      topics: [err.id],
      why: err.key,
      weight: 1,
      occurredAt: Number.isFinite(at) ? at : null,
    });
  }
  if (sharedErrors.length) {
    const filesA = filesOf(va);
    const filesB = filesOf(vb);
    for (const file of filesA) {
      if (!filesB.some((f) => f.id === file.id)) continue;
      for (const err of sharedErrors) {
        const other = errB.find((y) => y.id === err.id);
        const at = Math.min(
          Number.isFinite(err.occ?.occurredAt) ? err.occ.occurredAt : Infinity,
          Number.isFinite(other.occ?.occurredAt) ? other.occ.occurredAt : Infinity,
        );
        out.push({
          a: nodeSideOf(va.episode.id, err.occ),
          b: nodeSideOf(vb.episode.id, other.occ),
          kind: 'same-file',
          topics: [file.id, err.id],
          why: `${file.key}, ${err.key}`,
          weight: 1,
          occurredAt: Number.isFinite(at) ? at : null,
        });
      }
    }
  }
  return out;
}

/**
 * 增量派生入口（**episode 为最小更新单位**）。
 *
 * @param {{episodes?:Array, prevEpisodes?:Array|null, store?:object|null,
 *          derive?:object|null, at?:number, forceFull?:boolean}} opts
 *   episodes     = 本轮**写后**的全量 episode 记录（权威）
 *   prevEpisodes = 本轮**写前**的全量 episode 记录（缺省 = episodes）；用于判定"谁真的变了"
 *   store        = 用于读派生状态缓存与既有 links/threads（缺失 ⇒ 只能全量）
 *   forceFull    = true 走老的全量路径（回滚/对照）
 * @returns {Promise<object>} 见下方 return；`mode` ∈ full | scoped | noop | skipped
 */
export async function deriveIncremental(opts = {}) {
  const episodes = Array.isArray(opts.episodes) ? opts.episodes : [];
  const prevEpisodes = Array.isArray(opts.prevEpisodes) ? opts.prevEpisodes : episodes;
  const store = opts.store ?? null;
  const mods = opts.derive ?? (await loadDerivers());
  const at = Number.isFinite(opts.at) ? opts.at : Date.now();
  const forceFull = Boolean(opts.forceFull);
  const skipped = [];

  const isActive = (e) => e && typeof e.id === 'string' && (e.state ?? 'archived') === 'archived';
  const active = episodes.filter(isActive).sort(byIdAsc);
  const prevActiveList = prevEpisodes.filter(isActive).sort(byIdAsc);
  const prevById = new Map(prevActiveList.map((e) => [e.id, e]));

  if (!okObject(mods.topic, ['computeDf', 'deriveScaffoldTopics']) || !okObject(mods.link, ['buildLinks', 'linkEligible', 'capLinksPerEpisode'])) {
    skipped.push('topics/links: R04 topic 或 R05 link 缺失（派生未重算，旧文件保持原样）');
    return {
      mode: 'skipped',
      skipped,
      counts: { episodes: active.length, topics: null, links: null, threads: null, mentions: null, indexBytes: 0 },
      dirty: { episodes: [], removed: [], topics: [], pairs: 0 },
      changed: emptyChangedSets(),
      indexMd: null,
      full: null,
      state: null,
    };
  }

  // 派生主题（scaffold 是全局判据：族里成员 ≥2 —— 两条路径都按全量语料算，12ms）
  const scaffold = (list) => mods.topic.deriveScaffoldTopics(
    list.map((e) => ({ episodeId: e.id, topics: Array.isArray(e.topics) ? e.topics : [] })),
  );
  const perEpisode = scaffold(active);
  const table = mods.topic.computeDf(perEpisode);
  const withTopics = active.map((e, i) => ({ ...e, topics: perEpisode[i].topics ?? [] }));
  const prevPer = scaffold(prevActiveList);
  const prevDerivedTopics = new Map(prevActiveList.map((e, i) => [e.id, sortedIdList(prevPer[i].topics)]));

  const N = active.length;
  const capNow = eligibilityCapOf(N);
  const state = store ? readDeriveState(store.root) : null;
  const digest = store && typeof store.derivedDigest === 'function' ? store.derivedDigest() : null;
  const stateValid = Boolean(state && digest && state.derived === digest);
  // 状态缓存说"派生文件没变"，但文件数对不上（被外部删/多出来）⇒ 不敢走 noop，
  // 退回全量把派生目录修回来。readdir 只看文件名，三个 kind 合计 ~0.3 秒。
  const derivedCountsMatch = () => {
    if (!store || !state || !state.counts) return true;
    for (const kind of DERIVED_KINDS) {
      const want = state.counts[kind];
      if (!Number.isFinite(want)) continue;
      if (store.ids(kind).length !== want) return false;
    }
    return true;
  };
  const useFull = forceFull || !stateValid || !derivedCountsMatch();

  const buildFull = () => {
    const built = mods.link.buildLinks({ episodes: withTopics, topics: table });
    const projected = projectDerived({ withTopics, table, mods, at, built, skipped });
    const counts = {
      episodes: N,
      topics: projected.topicRecords.length,
      links: projected.linkRecords.length,
      threads: Array.isArray(projected.threads) ? projected.threads.length : null,
      mentions: projected.mentions.length,
      indexBytes: typeof projected.indexMd === 'string' ? Buffer.byteLength(projected.indexMd, 'utf8') : 0,
    };
    return {
      mode: 'full',
      skipped,
      counts,
      dirty: {
        episodes: active.map((e) => e.id),
        removed: prevActiveList.filter((e) => !active.some((x) => x.id === e.id)).map((e) => e.id),
        topics: table.topics.length,
        pairs: 0,
      },
      changed: emptyChangedSets(),
      indexMd: projected.indexMd,
      full: {
        topics: projected.topicRecords,
        links: projected.linkRecords,
        threads: projected.threads,
      },
      state: null,
    };
  };

  if (useFull) {
    const out = buildFull();
    out.state = makeDeriveState({ mode: 'full', n: N, episodes: active, counts: out.counts, at });
    return out;
  }

  // ---- 变化判定：谁真的变了（内容 / 派生主题集合 / 进出活跃集）----
  const fps = new Map(active.map((e) => [e.id, episodeDeriveFingerprint(e)]));
  const dirtyIds = [];
  for (const ep of withTopics) {
    const prev = prevById.get(ep.id);
    if (!prev) { dirtyIds.push(ep.id); continue; }
    const prevFp = state.episodes[ep.id];
    if (typeof prevFp !== 'string' || prevFp !== fps.get(ep.id)) { dirtyIds.push(ep.id); continue; }
    const idsNow = sortedIdList(ep.topics);
    const idsPrev = prevDerivedTopics.get(ep.id) ?? [];
    if (!sameTopicIdSet(idsNow, idsPrev)) dirtyIds.push(ep.id);
  }
  const activeIds = new Set(active.map((e) => e.id));
  const removedIds = [...prevById.keys()].filter((id) => !activeIds.has(id));

  if (dirtyIds.length === 0 && removedIds.length === 0) {
    // ---- noop：本轮没有任何 episode 变化 ⇒ 派生一份不重算、不重写（只报数）----
    const counts = {
      episodes: N,
      topics: Number.isFinite(state.counts?.topics) ? state.counts.topics : table.topics.length,
      links: Number.isFinite(state.counts?.links) ? state.counts.links : null,
      threads: Number.isFinite(state.counts?.threads) ? state.counts.threads : null,
      mentions: Number.isFinite(state.counts?.mentions) ? state.counts.mentions : null,
      indexBytes: Number.isFinite(state.counts?.indexBytes) ? state.counts.indexBytes : 0,
    };
    return {
      mode: 'noop',
      skipped,
      counts,
      dirty: { episodes: [], removed: [], topics: 0, pairs: 0 },
      changed: emptyChangedSets(),
      indexMd: null, // 派生索引与派生记录同源：没有 episode 变化 ⇒ 不必重渲染
      full: null,
      state: null,
    };
  }

  if (dirtyIds.length + removedIds.length > Math.max(8, Math.ceil(N * DERIVE_SCOPED_MAX_RATIO))) {
    const out = buildFull();
    out.state = makeDeriveState({ mode: 'full', n: N, episodes: active, counts: out.counts, at });
    return out;
  }

  // ---- 受影响主题 ----
  const Taff = new Set();
  const addTopicIdsOf = (rec) => { for (const id of sortedIdList(rec?.topics)) Taff.add(id); };
  for (const id of dirtyIds) addTopicIdsOf(prevById.get(id));
  for (const id of removedIds) addTopicIdsOf(prevById.get(id));
  for (const id of dirtyIds) addTopicIdsOf(active.find((e) => e.id === id));
  for (const id of dirtyIds) for (const t of prevDerivedTopics.get(id) ?? []) Taff.add(t);
  for (const id of removedIds) for (const t of prevDerivedTopics.get(id) ?? []) Taff.add(t);
  // 判别性上限随 N 变 ⇒ 边界主题（df ∈ (旧上限, 新上限]）的可用性翻转
  const capPrev = eligibilityCapOf(Number.isFinite(state.n) ? state.n : N);
  if (capPrev !== capNow) {
    const lo = Math.min(capPrev, capNow);
    const hi = Math.max(capPrev, capNow);
    for (const t of table.topics) if (t.df > lo && t.df <= hi) Taff.add(t.id);
  }

  // ---- 主题记录：只重算受影响主题（成员集合算术，判据只有一条「谁提到它」）----
  const changed = emptyChangedSets();
  for (const id of Taff) {
    const t = table.byId.get(id);
    if (!t) { changed.removedTopics.push(id); continue; } // 没有任何活跃局再提到它
    changed.topics.push({
      id: t.id,
      kind: t.kind,
      key: t.key,
      df: t.df,
      firstSeenAt: t.firstSeenAt,
      lastSeenAt: t.lastSeenAt,
      episodes: [...t.episodes].sort(),
    });
  }

  // ---- 边：候选限定同一对端点 ----
  const views = episodeViews(withTopics, table);
  const orderedIds = withTopics.map((e) => e.id).sort();
  const pairKeys = new Set();
  const addPair = (x, y) => {
    if (x === y) return;
    pairKeys.add(x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
  };
  // 成本闸：受影响端点对一旦超过「全量两两配对」的量级，就地退回全量（全量此时更省）。
  // 只统计**真能产出边**的主题：判别性通过（≤ 上限）的硬/软主题，加上非通用、非类级的 error；
  // 其余主题（df 太大的通用词）本来就不建边，算进来只会白白触发全量。
  const totalPairs = (orderedIds.length * (orderedIds.length - 1)) / 2;
  const pairBudgetLimit = Math.min(Math.max(totalPairs, 64), 400000);
  let pairBudget = 0;
  for (const id of [...Taff].sort()) {
    const t = table.byId.get(id);
    if (!t || t.df < 2) continue;
    const linkable = (t.kind === 'error' && !mods.topic.isGenericErrorKey(t.key) && !String(t.key).startsWith('class:'))
      || (t.kind !== 'error' && mods.link.linkEligible(t.df, N));
    if (!linkable) continue;
    const holders = t.episodes ?? [];
    pairBudget += (holders.length * (holders.length - 1)) / 2;
    if (pairBudget > pairBudgetLimit) return finishFull();
    const sorted = [...holders].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) addPair(sorted[i], sorted[j]);
    }
  }

  const storedLinks = store.list('links').filter((x) => x.record).map((x) => x.record);
  if (process.env.KIFU_TRACE_DERIVE === '1') {
    console.error('[derive] scoped: N=%d dirty=%j removed=%j Taff=%d pairs=%d storedLinks=%d', N, dirtyIds, removedIds, Taff.size, pairKeys.size, storedLinks.length);
  }
  const removedSet = new Set(removedIds);
  const linkTouchesTopic = (l) => (Array.isArray(l.topics) ? l.topics.some((t) => Taff.has(t)) : false);
  const linkAffected = (l) => {
    const a = l?.a?.episode;
    const b = l?.b?.episode;
    if (removedSet.has(a) || removedSet.has(b)) return true;
    if (typeof a === 'string' && typeof b === 'string' && pairKeys.has(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)) return true;
    return linkTouchesTopic(l);
  };

  const freshLinks = [];
  const seenKeys = new Set();
  const ordered = [...pairKeys].sort();
  for (const key of ordered) {
    const [aId, bId] = key.split('\u0000');
    const va = views.get(aId);
    const vb = views.get(bId);
    if (!va || !vb) continue;
    for (const link of pairLinksOf(va, vb, N, mods, table.byId)) {
      const dedupe = `${link.kind}|${link.a.episode}|${link.b.episode}|${link.why}`;
      if (seenKeys.has(dedupe)) continue;
      seenKeys.add(dedupe);
      freshLinks.push(link);
    }
  }

  // 上限裁剪：判据函数直接用 R05 的（不复制），候选取「库内未受影响的边 ∪ 本轮重算的边」。
  // 说明：库内的边已被上一轮裁过，被裁掉的候选不在池里 ⇒ 这里只会**少裁**、不会凭空造边。
  // 落盘形状先转成记录（含稳定 id），这样"新增/删除"都能按 id 集合比，不靠内容猜。
  const maxPerEpisode = mods.link.DEFAULT_LINK_OPTIONS?.maxLinksPerEpisode;
  const toRecord = (l) => ({
    id: linkIdOf(l),
    kind: l.kind,
    a: l.a,
    b: l.b,
    topics: l.topics,
    why: l.why,
    weight: l.weight,
    occurredAt: l.occurredAt,
    episodes: [l.a?.episode, l.b?.episode].filter((x) => typeof x === 'string').sort(),
  });
  const freshRecords = freshLinks.map(toRecord);
  const pool = [...storedLinks.filter((l) => !linkAffected(l)), ...freshRecords];
  const capped = mods.link.capLinksPerEpisode(pool, Number.isFinite(maxPerEpisode) ? maxPerEpisode : 16);

  const storedIds = new Set(storedLinks.map((l) => l.id));
  const finalIds = new Set(capped.map((l) => l.id));
  changed.links = capped.filter((l) => !storedIds.has(l.id));
  changed.removedLinks = [...storedIds].filter((id) => !finalIds.has(id));
  if (process.env.KIFU_TRACE_DERIVE === '1') {
    console.error('[derive] pool=%d capped=%d write=%d removed=%d', pool.length, capped.length, changed.links.length, changed.removedLinks.length);
  }

  // ---- 卷 / index：R06/R07 的判据不复制，直接按全量口径调用（0.9 秒量级），只写变了的 ----
  const builtLinks = capped;
  let threads = null;
  if (!okObject(mods.thread, ['buildThreads'])) {
    skipped.push('threads: R06 thread 缺失（threads/ 保持原样）');
  } else {
    try {
      threads = asRecordList(mods.thread.buildThreads({ episodes: withTopics, links: builtLinks, topics: table, now: at }), ['threads'])
        .filter((t) => t && typeof t.id === 'string')
        .map((t) => ({ ...t }))
        .sort(byIdAsc);
    } catch (err) {
      skipped.push(`threads: R06 抛错（${String(err?.message ?? err)}）`);
      threads = null;
    }
  }
  if (Array.isArray(threads)) {
    const storedThreads = store.list('threads').filter((x) => x.record).map((x) => x.record);
    const storedThreadById = new Map(storedThreads.map((t) => [t.id, t]));
    const threadIds = new Set(threads.map((t) => t.id));
    for (const t of threads) {
      const prev = storedThreadById.get(t.id);
      const next = { ...t };
      if (prev) for (const field of ['createdAt', 'recordedAt', 'generatedAt']) if (prev[field] !== undefined) next[field] = prev[field];
      if (!prev || !sameMemoryContent(next, prev)) changed.threads.push(next);
    }
    changed.removedThreads = storedThreads.filter((t) => !threadIds.has(t.id)).map((t) => t.id);
  }

  let indexMd = null;
  if (okObject(mods.index, ['renderIndex'])) {
    indexMd = mods.index.renderIndex({
      episodes: withTopics,
      links: builtLinks,
      topics: table,
      mentions: [],
      generatedAt: null,
      tz: 'UTC',
    });
  } else {
    skipped.push('index.md: R07 index 缺失（不重写 index.md）');
  }

  const counts = {
    episodes: N,
    topics: table.topics.length,
    links: capped.length,
    threads: Array.isArray(threads) ? threads.length : null,
    mentions: null,
    indexBytes: typeof indexMd === 'string' ? Buffer.byteLength(indexMd, 'utf8') : 0,
  };
  return {
    mode: 'scoped',
    skipped,
    counts,
    dirty: { episodes: dirtyIds, removed: removedIds, topics: Taff.size, pairs: pairKeys.size },
    changed,
    indexMd,
    full: null,
    state: makeDeriveState({ mode: 'scoped', n: N, episodes: active, counts, at }),
  };

  function finishFull() {
    const out = buildFull();
    out.state = makeDeriveState({ mode: 'full', n: N, episodes: active, counts: out.counts, at });
    return out;
  }
}

function emptyChangedSets() {
  return { topics: [], links: [], threads: [], removedTopics: [], removedLinks: [], removedThreads: [] };
}

/** 派生状态缓存（写盘前由调用方补 `derived` 摘要）。 */
function makeDeriveState({ mode, n, episodes, counts, at }) {
  const fps = {};
  for (const ep of episodes) {
    const fp = episodeDeriveFingerprint(ep);
    if (fp) fps[ep.id] = fp;
  }
  return {
    version: DERIVE_STATE_VERSION,
    mode,
    derivedAt: at,
    n,
    counts: { ...counts },
    derived: null,
    episodes: fps,
  };
}

export default {
  createStore,
  deriveStore,
  deriveIncremental,
  pairLinksOf,
  deriveStatePath,
  readDeriveState,
  writeDeriveState,
  episodeDeriveFingerprint,
  DERIVE_STATE_VERSION,
  DERIVE_SCOPED_MAX_RATIO,
  loadDerivers,
  linkIdOf,
  asRecordList,
  sha256,
  canonicalJson,
  stableText,
  encodeId,
  decodeId,
  validateRelPath,
  relativizeSource,
  resolveSource,
  sourceStatusOf,
  findPathViolations,
  sameMemoryContent,
  isAuthoritativeProblem,
  PersistError,
  STORE_VERSION,
  STORE_SCHEMA,
  ENTRY_KINDS,
  AUTHORITATIVE_KINDS,
  DERIVED_KINDS,
  STORE_DIRS,
  MANIFEST_FILE,
  INDEX_FILE,
  JOURNAL_REL,
  PATH_POLICY,
};
