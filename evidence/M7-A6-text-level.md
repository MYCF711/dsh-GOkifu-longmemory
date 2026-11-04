# M7 · A6 文字级可核：修复前后的同一把尺子（2026-11-04）

> 背景：`reports/audit-11.md` 指出「可回溯 100%」是**弱判据**（只证 ep 存在 + seq 在闭包内），
> 而卡上的文字可能来自另一局、坐标却挂在本局。本档把两件事分开量：
> **修复前**的线上留样（宿主仍跑旧代码）与**修复后**的离线重抽（当前代码现造卡），用**同一判据**比对。

## 1 · 判据（`scripts/audit-card-samples.mjs` 的 `auditRows`）

每条卡片行 `- [marker] 正文 (ep-xxxxxxxx, 日期, seq N)`：

1. 正文剥掉模板前缀（`[跨项目] `、`class:<token> · `）与截断尾 `…`，`singleLine` 归一空白；
2. 逐帧解该 episode 的会话日志（`readFrames` + `parseEvents`，按 ep 缓存），把事件里的每个字符串同样归一，
   用 `includes` 找命中：
   - `at-seq`：命中且与所引 `seq` 的距离 ≤ **window（默认 ±10）**；
   - `elsewhere`：只在该局别处命中（带最近 seq 与距离）；
   - `missing`：该局完全没有这段文字。
3. 日期层独立：取 `seq` 处事件（缺则最近），按 `formatCardDate`（UTC）与卡片日期比。

**window 为什么是 10**：实测「调用步 → 工具结果」的 seq 间隔直方为 `0×9, 2×9, 3×2, 4×30, 5×11, 6×6, 8/9/10 各 1`，
默认 ±3 会把一大批真引用判成 `elsewhere`（同一批样本 ±3 只有 20 条 at-seq，±10 有 70 条）。

退出码：`missing > 0 || 日期不一致 > 0` ⇒ 1；`--no-text` 退回弱判据（对照用）。

## 2 · 修复前 vs 修复后（同一判据）

| | 修复前（线上留样，宿主仍跑 0.117.0） | 修复后（离线重抽，0.118.0 代码） |
|---|---|---|
| 命令 | `node scripts/audit-card-samples.mjs` | `node scripts/a6-text-level.mjs` |
| 样本 | 27 张卡 / **122** 条引用 | 11 张卡 / **43** 条引用 |
| `at-seq` | 70（57.4%） | **41（95.3%）** |
| `elsewhere` | 38 | **2** |
| `missing` | **14** | **0** |
| 日期一致 | **31/122（25.4%）** | **43/43（100%）** |
| 跨作用域 | 2（都在补闸前） | 0 |
| 判定 | FAIL | **PASS** |

- 「修复前」的数**不是回归**：那是 07:44 启动的宿主（加载 0.117.0）在 0.118.0 的修落地之前产出的卡。
- 「修复后」是**离线重抽**：`a6-text-level.mjs` 用与注入同一条链（`scripts/m5-report.mjs` 的 `runPipeline`）
  为当前库现造卡片，再套同一判据 —— 所以它证明的是"现在这份代码会产出什么卡"，不依赖宿主重启。
- 剩下的 2 条 `elsewhere` 属**抽取层**现象（quote 由「命令 stderr + 退出码」拼成、或抽取时被截断），
  与"坐标挂错局"是两回事，记为已知限制而非通过。

## 3 · 修在哪

`src/rooms/inject.mjs` 的 `entryFromClaim`：

- 文字：`text ← src.quote`（该 `seq` 的原文；`class:<token>` 作为机械标签保留成前缀）；
- 日期：`occurredAt ← src.occurredAt`（所引那条事件的时刻），不再优先 `claim.occurredAt`；
- 旧夹具/旧数据缺 `quote` 时才退回 `claim.text` —— 那不是允许脱钩，而是让审计能把它抓成可见失败。

## 4 · 复现

```bash
node scripts/audit-card-samples.mjs            # 线上留样（宿主重启后才是新代码产出的卡）
node scripts/audit-card-samples.mjs --no-text  # 旧弱判据，对照用
node scripts/a6-text-level.mjs                 # 离线重抽：当前代码 + 当前库
node scripts/a6-text-level.mjs --json          # 逐条 verdict / nearestSeq / distance / dateVerdict
```

## 5 · 遗留

- 文字级读数目前是**离线口径**；线上口径要等宿主下次重启后 `card-samples.jsonl` 换上新卡。
- `validate`-类现象的根治（quote 拼接/截断）属抽取层，另开一刀，不在本档。
