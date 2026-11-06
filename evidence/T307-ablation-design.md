# T307 · 真 ablation 实验设计：记忆有没有用（干预实验）

> `[本] 2026-11-06 13:30 +08:00` · **只读真库**；**不调用模型**；**不改生产配置**
> 脚本骨架：`scripts/ablation-live.mjs`（出题 / 记录 / 记分）· 单测：`test/ablation-live.test.mjs`（4 条）

## 0 · 一句话结论

**这个实验只能由主人跑**（要模型在环 + 改注入开关），脚本只负责**出题 + 记分**。
**跑出"B 路（无记忆）显著更多复发"才算记忆有用**（McNemar 精确 p < 0.05 且方向正确）；**无差别 ⇒ 记忆没起作用**，那时该问的是"卡上写了什么"，不是"要不要这个插件"。
T305/T306 已证明观测数据这条路走不通（选择偏差：claim 只从被抽取过的失败里来）——所以本设计**不再用观测分组**，改用**同一任务的两次干预**。

## 1 · 实验设计（可执行）

### 1.1 干预（两臂）

| 臂 | 配置 | 说明 |
|---|---|---|
| **A（有记忆）** | 默认（注入开） | 现状 |
| **B（无记忆）** | **`GOKIFU_INJECT=off`**（或等效：把 `plugin.mjs` 的注入点短路） | 模拟"没有这个插件" |

> ⚠ **不改生产配置**：两臂通过**环境变量**切换（由宿主在**单次会话**里设置），不改 `cordis.patch.yml`、不改 `settings.json`。

### 1.2 任务（N ≥ 20）

`node scripts/ablation-live.mjs --n 20` 从库里挑**有 claim 引用、且错误原文 ≥20 字**的失败签名（每条带 `taskId / episode / seq / claimId / 错误原文`）。
实跑已得 **12 条**（见 §2）；正式跑建议 **≥20 条**，覆盖 **≥5 个 scope**。

**出题原则**（避免选择偏差）：
- 任务必须**来自不同 episode**（同局只出一条），否则同局上下文会污染另一条；
- 任务必须**可复现**（错误原文里的路径/命令在当前机器可重放）；
- **不许挑"看起来容易"的**：候选由脚本按 claim id 排序机械选取，**跑之前定死**。

### 1.3 配对

**同一任务的两个变体**（A/B），**不是**"有 claim 的局 vs 无 claim 的局"。
每个任务跑两次：A 臂一次、B 臂一次，记录是否复发同一错误。

### 1.4 终点（机械可判）

| 符号 | 含义 |
|---|---|
| `onlyA` | A 复发、B 不复发 |
| `onlyB` | **B 复发、A 不复发**（记忆有用的方向） |
| `both` / `neither` | 两臂一致（不参与判别） |
| **判据** | `onlyB > onlyA` **且** McNemar 精确 **p < 0.05** |

## 2 · 出题实跑（原样，12 条）

```
$ node scripts/ablation-live.mjs --n 12
T307 · 真 ablation 出题 · 候选失败签名 12 条
| # | taskId | episode | seq | claimId | 错误原文（前 80） |
|---|---|---|---|---|---|
| 1 | T-c0a5847a-50332 | ep-c0a5847a | 50332 | c-00248579 | Error: unknown job bash-49fb11d400eb4696 |
| 2 | T-bc4ab3cb-819 | ep-bc4ab3cb | 819 | c-00a2178a | Error: writing under <fonts-dir>/msyh.ttc would destroy the running runtime |
| 3 | T-9becea64-1330 | ep-9becea64 | 1330 | c-00d76725 | Error: ENOENT: no such file or directory, open 'C:\tmp\rewrite\replace.txt' |
| 4 | T-a9f16ff0-401 | ep-a9f16ff0 | 401 | c-00eb81f4 | cp: cannot stat 'references/_lead/community-workbuddy-index.mjs': No such file |
| 5 | T-aa52f421-613 | ep-aa52f421 | 613 | c-01b1ecf1 | Error: ENOENT: no such file or directory, open 'D:\tmp\magpie-plugins-after |
| 6 | T-00b50089-9006 | ep-00b50089 | 9006 | c-01c643fc | SyntaxError: Illegal return statement at checkSyntax |
| 7 | T-1e82afca-45026 | ep-1e82afca | 45026 | c-01c643fc | SyntaxError: Illegal return statement at checkSyntax |
| 8 | T-32a78774-213 | ep-32a78774 | 213 | c-01f27abe | /usr/bin/bash: line 1: cd: <app.asar>/dsh: No such file |
| 9 | T-8a73e06b-26790 | ep-8a73e06b | 26790 | c-01f39877 | src/ui.mjs === 价格常量 === [exit code: 1] |
| 10 | T-bde12afa-3284 | ep-bde12afa | 3284 | c-0278a298 | Error: glob search failed (exit 2): rg: <workspace>/tm |
| 11 | T-4480912b-1382 | ep-4480912b | 1382 | c-0297c19b | --- FAIL: TestDshSpeedAcceptsAndSkipsWithoutBilling (0.25s) |
| 12 | T-8cc34e32-22116 | ep-8cc34e32 | 22116 | c-02d0cf71 | === 046509f 是否在 main 上 === [exit code: 1] |
```

> 注：第 2/8/10 条的原文含本机绝对路径，此处做了**脱敏替换**（`<fonts-dir>` / `<app.asar>` / `<workspace>`），实际脚本输出是完整路径。

## 3 · 判据（跑之前定死）

| 结果 | 判定 |
|---|---|
| `onlyB > onlyA` **且** p < 0.05 | **记忆有用**（B 路显著更多复发） |
| `onlyB ≈ onlyA`（p ≥ 0.05） | **无差别 ⇒ 记忆没起作用** |
| `onlyA > onlyB` | **方向相反**（有记忆时更容易复发）⇒ 查是不是"卡在诱导错误" |
| 配对数 < 6 | **样本不足**（0 vs 6 才刚过 p<0.05） |

> **样本量提示**：McNemar 精确检验在 `onlyA=0` 时需要 **onlyB ≥ 6** 才显著（0 vs 5 ⇒ p=0.0625；0 vs 6 ⇒ p=0.031）。**N=20 的任务里至少要有 6 对不一致**，否则只能报"方向"不能报"显著"。（这正是单测里 6 条 vs 4 条的差别——4 条时 p=0.125，不显著。）

## 4 · 执行步骤（哪几步必须由主人来做）

| # | 步骤 | 谁做 | 命令 |
|---|---|---|---|
| 1 | **出题**（生成任务清单） | 脚本 | `node scripts/ablation-live.mjs --n 20 --json > tmp/ablation-tasks.json` |
| 2 | **A 臂**：默认配置跑 N 个任务 | **主人**（宿主 + 模型） | 每个任务：`node scripts/ablation-live.mjs --record --task <id> --variant A --recurred 0/1` |
| 3 | **B 臂**：`GOKIFU_INJECT=off` 跑同一批 | **主人**（需改环境变量） | 同上，`--variant B` |
| 4 | **记分** | 脚本 | `node scripts/ablation-live.mjs --score` |
| 5 | **结论** | 我 | 按 §3 判据 |

**必须主人做的原因**：
- **不能重启/改 DSH 配置**（铁律 1/3）：`GOKIFU_INJECT=off` 要在**新会话**里生效；
- **不能调用模型**：A/B 两臂都要真实模型跑任务，"是否复发"由模型行为决定；
- **不能替主人决定任务批次**：N=20 要一次跑完（中途换配置会污染）。

## 5 · 结果记录格式（`evidence/ablation-live.jsonl`，追加）

```jsonl
{"taskId":"T-c0a5847a-50332","variant":"A","recurred":false,"run":"2026-11-06T14:00:00Z","note":""}
{"taskId":"T-c0a5847a-50332","variant":"B","recurred":true,"run":"2026-11-06T14:20:00Z","note":""}
```
- **幂等**：同 `taskId + variant` 重复记录会覆盖（不重复计数）；
- **只追加**：脚本不删既有行，只重写去重后的全集。

## 6 · 为什么这个设计能回答而 T305/T306 不能

| | T305/T306（观测） | T307（干预） |
|---|---|---|
| 分组依据 | 库里有没有 claim | **同一任务的两个变体** |
| 选择偏差 | **有**（claim 从复发中抽取） | **无**（同一任务跑两次） |
| 因果 | 不能 | **能**（唯一变量是注入开关） |
| 成本 | 0（已做两次） | 需主人跑 2×N 个会话 |

## 7 · 复现

```bash
node --test "test/ablation-live.test.mjs"    # 4 条
node scripts/ablation-live.mjs --n 20        # 出题
node scripts/ablation-live.mjs --record --task T-xxx --variant A --recurred 0
node scripts/ablation-live.mjs --score       # 记分 + 判定
```
