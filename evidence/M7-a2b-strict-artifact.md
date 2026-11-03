# A2b 严格口径的两个失分：是"类级代表性文本"的度量假象，不是召回失败（2026-11-03）

## 事实
`node scripts/m5-report.mjs` 新增诊断字段后（`hitByClaim` / `bestOverlap` / `bestText`），19 条冻结卷实测：

```
hit 19/19 · hitByClaim 19/19 · 严格 17/19
multiHop 15/15 严格 · openDomain 2/4 严格
```

两条失分明细：

| 目标签名 | 覆盖它的 claim 文本（截断） | 判别词重合 |
|---|---|---|
| `error: url hostname "raw.githubusercontent.com" resolves to …` | `class:web-search-empty · Error: DeepSeek returned no web_search_tool_result blocks…` | 1 |
| `json.decoder.jsondecodeerror: expecting value: line …` | （文本与判别词 0 重合） | 0 |

## 机理
1. 冻结卷里这两条目标签名的 **prior 局**（`ep-8cc34e32` / `ep-1e82afca`）里同时出现过**别的错误**；
2. claim 按「类别 + 作用域」分组，文本取组内**代表性错误行**；
3. 于是"命中了这条 prior 局"的 claim，文本描述的是**同局另一类错误**，判别词自然对不上。

## 结论
- **召回没有失败**（hit 与 hitByClaim 都是 19/19）；严格口径扣分来自"代表性文本"的选择，不是卡片没找到先例；
- 这与 A2b 分桶的结论一致：openDomain 是唯一失分桶，且失分与跨工作区无关，而是**类内变体**问题；
- 因此**不要**为这两条改排序或开跨工作区（Q18 的 B 也救不了它们）。

## 若要真修（待评估，不动手）
把 claim 文本从"一个代表行"扩展为"代表行 + 最多 1 条与代表行判别词重合 <2 的变体行"，
需要 ① 重新归档/重建 claim；② 对照 A2b 与 token 成本；③ 确认不会让卡片超预算。**本次不做**，先记账。
