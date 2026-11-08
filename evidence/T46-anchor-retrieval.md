# T46 · 锚定作为检索通路（抬 A2b 的最后一试）

> 日期：2026-11-09 · 改动：`src/rooms/walk.mjs`（第 4 条检索通路 + 空匹配快路径门）、`test/walk.test.mjs`（T46 ①–②）
> 依据：`evidence/T45-walk-anchor.md`（重排 0 收益；A2b 是集合口径）、`evidence/T21-a2b-attribution.md`（放宽 limit / 重排全非正）

## 0 · 结论（负结果，如实报）

**锚定检索通路做出来了，但 A2b 严格率没有提升：47.95% → 47.95%（Δ 0），宽松 67.81% → 67.81%（Δ 0），0 掉分。** 而且新增候选的**精度是 0%**：

| 臂 | 严格 | 宽松 | 新增候选行 | 新增里 strict | 新增里 related |
|---|---|---|---|---|---|
| 关掉（基线） | 70/146 = 47.95% | 99/146 = 67.81% | — | — | — |
| 只开检索通路 | 70/146 = 47.95% | 99/146 = 67.81% | **4** | **0** | **0** |
| 检索 + 排序 | 70/146 = 47.95% | 99/146 = 67.81% | 4 | 0 | 0 |

**新增的 4 条候选全部不相关（strict 0 / related 0）** —— 也就是说：这条通路把"同一 repo / 同一错误签名 / 同一任务链"的条目拉进来了，但它们在 A2b 的口径下**没有一条是相关记忆**。**0 掉分**（没有把任何 strict 行挤掉）成立，但**收益为 0**。

**结论：不开启（默认关）。A2b 严格 46.6%（118 题口径）/ 47.95%（146 题冻结考卷口径）就是当前机械判据的顶。** 这符合任务书"找不到就接受这个顶"的预设，不再找机械提升路径。

## 1 · 实现（`src/rooms/walk.mjs`）

1. **第 4 条检索通路**（在 topic/link/文本匹配之后、T179 合并展开之前）：

```js
{
  const anchorMatchOf = typeof opts.anchorMatchOf === 'function' && opts.anchorRetrieval !== false ? opts.anchorMatchOf : null;
  if (anchorMatchOf && opts.signalText) {
    for (const claim of store.list('claims').map((e) => e?.record ?? e)) {
      if (claimHits.has(claim.id) || claim.state === 'invalidated') continue;   // 去重 + 同规则
      if (!anchorMatchOf(text, opts.signalText)) continue;                     // 判据由调用方注入
      const visibleSupport = support.find(/* 同 scope + 非 folded */);
      if (!visibleSupport) { dropped.crossScope += 1; continue; }              // 作用域闸优先
      const occurredAt = claimTime(claim, visibleSupport);
      if (!finiteNumber(occurredAt)) { dropped.noTime += 1; continue; }        // 无时不入
      // 与文本匹配路径**同形状**的 hit（why:['anchor']、weight 0.5、depth 1、direct:true）
      claimHits.set(claim.id, hit);
    }
  }
}
```

- **walk 保持零 import**（R11 tombstone：源码不 import 任何模块）——锚定判据（T44 的 `hasExactAnchor`）由**调用方**以 `opts.anchorMatchOf(claimText, signalText)` 注入。
- **空匹配快路径加门**：原来 `picked.length === 0` 直接 `return emptyResult()`，第 4 条通路永远跑不到（这就是第一版"检索不到"的原因，已修）：
  ```js
  if (picked.length === 0) {
    const anchorRetrievalOn = typeof opts.anchorMatchOf === 'function' && opts.anchorRetrieval !== false && opts.signalText;
    if (!anchorRetrievalOn) { dropped.noTopic += 1; return emptyResult(); }   // 无锚定 ⇒ 与改动前逐字节一致
  }
  ```
- 与现有候选**合并去重**（`claimHits` 已存在的 claim 不重复加）。

## 2 · A2b 前后对照（同一份冻结考卷，`tmp/t46-replay.mjs`）

逐行复刻 `scripts/a2b-holdout.mjs` 的 `runHoldout`（同一个 `buildExam`（冻结 `evidence/a2b-set.json`）/ `signalFromText` / `walkFromSignals` / `buildMemoryCard` / `judgeCard`），只切换 `anchorRetrieval` / `anchorRanking`：

- 基线：strict 70/146 = **47.95%**，related 99/146 = 67.81%（与 T45 一致，可复现）。
- 只开检索：**同**；新增候选 4 行，**strict 0 / related 0（精度 0%）**。
- 检索 + 排序：**同**；`flips: []`（0 升 0 降）。

**为什么 0 收益（实测归因）**：

1. A2b 的 strict 是**集合口径**（渲染 5 行里有没有），不是排序口径；
2. 锚定命中的 claim 在 A2b 里**绝大多数本来就在候选池里**（T44：403 个渲染行里 11 个命中锚定，全在 top-5 内）——新增的 4 条是"池外"的，但它们恰好**都不相关**；
3. 池外的锚定 claim 里，最大的一批是**跨 scope**（诊断：27 个锚定命中里 9 个题的命中在池外，其中多数 `claimScope = w:e:/…` ≠ 题 scope）⇒ 被 A5 作用域闸正确挡住（不许为抬指标放宽作用域）；
4. 剩下同 scope 的池外命中只有极少数（诊断 3 个），且都不是 strict。

## 3 · tombstone

- `anchorRetrieval: false`（或不传 `anchorMatchOf`）⇒ 第 4 条通路不存在，且空匹配快路径**原样** `return emptyResult()` ⇒ 候选池/排序/输出与改动前**逐字节一致**（T46 ① 用 `JSON.stringify(off) === JSON.stringify(base)` 断言）。
- 作用域闸优先：跨 scope 的锚定 claim **绝不进池**，只 `dropped.crossScope += 1`（T46 ②）。
- 无时不入：`occurredAt` 缺失 ⇒ `dropped.noTime += 1`（同主路径）。
- 既有 R11「源码零 import」tombstone 仍绿（walk 未新增 import）。

## 4 · 测试（`test/walk.test.mjs` T46 ①–②）

| # | 断言 |
|---|---|
| T46 ① | 锚定 claim 在 topic/link 走不到时**也能进候选池**；不传/关掉 ⇒ 与基线 `JSON.stringify` 全等（tombstone） |
| T46 ② | 跨 scope 的锚定 claim **不进池**，只记 `crossScope`（作用域闸优先于锚定） |

## 5 · 验收

- 全量：`node --test "test/*.test.mjs"` —— **1213 tests / 1207 pass / 0 fail / 6 skipped**（exit 0）。
- `node scripts/check.mjs` PASS。
- A2b：`node tmp/t46-replay.mjs`（47.95% → 47.95%，新增候选 4 行、strict 0、related 0、flips 0）。

## 6 · 复现

```bash
node --test --test-name-pattern "T46" test/walk.test.mjs
node tmp/t46-replay.mjs     # A2b 三臂：基线 / 只检索 / 检索+排序
node tmp/t46-diag.mjs       # 锚定命中在池内/池外的分布（含 scope）
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- A2b 严格：**47.95% → 47.95%（Δ 0）**；宽松 67.81% → 67.81%（Δ 0）；`flips: []`；
- 新增候选：**4 行，strict 0 / related 0（精度 0%）**；
- 作用域：池外锚定命中的多数是**跨 scope**（A5 闸正确挡住，不放宽）；
- tombstone：关掉通路 ⇒ 与基线 **JSON 全等**（T46 ①）。

## 7 · 建议（接受 46.6% 是顶）

1. **不开启**：锚定检索通路保留为**默认关**的可选项（`anchorRetrieval` + 调用方回调），因为它精度 0%；打开只会引入噪声。
2. **A2b 的机械提升到此为止**：T21（放宽 limit）、T45（重排）、T46（加检索通路）三次实测全部 0/负。46.6% 是**当前机械判据 + 当前数据**的顶；再往上需要换**判据口径**（例如把"同局相关"换成"内容相关"，T362 已有并列口径），而不是继续加机械规则。
3. 若要继续：下一步应是**标注复核**（A2b 的 strict/related 标签本身是否可信 —— 本刀诊断里 4 条新增候选"不相关"是否真的不相关，需要人工抽样），而不是再找一条检索通路。
4. 生产接入：**不要接**（`plugin.mjs` 未传回调；即使接了也是 0 收益 + 噪声）。

## 8 · 限制

1. 4 条新增候选的"不相关"是 **A2b 机械标签**（support 归属 + 词重合）判的，不是人工标注；从这个口径看精度 0%，换人工口径可能不同（但本刀没有人工样本，不能声称）。
2. 冻结考卷 146 题 vs holdout 报告 118 题：同源同题对照的 Δ 才是结论；绝对值差异来自题集口径。
3. 跨 scope 的池外命中"应当被挡"是 **A5 作用域闸**的既有契约（`evidence/T12`、`docs/记忆的职责边界.md`），本刀不放宽。
4. 未做线上验证（本刀默认关，线上零变化）。