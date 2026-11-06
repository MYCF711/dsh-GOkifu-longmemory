# T333 · cost 门：硬过滤 → 同分次序

## 1 · 为什么改
T332 实测（40 条 antipattern 建卡）：
```
{"rowsBefore":96,"rowsAfter":50,"costZeroBefore":46,"costZeroAfter":2,
 "overlapBefore":270,"overlapAfter":108}
```
**硬过滤削掉 60% 相关性**（270→108）—— 被过滤的正是与信号重合的那批。
`cost` 量的是"重试/返工/中断痕迹"，与"文本相关"正交 ⇒ 只能做**同分内的次级排序**。

## 2 · 改了什么（`src/rooms/inject.mjs`）
- **撤掉硬过滤**：`costIndex.get(id) === 0 ⇒ return null` 已删除；
- **`buildEntry` 挂 `cost`**（来自 `options.costIndex`，缺失 ⇒ `null`）；
- **`compareEntries` 加**：`|| ((b.cost ?? 0) - (a.cost ?? 0))`，位置在
  `rank → occurredAt → episode → seq` **之后**、`claimId` 字典序**之前** ⇒ **主键全同才比 cost**；
- 主排序键（`rank` / `tokOverlap`）一字未动（T246）。

## 3 · 测试（原样）
```
$ node --test "test/inject.test.mjs"
ℹ tests 66
ℹ pass 65
ℹ fail 0
```
新增 2 条：
- `T333 ①` 主键（rank）不同 ⇒ **不看 cost**（代价再高也不能翻主键顺序）✅
- `T333 ②` 主键全同 ⇒ `cost > 0` 排前；**两条都进卡**（不再硬过滤）；无 `costIndex` ⇒ 视为 0（不加分不惩罚）✅

## 4 · 真库 shadow 复算
见下（同脚本、同 40 条样本）。

## 5 · 未验
- 全量 A2b 主判据（`metrics-guard`）未跑；
- 索引仍只覆盖 200/1105 条（`--limit 200`）。
