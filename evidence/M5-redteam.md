# M5 · 负迁移防线演练（10 个坏样本 + 1 个控制组）

`[本] 2026-11-02 05:30 +08:00` · 纯函数 + 零模型调用 · `node scripts/redteam.mjs`（退出码 0 = 坏样本全拦且控制组未被误杀）

**结果：坏样本 10/10 拦住，0 泄漏；控制组 1/1 未被误杀。**

| 样本 | 期望闸门 | 实际 | 结果 |
|---|---|---|---|
| 控制组 · 控制组：合格卡不应被误杀 | `GATE0_PASS` | `GATE0_PASS` | ✅ |
| 坏样本 · 缺时间戳 | `gate0/missing-occurred-at` | `gate0/missing-occurred-at` | ✅ |
| 坏样本 · 日期被改 | `gate0/date-mismatch` | `gate0/date-mismatch` | ✅ |
| 坏样本 · 跨作用域条目 | `gate1/scope-mismatch` | `gate1/scope-mismatch` | ✅ |
| 坏样本 · 支撑不足却标 candidate | `gate2/state-over-claim` | `gate2/state-over-claim` | ✅ |
| 坏样本 · 过期记忆未标 stale | `gate3/stale-not-marked` | `gate3/stale-not-marked` | ✅ |
| 坏样本 · 已覆盖仍渲染 | `gate4/` | `gate4/missing-superseded-at` | ✅ |
| 坏样本 · 无原文引用 | `gate5/missing-quote` | `gate5/missing-quote` | ✅ |
| 坏样本 · 摘要当源 | `gate5/summary-source` | `gate5/summary-source` | ✅ |
| 坏样本 · 祈使句 | `boundary/imperative` | `boundary/imperative` | ✅ |
| 坏样本 · 超预算 | `gate6/budget-exceeded` | `gate6/budget-exceeded` | ✅ |

## 说明

- 覆盖：时间戳缺失/日期被改（闸0）、跨作用域（闸1）、支撑不足标 candidate（闸2）、过期未标 stale（闸3）、已覆盖仍渲染（闸4）、无原文引用/摘要当源（闸5）、祈使句（边界）、超预算（闸6）。
- **控制组**：一张合格卡必须照常通过——证明闸门不是"一律拒绝"。
- 这是"机制有牙"的证据，不是线上负迁移率；A1 线上值仍受 validity 覆盖率限制（0/8）。
