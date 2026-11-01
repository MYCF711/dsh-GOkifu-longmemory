# T2 报告 · R02 graphread + R03 extract（2026-11-02）

> 任务 id：**task-2**（`T2: R02 graphread（基线+delta 回放）+ R03 extract（信号抽取）`）
> 分支：**main（未提交）** —— 按 Lead 2026-11-02 02:47 指令「团队共用工作树，禁止各自 checkout/switch，文件保持未提交，由 Lead 按文件范围提交」。
> commit sha：**无（未提交）**。建议 Lead 按「一刀一个 commit」拆两条：
> `R02 graphread: 基线 + delta 逐帧回放，坏尾截断/版本拒绝`、
> `R03 extract: 失败/成功/未结算/约束/工具的机械抽取（seq+quote 溯源）`。
> 我此前建的 `feat/t2-graphread` 分支已删除（tip 与 main 上的 fe6ceeb 同内容，无提交丢失）。

## 0 · 交付物

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/rooms/graphread.mjs` | 197 | R02：`loadGraphAt` / `applyDelta` / `decodeDeltaFrames` / `checksum31` / `baseHashOf` / `rebuildStateIndex` |
| `src/rooms/extract.mjs` | 371 | R03：`extractSignals` / `extractConstraints` / `matchedConstraintWords` / `messageText` / `clip` |
| `test/graphread.test.mjs` | 21 条 | 真实棋谱 3 张 + 合成夹具（upsert/del/order/scalars/stateIndex/坏尾×4/版本×2/缺失/损坏） |
| `test/extract.test.mjs` | 12 条 | 事件夹具（形状取自真日志）+ 真实棋谱 2 张 + 口径闭合自检 |
| `reports/T2-REPORT.md` | 本文件 | 数字与风险 |

辅助脚本（`tmp/`，**不进 git**，可复现）：`tmp/sweep-t2.mjs`（全库扫 + 零写入指纹）、`tmp/verify-events.mjs`（真日志事件侧交叉核对）、`tmp/probe-events.mjs`（事件形状侦查）。

## 1 · 验收

```
$ node --test test/graphread.test.mjs test/extract.test.mjs
ℹ tests 33   ℹ pass 33   ℹ fail 0   ℹ skipped 0   duration_ms 190.5

$ node scripts/check.mjs
ok  private:true / version=0.1.1 / changelog / 六大文档 / 房间齐 / branch=main
check: PASS

$ node --test            # 全仓
ℹ tests 66   ℹ pass 65   ℹ fail 1   ← 唯一红的是 test/topic.test.mjs（T3 正在写，SyntaxError: Unexpected token '>'），与本任务无关：topic 不 import 我的两个房间。
```

## 2 · 真实数字（2026-11-02 02:55 实测，`[本]`）

### 2.1 三张真实样本（tombstone 测试直接吃它们）

| 样本 | sid | 基线 节点/边 | **回放后 节点/边** | delta 帧 | failure 边 | success | 约束 | 工具名 | 回放幂等 |
|---|---|---|---|---|---|---|---|---|---|
| **A（主）** | `session-1286ce28-dba8-448b-9827-e6ccacdf9806` | 141 / 155 | **172 / 188** | **43** | **6** | 16 | 1 | 12 | ✅ 再回放整批帧 → 图逐字相同 |
| **B（主）** | `3a50f4d2-8df2-4fc6-9a1d-6f69d16e594c` | 1 / **0** | **23 / 26** | **41** | **1** | 1 | 5 | 3 | ✅ |
| C（对照） | `fa84bf69-0e4b-422c-aed9-85b8c2462359` | 51 / 77 | 51 / 77 | 0 | 4 | 23 | 4 | 6 | n/a（无 delta） |

**样本 B 是"直接 `JSON.parse` 少一回合"的极端证据**：基线里 **0 条边**，回放 41 帧后 **26 条边**——只读基线等于把这局棋看丢了。

### 2.2 全库扫（15 张棋谱，`$DSH_HOME/chess-context/sessions/*`）

```
棋谱 15 张全部读出：0 坏、0 truncated、0 版本异常
节点 1,005 / 边 1,158 / delta 帧 232
信号：failure 50 / success 133 / unsettled 975 / 约束 30 / 工具名 96（按局去重后求和）
桶闭合：15/15 局「failure+success+unsettled+noSource+noQuote+unknownResult == 边数」
回放幂等：10/10 有 delta 的局，再回放一次图逐字相同
耗时：62.9 ms（全库，含 JSON 解析与 232 帧回放）
零写入：扫前后对 chess-context 全树做 (size, mtime) 指纹，sha256 完全一致（403e5280…）
```

> 注：AGENTS §7 记的「11 张棋谱」是 2026-11-01 22:40 时点；02:55 已有 15 张（今天新开的会话陆续落谱）。

### 2.3 事件侧（真日志交叉核对，非单测）

纯读侦查脚本（`tmp/`，不进 git）逐帧解 zstd 后喂给 `extractSignals({events})`：

| 日志 sid | 帧 | 事件 | 真实用户消息 | tool/call | 抽到约束 | 抽到工具 | 与棋谱侧对照 |
|---|---|---|---|---|---|---|---|
| `3a50f4d2-…` | — | 182 | **1** | 26 | **5** | **3** | 事件侧 5 约束 / 3 工具 **== 棋谱侧 5 / 3**（逐句逐名相同） |
| `session-8cc34e32-…` | 983 | 1,861 | **10** | 279 | 8 | 19 | 该局棋谱只落了 1 个 user 节点（2 条约束）⇒ **事件侧比棋谱侧更全**，故 events 优先 |

## 3 · 实现要点（只说会被误读的）

### R02 graphread

- **帧格式**：一行一帧 `<基线 sha256 前16位>\t<checksum31 十进制>\t<delta JSON>`；`checksum31` 是 `h=(h*31+charCode)|0` 的便宜校验（挡半写，不是密码学）。
- **为什么用 `node:crypto`**：帧首列就是「它写在其上的那份 `graph.json` 文本」的 sha256 前 16 位，不比对无法判断帧属于哪份基线。这是格式硬要求，不是新增依赖；不引上游包、不复制上游源码，帧解码/应用按格式独立实现（语义对齐上游 `kifu-model.mjs`：upsert 绝对覆盖、`delNodes/delEdges` 删除、scalars 白名单、order 追加去重、`stateIndex` 派生重建）。
- **返回值是包装不是裸图**：`{graph, baseHash, frames, truncated, reason, missing, corrupt, error}`。因为契约要求「坏尾 → 返回已回放前缀 + `truncated:true`」，裸图装不下这个旗。**下游 R05/R07/R14 要取 `.graph`**。
- **坏尾四种 reason**：`malformed-frame`（没有两个 tab）/ `checksum`（帧体被改）/ `base-mismatch`（旧基线留下的帧，整段忽略）/ `bad-json`。`truncated` 为真时 `reason` 必非空——不许静默截断。
- **版本未知抛错**：基线 `graphread: unsupported version N`；帧 `graphread: unsupported delta version N`。**缺失/损坏不抛**（`missing:true` / `corrupt:true` + `error`），因为库扫描时"没棋谱"是常态，但损坏必须立旗、不许降级成空图。

### R03 extract

- **桶映射**：`failure→failures`、`success→successes`、`untested/unverified/pending→unsettled`、其余值 → `dropped.unknownResult`（**不猜**）。
  **`unverified` 不是成功**：它是"工具跑了但没有退出码"，全库 84% 的边（975/1158）落在这里，原 `result` 保留在条目上供下游区分。
- **约束只认用户原话**：事件侧要求 `type==="user/message"` **且** `data.source.kind==="user"`。真日志里同类型事件还有 `agent-instructions(30)` / `time-context(9)` / `runtime-context(3)` / `agent-message(3)` / `subagent-settled(3)` / `skill-catalog(2)` / `plugin:hindsight(2)` / **`compact-checkpoint(1)`** / `chess-context(1)`——**模型压缩摘要就在里面**，从它抽约束就是自证污染，一条都不采。
- **切句与约束词**：按 `。！？!?；;` 与换行切句、逐字保留原句、每段 ≤40 句（与上游 `extractConstraints` 同口径）；词集在它的 `必须|不要|不能|不许|禁止|只能|一定要|务必|记得|注意|要求|永远|绝不|never|must|do not|don't|only|always|required` 之外补 `不准`、`以后|下次|默认|应该|最好|避免|remember|avoid|prefer`（软档），`别` 只收有限动词前缀（`别忘/别再/别用/别把/别删/别动/别改/别碰/别写/别说`），单字"别"不认（区别/类别误报太多）。
- **引文优先级**：失败边 `errorSnippet` → `verify.summary`（仅 `exit`/`host-error`，那是原始失败事实）→ `action`；成功/未结算边用 `action`（"怎么做的"才是可复用的那一手，`exit 0` 不当引文）。全部按码点截到 **≤200 字**（CJK 不按字节切），截断补 `…`。
- **源分层**：给了 `events`（或 R01 `parseEvents` 的 `{header, events}` 整体）就用事件；没给才回退棋谱（`kind:"user"` 节点的 `text`/`constraints`、边的 `action` 前缀取工具名）。同一批事件派生出的棋谱不重复计入约束。

## 4 · 风险（按严重度）

1. **真实样本断言依赖棋谱冻结**（中）：A/B/C 三张目录 mtime 停在 2026-11-01 22:xx–22:30，断言里写死了「帧数 ≥1」「回放后边数 > 基线边数」「基线 0 条边」。若上游 fold 重写基线并压缩 delta（实测 `session-1e82afca` 就从 18 帧变 2 帧、基线从 125/133 变 141/148），这三条会红。**应对**：红了先看是不是基线被重写，按新数字更新（不要放宽成 `>=`，那样 tombstone 就失效了）。
2. **`unsettled` 体量会淹没下游**（高，但属设计选择）：975/1158 边（84%）是 `unverified`。R08/R12/R05 若直接吃 `unsettled`，噪声压过信号。建议下游只用 `failures` + `successes`，`unsettled` 只作"未验证"计数。
3. **约束词规则有假阳性**（中）：`3a50f4d2` 的 5 条约束**全部**来自一句子代理任务书的模板行 `- **约束清单**（用户说的不能做/必须做）`（命中"不能/必须"）。词法规则抓不到"这是元描述不是要求"。目前只靠 `level: hard|soft` + `nodeId/seq` 让下游可复核，**没有做语义过滤**（那会引入模型判断，越界）。
4. **子代理会话里"用户"是 Lead**（中）：task 书以 `user/message(source.kind="user")` 出现，会被当作用户约束。对记忆系统这是可接受的（对子代理而言 Lead 就是用户），但跨会话统计时要知道这批"约束"来自父代理而非人。
5. **`sessionId` 目录名有两种前缀**（低）：`sessions/` 下既有 `session-<uuid>` 也有纯 `<uuid>`。R02 不推导目录（只吃 `basePath`），但 R14 扫库时必须两种都认，否则漏局。
6. **事件形状依赖 R01**（低）：我用真日志验证了 `user/message`（`data.content[].text` + `data.source.kind`、`data.role`）与 `tool/call`（`data.name` / `data.arguments` 字符串）的形状；`messageText` 做了容错，但若 R01 改输出形状，事件侧要同步。
7. **`package.json` 的 `exports` 没加 R02/R03**（低）：我只动 `src/rooms/*.mjs`、`test/*.mjs`、本报告；包面导出（`./graphread`、`./extract`）留给 Lead 决定，避免撞文件。
8. **本任务只读承诺的验证方式**（低）：代码只调 `readFileSync`/`existsSync`；全库扫前后 chess-context 全树 (size, mtime) 指纹一致；`$DSH_HOME/sessions` 只在 `tmp/` 侦查脚本里被只读解压过。

## 5 · 口径（不可跨时点比较）

- 所有数字为 **2026-11-02 02:55 工作树实测**，`[本]`；棋谱库当时 15 张、其中 4 张仍在被活跃会话追加（`truncated:false` 只是那一刻的读法结果）。
- 「回放后边数 > 基线边数」的严格判据**只对冻结样本**成立；活跃会话在两次读之间可能继续增长，故测试对活跃态只断言 `≥` + `truncated ⇒ reason 非空`。
- `工具名 96` 是「按局去重后求和」，不是全库去重（同局同名只算一次，跨局重复计）。
