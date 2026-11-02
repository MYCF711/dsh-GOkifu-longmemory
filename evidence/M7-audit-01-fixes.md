# 审计 audit-01 的处理结果（2026-11-02）

审计报告：[`reports/audit-01.md`](../reports/audit-01.md)（独立子代理，只读；结论**有条件通过，无 P0**）。

## P1（5 项）全部处理

| # | 问题 | 处理 | 证据 |
|---|---|---|---|
| P1-1 | `validFrom` 未落地，却宣称已落地；N1 测试是空壳 | **代码修复**：`promoteClaim` 落 `validFrom = occurredAt`；测试改成真断言（fixture 非空） | `src/rooms/claim.mjs`；`test/claim.test.mjs`「N1: 每条 claim 的 validFrom 等于 occurredAt」；本机库 322 条中 296 条有 `validFrom`（26 条历史条目无 `occurredAt`，按只增不改不回溯） |
| P1-2 | claim 文本随输入顺序变、`class:` 前缀丢失 | **代码修复**：新增 `representativeTextFor()`，建组与"更早支撑"两条路径共用；新增乱序一致性测试 | `src/rooms/claim.mjs`；`test/claim.test.mjs`「P1-2: 输入顺序不影响代表文本」；历史 16 条无前缀 claim 不回溯（只增不改） |
| P1-3 | `AGENTS.md` 状态写死 0.19.1/353 条 | **删除快照，改成指针表**（版本/测试/六轴一律看 `MAINTENANCE.md`）；`check.mjs` 断言指针存在，写回数字会红 | `AGENTS.md` §7；`scripts/check.mjs` |
| P1-4 | 仓库实际 public，台账写"私有"；main 无保护 | **口径统一为"公开"**；并给 `main` 开分支保护：require PR + required check `rules`（禁 force push / 禁删除） | `AGENTS.md` §0、`MAINTENANCE.md`；`gh api .../branches/main/protection` 返回 200（strict + contexts:[rules]） |
| P1-5 | A1 的 0% 是空转（validity 覆盖 0/23），护栏仍判 PASS | `metrics-guard` 增 `a1Vacuous/a1Coverage`，摘要行显式打印「A1=0（空转：validity 覆盖 0）」；台账同步改写 | `scripts/metrics-guard.mjs`；`MAINTENANCE.md` 六轴行 |

## P2（9 项）

已修：
- **P2-1** 巩固只吃 `kind=antipattern`（契约 §12 相符）；契约补「迁移说明：对新库基本空转」。
- **P2-2** 契约 §9 标注 `repeat` 为派生字段、`threadIds`/`supersedes` 为保留字段（无生产者）。
- **P2-3** 台账数字改为**带时间戳 + 可复现命令**；一次性指标（当天覆盖 18/18）移出表格。
- **P2-4** 门槛证据 `evidence/M7-metrics-guard.md` 同步为 ≥0.55；今后门槛改动单独一刀（`metrics:` 开头）。
- **P2-6** 删除 `DEFAULT_CONFIG` 里重复的 `autoBuild`；键数 18（16 产品键 + 2 测试钩子）。

未修（写明理由，留作候选）：
- **P2-5** 4 条"真实样本"测试永久 skip：需要把该会话 graph 基线脱敏后固化进 `evidence/samples/`，属独立一刀。
- **P2-7** 闸对 `请/建议/记得` 等词整卡拦截：属产品取舍（preference 逐字引文是否豁免），需一条 Q 记录。
- **P2-8** `boundary-audit.mjs` 缺位：静态扫描与运行时闸重复度高，需先定"扫哪些字面量"的口径。
- **P2-9** main 分支保护：**已实际开启**（见 P1-4），不再是缺项。

## 审计后实测

```
node scripts/check.mjs        → check: PASS（新断言：AGENTS §7 指针）
node --test                   → 388 条（384 pass / 0 fail / 4 skip）
node scripts/metrics-guard.mjs → PASS · A1=0（空转：validity 覆盖 0） A5=0 A6=1 A2b严格=0.842(n=19) p50≈2ms
node scripts/cli.mjs audit    → claim 322 / 卷 143 / 有效期已止 25 / 无支撑 0
```
