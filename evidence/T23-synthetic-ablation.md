# T23 · 合成坑 ablation（记忆能否防止踩坑 · 机制实验）

> 生成于 2026-11-08 05:35 · 沙箱 `<TMP>/kifu-ablation-sandbox/2026-11-08T05-17-36-673Z` · meta `<REPO>/tmp/ablation-meta/2026-11-08T05-17-36-673Z`
> 判分：合成坑用 syntheticHit —— 只认 tool/result 里以题目签名开头的行（源码 console.error 不算）；零模型。
> **诚实性声明（先说）**：本实验测的是「**记忆能不能防止踩一个已知的合成坑**」这个机制，**不是**「真实历史坑的复发率」，**不能**当作第一验收面（不重复踩坑）已证。

## 0 · 结论

- 题集：**4 个合成坑 × 3 轮 = 12 题**；跑出完整对 12 对。
- **有效坑**：4/4（B 臂至少踩 1 次的坑；B 不踩的坑作废，见 §1）。
- **有效对 12 对**：A（有卡）踩坑 **1/12 = 8.3%**，B（无卡）踩坑 **11/12 = 91.7%**；onlyA **0** / onlyB **10**；McNemar 精确 p = **0.001953125**。
- **方向**：**B 臂踩得更多（偏「记忆有用」）**；**显著性**：p < 0.05，达到显著。
- 全批（含作废坑）口径：A 1/12 vs B 11/12，p=0.001953125。

## 1 · 合成坑设计（坑是什么 / 为什么无记忆会踩 / 判分怎么机械）

| 坑 | 题面 | 错误签名（判分依据） | 为什么无记忆会踩 | B 踩 / A 踩 | 有效 |
|---|---|---|---|---|---|
| 环境变量守卫（pit-env） | `bash node scripts/t23/pit-env.mjs` | `Error: T23_PIT: T23_TOKEN is not set` | 脚本只在运行期检查 T23_TOKEN；题面只说跑脚本，不设变量直接跑就踩 | **2/3** / 0/3 | ✅ |
| 缺省参数守卫（pit-flag） | `bash node scripts/t23/pit-flag.mjs` | `Error: T23_PIT: network disabled; rerun with --offline` | 脚本默认走网络分支并 fail-closed；题面没写 --offline，直接跑就踩 | **3/3** / 0/3 | ✅ |
| 初始化顺序（pit-order / pit-init） | `bash node scripts/t23/pit-order.mjs` | `Error: T23_PIT: state missing; run node scripts/t23/pit-init.mjs first` | order 依赖 init 写入的状态文件；不先 init 直接跑就踩（状态在每臂独立 DSH_HOME） | **3/3** / 0/3 | ✅ |
| 运行目录要求（pit-cwd） | `bash node scripts/t23/pit-cwd.mjs` | `Error: T23_PIT: must run from scripts/t23` | 脚本只认 cwd=scripts/t23；从仓库根跑就踩 | **3/3** / 1/3 | ✅ |

判分机械性：每个坑的脚本在踩坑时把固定错误串写进 stderr，落入 tool/result。syntheticHit 扫描 tool/result 文本的每一行：以题目 signature 开头的行即判 recurred=true（read 到源码里的 console.error 不算）。与 A 臂给不给卡无关，卡正文不在 tool/result 里。

## 2 · 逐对明细

| # | taskId | 坑 | A 踩坑 | B 踩坑 | A 时长s | B 时长s |
|---|---|---|---|---|---|---|
| 1 | T23-env-r1 | env | false | false | 21 | 45 |
| 2 | T23-flag-r1 | flag | false | true | 8 | 26 |
| 3 | T23-order-r1 | order | false | true | 55 | 63 |
| 4 | T23-cwd-r1 | cwd | true | true | 24 | 19 |
| 5 | T23-env-r2 | env | false | true | 11 | 24 |
| 6 | T23-flag-r2 | flag | false | true | 14 | 22 |
| 7 | T23-order-r2 | order | false | true | 124 | 161 |
| 8 | T23-cwd-r2 | cwd | false | true | 16 | 21 |
| 9 | T23-env-r3 | env | false | true | 42 | 60 |
| 10 | T23-flag-r3 | flag | false | true | 13 | 18 |
| 11 | T23-order-r3 | order | false | true | 74 | 63 |
| 12 | T23-cwd-r3 | cwd | false | true | 24 | 33 |

## 3 · 口径与限制

- 超时：A 0 条 / B 0 条（墙钟 ≥ limit−5s 或 status=null+SIGTERM）。
- A 臂的卡是**手写、符合 memory-ledger 格式**的合成卡（写明该坑的错误原文与修复方式）；B 臂只有题面。两臂只差这一张卡。
- 合成坑的**外部效度有限**：它证明「卡里写了这个坑 ⇒ 模型会避开」，不等于真实历史坑在自然场景下会被记住/被检索到。要证第一验收面，仍需真实坑的 field 数据。
- 坑的「自然性」：题面只给动作、不给提示；B 臂若通过读源码自行发现守卫，会表现为「不踩」→ 该坑作废（本报告按此规则处理）。

## 4 · 复现

```bash
node scripts/ablation-sandbox.mjs --prepare --synthetic --rounds 3
node scripts/ablation-sandbox.mjs --run --max-pairs 12 --limit 300
node scripts/ablation-sandbox.mjs --report-synthetic --out evidence/T23-synthetic-ablation.md
```
