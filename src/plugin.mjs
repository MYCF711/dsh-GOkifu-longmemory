// src/plugin.mjs —— 棋院（Kifu-in）宿主插件入口：**组合根 + 出口垫片**（重构 C 期 M1）。
//
// 本文件只做三件事：
//   ① **组合根**：`apply()` 解析配置 → 建运行时（lifecycle）→ 挂两个钩子（hooks）；
//   ② **出口垫片**：原导出面（named + default）逐项不变 —— 宿主、脚本、测试只认这一层；
//   ③ **诊断留痕写盘**：卡样本 / live-stats / 消息语料 / D5 遥测的**唯一写点**。
//      为什么留在这里：T42 用**源扫描**钉住三个 64MB 上限的常量定义、T365 钉住
//      `...cardSampleSignal(payload?.messages)` 这一行 —— 两条 tombstone 要求"写盘代码就长在这个文件里"，
//      所以它们不随注入逻辑搬进 hooks.mjs（判据不许松，搬走就等于让那两条用例变成空转）。
//
// 其余职责按"删掉谁，哪条用例红"切开了：
//   · `src/hooks.mjs`     —— 钩子注册与事件绑定 + pre-step 决策流水线（decidePreStep）
//   · `src/lifecycle.mjs` —— 配置解析 / apply 运行时 / dispose 语义 / autoBuild 共享 record / 预热 / 工具面
//   · `src/cache.mjs`     —— walk cache / bundle 读取 / 探针缓存 / 会话作用域缓存
// 依赖方向：`plugin → hooks → lifecycle → cache`（**无环**；cache 是叶子，只 import 房间）。
//
// ── 接缝与边界（全文见 docs/记忆的职责边界.md）──────────────────────────────
//   · `agent/pre-step` 是 waterfall：`next()` 取下游默认，返回 `{kind:'enter', messages}` 才替换入步消息；
//     与压缩插件同点注入时两个替换**互不代管**。
//   · 只读 sidecar；**不写会话事件**、不 append、不改会话日志；唯一的输出就是返回的 decision。
//   · **不阻塞会话**：库缺失 / 构建抛错 / 闸门不过 / 消息造不出来 —— 一律 warn + 原样返回下游 decision。
//   · 注入内容只陈述事实（祈使句/许可/建议由 R13 边界闸判，`gates.ok === false` 就不注入）。
//
// ── 配置：键与默认值见 `lifecycle.mjs` 的 `DEFAULT_CONFIG`（唯一一份）────────────
import fs from 'node:fs';
import path from 'node:path';

// T3：`DEFAULT_CONFIG.pointerTier` 的默认值 = `POINTER_TIER_DEFAULT`（单一来源，与 R12 的默认参数同一份）。
import { POINTER_TIER_DEFAULT } from './rooms/inject.mjs';

import {
  CARD_SOURCE_FORM,
  CARD_SOURCE_KIND,
  HOOK,
  LLM_PACKAGE,
  MESSAGE_ENTITY_PATTERNS,
  PLUGIN_VERSION,
  cardAlreadyInContext,
  cardText,
  classifyAbstainReason,
  collectRepeatTrigger,
  createPreStepHandler,
  createTurnStoppingHandler,
  digestOf,
  gateClaimIdsFromGates,
  gateCodesFromGates,
  gateIdsFromGates,
  insertAfterClaimed,
  lastUserText,
  makeUserMessageFallback,
  messageEntities,
  messageText,
  name,
  sessionIdOf,
  signalFromMessages,
} from './hooks.mjs';
import {
  CONFIG_ROUTE,
  USER_CONFIG_FILE,
  WARMUP_MAX_EPISODES,
  WARMUP_MAX_LINKS,
  createConfigApi,
  createPluginRuntime,
  enforceStoreRoot,
  readUserConfig,
  resolveShadowDir,
  warn,
  writeUserConfig,
} from './lifecycle.mjs';
import {
  SESSION_MAP_MAX,
  WALK_CACHE_IDLE_MS,
  lastResolvedScope,
  probeCacheSize,
  probeCardValidity,
  resolveSessionScope,
  sessionLogScope,
  sessionScopeIndex,
  walkCacheEntries,
  walkCacheSize,
} from './cache.mjs';

// ── 出口垫片：下面这四组 `export { … }` 就是"原导出面逐项相等"的清单 ──────────
export {
  CARD_SOURCE_FORM,
  CARD_SOURCE_KIND,
  HOOK,
  LLM_PACKAGE,
  MESSAGE_ENTITY_PATTERNS,
  PLUGIN_VERSION,
  cardAlreadyInContext,
  cardText,
  classifyAbstainReason,
  collectRepeatTrigger,
  digestOf,
  gateClaimIdsFromGates,
  gateCodesFromGates,
  gateIdsFromGates,
  insertAfterClaimed,
  lastUserText,
  makeUserMessageFallback,
  messageEntities,
  messageText,
  name,
  sessionIdOf,
  signalFromMessages,
};
export {
  CONFIG_ROUTE,
  USER_CONFIG_FILE,
  WARMUP_MAX_EPISODES,
  WARMUP_MAX_LINKS,
  enforceStoreRoot,
  readUserConfig,
  writeUserConfig,
};
export {
  SESSION_MAP_MAX,
  WALK_CACHE_IDLE_MS,
  lastResolvedScope,
  probeCacheSize,
  probeCardValidity,
  resolveSessionScope,
  sessionLogScope,
  sessionScopeIndex,
  walkCacheEntries,
  walkCacheSize,
};

// ---------------------------------------------------------------------------
// 配置默认值表：**唯一一份，必须逐字留在这里**
//
// `scripts/m5-report.mjs` 的 `readPluginFacts` 用**源扫描**读本文件的 `DEFAULT_CONFIG`（A3 轴的
// 「零配置默认开启」事实）；T42 那一族 tombstone 用的是同一套「源即判据」写法。判据不许松 ⇒
// 表留在入口，配置**逻辑**（sanitize / resolve / schema / 设置路由）在 `lifecycle.mjs` 的
// `createConfigApi`，表以参数注入 ⇒ 依赖方向仍是 plugin → lifecycle（不成环）。
// ---------------------------------------------------------------------------
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
  // T366e：**不相关时沉默**（知识库 79/87）。**默认开启**，但受两层限制：
  // ① 只在 `hasReliableHandle(text)` 的输入上生效（短指令/纯通用中文 ⇒ 不启用，保守）；
  // ② `abstainIrrelevant: false` 可显式关掉。
  // ⚠ **不要用 `config.abstainIrrelevant !== false` 做默认开启** ——
  //    `undefined !== false` = true 会把"**未设置**"当成"**开启**"（D5 实测踩过）；
  //    **在 DEFAULT_CONFIG 里设 true** 才是正确的默认开启写法（未设置时有明确默认值）。
  abstainIrrelevant: true,
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
  // T3（三级交付）：**没把握 ⇒ 只给指针**（`observed` 且支撑 ≤ `POINTER_SUPPORT_LIMIT`）。
  // 默认值 = `POINTER_TIER_DEFAULT`（单一来源，与 `buildMemoryCard` / `collectEntries` 的默认参数同一份），
  // 不再各自写一个字面量 —— 否则"函数默认关、插件默认开"会静默分叉。
  // `false` 可显式关掉（回到 0.8.46 行为，向后兼容；A/B 对照也走它）。
  pointerTier: POINTER_TIER_DEFAULT,
  // Q19 预置（2026-11-03）：true = 只注入 hard 约束，丢弃 soft 偏好（理由句/闲聊）。默认关，等主人裁定。
  preferenceHardOnly: false,
  liveStats: true, // A3 心跳：每步一行 live-stats.jsonl（默认开；关掉不影响功能）
  repeatHint: true,
  repeatHintAfter: 2,
  repeatHintMax: 1,
  deps: null,
});

const configApi = createConfigApi(DEFAULT_CONFIG);
const { sanitizeConfig, resolveConfig, Config, storeStatsOf, handleConfigRoute } = configApi;
export { sanitizeConfig, resolveConfig, Config, storeStatsOf, handleConfigRoute };

// T282：**写入根收口到 sidecar** —— 相对 `<storeRoot>` 的路径，绝不写仓库。
// 独立实例（DSH 0.2.2-rc.1）link 本源码时，数据必须落在**它自己的** store root 下，
// 当前源码仓库保持只读（tombstone：仓库目录里不许出现新文件）。
export const MESSAGE_CORPUS_PATH = 'corpus/messages.jsonl';

/** 语料绝对路径：**由 store root 推导**（不写死任何仓库路径）。 */
export function messageCorpusPath(storeRoot) {
  return path.join(String(storeRoot ?? ''), MESSAGE_CORPUS_PATH);
}
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

/**
 * T20（T18 遗留）：消息语料 `corpus/messages.jsonl` 的**字节上限** —— 无上限 → **64 MB**。
 *
 * 读者清单（先查后定）：全仓只有 **1 个读者** —— `scripts/t267-replay.mjs` 的 `CORPUS`
 * （`readFileSync` 整文件、逐行重放）。它不在本任务的可写范围 ⇒ 与 T16/T18 同一条硬约束：
 * **任何让读者静默少读的方案（分段/轮转）都不行**；抬上限 = 零读者改动、旧行一字不改。
 * 64MB 按当前 ~357 行/天 × 1,985 B/行 ≈ 709 KB/天估算 ≈ 95 天（见 evidence/T20-corpus-cap.md）。
 *
 * 撞线不静默：`appendMessageCorpus` 返回 `capped`，`traceMessageCorpusCap` 一次性 warn +
 * 往 live-stats 写一条 `kind:'messages-corpus-cap'`（`allowOverCap` —— 台账自己也满时仍落得下）。
 */
export const MESSAGE_CORPUS_CAP_BYTES = 64 * 1024 * 1024;

/** 追加一行语料；**绝不抛**（写失败只 warn）。T20：返回值从 `boolean` 改成 `{ status, fileBytes }`（written|capped|failed）。 */
export function appendMessageCorpus(rootDir, row, { fsImpl = fs, capBytes = MESSAGE_CORPUS_CAP_BYTES } = {}) {
  try {
    const file = messageCorpusPath(rootDir);
    const stat = typeof fsImpl.existsSync === 'function' && fsImpl.existsSync(file) ? fsImpl.statSync(file) : null;
    const fileBytes = stat ? stat.size : 0;
    const cap = Number.isFinite(capBytes) && capBytes > 0 ? capBytes : MESSAGE_CORPUS_CAP_BYTES;
    if (stat && stat.size >= cap) return { status: 'capped', fileBytes }; // 到上限就停写（旧行一字不动）
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const safe = { ...row, messages: (row.messages ?? []).map((m) => ({ ...m, text: redactForCorpus(m.text) })) };
    fsImpl.appendFileSync(file, `${JSON.stringify(safe)}
`);
    return { status: 'written', fileBytes };
  } catch {
    return { status: 'failed', fileBytes: 0 };
  }
}

/**
 * T20：消息语料撞上限时留**可发现**的痕迹（一次性 warn + live-stats 一条 `messages-corpus-cap`）。
 * `notified` 由 `apply()` 的 lifecycle 持有（每插件实例、每 store 只报一次）—— 撞线后每一步都会尝试采集，
 * 不设闸就会每步刷一条。痕迹写进 live-stats（现有 8 个读者都能看见），不写没人读的新文件。
 */
export function traceMessageCorpusCap({ ctx = null, storeRoot = null, result = null, notified = null } = {}) {
  if (!result || result.status !== 'capped' || !storeRoot) return false;
  const seen = notified instanceof Set ? notified : new Set();
  if (seen.has(storeRoot)) return false;
  seen.add(storeRoot);
  warn(ctx, `消息语料已到上限 ${MESSAGE_CORPUS_CAP_BYTES} 字节（${messageCorpusPath(storeRoot)}，当前 ${result.fileBytes}）：后续语料不再采集，归档或抬高上限后恢复；本提示每个进程只发一次。`);
  appendLiveStats(storeRoot, {
    kind: 'messages-corpus-cap',
    action: 'skip',
    reason: 'messages-corpus-cap',
    capBytes: MESSAGE_CORPUS_CAP_BYTES,
    fileBytes: Number.isFinite(result.fileBytes) ? result.fileBytes : null,
  }, { allowOverCap: true }); // T18：live-stats 自己也满时，这条语料已满的痕迹仍要落得下（每进程一次）
  return true;
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

/**
 * T18（T16 遗留）：心跳台账 `live-stats.jsonl` 的**字节上限** —— 无上限 → **64 MB**。
 *
 * 为什么选「抬上限」而不是「按月分段」：`live-stats.jsonl` 有 **6 个整文件读者**
 * （`scripts/live-stats.mjs`、`arena-report.mjs`、`audit-card-samples.mjs --current`、`m5-report.mjs`、
 * `watch-first-inject.mjs`，以及经 `live-stats.mjs` 的 `patrol.mjs` / `status-digest.mjs`），
 * 另有 `ledger-check.mjs`（只 stat 判新鲜）与 `kifu-profile-doctor.mjs`（只读 tail）。
 * 按月分段会让这些读者的「规范路径」静默只剩最新一段 —— 与 T16 同一条硬约束：
 * **任何让读者静默少读的方案都不行**。抬上限 = 零读者改动、旧行一字不改。
 * 64MB 按当前 228 B/行、~1,920 行/天估算 ≈ 29 万行 ≈ 5 个月（见 evidence/T18-live-stats-cap.md）。
 *
 * 撞线不静默：`appendLiveStats` 返回 `capped`，`apply` 里一次性 warn + 写一条 `kind:'live-stats-cap'` 的墓碑行。
 * 墓碑行是**唯一**允许越界（`allowOverCap`）的一行，而且**就写在 live-stats 里** ——
 * 这样 6 个整文件读者都能看见它；写在没人读的新文件里等于没留痕。
 */
export const LIVE_STATS_CAP_BYTES = 64 * 1024 * 1024;

export function appendLiveStats(storeRoot, row, { capBytes = LIVE_STATS_CAP_BYTES, allowOverCap = false } = {}) {
  try {
    if (!storeRoot) return { status: 'absent', fileBytes: 0 };
    // 不创建目录：库还不存在时（首次用之前）不写心跳，避免把"无库"变成"有库"。
    if (!fs.existsSync(storeRoot)) return { status: 'absent', fileBytes: 0 };
    const file = path.join(storeRoot, 'live-stats.jsonl');
    const stat = fs.existsSync(file) ? fs.statSync(file) : null;
    const fileBytes = stat ? stat.size : 0;
    const cap = Number.isFinite(capBytes) && capBytes > 0 ? capBytes : LIVE_STATS_CAP_BYTES;
    if (!allowOverCap && stat && stat.size >= cap) return { status: 'capped', fileBytes }; // 到上限就停写
    const src = (process.argv[1] ? path.basename(process.argv[1]) : 'host').slice(0, 40);
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), src, pid: process.pid, ...row })}
`);
    return { status: 'written', fileBytes };
  } catch { /* 心跳失败不影响决策 */ }
  return { status: 'failed', fileBytes: 0 };
}

/**
 * T18：心跳撞上限时留**可发现**的痕迹（一次性 warn + 一条 `kind:'live-stats-cap'` 墓碑行）。
 *
 * `notified` 由 `apply()` 的闭包持有（每个插件实例、每个 store 只报一次）——
 * 撞线后每一步都会走到 `appendLiveStats`，不设闸就会每步刷一行。
 * 墓碑行走 `allowOverCap`（唯一允许越界的一行），这样 `scripts/live-stats.mjs` 的 `reason` 聚合里会看到
 * `live-stats-cap=1` —— 台账满了这件事本身仍然可被现有读者发现。
 */
export function traceLiveStatsCap({ ctx = null, storeRoot = null, result = null, notified = null } = {}) {
  if (!result || result.status !== 'capped' || !storeRoot) return false;
  const seen = notified instanceof Set ? notified : new Set();
  if (seen.has(storeRoot)) return false;
  seen.add(storeRoot);
  const file = path.join(storeRoot, 'live-stats.jsonl');
  warn(ctx, `live-stats 已到上限 ${LIVE_STATS_CAP_BYTES} 字节（${file}，当前 ${result.fileBytes}）：后续心跳不再记录，归档或抬高上限后恢复；本提示每个进程只发一次。`);
  appendLiveStats(storeRoot, {
    kind: 'live-stats-cap',
    action: 'skip',
    reason: 'live-stats-cap',
    capBytes: LIVE_STATS_CAP_BYTES,
    fileBytes: Number.isFinite(result.fileBytes) ? result.fileBytes : null,
  }, { allowOverCap: true });
  return true;
}

// ---------------------------------------------------------------------------
// T10 · 卡样本里的信号：**存完整信号**（上限 4096 字符）
//
// 为什么改：T6 §4.1 实测 `card-samples.jsonl` 的 `signalPreview` 是「中位 0 / max 160」——
// 绝大多数旧行**根本没有这个字段**（T365 之前写的），有的那些全被截在 160 字。
// 拿它对账「这张卡该不该注入」时，会把「信号不全」误读成「内容不相关」（T6 因此只能改从会话日志重建）。
//
// 为什么**不**无限存：`appendCardSample` 有 8 MB 上限，一条 user 消息里贴进整份日志（几十 KB）时
// 按原文全存 ⇒ 数百条样本就把文件撑满、抽样**提前静默停止**。
// 上限值取 4096（**≥ T10 的「至少 2KB」**）：本机 `corpus/messages.jsonl` 的 495 条真实 pre-step 信号
// 长度中位 **1106** / p90 2843 / p95 3352（脱敏后的文本，语料自身封顶 4000）⇒ 4096 基本等于「完整」，
// 而 2048 会再截掉 16.4% 的真实信号 —— 那还是"审计失真"，只是程度轻一点。
// 超出上限的部分不假装完整：`signalPreviewTruncated: true` 明示「原文更长」。
// 注意：**文件名/字段名不变**（`signalPreview`），旧行缺新字段仍可读（缺 = 该行早于本版本）。
// ---------------------------------------------------------------------------

/** 卡样本信号的字符上限（T10：完整信号、至少 2KB；4096 覆盖真实信号的 p95）。 */
export const CARD_SAMPLE_SIGNAL_LIMIT = 4096;

/**
 * 卡样本的 `signalPreview` 字段（T10）：**完整信号**，最多 `CARD_SAMPLE_SIGNAL_LIMIT` 字符。
 *
 * 取的是与判定**同一条**信号：`lastUserText(messages)`（`decidePreStep` 里的 `text` 就是它）。
 * 返回 `{ signalPreview, signalPreviewTruncated }`：多给一个布尔，让离线脚本能区分
 * 「原文就这么短」与「原文更长、只留了前 4KB」—— 这正是 T6 踩的那个坑（截断被当成完整）。
 */
export function cardSampleSignal(messages, { limit = CARD_SAMPLE_SIGNAL_LIMIT } = {}) {
  const full = String(lastUserText(messages) ?? '');
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : CARD_SAMPLE_SIGNAL_LIMIT;
  return { signalPreview: full.slice(0, max), signalPreviewTruncated: full.length > max };
}

/**
 * T16（T10 遗留）：卡样本文件的**字节上限** —— 8 MB → **64 MB**。
 *
 * 为什么选「抬上限」而不是「按大小轮转」：
 *   `card-samples.jsonl` 在本仓有**两个独立读者** —— `scripts/audit-card-samples.mjs` 与
 *   `scripts/offset-attribution.mjs`（后者自己 readFileSync 规范路径，不在本任务可写范围）。
 *   轮转会让「card-samples.jsonl」这个名字的含义静默改变（只剩最新一段），第二个读者会**无声**少读历史；
 *   抬上限是零读者改动、旧文件原样可读（append-only），代价只是磁盘：按 T10 后的行宽估算
 *   64MB ≈ 2.8 万条 ≈ 94–114 天（8MB 只够 ≈ 3.5 千条 ≈ 12–14 天；见 evidence/T16-card-sample-cap.md 的实测口径）。
 * 撞线不再静默：`appendCardSample` 返回 `capped`，`traceCardSampleCap` 会 warn 一次并写一条 live-stats。
 */
export const CARD_SAMPLE_CAP_BYTES = 64 * 1024 * 1024;

/**
 * 注入质量抽样：只写 sidecar；失败不影响注入（2026-11-04）。
 *
 * T16：返回值从 `undefined` 改成状态对象 `{ status, fileBytes }`，`status ∈ written|capped|absent|failed`
 * —— 让调用方能把「撞上限」记成可发现的痕迹（旧调用方忽略返回值 ⇒ 行为不变）。
 * `capBytes` 只给测试注入小上限；生产永远走 `CARD_SAMPLE_CAP_BYTES`。
 */
export function appendCardSample(storeRoot, row, { capBytes = CARD_SAMPLE_CAP_BYTES } = {}) {
  try {
    if (!storeRoot || !fs.existsSync(storeRoot)) return { status: 'absent', fileBytes: 0 };
    const file = path.join(storeRoot, 'card-samples.jsonl');
    const stat = fs.existsSync(file) ? fs.statSync(file) : null;
    const fileBytes = stat ? stat.size : 0;
    const cap = Number.isFinite(capBytes) && capBytes > 0 ? capBytes : CARD_SAMPLE_CAP_BYTES;
    if (stat && stat.size >= cap) return { status: 'capped', fileBytes }; // 到上限就停写（旧行一字不动）
    // 2026-11-04：留样带 pid —— 宿主重启后新旧进程会混写同一文件，
    // 审计要能按进程切（`audit-card-samples --pid <n>`），否则"旧代码的账"会被误读成回归。
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...row })}
`);
    return { status: 'written', fileBytes };
  } catch { /* 抽样失败不影响注入 */ }
  return { status: 'failed', fileBytes: 0 };
}

/**
 * T16：卡样本撞上限时留**可发现**的痕迹（一次性 warn + 一条 live-stats 行）。
 *
 * `notified` 由 `apply()` 的闭包持有（每个插件实例、每个 store 只报一次）——
 * 撞线后每一次注入都会走到 `appendCardSample`，不设一次性的闸就会每步刷一行。
 * 返回 true = 本次真的记了；false = 没撞线 / 已经报过 / 参数不全。
 */
export function traceCardSampleCap({ ctx = null, storeRoot = null, sample = null, notified = null } = {}) {
  if (!sample || sample.status !== 'capped' || !storeRoot) return false;
  const seen = notified instanceof Set ? notified : new Set();
  if (seen.has(storeRoot)) return false;
  seen.add(storeRoot);
  const file = path.join(storeRoot, 'card-samples.jsonl');
  warn(ctx, `卡样本已到上限 ${CARD_SAMPLE_CAP_BYTES} 字节（${file}，当前 ${sample.fileBytes}）：后续注入不再留样，归档或抬高上限后恢复；本提示每个进程只发一次。`);
  appendLiveStats(storeRoot, {
    kind: 'card-samples-cap',
    action: 'skip',
    reason: 'card-samples-cap',
    capBytes: CARD_SAMPLE_CAP_BYTES,
    fileBytes: Number.isFinite(sample.fileBytes) ? sample.fileBytes : null,
  }, { allowOverCap: true }); // T18：live-stats 自己也满时，这条"卡样本已满"的痕迹仍要落得下（每进程一次）
  return true;
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

/**
 * 注入成功后留样（T365/T10/T16）：**卡样本行的唯一组装点**。
 *
 * 为什么单独包一层：hooks.mjs 每步都可能要留样，但"卡样本长什么样"与三个 64MB 上限
 * 必须留在这个文件里（T42 的源扫描 + T365 的 `...cardSampleSignal(payload?.messages)`）。
 * hooks 只通过注入的 `telemetry.recordCardSample` 调它，不自己拼这行。
 * 行内字段与拆分前**逐项一致**（顺序也一致：scope / scopeFrom / digest / tokens / section / 信号 / 指针自证）。
 */
function recordCardSample({ ctx = null, storeRoot = null, result = null, payload = null, scope = null, scopeFrom = null, notified = null }) {
  if (!result || result.action !== 'inject' || !result.card?.section) return null;
  const cardSample = appendCardSample(storeRoot, {
    scope,
    scopeFrom,
    digest: result.digest ?? null,
    tokens: result.card?.tokens ?? null,
    section: String(result.card.section),
    // T365：**留样必须带信号**，否则"这张卡是否该注入"无法审计。
    // T10：从「只留前 160 字」改为**完整信号**（上限 4KB，另带 `signalPreviewTruncated` 明示截断）。
    // 作用域必须是**外层**（没有 decidePreStep 的局部 text）⇒ 现取 `lastUserText`，与判定同一条。
    ...cardSampleSignal(payload?.messages),
    // T3：**指针行的自证字段** —— A6 文字层要把指针行排除出分子分母，排除前必须能核对数量。
    tier: typeof result.card?.tier === 'string' ? result.card.tier : null,
    pointerCount: Number.isFinite(result.card?.pointerCount) ? Number(result.card.pointerCount) : null,
  });
  // T16：撞上限不许静默 —— 一次性 warn（宿主日志）+ 一条 live-stats（kind=card-samples-cap）。
  traceCardSampleCap({ ctx, storeRoot, sample: cardSample, notified });
  return cardSample;
}

/**
 * 观测留痕的**注入面**：hooks.mjs 只调这些，不 import 本文件（依赖图保持无环）。
 * 全部是"写 sidecar / 写影子台账"，**不参与任何注入判定**，失败一律静默。
 */
const telemetry = Object.freeze({
  messageCorpusRow,
  appendMessageCorpus,
  traceMessageCorpusCap,
  appendLiveStats,
  traceLiveStatsCap,
  writeRepeatTelemetry,
  recordCardSample,
});

// ---------------------------------------------------------------------------
// 插件入口（组合根）
// ---------------------------------------------------------------------------

/**
 * 挂载插件。失败绝不阻塞会话。
 *
 * 分工：`createPluginRuntime` 建运行时（state / disposers / effect / 预热 / 工具面 / 设置路由），
 * 本函数只负责**挂钩子**并交回 disposer。
 *
 * @param {object} ctx  宿主上下文（用 `ctx.on`、`ctx.logger?.warn`；其余一概不碰）
 * @param {object} [rawConfig]
 * @returns {Function} Cordis disposer；旧诊断字段挂在函数属性上
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  // Cordis 4.1 会把 apply 的返回值当作 effect 收集：普通诊断对象会触发 Invalid effect ⇒ 返回真 disposer。
  const runtime = createPluginRuntime({ ctx, config, rawConfig, handleConfigRoute, identity: { name, hook: HOOK } });
  if (!runtime.mounted) return runtime.effect; // 宿主没有 ctx.on：已 warn，原样交回（registered:false）

  const { lifecycle, state, listen, makeEffect } = runtime;
  // 注入钩子（waterfall）：处理器只返回 decision，不写会话日志。
  listen(HOOK, createPreStepHandler({ ctx, config, lifecycle, state, telemetry }));

  // D1（2026-11-02）：轮次收尾时增量刷新记忆库——不再只靠手动/首次 autoBuild。
  try {
    listen('agent/turn-stopping', createTurnStoppingHandler({ ctx, config, lifecycle }));
  } catch (error) {
    warn(ctx, `turn-stopping 钩子没挂上：${String(error?.message ?? error)}`);
  }

  return makeEffect(true);
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
  sessionIdOf,
  CARD_SAMPLE_SIGNAL_LIMIT,
  cardSampleSignal,
  CARD_SAMPLE_CAP_BYTES,
  appendCardSample,
  traceCardSampleCap,
  LIVE_STATS_CAP_BYTES,
  appendLiveStats,
  traceLiveStatsCap,
  MESSAGE_CORPUS_CAP_BYTES,
  appendMessageCorpus,
  traceMessageCorpusCap,
  digestOf,
  insertAfterClaimed,
  cardText,
  apply,
};
