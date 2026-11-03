# A3 首次真实注入（2026-11-04 05:24 起，宿主写入）

## 首条（`src=index.js`，宿主进程 pid 36056）
```json
{"at":1793741065587,"src":"index.js","pid":36056,"kind":"pre-step",
 "scope":"w:d:/DeepSeek Harness/default-workspace/DSH-GO","scopeFrom":"session-log",
 "action":"inject","digest":"6a3577fa77b349df","tokens":239,"shadow":false}
```
时间：2026-11-04 05:24:25（本地）。

## 规模（同一进程内，截至 05:35）
```
宿主行 11451 · inject = 14 · skip = 11437
tokens：p50 35 · p95 239 · max 344
```
注入覆盖的作用域包括 `…/DSH-GO`、`…/反代`、`…/反代/wps`、`…/长期记忆系统` —— 两类兜底（`session-log` / `episode-fallback`）都在真实注入里出现过。

## 本次会话里可见的那一张卡
```
<memory-ledger> … 362 局 · 未列出≠不存在
- [antipattern] Error: this destroys the runtime … (ep-8cc34e32, 2026-11-02, seq 16741)
- [antipattern] class:sandbox-limit · Error: tool call aborted (…, seq 2560)
…
</memory-ledger>
```
（即用户消息里出现的那段；digest `8a3daac88d10a84a`、299 tokens）

## 结论
- **A3 从 `live-idle` → `live`**：不止"有心跳"，而是宿主真的把记忆卡注进了模型上下文；
- 修掉的两个真因都得到了线上确认：N10 作用域兜底（`scopeFrom` 有值）+ 0.112 消息工厂本地兜底（不再报 `Cannot find package`）；
- 口径仍严格：只统计 `src=index.js`；3 条 `src:sim-inject.mjs` 的仿真行不计入。
