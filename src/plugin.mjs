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

import { createHash, randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
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
import { probeValidity, validityKeyOf, workspaceOf, runGates } from './rooms/gates.mjs';
import { classifyErrorClass } from './rooms/claim.mjs';
import { errorClassKeyOf } from './rooms/topic.mjs';
import { registerMemoryTools, recordToolRegistration } from './tools.mjs';
import { createMemorySdk } from './sdk.mjs';
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
  // 2026-11-04（M4 精度抽样）：注入成功时把卡片正文抽存到 `<storeRoot>/card-samples.jsonl`，
  // 供事后做「注入质量」人工/机械核对。默认开；不写会话日志、只写 sidecar。
  sampleCards: true,
  // T268：采集**真实消息语料**（只本机、只追加到 evidence/T268-messages.jsonl），
  // 用来复算 T267「最近 N 条消息的硬实体」到底带来多少召回。默认开；false 时完全不写。
  collectMessages: true,
  budgetTokens: 500,
  limit: 5,
  oncePerSession: true,
  now: null,
  createUserMessage: null,
  probeValidity: true,
  autoArchive: true,
  autoArchiveMinutes: 30,
  crossScopeClass: false,
  // Q19 预置（2026-11-03）：true = 只注入 hard 约束，丢弃 soft 偏好（理由句/闲聊）。默认关，等主人裁定。
  preferenceHardOnly: false,
  liveStats: true, // A3 心跳：每步一行 live-stats.jsonl（默认开；关掉不影响功能）
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
    sampleCards: typeof src.sampleCards === 'boolean' ? src.sampleCards : DEFAULT_CONFIG.sampleCards,
    collectMessages: typeof src.collectMessages === 'boolean' ? src.collectMessages : DEFAULT_CONFIG.collectMessages,
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
    preferenceHardOnly: boolOf(src.preferenceHardOnly, false),
    liveStats: boolOf(src.liveStats, true),
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

// T267：硬实体（与 scripts/a2b-holdout.mjs 的 HARD_ENTITY_PATTERNS 同一套正则）
export const MESSAGE_ENTITY_PATTERNS = Object.freeze([
  // 文件路径：Windows 盘符 / POSIX 绝对路径
  /[A-Za-z]:[\\/][\w./\\-]{3,}/g,
  /(?:^|[\s"'(=])\/(?:[\w.-]+\/)*[\w.-]{3,}/g,
  // 错误码 / 错误类
  /\bclass:[a-z0-9-]+\b/gi,
  /\b(?:ENOENT|EACCES|EPERM|EEXIST|ECONNREFUSED|ETIMEDOUT|MODULE_NOT_FOUND|ERR_[A-Z_]+)\b/g,
  // 包名（scoped 或无 scope）
  /(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]+\/[a-z0-9][a-z0-9._-]+/gi,
  // 命令（git/node/npm/go/python/bash… + 少量参数）
  /\b(?:git|node|npm|pnpm|yarn|go|python|bash|pwsh|powershell|curl|gh)\b(?:\s+[-\w./=:]{1,40}){0,4}/gi,
]);

/** 从一段文本抽硬实体（小写、去重、≥3 字符；路径额外保留 basename）。 */
export function messageEntities(text) {
  const raw = String(text ?? '');
  const out = new Set();
  for (const re of MESSAGE_ENTITY_PATTERNS) {
    re.lastIndex = 0;
    for (const m of raw.matchAll(re)) {
      const value = String(m[0] ?? '').trim().replace(/^[\s"'(=]+|[\s"'),.]+$/g, '');
      if (value.length < 3) continue;
      out.add(value.toLowerCase());
      const base = value.split(/[\/]/).pop();
      if (base && base.length >= 6 && /[._-]/.test(base)) out.add(base.toLowerCase());
    }
  }
  return [...out];
}

/**
 * T267：**合法信号扩展** —— 从 `payload.messages` **最近 N 条**（含 assistant / tool）抽硬实体。
 *
 * 为什么合法：这些实体在 `pre-step` 这一刻已经出现在上下文里，`availableAtSeq <= injectionSeq`；
 * **不是**从整局棋谱主题反推的事后信息（T264 已证明那是作弊）。
 *
 * 返回 `{ text, entities }`：
 *   · `text`     = 最后一条 user 消息（**行为与现状一致**，golden）；
 *   · `entities` = 最近 N 条消息里的硬实体（追加，不替换）。整段对话**只抽实体、不塞正文**（避免噪声）。
 */
export function signalFromMessages(messages, { lastN = 12 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const text = lastUserText(list);
  const n = Number.isFinite(lastN) && lastN > 0 ? Math.floor(lastN) : 12;
  const entities = new Set();
  for (const message of list.slice(-n)) {
    for (const entity of messageEntities(messageText(message))) entities.add(entity);
  }
  return { text, entities: [...entities] };
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

/**
 * T268：把**本轮真实消息**追加进语料（只本机、只追加）。
 *
 * 用途：T267 的收益（最近 N 条消息的硬实体）在现有考卷上**测不出来** —— 考卷只有根用户原话。
 * 这份语料补上 `messages`，让 `scripts/t267-replay.mjs` 能复算 A/B 两路。
 *
 * 纪律：
 *   · **只读注入链路之外**：不参与任何判定，失败一律吞掉（采集永远不许拖垮注入）；
 *   · **脱敏**：落盘前用 `scripts/privacy-scan.mjs` 的同一套规则扫一遍（本机语料也要同规则）；
 *   · **截断**：单条 `text` 只保留前 4000 字符，超长打 `truncated: true`。
 */
export const MESSAGE_CORPUS_PATH = 'evidence/T268-messages.jsonl';
export const MESSAGE_TEXT_LIMIT = 4000;

export function messageCorpusRow({ episode = null, scopeKey = null, messages = [], at = null } = {}) {
  const rows = (Array.isArray(messages) ? messages : []).map((m) => {
    const text = redactForCorpus(String(messageText(m) ?? ''));
    const truncated = text.length > MESSAGE_TEXT_LIMIT;
    return { role: String(m?.role ?? 'unknown'), text: truncated ? text.slice(0, MESSAGE_TEXT_LIMIT) : text, ...(truncated ? { truncated: true } : {}) };
  }).filter((r) => r.text !== '');
  return { episode: episode ?? null, scopeKey: scopeKey ?? null, at: Number.isFinite(at) ? at : null, messages: rows };
}

/** 简单脱敏（与 privacy-scan 同族规则；宁可多遮，不落明文密钥）。 */
export function redactForCorpus(text) {
  return String(text ?? '')
    .replace(/(sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '[REDACTED]');
}

/** 追加一行语料；**绝不抛**（写失败只 warn）。 */
export function appendMessageCorpus(rootDir, row, { fsImpl = fs } = {}) {
  try {
    const dir = path.join(rootDir, 'evidence');
    fsImpl.mkdirSync(dir, { recursive: true });
    const safe = { ...row, messages: (row.messages ?? []).map((m) => ({ ...m, text: redactForCorpus(m.text) })) };
    fsImpl.appendFileSync(path.join(rootDir, MESSAGE_CORPUS_PATH), `${JSON.stringify(safe)}
`);
    return true;
  } catch {
    return false;
  }
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
  try {
    const mod = await import(LLM_PACKAGE);
    if (typeof mod?.createUserMessage === 'function') return mod.createUserMessage;
  } catch { /* 宿主包在 asar 里：外部插件按文件路径解析不到 —— 走本地等价实现 */ }
  // 2026-11-04：本地等价实现。已核对宿主源码：createUserMessage(input) = createMessage({...input, role:'user'})，
  // 而 createMessage = deepFreeze(structuredClone({...input, id: randomUUID()}))。这里逐字段对齐，不引入宿主依赖。
  return makeUserMessageFallback;
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
    // T198（audit-12 洞 2）：**以 claim 自己的 workspace 为准**（`scopeKey` 解出的路径），
    // 会话 cwd 只作兜底 —— 与 `runValidityCheck`（gates-check）同口径。
    // 之前直接传 cwd，同一批 claim 在两条口径下 53 条结论不同（cwd 有 package.json 时误判 version-mismatch ⇒ 闸 3 运行时误红）。
    const recordWorkspace = workspaceOf(record, fallbackWorkspace);
    const bucket = Math.floor((Number.isFinite(now) ? now : Date.now()) / PROBE_TTL_MS);
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
 * @returns {{decision:object, action:string, reason:string|null, card?:object, gates?:object, digest?:string}}
 *   action: `inject` | `shadow` | `skip`
 */
/**
 * 从 `runGates()` 的返回里取「被哪几道闸拦下」。
 * 2026-11-04（0.132.0）：之前只读 `gates.failed`，但 `runGates()` 返回的是 `{ok, errors, checks}` —— 没有 `failed`，
 * 于是线上两次 `gates-failed` 的心跳都是 `gateIds: null`，事后查不出原因。现在**两条来源都认**，并补错误码。
 * 只读闸 id / 错误码，不碰卡内容（心跳里不许写记忆）。
 */
export function gateIdsFromGates(gates) {
  if (Array.isArray(gates?.failed)) {
    const ids = gates.failed.map((g) => (typeof g === 'string' ? g : g?.id)).filter(Boolean);
    if (ids.length) return [...new Set(ids)];
  }
  const fromErrors = (Array.isArray(gates?.errors) ? gates.errors : []).map((e) => String(e?.gate ?? '')).filter(Boolean);
  return [...new Set(fromErrors)];
}

export function gateCodesFromGates(gates, limit = 5) {
  const codes = (Array.isArray(gates?.errors) ? gates.errors : []).map((e) => String(e?.code ?? '')).filter(Boolean);
  return [...new Set(codes)].slice(0, limit);
}

/**
 * T160：从 `runGates()` 的 `errors[].detail` 里取出**被点名的 claim id**。
 *
 * 为什么需要：被闸挡下的卡**不入** `card-samples.jsonl`，心跳行原来只有
 * `digest / tokens / gateIds / gateCodes` —— 事件过去后无法还原是哪几条 claim 被拦
 * （按 digest 回放也命中不了，因为库还在长）。这里补上 id，事后能直接去 store 里查。
 *
 * 取法（**能拿到就收集，拿不到就空数组，不猜**）：
 *   · `detail.ids`（数组，闸 4 的 byBody 组）
 *   · `detail.claimId`（闸 2 / 3 / 5 / 7 的条目级报错）
 *   · `detail.id`（有的闸只写 id）
 * 只收非空字符串；去重保序；最多 `limit` 个（默认 5，防止一行心跳被撑爆）。
 * **只读 id，不碰卡正文**（心跳里不许出现记忆内容）。
 */
export function gateClaimIdsFromGates(gates, limit = 5) {
  const errors = Array.isArray(gates?.errors) ? gates.errors : [];
  const ids = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const id = value.trim();
    if (id) ids.push(id);
  };
  for (const error of errors) {
    const detail = error?.detail;
    if (!detail || typeof detail !== 'object') continue;
    if (Array.isArray(detail.ids)) for (const id of detail.ids) push(id);
    push(detail.claimId);
    push(detail.id);
  }
  return [...new Set(ids)].slice(0, Math.max(1, Number(limit) || 5));
}

async function decidePreStep({ ctx, config, deps, payload, decision }) {
  const session = payload?.agent?.session ?? payload?.session ?? null;
  const text = lastUserText(payload?.messages);
  // T267：**合法信号扩展** —— 最近 N 条消息（含 assistant / tool）里的硬实体（文件路径/错误码/包名/命令）。
  // 它们此刻已经在 payload.messages 里（availableAtSeq <= injectionSeq），不是整局统计的事后信息。
  const messageSignal = signalFromMessages(payload?.messages, { lastN: config.messageSignalLastN ?? 12 });

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
  const resolved = resolveSessionScope({ session, store, storeRoot });
  if (typeof session?.id === 'string') LAST_SCOPE.set(session.id, resolved);
  const scope = resolved.scope;
  const signal = signalFromText(text, { at });
  // T268：采集真实消息语料（**只写盘、不参与判定**；失败静默降级）
  if (config.collectMessages === true) {
    try {
      const row = messageCorpusRow({
        episode: null,
        scopeKey: payload?.scopeKey ?? null,
        messages: payload?.messages ?? [],
        at,
      });
      if (row.messages.length && !appendMessageCorpus(REPO_ROOT, row)) warn(ctx, '语料采集写盘失败（已忽略）');
    } catch (error) {
      warn(ctx, `语料采集失败（已忽略）：${String(error?.message ?? error)}`);
    }
  }
  // T267：把最近消息里的硬实体**追加**进信号（不改 base 词；只加实体，不塞整段对话）。
  if (messageSignal.entities.length) {
    const seen = new Set((signal.entities ?? []).map((e) => String(e?.key ?? e)));
    for (const key of messageSignal.entities) {
      if (seen.has(key)) continue;
      seen.add(key);
      signal.entities.push({ kind: 'entity', key });
    }
  }
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
    preferenceHardOnly: config.preferenceHardOnly === true,
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
    // 2026-11-04：记下是哪几道闸拦的（只写闸 id 与错误码，不写卡内容，避免把记忆写进心跳）。
    // 修（0.132.0）：之前只读 `gates.failed`，但 `runGates()` 返回的是 `{ok, errors, checks}` —— 没有 `failed` 字段，
    // 于是线上两次 `gates-failed` 的心跳都是 `gateIds: null`，事后根本查不出被哪道闸拦的（"红了但不知道是谁"的同类问题）。
    const failedIds = gateIdsFromGates(gates);
    const gateCodes = gateCodesFromGates(gates);
    // T160：再补"被点名的 claim id"与"卡片渲染了多少行"—— 被闸挡下的卡不进 card-samples，
    // 没有这两项就永远还原不出是哪几条记忆被拦（只记 id 与计数，**不记卡正文**）。
    const gateClaimIds = gateClaimIdsFromGates(gates);
    const gateLineCount = Array.isArray(card?.claims) ? card.claims.length : null;
    return { decision, action: 'skip', reason: 'gates-failed', card, gates, digest, gateIds: failedIds, gateCodes, gateClaimIds, gateLineCount };
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
    liveStats: { type: 'boolean', meta: { default: true, description: 'A3 心跳：每步往 sidecar/live-stats.jsonl 追加一行（可关）' } },
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
/**
 * A3 线上心跳（2026-11-03）：每走完一次 pre-step 决策，就往 sidecar 追加一行。
 * 用途：装了插件之后，`live-stats.jsonl` 里**出现行**本身就是"插件真的在宿主里跑过"的证据。
 * 只写 storeRoot 内（sidecar），失败一律吞掉，绝不影响本轮注入。
 */

// 2026-11-03（N10）：会话 cwd 落在 DSH_HOME 里（profiles/desktop 等）时，scopeKeyFromPath 会得到
// 一个没有棋谱的假作用域，导致永远 no-hit。用**本会话历史 episode 的 scopeKey**兜底（归档时读过会话
// header 的真实 cwd），比猜目录名可靠。
const SESSION_SCOPE_CACHE = new WeakMap();
const LAST_SCOPE = new Map();
export function lastResolvedScope(sessionId) { return sessionId ? (LAST_SCOPE.get(sessionId) ?? null) : null; }
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

export function appendLiveStats(storeRoot, row) {
  try {
    if (!storeRoot) return;
    // 不创建目录：库还不存在时（首次用之前）不写心跳，避免把"无库"变成"有库"。
    if (!fs.existsSync(storeRoot)) return;
    const src = (process.argv[1] ? path.basename(process.argv[1]) : 'host').slice(0, 40);
    fs.appendFileSync(path.join(storeRoot, 'live-stats.jsonl'), `${JSON.stringify({ at: Date.now(), src, pid: process.pid, ...row })}
`);
  } catch { /* 心跳失败不影响决策 */ }
}

/** 注入质量抽样：只写 sidecar；失败不影响注入（2026-11-04）。 */
export function appendCardSample(storeRoot, row) {
  try {
    if (!storeRoot || !fs.existsSync(storeRoot)) return;
    const file = path.join(storeRoot, 'card-samples.jsonl');
    const stat = fs.existsSync(file) ? fs.statSync(file) : null;
    if (stat && stat.size > 8 * 1024 * 1024) return; // 8 MB 上限，避免无限增长
    // 2026-11-04：留样带 pid —— 宿主重启后新旧进程会混写同一文件，
    // 审计要能按进程切（`audit-card-samples --pid <n>`），否则"旧代码的账"会被误读成回归。
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...row })}
`);
  } catch { /* 抽样失败不影响注入 */ }
}

export function writeRepeatTelemetry({ config, trigger, card = null, digest = null, at = Date.now(), shadow = false } = {}) {
  const dir = resolveShadowDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    at,
    kind: 'repeat-hint',
    cls: trigger?.cls ?? null,
    count: trigger?.count ?? null,
    tokens: card?.tokens ?? null,
    digest: digest ?? null,
    shadow: shadow === true,
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


// 宿主 createUserMessage 的本地等价实现（见 docs/记忆的职责边界.md 的消息形状约定）。
// 已核对宿主源码：createUserMessage = createMessage({...input, role:'user'})，
// createMessage = deepFreeze(structuredClone({...input, id: randomUUID()}))。
export function makeUserMessageFallback(input) {
  const message = { ...input, role: 'user', id: randomUUID() };
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) freeze(value[key]);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(message);
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

  // 2026-11-04（S17）：把记忆查询注册成**工具** —— PTC / run_code 模式下宿主会据此生成 SDK 绑定，
  // 代码块里可以直接循环调用（"要查几次查几次"），不再依赖模型反复召回。只读、零模型。
  try {
    const storeRoot = resolveStoreRoot(config);
    const dshHome = storeRoot ? path.dirname(storeRoot) : null;
    const createSdk = (opts) => createMemorySdk({ ...opts, dshHome: opts?.dshHome || dshHome || null });
    const ctxHasRegister = typeof ctx?.tools?.register === 'function';
    let names = registerMemoryTools(ctx, { createSdk, warn });
    let via = names.length ? 'direct' : 'none';
    // 2026-11-04（重启后实测：凭据文件没出现 ⇒ 直接访问 ctx.tools 没拿到）：宿主可能要求先声明服务依赖。
    // 与 webServer 同一条路子：ctx.inject(['tools'], host => …)。两条都试，结果如实写进凭据。
    if (!names.length && typeof ctx?.inject === 'function') {
      try {
        ctx.inject(['tools'], (host) => {
          const got = registerMemoryTools(host, { createSdk, warn });
          if (storeRoot) recordToolRegistration(storeRoot, got, { host: 'dsh', via: 'inject', ctxHasRegister });
        });
        via = 'inject';
      } catch (error) {
        warn(ctx, `ctx.inject(['tools']) 失败：${String(error?.message ?? error)}`);
        via = 'inject-failed';
      }
    }
    // 凭据**无论成没成都写**：文件里没有工具名本身就是"没注册上"的证据（否则只能靠猜）。
    if (storeRoot) recordToolRegistration(storeRoot, names, { host: 'dsh', via, ctxHasRegister });
  } catch (error) {
    warn(ctx, `工具面注册整体失败（不影响注入）：${String(error?.message ?? error)}`);
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
      if (config.repeatHint && (config.enabled || config.shadow)) {
        try {
          const state = repeatStateFor(repeatStates, session, config.repeatHintAfter);
          if (state && state.injected < config.repeatHintMax) {
            const trigger = collectRepeatTrigger(state, payload?.messages);
            if (trigger && config.shadow) {
              // 影子模式（2026-11-02）：D5 不真注入，但**照样记录**"本来会补一张卡"——
              // 这样在正式开注入之前就能观察触发率与类别分布。
              try {
                writeRepeatTelemetry({ config, trigger, at: Date.now(), shadow: true });
              } catch { /* 影子遥测失败不影响决策 */ }
              state.injected += 1;
            } else if (trigger) {
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
      // enabled=false 时的 "skip disabled" 没有诊断价值，别写（任何库内调用都会带出来一堆噪声）。
      if (config.liveStats !== false && !(result.action === 'skip' && result.reason === 'disabled')) {
        const storeRootForStats = resolveStoreRoot(config);
        if (config.sampleCards === true && (result.action === 'inject') && result.card?.section) {
          appendCardSample(storeRootForStats, {
            scope: lastResolvedScope(session?.id)?.scope ?? null,
            scopeFrom: lastResolvedScope(session?.id)?.from ?? null,
            digest: result.digest ?? null,
            tokens: result.card?.tokens ?? null,
            section: String(result.card.section),
          });
        }
        appendLiveStats(storeRootForStats, {
          kind: 'pre-step',
          scope: lastResolvedScope(session?.id)?.scope ?? null,
          scopeFrom: lastResolvedScope(session?.id)?.from ?? null,
          action: result.action ?? 'skip',
          gateIds: Array.isArray(result.gateIds) && result.gateIds.length ? result.gateIds : null,
          // 只有被闸拦下时才有意义：写错误码（如 card/imperative、claim/validity），仍不含卡内容。
          gateCodes: Array.isArray(result.gateCodes) && result.gateCodes.length ? result.gateCodes : null,
          reason: result.reason ?? null,
          digest: result.digest ?? null,
          tokens: result.card?.tokens ?? null,
          shadow: config.shadow === true,
          // T160：只有 gates-failed 才有这两项 —— "被哪几条 claim 拦住 / 卡上本来有几行"。
          // 拿不到 id 时写 []（不猜）；行数拿不到写 null。**只记 id 与计数，不记卡正文。**
          ...(result.reason === 'gates-failed'
            ? {
              gateClaimIds: Array.isArray(result.gateClaimIds) ? result.gateClaimIds : [],
              gateLineCount: Number.isFinite(result.gateLineCount) ? result.gateLineCount : null,
            }
            : {}),
        });
      }
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
