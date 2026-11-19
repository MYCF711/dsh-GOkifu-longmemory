# T381 · `matchTopics` 候选剪枝：**349 条真实信号 × 13212 主题，结果差异 0**

> 2026-11-20 · A4 的结构性优化（第一大 self 成本是 `overlaps`，它被「主题数 × term 数」调用）。

## 一、做了什么（三层，全部是"超集剪枝"，判定仍走原 `overlaps`）

| 改动 | 说明 |
|---|---|
| ① 接上已有精确键索引 | `walk` 一直没给 `matchTopics` 传 `index`（它早就支持）。索引键 = `topicsByKey`，与主循环的 `termLower === topicKey` 完全一致 ⇒ 纯等价 |
| ② 建 2-gram 倒排 + 长度分桶 | 与 cache 同生命周期，不随查询变 |
| ③ 主循环只遍历候选 | `overlaps(a,b)` 真只可能是 ① `a ⊂ b`（则 b 必含 a 的每个 2-gram）或 ② `b ⊂ a`（则 b 的长度 ≤ a） |

**关键纪律**：剪枝只负责"给超集"，**判定仍然是原来的 `overlaps`** ⇒ 语义不可能变。

## 二、等价性验证（两道）

**① 构造用例**（`test/t381-prune-equivalence.test.mjs`）：CJK 子串、ASCII 子串、短标识符整段、停用词边界，逐条比对剪枝 vs 全表 —— 一致。

**② 真实语料差分**（`tmp/diff-prune.mjs`）：holdout 里的真实文本 + 典型报错句，共 **349 条信号 × 13212 主题**：

```
{ "signals": 349, "topics": 13212, "diff": 0 }
```

**差异为 0** —— 一条都没漏、没错。

## 三、实测

| 指标 | 改前 | 改后 |
|---|---|---|
| `runPipeline` 9 次 median（3 轮） | 46.4 / 41.8 / 42.8 ms | **57 / 43.4 / 40.9 ms** |
| 最小值 | 37.3–40.3 ms | **33.2–37.6 ms** |
| A2b | 46.6% / 79.7% | **46.6% / 79.7%（逐项未变）** |
| 全量测试 | 1307/1301 | **1308/1302 / 0 失败** |

**诚实评价：收益有限**（中位数在噪声内，最小值降了约 4ms）。
说明 `matchTopics` 已不是第一大瓶颈 —— profile 里剩下的成本在 **`readKindBundle`（165ms）、GC（158ms）、`walkFromSignals`（121ms）**。

## 四、下一步

1. `walkFromSignals` 内部的图遍历（29293 条 links）—— 相邻表已在 cache 里（T371），要查的是它是否每轮都重排/重建；
2. GC 158ms：链上产生了大量临时对象（每轮都建 card/walk 结果），可查是否有可复用的中间结构；
3. **A4 的机器噪声（42–85ms）仍大于这些收益** ⇒ 判断只能靠"最小值/中位数趋势 + 差分等价"，不能靠单次门槛读数。

## 五、复现

```bash
node tmp/diff-prune.mjs     # 349 条真实信号差分（期望 diff: 0）
node tmp/measure3.mjs       # 3 批 × 9 次的 median/min/max
node --test test/t381-prune-equivalence.test.mjs
```
