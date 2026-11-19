# T380 · A4 测量本身不稳定：同代码在 42–80ms 之间摆动，发版被它反复拦住

> 2026-11-20 · 由「连续两次 release 被 A4 拦住」引出。

## 一、同一份代码的连续读数

| 时点 | A4 p50 | 来源 |
|---|---|---|
| T376 之后 | 43.34 / 49.53 / 52.14 / 53.72 / 56.98 / 57.44 | `metrics-guard` |
| T377 之后（未改 WeakMap 的实验代码） | 56.98 / 57.44 | 同上 |
| 回滚实验后 | 66.57 / 80.31 | 同上 |
| 同时段 `runPipeline` 直接测 9 次 | median **41.8–46.4**，max 74–101 | `tmp/measure3.mjs` |

**同一份代码，`metrics-guard` 的 p50 落在 43–80ms 之间；而同一时段的 9 次原始中位数只有 42–46ms。**
两者差得太多，说明 `metrics-guard` 那条链里还有别的开销被计进去了（不是纯粹的 walk+card）。

## 二、机器侧观察（这段时间确实有异常负载）

```
CPU 瞬时 LoadPercentage = 100%
SearchIndexer 累计 CPU 219975 秒（WS 462MB）   ← Windows Search 在扫
System 累计 760491 秒
```

`archive.mjs` 一次真跑会写上千个文件，**很可能触发了 Windows Search 的增量索引**，
在随后一段时间里占着 CPU —— 这就是 A4 在 42→80ms 之间乱跳的外部原因之一。

## 三、结论与下一步

1. **A4 不能作为"精确刻度"用**：它的噪声（±40ms）比我要优化的收益（几十 ms）还大；
2. 发版被它拦住时，**不调门槛**（门槛没错），但也别把它的具体读数当结论；
3. 真正要拿到稳定低延迟，仍然只有 **D6 的倒排索引**这一条路（把 O(topics×terms) 降下来，
   让真实值落到 25ms 以下，噪声就淹不掉它了）；
4. 本轮 `0.8.153`（只加测试）**因 A4 68.86/80.31 连续越线未发版**，代码已在 main。

## 四、复现

```bash
node scripts/metrics-guard.mjs                     # 门槛口径（p50）
node tmp/measure3.mjs                              # 3 批 × 9 次的 median/max
powershell -c "Get-Process | Sort-Object CPU -Desc | Select -First 6 Name,CPU,WS"
```
