# T371 · walk 的两张索引：A4 p50 38.8ms → **15.6ms**

> 2026-11-09 · 接 T370 的拆账（`walk 31.1ms / card 0.9ms / gates 0.1ms`）—— 这一刀把 94% 那块砍掉。

## 一、病灶：**每次都重建只随库变的结构**

```js
for (const match of picked) {
  const holders = new Set(topicEpisodes.get(match.topic.id) ?? []);
  for (const episode of episodes) {            // ← 1908 局 × 每次命中主题
    if (episode.topics.some((t) => t.id === match.topic.id)) holders.add(episode.id);
  }
  …
}

const adjacency = new Map();
for (const link of links) { … }                // ← 每次遍历 14320 条 link
for (const list of adjacency.values()) list.sort(compareHops);   // ← 再全量排序
```

这两个结构**只随库变、不随查询变**，而 cache 本来就已经按库签名重建（T55/T61）——
放在 cache 里建一次，每次 walk 直接用。

## 二、改法

在 `createWalkCache()` 里预建两张索引：

| 索引 | 内容 | 等价性 |
|---|---|---|
| `holdersByTopic` | 主题 → 持有它的棋谱 id（**并上** `episode.topics` 与 `topic.episodes` 两路） | 与旧代码的 `new Set(topicEpisodes…) ∪ 扫 episodes` 同一并集 |
| `adjacency` + `linksWithoutWhy` | 棋谱邻接表（已排序）+ 无 why 边的计数 | 与旧代码同一建表规则；`dropped.hopNoWhy` 照旧加上 |

`fresh`（"这条边的 why 是否带来新主题"）**依赖本次命中主题**，所以留在 walk 里现算：
`hopsOf(from)` 取预建表 → 算 `fresh` → 按 `compareHops` 重排。排序规则没动，结果逐位一致。

**没有 cache 的调用路径（部分单测）仍然走旧代码** —— 行为不变，只是慢。

## 三、读数（真库 1908 局 / 14320 link）

| 阶段 | 改前 | 改后 |
|---|---|---|
| walk | 31.1 ms | **12.4 ms** |
| card | 0.9 ms | 0.6 ms |
| gates | 0.1 ms | 0.1 ms |
| **合计** | **33.1 ms** | **13.2 ms** |

A4 p50（`metrics-guard` 三次）：**38.76 → 15.59 / 15.76 / 16.78 ms**（门槛 50ms，现在只用掉 31%）。

建 cache 从 ~180ms 变成 **185ms**（预建索引的增量在噪声内，且它本来就被排除在 A4 的计时之外）。

## 四、等价性怎么保证

```
node --test test/walk.test.mjs     → 41/41
node --test "test/*.test.mjs"      → 1292 条 / 1286 pass / 0 fail / 6 skip
node scripts/metrics-guard.mjs     → PASS
  A2b 严格 46.6% · 覆盖 79.7%（与改前**完全一致**）      ← 走图结果没变
  A5 0 · A6 1 · A1 0
```

**A2b 一位没动**是这次最关键的证据：链路一样快慢无所谓，**检索结果必须一样**。

## 五、还剩什么

A4 现在 15.6ms，其中 walk 12.4ms。剩下的成本是 `matchTopics`（5009 个主题的模糊匹配）与命中排序。
要继续降得给主题匹配建倒排/前缀索引 —— 但当下的余量（31% 门槛）已经不紧急了。
