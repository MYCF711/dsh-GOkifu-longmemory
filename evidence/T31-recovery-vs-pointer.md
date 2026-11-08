# T31 · 有恢复事实的 antipattern 不降级为指针行

> 日期：2026-11-08 · 改动：`src/rooms/inject.mjs`、`test/inject.test.mjs`
> 前置：`evidence/T3-pointer-tier.md`（三级交付的降级判据）、`evidence/T28-recovery-fact-on-card.md`、`evidence/T30-recovery-index.md`

## 0 · 一句话结论

指针档默认开时，`observed` 且 **1 局支撑**的 antipattern 本来降级成 `1 局支撑 · 原文未给`（没有正文，恢复事实也无处可挂）。现在加一条**豁免**：这类 claim **若有恢复事实**（归档索引或读时派生命中），**不降级**，照常给正文 + ` · 恢复：…` 尾注；没有恢复事实的**仍按原样降级**（T3 的 token 节省不动）。真库可豁免 **20 条**（1560 条 antipattern 的 1.28%；1314 条指针候选的 1.5%），每行约 **+41 tokens**，20 张真实卡合计 **+32 tokens（+3.2/卡）**。

## 1 · 改了什么（唯一收口）

`src/rooms/inject.mjs` 的 `entryFromClaim`：

```js
const basePointer = options?.pointerTier === true && isPointerCandidate(claim);
// T31：恢复事实先算 —— 它决定「指针档是否豁免」
const recovery = recoveryFactOf({ claim, src, options, logFallback: !basePointer });
const pointer = basePointer && !recovery;   // 有恢复事实 ⇒ 不降级
```

| 规则 | 行为 |
|---|---|
| 有恢复事实（索引/读时派生命中） | **不降级**：正文行 + 恢复尾注 |
| 没有恢复事实 | **照旧降级**为指针行（T3 的 token 节省完全保留） |
| `recoveryOnCard:false` | 恢复事实不参与 ⇒ 全部回到原降级行为（一键回退） |
| `pointerTier:false` | 本来就没有降级 ⇒ 行为不变（T3 关档口径） |

**成本边界**：指针候选只查**索引**（`logFallback:false`）——索引是 `stat` + 小 JSON，热缓存后≈0；正文行仍走 T28/T30 的完整链路（索引 → 读时派生）。这样豁免不会把"为指针行解 8 MB 日志"的成本带进热路径。

## 2 · token 成本（要求 ③）

真库统计（`tmp/t31-estimate.mjs`，只读）：

| 读数 | 值 |
|---|---|
| antipattern claim | 1560 |
| 指针候选（`observed` 且 ≤1 局支撑） | **1314** |
| **有恢复事实 ⇒ 被豁免** | **20**（占全部 1.28%；占指针候选 1.5%） |
| 指针行 tokens（估算） | ~20 |
| 豁免后的正文行 tokens（估算，含尾注） | ~61（**+41/行**） |
| 20 张真实卡（默认指针档） | rows 34 · 被豁免 2 行 · tokens **2233 → 2265（+32，+3.2/卡）** |
| m5-report（20 张卡，含索引查询） | **49.9 s**（T30 时 56.9 s ⇒ 无回归；指针候选只查索引，不解日志） |

结论：**豁免面很小（20 条），成本按行可测（+41 tokens/行）、按卡平均 +3.2 tokens**；不豁免的 1294 条指针候选一个 token 都没变。

## 3 · 卡行样例（真库，`c-b8725e63` / 索引命中）

```text
默认指针档（T30 时）：
- [antipattern] 1 局支撑 · 原文未给 (ep-8cc34e32, 2026-11-06, seq 44262)

T31（有恢复事实 ⇒ 不降级）：
- [antipattern] Error: cannot edit "…/CHANGELOG.md": binary file (ep-8cc34e32, 2026-11-06, seq 44262) · 恢复：后于 2026-11-06 同一文件写入成功（seq 48687）
```

没有恢复事实的 claim（例如 `c-0000aa03` 那类）**仍是指针行**：

```text
- [antipattern] 1 局支撑 · 原文未给 (ep-aaaaaaa1, 2026-10-20, seq 2)
```

## 4 · 测试（`test/inject.test.mjs`，5 条全绿）

| # | 断言 |
|---|---|
| T31 ① | 有索引事实的 `observed`+1 局支撑 antipattern ⇒ **正文行** + 恢复尾注，`card.tier === 'content'`，且不含 `原文未给` |
| **T31 ②（tombstone）** | 没有恢复事实 ⇒ **仍是指针行**（`1 局支撑 · 原文未给`），`tier === 'pointers'` |
| T31 ③ | `recoveryOnCard:false` ⇒ 有索引也回到指针行（开关关掉 = 原行为） |
| T31 ④ | `pointerTier:false` ⇒ 行为不变（没有指针行，正文行照常带尾注） |
| T31 ⑤ | token 成本：同一张卡只有"被豁免"那一行变厚，**其它行逐字节不变**；`tokens` 增加 |

## 5 · 限制 / 风险

1. **豁免只对有恢复事实的行**：`observed`+1 局支撑、但没有恢复事实的 1294 条**仍降级**（T3 的意图不变）。
2. **指针候选只查索引**：索引没覆盖到的（新 claim / 索引未重建）即便读时派生能算到，也**不会**触发豁免 —— 这是为守住热路径成本。若将来索引覆盖率提高，这条限制自然变松。
3. **A6 口径**：豁免行是正文行，进 A6 分子分母；指针行仍机械豁免。豁免后 A6 的分子分母会**各增加约 20 行**（真库），口径没变，只是样本多了。
4. **token**：单行 +41 tokens；一张卡最多 5 行，最坏 +205 tokens（仍在 500 预算内，预算自限照常生效——超预算先降条数）。
5. 不改变 `isPointerCandidate` 的计数判据，也不改 `pointerBodyOf`（指针行形态一字不变）。

## 6 · 复现

```bash
node --test --test-name-pattern "T31" test/inject.test.mjs
node tmp/t31-estimate.mjs          # token 成本（20 张真实卡 + 真库 claim 统计）
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- 豁免面：**20 / 1560（1.28%）**；指针候选 1314 条里 20 条；
- 成本：**+41 tokens/行**，20 张真实卡 **+32 tokens（+3.2/卡）**；
- tombstone：没有恢复事实的**仍是指针行**（T31 ②），开关关掉回到原行为（③）；
- 向后兼容：`pointerTier:false` 行为不变（④）。