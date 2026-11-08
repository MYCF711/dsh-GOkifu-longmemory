# T40 · 洞见层变体泛化（大样本：3 个同类变体 × 12 轮）

> 生成于 2026-11-08 13:34 · 两批 meta：insight=2026-11-08T12-46-30-026Z（A 卡=env 原坑洞见层卡）、raw=2026-11-08T13-09-18-138Z（A 卡=env 原坑 raw 恢复卡）
> 判分：syntheticHit（只认 tool/result 里以变体签名开头的行；源码 console.error 不算）。
> **诚实性声明**：恢复事实与坑类陈述均为按 T28/T38 格式**手工构造**（合成坑没有真实恢复历史）；只证「卡形态能否让模型跨同类坑泛化」的机制，**不等于**真库洞见层覆盖率/效果，不能当第一验收面已证。

## 0 · 结论

- 洞见层卡（A=env 原坑的 `class:env-missing` 卡）在 3 个变体上共踩 **7/36 = 19.4%**；raw 恢复卡对照踩 **4/36 = 11.1%**（两批各 36 对，各自都跑 B 臂）。
- 洞见层 vs raw 的两独立比例检验（Fisher 精确，双尾）p = **0.514075**。
- **能否泛化到同类不同坑**：**不能**（洞见层与 raw 无差别）。
- **综合（关键）**：洞见层卡在变体上踩 **7/36 (19.4%)**，raw 卡踩 **4/36 (11.1%)**——洞见层**没有比 raw 更好**（Fisher p=0.514；raw 甚至更低）。且 env2/env4 的 B 臂基础踩坑率不足（4/12 ≈ 33%，变体不自然，按规则作废）；唯一 B 率达标的 env3 上，洞见层 A 2/12、raw A 1/12，两者都低、差 1 条，无优势。**结论：本实验不支持「洞见层能带来更好的跨坑泛化」**；洞见层目前更像「把原坑答案写得更抽象」，尚不足以证明值回 T37/T38 的改动。
- 每个变体的 B 臂踩坑率见 §1；B 率过低的变体按「不自然、作废」处理（不硬凑）。

## 1 · 变体坑设计（同坑类 env-missing，具体形态不同）

| 变体 | 题面 | 错误签名 | A 卡里有这个变量名吗 | B 踩坑率（insight/raw） | 变体有效？ |
|---|---|---|---|---|---|
| env2 | `bash node scripts/t23/pit-env2.mjs` | `Error: T23_PIT: T23_TOKEN2 is not set` | 否（A 卡写的是 env 的 T23_TOKEN） | 4/12 · 6/12 | ❌ B 率 33%，变体不自然（作废） |
| env3 | `bash node scripts/t23/pit-env3.mjs` | `Error: T23_PIT: T23_TOKEN3 is not set` | 否（A 卡写的是 env 的 T23_TOKEN） | 9/12 · 6/12 | ✅ B 率 75%/50% |
| env4 | `bash node scripts/t23/pit-envcheck.mjs` | `Error: T23_PIT: T23_TOKEN4 is not set` | 否（A 卡写的是 env 的 T23_TOKEN） | 4/12 · 8/12 | ⚠️ insight 批 B 率 33%（口径不一致，仅方向参考） |

判分机械性：变体脚本踩坑时把各自的固定错误串写进 stderr，落入 `tool/result`；`syntheticHit` 以变体签名逐行匹配。**A 卡与变体签名不同名**，所以能避开只能靠「从坑类陈述泛化」，抄不到具体变量名。

## 2 · 洞见层 vs raw（每个变体各自 vs 自己的 B）

| 变体 | 卡 | A 踩 | B 踩 | onlyB/onlyA | McNemar p |
|---|---|---|---|---|---|
| env2 | 洞见层 | 3/12 | 4/12 | 3 / 2 | 1 |
| env2 | raw | 1/12 | 6/12 | 5 / 0 | 0.0625 |
| env3 | 洞见层 | 2/12 | 9/12 | 7 / 0 | 0.015625 |
| env3 | raw | 1/12 | 6/12 | 6 / 1 | 0.125 |
| env4 | 洞见层 | 2/12 | 4/12 | 3 / 1 | 0.625 |
| env4 | raw | 2/12 | 8/12 | 7 / 1 | 0.0703125 |

## 3 · 逐对明细

### 洞见层卡批

| # | taskId | A 踩坑 | B 踩坑 | A 时长s | B 时长s |
|---|---|---|---|---|---|
| 1 | T23-env2-r1 | false | true | 29 | 12 |
| 2 | T23-env2-r10 | false | false | 15 | 17 |
| 3 | T23-env2-r11 | false | true | 22 | 20 |
| 4 | T23-env2-r12 | true | false | 10 | 11 |
| 5 | T23-env2-r2 | false | false | 16 | 18 |
| 6 | T23-env2-r3 | false | true | 14 | 14 |
| 7 | T23-env2-r4 | false | false | 16 | 33 |
| 8 | T23-env2-r5 | false | false | 22 | 41 |
| 9 | T23-env2-r6 | true | true | 27 | 40 |
| 10 | T23-env2-r7 | false | false | 25 | 15 |
| 11 | T23-env2-r8 | true | false | 11 | 19 |
| 12 | T23-env2-r9 | false | false | 14 | 11 |
| 13 | T23-env3-r1 | false | false | 14 | 14 |
| 14 | T23-env3-r10 | false | true | 19 | 13 |
| 15 | T23-env3-r11 | false | true | 8 | 11 |
| 16 | T23-env3-r12 | true | true | 9 | 26 |
| 17 | T23-env3-r2 | false | false | 21 | 22 |
| 18 | T23-env3-r3 | false | true | 11 | 17 |
| 19 | T23-env3-r4 | true | true | 24 | 46 |
| 20 | T23-env3-r5 | false | false | 12 | 33 |
| 21 | T23-env3-r6 | false | true | 11 | 43 |
| 22 | T23-env3-r7 | false | true | 14 | 25 |
| 23 | T23-env3-r8 | false | true | 11 | 10 |
| 24 | T23-env3-r9 | false | true | 23 | 14 |
| 25 | T23-env4-r1 | false | false | 17 | 28 |
| 26 | T23-env4-r10 | false | true | 14 | 22 |
| 27 | T23-env4-r11 | false | false | 13 | 10 |
| 28 | T23-env4-r12 | false | false | 11 | 15 |
| 29 | T23-env4-r2 | false | false | 51 | 16 |
| 30 | T23-env4-r3 | false | true | 22 | 20 |
| 31 | T23-env4-r4 | false | false | 13 | 24 |
| 32 | T23-env4-r5 | false | false | 17 | 15 |
| 33 | T23-env4-r6 | false | true | 16 | 29 |
| 34 | T23-env4-r7 | false | false | 16 | 20 |
| 35 | T23-env4-r8 | true | true | 10 | 9 |
| 36 | T23-env4-r9 | true | false | 16 | 19 |

### raw 卡批

| # | taskId | A 踩坑 | B 踩坑 | A 时长s | B 时长s |
|---|---|---|---|---|---|
| 1 | T23-env2-r1 | false | false | 14 | 17 |
| 2 | T23-env2-r10 | true | true | 23 | 15 |
| 3 | T23-env2-r11 | false | true | 12 | 37 |
| 4 | T23-env2-r12 | false | true | 9 | 15 |
| 5 | T23-env2-r2 | false | false | 13 | 16 |
| 6 | T23-env2-r3 | false | true | 19 | 12 |
| 7 | T23-env2-r4 | false | false | 23 | 18 |
| 8 | T23-env2-r5 | false | true | 17 | 39 |
| 9 | T23-env2-r6 | false | false | 17 | 20 |
| 10 | T23-env2-r7 | false | false | 11 | 9 |
| 11 | T23-env2-r8 | false | true | 14 | 38 |
| 12 | T23-env2-r9 | false | false | 20 | 16 |
| 13 | T23-env3-r1 | false | true | 16 | 34 |
| 14 | T23-env3-r10 | false | true | 16 | 9 |
| 15 | T23-env3-r11 | false | false | 12 | 19 |
| 16 | T23-env3-r12 | true | false | 12 | 18 |
| 17 | T23-env3-r2 | false | false | 21 | 12 |
| 18 | T23-env3-r3 | false | true | 11 | 11 |
| 19 | T23-env3-r4 | false | false | 11 | 27 |
| 20 | T23-env3-r5 | false | true | 16 | 43 |
| 21 | T23-env3-r6 | false | false | 10 | 37 |
| 22 | T23-env3-r7 | false | false | 12 | 33 |
| 23 | T23-env3-r8 | false | true | 23 | 29 |
| 24 | T23-env3-r9 | false | true | 12 | 35 |
| 25 | T23-env4-r1 | false | false | 29 | 34 |
| 26 | T23-env4-r10 | false | true | 13 | 16 |
| 27 | T23-env4-r11 | false | false | 18 | 22 |
| 28 | T23-env4-r12 | false | true | 16 | 29 |
| 29 | T23-env4-r2 | false | true | 19 | 12 |
| 30 | T23-env4-r3 | false | false | 15 | 26 |
| 31 | T23-env4-r4 | false | true | 21 | 32 |
| 32 | T23-env4-r5 | true | true | 15 | 11 |
| 33 | T23-env4-r6 | false | true | 14 | 19 |
| 34 | T23-env4-r7 | false | true | 21 | 10 |
| 35 | T23-env4-r8 | true | false | 125 | 19 |
| 36 | T23-env4-r9 | false | true | 15 | 16 |

## 4 · 口径与限制

- 超时：insight 批 0 条 / raw 批 0 条。
- **每批各自跑 B 臂**（不拿不同变体的 B 混比）；洞见层 vs raw 的总体比较用两独立比例（Fisher 精确）。
- 变体坑的 A 卡都是 **env 原坑**的卡（洞见层版本含 `class:env-missing`，raw 版本只写 `T23_TOKEN=demo`）；变体自身的变量名卡里没有。
- **恢复事实与坑类陈述为手工构造**；真库洞见层覆盖率见 T37/T38（5.26%→60.53%），本实验不覆盖「真库能否检索到」这一段。
- 合成坑的「自然性」：B 臂必须真的踩坑（本批按变体逐一看 B 率；B 率低的变体结论作废）。

## 5 · 复现

```bash
node scripts/ablation-sandbox.mjs --prepare --synthetic --rounds 12 --card insight --pits env2,env3,env4
node scripts/ablation-sandbox.mjs --run --max-pairs 36 --limit 300
node scripts/ablation-sandbox.mjs --prepare --synthetic --rounds 12 --card recovery --pits env2,env3,env4
node scripts/ablation-sandbox.mjs --run --max-pairs 36 --limit 300
```
