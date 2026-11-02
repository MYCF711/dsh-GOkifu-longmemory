# T6b 报告 · R06 thread + R08 joseki（候选）+ R09 claim（候选）（2026-11-02）

> 任务 id：**task-5**（`T6b: R06 thread + R08 joseki + R09 claim（候选）`）
> 分支：**main（未提交）** —— 按 Lead 指令「团队共用工作树，禁止 checkout/switch/commit，文件保持未提交，由 Lead 提交」。
> commit sha：**无（未提交）**。建议 Lead 拆三条 `R06 thread:` / `R08 joseki:` / `R09 claim:`（各自 tombstone test 独立可红）。
> 版本（`package.json` / `CHANGELOG.md` / `MAINTENANCE.md`）由 Lead 升，本任务未动。
> 规则口径：**只做机械规则**（成功边序列签名、跨 ≥2 独立局、无 quote 不产出），**零模型调用**，**只用 `node:` 内置模块**，未新增依赖。

## 0 · 交付物

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/rooms/thread.mjs` | 232 | R06：`buildThreads({episodes, links, topics, options})` → `{threads, assignments, stats}`；同 scope + 判别性主题（df≥2 且过 R05 `linkEligible`）聚卷，多对多，kifus 按 occurredAt 升序 |
| `src/rooms/joseki.mjs` | 478 | R08：`promoteJoseki({episodes, signals, now, options})` → `{joseki, links, stats}`；成功边签名序列（长度 2–3 的连续窗口）跨 ≥2 独立局、无反例、每步有 source ⇒ `state:"candidate"`；同时产出 `shares-joseki` 边 |
| `src/rooms/claim.mjs` | 544 | R09：`promoteClaim({episodes, signals, now, options})` → `{claims, stats}`；失败边→antipattern、约束句→preference、ENOENT 路径/字面版本→fact（带 validity）；`observed`/`candidate` 两档 |
| `test/thread.test.mjs` | 154 | 8 条 tombstone：多对多 / df=N 不成卷 / 跨 scope 不混卷 / 卷形状 / 表可选 / links 只计数 / 确定性 / 空输入 |
| `test/joseki.test.mjs` | 225 | 10 条：候选准入 / 单局 / 父子 / 跨 scope / 反例 / 无 source / 3 连招去冗余 / 四种入参形态 / 签名归一 / 确定性 |
| `test/claim.test.mjs` | 245 | 12 条：antipattern 门槛 / 单局 observed / preference 逐字 + u: 升层 / ENOENT file 事实 / 版本事实 / 反例优先 / 无源不入 / 合成失败标记 / 无分数 / 归一工具 / 确定性 / 空输入 |
| `reports/T6b-REPORT.md` | 本文件 | 契约 + 数字 + 风险 |

可复现实物（`tmp/`，**不进 git**）：

- `tmp/t6b-final.mjs` / `tmp/t6b-final.json` —— 一次语料快照跑 R06/R08/R09 的全部数字与本报告引用的样本。
- `tmp/t6b-determinism.mjs` —— 同一快照跑两遍，三房间输出逐字节相同（`identical:true`，退出 0）。
- `tmp/t6b-fixtures.mjs` —— 合成夹具计数（与测试同口径）。

## 1 · 验收

```
$ node --test test/thread.test.mjs test/joseki.test.mjs test/claim.test.mjs
ℹ tests 30   ℹ pass 30   ℹ fail 0   ℹ skipped 0

$ node --test                    # 全仓（含 T1/T2/T3/T6a 的 120 条）
ℹ tests 150  ℹ pass 150  ℹ fail 0   ℹ skipped 0

$ node scripts/check.mjs
ok  private:true / version=0.2.0 / changelog / 六大文档 / 房间齐 / branch=main
check: PASS
```

- 全程只读 `$DSH_HOME`（`sessions/` + `chess-context/`），**未写** `<DSH_HOME>`；`<DSH_HOME>/memory-context/` 至今不存在。
- 未改其他房间、`package.json`、`CHANGELOG.md`；三个新文件与其他房间零 import 耦合（R06 只 import R05 的 `linkEligible`，R08/R09 只用 `node:crypto`）。

## 2 · 契约与机械规则

### R06 thread（卷是视图，不是容器）

| 规则 | 机械判据 | 位置 |
|---|---|---|
| 成卷 | 同一 `scopeKey` 内共享同一**判别性**主题：`df ≥ 2` 且 `linkEligible(df, N)`（`df < N`、`df ≤ max(2, ⌈10%N⌉)`，与 R05 建边同一阈值 S8） | `thread.mjs` §3 |
| 多对多 | 一局可属多卷；`assignments` 给回 `{episode, threadIds[]}` | 同上 |
| 不成卷 | 无主题的局、通用主题（`df = N`，如 `tool:bash`）、同 scope 内不足 2 局的跨域主题 | 同上 |
| 排序 | `kifus` 按 `occurredAt`（= `startedAt`/`firstEventAt`）升序，同时刻按 id；卷按 `[scopeKey, title, id]` | `byOccurredThenId` |
| 双时钟 | `createdAt` = 卷内最早 occurredAt，`updatedAt` = 最晚；**不取 `Date.now()`**（派生可重算） | `thread.mjs` §5 |
| links 的用途 | 只记卷内 `shared-topic` 边数（`thread.links`），**不决定成员**（卷是视图，跳转走边） | 同上 |

### R08 joseki（每招溯源；M2 只到 candidate）

```js
joseki = { id:"j-<hash8>", version:1, title,
  steps:[{ n, action, expect, source:{episode,nodeId,edgeId,seq,quote}, occurredAt }],
  preconditions:[{check:"scope", value, why}], assumptions:[],
  support:["ep-…"], counter:[], state:"candidate", supersedes:null,
  recordedAt, updatedAt, scopeKey, signature:[…] }
```

| 规则 | 机械判据 |
|---|---|
| 招的签名 | 动作原文 `tool(key=value …)` → 取文本顺序第一个主参数（`command/cmd/script/file_path/path/file/url/query/pattern/name`）；抹工作区根前缀、`\`→`/`、长十六进制→`<id>`、13 位以上数字→`<ts>`、截 160 字。`write` **只取 file_path，不取 content** |
| 片段 | 同局成功边按 `seq` 升序，取长度 `minSteps(2)–maxSteps(3)` 的连续窗口 |
| 候选准入（Q5） | ① 同一 `(scopeKey, 签名序列)` 被 **≥2 局独立**支撑（不同 `sessionId`、非父子）② **无反例** ③ 每步有 source（`episode+seq+quote`）④ `preconditions` 可核（scope）。任一不满足 ⇒ 不产出 |
| 反例 | 支撑局的该窗口内（首招 seq < failure.seq < 末招 seq）夹失败边 ⇒ 记反例、不产出（`stats.dropped.countered`） |
| 去冗余 | 窗口 W 是保留候选 J 的连续子窗口（`|J|=|W|+1`）且 `support(J) ⊇ support(W)` ⇒ 丢 W |
| 状态 | **只产出 `candidate`**；`standard/disputed/superseded` 由 M4 的机械规则触发，本模块永不产出 |
| 连接组织 | 每条候选的支撑局两两产出 `shares-joseki` 边（`why = j-…`，`weight = 1`），返回在 `links` 里供入档管线并入图 |

### R09 claim（参考层；两档状态）

| 来源 | kind | text | validity / preconditions |
|---|---|---|---|
| 失败边 | `antipattern` | 归一错误键 → 归并；text 取最早支撑局的**错误行原文**（逐字） | `validity:{type:"none"}`；`preconditions:[{check:"scope"}]`；动作侧证据由 `support.edgeId` 回指棋谱边 |
| 用户约束句 | `preference` | 用户原话（R03 已切句，逐字），保留 `level: hard|soft` | `none` + scope |
| ENOENT 失败 + 可提路径 | `fact` | 那一行 ENOENT 原文（逐字） | `{type:"file", value:path}`；`preconditions:[{check:"file-exists", value:path}]`（文件出现即 stale，方案 §5.3） |
| 动作原文里字面版本 | `fact` | 原文片段（`name@x.y.z` / `version=x.y.z`） | `{type:"version", value}` |
| `signals.facts`（上游机械产出物） | `fact` | 传入的 text/quote | 校验 `validity.type ∈ none/file/commit/version`，否则丢弃并计数 |

| 规则 | 判据 |
|---|---|
| 状态 | `candidate` ⇔ 支撑局 ≥2 且存在**独立对**（不同 sessionId、非父子）且 `counter` 为空；否则 `observed`。**不产生 semantic/disputed/invalidated/stale** |
| 作用域 | 同一 text 在 **≥2 个不同工作区**被独立印证 ⇒ `scopeKey = "u:<user>"`（方案 §4.10，默认 `u:owner`）；否则留在 `w:` 层 |
| 反例优先 | 文件事实若在**更晚时间**有成功边触到同一路径（文件已出现）⇒ 记 `counter`、不升 candidate（方案 §5.2） |
| 无源不入 | 无 `quote` / 无 `seq` / 无 `occurredAt` 一律不产出，只进 `stats.dropped` 的明确分桶 |
| 计数不是打分 | `counters:{support,counter,injections,lastInjectedAt}` 只记可数事实，**无 score/rank/confidence 字段**（有测试断言），不参与排序与晋升 |
| 合成失败标记 | `(no output) [exit code: 1]`、`[exit code: N]` 只说"命令失败"不说"错在哪" ⇒ 不构成 antipattern（与 R05 对 same-error 的口径一致），计入 `dropped.generic` |

## 3 · 合成夹具数字（`tmp/t6b-fixtures.mjs`，与测试同口径）

| 房间 | 夹具规模 | 产出 |
|---|---|---|
| R06 | 5 局 / 2 个工作区 / 5 个主题（含 `df=N` 的 `tool:bash`、跨域各 1 局的 `跨域主题`、无主题的 1 局） | **3 卷**（`mycf711/dsh-gokifu-longmemory`、`src/rooms/link.mjs`、`yaml`）；4 局入卷、**2 局属 2 卷**（多对多）、1 局无卷；`df=N` 与跨域主题均不成卷 |
| R08 | 2 局同 scope，同一 2 招成功线（`bash(command=npm test)` → `write(file_path=…/out/result.json)`，两局路径写法不同、content 不同） | **1 条候选**（2 招、`state:"candidate"`、`support` 2 局、**1 条 `shares-joseki` 边**）；单局 / 父子 / 跨 scope / 窗口内夹失败 / 缺 seq 或 quote 五种情形**各 0 候选**（`singleSupport`、`notIndependent`、`countered`、`noSource`、`noQuote` 分别计数）；3 连招夹具 → 1 条 3 招候选 + 2 个 2 招子窗口被剪 |
| R09 | 4 局（3 同 scope + 1 跨 scope），错误 2 条同文本、约束同 1 句、1 条 ENOENT、1 条字面版本 | **5 条 claim**：`fact 2`（file / version）、`antipattern 2`（一 candidate 一 observed）、`preference 1`（跨工作区 ⇒ `u:owner`、candidate）；2 candidate / 3 observed；反例夹具（两局 ENOENT + 更晚写同一路径）⇒ 该 file 事实 `counter=1`、`state:"observed"` |

## 4 · 真实语料数字（`tmp/t6b-final.mjs`，快照 `2026-11-02 03:11 +08`）

语料 = `$DSH_HOME/sessions` + `$DSH_HOME/chess-context/sessions`，**活语料**（其他会话仍在追加），下表是**该时点**的值：

| 项 | 值 |
|---|---|
| 根局（depth=0，子代理已归并） | **24** 局（全 92 局，其中 68 局为子代理） |
| 有棋谱的局 | 7 |
| 主题 | **784**（`df≥2`：165） |
| 相关边 | **200**（shared-topic 72 / same-error 67 / same-file 61） |
| 工作区 | 4 个 `scopeKey` |

### R06 thread

| 项 | 值 |
|---|---|
| 卷 | **84** |
| 卷内棋谱数 | 2 局：58 卷；3 局：26 卷 |
| 入卷局数 | 20 / 24（4 局无判别性主题，不成卷） |
| 多对多 | **20 次**（一局属 ≥2 卷） |
| 卷种类 | file 27 / tool 16 / dependency 14 / term 11 / error 7 / domain 4 / scaffold 3 / repo 2 |
| 样本 | `@deepseek-ai/dsh`（3 局 3 条边）、`@deepseek-ai/schemastery`（3 局）、`<lan-ip>`（2 局）、`@deepseek-ai/cordis`（2 局） |

### R08 joseki

| 项 | 值 |
|---|---|
| 候选定式 | **0** |
| 有成功边的根局 | 5 / 24 |
| 成功边 | 54；窗口 94；其中 **88** 个窗口只有 1 局支撑（`singleSupport`） |
| 两局以上重复的签名 | **0**（44 个不同签名，没有一个出现在 ≥2 局） |
| 对照：全 92 局（含子代理） | 211 条成功边 / 108 个签名 / **0 个**跨局重复 ⇒ 仍然 0 候选 |

**为什么是 0（证据，不是阈值调参）**：上游 `verify.kind` 给成功边的只有 `write`（实测 `successes.verifyKind` 全为 `write`），即本机成功边 = "写了哪个文件"，而各局写的是不同路径；`bash` 一类命令没有退出码 ⇒ 归 `unsettled`，不进成功序列。因此机械签名在 24 局（乃至 92 局）里**没有一个跨局重复**，"同一成功序列在 ≥2 局重复"这个准入条件客观不成立。这是**诚实的少算**（方案 §5.1a「宁可少算，不可多算」），不是实现缺陷；要让定式长出来，需要上游把命令的 `exit 0` 也算成可验证成功（那是 R03/上游的判据，不在本任务范围）。

### R09 claim

| 项 | 24 根局 | 全 92 局（对照） |
|---|---|---|
| claim | **128** | 429 |
| 按 kind | fact 9 / antipattern 29 / preference 90 | fact 9 / antipattern 45 / preference 372 |
| 按 state | observed 123 / **candidate 5** | observed 411 / candidate 18 |
| 升到 `u:owner` | 1 | 4 |
| 带 counter | 0 | — |
| 丢弃 | generic 2（合成失败标记），其余桶 0 | — |

5 条 candidate（该时点全部）：

```
antipattern · support 3 · Error: DeepSeek returned no web_search_tool_result blocks; …
antipattern · support 2 · Error: cannot modify "<WORKSPACE>/projects/dsh-gitbash-shell-fork/tools/patch-installed-freeze.mjs"…
antipattern · support 2 · Error: the pwsh tool is hidden on this host by the dsh-gitbash-shell settings…
preference  · support 2 · 只把压缩本职工作做到最好，形成可执行改进项并落地验证。      （u:owner，跨工作区）
preference  · support 3 · - 主线只留必须在这里做的：全局取舍、与用户来回确认、需要连续上下文的判断。
```

## 5 · 幂等 / 确定性

```
$ node tmp/t6b-determinism.mjs
{ threads:{n:84,hash:aa1de6b7c238dfd7}, joseki:{n:0,hash:54e7323d83a0dd1d},
  claim:{n:128,hash:411668d65b387bef}, identical:true }   # exit 0
```

- 同一语料快照跑两遍，三房间输出**逐字节相同**；测试里另有「同输入两次 deepEqual + 入参不被改写 + 入参顺序变化不改变结果」。
- **不使用 `Date.now()`**：`recordedAt` 只取入参 `now`（缺省 `null`）；`createdAt/updatedAt/occurredAt` 全部由证据时间派生 ⇒ 重建可复算。
- 忠实记录一个坑：真实语料是活的，连跑两次的**语料**本身会变（本次前后从 783 主题涨到 784、成功边 53→54），所以幂等只能在**冻结快照**上验证（上面这行就是）。

## 6 · 风险与限制

1. **R08 在真实语料上产出为 0**（见 §4）。这是数据形态导致，不是阈值：把 `maxSteps` 调到 4/5 或 `minSteps` 保持 2 都不会变（0 个跨局重复签名）。若 Lead 想要 M2 有可见定式，唯一机械办法是让成功边覆盖 `bash exit 0`（R03 判据调整），**不建议**放宽"≥2 局独立支撑"这条 Q5 硬门槛。
2. **反例判据是保守近似**：R03 的 `failures[].quote` 是**错误原文**、没有动作签名，所以反例只能判"同一窗口内夹着失败边"，判不了"同一招失败了"。动作侧证据可通过 `support.edgeId` 回棋谱边取；更精细的反例判据需要 R03 暴露失败边的 action（后续房间）。
3. **卷数量偏高**（84 卷 / 24 局，2 局卷占 58 条）。原因：`df ≤ max(2, ⌈10%N⌉) = 3` 的阈值在小语料下把 `file`/`term` 主题也放进来了。卷是视图、删除不删谱，可读性应由 R07/R11 按 kind/links/日期过滤；要减少卷数属于产品取舍（不在本任务自裁范围）。
4. **子代理局**：三个房间都按"调用方传入什么就处理什么"工作；R08/R09 用「不同 sessionId + 非父子」判独立，R06 **不**做归并。入档管线（T6a）传的是已归并的 `corpus.episodes`（24 局），现状正确；若将来传全 92 局，卷会变多、定式/claim 的独立判定仍正确但 support 会含子代理局。
5. **accept 的数字带时点**：真实语料在动，重跑得到的绝对值会漂移（本次 128 claims → 下一分钟可能 129）。口径：分子/分母都取 `tmp/t6b-final.json` 的同一快照，跨时点不可比。
6. **`shares-joseki` 边不在 R05 的 `LINK_KIND_ORDER` 里**：R08 自带 `links` 输出，需要入档管线（或 R05 后续版本）把它并入 `links/`；本任务未改 `link.mjs`，避免和其他刀冲突。
7. **共享工作树的并发**：采数期间 `src/rooms/cli.mjs` 正被 T6a 改到一半（一度语法错误），我未修改它、等待其恢复后重跑；最终 `node --test` 150 条全绿、`check.mjs` PASS。若 Lead 合并时 `package.json` 的 `exports` 与 T6a 的改动重叠，以 Lead 的版本为准。
8. **`u:owner` 的升层**只按"跨 ≥2 工作区独立印证"这一条机械规则；用户身份默认 `owner`、可由 `options.user` 覆盖。这是方案 §4.10 的规则，但**尚未经多成员裁决**（R10 未建），因此本任务只给到 `candidate`。

## 7 · 复现

```bash
cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"

# 验收
node --test test/thread.test.mjs test/joseki.test.mjs test/claim.test.mjs
node --test
node scripts/check.mjs

# 真实语料数字（只读；写 tmp/，不进 git）
node tmp/t6b-final.mjs > tmp/t6b-final.json

# 幂等（同一快照两遍）
node tmp/t6b-determinism.mjs

# 合成夹具计数
node tmp/t6b-fixtures.mjs
```

## 8 · 数字口径

- **根局** = `buildCorpus({includeSubagents:false})` 的 `episodes`（`delegationDepth=0`，子代理按父局归并）；**全 92 局** = `allEpisodes`，仅作对照。
- **卷** = `buildThreads()` 返回的 `threads.length`；**入卷局数** = `assignments` 里 `threadIds.length>0` 的条数；**多对多** = `threadIds.length≥2` 的条数。
- **候选定式** = `promoteJoseki().joseki.length`（只可能是 `state:"candidate"`）；**窗口** = 所有 (局, 长度 2–3 连续成功边) 片段计数（同一签名重复出现也算多个窗口）；**签名重复** = 同一归一签名出现在 ≥2 个不同局（局内重复只算一次）。
- **claim** = `promoteClaim().claims.length`；**candidate** = `state==="candidate"`（≥2 独立局 + 无 counter）；**升层** = `scopeKey` 以 `u:` 开头。
- 时点 = `tmp/t6b-final.json` 的 `at` 字段（UTC）与 `elapsedMs`；语料在动，跨时点不可比。
