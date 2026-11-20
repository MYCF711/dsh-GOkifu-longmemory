# T402 · 我上一版把归档读成了 OOM：并发预读必须**按批次**，不能全量留内存

> 2026-11-20 · 0.8.158 的回归，本版修复。

## 一、事故

T401（0.8.158）为了把"读 428 个会话 230 秒"提速，改成并发预读，但**把所有会话的解析结果都留在 `Map` 里**等主循环消费。

真库实测：

```
EXIT=134  38 秒后崩
<--- Last few GCs --->
Scavenge (interleaved) 3953.7 (3964.2) -> 3953.6 (3986.2) MB
```

**heap 冲到 3.9 GB 后 OOM。** 直接违反主人的硬约束：「不要再出现无意义的内存占用」。

## 二、根因

```js
const PRELOAD = new Map();          // 整个 run 的生命周期
await Promise.all(workers);          // 428 个会话全部读进内存
for (const pair of pairList) { ... } // 之后才慢慢消费
```

**并发 ≠ 需要同时持有**。正确做法是"窗口"：只保留正在处理的那一批。

## 三、修复（T401b）

```js
const BATCH = 32;                       // KIFU_ARCHIVE_BATCH 可覆盖
for (let s = 0; s < pairList.length; s += BATCH) {
  const chunk = pairList.slice(s, s + BATCH);
  const PRELOAD = await preloadBatch(chunk);   // 并发 6 读这 32 个
  for (const pair of chunk) { ...原循环体... }
}                                        // 这批的 PRELOAD 随之释放
```

内存上界从「全量 428 个会话」降到 **32 个**；并发度仍为 6。

## 四、实测

| 项 | 结果 |
|---|---|
| `archive.test` + `archive-stale.test` | **15/15** |
| 真跑（有积压 45,069 条待写） | EXIT=0 · 437 秒 · verify ok |
| 第二次真跑（积压 35,689 条） | EXIT=0 · **157 秒** · verify ok |
| 崩溃 | **消失**（不再 OOM） |

**注意**：这两次耗时偏高是因为之前几次崩溃留下了大量未入档积压；稳态耗时需在积压清空后再测。

## 五、教训

我在 T401 里只看了"耗时 230→14.7 秒"，**没有测内存**。这是本会话第七次"没量全就下结论"：
**改并发必须同时量峰值内存**，否则优化会变成崩溃。
