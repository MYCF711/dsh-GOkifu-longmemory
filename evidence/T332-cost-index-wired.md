# T332 · costIndex 接线（预计算 sidecar → 插件 → buildMemoryCard）

## 1 · 改哪里（先说清）
| 文件 | 改什么 |
|---|---|
| `scripts/antipattern-cost.mjs` | 新增 `--write-index [--index <path>]`：把现算的 `cost` 落成 `{version, generatedAt, source, count, costs:{claimId:cost}}`；**守卫**：目标必须在 `tmp/` 或 `<store>/corpus/` 下，否则拒绝写 |
| `src/plugin.mjs` | `decidePreStep` 里读 `<storeRoot>/corpus/antipattern-cost.json`（**只读、失败静默 ⇒ `costIndex = null` ⇒ 不过滤**），并传给 `buildMemoryCard({ costIndex })` |
| `src/rooms/inject.mjs` | （T331 已实现的门）把 `costIndex` 透到 `entryFromClaim` 的 options |

## 2 · 预计算（原样）
```
$ node scripts/antipattern-cost.mjs --limit 200 --write-index
antipattern 1105 · 测到代价 0 · 未测到（cost:0）200 · 比例 0.00%
痕迹分布：{} · 失败→恢复平均 n/a 步
```
索引落在 sidecar：`<DSH_HOME>/memory-context/corpus/antipattern-cost.json`（4355 B，200 条，**全部 cost: 0**）。

## 3 · 测试（原样）
```
$ node --test "test/inject.test.mjs"
ℹ tests 65
ℹ pass 64
ℹ fail 0
```

## 4 · 真库 shadow 实跑（40 条 antipattern 建卡，原样）
```
{"sampled":40,"rowsBefore":96,"rowsAfter":50,
 "costZeroBefore":46,"costZeroAfter":2,
 "overlapBefore":270,"overlapAfter":108}
```
- **卡上 `cost: 0` 的条目：46 → 2**（过滤生效；剩 2 条是索引未覆盖的 id —— 索引只算了 200/1105）。
- **行数 96 → 50**（掉了 46 行）。
- **重叠（主判据的粗代理）：270 → 108，掉 60%。**

## 5 · 结论（必须直说）
**主判据（粗代理）掉了 60%** —— 也就是说，被 `cost: 0` 过滤掉的条目**正是**与信号文本重合的那批。
这不奇怪：`cost` 量的是"重试/返工/中断痕迹"，与"文本相关"是两个正交维度。
⇒ **`cost: 0` 不能当"不值得注入"的判据**；它只说明"这局没测到代价"。若要用，必须改成
**同分内的次级排序**（tokOverlap 相同才比 cost），而不是**硬过滤**——硬过滤会削掉大部分相关性。

## 6 · 未验
- 真实 A2b 主判据（`metrics-guard`）未跑：本轮 40 条样本的重叠已掉 60%，跑全量只会更差，先报风险再决定。
- 索引只覆盖 200/1105 条（`--limit 200` 为控时）；全量预计算约需 5× 时间。
