# M7 · 类表扩展 + class 主题不冒充 same-error（2026-11-02）

## 改动
1. `topic.mjs` 的类表从 5 类扩到 8 类：新增 `module-missing`（Cannot find module / ERR_MODULE_NOT_FOUND）、
   `permission-denied`（EACCES/EPERM/perm denied）、`timeout`（timed out/timeout/ETIMEDOUT）。
2. `link.mjs`：`class:*` 主题**只建 shared-topic 边**，不再进入 `same-error` 分组
   （否则同一对棋谱会出现两条 same-error，实测 R05 测试红：2 !== 1）。
3. 回退死代码：N2 的多词兜底分支永远不会执行（S10 单条词兜底已先命中），已删。

## 实测（本机 116 局）
| 轴 | 0.23.0 | 本次 |
|---|---|---|
| A2 收益（LOO） | 23.61% | **24.32%**（+0.71pp，n=148） |
| A1 负迁移 | 0.00% | 0.00% |
| A4 p50 | 1.78ms | 2.30ms（仍远低于 50ms 门限） |
| A5 / A6 | 0.00% / 100% | 0.00% / 100% |

## 说明
- N2（BM25）本轮**未落地**：单条词兜底已覆盖同样的召回路径，多词分支是死代码；
  真要做 BM25 需要独立倒排索引与单独的精度评估，见 `M7-N2-rejected.md`。
