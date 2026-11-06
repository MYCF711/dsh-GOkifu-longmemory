# T335 · `cost` 与"文本相关"的独立性（I1 乘法检验）

> `[本] 2026-11-06 18:10 +08:00` · **只读** · 脚本 `scripts/cost-independence.mjs` · 单测 2 条
> 语料：`evidence/a2b-holdout.json` 的 114 题（冻结信号），**渲染行 392 条**

## 0 · 一句话结论

**耦合强度不可计算，因为 `P(cost>0) = 0`——392 条渲染行的 `cost` 全部是 `null`。**
⇒ **T333 的"cost 与文本相关正交"不是测出来独立的，是 cost 从未被赋值**（`buildMemoryCard` 调用没传 `costIndex`）。
**"正交"是空谈：cost 在这条路径上从未参与过任何排序。**

## 1 · 实跑（原样）

```
$ node scripts/cost-independence.mjs
T335 · cost × related 独立性 · 渲染行 392
P(cost>0)      = 0/392 = 0.0000
P(related)     = 154/392 = 0.3929
P(cost>0 ∧ 相关) = 0/392 = 0.0000
耦合强度 = n/a  （不可计算：边际为 0）
cost 缺失（null）行: 392/392
```

| 量 | 值 |
|---|---|
| `P(cost>0)` | **0/392 = 0.0000** |
| `P(related)` | 154/392 = **0.3929** |
| `P(cost>0 ∧ related)` | **0/392 = 0.0000** |
| **耦合强度** | **n/a**（分母为 0） |
| `cost` 为 null 的行 | **392/392（100%）** |

## 2 · 为什么是 0（根因）

`src/rooms/inject.mjs` 的 `entryFromClaim` / `buildEntry` 里：

```js
cost: Number.isFinite(options?.costIndex?.get?.(String(claim.id ?? ''))) ? options.costIndex.get(...) : null,
```

`costIndex` 是**可选注入**；本刀（以及主判据 `a2b-holdout.mjs` 的 `buildMemoryCard` 调用）**没有传 `costIndex`** ⇒ 每条 entry 的 `cost` 恒为 `null` ⇒ `cost > 0` 永远为假。

## 3 · 判据（知识库 78）

| 判据 | 要求 | 实测 | 结论 |
|---|---|---|---|
| 耦合强度 ≈ 1 ⇒ 独立 | \|s−1\| < 0.1 | **n/a**（不可计算） | **无法判定** |
| `P(cost>0) > 0` | 前提 | **0** | **前提不成立** |

**⇒ 不能声称"独立"**，也不能声称"耦合"——**这个量在当前的测量路径上不存在**。

## 4 · 结论与建议

- **T333 的"正交"是定性判断，不是统计结论**；本刀证明它**连可检验的形态都没有**（cost 恒 null）。
- **cost 不能当"同分内次级排序"的键**：它不是"独立与否"的问题，而是**从未被赋值**。
- **要真正检验**，必须：① 在 `buildMemoryCard` 调用里**传入 `costIndex`**（从 claim 的代价统计构造）；② 重跑本脚本，那时 `P(cost>0)` 才会 > 0，耦合强度才有定义。
- 在此之前，**任何"cost 与文本正交"的说法都应视为未验证**。

## 5 · 复现

```bash
node --test "test/cost-independence.test.mjs"   # 2 条
node scripts/cost-independence.mjs              # P 三量 + 耦合强度
node scripts/cost-independence.mjs --json       # 前 50 行明细（含每行 cost/related）
```
