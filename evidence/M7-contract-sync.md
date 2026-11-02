# M7 · 契约与代码对齐（2026-11-02）

## 背景
`docs/数据契约.md` 只写到 §8（版本与拒绝），而 0.15→0.52 期间新增了一批**已在跑**的结构：
claim 全字段（含 `validFrom/validTo/validityOk/repeat`）、adjudication 回填、thread `headline`、
类级章节自愈（"巩固"）、插件配置项。契约缺失 = 接管者必踩的坑。

## 本次补齐（只改文档）
| 新节 | 内容 |
|---|---|
| §9 claim | 完整字段表 + 四条不变量（只增不改 / 无源不入 / 无时不入 / `validFrom ≤ validTo`） |
| §10 adjudication | 只有 `L4 + correct` 回填；幂等；L2/hold 不动 claim |
| §11 thread | `headline` 机械拼接格式；卷是视图；`class:*` 不套 10% 上界 |
| §12 巩固 | 输入/输出/幂等/副作用/触发条件（与 Mem0 的 consolidate 对齐命名） |
| §13 配置 | 13 个键的默认值；`crossScopeClass` 标注 Q18 未裁定前必须 false |
| §14 版本 | 新字段缺失按 null 处理，旧库不迁移、不重写历史文件 |

## 验证
`node scripts/check.mjs` PASS；`metrics-guard PASS`（A1=0 A5=0 A6=1 · A2b 严格 84.2% · p50 2.04ms）。
本次**无代码改动**，六轴不受影响。
