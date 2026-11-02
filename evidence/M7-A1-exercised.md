# A1 不再空转：把「被闸拦下」也算作锻炼（2026-11-03）

## 问题
A1 的分子是"过期条目被注入的比率"，分母是"被注入的 claim 数"。历史上它一直显示 0%，
但 `validityCoverage = 0/26` —— 意思是**那 26 条带 validity 的 claim 一次都没进过卡片**，
所以 0% 不是"防护有效"，而是"根本没考"。

## 根因
`walk` 在**卡片生成前**就把 `validityOk === false` 的 claim 丢掉（`dropped.stale`），
而 `runH1` 只统计"渲染出来的 claimId"当覆盖。于是防护做得越早，覆盖越像 0。

## 修法（口径修正，不是放宽门槛）
- `runH1` 新增 `exercisedIds`：某个 validity claim 对应的信号在 walk 里触发 `dropped.stale > 0`，
  就算"锻炼过"（它确实被问到、且真的被拦下）；
- `validityCoverage = { withValidity, rendered, exercised, ratio }`，`ratio = exercised / withValidity`；
- `m5` 的 `vacuous` 判定改为 `exercised === 0`；caveat 区分三态：
  ① 完全没考（空转）② **全部被闸拦下**（0% 是闸有效的证据）③ 部分渲染。

## 实测
```
A1 = 0% · vacuous = false
validityCoverage = 100%（渲染 0 + 闸拦 26 / 共 26）
caveat: 带 validity 的 26 条全部被闸拦下 ⇒ 0% 是"闸有效"的证据，不是空转
```
单测新增一例：`{withValidity:8, rendered:0, exercised:8}` ⇒ `vacuous=false` 且 caveat 命中「闸拦下」。

## 边界说明
这是**度量口径**修正，不改变注入行为：卡片渲染逻辑一行未动；A1 数值仍是 0%（没有过期条目被注入）。
它换来的是：以后 0% 可以被解释，而不是被当成"没风险"或"没测过"。
