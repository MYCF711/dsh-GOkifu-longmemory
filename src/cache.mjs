// src/cache.mjs —— 插件侧的**进程内缓存与读取面**：walk cache / bundle 读取 / 探针缓存 / 会话作用域缓存。
//
// 为什么单独成文件（重构 C 期 M1）：这些东西的共同点是 **"可以随时重算、但重算很贵"**
// —— 它们唯一正确的行为是"命中时快、换版本就换、闲置就摘掉、条数有上界"，而不是业务判断。
// 拆出来之后"缓存有没有泄漏"只需要看这一个文件。
//
// 边界：
//   · 只读 sidecar（store 由调用方给），**不写任何盘**；
//   · 失败一律降级（返回 null / 不缓存），绝不抛给注入链路；
//   · 所有 Map 都有界或按桶清理（T61 / T64：宿主进程长驻，无界增长就是内存泄漏）。
import { zstdDecompressSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { scopeKeyFromPath } from './rooms/inject.mjs';
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
