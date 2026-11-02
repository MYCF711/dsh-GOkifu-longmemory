// src/plugin.mjs —— 棋院（Kifu-in）的**宿主插件入口**：`agent/pre-step` 上的记忆卡注入。
//
// ── 这是什么 ────────────────────────────────────────────────────────────────
// 真注入的唯一一刀。每轮每次进入 step 前，`agent/pre-step` 先拿下游默认 decision，
// 只有 `decision.kind === "enter"` 时才考虑：拿本轮最后一条 user 文本当信号 → 走 R11 walk →
// R12 buildMemoryCard → R13 runGates；闸全绿且**确实有内容**，才把一张记忆卡插进
// `decision.messages`（插在"最后一条 claimed 消息"之后），并**每会话只插一次**。
//
// ── 接缝（上游 dsh-GOkifu-compact 已核实，src/engine.mjs 的 `ctx.on("agent/pre-step", …)`）──
//   ctx.on("agent/pre-step", async (payload, next) => {
//     const decision = await next();                       // waterfall：取下游默认
//     if (decision.kind !== "enter") return decision;      // 非 enter 不动
//     … 返回 { ...decision, messages: 新数组 } 才算替换入步消息
//   })
//   注入位置（与压缩插件同一套语义，两个替换**互不代管**）：
//     const lastClaimed = decision.messages.findLastIndex((m) => payloadMessages.includes(m));
//     const entered = decision.messages.toSpliced(Math.max(lastClaimed, 0) + 1, 0, message);
//   消息形状：`createUserMessage({content:[{type:"text",text}], source:{kind,form,digest}})`
//   —— 从 `@deepseek-ai/dsh-llm` **动态 import**（config 可注入替身；宿主没这个包时安静跳过）。
//
// ── 边界（硬规则，逐条对应 docs/记忆的职责边界.md §2/§5）──────────────────
//   · 只读：只读 sidecar（`<DSH_HOME>/memory-context`）与只写 `evidence/shadow/`（影子模式）。
//   · **不写会话事件**、不 `session.append`、不改会话日志：唯一的输出就是返回的 decision。
//   · **不阻塞会话**：store 缺失 / 构建抛错 / 闸门不过 / 消息造不出来 —— 一律 `ctx.logger?.warn` +
//     原样返回下游 decision。这个函数没有"失败"分支，只有"少说一句"。
//   · 注入内容只陈述事实：祈使句/许可/建议由 R13 边界闸判，`gates.ok === false` 就不注入。
//   · 成本：默认预算 500 tokens（实测最坏 ~300），首轮那行 ~35 tokens；不命中零注入。
//
// ── 配置（默认全关）──────────────────────────────────────────────────────
//   enabled         false  —— 真注入总开关；**只有 true 才可能改 decision**
//   shadow          true   —— 影子模式：只落 evidence/shadow/shadow.jsonl，永远返回原 decision
//   storeRoot       null   —— 默认 `<DSH_HOME>/memory-context`
//   shadowDir       null   —— 默认 `<repo>/evidence/shadow`（不得在 $DSH_HOME 内，硬守卫）
//   budgetTokens    500    —— 卡片预算（口径 = indexLine + section）
//   limit           5      —— 条数上限
//   oncePerSession  true   —— 每会话只注入一次（WeakSet）
//   now             null   —— 固定时钟（测试/回放用）
//   createUserMessage null —— 消息构造替身（测试用；缺省动态 import 宿主包）
//   probeValidity    true   —— 闸 3 真核验（true 才调 fs/git；false ⇒ 闸 3 记 unverified）
//   deps             null  —— 依赖替身（测试用：createStore/walk/buildMemoryCard/runGates/writeShadow）

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildMemoryCard,
  defaultShadowDir,
  filterHitsByScope,
  scopeKeyFromPath,
  signalFromText,
  writeShadow,
} from './rooms/inject.mjs';
import { probeValidity, validityKeyOf, runGates } from './rooms/gates.mjs';
import { classifyErrorClass } from './rooms/claim.mjs';
import { errorClassKeyOf } from './rooms/topic.mjs';
import { createStore } from './rooms/persist.mjs';
import { createWalkCache } from './rooms/walk.mjs';

/** 插件名（宿主用来标识这个插件）。 */
export const name = 'dsh-gokifu-longmemory';
/** 配置/消息格式的版本号（改消息形状时 +1，便于事后认账）。 */
export const PLUGIN_VERSION = 1;
/** 注入消息的 source 标识（宿主里一眼能认出是棋院写的）。 */
export const CARD_SOURCE_KIND = 'dsh-gokifu-longmemory';
export const CARD_SOURCE_FORM = 'memory-card';
/** 挂的钩子名。 */
export const HOOK = 'agent/pre-step';
/** 宿主消息包的包名（动态 import；解析不到就安静跳过）。 */
export const LLM_PACKAGE = '@deepseek-ai/dsh-llm';

export const DEFAULT_CONFIG = Object.freeze({
  // 零配置（2026-11-02 主人裁定）：装完即用；库不存在时自动建库、本次沉默。
  enabled: true,
  shadow: false,
  autoBuild: true,
  storeRoot: null,
  shadowDir: null,
  budgetTokens: 500,
  limit: 5,
  oncePerSession: true,
  now: null,
  createUserMessage: null,
  probeValidity: true,
  autoBuild: true,
  autoArchive: true,
  autoArchiveMinutes: 30,
  crossScopeClass: false,
  repeatHint: true,
  repeatHintAfter: 2,
  repeatHintMax: 1,
  deps: null,
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 用户配置（GUI 保存的「记忆库地址」等）落在 <DSH_HOME>/kifu-longmemory.json。
// 优先级：profile 配置 > 用户文件 > 默认值。文件坏了只 warn，不阻塞。
// ---------------------------------------------------------------------------
export const USER_CONFIG_FILE = 'kifu-longmemory.json';

function dshHomeOf() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME ? process.env.DSH_HOME : null;
}

export function readUserConfig({ dshHome = null } = {}) {
  const home = dshHome ?? dshHomeOf();
  if (!home) return {};
  try {
    const raw = fs.readFileSync(path.join(home, USER_CONFIG_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeUserConfig(patch, { dshHome = null } = {}) {
  const home = dshHome ?? dshHomeOf();
  if (!home) throw new Error('没有 DSH_HOME，无法保存插件配置');
  const current = readUserConfig({ dshHome: home });
  const next = { ...current, ...patch };
  const file = path.join(home, USER_CONFIG_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}
`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
}

/** profile 配置覆盖用户文件；两者都不认识的值由 sanitizeConfig 兜底。 */
export function resolveConfig(rawConfig = {}) {
  return sanitizeConfig({ ...readUserConfig(), ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) });
}

// ---------------------------------------------------------------------------
// 小工具（全部纯函数，单独导出便于单测）
// ---------------------------------------------------------------------------

function boolOf(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function positiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** 配置净化：只认已知键、类型不对就退回默认（不静默接受垃圾）。 */
export function sanitizeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: boolOf(src.enabled, DEFAULT_CONFIG.enabled),
    shadow: boolOf(src.shadow, DEFAULT_CONFIG.shadow),
    storeRoot: typeof src.storeRoot === 'string' && src.storeRoot.trim() !== '' ? src.storeRoot.trim() : null,
    shadowDir: typeof src.shadowDir === 'string' && src.shadowDir.trim() !== '' ? src.shadowDir.trim() : null,
    budgetTokens: positiveInt(src.budgetTokens, DEFAULT_CONFIG.budgetTokens, 100000),
    limit: positiveInt(src.limit, DEFAULT_CONFIG.limit, 100),
    oncePerSession: boolOf(src.oncePerSession, DEFAULT_CONFIG.oncePerSession),
    now: Number.isFinite(src.now) ? Number(src.now) : (typeof src.now === 'function' ? src.now : null),
    createUserMessage: typeof src.createUserMessage === 'function' ? src.createUserMessage : null,
    probeValidity: boolOf(src.probeValidity, true),
    autoBuild: boolOf(src.autoBuild, true),
    autoArchive: boolOf(src.autoArchive, true),
    autoArchiveMinutes: positiveInt(src.autoArchiveMinutes, 30, 24 * 60),
    crossScopeClass: boolOf(src.crossScopeClass, false),
    repeatHint: boolOf(src.repeatHint, true),
    repeatHintAfter: positiveInt(src.repeatHintAfter, 2, 20),
    repeatHintMax: positiveInt(src.repeatHintMax, 1, 5),
    deps: src.deps && typeof src.deps === 'object' && !Array.isArray(src.deps) ? src.deps : null,
  };
}

/** 一条消息的纯文本（兼容 `content: "…"` / `[{type:"text",text}]` / `{text}` 三种形态）。 */
export function messageText(message) {
  if (!message || typeof message !== 'object') return typeof message === 'string' ? message : '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type !== undefined && block.type !== 'text') continue;
      if (typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n').trim();
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text.trim();
  if (typeof message.text === 'string') return message.text.trim();
  return '';
}

/** 本轮信号：`payload.messages` 里**最后一条有文本的 user 消息**。 */
export function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message && typeof message === 'object' && message.role && message.role !== 'user') continue;
    const text = messageText(message);
    if (text) return text;
  }
  return '';
}

/** 卡片指纹：同 scope + 同文本 ⇒ 同 digest（可复算，不含时钟）。 */
export function digestOf(scopeKey, text) {
  return createHash('sha256').update(`${String(scopeKey ?? '')}\u0000${String(text ?? '')}`).digest('hex').slice(0, 16);
}

/**
 * 把消息插到"最后一条 claimed 消息"之后。
 * claimed = 本轮真正被喂给模型的那批消息（`payload.messages`），用**引用**判定。
 * 与上游压缩插件同一语义（`Math.max(lastClaimed, 0) + 1`）：找不到 claimed 就插在开头之后。
 */
export function insertAfterClaimed(messages, claimed, message) {
  // messages 不是数组 ⇒ 不予拼接（返回 null，调用方据此跳过注入，绝不重建一个空列表）
  if (!Array.isArray(messages)) return null;
  const list = messages;
  if (typeof list.toSpliced !== 'function') return null;
  const claimedSet = new Set(Array.isArray(claimed) ? claimed.filter((m) => m && typeof m === 'object') : []);
  let lastClaimed = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (claimedSet.has(list[i])) lastClaimed = i;
  }
  return list.toSpliced(Math.max(lastClaimed, 0) + 1, 0, message);
}

/** 注入文本：首轮那一行 + 命中展开（没有展开就只给那一行）。 */
export function cardText(card) {
  if (!card || typeof card !== 'object') return '';
  const line = typeof card.indexLine === 'string' ? card.indexLine.trim() : '';
  const section = typeof card.section === 'string' ? card.section.trim() : '';
  return [line, section].filter(Boolean).join('\n');
}

function warn(ctx, line) {
  try {
    if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(`dsh-gokifu-longmemory: ${line}`);
  } catch {
    // 记日志本身失败也不许影响会话
  }
}

/** 时钟：允许把 `now` 固定成数字或函数（测试/回放）。 */
function clockOf(config) {
  if (typeof config.now === 'function') {
    const v = config.now();
    if (Number.isFinite(v)) return Number(v);
  }
  if (Number.isFinite(config.now)) return Number(config.now);
  return Date.now();
}

// ---------------------------------------------------------------------------
// 依赖（默认真实现；`config.deps` 可注入替身，测试用）
// ---------------------------------------------------------------------------

async function resolveDeps(config) {
  const injected = config.deps ?? {};
  let walk = typeof injected.walk === 'function' ? injected.walk : null;
  if (!walk) {
    try {
      const mod = await import('./rooms/walk.mjs');
      walk = typeof mod.walkFromSignals === 'function' ? mod.walkFromSignals : null;
    } catch {
      walk = null; // R11 缺位：降级到 R12 的 degradedWalk（注入函数自己会兜）
    }
  }
  return {
    createStore: typeof injected.createStore === 'function' ? injected.createStore : createStore,
    createWalkCache: typeof injected.createWalkCache === 'function' ? injected.createWalkCache : createWalkCache,
    buildMemoryCard: typeof injected.buildMemoryCard === 'function' ? injected.buildMemoryCard : buildMemoryCard,
    runGates: typeof injected.runGates === 'function' ? injected.runGates : runGates,
    probeValidity: typeof injected.probeValidity === 'function' ? injected.probeValidity : probeValidity,
    buildStore: typeof injected.buildStore === 'function' ? injected.buildStore : null,
    writeShadow: typeof injected.writeShadow === 'function' ? injected.writeShadow : writeShadow,
    walk,
    createUserMessage: typeof injected.createUserMessage === 'function' ? injected.createUserMessage : null,
  };
}

function expandHomePlaceholder(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : '';
  const hasPlaceholder = /^(<DSH_HOME>|\$DSH_HOME)([\/]|$)/i.test(text);
  if (!hasPlaceholder) return text;
  if (!home) return null; // 占位符解析不了就当作没有配置（宁可沉默，不去猜一个路径）
  return text.replace(/^(<DSH_HOME>|\$DSH_HOME)/i, home);
}

function resolveStoreRoot(config) {
  if (config.storeRoot) {
    const expanded = expandHomePlaceholder(config.storeRoot);
    return expanded ? path.resolve(expanded) : null;
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : '';
  if (!home) return null;
  return path.resolve(home, 'memory-context');
}

function resolveShadowDir(config) {
  if (config.shadowDir) {
    const expanded = expandHomePlaceholder(config.shadowDir);
    return expanded ? path.resolve(expanded) : null;
  }
  try {
    return defaultShadowDir();
  } catch {
    return path.join(REPO_ROOT, 'evidence', 'shadow');
  }
}

/** 造一条 user 消息（宿主包动态 import；config 可注入替身）。 */
async function resolveCreateUserMessage(config, deps) {
  if (config.createUserMessage) return config.createUserMessage;
  if (deps.createUserMessage) return deps.createUserMessage;
  const mod = await import(LLM_PACKAGE);
  if (typeof mod?.createUserMessage !== 'function') {
    throw new Error(`${LLM_PACKAGE} 没有导出 createUserMessage`);
  }
  return mod.createUserMessage;
}

// ---------------------------------------------------------------------------
// 一次 pre-step 的决策（纯：不改入参、不写会话；返回值给 apply 用）
// ---------------------------------------------------------------------------

/**
 * 只为"这张卡里出现的条目"跑 validity 核验（闸 3 的输入）。
 * 为什么要限制范围：plugin 在每一步都会被调，扫全库太贵；卡片最多 `limit` 条。
 * 任何异常都吞成"没有结果"（⇒ 闸 3 记 unverified，而不是注入失败）。
 */
const PROBE_CACHE = new Map();
const PROBE_TTL_MS = 60_000;

function probeCardValidity({ card, store, deps, fallbackWorkspace = null, now = null }) {
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
    const bucket = Math.floor((Number.isFinite(now) ? now : Date.now()) / PROBE_TTL_MS);
    const cacheKey = `${key}|${fallbackWorkspace ?? ''}|${bucket}`;
    if (PROBE_CACHE.has(cacheKey)) {
      results[key] = PROBE_CACHE.get(cacheKey);
      continue;
    }
    try {
      results[key] = deps.probeValidity(record, { workspace: fallbackWorkspace, now });
      PROBE_CACHE.set(cacheKey, results[key]);
    } catch (error) {
      results[key] = { ok: false, reason: `probe-error:${String(error?.message ?? error)}`, checkedAt: now };
    }
  }
  return results;
}

/**
 * @returns {{decision:object, action:string, reason:string|null, card?:object, gates?:object, digest?:string}}
 *   action: `inject` | `shadow` | `skip`
 */
async function decidePreStep({ ctx, config, deps, payload, decision }) {
  const session = payload?.agent?.session ?? payload?.session ?? null;
  const text = lastUserText(payload?.messages);

  // 既没开真注入也不是影子 ⇒ 什么都不做（默认配置走这条）
  if (!config.enabled && !config.shadow) return { decision, action: 'skip', reason: 'disabled' };
  if (!text) return { decision, action: 'skip', reason: 'no-signal' };

  const storeRoot = resolveStoreRoot(config);
  if (!storeRoot) return { decision, action: 'skip', reason: 'no-store-root' };
  if (!fs.existsSync(storeRoot)) {
    warn(ctx, `记忆库不存在：${storeRoot}（本次沉默；${config.autoBuild ? '后台建库中' : '未开 autoBuild'}）`);
    if (config.autoBuild) scheduleAutoBuild({ ctx, storeRoot, deps });
    return { decision, action: 'skip', reason: 'no-store' };
  }

  const at = clockOf(config);
  const store = deps.createStore({ root: storeRoot });
  const cwd = typeof session?.cwd === 'string' && session.cwd.trim() !== '' ? session.cwd : process.cwd();
  const scope = scopeKeyFromPath(cwd);
  const signal = signalFromText(text, { at });
  signal.scopeKey = scope;
  // 首条消息里若直接贴着报错原文（很常见："又报这个错"），把类级错误作为实体信号，
  // 让「同一类坑」的历史棋谱能被直接命中（D2 类主题的消费方，2026-11-02）。
  const errClass = errorClassKeyOf(text);
  if (errClass) {
    signal.entities = Array.isArray(signal.entities) ? signal.entities : [];
    if (!signal.entities.some((e) => String(e?.key ?? '') === errClass)) {
      signal.entities.push({ kind: 'error', key: errClass });
    }
  }

  const cache = deps.walk ? walkCacheFor(storeRoot, store, deps) : null;
  let walk = null;
  if (deps.walk) {
    walk = deps.walk({ signal, store, scope, cache, depth: 2, limit: config.limit, budgetTokens: config.budgetTokens, allowCrossScopeClass: config.crossScopeClass === true }) ?? null;
  }
  if (!walk) {
    const { degradedWalk } = await import('./rooms/inject.mjs');
    walk = degradedWalk({ signal, store, limit: config.limit });
  }
  const scoped = filterHitsByScope(walk.hits ?? [], scope);
  const walkResult = {
    ...walk,
    hitCount: Array.isArray(walk.hits) ? walk.hits.length : 0,
    hits: scoped.hits,
    crossScope: scoped.dropped,
    unknownScope: scoped.droppedUnknown,
    crossScopeWalk: (Number.isFinite(walk?.dropped?.crossScope) ? walk.dropped.crossScope : 0)
      + (Number.isFinite(walk?.dropped?.scopeMissing) ? walk.dropped.scopeMissing : 0),
  };

  const card = deps.buildMemoryCard({
    cache,
    signal,
    walkResult,
    store,
    scope,
    now: at,
    limit: config.limit,
    budgetTokens: config.budgetTokens,
    droppedCrossScope: scoped.dropped,
    droppedUnknownScope: scoped.droppedUnknown,
  });
  // 闸 3 真核验：只核**这张卡里出现的**条目（≤ limit 条），够用且不会每步扫全库。
  // 每条按它自己的 scopeKey 解析工作区（probeValidity 内部做），失败只记 reason、绝不抛。
  const validityResults = config.probeValidity === false ? null : probeCardValidity({ card, store, deps, fallbackWorkspace: cwd, now: at });
  const gates = deps.runGates({ card, walkResult, store, cache, scope, validityResults });
  const text2 = cardText(card);
  const digest = digestOf(scope, text2);

  // 影子模式：只记录"本来会注入什么"，永远返回原 decision
  if (config.shadow) {
    try {
      deps.writeShadow({ dir: resolveShadowDir(config), card, signal, at });
      return { decision, action: 'shadow', reason: null, card, gates, digest };
    } catch (error) {
      warn(ctx, `影子记录写入失败（本轮不动）：${String(error?.message ?? error)}`);
      return { decision, action: 'skip', reason: 'shadow-write-failed', card, gates, digest };
    }
  }

  if (!config.enabled) return { decision, action: 'skip', reason: 'disabled', card, gates, digest };
  if (!gates?.ok) {
    warn(ctx, `闸门未通过（本轮不注入）：${(gates?.errors ?? []).map((e) => e.code).slice(0, 5).join(', ')}`);
    return { decision, action: 'skip', reason: 'gates-failed', card, gates, digest };
  }
  if (!card?.section || !text2) return { decision, action: 'skip', reason: 'no-hit', card, gates, digest };

  const createUserMessage = await resolveCreateUserMessage(config, deps);
  const message = createUserMessage({
    content: [{ type: 'text', text: text2 }],
    source: {
      kind: CARD_SOURCE_KIND,
      form: CARD_SOURCE_FORM,
      digest,
      pluginVersion: PLUGIN_VERSION,
    },
  });
  const messages = insertAfterClaimed(decision.messages, payload?.messages, message);
  if (!messages) {
    warn(ctx, 'decision.messages 不是可拼接的数组（本轮不注入）');
    return { decision, action: 'skip', reason: 'no-message-list', card, gates, digest };
  }
  return { decision: { ...decision, messages }, action: 'inject', reason: null, card, gates, digest };
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * 挂载插件。**默认什么都不做**（`enabled:false, shadow:true`），失败绝不阻塞会话。
 *
 * @param {object} ctx  宿主上下文（用 `ctx.on`、`ctx.logger?.warn`；其余一概不碰）
 * @param {object} [rawConfig]
 * @returns {{name:string, hook:string, registered:boolean, config:object}}
 */
const WALK_CACHES = new Map();

const BUILDING = new Set();

/** 零配置：库不存在时后台建一次（不阻塞本轮；失败只 warn，不重试风暴）。 */
function scheduleAutoBuild({ ctx, storeRoot, deps = null, reason = 'missing' }) {
  if (!storeRoot || BUILDING.has(storeRoot)) return;
  BUILDING.add(storeRoot);
  const run = async () => {
    try {
      const dataRoot = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME ? process.env.DSH_HOME : null;
      if (typeof deps?.buildStore === 'function') {
        await deps.buildStore({ storeRoot, dataRoot });
      } else {
        const mod = await import('../scripts/archive.mjs');
        if (typeof mod.runArchive !== 'function') throw new Error('archive.mjs 未导出 runArchive');
        if (!dataRoot) throw new Error('没有 DSH_HOME，无法建库');
        await mod.runArchive({ dataRoot, storeRoot, dryRun: false, user: 'owner' });
      }
      warn(ctx, `记忆库已刷新（${reason}）：${storeRoot}`);
    } catch (error) {
      warn(ctx, `自动建库失败：${String(error?.message ?? error)}`);
      BUILDING.delete(storeRoot); // 失败允许下次再试；成功不重试
    }
  };
  setTimeout(() => { run(); }, 0);
}

function walkCacheFor(storeRoot, store, deps) {
  try {
    const mf = `${storeRoot}/manifest.json`;
    const stamp = fs.existsSync(mf) ? fs.statSync(mf).mtimeMs : 0;
    const key = `${storeRoot}::${stamp}`;
    if (WALK_CACHES.has(key)) return WALK_CACHES.get(key);
    const build = typeof deps.createWalkCache === 'function' ? deps.createWalkCache : createWalkCache;
    const cache = build(store);
    WALK_CACHES.set(key, cache);
    return cache;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 设置页 schema（2026-11-02）：让设置 UI 能展示/选择"记忆库地址"等配置。
// 形状与 dsh-unlag 的 Config 一致：type/dict/meta + ~standard.validate（不引入 schemastery）。
// ---------------------------------------------------------------------------
export const Config = {
  type: 'object',
  dict: {
    enabled: { type: 'boolean', meta: { default: true, description: '启用记忆注入（关掉 = 完全静默）' } },
    shadow: { type: 'boolean', meta: { default: false, description: '影子模式：只记录本来会注入什么，不真注入' } },
    storeRoot: { type: 'string', meta: { default: '', description: '记忆库地址；留空 = <DSH_HOME>/memory-context（推荐留空）' } },
    autoBuild: { type: 'boolean', meta: { default: true, description: '库不存在时后台自动建库（本次沉默）' } },
    autoArchive: { type: 'boolean', meta: { default: true, description: '轮次收尾时按时间阈值自动刷新记忆库' } },
    autoArchiveMinutes: { type: 'number', meta: { default: 30, description: '自动刷新间隔（分钟）' } },
    crossScopeClass: { type: 'boolean', meta: { default: false, description: '类级章节允许跨工作区先例（卡片标 [跨项目]；Q18 裁定前默认关）' } },
    repeatHint: { type: 'boolean', meta: { default: true, description: '同一会话同类失败 ≥N 次时补一次事实卡（D5）' } },
    repeatHintAfter: { type: 'number', meta: { default: 2, description: '同类失败达到几次才补卡' } },
    budgetTokens: { type: 'number', meta: { default: 500, description: '每次注入的 token 预算' } },
    limit: { type: 'number', meta: { default: 5, description: '每次最多注入几条' } },
    oncePerSession: { type: 'boolean', meta: { default: true, description: '每会话只注入一次（首轮）' } },
  },
  meta: { default: {} },
  toJSON() {
    return { type: 'object', dict: this.dict, meta: this.meta };
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-gokifu-longmemory',
    validate(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      return { value: sanitizeConfig(source) };
    },
  },
};


// ---------------------------------------------------------------------------
// D5（2026-11-02，主人批准）：同一会话里同类失败反复出现 ⇒ 补一次事实卡。
// 触发条件全机械：只看新增消息里的错误行，按 D2 的类归并；每会话最多 repeatHintMax 次。
// 注入内容仍走 decidePreStep → 十道闸，因此仍是事实、带 provenance、无祈使句。
// ---------------------------------------------------------------------------
function repeatErrorLine(text) {
  const lines = String(text ?? '').split(String.fromCharCode(10));
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^error[:：]/i.test(line)) return line;
    if (/\[exit code: [1-9][0-9]*\]/.test(line)) return line;
  }
  return null;
}

export function collectRepeatTrigger(state, messages) {
  if (!state || !Array.isArray(messages)) return null;
  const fresh = messages.slice(state.seen ?? 0);
  state.seen = messages.length;
  let trigger = null;
  for (const message of fresh) {
    const text = messageText(message);
    if (!text) continue;
    const line = repeatErrorLine(text);
    if (!line) continue;
    const cls = classifyErrorClass(line);
    if (!cls) continue;
    const rec = state.counts.get(cls) ?? { count: 0, quote: line };
    rec.count += 1;
    rec.quote = line;
    state.counts.set(cls, rec);
    if (rec.count >= (state.after ?? 2)) trigger = { cls, quote: line, count: rec.count };
  }
  return trigger;
}

function repeatStateFor(map, session, after) {
  const key = typeof session?.id === 'string' ? session.id : (typeof session === 'string' ? session : null);
  if (!key) return null;
  let state = map.get(key);
  if (!state) {
    state = { seen: 0, counts: new Map(), injected: 0, after };
    map.set(key, state);
  }
  state.after = after;
  return state;
}

/**
 * D5 遥测：每触发一次「同类失败补卡」记一行 JSONL。
 * 字段只放机械量：时间 / 类 / 本会话内同类失败次数 / 卡片 token / digest；不含会话内容与路径。
 */
export function writeRepeatTelemetry({ config, trigger, card, digest, at = Date.now() } = {}) {
  const dir = resolveShadowDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    at,
    kind: 'repeat-hint',
    cls: trigger?.cls ?? null,
    count: trigger?.count ?? null,
    tokens: card?.tokens ?? null,
    digest: digest ?? null,
  });
  fs.appendFileSync(path.join(dir, 'repeat-hint.jsonl'), `${line}
`, 'utf8');
}

export const CONFIG_ROUTE = '/kifu-longmemory/config';

/**
 * 设置页用的纯处理函数（不碰 http 对象，便于单测）。
 * GET  → { config, effectiveStoreRoot, userConfigFile }
 * POST → 保存 { storeRoot } 到 <DSH_HOME>/kifu-longmemory.json
 */
/** 库状态（只读、失败静默）：设置页要显示"当前库有多大、什么时候更新的"。 */
export function storeStatsOf(root) {
  if (typeof root !== 'string' || root === '') return null;
  const countJson = (dir) => {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return null; }
  };
  let updatedAt = null;
  try { updatedAt = Number(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).updatedAt) || null; } catch { updatedAt = null; }
  return {
    exists: fs.existsSync(root),
    episodes: countJson(path.join(root, 'episodes')),
    claims: countJson(path.join(root, 'claims')),
    updatedAt,
  };
}

export function handleConfigRoute({ method = 'GET', body = null, profileConfig = {}, dshHome = null } = {}) {
  const home = dshHome ?? dshHomeOf();
  const merged = resolveConfig({ ...readUserConfig({ dshHome: home }), ...profileConfig });
  if (method === 'GET') {
    return {
      status: 200,
      body: (() => {
        const effective = merged.storeRoot ? resolveStoreRoot(merged) : (home ? path.join(home, 'memory-context') : resolveStoreRoot(merged));
        return {
          config: merged,
          effectiveStoreRoot: effective,
          stats: storeStatsOf(effective),
          userConfigFile: home ? path.join(home, USER_CONFIG_FILE) : null,
        };
      })(),
    };
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
  let patch;
  try {
    patch = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { status: 400, body: { error: 'body must be an object' } };
  const next = {};
  if (patch.storeRoot !== undefined) {
    if (typeof patch.storeRoot !== 'string') return { status: 400, body: { error: 'storeRoot must be a string' } };
    const trimmed = patch.storeRoot.trim();
    if (trimmed !== '' && !/^[A-Za-z]:[\/]|^\//.test(trimmed)) return { status: 400, body: { error: 'storeRoot 必须是绝对路径或留空' } };
    next.storeRoot = trimmed;
  }
  for (const key of ['enabled', 'shadow', 'autoBuild', 'oncePerSession']) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'boolean') return { status: 400, body: { error: `${key} must be a boolean` } };
      next[key] = patch[key];
    }
  }
  for (const key of ['budgetTokens', 'limit']) {
    if (patch[key] !== undefined) {
      const n = Number(patch[key]);
      if (!Number.isFinite(n) || n <= 0) return { status: 400, body: { error: `${key} must be a positive number` } };
      next[key] = n;
    }
  }
  try {
    writeUserConfig(next, { dshHome: home });
  } catch (error) {
    return { status: 500, body: { error: String(error?.message ?? error) } };
  }
  return { status: 200, body: { ok: true, saved: next, file: home ? path.join(home, USER_CONFIG_FILE) : null } };
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const injected = new WeakSet(); // 每会话只注入一次（对象身份；WeakSet 不留引用）
  const repeatStates = new Map(); // D5：每个会话的「同类失败计数」

  if (typeof ctx?.on !== 'function') {
    warn(ctx, 'ctx.on 不可用（插件未挂载，宿主行为不变）');
    return { name, hook: HOOK, registered: false, config };
  }

  // 预热：把 walk 需要的四类记录读进内存一次（~0.7s），把成本挪到插件加载，而不是首轮注入。
  // 未开 enabled/shadow 或库不存在时跳过；失败静默（首轮退回冷路径，仍不影响会话）。
  try {
    if (config.enabled || config.shadow) {
      const root = resolveStoreRoot(config);
      if (root && fs.existsSync(root)) {
        walkCacheFor(root, createStore({ root }), { createWalkCache });
      }
    }
  } catch (error) {
    warn(ctx, `预热失败（首轮可能变慢）：${String(error?.message ?? error)}`);
  }

  // 设置页的读写接口（只在本机 webServer 上注册；没有该服务就跳过）。
  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['webServer'], (host) => {
        if (typeof host?.webServer?.register !== 'function') return;
        host.webServer.register({
          kind: 'exact',
          path: CONFIG_ROUTE,
          handler: (request, response) => {
            const method = String(request?.method ?? 'GET').toUpperCase();
            if (method === 'GET') {
              const out = handleConfigRoute({ method, profileConfig: rawConfig });
              response.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
              response.end(JSON.stringify(out.body));
              return;
            }
            if (method !== 'POST') {
              response.writeHead(405, { allow: 'GET, POST' });
              response.end();
              return;
            }
            let raw = '';
            request.on('data', (chunk) => {
              raw += chunk;
              if (raw.length > 64 * 1024) request.destroy();
            });
            request.on('end', () => {
              const out = handleConfigRoute({ method, body: raw, profileConfig: rawConfig });
              response.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
              response.end(JSON.stringify(out.body));
            });
          },
        });
      });
    }
  } catch (error) {
    warn(ctx, `设置接口没注册上：${String(error?.message ?? error)}`);
  }

  ctx.on(HOOK, async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || typeof decision !== 'object') return decision;
      if (decision.kind !== 'enter') return decision;
      if (!Array.isArray(decision.messages)) return decision;

      const session = payload?.agent?.session ?? payload?.session ?? null;

      // D5：先看这一刀有没有"同类失败反复"。它不受 oncePerSession 限制，但每会话有上限。
      if (config.repeatHint && config.enabled && !config.shadow) {
        try {
          const state = repeatStateFor(repeatStates, session, config.repeatHintAfter);
          if (state && state.injected < config.repeatHintMax) {
            const trigger = collectRepeatTrigger(state, payload?.messages);
            if (trigger) {
              const deps5 = await resolveDeps(config);
              const inner = await decidePreStep({
                ctx,
                config,
                deps: deps5,
                payload: { ...payload, messages: [{ role: 'user', content: [{ type: 'text', text: trigger.quote }] }] },
                decision,
              });
              if (inner?.action === 'inject') {
                state.injected += 1;
                // D5 遥测（2026-11-02）：真注入后要能统计"二次命中触发率与误报"。
                // 只写影子台账目录；任何异常不影响本轮注入。
                try {
                  writeRepeatTelemetry({ config, trigger, card: inner.card, digest: inner.digest, at: Date.now() });
                } catch (error) {
                  warn(ctx, `D5 遥测写入失败（忽略）：${String(error?.message ?? error)}`);
                }
                return inner.decision;
              }
            }
          }
        } catch (error) {
          warn(ctx, `D5 补卡失败（继续本轮）：${String(error?.message ?? error)}`);
        }
      }

      if (config.oncePerSession && session && injected.has(session)) return decision;

      const deps = await resolveDeps(config);
      const result = await decidePreStep({ ctx, config, deps, payload, decision });
      // 真注入成功 / 影子记录写成 ⇒ 这个会话就别再来一遍
      if (result.action === 'inject' || result.action === 'shadow') {
        if (session) injected.add(session);
      }
      return result.decision ?? decision;
    } catch (error) {
      // 兜底：任何异常都不许冒泡到宿主（否则会阻塞本轮对话）
      warn(ctx, `注入失败（继续本轮）：${String(error?.message ?? error)}`);
      return decision;
    }
  });

  // D1（2026-11-02）：轮次收尾时增量刷新记忆库——不再只靠手动/首次 autoBuild。
  // 条件：开了 autoArchive、库存在、且 manifest.updatedAt 已超过 autoArchiveMinutes。
  try {
    ctx.on('agent/turn-stopping', async () => {
      try {
        if (!config.autoArchive) return;
        const root = resolveStoreRoot(config);
        if (!root || !fs.existsSync(root)) return;
        const marker = path.join(root, 'manifest.json');
        let updated = 0;
        try { updated = Number(JSON.parse(fs.readFileSync(marker, 'utf8')).updatedAt) || 0; } catch { updated = 0; }
        const age = Date.now() - updated;
        if (age < config.autoArchiveMinutes * 60 * 1000) return;
        scheduleAutoBuild({ ctx, storeRoot: root, deps: config.deps ?? null, reason: 'periodic' });
      } catch (error) {
        warn(ctx, `增量刷新检查失败：${String(error?.message ?? error)}`);
      }
    });
  } catch (error) {
    warn(ctx, `turn-stopping 钩子没挂上：${String(error?.message ?? error)}`);
  }

  return { name, hook: HOOK, registered: true, config };
}

export function enforceStoreRoot(config = {}) {
  return resolveStoreRoot(config);
}

export default {
  name,
  PLUGIN_VERSION,
  CARD_SOURCE_KIND,
  CARD_SOURCE_FORM,
  HOOK,
  LLM_PACKAGE,
  DEFAULT_CONFIG,
  sanitizeConfig,
  messageText,
  lastUserText,
  digestOf,
  insertAfterClaimed,
  cardText,
  apply,
};
