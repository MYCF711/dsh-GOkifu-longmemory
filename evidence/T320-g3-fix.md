# T320 · 两处根因修完的复测（G3）

> `[本] 2026-11-06 16:05 +08:00` · **只读** · 改动：`scripts/a2b-holdout.mjs`（`signalHash` 同源 + `expectedEpisodes`）、`scripts/a2b-independent.mjs`（用 `expectedEpisodes`）

## 0 · 一句话结论

**修好一处（`signalHash` 22 → 0），另一处只收了一半（判定差异 2 → 3，未收敛）。**
**主判据（重放冻结信号）58/114 = 50.88% vs 独立实现 55/114 = 48.25%，仍差 3 条，全部是"主=中、独立=不中"。**

## 1 · 两处修法落地

| 修法 | 落点 | 结果 |
|---|---|---|
| **① `signalHash` 同源** | `runHoldout` 落盘处 `const judged = judgeCard(...); judged.signal = text; judged.signalHash = signalHash(text);`（**不再依赖 `judgeCard`**） | ✅ **22 → 0 条哈希不符** |
| **② 考卷补 `expectedEpisodes`** | 同处写 `judged.expectedEpisodes = item.expected.episodes`；`replayFrozen` 与独立实现都改用它 | ⚠ 落盘成功（114/114），**差异未消（2 → 3）** |

```
有 signalHash: 114 | 有 expectedEpisodes: 114 | 主判据: 55/114
```

## 2 · 复测（原样）

```
$ node tmp/t318-compare.mjs
主判据(重放冻结信号): 58/114 = 50.88%
独立实现(冻结信号)  : 55/114 = 48.25%
不一致: 3 条
  ✗ self:ep-c0a5847a · 主=中 独立=不中
  ✗ self:ep-bde12afa · 主=中 独立=不中
  ✗ self:ep-08da81e8 · 主=中 独立=不中
signalHash 不符: 0 条
信号漂移自检（冻结 vs 当前 exam 文件）: 不同 1 条
```

| 指标 | T318b | **T320** |
|---|---|---|
| `signalHash` 不符 | 22 | **0** ✅ |
| 判定不一致 | 2 | **3**（未收敛） |
| 主判据（重放） | 42/92 = 45.65% | **58/114 = 50.88%** |
| 独立实现 | 54/114 = 47.37% | **55/114 = 48.25%** |

## 3 · 3 条差异逐条（真问题，未消除）

| # | 题 | 主 | 独立 | 已排查 |
|---|---|---|---|---|
| 1 | `self:ep-c0a5847a` | 中 | 不中 | 已补 `expectedEpisodes`，仍差 |
| 2 | `self:ep-bde12afa` | 中 | 不中 | 同上 |
| 3 | `self:ep-08da81e8` | 中 | 不中 | 同上 |

**共同点**：全部是"主判据命中、独立实现不命中"，且 `expectedEpisodes` 补完后**没有变化** ⇒ **不是 `related` 的映射问题**，而是**两边的卡不同**（`signalHash` 已 0 不符，说明信号一致 ⇒ 差异在 `walkFromSignals`/`buildMemoryCard` 的**调用参数**：主判据传 `bigramFilter`，独立实现没传；或 `limit/budgetTokens` 默认值不同）。

## 4 · 判据（知识库 62）

| 判据 | 结论 |
|---|---|
| 机制上不可能？ | **不是**——`signalHash` 已证明"同源"可行（22 → 0） |
| 实现上不好？ | **是**——剩 3 条，根因指向"两边调用 walk 的参数不一致"（`bigramFilter` 未传），**这是可修的** |
| 是否该归档"已否决"？ | **暂不**：还剩一条**具体、可验证**的修法（让独立实现传入与主判据相同的 `bigramFilter`） |

## 5 · 下一步（一句话）

独立实现调用 `judgeCard` 时**没传 `bigramFilter`**（主判据传了）⇒ 两边的 bigram 通道口径不同。**传上即可**，预计 3 → 0。

## 6 · 复现

```bash
node scripts/a2b-holdout.mjs --json > evidence/a2b-holdout.json
node tmp/t318-compare.mjs
```

---

## T320b · 补 `bigramFilter` 的尝试（**前提不成立，如实报告**）

**核对结果：独立实现里没有 `judgeCard`，也没有 `bigramFilter` 参数。**

```
$ grep -n "bigramFilter|judgeCard" scripts/a2b-independent.mjs
（无匹配）
```

- 独立实现调用的是**自己的 `judge()`**（契约 J1–J4 的逐字实现），`df/n` 由 `buildDf(claims)` 自己算；
- 因此**"给独立实现传 `bigramFilter`"这条修法不存在**——T320 的定位（"独立实现没传 `bigramFilter`"）**是错的**；
- 两边的 bigram 通道**都做了 IDF 过滤**（主：`buildBigramDf` + `isDiscriminative`；独立：`buildDf` + 同一 `MAX_DF_RATIO = 0.02`）。

**⇒ 3 条差异的真实来源仍未定位**（不在 `related`、不在 `signalHash`、不在 `bigramFilter` 参数）。

## T320b · 最终状态（静止）

| 指标 | 值 |
|---|---|
| 主判据（重放冻结信号） | **58/114 = 50.88%** |
| 独立实现（冻结信号） | **55/114 = 48.25%** |
| 判定不一致 | **3 条**（全部"主=中、独立=不中"） |
| `signalHash` 不符 | **0** |
| 未定位的差异 | **3** |

**剩余 3 条（`ep-c0a5847a` / `ep-bde12afa` / `ep-08da81e8`）候选根因（按可能性排序，均未验证）：**
1. **`related` 的 `expectedClaimIds` 在 repeat 题上不完整**（考卷只存了部分 id）；
2. **`contractTokens` vs `discriminativeTokens` 的停用词差异**（主实现丢弃 `'path'`，独立实现也丢弃，但主实现在 `bigramOverlapCount` 里还额外做了 `signalTokensOf` 的过滤）；
3. **卡面 claim 的 `text` 取值不同**（`store.get('claims', id)` 与主判据用的 `record.text` 可能不是同一字段）。

**判据（知识库 62）**：已定位的两处**都修完**（`signalHash` 22→0；`expectedEpisodes` 已落盘），**剩 3 条属于"实现上不好"但根因未知**。**下一刀必须先做"逐条 diff 3 个 item 的 card 面"**，否则再改都是猜。
