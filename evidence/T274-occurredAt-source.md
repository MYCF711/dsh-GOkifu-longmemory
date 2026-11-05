# T274 · 归档抽取的取时 bug：`occurredAt` 取成了 `seq+1` 的时间

> `[本] 2026-11-06` · **只读真库**（修的是未来抽取，不动历史数据）· 未跑全量 `node --test`、未重启 DSH。
> 改动：`src/rooms/extract.mjs` · `test/extract.test.mjs`（+4 条）· 补丁 `tmp/t274-redo.cjs`

## 0 · 一句话

**根因是 `src/rooms/extract.mjs` 的失败 entry 里写死 `occurredAt: Number.isFinite(edge.ts) ? edge.ts : null`** ——
`edge.ts` 由上游写边时给出，实测**等于 `seq+1`（tool/call）那一格的时间**；于是 support 的"出处"（seq → assistant/message）
与"发生时间"（seq+1）不属于同一个事件，违反知识库 57 的 L3 语义不变量。**改完后新抽取不会再取错**（取该事件自己的 `time`；
没有就向前找并标 `timeSource='previous-event'`；前后都没有 ⇒ null，绝不借）。

## 1 · 定位（哪一行）

```js
// 改前（src/rooms/extract.mjs · 失败/成功 entry）
occurredAt: Number.isFinite(edge.ts) ? edge.ts : null,
```

真库重放（`ep-5cf57bb4` + `ep-62bcb7d2`，123 条 failure 边）：

```
受影响 123 条 | 旧 ts 恰等于 seq+1 时间：123 条 | 新逻辑取对：123 条
```

样例（`ep-5cf57bb4`）：

```json
{"seq":1731,"oldTs":1793627531298,"ownTime":1793627531297,"newAt":1793627531297,"src":"event","oldWasNext":true}
{"seq":592, "oldTs":1793627531299,"ownTime":1793627531298,"newAt":1793627531298,"src":"event","oldWasNext":true}
{"seq":852, "oldTs":1793628696543,"ownTime":1793628696542,"newAt":1793628696542,"src":"event","oldWasNext":true}
{"seq":1015,"oldTs":1793629224925,"ownTime":1793629224924,"newAt":1793629224924,"src":"event","oldWasNext":true}
```

**123/123 的旧 `ts` 都恰好等于 `seq+1` 的时间** —— 不是巧合，是上游按"下一格"写 ts。

## 2 · 修法

```js
const timeBySeq = new Map();                     // 事件 seq → 它自己的 time
const occurredAtOf = (s, edge = null) => {
  const own = timeBySeq.get(Number(s));
  if (own !== undefined) return { occurredAt: own, timeSource: 'event' };
  const prev = timeBySeq.get(Number(s) - 1);     // 兜底只许**向前**找
  if (prev !== undefined) return { occurredAt: prev, timeSource: 'previous-event' };
  if (list.length === 0 && Number.isFinite(edge?.ts)) return { occurredAt: Number(edge.ts), timeSource: 'edge-ts' };
  return { occurredAt: null, timeSource: null };  // 缺时间 = 假记忆，不许编
};
// entry：
...occurredAtOf(seq, edge),
```

- 有事件时**永远不用 `edge.ts`**（它是 seq+1 的时间）；
- 完全离线（只给棋谱的考古路径，`list.length === 0`）才退到 `edge.ts`，并标 `timeSource: 'edge-ts'`（来源可疑，可审计）；
- 每条 entry 现在都带 `timeSource`（`event` / `previous-event` / `edge-ts` / `null`）。

## 3 · 验收

```
$ node --test "test/extract.test.mjs"
✔ T274 occurredAt：assistant/message 无 time、下一条 tool/call 有 time ⇒ 不许取下一条的
✔ T274 occurredAt：该事件自己有 time ⇒ 取自己的（不是 edge.ts）
✔ T274 occurredAt：兜底向前找时必须标 timeSource="previous-event"
✔ T274 occurredAt：前后都没有 time ⇒ null（缺时间 = 假记忆，不许编）
ℹ tests 29   ℹ pass 27   ℹ fail 0   ℹ skipped 2
```

行为自检：

```
① 无time+下一条有time: {"occurredAt":null,"timeSource":null}
② 自己有time:          {"occurredAt":111,"timeSource":"event"}
③ 向前兜底:            {"occurredAt":555,"timeSource":"previous-event"}
```

## 4 · 存量那 9 条要不要单独处理

**建议单独一刀，别混进本刀**：

- 它们的 `occurredAt` 是**旧代码**写进 sidecar 的，本刀只影响**未来**抽取（重放归档不会自动改写既有 claim）；
- 处置方式与 T233/T238 那类"重指"不同：**不改 `seq`、不改 `quote`，只修 `occurredAt` 一个字段**（+ 标 `timeSource: 'event'` / `'previous-event'`）；
- 因为 `occurredAt` 参与"新旧排序"（AGENTS §2.3），修它要**先 dry-run 出 diff**（每条 `旧值 → 新值`），再一次性 `--apply` 到 `tmp/` 副本验证；
- 判据：修完后 `occurredAt` 必须与该 support 的 `seq` 事件时间**逐条相等**（或 `previous-event` 且相邻），否则不写。

## 5 · 补丁

`tmp/t274-redo.cjs`（2 处 anchor 断言 + 幂等）：`--check` / 重放均 `skip：T274 已应用`；anchor 不是恰好 1 处 ⇒ 抛错、不写半套。
