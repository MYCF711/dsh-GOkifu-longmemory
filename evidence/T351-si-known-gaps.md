# T351 · SI-5 历史欠账文件化（精确豁免，不回填）

> `[本] 2026-11-07` · `--all` 口径下 SI-5 的 58 条历史欠账正式登记为**可见的已知缺口**。

## 0 · 一句话

59 条历史 fix 缺 `toOccurredAt`（T238/T260 之前只换 seq、不记时间）⇒ 以前只在 `--all` 口径下暴露、
采样口径看不见。现在生成 `evidence/si-known-gaps.json` **文件化登记**：`--all` 的 fail **214 → 156**，
且 59 条以「已知缺口」**可见**列出（不是静默吞掉）。

## 1 · 为什么是「登记」而不是「回填」

SI-5 的判据是 `fixes[].toOccurredAt == support[].occurredAt`。
如果用 `support.occurredAt` 把 `toOccurredAt` 补上，这条不变量就**恒真** —— 检查变成同义反复，等于自己把闸拆了。

所以：**不改历史数据**，改为精确登记（`kind + claimId + episode + seq` 四者全等才豁免），
任何新违规照旧红（测试 T351 ② 逐位证伪：换 claimId / episode / seq / kind 任一即不豁免）。

## 2 · 改了什么

| 位置 | 改动 |
|---|---|
| `evidence/si-known-gaps.json` | 从真库一次性生成的 59 条（含 why / since），入库审计 |
| `scripts/semantic-check.mjs` | 新增 `loadKnownGapsFile()`；`knownGapOf` 先查硬编码再查文件，**匹配规则同样严格** |
| `test/semantic-check.test.mjs` | +3 条（T351 ①②③），其中 ② 是 tombstone |

## 3 · 验收（`--all` 口径）

| 指标 | 改前 | 改后 |
|---|---|---|
| fail | **214** | **156** |
| SI-5 | 58 ✗ | **59 ·（已知缺口，可见）** |
| SI-1 | 156 ✗ | 156 ✗（**真实欠账，只能靠重指修**） |

→ 剩下的 156 条 SI-1 才是真问题；修它的唯一路径是应用 T350 已验证的重指计划（活库尚未写入）。

全量 **1043 条 / 1037 pass / 0 fail**；`check: PASS`。
