# T298 · 读侧硬过滤（stale / 过期不占位）

## 1 · 改哪个文件（先回答）
**`src/rooms/inject.mjs`** —— 渲染入口 `entryFromClaim`（+ 把 `now` / `preconditionOk` 从 `buildMemoryCard` 透到 `collectEntries`）。
walk 侧已有 `invalidated` / `validityOk===false` 的剔除，**不重复造**；本刀只补 `stale` 与 `validUntil` 两条。

## 2 · 判据（硬过滤，不是降权）
```js
const revived = typeof options.preconditionOk === 'function' ? options.preconditionOk(claim) === true : false;
if (!revived) {
  if (claim?.state === 'stale') return null;
  const validUntil = Number(claim?.validUntil);
  if (Number.isFinite(validUntil) && validUntil < nowTs) return null;
}
```
- 卡上不出现，**库里仍在**（只增不改）；
- **可复活**：`preconditionOk(claim) === true` ⇒ 回到候选（V2）；
- 不改 `state` 写入逻辑、不改注入形状（golden）。

## 3 · 真库现状（只读）
```
{"total":1578,"stale":0,"expired":0,"precond":1578,"staleIds":[]}
```
**当前库里没有 stale、也没有 `validUntil` 过期的 claim** ⇒ 卡上过期条目数 **过滤前 = 0、过滤后 = 0**（这条对照没有区分力，如实记录）。
1578 条都带 `preconditions`（多为 `scope` 检查）—— 它们的 `check` 尚未接入复活回调，属未验项。

## 4 · 测试（原样）
```
$ node --test "test/inject.test.mjs"
ℹ tests 64
ℹ pass 63
ℹ fail 1
```
- `T298 ②`（`state === 'stale'` 不进卡）✅
- `T298 ③`（`preconditions` 重跑通过 ⇒ 可复活）✅
- `T298 ①`（`validUntil` 过期 ⇒ 不进卡）❌ **未过**

### ① 的根因（诚实）
测试命中的行不是由 `entryFromClaim` 渲染的，而是 `pickClaim` 的**兜底分支**
（store 里查不到该 claim 时，用 `hit.text` 造一行并沿用 `hit.claimId`）。
该分支拿不到 `validUntil`，所以 `entryFromClaim` 里的过滤**根本没被调用到**。
我在 `pickClaim` 里加过同一道判断，但那样会**先于复活逻辑**拦掉（`T298 ③` 立刻变红），已回退。

**T298b 尝试（已回退）**：把过滤下沉到 `buildMemoryCard` 的 hit 循环（`pickClaim` 之前，`view.claimsById` + `store.get('claims', id)` 双查，复活回调同一处判定）。
结果：① 仍红（该 claim **不在** scope 过滤后的 `view.claimsById` 里，`store.get` 也未命中 ⇒ `hitRecord === null` ⇒ 兜底分支照旧造行），
且新判断把两条 R12 兼容用例判红（`hit.claimState` 为 stale 的合法 hit 被误杀）。**已整段回退**，回到 63/64。

**下一步（更精确）**：问题不在"查不到 claim"，而在**兜底分支本身**（`pickClaim` 里 `claimId && hit.text` 那条：store 查不到就用 `hit.text` 造行）。
正确收口 = 给 `pickClaim` 传入 `preconditionOk`，在兜底分支里**当 `hit.claimState === 'stale'` 或该 id 在库里有 `validUntil` 且已过期时返回 null**（复活优先）；
不要在 hit 循环里再判一遍（会误杀 `claimState` 合法的 hit）。

## 5 · 未验
- 真库 shadow 的"过滤前后卡上过期条目数"：**库里 0 条，无对照可做**（不是没测，是没有样本）；
- 主判据 / A5 在过滤后的读数：**未跑**（`metrics-guard` 需 ~10 分钟；且 0 条被过滤 ⇒ 数值不可能变化）。


---

## 6 · T298c 最终尝试与 known-limitation（2026-11-06）

### 尝试
只改 `pickClaim` 兜底分支（`claimId && hit.text` 那条），并给 `pickClaim` 传入 `preconditionOk`；
判据用**记录本身**（`record.state === 'stale'` / `record.validUntil < now`），不用 `hit.claimState`（T298b 的误杀教训）。

### 结果
```
$ node --test "test/inject.test.mjs"
ℹ tests 64
ℹ pass 63
ℹ fail 1        ← T298 ① 仍红
```
**没有新增误杀**（②③ 保持绿），但 ① 仍未过 ⇒ **按止损线整段回退**，不再进行第三轮。

### known-limitation（明确记录，不遮）
- **`T298 ①`（`validUntil` 过期 ⇒ 不进卡）未实现**：该用例命中的行由 `pickClaim` 的**兜底分支**产生，
  而兜底分支的触发条件正是"`view.claimsById` 里查不到该 claim"——**没有记录可判 `validUntil`**，
  在 `pickClaim` 内拿不到 store。要修必须把 `store` 传进 `pickClaim`（或把过滤上移到 `buildMemoryCard` 的
  视图构建阶段），两者都超出本刀的"一处收口"边界，且 T298b 已证明上移会误杀 `claimState` 合法的 hit。
- **影响面：0** —— 真库 `{"stale":0,"expired":0}`（1578 条 claim 全量核过），**当前没有任何 claim 会被这条路径漏掉**。
- **继续投入的前提**：真库出现第一条 `stale` / `validUntil` 过期的 claim，或视图构建阶段被重构时，再补这一条。
- **已生效的部分**：`state === 'stale'` 不进卡（②）、`preconditions` 重跑通过可复活（③）—— 两条都绿且有用。

### 知识库 62（停止规则）
真库 0 条 ⇒ 此功能是**防未来**，不是修当前问题。按停止规则：**不再为 ① 投入**，直到影响面变为非零。
