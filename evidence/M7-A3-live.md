# A3 线上：插件已经在宿主里跑（2026-11-03 20:09 起）

## 判据与证据
`<DSH_HOME>/memory-context/live-stats.jsonl` 出现并持续增长：

```
1484 行 · 2026-11-03 20:09:20 → 20:40:53
动作：skip=1484（no-signal=1428 · no-hit=56）
tokens：p50 35 / p95 35 / max 35
```

心跳行由插件在每次 `agent/pre-step` 写入，`src=index.js`（宿主加载器）、`pid` 稳定 ——
**这条文件本身就是"插件真的在宿主里跑过"的硬证据**。

## 同时做的完整性检查
```
cli verify：OK · 文件 5485 · 字节 8,455,670 · 错误 0 · 告警 0
store：267 局 / 761 claim（宿主内 autoArchive 已把新会话归档）
```

## A3 的准确表述
- **不是 `not-live` 了**：插件已加载、钩子已在工作；
- 但**还没有一次真正的注入尝试**：当前会话的信号没命中（`no-signal` 1428 / `no-hit` 56），
  所以 `m5` 把 A3 报成 **`live-idle`（value=null）**——不能把 null 当 0，也不能说"注入可靠性已验证"。

## 什么会让 A3 变成 `live`
下一次**信号命中**（例如会话里出现与库中失败签名相关的错误/关键词）时，心跳会出现 `action=inject`。
届时 `live-stats` 的 `inject` 计数 >0，`m5` 的 A3 自动变 `live`，失败率按 `injected+failed` 计。

## 结论
A3 从 `not-live` → **`live-idle`**：能力与加载路径都已确认，等待第一次真实命中。
