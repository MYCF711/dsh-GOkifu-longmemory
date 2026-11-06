# T331 · 第二道降级门（`cost: 0` 不占注入位）

## 1 · 先说**前提**（这条比实现更重要）
**`cost` 不是 claim 字段。** 真库全量核过：
```
{"total":1578,"antipattern":1105,"withCostField":0,"costZero":0,"costPositive":0}
```
claim 记录的实际字段是：
```
["_store","counter","counters","id","kind","occurredAt","preconditions","recordedAt","scopeKey",
 "state","supersedes","support","text","threadIds","validFrom","validTo","validity"]
```
**没有 `cost`**。T330 的 0.09% 是 `scripts/antipattern-cost.mjs` 的 `estimateCost()` **读会话日志时现算**的值
（`cost = 命中的痕迹种类数`，0 = **没测到**，不等于"没代价"）。
⇒ 本门**只能吃预计算索引**（`Map<claimId, number>`），不能在注入路径里读日志（每步都要 zstd 解压，会拖垮注入）。

## 2 · 实现了什么
`src/rooms/inject.mjs` · `entryFromClaim`：
```js
if (claim && options.costIndex instanceof Map) {
  const cost = options.costIndex.get(String(claim.id ?? ''));
  if (Number.isFinite(cost) && cost === 0) return null;   // 从注入面退出
}
```
- **fail-open**：不传 `costIndex` ⇒ 不过滤（**今天的行为一字不变**，插件尚未接线）；
- `cost > 0` ⇒ 正常进卡；**主排序键（tokOverlap）一字未动**（T246 排序平台期已证）。

## 3 · 测试（原样）
```
$ node --test "test/inject.test.mjs"
ℹ tests 65
ℹ pass 64
ℹ fail 0
```
- `T331 ②`（`cost > 0` 正常进卡 + 无索引不过滤 = fail-open）✅
- `T331 ①`（`costIndex` 判 0 ⇒ 不进卡）**未写成绿**：该用例命中的行由 `pickClaim` 的**兜底渲染路径**产生
  （store 里按 (episode, seq) 锚定不到 claim 时，用 `hit.text` 造行），那条路**拿不到 claim 记录**，
  与 T298 ① 同源。写成绿会是假绿，故改为 known-limitation。

## 4 · 真库 shadow 实跑
**没有跑**，原因如实：`costIndex` 尚未由插件提供（需要先把 `antipattern-cost.mjs` 的现算结果预计算成 sidecar），
所以"卡上 `cost: 0` 的条目数"当前**恒为 0 且不具区分力** —— 过滤前后卡片逐字节相同。
主判据同理：**过滤不可能改变它**（没有任何条目被过滤）。

## 5 · 一句话
**现在卡上没有"没测到代价"的条目 —— 但这只是因为 cost 索引还没接线（不是门生效）**；
要让它真正生效，需要先把 `antipattern-cost.mjs` 的现算结果落成 `<store>/corpus/antipattern-cost.json`，
再由插件传给 `buildMemoryCard({ costIndex })`。**主判据没有掉**（没有任何条目被过滤）。
