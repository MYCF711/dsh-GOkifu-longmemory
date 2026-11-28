// src/cache.mjs —— 插件侧的**进程内缓存与读取面**：walk cache / bundle 读取 / 探针缓存 / 会话作用域缓存。
//
// 为什么单独成文件（重构 C 期 M1）：这些东西的共同点是 **"可以随时重算、但重算很贵"**
// —— 它们唯一正确的行为是"命中时快、换版本就换、闲置就摘掉、条数有上界"，而不是业务判断。
// 拆出来之后"缓存有没有泄漏"只需要看这一个文件。
//
// 边界：
//   · 只读 sidecar（store 由调用方给）；**唯一的写**是 A7 缓存读数账本
//     （`<storeRoot>/cache-breaks.jsonl`，append-only + 有界轮转 —— 见文件末尾「A7」一节：
//      它是观测留痕，与 `trials.jsonl` / `live-stats.jsonl` 同一类，不是记忆内容）；
//   · 失败一律降级（返回 null / 不缓存 / 不写），绝不抛给注入链路；
//   · 所有 Map 都有界或按桶清理（T61 / T64：宿主进程长驻，无界增长就是内存泄漏）。
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { scopeKeyFromPath } from './rooms/inject.mjs';
import { CACHE_BREAKS_MAX_BYTES, CACHE_BREAKS_TAIL_BYTES } from './rooms/limits.mjs';
import { createStore } from './rooms/persist.mjs';
import { workspaceOf, validityKeyOf } from './rooms/gates.mjs';
import { createWalkCache } from './rooms/walk.mjs';

// ---------------------------------------------------------------------------
// bundle 读取（T62：热路径批量读走 bundle，不逐条 open）
// ---------------------------------------------------------------------------

/**
 * 读侧 store：**bundle 模式**（一次读全量、不再逐条 stat/open）。
 * `deps.createStore` 可注入替身（测试用）；缺省 = `rooms/persist` 的真实现。
 */
export function openReadStore(storeRoot, deps = null) {
  const build = deps && typeof deps.createStore === 'function' ? deps.createStore : createStore;
  return build({ root: storeRoot, bundle: true });
}

// ---------------------------------------------------------------------------
// 闸 3 的探针缓存（PROBE_CACHE）：按**时间桶**整份清理，条数与运行时长无关（T64）
// ---------------------------------------------------------------------------

/**
 * 只为"这张卡里出现的条目"跑 validity 核验（闸 3 的输入）。
 * 为什么要限制范围：plugin 在每一步都会被调，扫全库太贵；卡片最多 `limit` 条。
 * 任何异常都吞成"没有结果"（⇒ 闸 3 记 unverified，而不是注入失败）。
 */
const PROBE_CACHE = new Map();
const PROBE_TTL_MS = 60_000;
/**
 * T64（2026-11-09）：`PROBE_CACHE` 的 key 里带**时间桶**（`floor(now/60s)`）——
 * 旧实现从不删除过期桶 ⇒ 每个 60 秒都往 Map 里堆一代新 key，**永不释放**（宿主进程长驻）。
 * 现在我们只保留**当前桶**：桶一换就整份清掉（过期条目本来就没用）。
 * 上界 = 一个桶内的 (claim, workspace) 组合数，与运行时长无关。
 */
let PROBE_BUCKET = null;
/** 测试用：当前探针缓存条数（有界性判据）。 */
export function probeCacheSize() { return PROBE_CACHE.size; }

export function probeCardValidity({ card, store, deps, fallbackWorkspace = null, now = null }) {
  const results = {};
  const rows = Array.isArray(card?.claims) ? card.claims : [];
  for (const row of rows) {
    const claimId = typeof row?.claimId === 'string' ? row.claimId : '';
    if (!claimId) continue;
    const kind = claimId.startsWith('j-') ? 'joseki' : 'claims';
    let record = null;
    try {
      record = store?.get ? store.get(kind, claimId) : null;
    } catch {
      record = null;
    }
    if (!record || typeof record !== 'object') continue;
    const key = validityKeyOf(record) || `${kind}:${claimId}`;
    // T198（audit-12 洞 2）：**以 claim 自己的 workspace 为准**（`scopeKey` 解出的路径），
    // 会话 cwd 只作兜底 —— 与 `runValidityCheck`（gates-check）同口径。
    // 之前直接传 cwd，同一批 claim 在两条口径下 53 条结论不同（cwd 有 package.json 时误判 version-mismatch ⇒ 闸 3 运行时误红）。
    const recordWorkspace = workspaceOf(record, fallbackWorkspace);
    const bucket = Math.floor((Number.isFinite(now) ? now : Date.now()) / PROBE_TTL_MS);
    if (PROBE_BUCKET !== bucket) { PROBE_CACHE.clear(); PROBE_BUCKET = bucket; } // 过期桶一次性丢掉
    const cacheKey = `${key}|${recordWorkspace ?? ''}|${bucket}`;
    if (PROBE_CACHE.has(cacheKey)) {
      results[key] = PROBE_CACHE.get(cacheKey);
      continue;
    }
    try {
      results[key] = deps.probeValidity(record, { workspace: recordWorkspace, now });
      PROBE_CACHE.set(cacheKey, results[key]);
    } catch (error) {
      results[key] = { ok: false, reason: `probe-error:${String(error?.message ?? error)}`, checkedAt: now };
    }
  }
  return results;
}

/**
 * T61（2026-11-09）：walk cache 按 **storeRoot** 存一份，**换版本就替换、空闲就摘掉**。
 *
 * 旧实现把 `manifest.json` 的 mtime 拼进 key 却**从不删除**旧 key ⇒ 库每更新一次就多一份
 * 完整图（真库实测一份 ≈35MB 堆）留在宿主进程里，永不释放。这是"无意义内存占用"最典型的一种。
 * 现在：① 同 storeRoot 只留最新一代（旧的立刻失去引用）；② 闲置 `WALK_CACHE_IDLE_MS` 后自动摘掉。
 */
const WALK_CACHES = new Map(); // storeRoot -> { stamp, cache, at, timer }
export const WALK_CACHE_IDLE_MS = 10 * 60_000;

function dropWalkCache(storeRoot) {
  const entry = WALK_CACHES.get(storeRoot);
  if (entry?.timer) clearTimeout(entry.timer);
  WALK_CACHES.delete(storeRoot);
}

/** 测试用：清空全部 walk cache。 */
export function walkCacheEntries() {
  for (const root of [...WALK_CACHES.keys()]) dropWalkCache(root);
  return 0;
}

/** 测试用：当前保留的 walk cache 份数（**同库只该有 1 份**，T61 之前是"每换一次 manifest 多一份"）。 */
export function walkCacheSize() {
  return WALK_CACHES.size;
}

function scheduleIdleDrop(storeRoot, entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const cur = WALK_CACHES.get(storeRoot);
    if (cur === entry) dropWalkCache(storeRoot);
  }, WALK_CACHE_IDLE_MS);
  if (typeof entry.timer?.unref === 'function') entry.timer.unref(); // 不许因此拖住进程退出
}

export function walkCacheFor(storeRoot, store, deps) {
  try {
    const mf = `${storeRoot}/manifest.json`;
    const stamp = fs.existsSync(mf) ? fs.statSync(mf).mtimeMs : 0;
    const hit = WALK_CACHES.get(storeRoot);
    if (hit && hit.stamp === stamp) {
      scheduleIdleDrop(storeRoot, hit); // 每次命中都把"闲置倒计时"推后
      return hit.cache;
    }
    const build = typeof deps.createWalkCache === 'function' ? deps.createWalkCache : createWalkCache;
    const cache = build(store);
    // 替换而不是累积：旧世代在 set 之后立刻失去引用，可被回收
    const entry = { stamp, cache, timer: null };
    if (hit?.timer) clearTimeout(hit.timer);
    WALK_CACHES.set(storeRoot, entry);
    scheduleIdleDrop(storeRoot, entry);
    return cache;
  } catch {
    return null;
  }
}

// 2026-11-03（N10）：会话 cwd 落在 DSH_HOME 里（profiles/desktop 等）时，scopeKeyFromPath 会得到
// 一个没有棋谱的假作用域，导致永远 no-hit。用**本会话历史 episode 的 scopeKey**兜底（归档时读过会话
// header 的真实 cwd），比猜目录名可靠。
const SESSION_SCOPE_CACHE = new WeakMap();
/**
 * T61：会话键的 Map 都要**有界**。宿主进程是长驻的，`session.id` 只会越积越多；
 * 每个值都很小（一个 scope 字符串），但没有上界就是"无意义增长"——按插入序淘汰最老的即可
 * （这些值都是可重算的缓存，丢了最多多算一次）。
 */
export const SESSION_MAP_MAX = 2000;

function capSessionMap(map) {
  if (map.size <= SESSION_MAP_MAX) return map;
  for (const key of map.keys()) {
    if (map.size <= SESSION_MAP_MAX) break;
    map.delete(key);
  }
  return map;
}

const LAST_SCOPE = new Map();
export function lastResolvedScope(sessionId) { return sessionId ? (LAST_SCOPE.get(sessionId) ?? null) : null; }

/**
 * 记住本会话最近一次解析出的作用域（心跳行回读用）。Map 有界（T61：按插入序淘汰最老的）。
 * 语义与拆分前内联写法逐字一致：`capSessionMap(LAST_SCOPE.set(sid, resolved) && LAST_SCOPE)`。
 */
export function rememberLastScope(sessionId, resolved) {
  if (sessionId) capSessionMap(LAST_SCOPE.set(sessionId, resolved) && LAST_SCOPE);
  return resolved;
}

export function sessionScopeIndex(store) {
  if (!store || typeof store.list !== 'function') return new Map();
  const hit = SESSION_SCOPE_CACHE.get(store);
  if (hit) return hit;
  const map = new Map();
  for (const row of store.list('episodes')) {
    const rec = row?.record ?? row;
    const sid = rec?.sessionId;
    if (typeof sid !== 'string' || !sid) continue;
    const at = Number.isFinite(rec?.lastEventAt) ? rec.lastEventAt : 0;
    const prev = map.get(sid);
    if (!prev || (prev.at ?? 0) < at) map.set(sid, { scope: rec.scopeKey, at });
  }
  const out = new Map([...map].map(([k, v]) => [k, v.scope]));
  SESSION_SCOPE_CACHE.set(store, out);
  return out;
}

const SESSION_LOG_SCOPE_CACHE = new Map();
/** 从本会话日志的 header 里读真实 cwd（会话日志第一帧就是 header，单帧解压即可）。 */
export function sessionLogScope(sessionId, home) {
  if (!sessionId || !home) return null;
  if (SESSION_LOG_SCOPE_CACHE.has(sessionId)) return SESSION_LOG_SCOPE_CACHE.get(sessionId);
  let scope = null;
  try {
    const root = path.join(home, 'sessions');
    for (const group of fs.readdirSync(root)) {
      const file = path.join(root, group, sessionId, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      const head = zstdDecompressSync(fs.readFileSync(file)).toString('utf8').split(String.fromCharCode(10))[0];
      const parsed = JSON.parse(head);
      if (typeof parsed?.cwd === 'string' && parsed.cwd) { scope = scopeKeyFromPath(parsed.cwd); break; }
    }
  } catch { scope = null; }
  SESSION_LOG_SCOPE_CACHE.set(sessionId, scope);
  capSessionMap(SESSION_LOG_SCOPE_CACHE);
  return scope;
}

export function resolveSessionScope({ session = null, store = null, storeRoot = null } = {}) {
  const cwd = typeof session?.cwd === 'string' && session.cwd.trim() !== '' ? session.cwd : process.cwd();
  const direct = scopeKeyFromPath(cwd);
  const home = storeRoot ? path.dirname(storeRoot) : null;
  if (!home) return { scope: direct, from: 'session-cwd' };
  const under = direct.replace(/^w:/, '').toLowerCase().startsWith(home.split(String.fromCharCode(92)).join('/').toLowerCase());
  if (!under) return { scope: direct, from: 'session-cwd' };
  const idx = sessionScopeIndex(store);
  const sid = typeof session?.id === 'string' ? session.id : null;
  const fallback = sid ? idx.get(sid) : null;
  if (fallback) return { scope: fallback, from: 'episode-fallback' };
  // 新会话还没归档过：直接读它的日志 header（第一帧 = session 元数据，含真实 cwd）。
  const fromLog = sessionLogScope(sid, home);
  if (fromLog) return { scope: fromLog, from: 'session-log' };
  return { scope: direct, from: 'session-cwd' };
}

// ---------------------------------------------------------------------------
// A7 · prompt cache 前缀失效读数（task-18 / P0-5）
//
// 上游依据（Anthropic prompt caching 的规则原文，转述见 evidence/research/mem-vendors.md §1）：
//   · 缓存是**前缀累积哈希**，层级 `tools → system → messages`：改早层 ⇒ **该层及其后全部失效**；
//   · **尾部追加**天然命中原缓存；把 breakpoint 放在"每请求都变的块"上 = 每次写、永不读（官方点名的坑）；
//   · 官方 context editing 也承认清理会失效前缀，要求 `clear_at_least` 让一次失效"值回票价"。
// 所以我们唯一需要的成本读数就一句话：**这一轮有没有把上一轮已经发出去的前缀改掉**。
//   · 尾部追加（消息变多、前面一字不动）⇒ **不是** break（这正是"只有尾部追加能全命中"）；
//   · 改早层 / 压缩 / 槽位覆盖把已发出的卡正文改掉 ⇒ **是** break。
//
// 为什么放在本文件：两半都是"不是业务判断、但必须能被单独钉住"的东西 ——
//   ① 判据是**纯函数**（`prefixHashOf` / `planCacheBreakRow`），单测可以逐位断言；
//   ② 落盘只有**一处**（`appendCacheBreak`），且与这里的其它读面同性质：失败一律降级，绝不抛给注入链路。
//
// 账本格式（`<storeRoot>/cache-breaks.jsonl`，append-only，一行一轮）：
//   {"schemaVersion":1,"at":<epoch ms>,"sid":"<session.id>","round":N,"action":"inject|skip|shadow",
//    "beforeHash":"<16 hex>","afterHash":"<16 hex>","prevHash":"<16 hex>|null","prevCount":N|null,
//    "intact":true|false,"cacheBreak":true|false,"breakReason":"first-round|tail-append|prefix-changed|prefix-shrunk",
//    "injectedChars":N,"msgsBefore":N,"msgsAfter":N}
// ---------------------------------------------------------------------------

/** A7 账本文件名（相对 `<storeRoot>`）。 */
export const CACHE_BREAKS_FILE = 'cache-breaks.jsonl';
/** A7 账本行的格式版本（读侧不认识就**不认这一行**；不静默把新格式当旧格式算）。 */
export const CACHE_BREAKS_SCHEMA_VERSION = 1;

/**
 * 稳定前缀 hash（纯函数，可逐位断言）。
 *
 * @param {string[]} tokens 每项 = 一条消息的**稳定投影**（`role + 文本`；**不带 id / 时间戳**）
 * @param {{count?:number|null}} [opts] 只取前 `count` 条 —— 判"上一轮已发送区是否逐字保留"时用
 * @returns {string} sha256 前 16 个 hex（64 bit）
 *
 * 为什么投影里不带 id / 时间戳：宿主每步都可能重建消息对象（`createUserMessage` 就是 `randomUUID()`），
 * 把 id 算进 hash 会让"内容一个字都没变"也判成变化 —— 那是把判据变成噪声（假红恒为 100%）。
 * 已知边界：非文本块（`tool_use` 参数体 / `tool_result` 的结构）不进投影，它们的变化不会被记成 break。
 */
export function prefixHashOf(tokens, { count = null } = {}) {
  const list = Array.isArray(tokens) ? tokens : [];
  const n = Number.isFinite(count) ? Math.max(0, Math.min(list.length, Math.floor(count))) : list.length;
  const h = createHash('sha256');
  for (let i = 0; i < n; i += 1) {
    // 分隔符用控制字符：文本里不会出现，避免"两条消息拼起来一摸一样"这种碰撞。
    h.update(`${i}\u001f`);
    h.update(String(list[i] ?? ''));
    h.update('\u001e');
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * 一轮的读数（纯函数）：给"注入前 / 注入后"两段消息序列 + 同会话上一条记录 ⇒ 账本行 + 是否失效。
 *
 * @param {object} input
 * @param {number|null} input.at              记录时刻（epoch ms；调用方用 `clockOf(config)`，测试可写死）
 * @param {string|null} input.sessionId       稳定会话键（`session.id`，与仓里其它会话键同一把）
 * @param {string} input.action               `inject` / `skip` / `shadow` / `abstain`
 * @param {string[]} input.beforeTokens       注入**前**整段请求的稳定投影（宿主交给我们时的那一份）
 * @param {string[]} input.afterTokens        注入**后**整段请求的稳定投影（真正发出去的那一份）
 * @param {number} [input.injectedChars]      本轮注入的字符数（没注入 = 0）
 * @param {object|null} [input.prev]          同会话上一条账本行（首轮 = null）；跨 apply/重启从账本回读
 * @returns {{row:object, intact:boolean}}
 */
export function planCacheBreakRow({ at = null, sessionId = null, action = 'skip', beforeTokens = [], afterTokens = [], injectedChars = 0, prev = null } = {}) {
  const before = Array.isArray(beforeTokens) ? beforeTokens : [];
  const after = Array.isArray(afterTokens) ? afterTokens : [];
  const beforeHash = prefixHashOf(before);
  const afterHash = prefixHashOf(after);
  const hasPrev = Boolean(prev) && Number.isFinite(prev?.msgsAfter) && typeof prev?.afterHash === 'string';
  const prevCount = hasPrev ? Math.floor(prev.msgsAfter) : null;
  let intact = true;
  let breakReason = 'first-round';
  if (hasPrev) {
    if (prevCount > after.length) {
      // 已发送区比这一轮还长 ⇒ 前面的消息被丢掉了（压缩 / 截断 / 重建）⇒ 前缀必然失效。
      intact = false;
      breakReason = 'prefix-shrunk';
    } else if (prefixHashOf(after, { count: prevCount }) === prev.afterHash) {
      intact = true;
      breakReason = 'tail-append'; // 上一轮发出去的整段前缀逐字保留 ⇒ 全命中，只有尾部是新的
    } else {
      intact = false;
      breakReason = 'prefix-changed'; // 早层被改写（改卡内文 / 换序 / 插到中间）
    }
  }
  return {
    row: {
      schemaVersion: CACHE_BREAKS_SCHEMA_VERSION,
      at: Number.isFinite(at) ? Number(at) : Date.now(),
      sid: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
      round: hasPrev ? Math.floor(prev.round) + 1 : 1,
      action: String(action ?? 'skip'),
      beforeHash,
      afterHash,
      prevHash: hasPrev ? prev.afterHash : null,
      prevCount,
      intact,
      cacheBreak: !intact,
      breakReason,
      injectedChars: Number.isFinite(injectedChars) && injectedChars > 0 ? Math.floor(injectedChars) : 0,
      msgsBefore: before.length,
      msgsAfter: after.length,
    },
    intact,
  };
}

/** 读一个 jsonl 文件的**尾部**若干字节（丢掉被截断的残行；坏行跳过，账本坏了不许影响判定）。 */
function readJsonlTail(file, maxBytes) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    const size = Number(stat.size) || 0;
    const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : CACHE_BREAKS_TAIL_BYTES;
    const start = size > cap ? size - cap : 0;
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // 从中间切进来的第一行一定是残行（还可能在多字节字符中间）⇒ 整行丢掉。
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const rows = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === 'object') rows.push(row);
      } catch { /* 坏行跳过 */ }
    }
    return rows;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 关不掉不影响读数 */ }
    }
  }
}

/**
 * 追加一行 A7 读数（append-only；撞上限**轮转**成 `.1` 而不是停写）。
 *
 * 为什么轮转而不是停写：停写会让 A7 静默变旧 —— 读的人看到的永远是撞线那天的值，
 * 而"指标悄悄不动了"正是要防的那类假绿。轮转 = 旧行整体改名，读数仍然连续。
 * @returns {{status:'written'|'rotated'|'absent'|'failed', file?:string, fileBytes:number, rotated?:boolean, error?:string}}
 */
export function appendCacheBreak({ storeRoot = null, row = null, maxBytes = CACHE_BREAKS_MAX_BYTES } = {}) {
  if (!row || typeof row !== 'object') return { status: 'absent', fileBytes: 0, rotated: false };
  try {
    // 不创建库目录：库还不存在时不写账本，避免把"无库"变成"有库"（与 live-stats 同一条纪律）。
    if (typeof storeRoot !== 'string' || storeRoot === '' || !fs.existsSync(storeRoot)) return { status: 'absent', fileBytes: 0, rotated: false };
    const file = path.join(storeRoot, CACHE_BREAKS_FILE);
    const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : CACHE_BREAKS_MAX_BYTES;
    let stat = null;
    try { stat = fs.statSync(file); } catch { stat = null; }
    const fileBytes = stat ? Number(stat.size) || 0 : 0;
    let rotated = false;
    if (stat && fileBytes >= cap) {
      const backup = `${file}.1`;
      try { fs.rmSync(backup, { force: true }); } catch { /* 备份删不掉就覆盖 */ }
      try { fs.renameSync(file, backup); rotated = true; } catch { rotated = false; }
    }
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    return { status: rotated ? 'rotated' : 'written', file, fileBytes, rotated };
  } catch (error) {
    return { status: 'failed', fileBytes: 0, rotated: false, error: String(error?.message ?? error) };
  }
}

/**
 * 读 A7 账本（轮转备份 + 当前文件，各自只取尾部 `maxBytes`；旧行在前、新行在后）。
 * 读数窗口 = 这两个文件的尾读范围 —— 不是"全部历史"，因为宿主每步都写，全读会随运行时长线性变贵。
 */
export function readCacheBreaks({ storeRoot = null, maxBytes = CACHE_BREAKS_TAIL_BYTES } = {}) {
  if (typeof storeRoot !== 'string' || storeRoot === '') return [];
  const file = path.join(storeRoot, CACHE_BREAKS_FILE);
  const rows = [];
  const rotated = `${file}.1`;
  if (fs.existsSync(rotated)) rows.push(...readJsonlTail(rotated, maxBytes));
  if (fs.existsSync(file)) rows.push(...readJsonlTail(file, maxBytes));
  return rows;
}

/**
 * 同会话最近一条可用读数（**跨 apply / 跨重启的判据**：账本是权威，进程内 Map 只是快路）。
 * 只认字段齐全的行（残行 / 更早格式不算），坏行跳过、绝不抛。
 */
export function lastCacheBreakRow({ storeRoot = null, sessionId = null, maxBytes = CACHE_BREAKS_TAIL_BYTES } = {}) {
  const rows = readCacheBreaks({ storeRoot, maxBytes });
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    if (Number.isFinite(row.schemaVersion) && row.schemaVersion !== CACHE_BREAKS_SCHEMA_VERSION) continue; // 不认识的版本不认
    if (sessionId ? row.sid !== sessionId : row.sid != null) continue;
    if (!Number.isFinite(row.round) || !Number.isFinite(row.msgsAfter) || typeof row.afterHash !== 'string') continue;
    if (typeof row.cacheBreak !== 'boolean') continue;
    return row;
  }
  return null;
}

/**
 * A7 汇总（纯函数）：**前缀变化次数 / 轮数** —— 只统计，**不判红**（指标先有消费者）。
 * @param {object[]} rows 账本行
 * @returns {{rounds:number, breaks:number, rate:number|null, injectedChars:number, byReason:object, lastAt:number|null}}
 */
export function aggregateCacheBreak(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && typeof row === 'object'
      && typeof row.cacheBreak === 'boolean'
      // 不认识的版本**不认**（与 `lastCacheBreakRow` 同一口径）：新格式的语义可能不同，
      // 拿来按旧口径统计就是"静默漂移"。没有版本号的旧行仍计入（当时就是这一套口径）。
      && !(Number.isFinite(row.schemaVersion) && row.schemaVersion !== CACHE_BREAKS_SCHEMA_VERSION),
  );
  const rounds = list.length;
  let breaks = 0;
  let injectedChars = 0;
  let lastAt = null;
  const byReason = {};
  for (const row of list) {
    if (row.cacheBreak === true) breaks += 1;
    const reason = String(row.breakReason ?? 'unknown');
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (Number.isFinite(row.injectedChars) && row.injectedChars > 0) injectedChars += Math.floor(row.injectedChars);
    if (Number.isFinite(row.at) && (!Number.isFinite(lastAt) || row.at > lastAt)) lastAt = Number(row.at);
  }
  return { rounds, breaks, rate: rounds > 0 ? breaks / rounds : null, injectedChars, byReason, lastAt };
}

/** 一步到位：读账本 + 汇总（metrics-guard / 脚本用）。读失败 ⇒ 全 null 的读数（**不许把"读不到"当 0**）。 */
export function readCacheBreakStats({ storeRoot = null, maxBytes = CACHE_BREAKS_TAIL_BYTES } = {}) {
  try {
    const rows = readCacheBreaks({ storeRoot, maxBytes });
    return { ...aggregateCacheBreak(rows), rows: rows.length, root: storeRoot ?? null, error: null };
  } catch (error) {
    return { ...aggregateCacheBreak([]), rows: 0, root: storeRoot ?? null, error: String(error?.message ?? error) };
  }
}
