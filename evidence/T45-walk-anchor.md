# T45 · walk 排序用精确锚定（抬 A2b 的尝试）

> 日期：2026-11-09 · 改动：`src/rooms/walk.mjs`（排序键 + 调用方回调）、`test/walk.test.mjs`（T45 ①–②）
> 依据：`evidence/T44-exact-anchor.md`（abstain 线到顶；A2b 的分母是"渲染哪 5 行"）、`evidence/T21-a2b-attribution.md`（T21 实测：放宽 limit / 重排**全部非正**）

## 0 · 结论（先说结果）

**实现了，但 A2b 严格率没有提升：47.95% → 47.95%，宽松 67.81% → 67.81%，逐题翻转 0 条。** 原因是**结构性的**，不是实现 bug：

- A2b 的 strict 是**集合口径**（渲染的 5 行里有没有一条 strict），不是排序口径；
- 精确锚定在 A2b 语料上**只命中已被渲染的行**（T44 实测：403 行里命中 11 行，全是 top-5 内的行）；
- 把 top-5 **内部**重排，不可能改变"top-5 里有没有" ⇒ **hit@5 不动**。
- 146 道题里只有 **2 道**顺序有变化（同分 tie 的次序），没有一道题的命中集变化。

**要让锚定真正抬 A2b，必须让它"加候选"（把 top-5 之外的同身份条目拉进候选池），而不是"重排 top-5"。** 那是 walk 的**候选生成**改动（新检索通路），与本刀不同，需另立任务并做回归对照。

## 1 · 实现（`src/rooms/walk.mjs`）

1. **排序键**：`compareHits` 新增**最高优先键** `_anchorRank`（0 = 命中锚定，1 = 未命中；缺省 1）：

```js
const anchorA = finiteNumber(a?._anchorRank) ? a._anchorRank : 1;
const anchorB = finiteNumber(b?._anchorRank) ? b._anchorRank : 1;
if (anchorA !== anchorB) return anchorA - anchorB;   // 0 在前
// 其余键（tokOverlap → 档位 → depth → repeat → weight → occurredAt → id）一字不动
```

2. **锚定判据由调用方传入**（关键设计）：

```js
const anchorRankOf = typeof opts.anchorRankOf === 'function' && opts.anchorRanking !== false ? opts.anchorRankOf : null;
if (anchorRankOf) {
  const signalText = opts.signalText ?? [terms, entities].join(' ');
  for (const hit of [...episodeHits.values(), ...claimHits.values()]) {
    hit._anchorRank = hit.text && anchorRankOf(String(hit.text), signalText) ? 0 : 1;
  }
}
```

**为什么用回调而不是 import**：`test/walk.test.mjs` 有一条 R11 tombstone ——「源码不 import 任何模块（连 node: 内置都没有）」。直接 `import { hasExactAnchor } from './abstain.mjs'` 会**打破这条既有契约**（首版就是这么写的，跑全量会红）。所以 walk 保持零依赖，锚定判据（T44 的 `hasExactAnchor`）从调用方注入。

3. **默认行为不变**：不传 `anchorRankOf` ⇒ 不计算 `_anchorRank` ⇒ 排序与改动前**逐字节一致**（T45 ② 用 `JSON.stringify` 全等断言）。

## 2 · A2b 前后对照（同一份冻结考卷，`tmp/t45-replay.mjs`）

重放脚本**逐行对照 `scripts/a2b-holdout.mjs` 的 `runHoldout`**（同一个 `buildExam`（冻结 `evidence/a2b-set.json`）/ `signalFromText` / `walkFromSignals` / `buildMemoryCard` / `judgeCard`），只切换 `anchorRankOf`：

| 口径 | 关掉锚定（改动前） | 打开锚定（改动后） | Δ |
|---|---|---|---|
| 题数 | 146 | 146 | — |
| **严格命中** | **70 / 146 = 47.95%** | **70 / 146 = 47.95%** | **0** |
| 宽松命中 | 99 / 146 = 67.81% | 99 / 146 = 67.81% | **0** |
| 逐题翻转 | — | — | **0**（0 升 / 0 降） |

（holdout 报告里的 46.61% 是 118 题口径；本重放的 146 题是冻结考卷的全部题，含 repeat 题 —— 两者**同源**，对照在同一批题上做，Δ 才有意义。）

**0 掉分成立**（严格、宽松都没有降），但**也没有升**。

## 3 · 为什么 0 收益（诊断）

1. **锚定在 A2b 语料上很少触发**：T44 在 403 个（题, 渲染行）对上测过，锚定只命中 11 对（2.7%）——而且这 11 对**全部是已经渲染出来的行**。
2. **hit@5 是集合成员判定**：把已经在 top-5 的行提前，命中集合不变 ⇒ `hitStrict` 不变。
3. **top-5 之外的锚定候选本来就不存在**：walk 的候选来自 topic/link 遍历，锚定不是检索通路，只是排序键 ⇒ 没有"把外面的拉进来"的能力。（`tmp/t45-diag.mjs` 试图按候选池统计锚定行，但它读到的是 `publicHit` 之后的 hits —— 内部字段 `_anchorRank` 已被剥掉，所以那里的 `0/146` 是**观察口径问题**，不作为结论；真实触发率以 T44 的 11/403 渲染行为准。）
4. 146 题里只有 2 题顺序变化（`tokOverlap` 与 `_anchorRank` 的 tie 次序），没有一道题命中集变化。

## 4 · tombstone

- `anchorRanking: false`（或干脆不传 `anchorRankOf`）⇒ `_anchorRank` 不写入 ⇒ `compareHits` 全部按缺省 1 ⇒ **输出与改动前逐字节一致**（T45 ② `JSON.stringify(again) === JSON.stringify(base)`）。
- 锚定不命中（回调返回 false）⇒ 顺序与基线一致（T45 ② 第二条断言）。
- 锚定只改顺序、**不增删 hit**（T45 ② 断言命中集相等）。
- 既有 R11 「源码零 import」tombstone 仍然绿（本刀没有 import 任何模块）。

## 5 · 测试（`test/walk.test.mjs` T45 ①–②）

| # | 断言 |
|---|---|
| T45 ① | `compareHits`：`_anchorRank=0` 的行即使 `_tokOverlap` 更低也排前面；没有 `_anchorRank` ⇒ 回到原口径（tokOverlap 优先） |
| T45 ② | walk 集成：关掉锚定 ⇒ **JSON 全等**；锚定只改顺序、不增删 hit；锚定不命中 ⇒ 排序不变 |

## 6 · 验收

- 全量：`node --test "test/*.test.mjs"` —— **1211 tests / 1205 pass / 0 fail / 6 skipped**（exit 0）。
- `node scripts/check.mjs` PASS。
- A2b：`node tmp/t45-replay.mjs`（47.95% → 47.95%，0 翻转）。

## 7 · 复现

```bash
node --test --test-name-pattern "T45" test/walk.test.mjs
node tmp/t45-replay.mjs      # A2b 同一冻结考卷，锚定 开/关
node tmp/t45-diag.mjs        # 诊断：逐题比较开/关后的 hits 顺序（2/146 道有 tie 次序变化；内部字段不可从 publicHit 读）
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- A2b 严格：**47.95% → 47.95%（Δ 0）**；宽松 67.81% → 67.81%（Δ 0）；逐题翻转 **0**；
- 锚定在 A2b 的触发面很窄：渲染行里 **11/403（2.7%）**（T44 实测），且**全部已在 top-5 内**；
- tombstone：关掉 ⇒ **JSON 全等**（T45 ②）；
- 未接入生产：walk 只接受**调用方回调**，`src/plugin.mjs` 未传（本刀禁止改）⇒ 线上行为**零变化**。

## 8 · 建议（要抬 A2b 该动哪里）

1. **本刀不接入**：排序键保留（零成本、可关、tombstone 完备），但在 `plugin.mjs` 传入 `anchorRankOf` + `signalText` 之前，它对线上**没有任何影响**；即使接了，按本实测也 **0 收益**。
2. **真正有希望的是"候选生成"**：把「同 repo / 同错误签名 / 同任务链」当成**第 4 条检索通路**（现有三条：topic 匹配 / link 一跳 / claim 文本含信号词），把 top-5 之外的**同身份**条目直接拉进候选池，再用现有 `compareHits` 排序。这需要改 `walkFromSignals` 的候选构造，并做**回归对照**（T21 的教训：任何放宽/扩大候选都要证明 0 掉分）。
3. **别再用"重排"抬 A2b**：T21 与本刀两次实测都指向同一结论 —— A2b 的分母是**集合**，重排动不了它；要动就动**集合**（候选/limit/去重），而 T21 已证明"单纯放宽 limit"非正，所以必须是**有判别力的新增候选**（同身份锚定正好是这种）。
4. 若要做第 2 条：先在小样本上量「锚定候选的 strict 占比」（本刀 T44 的 11/403 ≈ 2.7% 是上界参考），并准备 tombstone（通路关掉 ⇒ 与现状逐字节一致）。

## 9 · 限制

1. **本刀是"零收益"结论**：不要把它当"抬了 A2b"的交付；它只证明了"重排这条路线在 A2b 上无效"，并把排序键与回调接口留在了 walk 里（可关、默认关）。
2. 重放脚本是 `runHoldout` 的**逐行复刻**（导出函数不可注入 `anchorRankOf`，`scripts/a2b-holdout.mjs` 不在本刀可写路径），所以数字以本脚本为准；与 holdout 报告 46.61% 的差异来自题集口径（146 vs 118），**同题对照的 Δ 才是结论**。
3. 锚定判据本身的能力沿用 T44：A2b 的 403 对里 P 0.909 / R 0.128 —— **窄**，这也是"加候选"路线要先扩召回的原因。
4. 未验证线上：`live-stats.jsonl` 不受影响（本刀零接入）。