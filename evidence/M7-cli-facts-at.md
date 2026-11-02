# M7 · `cli facts --at`：双时态查询面（2026-11-02）

## 为什么
N1 给 claim 加了 `validFrom/validTo`（0.37.0），但**没有查询面**——`audit` 只数“有效期已止”多少条，
回答不了 Graphiti 那类问题：“这条结论在某天是否成立？”

## 新增（只读）
```bash
node scripts/cli.mjs facts --at 2026-11-02 [--json] [--limit n]
```

- 生效判据：`state ≠ invalidated` 且 `validFrom ≤ at` 且（无 `validTo` 或 `validTo > at`）；
- 起始时间回退链：`validFrom → occurredAt → support 里最早的 occurredAt`（旧 claim 没有 validFrom）；
- `--at` 不可解析 ⇒ 退出码 2；不写 store。

## 本机实测
```
at=2026-11-02T00:00:00Z · 合计 303 · 当时有效 184
at=2020-01-01T00:00:00Z · 当时有效 0        ← 空集，说明时间轴单调
```

## 边界
- 该命令只回答“某时点为真”，**不做时间旅行式推理**（不推断“如果当时…则…”）；
- 没有 `validFrom` 也没有 support 时间的旧 claim 会以无日期形式列出（不伪造日期）。

## 测试
新增 1 条：出生前不返回、截止前有效、过后失效、invalidated 永不返回、非法 `--at` 退出码 2。
