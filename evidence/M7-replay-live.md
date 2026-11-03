# 真实会话回放（replay-live）

生成时间：2026-11-02T16:41:55.110Z
结论：真实会话 12 局中，**注入 12 局**、沉默 0 局；warn 0。
延迟：p50 8.24ms · p95 19.81ms

| 局 | 注入 | 用户消息数 | scope |
|---|---|---|---|
| ep-c0a5847a | 是 | 2 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |
| ep-8cc34e32 | 是 | 2 | `w:d:/DeepSeek Harness/default-workspace/长期记忆系统` |
| ep-a09a4535 | 是 | 2 | `w:e:/Documents/deepseek-harness/default-workspace` |
| ep-8a73e06b | 是 | 2 | `w:d:/DeepSeek Harness/default-workspace/GOkifu上下文压缩` |
| ep-b79c9e01 | 是 | 2 | `w:d:/DeepSeek Harness/default-workspace/长期记忆系统` |
| ep-1e82afca | 是 | 2 | `w:e:/Documents/deepseek-harness/default-workspace` |
| ep-09fca259 | 是 | 2 | `w:d:/DeepSeek Harness/default-workspace/GOkifu上下文压缩` |
| ep-19df136e | 是 | 2 | `w:d:/DeepSeek Harness/default-workspace/GOkifu上下文压缩` |
| ep-00b50089 | 是 | 2 | `w:e:/Documents/deepseek-harness/default-workspace` |
| ep-d70b7c2f | 是 | 2 | `w:e:/Documents/deepseek-harness/default-workspace` |
| ep-0ef39d3a | 是 | 2 | `w:e:/Documents/deepseek-harness/default-workspace` |
| ep-ce5dbb93 | 是 | 2 | `w:d:/DeepSeek Harness/default-workspace/DSH-GO` |

## 作用域闸的机械核对（2026-11-04 补记，回应 audit-07）
本文件当时只记了 12 局注入表，没记 `crossScopeRefs` 行。今天可复算的口径是 `m5` 的 **A5 = 0.00%**（见 `evidence/M5-six-axis.md`），
而不是"本表里的 0"。以后凡是引用"跨作用域 0"，请引 m5 A5 读数；本表只作"注入是否发生"的证据。
