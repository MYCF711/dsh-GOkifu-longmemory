# T260 · `applyPlan` 同步 `occurredAt`（"更准的指针 + 更错的时间"修复）

> `[本] 2026-11-05 20:10 +08:00` · 真库只读；`--apply` 只许 `tmp/` 副本（守卫保留）。
> 产物：`scripts/repair-support-seq.mjs`、`test/repair-support-seq.test.mjs`、`tmp/t260-redo.cjs`

## 1 · 改了什么

| 位置 | 改动 |
|---|---|
| `buildEventIndex` | 事件索引保留 `time`（原实现只留 `type/text/joined`） |
| `locateQuoteSeq` | 唯一命中 / 消歧后都返回 `toTime`（新事件的 `time`） |
| `planRepairs` | 行里带 `fromOccurredAt`（记录声明值）与 `toOccurredAt`（新事件时间） |
| **`planRepairs` 新增 `dateSync` 桶** | 已重指（`provenanceRepair` 存在）但 `occurredAt` 与新事件时间不一致的条目 |
| `applyPlan` | 重指 `seq` 的**同一处**同步 `occurredAt = 新事件 time`；`fixes[]` 记 `fromOccurredAt` / `toOccurredAt`；`dateSync` 行只改日期 |
| 守卫 | `--apply` 且 store 不在 `tmp/` 下 ⇒ **exit 1**（保留自 T257） |

判据：`occurredAt` 的语义是"所指事件的发生时间"（`AGENTS.md` §2.3）；卡面渲染 `(ep, 日期, seq)` 三件套必须自洽。

## 2 · 测试

```
$ node --test "test/repair-support-seq.test.mjs"
✔ T260 ①: 重指后 occurredAt = 新事件的 time（不是旧事件的时间）
✔ T260 ②: provenanceRepair.fixes[] 记 fromOccurredAt / toOccurredAt
✔ T260 ③: 幂等 —— 日期同步后再跑第二次 0 变更（dateSync 归零）
ℹ tests 12   ℹ pass 12   ℹ fail 0   ℹ duration_ms 229.61
```

## 3 · 未完成的验证（如实）

**副本重跑 T259 体检未完成**：`dateSync` 需要按 episode 载入日志，949 条带修复的 claim 横跨约 700 局 ⇒ 单次要 10 分钟以上（已加按 episode 缓存，仍受"I/O 逐局解压"限制）；本轮预算内没跑完，**所以 `mismatch = 0` 尚未实测**。

## 4 · 共享工作树被反复重置（阻塞项）

`scripts/repair-support-seq.mjs` / `test/repair-support-seq.test.mjs` 在本轮内被**三次**恢复成 HEAD（T238 基线）：
`18:39:16`、`19:01:24`、`19:56:17`。每次都要重放补丁，直接吃掉了本轮大半预算。

**应对**：`tmp/t260-redo.cjs` 是可重放补丁（幂等、anchor 不符退 3），任何一次重置后跑 `node tmp/t260-redo.cjs` 即可恢复。
但它目前**只覆盖 T256/T257/T260 的脚本改动**，测试文件的 T260 三例需要另外重放（本轮手动加的）。

## 5 · 一句话

**修法已落地并有测试证明（重指即同步日期、provenanceRepair 带 from/to、幂等），但"副本重跑体检 mismatch=0"这条尚未实测 —— 在它跑完之前，865 处仍不能算可落库。**
