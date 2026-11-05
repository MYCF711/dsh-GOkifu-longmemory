# T262 · 语义不变量校验（SI）—— 把事故教训变成机器闸

> `[本] 2026-11-05 21:00 +08:00` · **只读**：`scripts/semantic-check.mjs` 里没有任何 `writeManifest` / `store.put` / `--apply`（`grep -c "writeManifest|store.put|\.put("` = **0**）。

## 1 · 四条不变量

| 编号 | 判据 |
|---|---|
| SI-1 | `support[].occurredAt == events[support.seq].time`（容差 `--tolerance`，默认 0） |
| SI-2 | `support.seq ∈ [minSeq, maxSeq]`（该局事件窗） |
| SI-4 | `claim.occurredAt ∈ [minTime, maxTime]`（该局时间窗） |
| SI-5 | `provenanceRepair.fixes[].toOccurredAt == support[].occurredAt`（防"改了日期没记"） |

三态：`pass` / `fail` / `unverified`（读不到日志的局**单列**，不判绿也不判红，但退出码非 0 —— fail-closed）。

## 2 · 测试

```
$ node --test "test/semantic-check.test.mjs"
✔ T262 ②: SI-1 一致 ⇒ pass
✔ T262 ①: SI-1 不一致 ⇒ fail（按类型分桶）
✔ T262 ⑤: tombstone —— 把 seq 改 +4 而不改 occurredAt ⇒ 必须红
✔ T262 ③: SI-5 缺 toOccurredAt ⇒ fail
✔ T262 ④: 读不到局 ⇒ unverified 单列
✔ T262: SI-2 序号越窗 / SI-4 时间越窗 / episodeWindow
✔ T262: 只读闸 —— --apply 一律拒绝
ℹ tests 7   ℹ pass 7   ℹ fail 0
```

## 3 · 真库实跑（当前状态）

```
$ node scripts/semantic-check.mjs --sample 30
抽样 30/1570 条 · 检查引用 38 处 · 容差 0 ms
  pass 21 · fail 19 · unverified 0
  ✗ SI-1-time-mismatch: 17
  ✗ SI-5-missing-toOccurredAt: 1
  ✗ SI-4-claim-time-out-of-window: 1
结论：fail（含 unverified）

$ node scripts/semantic-check.mjs --sample 30 --tolerance 1
  pass 38 · fail 2 · unverified 0
  ✗ SI-5-missing-toOccurredAt: 1
  ✗ SI-4-claim-time-out-of-window: 1
结论：fail（含 unverified）   exit=1
```

**解读**：默认容差 0 时那 17 条 SI-1 全是 **±1 ms**（`occurredAt` 与事件 `time` 的毫秒级舍入，基线里本来就有）；容差放宽到 1 ms 后 SI-1 归零，剩下两条真问题：
- `c-00a2178a` 的 `.fixes[]` 缺 `toOccurredAt`（旧版 repair 写的，SI-5 抓住）；
- `c-0402805c` 的 `claim.occurredAt` 落在该局时间窗外（SI-4 抓住）。

## 4 · 它能不能在下次同类事故立刻红

能。tombstone 用例就是把 `seq` 改 +4 而不改 `occurredAt`：原状绿、改后**必红**（`T262 ⑤`）。这类逻辑损坏 `verify` 永远抓不到（checksum 只保证文件没坏），SI 闸専门抓它。

## 5 · 建议

日常用法：`node scripts/semantic-check.mjs --sample 30 --tolerance 1`（±1 ms 属噪声）；全量 `--all` 会更慢但可用。
