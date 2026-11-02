# N1 · 双时态：claim 的 validFrom / validTo（2026-11-02）

## 机制（Zep/Graphiti 的 claim 侧落地）
- 出生：`validFrom = occurredAt`（首条支撑的发生时间），`validTo = null`。
- 终止只在两种情况下发生，且**都不改原文、不删条目**：
  1. **人纠错**（L4, decision=correct）⇒ `validTo = 纠错时间`（取更早者，不覆盖既有终点）；
  2. **核验失败**（validityOk=false）⇒ `validTo = 本次核验时间`。

## 为什么不给 claimEdge 加字段
`claimEdge` 目前没有 store 消费者（边尚未落盘），先给有消费者的 claim；等边真正落盘时再镜像这套字段，
避免"加了没人读"的字段（AGENTS §2.4 指标先有消费者）。

## 实测（本机 116 局 store）
```
claim 295 条 · 有效期已止 22 条（全部来自 validityOk=false）
metrics-guard PASS · A1=0 A5=0 A6=1 A2b严格=0.611（n=18） 覆盖=1 p50=2.02ms
```

## 说明
- `cli audit` 现在会报「有效期已止」数量；它与「过期(validityOk=false)」当前同源（22 条），
  等出现人纠错样本后会分开增长。
- 下一步（时间线查询）需要真实的 `validTo` 样本；本机当前没有 L4 纠错记录。
