# 棋院 · 项目手册（AGENTS.md）

> **这份文件写给「下一个接手的 agent」**。它不说愿景，只说：这是什么、必读什么、规则是什么、怎么查、现在做到哪了。
> **项目方向与终极目标**在 `方案.md`（必读第一）；**职责边界成文法**在 `docs/记忆的职责边界.md`；**已裁定决策**在 `docs/拷问记录.md`；**对标基线**在 `docs/对标-Hindsight.md`。
> 这四个文件 + 本文件，读完即可安全开工。

---

## 0 · 这是什么

**DSH 的长期记忆系统插件（棋院 / Kifu-in）。** 一句话：

> 每局棋（会话）结束后棋谱入馆，**所有相关边与节点连成一张网**（棋谱↔主题、棋谱↔棋谱、节点↔节点）；新会话遇到相关主题时**顺藤摸瓜**跳到相关棋谱/节点，不相关时沉默。先取已付过代价的失败（不重复踩坑），成功经验（定式）只作参考且必须带适用条件。

**它不做**：压缩（那是 `dsh-GOkifu-compact` 的本职）、工具、系统提示词、AGENTS 规则、上下文工程、向量库/RAG。

**四条定调（主人，2026-11-02）**：

1. **判据**：一段内容属于记忆，当且仅当 ① 不产自本次会话 ② 只在记忆生命周期出现。
2. **唯一入口**：**无棋谱不入馆**——外部文档/网页必须由 agent 在会话里读过、嚼碎、压成棋谱后才可能入馆；不提供 `ingest_document` 旁路，不自己联网、不自动扫仓库。
3. **面向模型，不面向人**：记忆卡/索引/线索是给模型读的，人不看懂无所谓；不做人可读知识页。
4. **人不是审批者，是纠错者**：难判的事交多成员独立解析 + 机械共识；人指出错误是最高优先级证据，触发一次纠错反思。

**运行模式（2026-11-02 起）**：**superagent + Team Lead**——私有仓库 `MYCF711/dsh-kifuin`；按 `magpie-plugin-scaffold` 的维护准则（分支→PR→必需检查→合并→release）；**每个功能实现都发版本并写 CHANGELOG；不发 npm**（只发 annotated tag + GitHub Release）。
**最小交付房间**：按"可独立验收的行为"切房间（R00–R15，见 §11），每个房间有 tombstone test；M1 最小集 = R00/R01/R02/R03/R04/R05/R07/R14。
**粉色大象规则**：规则、提示与任务书写**正向做法**（做什么）；禁止项只写进边界成文法且写成"归谁做"。点名"不要想 X"会把注意力钉在 X 上。

**产品目标**：长期记忆 + 长期知识库 + **解决过拟合**。第一验收面 = **不重复踩坑**；成功经验（定式）= 参考面（`preconditions`，排在失败教训之后）；棋书馆 = 关系网不是柜子；本质相关四路分层。**硬约束：至少比 Hindsight 强**（判据见 `docs/对标-Hindsight.md` §2：收益为主判据、负迁移 ≤5% 硬上限）。

---

## 1 · 必读清单（按顺序）

| # | 文件 | 读它回答什么 |
|---|---|---|
| 1 | `方案.md` | 项目是什么、做什么、终极目标怎么验收、里程碑 |
| 2 | `docs/记忆的职责边界.md` | 记忆与压缩/工具/系统提示词/AGENTS 的边界（红线） |
| 3 | `docs/拷问记录.md` | 已裁定决策 + 自裁清单（技术细项自裁，方向问题才问） |
| 4 | 本文件 | 硬规则、数据契约、陷阱、状态 |
| 5 | `docs/对标-Hindsight.md` | 本机 Hindsight 基线实测 + "比它强"的六轴判据 + 擂台协议 |
| 6 | `docs/调研/01-记忆系统调研简报.md` · `02-GOkifu-测绘简报.md` · `03-产品对标简报.md` | 九套系统拆解 / 上游数据模型 / 产品机制核实（按需深读） |
| 7 | 压缩仓（`D:\主工作区\repos\dsh-GOkifu-compact`）的 `docs/research/00/03/04/05`、`docs/压缩的职责边界.md`、`docs/DSH-技术测绘.md` | 上游证据与宿主接缝（不要转述未读内容） |

**状态与逐刀记账**：`计划表.md`（M1 开工时创建，唯一权威）。
**实测证据**：`evidence/`（M1 起）。

---

## 2 · 硬规则（违反即作废，不是建议）

### 2.1 边界（第一条硬规则）

- 只做记忆。**不压缩、不改压缩产物、不新增工具、不改系统提示词、不写 AGENTS 规则、不做上下文工程、不做向量检索。**
- **无棋谱不入馆**：一切入馆内容都必须来自某一局会话；不直读外部文档、不抓网页、不扫仓库。
- 任何注入到模型上下文的文本，必须过 `docs/记忆的职责边界.md` §4 五问 + §5 审计模式。
- 注入内容只能是**事实**：禁止祈使句、禁止"下一步"、禁止行动许可、禁止教模型"何时查记忆/何时 restore"。
- 每条注入必须带 provenance（episode + seq/节点/边）**和日期**（`occurredAt`）；无源不入、无时不入。

### 2.2 DSH 接缝

- **不改 DSH 安装目录**（`D:\DeepSeek Harness\Desktop\resources\`）；只经 profile 通道安装。
- **不写自定义 session 事件**：日志里出现未知事件类型会让会话打不开（fail-closed）。记忆数据一律进 sidecar（`<DSH_HOME>/memory-context/`）。
- **落账只挂可 await 的钩子**：`agent/pre-step`（每步边界，唯一可安全 append 的 durable 写点）、`agent/turn-stopping`（轮次收尾）、`agent/status`（状态）；**禁止在 `session/event` 广播里 append**（重入抛错且被吞成 warn）。
- **运行中不改 `profiles/*/cordis.patch.yml`**：会整树热重载，可能让 host `exit(1)`（压缩仓 2026-11-01 实机事故）。要改配置走设置 UI。
- **禁止重启/关闭 DSH、禁止 `taskkill`、禁止关 magpie**（本机铁律，见 `$DSH_HOME/AGENTS.md`）。

### 2.3 数据纪律

- **只增不改**：任何冲突只加 `supersededBy` + `supersededAtSeq`，不删、不改写既有条目。
- **原件永不删**：记忆只遮蔽可见性，不删除会话日志与棋谱。
- **不写上游**：只读 `graph.json` / 会话日志；不修、不回填、不迁移。
- **禁止从摘要再抽取**：抽取输入只能是原始事件/棋谱边（`<compacted-summary>` / `<chess-fold>` / 任何模型生成摘要一律不可作源）——自证污染。
- **时间戳是一等字段**：每条记忆带 `occurredAt`（事件发生时间）与 `recordedAt`（入馆时间）；**新旧按 `occurredAt` 判，不按入档顺序**；覆盖必须显式 `supersedes`；渲染必须显示日期。
- **sidecar 有版本号与拒绝语义**：不认识的版本必须明确报错，不许静默降级。
- **写盘可崩溃恢复**：append-only + 帧校验 + 幂等（重放两次同结果）。
- **计数不是打分**：只能用可机械统计的计数（支撑局数/反例数/注入数）；禁止模型评分参与晋升、排序、存留。

### 2.4 工程纪律

- **一刀一个 commit**，commit 首行 = 切片 id；不许同一刀里同时改「结构」与「行为」。
- **契约先行**：新增房间/字段先写契约（职责 / 导出 / 输入输出 / 错误语义 / 允许依赖），再写代码。
- **指标先有消费者**：任何指标必须有真实语料消费者，否则会一直算假数。
- **指标本身要被验证**：口径写清分子/分母/时点/树（工作树 vs 发布树），跨时点不可比。
- **不引用未核实数字**：`[外]` 与 `[本]` 分开标；本仓数字带日期；不转述没读过的文献。
- **成本透明**：任何注入改动必须给出 token 前后对照；任何模型调用必须说明次数与失败降级。
- **不留密钥**；不复制 `D:\MyKey\` 内容。

### 2.5 上游依赖

- 压缩仓是**只读上游**：不修改它的任何文件、不 git 操作它；版本不匹配时按只读日志模式降级。
- **复用只走它已暴露的导出面**：`dsh-gokifu-compact/graph`（43 导出、零依赖）与 `dsh-gokifu-compact/persist`（10 导出、fs 可注入）。**不复制源码进来**；不 import 它的 `engine`。
- **引用它的行号前先 `git status`**：上游可能正被另一会话修改（2026-11-02 实测有 9 个已改文件 + 1 个未跟踪）。行号会漂移，只引用"文件 + 函数名 + 大致位置"。
- **上游的"跨会话 = 越界"是对压缩说的**，不是对本项目说的；它的文档自己写明"需要跨会话统计"是复活条件。本项目必须显式声明（`方案.md` §3.5）。

---

## 3 · 怎么跑

**当前阶段：M1 完成（0.2.0）。** 命令：`node scripts/check.mjs`、`node --test`、`node scripts/cli.mjs stats|dump|walk`、`node scripts/release.mjs --dry-run`。M2 起补：`verify`/`rebuild`、边界审计、发布门禁。

当前可用的**只读侦查命令**（均已实测，2026-11-02）：

```bash
# 会话日志（多帧 zstd：首帧只有 header，必须逐帧解或参考 DSH 的 frame scanner）
find "$DSH_HOME/sessions" -name '*.zstd' | wc -l        # 86
find "$DSH_HOME/sessions" -name '*.zstd' -printf '%s %p\n' | sort -rn | head

# 棋谱（基线 + delta；graph.json 落后一回合）
ls "$DSH_HOME/chess-context/sessions"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.keys(j.nodes).length,Object.keys(j.edges).length,j.foldCount)' "$DSH_HOME/chess-context/sessions/<sid>/graph.json"
```

> ⚠ 读 `graph.json` 当"最新"会少一回合：基线 + `graph.json.delta.jsonl` 逐帧 `applyDelta` 才是最新。M1 读侧必须走这条正确读法。
> ⚠ 会话事件包裹层带 `time`（epoch ms，已实测）；棋谱节点/边带 `ts`。两者是 `occurredAt` 的来源。

---

## 4 · 数据契约（v0 草案；实现前先写进 `docs/数据契约.md` 并冻结）

### 4.1 棋谱（episode）

```js
{
  id: "ep-<sid8>", sessionId, scopeKey,
  startedAt, endedAt,           // 会话起止（epoch ms）
  firstEventAt, lastEventAt,    // 事件时间窗 = 该局 occurredAt 的范围
  recordedAt,                   // 入馆时间（第二时钟）
  agentPreset, delegationDepth, // 只收 depth=0；子代理归并到父局
  closure: { logPath, graphPath, seqFrom, seqTo, nodeIds:[], edgeIds:[] },
  l0: "<=256 chars", l1: "<=4000 chars",   // l0 从 l1 派生
  signals: { failures, successes, unsettled, constraints, tools:[] },
  threadIds: ["th-…"],
  state: "archived" | "folded-into:<id>"
}
```

### 4.2 主题节点（topic）

```js
{ id:"t:…", kind:"repo"|"scaffold"|"dependency"|"tool"|"file"|"domain"|"error"|"term"|"goal",
  key:"…", df:<出现该主题的棋谱数>, firstSeenAt, lastSeenAt }
```

机械抽取：deps / import 路径 / 仓库名前缀 / 工具名 / 命令 / 文件路径 / 域名 / 错误码 / 根 user 消息判别性词（IDF、通用词停用）。**禁止模型判断"像不像"**。

### 4.3 相关边（多粒度）

```js
mention = { from:{episode,nodeId?,edgeId?}, topic:"t:…", seq, quote, weight, occurredAt }
link    = { a:{episode,nodeId?}, b:{episode,nodeId?},
            kind:"shared-topic"|"same-error"|"same-file"|"continues"|"user-said"|"shares-joseki",
            topics:["t:…"], why:"…", weight, occurredAt }
```

- 节点↔节点：同一报错原文 / 同一文件+同一错误 / 同一命令+同一失败 ⇒ 直连。
- 棋谱↔棋谱：共享 ≥1 硬主题，或 ≥2 判别性软主题。
- 权重只由机械量决定；每条边必须有 `why`。

### 4.4 线索（thread / 棋书）= 藤的可读视图

```js
{ id:"th-<n>", title:"反代插件卷"|"上下文压缩卷"|…, topics:["t:…"], kifus:["ep-…"],
  parentThreadId|null, state:"open"|"sealed", createdAt }
```

卷是**视图**不是容器：多对多、删卷不删谱、不分类不分柜。

### 4.5 棋书馆（library）

```js
{ version, root:"<DSH_HOME>/memory-context", topics, links, threads, kifus,
  index:"index.md", generatedAt }
```

只组织与索引，不生成内容；索引是派生数据、可重算。

### 4.6 定式（joseki）

```js
{ id:"j-<n>", version:1, title:"…",
  steps:[ { n, action, expect, source:{episode,nodeId,edgeId,seq,quote}, occurredAt } ],  // 每招溯源
  preconditions:[…], assumptions:[…],
  support:["ep-…"], counter:["ep-…"],
  state:"candidate"|"standard"|"deprecated"|"superseded",
  supersedes:"j-<m>"|null, recordedAt, updatedAt }
```

- 准入：≥2 局独立支撑 + 无反例 + 每步有 source + preconditions 可核（Q5 裁定，细则见 `方案.md` §5.1b）。
- 连接：`shares-joseki` 边；每招回指源头节点/边。
- 更新：同条件更优新线 ⇒ `version+1` + `supersedes`；旧版保留。
- 体检：拿对手会话逐招比对 ⇒ 只产出"偏离事实 + 指针"，不产出行动指令。

### 4.7 裁决记录（adjudication）

```js
{ id:"ad-<n>", target:"c-…"|"j-…",
  level:"L2-multi-member"|"L4-human-correction",
  n, votes:[{member:"m-<id>", verdict:"support"|"oppose"|"insufficient", evidence:[{episode,seq,quote}]}],
  agreement:0..1, dissent:[…], decision:"promote"|"hold-disputed"|"invalidate"|"correct", at }
```

- L2 成员独立（不同会话/上下文、互不看输出），结构化票，机械聚合；一致度不足 ⇒ disputed。
- L4 人纠错 = 最高优先级证据；只记 correction + counter，不改写原文。
- 成员不得直接写记忆；只有聚合器落账；可回放。

### 4.8 claim + 关系边

```js
claim = { id:"c-<n>", kind:"fact"|"rule"|"antipattern"|"preference"|"pattern",
  text, scopeKey, threadIds, state:"observed"|"candidate"|"semantic"|"disputed"|"invalidated"|"stale",
  support:[{episode,threadId,nodeId,edgeId,seq,quote}], counter:[…],
  validity:{type:"none"|"file"|"commit"|"version",value},
  preconditions:[{check:"file-exists"|"cmd"|"tool"|"scope"|"step-range", value, why}],
  occurredAt, recordedAt, validFrom?, validTo?,
  counters:{support,counter,injections,lastInjectedAt}, supersedes:"c-<m>"|null }

claimEdge = { id, from:"c-…", to:"c-…"|"ep-…"|"t:…",
  kind:"corroborates"|"contradicts"|"supersedes"|"derives", evidence:[…], at }
```

### 4.9 存储

- 根：`<DSH_HOME>/memory-context/`（sidecar；**不进会话日志**）。
- 结构：`episodes/`、`topics/`、`links/`、`threads/`、`joseki/`、`adjudications/`、`claims/`、`index.md`、`graph.json`（增量协议仿压缩仓）、`journal/`。
- 版本：`memoryGraph.version`；`fromJSON` 对未知版本必须抛错。

---

## 5 · 已知陷阱（部分真踩过，部分是高概率坑）

1. **多帧 zstd**：会话日志是逐帧追加（实测单文件 4,459 帧 / 6.8 MB）；`zstdDecompressSync` 与流式解压都只出首帧（header）。离线读必须逐帧解。
2. **`graph.json` 落后一回合**：必须「基线 + delta 逐帧回放」；直接 `JSON.parse` 当最新会少一回合。
3. **棋谱 `cwd` 不是工作区**：实测多为 `D:\DeepSeek Harness\home\profiles\desktop`；作用域用**会话日志 header 的 `cwd`** 或存储目录名解码。
4. **`session/event` 里 append 会被吞**：重入抛错且被吞成 `logger.warn`——静默丢写。
5. **自定义 session 事件 = 会话打不开**（fail-closed）：记忆数据进 sidecar。
6. **`agent/pre-step` 是 waterfall**：`next()` 取下游默认；返回 `{kind:'enter', messages}` 才替换入步消息。与压缩插件同点注入时，两个替换互不代管。
7. **`README.md` 改了 = 包改了**（npm 强制包含）：版本号必须同步。
8. **文件大小不能判断内容变没变**：版本号 bump 必产生"同尺寸内容变更"；冻结面校验只看 sha256。
9. **时间戳不可靠**：NTFS 时间戳可能比 `Date.now()` 超前几毫秒；判断"新鲜度"用绝对值。
10. **子代理会话不应独立成记忆节点**：`delegationDepth > 0` 的会话是父局的一部分；按父局归并。
11. **不要把"摘要"当源**：任何从模型生成摘要再抽取的路径都是 ρ^k 的移植。
12. **"指标先有消费者"**：压缩仓里 `provenanceCoverage` 先只算不接，一直算假数；`sections` 第一版把字符当 token 算出「失败边占 238%」。
13. **时间戳缺失 = 假记忆**：旧事新录若不按 `occurredAt` 排序，会被当成新事实；覆盖关系必须显式 `supersedes`。
14. **外部文档不进记忆**：只认棋谱入口；"读过"才是"发生过"，没读过的文档不存在于记忆。

---

## 6 · 记账与报告路径（M1 起生效）

| 内容 | 路径 |
|---|---|
| 当前状态 / 逐刀记账 / 基线 / 决策 / 否决 | `计划表.md`（唯一权威） |
| 方案与方向 | `方案.md` |
| 边界成文法 | `docs/记忆的职责边界.md` |
| 裁定记录 | `docs/拷问记录.md` |
| 数据格式契约 | `docs/数据契约.md`（M1 建） |
| 实测证据 | `evidence/` |
| 各工作流报告 | `reports/ws-*/REPORT.md` |
| 临时产物（不进 git） | `tmp/` |

**目录约定（M1 起）**：

```
src/       引擎与规则（纯函数优先）；src/rooms/<id>.mjs = 房间
scripts/   CLI：doctor / dump / build-index / eval / boundary-audit / release
test/      单测（可脱离 DSH 跑）
docs/      契约 / 边界 / 拷问记录 / 对标
evidence/  实测证据
方案.md    项目方向（必读）
AGENTS.md  本文件
```

---

## 7 · 当前状态快照（2026-11-02 · v0.2.0）

| 项 | 状态 |
|---|---|
| 阶段 | **M1 完成**（0.2.0）；M2 建网成线即将开始 |
| 方案 | `方案.md` v0.9；Q1–Q7、Q13 已裁定；Q8–Q12/Q14 自裁；Q16 已由主人拍板"直接开跑" |
| 仓库 | `MYCF711/dsh-kifuin`（私有）；版本 0.2.0；不发 npm |
| 模式 | superagent + Team Lead；每日 09:00 巡检 |
| 边界 | `docs/记忆的职责边界.md` v0.1（判据 + 红线 + 审计 + 接口 + 定式/裁决边界） |
| 对标 | `docs/对标-Hindsight.md`（六轴判据 + 本机基线实测 + 擂台协议） |
| 调研 | `docs/调研/01`（495 行）、`02`（599 行）、`03`（318 行，带 URL） |
| 本机语料 | **90 个会话日志（最大 7.08 MB / 4,607 帧）、15 张棋谱（1,230 节点 / 1,397 边）、24 局独立成谱 + 66 子代理归并、753 主题、194 相关边** `[本] 2026-11-02 03:10` |
| 校验 | `node scripts/check.mjs` PASS；`node --test` 98 条全绿 |
| 上游 | 压缩仓 `dsh-GOkifu-compact` 1.17.0（未发布）；只读；**工作树可能被另一会话修改，引用行号前先 `git status`** |

> **本节是快照，不是实时状态。** 实时状态看 `计划表.md`（M1 建）。

---

## 8 · 拷问协议（2026-11-02 新规）

- **只问方向问题**（目标、定位、验收标准、不可逆取舍、发布/隐私边界）；技术细项**自裁**并记进 `docs/拷问记录.md`「自裁清单」。
- 一次只问一个（主人指令）。问题必须带：影响面、候选答案、默认推荐。
- 主人回答后：写进 `docs/拷问记录.md` → 改 `方案.md` 对应章节与版本号 → 才允许改代码。
- 自裁要有理由、可逆性与复核触发条件；被证据推翻时记「改判」，不悄悄改。
- 裁定可以推翻：推翻时写新记录（不删旧的），并说明依据变化。

---

## 10 · 仓库维护准则（继承 magpie-plugin-scaffold）

- **禁止直推 `main`**：功能分支 → PR → 必需检查 `rules` 全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。
- 发布前必跑：`node scripts/check.mjs`（退出 0）、`node --test`、`node scripts/release.mjs --dry-run`。
- **不发 npm**：`package.json` 保持 `private: true`；版本发布 = annotated tag + GitHub Release；`publishConfig` 不出现。
- **每个功能实现都升版本**：`CHANGELOG.md` 写清更新内容（用户可读），`package.json` 同步版本。
- **维护台账**：`MAINTENANCE.md` 的「当前状态 / 下一步」每次干完活必须更新；接手先读它。
- **一刀一个 commit**：commit 首行 = 房间 id（如 `R01 logread: ...`）；不许同刀混结构+行为。
- 出问题先看 `MAINTENANCE.md` 的「给接手者的最短路径」，不要猜。

## 11 · 最小交付房间（按可独立验收的行为切）

> 理论来源：压缩仓 `docs/架构-最小交付房间.md` §3/§6。要点：**不按技术层拆**；每个房间必须能回答"删掉它，哪条测试红、哪个行为消失"；房间契约 = 职责 / 入口 export / 输入→输出 / 错误语义 / 配置键 / 测试夹具 / 允许依赖 / 禁止依赖。

| id | 房间 | 职责 | 入口 | 允许依赖 | tombstone test |
|---|---|---|---|---|---|
| R00 | `episode` | 会话 → 棋谱（闭包、时间窗、信号计数） | `buildEpisode` | 无 | `test/episode.test.mjs` |
| R01 | `logread` | 多帧 zstd 逐帧解 + 事件解析（`time/seq/type`） | `readFrames` / `parseEvents` | `node:zlib` | `test/logread.test.mjs` |
| R02 | `graphread` | `graph.json` + delta 回放 | `loadGraphAt` | R00 | `test/graphread.test.mjs` |
| R03 | `extract` | 失败/成功/约束/工具的机械抽取 | `extractSignals` | R00 | `test/extract.test.mjs` |
| R04 | `topic` | 主题/实体抽取（IDF、停用词） | `extractTopics` | 无 | `test/topic.test.mjs` |
| R05 | `link` | 多粒度相关边（带 `why`） | `buildLinks` | R04 | `test/link.test.mjs` |
| R06 | `thread` | 线索（藤的视图，多对多） | `buildThreads` | R05 | `test/thread.test.mjs` |
| R07 | `index` | `index.md` 树（派生、可重算） | `renderIndex` | R00/R05 | `test/index.test.mjs` |
| R08 | `joseki` | 定式提炼/更新（每招溯源） | `promoteJoseki` | R00/R03 | `test/joseki.test.mjs` |
| R09 | `claim` | claim + validity/preconditions | `promoteClaim` | R00 | `test/claim.test.mjs` |
| R10 | `adjudicate` | 多成员裁决（L2/L3/L4） | `adjudicate` | R09/R08 | `test/adjudicate.test.mjs` |
| R11 | `walk` | 顺藤摸瓜（深度 ≤2、证据路径） | `walkFromSignals` | R05/R07 | `test/walk.test.mjs` |
| R12 | `inject` | 首轮 INDEX 一行 + 命中展开 | `buildMemoryCard` | R11 | `test/inject.test.mjs` |
| R13 | `gates` | 十道闸 + 边界审计 | `runGates` | 全部 | `test/gates.test.mjs` |
| R14 | `cli` | `dump/stats/walk/verify/rebuild` | `main` | R00–R13 | `test/cli.test.mjs` |
| R15 | `persist` | sidecar、manifest、checksums、append-only | `createStore` | R00 | `test/persist.test.mjs` |

**M1 最小交付集 = R00 / R01 / R02 / R03 / R04 / R05 / R07 / R14**（只读考古，零注入）。M2 加 R06/R08/R09/R15；M3 加 R11/R12；M4 加 R10/R13。

---

## 9 · 自动化协作（watcher 唤醒时读这一节）

- 当前**未启用** watcher。启用前必须先确定仓库与发布形态（Q13=A：单机单用户，不发多租户）。
- 启用后规则沿用压缩仓：只处理本仓库 issue/PR；作者（`MYCF711`）指令才算有效派单；每轮只做一件事；不确定就问一个问题，不要猜。
