# M4 线上抽样抓到一个 A5 实质越界（2026-11-04，已补闸）

## 怎么发现的
`0.116.0` 起注入成功会把卡片正文留样到 `<storeRoot>/card-samples.jsonl`。
用新写的 `scripts/audit-card-samples.mjs` 逐条核对「卡片里的 (ep, seq) 是否真属于本卡作用域」：

```
样本 7 张 · 引用 33 条 · 可回溯 33（100.0%）· 同作用域 32 · 跨作用域 1
```

## 那 1 条跨作用域引用
卡片作用域 `w:…/default-workspace/DSH-GO`，但其中一行的出处是 `ep-1cf2b33f`
（属于 `w:…/反代/wps`）。追到源头：

```
c-d296e620  class:sandbox-limit  scopeKey=u:owner  support=[…, ep-1cf2b33f, ep-226dbf4f, …]
```

`u:owner`（用户级）claim 的 support 天然跨多个工作区；注入层此前按 `claim.support[0]`
或"命中局"取一条出处 —— 于是**别项目的失败原文 + ep/seq 被渲染进本项目的卡**。
A6（可回溯）没错（引用确实存在），错在 **A5（按工作区隔离）**：这是实质越界，不是口径问题。

## 补闸（本版）
`entryFromClaim` 增加作用域过滤：**只选与本卡同作用域的 support**；
若该 claim 的 support 全在别的作用域 ⇒ **不渲染**（返回 null，不进卡）。
查不到 episode 记录（测试夹具/库未加载）时不误杀（保留原行为）。

## 验收
- 新增单测 `R12/A5: u:owner 类级 claim 只选同作用域 support`：构造 a/b 两作用域的 claim，断言卡里不出现 `ep-scope0002`；
- 线上口径：`scripts/audit-card-samples.mjs` 的 `crossScopeRefs` 应为 **0**（下次宿主加载本版后重新抽样核对）；
- 离线 `m5` 的 A5 门槛不变（0 越界）。
