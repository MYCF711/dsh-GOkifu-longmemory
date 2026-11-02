# M7 · 两处「扩召回」实验：实测 0 收益，已回退（2026-11-02）

| 实验 | 做法 | 结果 |
|---|---|---|
| 错误类表 8 → 11 | 增 `path-not-found`(ENOENT) / `json-parse` / `npm-err` | A2 24.32% → 24.32%（0pp）；A5 行数 24→28 仍 0 越界 |
| 首条消息路径实体 | 抽取绝对路径作 `file` 实体参与主题匹配 | A2 24.32% → 24.32%（0pp） |

## 结论
- 两条都不进代码：没有可复算的收益，只增加分支与噪声面。
- 类表停在 8 类（fs/tool/policy/sandbox/web-search/module/permission/timeout）。
- 若将来语料里 ENOENT 类真的跨局重复，先跑一次 A2 对照再决定。

## 复算
`node scripts/archive.mjs && node scripts/m5-report.mjs`。
