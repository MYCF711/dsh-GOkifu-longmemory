# T378 · 把 `matchTopics` 从「主题 × term」改成倒排：设计、代价与为什么先不动手

> 2026-11-20 · A4 结构性优化的前置分析。**这一刀没有实施**，因为它有召回语义风险。

## 一、现状（profile 实测）

`matchTopics` 对**全表主题**逐个试 signal 的每个 term/entity：

```
for (topic of topics(6000+))       // 全表
  for (term of sig.terms(数十))
    if (termLower === topicKey) consider(1)
    else if (overlaps(term, topicKey)) consider(0.6)
```

复杂度 `O(topics × terms)`。profile 里 `overlaps` 是第一大 self 成本（204ms 量级），
A4 p50 稳定在 **42–46ms**（门槛 50ms，偶发越线）。

## 二、已做的纯正向优化（都已发版）

| 改动 | 效果 |
|---|---|
| `minComparableLength` 正则 → charCode | 去掉每次调用的正则 |
| 三个内联正则提成模块常量 | 复用编译结果 |
| `split` 结果按字符串缓存 | 同一 key 不重复切词 |
| 内层 `toLowerCase` 提到循环外 | 少几十万次转换 |

**A2b 46.6%/79.7% 逐项未变** —— 说明这些都不碰语义。

**试过并回滚的**：`overlaps` 记忆化（自己成了第一大开销 248ms）、topic 小写键 WeakMap（无收益）。
教训：在「主题数 × term 数」这个量级下，任何"每次调用都要算一遍键"的缓存策略都是负收益。

## 三、倒排方案（真正能到 ≤25ms 的路）

在 `createWalkCache` 里与 cache 同生命周期地建三张表：

| 表 | 内容 | 覆盖的匹配形态 |
|---|---|---|
| `byExactKey` | `key → topic[]`（**已存在**：`topicsByKey`） | 完全相等（score 1） |
| `bySegment` | `段 → topic[]`（key 按非字母数字切段） | ASCII 短标识符整段命中（T394 规则） |
| `byGram` | CJK 2-gram → `topic[]` | 中文子串（`记忆` ⊂ `记忆系统`） |

匹配时只遍历 `sig.terms/entities`，各查三张表取候选，**不再扫全表**。
复杂度降到 `O(terms × 候选数)`。

## 四、为什么先不动手（**这是关键**）

`overlaps` 当前做的是**双向子串**判定（`x.includes(y) || y.includes(x)`），
而倒排只能覆盖「完全相等 / 整段 / 2-gram 包含」这三类。**长 ASCII 子串**（如 `scanPrivacy` 里的 `scan`）
和 **1 字 CJK**（如 `库` ⊂ `数据库`）不在其中 ⇒ **会改变召回结果**。

改召回 = 改产品行为，不是"纯正向优化"。按规矩这属于**有代价的优化**，
必须由主人裁定（或者先做成双跑对照、证明 A2b 一字不动才允许切换）。

## 五、给主人的决策项（D6）

| 选项 | 得到 | 代价 |
|---|---|---|
| **① 不做**（默认） | A4 维持 42–46ms，偶发越线 | 性能不达最优 |
| **② 严格等价倒排** | 只优化到能覆盖的三类，其余仍走 `overlaps` | 收益有限（长 ASCII/单字 CJK 仍扫全表） |
| **③ 双跑对照 → 证明等价后切换** | 可能拿到 ≤25ms | 需要额外一轮"新旧结果逐条比对"的开发与验证 |
| **④ 改判据**（放宽 `overlaps` 语义） | 最快 | **改变召回**，A2b 会动，等于改产品 |

**我的建议：③**，理由是它既能拿到性能，又把"是否改变召回"变成**可机械验证**的问题
（新旧实现在同一批 signal 上逐条比对，差异为 0 才切换）。

## 六、复现

```bash
node --cpu-prof --cpu-prof-dir=tmp/prof tmp/prof/a4.mjs   # 热点
node tmp/measure3.mjs                                      # 3 批中位数与最大值
```
