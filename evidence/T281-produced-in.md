# T281 · "同局产出"（produced-in）边：验证与原型

> `[本] 2026-11-06 02:20 +08:00` · **只读**（不写库、不改检索、零模型调用）
> 脚本：`scripts/produced-in-edge.mjs`（新建，只读）· 测试：`test/produced-in-edge.test.mjs`
> 考卷与判据：`scripts/a2b-holdout.mjs` 的 `buildExam` / `judgeCard`（**一字未改**）+ `scripts/recall-coverage.mjs` 的四类判定（A > D > C > B）

## 0 · 一句话结论

**核心假设被证伪：加"同局产出"边带来 *0* 条净命中。**
56 条 B 拆开是 **29 条"其实已经取到"**（卡上已有该局 claim，只是判据的"≥2 判别词重合"不认）
\+ **27 条"walk 从未命中该局"**（缺的是**主题/入口**，而它们的 claim 与任务原话词面重合 **26 条 = 0、1 条 = 1**，即使补上这条边也过不了 ≥2 的门槛）。
主判据 **34.21% → 34.21%**；A5 违规 **0**。

## 1 · A 阶段：对 self/root 的 56 条 B 逐条核（真库实跑）

```
$ node scripts/produced-in-edge.mjs
T281 · produced-in 边验证 · 考卷 n=114 · 基线 A=39 B=56 C=0 D=19

主判据（严格命中率）：34.21% → 34.21%（下界）· 上界 35.09%

B 类 56 条：
  · 该局确有 claim：55 条
  · 绕过 walk 直接可取到：55 条 ⇒ 缺的是边，不是内容
  · 该局已被 walk 命中（只是 claim 排不进去）：29 条
  · 其实已取到（卡上已有该局 claim，只是没到严格口径）：29 条 ⇒ 这类不是检索问题
  · 真没取到（卡上没有任何该局 claim）：27 条，其中加边后能变 A 的 0 条
  · 加边后变 A：0 条（下界）· 上界 1 条 · 净新增 0 条（上界那条其实已在卡上）
  · judge 口径 overlap 分布：{"0":50,"1":5,"3":1}
  · A5 违规（带进卡的跨域 claim）：0 条（该局含跨域 claim 的行 43 行 / 共 202 条 claim —— 全部不建边、不进卡）

produced-in 边原型：1576 条（覆盖 1510 条 claim）· 跳过 {"crossScope":373,"missingEpisode":0,"noScope":0}
```

逐条回答任务书的三问：

| 问题 | 读数 | 说明 |
|---|---|---|
| ① 该局**是否真有 claim**？几条？ | **55 / 56** | 唯一例外 `ep-294c4c1d` 的**第一个** expected episode 无 claim（多 episode 题目，`hasGoods` 靠另一局成立）；每局 claim 数中位数 ~10，最多 156 条 |
| ② **绕过 walk 直接检索**能不能取到？ | **55 / 56** | `store.get('claims', id)` 全部非空、`claimsByEpisode` 全部命中 ⇒ **内容确实在库里** |
| ③ 加边后能变 A 多少条？ | **净新增 0** | 下界 0（把同局 claim 作为 hit 注入卡片后 `judgeCard.hitStrict` 仍 false）· 上界 1（该局存在重叠 3 的 claim，但**那条已经在卡上**） |

## 2 · 为什么"缺边"这条解释只对了一半

把 56 条 B 按"卡上到底有没有该局 claim"切开（`judgeCard.related`）：

| 子类 | 条数 | 卡上状态 | 真瓶颈 |
|---|---|---|---|
| **B1 · 其实已取到** | **29** | 该局 claim **已在卡上**（`related ≥ 1`），只是判据的"≥2 判别词重合"不认 | **判据口径**（与 T246 的 E1a 同源）：`discriminativeTokens` 把中文整段当一个 token，`includes` 几乎不可能命中 |
| **B2 · 真没取到** | **27** | 卡上没有任何该局 claim，且 **27/27 该局从未被 walk 命中** | **主题/入口**（`episodeHitByWalk = 27/27 = false`）：walk 的硬主题没抽到这一局 ⇒ 边（episode→claim）根本没有起点 |

- B1 的 overlap 分布：`{0: 24, 1: 4, 3: 1}` —— 即便把整局 claim 全塞进卡，**24 条**的判别词重合仍是 **0**；
- B2 的 overlap 分布：`{0: 26, 1: 1}` —— 全部 < 2，**加边后仍不满足"≥2 判别词重合"**；
- 也就是说：**"这条边"只能解决"路不通"，解决不了"判据不认"**。要动的是判据（中文二元组 / 硬实体桥）与主题抽取，不是 walk 的边。

## 3 · 误判率（A5 / 同 scope）有没有升

- **A5 违规 = 0**：模拟注入的 claim 全部先过 `normalizeScopeKey(claim.scopeKey) === normalizeScopeKey(item.scopeKey)`；
  库里 43 行 B 含**跨域** claim（共 202 条），**全部不建边、不进卡**；
- 边原型本身也带同一条硬约束：`buildProducedInEdges()` 对跨域（`normalizeScopeKey` 不等）只计入 `skipped.crossScope`（真库上跳过 **373** 条），**不产出边**；
- `related` 判据一字未动（`judgeCard` 原样调用），没有放宽任何门槛。

## 4 · B 阶段：`produced-in` 边原型（**未接生产**，仅资产）

因 A 阶段证伪，**没有**把边接进 `link.mjs` / `walk.mjs`（也没改 `src/**`）。原型留在脚本里，若将来判据口径变了可直接复用：

```js
buildProducedInEdges(claims, episodes) // → { edges, skipped, claimsWithEdges }
edge = {
  id: `pin:${episodeId}->${claimId}`,  // 确定性 id（幂等）
  from: episodeId,                     // 该局（根任务所在的那一局）
  to: claimId,                         // 该局产出的 claim
  kind: 'produced-in',
  why: '同局产出',                      // 每条边必须有 why（契约）
  weight: 1,                           // 机械量：同局 = 1（不引入模型评分）
  scopeKey: claim.scopeKey,
  occurredAt: claim.occurredAt ?? episode.lastEventAt,
}
```

硬约束（`test/produced-in-edge.test.mjs` 8 条用例守着）：

1. **同 scope**：两端 `normalizeScopeKey` 必须相等，跨域只记 `skipped.crossScope`；
2. **同 episode**：只按 claim 自己 `support[].episode` 建边，**不推断、不跨局**（多局支撑 → 每局各一条）；
3. **幂等**：id 由 `(episode, claim)` 决定，重复 support 项/重复调用都只产出一条，输出按 id 稳定排序；
4. **无源/坏输入不抛**：缺 episode 记 `skipped.missingEpisode`、缺 scope 记 `skipped.noScope`，空输入返回空边集。

真库规模：**1576 条边**（覆盖 1510 条 claim），跨域跳过 373 条。

## 5 · 建议（下一步该动哪一层）

1. **别接这条边**（净新增 0，纯增索引体积）；
2. **改判据口径**（收益最大，29 + 26 = 55/56 条受它影响）：`discriminativeTokens` 对中文按"非字母数字即切分"切出整段 run，
   `includes` 要求长串逐字出现 ⇒ 中文题目几乎不可能拿分。建议加**中文二元组 + 硬实体桥**（T248 已有 `sharedHardEntities`，本脚本量到 B 类共享硬实体 = 0，
   说明语料里连实体也没有 ⇒ 更可能是**claim 文本与任务原话真的没有交集**，需要 claim 侧保留"任务原话 alias"）；
3. **主题抽取**（27 条）：这 27 条该局从未被 walk 命中，属 R04 的召回面，不是 R11 排序/边的问题。

> 一句话：**"同局产出"这条边能把 self/root 的 56 条 B 变成命中：0 条（净新增 0，上界 1 且那条已在卡上）；误判率没升（A5 违规 0、跨域 202 条 claim 全部不建边）。**
> 真正的瓶颈是 **29 条判据口径 + 27 条主题入口**，两者都不在"边"这一层。
