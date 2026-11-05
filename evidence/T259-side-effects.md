# T259 · 消歧修复的副作用体检（865 处重指的落库前置闸）

> `[本] 2026-11-05 20:05 +08:00` · **真库只读**（本工具全程无写；`--apply` 一律 exit 1）。
> 产物：`scripts/repair-side-effects.mjs`、`test/repair-side-effects.test.mjs`、`tmp/t259-redo.cjs`
> 对照：真库 `<DSH_HOME>/memory-context` vs 消歧副本 `tmp/t257-copy`

## 0 · 守卫（先贴代码）

```js
// ⚠ T259 守卫：本工具**只读**，任何 --apply 一律拒绝；并且拒绝把"真库"当作副本
if (flags.apply) return { code: 1, stdout: '✗ 拒绝 --apply：repair-side-effects 是只读体检工具（写操作只在 tmp/ 副本，由 repair-support-seq 负责）' };
if (!copyRoot) return { code: 2, stdout: '缺少 --copy（消歧后的副本目录，例如 tmp/t257-copy）' };
if (path.resolve(copyRoot) === path.resolve(realRoot)) return { code: 1, stdout: `✗ 拒绝：--copy 与真库是同一个目录（${realRoot}）` };
```
测试 `T259 ④` 实证：`--apply` ⇒ 1；`--copy` 指向真库 ⇒ 1；缺 `--copy` ⇒ 2。

## 1 · 卡面副作用（逐卡对照，8 张卡）

```
逐卡对照（8 张卡）：
  行数：0 → 0（Δ +0）
  provenance 变化：0 条 (ep,seq)
  A5 跨作用域违规卡：0（必须 0）
  正文完全一致（归一后）：8/8
```
**局限（如实说）**：这 8 个信号取自"被重指的 claim 的正文"，在影库里渲染为空卡（0 行）⇒ 卡面维度**没有测出差异**，不能据此说"卡面绝对没变"。

## 2 · 日期一致性：**这是真副作用**

判据：`support[].occurredAt` 必须等于**重指后 seq 那个事件的 `time`**（容差 1s）。

**全量普查（副本里 949 条带 `provenanceRepair` 的 claim · 1418 处 fix）**：

```
checked 1418 · 一致 767 · 不一致 651 · 不可读 0
|Δ| 分布：≤1min 545 · ≤1h 79 · ≤1d 19 · >1d 8
最大 |Δ| = 255,379,213 ms（≈ 2.96 天）
跨本地日期：17 条
```

**基线对照（证明判据有效）**：未重指的 claim 抽 40 条，`occurredAt` 与 seq 事件时间 **40/40 全一致**（0 偏差）。
⇒ 651 条偏差**不是字段语义问题，而是重指时漏改 `occurredAt`**。

### 对 Lead 举的例子做更正

`c-00248579`（`ep-543cf0b2`）**不是违规**：

```
support[0].seq = 50334, occurredAt = 1793787707452
新 seq(50334) 事件 time = 1793787707468   Δ = +16 ms（同一天 2026-11-04）
旧 seq(50332) 事件 time = 1793787707451   Δ = +1 ms
```
50332 与 50334 是**同一毫秒级相邻的两条事件**（同一 tool/result 的重复广播），16ms 在容差内。

## 3 · 三个问题的答案

1. **影响面**：1418 处重指里 **651 处（45.9%）** 的 `occurredAt` 与新 `seq` 事件时间不一致；最大偏差 **255,379,213 ms ≈ 2.96 天**。
2. **严重度**：多数是秒/分钟级（545 条 ≤1min），但有 **19 条 ≤1 天**、**8 条 >1 天**，且 **17 条跨本地日期** —— 这 17 条卡上的**日期直接是错的**。
3. **修法**：**必须同步 `occurredAt` = 新事件的 `time`**（同意你的倾向）。
   判据：`occurredAt` 的字段语义就是"所指事件的发生时间"（`AGENTS.md` §2.3）；卡面渲染的是 `(ep, 日期, seq)` 三件套，三者必须自洽——只改 seq 不改日期 = 自相矛盾。
   同时在 `provenanceRepair` 里**同时记录** `fromOccurredAt` / `toOccurredAt`，这样回滚与审计都不需要再去读日志（成本 O(1) 而不是 O(读一局)）。

## 4 · 能不能落库

**不能。** 当前 865 处改动是"更准的指针 + 651 处更错的时间"。
**修脚本，不要回滚**：`repair-support-seq.mjs` 的 `applyPlan` 需要在改 `seq` 的同一处把 `occurredAt` 一并改成新事件 `time`，并在 `provenanceRepair` 里带上 `fromOccurredAt/toOccurredAt`；改完重跑 T257 的幂等 + 本体检的日期一致性（期望 mismatch = 0），再谈落库。

## 5 · 测试

```
$ node --test "test/repair-side-effects.test.mjs"
ℹ tests 4   ℹ pass 4   ℹ fail 0   ℹ duration_ms 93.36
```
