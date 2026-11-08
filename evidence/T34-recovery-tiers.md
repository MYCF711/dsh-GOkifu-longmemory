# T34 · 恢复事实分档（exact / same-file / same-tool）

> 日期：2026-11-08 · 改动：`src/rooms/extract.mjs`（判据 + 分档）、`src/rooms/inject.mjs`（卡上文案）、`scripts/archive.mjs`（索引映射按档位优先）、`test/extract.test.mjs`、`test/inject.test.mjs`
> 前置：`evidence/T28-recovery-fact-on-card.md`、`evidence/T30-recovery-index.md`（exact 三档 + 归档索引）

## 0 · 一句话结论

恢复事实从「同一命令/同一文件（逐字）」扩出最弱一档 **`same-tool`（同工具族后来显式成功）**，**分档计数、卡上标清档位**：

| 档位 | 判据 | 卡上文案 |
|---|---|---|
| **exact** | 同一 bash 命令逐字重跑、后来 `exit 0`（`same-command-exit-0`）；或同一条命令重跑、无失败输出（`same-command-no-failure`） | ` · 恢复：后于 <date> 同一命令成功（exit 0, seq N）` / ` · 恢复：后于 <date> 同一命令重跑（无失败输出, seq N）` |
| **same-file** | 同一个 `file_path` 后来被 `write`/`edit` 写成功（`same-file-write-ok`） | ` · 恢复：后于 <date> 同一文件写入成功（seq N）` |
| **same-tool**（新） | **同工具族**后来**显式成功**（见 §1 归一规则） | ` · 恢复（同工具族）：后于 <date> 同工具族后来成功（seq N）` |

真库 1560 条 antipattern claim 的**逐档计数**（不是合并覆盖率）：**exact 12 · same-file 22 · same-tool 76**；三档合计 110/1560 = **7.05%**（同口径下 T30 只有 exact+same-file = 34–37 条，2.18–2.37%）。same-tool 一律带 `（同工具族）` 前缀，**绝不写成"同一命令"**。

## 1 · same-tool 的机械判据（宁缺勿编的边界）

**工具族归一**（`recoveryCommandFamily` / `recoveryDirOf`，纯函数）：

| 主体 | 归一规则 | 例 |
|---|---|---|
| bash 命令族 | 跳过前置环境变量赋值（`FOO=bar`），取**首个非开关词** + 可选的**次词**（非 `-` 开头），小写 | `git push origin main` ⇒ `git push`；`git push --force` ⇒ `git push`；`node scripts/check.mjs --x` ⇒ `node scripts/check.mjs`；`ls -la` ⇒ `ls` |
| write/edit 目录族 | `file_path` 的**目录**（反斜杠→斜杠、小写） | `D:/repo/a/x.mjs` ⇒ `d:/repo/a` |

**缺一不产出**（与 exact 同一套硬约束）：
1. **同一局**内，恢复事件 `seq` **更靠后**；
2. **显式成功**：bash 结果里有 `[exit code: 0]`；`write`/`edit` 结果带成功标记（`has been updated successfully` / `Created file` …）；
3. **同族**：归一后的命令族 / 目录族相同；
4. 取不到时间的一律不产出（无时不入）。

**精确优先**：`findRecoveryFact` 先试 exact（同命令 exit 0 → 同命令重跑无失败 → 同文件写成功），都没有才试 same-tool ⇒ 同一命令永远走 exact，不会被 same-tool 抢（T34 ③ 钉住）。归档索引映射（`archive.mjs` 的 `recoveryIndexFactsForClaims`）也先按档位、再按 `support.seq` 距离取事实（否则同族事实可能挤掉 exact 事实）。

## 2 · 分档计数（真库，逐档报，不合并）

| 档位 | 条数 | 占 1560 条 antipattern |
|---|---|---|
| **exact**（`same-command-*`） | **12** | 0.77% |
| **same-file**（`same-file-write-ok`） | **22** | 1.41% |
| **same-tool**（新） | **76** | **4.87%** |
| 合计（仅作对照，不当作单一判据） | 110 | 7.05% |

- 索引：`entries 114` · `supports 611`（T30 时 37 / 455）；回填 115 局 / 475 MB / **15.1 s**。
- **exact+same-file 本次口径 34 条（2.18%）**，T30 实测 37 条（2.37%）：差 3 条来自「claimId 兜底键的第一条事实现在可能落到 same-tool」——卡渲染的是 support，`supports` 精确键下 exact 事实优先，不改变"该行该显示什么"。
- 提上去的 76 条**都来自真实事件**：同一工具族、同局、更靠后、显式成功；不是把"不算恢复的"算成恢复。

## 3 · 卡行样例（三档并存）

```text
exact     - [antipattern] Error: boom (ep-a, 2026-10-20, seq 2) · 恢复：后于 2026-10-20 同一命令成功（exit 0, seq 4）
same-file - [antipattern] Error: old_string matched 2 times in "…/a.mjs" (ep-a, 2026-10-20, seq 6) · 恢复：后于 2026-10-20 同一文件写入成功（seq 8）
same-tool - [antipattern] error: failed to push some refs (ep-a, 2026-11-06, seq 3) · 恢复（同工具族）：后于 2026-11-06 同工具族后来成功（seq 40）
```

- same-tool 行**必须**带 `（同工具族）`；T34 ④ 断言它不含 `同一命令成功` / `同一文件写入成功`（否则就是编）。
- exact / same-file 文案**不受影响**（T34 ⑤）。

## 4 · tombstone（same-tool 关掉 ⇒ 与现状逐字节一致）

- `findRecoveryFact(..., { includeSameTool: false })` 的行为 = T30 的实现（只走 exact/same-file），T34 ② 断言同一份事件在关掉时返回 `null`、打开时 `same-tool`。
- 索引层同样：`collectRecoveryFacts` 默认带 same-tool；关掉（`includeSameTool:false`）时归档产出的索引与 T30 完全一致。
- 既有 1165 条测试（含 T28/T30/T31 全部）在打开 same-tool 后仍全绿（见 §6）。

## 5 · 测试

| # | 断言 |
|---|---|
| T34 ① | 工具族归一（命令族 / 目录）+ 档位映射（`recoveryTierOf`） |
| T34 ② | 不同命令、同 `git push` 族、后来 exit 0 ⇒ `same-tool`；`includeSameTool:false` ⇒ `null`（tombstone） |
| T34 ③ | 同一命令仍走 `same-command-exit-0`（不许被 same-tool 抢）；不同工具族不算；同目录不同文件 ⇒ `same-tool`，不同目录 ⇒ 不算 |
| T34 ④ | 卡行 `kind=same-tool` ⇒ 文案「恢复（同工具族）…同工具族后来成功」，且**不含**「同一命令成功」「同一文件写入成功」 |
| T34 ⑤ | exact / same-file 文案不受影响（分档不改旧档） |

## 6 · 验收

- 全量：`node --test "test/*.test.mjs"` —— **1176 tests / 1170 pass / 0 fail / 6 skipped**（exit 0）。
- `node scripts/check.mjs` PASS。
- 真库：`node scripts/archive.mjs --recovery-index`（15.1 s，114 条 entries / 611 条 supports）。

## 7 · 复现

```bash
node --test --test-name-pattern "T34" test/inject.test.mjs test/extract.test.mjs
node scripts/archive.mjs --recovery-index --root "$DSH_HOME" --json   # 重建索引（含 same-tool）
node tmp/t30-coverage.mjs                                            # 逐档计数
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- 逐档：**exact 12 · same-file 22 · same-tool 76**（合计 110/1560 = 7.05%，只作对照）；
- same-tool 判据：同族（命令族/目录）+ 同局 + 更靠后 + **显式成功**；
- 文案：same-tool 必带「（同工具族）」，T34 ④ 断言不冒充「同一命令/同一文件」；
- tombstone：`includeSameTool:false` 与 T30 行为逐字节一致（T34 ②）。

## 8 · 限制 / 风险

1. **same-tool 是弱证据**：同工具族 ≠ 同一主体（`git push` 到另一个 remote 也算）。所以它**单独一档**、卡上明标，**不许**当成 exact 用；后续要退役/降权时，same-tool 的权重应低于 exact。
2. **命令族归一是启发式**：`node scripts/check.mjs` 与 `node scripts/other.mjs` 是不同族（次词不同）；`npm install` 与 `npm ci` 不同族（次词不同）。宁缺：宁可少匹配，不把不同工具合并。
3. **目录族**可能过宽（同一目录下不同文件），这是"同工具族"的本意；卡上文案已说明。
4. 覆盖率 7.05% 里 **76 条是 same-tool**，属于"能找到的恢复事实"变多，**不是**"记忆命中率"变高；A2b/ablation 口径不受影响（本刀只改恢复事实的判据与文案）。
5. 索引只增不改：已有 exact 条目不会被 same-tool 覆盖；重算幂等仍需在重建时保持一致（T30 §6 的 sha256 校验方式照旧）。
6. **观察窗/证据仍是同局**：跨局"后来在别处修好"不算（无法证明因果），same-tool 也没有放宽这一条。