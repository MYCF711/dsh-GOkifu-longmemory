# v0.10.0 独立严格审核（外部审核员）

> 审核对象：`MYCF711/dsh-gokifu-longmemory`，**HEAD = `ec7b6d8`（v0.10.0）** + 审核期间工作树上的未提交改动。
> 审核时刻：`2026-11-02 05:09–05:25 +08`（本地；UTC 见各命令输出）。
> 审核人立场：**外部审核员**——按"是否达到可交付/可安装"判定，不替实现辩护，不修改任何功能代码。
> 本轮**只写本文件**；未 `git checkout/commit`、未安装、未重启、未写 `<DSH_HOME>`。

## 0 · 审核快照（先说清楚"审的是哪棵树"）

| 项 | 值 |
|---|---|
| HEAD | `ec7b6d8 M5: 负迁移防线演练（11/11 拦住，0 泄漏） (#18)` |
| 最新 tag（本地） | `v0.9.0`；`v0.10.0` 在远端有 Release（`gh release list` 可见，`2026-11-01T21:09:28Z`） |
| `package.json` | `version 0.10.0`、`private:true`、18 个 exports |
| 工作树 | **不干净**：`M AGENTS.md`、`M 方案.md`、`M docs/对标-Hindsight.md`；`?? docs/staging/`、`?? scripts/stage-check.mjs`（审核期间 Lead 正在补文档） |
| 文档指纹（sha256 前 16） | AGENTS `c339e4ae060b6276` · CHANGELOG `c8ecb2a9a63c63d0` · MAINTENANCE `803944d394515a0c` · README `cb944d05ff9c5053` · 安装指南 `cc76259a2a733ed6` · package.json `03eeb1c9d870788c` |
| 语料/记忆库 | 只读使用 `tmp/memory-context`（store: 92 局 / 125 claim / 780 主题 / 199 边 / 83 卷 / 0 定式）与 `$DSH_HOME`（只读） |

> ⚠ 未提交改动意味着：**"v0.10.0 发布树" ≠ "当前工作树"**。§1/§3 中凡涉及"文档说了什么"，均标注是 HEAD 还是工作树；Lead 正在同步的改动（AGENTS §3/§7 阶段、方案 §8.2b 的 13.33%、对标 §4.5 的 13.33%）已按工作树现状计。

---

## 1 · 验收对齐（方案 §8/§9 vs 仓库实际）

### 1.1 方案 §8.2 的判据 vs 实测（逐项）

| 指标 / 判据 | 方案要求 | 仓库实际（本轮复算/核对） | 对齐结论 |
|---|---|---|---|
| `repeatFailureRate`（A2，主判据） | 相对无记忆的下降幅度**不劣于 Hindsight** | 13.33%（14/105，机械代理，**无配对重放**） | ⚠ **未达标**：只有代理值，无"有/无记忆"对照；仓库自己也写"不是收益"（`方案.md:687`、`docs/对标-Hindsight.md:126`） |
| `negTransferRate`（A1，≤5% 硬上限） | 注入条目被否定/不适用的比例 ≤5% | 只测 `staleTransferRate` = 0%（0/9），**validity 覆盖率 0/8（空转）**；`preconditions` 面由闸 3 预先过滤，**不可观测**；无影子/人工抽样 | ⚠ **未验证**：0% 是"没被锻炼"；仅覆盖 validity 一项，未覆盖方案定义中的"preconditions 不满足却被使用" |
| `injectFailureRate`（A3，=0） | 线上注入失败率 = 0 | `m5-report` = 0，状态 **`not-live`**；`host-sim` 仿真 40/40、failed 0 | ⚠ **仅仿真**：能力在，未上线；两处状态并列（`AGENTS.md:287` 写 simulated、`evidence/M5-six-axis.md` 写 not-live） |
| `injectLatency`（A4，**p50,p90** ≤50ms） | p50、p90 ≤50ms | 本轮 p50 **1.5ms**、p90 **4.67ms**（m5-report）；bench 三轮 p50 1.4/1.7/2.0、p90 10.1/20.2/11.6 | ✅ **达标**（按方案判据） |
| 同轴 p95（**方案未设此判据**） | — | 仓库写作"p95 5.55ms，p95 门槛达标"；本轮 p95 = **8.45 / 16 / 23 / 70.2ms**（4 次；其中 1 次 >50ms） | ❌ **不可复算**（见 §2） |
| `injectTokens/step` | ≤500 | p50 46（m5-report）· p50 300（host-sim） | ✅ 达标 |
| `crossScopeLeakRate`（A5，=0） | =0 | 0（n=6 渲染行；walk 拒跨域 655） | ✅ 达标（样本小，见 §3） |
| `provenanceCoverage` / `timestampCoverage`（A6，=100%） | 100% | 100%（n=6 渲染行） | ✅ 达标（样本小） |
| `hopPrecision`（≥70%，M5 定） | ≥70% | S0 87.38%（35 样本）；**任务句层 66.67%**（`evidence/M4-precision.md:307`） | ⚠ **分层未达标**：总体过线靠高 df 键层（93.59%），真实任务句层 <70%；`方案.md:689` 未带此分层数 |
| `overfitGap` / V2–V5 | M5 需 V1–V5 与 H1–H3 | 只有 V1 代理 + H1；V2 `posTransferRate`、V3 `resumeFidelity`、V4 `memoryHitRate`、V5 `constraintRetention` **均未测** | ❌ **未达标**（见 §1.2） |

### 1.2 方案 §9 里程碑 M5 的验收行

> 原文：「留出集上 V1–V5 与 H1–H3 达到阈值（Q2 判据，M5 校准）；六轴全过才允许说"比 Hindsight 强"」。

- 仓库**没有**任何"比 Hindsight 强"的结论（`docs/对标-Hindsight.md:121,145` 明确"不构成结论""擂台未开打"）——这一点是诚实的。
- 但 AGENTS §3（工作树）已写 **"当前阶段：M5 收口（0.10.0）"**，而 §9 的 M5 验收面只完成了 V1（代理）与 H1 一项；V2–V5、`overfitGap` 没有任何读数。**"收口"一词超出了证据范围**，应写"M5 指标面收口（六轴可复算）/ V2–V5 未测"。

### 1.3 CHANGELOG / evidence / MAINTENANCE 三者的一致性

| 事实 | CHANGELOG | evidence/ | MAINTENANCE | 一致？ |
|---|---|---|---|---|
| 版本 0.10.0、340 条测试 | ✅ `0.10.0` 段 | — | 头写 0.10.0，**正文写 0.7.0 / 327 条** | ❌ |
| A2 13.33%（14/105） | ✅ 0.8.0/0.8.1 | ✅ `M5-six-axis.md` | 未提 | ⚠ 仅正文缺失 |
| A4 p50 1.14 / p95 5.55 | ✅ 0.8.1 | ✅ 同值 | 头写 p50 1.14 / p95 5.55（与复算不符，见 §2） | ❌（不可复算） |
| A1 0% 空转 | ✅ 明确写"0/9 空转" | ✅ `vacuous:true` | 只写 0/8 覆盖 | ✅ |
| redteam 11/11 | ✅ "11 个坏记忆样本" | ✅ 表含 baseline 行 | 未提 | ❌（实为 10 坏 + 1 控制，见 §3.2） |
| 本机语料 | 0.3.0 段：784 主题 / 212 边 / 84 卷 / 128 claim | M5-six-axis：780 主题 / 125 claim | 780 / 199 / 83 / 125 | ❌（两套数并存，见 §3.4） |

**§1 小结**：六轴的"可复算框架"做得扎实（一条命令、`--json`、缺数据记 `not-consumed` 而不是 0），诚实声明密度也高；**未达标项仍然是方案自己列的那些**（A2 无配对重放、A1 空转、A3 未上线、V2–V5 未测）。问题主要不在"有没有藏"，而在**几处数字被写成了比证据更强的东西**（§2/§3）。

---

## 2 · 数字自跑复算（3 个关键数字）

> 全部在 `tmp/memory-context`（92 局 / 125 claim）上复算；**零模型调用**；命令与退出码如下。

### 2.1 A2 `repeatFailureRate（LOO）` = 13.33% —— ✅ **完全复现**

```bash
$ node scripts/m5-report.mjs --store tmp/memory-context --workspace . --json   # exit 0 (26.4s)
A2: value 0.13333333333333333  n=105  status=measured
    detail: repeat 14 / novel 91 / sigma 0.03317 / rootEpisodes 24 / evaluated 19
$ node scripts/eval.mjs --store tmp/memory-context --workspace . --json        # exit 0
both 14/105 = 0.133333  coverage 0.79167 | edge 10/56 = 0.17857 (cov 0.29167) | event 16/120 = 0.133333
```

**结论**：13.33% 逐位一致，`edge`/`event`/`both` 三个变体的分子分母也与 evidence 完全一致。**可复算**。

### 2.2 redteam 11/11 —— ✅ 复现，但**计数口径多算 1 个**（详见 §3.2）

```bash
$ node scripts/redteam.mjs        # exit 0
"total": 11, "blocked": 11, "leaked": 0
```

### 2.3 A4 p95 = 5.55ms —— ❌ **不可复现**

```bash
$ node scripts/m5-report.mjs --store tmp/memory-context --workspace . --json   # exit 0
A4: value 1.5 (p50) · detail p50 1.5 / p90 4.67 / p95 8.45 / max 107.36 · coldCache 374.7ms

$ node scripts/bench-inject.mjs tmp/memory-context "w:d:/DeepSeek Harness/default-workspace/长期记忆系统"  # 三次，exit 0
run1: p50 1.4 / p90 10.1 / p95 16.0  / max 91.6
run2: p50 1.7 / p90 20.2 / p95 70.2  / max 104.6
run3: p50 2.0 / p90 11.6 / p95 23.0  / max 43.0
```

| 量 | 文档值（`CHANGELOG.md:41`、`AGENTS.md:287`、`evidence/M5-latency.md`） | 本轮 4 次复算 |
|---|---|---|
| p50 | 1.14ms | 1.4 / 1.5 / 1.7 / 2.0 ✅ 同量级 |
| p90 | 3.48ms | 4.67 / 10.1 / 11.6 / 20.2 ⚠ 3–6× |
| **p95** | **5.55ms** | **8.45 / 16 / 23 / 70.2** ❌（最高一次超 50ms 判据） |
| max | 103.1ms | 43–107ms ⚠ 波动大 |

**判定**：这是**单次运行的微基准**，被写成了仓库级事实（"p95 门槛达标"）。按任务判据"不一致即为缺陷"——**p95 不一致，属缺陷**。同时暴露一个口径错误：方案 §8.2 的判据是 **p50,p90 ≤50ms**（原文 `注入失败率 / 注入延迟（p50,p90）`），仓库却自造了"p95 门槛"。按方案判据 A4 **达标**；按仓库自造的 p95 判据，**我的一次复算就不达标**。两个口径必须二选一，并把数字改成区间 + 说明采样方式。

---

## 3 · 口径诚实（全仓 grep + 人工读）

做的检查：`grep -rn "收益|线上|生产|live|提升|减少.*失败|少走弯路"`、`grep -rn "87.38|S9"`、逐条读 `CHANGELOG` 0.6–0.10、`evidence/*`、`MAINTENANCE`、`README`、`方案 §8.2b`、`docs/对标 §4.5`。

### 3.1 做得好的（先记账，避免只挑错）

- **A2 到处都写"机械代理、不是收益"**（`CHANGELOG.md:66,148`、`方案.md:687`、`docs/对标-Hindsight.md:126`），并给了 CI/1σ、明写"不可外推、不可跨语料与 Hindsight 比"。
- **A1 明写"空转"**（`CHANGELOG.md:45`、`evidence/M5-six-axis.md` A1）；**A3 明写"not-live / 仿真不是线上"**（`CHANGELOG.md:33`、`evidence/M5-host-sim.md` 首段）。
- **没有发现**把仿真写成线上、把注入条数写成收益的表述；Hindsight 对比一节明确"擂台未开打"。

### 3.2 ❌ **redteam "11/11" 把控制组算进了"拦住"**（中等）

- `scripts/redteam.mjs:39` 第 0 个 case 是 **baseline（合格卡）**，期望 `GATE0_PASS`——它是**验证"闸门不误杀"的控制组**，不是坏记忆。
- 末尾统计 `blocked = cases.length - bad.length`（`scripts/redteam.mjs:末段`）把"期望命中"一律计为 blocked ⇒ 输出 `total 11 / blocked 11`。
- 于是 `CHANGELOG.md:7,15`「**11 个坏记忆样本**全部被闸门拦住」与 `test/redteam.test.mjs:9` 的测试名 **多算了 1 个**。真实结论是：**10 个坏样本全部拦住 + 1 个合格样本未被误拦**（后者其实是更强的证据，应该单独报）。
- 影响：headline 证据被抬高 10%；不致命，但属于"数字口径"缺陷，且很容易改（把 baseline 标成 `control` 并从 blocked 里剔除）。

### 3.3 ⚠ **A2 的 13.33% 分母里约 35% 不是"错误文本"**（中等）

- 口径 `both` = 逐局优先 R03 边失败，**没有棋谱的局用事件兜底**（`tool/result` 以 `[exit code: N≠0]` 结尾）。事件兜底的"签名"是**命令输出文本**，不是动作。
- 我按 `perEpisode` 明细数：**91 个去重签名中有 32 个（35%）不含任何错误词**，例如 `storages`、`--- compaction ---`、`=== new files ===`、`drwxr-xr-x 1 weicong …`、`mirror+verify ok: 23 / 23`、`bytes 230`、`dns.google -> 000`。这些是"非零退出但输出正常"（grep 无匹配、ls、脚本中途 exit 1 的 section header）。
- 方案 §8.2 的 V1 定义是"**执行了馆里已结算失败动作**"——更接近 `edge` 变体（10/56 = 17.86%，但覆盖仅 29.2%）。仓库把"both"当 headline 并在 `方案.md:687` 用一行"both 口径"带过，**没有披露 35% 的非错误文本**。
- 建议：headline 同时给 edge/event/both 三行的"噪声占比"，或对 event 兜底加一层"输出需含错误标记"的过滤后重算。

### 3.4 ❌ **语料基线有三套数，六轴跑在旧的那套上**（中等）

| 来源 | episodes | topics | links | threads | claims |
|---|---|---|---|---|---|
| `AGENTS.md:286`（`[本] 03:12`） | 24 局 + 68 子代理 | **784** | **212** | **84** | **128** |
| `CHANGELOG.md` 0.3.0 | 92 | 784 | 212 | 84 | 128 |
| `evidence/M2-archive.md`（dry-run，03:13） | 92 | 784 | 212 | 84 | 128 |
| `MAINTENANCE.md:33`（`[本] 03:40`） | 92 | **780** | **199** | **83** | **125** |
| **实际 store `tmp/memory-context/manifest.json`**（六轴/仿真/H1 都用它） | **92** | **780** | **199** | **83** | **125** |

- 结论：**所有 M5 数字（A1/A2/A3/A5/A6、H1、host-sim、redteam 之外的评测）都跑在 125 claim 的 store 上**，而 AGENTS/CHANGELOG 引用的语料快照是 128 claim 的另一份。两套快照没有同一时点、没有互相标注。
- 影响：读者会把 128 claim 的语料与 105 签名的评测当成同一批数据；实际是两次 archive 的结果。**指标口径要求"写清分子/分母/时点/树"，这里失真。**

- 另：`方案.md:688` 的「同口径 edge / event 16.3% / 12.8%」与当前复算的 **17.86% / 13.33%** 也不一致——同属活语料漂移，但该行**没有时点标注**（只有 V1 那行补了）。

### 3.5 ⚠ **MAINTENANCE 台账与 README 明显过期**（中等）

- `MAINTENANCE.md:21-23`：`分支 main = 0.7.0`、`里程碑 M5 起步（0.7.0）`、`327 条测试`——当前是 0.10.0 / 340 条。
- `MAINTENANCE.md:41-43`：下一步第 1 条仍写「**T9 合并与发版 … 0.6.0**」；0.6.0–0.10.0 早已发布。
- `README.md:8`：仍写「**M5 起步（v0.6.1）**…LOO 机械评测 **12.2%**…」，与 0.10.0 / 13.33% 不符；AGENTS §5 陷阱 7 明确"README 改了 = 包改了（版本号必须同步）"。
- 这直接违反 AGENTS §10「维护台账：MAINTENANCE 的当前状态/下一步每次干完活必须更新；接手先读它」——**接手者按台账会以为还在 0.7.0、T9 没发版**。

### 3.6 ⚠ **A1 状态用词**（低）

`m5-report` 的 A1 输出 `status:"measured"` + `detail.vacuous:true`。仓库自己的状态词表是 `measured / not-live / not-consumed`（`evidence/M5-six-axis.md`），**没有 `vacuous`**。虽然 CHANGELOG 写了"空转"，但机器可读的状态仍是 `measured`，下游（报告/看板）无法机械区分"量到了"与"空转量到 0"。建议增 `vacuous` 状态或 `measured(vacuous)`。

### 3.7 未发现的问题（明确记录）

- 未发现祈使句/行动指令进入注入文本（redteam `boundary/imperative` 有用例；R12 渲染有闸）。
- 未发现"改旧条目"：`supersedes`/`supersededBy` 只在闸 4 用例里出现，实现是标注不改写。
- 未发现把 Hindsight 的厂商分数当自家证据（`docs/对标 §3.4` 明令禁止且未违反）。

---

## 4 · 边界合规

| 检查 | 方法 | 结果 |
|---|---|---|
| 不写 `<DSH_HOME>`（产品侧设计上只写 sidecar） | `ls "$DSH_HOME/memory-context"` → 不存在；`node scripts/cli.mjs verify`（默认 store）→ exit 2「记忆库不存在 …（先跑 archive）」 | ✅ 未安装、未建库、无写入 |
| 不写 ~写入 DSH 安装目录 | `grep -rn "Desktop.*resources\|app\.asar" src scripts` → 0 命中 | ✅ |
| 不发 npm | `package.json private:true`；`grep -rn "npm publish\|publishConfig"` → 只有 `check.mjs` 的**拦截规则**与 `release.mjs:45` 的 "no npm publish" 日志 | ✅ |
| 不写自定义 session 事件 | `grep -rn "session\.append\|appendEvent\|session/event" src scripts` → 只有 `plugin.mjs:23` 的注释（"不写"）；`host-sim` 的假 session `append` 一调就抛，实测 `sessionAppendCalls: 0` | ✅ |
| 落账只用可 await 的钩子 | `plugin.mjs` 只注册 `HOOK = 'agent/pre-step'` | ✅ |
| 无跨作用域注入 | A5 复算 0（n=6）；walk 拒跨域 655；`gates` 有 `gate1/scope-mismatch` 用例；`shadowDir` 有"不得在 `$DSH_HOME` 内"的守卫 | ✅（守卫有条件性，见 §6） |
| 原件只读 | `archive` 只读 `sessions/`、`chess-context/`（dry-run 实测 92 日志 / 19 棋谱）；测试全部用 `os.tmpdir()` | ✅ |
| 不重启/不装 | 本轮未执行任何安装/重启/杀进程 | ✅ |
| 上游只读 | 未对压缩仓做任何 git/写操作 | ✅ |

补充：`evidence/shadow/` 不存在（影子从未真跑）——与"未安装"一致。

---

## 5 · 工程门禁（四条，记退出码）

| # | 命令 | 退出码 | 输出摘要 |
|---|---|---|---|
| 1 | `node scripts/check.mjs` | **0** | `check: PASS`（private / version 0.10.0 / changelog 段 / 六大文档 / 房间齐 / branch=main） |
| 2 | `node --test` | **0** | `tests 340 / pass 340 / fail 0`（7.3s，Windows + Node v24.20.0） |
| 3 | `node scripts/redteam.mjs` | **0** | `total 11 / blocked 11 / leaked 0`（口径问题见 §3.2） |
| 4 | `node scripts/host-sim.mjs` | **0** | `attempts 40 / injected 16 / empty 24 / failed 0 / warnCount 0 / sessionAppendCalls 0`；`p50 3.51 / p95 48.85 / max 108.36`；`tokens.p50 300` |

### ❗ 但仓库的"必需检查"在 CI 上是红的（本轮最重要的发现）

```bash
$ gh run list --limit 40 --json conclusion,...   # 结论统计：success 14 / failure 22（共 36 次）
$ gh run view 41350496035 --log-failed           # 0.10.0 的 main 运行
  not ok 285 - R16: shadow 写不进去（目录在 $DSH_HOME 内）⇒ 不注入、不抛、warn
  location: '/home/runner/work/dsh-gokifu-longmemory/dsh-gokifu-longmemory/test/plugin.test.mjs:341:1'
  stack: TestContext.<anonymous> (test/plugin.test.mjs:353:12)
  expected: true, actual: false
  # fail 1
```

- **从 0.6.0 起的 10 条 PR/main 对（0.6.0–0.10.0 七个版本 + 3 条修复分支）全部失败，PR 与 main 各一次 = 20 次红**；加上仓库初始化时的 2 次，共 **22/36 失败**。0.2.0–0.5.0 的 7 对曾全绿。
- `v0.10.0` 的 Release 生成于 `21:09:28Z`，而对应 CI 在 `21:09:17Z` 已完成**失败**——**release 跑在红灯之后**。
- 根因（本地可复现）：`test/plugin.test.mjs:341-355` 用 `process.env.DSH_HOME || path.join(tmpdir(),'fake-dsh-home')` 构造影子目录；CI 是 ubuntu 且**没有 `$DSH_HOME`**，`assertSafeShadowDir` 在 `src/rooms/inject.mjs:834-835` 直接 `if (!home) return target`（无守卫）⇒ 写入成功、没有 warn ⇒ 断言 `warns.some(w => w.includes('影子记录写入失败'))` 失败。

```bash
$ env -u DSH_HOME node --test test/plugin.test.mjs   # exit 1 → 20 pass / 1 fail（本机复现 CI）
$ env -u DSH_HOME node --test                        # exit 1 → 全量也红
```

**这条同时否掉了两件事**：① AGENTS §10「必需检查 rules 全绿 → 合并 → release」（实际 0.6.0–0.10.0 全部带红发版）；② `docs/安装指南.md:10`「`node --test` 必须全绿」（在没有导出 `$DSH_HOME` 的新机器上做不到）。

---

## 6 · 可安装性（按 `docs/安装指南.md` 只读走查）

指南共 74 行，结构：前置检查 → 影子 → 看数据 → 真注入 → 回滚 → 已知限制。逐条走查：

### 6.1 ❌ **第一步就断了：没有"怎么把插件装上"**

- 指南 `:19`：「在设置 UI 的插件配置里（或你惯用的 profile 配置通道）加：{json}」——**只讲配置，不讲注册**。全仓检索不到：profile/preset 里的插件条目长什么样、插件从哪来（未发 npm、无 `pnpm add`、无本地路径写法）、装到哪个目录。`MAINTENANCE.md:44` 只说"plugin 声明进 profile/preset"，同样没有形式。
- 后果：主人按指南操作，**没有可执行的第 1 步**。

### 6.2 ❌ **`<DSH_HOME>` 是字面占位符，照抄会静默失效**

- 指南 `:25` 写 `"storeRoot": "<DSH_HOME>/memory-context"`；`src/plugin.mjs:229-230` 是 `if (config.storeRoot) return path.resolve(config.storeRoot)` —— **不做变量展开**。照抄 ⇒ 解析成 `<repo>/<DSH_HOME>/memory-context` ⇒ 库不存在 ⇒ 插件只 warn、原样返回（不报错，静默零注入）。
- 反证：仓库自带的 `docs/staging/shadow.json` / `live.json` 用的是 `"storeRoot": null`（= 默认 `<DSH_HOME>/memory-context`），这才是正确形态。**指南既没引用 staging 文件，也没解释 null。**
- 建议：指南直接引用 `node scripts/stage-check.mjs docs/staging/shadow.json`（该脚本已存在）并给出"把 staging 文件内容贴进设置 UI"的路径。

### 6.3 ⚠ 影子守卫是条件性的

- 指南 `:34` 承诺「`shadowDir` 不允许落在 `$DSH_HOME` 内（硬守卫）」；实现 `src/rooms/inject.mjs:834-835` 在 `$DSH_HOME` 未设置时**直接放行**。宿主进程若没导出该变量，硬守卫等于不存在。这与 §5 的 CI 红是同一个根因。

### 6.4 ⚠ 其他缺步骤/歧义

| # | 位置 | 问题 |
|---|---|---|
| a | 指南 `:10` | `node --test` 标"必须全绿"，但无 `$DSH_HOME` 的新机器会红（§5 复现）；应先说明"需要 `DSH_HOME` 已导出"或修测试 |
| b | 指南 `:11` | `node scripts/archive.mjs` 会**写 `<DSH_HOME>/memory-context`**（约 1,300 条 / 1,280 文件）；指南未提示"这是写 DSH home"，也没给 `--dry-run` 先看的选项（CLI 里有） |
| c | 指南 `:19` | 没有"如何确认插件已加载"的验证步骤（没有日志行约定）；只能靠影子文件间接判断 |
| d | 全文 | **无卸载/回滚到"无插件"**（只写了 `enabled:false`，但没写如何移除插件条目） |
| e | 指南 `:4` vs `:47` | 一边说"运行中不改 `cordis.patch.yml`、要重启"，一边说"无需重启也能生效的配置通道按你的设置 UI 来"——**哪种配置改动需要重启没有说清** |
| f | 指南 §3 | "确认 messages 顺序（与压缩插件同点注入）"没有给出可判定的期望顺序/示例，只靠肉眼 |

### 6.5 ✅ 已验证可用的部分

```bash
$ node scripts/cli.mjs verify --store tmp/memory-context   # exit 0：verify: OK · 文件 1280 · 错误 0 · 告警 0
$ node scripts/eval.mjs --h1 --store tmp/memory-context --workspace . --evidence tmp/rev-h1.md   # exit 0，写出证据文件
$ node scripts/m5-report.mjs --store tmp/memory-context --workspace . --json                     # exit 0
```
指南 §0/§2 的 CLI 形态、`--evidence` 落盘、`verify` 的报错文案（缺库时 exit 2 + 明确提示）都正确。

---

## 7 · 结论

### 判定：**PASS-WITH-FIXES**

- **功能主体可交付**：340 条测试（本机）全绿；R00–R16 房间在位；六轴框架零模型调用、可一条命令复算；A2 13.33% 与 redteam 的拦截结果可复现；边界纪律（不写会话事件、不发 npm、不改安装目录、跨域 0）在代码与实测两层都干净。
- **但不能判 PASS**：仓库自己的"必需检查"已经连续红了 10 条分支（含 0.6.0–0.10.0 七个版本），且**安装指南无法按字面执行**（无插件注册步骤 + 占位符会静默失效）。这两条直接命中"可交付/可安装"的门槛，所以是 **PASS-WITH-FIXES（含 2 个安装前阻断项）**。

### 必修清单（≤5 条，按严重度）

| # | 严重度 | 位置 | 问题 | 修法 |
|---|---|---|---|---|
| **F1** | **阻断/高** | `test/plugin.test.mjs:341`（断言在 `:353`）、`src/rooms/inject.mjs:834-835`、`scripts/release.mjs:15-22` | CI `node --test` 在无 `$DSH_HOME` 时必红（已在 CI 连红 20 次；本地 `env -u DSH_HOME node --test` → exit 1）。根因：测试依赖环境变量、守卫在无 home 时放行。且 `release.mjs` 不检查 CI 结论，红灯也能发版（0.10.0 即如此）。 | ① 测试显式注入 `dshHome`（或临时 set/restore `process.env.DSH_HOME`）；② 守卫在 `home` 缺失时改为"拒绝写绝对路径之外的 dir"或让 `dshHome` 可从 `storeRoot` 推导，并补一条"无 env"单测；③ `release.mjs` 增加 `gh run list --commit HEAD` 的结论校验（非 success 即拒绝）。 |
| **F2** | **阻断/高** | `docs/安装指南.md:19`（注册缺失）、`:25`（`<DSH_HOME>` 占位符）、`:10`（`node --test` 必须全绿） | 指南没有"如何注册插件"这一步，照抄 `storeRoot` 会静默零注入；新机器上第一步测试就红。 | 补「注册」小节（profile/preset 条目形式 + 未发 npm 时用本地路径/`file:`），把配置示例改为引用 `docs/staging/*.json`（`storeRoot: null`），并在 §0 注明 `DSH_HOME` 前置条件；补卸载步骤。 |
| **F3** | 中 | `CHANGELOG.md:7,15`、`test/redteam.test.mjs:9`、`evidence/M5-redteam.md` 表头、`scripts/redteam.mjs:39` | "11 个坏记忆样本全部拦住"多算 1：第 1 个是合格卡控制组（期望 `GATE0_PASS`）。真实是 10 坏样本全拦 + 1 控制未被误拦。 | 把 baseline 标为 `control` 并从 `blocked` 剔除；headline 改成「10/10 坏样本拦住 + 1/1 合格卡未误杀」；测试名同步。 |
| **F4** | 中 | `CHANGELOG.md:37,41`、`AGENTS.md:287`、`README.md:8` | A4 "p95 5.55ms / p95 门槛达标"**不可复算**（本轮 8.45/16/23/70.2ms，其中一次 >50ms）；且方案 §8.2 的判据是 **p50,p90 ≤50ms**，p95 不是判据。 | ① 按方案口径改写成"p50 1.4–2.0ms、p90 4.7–20.2ms（≤50ms）"；② 若保留 p95，改成"3 次以上运行的区间（如 8.4–70ms，GC 尖峰）"，并说明采样方法；③ 删掉"p95 门槛达标"这个自造判据。 |
| **F5** | 中 | `AGENTS.md:286` vs `MAINTENANCE.md:33` vs `tmp/memory-context/manifest.json`；`MAINTENANCE.md:21-23,41-43` | 语料基线两套数并存（784/212/84/128 vs 780/199/83/125），六轴全部跑在后者；MAINTENANCE 正文仍写 0.7.0 / 327 条 / 下一步"发 0.6.0"。 | ① 统一为"store 快照 + 入档时刻"一个权威数（建议以 `manifest.json` 为准并注明 `[本]` 时点），或重建 store 后重跑六轴；② MAINTENANCE 更新到 0.10.0 / 340 条 / 已发版的事实。 |

### 非阻断但有证据的改进项（不计入必修 5 条）

1. **A2 分母噪声**：`both` 里 32/91（35%）签名不含错误词（§3.3）。headline 应给三变体噪声占比，或对 event 兜底加"输出含错误标记"过滤后重算。
2. **hopPrecision 分层**：`方案.md:689` 只写 S0 87.38%，应同格补"任务句层 66.67%（<70%）"（`evidence/M4-precision.md:307`）。
3. **A1 状态词**：`m5-report` 输出 `status:"measured"` + `vacuous:true`；建议加 `vacuous`（§3.6）。
4. **"M5 收口"措辞**：`AGENTS.md:99,279`（工作树）写 M5 收口，但 §9 要求的 V2–V5、`overfitGap` 未测；建议写"M5 指标面收口 / V2–V5 未测"。
5. **README 过期**：`README.md:8`（v0.6.1 / 12.2%）。
6. **发布树 ≠ 工作树**：0.10.0 tag 已发，但 AGENTS/方案/对标三处文档修复仍在工作树未提交（`git status` 可见）；下一次 release 前需先落库，否则 tag 里的文档仍是旧数。

### 一句话

> **引擎与纪律都是真的，账本有四处对不上，安装链缺最后一公里。** 先把 F1（CI 红 + 无 CI 门禁）与 F2（装不上）修掉，v0.10.0 才算"可安装"；F3–F5 是半小时级的口径修正。

---

## 附录 A · 我实际跑过的命令与退出码

```bash
node scripts/check.mjs                                                        # 0  PASS
node --test                                                                   # 0  340 pass / 0 fail
node scripts/redteam.mjs                                                      # 0  total 11 · blocked 11 · leaked 0
node scripts/host-sim.mjs                                                     # 0  attempts 40 · injected 16 · failed 0 · append 0 · p95 48.85
node scripts/m5-report.mjs --store tmp/memory-context --workspace . --json    # 0  A1 0(n=9) · A2 .13333(n=105) · A3 0(n=21,not-live)
                                                                              #    A4 p50 1.5/p90 4.67/p95 8.45 · A5 0(n=6) · A6 1(n=6)
node scripts/eval.mjs --store tmp/memory-context --workspace . --json         # 0  both 14/105 · edge 10/56 · event 16/120
node scripts/eval.mjs --h1 --store tmp/memory-context --workspace . --evidence tmp/rev-h1.md  # 0
node scripts/bench-inject.mjs tmp/memory-context "w:d:/DeepSeek Harness/default-workspace/长期记忆系统"  # 0 ×3
node scripts/cli.mjs verify --store tmp/memory-context                        # 0  verify: OK · 1280 文件 · 0 错
node scripts/cli.mjs verify                                                   # 2  记忆库不存在（未安装，符合预期）
env -u DSH_HOME node --test test/plugin.test.mjs                              # 1  20 pass / 1 fail（复现 CI）
env -u DSH_HOME node --test                                                   # 1  全量红
gh run list --limit 40 --json ...                                             # 0  36 次：14 success / 22 failure
gh run view 41350496035 --log-failed                                          # 0  失败点 = test/plugin.test.mjs:353
gh release list --limit 5                                                     # 0  v0.10.0…v0.7.1
```

只读静态检查（grep/read，无退出码意义）：`session.append|session/event`、`npm publish|publishConfig`、`Desktop.*resources|app.asar`、`DSH_HOME`、`收益|线上|live`、`87.38|S9`、`12.2%`、`p95`。

## 附录 B · 本次读过的关键文件（便于复核）

`AGENTS.md`、`CHANGELOG.md`、`MAINTENANCE.md`、`README.md`、`方案.md` §8/§9/§5.1b/§6.3、`docs/对标-Hindsight.md` §2/§4.5、`docs/安装指南.md`、`docs/usage` 无、`evidence/M5-six-axis.md`、`M5-redteam.md`、`M5-host-sim.md`、`M5-latency.md`、`M2-archive.md`、`M4-precision.md`、`T7b-shadow.md`、`T8b-gates-real.md`、`scripts/{check,release,redteam,host-sim,m5-report,eval,bench-inject,stage-check}.mjs`、`src/plugin.mjs`、`src/rooms/{inject,gates,walk}.mjs`、`test/{plugin,redteam}.test.mjs`、`.github/workflows/check.yml`、`docs/staging/{shadow,live}.json`。

> 报告中每条"不可复算/不一致"都附了命令与输出；每条"文件:行"对应当前工作树（含未提交改动，指纹见 §0）。若 Lead 在我之后继续改文档，行号会漂移，请以内容为准。
