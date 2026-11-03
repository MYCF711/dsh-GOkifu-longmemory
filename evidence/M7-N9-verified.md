# N9 接线实测：能取到真实失败原文，但被 A5（同作用域）挡住（2026-11-03）

## 接线内容
`buildMemoryCard` 在收集条目时，额外按**签名**查 `<store>/signature-index.json`：
命中就追加一条带完整 provenance 的条目（`episode + seq + occurredAt` + 原文 snippet），每信号 ≤2 条，**只追加不替换**；
作用域必须与卡片一致（A5）。归档成功后自动重建索引（失败只记一行，不影响归档结论）。

## 关键验证：作用域对齐时，卡片第一行就是那条真实失败
以签名 `error: url hostname "raw.githubusercontent.com" resolves to a non-public ip address`
、用**先例局所在作用域**建卡：

```
<memory-ledger>
- [antipattern] Error: URL hostname "raw.githubusercontent.com" resolves to a non-public IP address (ep-8cc34e32, 2026-11-02, seq 7148)
- [antipattern] SyntaxError: missing ) after argument list at checkSyntax (…) (ep-8cc34e32, 2026-11-01, seq 13061)
…
```

对上了：真实原文（边 `e748`）、正确序号（7148）、日期（2026-11-02）。

## 但在现行 A5（同作用域）下，A2b 指标**没有变化**
```
hit 19/19 · claimHits 19/19 · 严格 17/19 · 可读 17/19
multiHop 15/15 · openDomain 2/4 · A1=0 · A5=0 越界 · A4 4.5ms
```
原因：可读性缺失的两条**正是 openDomain 那两条**——它们的先例局在别的工作区，按 A5 被正确挡掉。

## 结论
- **A2b 89.5% 的天花板是 A5 造成的，不是检索能力**；N9 把"能取到"这件事做实了；
- 若 **Q18 = B**（类级章节允许跨工作区、卡片标 `[跨项目]`），这两条会被 N9 直接补上真实原文；
- 只要 **Q18 = A**，A2b 严格就是 17/19，且 A5 越界保持 0 —— 这是**设计选择**，不是缺陷。
