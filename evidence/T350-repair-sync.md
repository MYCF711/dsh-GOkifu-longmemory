# T350 · 重指的 SI-4b 同步 + 已验证的修复计划（活库仍未写入）

> `[本] 2026-11-07` · 承接 T349（流式）。修掉 T349 副本实验新增的那 1 类回归，并把"能不能用"钉成可复核的门。

## 0 · 一句话

`applyPlan` 重指 support 后**没有同步 claim.occurredAt**（SI-4b：claim 晚于它的全部证据）。
修掉之后副本对照变成 **fail 214 → 133、SI-1 156 → 75、SI-4b 0、无任何新增违规类** —— 达到自己设的门。
但**活库仍一个字节没写**：工具自身有安全闸（拒绝 `--apply` 真库），替换必须是一次显式操作。

## 1 · 修了什么

| 位置 | 改动 | 为什么 |
|---|---|---|
| `scripts/repair-support-seq.mjs` 的 `applyPlan` | 应用重指后，若 `claim.occurredAt > min(support.occurredAt)` 则**降到该 min**（只降不升），并记 `loweredAt` | 重指可能把 support 挪到更早的事件；不同步 ⇒ SI-4b「首次发生晚于证据」 |

## 2 · 副本对照（同一批 3338 引用）

| SI 指标 | 活库（--all 基线） | T349 副本 | **T350 副本** |
|---|---|---|---|
| pass | 3181 | 3262 | **3262** |
| fail | 214 | 134 | **133** |
| SI-1 | 156 | 75 | **75**（−81） |
| SI-5 | 58 | 58 | **58**（不变，历史欠账） |
| SI-4b | 0 | **1** | **0 ✅** |

**结论**：重指计划在副本上**净减 81 条违规、且不新增任何违规类**。
（修正 T349 的证据误读：SI-5 的 58 条在活库**本来就存在**，不是修复引入的。）

## 3 · 为什么没写进活库

1. 工具**自带安全闸**：`--apply` 指向真库时直接拒绝，要求先复制到临时目录 —— 这是仓库刻意的保护，本刀不绕过它。
2. 合规路径是「副本修好 → 验证 → **替换** claims/ + manifest.json（1.6MB 校验表）」，属于**1153 个文件的覆盖式写入**。
   当前没有并发的归档写入（活库最新 claim 仍是 22:35，1873 = 1873），但这是**凌晨对活库做大规模覆盖**，
   收益（采样闸本来就 pass）与风险不成比例 ⇒ 留给一次**显式、可审计**的操作，而不是自动顺手做掉。

**已备好回滚**：`tmp/claims-backup-20261107-005523`（1873 个文件 / 8.1MB，未删）。
**替换 procedure**（谁来做都照这个走）：
```bash
BK=... # 先备份 claims/
cp -r "$DSH_HOME/memory-context" /tmp/mc && node scripts/repair-support-seq.mjs --apply --store /tmp/mc
node scripts/semantic-check.mjs --store /tmp/mc --all      # 期望 fail ≈133、无新增类
cp -r /tmp/mc/claims/. "$DSH_HOME/memory-context/claims/"   # 覆盖前确认无并发归档
cp /tmp/mc/manifest.json "$DSH_HOME/memory-context/manifest.json"
node scripts/cli.mjs verify && node scripts/patrol.mjs --full
```

## 4 · 验收

- `test/repair-support-seq.test.mjs` **14/14 全绿**
- 全量 **1040 条 / 1034 pass / 0 fail**；`check: PASS`
- 活库 SI：**pass**（采样 30，2 条已知缺口可见）；活库 1873 条 claim 未变
