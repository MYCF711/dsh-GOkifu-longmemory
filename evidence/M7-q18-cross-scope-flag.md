# Q18 预留实现：`crossScopeClass` 开关（2026-11-02，默认关）

## 做了什么（默认关闭，行为不变）
- 配置 `crossScopeClass`（默认 `false`）：打开后，**只有** `class:*` 类级章节可以用跨工作区先例承载证据；
- `walk` 新增 `allowCrossScopeClass`：类级 claim 可直接用跨域支撑局做证据（不再要求该局本身进入命中），
  并记录 `why: ['class:cross-scope']`；
- `inject` 渲染：证据局作用域与当前不同 ⇒ 行尾标 **`[跨项目]`**（放在 `(` provenance 之前，不破 `PROVENANCE_LINE_RE`）；
- `m5-report` 的 A5：含 `[跨项目]` 的行**不进主 A5 的分子/分母**，单独计 `crossMarkedLines`（A5-class 分桶）。

## 实测
- 默认（关）：A5 = 0.00%（29 行）、跨标记行 0 —— 行为与 0.48.0 完全一致；
- 单测（开）：类级 claim 挂上、卡片出现 `[跨项目]`；关闭时不挂。
- 378+1 条测试全绿。

## 待主人裁定（Q18）
- 选 A（保持现状）：此开关永远关，代码留着不启用；
- 选 B（受限放开）：把 `crossScopeClass` 设为 true，并把 A5 与 A5-class 两个数一起报；
  同时**新建第二份冻结考卷**（把「只有跨项目先例」样本纳入），不改原 19 条。
