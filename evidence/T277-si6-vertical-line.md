# T277 · SI-6 偏移分布"竖线"检测

> `[本] 2026-11-06 01:00 +08:00` · 只读，未改库。
> 产物：`scripts/semantic-check.mjs`（新增 SI-6）、`test/semantic-check.test.mjs`、`tmp/t277-redo.cjs`

## 1 · 判据

`delta = support.occurredAt − events[support.seq].time`（对全部**可判定**引用）。

| 条件 | 判定 |
|---|---|
| 可判定引用 < 5 条 | 不判（样本不足） |
| 众数 delta 占比 ≥ **80%** 且 `|delta| > 1ms` | **`SI-6-systematic-offset`**（系统性取错），报常数 + 占比 + top3 分布 |
| 众数 delta 占比 ≥ 80% 但 `|delta| ≤ 1ms` | 正常（**delta≈0 的竖线 = 大家都取对了**） |
| 众数占比 < 80% | 正常（随机残差，不是系统性 bug） |

阈值写死在代码里：`MIN_SI6_N = 5`、`SHARE = 0.8`、`|delta| > 1ms`。

## 2 · 测试

```
$ node --test "test/semantic-check.test.mjs"
✔ T277 ①: delta 全 = +4ms ⇒ 红（系统性偏移，报常数与占比）
✔ T277 ②: delta 全 0 ⇒ 绿
✔ T277 ③: delta 随机分散 ⇒ 绿
✔ T277 ④: 1ms 噪声（全 = +1ms）不算系统性偏移（阈值 |delta| > 1ms）
（其余 10 条 T262/T272 用例全绿）
ℹ tests 14   ℹ pass 14   ℹ fail 0   ℹ duration_ms 93.20
```

## 3 · 真库全量复跑（`--all --tolerance 1`）

```
抽样 1578/1578 条 · 检查引用 2686 处 · 容差 1 ms
  pass 2620 · fail 125 · unverified 0
  ✗ SI-5-missing-toOccurredAt: 59
  ✗ SI-1-time-mismatch: 66
  SI-6 偏移分布：n=2686 · 众数 delta=0 ms · 占比 54.9%
    top [{"delta":0,"count":1475},{"delta":1,"count":1143},{"delta":3,"count":4}]
```

**没有竖线**：最大众数是 `delta = 0`（54.9%），第二是 `+1ms`（42.6%）——两者都在 1ms 容差内，且没有任何常数超过 80% 且 |delta|>1ms。
`+3ms` 只有 4 条，属个别噪声。

## 4 · 一句话

**真库现在没有系统性取错**（无竖线：众数 delta = 0 ms / 54.9%，次众数 +1 ms / 42.6%，均在 1ms 容差内；剩余 125 条是 SI-5 缺 `toOccurredAt` 59 条 + SI-1 零星偏差 66 条，属**分散残差**，不是系统性 bug）。
