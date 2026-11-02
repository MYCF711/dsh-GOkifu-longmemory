# M6 · D4 失败→修复配对：试做后否决（2026-11-02）

## 做法
在 claim 上挂 `fix`：同路径、同 episode、更晚的成功 quote（机械配对，不推断因果）。

## 实测（全量 248 条 claim）
只出 **2 条**带 fix，且**两条都是错的**：

| claim | 配到的“修复” | 为什么错 |
|---|---|---|
| `grep search failed ... tmp\dsh-di...` | `edit(file_path=...\package.json)` | 路径不同、工具不同，只是同 episode 里更晚的成功 |
| `offset 840 out of range ... lingxi-repo/tests/agent.test.mjs` | `edit(file_path=.../agent.test.mjs)` | 同一文件但因果无关（offset 越界 vs 编辑文件） |

## 结论
- 精度 ≈ 0%，**比不做好**（会让模型把无关成功当“上次这样修好的”）。
- 已回退实现，只保留这份证据；D4 不再默认启用。

## 若要重做，前置条件
- 需要“失败原因”和“成功动作”的**同因判定**（例如同一 tool + 同一参数键 + 失败后 3 步内），而不是同路径；
- 或由 L2 多成员裁决分级，人工抽检 ≥20 条、精度 ≥80% 才允许上线。
