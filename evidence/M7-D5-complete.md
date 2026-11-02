# D5 收口：会话内二次命中（2026-11-02）

目标 ④ 要求：**同类失败 ≥2 次 ⇒ 补一次事实卡；仍过十道闸、无祈使句**。逐条给证据。

## 1. 触发是机械的
`src/plugin.mjs` 的 `collectRepeatTrigger(state, messages)`：
- 只看**新增消息**里的错误行；
- 用 D2 的 `errorKeyOf` 归并同类（不是字面相同）；
- 达到 `repeatHintAfter`（默认 2）才触发；
- 每会话最多 `repeatHintMax`（默认 1）次。

## 2. 补卡是真注入，且不是"绕过首轮"
`decidePreStep` 复用首轮同一条路径（walk → buildMemoryCard → runGates），
所以 D5 与首轮**共享同一套闸与预算**。
测试：`test/plugin.test.mjs`「D5: 同类失败第二次出现才触发，且每会话只补一次」——
第二次同类失败拿到 `CARD:` 前缀的注入消息；第三次不再补。

## 3. 闸不过就不补（本轮新增）
测试：`test/plugin.test.mjs`「D5: 闸不通过 ⇒ 不补卡（不绕过十道闸）」——
`runGates → {ok:false}` 时第二次同类失败**没有任何注入消息**。

## 4. 无祈使句
D5 注入的是事实卡（`- [antipattern] <错误原文> (ep-…, 日期, seq N)`），
渲染路径与首轮完全相同；祈使句由 `gates` 的 `IMPERATIVE_PATTERNS` 检查，
并新增**静态**边界审计（`scripts/boundary-audit.mjs`）在 PR 阶段守源码字面量。

## 5. 可观测
- 真注入后写 `repeat-hint.jsonl`（`shadow:false`）：`{at, cls, count, tokens, digest}`；
- 影子模式（`shadow:true`）只记录"本来会补"、**不改 messages**（0.57.0 单测）；
- `node scripts/repeat-report.mjs` 汇总触发率与类别分布；无台账退出码 2。

## 6. 对六轴的影响
D5 只在**同一会话内**、同类失败重复时触发，冻结考卷（A2b）是跨会话静态评估，
因此不改变 A2b 严格 84.2%；A1/A5/A6 由闸保证不变。

## 结论
**目标 ④ 完成**。剩余未验证项只有"A3 线上"——需要一次真实安装（见 `evidence/M7-install-gate.md`）。
