# T318 · 把信号钉进考卷（signalHash）—— 未收敛，剩余 2 条 + 22 条哈希不符

> `[本] 2026-11-06 15:40 +08:00` · **只读** · 改动：`scripts/a2b-holdout.mjs`（`signalHash` / `replayFrozen`）
> ⚠ **本刀未达成验收目标（0 条差异）**，如实报告：**2 条判定差异 + 22 条哈希不符**。

## 1 · 落地了什么

| 件 | 落点 | 状态 |
|---|---|---|
| `signalHash(text)` | `sha256(signal)` | ✅ |
| 考卷逐题存 `signalHash` | `judgeCard` 返回值 | ✅ **114/114** |
| `replayFrozen()` | 只读 `exam.results[].signal`，不重建 exam | ✅ 新增 |
| 哈希不符即拒绝出数 | `hashMismatch` 收集并跳过 | ✅ 生效（**22 条被拒**） |

## 2 · 实跑（原样）

```
$ node tmp/t318-compare.mjs
主判据(重放冻结信号): 42/92 = 45.65%
独立实现(冻结信号)  : 54/114 = 47.37%
不一致: 2 条
  ✗ self:ep-bde12afa · 主=中 独立=不中
  ✗ self:ep-08da81e8 · 主=中 独立=不中
signalHash 不符: 22 条
信号漂移自检（冻结 vs 当前 exam 文件）: 不同 23 条
```

| 指标 | 值 |
|---|---|
| 主判据（重放冻结信号） | 42/**92** = 45.65% |
| 独立实现（冻结信号） | 54/**114** = 47.37% |
| **判定不一致** | **2 条**（分母不同：92 vs 114） |
| **signalHash 不符** | **22 条**（应为 0） |

## 3 · 为什么没收敛（根因，已定位）

**① 22 条哈希不符（主因）**：`signalHash` 是在 `judgeCard` 里对**传入的 `item.signal`** 算的，而 `runHoldout` 在 `signalMode` 路径下传的是**模式特定信号**（`text`），考卷里存的 `signal` 字段却是**原始信号** ⇒ 两者不同 ⇒ 哈希不符。
⇒ **修法**：`results[].signalHash` 必须与 `results[].signal` **同源**（都在 `runHoldout` 落盘处计算），不能放在 `judgeCard` 里。

**② 2 条判定差异**：发生在**通过哈希校验的 92 条**里。`ep-bde12afa`/`ep-08da81e8` 是 `repeat` 题——独立实现的 `related` 用 `expectedClaimIds`，主判据用 `expected.episodes`（我在 `replayFrozen` 里补的是 `[item.episode]`，对 repeat 题不成立）。**这是 `replayFrozen` 的映射缺陷，不是判据差异。**

**③ 信号漂移自检 23 条**：冻结考卷的 `signal` 与**当前 `buildExam` 现场重建**的信号不同（T317 已定位：重归档后 37 条 episode 根任务文本变了）。**这正说明 T318 的 `signalHash` 是必要的**——只是我把它放错了位置。

## 4 · 判据

| 判据 | 要求 | 实测 | 结论 |
|---|---|---|---|
| 考卷钉住信号 | 每题带 `signalHash` | 114/114 | ✅ |
| 哈希不符即拒绝出数 | 拒绝 | 22 条被拒（生效） | ✅ 机制对，**数据源错** |
| **差异收敛到 0** | **0** | **2（+22 被拒）** | ❌ **未达成** |
| 判据未被放宽 | J1–J6 未动 | ✅ 未改 | ✅ |

## 5 · 下一步（一句话）

把 `signalHash` 从 `judgeCard` 挪到 `runHoldout` 的**落盘处**（与 `signal` 字段同源），并让 `replayFrozen` 用 `item.expectedClaimIds` 构造 `expected.claimIds`（repeat 题也要成立）——**预计哈希不符 22 → 0、判定差异 2 → 0**。

## 6 · 复现

```bash
node scripts/a2b-holdout.mjs --json > evidence/a2b-holdout.json
node tmp/t318-compare.mjs
```

---

## T318b · 两处修完后的复测（**仍未收敛**）

**修了什么**：`replayFrozen` 的 `expected.claimIds` 改为取 `item.expectedClaimIds`（repeat 题也用 claim id 通道）。

**复测（原样）**：
```
主判据(重放冻结信号): 42/92 = 45.65%
独立实现(冻结信号)  : 54/114 = 47.37%
不一致: 2 条
  ✗ self:ep-bde12afa · 主=中 独立=不中
  ✗ self:ep-08da81e8 · 主=中 独立=不中
signalHash 不符: 22 条
信号漂移自检（冻结 vs 当前 exam 文件）: 不同 23 条
```

**结论：两处修改都没有消除差异**（2 条、22 条均未变）。

**为什么没生效（已定位，未再试第三轮）**：
1. **22 条哈希不符**：`judgeCard` 返回的 `signalHash` 与落盘的 `signal` 在**同一对象**上计算，理论上应同源——实测不符，说明**这 22 条在 `runHoldout` 里走的是 `signalMode` 分支**，落盘的 `signal` 是 `text`（模式信号），而 `signalHash` 是**另一次**调用（`signalHash(item?.signal)`）在 spread 之前算的。**修法（下次）**：`runHoldout` 落盘处**只算一次** `const sig = text; const h = signalHash(sig);` 再一起写 `{signal: sig, signalHash: h}`，彻底不依赖 `judgeCard`。
2. **2 条判定差异**：`ep-bde12afa` / `ep-08da81e8` 是 repeat 题，冻结 JSON 里 `expectedClaimIds` 与主判据现场的 `expected.claimIds` **不是同一组**（repeat 题的 expected 是"prior 局"的 claim，不在 `expectedClaimIds` 里）⇒ 补映射无效。**修法（下次）**：考卷需**额外存 `expectedEpisodes`**（repeat 题的 prior 局 id），否则 `related` 无法复现。

**停止规则（知识库 62）**：本轮到此为止，不再尝试第三次。**当前状态：主判据（重放）42/92 = 45.65%，独立实现 54/114 = 47.37%，判定差异 2 条 + 哈希不符 22 条。G3 仍未通过。**
