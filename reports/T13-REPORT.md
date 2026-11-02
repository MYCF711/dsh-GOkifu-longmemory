# T13 报告 · M5 六轴一条命令可复算（2026-11-02）

> 任务 id：**task-13**（`T13: M5 六轴一条命令可复算`）
> 分支：**main（未提交）** —— 按 Lead 指令「团队共用工作树，禁止 checkout/switch/commit，文件由 Lead 提交」。
> 本任务只产出 4 个文件，**没动** `scripts/eval.mjs` / 房间代码 / `package.json` / `CHANGELOG` / `MAINTENANCE` / 计划表。

## 0 · 交付物

| 文件 | 行数 | 作用 |
|---|---|---|
| `scripts/m5-report.mjs` | 759 | 六轴评测：`runM5` / `measureA1..A6` / `runPipeline` / `renderM5Markdown` / CLI |
| `test/m5-report.test.mjs` | 400 | 11 条：六轴结构、A6=100%、A5=0、A1 not-consumed、A2 measured/not-consumed、A3 not-live、空库、只读、CLI |
| `evidence/M5-six-axis.md` | 193 | 命令生成的真实证据（总表 + 逐轴口径与明细 + 复现命令 + 风险） |
| `reports/T13-REPORT.md` | 本文件 | 数字 + 口径 + 风险 |

## 1 · 验收

```
$ node --test test/m5-report.test.mjs
ℹ tests 11   ℹ pass 11   ℹ fail 0   ℹ duration_ms 3237.2

$ node --test                # 全仓
ℹ tests 339  ℹ pass 339  ℹ fail 0   ℹ duration_ms 7439.5
```

> Lead 给的基线是 328 条；本刀 +11 ⇒ **339 条全绿**，既有 328 条一条没红。
> 全程只读；`$DSH_HOME/memory-context/` 仍不存在（`ls` 报 no such file）。

## 2 · 六轴真实值（`[本] 2026-11-02 04:57`，`--store tmp/memory-context --workspace . --root $DSH_HOME`）

| 轴 | 判据 | 指标 | 值 | n | 状态 |
|---|---|---|---|---|---|
| **A1** | 负迁移受控 | `staleTransferRate` | **0.00%**（0/9） | 9 | `measured`（**空转**） |
| **A2** | 收益（主判据） | `repeatFailureRate`（LOO, both） | **13.33%**（14/105，1σ=±3.32%） | 105 | `measured` |
| **A3** | 可靠性 | `injectFailureRate` | **0.00%** | 21 | `not-live` |
| **A4** | 延迟/成本 | `walk→card→gates` p50 | **4.11 ms**（p90 11.9 / p95 45.71 / max 106.14）· tokens p50 **46** | 50 | `measured` |
| **A5** | 作用域隔离 | `crossScopeLeakRate` | **0.00%**（0/6 行） | 6 | `measured` |
| **A6** | 可回溯 | `provenanceCoverage` | **100.00%**（6/6 行） | 6 | `measured` |

一条命令耗时 **27.3 s**（其中 A1 复用 `runH1` ≈ 23 s、A2 `runEval` ≈ 3.4 s、A4–A6 热路径 ≈ 0.6 s + 冷缓存 0.53 s）。

## 3 · 每轴口径（分子 / 分母 / 时点 / 树）

| 轴 | 复用什么 | 分子 | 分母 | 时点 |
|---|---|---|---|---|
| A1 | `scripts/eval.mjs#runH1`（未改写） | 注入条目中 validity 核不过（`ok:false`）的条数 | 卡片里带 claimId 的注入条目数 | store 当前快照 + 工作区现场 |
| A1 附 | 同一次 `runH1` | 被渲染过的带 validity 条目数 | 全部带 validity 的条目数（`validityCoverage`） | 同上 |
| A1 附 | 本次 A5 的独立复核 | 越界渲染行 | 渲染行总数（`crossScopeLeakRate`） | 同上 |
| A2 | `scripts/eval.mjs#runEval`（未改写） | Σrepeat（签名已在严格更早的局出现） | Σrepeat+Σnovel | 每局 `startedAt`；语料 = store 的 24 root 局 + `$DSH_HOME` 原件 |
| A3 | 读 `src/plugin.mjs` 的 `DEFAULT_CONFIG` + `test/plugin.test.mjs` 的条数 | 单测里 inject 失败 0 次 | 单测用例 21 条 | 代码树当前版本（**不在宿主里跑**） |
| A4 | R11→R12→R13 同一条热路径 50 次 | — | — | 当前机器、当前 store（冷缓存后预热） |
| A5 | 20 张卡 × 渲染行 | 越界行（反查 `ep-…` 的 scopeKey，`isScopeVisible` 判） | 渲染行总数 | 同上 |
| A6 | 20 张卡 × 渲染行 | 命中 `PROVENANCE_LINE_RE`（`- [kind] text (ep-…, YYYY-MM-DD, seq N)`）的行 | 以 `- [` 开头的渲染行 | 同上 |

**状态语义（三档，缺数据不写 0）**：

- `measured`：有真实样本，value 是真数字；
- `not-live`：能力在、但没在宿主里真跑过（A3，插件 `enabled=false`）；
- `not-consumed`：**没有数据 ⇒ value = null**，caveat 写清缺什么（测试里断言 `value === null`）。

## 4 · 读数字前必须知道的

1. **A2 是机械代理，不是净收益**：只回答"失败原文是否在更早的局出现过"；"模型少走弯路"要 M5 配对重放。
2. **A2 会随活语料漂移**：`[本] 04:18` 的 `evidence/M5-eval.md` 是 **12.2%（98 签名）**，本文件 `04:57` 是 **13.33%（105 签名）**——差异来自两局长会话（`<ep>` 12→17 条签名、`<ep>` 仍在追加事件）**仍在写入**。同口径、不同时点，**不许混用**。
3. **A1 的 0% 是空转的**：`validityCoverage = 0%`（8 条带 validity 的条目一条也没被渲染过）⇒ 分子恒为 0。这是第 4 次实测到同一现象（见 `evidence/M5-h1.md`），已作为 S10/S11 记录。
4. **A3 的 0 是"没跑过"**：`enabled=false, shadow=true`，0 失败率来自 21 条单测覆盖，`liveAttempts=0`。
5. **A4 的 p95/max 受 GC 影响**：p50 4.11ms（与 `evidence/M5-latency.md` 的 3.9–5.3ms 一致），但 max 106ms、p95 45.71ms 是 GC 尖峰，**未稳定达标 50ms**。
6. **A5/A6 的 n 很小**：20 张卡只渲染出 **6 行**（大部分信号零命中）。6/6 = 100% 与 0/6 = 0% 都说明"没坏"，不足以证明"在别的语料上也对"。样本变大后要复算。
7. **A5 是三重计数**（walk 自拒 655 条跨域 / 卡内 `crossScope` 0 / 独立反查 0 行）：三者任一非 0 都要当缺陷查。
8. **A6 判据是严格整行正则**：日期或 `seq` 丢一个就不算；不靠"看起来有 ep"。
9. **六轴不同时点、不同语料**：A1/A2 读 2026-11-01 入档的 store + 原件；A4–A6 跑当前工作区作用域的卡片；A3 读代码树事实。**跨时点不可比**。
10. **27 s 的运行时间主要花在 A1**（`runH1` 走的是无缓存 walk 路径）。要提速需要给 runH1 接 `createWalkCache`——那属于改 `eval.mjs` 的口径实现，不在本刀写作用域。

## 5 · 复现命令

```bash
cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"

node scripts/m5-report.mjs --store tmp/memory-context --workspace .                              # 文本表
node scripts/m5-report.mjs --store tmp/memory-context --workspace . --root "$DSH_HOME" --json    # JSON
node scripts/m5-report.mjs --store tmp/memory-context --workspace . --root "$DSH_HOME" \
     --evidence evidence/M5-six-axis.md                                                          # 证据
node --test test/m5-report.test.mjs
```

## 6 · 测试覆盖（11 条）

1. 六轴齐全 + 每轴 `{value,unit,n,status,caveat}` + 状态合法 + A3 唯一 `not-live` + A4 的 n = 实跑次数
2. **A6 = 100%**（且 n>0，真渲染出卡片行）
3. **A5 = 0**（越界行 0 / 卡内跨域 0）
4. A2：有数据根 ⇒ `measured` 且给 1σ；无数据根 ⇒ `not-consumed` 且 `value=null`
5. A1：真跑无 validity ⇒ `not-consumed`（value=null）；注入已知答案 ⇒ `measured` 0.2；覆盖率 0 ⇒ 标 `vacuous`
6. A3：读插件事实（`enabled=false` / `shadow=true` / 21 条单测），不跑宿主
7. 空 store：六轴都有状态、不抛、`not-consumed` 的 value 必须是 null、不创建 store 目录
8. **只读**：跑完 store 的 sha256 树指纹完全不变
9. 纯工具：信号集按 df 降序取主题 key；空库有兜底信号；空库 100% 零注入
10. CLI：`--json` 六轴结构、`--evidence` 写 markdown、参数解析、`--help`
11. **复用一致性**：A2 的值/样本数与直接调 `runEval` 完全相等（证明没重写口径）

## 7 · 给 Lead 的合并清单（本任务没动的东西）

1. `package.json`：如需把 `scripts/m5-report.mjs` 挂成 npm script（如 `"m5": "node scripts/m5-report.mjs"`），由你在升版本那一刀加。
2. `CHANGELOG.md`：写"M5 六轴一条命令可复算 + 真实数字（A2 13.33%、A4 p50 4.11ms、A6 100%）"。
3. `MAINTENANCE.md` / `计划表.md`：把六轴表贴进"当前状态"，并记 S10/S11（validityCoverage=0 仍未消解）。
4. 建议 commit：`M5: 六轴报告（一条命令可复算）`。
5. 后续（不属本刀）：H1 接 `createWalkCache`（27s → ~4s）；`validityCoverage` 归零的根因（S10/S11）；A2 的配对重放。
