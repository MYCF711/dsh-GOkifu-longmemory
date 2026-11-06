# T294 · 把子代理归并接进归档管线

> `[本] 2026-11-06` · **真库只读**（写只在 `tmp/mc-copy` 副本）· 未跑全量 `node --test`、未重启 DSH。
> 改动：`scripts/archive.mjs`（接线）· `scripts/subagent-merge.mjs`（导出 `appendMergedChild`，**不复制第二份实现**）· `test/archive.test.mjs`（+3）

## 0 · 一句话

**接上了：现在每次归档都会自动归并**——`scripts/archive.mjs` 的折叠步里对每个 `delegationDepth>0` 且父局同 scope 的子局调用 `appendMergedChild()`，真库实测一次归档 **`mergedChildren: 679`**（= 889 个被 fold 的子局里，带失败且能归并的那些）。不再需要单独跑 `scripts/subagent-merge.mjs`。

## 1 · 改哪个文件（先定位再动）

- **`scripts/archive.mjs`** —— 归档管线本体：`extractSignals` 在「3. 子代理归并」步（`depth>0 && parentId` ⇒ `state:"folded-into:…"`）之后接线；
- **`scripts/subagent-merge.mjs`** —— 只**新增导出** `appendMergedChild()`（T293 已有的 `planMerge` 复用同一份 `REPAIR_KIND`/`mergeKey`，没有第二份实现）；
- `src/**` 未动。

## 2 · 接线代码（archive.mjs）

```js
import { appendMergedChild } from './subagent-merge.mjs';   // T294：复用 T293 的实现

if (depth > 0 && parentId) {
  rec.state = `folded-into:${parentId}`;
  rec.foldedInto = parentId;
  rec.topics = [];
  folded += 1;
  const parentRec = built.find((x) => x.record.id === parentId)?.record ?? null;
  const childFailures = Number(rec.signals?.failures ?? 0);
  if (parentRec && childFailures > 0 && String(parentRec.scopeKey ?? '') === String(rec.scopeKey ?? '')) {
    if (appendMergedChild(parentRec, { child: rec.id, failures: childFailures, at: rec.recordedAt ?? rec.lastEventAt ?? 0 })) mergedChildren += 1;
  }
}
```

- **只增不改**：只往父局 `signals.mergedChildren` 追加，父局原有字段一个不动；
- **幂等**：`appendMergedChild` 按 `from + seq` 去重，重放返回 `false`；
- **A5 仍 0**：父子 `scopeKey` 不一致直接不并；
- **可审计/可回滚**：每条带 `{ kind:'subagent-merge', from, seq, failures, at }`；
- `at` 取 `rec.recordedAt`（**不是 `Date.now()`**），否则每次归档都产生假变更。

## 3 · 验收

```
$ node --test "test/archive.test.mjs"
✔ T294 appendMergedChild：只增不改 + 按 from+seq 幂等
✔ T294 appendMergedChild：父局非法对象 ⇒ 不抛、不写
✔ T294 归档管线：depth>0 + 父局同 scope ⇒ 自动归并（mergedChildren 进 stats）
ℹ tests 10   ℹ pass 10   ℹ fail 0
```

真库 dry-run（连跑两次，`episodes` 段逐字相同）：

```
第1次: {"total":1127,"archived":238,"folded":889,"mergedChildren":679,"skipped":1}
第2次: {"total":1127,"archived":238,"folded":889,"mergedChildren":679,"skipped":1}
```

副本上连跑两次归档：

```
副本第1次归档 episodes: {"total":1127,"archived":238,"folded":889,"mergedChildren":679,"skipped":1}
副本第2次归档 episodes: {"total":1127,"archived":238,"folded":889,"mergedChildren":679,"skipped":1}
```

## 4 · 幂等的边界（诚实报告）

- **归并记录本身幂等**：单测证明同一子局重放 `appendMergedChild` 返回 `false`、列表长度不变；
- **`episodes` 统计逐字相同**（两次 dry-run、两次副本归档都是 `1127/238/889/679/1`）；
- **整库字节级不完全一致**：`logs.events`（1,037,526 → 1,037,687）与 `graphs.deltaFrames`（146 → 168）每轮都在长 —— 那是**本机活跃会话还在写**（AGENTS §5 陷阱 15：活跃会话的归档不幂等，属预期），不是本次改动引入的；
- 因此"归档两次输出 diff"只对**已封存数据**成立；`mergedChildren` 的 payload 也会随活跃会话增减而变化（`n=72` 不变，内容随新子局更新）。

## 5 · 归并率

- 旧：只有独立脚本能归并（10.00% 口径）；
- 新：**每次归档自动归并**，真库一次归档 `mergedChildren = 679` / `folded = 889`（76.4% 的 folded 子局带失败并成功归并；其余 210 个 folded 子局**本身没有失败**）。
- 跨 scope / 无父局的子局**不归并**（A5 必须仍 0）。

## 6 · 补丁

`tmp/t294-redo.cjs`：给 `subagent-merge.mjs` 追加 `appendMergedChild`（缺则加）+ 给 `archive.mjs` 应用 4 处 anchor 编辑；幂等（检测到标记即 skip）、anchor 不匹配抛错。
