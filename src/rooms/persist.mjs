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
// 路径纪律（§4.11 规则 2）：store 内一切路径相对 root（manifest.checksums 的 key、条目文件名都是
//   相对路径）；**不存绝对路径**。来源文件（会话日志/棋谱）的绝对路径不入库：
//   一律存成相对 DSH_HOME 的路径 + `sourceRoot:"DSH_HOME"`，并带 `sourceStatus`。
// 原件缺失不失效（§4.11 规则 6）：sourceStatus:"missing" 只表示原件不在这台机器上，
//   条目照常读出、照常可注入，只是不可晋升/更新（缺证据）；**不改 state、不删除**。
// 错误语义：
//   - 未知 manifest 版本 ⇒ verify 返回 `manifest/unsupported-version`（不静默降级）；
//     写入侧 ensureCompatible 直接抛 PersistError('store/unsupported-version')。
//   - 缺 manifest / 坏 manifest ⇒ verify 返回 `manifest/missing` / `manifest/invalid` + hint rebuild。
//   - 条目不慎带绝对路径 ⇒ put 抛 `persist/absolute-path`（宁可不入馆，不写进搬不走的库）。
//   - journal 坏尾（崩溃截断）⇒ readJournal 丢尾行 + 计数，**不抛**；rebuild 仍可跑。
// 允许依赖：R00（棋谱形状）；派生重算时按需动态 import R04/R05/R07/R06（缺失则显式 skipped，
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
export const MANIFEST_FILE = 'manifest.json';
export const INDEX_FILE = 'index.md';
export const JOURNAL_REL = 'journal/archive.jsonl';
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
 * @param {{root:string, user?:string, now?:number|(()=>number), version?:number}} opts
 *        root = 记忆库根目录（`<DSH_HOME>/memory-context/`，测试用临时目录）。
 *        now  = 时钟注入（测试可固定；默认 Date.now）。
 * @returns {object} store（方法见文件头与下方注释）
 */
export function createStore(opts = {}) {
  if (!opts || typeof opts.root !== 'string' || opts.root.trim() === '') {
    throw new PersistError('persist: createStore({root}) 需要 root', 'persist/missing-root');
  }
  const root = path.resolve(opts.root);
  const user = typeof opts.user === 'string' && opts.user !== '' ? opts.user : DEFAULT_USER;
  const version = Number.isFinite(opts.version) ? opts.version : STORE_VERSION;
  const clock = typeof opts.now === 'function' ? opts.now : () => (Number.isFinite(opts.now) ? opts.now : Date.now());

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

  function writeAtomic(absTarget, text) {
    const dir = path.dirname(absTarget);
    fs.mkdirSync(dir, { recursive: true });
    tmpSeq += 1;
    const tmp = path.join(dir, `.tmp-${process.pid}-${tmpSeq}-${Date.now().toString(36)}`);
    const buf = Buffer.from(text, 'utf8');
    const fd = fs.openSync(tmp, 'w');
    try {
      let offset = 0;
      while (offset < buf.length) offset += fs.writeSync(fd, buf, offset, buf.length - offset);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
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

  function readManifest() {
    let raw;
    try {
      raw = fs.readFileSync(manifestPath, 'utf8');
    } catch {
      return { manifest: null, error: 'missing' };
    }
    try {
      return { manifest: JSON.parse(raw), error: null, raw };
    } catch (err) {
      return { manifest: null, error: 'invalid', message: String(err?.message ?? err), raw };
    }
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
    return manifest;
  }

  /** 全目录快照：每个条目文件的 sha256 + 各 kind 条目数（一次遍历）。 */
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
        const buf = fs.readFileSync(abs);
        bytes += buf.length;
        files.set(`${kind}/${name}`, sha256(buf));
        n += 1;
      }
      counts[kind] = n;
    }
    const indexStat = statSafe(indexPath);
    if (indexStat?.isFile()) {
      const buf = fs.readFileSync(indexPath);
      bytes += buf.length;
      files.set(INDEX_FILE, sha256(buf));
    }
    return { files, counts, issues, bytes };
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

  function appendJournal(entry) {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
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
    const fd = fs.openSync(journalPath, 'a');
    try {
      fs.writeSync(fd, Buffer.from(`${line}\n`, 'utf8'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { line };
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
    }
    if (sameExceptClocks(candidate, previous)) {
      // 同内容重放：不写盘、不追加 journal、不动 updatedAt（幂等）
      return { changed: false, id: rec.id, path: rel, sha256: sha256(prevRaw) };
    }

    const next = { ...rec, [META_KEY]: { ...meta, updatedAt: at } };
    const text = stableText(next);
    writeAtomic(abs, text);
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

  function putMany(kind, records, putOpts = {}) {
    const list = (Array.isArray(records) ? records : []).filter(Boolean);
    const ordered = [...list].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    const results = ordered.map((record) => put(kind, record, putOpts));
    return {
      kind,
      total: results.length,
      written: results.filter((r) => r.changed).length,
      unchanged: results.filter((r) => !r.changed).length,
      results,
    };
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
    const written = putMany(kind, list, { at });
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
    return { kind, total: list.length, written: written.written, unchanged: written.unchanged, removed };
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
        ? { version: manifest.version, user: manifest.user, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, counts: manifest.counts, pathPolicy: manifest.pathPolicy }
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
    result.episodes = episodes.length;
    result.elapsedMs = Date.now() - started;
    return result;
  }

  return {
    // 身份与路径
    root,
    user,
    version,
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

  const topicRecords = table.topics.map((t) => ({
    id: t.id,
    kind: t.kind,
    key: t.key,
    df: t.df,
    idfNorm: t.idfNorm,
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

export default {
  createStore,
  deriveStore,
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
