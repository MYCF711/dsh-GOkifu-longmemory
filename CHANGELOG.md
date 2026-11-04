# CHANGELOG

> 每次功能实现都发版本并写在这里。**不发 npm**（私有自用），只发 GitHub Release + tag。

> **更正记录（约定，2026-11-04 起）**：**已发布版本的段落一律不再改写**（audit-10 残留 C：连续两版覆盖式改写已发布段，产生互相矛盾的公开文本）。
> 需要更正时，在文件**顶部**新增 `## 更正 · <日期>` 段，写「原文是什么、正确是什么、依据（审计编号/提交）」，旧段保持原样。

## 更正 · 2026-11-04（`v0.116.0` tag 作废）

- **原文是什么**：`v0.116.0` 这个 tag 存在（本地与远端），指向提交 `046509f`（`M4: 注入卡片留样（0.116.0）`）。
- **正确是什么**：`046509f` 是 PR **合并之前**的分支提交，不在 `main` 历史上；它里面的 `package.json` 已经是 **0.117.0**
  —— 因为 PR #193 把 0.116.0 与 0.117.0 的内容一起 squash 进了 `main` 的 `4376d5f`。
  所以 `v0.116.0` 这个 tag 名与内容版本**对不上**，也没有对应的 GitHub Release。
- **处置**：撤掉该 tag，**不补 Release**；0.116.0 的段落在本文件里保持原样（按上面的约定不改写），
  内容视为随 `v0.117.0` 一并发布。`MAINTENANCE.md` 的「已发布」行把它记入"有段无 tag"的历史缺口。
- **防复发**：新增 `scripts/tag-audit.mjs`（闸：tag 名必须等于该提交里的 `version`），
  并在 `scripts/release.mjs` 发版前强制运行 —— 此前 `check` / `ledger-check` / CI 全都只看工作树，看不见 tag。
- **依据**：0.118.0 发版前的手工核对（`node scripts/tag-audit.mjs` 当时输出 1 条硬红，即本条）。

## 0.136.0（2026-11-04）

### 工具面加一条「注册凭据」：重启一次就能确认工具到底进去了没有
- 背景：工具是**插件加载时**注册的，从会话里看不出"注册成没成" —— 今天重启后我们只能猜。
- 新增 `recordToolRegistration()`（`src/tools.mjs`）：插件加载时若确实注册成功，就在
  `<storeRoot>/tools-registered.json` 写一条 `{at, names, count, host}`；**原子写**（tmp + rename），
  失败返回 `false`、不抛、不影响注入。
- 用法：重启一次后 `cat ~/DeepSeek Harness/home/memory-context/tools-registered.json` 就能确认
  宿主是否把 `ctx.tools` 交给了插件、五个 `kifu_*` 是否都在。

### 验证
495 条测试（491 pass / 0 fail / 4 skip）：新增 1 条覆盖凭据落盘（原子写、可读回、空目录/不存在目录返回 false）；
`check PASS`；新宿主（pid 13364）线上 A6 首批样本 at-seq 2/2、missing 0、跨作用域 0。

## 0.135.0（2026-11-04）

### 知识库到 38 篇：调研 37 · AWS AgentCore Memory（"遗忘"的工程形态）
- [外] 原文已核：默认 **"long-term memory records do not expire"**；可选 `recordExpirySpecification`
  （`recordExpiryDurationDays` **最短 31 天**，或 `action: REMOVE`）；
  **"Changing or removing a TTL affects only records that are created after the change. Previously stored records
  keep their original expiration, and expired records cannot be recovered."**
- [外] 删除是**后台近似**：到期后 "can typically take a few days…removes expired records as a background process…
  During that window, an expired record can still be returned by read operations"；要立刻消失得显式删。
- [外] 因为"设个很短的 TTL"等于删除能力，配 TTL 需要**独立权限**（`UpdateMemoryRecordExpirySpecification`）。
- 对照本仓：他们只做 **TTL + 后台巩固**（**没有**重要性打分衰减），而且承认"到期 ≠ 读不到" ——
  这反证我们把**可见性判在读侧**（注入前遮蔽）是对的。可借：TTL 契约里"不追溯"的措辞、
  可见性在读侧判的硬约束、改可见性=独立权限的治理范例。不借：自动删除、模型抽取/合并、语义检索、打分衰减。

### A2b 严格口径复核（0.134.0 的 `seq<1` 改动之后）
- `metrics-guard PASS`：**A2b 严格 0.8947（17/19，n=19）、覆盖 19/19** —— 与改动前**逐位相同**，
  说明"丢弃 seq<1 的局级指针"没有动到任何一条被计分的注入；
- 同批：A1=0 · A5=0 · A6=1 · p50 19.60ms（负载抖动，仍远低于门槛）。

### 线上 A6 续记（同日 19:30）
样本 30 张 / 66 条引用：at-seq 64、elsewhere 0、missing 2（即 seq-0 指针，已修待重启生效）、日期 66/66、跨作用域 0。
证据：`evidence/M8-A6-live-2026-11-04.md` 的「续记 2」。

### 验证
494 条测试（490 pass / 0 fail / 4 skip）；`check PASS`（调研清单 **38 篇**）；不发 npm。

## 0.134.0（2026-11-04）

### 无源不入：`seq: 0` 的条目不再进卡（线上 A6 那 2 条 missing 的根因）
- 巡检发现：重启后的新宿主 60 条引用里有 **2 条落在 `seq 0`**，卡上是这种行 ——
  `- [observed] fail=1 · topics=版本 (ep-…, 日期, seq 0)`：**局级指针**（没有事件坐标）被渲染成了带出处的行。
- 它长着 provenance 的样子，其实没有坐标 ⇒ 审计在那一局里当然找不到这段文字（missing 是对判定）。
- 规矩回到根本：`seq` 是 **1 基**的，`seq: 0` 等于"不知道在哪"。`buildEntry()` 现在拒绝 `seq < 1`
  （这类条目不进卡、计入 omitted），卡上每条渲染行都必须真的指向一个事件。
- 影响面：当前宿主 60 条渲染行里 2 条属此类（3.3%）；修复后不会再产生新的。

### 验证
494 条测试（490 pass / 0 fail / 4 skip）：新增 1 条 —— 「seq 0 不许进卡，其它条目照常渲染」；
`check PASS`；线上 A6 其余读数不变（同作用域 60/60、跨作用域 0、日期 60/60）。

## 0.133.0（2026-11-04）

### 截断落在词边界上（T123 的尾巴）：卡片文字更接近"原文的连续前缀"
- 起因：线上那条 A6 `missing` 的卡上原文是 `…copying <user-home>\…\a.ou…` —— **词被切了一半**（`a.out` 只留 `a.ou`）。
  硬截会让卡上文字不再是原文的连续前缀，文字层核对只能靠宽容匹配。
- 改（`src/rooms/inject.mjs` 的 `clipLine`）：超限时优先回退到最近的**空白边界**再补 `…`；
  但要求至少保留 60% 的内容，否则照旧硬截（不为了好看把一条长错误砍掉一半）。CJK 无空白 ⇒ 自然走硬截。
- 单测 4 条钉住：回退边界 / 无空白硬截 / 未超限原样 / 超限必带省略号。

### T123 结案：那条"组装行"在当前代码上**不再复现**
- 新宿主（pid 18464）线上实测：**19 张样本 / 46 条引用 · at-seq 46 · elsewhere 0 · missing 0 · joined 0 · 日期 46/46 · 跨作用域 0**。
- 也就是说，问题只出现在更早进程产出的旧卡上；当前代码路径没有组装行。
- 结论写进 `evidence/M8-A6-live-2026-11-04.md` 的续记：**不擅自改抽取口径**（抬头 + 原文的取舍记为 T125 的邻居，等真复现再定），
  保留 `joined` 档作为安全网。

### 工具面：把记忆做成 **PTC 运行时可直接调用的工具**（主人的方向）
- 新 `src/tools.mjs`：`kifu_stats` / `kifu_search` / `kifu_card` / `kifu_recent_failures` / `kifu_get` 五个工具，
  每个都是**只读、零模型、有界、JSON 安全**的壳，能力来自 `src/sdk.mjs`（不重复实现）。
- `src/plugin.mjs` 的 `apply()` 里用 `ctx.tools.register()` 注册（宿主没有 `ctx.tools` 就安静跳过；
  单个工具注册失败只 warn，**不影响自动注入**）。
- 意义：自动注入是"会话模式"的推送；工具是**任何时刻都能按需拉取**——代码块里要查几次查几次，
  不必靠模型反复召回。两者并存，注入负责"不用问就来"，工具负责"要查就查准"。
- 边界变化（自裁 S17）：`AGENTS.md` §2.1 原写"不新增工具"；现明确为**记忆自身的只读查询工具归本项目**，
  压缩/系统提示词/上下文工程类工具仍不归。

### 验证
493 条测试（489 pass / 0 fail / 4 skip）—— 其中工具面 6 条（形状 / 参数透传 / SdkError 翻成返回值 / 意外翻 internal /
并发安全 / 注册失败不连累其它）；`check PASS`；线上 A6 仍 46/46、跨作用域 0。

## 0.132.0（2026-11-04）

### 心跳补上「被哪几道闸拦的」——线上两次 `gates-failed` 之前查不出原因
- 线上真事故：`live-stats.jsonl` 里有 2 次 `reason=gates-failed`，但 `gateIds` 都是 `null`。
  根因：代码只读 `gates.failed`，而 `runGates()` 返回的是 `{ok, errors, checks}` —— **根本没有 `failed` 字段**。
- 修（`src/plugin.mjs`）：抽出 `gateIdsFromGates()` / `gateCodesFromGates()`（纯函数、可单测），
  **两条来源都认**（`failed` 优先，缺了就从 `errors` 推出闸 id），并把错误码一起写进心跳（如 `claim/validity`）。
  心跳里仍然只有闸 id / 错误码，**不写卡内容**。
- 单测 3 条钉住：只给 `errors` 时也要说出闸 id（正是线上 null 的根因）、`failed` 优先、错误码去重截断。

### A6 文字级：把「同一事件里多段被拼成一行」单列成 `joined`
- 巡检发现当前宿主有 1 条 `missing`。查清后是**抽取把多段拼成一句**（抬头 `ok <pkg>: go build …` + 原文），
  逐字子串当然不存在 —— 判 `missing` 是对的，但它和"真错位/编造"应该分开看。
- `audit-card-samples` 新增 `joined` 档：严格版没命中时再看"段间以空格连接"的版本，命中记 `joined`，
  **不冒充 at-seq、也不算 missing**，汇总里单独报数。当前宿主这条连 joined 都命中不了（拼接引入了事件里没有的字符），
  说明是真·组装 —— 记进 `evidence/M7-A6-assembled-line.md`，修法（T123）另记，不擅自改抽取口径。

### 验证
487 条测试（483 pass / 0 fail / 4 skip）；`check PASS`；
当前宿主读数：34 张样本 / 65 引用 · at-seq 63 · elsewhere 1 · missing 1（已解释）· 日期 65/65 · 跨作用域 0。

## 0.131.0（2026-11-04）

### 巡检的第一句不再要人解释：`audit-card-samples --current` 自动切「当前宿主」
- 之前的痛点：`card-samples.jsonl` 里新旧进程混写，全量统计永远显示「跨作用域 2 / missing 17」——
  每次巡检都要人工补一句「那是 0.117.0 的旧账」。只看数字的人会把它读成**回归**。
- 新增 `--current`：从 `live-stats.jsonl` 里挑**最后一条心跳所在的 pid**（`pickCurrentPid()`，纯函数、可单测），
  只统计这个进程写的样本；超过 30 分钟没心跳会标「看起来没在跑」，找不到心跳则如实退回全量。
- **实测立刻见效**：当前宿主（pid 38972）的 22 张样本 ⇒ **跨作用域 0**。
  也就是说 A5 那 2 条越界全部来自旧代码，当前代码是干净的 —— 这句话以前只能靠人记，现在一条命令就能看见。

### 知识库：调研 36 Letta MemFS —— 记忆块换成 git 仓库
- [外] MemFS 原文：“The memory itself is part of the agent's state, **held in a git repository that belongs to the agent**”，
  投影成真实 checkout、**commit + push 前改动只在本地**；按路径寻址（标签 `persona` → `persona.md`）。
- [外] **根目录文件每轮进系统提示词**；带自己 `MEMORY.md` 的子目录默认不进上下文（“signposts”）；
  “MemFS **does not include a semantic or vector index by default**”；dreaming / memory doctor 用 **git worktree** 并发改记忆。
- 对照本仓：Letta 把记忆做成**可写的仓库状态**（面向行为延续），我们把记忆做成**只读档案**（面向经验复用）。
  可借「分层索引当路标」「把重复纳入机械审计（只报不改）」；**不借**开放写面、根文件进系统提示（祈使句）、
  模型审阅后自动应用、跨 agent 共享仓库 —— 最值钱的是反向证据：他们正为开放写面付旧 memory blocks 的迁移成本。

### 验证
481 条测试（477 pass / 0 fail / 4 skip）：新增 3 条覆盖 `pickCurrentPid`（取最新 pid / 30 分钟标 stale / 空输入返回 null）；
`check PASS`（调研清单 37 篇）。

## 0.130.0（2026-11-04）

### 台账闸：红了要能说出**是哪一条**（上一版留下的债）
- 上一版发版时真踩过一次：`release.mjs` 内部的 `ledger-check` 报「node --test 有失败」，但**输出为空**，
  看不到红的是哪条 —— 只知道红了、没法修。
- 新增 `scripts/ledger-parse.mjs`（纯函数、零副作用）：
  `parseTestCounts()` 同时认 spec（`ℹ tests`）与 tap（`# tests`）两套汇总；
  `failingTestNames()` 认 `✖ 名字 (12.3ms)` 与 `not ok 7 - 名字`；
  `describeFailure()` 拼出「；红的是：a | b」，**解析不到就如实说解析不到**（不假装知道）。
- `scripts/ledger-check.mjs` 接入它，并在 stdout 为空时用 `--test-reporter=tap` **再跑一次兜底**。
- 为什么单独成文件：`ledger-check.mjs` 是「跑起来就有副作用」的脚本，往里面加 export 再 import 会连带执行整个检查
  （0.126 的 `q18-preview` 就这么在 CI 里炸过）—— 解析逻辑必须能被单测独立 import。

### 验证
478 条测试（474 pass / 0 fail / 4 skip）：新增 4 条覆盖解析器（双报告器 / 去掉时长后缀 / 去重保序 / 空输出如实说）；
`check PASS`。

## 0.129.0（2026-11-04）

### SDK 面：把记忆的读操作做成可在 PTC / `run_code` 里反复调用的一层
- 新增 `src/sdk.mjs`：`createMemorySdk({ dshHome, scope, now })` 返回 `describe / stats / get / search / walk / card / recentFailures / scopeOf`。
  一个代码块里可以循环、过滤、聚合几十次，而不是一次工具调用只做一件事。
- 复用既有房间（R11 walk / R12 inject / R13 gates / R15 persist），**不重写逻辑**：`card()` 跑的就是线上同一份 `buildMemoryCard` + 十道闸。
- 三条铁律（`docs/SDK-PTC.md` 契约 + `test/sdk.test.mjs` 钉住）：
  ① **只读**——没有写入/入馆接口，跑完库的 sha256 一字不变；
  ② **零模型零网络**，毫秒级；
  ③ **有界且 JSON 安全**——`limit` ≤ 50、`budgetTokens` ≤ 2000、`depth` ≤ 2，超限夹紧并如实标 `clamped: true`。
- 状态语义：`measured` / `empty`（库在但没内容）/ **`missing`（库不存在，不抛异常）**——
  PTC 代码块不该因为"新机器还没入过馆"就崩；但"库在却读不动"仍抛 `store-unreadable`，不吞。
- 与线上同一套信号构造：文本里贴着报错原文时会补类级错误实体（少了这一步卡片会莫名变空——实现时踩到）。

### 用法（代码块里）

```js
import { createMemorySdk } from '<repo>/src/sdk.mjs';
const sdk = createMemorySdk({ scope: 'w:d:/…/长期记忆系统' });
const { items } = sdk.recentFailures({ limit: 20 });
for (const it of items) console.log(it.occurredAt, it.quote.slice(0, 80));
```

### 验证
474 条测试（470 pass / 0 fail / 4 skip）：新增 9 条覆盖契约（自描述 / 只读不变 / 夹紧 / 错误语义 / 三种状态 / 任意 cwd 可导入）；
`check PASS`；`node -e` 从任意工作目录导入实测 `stats` 输出 392 局 / 1053 claim。

## 0.128.0（2026-11-04）

### 可交付性闸 + 两个被它逼出来的真问题
- 新增 `scripts/deliverability.mjs`：用 **`git archive HEAD` 只导出 tracked 内容**（不是 clone —— archive 更严，未跟踪文件一个都不带），
  在干净目录里跑 `node scripts/check.mjs` + `node --test`。判据：check 退出 0、单测 fail=0、且至少跑了 1 条。
  单测 `test/deliverability.test.mjs` 钉住判据本身（check 非 0 / 有失败 / 0 条 / 没汇总 都判不可交付）。
- **它立刻抓到两个真问题**：

  1. **脱敏守卫从来没生效过**：`scripts/privacy-scan.mjs` 的 `user-home` 规则用了 `\+Users\+` 这种写法，
     `\+` 在正则里是**字面加号** ⇒ 只匹配 `C:+Users+`，真实的 Windows 用户目录一个都抓不到；`key-dir` 规则同病。
     修：改用 `\x5c`（反斜杠的十六进制写法）避开转义坑。**修好后立刻扫出 2 处真实泄漏**（见下条）。
  2. **`evidence/M7-arena.md` 写着本机用户名**：擂台报告把绝对路径原样写进了公开仓库（含 Hindsight 日志目录）。
     修：`arena-report.mjs` 新增 `redactLocalPaths`（本仓根 ⇒ `<repo>`，用户目录连盘符一起 ⇒ `<user-home>`），并重新生成证据。
     现在 `node scripts/privacy-scan.mjs` → **PASS（0 处）**。
- 顺带：`privacy-scan` 在没有 `.git` 时**不再抛错**，退化成目录遍历（跳过 `node_modules`/`tmp`/二进制），
  这样导出的 tarball 也能过 check；单测覆盖回退路径与三个规则的真实命中。

### 验证
465 条测试（461 pass / 0 fail / 4 skip）；`check PASS`；`privacy-scan 0 处`；`metrics-guard PASS`
（A1=0 · A5=0 · A6=1 · A2b严格 0.8947 · 覆盖 1 · p50 16.81ms）；`deliverability` 在干净导出目录里 PASS。

## 0.127.0（2026-11-04）

### 卡片留样带 pid：审计能按宿主进程切「新旧代码的账」
- 背景：宿主重启前后新旧进程会混写同一个 `card-samples.jsonl`；不分进程时，旧代码产出的卡会被误读成"新代码回归"
  （本轮巡检就出现 15 条 `missing`，全是 0.117.0 产出的旧账）。
- `src/plugin.mjs` 的 `appendCardSample` 现在统一写入 `pid: process.pid`；单测断言该字段存在。
- `scripts/audit-card-samples.mjs` 新增 `--pid <n>`：只看某个宿主机汇报的样本（默认不过滤，保持向后兼容）。
- 注意：字段是**新增**的，只对**重启后**的新样本生效；旧样本没有 pid 属预期。

### 知识库：调研 35 Mem0 v3 的 ADD-only 累积
- [外] Python SDK **v2.0.0（2026-04-14）** 的 Breaking Changes 原文：`add()` 只返回 ADD 事件，
  **"No more UPDATE or DELETE events. Memories accumulate; nothing is overwritten"**，新记忆靠 `linked_memory_ids` 累积；
  体积问题改在**读时排序**解决（"handles this at retrieval time instead… without destroying historical context"）。
- 对照本仓：它把"只增不改 + 读时遮蔽"从异类变成了 2026 年的主流工程解（累积 + 关系 + 时间是一套）；
  可借的只有"入馆前对完全相同事实做机械去重"这一件小事，不借 LLM 抽取/向量检索/用 delete 控体积。
- 全部为**厂商文档**（非论文），自报指标未独立复现，笔记里已逐条标注（含 GitHub 抓不到、提示词正文未读到）。

### 验证
458 条测试（454 pass / 0 fail / 4 skip）；`check PASS`（调研清单 36 篇）；`metrics-guard PASS`（A1=0 · A5=0 · A6=1 · A2b严格 0.8947 · 覆盖 1 · p50 8.56ms）。

## 0.126.0（2026-11-04）

### Q18 复核：从"聚合率"升级到"逐条配对 + 精确 McNemar" —— 结论仍是 A
- 上一轮裁定 Q18=A 用的是聚合率（严格 75%→66.7%）。聚合率会掩盖"谁翻转了"，所以给 `scripts/q18-preview.mjs` 加了
  **配对比较**：同一批考卷逐条比 A/B 的严格命中，输出 2×2 与**精确 McNemar**（双侧，只算不一致对）。
- 复跑结果（`evidence/q18-preview.md`，主考卷严格 **89.5%**，与 T115 后一致）：

  | 2×2（严格口径，n=12） | 条数 |
  |---|---|
  | A、B 都对 | 9 |
  | **只有 A 对（开闸把它弄丢了）** | **1** |
  | **只有 B 对（开闸救回来的）** | **0** |
  | 都不对 | 2 |

  精确 McNemar 双侧 **p = 1.0000**（不一致对只有 1 条）⇒ **B 没有可测收益，维持 A（关闸）**。
- 诚实边界：n=12 只能抓大坑、不能证小胜；当前语料里"跨项目唯先例"的签名总共只有 12 条，扩卷要等新会话（T117）。
- 单测 6 条钉住检验本身：`5:0 ⇒ p=0.0625`、`6:0 ⇒ p=0.03125`、`1:0 ⇒ p=1`、无不一致 ⇒ p=1、2×2 识别"只有 A 对"、长度不等不越界。

### 验证
458 条测试（454 pass / 0 fail / 4 skip）；`check PASS`；`metrics-guard PASS`（A1=0 · A5=0 · A6=1 · A2b严格 0.8947 · 覆盖 1 · p50 9.17ms）。

## 0.125.0（2026-11-04）

### T114：A2 配对重放的协议、冻结集与成本，先落地为可执行的东西
- 新增 `docs/A2-配对重放协议.md`：判据在**跑之前写死**（Δ ≥ +10pp 且 McNemar p<0.05 ⇒ 有净收益；±10pp 内 ⇒ 未测出；Δ ≤ −10pp ⇒ 记忆在拖后腿），
  并写清「切点之后、防考同一张卷子」「两臂同模型同预算」「抽样先冻结成文件、跑完不许换题」四条护栏。
- 新增 `scripts/a2-pair-replay.mjs`：
  - `--build-set` 机械产出**冻结配对集** `evidence/a2-pair-set.json`（**20 条任务**，切点 2026-11-02）；
  - `--dry-run` 打印成本：**20 对 × 240,000 tokens ≈ 4,800,000 tokens**（80 对 ≈ 19M，用来检出 10pp 级差异）；
  - `--arm both|mem|nomem` **一律拒绝执行**（exit 3）：它要起干净会话、按对消耗模型预算，属**预算决策**，须主人点头。
- 意义：主判据 A2 与 Hindsight 的"不可比"，从此不是缺工具，而是缺**一次预算表态**。

### 验证
452 条测试（448 pass / 0 fail / 4 skip）：新增 5 条钉住"只挑切点后有先例的签名 / 同签名只留一条 / limit 生效 / 成本算式 20 对=4.8M、80 对=19.2M"。
`check PASS`；`metrics-guard PASS`（A1=0 · A5=0 · A6=1 · A2b严格 0.8947 · 覆盖 1 · p50 10.01ms）。

## 0.124.0（2026-11-04）

### T115：同一局里挑"最贴近这次失败"的那条教训 —— A2b 严格回到 89.5%
- 上一轮（T111）把短板的定位收敛到"选源"，这一刀继续往下：
  **同一局里往往不止一条教训**，而 walk 命中的那个 seq（或它自带的 claim）可能锚定着与本次失败无关的**类级泛教训**。
- 实测反例：`syntaxerror … checkSyntax` 那条考卷，5 个 hit 全落在同一局 `ep-8a73e06b`，各自只带一条"工具坏了"的泛教训
  （`claim.text` 重叠 0），而真正对得上的那条在同一局的另一个 seq（`c-0402805c`，重叠 8）。
- 修（`src/rooms/inject.mjs` 的 `pickClaim`）：在该局的 claim 里挑与**本次信号判别词**重叠最高的那条，
  要求 **≥2 且严格优于原选**，否则保持原行为（不为换而换）；出处仍由 `entryFromClaim` 从所选 claim 的 support 里取，
  所以「文字 / 坐标 / 日期」三者一致的不变量、以及 A5 作用域闸都不受影响。
- 结果：

  | 读数 | 改前（0.122.0） | 改后 |
  |---|---|---|
  | **A2b 严格（claim.text 口径）** | 16/19（84.2%） | **17/19（89.47%）** |
  | 分桶（严格） | multiHop 14/15 · openDomain 2/4 | **multiHop 15/15** · openDomain 2/4 |
  | A2b 卡片可读性 | 18/19 | 18/19 |
  | A5 跨作用域 / A6 结构 | 0 / 100% | **0 / 100%** |

- 剩下 2 条全是 **openDomain（跨工作区）**：它们的 claim 支撑局都在别的工作区，按 A5 被正确挡掉 ——
  这就是"天花板由 A5 决定"，也是 Q18 裁定 A 的自觉代价（0.119.0 的 A/B 对照：开闸净负）。

### 口径更正 S16：A1 的负迁移主值改取**闸门后**
- T115 让"闸前的 stale 候选"从 0 张变成 20 张（会从同局里挑更贴近的教训，可能挑到已过期的），
  A1 的**闸前** `staleTransferRate` 于是从 0% 跳到 **22.09%（19/86）**；但**闸后是 0.00%（0/56 到达模型）** —— 闸 3 全部拦下。
- 结论：A1 主值取**闸门后**（负迁移 = 错误记忆真的进了上下文），闸前的数作为"候选暴露度"照旧打印、不藏。
  这不是为了让指标好看：之前那个 0% 是**偶然**（从来没有 stale 候选被渲染过，指标对闸根本没锻炼过）。
  旧 report 没给闸后数时退回闸前，不把有读数的情况变成 null（单测覆盖两个分支）。

### 验证
447 条测试（443 pass / 0 fail / 4 skip）；`check PASS`；六轴 A1 **0%**（闸前 22.09% 可见）· A2 21.73% · **A2b 严格 89.47%** · A3 live（inject=81） · A4 p50 9.69ms · A5 **0** · A6 **100%**。

## 0.123.0（2026-11-04）

### 擂台开打：把「至少比 Hindsight 强」从口号变成逐轴读数
- 新脚本 `scripts/arena-report.mjs`（零模型调用、只读双方日志）：
  **我方**读数取 `evidence/metrics-guard.json`（每轮巡检刷新）+ `live-stats.jsonl`；
  **对方**读数由它自己的日志当场重算（`~/.hindsight/coding-agents-logs/{usage,diag}.jsonl`）。
- 判定只有三档 `win` / `lose` / `incomparable`，**且单测禁止把"不可比"判成"我们更强"**（A2 主判据即使我方读数很好看也不许判 win）。
- 结果（`evidence/M7-arena.md`）：**赢 3 · 输 0 · 不可比 3**

  | 轴 | 判定 | 我方 | 对方 |
  |---|---|---|---|
  | A3 可靠性 | **win** | 线上注入 79 次、失败 0 | recall 失败 **27.9%**（299/1071）· retain 4.6% · pages 9.7%，另有 3347 次空注入 |
  | A4 延迟 | **win** | 热路径 p50 **9.03ms** | `inject_recall` p50 **4923ms** / p90 8329ms（n=772） |
  | A5 作用域 | **win** | 按工作区硬隔离，跨作用域 0 | 8 个 bank、269 个会话只有 1 个跨 bank，但最多轮次落在**共享**的 `coding-agent::default-workspace` |
  | A1 / A2 / A6 | incomparable | 0% / A2b 覆盖 100%、严格 84.2% / 结构 100% | 无同口径读数（只有 1.49% 的 credited 代理） |

- **阻止开打的那一条已经消失**：`docs/对标-Hindsight.md` 原写"擂台仍未开打，因为插件尚未在宿主里跑过（A3）"——A3 早已 live，本轮据实改为"已开打"。
- **主判据 A2 仍不可比**：要在同域做「有/无记忆配对重放」才谈得上比较，那要调模型。**所以现在仍不宣称"比 Hindsight 强"**。

### 更正：Hindsight 的 bank 结构（原话说过了头）
- 原文写"所有项目共用一个 bank（不是 per-repo）"；按它的日志实测：**8 个 bank**，项目 bank 最大的是共享的
  `coding-agent::default-workspace`（5556 轮），另有少量 per-repo bank（`zcode-glm5.3f` 175 / `主工作区` 64 / `dsh系统提示词工程` 27 …），
  以及归档类 `archive`（11706 轮）。**269 个会话里只有 1 个跨 bank** ⇒ 准确说法是"以共享默认 bank 为主"。
- 同源复读的其它数（2026-11-04）：注入失败 27.9%（原记 29.4%）、retain 4.6%（原记 7.5%）、pages 9.7%、credited 1.49%（原记 1.82%）。

### 验证
445 条测试（441 pass / 0 fail / 4 skip）；`check PASS`；`tag-audit PASS`。

## 0.122.0（2026-11-04）

### T111：类级 claim 的展示原文按本次信号选（针对 0.121.0 定位出的短板）
- 0.121.0 把 A2b 的失分归因量成「覆盖但文本不匹配 3 / 未检索到 0」，短板是**选源**：
  类级 claim 把同类多条错误收在一条上、只存**一个代表原文**，固定取 `hit.seq` 那条时，
  卡片会把 `class:sandbox-limit（工具被掐）` 这类"工具箱坏了"的泛教训端上来，却不点名这次到底是哪条错。
- 修（`src/rooms/inject.mjs`）：同域 support 里挑**与本次信号判别词重叠最多**的那条 quote 作为展示原文
  （新增 `signalTokensOf`，与 m5 A2b 的判别词口径同源）；**只有明显更好（≥2 且优于原选）才替换**，
  没有更好的候选就保持原行为 —— 不为换而换，避免卡片变成"随机挑一条"。
- 口径提醒：m5 的**严格**口径按 `claim.text` 算，所以本次**严格不动是预期的**（它量的是 claim 的措辞，不是卡片正文）；
  这次改善的是**卡片正文**：`卡片可读性 17/19 → 18/19`（A2 行现在也直接打出这个数）。
- 另一条失分（`json.decoder.JSONDecodeError…`）复盘后属**排序**问题（覆盖该签名的 claim 没进 top-5），不在这一刀的范围。

### 前后对照

| 读数 | 改前 | 改后 |
|---|---|---|
| A2b 覆盖 | 19/19 | 19/19 |
| A2b 严格（claim.text 口径） | 16/19 | **16/19（不动，符合预期）** |
| **A2b 卡片可读性（卡片正文口径）** | 17/19 | **18/19** |
| A5 跨作用域 | 0 | **0** |
| A6 结构口径 | 100% | **100%** |
| A4 tokens p50 | 304 | **301**（没有膨胀） |
| A4 p50 延迟 | 9.84ms | 10.74ms（负载抖动范围内） |

### 验证
439 条测试（435 pass / 0 fail / 4 skip）；`check PASS`；`metrics-guard PASS`。

## 0.121.0（2026-11-04）

### A2b 的失分开始有归因：先知道该修哪一层，再改代码
- 巡检不满足于"严格 16/19"，把三条失分拆到三层量了一遍（`evidence/M7-a2b-misses.md`）：
  **三条都"覆盖"了**（命中的 claim 支撑局确实包含当年那条签名所在的棋谱），所以不是"没召回"。
- 机制：三条命中的 claim 全是**类级**（`class:sandbox-limit` / `class:tool-unavailable` / `class:web-search-empty`…），
  而类级 claim 只存**一个代表原文** —— 当本次签名是"同类的另一条错"时，严格口径的重叠只有 0–1，
  卡片正文（0.118.0 起取 `src.quote`）的重叠也只有 1/9、2/11。**卡片端上"工具箱坏了"的泛教训，却不点名是哪条错。**
- **否决了一个看似省事的改法**：把严格口径放宽成"`claim.text` ∪ 同域 `support.quote` 的重叠"（理由是 0.118.0 起正文取 quote）。
  实测卡片正文本身只重叠 1/9、2/11 —— 放宽等于给"卡片里根本没出现的证据"记分，属发明得分。
- 落地（只加观测，不改行为）：`measureA2b` 新增 `missBy = {covered, notRetrieved}`，
  六轴 A2 行打出 `**失分归因** 覆盖但文本不匹配 X / 未检索到 Y`；单测覆盖"空库必须记 notRetrieved"。
  本机实测：**覆盖但文本不匹配 3 / 未检索到 0** ⇒ 短板在"类级 claim 的展示原文选择"，不在检索。
- 下一刀（计划表 T111，未做）：类级 claim 的展示原文按当前信号选（取同域 support 里与信号判别词重叠最高的那条 quote），必须给 A2b 严格前后对照。

### 验证
437 条测试（433 pass / 0 fail / 4 skip）；`check PASS`；`metrics-guard PASS`（A1=0 · A5=0 · A6=1 · A2b严格 0.842 · 覆盖 1 · p50 9.03ms）。

## 0.120.0（2026-11-04）

### 回归闸的采集失败不再"不可诊断"，也不再伪装成台账问题
- 巡检时 `node scripts/metrics-guard.mjs` **直接失败**：`采集失败（Command failed: … m5-report.mjs --json）`；
  重跑同一条命令又正常 —— `m5 --json` 是**间歇性静默死亡**。
- 三个缺陷让这件事只能靠猜：① `execFile` 把子进程 **stderr 吞了**，信息只剩 `Command failed`；
  ② `JSON.parse` 失败与子进程失败混成同一句"采集失败"；③ `ledger-check.mjs` `catch {}` 后把 a2/a4 置空，
  于是报「**台账缺 A2/A4 实测值**」—— 把采集失败伪装成台账问题，指向完全错误的排查方向。
- 修（只改工具，不改任何判据）：
  - `scripts/metrics-guard.mjs` 改用 `spawn`，分记 `exitCode / stderr / stdout`；失败时打印 exit、stderr 尾部、stdout 尾部，
    并把原始输出落 `tmp/m5-raw.json`、`tmp/m5-raw.stderr.txt`；**只对「exit≠0 且 stderr 为空」的静默死亡重试一次**。
  - `scripts/ledger-check.mjs` 把采集失败单独记成 `m5 采集失败（不是台账的问题）：exit=… · stderr: …`。
  - 单测：`test/ledger-check.test.mjs` 加一条 —— 带 `m5CollectFailed` 时必须报采集失败，且**不得**出现「台账缺 A2/A4」。

### 巡检留档
- `evidence/M7-patrol-2026-11-04-0900.md`：心跳 73 次注入 / 失败 0；跨作用域 2 条**全是补闸前老卡**（无回归）；
  文字级线上仍是旧代码的账（85/149、missing 14），离线重抽 41/43、missing 0、日期 43/43。
- 残留 2 条 `elsewhere` 已定位于 `ep-8cc34e32`（同局内同一句失败原文重复出现，`seq` 指向较早那次），
  同局内坐标精度问题、非跨局越界，记 T109。

### 知识库：调研 34 Obsolete Facts（过时事实与"检索不足"）
- [外] 证据预算 64→512 tokens 反而让准确率从 45% 掉到 32%（检索集里始终含最新陈述）；
  把一条无关陈述换成**过时的竞争陈述**，准确率 100%→44.6%（Qwen2.5）/ 100%→87.8%（Qwen3-14B）。
- 对照本仓：旧条永远在库里 ⇒ **遮蔽必须发生在注入前**；可借「旧条只给指针不给正文」，不借提示词级修复。

### 验证
436 条测试（432 pass / 0 fail / 4 skip）；`check PASS`；`tag-audit` PASS。

## 0.119.0（2026-11-04）

### Q18 裁定：维持关闸（A），并用数据把"该不该开"变成可复核的判定
- `scripts/q18-preview.mjs` 用**同一张跨项目考卷**分别跑 A（关）与 B（开）：

  | 考卷 / 口径 | n | 覆盖 | 严格 | 展示命中 |
  |---|---|---|---|---|
  | 主考卷（现状） | 19 | 100.0% | 84.2% | 47.4% |
  | 跨项目 · Q18=A | 12 | 100.0% | 75.0% | 0.0% |
  | 跨项目 · Q18=B | 12 | 100.0% | 66.7% | 16.7% |

- 开闸只把"卡片里真的出现当年那一局"从 0 抬到 16.7%（2/12），却把同一考卷的严格命中从 75.0% 拉到 66.7%（净负 1 条）。
  n=12 付不起 A5 从干净的 0 变成需要分桶解释的代价 ⇒ **结论 A**，记入 `docs/拷问记录.md` 的自裁 S15。
- **复核触发条件**（任一满足就重测、可推翻）：跨项目考卷 ≥30 条 / 主人明确要求跨项目复用 / 出现"同一类级失败在 ≥3 个工作区重复且都无同域先例"。
- 可逆性：一行 `crossScopeClass: true`；开关早已实现且默认关，本次**不改行为**。

### 安装指南与实况对齐
- `docs/安装指南.md` 的"当前已知状态"还是"已注册但被禁用（两条 `disabled: true`）"，早已过期 ——
  改为实况：别名包 `kifu-loader` 已挂、宿主里真跑，状态与六轴读数一律以 `MAINTENANCE.md` 为准（指南不写死数字）。

### 验证
435 条测试（431 pass / 0 fail / 4 skip）；`check PASS`；`tag-audit` PASS。

## 0.118.0（2026-11-04）

### A5 补闸的线上复核：跨作用域引用归 0
- 主人重启后新宿主进程（pid 38972，07:44:05 起）加载 0.117.0，继续真实注入：到 07:50:57 已 22 次 pre-step、`inject=8`。
- `node scripts/audit-card-samples.mjs`：全量 22 张卡 / 98 条引用按**结构口径**100% 可回溯；跨作用域 2 条，
  **全部来自补闸前**（06:57:35 与 07:37:34，同一条 `ep-1cf2b33f@783`）；**重启后 8 张卡 / 34 条引用，跨作用域 0**。
- 也就是说 0.117.0 那条验收判据（`crossScopeRefs` 归 0）在线上达成了，且不是"因为不再注入所以不越界"——同期仍在注入。
- 证据 `evidence/M7-A5-live-clean.md`（含按 pid 切分重启边界的复现命令）。

### A6 判据升级 + 修：卡上的字必须落在它自己标注的 (ep, seq) 上
- 独立复核（`reports/audit-11.md`）把"可回溯"加严成"文字必须真的出现在所引 seq 附近的事件里"，读数完全不同：
  重启后 10 张卡 / 44 条引用里，**28 条对得上、15 条只在该局别处出现、1 条该局根本没有那段文字**；日期 **34/44** 不是所引那条事件的时间。
- 反例（唯一一条"该局没有这段文字"）：`ep-226dbf4f@783` 的卡上写着 `ptc-domain-presets/AGENTS.md: not found`，
  而该局 14167 个事件里 `ptc-domain-presets` 出现 **0** 次；真身是 `ep-fdd814b1@546`（祖先域）。
- 根因是**三者脱钩**：`text ← claim.text`（claim 的 exemplar，可能来自另一局）、`episode/seq ← src`（作用域过滤后挑中的那条 support）、
  `occurredAt ← claim.occurredAt`。库里 46 条 `u:` 层 claim **46/46** 的 support 跨多个工作区，故属结构性而非偶发。
- 修（`src/rooms/inject.mjs` 的 `entryFromClaim`，本版**行为改动**）：
  ① 文字取 `src.quote`（该 seq 的原文；`class:<token>` 作为机械标签保留成前缀）；② 日期取 `src.occurredAt`；
  ③ 只有旧夹具/旧数据缺 `quote` 时才退回 `claim.text` —— 那不是允许脱钩，而是让审计能把它抓成可见失败。
- 判据同刀升级：`scripts/audit-card-samples.mjs` 默认做**文字级**核验（`at-seq` / `elsewhere` / `missing` + 日期一致），
  `missing` 或日期不一致即退出 1（旧的"ep 存在 + seq 在闭包内"只保留在 `--no-text` 里作对照）。
  文字层窗口默认 **±10**：实测「调用步 → 工具结果」的 seq 间隔直方为 `0×9,2×9,3×2,4×30,5×11,6×6,8/9/10 各 1`，±3 会把真引用判成 elsewhere。
- 新增 `scripts/a6-text-level.mjs`：**离线重抽**——用与注入同一条链（`runPipeline`）为当前库现造卡，再套同一判据。
  这样"改完的代码会产出什么卡"不必等宿主重启就能量（`audit-card-samples` 读的是线上留样）。
- **前后对照（同一把尺子，window=±10）**：

  | | 修复前（线上留样，宿主仍跑旧代码） | 修复后（离线重抽） |
  |---|---|---|
  | 引用 | 122 | 43 |
  | at-seq | 70（57.4%） | **41（95.3%）** |
  | elsewhere | 38 | **2** |
  | missing | **14** | **0** |
  | 日期一致 | 31/122（25.4%） | **43/43（100%）** |
  | 判定 | FAIL | **PASS** |

  证据 `evidence/M7-A6-text-level.md`；剩下 2 条 elsewhere 属抽取层（quote 由「stderr + 退出码」拼成或被截断），另开一刀。
- 单测：`test/inject.test.mjs` 加 3 条（文字取原文不取 exemplar、日期取所引事件、类级标签保留、旧数据退回可见），
  `test/audit-card-samples.test.mjs` 10 条（三档判定 / 日期 / 读不到原件 fail-closed / `--no-text` 回退）。
- **口径变更声明**：六轴里 A6 的 100% 是**结构口径**；文字级读数另计（本版离线重抽 41/43，修复前线上 70/122）。
  线上口径要等宿主下次重启、`card-samples.jsonl` 换上新卡后才更新。

### 新增闸：tag 与内容版本一致性（`scripts/tag-audit.mjs`）
- 硬红：每个 tag 的 `package.json` `version` 必须等于 tag 名（`v0.116.0` ⇒ `0.116.0`）。
- 软警：tag 指向的提交是否在 `main` 历史上（早期 v0.16.0 及以前有一批不在，属历史遗留，只告警不阻断）。
- `scripts/release.mjs` 发版前强制跑；单测 `test/tag-audit.test.mjs` 覆盖 5 种形态（含 0.116.0 的真实形态、取不到 version 时 fail-closed）。

### 台账自证恢复可复现
- `MAINTENANCE.md`：测试 435（431 pass / 0 fail / 4 skip）、A2 **22.69%**、A4 p50 **10.04ms**（p90 14.39 / p95 15.01 / max 26.41）、claim 1053、六轴时点刷新。
- 台账原先写 416/412 且 A4 写成区间（`~9–16ms`）导致解析不出实测值 —— `ledger-check --full` 因此连续红；本次改成可解析的定值 + 时点。
- 「插件」行从"两条 `disabled: true`、待重启验证"改为实况：别名包 `kifu-loader` 已挂、宿主真跑、`first-live` 报 `liveReady=true`。

### 知识库：调研 33 MemoryAgentBench（四能力记忆基准）
- [外] v4 的四项能力是 accurate retrieval / test-time learning / long-range understanding / **selective forgetting**，
  而 v1 目录与正文写的是 **Conflict Resolution**（判据相同：面对矛盾证据时覆盖/删除旧信息）。
- 对照：它的 SF/CR 要求**写时覆盖**，与「只增不改、原件永不删」直接冲突 ⇒ 评测骨架可借（按 AR/冲突型分桶、机械造矛盾对），写时覆盖不借。

### 验证
435 条测试（431 pass / 0 fail / 4 skip）；`check PASS`；`tag-audit` PASS；`ledger-check --full` PASS。

## 0.117.0（2026-11-04）

### M4 抽样抓到 A5 实质越界 → 补闸
- `audit-card-samples.mjs` 抽查 7 张真实注入卡：33 条引用 **100% 可回溯**，但 **1 条跨作用域**。
- 根因：`u:owner` 类级 claim 的 support 跨多个工作区，注入层按 support[0]/命中局取一条出处 ⇒ 把别项目的失败原文渲染进本项目的卡。
- 修：`entryFromClaim` 只选**同作用域** support；全在别的作用域则不渲染（查不到 episode 记录时不误杀）。
- 新增单测（a/b 两作用域夹具，断言卡里不出现别项目的 ep）；线上验收看 `audit-card-samples` 的 `crossScopeRefs` 归 0。
- **指标必须跟着改**：补闸后 A2b 严格 **89.5% → 84.2%（16/19）**、A5 仍 0。掉的那 1–2 条原本是 u:owner 跨作用域 claim 命中，
  属**越界命中**；这不是能力退化，是把不该算的分去掉。旧读数 89.5% 从此作废，不再引用。
- 证据 `evidence/M7-A5-live-leak.md`。

### 验证
417 条测试（413 pass / 0 fail / 4 skip）；`check PASS`。

## 0.116.0（2026-11-04）

### M4 精度抽样：注入卡片留样（默认开）
- 新增配置 `sampleCards`（默认 true）：注入成功时把卡片正文追加到 `<storeRoot>/card-samples.jsonl`
  （只写 sidecar、不写会话日志；8 MB 上限；失败不影响注入）。字段 `{at, scope, scopeFrom, digest, tokens, section}`，
  与心跳 `digest` 可一一对应。
- 动机：本会话那张卡由「整点巡检…」这类**宽泛指令**触发，给的却是五类失败教训 —— 泛相关风险必须留证；
  离线 A1 用留出集，看不到线上。
- 下一步：按 `evidence/M7-live-injection-sample-plan.md` 抽 N 条逐条核「引用是否属实 / 是否泛相关 / 是否跨项目」。
- 单测覆盖：只写 sidecar、库不存在不写、8 MB 上限。

### 验证
416 条测试（412 pass / 0 fail / 4 skip）；`check PASS`。

## 0.115.0（2026-11-04）

### 知识库：调研 32 A-MEM（NeurIPS 2025）
- [外] Zettelkasten 式笔记：写入时建结构化属性 + 动态链接；**记忆演化**会回写旧记忆使其更精炼。
- 对照：链接同构；但回写与「只增不改」冲突——我们用 `supersededBy` 保留原件，换 A6 可回溯 100%。
- 结论：回写是能力也是债（旧版被改掉就无法回放"当时怎么想"），取舍是自觉的。

### 验证
415 条测试（411 pass / 0 fail / 4 skip）；`check PASS`。

## 0.114.0（2026-11-04）

### A3 闭环：宿主真实注入 14 次、失败 0
- 宿主进程（pid 36056）自 05:24 起写入 `action=inject` 共 **14 次**（`src=index.js`），tokens p95 239 / max 344，失败 **0**。
- 覆盖作用域含 `…/DSH-GO`、`…/反代`、`…/反代/wps`、`…/长期记忆系统`；`scopeFrom` 两类兜底（session-log / episode-fallback）都出现在真实注入里。
- 本会话可见的那张卡：`<memory-ledger>` 362 局、5 条失败教训（digest `8a3daac88d10a84a`、299 tokens）。
- `m5` 的 A3 实测：`status=live`、`n=11468`（心跳）、`value=0`（失败率 0/14）。
- 口径不变：只统计 `src=index.js`；3 条 `src:sim-inject.mjs` 的仿真行不计入。
- 六轴表与对标文档 §4.5 同步更新：**A3 not-live / live-idle → live**。

### 验证
415 条测试（411 pass / 0 fail / 4 skip）；`check PASS`。

## 0.113.0（2026-11-04）

### 心跳汇总区分宿主行/仿真行
- `live-stats` 明确分开 `src=index.js`（宿主）与脚本写入的仿真行；动作/原因/tokens 只统计宿主行。
- 现状：宿主行 10495（全 skip，0 inject）· 仿真行 3（仿真 inject，不算线上）。
- 这样"是不是真注入"不再需要靠人记口径。

### 验证
415 条测试（411 pass / 0 fail / 4 skip）；`check PASS`。

## 0.112.0（2026-11-04）

### 修掉最后一个注入阻塞：宿主消息工厂本地兜底
- 真因：`import('@deepseek-ai/dsh-llm')` 只存在于宿主 asar，外部插件按仓库路径解析不到 ⇒ 命中/建卡/过闸都通过，最后**造消息失败**而静默沉默。
- 修法：解析不到时用本地等价工厂 `makeUserMessageFallback`，形状逐字段对齐宿主源码（`role:'user'` + `randomUUID` + 冻结）。
- 仿真实测：`kind=enter`、`msgs: 2`、注入消息带 `source.kind=dsh-gokifu-longmemory`。
- **取证口径收紧**：`m5` 的 A3 与首注入守望只统计 `src=index.js`（宿主写入）的行；现有 3 条 `src:sim-inject.mjs` 的 inject 行明确是仿真，不算线上注入。
- 证据 `evidence/M7-message-factory-fallback.md`。

### 验证
415 条测试（411 pass / 0 fail / 4 skip）；`check PASS`。

## 0.111.0（2026-11-04）

### 线上链路已到闸 + 心跳记闸 id
- 实测心跳：`reason=gates-failed`、`tokens=239` ⇒ walk 命中、卡已建、闸按设计拦下（此前只有 no-hit/no-signal）。
- 心跳新增 `gateIds`（只写闸 id，不写卡内容）：下次重启后可直接定位是哪道闸。
- 证据 `evidence/M7-live-pipeline-reaches-gates.md`；**仍不声称注入可靠性已验证**（inject 仍为 0）。

### audit-10 文案更正
- CHANGELOG 0.108 段的「已发布清单」表述改成与事实一致（本版确实补全到 0.108.0；「改为指针」是 0.109.0）；
  并按新约定**不再改写已发布段**，本段即最后一次直接更正（audit-10 唯一阻塞项）。
- `MAINTENANCE.md` 缺口清单标注下限「（0.15.0 起）」，并补记全历史另有 0.14.0 有段无 tag（audit-10 残留 B）。

### 验证
414 条测试（410 pass / 0 fail / 4 skip）；`check PASS`。

## 0.110.0（2026-11-04）

### 知识库：调研 31 GraphRAG
- [外] LLM 建实体图 + 预生成社区摘要 + map-reduce 汇总；面向"整个语料"的全局问题，全面性/多样性优于常规 RAG。
- 对照：LLM 建图与摘要被本仓边界禁止；**全局问答 ≠ 检索**，我们选择不做（记忆不替模型写总结），而不是用相似度硬凑。
- 可复用：摘要必须标明是派生/可重建（与我们"卷是视图"同构）；索引按需重建（N9 已落地）。

### 验证
414 条测试（410 pass / 0 fail / 4 skip）；`check PASS`。

### audit-09 修复（终验不通过 → 逐条关闭）
- **R1 关闭**：`MAINTENANCE.md` 的「已发布」行不再声称"全部有 tag"，改为如实列出 6 个历史缺口
  （0.77.3 / 0.78.0 / 0.86.0 / 0.88.0 / 0.97.0 / 0.107.0 有 CHANGELOG 段但无 annotated tag，不回填）；
  CHANGELOG 0.108 段里"已改为指针"的不实表述更正为"本版未改，指针是 0.109.0 做的"。
- **回归修复**：`CHANGELOG.md` 里的裸 NUL 清除（0.109.0 清理 NUL 时误写入，导致 read/grep 判为二进制）。
- `reports/audit-09.md` 入库（结论：不通过，原因正是上述两条；R2/R3 已验证关闭）。
## 0.109.0（2026-11-04）

### audit-08 复核后的收尾（R1/R2/R3）
- **R1**：「已发布」行改为**指针**（`git tag -l` + CHANGELOG），不再手抄 —— audit-08 证明手抄必漏/重（缺 0.80–0.87、含未打 tag 的 0.97/0.107）；CHANGELOG 里"补全"的不实表述同步改正。
- **R2**：`ledger-check` 的 A4 p50 容差改为**线上自适应**（实测值的 50%，下限 3ms）；audit-08 实测抖动达 7.34ms，固定 3ms 会假红。
- **R3**：`MAINTENANCE.md` 的「跨作用域 0」口径改为指向 m5 A5，不再挂 replay-live。
- 顺手：`scripts/preflight-bundle.mjs` 里一个裸 NUL 字节改成 `\u0000` 转义（此前 `grep -I` 与 read 工具会拒读该文件）。
- `reports/audit-08.md` 入库（结论：有条件通过；无阻塞交付问题）。

### 验证
414 条测试（410 pass / 0 fail / 4 skip）；`check PASS`。

## 0.108.0（2026-11-04）

### audit-07 修复（有条件通过 → 逐条处理）
- **台账容差改为按比例**：线上 `autoArchive` 持续入馆，固定 ±12 会被正常增长追上；改为「live 时 2%（下限 12）」，claim 836 vs 852 这类正常漂移不再误报，量级错误仍会被挡。
- **`m5` 状态标签补齐** `live` / `live-idle`（此前状态列打印 undefined）。
- **`MAINTENANCE.md` 的「已发布」行在本版补全到 0.108.0**（未改为指针；改为指针是 0.109.0 做的）。
  0.109.0 曾把本版误记成"改为指针"，audit-09/audit-10 复核更正为此句（覆盖式改写已发布段落**不再使用**，见文件头「更正记录」约定）。
- **装前预检加动态导入**：`import('kifu-loader')` + `apply` 可用性 + 插件名核对；软链缺失/复制安装导致 re-export 断裂会当场报错，而不是宿主静默失败（audit-07 指出的唯一安装风险）。
- **引用纠正**：`evidence/M7-replay-live.md` 补记「跨作用域 0 应引 m5 A5 读数」，该文件只作"注入是否发生"的证据。
- 说明：audit-07 报的「ledger-check FAIL 仍 exit 0」是管道取尾部导致的误读——脚本 `main` 里是 `process.exit(out.ok ? 0 : 1)`；已在报告复核项里备注。

### 验证
414 条测试（410 pass / 0 fail / 4 skip）；`check PASS`；`preflight PASS`（含动态导入）。

## 0.107.0（2026-11-04）

### N10 线上验证：scopeFrom=session-log 生效
- 重启后新 pid 的心跳带 `scope=w:d:/…/长期记忆系统`、`scopeFrom=session-log`——不再是 `profiles/desktop` 假作用域。
- 心跳 4301 → 4889；仍 0 注入，因为当前消息无信号（`no-signal`），符合设计。
- 首次注入守望已重启（30 秒间隔 / 12 小时），命中即自动落证 `evidence/M7-A3-first-inject.md`。
- 证据 `evidence/M7-N10-live.md`。

### 验证
414 条测试（410 pass / 0 fail / 4 skip）；`check PASS`。

## 0.106.0（2026-11-04）

### Q18 开闸设计（B 方案，默认关，先合后翻）
- `docs/Q18-开闸设计.md`：写清行为契约（class 级跨工作区 + `[跨项目]` 标记、具体事实仍不跨）、
  四处改动清单（walk 作用域闸 / inject 标记 / 配置键 / m5 断言）、**验收六轴对照表**（A2b 严格目标 ≥18/19、可读性 19/19、A5 越界仍 0）、
  回滚方式（一行配置）与"可单独切"的理由。
- 本轮不动行为；等 Q18 裁定后按此一刀落地。

### 验证
414 条测试（410 pass / 0 fail / 4 skip）；`check PASS`。

## 0.105.0（2026-11-04）

### 知识库：调研 30 Generative Agents
- [外] memory stream（全存）+ reflection（模型合成高层记忆）+ recency/importance/relevance 检索；消融显示三者都关键。
- 对照：全存与我们"原件永不删"同构；**反思与重要性打分被本仓边界禁止**；
  我们**故意不引入 recency**——A2b 依赖"旧签名也要召回"，引入衰减会让旧教训沉底。
- 结论：全存 + 检索骨架可复用；不引入 recency 的取舍写进文档，防止被"更先进"的方案带跑。

### 验证
414 条测试（410 pass / 0 fail / 4 skip）；`check PASS`。

## 0.104.0（2026-11-03）

### 签名索引加缓存（12.3× 单调用提速；如实说明不是主因）
- `loadSignatureIndex` 按 (mtime, size) 缓存，`writeSignatureIndex` 失效；微基准 300 次读取 160ms → 13ms。
- 诚实结论：单次约 0.5ms → 0.04ms，属廉价清理；`m5` 完整跑仍是 **130s**，成本在 A2 LOO 与热路径重复建卡。
- 证据 `evidence/M7-sigindex-cache.md`。
- **线上漂移容差**：插件在宿主里跑后 autoArchive 持续入馆，台账数字是快照 ⇒ `ledger-check` 在
  `<store>/live-stats.jsonl` 15 分钟内有写入时，对「局数/claim/卷」给 ±12 计数容差（方向性指标不开口子；
  测试计数与 A2/A4 容差不变）。修掉"发版时台账必然过期"的死循环。

### 验证
414 条测试（410 pass / 0 fail / 4 skip）；`check PASS`。

## 0.103.0（2026-11-03）

### 首次注入守望 `scripts/watch-first-inject.mjs`
- 轮询 `live-stats.jsonl`，出现 `action=inject` 时把**首条注入**的快照写进 `evidence/M7-A3-first-inject.md`
  （时间、src/pid、scope/scopeFrom、digest、tokens、心跳总数）。
- 已后台启动（每 60 秒检查，最多 2 小时）——A3 首次注入不会因为没人盯而丢掉证据。

### 验证
412 条测试（408 pass / 0 fail / 4 skip）；`check PASS`。

## 0.102.1（2026-11-03）

### N10 端到端演示（真实会话，无需重启即可验证）
- 真实 session id `1b9837d6-…`：`episode-fallback` 解析到 `w:d:/DeepSeek Harness/default-workspace`；
- 同一信号在该作用域下 **命中 5 条、渲染出真实卡片（tokens 276）**；
- 结论：宿主里只差一次重启加载新代码，注入就会发生。

### 验证
412 条测试（408 pass / 0 fail / 4 skip）；`check PASS`。

## 0.102.0（2026-11-03）

### N10：会话作用域兜底（修「插件在跑但永远 no-hit」）
- 根因：`session.cwd` 可能落在 `$DSH_HOME/profiles/...`，`scopeKeyFromPath` 得到没有棋谱的假作用域，walk 全被作用域闸挡掉。
- 两级兜底：① 本会话历史 episode 的 scopeKey；② 新会话读 `session.v4.jsonl.zstd` 第一帧 header 的真实 cwd。
- 心跳新增 `scope` / `scopeFrom` 字段，便于线上核对；兜底失败保持原样（不乱猜）。
- 实测：真实 session id → `episode-fallback` 命中 `w:d:/…/长期记忆系统`；同一信号在该作用域下命中 4–5 条、在 profile 作用域下 0 条。
- 4 条单测；证据 `evidence/M7-N10-scope-fallback.md`。

### 验证
412 条测试（408 pass / 0 fail / 4 skip）；`check PASS`。

## 0.101.0（2026-11-03）

### A3 状态：not-live → live-idle（插件已在宿主里跑）
- `memory-context/live-stats.jsonl` 出现并持续增长：1484 行（20:09–20:40），src=index.js（宿主加载器）。
- 动作全是 skip（no-signal 1428 · no-hit 56）：**还没有一次真正的注入尝试**。
- 存储完整性：`cli verify` OK（5485 文件 / 0 错误）；store 267 局 / 761 claim（宿主内 autoArchive 已归档）。
- `m5` 的 A3 改为消费心跳：有心跳 → `live-idle`（value=null）；出现 inject/failed 才 `live` 并计算失败率。
- 证据 `evidence/M7-A3-live.md`。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.100.0（2026-11-03）

### 对标文档刷新到今天的实测
- `docs/对标-Hindsight.md` §4.5 重写：A1 0%（覆盖 26/26）、A2 LOO 25.3% / holdout 24.2% / A2b 严格 89.5%（分桶 multiHop 15/15、openDomain 2/4）、
  A4 真实注入 p50 22.4ms / p95 32.9ms（Hindsight 4,715ms）、A5 越界 0、A6 100%、**A3 not-live**。
- 两条边界写死：① A2b 天花板由 A5 决定（N9 已验证作用域对齐时能取到真实失败原文，Q18 是开关）；
  ② A1 的 0% 是"被闸拦下"的 0%（26 条候选全部过闸判定），不是"没有负面候选"。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.99.0（2026-11-03）

### 知识库：调研 29 MemGPT
- [外] virtual context management：主上下文 + 外部存储分层、中断控制流、模型可编辑自身记忆。
- 对照：分层与我们"日志永不删 + 少量注入"同构；**模型自编辑记忆被本仓边界禁止**；
  中断点我们只使用宿主给的 `agent/pre-step`，不自造控制流。
- 两条可复用：分层省 token（token p50 ~248）；中断点必须来自宿主。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.98.1（2026-11-03）

### 装前预检 `scripts/preflight-bundle.mjs`（只读）
- 按 DSH 真实规则核对：bundles 每个包**声明了**哪些 patch、会插入哪些 id、这些 id 是否被 profile 的 patch 禁用。
- 真实 home 实测：`id=kifu-memory name=kifu-loader` 被正确插入，`PASS`。
- 只对本项目相关 bundle 判失败（其他插件被禁用是主人的选择，仅展示）。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.98.0（2026-11-03）

### 安装真相：bundle 必须自己声明 `dsh.bundle.patch`（否则宿主不读它的 patch）
- 从 DSH 实现里确认：`dsh.profile.bundles` 的每一项，宿主只读它在 package.json 里**声明**的 patch
  （`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`），不是"包里有文件就会读"。
- 因此 0.89 的别名包只进 bundles 没有声明 → 宿主什么都没插；profile 里两块 disabled 依旧生效。
- 修：`packages/kifu-loader` ① 自带 `cordis.patch.yml`（insert id `kifu-memory`、name `kifu-loader`）；
  ② package.json 声明 `dsh.bundle.patch`；③ 导出 `./cordis.patch.yml`。
- 生效判据不变：重启后 `live-stats.jsonl` 出现行。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.97.0（2026-11-03）

### N9 接线：按签名追回历史失败原文（只追加、受 A5 约束）
- `buildMemoryCard` 命中签名时追加索引条目（原文 + episode/seq/occurredAt），每信号 ≤2 条，不替换既有 claim。
- 归档成功后自动重建签名索引（失败只记一行，不影响归档）。
- 作用域对齐时实测：卡片第一行就是那条真实失败（`ep-8cc34e32, seq 7148`）。
- 现行 A5 下六轴不变：hit 19/19 · 严格 17/19 · 可读 17/19 · A1=0 · A5=0 · A4 4.5ms。
- **结论：A2b 89.5% 的天花板来自 A5（同作用域）而非检索**；Q18=B 才会看到提升。
- 证据 `evidence/M7-N9-verified.md`。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.96.0（2026-11-03）

### N9 第一步：签名索引（历史失败原文可检索）
- 新增 `src/rooms/sigindex.mjs`（读写索引、按时间倒序 lookup）+ `scripts/build-sigindex.mjs`（从棋谱边重建）。
- 真实库实测：**93 局 / 28,135 边 / 628 条失败原文 / 172 个签名**，索引落在 `<store>/signature-index.json`（派生、可重建）。
- 设计文档 `docs/N9-签名索引-设计.md`：注入侧下一步改为"按签名追加原文条目"，不替换现有 claim（N8 教训）。
- 3 条单测（写读/版本不符/lookup 排序与 limit）。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.95.0（2026-11-03）

### N8 否决（两版）+ 新增"卡片可读性"口径
- 实验一（类别不同就换 episode 条目）：严格 17→7（36.8%），大倒退，否决。
- 实验二（判别词 <2 时追加 episode 行）：指标全同基线，但追加的行与 claim 文本完全重复，只多烧 token，否决。
- 根因：walk 按**类别**召回，拿不到"该先例局里那条具体失败原文"；真修需检索层按**签名**匹配（记作 N9）。
- 代码已全部回滚；新增 `recallReadable`（卡片正文含签名 ≥2 判别词）= **17/19**，作为 N9 对照基线。
- 证据 `evidence/M7-N8-rejected.md`。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；inject 29 条全绿；`check PASS`。

## 0.94.0（2026-11-03）

### N7 否决：类级 claim 补"变体行" 对 A2b 严格 0 增益
- 用全量新建库（245 局 / 667 claim）对照：严格仍 **17/19**、hit 19/19、分桶不变（multiHop 15/15、openDomain 2/4）。
- 原因：两条失分的覆盖 claim 来自**别的类别**，同组变体救不到；要改的是严格口径的判定对象，不是产品。
- 代码已回滚；负结果入账 `evidence/M7-N7-rejected.md`，后续不再尝试这条路。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；18 条 claim 单测全绿；`check PASS`。

## 0.93.0（2026-11-03）

### A2b 诊断字段 + 两条失分归因（度量假象，不是召回失败）
- m5 的 A2b 采样新增 `hitByClaim / bestOverlap / bestText`，分桶也带 `hitByClaim`。
- 19 条冻结卷：hit 19/19、hitByClaim 19/19、严格 17/19。两条失分的覆盖 claim 文本来自**同局另一类错误的代表行**，
  判别词重合 1 和 0 —— 是"类级代表性文本"的度量假象。
- 结论：**不要**为这两条改排序、也不该指望 Q18=B 来救；真修需要扩展 claim 变体文本 + 重建归档，列入待评估不做。
- 证据 `evidence/M7-a2b-strict-artifact.md`。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；`check PASS`。

## 0.92.0（2026-11-03）

### A2b 分桶：失分全部在 openDomain（跨工作区）
- 按 LOCOMO 四类做机械分桶（temporal > multiHop > openDomain > singleHop），复算 19 条冻结卷：
  **multiHop 15/15 严格**、**openDomain 2/4 严格**（hit 4/4）；singleHop/temporal 本卷无样本。
- 结论：89.5% 的失分不是"普遍召回差"，而是跨工作区先例的**判别词没带出来**；Q18 若开 B，受益的正是这 2 条。
- 不改行为；证据 `evidence/M7-a2b-buckets.md`；m5 报告里新增「分桶（严格）」一行。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；`check PASS`。

## 0.91.0（2026-11-03）

### 知识库：调研 28 Mem0（生产级长期记忆）
- [外] 抽取→整合→检索；LOCOMO 四类问题（single-hop/temporal/multi-hop/open-domain）；相对 OpenAI 记忆 LLM-as-a-Judge +26%，图记忆再 +2%；对比全上下文 p95 延迟 −91%、token −90%。
- 对照：他们允许 ADD/UPDATE/DELETE，我们只增不改 + `supersededBy`（同样问题的两种解法，差异来自边界）；图记忆与我们 link 同构。
- 可复用：①"整合"是价值核心；②评测按 LOCOMO 四类分桶重算 A2b（已有冻结卷可扩展）。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；`check PASS`。

## 0.90.0（2026-11-03）

### doctor 识别别名包 + 文档对齐
- `install-doctor` 现在把 `kifu-loader` 别名视为启用；并在检测到历史 `disabled:true` 时补一条说明「不影响别名包，可忽略」。
- 新增单测：别名在依赖里 ⇒ 计为启用。
- `docs/安装指南.md` 顶部写明**当前安装方式 = kifu-loader，重启一次即生效**；`docs/交付清单.md` §2 同步改写（含回滚路径）。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；`check PASS`。

## 0.89.0（2026-11-03）

### 安装：别名包 `kifu-loader`（不改热重载开关就能启用）
- 历史遗留的两个 `disabled: true` 块会压过 bundle 列表，导致同名包永不加载；改 patch 又必须 DSH 关闭。
- 新增 `packages/kifu-loader`：只是把 `src/plugin.mjs` 原样再导出一次，profile 注册的是 `kifu-loader`（不在任何禁用名单里）。
- profile 侧：依赖 + bundles 增加 `kifu-loader`，移除原来的 `dsh-gokifu-longmemory` bundle（依赖保留），`pnpm install` 完成。
- 预检：导入成功、`apply` 注册 `agent/pre-step` + `agent/turn-stopping`、真实库无报错。

### 对比方案
- 直接改 patch：需 DSH 全程关闭 + 有热重载风险（本机事故历史）；
- 别名包：只改 profile 的 `package.json`（非热重载开关），重启一次即生效，失败可整包移除回滚。

### 验证
405 条测试（401 pass / 0 fail / 4 skip）；`check PASS`。

## 0.88.0（2026-11-03）

### 安全版 re-enable：失败也炸不了 DSH
- **运行中拒绝**：检测到 `DeepSeek Harness.exe` 在跑就退出（exit 2），一个字节都不写——这是唯一会炸 DSH 的路径。
- **先算后写**：JSON 解析、patch 结构校验（块数按条目计、无残留禁用块、结尾换行）全部在写盘前完成；不过就中止。
- **原子写 + 备份**：临时文件 + rename；写前备份 `*.bak-reenable-<ts>`。
- **写后读回校验**；**pnpm 失败自动回滚**（patch 与 package.json 恢复原样），并打印"已回滚，DSH 不受影响"。
- 依赖已就绪则跳过 pnpm（关掉到重开只需数秒）。
- `开启长期记忆.cmd` 改为按退出码显示三态：成功 / DSH 仍在运行（未改动）/ 失败已回滚。

### 实测（假 home）
| 场景 | 结果 |
|---|---|
| DSH 运行中（真实 home） | 拒绝，未写任何文件 |
| 正常（假 home，--force） | 摘除 2 块 + 1 注释，其它块原样，依赖/bundle 补上 |
| package.json 坏 JSON | 写前中止，patch md5 不变 |
| pnpm 强制失败 | 回滚成功：patch 恢复 6 条禁用、依赖回到未装 |

### 验证
405 条测试（401 pass / 0 fail / 4 skip）；`check PASS`。

## 0.87.0（2026-11-03）

### 零命令行启用：关掉 DSH 就自动装好
- 新增 `scripts/enable-on-exit.mjs`：后台常驻，轮询 `DeepSeek Harness.exe`；连续两轮不存在（DSH 已退出）后自动跑 `re-enable`，
  写完配置再跑一次 `install-doctor` 并记日志（`evidence/enable-on-exit.log`）。
- `re-enable` 增"依赖已就绪则跳过 pnpm install"：预置依赖后，关掉到重开的窗口从 ~30s 压到**几秒**。
- 用户侧零命令：预置依赖 → 关掉 DSH → 等 5–10 秒 → 重新打开。

### 验证
`re-enable --dry-run`：`bundle: 已有 · 摘除 3 条 · package.json 将改: false`；404 条测试全绿。

## 0.86.0（2026-11-03）

### 修正：`install-doctor` 的"已注册"是假阳性（你看到 `ok 插件注册` 但插件其实没启用）
- 两个根因：① 把 `storages/schedule.json` 也算注册（定时任务提示词里恰好含包名）；② patch 按块解析时把**注释行**吞进上一个块，
  注释里提到包名 → 被算成"启用 1 处"。
- 现在只看 profile 的 `cordis.patch.yml` / `cordis.yml` / `package.json`；注释作为块边界；只有**非 disabled 块或依赖/bundles**才算启用。
- 当前真实输出：`FAIL 插件注册（启用，而非仅出现） · 启用 0 处 · 禁用 2 处（只有禁用块 ⇒ 还没跑 re-enable）`。
- 新增 4 条单测（只剩禁用块 / 注释不算 / 依赖算 / 没有注册）。

### 验证
404 条测试（400 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.85.0（2026-11-03）

### D5 真实触发率测量：低频安全网，不是主收益
- 在 19 个"含同类错误文本"的会话、114 步上回放：**D5 触发 0 次**（按生产触发条件：行需 `Error:` 开头或含 exit code，且归入 8 类）。
- 口径限制写清：只用了**用户消息**，真实宿主 payload 含 tool 结果，因此本测量**低估**；不能说 D5 无用，也不能说有效。
- 正确姿态：D5 是低频安全网；装到宿主后先用 `repeat-report` 看真实触发率再调参。
- 证据 `evidence/M7-D5-real-rate.md`。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.84.0（2026-11-03）

### 容量观察：注入延迟随语料近似线性（117→167 局）
- 02:15：117 局/322 claim，注入 p50 15.1ms / p95 20.1ms（39 局回放）。
- 12:23：167 局/533 claim，注入 p50 **22.4ms** / p95 **32.9ms**（12 局回放）。
- claim ×1.65 ⇒ p50 ×1.48、p95 ×1.64，**近似线性**；仍远低于 A4 门槛（p95 ≤50ms）与 Hindsight（p50 4,715ms）。
- 外推：p95 触到 50ms 约在 800–1,000 claim；触发条件写明（连续两次 p95>40ms 再考虑索引）。
- 证据 `evidence/M7-latency-vs-corpus.md`。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.83.0（2026-11-03）

### 知识库：调研 27 Zep（时序知识图）
- [外] Graphiti 双时态知识图；DMR 94.8% vs MemGPT 93.4%；LongMemEval 准确率 +18.5%、延迟 −90%。
- 对照：双时态与我们 `validFrom/validTo` 同构（且我们有 validityOk 探针）；他们用 LLM 抽实体、我们机械抽取；单一来源是本项目刻意收窄。
- 结论：无新机制，但提供了外部证据——**时序是一等属性**，与"只增不改"的方向一致。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.82.0（2026-11-03）

### 交付清单 `docs/交付清单.md`（一页交接）
- 装法（一条命令 + 回滚）、六轴现状（含真实/合成两个口径）、关键证据索引、还差什么、常用命令。
- 目的：接手者在 1 分钟内知道"拿到了什么、怎么验、还差哪一步"。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.81.1（2026-11-03）

### 发版重试：GitHub API 间歇故障下的自愈
- 今天 API 多次 502/503，`gh release create` 失败会中断发版流程、且错误输出被吞成半截 JSON。
- `release.mjs` 现在对创建 Release **重试 5 次**（15s×n 退避），每次都打印可读错误；
  全失败时明确说"tag 已推、Release 未建"并给出可复制的补救命令，而不是抛栈。
- 发版链路其余部分（check → ledger → tag → push）保持原样。

### 验证
403 条测试（399 pass / 0 fail / 4 skip）。

## 0.81.0（2026-11-03）

### 知识库：调研 26 Reflexion
- [外] 言语反思进情景缓冲、下次决策读取；HumanEval pass@1 91%（当时 GPT-4 80%）。
- 对照结论：结构同构（失败教训→claim→注入），但**反思来源相反**——我们用机械抽取（可回放），它用模型生成（可能总结错）。
- 可复用的一条：**反思必须回到下一次决策**；我们的对应物是 D5（0.68.0 已收口，有闸内单测）。

### 文档更正：本插件没有"设置页 UI"
- 核对代码：`src/` 无 client 入口、`plugin.mjs` 无 settings 注册 ⇒ **只有 HTTP 配置路由 + 命令行**。
- 修正 `docs/安装指南.md` 验证第 2 条（改为 `live-stats` 心跳 / `cli stats` 局数）；证据 `evidence/M7-settings-ui-truth.md`。
- 装没装的唯一判据收敛为：**`live-stats.jsonl` 有没有行**。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.80.0（2026-11-03）

### 知识库：调研 25（LLM Agent 记忆机制综述）
- 综述给出了"来源 / 形式 / 操作 / 评估"四问骨架；逐条对照：我们四问**闭合**，且评估比综述的"主观/任务级"更硬（六轴 + 冻结卷 + 安慰剂）。
- 两处**刻意偏离**并写明依据：① 不用时间衰减/容量淘汰（红线：原件永不删，改用有效期 + stale 遮蔽）；② 不做多模态（纯文本工作区）。
- 结论：无新机制，可当检查清单用。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.79.1（2026-11-03）

### 台账时点窗口 20 分钟 → 6 小时（发版流程自锁的修复）
- 20 分钟窗口在"PR → required check → 合并"这段排队里必然过期，导致刚一合并就发不出版（今天实测卡住 0.79.0 两次）。
- 真正的护栏是**数字一致性**（`compare` 逐项比对局数/A2/A4/测试数），时点只负责抓"改完大事忘了 sync"；6 小时足够，且不会被流程本身卡死。
- 单测改用 10 小时前的时点断言"过旧"，2 小时前视为新鲜。

### 验证
6 条 ledger-check 单测全绿。

## 0.79.0（2026-11-03）

### A3 心跳：`live-stats.jsonl`（插件真的在宿主里跑过的证据）
- 每走完一次 pre-step 决策，向 `<sidecar>/live-stats.jsonl` 追加一行：`{at, action, reason, digest, tokens, shadow}`。
- 用途：**装了之后不用猜**——文件里有行 = 插件在真宿主里跑过；没有行 = 没加载或 `liveStats:false`。
- 默认开（`liveStats: true`），库不存在时不创建目录、不写心跳；仿真脚本（host-sim / replay-live）显式 `liveStats:false`，避免污染证据。
- 新增 `scripts/live-stats.mjs` 汇总（动作分布/原因/tokens p50·p95/最近 N 行）；`status-digest` 增加「A3 心跳」一行。
- 新增单测：默认写、关掉不写。

### 验证
403 条测试（399 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.78.0（2026-11-03）

### 一键开启脚本 `开启长期记忆.cmd`
- 双击即用：先提示「把 DSH 完全关掉」，再执行 `node scripts/re-enable.mjs`（自动备份 patch/package.json）。
- 解决的真实问题：主人重启 DSH ≠ 启用插件——**只重启不会加载它**，必须先跑 re-enable。
- **实测过两个致命 bug 并修掉**：① `cd /d "%~dp0"` 尾反斜杠把引号转义 → 改为 `"%~dp0."`；
  ② GBK 写入时 `scripts
e-enable.mjs` 里的 `
` 被当成回车 → 全改成正斜杠。
- 假 home 实测：摘除 3 条禁用、依赖补齐、`dsh-gokifu-longmemory` 在 patch 中归零。
- `re-enable` 增 **no-op 路径**：已是启用状态时不再重写 patch/package.json（避免重复备份噪音）。
- `docs/runbook-装完之后.md` §1 增加懒人路径。

### 验证
脚本已随仓库提交；`re-enable --dry-run` 仍报「摘除 3 条 · patch 将改 true」。

## 0.77.3（2026-11-03）

### 归档幂等性实测（真实库，连续三次）
- 第 1 次：`claims 322→533`、`episodes 117→167`——不是失真，而是**补齐了"当时没有 header"的会话**（审计子代理写完才有 header）。
- 第 2 次：+24（两次运行之间新产生的会话）、8 个活跃 episode 变大。
- 第 3 次：**0 新增**，仅 3 个活跃 episode 变大；claims/topics/links/threads/joseki 全同。
- 判据写进 `AGENTS.md` §5 陷阱 15 + `evidence/M7-archive-idempotent.md`：已封存数据重跑零变化，活跃会话会继续长。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`（语料已按新库刷新）。

## 0.77.2（2026-11-03）

### Runbook：装完之后按这个顺序跑（`docs/runbook-装完之后.md`）
- 六节：① 安装三步（人做）② 验收（doctor 的期望输出）③ 出第一份线上证据（m5/first-live/repeat/digest）
  ④ 日常巡检 ⑤ **回滚**（用 re-enable 的备份，不手改 patch）⑥ 已知正常现象（warn=5、exists:false、A3 not-live 等）。
- 每步都带**期望输出**，避免"装完不知道对不对"。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.77.1（2026-11-03）

### 冷启动演练 + 两处误报修正
- `status-digest`：无 store 时把 `ledger`/`guard` 标为 **N/A（无 store）**（此前误报 FAIL）。
- `install-doctor`：热路径抽测在"库不存在"时注明 `warn 为预期（插件沉默）`（此前 warn=5 看起来像故障）。
- 演练：空 home 上跑 digest/doctor **不崩**、不误报；"插件注册/记忆库内容"两项 FAIL 属于安装前的正常状态。
- 证据 `evidence/M7-cold-start.md`。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.77.0（2026-11-03）

### 一页状态摘要 `scripts/status-digest.mjs`
- 一条命令汇总：版本/git → **三道质量门**（check / ledger-check / metrics-guard）→ 六轴 → 安装状态（install-doctor）
  → **真实会话回放**（注入/沉默/跨作用域/p50·p95）→ 待决问题。
- `--write <path>` 可直接落盘（如 `evidence/status-digest.md`）；`--json` 供脚本消费。
- 工具会**复原 metrics-guard 的副作用**（`git checkout -- evidence/metrics-guard.json`），不污染工作树。
- 用途：以后巡检不用手工拼状态；也方便主人一眼看到"现在到底怎么样"。

### 验证
`node scripts/status-digest.mjs` 实跑：check/ledger/guard 全 PASS、六轴在、回放 12 局注入 12、跨作用域 0；
402 条测试全绿；`ledger-check --full PASS`。

## 0.76.1（2026-11-03）

### 调研索引 `docs/调研/00-索引与机制对照.md`
- 一页打通 01–24：按**机制**汇总（谁提出 → 我们的决定 → 依据文件），按**系统**逐篇列出取舍。
- 三条被反复验证的结论：评估必须在链路里、多层抽象要么模型要么机械拼、1 条样本差异不是证据。
- 用途：接手 agent 先读这一页，避免重复调研已否决的机制。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.76.0（2026-11-03）

### 冻结考噪声底：三次「看起来能涨」的实验全被安慰剂打掉
- N6 查询扩展（+1/+1）→ 随机主题词也 +1；
- N3 命中重排（不变）→ 随机重排也不变；
- **D2 细化三条类规则（+1/+1）→ 把同类信号映射到无关类，结果一模一样**。
- 结论：19 条样本 **±1 条 = ±5.3pp 的噪声底**；只有「真实改动 > 安慰剂最好一次」才算证据，1 条差异一律记噪声。
- 产品代码零变化（类规则已回退）；证据 `evidence/M7-noise-floor.md`，实验脚本 `exp-n3.mjs`/`exp-n6.mjs` 保留可复现。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.75.2（2026-11-03）

### N3-lite 否决：重排命中不是杠杆
- 新增 `scripts/exp-n3.mjs`：把 `walk.hits` 按 claim 支撑局数重排，再交给卡片；安慰剂 = 随机重排（8 种子）。
- 两卷结果**完全不变**（84.2% / 75.0%，tokens 一致）——卡片按 marker 优先级与时间选条目，命中顺序不影响入选集合。
- 判定 **reject**；证据 `evidence/M7-N3-rejected.md`。要动排序就得动排序函数本身，需单独对照。

### 候选池
N2 暂缓 · **N3 否决** · **N4 否决** · N5 未试 · **N6 否决**。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.75.1（2026-11-03）

### N4 否决：卷级降级没有消费者
- 39 局真实会话回放：**零注入 0/39**（注入 39、跨作用域 0、p50 15.1ms/p95 20.1ms、溯源引用 158）。
- 既然"空卡"在真实语料里不出现，N4 的降级路径永远走不到 ⇒ 按"指标先有消费者"否决；重开判据：零注入率 > 5%。
- 附带观察：2/39 首刀被 `gate4/unsuperseded-duplicate` 拒绝（闸按设计工作），说明"重复 claim 未标 supersede"是真实形态。
- 证据 `evidence/M7-N4-rejected.md`；`replay-live` 增 `warnSamples`（以后能看到闸拒绝原因）。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.75.0（2026-11-03）

### A2b 回归线（防"慢慢烂掉"）
- `metrics-guard` 除绝对下限 `0.55` 外，新增**相对冻结基线**的回归线：`strict < 0.8421 − 10pp` 即 FAIL，理由写明掉点。
- 依据：19 条样本 1 条 = 5.3pp，10pp ≈ 2 条，低于此算波动。
- 新增单测：持平 PASS、−8pp PASS、−14pp FAIL；证据 `evidence/M7-a2b-regression-guard.md`。

### 验证
402 条测试（398 pass / 0 fail / 4 skip）；`check PASS`；`metrics-guard PASS`；`ledger-check --full PASS`。

## 0.74.2（2026-11-03）

### 发版工具健壮性：`gh release create` 失败时的可诊断兜底
- 0.74.1 首次发版时 `gh release create` 失败（tag 已推、Release 未建），错误被吞成半截输出。
- `release.mjs` 现在：① 捕获 stderr 并打印；② 用 `--notes` 内联正文**重试一次**。
- 0.74.1 的 Release 已手动补建（`gh release create v0.74.1 --notes-file …`）。

### 验证
`check PASS`；401 条测试全绿；本版发布用于验证兜底路径。

## 0.74.1（2026-11-03）

### 调研清单漂移修复 + 守卫
- `MAINTENANCE.md` 知识库清单只列到 `19-HippoRAG`，实际已有 **24 篇**（20-RAPTOR/21-CRAG/22-LongMemEval/23-Self-RAG/24-MemoRAG 漏列）。
- `check.mjs` 新增守卫：**docs/调研 下每个编号都必须在 MAINTENANCE 或 AGENTS 里被提到**，缺一个就红（防止"写了调研却没进台账"）。

### 验证
检查器输出 `调研清单 24 篇`；401 条测试全绿；`ledger-check --full PASS`。

## 0.74.0（2026-11-03）

### N6 否决：机械查询扩展赢不过安慰剂
- 新增 `scripts/exp-n6.mjs`：只改信号扩展词，其余不变，跑 A2b 主考卷/跨卷，并自带 `--shuffle` 安慰剂。
- 结果：主考卷严格 84.2%→89.5%（+1）、跨卷 75.0%→83.3%（+1）、tokens 基本不变——**但随机扩展词也能涨 1 条**（3 次里 1 次）。
- 判定 **reject**：涨的那条是 `sed` 报错，strict 取决于"哪条覆盖 claim 恰好进卡"，可被任何扰动翻转。
- 证据 `evidence/M7-N6-rejected.md`；方法论：**先跑赢安慰剂，再谈优化**。

### 验证
401 条测试（397 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.73.1（2026-11-03）

### 知识库
- `docs/调研/24-MemoRAG`：全局记忆 + 草稿线索 + KV 压缩记忆 + RLGF 反馈；对照结论——
  `index.md` 只做存在性提示、**未参与 walk 起跳**，是结构上可对照的差距；记候选 **N6（机械版查询扩展）**，需 A2b 对照。
- 明确不做的部分：KV 压缩（压缩插件本职）、模型训练/RLGF。

### 验证
401 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.73.0（2026-11-03）

### Q19-B 预置：`preferenceHardOnly` 开关（默认关）
- `buildMemoryCard` 增 `preferenceHardOnly`：true 时丢弃 `soft` 偏好（理由句/闲聊），保留 `hard` 约束；默认 false ⇒ 行为不变。
- 插件配置同名键 + 归一化 + 透传；Q19 裁定为 B 时把默认值翻成 true 即可。
- **顺手修一个真 bug**：`storeView` 投影 claim 时丢掉了 `level` 字段，导致 hard/soft 分流永远拿不到值（写测试时发现）。

### 实测
- 401 条测试（397 pass / 0 fail / 4 skip）；新增「flag 开/关」对照用例。
- 12 局真实会话首条消息：开与不开**结果一致**（没命中 soft 偏好）⇒ 暂无可观测差异，如实记录在 `evidence/M7-preference-hard-flag.md`。

## 0.72.0（2026-11-03）

### 偏好类注入的噪声测量（不夹带改动）
- 本机库 322 条 claim 中 `preference` 110 条，其中 **40 条（36.4%）含祈使/指令词**；
  `antipattern` 仅 4/186、`fact` 0/26。
- 真实卡片里可见"理由句 / 闲聊 / 文档加粗语法"被当成偏好抽进来；且同一批偏好被反复复述。
- 证据 `evidence/M7-preference-noise.md`：给三个选项（维持 / 收紧到 hard / 降级为指针），**默认建议 B**。
- **本轮不改代码**：偏好语义属产品方向，需主人裁定（Q19）。

### 验证
400 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.71.0（2026-11-03）

### A4 的真实口径：注入路径 p50 18.3ms / p95 36.8ms（12 局真实会话）
- `replay-live` 新增 `injectionLatencyMs`：只统计每局第一刀（真正走 walk→card→gates），
  不再被 `oncePerSession` 短路稀释。
- 对照：bench-inject 合成 ≈2ms；Hindsight 本机 p50 **4,715ms** / p90 8,329ms ⇒ 我们仍快 ≈258×。
- 证据 `evidence/M7-latency-real.md`。

### 一次被证否的优化（已回退）
- 曾给 `persist` 加 mtime 解析缓存、给插件加 5s store 缓存；A/B 显示注入路径 p50 16.5→15.6ms（噪声内）、
  p95 31.2→51.8ms（更差）。真实注入是按 key 定点查，不是全量 list ⇒ **两处缓存全部回退，代码净变化为零**。

### 验证
400 条测试（396 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.70.0（2026-11-03）

### 新增 `scripts/replay-live.mjs`：真实会话回放（A3 的「准线上」证据）
- 取**最近 N 局真实会话**的日志（逐帧解），把首条用户消息按真实 `session.cwd` 喂给**真实插件入口**，
  走真实 store 的 walk/card/gates——不是合成信号。
- 统计：注入/沉默、延迟、**溯源引用数**、**跨作用域引用率**。
- 实测（12 局）：**注入 12 / 沉默 0 / warn 0**；p50 9.2ms、p95 18.9ms；溯源引用 54 条、**跨作用域 0 条（0.00%）**。
- 证据 `evidence/M7-replay-live.md`；单测覆盖 `cwdFromScope`（scopeKey→盘符路径）。

### 说明
A3 仍是 `not-live`（插件未被真实加载过）；本次是"真实语料 + 真实代码"的最强离线证据，
它的价值是：**跨作用域 0** 这次是在真会话上测出来的，不只是合成样本。

### 验证
400 条测试（396 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.69.1（2026-11-03）

### 知识库
- `docs/调研/23-Self-RAG`：按需检索 + 反思 token（ISREL/ISSUP/ISUSE）；对照结论——我们的「十道闸 + 不命中零注入」
  就是**不训练版的反思机制**，且多了可单测与可复核。
- 可引用结论：「检索系统的质量上限，取决于它怎么处理"不该检索"和"检索错了"」。

### 验证
399 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.69.0（2026-11-03）

### A1 不再空转：把「被闸拦下」也算锻炼（口径修正）
- 根因：`walk` 在生成卡片前就丢弃 `validityOk=false` 的 claim，而 H1 只把"渲染出来的"算覆盖 ⇒ 防护越早，覆盖越像 0。
- `runH1` 增 `exercised`（渲染 + 被闸拦下）；`validityCoverage.ratio = exercised / withValidity`；
  `m5` 的 `vacuous` 改为 `exercised === 0`，caveat 区分「没考 / 全被闸拦 / 部分渲染」三态。
- 实测：A1 仍 0%，但 **vacuous=false、覆盖 26/26、0% 被解释为"闸有效"**；注入行为未改。
- 证据 `evidence/M7-A1-exercised.md`；单测新增「闸拦也算锻炼」一例。

### 验证
399 条测试（395 pass / 0 fail / 4 skip；新增断言并入既有用例）；`check PASS`；`ledger-check --full PASS`。

## 0.68.0（2026-11-02）

### D5 收口（目标 ④：同类失败 ≥2 次补一次事实卡）
- 新增单测「**D5: 闸不通过 ⇒ 不补卡**」：证明 D5 走的是与首轮同一套十道闸，不会强塞。
- 证据汇总 `evidence/M7-D5-complete.md`：触发机械性、真注入、闸拦截、无祈使句、遥测四件套、对六轴无影响。

### 验证
399 条测试（395 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.67.0（2026-11-02）

### 安装彩排：在假 home 上跑通 re-enable 全链路
- 复制真实 profile 到 `tmp/rehearse-home/`，跑 `re-enable`（dry-run + 实跑）与 `install-doctor`：
  摘除 3 条禁用、补 `link:` 依赖、补 bundle、生成两份备份；复制体 patch 不再含本包。
- `install-doctor`：`ok 插件注册（未见 disabled）`、`ok 设置接口 GET status=200`（无 store 时 `exists:false`，符合零配置预期）。
- **真实 home 全程未被改动**（patch 4 处包名 / 6 条 disabled / 无依赖，三项逐条核对）。
- 证据：`evidence/M7-reenable-rehearsal.md`。

### 验证
398 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.66.0（2026-11-02）

### 知识库
- `docs/调研/22-LongMemEval`：五种长期记忆能力（抽取/多会话推理/时序/知识更新/**拒答**）与三阶段（索引/检索/阅读）。
- 对照结论：我们五种能力都在（知识更新半覆盖：`supersedes` 尚无生产者）；**"拒答=不命中就沉默"与基准口径一致**。
- 新增候选 **N5 事实增强键扩展**（需先用冻结集做离线对照，0.44 的关键词摘要实验已证明"直接改文本"无效）。

### 台账
- `MAINTENANCE.md` 下一步补「安装闸」状态：六轮审计收敛到活文档 10/10，安装三步与 Q18 是唯二未决项。

### 验证
398 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.65.1（2026-11-02）

### 测试口径修正 + 知识库
- `test/extract.test.mjs`、`test/graphread.test.mjs` 里 4 条"真实样本"测试改名为「**固定样本（未入库则跳过）**」，
  skip 时带原因（不再让人误以为"真实语料回归已跑过"）。这是 audit P2-5 的低成本处理；是否固化样本另议。
- `docs/调研/21-CRAG`：检索评估器 + 置信度降级 + decompose/recompose；对照结论——我们的「十道闸」就是机械版评估器，
  **不引入模型打分、不联网兜底**。

### 验证
398 条测试（394 pass / 0 fail / 4 skip，skip 原因已显式化）；`check PASS`。

## 0.65.0（2026-11-02）

### 新增 `scripts/boundary-audit.mjs`（边界静态审计，补 P2-8）
- 只扫**模型可见面**（`inject.mjs` 渲染 + `plugin.mjs` 消息构造）的字符串/模板字面量；
  剥注释、排除检测清单自身；命中即 exit 1。
- **接进 `check.mjs`**：PR 阶段就拦"往模板里写指令句"。
- 与运行时闸（`gates.mjs`）分工：静态管源码字面量，运行时管动态拼接与数据。

### 验证
398 条测试（394 pass / 0 fail / 4 skip）；`check PASS`（含 boundary-audit 0 处）；证据 `evidence/M7-boundary-audit.md`。

## 0.64.0（2026-11-02）

### audit-06：活文档随机 10 条 **10/10**（口径：排除 reports/** 与 docs/调研/**）
- 10 条陈述全部实跑复现：`cli dump`、delta 坏尾处理、`ledger-check` 条数一致、六轴判据三处同口径、
  A1 边界（0.04/0.05 通过、0.06 失败）、S13 候选数、`re-enable` 摘除 3 条、发版闸 `--full`。
- 三条卫生提示已修：S13 补时点与现值（4 候选 11/5/3/3）、`evidence/M7-ledger-check.md` 去掉已删选项、
  `MAINTENANCE.md` 补「该行需重启才能实测」。

### 安装闸证据
- 新增 `evidence/M7-install-gate.md`：六轮审计收敛记录 + 当前可交付状态 + **仍未验证项**（A3 not-live、Q18 未裁定、3 条 P2 候选）。

### 验证
394 条测试（390 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.63.0（2026-11-02）

### audit-05（第二轮随机 10 条实测，9/10）与其修复
- 唯一 FAIL 是**引用失效**而非事实失真：`reports/audit-03.md` 用裸行号引用 `ledger-check.mjs`，0.61.0 加 `--full` 后整片下移。
- 新增引用规范（`AGENTS.md` §2.4）：**文档/PR 引用代码一律「文件 + 符号名」，不写裸行号**；`reports/引用漂移说明.md` 记录本次漂移，历史审计报告不改。
- 纠正命名漂移：`AGENTS.md` §4.9 的 `fromJSON` 在仓内不存在，改为实际符号 `loadGraphAt`（对未知版本抛 `unsupported version`）。

### 知识库
- `docs/调研/20-RAPTOR`（递归摘要树）：我们只有**机械两层**（claim/棋谱 → 卷 headline），明确拒绝模型摘要与 embedding；「卷级降级」记为 N4 候选（需 A2b + token 对照）。

### 验证
394 条测试（390 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.62.0（2026-11-02）

### audit-04（随机 10 条陈述实测，9/10）修复
- `方案.md` §8.2c「当前基线」改为**以命令为准**并写明实测时点：holdout **33.85%（22/65）**、117 局（原写 35.56%/16/45/116 局）。
- `方案.md` 三处「86 个会话日志」改为「数量以 `cli stats` 为准」（实测已 134）。
- `docs/安装指南.md` 不再写死版本与测试条数（原写 0.50.0 / 379 条），改为指向 `MAINTENANCE.md`。
- `ledger-check` 新增守卫：**安装指南里出现版本号或「N 条」即 FAIL**（这正是「按它安装」最先读到的文件）。

### 诚实说明
- A2 曾在审计中被判「确定性」，实测在 26.5–26.8% 间随 pipeline 时间窗微动，故台账核对保留 **0.5pp 容差**并在代码注释写明；A4 保留 3ms 容差（单次抖动 ±2ms）。

### 验证
394 条测试（390 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`；审计报告 `reports/audit-04.md` 入库。

## 0.61.0（2026-11-02）

### audit-03 复核修复：让「台账自证」真正闭环
- 新增 `scripts/ledger-sync.mjs`：用现场实测**生成**台账的「测试 / 六轴 / 语料」三行（研究值 + 真实时点），
  不再人工抄写（漂移之源）。
- `ledger-check` 加严：纳入**局数 / A2 / A4**（容差 0.5pp / 0.5ms）、`--full` 缺测点/时点>20 分钟/
  解析失败一律 FAIL（fail-closed）；测试计数从失败进程的 stdout 解析，不再当 n/a。
- `release.mjs` 发版闸改为 `ledger-check --full`，**去掉 `--no-ledger` 逃生门**。
- 修 `MAINTENANCE.md` §四仍写「私有仓库/不支持分支保护(403)」的陈旧段（与 public+ruleset 矛盾）。
- 计划表修正：T22 不再把 0.34 的「claim 类表对齐」记在 0.22–0.24；T36 区间收窄为调研 15–16；
  T38 改为「调研 17–18 + 三轮审计 + 台账自证」。已发布清单补 0.15.0/0.15.2/0.17.0–0.17.3。
- `AGENTS.md` §7 兜底加严：任何「数字+条」或版本号写回都会红（此前只挡「条测试」子串）。
- 删除 claim 测试里残留的 `if (sample)` 空转块。

### 验证
394 条测试（390 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.60.0（2026-11-02）

### 台账自证 `scripts/ledger-check.mjs`
- 把台账数字机械化核对：版本 / 测试（四个分量）/ claim / 卷，任一不一致退出 1；无 store 时跳过语料项并显式标注。
- 同时校验 `AGENTS.md` §7 仍是指针、`CHANGELOG.md` 有当前版本段。
- **接进发布流程**：`release.mjs` 打 tag 前先跑 `ledger-check --no-tests`，不一致中止（`--no-ledger` 可跳过）。

### 为什么现在做
audit-01 与 audit-02 两轮都因"文档写了不实数字"被判有条件通过。机械闸比"我记得更新"可靠。

### 验证
393 条测试（389 pass / 0 fail / 4 skip）；`ledger-check PASS`；证据 `evidence/M7-ledger-check.md`。

## 0.59.0（2026-11-02）

### 调研 19：HippoRAG（海马索引 + PPR）
- 知识图 + Personalized PageRank 模拟海马索引；多跳 QA 自报 +20%、单步检索比 IRCoT 便宜 10–30×、快 6–13×。
- 对照：我们的 topics/links/threads + walk 与之同构，**缺 PPR 全局扩散**；列为 **N3 候选**，
  前提是能用 A2b 严格 + hopPrecision 证明收益（当前 A2b 84.2%，无证据前不动排序）。

### audit-02 复核的修复
- **P1-3 死断言**：`check.mjs` 的 `\s` 在模板字符串里退化成 `s`，写回数字不会红。改成区间扫描（§7 出现「条测试」即失败），并做正反模拟验证。
- **P1-4 保护补强**：legacy protection 的 `required_pull_request_reviews=null` 不足以"需 PR"。新增 **ruleset**（pull_request + required_status_checks `rules` strict + 禁删除/强推），口径四处统一。
- **口径纠正**：26 条 `validFrom=null` 的 claim **都有 `occurredAt`**（旧代码未写该字段），此前写成"无 occurredAt"是错的；已改 CHANGELOG/契约/台账，并**披露归档会重写派生 claim 记录**。
- **测试补强**：删除 claim 测试里恒真的正则断言；给 `metrics-guard` 的 `a1Vacuous` 补单测（空转 vs 已覆盖）。

### 验证
389 条测试（385 pass / 0 fail / 4 skip）；`check PASS`；`metrics-guard PASS`。

## 0.58.0（2026-11-02）

### 独立审计 audit-01 的修复（有条件通过 → 处理 P1 全部 5 项）
- **P1-1** `validFrom` 真正落地（= `occurredAt`）；N1 空壳测试改成真断言。本机 322 条 claim 中 296 条有 `validFrom`，26 条 0.58 之前写入的历史条目（都有 `occurredAt`，旧代码未写该字段）不回溯改写。
- **P1-2** 新增 `representativeTextFor()`：建组与"更早支撑"共用，`class:` 前缀不再随输入顺序丢失；新增乱序一致性测试。
- **P1-3** `AGENTS.md` §7 的状态快照删除，改为「去哪看」指针；`check.mjs` 断言指针存在。
- **P1-4** 仓库口径统一为**公开**，并实际开启 `main` 保护：**ruleset**（pull_request + required check `rules` + 禁删除/强推；不做强制审批——单机单人无法自审）。
- **P1-5** `metrics-guard` 增 `a1Vacuous/a1Coverage`：A1=0 但 validity 覆盖 0 时显式标「空转」。

### P2 顺手修
- 巩固只吃 `kind=antipattern`；契约 §9 标注 `repeat` 派生、`threadIds`/`supersedes` 保留；台账数字带时间戳；
  门槛证据同步 0.55；删除 `DEFAULT_CONFIG` 重复键。

### 验证
388 条测试（384 pass / 0 fail / 4 skip）；`check: PASS`；`metrics-guard PASS`；审计报告入库 `reports/audit-01.md`。

## 0.57.0（2026-11-02）

### D5 影子遥测（开注入前就能观察）
- `shadow:true` 时 D5 也检测「同类失败 ≥2 次」，但**不注入**，只写 `repeat-hint.jsonl`（`shadow:true`）；
- 影子模式保证不改变 `messages`（单测断言）；遥测字段与正式一致。
- 用途：安装后先开影子跑一天，用 `repeat-report` 看"本来会补几次、哪些类"，再决定是否开真注入。

### 验证
385 条测试（381 pass / 0 fail / 4 skip）；`metrics-guard PASS`；证据 `evidence/M7-d5-shadow-telemetry.md`。

## 0.56.0（2026-11-02）

### 调研 18：CoALA（认知架构）+ 动作空间成文法
- `docs/调研/18-CoALA`：模块化记忆 / 结构化动作空间 / 决策过程；明确**工作记忆不归本仓**（属压缩插件）。
- `docs/记忆的职责边界.md` 新增「本仓的动作空间」表：检索、归档、纠错各做什么，以及
  **工作记忆管理 / 外部工具动作明确不做**——没有行 = 不归它。

### 验证
384 条测试全绿；`metrics-guard PASS`；只改文档。

## 0.55.0（2026-11-02）

### 调研 17：Hindsight 的实际机制（本机 skill 文档，非论文）
- 写出它的真实形态：每仓库一个 bank / commit seed + 代码库 survey + 对话摄入 / 首轮 LLM reflect /
  5 张固定知识页 / observations 作用域 / 失败降级链 / `Correction:` 纠错。
- `docs/对标-Hindsight.md` 增「机制级对照」附表：明确我们强在**逐个可回溯、零模型成本、毫秒延迟**，
  它强在**自动摄入代码与提交历史**（我们刻意不做）。

### 验证
384 条测试全绿；`metrics-guard PASS`；只改文档。

## 0.54.0（2026-11-02）

### Q18 预演：第二份冻结考卷 + 展示命中口径
- 新增 `evidence/a2b-set-cross.json`（12 条「跨项目唯先例」样本，`--cross` 冻结）。
- `measureA2b` 增加 `displayedHits / recallDisplayed`：**卡片行里真的出现当年那一局**才算展示命中。
- 新增 `scripts/q18-preview.mjs`：同时跑 A（关）/ B（开）两种口径并写 `evidence/q18-preview.md`。

### 实测（只读，无行为改动）
| 考卷 / 口径 | n | 覆盖 | 严格 | 展示命中 |
|---|---|---|---|---|
| 主考卷（现状） | 19 | 100.0% | 84.2% | 36.8% |
| 跨项目 · Q18=A | 12 | 100.0% | 75.0% | **0.0%** |
| 跨项目 · Q18=B | 12 | 100.0% | 75.0% | **41.7%** |

⇒ Q18=B 的可见收益是 **5/12**（A 恒为 0）；严格口径不变（文本命中与出处域无关）。

### 验证
384 条测试（380 pass / 0 fail / 4 skip）；`metrics-guard PASS`。

## 0.53.0（2026-11-02）

### 数据契约补齐（只改文档）
- 新增 §9 claim（含 `validFrom/validTo/validityOk/repeat` + 四条不变量）、§10 adjudication、
  §11 thread（`headline`）、§12 巩固（consolidation）、§13 配置（13 键默认值）、§14 版本与迁移纪律。
- 明确：新字段缺失按 null 处理，旧库不迁移、不重写历史文件。

### 验证
383 条测试全绿；`metrics-guard PASS`；证据 `evidence/M7-contract-sync.md`。

## 0.52.0（2026-11-02）

### 知识库
- `docs/调研/16-Mem0`（论文 abs 级）：抽取/巩固/检索三件套 + 图记忆变体；LoCoMo 上相对 OpenAI judge +26%、
  图记忆再 +2%、p95 延迟 -91%、token -90%+。
- 对照结论：我们的归档/合并/walk 与之同构，且**本来就是图**；唯一可做的是把「巩固」写成契约一节（只改文档）。

### 验证
383 条测试全绿；`metrics-guard PASS`。

## 0.51.0（2026-11-02）

### 新增 `scripts/first-live.mjs`（首次上线复盘）
- 一条命令把「注册状态 / 热路径抽测 / 六轴门槛 / 影子本来会注入什么 / D5 触发几次」合成
  `evidence/first-live.md`，并给出 `liveReady` 判定（注册无禁用 + 门槛通过）。
- 缺影子或遥测时明确写「不存在/没有遥测」，不编数字。
- 本机当前输出：`liveReady=false（disabled=4，guard=PASS）` —— 如实反映"还没执行 re-enable"。

### 验证
383 条测试（379 pass / 0 fail / 4 skip）；`metrics-guard PASS`。

## 0.50.0（2026-11-02）

### 安装指南改成单页版
- 重写 `docs/安装指南.md`：三步启用（dry-run → 退出 DSH 执行 re-enable → 重开后 install-doctor/metrics-guard）、
  零配置默认值表、三项验证、四种回滚、已知限制与排障表。
- 纠正过时内容：默认已不是 `enabled:false/shadow:true`（0.15 起为零配置）；`install-doctor`、`cli audit`、
  `cli facts --at`、`repeat-report` 全部纳入指南。

### 验证
379 条测试全绿；`metrics-guard PASS`。

## 0.49.0（2026-11-02）

### Q18 预留实现：`crossScopeClass` 开关（**默认关，行为不变**）
- 打开后仅 `class:*` 类级章节可用跨工作区先例；卡片行尾标 `[跨项目]`；
- A5 统计把 `[跨项目]` 行单列（`crossMarkedLines`），不进主 A5 分子/分母；
- 默认关闭：A5 仍 0.00%（29 行）、跨标记行 0，与 0.48.0 行为一致。

### 待裁定
- Q18=A 则永久关闭；Q18=B 则开启并新建第二份冻结考卷（不改原 19 条）。

### 验证
379 条测试（375 pass / 0 fail / 4 skip）；证据 `evidence/M7-q18-cross-scope-flag.md`。

## 0.48.0（2026-11-02）

### A2b 增加「跨项目唯先例」分桶（为 Q18 量化上限）
- 冻结集 19 条里，`sameScope=false` 的样本 10 条；其中 claim 文本可对上 **7** 条。
- **明确标注**：这 7 条不是现状收益（A5 要求同域证据，展示行仍是同域的那局），只是 Q18 放开后的**上限估计**。

### 验证
378 条测试全绿；`metrics-guard PASS`（A2b 严格 16/19）；证据 `evidence/M7-a2b-cross-bucket.md`。

## 0.47.0（2026-11-02）

### 新增 `cli facts --at`（双时态查询）
- 回答「某时点上哪些 claim 为真」：`validFrom ≤ at` 且（无 `validTo` 或 `validTo > at`），invalidated 永不返回。
- 起始时间回退链：`validFrom → occurredAt → support 最早时间`；`--at` 非法退出码 2。
- 本机：`at=2026-11-02` 有效 184 / 303；`at=2020-01-01` 有效 0（时间轴单调）。

### 验证
378 条测试（374 pass / 0 fail / 4 skip）；证据 `evidence/M7-cli-facts-at.md`。

## 0.46.0（2026-11-02）

### 知识库
- `docs/调研/15-Graphiti`（时序上下文图谱工程实现）：事实有效期 / invalidate 不删除 / episode 溯源 /
  增量构图 / 混合检索（语义+BM25+图）。
- 对照结论：我们除「BM25 混合检索」外的机制都已具备；新增候选 **`cli facts --at <date>`**（"某时点为真"的只读查询面）。

### 验证
377 条测试全绿；`metrics-guard PASS`。

## 0.45.0（2026-11-02）

### D5 遥测（为真注入后的观察做准备）
- D5 补卡成功后向影子目录写 `repeat-hint.jsonl`：`{at, cls, count, tokens, digest}`，**只放机械量**；
  写失败只 warn，不影响注入。
- 新增 `scripts/repeat-report.mjs`：总次数 / 涉及会话 / 类别分布 / token 均值；无台账退出码 2。

### 验收口径
触发率 = 触发次数 ÷ 有失败的新会话数；预期只在「同类失败 ≥2 次」的会话出现；人工抽 10 条看误报。

### 验证
377 条测试（373 pass / 0 fail / 4 skip）；证据 `evidence/M7-d5-telemetry.md`。

## 0.44.0（2026-11-02）

### A2b 严格口径判据修正（不是产品改动）
- 旧实现「第一条覆盖 claim 就 break」会把"卡里同时有类级章节"的情况误判为失分；
  改为「任一覆盖 claim 文本与签名 ≥2 判别词重合即算命中」。
- 冻结集 19 条：严格 **63.2% → 84.2%（16/19）**；覆盖仍 100%；A1/A5/A6 不变。
- 剩余 3 条为一次性具体错误（old_string / DNS / sed），不在 8 类表内。

### 尝试并回退
- 给类级 claim 文本追加「关键词摘要（词: …）」：A2b 严格**无变化**，已回退（不给代码加无用复杂度）。

### 验证
375 条测试全绿；证据 `evidence/M7-a2b-strict-semantics.md`。

## 0.43.0（2026-11-02）

### A2b 冻结评估集（`evidence/a2b-set.json`）
- `scripts/a2b-set.mjs --freeze` 固化「切点后 + 有当年先例」的失败签名（当前 19 条，同域 9）；
  `m5-report` 与 `metrics-guard` 自动使用快照，**分母不再随语料漂移**。
- 纪律：不得为了让数字好看而重冻；重冻须在 PR 写明理由，两套都报。

### 验证
375 条测试（371 pass / 0 fail / 4 skip）；`metrics-guard PASS`（A2b 严格 0.6316，n=19 固定）。

## 0.42.0（2026-11-02）

### `scripts/re-enable.mjs` 加固：精准摘除
- 旧版会「从标记注释截到文件末尾」（可能删掉后续配置），且只处理一条禁用条目。
- 新版 `stripDisableBlock()`：只删含包名且 `disabled: true` 的条目块 + 相关注释，其余原样保留；
  本机 dry-run 显示将摘除 **3 条**（1 条注释 + 2 条 disabled 条目）。

### 验收路径
退出 DSH → `node scripts/re-enable.mjs` → 重开 → `node scripts/install-doctor.mjs`（应显示「未见 disabled」）→ `metrics-guard`。

### 验证
373 条测试（369 pass / 0 fail / 4 skip）；证据 `evidence/M7-re-enable-hardening.md`。

## 0.41.0（2026-11-02）

### N9 · 卷首摘要（机械拼接）
- thread 新增 `headline`：`<类名> · N 局 · 最近 YYYY-MM-DD · 代表：<l0≤60>`；不调模型、不生成新文本。
- `cli volumes` 直接展示 headline；`docs/数据契约.md` §4.4 已补字段。
- **不进注入路径**（A1/A5/A6 不受影响）。

### 验证
370 条测试（366 pass / 0 fail / 4 skip）；`metrics-guard PASS`（A2b 严格 0.6316，n=19）。

## 0.40.0（2026-11-02）

### 方案 §8 口径收口（文档）
- 新增 **§8.2c**：holdout / A2b 覆盖 / A2b 严格三口径；明确「A2 只作背景值，声称收益必须给 A2b 严格 + n」。
- 新增 **§8.2d**：A3 的 `simulated` 与 `live` 分界与验收命令；未达 live 前不得写成「线上 0 失败」。

### Q18 的 A/B 实现草案（`docs/拷问记录.md`）
- A：现状（同域证据，A5=0）。
- B（推荐）：只对 `class:*` 类级章节放开跨域证据，卡片标 `[跨项目]`，A5 口径拆出 A5-class；预估 3 处改动，等主人拍板。

### 知识库
- `docs/调研/14-Generative-Agents`（记忆流/反思/动态检索；只借鉴"卷首摘要"，不做模型反思）。

### 验证
369 条测试全绿；`metrics-guard PASS`。

## 0.39.0（2026-11-02）

### 新增 `scripts/install-doctor.mjs`（安装后自检）
- 五项只读检查：注册（含 `disabled:true` 识别）/ 设置接口 / 库 verify / 证据目录 / host-sim 抽测（failed 必须 0）。
- 本机实跑 PASS；**发现插件在 `cordis.patch.yml` 里注册了两条且都 `disabled: true`**（历史改名残留）。

### 验证
369 条测试（365 pass / 0 fail / 4 skip）；证据 `evidence/M7-install-doctor.md`。

## 0.38.0（2026-11-02）

### 真实 store 下的宿主仿真（A3 simulated 证据刷新）
- `host-sim --store $DSH_HOME/memory-context`：40 首轮 × 2 次 ⇒ injected 24/40、failed 0、warn 0、
  session.append 0、p50 3.3–3.7ms、p95 5.5–6.0ms、tokens p50 248。

### 知识库
- `docs/调研/13-MIRIX`（六类记忆对照；确立 Procedural/Semantic 区分与我们一致）。

### 说明
- 仍是 simulated，不是线上；真机安装待主人执行 `scripts/re-enable.mjs`。

## 0.37.0（2026-11-02）

### N1 · 双时态字段 validFrom / validTo
- claim 出生带 `validFrom = occurredAt`；**人纠错**（L4 correct）与**核验失败**（validityOk=false）写 `validTo`。
- 只加字段，不改原文、不删条目；`cli audit` 新增「有效期已止」计数（本机 22 条）。

### 指标护栏口径修正
- `metrics-guard`：A2b 严格门槛 0.60 → **0.55**，并把样本量 n 打进输出。
  依据：同一 store 重复测量观察到 0.611–0.667 的跳动（样本仅 18 条，1 条 = 5.6pp）。

### 验证
366 条测试（362 pass / 0 fail / 4 skip）；`metrics-guard PASS`；证据 `evidence/M7-N1-bitemporal.md`。

## 0.36.0（2026-11-02）

### 指标护栏 `scripts/metrics-guard.mjs`
- 一条命令判定 A1/A5/A6/A4/A2b：不达标退出 1，并写 `evidence/metrics-guard.json`。
- 门槛：A1 ≤5% · A5 =0 · A6 =100% · A4 p50 ≤50ms · **A2b 严格 ≥0.60** · A2b 覆盖 =1.00。
- 缺值视为不达标；`judge()` 纯函数进单测（CI 可跑逻辑，数据判定在本地）。

### 说明
- A2b 严格本轮 12/18 = 66.7%（分母随类级章节自愈 +1），不是回归；门槛按样本量定 0.60。

### 验证
365 条测试（361 pass / 0 fail / 4 skip）；`metrics-guard PASS`。

## 0.35.0（2026-11-02）

### 类级章节自愈
- `claim.mjs`：`ensureClassClaims()` —— 有 ≥2 局支撑却缺类级 claim 的错误类，补一条 `class:<name> · <代表错误>`；
  support 取各单条支撑的并集，id 由「类名 + 作用域」决定 ⇒ 幂等；**不删、不改写旧条目**。
- 本机效果：有类级章节的类 **4/6 → 6/6**（补 module-missing、policy-human-turn）；claim 291 → 293。

### 新增 `scripts/class-audit.mjs`（只读）
- 每类：单条 claim 数 / 覆盖局数 / 是否已有类级章节 / 若受控重算可折叠多少条。

### 验证
361 条测试（357 pass / 0 fail / 4 skip）；A1/A5/A6 不变；证据 `evidence/M7-class-self-healing.md`。

## 0.34.0（2026-11-02）

### 修：claim 的类表与 topic 的类表不一致
- `claim.mjs` 的 `ERROR_CLASSES` 只有 5 类，而 `topic.mjs` 有 8 类 ⇒ `module-missing` / `permission-denied` /
  `timeout` 在**卷**里能成主卷，却从不合并成类级 claim（实测 `class:module-missing` 有 7 局，但无对应 claim）。
- 现已对齐到 8 类。注意：历史 claim 是只增不改的，旧库里的逐条 claim 不会回溯合并，**只对后续归档生效**。

### 尝试并回退
- 为 5 条不可召回样本试加 `path-not-found` / `edit-anchor-missing` / `network-blocked` 三类：
  A2b 严格 **无变化（12/17）**，已回退，不进代码。

### 验证
360 条测试全绿；A2b 严格仍 70.59%；知识库新增 `docs/调研/12-LangMem`。

## 0.33.0（2026-11-02）

### A2b 严格口径 47.06% → 70.59%
- **度量保真**：A2b 的信号补上「类级错误实体」，与插件热路径同口径（8/17 → 10/17）。
- **产品改动**：类级 claim 文本改为 `class:<name> · <代表错误>`，跨写法可命中（10/17 → **12/17**）。
- 覆盖口径保持 17/17；A1/A5/A6 不变（0.00% / 0.00% / 100%），A4 p50 1.88ms。

### 剩余
- 5 条未命中：ENOENT 类不在 8 类表内、或为一次性具体错误；扩类需先做严格口径对照。

### 验证
360 条测试全绿；证据 `evidence/M7-A2b-strict-7059.md`。

## 0.32.0（2026-11-02）

### A2b 两口径：覆盖 vs 严格
- 覆盖：卡片里的 claim 的 support 包含「切点前出现过该签名的棋谱」 ⇒ **100%（17/17）**。
- 严格：覆盖 + claim 文本与该签名 **≥2 个判别词重合** ⇒ **47.06%（8/17）**。
- `walk`：claim 有多局支撑时，**优先用与当前作用域相同的那局**做证据载体（卡片日期/棋谱对得上项目）。
- 纪律：声称收益必须给「A2b 严格」，覆盖只作上限参考。

### 验证
360 条测试全绿；证据 `evidence/M7-A2b-injection-recall.md`。

## 0.31.0（2026-11-02）

### A2b 注入召回（新指标）
- 对切点后「以前出现过的失败签名」，用签名建信号跑 walk+card，检查卡片 provenance 是否命中当年棋录。
- 基线：**29.41%（5/17）**；同域可达子集 **62.5%（5/8）**；10/17 只有跨工作区先例（当前策略不可达）。
- A2 从此只作背景值，**声称收益必须给 A2b**。

### 待裁定
- **Q18**：是否允许 `class:*` 类级主卷跨工作区展示（会把 A5 从 0 变成非 0）。已写入 `docs/拷问记录.md`。

### 验证
360 条测试全绿；证据 `evidence/M7-A2b-injection-recall.md`。

## 0.30.0（2026-11-02）

### A2 口径修正：时间切分 holdout
- `runEval({splitAt})`：memory = 切点之前的局，test = 之后的局；`m5-report` 固定切点 `2026-11-02T00:00Z`。
- 当前：全量 LOO 24.67%（会随语料增长）/ **holdout 35.56%**（16/45，test 9 局）。
- **不追认历史 A2 增量**：旧 CHANGELOG 里的 23.40/23.61/23.97/24.32 受语料增长影响，跨时点不可比。

### 验证
360 条测试全绿；`node scripts/m5-report.mjs` 同时输出两个口径；证据 `evidence/M7-A2-holdout.md`。

## 0.29.0（2026-11-02）

### N10 · 人纠错（L4）机械回填
- 归档时读取 `adjudications/`：只认 `L4-human-correction + decision=correct`。
- 给目标 claim 追加 counter（episode=`human:owner`、quote=纠错原文）、state 标 `disputed`；
  **原文/support/条目都不改不删**，幂等重放不重复计数。
- L2 裁决与 `hold-disputed` 不动 claim。

### 说明
本机当前 0 条 adjudication ⇒ 没有线上可回填样本；本轮 A2 显示 24.67% 属语料刷新，不计入 N10 收益。

### 验证
360 条测试（356 pass / 0 fail / 4 skip）；证据 `evidence/M7-N10-adjudications.md`。

## 0.28.0（2026-11-02）

### 新增 `cli audit`（只读健康检查）
- 统计 claim 总数/状态、**被遮蔽**（过期 validityOk=false / invalidated / 无支撑）、卷数与类级主卷 Top5。
- 存在无支撑 claim ⇒ 退出码 1（可接 CI）。
- 本机：282 claim（过期 22、无支撑 0）、138 卷、4 个类级主卷。

### 验证
359 条测试（355 pass / 0 fail / 4 skip）；证据 `evidence/M7-audit-cli.md`。

## 0.27.0（2026-11-02）

### 新增 `cli volumes`（棋书视图）
```bash
node scripts/cli.mjs volumes [--limit n] [--json]
```
- 类级主卷（`class:*`）排最前，其余按局数降序；输出总卷数/主卷数/每卷局数。
- 本机：138 卷 · 4 个主卷（module-missing 7 局、fs 读改写 6 局、web-search 4、sandbox 3）。

### 验证
358 条测试（354 pass / 0 fail / 4 skip）；证据 `evidence/M7-volumes-cli.md`。

## 0.26.0（2026-11-02）

### 类级错误成卷（棋书主卷）
- `thread.mjs`：`class:*` / `t:error:*` 主题只要求 `df ≥ minKifus`，不再套「df ≤ 10%N」上界。
- 效果：卷数 127 → **138**，类级主卷 **0 → 4**（fs 读改写 7 局、web-search-empty 4 局等）。
- 卷是视图（多对多、删卷不删谱），不影响 A1/A2/A5；357 条测试全绿。

## 0.25.0（2026-11-02）

### 设置页显示库状态
- `GET /kifu-longmemory/config` 返回 `stats {exists, episodes, claims, updatedAt}`。
- 卡片显示「当前库：N 局 · M 条教训 · 更新于 …」；库不存在时提示会自动建库。

### 说明
- 本轮试过的两处扩大召回（额外 3 个错误类、首条消息路径实体）实测 A2 **0 变化**，已回退，不进 CHANGELOG 当收益。

### 验证
357 条测试（353 pass / 0 fail / 4 skip）；证据 `evidence/M7-settings-stats.md`。

## 0.24.0（2026-11-02）

### 错误类表 5 → 8 类
新增 `module-missing`（Cannot find module / ERR_MODULE_NOT_FOUND）、`permission-denied`（EACCES/EPERM）、`timeout`（timed out/ETIMEDOUT）。

### 修：class 主题不再冒充 same-error
`class:*` 主题只建 shared-topic 边；否则同一对棋谱会出现两条 same-error（R05 实测 2 !== 1）。

### 回退：N2 多词兜底
该分支从未执行（S10 单条词兜底先命中），已删；A2 当时的 +0.36pp 属语料刷新噪声，见 `evidence/M7-N2-rejected.md`。

### 实测
A2 **23.61% → 24.32%**（+0.71pp，n=148）；A1 0.00%；A4 p50 2.30ms；A5 0.00%；A6 100%。

## 0.23.0（2026-11-02）

### 首条消息的类级错误信号（D2 类主题的消费方）
- 首条消息里出现已知报错原文（五类）⇒ 追加实体 `class:<name>`，exact 命中类主题。
- 效果：A2 收益 **23.40% → 23.61%**（+0.21pp）；A1 0.00%、A4 p50 1.78ms。
- 证据：`evidence/M7-class-signal.md`；356 条测试全绿。

## 0.22.0（2026-11-02）

### 类级错误主题（跨会话连接）
- 错误事件/失败边除原文主题外，再挂 `class:<name>` 主题（`fs-read-before-write` 等五类，与 D2 同口径）。
- 只连已知协议类；语法/模块类保持原文。
- 实测：A2 收益 **21.97% → 23.40%**（+1.43pp）；A1 0.00%、A4 p50 1.78ms、A5 0.00%、A6 100%。
- 证据：`evidence/M7-class-topics.md`；355 条测试全绿。

## 0.21.0（2026-11-02）

D5：会话内二次命中（主人批准，按推荐实现）。

### 规则
- 只看新增消息里的错误行（`Error:` / `[exit code: N≠0]`），按 D2 的类归一。
- 同会话同类失败累计 ≥2 次 ⇒ 补一次事实卡；每会话最多 1 次。
- 仍走 `decidePreStep → 十道闸`：事实、带 provenance、无祈使句。

### 配置
`repeatHint`（true）、`repeatHintAfter`（2）、`repeatHintMax`（1），设置页可见。

### 验证
单测覆盖触发/上限/首次不触发；354 条测试全绿。

## 0.20.0（2026-11-02）

### 修 R1 · 作用域越界（A5 34.62% → 0.00%）
- claim 必须用**同作用域**的棋谱承载证据；`scope=null`（只放用户层）时不做该检查。
- 效果：独立复核越界行 9 → 0，A2 收益不降。

### 修 R2 · 过期 claim 仍被注入（A1 8.33% → 0.00%）
- 归档时跑一次 `runValidityCheck`，把 `validityOk` 写进 claim（本机 20 条过期 / 1 条有效）。
- walk 跳过 `validityOk=false`：过期条目不注入，原文与 support 仍保留（只遮蔽可见性）。

### 六轴（116 局 store）
A1 0.00% · A2 21.97% · A3 not-live · A4 p50 1.89ms · A5 0.00% · A6 100%

## 0.19.1（2026-11-02）

D4（失败→修复配对）试做后**否决并回退**。

- 全量 248 条 claim 只出 2 条 fix，且两条都是错误配对（路径/因果无关）。
- 精度约 0%，会把无关成功当成“上次这样修好的”，比不做更糟。
- 已回退实现，证据留档：`evidence/M6-D4-rejected.md`；重做前置条件写在该文件。

## 0.19.0（2026-11-02）

D1：近实时增量入馆——记忆库不再只靠手动/首次建库。

### 新增
- `agent/turn-stopping`：轮次收尾时若 `manifest.updatedAt` 超过 `autoArchiveMinutes`（默认 30），后台跑一次归档（单飞锁，不阻塞会话）。
- 配置新增 `autoArchive`（默认 true）、`autoArchiveMinutes`（默认 30），设置页可见可改。

### 实测
- 全量重建：store 102 → **116 局**；当天覆盖 **7/19 → 18/18（100%）**。
- 归档 16.9s 在后台完成，不占对话步骤。

## 0.18.0（2026-11-02）

按当天真实样本（22 局 / 164 失败边 / 12 条跨局重复）落地 D2 + D3。

### D2 · 同类协议错误合并
- `errorKeyOf` 增加类映射：`fs-read-before-write` / `tool-unavailable` / `sandbox-limit` / `policy-human-turn` / `web-search-empty`。
- 只合并环境/协议类；`SyntaxError`、`Cannot find module` 等保留具体原文。
- 实测：读-改协议 10 条散 claim → **1 条 15 局支撑**；team limit → 9 局；goal-human-turn → 5 局。

### D3 · 跨局重复优先
- `compareHits` 顺序改为：档位 → depth → **repeat 降序** → weight → 时间。
- 失败命中与 claim 用「路径归一后的错误原文」互相包含匹配，把 claim.support 的局数带到 hit 上。
- 公开 hit 增加 `repeat` 字段（>1 = 反复踩过的坑）。

### 验证
- 352 条测试全绿（含 D2/D3 新测试）；`check PASS`。
- 证据：`evidence/M6-D2D3.md`。

## 0.17.3（2026-11-02）

新增 `scripts/re-enable.mjs`：一条命令恢复被临时禁用的插件。

```bash
# 先完全退出 DSH
node scripts/re-enable.mjs          # 加 --dry-run 只看会改什么
# 再打开 DSH
```

它做三件事（改前都备份）：删 `cordis.patch.yml` 末尾的临时禁用块、把 `link:` 依赖与 bundle 条目加回 profile、跑一次 `pnpm install`。

## 0.17.2（2026-11-02）

**修启动卡死**：web boot 卡在 `dsh-gokifu-longmemory: pending`，等 `@deepseek-ai/dsh-client-ui-settings`。

### 根因
- 浏览器半侧声明了 `inject: ['@deepseek-ai/dsh-client-ui-settings']`，该客户端模组在本机模块图里不会被解析 ⇒ 宿主永远 pending，界面打不开。
- 我们没有真的需要它：卡片只用宿主自带的 `slots` 服务。

### 修复
- `inject` 改为空；`apply` 先检查 `ctx.slots.inject/register` 是否存在，缺失就安静返回（绝不阻塞启动）。
- `dsh.client` 只留 `{ platform: 'web' }`。

### 复现与验证
- 实机：启动卡 pending（另一会话定位）；本版移除注入依赖后不再等待。
- 350 条测试全绿；`check PASS`。

## 0.17.1（2026-11-02）

设置卡片改用 `document.baseURI` 解析接口地址（与 dshmarket 一致）：反向代理前缀 / 桌面 `dsh-app://` 页面下也能读到配置。

## 0.17.0（2026-11-02）

**设置里可以选记忆库地址了（GUI）。**

### 新增
- **浏览器半侧 `client.js`**：注册「设置 → 长期记忆（棋院）」分区 —— 一个地址输入框 + 保存按钮，保存后显示当前生效路径。
- **宿主接口** `GET/POST /kifu-longmemory/config`：读写 `<DSH_HOME>/kifu-longmemory.json`；`profile` 配置优先于该文件。
- 用户配置优先级：**profile 配置 > kifu-longmemory.json > 默认值**；文件损坏只按空处理，不影响会话。

### 校验
- 地址必须是绝对路径或留空（相对路径 400）；布尔/数字字段类型校验；写入用临时文件 + rename 原子替换。
- 新增 3 条接口单测；350 条测试全绿。

## 0.16.0（2026-11-02）

**设置页可见：记忆库地址（storeRoot）等配置有 GUI 字段了。**

### 新增
- `src/plugin.mjs` 导出 `Config`（设置表单 schema）：`enabled` / `shadow` / **`storeRoot`（记忆库地址）** / `autoBuild` / `budgetTokens` / `limit` / `oncePerSession`。
- `storeRoot` 留空 = `<DSH_HOME>/memory-context`；填路径即生效（校验时自动去空白、空串回落默认）。
- 设置 → 插件 → **dsh-gokifu-longmemory** 里即可看到并修改这些字段，不用手改 JSON。

### 验证
- 新增单测：schema 必须暴露 storeRoot、validate 归一化；347 条测试全绿。

## 0.15.2（2026-11-02）

**可安装性修复：之前"设置里找不到插件"是因为包缺 bundle 清单。**

### 修复
- 新增 `cordis.patch.yml`（`insert: kifu-longmemory`），`package.json` 增加 `main` / `exports` / `dsh.bundle.patch` / `engines.dsh` / `files`。
- 宿主按 `dsh.bundle.patch` 把插件插入 profile 插件树；缺这个字段时包能装但不会出现在插件列表。

### 安装（三选一）
- 设置 → 插件 → 从本地目录安装：选本仓库根目录；
- 或 `cd <DSH_HOME>/profiles/desktop && pnpm add link:<本仓库路径>`，再把 `dsh-gokifu-longmemory` 加进 `package.json` 的 `dsh.profile.bundles`。

## 0.15.1（2026-11-02）

改名 **dsh-gokifu-longmemory** + 公开仓库脱敏。

### 改名
- `package.json` / 插件 name / 注入消息 `source.kind` / 裁决 schema → `dsh-gokifu-longmemory`。
- 仓库 `MYCF711/dsh-gokifu-longmemory`（旧地址自动重定向）。

### 脱敏（公开仓库前）
- 清掉：内网 IP、本机密钥目录名、本机用户目录、真实会话 UUID、本机绝对路径。
- 数据类证据只保留结构（`<ep>` / `<session-id>` / `<workspace>` 占位），测试夹具改用合成 id。
- **`scripts/privacy-scan.mjs`**：公开仓库的脱敏守卫（内网 IP / 用户目录 / 密钥 / 真实 UUID / 私钥）；接入 `scripts/check.mjs`，CI 会拦。

## 0.15.0（2026-11-02）

**改名 + 零配置 + 开源**：从 `dsh-kifuin` 改为 **`dsh-kifu`**；仓库转公开。

### 改名
- `package.json`：`name: dsh-kifu`；仓库 `MYCF711/dsh-kifu`（旧地址自动重定向）。
- 文档里的安装名、命令示例同步。

### 零配置（装完即用）
- **默认 `enabled: true`、`shadow: false`、`autoBuild: true`**（此前默认关）。
- 库不存在时：本次**沉默**（不注入），后台自动跑一次归档建库（`autoBuild`），下一轮生效；失败只 warn、不重试风暴。
- 用户最多只需填一个保存地址（`storeRoot`，缺省 `<DSH_HOME>/memory-context`）。
- `autoBuild: false` 可关自动建库；`enabled:false` 可完全停用。

### 实测
- 346 条测试全绿（含新增自动建库用例）。
- 安全：库不存在/构建失败/闸门不过 ⇒ 一律原 decision，不阻塞会话。

## 0.14.0（2026-11-02）

影子台账复盘工具：装完就能一眼看出"本来会注入多少、多长、哪些信号命中"。

### 新增
- **`scripts/shadow-report.mjs`**：读 `evidence/shadow/shadow.jsonl`（只读），输出：
  - `wouldInject` / `silent` / `silentRate`
  - `tokens`（会注入卡的 p50/p90/max）与 `tokensAll`、`silentIndexOnlyTokens`
  - `topSignals`（按信号词频）、`claimsPerCard`
- 台账不存在 ⇒ 退出码 **2**，不伪造 0。
- **`test/shadow-report.test.mjs`**：2 条（正常统计 / 缺台账）。

### 说明
- 影子卡没有命中时 `section:null`、`tokens` 只有 INDEX 行（约 16），报告把两类分开统计，避免把"沉默"算成"注入"。

## 0.13.0（2026-11-02）

Q17 裁定 C 落地：定式长出「参考层」（只作 candidate，不进 V1）。

### 新增（R08）
- **`generalizeCommand`**：命令 → `tool + 操作类`（`node --test` → `cmd:node test`；github 参数 JSON → `tool:github commits`）。
- **`promoteReferenceJoseki`**：泛化签名 **≥3 局独立支撑**才出候选；`layer:'reference'`、`entersV1:false`、`state:'candidate'`、必须带 `preconditions`（原文命令）。
- **archive**：参考层与精确层并列写入 store（`j-ref-*`）。

### 真实语料（100 局）
- 参考层候选 **2 个**：`tool:github path`（8 局）、`tool:github contents`（5 局）
- 精确层仍 **0**（真实命令参数高度 episode 特异）
- 343 条测试全绿

> 这一层的定位写死：**只回答“历史上这类操作成功过”，不进第一验收面（V1）**，避免把一次偶然成功当通用招法。

## 0.12.0（2026-11-02）

A2 口径收紧：只把"像错误"的签名算进 repeat/novel。

### 变化
- **`scripts/eval.mjs`**：新增 `ERROR_ONLY_RE` 与 `signaturesErrorOnly / repeatError / novelError / rateErrorOnly`；全量口径保留。
- **`scripts/m5-report.mjs`**：A2 主值改用 error-only 口径，caveat 同时给全量对照。

### 实测（2026-11-02 05:40）
- **A2 = 19.18%（14/73，1σ±4.61%）**；全量口径 13.89%（15/108，含非错误文本）
- A4 p50 1.23ms；A5 0%（6）；A6 100%（6）；A1 0/9 空转；340 条测试全绿

> 说明：审核指出原口径 35% 的"repeat"不是错误文本；收紧后数字更高（19% vs 14%），因为分母也变小了——**两个口径都保留**，不再只报一个。

## 0.11.0（2026-11-02）

独立审核（T18）后的必修项全部落地：CI 转绿、安装指南可照做、口径更正。

### 修复（审核阻断项）
- **F1 CI 红**：`test/plugin.test.mjs` 不再依赖 `$DSH_HOME` 环境变量（显式注入 + 还原）；`env -u DSH_HOME node --test` 现在退出 0。
- **F2 安装指南**：补「怎么注册插件」（设置 → 插件 → 本地路径 / tarball）、`storeRoot: null` 推荐写法、卸载与回滚步骤；插件新增 `<DSH_HOME>` / `$DSH_HOME` 占位符展开（无 home 时按"未配置"处理，不再解析成相对路径）。

### 更正（口径）
- **F3 redteam 计数**：control 组单独统计 —— **坏样本 10/10 拦住、0 泄漏；控制组 1/1 未被误杀**（此前"11 个坏样本"是错的）。
- **F4 A4 门槛**：方案 §8.2 判据是 **p50 / p90 ≤50ms**；实测 p50 1.1–2.0ms、p90 4.7–20ms 达标；**p95 在 5.6–70ms 间波动**（GC），不再声称"p95 达标"。
- **F5 台账**：语料统一为 store manifest 实测 **92 局 / 780 主题 / 199 边 / 83 卷 / 125 claim**；MAINTENANCE 的 0.7.0/327/待发 0.6.0 全部更新。
- **release.mjs**：发布前查询该提交的 CI 结论（`--require-ci` 时不一致即中止）。

## 0.10.0（2026-11-02）

负迁移防线演练：11 个坏记忆样本全部被闸门拦住（A1 的"闸门有牙"证据）。

### 新增
- **`scripts/redteam.mjs`**：把坏记忆逐条喂 R12/R13，断言被对应闸门拦住；退出码 0 = 全拦。
- **`evidence/M5-redteam.md`**：11 案例表（时间戳/日期/跨域/支撑/过期/覆盖/quote/摘要源/祈使句/预算）。
- **`test/redteam.test.mjs`**：子进程跑演练，断言 total 11 / leaked 0。

### 结果
- **11/11 拦住，0 泄漏**；340 条测试全绿。
- 这是"机制有牙"的证据，不是线上负迁移率；A1 线上值仍受 validity 覆盖率限制（0/8）。

## 0.9.0（2026-11-02）

宿主仿真：A3 从 `not-live` 升级为 `simulated`；修掉闸 3 的逐次 fs/git 开销。

### 新增
- **`scripts/host-sim.mjs`**：用真实插件入口 + 真实 store 跑 N 个"新会话首轮"；假 session 的 `append` 一旦调用即抛错；输出注入率/失败率/延迟/tokens。
- **`evidence/M5-host-sim.md`**：40 会话 × 2 轮 + 20 会话带间隔的实测。

### 修复
- **R12 `PROBE_CACHE`**：闸 3 validity 核验按 `validity key + workspace + 60s 桶` 缓存 ⇒ host-sim p95 从 62–115ms 降到 **40–47ms**。

### 实测（仿真，非线上）
- attempts 40 · injected 16（40%）· empty 24（60%）· **failed 0** · warn 0 · **session.append 0**
- p50 2.9–4.0ms · p95 **40.2–47.4ms** · max 56.8–113.5ms（GC）· tokens p50 **300**

> A3 仍是 `simulated`，不是线上；`m5-report` 里仍记 `not-live`，两者同时保留。

## 0.8.1（2026-11-02）

延迟收口：A4 p50 1.14ms / p95 5.55ms，**p95 门槛达标**。

### 变化
- **R12**：`storeView` 按 cache 对象缓存（WeakMap）——每次卡片不再重建 claims/episodes 映射。
- 六轴 A4 重算：**p50 1.14 ms / p90 3.48 / p95 5.55 / max 103.1**（50 次；max 是单次 GC 尖峰）。
- `evidence/M5-latency.md` 更新为三轮修复对照。

### 六轴复算（2026-11-02 05:02）
A2 13.33%（105）· A4 p50 1.14ms（50）· A5 0%（6）· A6 100%（6）· A1 0/9 空转 · A3 not-live；339 条测试全绿。

## 0.8.0（2026-11-02）

M5 收口：六轴一条命令可复算 + 安装指南。

### 新增
- **`scripts/m5-report.mjs`**：一条命令算 A1–A6（`--store --workspace --json --evidence`）；每轴 `{value,unit,n,status}`；缺数据记 `not-consumed`（**不写 0**）；零模型调用。
- **`docs/安装指南.md`**：前置检查 → 影子模式 → 看数据 → 真注入 → 回滚 → 已知限制（明确"安装由主人执行"）。
- **`test/m5-report.test.mjs`**：六轴结构、A6 100%、A1 无 validity 时 not-consumed。

### 六轴真实值（2026-11-02 04:57，零模型调用）
| 轴 | 值 | 状态 |
|---|---|---|
| A1 `staleTransferRate` | 0.00%（9 条；**覆盖率 0/8，空转**） | measured（vacuous） |
| A2 `repeatFailureRate（LOO）` | **13.33%**（14/105；1σ±3.32%；coverage 79.2%） | measured |
| A3 `injectFailureRate` | 0.00% | **not-live**（未上线） |
| A4 p50 | **4.11 ms**（n=50） | measured |
| A5 `crossScopeLeakRate` | 0.00%（n=6 卡） | measured |
| A6 `provenanceCoverage` | **100%**（n=6 卡） | measured |

> 纪律：A2 是机械代理、不是收益；A1 的 0% 是空转；A3 未上线。三条都写进报告，不许对外省略。

## 0.7.1（2026-11-02）

定式 0 的根因查清：补了"命令成功"语义，仍不足以长出定式。

### 新增
- **R03 `commandSuccesses`**：`tool/result` 以 `[exit code: 0]` 结尾 ⇒ 可验证成功（独立字段，不破坏边桶闭合）；带命令原文、seq、time。
- **R08** 消费 `commandSuccesses`（与边成功合并后再提定式）。
- **R11 S10**：claim 文本直接含信号判别性词也可命中（此前只能经 support 棋谱或主题 key）。

### 真实数字（2026-11-02 04:55，25 局 root）
- 有成功信号 **12/25**；成功条数 **105**（S11 前 54）
- 跨 ≥2 局重复的成功签名 **1 条**（`{"path":"user"}` 噪声）
- 定式候选仍 **0** ⇒ 不是"没算命令成功"，是真实命令高度 episode 特异
- 328 条测试全绿

> 定式要不要泛化签名（`bash:测试` / `edit:配置`）是**方向问题**，记 Q17 待裁定；按防过拟合默认**不泛化**（S12）。

## 0.7.0（2026-11-02）

M5 第二阶段：闸 3 从 unverified 变真核验 + H1 机械代理基线。

### 新增
- **`scripts/gates-check.mjs`**：只读核验 CLI（`--store --workspace --now --json`）；`file`（存在 + 可选 sha256/mtimeMs）、`version`（裸版本 / `pkg@x.y.z`）、`commit`（`git cat-file -e`，5s 超时）；单条失败只记 reason 不抛。
- **R13 `probeValidity` / `runValidityCheck`**：`runGates({validityResults})` 认三种键；无结果仍记 `gate3/validity-unchecked`（**不假绿**）。
- **R12 plugin**：注入路径只核本卡条目；`probeValidity:false` 可关。
- **`scripts/eval.mjs --h1`**：`staleTransferRate` = 注入条目中 validity 核不过 ÷ 注入条目；分母 0 记 `null`。

### 真实数字（2026-11-02 04:39）
- gates-check：带 validity **8 条** → **0 过 / 8 不过**（`version-package-not-found` 3、`version-file-unreadable` 2、`file-missing` 3）
- H1：28 信号 → 注入 9（去重）· stale 0 → **staleTransferRate 0.00%（0/9）**
- **覆盖率 0/8**：带 validity 的过期记忆属于另一个工作区，R11 走不到 ⇒ 0% **不等于没风险**
- 327 条测试全绿

## 0.6.2（2026-11-02）

注入延迟第二次收紧：主题精确索引 + 闸门记录查找走缓存。

- **R11**：`createWalkCache` 增 `topicsByKey`（精确匹配快路径）与 `get(kind,id)`；`matchTopics` 先查索引，未命中才扫描。
- **R13**：`runGates` / `buildResolver` 接受 `cache`，记录查找不再逐个 `store.get` 读盘。
- **plugin**：把 cache 传给闸门。
- **基准**：`scripts/bench-inject.mjs` 扩到 50 次采样，输出 p50/p90/p95/max。

### 实测（2026-11-02 04:45）
- 热 **p50 3.9–5.3 ms**；p90 20.9–56.4；p95 46.3–107.2（GC 波动）；max 110–123
- 冷缓存 355–667 ms（插件加载时预热）
- 298 条测试全绿

> 结论：p50 达标；p95 未稳定达标（GC 尖峰），不承诺 p95。

## 0.6.1（2026-11-02）

注入延迟修复：把 1,281 次文件读挪出 pre-step 热路径。

### 变化
- **R11 `createWalkCache`**：一次读出 episodes/topics/links/claims，`walkFromSignals({cache})` 走内存。
- **R12 `buildMemoryCard({cache})`**：claims/episodes/topics 从缓存读，不再每次 `store.list`。
- **plugin 预热**：`apply()` 时构建缓存（一次性），首轮注入走热路径；失败只 warn，不影响会话。
- **`scripts/bench-inject.mjs`**：冷/热 + p50/p90/p95 基准。

### 实测（2026-11-02 04:40，10 信号 × 5 轮）
- 冷缓存 **548 ms**（移到插件加载）
- 热 **p50 5.1 ms** / p90 50.8 / p95 62.7 / max 118.9（偶发 GC 尖峰）
- 298 条测试全绿

> 口径：`方案.md` §8.2 目标 ≤50ms/步；p50 达标，p95 在阈值附近，尖峰待压。

## 0.6.0（2026-11-02）

M5 起步：真注入的宿主入口（默认关）+ 留一局（LOO）机械评测。

### 新增
- **R12 宿主入口 `src/plugin.mjs`**：`apply(ctx, config)` 挂 `agent/pre-step`；接缝照抄压缩仓（`await next()` → 非 `enter` 原样返回 → 全 try/catch）；注入位置在"最后一条 claimed 消息之后"，与压缩插件相邻不互相覆盖；消息 `source.kind="dsh-kifuin"`；**每会话一次**；`enabled && !shadow` 才可能改 decision；任何异常 ⇒ warn + 原 decision；**不写 session 事件**。
- **M5 机械评测 `scripts/eval.mjs`**：留一局（LOO）算 `repeatFailureRate`；memory 只用 `startedAt` 严格更早的局；三个口径（edge/event/both）+ `--json`；零模型调用、零写入、确定性（同输入两次逐字节相同）。

### 真实数字（2026-11-02 04:18，store=tmp/memory-context，24 局 root）
- **both 口径**：12 repeat / 86 novel ⇒ **rate 12.2%**；coverage 79.2%（19/24 局有失败签名）
- edge 口径 16.3%（覆盖 29.2%）；event 口径 12.8%
- 坑榜 Top3：`file has not been read…`(3 局)、`no web_search_tool_result blocks`(3)、`file changed since it was read`(2)
- 298 条测试全绿

> **口径纪律**：12.2% 是"机械代理指标"，不是"模型因此少走弯路"的收益；对外不得写成收益。样本 98 条签名，95% CI 约 [6%, 19%]，不可外推。

## 0.5.0（2026-11-02）

M4 闸门与裁决：十道闸全开，作用域越界清零，精度过门槛（影子模式）。

### 新增/修复
- **R10 adjudicate**：多成员机械裁决（support/oppose/insufficient）；agreement=多数÷有效票；<阈值 ⇒ disputed；共享 `contextId` 的票不计（闸 2b）；结果可回放（id 由票集哈希，篡改即露）。
- **R13 十道闸全开**：0/1/2/2b/3/4/5/6/6b/7 + 边界审计；判据单源（R12 与 R13 共用 scope 函数）；`PENDING_GATES=[]`。
- **R11 作用域修复**：候选入 hits 前过 scope 闸（`w:` 只认完全相同，`u:` 跨域可见，缺 scope 默认拒绝）；真实 20 卡越界行 **52 → 0**，闸 1 **2/20 → 20/20**。
- **R12 接线**：`runInject` 把 store+scope 传给闸门；跨域/未知作用域分开计数并写进省略行（零展开也有解释）。
- **S9 起跳池收紧**：泛工具主题不做起跳种子。

### 真实数字（2026-11-02 04:09）
- 精度（35 样本）：hopPrecision **50.38% → 87.38%**；noiseRate **1.94%**；零注入 34.29%；token p50 224 / p90 295 / max 323；闸 35/35。
- 存量 125 claim：闸 2 / 闸 5 违规 **0**（状态与 quote 自洽）。
- 268 条测试全绿。

## 0.4.0（2026-11-02）

M3 顺藤摸瓜（影子模式）：能找、能组卡、能过闸，但**不注入任何模型上下文**。

### 新增房间
- **R11 walk**：从信号（根消息/活动/用户显式）→ 主题 → 棋谱 → 一跳；深度夹在 2；每跳带 `why`；失败教训优先；≤5 条 / ≤500 tokens；无命中零 token；真实语料 157–375 ms/次，只读（跑完 1,280 文件 sha256 全等）。
- **R12 inject**：`indexLine` 恒定一行（35 tokens）+ 命中才展开 `<memory-ledger>`；每条带 `occurredAt` 与 provenance；超预算阶梯降级但**不丢来源与日期**；**shadow 模式只写 JSONL**（`injected:false`），硬拒绝 `$DSH_HOME` 内影子路径。
- **R13 gates（起步）**：闸 0（时间戳）、闸 6（预算/省略）、闸 6b（相关性：每条 hit 有 why、深度 ≤2）、边界审计（指令式扫描）；其余闸在 `PENDING_GATES` 显式登记（M4 启用）。

### 增强
- R14 CLI 新增 `inject --shadow --signal ... [--shadow-dir]`。
- `package.json` exports 补 `./walk ./inject ./gates`。

### 真实数字（2026-11-02 03:30）
- 20 条真实信号影子跑：**闸门 20/20 通过**；零注入 1/20（`127.0.0.1` 主题无 hit）
- token：中位 **253** / p90 275 / max 292（预算 500，从未触顶）；首轮行固定 35
- 渲染 42 claim + 51 指针；shadow 20 行全部 `injected:false`
- 预算阶梯：500→4 条/190 tok；120→2 条/113 tok（日期与 provenance 一字不丢）；60→0 条/35 tok + omitted 计数
- 216 条测试全绿

## 0.3.0（2026-11-02）

M2 建网成线完成：把 92 局会话与 19 张棋谱落成一个**可拷贝的记忆库**（只写不读，零注入）。

### 新增房间
- **R15 persist**：sidecar 存储（`<DSH_HOME>/memory-context/`）；原子写 + fsync + rename；manifest（version/user/counts/**sha256 checksums**/pathPolicy）；append-only journal；`verify`/`rebuild`；权威（episodes/joseki/claims/adjudications）与派生（topics/links/threads/index.md）分离；**篡改权威 → rebuild 拒绝盖章**；绝对路径拒绝入馆；原件缺失标 `sourceStatus:"missing"` 不失效。
- **R15 archive**：`scripts/archive.mjs` 入档管线（只读上游）；`--dry-run` / `--store` / `--root` / `--session` / `--json`；幂等（同输入复跑 0 新增、全库逐字节相同）。
- **R06 thread**：线索（藤的视图，多对多）；84 卷、20 次一局多卷。
- **R08 joseki**：定式候选（每招溯源、≥2 局独立支撑、带 shares-joseki 边）；真实语料 **0 条候选**（成功边全是 write 型，无跨局同签名序列；不放宽 Q5 门槛）。
- **R09 claim**：128 条（fact 9 / antipattern 29 / preference 90；candidate 5 / observed 123）；失败→antipattern、约束→preference、file/version→fact（带 validity）。

### 增强
- R14 CLI 新增 `verify` / `rebuild` 子命令（`--store` 指定记忆库）；`package.json` exports 补 `./persist ./thread ./joseki ./claim`。

### 真实数字（2026-11-02 03:12）
- 92 日志（75,922 事件）/ 19 棋谱（1,701 节点 / 1,941 边）/ 24 局独立成谱 + 68 子代理归并
- 784 主题 / 212 相关边 / 84 线索 / 3,155 mention / 128 claim / 0 定式候选
- 预估写入 1,300 条；`verify` 1,281 文件 / 1.86 MiB / 0 错误；复跑逐字节相同

## 0.2.0（2026-11-02）

M1 只读考古完成：从 90 份真实会话日志与 15 张棋谱建出第一张关系网，**零注入、零写入**。

### 新增房间
- **R01 logread**：按 RFC 8878 逐帧扫边界 + 逐帧解压；坏尾返回前缀（`truncated`），坏行计数，帧级损坏与未知版本 fail-closed。实测 90/90 日志解析成功（38,388 帧 / 70,966 事件 / 194.9 MB 明文，中位 1.66 s）。
- **R00 episode**：会话 → 棋谱（双时钟、闭包、子代理父链）；24 局独立成谱，66 局子代理归并到父局。
- **R02 graphread**：`graph.json` + `graph.json.delta.jsonl` 逐帧回放；坏尾截断、版本拒绝。实测 15 张全部读出（1,230 节点 / 1,397 边 / 198 delta 帧）。
- **R03 extract**：失败/成功/未结算/约束/工具机械抽取，每条带 seq + quote（≤200 字），只认 `source.kind==="user"`（不抽模型摘要）。
- **R04 topic**：repo/file/domain/error/tool/term/goal 主题抽取；CJK 2-gram + 停用词 + IDF；753 主题（df≥2：162）。
- **R05 link**：多粒度相关边（棋谱↔主题、棋谱↔棋谱、节点↔节点），每条带 `why` 与权重；194 条边（shared-topic 61 / same-error 67 / same-file 66）。
- **R07 index**：`index.md` 树（派生、可重算）。
- **R14 cli**：`stats` / `dump` / `walk`，全程只读（实测写入 0 字节）。

### 修复
- `scripts/release.mjs` 在 Windows/sh 下的进程替换兼容问题：改用临时文件传 release notes。
- `engines` 改为 `>=23.8`（`node:zlib` 的 zstd API 不保证 22 全系都有）。

### 测试
- 98 条测试全绿（R00–R05、R07、R14）；真实语料断言 + 合成坏尾/坏行夹具。

## 0.1.0（2026-11-02）

首个版本：方案冻结 + 仓库骨架。

- 方案 v0.9 冻结：目标（第一验收面=不重复踩坑）、结构（棋谱+主题+相关边→线索→棋书馆+定式库）、边界（唯一入口=棋谱）、时间（双时钟）、裁决（多成员独立解析，人只纠错）、可搬迁内核。
- 仓库骨架：`src/rooms/`（按最小交付房间切）、`scripts/check.mjs`、`scripts/release.mjs`、`test/`。
- 维护台账：`MAINTENANCE.md`。
- 不发 npm；版本发布 = annotated tag + GitHub Release。
