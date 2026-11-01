# GOkifu 插件测绘简报（供「以单会话棋谱为节点的巨型棋谱」设计用）

> 测绘对象：`D:\主工作区\repos\dsh-GOkifu-compact`（包名 `dsh-gokifu-compact`）
> 测绘时点：2026-11-02 01:0x–01:2x（+08）。**只读仓库，未改任何文件，未 git 提交。**
> ⚠ **工作树不是干净树**：`HEAD = d9e4ffb`，另有 9 个已修改文件 + 1 个未跟踪文件（`src/engine.mjs`、`src/rooms/kifu-model.mjs`、`scripts/doctor.mjs`、`test/engine-harness.test.mjs`、`test/tier2.test.mjs`、`CHANGELOG.md`、`HANDOFF.md`、`docs/research/00-*.md`、`?? test/fold-closure.test.mjs`）。**另一个会话正在同一棵树上写代码**（C24「可寻址闭包」）。本简报的行号按**当前工作树**取，重读前请先 `git status`。
> 数字引用纪律（本仓自己的规矩）：每个数字都要带「时点 + 树」。下文凡未注明者，均为上述工作树 + 上述时点。

---

## 1. 一句话定位 · 版本 · 依赖了 DSH 哪些官方面

**一句话**：它是 DSH 的**上下文压缩后端**（compaction 槽位），把「历史 → 一段摘要」换成「历史 → 棋谱 DAG（节点=状态，边=尝试+验证信号）+ 每步重注入一份 ≈500 token 的热清单」；核心机制是**增量 fold**（只压「上一个 checkpoint 之后」，一段历史一生只摘一次）+ **失败记忆逐字保留**。

| 项 | 值 | 出处 |
|---|---|---|
| 版本 | `1.17.0`（**未发布**：无 tag、未 npm publish） | `package.json:3`、`README.md:3` |
| 运行时 | `node >= 20` | `package.json` `engines` |
| 包入口 | `main: src/ui.mjs`；exports: `.` / `./engine` / `./client` / `./graph` / `./persist` | `package.json:12-24` |
| 单实例约束 | 挂本插件必须 disable `@deepseek-ai/dsh-compaction-basic` | `AGENTS.md` §2.3 |

### 1.1 官方依赖（代码里**只有 4 条 import，全部在 `src/engine.mjs`**）

```js
// src/engine.mjs:20-23
import z from "@deepseek-ai/schemastery";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from "@deepseek-ai/dsh-compaction";
import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from "@deepseek-ai/dsh-llm";
```

`peerDependencies` 里还声明了 `@deepseek-ai/dsh-session`，但**源码零 import**（`src/` 全库 grep 只有上 4 条命中了 `@deepseek-ai`）。这条声明是给宿主解析用的，不是本插件在读它。

**继承关系**（`src/engine.mjs:166-171`）：

```js
export default class ChessCompactionEngine extends BasicCompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];
  static Config = Config;          // 由 SCHEMA 表生成的 schemastery z.object
  constructor(ctx, config = {}) {
    super(ctx, pickBase(config));  // 只把 11 个「基类认识的键」透传给父类
```

`BasicCompactionEngine` 自身 `extends CompactionEngine`（`@deepseek-ai/dsh-compaction`），后者只做 `super(ctx, "compaction")` 注册服务，**三个操作都是 abstract、没有实现**：

```ts
// docs/DSH-技术测绘.md:106-108（逐字取自 asar 的 api-catalog.js）
abstract compactIfNeeded( agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal ): Promise<CompactionResult | null>
abstract compactNow( agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId ): Promise<CompactionResult | null>
abstract compactRegion( start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal ): Promise<CompactionResult>
```

**覆盖面只有三处策略 + 新增两个监听器**（`src/engine.mjs:1-14` 文件头是它的边界声明）：

| 覆盖/新增 | 位置 | 说明 |
|---|---|---|
| `summarize(input, agent, signal)` | `engine.mjs:412` | 官方声明的**唯一**子类钩子；换成「规则事实 + 一次模型润色」 |
| `compactIfNeeded(agent, trigger, signal)` | `engine.mjs:677` | 换成 growth-gated 增量 fold |
| `compactRegion(start, end, agent, signal)` | `engine.mjs:597` | 只为设/恢复 `_chessActiveRange`，**事务本体仍走 `super`** |
| `compactNow(agent, signal, sourceCommandId)` | `engine.mjs:618` | 只为在手动 `/compact` 路径补记 foldMark + 人话错误 |
| 监听 `session/event`（keeper） | `engine.mjs:337` | 每步落账，零模型、零 IO |
| 监听 `agent/pre-step`（ledger） | `engine.mjs:365` | 每步注入/替换热清单 |

**硬规则（机器可判）**：`@deepseek-ai/*` 的 import **只允许**出现在 `src/engine.mjs`，且宿主说明符集合必须恰好是上面那 4 个 —— `test/rooms.test.mjs` 的 R-C / C1 静态断言，`node test/run.mjs rooms` 一跑即知（本次实测 15/0）。

---

## 2. 数据模型

**先纠一个词**：本仓的「**房间（room）**」不是运行期数据结构，是**代码组织单元** —— R00–R15 十三个 `.mjs`，一个房间一个文件、有静态依赖边门禁（`test/rooms.test.mjs`）。`graph.json` 里**没有任何 `room` 字段**。设计新项目时不要把「房间」当节点/容器用。

### 2.1 顶层：一张图 = 一个会话（`createGraph`）

```js
// src/rooms/kifu-model.mjs:48-76
export function createGraph({ sessionId, cwd = "" }) {
  const now = Date.now();
  return {
    version: GRAPH_VERSION,        // = 1，冻结；fromJSON 版本不符直接抛
    sessionId: String(sessionId ?? ""),
    cwd,
    createdAt: now, updatedAt: now,
    nextNode: 1, nextEdge: 1,      // id 分配游标：n1/n2… e1/e2…
    nodes: {},                     // id -> node
    edges: {},                     // id -> edge
    order: [],                     // 节点创建顺序（id 数组）
    stateIndex: {},                // stateKey -> 最早的 nodeId（派生数据，加载时重建）
    rootUserNodeIds: [],           // 首个 user 节点（可多个：用户每次重申根目标会新建）
    checkpointSeq: null,           // 最近一次 fold 产生的 checkpoint 消息 seq
    foldCount: 0,
    lastFoldTotalTokens: 0,
    foldMarks: [],                 // 每次 fold 的记账对象
    lastFoldUsage: null,           // 最近一次摘要调用的真实 usage
  };
}
```

**磁盘上真实存在的额外字段**（运行期写进去的，`createGraph` 不声明）：`lastFoldSeq`、`foldThrash`、`lastFoldMode`、`lastFoldDegraded`。live 实测顶层键：

```
version, sessionId, cwd, createdAt, updatedAt, nextNode, nextEdge, nodes, edges, order,
stateIndex, rootUserNodeIds, checkpointSeq, foldCount, lastFoldTotalTokens, foldMarks,
lastFoldUsage, lastFoldMode, lastFoldDegraded
```

### 2.2 节点（node）—— 只有两种 kind

| 字段 | user 节点 | agent 节点 | 语义 |
|---|---|---|---|
| `id` | `n<seq>` | 同 | 全图唯一，永不复用（`nextNode++`） |
| `kind` | `"user"` | `"agent"` | 只有这两种；没有 system/tool 节点 |
| `seq` | 事件 seq | 事件 seq | **回查唯一锚点**：原文在 append-only 事件日志里按 seq 可回读 |
| `turn` | `event.data.turn ?? null` | 同 | 只用于人读 |
| `text` | ✅ 用户原话**逐字**（不 norm） | — | 约束锚，不可压缩、不可被覆盖 |
| `constraints` | ✅ `string[]`（`extractConstraints`） | — | 正则抽句，逐字保留原句，≤40 条 |
| `goal` | — | ✅ `norm(goal).slice(0,400)` | agent 的「评语」，来源是 assistant 文本里的意图句 |
| `worldHash` | — | ✅ `string`（**必须是字符串**） | 世界状态哈希；历史脏数据（对象）由 `hashText` 收敛 |
| `constraintHash` | — | ✅ `string` | 约束集合哈希（`hashSet`，顺序无关） |
| `via` | — | ✅ `edgeId` | 本节点由哪条边到达 = 回溯主路径的唯一线索 |
| `transpositions` | — | 可选 `number` | 被 `mergeNodeInto` 记的「同一状态被另一条路再次到达」次数 |
| `ts` | ✅ | ✅ | `Date.now()` |

```js
// src/rooms/kifu-model.mjs:102-127（agent 节点，含置换命中分支）
worldHash = hashText(worldHash);
const pending = worldHash === "pending" || constraintHash === "pending";
const key = `${worldHash}/${constraintHash}`;
const originId = via && g.edges[via] ? g.edges[via].from ?? null : null;
if (!pending) {
  const existing = g.stateIndex[key];
  if (existing !== undefined && existing !== originId && g.nodes[existing]) {
    return { id: existing, transposition: { nodeId: existing, hops: hopsBetween(g, via, existing) } };
  }
}
```

**谁写 / 何时写**：`src/rooms/keeper.mjs` 的 `observeEvent(g, event, state)`（`keeper.mjs:163`），挂在 `session/event` 上，**同步、零 IO、永不 await**。
- user 节点：`case "user/message"`（`keeper.mjs:165-182`），且**只认真人消息** —— `source.kind ∈ {user, prompt, human}`（`HUMAN_SOURCES`，`keeper.mjs:119`）。AGENTS/技能目录/记忆注入/subagent 回执一律不建节点（否则工作区说明会被抽成「约束」，实测事故）。
- agent 节点：`case "step/end"`（`keeper.mjs:241-269`），一个 step 结束 = 一个状态节点，本步所有边 `edge.to = node.id`。

### 2.3 边（edge）—— 尝试 + 验证信号

```js
// src/rooms/kifu-model.mjs:208-235
export function addEdge(g, { from, intent = "", action = "", evidence = null }) {
  const id = `e${g.nextEdge++}`;
  g.edges[id] = {
    id, from, to: null,
    intent: norm(intent).slice(0, 200),      // 预想道路（assistant 文本里的意图句）
    action: norm(action).slice(0, 240),      // "tool(关键参数=…)"，`actionSummary` 生成
    result: "untested",                      // untested | success | failure | unverified
    verify: { kind: "none", summary: "" },
    errorSnippet: "",
    evidence,                                // {start:seq, end:seq}（数字形态也吃）
    transposition: false,
    ts: Date.now(),
  };
```

| 字段 | 类型 | 语义 | 由谁写 | 何时 |
|---|---|---|---|---|
| `from` | nodeId | 出发点（本步起点） | keeper | `assistant/message` 的每个 `tool-call` |
| `to` | nodeId \| null | 终点；`null` = 悬空 | keeper | `step/end` 时批量回填本步所有边 |
| `intent` | string≤200 | 「我打算怎么走」 | keeper | addEdge |
| `action` | string≤240 | 「实际做了什么」 | keeper | addEdge |
| `result` | 四态 | `untested`→结算 | keeper + `verify.classify` | `tool/result`（`keeper.mjs:215-238`） |
| `verify` | `{kind, summary}` | 外部验证信号种类 | `verify.classify` | 同上 |
| `errorSnippet` | string≤600 | **报错原文**（热清单的核心资产） | `verify.errorSnippet` | 同上 |
| `evidence` | `{start,end}` | 该边覆盖的 seq 区间 = **出处** | keeper / settle 时回填 end | addEdge / tool·result |
| `transposition` | bool | 该边指向了一个「已到过的状态」 | `mergeNodeInto` | 合并时 |
| `weak` | `"read"\|"shell"` | 弱成功（**只挂 unverified**） | `classify` | tool/result |
| `ts` | number | 创建时刻（悬空边年龄判据用它） | addEdge | — |

**四态语义（不可混）**：`success`（有外部验证信号）/ `failure`（有外部失败信号）/ `unverified`（跑了但无外部信号，**永不升格**）/ `untested`（还没落地）。

### 2.4 置换（transposition）—— 图不建分支的那条规则

`stateKey = worldHash + "/" + constraintHash`，命中 `stateIndex` 就**不新建节点**，只返回命中信息（图上只多一条边）。`mergeNodeInto(g, fromId, intoId)`（`kifu-model.mjs:147-183`）把旧节点的入边/出边全部改指向，并标 `transposition: true`。

**这里踩过两个 P0**（都在代码注释里钉着，设计新项目必读）：
- 置换**只应命中更早的状态**，不能命中本步起点（`originId`），否则 `from === to` ⇒ 图坍缩成自环（实测 530 边/23 节点、全库 60.9% 自环）。
- `mergeNodeInto` 必须同时改 `edge.from` 和 `edge.to`（旧版只改 to ⇒ 155 条边里 115 条 `from` 指向已删节点）。

### 2.5 foldMarks —— 每次 fold 的账本条目

```js
// src/engine.mjs:828-855（自动 fold 的 foldMark；手动/tier2 各有一处同构写入）
g.foldMarks.push({
  at: Date.now(),
  seqStart: range.start, seqEnd: range.end,
  closure: foldClosureOf(g, range),   // {nodes,edges,firstNode,lastNode,firstEdge,lastEdge}
  trigger,                            // pressure | context-overflow | manual | tier2
  shadowedTokens, totalAfter, foldCount,
  route: summaryRoute,                // {provider, model}
  fallback: summaryMode === "rules" ? "rules" : null,
  ms, usage,                          // 端到端耗时 / 摘要调用真实 usage
  summaryChars,
  quality: foldQuality,               // {constraintRecall, failureRecall, compressionRatio, …}
  dangling: danglingStats(g),         // 切边界时的悬空边快照
});
if (g.foldMarks.length > FOLD_MARKS_KEEP) g.foldMarks = g.foldMarks.slice(-FOLD_MARKS_KEEP);  // 只留 20 条
```

live 真实样本（旧版插件写的，缺 `closure/trigger/quality/summaryChars/dangling` —— **字段是只增不减的向后兼容面**）：

```json
{ "at": 1793540242027, "seqStart": 8, "seqEnd": 823, "shadowedTokens": 112024,
  "totalAfter": 273741, "foldCount": 1,
  "route": { "provider": "magpie", "model": "group/deepseek-v4.1-flash1017" },
  "fallback": null, "ms": 16429,
  "usage": { "inputTokens": 178750, "outputTokens": 2310, "totalTokens": 181060 } }
```

**写者唯一**：`src/engine.mjs`（自动：`compactIfNeeded` 尾部 `:828`；手动：`recordFoldMark()` `:645-670`；tier-2：`#tier2IfNeededUnsafe` `:945`）。**读者**：`scripts/doctor.mjs`（跨会话收集）、`scripts/handoff-check.mjs`、`scripts/ui.mjs` 的 `/gokifu/api`。

### 2.6 热清单（hot list）——**不落盘**，但它有身份

热清单是**每次渲染出来的字符串**，不存任何文件。它的「身份」是注入进会话 surface 的一条 `user/message`：

```js
// src/rooms/hot-inject.mjs:250-260
const message = createUserMessage({
  content: [{ type: "text", text: ledgerText }],
  source: { kind: "chess-context", form: "ledger", digest },
});
session.append("user/message", message, {
  surfaceOp: { op: "replace", startSeq: existing.seq, endSeq: existing.seq },  // 就地替换
  sourceEventSeqs: [existing.seq],
});
```

- **存哪**：宿主自己的 append-only 会话日志（surface）。插件不复制。
- **冻结面**：`source.kind = "chess-context"`、`form: "ledger" | "ledger-stub"`、stub 文案逐字、digest 组成 —— 全都是契约（`docs/架构-房间契约.md:231`）。`keeper.isOwnMessage()` 靠这个 kind 跳过自己注入的消息，否则会把自己的清单当用户原话抽成约束。
- **唯一间接落盘物**：`<root>/ledger-budget.json`（见 2.8）。

### 2.7 三层树（人读/模型下钻用）

```
<root>/sessions/<safeSessionId>/
├── index.md              # 缩进树（每节点只出现一次，SGF 风格深度 + DAG 风格唯一）+ 失败边全表
├── nodes/<id>.md         # 单节点：评语 / 状态 / 入边 / 出边 / verify
├── graph.json            # 基线快照（= 上一回合边界）
├── graph.json.delta.jsonl# 本回合增量帧（一行一帧）
```

设计依据（`docs/三层树设计.md`）：棋谱是 **DAG 不是树** —— live 实测 253 节点 / 427 边 / 最大入度 119 / 置换边占 61%，纯目录嵌套会让同一节点重复 119 份。**SGF 是树因为局面不重复；agent 棋谱会重复。**

### 2.8 落盘路径与键（`kifu-persist.mjs`）

```js
// src/rooms/kifu-persist.mjs:68-79
export function sessionPaths(root, sessionId) {
  const dir = nodePath.join(root, "sessions", safeSessionId(sessionId));
  const graphFile = nodePath.join(dir, "graph.json");
  return {
    dir, graphFile,
    deltaFile: `${graphFile}.delta.jsonl`,
    indexFile: nodePath.join(dir, "index.md"),
    nodesDir: nodePath.join(dir, "nodes"),
    budgetFile: nodePath.join(root, LEDGER_BUDGET_FILE),   // "<root>/ledger-budget.json"
  };
}
```

`root = graphDir || <DSH_HOME>/chess-context`（`kifu-persist.mjs:62-65`；`DSH_HOME` 由 `engine.mjs:160-165` 解析，缺省 `~/.dsh`）。

**`ledger-budget.json` 是本插件唯一的跨会话文件**（键集合冻结）：

```json
{ "none": 11, "over-budget": 5, "impossible": 0, "未采集": 0,
  "maxOverBudgetBy": 40, "updatedAt": 1793544076420, "samples": 16 }
```

### 2.9 delta 帧协议（崩溃安全的核心）

- 帧格式：`<baseHash16>\t<checksum31>\t<json>\n`（`kifu-model.mjs:1092` 编码、`:1101` 解码）。
- 写入：`dirty` 三张表（`peekDirty`/`clearDirty`/`deltaFromDirty`，`kifu-model.mjs:975/990/1001`）。
- 读回：`fromJSON` → `decodeDeltaFrames(text, base)` → 逐帧 `applyDelta`；半写帧就地停止并**截断坏尾**，旧 generation 的帧整体忽略。
- **`graph.json` 在回合内落后一回合**（只在 `agent/status idle` 落完整快照，`engine.mjs:351-360`）。任何 `JSON.parse(graph.json)` 当最新的外部脚本都会少一回合。

---

## 3. 压缩一次 fold 的完整生命周期

```
宿主 between-step 压力                 agent/pre-step                     agent/status idle
      │                                    │                                   │
      ▼                                    ▼                                   ▼
compactIfNeeded ── 选范围 ──► super.compactRegion ──► summarize ──► 落账 ──► flush(tree)
  (engine:677)   (planFold)      (官方事务)         (engine:412)  (foldMarks)  (persist:166)
                                                                                   │
                                                              下一次 pre-step ◄────┘
                                                              decideInjection → 重注入
```

| # | 步骤 | 函数 / 文件:行 | 关键事实 |
|---|---|---|---|
| 1 | **触发** | `engine.mjs:677` `compactIfNeeded(agent, trigger, signal)` | `trigger ∈ {pressure, context-overflow}`；官方在自己的 `agent/pre-step` / `agent/request-error` 里调（`docs/DSH-技术测绘.md:152`）。无路由目标 ⇒ `return null`（冷启动） |
| 2 | **预闸** | `engine.mjs:682-686`（tier-2 先跑）、`:695`（`meter.measure`）、`:1002` `resolveSpec`、`:721-731`（增长闸） | 阈值 = `min(窗口×thresholdRatio, 窗口−输出预留−headroom)`；**首折用 `firstFoldRatio`(0.30) 削峰**；`growthFloorTokens` 挡住「刚压完又压」 |
| 3 | **状态回填** | `engine.mjs:736-745`（快照/restore）+ `:1071` `backfillState` | 只有这里 stat 文件算 `worldHash`（贵，所以只 fold 前做）；**失败必须 restore**，否则留下「图被改但 foldCount 没变」 |
| 4 | **选边（选范围）** | `engine.mjs:881` `#selectRange` → `fold-planner.mjs:140` `planFold` → `:105` `nextSeqAfterLastCheckpoint` → `:23` `selectIncrementalRange` | 从「上一个 checkpoint 之后」起压（官方从 surface 头起压 ⇒ ρ^k 几何衰减）；保留尾部 `retainTokens`；两端用 `toolPairingBalancedBefore/After` 兜底，**宁可少压不可切断 tool-call/result**；`null` ⇒ 本次不 fold（reason: empty-surface / checkpoint-at-tail / no-foldable-span） |
| 5 | **压缩** | `engine.mjs:597` `compactRegion`（只设 `_chessActiveRange`）→ 官方事务 → `engine.mjs:412` `summarize` | 事务本体（锁、稳定性校验、`<compacted-summary>` 框定、`surfaceOp: replace`、checkpoint source）**全部继承官方，不重写** |
| 5a | 摘要输入 | `ledger.mjs:1244` `renderFacts(g,{range})` + `facts-prompt.mjs:33` `buildChessInstruction` | 硬事实块按 range 过滤（只列本段失败边），历史由上一个 checkpoint 承载 |
| 5b | 模型调用 | `engine.mjs:490-520` `runStream` | `ctx.llm.stream({provider,model,messages,toolHistory,maxTokens,purpose:"compaction",sessionId})` |
| 5c | 降级链 | `engine.mjs:534-580` | 配置模型 → 当前路由重试一次 → **规则摘要（零模型调用）**。`mode === "rules"` 直接走规则。**压缩永不失败** |
| 5d | 机械追加 | `engine.mjs:585-596` | 模型输出后**机械 push**「约束（逐字）」段；再 push「最近访问的文件」（`touched-files.mjs:155`）。模型无权丢掉它们 |
| 6 | **落账** | `engine.mjs:775-860` | `foldThrash`/`lastFoldSeq`/`foldCount++`/`lastFoldTotalTokens`；`checkpointSeq = checkpointSeqs(session).at(-1)`（**checkpoint 消息的 seq，不是被遮蔽区间起点**）；`measureFoldQuality`（`:804`）→ `foldMarks.push`（`:828`）→ 裁到 20 条 → `this.#flush(session,{tree:true})`（`:860`） |
| 6b | tier-2 | `engine.mjs:902/914` | checkpoint 数 ≥ `tier2After` 时，把**最老两条**合并成一条，零信息损失（事实从图重建）；`_tier2InFlight` 防重入，**不递归** |
| 6c | 手动 `/compact` | `engine.mjs:618` `compactNow` → `:645` `recordFoldMark` | 官方 `/compact` 只走 `compactNow → compactRegion`，**不经过 `compactIfNeeded`** ⇒ 记账要单独接；`busy` 错误只做人话化，不改 `code/name/cause/stack` |
| 7 | **重注入** | `engine.mjs:365` `#bindLedger` → `hot-inject.mjs:174` `decideInjection` → `ledger.mjs:685` `renderLedger` | 六条契约：①surface 只留一条（replace）②digest 只算骨架 ③限流 40 事件 / +5 失败边 ④内容一字不差就不动 ⑤替换锚点失效 ⇒ 退回 append ⑥被 fold 遮蔽且同源 ⇒ **绕过限流**立刻补回。**全部吞错返回原 decision** |

**失败路径（同等重要）**：fold 抛错 ⇒ `restore()` 恢复图快照 + `st.foldFailures += 1` + `st.lastFoldError` ⇒ 热清单首行出现 `⚠ CONTEXT COMPRESSION IS FAILING (n consecutive folds failed …)`（`hot-inject.mjs:86-97`）。告警**不走限流**。

**写盘时机（与新项目「禁止在 `session/event` 里 append」的规则对照，重要）**：GOkifu 在 `session/event` 里**只改内存**（`observeEvent` 同步、零 IO、不碰 session），真正的落盘是 `#scheduleFlush` 的 **1.2s debounce `setTimeout`**（`engine.mjs:324-335`，`timer.unref()`），外加**一个 durable 提交点**：`agent/status === "idle"` ⇒ `#flush(session,{full:true})`（`engine.mjs:351-360`）。⇒ **它与「禁止在 `session/event` 广播里 append」并不冲突**：没有 append，写发生在事件之外。这条纪律值得原样继承。

**三个 draw 点之间的时序**：`session/event`（内存图增长）→ 1.2s 后 `flush`（delta 追加）→ `agent/status idle`（完整基线快照）→ `agent/pre-step`（读图渲染热清单）。**没有一处是同步读盘**（`#graph()` 有内存缓存，miss 才 `load` 一次）。

---

## 4. 持久化现状（新项目最该先读的一节）

### 4.1 会话结束后棋谱还在吗？——**在，永久在，没人删**

| 问题 | 答案 | 证据 |
|---|---|---|
| 存在哪 | `<DSH_HOME>/chess-context/sessions/<safeSessionId>/{graph.json, graph.json.delta.jsonl, index.md, nodes/*.md}` | `kifu-persist.mjs:68-79` |
| 键是什么 | 目录名 = `safeSessionId(id)` = 非 `[A-Za-z0-9._-]` → `_`，截 120 字符 | `kifu-persist.mjs:57-59` |
| 有没有 TTL / 清理 / 归档 | **没有**。没有任何删除路径 | 全库无 `rm`/`unlink` 到 sessions 的调用 |
| 会话结束钩子 | **没接**。`forget(id)` 存在但注释写明「将来 `session/disposed` 的唯一清理点；本次**不接**」 | `kifu-persist.mjs:282-288` |
| 重启后能读回吗 | 能。`#graph()` 缓存 miss ⇒ `persist.load()` ⇒ `fromJSON` + delta 重放 + 坏尾截断 | `engine.mjs:253-265` |
| 读不出怎么办 | 不静默建空图：返回 `{repaired:true, repairedReason}`，engine 打一条 warn | `kifu-persist.mjs:155-159` |

live 实测（2026-11-02 01:2x，`D:\DeepSeek Harness\home\chess-context\sessions`）：**11 个会话目录**，其中 3 个 `foldCount=1`、1 个 195 边、1 个 155 边、1 个 119 边；其余是只跑了几步的小图。最大图 178 节点 / 195 边。

### 4.2 有跨会话能力吗？——**没有。这是被明确写进「非目标」和「越权红线」的**

代码层证据（三处 grep，全部为空或只读）：
- **热路径零跨会话**：`src/rooms/*.mjs` 内**没有任何**函数读别的 session 的图。`#graph(session)` 只按 `session.id` 取自己的目录。
- **唯一的跨会话状态**是内存计数器 `this.ledgerBudget`（`engine.mjs:191`，注释就写着「跨会话累计」），落盘成 `<root>/ledger-budget.json`。它的消费者只有 `doctor` 与 `/gokifu/api` 的展示，**不回流进任何注入内容**。
- **只读扫描**（不进压缩决策）：`scripts/doctor.mjs:228-270`（遍历 `sessions/*/graph.json` 收集 foldMarks 与健康度）、`scripts/handoff-check.mjs`（对每张 live 图渲染一次查七项）、`test/verify-graphs.mjs`、`src/rooms/migrate.mjs`（R14，显式 CLI，默认 dry-run）。

制度层证据（原文）：
- `docs/方案-持续优化.md:26` —— **「**非目标**：不做 2.x 版本号冲刺、不做可视化编辑器、不做跨会话全局失败库（先把单会话做强）。」**
- `docs/压缩的职责边界.md:43` —— ❌ 不属于压缩：「**跨会话记忆 / 知识库** … 不许把本次棋谱写进跨会话库、不许做"从历史会话检索"、不许把 Hindsight/向量库接进来当压缩」。
- `docs/草稿-持续优化.md:164-168` —— 「**设想 X · 跨会话全局失败库** … 状态：**候选（先证明单会话失败记忆有效，再谈跨会话）**」；代价写明「不同项目的失败原因不可迁移，容易污染；隐私边界模糊」。
- `docs/架构-房间契约.md:582`（§6 已否决方案 #10）—— 「per-session 状态换成 `ctx.sessions` 全局索引 … **什么条件下重新变得可行：需要跨会话统计（如全局失败边排行）**」。同表 #1：拆多包（`-kifu`/`-engine`/`-ui`）的复活条件是「**第三方要单独复用 R00/R06** 的真实需求」。

⇒ **新项目正好踩在这两个「复活条件」上**：它既需要跨会话聚合，也要单独复用 R00（数据层）+ R01（落盘）。这属于「按既有文档的判据，条件已成立」，不是越界 —— 但要显式声明（GOkifu 那边的红线是对**压缩**说的，新项目是**记忆系统**，两者是不同机制）。

### 4.3 有没有任何「长期记忆 / 知识库」相关代码或 TODO？

- **代码**：零。`src/` + `lib/` + `scripts/` 全库 grep `长期记忆|知识库|memory|embedding|vector` 无命中（除 `hindsight` 出现在 `verify.mjs` 的 `LOCAL_MUTATE_TOOLS` 白名单里 —— 那是「哪些工具会改本地状态」的判定表，不是记忆功能）。
- **TODO/FIXME/XXX**：`src/` `lib/` `scripts/` **一个都没有**。本仓不用 TODO 管理未完成项，用 `计划表.md` + task 编号。
- 唯一的「记忆相关」痕迹在 `docs/research/`（调研）：`03-human-memory.md`、`04-memory-systems.md`、`05-agi-memory-architectures.md` —— 结论是「指针 + 分层」，被引用的落地只有两条：`foldMarks` 的「可寻址闭包」（C24）与 TRACE 行。

---

## 5. 重注入契约在代码里怎么落地（七项逐个对位）

契约原文：`docs/压缩的重注入契约.md` §1（判据：**摘要可能丢、可能被改写、可能被降级裁掉的东西，必须在每一步重新灌进上下文**）。

| # | 项目 | 渲染位置（热清单 `renderLedger`） | 写入侧 | 机器判据 |
|---|---|---|---|---|
| ① | **根目标**（用户最初要什么，逐字） | `ledger.mjs:870` `ROOT USER (verbatim): ${clip(root.text, L0?900:L1?500:L2?300:168)}` | `graph.rootUserNodeIds[0]` | `ledger-boundary.test.mjs` #4；`handoff-check` ① |
| ② | **约束**（逐字） | `ledger.mjs:875` `CONSTRAINTS (verbatim):` + `collectConstraints()`（`:1230`，按 user 节点 order 去重） | user 节点 `constraints` | #4；`handoff-check` ② |
| ③ | **失败边**（意图 + 原因原文 + 证据 seq） | `ledger.mjs:902` `LEARNED (N failed attempts):`，行由 `renderFailureLine()`（`:409`）生成；**任何降级档位都不砍 seq** | `failureEdges(g)`（`kifu-model.mjs:253`）+ `classifyDangling` 过滤 residue | #4 + A；`handoff-check` ③ |
| ④ | **未落地的选项** | `ledger.mjs:938` `OPTIONS (not yet landed):`；L2+ 至少一行计数（`:943`） | `isDanglingOption()`（`:77`）= `untested && to==null` 且 (新鲜或陈旧) | #4 + D；`handoff-check` ④ |
| ⑤ | **未验证声明** | `ledger.mjs:947` `UNVERIFIED (ran, but no external signal…):`；L2+ 必有 `UNVERIFIED: N unproven (latest eN)`（`:954`） | `openEdges()` 去掉 residue 与 option | #4 + A；`handoff-check` ⑤ |
| ⑥ | **当前路径 / 工作位置** | `ledger.mjs:496-497` 的 `CURRENT PATH:` / `WORKING:`，经 `fitPaths()`（`:511-600`）按档位折叠；**L3+ 退化也必须留一行 `# path:`** | `currentPath()`（`kifu-model.mjs:310`）+ `latestAgentNode` + 强/弱 success 锚点 | #4；`handoff-check` ⑥ |
| ⑦ | **出处**（seq / edge id） | `seqSpan(edge)`（`ledger.mjs:307`）拼进每条失败边行；`provenanceCoverageOf`（`:633`）度量覆盖率 | 边的 `evidence` | #4 + A + I；`handoff-check` ⑦（覆盖率必须 = 1） |

**摘要侧的同源事实**：`renderFacts(g,{range})`（`ledger.mjs:1244`）输出 `ROOT_USER_REQUEST_VERBATIM` / `CONSTRAINTS_VERBATIM` / `FAILED_ATTEMPTS`（带 `evidence=seq a-b`）/ `OPTIONS` / `UNVERIFIED_CLAIMS` / `DANGLING_RESIDUE` / `FROM_DANGLING` / `CURRENT_PATH` / `CURRENT_STATE_KEY` —— 与热清单**同一份图、两套渲染**，这是「摘要与热清单不会各说各话」的原因。

**三层墓碑**：
1. `test/ledger-boundary.test.mjs` #4 —— 构造同时含七项的图，逐项断言出现在 `renderLedger().text`（**用内容断言，不用标题措辞**：改标题不会误红，删信息一定红）。本次实测 12/0。
2. `scripts/handoff-check.mjs` —— 对 **live 每一张图**渲染一次，判 ⑫ 项（①②③④⑤⑥⑦ + ⑧省略行可解析 + ⑨预算 + ⑩保真度 + ⑪幻觉探针 + ⑫触发原因）。它第一次跑 live 就抓出 3 个真缺口（⑤在 L2+ 静默消失等）。
3. `docs/压缩的重注入契约.md` §3 —— **明确不在这张表里的东西**：工具定义/用法、AGENTS 规则本身、persona、跨会话记忆/知识库条目、「下一步该做什么」。**这一栏就是新项目的接管点。**

---

## 6. 边界审计机制（boundary-audit）与越权红线

### 6.1 判据（成文法，`docs/压缩的职责边界.md` §1）

> **一段内容属于「压缩」，当且仅当它同时满足两条**：① 它**产自本次会话的历史**（不是产品自带的知识、不是通用规则、不是工具契约）；② 它**只在压缩生命周期里出现**（决策压什么 / 执行压缩 / 呈现压缩产物），不常驻、不解释世界。

§2 的 ❌ 清单就是红线表：AGENTS 规则、persona/系统提示词、tools 定义与治理（`permission: allow|ask|deny` / approval / sandbox）、跨会话记忆/知识库、上下文工程（挑哪些文件进窗口）、提示压缩、UI/展示。三条长期风险点：热清单膨胀（不许写「下一步应该」）、摘要指令膨胀（摘要模型只做降维与保真，不做规划）、restore 能力（只能给**寻址事实**，不能教模型何时用）。

### 6.2 机器审计怎么防越权（`scripts/boundary-audit.mjs`）

```js
// scripts/boundary-audit.mjs:32-45
export const RULES = [
  { id: "behavior-guidance", level: "error",
    why: "压缩产物不得包含行动指导（属于 AGENTS / persona）",
    re: /(下一步\s*[:：]|不要重试|建议你|建议先|务必先|请先执行|you should|you must|you may\b|continue or abandon|tell the user|the next action)/i },
  { id: "tool-governance", level: "error",
    why: "工具契约 / 权限治理属于宿主与工具层，压缩不得自建",
    re: /(permission\s*:\s*(?:allow|ask|deny)|approval\s*:|sandbox_permissions|tool_schema\s*:)/i },
];
```

四个实现要点（每一条都踩过）：
1. **只扫字符串字面量**（`stringLiterals`，`:75`）—— 代码标识符如 `state.permission` 不算。
2. **先剥注释再扫**（`stripComments`，`:69`）—— 注释里大量引用「旧版曾写：不要重试…」用于说明为什么删掉它，算进去就天天假红。
3. **豁免清单要写理由**（`ALLOW`，`:52-58`）：目前只有一条 —— `src/rooms/facts-prompt.mjs` 是**喂给摘要模型的指令模板**（不注入主 agent），它约束「怎么压缩」，不是「agent 该做什么」。
4. **退出码 = 有 error 即 1**，可直接进门禁。

**本次实测**：`node scripts/boundary-audit.mjs` → 扫 17 个 `src/**/*.mjs` · 豁免 1 条 · **越界线索 0 条 · exit 0**。`docs/压缩的职责边界.md` §3 的结论同此：「当前代码没有已确认的越权项」。

**本轮清掉的 4 处实际越权**（`docs/工程教训集.md:89-96`）：摘要骨架的「下一步」、`ruleSummary` 的行进指令、`foldFailureWarning` 的「告诉用户」、`OPTIONS` 的 `you may continue or abandon`。

---

## 7. 可复用的「记账」抽象（ledger API 面）

### 7.1 包导出面（作者已经把它当复用接口暴露了）

```json
// package.json:12-24
"exports": {
  ".":        "./src/ui.mjs",
  "./engine": "./src/engine.mjs",
  "./client": "./lib/client.js",
  "./graph":  "./src/rooms/kifu-model.mjs",   // ← 纯数据层，可直接被新项目复用
  "./persist":"./src/rooms/kifu-persist.mjs"  // ← 落盘层，注入 fs port，可直接复用
}
```

### 7.2 `kifu-model.mjs`（43 个命名导出，零依赖，仅 `node:crypto`）—— **通用，优先复用**

| 组 | 函数（签名要点） | 复用性 |
|---|---|---|
| 模型 | `createGraph({sessionId,cwd})` · `addUserNode(g,{seq,turn,text,constraints})→id` · `addAgentNode(g,{seq,turn,goal,worldHash,constraintHash,via})→{id,transposition}` · `addEdge(g,{from,intent,action,evidence})→id` · `settleEdge(g,edgeId,{to,result,verify,errorSnippet,weak})→edge` · `mergeNodeInto(g,fromId,intoId)→string[]` | ✅ 全通用 |
| 查询 | `failureEdges(g)` · `openEdges(g)` · `currentPath(g,nodeId)` · `latestAgentNode(g)` · `tewariAnalysis(g,edge)` · `failureClass(edge,tewari)` · `graphRevision(g)` | 🟡 前四个通用，后三个是棋谱语义 |
| 渲染 | `renderMd` · `renderNodeMd` · `renderIndexMd` · `renderIndexAppend(g,dirty,label)` | ✅ 通用（三层树） |
| delta | `markNodeDirty/markEdgeDirty/markNodeDeleted/markOrderAppend` · `peekDirty/clearDirty` · `deltaFromDirty` · `applyDelta` · `rebuildStateIndex` · `checksum31` · `encodeDeltaFrame/decodeDeltaFrames` | ✅ **完全通用**（这是本项目最值钱的一块） |
| 校验 | `validate(g)→string[]`（不变量：from/to 悬空、失败边无原因、weak 挂错、order 引用不存在、user 原话为空、agent 缺哈希）· `graphHealth(g)` | ✅ 通用 |
| 工具 | `sha` · `norm` · `hashSet` · `hashText` · `extractConstraints` · `foldClosureOf(graph,range)` | ✅ 通用 |

### 7.3 `kifu-persist.mjs`（10 个导出）—— **通用，契约清晰**

```js
graphRoot({graphDir, dshHome}) → string
sessionPaths(root, sessionId) → {dir, graphFile, deltaFile, indexFile, nodesDir, budgetFile}
createFsPort(fs?) → {readFileSync, writeFileSync, appendFileSync, renameSync, statSync, existsSync, mkdirSync, rmSync}
createPersistStore({port, root, onWarn(level,line), onStep?}) → store
store.load({id,cwd}) → {graph, baseHash, repaired, repairedReason, truncatedFrames}
store.flush({id,cwd}, graph, {tree=false, full=false}) → {ok:true, baseHash, wroteBaseline, wroteDelta} | {ok:false, error, dirtyKept:true}
store.persistBudget(stats) → {ok, error?}          // 原子写 <root>/ledger-budget.json
store.forget(id) → void                            // 三张按会话表清理
```

**写序是崩溃安全契约，不可乱**（`kifu-persist.mjs:54` 的 `_ORDER`）：

```js
export const _ORDER = ["index", "nodes", "graphTmp", "rename", "delta", "clearDirty"];
// index.md（全量或追加，>256KB 才全量）→ nodes/*.md → graph.json.tmp → rename（提交点）
// → delta 清空或追加 → clearDirty
```

两条行为契约（A2-2 定稿，与旧版**不同**）：`load` 不静默建空图（返回 `repaired + reason`）；`flush` 失败**不清 dirty**（`{ok:false, dirtyKept:true}`），下次连这一轮一起写。

### 7.4 通用 vs 压缩专用（给新项目的取舍表）

| 抽象 | 位置 | 判定 |
|---|---|---|
| DAG 模型 + 三态结算 + 置换合并 | `kifu-model.mjs` | ✅ **直接复用**（新项目的「节点/边」就是它） |
| delta 帧 + 三层树 + 崩溃安全写序 | `kifu-model.mjs` + `kifu-persist.mjs` | ✅ **直接复用**（巨型棋谱最需要的正是增量落盘） |
| 不变量校验 / 健康度 | `validate` / `graphHealth` | ✅ 复用，且应扩展（跨会话引用完整性是新不变量） |
| 事件 → 图（keeper） | `keeper.mjs` `observeEvent` | 🟡 **半复用**：`step/end` 建状态节点、`tool/result` 结算这两段通用；`HUMAN_SOURCES` 过滤与「意图句抽取」是棋谱语义 |
| 工具结果 → 三态 | `verify.mjs` `classify({tool,text,isError})` | ✅ 复用（唯一判据集中的判据表，`verify.mjs:102-148`） |
| 世界状态哈希 | `world.mjs` `createWorldTracker` | ✅ 复用（但新项目若要跨会话，哈希口径必须先定，见 §9-5） |
| 热清单渲染 | `ledger.mjs` `renderLedger/renderMinimalLedger/renderFacts` | ❌ **压缩专用**（六档降级、500 token 预算、失败边语义） |
| 悬空边五类分类 | `ledger.mjs` `classifyDangling` | 🟡 判据可复用（residue / candidate / live-unsettled / from-broken / none），阈值 10min 是压缩语境 |
| fold 范围选择 | `fold-planner.mjs` `planFold` | ❌ 压缩专用（checkpoint / surface / token 预算） |
| 每步注入 | `hot-inject.mjs` `decideInjection` | ❌ 压缩专用（限流 / digest / replace 锚点） |
| 保真度指标 | `fold-quality.mjs` `measureFoldQuality({graph,range,summaryText,modelText,summaryTokens,shadowedTokens})→{constraintRecall,failureRecall,compressionRatio,missingConstraints,missingFailures,modelConstraintRecall,unknownIds}` | 🟡 **思路复用**（「丢一条约束=任务变了、丢一条失败边=必然重踩」的判据对新项目同样成立） |
| 预算记账 | `engine.mjs` `accumulateLedgerBudget` / `ledgerBudgetMetrics` | ✅ 模式复用（纯函数 + 三态 fallback + 原子落盘） |

---

## 8. 测试与质量门禁

### 8.1 组织方式

- **零依赖自研 runner**：`test/run.mjs`（137 行）。每个 `*.test.mjs` 导出 `tests` 对象，键 = 用例名、值 = `(t) => …`。断言走 `t.eq/t.ok/…`。
- 汇总行固定：`== <passed> passed, <skipped> skipped, <failed> failed ==`
- **两种假绿被堵死**（`test/run.mjs:1-13`）：显式 `t.skip(reason)` 不算 pass；**零断言且无 `throw/assert` 证据 ⇒ 计入 failed**。
- `filter` 是**文件名子串**，不是房间名 —— `ledger` 不命中 `c17`/`markers`/`dangling-exclusion`（`AGENTS.md` §3.2）。
- 规模（本次实测）：**62 个 `*.test.mjs`** + **29 个辅助脚本**（`real-*` / `bench` / `verify-*` / `fixtures` / `graph-invariants` 等）。

### 8.2 怎么跑 / 门禁脚本

| 命令 | 用途 | 本次实测 |
|---|---|---|
| `npm test` = `node test/run.mjs` | 全量单测 | **675 passed / 0 skipped / 1 failed**（见 8.3） |
| `node test/run.mjs rooms` | **架构方向门禁**（R-A…R-F + 顶层白名单 + DELETED_FACADES） | **15/0** ✅ |
| `node test/run.mjs boundary-audit` / `node scripts/boundary-audit.mjs` | 越权审计 | **0 条 / exit 0** ✅ |
| `node test/run.mjs ledger-boundary` | 七项重注入墓碑测试 | **12/0** ✅ |
| `node test/run.mjs engine-harness` | 端到端（假宿主） | **49/0** ✅ |
| `node test/verify-install.mjs` | 挂载校验（18 项，含运行期证据） | 未跑（依赖 live profile，非只读面） |
| `node scripts/check-maintenance.mjs` | 维护门禁（tag/CHANGELOG/版本跳号） | 未跑（git 状态非干净，会红） |
| `node scripts/docs-index-check.mjs` | 新增文档必须被索引 | 未跑 |
| `node scripts/handoff-check.mjs` | live 每张图跑七项 + ⑫ 项 | 未跑 |
| `node test/bench.mjs 2000` | 性能基准 | 未跑（会重写 `evidence/bench-2000.json`，属「改文件」） |

**我没跑的**：`install` / `release` / `verify-release` / `p6c-preflight` / `make-presets-override` —— 它们会改 profile 或发布，违反只读纪律。

### 8.3 当前是否全绿：**不是，但红的不是产品缺陷**

| 次 | 结果 | 红的那条 |
|---|---|---|
| 第 1 次全量 | 675 / 0 skipped / **1 failed** | `engine-harness.test.mjs` P2-2-4 `doctor：显示最近 5 次 fold…`（「必须点名丢失的约束，实际 undefined」） |
| 第 2 次全量 | 675 / 0 skipped / **1 failed** | `tier2.test.mjs` T2-5 `auto 路径应产生 1 条 tier2 记录，实际 2` |
| 单文件复跑 | 全绿 | `engine-harness` **49/0**；`tier2` **7/0** |

**判读（有依据，不是猜测）**：两次红的**不是同一条**、且各自单跑全绿 ⇒ 共享夹具并发污染。这正是 `docs/工程教训集.md:58-65` 记的既有坑：

> 「**5. 两个会话同时跑 `node test/run.mjs` 会假红** —— 共用 `test/.harness/graphs`，典型症状是 `T2-5 ... 应产生 1 条 tier2 记录，实际 2`。**判据**：看到 T2-5 / tier2 之类**偶发**红，先做两步验证再审代码：1. 单独跑那个文件；2. `tasklist | grep -c node.exe` 看有没有别的会话在跑。」

且 `git status` 显示 `test/tier2.test.mjs`、`test/engine-harness.test.mjs` 正被另一个会话修改。⇒ **结论：全量门禁在「独占 + 干净树」下应为 675/0；本次观测到的 1 红是并发假红，不计为已知缺陷，但也不谎报为全绿。**

---

## 9. 工程教训：对新项目最有约束力的 10 条（原文引用）

> 来源：`AGENTS.md` §7（已知陷阱 TOP 10）、`AGENTS.md` §5（引用纪律）、`docs/工程教训集.md`。全部逐字引用。

**① 文档 = 发布物**
> 「**`README.md` 改了 = 包改了**（npm 强制包含，即使不在 `files`）⇒ 1.9.2 因 `README:3` 漏改版本号被迫发 1.9.3；**已加门禁 A0（`README` 版本行 == `package.json` version）**。」（`AGENTS.md` §7-1）

**② 数字必须带时点 + 树**
> 「每个数字都带**时点 + 树**（发布树 / 工作树 / 某 commit）。**跨批不可比**。」
> 「计数/比例必须自带 **定义式 + 分子 + 分母 + 时点**，缺一维视为不可引用。」（`AGENTS.md` §5）

**③ 增量落盘 ⇒ 读的人必须知道这是增量结构**
> 「**`graph.json` 落后一回合**（增量落盘）⇒ 外部工具直接 `JSON.parse` 当最新会少一回合。」（`AGENTS.md` §7-5）

**④ 运行中的插件会覆盖磁盘清理**
> 「**运行中插件会覆盖磁盘清理**（内存 flush 回升）⇒ 任何数据清理必须停插件窗口。」（`AGENTS.md` §7-6）

**⑤ 两个入口 = 两套事实（同一条规则也适用于「一个新子系统」）**
> 「**恢复旧门面必须变红** … **原因**：门面一复活，同一份实现就有了两个入口，「哪个才是真的」立刻无人能答 —— 这正是 A3 全部工作的意义。**新增房间同理：`src/rooms/` 下多一个未登记文件，C3 就必须红。**」（`AGENTS.md` §7-9）

**⑥ 每个新模块必须登记 + 有墓碑测试**
> 「在 `test/rooms.test.mjs` 的 `ROOMS` 表登记，并**至少加一条方向断言**（它只能依赖谁）。加测试文件 + 一条**墓碑测试**（删掉这个房间的某个能力必须变红）。」（`AGENTS.md` §4.1）

**⑦ 指标本身也要被验证**
> 「**判据**：新指标落地时，必须用一个**已知答案的输入**跑一遍对照（空摘要 ⇒ recall 0；全文摘要 ⇒ recall 1）。只跑「有值」不算验证。」（`工程教训集.md` §1）

**⑧ 没有消费者的指标不许进代码**
> 「**判据**：提 PR 前问一句「**谁读它**」。答案必须是 `doctor` / `ledger-budget.json` / `graph.json` / 某个断言，不能是"以后可能用"。」（`工程教训集.md` §2）

**⑨ 分清「链路真」与「数字真」**
> 「**判据**：任何"验证通过"的结论，都要写清**它证明了什么、没证明什么**。否则下一个人会把它当作生产指标引用。」（`工程教训集.md` §7）

**⑩ 边界争议写文档，不用代码「顺手实现」**
> 「**判据**：新增任何注入到模型上下文的内容前，过 `docs/压缩的职责边界.md` 的五问自检；答不上就写进该文档的「边界争议」小节，**不写代码**。」（`工程教训集.md` §8）

**另外三条对新项目直接适用（补充，不算在 10 条内）**：

- 「**判据**：写"做不到"之前，先分类：**架构限制**（改不了）→ 才可以写"不能"；**实现没写完** → 只能说"当前没做"，不能说"不能做"。」（`工程教训集.md` §3）
- 「**判据**：看到 T2-5 / tier2 之类**偶发**红，先做两步验证再审代码」（`工程教训集.md` §5）—— 即本次 8.3 的处理方式。
- 「**判据**：动手之前先花 5 分钟量一下。**测量比论证便宜得多**。」（`工程教训集.md` §6）
- 迁移/清理的硬纪律：「**禁止 engine 启动钩子**。迁移必须是**独立房间 R14 + 显式 CLI**，默认 `--dry-run`，`--apply` 需主人授权 + 停插件窗口」+「**120s 新鲜度守卫**：`--apply` 前扫会话目录，任一 `graph.json` 的 `mtime` 距 `now` 绝对值 < 120s ⇒ 拒绝」。**新项目若要回填/迁移跨会话索引，这两条应原样继承。**

---

## 附 · 给「巨型棋谱（单会话棋谱为节点）」的 6 条直接结论

1. **可复用的最小内核**：`kifu-model.mjs`（DAG 模型 + 三态 + 置换 + delta + 三层树渲染 + validate）+ `kifu-persist.mjs`（`createPersistStore` / `sessionPaths` / `_ORDER` 写序）。两者都**零 DSH 依赖**，包 exports 已经暴露为 `dsh-gokifu-compact/graph` 与 `/persist`。
2. **「节点 = 一个会话」需要新字段**：现有 agent 节点的 `worldHash`/`constraintHash`/`via` 语义是「一步的状态」，跨会话聚合时必须新增节点 kind（不要复用 `agent`），否则 `latestAgentNode` / `currentPath` / `tewariAnalysis` 全部会误判。现有 `validate` 的第 6 条不变量（agent 缺哈希即问题）会立刻挡路 —— 这是好事。
3. **`stateIndex` 是派生数据**：加载时无条件重建（`fromJSON`，`kifu-model.mjs:390-404`）。跨会话索引应当照抄这个模式（索引可丢、可从权威数据重建），而不是把索引当权威。
4. **持久化的既有范式**：基线快照 + 增量帧 + `baseHash` generation + `checksum31` + 坏尾截断。跨会话图如果要「常驻 + 高频小改」，直接沿用，不要另发明。
5. **跨会话的哈希口径必须先定**：`worldHash` 由「本会话触碰过的文件 stat」算（`world.mjs`），跨会话不可比。要么全局统一 cwd 口径，要么在巨型棋谱里改用「会话级指纹」（如 `sessionId + 结束时刻 + 根目标哈希`）。
6. **不要在 GOkifu 里加跨会话代码**：它是被明文排除的（§4.2 三处原文），且上游是**只读**的（本项目 `AGENTS.md` §2.5）。新项目独立成插件、独立目录、独立 graph root（`<DSH_HOME>/memory-context/`，见本项目 AGENTS §4.4），只**单向 import** 它的 `graph`/`persist` 导出面 —— 这样 GOkifu 的 `rooms` 门禁（R-A…R-F）与 boundary-audit 都不受影响。

### 附2 · 与「棋院」v0 数据契约（`AGENTS.md` §4）的字段对位

| 棋院 v0 字段 | GOkifu 对应物 | 复用建议 |
|---|---|---|
| `episode.id = "ep-<sid8>"` | 会话目录名（`safeSessionId`） | 直接用，但**别**把会话 id 当节点 id（GOkifu 的 `n<seq>` 是会话内序号，跨会话会撞） |
| `episode.closure.{graphPath,seqFrom,seqTo,nodeIds,edgeIds}` | `foldMarks[].closure`（`foldClosureOf`，`kifu-model.mjs:274-303`）+ `checkpointSeq` | **同一个抽象**：GOkifu 记「这次 fold 覆盖了哪些节点/边」（只存计数 + 首尾 id，避免 graph.json 膨胀）。episode 级闭包需要**全量 id 列表**，是全量而非计数 —— 这是唯一必须偏离的地方 |
| `episode.signals.{failures,successes,unsettled,constraints,tools}` | `failureEdges(g).length` / `success` 边数 / `danglingStats(g)` 四元组 / `collectConstraints(g)` / `action` 里的工具名 | 全部有现成函数，零改动 |
| `episode.l0/l1` | 无对应（GOkifu 只有 `renderMd` 全量渲染） | 新写；但 **l0 必须从 l1 派生**（不允许两次模型生成，否则自证污染） |
| `claim.support[].{nodeId,edgeId,seq,quote}` | 边的 `evidence.{start,end}` + `errorSnippet`/`intent` | `quote` 可直接落在 `errorSnippet` 上（≤600 字，可定位） |
| `claim.state` 六态 | 边的四态（`untested/success/failure/unverified`）+ 悬空五类 | **不要合并两套状态机**：边状态描述「一次尝试」，claim 状态描述「一条知识的置信度」 |
| `meta edge.kind`（6 种） | `edge.transposition`（置换）+ `mergeNodeInto` | 只有 `contradicts/supersedes` 的精神可借；GOkifu 的 `transposition` 是「同一状态被另一条路到达」，语义不同 |
| `memoryGraph.version` + 拒绝语义 | `GRAPH_VERSION=1` + `fromJSON` 抛 `unsupported version` | **原样照抄**（含「不许静默降级」） |
| 增量协议（基线 + delta + 帧校验） | `_ORDER` + `encodeDeltaFrame`/`decodeDeltaFrames`/`applyDelta` | **原样照抄**，含 `baseHash16` generation 保护与坏尾截断 |

---

## 附3 · 本次测绘读过的文件（可复现）

- **文档**：`AGENTS.md`(393)·`README.md`(239)·`QUICKSTART.md`(1-80)·`docs/方案-持续优化.md`(§一-§三 + 全 heading)·`docs/最终报告.md`(全)·`docs/现状审计-2026-10-29.md`(§一/二/四/六/七)·`docs/工程教训集.md`(全)·`docs/三层树设计.md`(全)·`docs/架构-房间契约.md`(§2.3 R00-R06/§2.6/§2.7/§2.8/§6)·`docs/压缩质量-现有观测盘点与缺口.md`(1-100)·`docs/压缩的重注入契约.md`(§1-§5)·`docs/压缩的职责边界.md`(§1-§4)·`docs/草稿-持续优化.md`(设想X/Y/Z)·`docs/DSH-技术测绘.md`(§1.2-§1.4)。
- **源码**：`src/engine.mjs`(逐段)·`src/rooms/kifu-model.mjs`(1-540 + 全 export)·`src/rooms/kifu-persist.mjs`(**全**)·`src/rooms/hot-inject.mjs`(**全**)·`src/rooms/keeper.mjs`(**全**)·`src/rooms/fold-planner.mjs`(1-215)·`src/rooms/ledger.mjs`(export + 55-110/685-800/1040-1170/1244-1356)·`src/rooms/fold-quality.mjs`(1-135)·`src/rooms/verify.mjs`(1-45/277-300)·`src/rooms/world.mjs`(1-45)·`src/rooms/config-schema.mjs`(SCHEMA)·`src/.harness-stubs/stub-basic.mjs`。
- **脚本/测试**：`scripts/boundary-audit.mjs`(**全**)·`scripts/handoff-check.mjs`(1-50)·`scripts/doctor.mjs`(215-270)·`scripts/check-maintenance.mjs`(1-40)·`scripts/docs-index-check.mjs`(1-30)·`test/run.mjs`(**全**)·`test/graph-invariants.mjs`(1-60)·62 个 `*.test.mjs` 清单。
- **实机**：`D:\DeepSeek Harness\home\chess-context\`（11 会话 + `ledger-budget.json`）、`session-d70b7c2f…/graph.json` 的 foldMark/node/edge 实样。
