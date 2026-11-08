# T26 · 事实型卡 ablation（线上可外推版：卡里只有事实，没有祈使句）

> 生成于 2026-11-08 06:24 · 沙箱 `<TMP>/kifu-ablation-sandbox/2026-11-08T06-13-13-141Z` · meta `<REPO>/tmp/ablation-meta/2026-11-08T06-13-13-141Z`
> 判分：合成坑用 syntheticHit —— 只认 tool/result 里以题目签名开头的行（源码 console.error 不算）；零模型。
> **诚实性声明（先说）**：本实验测的是「**记忆卡里的一条失败事实，能不能让模型不踩同一个坑**」这个机制，**不是**「真实历史坑的复发率」，**不能**当作第一验收面（不重复踩坑）已证。

## 0 · 结论

- 题集：**1 个合成坑 × 12 轮 = 12 题**；跑出完整对 12 对；A 卡形态：**事实型（只写「哪一局、跑了什么、报了什么错、日期」）**。
- **有效坑**：1/1（B 臂至少踩 1 次的坑；B 不踩的坑作废，见 §1）。
- **有效对 12 对**：A（有卡）踩坑 **3/12 = 25.0%**，B（无卡）踩坑 **7/12 = 58.3%**；onlyA **0** / onlyB **4**；McNemar 精确 p = **0.125**。
- **方向**：**B 臂踩得更多（偏「记忆有用」）**；**显著性**：p ≥ 0.05，未达显著。
- 全批（含作废坑）口径：A 3/12 vs B 7/12，p=0.125。

### 0.1 事实型 vs 指令式（T23 对照）

| 卡形态 | A 踩坑 | B 踩坑 | onlyB/onlyA | McNemar p | 结论 |
|---|---|---|---|---|---|
| 指令式（T23，2026-11-08 首批） | 1/12 = 8.3% | 11/12 = 91.7% | 10 / 0 | 0.001953 | 指令式有效（但线上不许用祈使句） |
| **事实型（本批 T26）** | **3/12 = 25.0%** | **7/12 = 58.3%** | **4 / 0** | **0.125** | 事实型有方向但未达显著（样本少） |

> 对照口径：T23 与 T26 用同一 4 个坑、同一题面、同一判分（syntheticHit），**只换 A 卡文字**；T23 数字取自 `evidence/T23-synthetic-ablation.md`（指令式卡）。

## 1 · 合成坑设计（坑是什么 / 为什么无记忆会踩 / 判分怎么机械）

| 坑 | 题面 | 错误签名（判分依据） | 为什么无记忆会踩 | B 踩 / A 踩 | 有效 |
|---|---|---|---|---|---|
| 环境变量守卫（pit-env） | `bash node scripts/t23/pit-env.mjs` | `Error: T23_PIT: T23_TOKEN is not set` | 脚本只在运行期检查 T23_TOKEN；题面只说「跑这个脚本」，不读源码/不设变量就会踩 | **7/12** / 3/12 | ✅ |

判分机械性：每个坑的脚本在踩坑时把固定错误串写进 stderr，落入 tool/result。syntheticHit 扫描 tool/result 文本的每一行：以题目 signature 开头的行即判 recurred=true（read 到源码里的 console.error 不算）。与 A 臂给不给卡无关，卡正文不在 tool/result 里。

## 2 · 逐对明细

| # | taskId | 坑 | A 踩坑 | B 踩坑 | A 时长s | B 时长s |
|---|---|---|---|---|---|---|
| 1 | T23-env-r1 | env | false | false | 26 | 21 |
| 2 | T23-env-r2 | env | true | true | 28 | 25 |
| 3 | T23-env-r3 | env | false | true | 24 | 48 |
| 4 | T23-env-r4 | env | false | false | 27 | 23 |
| 5 | T23-env-r5 | env | true | true | 22 | 37 |
| 6 | T23-env-r6 | env | false | false | 26 | 35 |
| 7 | T23-env-r7 | env | false | true | 13 | 23 |
| 8 | T23-env-r8 | env | true | true | 39 | 19 |
| 9 | T23-env-r9 | env | false | false | 26 | 16 |
| 10 | T23-env-r10 | env | false | true | 17 | 15 |
| 11 | T23-env-r11 | env | false | true | 29 | 26 |
| 12 | T23-env-r12 | env | false | false | 22 | 39 |

## 3 · 口径与限制

- 超时：A 0 条 / B 0 条（墙钟 ≥ limit−5s 或 status=null+SIGTERM）。
- A 臂的卡是**手写、符合 memory-ledger 格式**的合成卡（本批形态：事实型——只写「哪一局、跑了什么、报了什么错、日期」，不含祈使句）；B 臂只有题面。两臂只差这一张卡。
- 本批实际跑的有效坑：env（12 对）。其余坑若 B 臂一次都没踩，按「B 不踩即作废」规则剔除，不参与计分。
- **为什么只剩这些坑**：预跑 4 坑时，flag/order/cwd 的 B 臂多数轮次读源码或先做诊断后**主动避开**（踩坑率低或为 0；按「B 不踩即作废」处理），只有 env 的 B 踩坑率稳定（约 6/12）；故用 env 多轮凑足 ≥10 有效对。这也是「指令式 vs 事实型」对比里要一起看的：**坑本身要足够「自然会踩」**。
- 合成坑的**外部效度有限**：它证明「卡里写了这个坑 ⇒ 模型会避开」，不等于真实历史坑在自然场景下会被记住/被检索到。要证第一验收面，仍需真实坑的 field 数据。
- 坑的「自然性」：题面只给动作、不给提示；B 臂若通过读源码自行发现守卫，会表现为「不踩」→ 该坑作废（本报告按此规则处理）。

## 4 · 复现

```bash
node scripts/ablation-sandbox.mjs --prepare --synthetic --rounds 12 --card factual --pits env
node scripts/ablation-sandbox.mjs --run --max-pairs 12 --limit 300
node scripts/ablation-sandbox.mjs --report-synthetic --out evidence/T23-synthetic-ablation.md
```
