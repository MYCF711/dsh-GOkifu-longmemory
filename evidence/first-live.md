# 首次上线复盘（first-live）

- 版本：`0.117.0` · 生成于 2026-11-03T23:57:40.161Z
- 结论：**已上线（注册无禁用 + 六轴门槛通过）**

## 1 · 注册与热路径

| 项 | 值 |
|---|---|
| 注册状态 | $DSH_HOME\profiles\desktop\package.json, $DSH_HOME\profiles\desktop\cordis.patch.yml · 启用 1 处 · 禁用 2 处 |
| 热路径抽测 | runs=5 injected=4 empty=1 failed=0 warn=0 p95=33.5ms |
| install-doctor | PASS |

## 2 · 六轴（metrics-guard）

| 轴 | 值 | 门槛 |
|---|---|---|
| A1 负迁移 | 0.00% | ≤5% |
| A4 p50 | 2.03ms | ≤50ms |
| A5 越界 | 0.00% | =0 |
| A6 溯源 | 100.00% | =100% |
| A2b 覆盖 | 100.00% | =100% |
| A2b 严格 | 84.21%（n=19） | ≥0.55 |
| 门槛判定 | PASS | — |

## 3 · 影子台账（本来会注入什么）

影子台账不存在（尚未开 `shadow:true` 或还没产生记录）。

## 4 · D5 二次命中（repeat-hint 遥测）

没有遥测（真注入后才会产生；影子模式不写）。

## 5 · 下一步

1. 观察 1–2 天：`node scripts/repeat-report.mjs`、`node scripts/shadow-report.mjs`；
2. 任何回归先跑 `node scripts/metrics-guard.mjs`，按它给出的轴定位；
3. 需要“某时点为真”的核对时用 `node scripts/cli.mjs facts --at <日期>`。

