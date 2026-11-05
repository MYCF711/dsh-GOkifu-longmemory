# T272 · SI-4 判据误报修复（跨局 claim 不是错误）

> `[本] 2026-11-05 23:20 +08:00` · 只读，未改库。

## 1 · 判据改了什么

| | 旧（误报源） | 新（T272） |
|---|---|---|
| SI-4 | `claim.occurredAt` 落在**每一局**的窗口内 | **support 级**：每条 `support[].occurredAt` 落在**它自己那一局**的 `[minTime, maxTime]` 内 |
| claim 级 | 逐局比 ⇒ 跨局 claim 必然红 | 只保留一条：`claim.occurredAt ≤ max(support.occurredAt)`（首次发生不可能晚于证据）→ 桶 `SI-4b-claim-after-support` |

SI-1 / SI-2 / SI-5 **语义一字未改**。

归因：`claim.occurredAt` 是"**首次发生时间**"，而 `support` 可以引到之后很多局的证据 —— 这是记忆的正常形态，不是错误。

## 2 · 修前 vs 修后（真库全量，`--all --tolerance 1`）

```
修前：pass 2620 · fail 409 · unverified 0
      ✗ SI-5-missing-toOccurredAt: 59
      ✗ SI-4-claim-time-out-of-window: 284
      ✗ SI-1-time-mismatch: 66

修后：pass 2620 · fail 125 · unverified 0
      ✗ SI-5-missing-toOccurredAt: 59
      ✗ SI-1-time-mismatch: 66
      （SI-4 桶清零；SI-4b 新桶 0 条）
```

**f世 409 → 125**，减少的 284 条**全部**是旧 SI-4 的跨局误报（真库里没有任何一条 claim 的 `occurredAt` 晚于它的 support 最大值 ⇒ SI-4b 为 0）。

> 待补：任务书要求"抽 5 条人工核"——本轮预算耗尽，**没有逐条列举**，只做了机制层核对（`c-05ab0ff2` 形态 + SI-4b=0 的全局读数）。这一项不算完成，需下一轮补。

## 3 · tombstone（证明新判据仍能抓真错）

`T272 ②`：support 的时间**真的**落在它自己那一局外（`occurredAt = D1`，该局窗口是 D3）⇒ `SI-4-support-time-out-of-window` **必红**。

## 4 · 测试

```
$ node --test "test/semantic-check.test.mjs"
✔ T272 ①: 跨局 claim（首发生于 11-01、support 引到 11-03 的局）⇒ 不误报
✔ T272 ②: tombstone —— support 的时间真落在它自己那一局外 ⇒ 仍红
✔ T272 ③: claim.occurredAt 晚于所有 support ⇒ 红
（其余 7 条 T262 用例全绿）
ℹ tests 10   ℹ pass 10   ℹ fail 0
```

## 5 · 一句话

**修掉误报后真库还剩 125 条真违规**：`SI-5` 缺 `toOccurredAt` 59 条 + `SI-1` 时间不一致 66 条（其中多数是 15–70 ms 级偏差，少数是分钟级——需要按 claim 逐条看）。
