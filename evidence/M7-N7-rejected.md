# N7 被否决：给类级 claim 补"变体行"对 A2b 严格口径 0 增益（2026-11-03）

## 假设
A2b 两条严格失分源于「同局另一类错误」的代表行。若把同组内判别词重合 <2 的变体行补进 claim 文本，
能否把严格从 17/19 拉到 19/19？

## 做法（隔离，不动真实库）
1. 在 `promoteClaim` 里加 `classVariants()`：同组内挑最多 2 条与代表行重合 <2 的错误行，附在文本后；
2. `archive --store tmp/fresh-store` **全量新建**一个 245 局 / 667 claim 的库；
3. `m5-report --store tmp/fresh-store --root <真实 home>` 复算 A2b。

## 结果
```
严格 17/19（0.8947）· hit 19/19 · claimHits 19/19
multiHop 15/15 · openDomain 2/4
```
**与基线完全一致，0 增益。**

## 原因
两条失分的覆盖 claim 来自**别的类别**（如 `web-search-empty` 的 claim 覆盖了含 hostname 错误的先例局），
变体行只在**同组内**补充，救不到跨组的覆盖 claim。真正要改的是"严格口径的判定对象"（应看先例局里的错误行，
而不是覆盖 claim 的文本），那属于度量口径变更，不是产品改进。

## 处置
- 代码**已回滚**（`src/rooms/claim.mjs` 恢复原状，18 条 claim 单测全绿）；
- 负结果入账：以后不要再提"给 claim 补变体"这条路；
- 保留「严格 17/19 = 类级代表行假象」的结论（`evidence/M7-a2b-strict-artifact.md`）。
