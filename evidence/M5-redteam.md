# M5 · 负迁移防线演练（11 个坏记忆样本）

`[本] 2026-11-02 05:20 +08:00` · 纯函数 + 零模型调用 · `node scripts/redteam.mjs`（退出码 0 = 全部拦住）

**结果：11/11 拦住，0 泄漏。**

| 坏记忆样本 | 期望闸门 | 实际 | 拦住 |
|---|---|---|---|
| baseline（合格卡） | `GATE0_PASS` | `GATE0_PASS` | ✅ |
| 缺时间戳 | `gate0/missing-occurred-at` | `gate0/missing-occurred-at` | ✅ |
| 日期被改 | `gate0/date-mismatch` | `gate0/date-mismatch` | ✅ |
| 跨作用域条目 | `gate1/scope-mismatch` | `gate1/scope-mismatch` | ✅ |
| 支撑不足却标 candidate | `gate2/state-over-claim` | `gate2/state-over-claim` | ✅ |
| 过期记忆未标 stale | `gate3/stale-not-marked` | `gate3/stale-not-marked` | ✅ |
| 已覆盖仍渲染 | `gate4/` | `gate4/missing-superseded-at` | ✅ |
| 无原文引用 | `gate5/missing-quote` | `gate5/missing-quote` | ✅ |
| 摘要当源 | `gate5/summary-source` | `gate5/summary-source` | ✅ |
| 祈使句 | `boundary/imperative` | `boundary/imperative` | ✅ |
| 超预算 | `gate6/budget-exceeded` | `gate6/budget-exceeded` | ✅ |

## 说明

- 演练覆盖：时间戳缺失/日期被改（闸0）、跨作用域（闸1）、支撑不足标 candidate（闸2）、过期未标 stale（闸3）、已覆盖仍渲染（闸4）、无原文引用/摘要当源（闸5）、祈使句（边界）、超预算（闸6）。
- 这是"闸门有牙"的证据，不是线上负迁移率；A1 的线上值仍受 validity 覆盖率限制（`evidence/M5-six-axis.md`）。
