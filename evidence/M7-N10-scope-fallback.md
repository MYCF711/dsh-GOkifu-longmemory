# N10：会话作用域兜底（修「插件在跑但永远 no-hit」）（2026-11-03）

## 现象
A3 已 live（1484+ 心跳），但**全是 skip**：`no-signal` 与 `no-hit`，**0 次注入**。
同一条信号在正确作用域下能命中：实测 `Error: file has not been read…` 与整点巡检文本，
在 `w:d:/DeepSeek Harness/default-workspace` 下命中 4–5 条，在 `w:d:/DeepSeek Harness/home/profiles/desktop` 下 **0 条**。

## 根因（与陷阱 3 同源）
宿主会话的 `session.cwd` 可能是 **DSH_HOME 内的 profile 目录**，`scopeKeyFromPath` 就得到一个没有棋谱的假作用域，
walk 按作用域过滤后必然 no-hit —— 插件"跑着但不工作"。

## 修法（两级兜底，都不猜）
1. **episode 兜底**：用本会话历史 episode 的 `scopeKey`（归档时读过日志 header 的真实 cwd）；
2. **日志 header 兜底**：新会话还没归档时，直接读 `sessions/<group>/<sid>/session.v4.jsonl.zstd`
   第一帧（就是 `{"type":"session",…,"cwd":…}`）拿到真实 cwd。
命中包装在 `resolveSessionScope()`，返回 `{scope, from}`，并把 `scope/scopeFrom` 写进心跳便于核对。

实测（真实库 + 真实 session id）：
```
sample episode session 150047cd-… -> w:d:/DeepSeek Harness/default-workspace/长期记忆系统
resolved: {"scope":"w:d:/…/长期记忆系统","from":"episode-fallback"}
```

## 边界
- 只在 `cwd` 落在 **DSH_HOME 内**时才兜底；正常工作目录直接用 cwd，不改变既有行为；
- 兜底失败就保持原样（**不乱猜作用域**，避免 A5 越界）；
- 4 条单测：episode 兜底 / 正常 cwd 不变 / HOME 内无历史不猜 / 新会话读日志 header。

## 预期
下次重启后，心跳会带 `scopeFrom=episode-fallback|session-log`；若信号命中，`action=inject` 会出现 ——
A3 才会从 `live-idle` 变 `live`。
