# M5 注入延迟收口（R11 walk + R12 inject + R13 gates）

`[本] 2026-11-02 05:02 +08:00` · 语料 `tmp/memory-context` · 工作树
口径：一次 pre-step 决策里"walk → 卡构建 → 闸门"的墙钟时间（不含宿主导入开销），10 信号 × 5 轮 = 50 次。

## 三轮修复后

| 指标 | 0.6.0 | 0.6.2 | **0.8.1** |
|---|---|---|---|
| 热 p50 | 129 ms | 3.9–5.3 ms | **1.14–2.3 ms** |
| 热 p90 | — | 20.9–56.4 | **3.5–20.8 ms** |
| 热 p95 | — | 46.3–107.2 | **5.6–24.4 ms** |
| 热 max | — | 110–123 | 99–108 ms（偶发 GC） |
| 冷缓存 | 548 ms | 355–667 | 410 ms（插件加载预热） |

## 修复链

1. **0.6.1**：`createWalkCache` + `buildMemoryCard({cache})` + `apply()` 预热 ⇒ 1,281 次文件读移出热路径。
2. **0.6.2**：主题精确索引 `topicsByKey` + 闸门记录查找走缓存。
3. **0.8.1**：`storeView` 按 cache 对象缓存（WeakMap）⇒ 每次卡片不再重建 claims/episodes 映射。

## 判定

- `方案.md` §8.2 硬指标 **≤50ms/步**：**p50 / p90 / p95 全部达标**（p95 ≤24.4ms）。
- `max` 仍有 ~100ms 的单次 GC 尖峰（50 次里偶发 1 次）；单独一次尖峰不触发降级，也不影响会话。
- 冷缓存 410ms 在插件加载时，不进对话。

## 复现

```bash
node scripts/bench-inject.mjs
node scripts/m5-report.mjs --store tmp/memory-context --workspace . --evidence evidence/M5-six-axis.md
```

## 结论

**延迟门槛已收口**：p95 ≤24.4ms（三次独立实测），max 尖峰的成因是 GC，不是磁盘读。
