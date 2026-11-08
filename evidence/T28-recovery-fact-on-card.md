# T28 · 卡行补「恢复事实」（当时怎么修好的，事实形式）

> 日期：2026-11-08 · 只读派生（不回填、不写库）· 改动：`src/rooms/extract.mjs`（判据）、`src/rooms/inject.mjs`（读时派生 + 尾注）、`test/inject.test.mjs`
> 依据：`evidence/T26-factual-card-ablation.md`（事实型 25% vs 指令式 8.3%，p=0.125 —— 方向对但弱）
> 前置：`evidence/T311-extract-recovery.md` / `T339-command-recovery.md`（"同一主体后来成功"的机械判据）

## 0 · 一句话结论

失败 claim 的卡行现在会**多一段「恢复事实」尾注**：` · 恢复：后于 <日期> 同一命令成功（exit 0, seq N）` / ` · 恢复：后于 <日期> 同一文件写入成功（seq N）` / ` · 恢复：后于 <日期> 同一命令重跑（无失败输出, seq N）`。**只写事实，不写「你该这么做」**（AGENTS §2.1）。没有恢复证据的 claim，卡行**逐字节不变**（`recoveryOnCard:false` 整卡与改动前一致）。真库覆盖 **38/1560 = 2.4%** 的 antipattern claim（严格同命令 exit 0 为 0、重跑无失败 15、同文件写成功 23）——按"宁缺勿编"只报这个数，不拿放宽判据凑覆盖率。

## 1 · 判据（机械、只认显式成功）

| 种类 | 判据 | 卡上文案 |
|---|---|---|
| `same-command-exit-0` | 同一条 **bash 命令**（`tool/call.data.arguments.command`，空白归一后逐字相同）后来**再次执行**，结果里有 `[exit code: 0]` | `恢复：后于 <date> 同一命令成功（exit 0, seq N）` |
| `same-command-no-failure` | 同一条命令后来再次执行、**没有失败行**（是"重跑没报错"，不冒充 exit 0） | `恢复：后于 <date> 同一命令重跑（无失败输出, seq N）` |
| `same-file-write-ok` | 同一个 `file_path` 后来被 `write`/`edit` **写成功**（结果带 DSH 的成功标记：`has been updated successfully` / `Created file`…） | `恢复：后于 <date> 同一文件写入成功（seq N）` |

**共同约束**（缺一不产出）：
1. **同一主体**：命令逐字相同 / 文件路径相同（反斜杠→斜杠、小写归一）；不同主体不算（T311b 的"不许凑数"）。
2. **更靠后**：恢复事件的 `seq` 必须大于失败事件；取不到时间或序号 ⇒ 不产出（无源不入、无时不入）。
3. **只认显式成功**：`[exit code: 0]` 或 `write/edit` 成功标记。宁缺：抓不到就**不写**（不写"可能修好了"）。
4. **同一局**：只在失败所在那一局（同 `session.id`）里找 —— 跨局"后来成功"无法证明是"当时怎么修好的"。
5. **指针行不带恢复事实**：与 F3 同一条纪律（指针行没有正文，恢复事实也属于正文的注）。

为什么不是 F3：`falsifiableWhen`（T310/T345）是**文本派生**的"何时算我错"；本刀是**事件派生**的"当时怎么修好的"。两者不重叠、可同时出现（同一行会先 F3 尾注、再恢复尾注）。

## 2 · 实现（读时派生，零数据迁移）

| 位置 | 改动 |
|---|---|
| `src/rooms/extract.mjs` | 新增纯函数 `buildRecoveryIndex(events)`（解析 `tool/call`↔`tool/result`，产出 `runs`/`failures`）与 `findRecoveryFact(index, quote, {nearSeq})`；`failureLineOfText` / `recoverySubjectOfText` / `recoveryMatchPrefix` 辅助；`RECOVERY_FACT_KINDS` 单一来源 |
| `src/rooms/inject.mjs` | `recoveryFactOf()`：只对 `kind==='antipattern'` 的**正文行**派生；读该局会话日志（`closure.logPath`，相对 `dirname(store.root)`）→ 索引缓存（key=size+mtime，LRU 24 局）→ `findRecoveryFact`；`buildEntry` 存 `recovery:{kind,seq,at}`；`renderEntryLine` 追加尾注；`buildMemoryCard` / `collectEntries` 新增开关 `recoveryOnCard`（默认 `true`）与 `recoveryBaseDir` |
| `test/inject.test.mjs` | T28 ①–⑥（见 §6） |

**为什么读时派生**（T347 的口径）：恢复事实是**事件**的属性，store 里没有（episode 只存信号计数；`scripts/extract-recovery.mjs` 的 174 条恢复从未落库）。回填 = 拿现在的库编过去，禁止；归档层落新字段又要改 `archive/claim` 的写路径（本刀可写路径不含）。⇒ 只在**读卡时**从原始会话日志机械派生，**不写任何数据**。

**代价与边界（如实）**：
- inject 首次引入 **R01 `logread` 依赖**（此前只读 store/index/sigindex）。这是本刀唯一的结构性妥协：只为"读时派生"，读不到/解析失败 ⇒ `null`，卡行零变化。
- 冷启动**要解一局的 zstd**（实测大日志 ~100–200 ms/局）；同一进程内按 `size+mtime` 缓存，热路径 0。只在**要渲染 antipattern 正文行**时才付这个成本。
- 索引只存派生结果（runs/failures），不存事件原文；上限 24 局（LRU）。

## 3 · 卡行形态（前后对照，同一批输入、同一库）

同一批真实信号（20 条主题词），`recoveryOnCard:false` vs 默认：

| 读数 | 关 | 开 |
|---|---|---|
| 有展开的卡 | 10 | 10 |
| 卡行合计 | 34 | 34 |
| **变化的行** | — | **2 行**（同一 claim 在两题里各出现一次） |
| 卡片 tokens 合计 | 2233 | **2265（+32）** |
| 构建耗时（20 题合计） | 11.82 s | 14.06 s（**+2.24 s**，含解日志；热缓存后趋 0） |

逐字样例（真库）：

```text
关：- [antipattern] Error: cannot edit "…/CHANGELOG.md": binary file (ep-8cc34e32, 2026-11-06, seq 44262)
开：- [antipattern] Error: cannot edit "…/CHANGELOG.md": binary file (ep-8cc34e32, 2026-11-06, seq 44262) · 恢复：后于 2026-11-06 同一文件写入成功（seq 48687）
```

- 尾注在**坐标之后**（与 F3 同位），正文仍是逐字原文（A6 文字层只核正文；`PROVENANCE_LINE_RE` 允许可选尾注）。
- **没有恢复证据的行逐字节不变**（见 §6 的 ③④⑤）。
- 恢复事实**不带祈使句**（`auditImperatives` 断言为空）。

## 4 · 真库覆盖（宁缺勿编，如实报）

对 1560 条 antipattern claim（108 个有日志的局，逐局解析会话日志）跑判据：

| 读数 | 值 |
|---|---|
| 能按引文定位到失败事件 | **971 / 1560（62.2%）**；定位不到 589（引文被截断/合并/不在 tool/result 里） |
| `same-command-exit-0` | **0**（命令很少被**逐字**重跑；重试通常带改动） |
| `same-command-no-failure` | **15** |
| `same-file-write-ok` | **23** |
| **合计有恢复事实** | **38 / 1560 = 2.44%** |
| 同一段错误在一局里出现多次（按 `nearSeq` 取最近） | 305 条 |

**为什么这么低（不是判据太严，是事实稀缺）**：
- T338 已诊断：86.73% 的失败没有文件路径主体；本刀要求"同一主体"，天然抓不到"换个命令绕过去"的恢复。
- **命令级严格 0**：人们重试时几乎不会把长命令原样再打一遍（会改参数/换工具）。
- 所以本刀**只增加事实、不制造事实**：2.4% 是这份语料的上界附近，放宽到"任意后续成功"会把噪声当恢复（T311b/知识库 54 已禁止）。

## 5 · 为什么收益还没被证明

- 本刀只改**卡形态**（加事实），不改召回/排序；A2b 口径测不到它（与 T347 的 F3 同理，Δ 应为 0）。
- **收益要等下一轮 ablation**：用"事实 + 恢复事实"的卡跑 T26 那套 12 对合成坑（env），看 A 臂踩坑率是否从 25% 往 T23 的 8.3% 靠。
- **诚实提醒**：线上指针档默认开（`pointerTier:true`），`observed` 且 1 局支撑的 antipattern 渲染成**指针行**（没有正文）⇒ 恢复事实默认不挂在指针行上。实际曝光 = "内容行 ∩ 有恢复事实"，比 2.4% 更低。如果下一轮 ablation 要测这件事，卡里应显式带恢复事实（手写卡即可），不要依赖线上默认形态。

## 6 · 测试（`test/inject.test.mjs`，6 条全绿）

| # | 断言 |
|---|---|
| T28 ① | 同命令后来 exit 0 ⇒ 卡行多出 `恢复：后于 2026-10-20 同一命令成功（exit 0, seq 4）`；`PROVENANCE_LINE_RE` 仍能解析、正文不含尾注、`auditImperatives` 为空 |
| T28 ② | 同文件后来写成功 ⇒ 多出 `恢复：后于 2026-10-20 同一文件写入成功（seq 8）` |
| **T28 ③（tombstone）** | 没有恢复证据 ⇒ 卡行与 `recoveryOnCard:false` **逐字节相同**；非 antipattern 行也逐字节相同 |
| T28 ④ | `recoveryOnCard:false` ⇒ 整卡无任何恢复尾注，且同输入两次构建逐字节相同 |
| T28 ⑤ | 日志损坏/缺失 ⇒ 不抛、卡片照常渲染、无恢复尾注 |
| T28 ⑥ | 纯函数：不同命令成功不算；同命令再次失败不算；空白归一后同命令的"重跑无失败"= `same-command-no-failure`；重复失败按 `nearSeq` 取最近 |

另：`test/inject.test.mjs` 全文件 **85 条 / 84 pass / 0 fail**（1 skipped 为既有用例）；全量测试见 §8。

## 7 · 限制 / 风险（不许当结论用）

1. **覆盖率低**（2.4%）⇒ 线上单卡命中率很低；别把"加了恢复事实"当成"避坑率会涨"的证据。
2. **同局限定**：跨会话的"后来在别处修好了"不算（无法证明因果），会进一步压低覆盖。
3. **指针档**：默认指针行不带恢复事实（与 F3 一致），实际曝光更低。
4. **读日志成本**：冷启动 ~100–200 ms/局（热缓存 0）；只在渲染 antipattern 正文行时发生。生产 pre-step 是热路径，**这个延迟是新加的**，已记在这里而不是藏起来（未来若嫌慢，正解是在归档层落一个恢复索引，见 §9）。
5. **R01 依赖**：`inject` 首次依赖 `logread`（见 §2）；读不到日志时行为与改动前逐字节一致。
6. **token**：每条尾注 ~16 tokens（`恢复：后于 2026-11-06 同一文件写入成功（seq 48687）`）；5 行全带 ≈ +80 tokens，占 500 预算的 16%——预算自限仍生效（超预算先降条数）。
7. **判据仍有代理性**：`same-file-write-ok` 只证明"同一文件后被写成功"，不证明"这是当时为解决这个错而做的"；卡上写的是事实，读者自己推断。

## 8 · 复现

```bash
# 1) 判据 + 卡行（6 条）
node --test --test-name-pattern "T28" test/inject.test.mjs

# 2) 真库覆盖率（逐局解析会话日志；~14 s）
node tmp/t28-probe.mjs

# 3) 同一批真实信号的前后对照（行差异 / token / 耗时）
node tmp/t28-ab.mjs

# 4) 手工最小样例（打印开/关两张卡）
node tmp/t28-check.mjs

# 5) 全量
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- 三种尾注：同命令 exit 0 / 同命令重跑无失败 / 同文件写成功；
- 真库覆盖 **38/1560 = 2.44%**（严格 exit 0 = 0）；
- 前后对照：34 行里 **2 行变化**、+32 tokens、冷解析 ~100–200 ms/局；
- 无恢复证据 ⇒ **逐字节不变**（tombstone ③④⑤）。

## 9 · 下一步（不在本刀）

1. **下一轮 ablation**：用"事实 + 恢复事实"的卡跑 T26 的 12 对（env 坑），与 25% / 8.3% 对照。
2. **提高覆盖**：在**归档层**落"恢复索引"（`extractSignals` 时窗口已有事件，可产出 `recoveries[]`），卡行读索引即可（0 解析成本）；这需要改 `archive/claim` 的写路径，本刀可写路径不含。
3. **判据扩展**（要另立证据）：`tests-pass` / `build-success` / `git-clean` 在同主体约束下 T338 实测新增 0，暂不接。