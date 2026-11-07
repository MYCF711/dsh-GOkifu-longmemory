# T7 · A1.opposite（反向记忆率）—— 与 A1.stale **并列**的第二条负迁移轴

> 日期：2026-11-07 · 分支 `task/T7-opposite`（基于 main `3a222a0` = 0.8.48）
> 可写面：`scripts/m5-report.mjs`（A1.opposite 轴）、`scripts/metrics-guard.mjs`（回归闸）、本文件。
> **没有改** `src/**`、`test/**`、`package.json`、`CHANGELOG.md`、`MAINTENANCE.md`（版本与台账由 Lead 统一集成）。
> 数据：`$DSH_HOME/memory-context`（1345 棋谱 / 3581 主题 / 2020 claim）+ `evidence/label-set.json`（T1 的 135 对人工标注）。
> 判据：`src/rooms/abstain.mjs` 的 `detectPolarity` / `polarityReport` / `polarityScorecard`（**语义一字未改**，本刀只加消费方）。

## 0 · 一句话结论

**A1.opposite 已进报告与回归闸；线上值 0.00%（0/709 对）、可判率 25.95%（184/709）< 30% 下限 ⇒ 不可用于决策。**
这个 0 是"判据一次都没判出 opposite"，**不是**"线上没有反向记忆"：T6 实测 2354 条真实卡行里 `[disputed]` **0 次**，
本轴与那个 0 是同一个 0 —— **仪表未通电**，不能拿它说"我们没问题"。

## 1 · 两轴并列对照（**不是替换**）

两条轴都是负迁移、硬上限都是 **5%**；`A1`（stale）的口径与数值**一字不动**（已逐字节核对，见 §6）。

| 轴 | 指标 | 值 | 分子 / 分母 | 可判率（各自口径） | 可用于决策 | 状态 |
|---|---|---|---|---|---|---|
| **A1.stale**（原有） | `staleTransferRate`（**闸后**） | **0.00%** | **0 / 241**（到达模型）；闸前 7 / 252 = 2.78% | —（过期是 claim 自身属性，不需要可判率；覆盖 95.18% = 渲染 96 + 闸拦 121 / 228 带 validity） | —（沿用原口径） | `measured` |
| **A1.opposite**（新增） | `oppositeRate` | **0.00%** | **0 / 709 对** | **25.95%（184 / 709）** < 30% 下限 | **❌ 不可用于决策** | `measured` |

- **单位不同，所以分母不同**：A1.stale 的分母是**去重后的 claimId**（一条记忆过期就是过期）；
  A1.opposite 的分母是 **(信号, claim) 渲染行**——方向是"对"的属性（同一条 claim 对 A 反向、对 B 同向）。
  按 claimId 去重后是 0/252（可判率 72.22%），但那会把"只在一条信号上可判"抬成可判，是**口径幻觉**，只作对照、不进主值。
- **信号集与 A1 同构**：主题库 df 降序前 36 个（`${key} 相关的问题`）+ 每条带 validity 的条目用自己的文本，
  共 **264 条**（主题 36 + 带 validity 228）；其中 248 个信号产出了内容卡（零注入 16）。
- **可判率的三个口径一起报**（知识库 83）：

| 口径 | 对数 | 可判（same+opposite） | 可判率 | opposite 精确率 |
|---|---|---|---|---|
| **线上渲染行（本轴主口径）** | **709** | **184** | **25.95%** | **无样本（0/0）** |
| 线上按 claimId 去重（对照） | 252 | 182 | 72.22% | 无样本（0/0） |
| T2 校准集（`evidence/label-set.json`，有金标） | 135 | 26 | **19.3%** | **100%（2/2）** |

`polarityReport` 原样输出（线上口径）：

```
反向记忆率 0.0%（0/709）· 可判率 26.0%（184/709） · **不可用于决策**（可判率或精确率不足，只能作局部观察）
```

T2 校准集原样输出：

```
反向记忆率 1.5%（2/135）· 可判率 19.3%（26/135） · opposite 精确率 100.0%（2/2） · **不可用于决策**
```

## 2 · 为什么线上 `opposite` 是 0（引用 T6 的实测）

T6（`evidence/T6-cooling-live-validation.md`，2026-11-07，**只读**）在真实宿主流量上测到：

| 事实 | 数值 |
|---|---|
| 真实注入卡 | **1084 张** |
| 卡行 | **2354 行**（可解析 2323 = 98.7%） |
| `[antipattern]` / `[observed]` / `[candidate]` | 2170（92.7%）/ 150（6.4%）/ 3（0.1%） |
| **`[semantic]` / `[disputed]` / `[stale]`** | **0 / 0 / 0** |
| `abstain` 触发 | **0 / 15930** 条 pre-step 心跳 |
| `decay < 0.5` | **0.0%（0 / 2323）** |

`[disputed]` 是 `markerWithPolarity(claim, 'opposite')` 的唯一产物（`src/rooms/inject.mjs` 的渲染接线）；
它 0 次 ⇒ 线上 `detectPolarity` 一次都没判出 `opposite`。本轴 0/709 与它是**同一个事实**，
不是两条独立证据。**⚠ T6 还记了一条硬约束**：当时在跑的宿主启动早于 `abstainIrrelevant` 默认开启（T366e）约 1 小时
⇒ **线上跑的是旧代码**。所以这个 0 同时受"判据没判出"与"宿主版本落后"两个因素影响，
更不能反过来当成"没有反向记忆"的证明。

**无触发 ≠ 无反向记忆**：0 次的含义只是"判据一次都没判出 opposite"，
它既不排除"判据太窄（T2 的召回只有 2/4 = 50%）"，也不排除"线上确实没有"。
两者要分开得靠**正向样本**，而线上没有——这正是下面"仪表未通电"的由来。

## 3 · 这个轴的局限（**四条，逐条写清**）

1. **可判率不足 ⇒ 不可用于决策**。线上 25.95%（184/709）< 30% 下限；T2 校准集 19.3%（26/135）同样 < 30%。
   按知识库 83，这个率只能作**局部观察**，不能当验收面。
   本集上"零误判"的可判率理论上限是 **22.2%（30/135）**（T2 §六）——19.3% 已经是上限的 87%，
   剩下 4 条差额是"同一条任务链"这种**语义**判据，词表 + 正则做不到。
2. **精确率只有 2 个样本**。`opposite` 2/2 = 100% 的 Wilson 95% 下界约 **34%**；
   它的意义是"这次没有再错"，不是"以后不会错"。要收紧置信区间，只能给 `dir` 层以外补人工方向标注（T1 的数据面）。
3. **方向是"对"的属性，不是 claim 的属性**。按 claimId 去重会把可判率抬到 72.22%（182/252）——
   这是"一条 claim 只要有一条信号可判就算可判"的算术，不是判据变强了。主口径坚持按对。
4. **线上 0 正样本 ⇒ 精确率 0/0 ⇒ 仪表未通电**。`polarityReport` 的三件套只卡"可判率 ≥ 30% + decidable > 0"，
   在线上 0 触发时会给出 `usableForDecision=true` 的假绿（0/0 的精确率没样本）。
   `measureA1Opposite` 因此在三件套之外**额外要求"线上有正样本（opposite > 0）"**，
   并把这个额外条件写进 `detail.decisionGate` 与 `detail.decisionReason`。
   **metrics-guard 对这个轴的处理同构**：只有"已通电"才拿 5% 卡它；未通电时**只打印、不参与 exit code**，
   并在输出里明写"未通电·不参与 exit code（0 次触发 ≠ 无反向记忆）"。

## 4 · 改了什么（两个脚本，只加消费方）

| 文件 | 符号 | 改动 |
|---|---|---|
| `scripts/m5-report.mjs` | `measureA1Opposite` | 新增。与 `runH1` 同一条信号构造，跑 walk → `buildMemoryCard` → 逐条 `detectPolarity`；产出 `polarityReport` 三件套 + `claimLevel` 去重对照 + 校准集 + 决策门槛。 |
| 同上 | `A1_OPPOSITE_AXIS_ID` / `A1_AXIS_IDS` / `A1_OPPOSITE_MAX` / 两个 floor 常量 | 新增（`'A1.opposite'`、`['A1','A1.opposite']`、`0.05`、`0.30`、`0.80`）。 |
| 同上 | `runM5Body` | `axes` 里紧挨 `A1` 加 `'A1.opposite'`；顶层加 `a1Axes: ['A1','A1.opposite']`（`order` 仍是六轴 A1–A6）。 |
| 同上 | `formatM5Report` / `renderM5Markdown` | 加"A1 负迁移 · 两轴并列（stale \| opposite）"对照块与 §2b 表；**A1 那一行一字未改**。 |
| `scripts/metrics-guard.mjs` | `LIMITS.a1OppositeMax` | 新增 `0.05`（与 `a1Max` 并列）。 |
| 同上 | `judge` | 读 `axes['A1.opposite']`：缺轴 / 无值 ⇒ 红（tombstone）；**已通电且 >5%** ⇒ 红；未通电只打印。 |
| 同上 | CLI | 新增 `--workspace <dir>`（或 `KIFU_M5_WORKSPACE`）转发给 `m5-report`；**不给仍是当前目录**（默认行为不变）。 |

**为什么加 `--workspace`**：`metrics-guard` 用 `cwd` 当 m5 的 workspace scope。worktree 并行时
worktree 的 scope（`w:…/T7-opposite`）与库里的主工作区（`w:…/长期记忆系统`，24 局）对不上，
A5/A6 会落 `not-consumed` 而**假红**——这是本刀之前就存在的环境问题（见 §5 基线）。
加一个显式开关比改默认值更安全：默认行为不变，worktree 里用 `--workspace` 指到主工作区即可。

## 5 · 验收对照

| 验收项 | 结果 |
|---|---|
| ① `A1.opposite` 出现在 `m5-report` / `metrics-guard` | ✅ `axes['A1.opposite']`（JSON）+ 文本块 + markdown §2b + `metrics-guard` 的 `A1 两轴` 行 |
| ② 与 `A1.stale` **并列**（两个轴，不是替换） | ✅ `A1` 的轴对象**逐字节相同**（`JSON.stringify` 对拍 `true`）；两轴在总表里紧挨着（stale → opposite） |
| ③ 带可判率（`polarityReport` 三件套） | ✅ 率 0.00%（0/709）· 可判率 25.95%（184/709）· `usableForDecision=false`（并写明额外门槛"必须有正样本"） |
| ④ `check.mjs` + `metrics-guard.mjs` 全绿 | ✅ `node scripts/check.mjs` → `PASS`；`node scripts/metrics-guard.mjs --workspace "…/长期记忆系统"` → `PASS`（见 §6 命令与基线说明） |
| **tombstone** | ✅ 把 `runM5Body` 里 `[A1_OPPOSITE_AXIS_ID]` 那条统计临时删掉后，`metrics-guard` **exit 1**：`ERR A1.opposite 反向记忆率缺失（tombstone：轴统计被删）`；已还原 |
| 依赖测试 | ✅ `node --test test/m5-report.test.mjs test/metrics-guard.test.mjs test/abstain.test.mjs` → **53 pass / 0 fail** |

**基线（诚实说明）**：本刀之前，`node scripts/metrics-guard.mjs` 在**本 worktree**里就是 **FAIL**
（`A5 越界 null != 0`、`A6 溯源 null < 1`）——原因是 worktree 的 scope 与库里的主工作区不匹配（§4），
与 T7 无关。加上 `--workspace "…/长期记忆系统"` 后 PASS；`A1.stale` 的值与门槛一字未动。

## 6 · 复现

```bash
cd "D:/DeepSeek Harness/default-workspace/T7-opposite"

# ① 两轴原始数字（只读）
node scripts/m5-report.mjs \
  --store "$DSH_HOME/memory-context" \
  --workspace "D:/DeepSeek Harness/default-workspace/长期记忆系统" \
  --root "$DSH_HOME" --json > tmp/m5-t7.json

node -e "const r=require('./tmp/m5-t7.json');for(const id of ['A1','A1.opposite']){const a=r.axes[id];console.log(id,a.value,a.n,a.status,JSON.stringify(a.detail));}"

# ② 回归闸（worktree 里必须带 --workspace 指到主工作区，见 §4/§5）
node scripts/metrics-guard.mjs --workspace "D:/DeepSeek Harness/default-workspace/长期记忆系统"

# ③ 仓库自检 + 依赖测试
node scripts/check.mjs
node --test test/m5-report.test.mjs test/metrics-guard.test.mjs test/abstain.test.mjs

# ④ tombstone 演练（临时删掉 A1.opposite 那条统计 ⇒ 闸必须红；演练后还原）
#    删的是 scripts/m5-report.mjs 的 runM5Body 里 `[A1_OPPOSITE_AXIS_ID]` 那一项。
```

本次实测（2026-11-07，`now` 为运行时刻）：

```
A1.stale    value=0        n=241  status=measured   （闸前 2.78% = 7/252；validityCoverage 95.18%）
A1.opposite value=0        n=709  status=measured   （可判率 25.95% = 184/709；claimId 去重对照 182/252）
metrics-guard PASS · 主判据 A2b 严格=46.6% 覆盖=79.7% · A1=0 A5=0 A6=1 A4.p50=27.58ms
A1 两轴 · A1.stale=0.0% A1.opposite=0.0%（可判率 26.0%，n=709，未通电·不参与 exit code（0 次触发 ≠ 无反向记忆））
check: PASS · 53 pass / 0 fail
```

> ⚠ A4 是墙钟，跨次会跳（27.58ms / 32.31ms / 35.18ms 都出现过），与 A1 两轴无关；
> A2/A3 会随宿主实时流量变化。**A1 与 A1.opposite 的分子/分母在同一次运行内是确定的。**

## 7 · T7 没做的事（交回 Lead）

1. **版本号 / CHANGELOG / MAINTENANCE / 计划表**：按任务书由 Lead 统一集成（`scripts/**` 行为变了 ⇒ semver 走 **minor**）。
2. **`test/**` 没动**：本刀只加消费方，`test/m5-report.test.mjs` 与 `test/metrics-guard.test.mjs` 未改一字；
   `metrics-guard.judge` 对"旧快照/单测夹具"（无 `a1Axes` 标记）保持旧行为，只有真实 m5 报告才强制要求 `A1.opposite`
   （tombstone 正是靠这个标记触发）。
3. **`src/rooms/abstain.mjs` 没动**：`detectPolarity` 的收窄是 T2 的成果，本刀只消费。
   它的召回缺口（T2 的 pair 20/25 两条真反向判不出）仍是**已知局限**，不用模型评分去补。
4. **`[disputed]` 仍未在线上出现过**：T6 记的"宿主版本落后"未复测；要复测得等宿主重启后重跑 T6 口径，
   那属于 T6 的后续，不在本刀。
