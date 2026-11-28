// limits —— **全仓唯一权威常量表**（task-9 / P0-4「消灭重复门槛实现」）
//
// 为什么有这个文件（本会话踩过两次，事故记录在 task-9）：
//   A4 p50 门槛曾在 `scripts/metrics-guard.mjs`（`a4p50MaxMs`）与
//   `scripts/ledger-check.mjs`（`A4_GATE_MS`）**各写一份 50**，D7 改一半 ⇒ 0.8.160 / 0.8.161
//   连续两次发版被同一个门槛拦下。只要数值能在两处各写一遍，这类事故就会再来。
//
// 上游做法（都是把阈值集中在单一入口，而不是散落在消费点）：
//   · Graphiti：`graphiti_core` 各模块顶部集中 `MAX_SEARCH_DEPTH=3` / `DEFAULT_SEARCH_LIMIT=10` /
//     `NODE_DEDUP_CANDIDATE_LIMIT=15` / `RELEVANT_SCHEMA_LIMIT=10` …[外]
//     （见 evidence/research/mem-zep-graphiti.md「实际存在的约束全是候选/批次级」一节）
//   · LlamaIndex：`Memory.token_limit` / `DEFAULT_TOKEN_LIMIT` 是**唯一**预算入口（Memory=30000、
//     ChatMemoryBuffer=3000）[外]（见 evidence/research/mem-frameworks.md 默认值表）
//   本仓对应做法：判据 / 预算 / 截断的数值只在这里写**一次**，消费方 import；同值字面量不许再出现。
//
// 三条纪律：
//   1) **只搬家、不改值**：每个值都是迁移前逐字相等（test/limits-single-source.test.mjs 钉住快照）。
//   2) **零 import、零 I/O、全部冻结**：R11 `src/rooms/walk.mjs` 依赖这个性质（它的只读结构保证是
//      "没有 fs 句柄就不可能写盘"；import 一张纯常量表不引入任何 I/O 能力）。
//   3) 新增数值先落这里，再让消费方引用；不要在消费点写第二份。

// ---------------------------------------------------------------------------
// 一 · A 期验收面（六轴门槛）
// ---------------------------------------------------------------------------

/** A1 负迁移（staleTransferRate）硬上限 5%。上游对应：Graphiti / LlamaIndex 都不设此门槛，
 *  它是本仓对标 Hindsight 的判据（docs/对标-Hindsight.md §2「A1 负迁移 ≤5% = 硬上限」）[外]。 */
export const A1_MAX = 0.05;

/** T7：A1 的第二条轴（反向记忆率）与 stale **并列**，同一个 5% 硬上限；
 *  只有"通电"（可判率 ≥30% 且线上有正样本）才参与 exit code。上游对应：无（本仓自设）。 */
export const A1_OPPOSITE_MAX = 0.05;

/** T27：A1 的第三条轴（**会话级**冗余注入）浪费上限 1%；只有"通电"才卡。
 *  上游对应：Letta `rebuild_system_prompt` 的"内容没变就跳过"纪律（同一现象的另一种解法）[外]，
 *  阈值本身是本仓自设（1e-2）。 */
export const A1_REDUNDANT_WASTE_MAX = 0.01;

/** A5 跨作用域越界**必须为 0**（硬门槛，不是比例）。上游对应：无（本仓作用域零泄漏要求）。 */
export const A5_MAX = 0;

/** A6 溯源覆盖率必须 100%（=1）：每条注入都带 (episode, seq, occurredAt)。
 *  上游对应：Graphiti 用 `valid_at/invalid_at` 双时态保证可回溯（机制不同，目标同为 100%）[外]。 */
export const A6_MIN = 1;

/** A4 p50 检索延迟门槛（ms）。
 *  旧名：metrics-guard 的 `a4p50MaxMs` 与 ledger-check 的 `A4_GATE_MS` —— **两处曾各写一份 50**
 *  （task-9 事故）。现在只在这里有一份，两个脚本都读它。
 *  D7（2026-11-20 主人裁定）后判红条件：语料指纹一致且比基线退化 >20%；语料变了才退回本绝对门槛。
 *  上游对应：Graphiti 只有遍历/候选上限（`MAX_SEARCH_DEPTH` 等），**没有**延迟门槛 [外]；
 *  本仓 50ms 是自设 SLO。 */
export const A4_P50_MAX_MS = 50;

/** T225：台账值允许是实测值的几倍（同一命令跨时段的量级差）。上游对应：无（本仓台账口径）。 */
export const A4_REL_SLACK = 2;

/** T225：绝对下限（ms）——实测很小时（如 1ms），2 倍也才 2ms，抖动会把它顶穿 ⇒ 再留 20ms。 */
export const A4_ABS_SLACK_MS = 20;

// ---------------------------------------------------------------------------
// 二 · 注入（R12 记忆卡）预算
// ---------------------------------------------------------------------------

/** 命中展开的条数上限（方案 §7.3：≤5 条）。
 *  上游对应：Graphiti `DEFAULT_SEARCH_LIMIT=10`（每次检索返回条数）[外]；LlamaIndex 不限条数只限 token。
 *  本仓取 5 —— 与 walk 的每层 limit 同值同契约。 */
export const ENTRY_LIMIT = 5;

/** 命中展开的 token 预算（方案 §7.2 六条纪律 3：≤500 tokens）。
 *  口径 = indexLine + section 合计（保守）。
 *  上游对应：LlamaIndex `Memory.token_limit` 默认 30000（短期队列 + 全部 memory block 的**总**预算）[外]；
 *  本仓是**单卡**预算，故小两个量级，量级关系见 mem-frameworks.md 默认值表。 */
export const BUDGET_TOKENS = 500;

/** 首轮一行 INDEX 指针的预算（方案 §7.3：~40 tokens；这里放宽到 60 作为闸值）。上游对应：无。 */
export const INDEX_LINE_BUDGET = 60;

/** 单条文本渲染上限（超预算时「先降表示，不丢来源与日期」：160 → 60 两级）。
 *  上游对应：LlamaIndex 超 `token_limit` 时**整段**摘要或丢弃（不截半句）；本仓用字符级降表示
 *  + 台阶式收敛（CLIP_STEPS），两条路线可对照 [外]。 */
export const TEXT_CLIP = 160;

/** 降表示第二级的单条文本上限。 */
export const TIGHT_CLIP = 60;

/** T3：「没把握」的支撑局数上限（含）。口径 = `claim.support.length`（**不按作用域过滤**）。
 *  本仓自设的机械计数判据（AGENTS §2.3「计数不是打分」）。 */
export const POINTER_SUPPORT_LIMIT = 1;

// ---------------------------------------------------------------------------
// 三 · 检索（R11 walk）
// ---------------------------------------------------------------------------

/** walk 深度硬上限（契约 §7.2「深度 ≤2」）。
 *  上游对应：Graphiti `MAX_SEARCH_DEPTH=3`（BFS 最多 3 跳）[外]；本仓 2 跳（多一跳的收益/噪声比在本仓
 *  语料上未验证，故更保守）。 */
export const WALK_MAX_DEPTH = 2;

/** walk 默认条数（= 注入侧同一契约，引用而不是复制）。上游对应：Graphiti `DEFAULT_SEARCH_LIMIT=10` [外]。 */
export const WALK_DEFAULT_LIMIT = ENTRY_LIMIT;

/** walk 默认 token 预算（= 注入侧同一契约，引用而不是复制）。上游对应：LlamaIndex `token_limit` 单入口 [外]。 */
export const WALK_DEFAULT_BUDGET_TOKENS = BUDGET_TOKENS;

/** 一次信号最多匹配几个主题（多了说明信号太宽，宁可少跳）。
 *  上游对应：Graphiti `RELEVANT_SCHEMA_LIMIT=10`（每路检索候选上限）/ `2 * limit = 20`（多路合并前放大）[外]。 */
export const WALK_MAX_TOPICS = 8;

/** path 的最大跳数（保护注入侧上下文）。上游对应：无（本仓 path 长度保护）。 */
export const WALK_MAX_HOPS = 40;

// ---------------------------------------------------------------------------
// 四 · 相关边（R05 link）
// ---------------------------------------------------------------------------

/** 每局最多保留多少条边（D10，2026-11-20 主人裁定走方案③）。
 *  背景：真库 636 局撑起 12.5 万条边（中位数每局 330），97.4% 是 weight=1 硬边；边是"团"，
 *  N 局共享同一文件 ⇒ N² 条，而 walk 深度 ≤2、每层 limit 5 用不到这么多。
 *  上游对应：Graphiti **没有**存量级边上限（复核实测：`max_degree|max_edges|fan_?out` 全仓零命中），
 *  它只约束"候选/批次"（`RELEVANT_SCHEMA_LIMIT` / `NODE_DEDUP_CANDIDATE_LIMIT`）[外]。
 *  本仓因此自设 16（截断候选，不改判据；被截掉的邻居仍可由 holdersByTopic 按需展开）。 */
export const MAX_LINKS_PER_EPISODE = 16;

// ---------------------------------------------------------------------------
// 五 · 插件摘要（心跳行）
// ---------------------------------------------------------------------------

/** 心跳行 `gateCodes` / `gateClaimIds` / 告警行各截前几条（T160）。
 *  上游对应：无（本仓可观测性口径）；数值 5 与注入条数同值但语义不同，故单独命名。 */
export const DIGEST_GATE_CODES_LIMIT = 5;

// ---------------------------------------------------------------------------
// 六 · 可观测性上限（A7 缓存读数，task-18 / P0-5）
//
// 这两个数**不进下面的 `LIMITS` 冻结索引**，理由说清楚（免得下一个人以为是漏了）：
//   `LIMITS` 的键集合被 `test/limits-single-source.test.mjs` 的**快照**钉住（「只搬家、不许调值」那一刀），
//   往里加键等于让那份快照红。可观测性上限不是判据阈值（A7 本身**不判红**），所以按标量导出，
//   数值仍然**只在这里写一次**（消费方 `src/cache.mjs` import 它，不许在落盘点再写一份）。
// ---------------------------------------------------------------------------

/** A7 账本 `cache-breaks.jsonl` 的单文件上限（2 MiB）。撞上限时**轮转**（旧行整体改名为 `.1`），
 *  不是停写 —— 停写会让指标静默变旧（与 T18「抬上限而不是按月分段」同一条纪律：
 *  任何让读者静默少读的方案都不行）。2 MiB 按当前一行约 260 B 估算 ≈ 8,000 轮。
 *  上游对应：Anthropic 不给账本口径（它只给缓存规则）[外]；本仓自设的 sidecar 有界性（T61/T64）。 */
export const CACHE_BREAKS_MAX_BYTES = 2 * 1024 * 1024;

/** A7 读侧只取每个账本文件（含轮转备份）尾部的这么多字节。
 *  为什么是尾读而不是全读：账本 append-only 且宿主每步都写，全读会随运行时长线性变贵；
 *  而 A7 要的是"最近这些轮"的读数。256 KiB ≈ 1,000 轮。 */
export const CACHE_BREAKS_TAIL_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// 七 · 冻结索引（快照测试与跨模块「同一常量对象」判据的锚点）
//
// 消费方要「同一对象」时用这里的引用，而不是各自再拼一张表。
// test/limits-single-source.test.mjs 用 `===` 判 metrics-guard 与 ledger-check 读到的是这个对象。
// ---------------------------------------------------------------------------

export const LIMITS = Object.freeze({
  // A 轴门槛
  a1Max: A1_MAX,
  a1OppositeMax: A1_OPPOSITE_MAX,
  a1RedundantWasteMax: A1_REDUNDANT_WASTE_MAX,
  a5Max: A5_MAX,
  a6Min: A6_MIN,
  a4P50MaxMs: A4_P50_MAX_MS,
  a4RelSlack: A4_REL_SLACK,
  a4AbsSlackMs: A4_ABS_SLACK_MS,
  // 注入预算
  entryLimit: ENTRY_LIMIT,
  budgetTokens: BUDGET_TOKENS,
  indexLineBudget: INDEX_LINE_BUDGET,
  textClip: TEXT_CLIP,
  tightClip: TIGHT_CLIP,
  pointerSupportLimit: POINTER_SUPPORT_LIMIT,
  // 检索
  walkMaxDepth: WALK_MAX_DEPTH,
  walkDefaultLimit: WALK_DEFAULT_LIMIT,
  walkDefaultBudgetTokens: WALK_DEFAULT_BUDGET_TOKENS,
  walkMaxTopics: WALK_MAX_TOPICS,
  walkMaxHops: WALK_MAX_HOPS,
  // 相关边
  maxLinksPerEpisode: MAX_LINKS_PER_EPISODE,
  // 可观测性
  digestGateCodesLimit: DIGEST_GATE_CODES_LIMIT,
});