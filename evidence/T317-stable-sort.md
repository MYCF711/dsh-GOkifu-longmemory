# T317 · 候选排序加 `claimId` 二级键（稳定总序）

> `[本] 2026-11-06 15:35 +08:00` · 只读真库 · 未 git 提交
> 改动：`src/rooms/inject.mjs`（**不是** `walk.mjs`——`compareHits` 早已有 claimId 兜底，缺的是建卡侧两个比较器）

## 0 · 一句话结论

**加了 `claimId` 二级键后，独立实现与主判据仍是 3 条不一致（111/114）—— 这 3 条不是排序不稳定。**
根因已定位：**冻结考卷（`evidence/a2b-holdout.json`）与现场考卷的信号漂移了 37/114 条**，
3 条不一致**全部落在这 37 条漂移集里**（T315 只钉了 `at`，没钉 `signal` 的来源快照）。
二级键仍然值得加（总序、可复现），但它不是这 3 条的成因。

## 1 · 定位：改的是 `src/rooms/inject.mjs`

| 位置 | 原状 | 现状 |
|---|---|---|
| `compareEntries()`（卡片行排序） | rank → occurredAt → episode → **`a.source.seq - b.source.seq`** | 补 `Number.isFinite` 守卫（seq 缺失时原式是 **NaN**，被 sort 当 0 ⇒ 退回插入序）+ **最后一级 `claimId.localeCompare`** |
| `buildMemoryCard()` 的 `hits.sort(...)` | kind → occurredAt → episode | 补 **最后一级 claimId**（episode 指针无 claimId，空串排前） |
| `walk.mjs` 的 `compareHits()` | 已有 episode → claim 字典序 | **未改**（主排序键一字未动） |

`git diff --numstat`：`8	2	src/rooms/inject.mjs`（`test/walk.test.mjs` 新增 2 条 tombstone）。

## 2 · 测试（原样）

```
$ node --test "test/walk.test.mjs"
ℹ tests 36
ℹ pass 36
ℹ fail 0
ℹ skipped 0
```

新增 2 条：
① **同分候选稳定**：两条 claim 同 kind / 同 `occurredAt` / 同 `seq`（只有 claimId 不同）⇒ 把 `walkResult.hits` **反转输入**后建卡，卡面 claim 顺序**逐位相同**，且等于 claimId 字典序；
② **主排序键不变**：`compareHits` 白盒断言 `_tokOverlap=5` 排在 `1` 前（即使它的 claimId 字典序更差），同分时才按 claimId —— 且两向对称（无 0 依赖）。

`test/inject.test.mjs`：`ℹ tests 64 / pass 63 / fail 0 / skipped 1`（未变）。

## 3 · 真跑：独立实现 vs 主判据（原样）

```
$ node scripts/a2b-independent.mjs
T314 · 独立实现复算 · 考卷 114 条
我的实现：严格 54/114 = 47.37%
主判据  ：严格 55/114 = 48.25%
一致 111/114 · 不一致 3
库规模：考卷 1578 vs 当前 1578（一致） · 缺 at 的题 0
  ✗ self:ep-c0a5847a · 我=中 主=不中 · overlap=0 · ep-c0a5847a
  ✗ self:ep-226dbf4f · 我=不中 主=中 · overlap=0 · ep-226dbf4f
  ✗ self:ep-ed98c462 · 我=不中 主=中 · overlap=0 · ep-ed98c462
```

**改前 3 条 · 改后 3 条**（未收敛到 0）。

## 4 · 根因：不是排序，是考卷漂移

现场复算（`tmp/t317-probe.mjs` 同款逻辑）：

```
按 episode 对齐：信号相同 77 | 不同 37
ep-c0a5847a 信号漂移: true
ep-226dbf4f 信号漂移: true
ep-ed98c462 信号漂移: true
```

- 独立实现读**冻结**考卷（`evidence/a2b-holdout.json` 的 `results[].signal`），主判据读**现场重建**的考卷（`buildExam` 从当前 store 的 episode 重新取根任务原话）；
- store 重归档后 37 条 episode 的 `l1`/根任务文本变了 ⇒ 两者拿着**不同的信号**建卡 ⇒ 卡面不同 ⇒ 判定不同；
- 3 条不一致**全部**在这 37 条里（含 `ep-c0a5847a` 的"完全不重合"）。

⇒ **`claimId` 二级键该加（总序保证），但它救不了这 3 条**；要收敛到 0 得把**信号**也钉进考卷（T315 钉了 `at`，还差 `signal`/episode 文本快照），或让两边读同一份考卷。

## 5 · 下一步（建议）

1. **考卷钉住信号**：`evidence/a2b-holdout.json` 增 `signalHash`（episode 根任务文本的 sha256）+ 独立实现若哈希不符就**拒绝出数**（与 T314 的"库规模一致"同级）；
2. 或让主判据也读冻结考卷（`--exam` 通道已有，只是主入口没用）；
3. `claimId` 二级键保留（确定性收益，与漂移无关）。
