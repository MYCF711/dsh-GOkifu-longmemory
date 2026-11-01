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
import { runGates } from './rooms/gates.mjs';
import { createStore } from './rooms/persist.mjs';

/** 插件名（宿主用来标识这个插件）。 */
export const name = 'dsh-kifuin';
/** 配置/消息格式的版本号（改消息形状时 +1，便于事后认账）。 */
export const PLUGIN_VERSION = 1;
/** 注入消息的 source 标识（宿主里一眼能认出是棋院写的）。 */
export const CARD_SOURCE_KIND = 'dsh-kifuin';
export const CARD_SOURCE_FORM = 'memory-card';
/** 挂的钩子名。 */
export const HOOK = 'agent/pre-step';
/** 宿主消息包的包名（动态 import；解析不到就安静跳过）。 */
export const LLM_PACKAGE = '@deepseek-ai/dsh-llm';

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  shadow: true,
  storeRoot: null,
  shadowDir: null,
  budgetTokens: 500,
  limit: 5,
  oncePerSession: true,
  now: null,
  createUserMessage: null,
  deps: null,
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(`dsh-kifuin: ${line}`);
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
    buildMemoryCard: typeof injected.buildMemoryCard === 'function' ? injected.buildMemoryCard : buildMemoryCard,
    runGates: typeof injected.runGates === 'function' ? injected.runGates : runGates,
    writeShadow: typeof injected.writeShadow === 'function' ? injected.writeShadow : writeShadow,
    walk,
    createUserMessage: typeof injected.createUserMessage === 'function' ? injected.createUserMessage : null,
  };
}

function resolveStoreRoot(config) {
  if (config.storeRoot) return path.resolve(config.storeRoot);
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : '';
  if (!home) return null;
  return path.resolve(home, 'memory-context');
}

function resolveShadowDir(config) {
  if (config.shadowDir) return path.resolve(config.shadowDir);
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
    warn(ctx, `记忆库不存在：${storeRoot}（本轮不动）`);
    return { decision, action: 'skip', reason: 'no-store' };
  }

  const at = clockOf(config);
  const store = deps.createStore({ root: storeRoot });
  const cwd = typeof session?.cwd === 'string' && session.cwd.trim() !== '' ? session.cwd : process.cwd();
  const scope = scopeKeyFromPath(cwd);
  const signal = signalFromText(text, { at });
  signal.scopeKey = scope;

  let walk = null;
  if (deps.walk) {
    walk = deps.walk({ signal, store, scope, depth: 2, limit: config.limit, budgetTokens: config.budgetTokens }) ?? null;
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
  const gates = deps.runGates({ card, walkResult, store, scope });
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
export function apply(ctx, rawConfig = {}) {
  const config = sanitizeConfig(rawConfig);
  const injected = new WeakSet(); // 每会话只注入一次（对象身份；WeakSet 不留引用）

  if (typeof ctx?.on !== 'function') {
    warn(ctx, 'ctx.on 不可用（插件未挂载，宿主行为不变）');
    return { name, hook: HOOK, registered: false, config };
  }

  ctx.on(HOOK, async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || typeof decision !== 'object') return decision;
      if (decision.kind !== 'enter') return decision;
      if (!Array.isArray(decision.messages)) return decision;

      const session = payload?.agent?.session ?? payload?.session ?? null;
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

  return { name, hook: HOOK, registered: true, config };
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
