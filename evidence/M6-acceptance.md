# M6 · 验收（D1/D2/D3 + 两处回归修复，2026-11-02）

## 六轴（`node scripts/m5-report.mjs`，本机 store 116 局）

| 轴 | 指标 | 值 | n | 状态 |
|---|---|---|---|---|
| A1 | 负迁移 | **0.00%** | 11 | measured（硬上限 ≤5%） |
| A2 | 收益（不重复踩坑，LOO） | **21.97%** | 132 | measured |
| A3 | 可靠性 | 0.00% | 25 | not-live（未在宿主真跑） |
| A4 | 延迟 p50 | **1.89 ms** | 50 | measured（p95 ≈3ms） |
| A5 | 作用域隔离 | **0.00%** | 22 | measured |
| A6 | 可回溯 | **100%** | 22 | measured |

## 本轮修掉的两个回归（都是指标先跳出来的）

### R1 · A5 跨域越界 34.62% → 0.00%
- 现象：D2 把同类失败合并到 `u:` 层后，卡片用**别的工作区**的棋谱承载证据 ⇒ 独立复核 9 行越界。
- 修法：claim 必须用**同作用域的棋谱**承载证据；`scope=null`（只放用户层）时跳过该检查。
- 代价：`u:` 层 claim 在没有本域证据的工作区不出现（`test/walk.test.mjs` 已改口径）。

### R2 · A1 负迁移 8.33% → 0.00%
- 现象：入馆时的 validity 核验结果没有落进 claim，过期 claim 被当当前事实注入。
- 修法：归档时 `runValidityCheck` 一次，把 `validityOk` 写进 claim；walk 跳过 `validityOk=false`（本机 20 条过期、1 条有效）。
- 口径：核验失败 ≠ 删除；原文与 support 保留，只遮蔽注入。

## 回归
`node --test` 353 条（349 pass / 0 fail / 4 skip）；`node scripts/check.mjs` PASS。
