# M7 · 类级错误成卷（棋书主卷，2026-11-02）

## 问题
卷（thread）按「判别性主题」聚合，阈值是 `df ≥ 2` 且 `df ≤ max(2, ⌈10%N⌉)`。
类级错误主题（`class:*`）天然横跨很多局（fs 读改写 df=8），**恰恰被上界挡掉**——最该成册的那一类永远不成卷。

## 改动
`thread.mjs` 的 eligible：`class:*`（及 `t:error:*` 类主题）只要求 `df ≥ minKifus`，不套 10% 上界。
其余主题口径不变（仍走 `linkEligible`）。

## 实测（本机 116 局）
| 指标 | 改前 | 改后 |
|---|---|---|
| 卷数 | 127 | **138** |
| 类级主卷 | 0 | **4**（fs 读改写 7 局 / web-search-empty 4 / policy-human-turn 1 / …） |

卷是**视图**：一局可属多卷、删卷不删谱，所以放大主卷不影响 A1/A2/A5。

## 复算
`node scripts/archive.mjs` → 看 `threads/` 里 `title` 以 `class:` 开头的卷。
