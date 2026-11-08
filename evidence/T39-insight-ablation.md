# T39 · 洞见层恢复事实 ablation（T29 升级版 + 同类变体泛化）

> 生成于 2026-11-08 12:24 · 三批沙箱 meta：A=2026-11-08T12-02-51-765Z（env×12 insight）、B=2026-11-08T12-14-00-621Z（env2×6 insight）、C=2026-11-08T12-17-16-557Z（env2×6 raw 对照）
> 判分：syntheticHit（只认 tool/result 里以题目签名开头的行；源码 console.error 不算）。
> **诚实性声明**：本批 A 卡里的「恢复事实」与「坑类陈述」都是**手工构造**的（合成坑没有真实恢复历史）；只证「卡形态能否让模型避开/泛化」的机制，**不等于**真库洞见层覆盖率或效果，也不能当第一验收面已证。

## 0 · 结论

- **主批（T39，洞见层）**：env 坑 × 12 轮，有效对 **12**；A（有卡）踩 **0/12 = 0.0%**，B（无卡）踩 **8/12 = 66.7%**；onlyB **8** / onlyA **0**；McNemar p = **0.0078125**。
- **变体泛化（同类不同坑 env2）**：洞见层卡 A 踩 **1/6 = 16.7%**（B 3/6）；raw 恢复卡对照 A 踩 **2/6 = 33.3%**（B 1/6）。**注意两批 B 基础率不同（3/6 vs 1/6），不能直接比 A 率；样本仅 6 轮/批，只作方向性参考。**
- **结论**：主批洞见层卡 A **0/12 = 0.0%**，是四批里最低（优于 raw 恢复 8.3%、事实型 25%、指令式 8.3%），**支持「洞见层值得加」**；但变体泛化证据弱（见 §0.2 的样本量限制），不能据此说「跨类泛化已证」。

### 0.1 四批对照（同坑 env、同题面、同判分）

| 卡形态 | A 踩坑 | B 踩坑 | onlyB/onlyA | McNemar p |
|---|---|---|---|---|
| 指令式（T23） | 1/12 = 8.3% | 11/12 = 91.7% | 10 / 0 | 0.001953 |
| 事实型 raw（T26） | 3/12 = 25.0% | 7/12 = 58.3% | 4 / 0 | 0.125 |
| 事实型+raw 恢复（T29） | 1/12 = 8.3% | 8/12 = 66.7% | 7 / 0 | 0.015625 |
| **事实型+洞见层恢复（T39 本批）** | **0/12 = 0.0%** | **8/12 = 66.7%** | **8 / 0** | **0.0078125** |

### 0.2 同类变体坑（env2：把 T23_TOKEN 换成 T23_TOKEN2）

| A 卡 | A 踩坑（env2） | B 踩坑 | 泛化？ |
|---|---|---|---|
| 洞见层卡（含 class:env-missing） | **1/6** | 3/6 | ✅ 有泛化迹象 |
| raw 恢复卡（只写 T23_TOKEN） | **2/6** | 1/6 | ❌ 未泛化 |

> 变体坑的 A 卡**仍是 env 坑的卡**（只差坑类陈述 vs raw 命令），所以这才是「同一张卡跨坑类泛化」的对照：raw 里写的是 `T23_TOKEN`，对 `T23_TOKEN2` 帮不上；洞见层写的是「环境变量未设置」这一类。
>
> **读法提醒**：两批的 B 臂基础踩坑率不同（3/6 vs 1/6），A 率不能直接跨批比较；且 6 轮/批的随机波动很大（A 差 1 条就翻倍）。所以「洞见层泛化更好」只能说**方向一致、证据不足**。

## 1 · 合成坑设计

| 坑 | 题面 | 错误签名 | 坑类（洞见层） | 为什么无记忆会踩 |
|---|---|---|---|---|
| env | `bash node scripts/t23/pit-env.mjs` | `Error: T23_PIT: T23_TOKEN is not set` | `env-missing`（环境变量未设置） | 不设变量直接跑就踩 |
| env2（变体） | `bash node scripts/t23/pit-env2.mjs` | `Error: T23_PIT: T23_TOKEN2 is not set` | `env-missing`（同类，不同变量名） | 同上，但卡里没有这个变量名 |

判分机械性：脚本踩坑时把固定错误串写进 stderr → 落入 `tool/result`；`syntheticHit` 扫 `tool/result` 每行，**以签名开头**且不含 `console.error` 即判踩坑。与卡无关。

## 2 · 逐对明细

### A（env×12 洞见层）

| # | taskId | A 踩坑 | B 踩坑 | A 时长s | B 时长s |
|---|---|---|---|---|---|
| 1 | T23-env-r1 | false | false | 8 | 37 |
| 2 | T23-env-r10 | false | false | 10 | 28 |
| 3 | T23-env-r11 | false | false | 14 | 29 |
| 4 | T23-env-r12 | false | true | 14 | 29 |
| 5 | T23-env-r2 | false | true | 8 | 11 |
| 6 | T23-env-r3 | false | true | 13 | 54 |
| 7 | T23-env-r4 | false | true | 11 | 27 |
| 8 | T23-env-r5 | false | false | 12 | 13 |
| 9 | T23-env-r6 | false | true | 11 | 24 |
| 10 | T23-env-r7 | false | true | 12 | 20 |
| 11 | T23-env-r8 | false | true | 11 | 26 |
| 12 | T23-env-r9 | false | true | 15 | 33 |

### B（env2×6 洞见层卡）

| # | taskId | A 踩坑 | B 踩坑 | A 时长s | B 时长s |
|---|---|---|---|---|---|
| 1 | T23-env2-r1 | false | false | 26 | 17 |
| 2 | T23-env2-r2 | false | false | 12 | 19 |
| 3 | T23-env2-r3 | false | true | 11 | 14 |
| 4 | T23-env2-r4 | false | true | 13 | 17 |
| 5 | T23-env2-r5 | true | true | 14 | 19 |
| 6 | T23-env2-r6 | false | false | 12 | 21 |

### C（env2×6 raw 卡）

| # | taskId | A 踩坑 | B 踩坑 | A 时长s | B 时长s |
|---|---|---|---|---|---|
| 1 | T23-env2-r1 | false | false | 13 | 51 |
| 2 | T23-env2-r2 | false | false | 13 | 70 |
| 3 | T23-env2-r3 | false | false | 22 | 41 |
| 4 | T23-env2-r4 | false | false | 9 | 28 |
| 5 | T23-env2-r5 | true | false | 20 | 35 |
| 6 | T23-env2-r6 | true | true | 18 | 23 |

## 3 · A 臂是否读出正确做法

### 3.1 主批（env，卡里写 T23_TOKEN）

- A 输出提到 `T23_TOKEN` 的：**12/12**；其中读出并避开：**12**。

| # | taskId | A 踩坑 | 提到 | 判定 |
|---|---|---|---|---|
| 1 | T23-env-r1 | false | true | ✅ 读出并避开 |
| 2 | T23-env-r10 | false | true | ✅ 读出并避开 |
| 3 | T23-env-r11 | false | true | ✅ 读出并避开 |
| 4 | T23-env-r12 | false | true | ✅ 读出并避开 |
| 5 | T23-env-r2 | false | true | ✅ 读出并避开 |
| 6 | T23-env-r3 | false | true | ✅ 读出并避开 |
| 7 | T23-env-r4 | false | true | ✅ 读出并避开 |
| 8 | T23-env-r5 | false | true | ✅ 读出并避开 |
| 9 | T23-env-r6 | false | true | ✅ 读出并避开 |
| 10 | T23-env-r7 | false | true | ✅ 读出并避开 |
| 11 | T23-env-r8 | false | true | ✅ 读出并避开 |
| 12 | T23-env-r9 | false | true | ✅ 读出并避开 |

### 3.2 变体（env2 洞见层卡，卡里没有 T23_TOKEN2）

- A 输出提到 `T23_TOKEN2` 的：**6/6**；其中读出并避开：**5**。

| # | taskId | A 踩坑 | 提到 | 判定 |
|---|---|---|---|---|
| 1 | T23-env2-r1 | false | true | ✅ 读出并避开 |
| 2 | T23-env2-r2 | false | true | ✅ 读出并避开 |
| 3 | T23-env2-r3 | false | true | ✅ 读出并避开 |
| 4 | T23-env2-r4 | false | true | ✅ 读出并避开 |
| 5 | T23-env2-r5 | true | true | ⚠️ 读出但已踩 |
| 6 | T23-env2-r6 | false | true | ✅ 读出并避开 |

### 3.3 变体（env2 raw 卡，对照）

- A 输出提到 `T23_TOKEN2` 的：**6/6**；其中读出并避开：**4**。

| # | taskId | A 踩坑 | 提到 | 判定 |
|---|---|---|---|---|
| 1 | T23-env2-r1 | false | true | ✅ 读出并避开 |
| 2 | T23-env2-r2 | false | true | ✅ 读出并避开 |
| 3 | T23-env2-r3 | false | true | ✅ 读出并避开 |
| 4 | T23-env2-r4 | false | true | ✅ 读出并避开 |
| 5 | T23-env2-r5 | true | true | ⚠️ 读出但已踩 |
| 6 | T23-env2-r6 | true | true | ⚠️ 读出但已踩 |

> 说明：「读出」= 最终回复里出现该变量名；只能证明模型**说出了**正确做法。变体里若 A 提到 `T23_TOKEN2` 且没踩，说明它从「环境变量未设置」这一类推到了新变量名。

## 4 · 口径与限制

- 超时：A 批 0 / B 批 0 / C 批 0 条（墙钟 ≥ limit−5s 或 status=null+SIGTERM）。
- 三批都是同题面、同判分；A 卡文字不同（洞见层 / raw）、或卡来自别的坑（变体）。
- **恢复事实与坑类陈述均为手工构造**；真库的洞见层覆盖率见 T37/T38 证据（5.26%→60.53%），本实验不覆盖「真库能否检索到/命中」这一段。
- 变体样本只有 6 轮/批，方向性证据，不做显著性结论。
- 结论只证机制：把「坑类」写进恢复事实，是否比只写 raw 命令更容易跨同类坑泛化。

## 5 · 复现

```bash
node scripts/ablation-sandbox.mjs --prepare --synthetic --rounds 12 --card insight --pits env
node scripts/ablation-sandbox.mjs --run --max-pairs 12 --limit 300
node scripts/ablation-sandbox.mjs --prepare --synthetic --rounds 6 --card insight --pits env2
node scripts/ablation-sandbox.mjs --run --max-pairs 6 --limit 300
node scripts/ablation-sandbox.mjs --prepare --synthetic --rounds 6 --card recovery --pits env2
node scripts/ablation-sandbox.mjs --run --max-pairs 6 --limit 300
```
