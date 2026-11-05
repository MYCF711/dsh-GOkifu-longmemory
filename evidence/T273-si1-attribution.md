# T273 · SI-1 的 66 条时间不一致：归因（只读）

> `[本] 2026-11-05 23:45 +08:00` · **只读真库**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 脚本：`scripts/si1-attribution.mjs`（只读）· 判据与 `scripts/semantic-check.mjs` 的 SI-1 完全一致（`|actual − declared| > tolerance`）
> 真库：claims 1578 · 检查引用 2686 · unverified 0 · 容差 1ms

## 0 · 一句话结论

**66 条里 57 条是 A 类（重指漏改），9 条是 B 类（本来就有），C 类 0 条。**
A 类的机制已坐实：`provenanceRepair.fixes[].from → to` **改了 seq，但 `occurredAt` 仍停在旧 seq 的事件时间**（且没记 `toOccurredAt`，与 SI-5 那 59 条同源）。
**不紧急**：66 条全部**可机械复现、可机械重放**（seq 本身都对，错的是 `occurredAt`），没有一条是"数据被写坏"。

## 1 · 差值分桶 × provenanceRepair 交叉表

```
$ node scripts/si1-attribution.mjs
T273 · SI-1 时间不一致归因 · 容差 1ms
claims 1578 · 检查引用 2686 · unverified 0 · **SI-1 失败 66**

| 差值桶 | 条数 | 带 provenanceRepair | 不带 |
|---|---|---|---|
| 1-5ms | 9 | 0 | 9 |
| 5-100ms | 18 | 18 | 0 |
| 100ms-1s | 10 | 10 | 0 |
| 1s-1min | 24 | 24 | 0 |
| >1min | 5 | 5 | 0 |
```

| 类 | 判据 | 条数 | 占比 |
|---|---|---|---|
| **A · 重指漏改** | 带 `provenanceRepair` 且 `fixes[].from ≠ to` | **57** | **86.36%** |
| **B · 本来就有** | 无 repair；`occurredAt` = 相邻事件（`seq+1` 的 `tool/call`）的时间 | **9** | **13.64%** |
| **C · 容差边界** | 无解释的毫秒噪声 | **0** | 0% |

> 注意：9 条虽然落在 1–5ms 桶，但**每条都能指到具体事件**（见 §3），不是随机舍入 ⇒ 归 **B** 不归 C。

## 2 · 逐条明细（前 20 条，全量在 `--json`）

| # | claimId | episode | seq | declared | actual | Δms | 桶 | repair |
|---|---|---|---|---|---|---|---|---|
| 1 | c-137e7002 | ep-4188510d | 878 | 2026-11-03T05:24:34.251Z | 2026-11-03T05:24:34.266Z | 15 | 5-100ms | 是 |
| 2 | c-1521d8e2 | ep-75e7347e | 167 | 2026-11-01T19:18:46.904Z | 2026-11-01T19:19:56.782Z | 69878 | >1min | 是 |
| 3 | c-18b28387 | ep-a09a4535 | 5567 | 2026-11-02T15:57:04.089Z | 2026-11-02T15:57:04.095Z | 6 | 5-100ms | 是 |
| 4 | c-1f1ce0f6 | ep-bde12afa | 1265 | 2026-11-04T15:23:01.059Z | 2026-11-04T15:23:01.553Z | 494 | 100ms-1s | 是 |
| 5 | c-1f1ce0f6 | ep-bde12afa | 3307 | 2026-11-04T17:49:42.091Z | 2026-11-04T17:49:42.341Z | 250 | 100ms-1s | 是 |
| 6 | c-26ab9c93 | ep-1286ce28 | 2954 | 2026-11-01T14:23:05.369Z | 2026-11-01T14:23:05.380Z | 11 | 5-100ms | 是 |
| 7 | c-26ab9c93 | ep-d70b7c2f | 2539 | 2026-11-01T13:55:31.431Z | 2026-11-01T13:55:31.459Z | 28 | 5-100ms | 是 |
| 8 | c-26ab9c93 | ep-d70b7c2f | 2773 | 2026-11-01T14:05:27.894Z | 2026-11-01T14:05:27.918Z | 24 | 5-100ms | 是 |
| 9 | c-26ab9c93 | ep-d70b7c2f | 6410 | 2026-11-01T19:21:30.751Z | 2026-11-01T19:21:30.759Z | 8 | 5-100ms | 是 |
| 10 | c-2e17ebe4 | ep-f0e51ab3 | 208 | 2026-11-04T13:49:52.097Z | 2026-11-04T13:59:50.066Z | 597969 | >1min | 是 |
| 11 | c-3011f83f | ep-8cc34e32 | 17583 | 2026-11-03T08:34:23.886Z | 2026-11-03T08:34:24.950Z | 1064 | 1s-1min | 是 |
| 12 | c-3011f83f | ep-8cc34e32 | 17618 | 2026-11-03T08:35:04.214Z | 2026-11-03T08:35:05.392Z | 1178 | 1s-1min | 是 |
| 13 | c-38000b74 | ep-bd0161a1 | 504 | 2026-11-03T06:55:08.926Z | 2026-11-03T06:55:22.698Z | 13772 | 1s-1min | 是 |
| 14 | c-38000b74 | ep-bd0161a1 | 547 | 2026-11-03T06:58:12.300Z | 2026-11-03T06:58:17.979Z | 5679 | 1s-1min | 是 |
| 15 | c-3bb3b546 | ep-32a78774 | 3252 | 2026-11-03T18:14:42.825Z | 2026-11-03T18:14:42.834Z | 9 | 5-100ms | 是 |
| 16 | c-41157b78 | ep-bd0161a1 | 324 | 2026-11-03T06:51:54.473Z | 2026-11-03T06:51:55.752Z | 1279 | 1s-1min | 是 |
| 17 | c-41157b78 | ep-bd0161a1 | 504 | 2026-11-03T06:55:08.926Z | 2026-11-03T06:55:22.698Z | 13772 | 1s-1min | 是 |
| 18 | c-41157b78 | ep-bd0161a1 | 547 | 2026-11-03T06:58:12.300Z | 2026-11-03T06:58:17.979Z | 5679 | 1s-1min | 是 |
| 19 | c-415e7002 | ep-226dbf4f | 8687 | 2026-11-03T19:17:38.756Z | 2026-11-03T19:17:56.292Z | 17536 | 1s-1min | 是 |
| 20 | c-4a7e6c4b | ep-8a73e06b | 45994 | 2026-11-03T23:49:54.802Z | 2026-11-04T18:10:32.713Z | 66037911 | >1min | 是 |

## 3 · 5 条逐字对照（quote 属于哪个事件？occurredAt 取的是谁的时间？）

```
c-137e7002 ep=ep-4188510d refSeq=878(tool/result) declared=1793683474251 → 该时间属于 seq 877(tool/call)
   repair fix: from=876 to=878 reason=quote-not-at-seq | Δ=15ms | 桶=5-100ms
c-1521d8e2 ep=ep-75e7347e refSeq=167(tool/result) declared=1793560726904 → 该时间属于 seq 160(tool/call)
   repair fix: from=159 to=167 reason=quote-not-at-seq | Δ=69878ms | 桶=>1min
c-18b28387 ep=ep-a09a4535 refSeq=5567(tool/result) declared=1793635024089 → 该时间属于 seq 5565(assistant/message),5566(tool/call)
   repair fix: from=5565 to=5567 reason=quote-not-at-seq | Δ=6ms | 桶=5-100ms
c-1f1ce0f6 ep=ep-bde12afa refSeq=1265(tool/result) declared=1793805781059 → 该时间属于 seq 1262(tool/call)
   repair fix: from=1261 to=1265 reason=quote-not-at-seq | Δ=494ms | 桶=100ms-1s
c-1f1ce0f6 ep=ep-bde12afa refSeq=3307(tool/result) declared=1793814582091 → 该时间属于 seq 3305(assistant/message)
   repair fix: from=3305 to=3307 reason=quote-not-at-seq | Δ=250ms | 桶=100ms-1s
```

**读法（5 条一致）**：
1. 每条 ref 的 **seq 都是对的**（引文就在该 `tool/result` 事件里，`by: head` 命中）；
2. `occurredAt` 指向的是**旧 seq**（`repair.fixes[].from`）的事件时间——`876`/`159`/`5565`/`1261`/`3305`；
3. `repair.fixes[].reason` 一律是 `quote-not-at-seq`，且**没有 `toOccurredAt`**（SI-5 那 59 条同源）。

⇒ **A 类坐实：重指只改了 seq，没把 `occurredAt` 跟着挪到新事件的时间。**

补充（B 类 9 条，全部同形）：

```
c-5175f1dc @ ep-5cf57bb4 seq=1731 Δ=-4ms | 声明时间的事件: seq 1732 (tool/call) | 该 seq 事件: assistant/message
c-5175f1dc @ ep-a09a4535 seq=255  Δ=-2ms | 声明时间的事件: seq 256 (tool/call) | 该 seq 事件: assistant/message
c-846f4d01 @ ep-62bcb7d2 seq=23613 Δ=-3ms | 声明时间的事件: seq 23614 (tool/call) | 该 seq 事件: assistant/message
c-b82a67ce @ ep-8cc34e32 seq=2886 Δ=-4ms | 声明时间的事件: seq 2887 (tool/call) | 该 seq 事件: assistant/message
c-c1af258c @ ep-3a3fb03c seq=223  Δ=-2ms | 声明时间的事件: seq 224 (tool/call) | 该 seq 事件: assistant/message
c-d1215aa0 @ ep-62bcb7d2 seq=23613 Δ=-3ms | 声明时间的事件: seq 23614 (tool/call) | 该 seq 事件: assistant/message
c-edfcf3ca @ ep-62bcb7d2 seq=23613 Δ=-3ms | 声明时间的事件: seq 23614 (tool/call) | 该 seq 事件: assistant/message
```
**9 条全部是**：ref 的 seq 是 `assistant/message`，`occurredAt` 取了 **seq+1 的 `tool/call`** 的时间（Δ = −2~−4ms）。没有 repair 记录 ⇒ **归档抽取时就取错了事件**（B 类），与 T238 的重指事故无关。

## 4 · 与 SI-5 的关系

- A 类 57 条全部**没有** `toOccurredAt`；SI-5 报的 59 条也是"缺 `toOccurredAt`"。
- 两者是**同一批修复的两面**：旧版 `repair-support-seq` 只写 `{from,to,reason,eventType}`，不写 `toOccurredAt`，也**没有回写 `support[].occurredAt`**。
- 所以：**SI-5 是"留痕不全"，SI-1 的 A 类是它的后果**（补上 `toOccurredAt` 并同步 `occurredAt` 就能一起消掉）。

## 5 · 要不要紧急处理

| 维度 | 结论 |
|---|---|
| 数据是否损坏 | **没有**：seq 全部正确，quote 都在对应事件里，只是 `occurredAt` 停在了旧事件 |
| 影响面 | 66 条 / 2686 条引用 = **2.46%**；其中 57 条是机械可重放 |
| 是否新产生 | **不是**：`repair.at = 1793875213639`（2026-11-05 18:40 左右那批修复），是那次修复的遗留 |
| 紧急度 | **不急**：没有一条会导致错误召回（召回按 seq/主题走，`occurredAt` 只影响排序与日期展示；日期层是另一条独立检查） |

**建议（未动手）**：
1. **A 类**：用修复版重放（读 `provenanceRepair.fixes[].to`，把 `support[].occurredAt` 改成 `to` 事件的时间，同时补 `toOccurredAt`）—— **一次脚本消掉 57 + 59 里的 57**；只增不改（写 `provenanceRepair` 追加一条）。
2. **B 类 9 条**：改**归档抽取**（`src/rooms/topic.mjs` 的 `add(...)` 用 `event.time` 而不是"下一条事件"的时间）—— 属于**下游修复**，不紧急；若要一次性对齐，可在同一重放里按 `seq` 回写。
3. **不要调容差**：9 条虽然只有 2–4ms，但都能解释到具体事件，调容差会把 A 类也一起放过（A 类里 15/6/8/9ms 的也在 5–100ms 桶）。

## 6 · 复现

```bash
node scripts/si1-attribution.mjs              # 66 条 + 分桶 + 交叉 + 5 条逐字对照
node scripts/si1-attribution.mjs --json       # 全量明细（含每条的事件类型与引文）
node scripts/si1-attribution.mjs --tolerance 0  # 看容差是否影响结论
```
