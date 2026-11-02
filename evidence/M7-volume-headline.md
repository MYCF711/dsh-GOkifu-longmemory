# M7 · N9 卷首摘要（机械化，2026-11-02）

## 是什么
每卷（thread）新增 `headline` 字段，归档时**机械拼接**：

```
<class 名> · <N> 局 · 最近 <YYYY-MM-DD> · 代表：<最早一局 l0 ≤60 字>
```

不调模型、不生成新文本（区别于 Generative Agents 的"模型反思"，见 `docs/调研/14`）。

## 消费方
- `node scripts/cli.mjs volumes`：直接打印 headline（人/模型都能一眼看出这卷是什么、多大、多新）；
- `docs/数据契约.md` §4.4 已补字段；
- **不进入注入路径**（卡片仍只放 claim/棋谱证据），所以 A1/A5/A6 不受影响。

## 实测
```
卷（棋书视图，只读）：142 个 · 类级主卷 4 个
- class:module-missing · 7 局 · 最近 2026-11-02 · th-7520f349 · 主卷
- class:fs-read-before-write · 6 局 · 最近 2026-11-02 · th-ded39fb5 · 主卷
```
`metrics-guard PASS`：A1=0 A5=0 A6=1 A2b严格=0.6316（n=19） 覆盖=1 p50=2.24ms

## 后续（若要用进注入）
需要先证明"卷首行不会挤掉真正有用的 claim"：做法是把卷首行作为候选，跑 A2b 严格 + token 增量对照；
未证明前不进卡片。
