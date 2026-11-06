# T347 · F3 读时派生 —— 历史 1305 条 claim 立即受益，且不动数据

> `[本] 2026-11-06` · 承接 T343（字段入库）/ T345（上卡）。A2b 对照已跑。

## 0 · 一句话

F3 是 `claim.text` 的**纯函数** ⇒ **读时派生兜底**，历史 claim（库里没有该字段）也能上卡；
`f3OnCard:false` 保留回退。**零数据迁移**，且派生的卡片**逐字节确定**（可复算）。

## 1 · 为什么需要它

T345 只让**新归档**的 antipattern 带 F3；而库里 1305 条历史 claim 的 `falsifiableWhen` 是空的
（只增不改，永不回填）。于是「F3 上卡」在真库上**几乎不生效** —— 功能有、覆盖≈0。

**关键观察**：F3 不是观测证据，而是**文本规则的确定性函数**（`deriveFalsifiableWhen(claim.text)`）。
既然是纯函数，就不该只在写入时算一次 —— **读时算同样正确，且立刻覆盖全部历史**。

## 2 · 实现

| 位置 | 改动 |
|---|---|
| `src/rooms/inject.mjs` | `entryFromClaim` 的 F3 改为 `claim.falsifiableWhen ?? deriveFalsifiableWhen(body)`；新增开关 `f3OnCard`（默认 `true`），经 `buildMemoryCard` → `collectEntries` 透传 |
| `src/rooms/inject.mjs` | `PROVENANCE_LINE_RE` 允许坐标后**可选尾注**（`(?: · .+)?$`）—— 闸 0 的日期/seq 仍只从坐标组取 |
| `scripts/a2b-holdout.mjs` | `replayFrozen` / `runHoldout` 支持 `f3OnCard`，让 A2b 能 A/B |

**为什么不是"回填"**：回填要改写历史 claim 文件（违反「只增不改」）；读时派生**不碰数据**，且规则升级后自动生效。

## 3 · A2b 对照（真语料，114 条冻结考卷）

```
关 F3：严格 58/114 = 50.88%
开 F3：严格 58/114 = 50.88%
Δ = 0.00pp · 翻转 0（变好 0 / 变坏 0）
```

**诚实解读**：A2b 判的是「**召回哪些** claim」（watcher 的 `claims` 集合），
F3 尾注**不改召回、只加信息** ⇒ Δ=0 是**预期且正确**的，说明它**零损害**。
它的收益（防教条式套用 / 负迁移 ≤5% 硬上限）**需要另立判据**，A2b 测不到 —— 与 T337 的 `cost` 同性质。

## 4 · token 成本（口径同 T345）

- 可派生 **43.37%**（566/1305）；尾注平均 **37 字符**，截断上限 `F3_MAX_CHARS=60`
- 最坏单卡 5 行全带 = **53 tokens ≈ 预算 10.6%**（`budgetTokens` 自限）
- **关闭开关 ⇒ 与 0.6.3 之前逐字节一致**（T345 ②）

## 5 · 测试

`test/f3-on-card.test.mjs`（7 条，全绿）：

| # | 断言 |
|---|---|
| T345 ① | 有 F3 ⇒ 尾注在坐标之后 |
| T345 ② | **`f3OnCard:false` ⇒ 旧格式逐字节一致**（tombstone） |
| **T347 ①** | **历史 claim（无该字段）⇒ 读时派生兜底，仍上卡**；派生不污染逐字正文 |
| **T347 ②** | 纯函数：同库同题 ⇒ 两次建卡**逐字节相同**（`now` 只进 shadow） |
| T345 ③ | `parseCardLines` 的 `text` = 逐字原文（F3 混进正文 ⇒ A6 报 missing） |
| T345 ④ | 超长 ⇒ 截断到 60 |
| T345 ⑤ | 旧格式行仍解析（向后兼容） |

另修 `test/inject.test.mjs` 的一处**自写行正则**（锚定 `$` 会被尾注打破）—— 改为复用导出的 `PROVENANCE_LINE_RE`（单一来源，AGENTS §2.4）。
全量：**1038 条 / 1032 pass / 0 fail**；`node scripts/check.mjs` PASS。

## 6 · 未做 / 未验（如实）

- **未回填历史数据**（只增不改）：靠读时派生达到同样效果。
- **F3 的收益未被证明**：A2b 测不到；需要"负迁移率"判据（模型是否因过时教训做错事），该判据尚未设计。
- 尾注不含 `quote`（正文已有，重复会翻倍 token）。
