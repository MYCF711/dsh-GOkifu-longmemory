# N10 · 人纠错（L4）机械回填（2026-11-02）

## 机制
`claim.mjs` 新增 `applyAdjudications({claims, adjudications})`，归档时调用：

- 只认 `level === 'L4-human-correction'` 且 `decision === 'correct'`；
- 给目标 claim **追加 counter 证据**（episode=`human:owner`、quote=纠错原文、at=纠错时间）；
- 把 `state` 标成 `disputed`；**原文、support、条目都不改不删**；
- 幂等：同一纠错重放两次不重复加 counter；
- L2 裁决与 `hold-disputed` 不动 claim。

## 为什么这样做
Cognee 的 `improve` 是「用反馈丰富记忆」。我们不调模型，只做它的机械子集：
**人指出的错误 = 最高优先级证据**，落账为 counter + disputed，供后续卡片显式标 `[disputed]`。

## 实测
- 单测：L4+correct 命中、L2/hold 不动、幂等 3 个断言组全过（360 条测试全绿）。
- 本机 store 当前 **0 条 adjudication**，所以线上没有可回填样本；六轴本轮未受影响。
- 附注：本轮重建后 A2 显示 24.67%（前 24.32%），但**无 L4 样本**，该变化归因于语料刷新，不计入 N10 收益。

## 下一步
需要有真实的人纠错样本（主人或 L4 流程产出 adjudication）后再评估 A1/A2 影响。
