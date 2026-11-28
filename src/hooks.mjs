// src/hooks.mjs —— **钩子注册与事件绑定**：`agent/pre-step`（注入）与 `agent/turn-stopping`（D1 增量刷新）
// 的处理器、以及这些处理器直接依赖的判据/投影/工具函数。
//
// 为什么单独成文件（重构 C 期 M1）：钩子里的每一行都会**每步执行**（宿主长驻、每轮多步），
// 它同时又承担四条硬约束（不阻塞会话 / 不写会话事件 / 只陈述事实 / 失败只 warn）。
// 把"事件绑在哪、每步做什么"收在一个文件里，才能逐条对照 docs/记忆的职责边界.md 检查。
//
// 边界：
//   · **不做任何写盘**（观测留痕由组合根注入的 `telemetry` 负责）—— 唯一的输出就是返回的 decision；
//   · 任何异常都收敛成"原样返回下游 decision"（这个文件里没有"失败"分支，只有"少说一句"）；
//   · 依赖方向：hooks → lifecycle → cache（无环；hooks 不 import 组合根）。
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hasRelevantClaim, hasReliableHandle } from './rooms/abstain.mjs';
import { filterHitsByScope, recordInjectionTrials, signalFromText } from './rooms/inject.mjs';
import {
  INJECT_SLOT_ID,
  cardEvidenceItems,
  claimEvidenceEnabled,
  contextLineHashes,
  readClaimEvidenceLedger,
  recordEvidence,
  recordSlot,
  restatedEvidenceOf,
  slotContentHash,
  slotContentPresent,
  slotIdempotencyEnabled,
  slotSeen,
} from './rooms/inject-slot.mjs';
import { classifyErrorClass } from './rooms/claim.mjs';
import { errorClassKeyOf } from './rooms/topic.mjs';
import { DIGEST_GATE_CODES_LIMIT } from './rooms/limits.mjs';
import { lastResolvedScope, openReadStore, probeCardValidity, rememberLastScope, resolveSessionScope, walkCacheFor } from './cache.mjs';
import { clockOf, resolveDeps, resolveShadowDir, resolveStoreRoot, scheduleAutoBuild, warn } from './lifecycle.mjs';

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
 * T49（2026-11-09）：**这张卡已经在本轮上下文里了** ⇒ 别再投一次（无状态去重）。
 *
 * 为什么 `oncePerSession` 不够：它是 `apply()` 内的内存 `Set`，宿主**重新 apply**（新 agent 作用域 /
 * 插件重载 / 会话再 seed）之后就空了。本机实测：`tools-registered.json` 只由 `apply` 写，
 * 它在宿主启动（01:52）之后 1.5 小时（03:22）又被重写 ⇒ 同一进程里 `apply` 跑了不止一次；
 * 于是同一张卡在**每个 `turn/start`** 又被投一遍，`A1.redundant` 浪费 **36 对 / 291 次 = 10.5%**（闸 1%）。
 *
 * 判据用**上下文事实**而不是内存状态：卡正文（`cardText(card)`，也就是注入那条消息的正文）逐字
 * 出现在 `messages` 里 ⇒ 再投一次必然是浪费。压缩把那条消息压掉之后正文不再在 ⇒ 自然恢复注入
 * （即 `A1.redundant` 分档里的「必要重注」，不误伤）。
 *
 * @param {unknown} messages `payload.messages`（宿主本轮上下文）
 * @param {object|null} card  `decidePreStep` 产出的卡
 * @returns {boolean} 卡正文是否已逐字出现在上下文里
 */
export function cardAlreadyInContext(messages, card) {
  const text = cardText(card);
  if (!text) return false; // 没有正文可比 ⇒ 不去重（宁可多投一次，也不误判成"已在"）
  const list = Array.isArray(messages) ? messages : [];
  for (const message of list) {
    if (messageText(message) === text) return true;
  }
  return false;
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

export function gateCodesFromGates(gates, limit = DIGEST_GATE_CODES_LIMIT) {
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
export function gateClaimIdsFromGates(gates, limit = DIGEST_GATE_CODES_LIMIT) {
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

/**
 * T4：`abstain` 时**说出拒的是哪道门**（可解释的拒绝）。
 *
 * 为什么要有这个：单一 `reason: 'no-relevant-claim'` 让模型（和事后审计）**分不清**三种完全不同的处境 ——
 * 「库里根本没有」「库里有、但只有一局证据、拿不准」「库里有、但全被作用域/时效挡了」。
 * 这三种情况下该做的事不一样：放弃 / 去核实 / 去别的项目查。
 *
 * 判据**全机械**（AGENTS §2.3：计数不是打分，禁止模型评分），按**从具体到泛化**排序：
 *   ① `cross-scope`      —— walk 命中过，但全被作用域挡掉（库里有，只是不属于本项目）；
 *   ② `stale`            —— 卡上**每一行**的衰减权重都 < 0.5（全部超过半衰期没被调用）；
 *   ③ `low-confidence`   —— 卡上**每一行**都是单局 `[observed]`（只有 1 局支撑，拿不准）；
 *   ④ `no-relevant-claim` —— 兜底：卡上有行，但与信号没有可判别的重合。
 *
 * **不改默认行为**：只在 `abstain` **已触发**时细化 `reason` 字符串；
 * `action` 仍是 `'abstain'`，不注入、不改变任何决策（向后兼容）。
 */
export function classifyAbstainReason({ card = null, walkResult = null } = {}) {
  const claims = Array.isArray(card?.claims) ? card.claims : [];
  // T12 修①：`cross-scope` 的口径是「**本次 walk 命中的条目全被作用域挡掉**」。
  // 原判据把 `crossScopeWalk`（= 整库遍历里被作用域挡掉的命中**总数**，实测恒 200–1000）也加了进来，
  // ⇒ `cross > 0` 恒真，33/33 全塌成 `cross-scope`，"卡上有行但与信号不相关"永远归因不出来（T11 §六）。
  // 现在只认**本次**的丢弃数（`crossScope` / `unknownScope`，来自 `filterHitsByScope`），
  // 且要求**没有一条活着进卡**（`hits` 为空）—— 卡里已经有行，就说明"库里有、只是不属于本项目"不成立。
  // 调用方没给 `hits`（离线脚本 / 老单测）时保持旧语义，避免调用面悄悄变成"永不返回 cross-scope"。
  const droppedByScope = Number(walkResult?.crossScope ?? 0) + Number(walkResult?.unknownScope ?? 0);
  const noInScopeHit = Array.isArray(walkResult?.hits) ? walkResult.hits.length === 0 : true;
  if (droppedByScope > 0 && noInScopeHit) return 'cross-scope';
  // T12 修②：`stale` 读 `c.decay`，而 `buildMemoryCard` 的 `card.claims` 投影现在**带 decay**
  // （`src/rooms/inject.mjs` 的 claims 投影）；此前投影不含该字段 ⇒ `Number(undefined ?? 1)` 恒 1 ⇒ 死码。
  if (claims.length && claims.every((c) => Number(c?.decay ?? 1) < 0.5)) return 'stale';
  if (claims.length && claims.every((c) => String(c?.state ?? '') === 'observed')) return 'low-confidence';
  return 'no-relevant-claim';
}

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
 * T25：**稳定的会话标识** = `session.id`（宿主每个 pre-step 可能给一个新对象，但 id 不变）。
 *
 * 这是本仓一贯的会话键：`LAST_SCOPE`（`Map<session.id, scope>`）与 `repeatStateFor`（D5 状态）
 * 都用它 —— 这里沿用同一把 id，不引入第二个会话标识。无 `id`（或空串）⇒ `null`，调用方退回旧行为。
 */
export function sessionIdOf(session) {
  return typeof session?.id === 'string' && session.id.trim() !== '' ? session.id : null;
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

async function decidePreStep({ ctx, config, deps, payload, decision, lifecycle, telemetry = null }) {
  const session = payload?.agent?.session ?? payload?.session ?? null;
  const text = lastUserText(payload?.messages);
  // T267：**合法信号扩展** —— 最近 N 条消息（含 assistant / tool）里的硬实体（文件路径/错误码/包名/命令）。
  // 它们此刻已经在 payload.messages 里（availableAtSeq <= injectionSeq），不是整局统计的事后信息。
  // T279 实测**净亏**：A（只用原话）97.53% vs B（+消息内实体）93.83%，**净 −3 条**，
  // 且 B 新增的 2 条命中**全部落在"A 路完全无重合"的样本上**（negativeControl 2/2 = 100% ⇒ 造命中不是召回）。
  // 处置（知识库 55「默认关」）：**代码保留、默认关**，`messageSignals: true` 才启用。
  // 重开条件：用有命中的历史局语料复算，B 的 delta > 0 **且** negativeControl 率显著低于 A 基线。
  const messageSignal = config.messageSignals === true
    ? signalFromMessages(payload?.messages, { lastN: config.messageSignalLastN ?? 12 })
    : { text, entities: [] };

  // 既没开真注入也不是影子 ⇒ 什么都不做（默认配置走这条）
  if (!config.enabled && !config.shadow) return { decision, action: 'skip', reason: 'disabled' };
  if (!text) return { decision, action: 'skip', reason: 'no-signal' };

  const storeRoot = resolveStoreRoot(config);
  if (!storeRoot) return { decision, action: 'skip', reason: 'no-store-root' };
  if (!fs.existsSync(storeRoot)) {
    warn(ctx, `记忆库不存在：${storeRoot}（本次沉默；${config.autoBuild ? '后台建库中' : '未开 autoBuild'}）`);
    if (config.autoBuild) scheduleAutoBuild({ ctx, storeRoot, deps, lifecycle });
    return { decision, action: 'skip', reason: 'no-store' };
  }

  const at = clockOf(config);
  const store = openReadStore(storeRoot, deps); // T62：热路径批量读走 bundle（读侧收口在 cache.mjs）
  const cwd = typeof session?.cwd === 'string' && session.cwd.trim() !== '' ? session.cwd : process.cwd();
  const resolved = resolveSessionScope({ session, store, storeRoot });
  const sid = sessionIdOf(session);
  rememberLastScope(sid, resolved);
  const scope = resolved.scope;
  // T332：**costIndex 接线** —— 读预计算 sidecar（`<store>/corpus/antipattern-cost.json`），
  // 交给 `buildMemoryCard` 做 `cost: 0` 降级门。**只读、失败静默**（索引缺失 ⇒ 不过滤，行为不变）。
  let costIndex = null;
  try {
    const costFile = path.join(storeRoot, 'corpus', 'antipattern-cost.json');
    if (fs.existsSync(costFile)) {
      const raw = JSON.parse(fs.readFileSync(costFile, 'utf8'));
      if (raw && raw.costs && typeof raw.costs === 'object') costIndex = new Map(Object.entries(raw.costs));
    }
  } catch { costIndex = null; }

  const signal = signalFromText(text, { at });
  // T268：采集真实消息语料（**只写盘、不参与判定**；失败静默降级）
  if (config.collectMessages === true) {
    try {
      const row = telemetry.messageCorpusRow({
        episode: null,
        scopeKey: payload?.scopeKey ?? null,
        messages: payload?.messages ?? [],
        at,
      });
      if (row.messages.length) {
        const corpusWrite = telemetry.appendMessageCorpus(storeRoot, row);
        if (corpusWrite.status === 'failed') warn(ctx, '语料采集写盘失败（已忽略）');
        // T20：语料撞上限不许静默 —— 一次性 warn + live-stats 一条 kind=messages-corpus-cap。
        telemetry.traceMessageCorpusCap({ ctx, storeRoot, result: corpusWrite, notified: lifecycle?.corpusCapNotified ?? null });
      }
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
    // T332：`cost: 0` 降级门（索引缺失 ⇒ null ⇒ 不过滤）
    costIndex,
    // T3：**三级交付接生产** —— 这一行是唯一接线点（删掉它，配置键就不再生效，T3 ⑩ 会红）。
    // `true` ⇒ 没把握的条目只给指针（`episode + seq + occurredAt`），正文不渲染。
    pointerTier: config.pointerTier === true,
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
    warn(ctx, `闸门未通过（本轮不注入）：${(gates?.errors ?? []).map((e) => e.code).slice(0, DIGEST_GATE_CODES_LIMIT).join(', ')}`);
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

  // T366：**不相关时沉默**（abstention，知识库 79）。
  // 卡**不为空**但**没有任何一行与信号相关** ⇒ **显式拒绝**，不注入。
  // 此前这种情况会**照样注入**（只有"卡为空"才 no-hit），那就是噪声。
  // 用独立的 `action: 'abstain'`（**不是** skip），让"我们该沉默的时候沉默了几次"**可计数**。
  // ⚠ **默认关**：`abstainIrrelevant: true` 才启用。
  // 实测判据边界太多（纯中文信号、单个共享的包名如 `yaml`、中英文混排），
  // **误杀的代价高于收益** —— 在判据校准到"不误杀"之前，**不在生产里拒**（知识库 55「默认关」）。
  // 重开条件：在真实考卷上证明「被拒的**全部**是不相关」且「注入率下降全部来自不相关」，
  //           并给出「误杀率 = 0」的逐条证据。
  // 知识库 87：**精化适用条件**（不是"全关"，是"只在判据可靠的输入上启用"）。
  // 拉卡托斯：反例该让我们"精化适用条件"，不是"全关"。
  // `hasReliableHandle(text)` = 信号里有硬实体（文件路径/错误码/包名）或 ≥2 英文判别词 ——
  // **在这些输入上判据是可靠的**，不该被"默认关"一起埋掉；
  // 短指令 / 纯通用中文 ⇒ 不可靠 ⇒ **不启用**（保守，不误杀）。
  // 知识库 87 + T366e：**在判据可靠的输入上默认开启**（`abstainIrrelevant !== false`）。
  // 依据：T366e 实测在判据可靠的输入上**误杀率 = 0**（2 条被拒全部正确拒绝），三条重开条件全满足。
  // **"不相关时沉默"这条原则该真正生效了**，而不是永远躺在 latent code 里。
  // 两层保护：
  //   ① `hasReliableHandle(text)`：**只在判据可靠的输入上启用**（短指令/纯通用中文 ⇒ 不启用，保守）；
  //   ② `abstainIrrelevant: false` 可显式关掉（回到旧行为，向后兼容）。
  if (config.abstainIrrelevant === true && hasReliableHandle(text) && card?.section && !hasRelevantClaim(card, text)) {
    // T4：**说出拒的是哪道门** —— 单一 reason 分不清「根本没有 / 拿不准 / 被作用域挡了」。
    // 只细化 `reason` 字符串，`action` 不变 ⇒ 向后兼容（计数口径 `action === 'abstain'` 不动）。
    const reason = classifyAbstainReason({ card, walkResult });
    return { decision, action: 'abstain', reason, card, gates, digest };
  }

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
  // T33：**trial 记录** —— 只写 `<store>/trials.jsonl`（append-only），不改可见性/不退役。
  // 失败静默（记 trial 失败不许影响本轮注入）；没有上一条 trial ⇒ 本次只开 trial、不写记录。
  try {
    const antipatterns = (Array.isArray(card?.claims) ? card.claims : []).filter((c) => c && c.kind === 'antipattern');
    if (antipatterns.length) recordInjectionTrials({ storeRoot, claims: antipatterns, at });
  } catch (error) {
    warn(ctx, `trial 记录失败（已忽略）：${String(error?.message ?? error)}`);
  }
  return { decision: { ...decision, messages }, action: 'inject', reason: null, card, gates, digest };
}

// ---------------------------------------------------------------------------
// 事件绑定：pre-step（注入）与 turn-stopping（D1 增量刷新）
//
// 两个 handler 都是**工厂**：由组合根（plugin.mjs）传入 ctx / config / lifecycle / state / telemetry。
// 这样 hooks 不需要 import 组合根，依赖图保持无环（plugin → hooks → lifecycle → cache）。
// ---------------------------------------------------------------------------

/**
 * 造 `agent/pre-step` 的处理器。
 *
 * @param {object} env `{ ctx, config, lifecycle, state, telemetry }`
 *   `state` = 每个插件实例的内存状态（判重集合 / D5 计数 / 只报一次的闸）；
 *   `telemetry` = 观测留痕写盘（由组合根注入，hooks 自己不写盘）。
 * @returns {(payload:object, next:Function)=>Promise<object>} waterfall 处理器
 */
export function createPreStepHandler({ ctx, config, lifecycle, state, telemetry }) {
  const {
    injectedIds,
    injectedObjects,
    slotLedgerNotified,
    repeatStates,
    cardSampleCapNotified,
    liveStatsCapNotified,
    oncePerSessionNotified,
  } = state;

  /** 本轮上下文里**我们自己投进去的**卡正文（只认 `source.kind`，不碰用户消息）。 */
  const injectedCardTexts = (messages) => {
    const out = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      if (!message || typeof message !== 'object') continue;
      if (message?.source?.kind !== CARD_SOURCE_KIND) continue;
      const text = messageText(message);
      if (text) out.push(text);
    }
    return out;
  };

  /**
   * 这个会话是否**已经有同一张卡在上下文里**（跨 apply / 跨重启都成立）。
   * 账本不可用（没有 storeRoot / 读写失败 / 版本不认识）⇒ 退回 false（= 不拦），并留一次 warn。
   * 宁可多投一张，也不许因为账本坏了把该投的卡吞掉（判据不对称：吞卡用户看不见，多投有痕迹）。
   */
  const slotSaysAlreadyInjected = (sessionId, messages) => {
    if (!sessionId || !slotIdempotencyEnabled()) return false;
    let root = null;
    try { root = resolveStoreRoot(config); } catch { root = null; }
    if (!root) return false;
    try {
      const entry = slotSeen({ storeRoot: root, sessionId, slotId: INJECT_SLOT_ID });
      if (!entry) return false;
      return slotContentPresent(entry, injectedCardTexts(messages));
    } catch (error) {
      if (!slotLedgerNotified.has(root)) {
        slotLedgerNotified.add(root);
        warn(ctx, `槽位账本不可用（本轮退回进程内去重）：${String(error?.message ?? error)}`);
      }
      return false;
    }
  };

  /**
   * 注入成功 / 影子写成后记账（哈希相同 ⇒ 账本一个字节都不动；变了 ⇒ 覆盖同一条，`seq+1`）。
   * 记账失败**不影响本轮**（卡已经投出去了），只留一次 warn。
   */
  const rememberInjectedSlot = (sessionId, sessionObject, card) => {
    if (sessionId) injectedIds.add(sessionId);
    else if (sessionObject) injectedObjects.add(sessionObject);
    if (!sessionId || !slotIdempotencyEnabled()) return;
    let root = null;
    try { root = resolveStoreRoot(config); } catch { root = null; }
    if (!root) return;
    try {
      const text = cardText(card);
      if (!text) return;
      recordSlot({ storeRoot: root, sessionId, slotId: INJECT_SLOT_ID, contentHash: slotContentHash(text), at: clockOf(config) });
    } catch (error) {
      if (!slotLedgerNotified.has(root)) {
        slotLedgerNotified.add(root);
        warn(ctx, `槽位账本记账失败（本轮照常注入）：${String(error?.message ?? error)}`);
      }
    }
  };

  /**
   * P0-2（记忆侧去重）：这张卡是不是**全是已经投过、且那一行还在本轮上下文里的证据**。
   *
   * 与槽位账本的分工：槽位账本判的是**整张卡正文的 hash**（正文一变就重投）；本判据判的是
   * **每一行证据的来源身份** `(scopeKey, episodeId, seq, claimId)`（持久账本），所以
   *   · 同一批证据换个渲染（索引行的局数变了 / 行序变了 / 正文措辞变了）⇒ 仍然命中 ⇒ 不重投；
   *   · 同文本不同来源（另一局的同一句话）⇒ 身份不同 ⇒ 照常投（这正是与"文本哈希"的差别）。
   *
   * 判重窗口**只来自持久账本**（不吃本轮 walk 的 top-k），因此跨 apply（`session/end-seed` 后重建）
   * 与跨重启都成立。账本不可用 ⇒ `false`（fail-open：宁可多投，不许吞卡）。
   */
  const cardIsRestatedEvidence = (scopeKey, card, messages) => {
    if (!scopeKey || !claimEvidenceEnabled()) return false;
    let root = null;
    try { root = resolveStoreRoot(config); } catch { root = null; }
    if (!root) return false;
    // "还在上下文里"= 我们自己投过的卡消息里还能找到那一行（逐字 hash）。找不到 ⇒ 可能被压缩掉了。
    const lines = contextLineHashes(injectedCardTexts(messages));
    if (!lines.size) return false;
    try {
      const items = cardEvidenceItems(card, scopeKey);
      if (!items.length) return false;
      return restatedEvidenceOf(readClaimEvidenceLedger({ storeRoot: root }), items, lines).restated;
    } catch (error) {
      if (!slotLedgerNotified.has(root)) {
        slotLedgerNotified.add(root);
        warn(ctx, `内容身份账本不可用（本轮退回进程内去重）：${String(error?.message ?? error)}`);
      }
      return false;
    }
  };

  /**
   * 真注入成功后，把这张卡每行的**内容身份 + 渲染行 hash** 记进 sidecar（一次读写）。
   *
   * 只记**真注入**：影子模式（`action:'shadow'`）没进上下文，记了会把将来的真注入当成复述吞掉。
   * 记账失败不影响本轮（卡已经投出去了），只留一次 warn。
   */
  const rememberDeliveredEvidence = (scopeKey, card) => {
    if (!scopeKey || !claimEvidenceEnabled()) return;
    let root = null;
    try { root = resolveStoreRoot(config); } catch { root = null; }
    if (!root) return;
    try {
      const items = cardEvidenceItems(card, scopeKey);
      if (!items.length) return;
      recordEvidence({ storeRoot: root, items, at: clockOf(config) });
    } catch (error) {
      if (!slotLedgerNotified.has(root)) {
        slotLedgerNotified.add(root);
        warn(ctx, `内容身份账本记账失败（本轮照常注入）：${String(error?.message ?? error)}`);
      }
    }
  };

  return async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || typeof decision !== 'object') return decision;
      if (decision.kind !== 'enter') return decision;
      if (!Array.isArray(decision.messages)) return decision;

      const session = payload?.agent?.session ?? payload?.session ?? null;
      const sessionId = sessionIdOf(session); // T25：按 id 判会话（宿主每步可能换对象）
      // T25：WeakSet 只能收对象 —— 极端情况下 payload.session 可能是字符串，兜底时先判类型（不许炸）
      const sessionObject = session && typeof session === 'object' ? session : null;

      // D5：先看这一刀有没有"同类失败反复"。它不受 oncePerSession 限制，但每会话有上限。
      if (config.repeatHint && (config.enabled || config.shadow)) {
        try {
          const repeatState = repeatStateFor(repeatStates, session, config.repeatHintAfter);
          if (repeatState && repeatState.injected < config.repeatHintMax) {
            const trigger = collectRepeatTrigger(repeatState, payload?.messages);
            if (trigger && config.shadow) {
              // 影子模式（2026-11-02）：D5 不真注入，但**照样记录**"本来会补一张卡"。
              try {
                telemetry.writeRepeatTelemetry({ config, trigger, at: Date.now(), shadow: true });
              } catch { /* 影子遥测失败不影响决策 */ }
              repeatState.injected += 1;
            } else if (trigger) {
              const deps5 = await resolveDeps(config);
              const inner = await decidePreStep({
                ctx,
                config,
                deps: deps5,
                payload: { ...payload, messages: [{ role: 'user', content: [{ type: 'text', text: trigger.quote }] }] },
                decision,
                lifecycle,
                telemetry,
              });
              // T49：D5 也吃同一条去重 —— 卡已在上下文里就别再投（否则每次重新 apply 后 D5 会补同一张）
              if (inner?.action === 'inject' && !cardAlreadyInContext(payload?.messages, inner.card)) {
                repeatState.injected += 1;
                // D5 遥测（2026-11-02）：真注入后要能统计"二次命中触发率与误报"。任何异常不影响本轮注入。
                try {
                  telemetry.writeRepeatTelemetry({ config, trigger, card: inner.card, digest: inner.digest, at: Date.now() });
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

      // T52（2026-11-09）：被 oncePerSession 拦下时**留一条墓碑行**（每会话一次）。
      // 为什么：早退发生在心跳写入之前 ⇒ 台账里"被限流静默"与"插件根本没被调用/已死"长得一模一样。
      if (config.oncePerSession && session) {
        // task-11：判据 = ① 同实例投过（内存）或 ② 账本记着的那份正文**还在本轮上下文里**（sidecar）。
        const blockedBySession = sessionId
          ? (injectedIds.has(sessionId) || slotSaysAlreadyInjected(sessionId, payload?.messages))
          : (sessionObject ? injectedObjects.has(sessionObject) : false);
        if (blockedBySession) {
          const key = sessionId ?? '(no-id)';
          if (!oncePerSessionNotified.has(key)) {
            oncePerSessionNotified.add(key);
            try {
              telemetry.appendLiveStats(resolveStoreRoot(config), {
                kind: 'pre-step',
                scope: lastResolvedScope(session?.id)?.scope ?? null,
                scopeFrom: lastResolvedScope(session?.id)?.from ?? null,
                action: 'skip',
                reason: 'once-per-session',
                digest: null,
                tokens: null,
                shadow: config.shadow === true,
              });
            } catch { /* 心跳失败不影响决策（这条本来就只是留痕） */ }
          }
          return decision;
        }
      }

      const deps = await resolveDeps(config);
      let result = await decidePreStep({ ctx, config, deps, payload, decision, lifecycle, telemetry });
      // T49：**无状态去重**（`oncePerSession` 只在同一个 apply 实例里有效；宿主重新 apply 后它一定是空的）。
      // 卡正文已经逐字出现在本轮上下文里 ⇒ 再投一次是确定的浪费。降级成 `skip`（带 reason）。
      if (result.action === 'inject' && cardAlreadyInContext(payload?.messages, result.card)) {
        // **`decision` 必须是官方入参那个原对象** —— `result.decision` 已经带上了那张卡，拿它返回等于照样注入。
        result = { ...result, action: 'skip', reason: 'already-in-context', decision };
      }
      // P0-2：T49 只挡"正文逐字相同"的卡。正文一变（多一行 / 行序变了 / 索引行的局数变了）它就漏，
      // 卡上**模型已经看过的那些行**会被整张卡复述一遍。这里按**每一行的内容身份**再判一次：
      // 全卡都是"已投过且那一行还在上下文里"的证据 ⇒ 没有一条新事实 ⇒ 不投。
      // 判据只来自 sidecar 身份账本（不吃本轮 top-k），所以跨 apply / 跨重启都成立。
      const dedupeScope = sessionId ? (lastResolvedScope(sessionId)?.scope ?? null) : null;
      if (result.action === 'inject' && cardIsRestatedEvidence(dedupeScope, result.card, payload?.messages)) {
        result = { ...result, action: 'skip', reason: 'restated-evidence', decision };
      }
      // enabled=false 时的 "skip disabled" 没有诊断价值，别写（任何库内调用都会带出来一堆噪声）。
      if (config.liveStats === true && !(result.action === 'skip' && result.reason === 'disabled')) {
        const storeRootForStats = resolveStoreRoot(config);
        if (config.sampleCards === true && (result.action === 'inject') && result.card?.section) {
          // T365/T10/T16：留样带**完整信号**与指针行自证字段；撞上限由写盘侧一次性 warn（不在这里）。
          telemetry.recordCardSample({
            ctx,
            storeRoot: storeRootForStats,
            result,
            payload,
            scope: lastResolvedScope(session?.id)?.scope ?? null,
            scopeFrom: lastResolvedScope(session?.id)?.from ?? null,
            notified: cardSampleCapNotified,
          });
        }
        const liveStatsWrite = telemetry.appendLiveStats(storeRootForStats, {
          kind: 'pre-step',
          // T364（2026-11-19）：**带上会话 id** —— 没有它，A1.redundant 只能按「同 scope」判。
          sid: sessionId ?? null,
          scope: lastResolvedScope(session?.id)?.scope ?? null,
          scopeFrom: lastResolvedScope(session?.id)?.from ?? null,
          action: result.action ?? 'skip',
          gateIds: Array.isArray(result.gateIds) && result.gateIds.length ? result.gateIds : null,
          gateCodes: Array.isArray(result.gateCodes) && result.gateCodes.length ? result.gateCodes : null,
          reason: result.reason ?? null,
          digest: result.digest ?? null,
          tokens: result.card?.tokens ?? null,
          shadow: config.shadow === true,
          // T160：只有 gates-failed 才有这两项 —— "被哪几条 claim 拦住 / 卡上本来有几行"。
          ...(result.reason === 'gates-failed'
            ? {
              gateClaimIds: Array.isArray(result.gateClaimIds) ? result.gateClaimIds : [],
              gateLineCount: Number.isFinite(result.gateLineCount) ? result.gateLineCount : null,
            }
            : {}),
        });
        // T18：心跳撞上限不许静默 —— 一次性 warn + 一条 kind=live-stats-cap 的墓碑行。
        telemetry.traceLiveStatsCap({ ctx, storeRoot: storeRootForStats, result: liveStatsWrite, notified: liveStatsCapNotified });
      }
      // 真注入成功 / 影子记录写成 ⇒ 这个会话就别再来一遍（T25：按 session.id 记；无 id 才按对象）
      // task-11：同时记进 sidecar 槽位账本 —— 跨 apply / 跨重启的判据在账本里。
      // P0-2：真注入再逐行记**内容身份**（记忆侧去重的键；影子没进上下文，不记）。
      if (result.action === 'inject' || result.action === 'shadow') {
        if (session) rememberInjectedSlot(sessionId, sessionObject, result.card);
      }
      if (result.action === 'inject') rememberDeliveredEvidence(dedupeScope, result.card);
      return result.decision ?? decision;
    } catch (error) {
      // 兜底：任何异常都不许冒泡到宿主（否则会阻塞本轮对话）
      warn(ctx, `注入失败（继续本轮）：${String(error?.message ?? error)}`);
      return decision;
    }
  };
}

/**
 * 造 `agent/turn-stopping` 的处理器：D1 —— 轮次收尾时按时间阈值增量刷新记忆库。
 * 条件：开了 autoArchive、库存在、且 manifest.updatedAt 已超过 autoArchiveMinutes。
 */
export function createTurnStoppingHandler({ ctx, config, lifecycle }) {
  return async () => {
    try {
      if (!config.autoArchive) return;
      const root = resolveStoreRoot(config);
      if (!root || !fs.existsSync(root)) return;
      const marker = path.join(root, 'manifest.json');
      let updated = 0;
      try { updated = Number(JSON.parse(fs.readFileSync(marker, 'utf8')).updatedAt) || 0; } catch { updated = 0; }
      const age = Date.now() - updated;
      if (age < config.autoArchiveMinutes * 60 * 1000) return;
      scheduleAutoBuild({ ctx, storeRoot: root, deps: config.deps ?? null, reason: 'periodic', lifecycle });
    } catch (error) {
      warn(ctx, `增量刷新检查失败：${String(error?.message ?? error)}`);
    }
  };
}
