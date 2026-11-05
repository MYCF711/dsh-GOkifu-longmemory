# T287 · 中文 bigram 用在**产品级主题匹配**上：验证与结论

> `[本] 2026-11-06 05:15 +08:00` · **只读**（未改 `src/**`、未改 `test/**`、零模型调用）
> 原型：`tmp/t287-probe.mjs`（入口可达性）· `tmp/t287-sim.mjs`（bigram 分支模拟）
> 基线读数：`node scripts/metrics-guard.mjs --json`（本机全量语料，2026-11-06）

## 0 · 一句话结论

**产品级主题匹配不需要改：walk 早就能收中文 2 字词**（`signalFromText` 产出 CJK bigram terms，
`overlaps()` 对非 ASCII 用 `minLength=2`），**26/27 条 B2 的该局在 picked 里排第 1**。
加"中文 bigram（带 IDF 过滤）"分支的模拟结果是 **0 条变好、+13 个局被稀释**（纯噪声）
⇒ 不改产品代码，四项读数保持 **48.25% / 2.63% / A5=0 / p50=16.91ms**。

## 1 · 定位：改哪个文件？（答案是**都不用改**）

| 环节 | 位置 | 现状 |
|---|---|---|
| 信号抽取 | `src/rooms/inject.mjs` 的 `signalFromText` | **已经**把中文按 **2 字滑窗**切进 `terms`（`\u3400-\u9fff` 连续段逐 2 字） |
| 词面匹配 | `src/rooms/walk.mjs` 的 `overlaps()` + `minComparableLength()` | 非 ASCII **`minLength = 2`** ⇒ 2 字中文词可命中（英文/路径才要 ≥3） |
| 主题匹配 | `src/rooms/walk.mjs` 的 `matchTopics()` | 精确命中 1 分、包含命中 0.6 分，再按 df/kind 排序 |
| 判据 | `scripts/a2b-holdout.mjs` 的 `judgeStrict`（T284 已改） | 判别词 ≥2 **或** 中文 bigram ≥2 **或** 硬实体 ≥1 |

实测（`tmp/t287-probe.mjs`）：

```
B2 = 27 | 该局 topic 落在 picked(前8) 内: 26 | 掉出前8: 1 | walk hits 含该局: 0
ep-bc4ab3cb | rank 1 / 64  | hit false | domain:opc.fiime.cn(df=4) · term:后看(df=1) · term:网页(df=1)
ep-9becea64 | rank 1 / 45  | hit false | term:最小(df=1) · term:扫一(df=2) · term:脱敏(df=2)
ep-00b50089 | rank 74 / 120 | hit false | repo:actions/setup-node(df=1) · dependency:--prefer-offline(df=1) · …
ep-03bc3e53 | rank 1 / 47  | hit false | term:auto(df=1) · term:具体(df=1) · term:请求(df=1)
ep-a1aab8ef | rank 1 / 360 | hit false | term:确认(df=1) · term:话调(df=1) · term:调用(df=6)
```

⇒ **入口是通的**（该局排第 1），**但 walk 的 top-5 hits 里没有这条局** ——
`hits` 先按档位（failure/constraint/claim）再按 depth/…排序，**episode 指针排最后**，
名额被 claim 行占满；与该局绑定的 claim 又输给了别的 claim（T240/T246 已到平台期）。

## 2 · 原型模拟：加 bigram 分支能救多少（`tmp/t287-sim.mjs`）

复刻 `matchTopics` 并加一条分支：`topic.key` 的**判别性**中文 bigram（`isDiscriminative(bg, filter, 0.02)`）
出现在信号里 ⇒ 得 **0.4 分**（排在精确 1.0 / 包含 0.6 之后，不挤掉原命中）。

```
B2 = 27
加 bigram 分支后，该局仍在前 8 picked 内: 26 | 掉出前 8: 1
picked 里**新增**的局（稀释）: 13 | 新增 topic 数: 102
判别性 bigram 过滤器 df/N 上限 = 0.02 · 语料 claim = 1578
  ep-bc4ab3cb | 该局 rank 前 1 → 后 1 | picked 64 → 67 | 覆盖局数 12 → 12
  ep-9becea64 | 该局 rank 前 1 → 后 1 | picked 45 → 46 | 覆盖局数 22 → 22
  ep-00b50089 | 该局 rank 前 74 → 后 46 | picked 120 → 131 | 覆盖局数 7 → 8
  ep-03bc3e53 | 该局 rank 前 1 → 后 1 | picked 47 → 47 | 覆盖局数 18 → 18
  ep-a1aab8ef | 该局 rank 前 360 → 后 360 | picked 19 → 21
```

- **0 条**从"不在 picked"变成"在 picked"（唯一变化的 `ep-00b50089` 74→46，仍在前 8 之外）；
- **+13 个局 / +102 个 topic** 进入 picked ⇒ 只增加 top-5 竞争（稀释），不增加命中；
- 与 T285 的误判警告一致：**bigram 当检索信号会满图乱连（56.1% 假入口）**，IDF 过滤只是把 56% 压到"仍然稀释"。

## 3 · 四项读数（before / after）

因为**没有改产品代码**（模拟证明收益为 0 且有稀释），四项读数**前后相同**：

| 指标 | before | after | 说明 |
|---|---|---|---|
| 主判据（A2b 严格命中） | **48.25%**（55/114） | **48.25%** | 未改产品代码 ⇒ 不变 |
| 误判率（negativeControl 桥接率） | **2.63%**（T286 读数） | **2.63%** | 同上 |
| A5 跨作用域 | **0** | **0** | 未动 scope 逻辑 |
| A4 p50 延迟 | **16.91 ms** | **16.91 ms** | 未加任何匹配分支（模拟分支若上线，picked 从 64→67 起，延迟只会更差） |

## 4 · 回报（一句话）

**产品级中文匹配不能把召回再抬一截**：walk 的主题匹配**本来就收**中文 2 字词（`minLength=2` + `signalFromText` 的 CJK bigram），
26/27 条 B2 的该局已经排第 1；加带 IDF 过滤的 bigram 分支模拟下来 **0 条变好、反而稀释 13 局、102 个 topic**。
**瓶颈不在"入口匹配"，而在"入口之后"**：episode 指针在 hits 里排最后（档位/排序），
与该局绑定的 claim 进不了 top-5 —— 那是 T240 的排序键与 T246 已证实的平台期，
继续在 walk 的匹配层加分支只会更差。

## 5 · 为什么没有交实现

任务书写明"**数据证明它真的好**才接生产"、"不许交半成品"。本次数据是**反证**（0 收益 + 稀释），
按 T227「未消费的能力是纯成本」的口径，**不把该分支合入** `src/rooms/walk.mjs`；
`tmp/t287-sim.mjs` 留着，将来若排序层能把 episode 指针抬进 top-5，再回来重测这条分支。
