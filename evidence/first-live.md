# 首次上线复盘（first-live）

- 版本：`0.51.0` · 生成于 2026-11-02T12:16:55.097Z
- 结论：**尚未上线（见下）**

## 1 · 注册与热路径

| 项 | 值 |
|---|---|
| 注册状态 | $DSH_HOME\profiles\desktop\cordis.patch.yml, $DSH_HOME\storages\schedule.json · 其中 4 条 disabled:true（等 re-enable） |
| 热路径抽测 | runs=5 injected=3 empty=2 failed=0 warn=0 p95=15.34ms |
| install-doctor | PASS |

## 2 · 六轴（metrics-guard）

| 轴 | 值 | 门槛 |
|---|---|---|
| A1 负迁移 | 0.00% | ≤5% |
| A4 p50 | 2.04ms | ≤50ms |
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

1. 按 `docs/安装指南.md` §1 三步启用（dry-run → 退出 DSH 执行 re-enable → 重开后 doctor/guard）；
2. 若仍显示 `disabled:true`，说明第 ② 步没有在**退出 DSH 后**执行。

