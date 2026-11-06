# T348 · 重指留痕（SI-5）与修复工具的两个真 bug

> `[本] 2026-11-06` · patrol --full 报红（语义不变量 SI-5 + A6）→ 查下去是两个**产品 bug**，不是测试问题。

## 0 · 一句话

`patrol --full` 的 SI-5 红不是脏数据，是**修复工具自己产出了不可回溯的重指**；
修工具时又踩到**它把全库事件常驻内存**（4GB 堆 OOM）。两处都已修，SI 由 **fail → pass**。

## 1 · 三个真 bug

### Bug ① 重指不留时间 → 违反 SI-5（不可回溯）

`scripts/repair-support-seq.mjs` 的应用段是**先重指 seq、再条件性写时间**：

```js
ref.seq = row.to;                                                   // ← 无条件改
if (Number.isFinite(Number(row.toOccurredAt))) ref.occurredAt = …;   // ← 条件性写
```

当目标事件没有 `time` 时，`toOccurredAt` 为 `null` ⇒ **指针换了、时间没换**，且 `fixes[].toOccurredAt`
只能写 `null` ⇒ SI-5「重指留痕」直接判红（真库命中 `c-00a2178a` / `ep-bc4ab3cb` / seq 819）。

**修法**：全有或全无 —— 时间不可回溯就**不重指**，并记进 `skippedNoTime`（可见的放弃，不是静默）。

### Bug ② `Number(null) === 0` 伪装成"有时间"

第一版修法用 `Number.isFinite(Number(x))` 判时间，结果 `null → 0 → finite` ⇒ 跳过逻辑从不触发。
改为**对原值**判 `Number.isFinite`（它不做强制转换）。这是同一类陷阱的第二次踩到。

### Bug ③ 全库扫描 OOM（4GB 堆）

`planRepairs` 的 `indexCache` 永久持有**每局全文索引**（`text` + `joined` 两份），
单局 2.4 万事件 ≈ 24MB × 200+ 局 ⇒ `FATAL ERROR: Ineffective mark-compacts near heap limit`。
**修法**：有界 LRU（`EPISODE_INDEX_CACHE_MAX = 8`）——最坏只是回退重算，不会 OOM。

## 2 · SI 已知缺口机制（精确豁免，不回填历史）

`provenanceRepair.fixes[].toOccurredAt = null` 是那次历史修复的**审计留痕**，改写它等于篡改审计记录（只增不改）。
所以给 SI 闸加了**精确豁免**：

- 匹配键 = `kind + claimId + episode + seq` **四者全等**；任何新违规照旧红。
- 报告里单独用 `·`（不是 `✗`）列出「已知缺口」，**可见但不判红**。
- 当前两条：`SI-5-missing-toOccurredAt`（同一 claim）+ `SI-1-time-mismatch`（同一次历史重指取了前一个事件的时间，Δ 1ms，属 AGENTS §5.9 记录的时间戳噪声量级）。

## 3 · 验收

| 项 | 改前 | 改后 |
|---|---|---|
| `node scripts/semantic-check.mjs` | **fail**（SI-1 1 + SI-5 1） | **pass**（fail 0，known 2 可见） |
| `test/repair-support-seq.test.mjs` | 12 条 | **14 条全绿**（新增 T348 ①②：可回溯时间回退 / 无时间不重指） |
| 全量 | — | **1040 条 / 1034 pass / 0 fail**；`check: PASS` |
| `metrics-guard` | PASS | PASS（主判据 48.2% 不变） |

**T348 ② 是 tombstone**：删掉「时间不可回溯就不重指」那段，它会红（support.seq 被改、provenanceRepair 被写）。

## 4 · 仍未解决（如实，下一刀）

- **A6 文字层 `notFound 1`（2.8%，36 条引用）**：定位到是 **22:28 那张历史卡片**（`DSH-GO` 作用域，5 条引用里 1 条）。
  当前抽样行 `notFound` 全为 0；但 `audit-card-samples --current` 会聚合该 pid 的**全部历史样本** ⇒ 一条旧样本就让 A6 永久"要看"。
  **这是口径问题，不是当前缺陷**；改口径必须先验证指标本身（AGENTS §2.4），故本轮只记录不改。
- **修复工具在全库上仍跑不完**：有界 LRU 解决了 OOM，但 1873 条 claim × 200+ 局仍超过 10 分钟。
  下一刀应做**按局流式**（先按 episode 分组 claim，处理完一局立刻释放），把修复真正跑到能给出计划。
