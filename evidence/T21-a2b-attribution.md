# T21 · A2b 严格率归因与改进（T12 的另一半）

> 日期：2026-11-08 · 只读归因 + 一处预算口径修复 · 考卷：`evidence/a2b-holdout.json`（n=118 行 / 117 唯一 itemId）
> 基线：`scripts/metrics-guard.mjs` 报 **A2b 严格 46.6%**（快照值 55/118；内容相关 79.66% = 任务里说的"覆盖 79.7%"）。

## 0 · 一句话结论

**A2b 严格 55/118 = 46.61%**。同一份冻结考卷、同一时刻的库上重放：**改前 52/118 = 44.07% → 改后 55/118 = 46.61%**（+3 条，**0 掉分**；宽松 +6 条，0 掉分）。失分 63 条分两桶：

- **57 条 = 文本天生不重合**（该局**没有任何** claim 的措辞能与任务原话达到严格门槛——检索/排序/预算怎么改都救不了；要救只能改判据（任务禁止）或改 claim 的"代表原文"生成（另一层，超出可写路径））⇒ **机械改进收益 0**。
- **6 条 = 有合格条目、但在完整候选池里排名 5–15，被 walk 的 top-5 截掉（排序）** ⇒ 理论上界 +6（**61/118 = 51.7%**），但实测 6 组放宽/重排**全部非正（净负或无变化）**（见 §6），**没有可证明的低风险实现**。

⇒ **目标 ≥50% 在本考卷上没有可用的机械路径**；本刀只交付"预算口径缺陷"修复（+3），其余如实报数为 46.6%，不拿放宽判据或扩大候选换数字（依据：`docs/记忆的职责边界.md` §5、任务约束"不许拿放宽判据换数字"）。

## 1 · 口径（先钉死，否则数字不可比）

| 项 | 值 |
|---|---|
| 考卷文件 | `evidence/a2b-holdout.json`（`generatedAt` 2026-11-07 08:32；`claimsCount` 1657） |
| 行数 / 唯一 itemId | **118 / 117**（`repeat:ep-8a73e06b:222` 重复 1 行——artifact 缺陷，见 §7） |
| 不可重放 1 条 | `self:ep-1e976ca9` 的信号被脱敏成 `session-<REDACTED-UUID>继续这个会话的任务` ⇒ `signalHash` 对不上，`replayFrozen` 会跳过它（n=117）；本报告主表按 **118 行全量**重放（脱敏文本照常参与），另列 117 行对照 |
| 判分 | `scripts/a2b-holdout.mjs` 的 `judgeCard`（与主判据同源代码）：`strict = related ∧ (判别词≥2 ∨ 判别性 bigram≥2 ∨ 硬实体≥1)`；bigram 的 df 过滤用**全库 claim**（与 `runHoldout` 同口径） |
| 当前库 | claims **2277** / episodes **1517**（快照时 1657 / —；库涨了 37%，检索面已不同） |
| 前后对照 | **同一份快照信号 + 同一时刻同一库**，只差本次改动；不重建考卷（不换题） |
| `metrics-guard` 的 A2b | 读的是**快照文件里的值**，代码改动不会自动改它；改它必须重建考卷 = 换题（禁止），所以本刀的前后对照用"重放"而不是改快照 |

**术语**：任务里的"覆盖 79.7%" = 快照的 `contentRate`（**内容相关，不限来源局**）79.66%；`relatedRate`（同局口径）是 66.95%，两者不同，本文分开写。

## 2 · 读数（同一考卷 · 同一库 · 只差本次改动）

| 读数 | 改前（当前库重放） | 改后（当前库重放） | 快照值（metrics-guard 口径） |
|---|---|---|---|
| **严格** | **52/118 = 44.07%** | **55/118 = 46.61%** | 55/118 = 46.61% |
| 宽松（同局） | 74/118 = 62.71% | 80/118 = 67.80% | 79/118 = 66.95% |
| 内容相关（不限局） | 96/118 = 81.36% | 96/118 = 81.36% | 94/118 = 79.66% |
| 卡行合计（118 行）/ 5 行卡（117 唯一） | 400 行 / 38 张 | 493 行 / 74 张 | — |
| 卡片 tokens p50 | 179 | 186 | — |
| 117 个唯一 itemId 对照（去重复行） | 51/117 = 43.59% | 54/117 = 46.15% | — |

> 改前 ≠ 快照值的原因：快照是 11-07 的库（1657 claims），当前库 2277 claims；`self` 题的检索面随库变大而变。**本刀所有前后对比都在同一库同一时刻完成**，不受这个漂移影响。

## 3 · 失分三层归因（改后 63 条）

判定方法（机械，可复算）：对每条考卷，把 `support` 含 expected episode 的**全部** claim 取出，逐条判"**如果它被渲染，会不会满足 strict 的文本门槛**"（`eligible`）。再对三层做区分：

| 桶 | n | 机制 | 证据 |
|---|---|---|---|
| **C · 文本天生不重合** | **57** | 该局 `eligible` claim 数 = **0**：无论检索/排序/预算怎么改，卡片上都凑不出 strict 行 | C1 23 条：卡上**已有**该局 claim（related>0）但全部 strict=false；C2 34 条：卡上连该局 claim 都没有（但文本层同样无解） |
| **A · 命中但排序靠后** | **6** | 有 `eligible` claim，且**在完整候选池里**（walk limit=1000/budget=1e6 可见），但名次 5–15 > top-5 | 名次（0 起）：`[5, 5, 6, 12, 14, 15]`；对应 `self:ep-1710f716 / ep-5cf57bb4 / ep-c650bcea / ep-294c4c1d / ep-f46d6330 / ep-bde12afa` |
| **命中但渲染被丢（预算/闸）** | **0**（改前 3） | 改前 walk 的 token 预算按审计 `why` 扣账，把 3 条合格条目挤掉；已由 §5 修复 | 收益 3 条见 §5；修复后此桶为 0 |
| **检索没命中（合格条目不在候选池）** | **0** | 凡有 `eligible` 的题（6 条），全部能在完整候选池里找到该 claim ⇒ **检索路径不是瓶颈** | `inFull = eligible` 逐条成立 |
| **其它** | **0** | — | 2 条 artifact 问题不参与判分（§7） |

C 桶的分布：`self/root` 44 · `self/shortRoot` 11 · `self/firstUser` 2；信号平均 51 字。典型形态：**中文口语任务原话 vs 英文错误原文/路径**（`处理一下`、`怎么号全崩了？` ↔ `Error: ...` / `/d/DeepSeek Harness/...`），判别词与中文 bigram 都不撞。

## 4 · 每桶"改哪个判据/哪个环节"与预期收益

| 桶 | 可改环节 | 预期收益（条） |
|---|---|---|
| C（57） | **没有机械可改的环节**：判据不变 ⇒ 任何检索/排序/预算都无法让 claim.text 与信号产生 ≥2 判别词/判别性 bigram/硬实体；唯一出路是改 `judgeCard`（任务：**不许拿放宽判据换数字**）或改 claim 的"代表原文"生成（R09/R08 层，不在本任务可写路径） | **0** |
| A（6） | `walk.mjs` 的 `compareHits` 排序键（`_tokOverlap`/depth/repeat/time）或 `inject.mjs` 的 `compareEntries`（卡片重排）。**但**：需要同时改"候选面宽度 + 排序"，实测全部非正（§6） | **理论上界 6**（51.7%）；**实测 0** |
| 预算（改前 3） | `walk.mjs` 的 `hitTokens`：预算口径 = 可见内容，不含审计 `why`/`kind` | **+3（已实现，0 掉分）** |

## 5 · 已实现的改进：walk 的 token 预算不再按"审计字段"扣账

**缺陷（实测）**：`hitTokenText` 把 `hit.why`（via 的主题 key 列表，常带 30+ 个历史 key）和 `hit.kind` 一起计入 token 预算。例：`c-f500b3a9` 正文 38 字 = **22 tokens**，`hit.tokens` 却是 **270 tokens**（why 30+ 个 key 全被计价）。于是 `budgetTokens=500` 的 walk 实际只装得下 **1–2 条**（`limit=5` 形同虚设），卡片被系统性做薄。

**改法**（`src/rooms/walk.mjs` 的 `hitTokenText`）：只估**将来会注入的可见内容** = `episode + claim + text`；`why`/`kind` 是审计字段（给 `path`/provenance 用），不进模型上下文、不计入预算。卡片自身的 500-token 预算与渲染逻辑**一字未改**。

**前后对照（同一考卷、同一库）**：

| 读数 | 改前 | 改后 | Δ |
|---|---|---|---|
| 严格 | 52/118 = 44.07% | **55/118 = 46.61%** | **+3 条（+2.54pp），0 掉分** |
| 宽松（同局） | 74/118 = 62.71% | 80/118 = 67.80% | +6 条，0 掉分 |
| 内容相关 | 96/118 = 81.36% | 96/118 = 81.36% | 0 |
| 卡行合计（118 行） | 400 | 493 | +93 行（+0.79 行/卡） |
| 5 行卡（117 唯一） | 38/117 张 | 74/117 张 | 卡片按 limit=5 装满（口径修复的直接效果） |
| tokens p50 | 179 | 186 | +7 |

- **收益逐条**：`self:ep-1286ce28`、`self:ep-eb9b65ea`、`self:ep-ee0d63a9`（严格）；宽松另 +`self:ep-bc4ab3cb`、`self:ep-7bba753b`、`self:ep-25d39e67`。**掉分 0**。
- **代价（如实）**：`unrelated` 行 98 → 135（多出的行是原本被预算挤掉、现在进入 top-5 的候选——严格判据不奖励噪声，但这确实是注入面的成本；卡片 500-token 上限未变）。「多给行」本身不是收益，收益只认 strict/related。
- **tombstone**：`test/walk.test.mjs` 的 `T21: hit.tokens 只估**可见内容**（指针 + 原文），审计字段 why/kind 不计入预算`——把 `why/kind` 加回去即红（已实测）。

## 6 · 为什么没有继续做（≥50% 的实测上界）

同一考卷、同一库，逐一实测"候选面/排序"的可调项：

| 尝试 | 严格 | 结论 |
|---|---|---|
| 基线（预算修复后） | **55/118 = 46.61%** | — |
| `walk.limit` = 6 / 7 / 8（候选多给 1–3 条） | 50 / 45 / 41 | **净负**（卡片 rank 优先，多出来的候选挤掉原本 strict 的行） |
| `maxTopics` = 10 / 12 / 16 / 24 | 55 / 55 / 54 / 54 | **无收益** |
| 卡片同档内按信号判别词重合排序（`compareEntries` 加次键） | 55 | **无变化**（top-5 内本来就能排到） |
| 卡片 overlap 优先 + walk.limit 8 / 12 / 20 | 47 / 41 / 39 | **净负** |
| 完整候选池（walk limit=1000 / budget=1e6） | **12/118 = 10.17%** | 灾难（卡片排序不是按相关性，候选越宽越糟） |

⇒ **只有 6 条属于"排序"**，且每条都有别的高优先行可替代；所有机械重排都在别处丢掉更多。**可达上界 = 61/118 = 51.7%，但没有任何一条低风险实现**——本刀不拿"调参到刚好过线"换数字。

## 7 · 不能靠机械判据解决的桶（如实）

1. **C 桶 57 条**：这是 A2b 的主短板，形态是"任务原话（中文口语）↔ claim 的代表原文（英文错误/路径）"没有共同判别词。**机械判据下无解**；两条例外路径都不在本刀：
   - 改 `judgeCard` 的 strict 口径 = **放宽判据换数字**，任务明令禁止；
   - 改 claim 的"代表原文"（在 claim 生成/选源层，把任务语言与错误原文的对应保留下来）= R09/R08 的活，本任务可写路径不含。
2. **考卷 artifact 的 2 个缺陷**（不属于失分，但影响读数可复算性）：
   - `repeat:ep-8a73e06b:222` 在 118 行里出现两次（同 itemId）⇒ 去重后 n=117；
   - `self:ep-1e976ca9` 的信号被脱敏成 `session-<REDACTED-UUID>…` ⇒ `signalHash` 不可复核、`replayFrozen` 跳过它。
   - 修它们要重建 holdout = **换题**（禁止），故只记在这里。
3. **A2b 的 self 题型局限**（T236a §4 已记）：query = 该局任务原话、expected = 该局自己的教训；与"后续会话召回"不完全同构。本报告不据此下"线上召回率"结论。

## 8 · 局限

- 重放非线上：A2b 是离线考卷，不等于线上注入质量（T11 §八.1 同款限制）。
- 库增长会漂移检索面：快照（1657 claims）与当前库（2277）的读数不同（快照 55/118 vs 改前重放 52/118）；所有前后对比均在同库完成。
- bigram 的 df 过滤用**当前库**统计，会随库增长变化（与 `runHoldout` 同口径，不是新引入的偏差）。
- 考卷 118 行含 1 重复、1 脱敏（§7）。

## 9 · 复现

脚本在 `tmp/`（临时产物，不入 git）：

```bash
# 1) 三层归因（检索→渲染→判分；输出 tmp/t21-attrib.json 与逐条日志）
node tmp/t21-probe.mjs
# 2) 深挖：eligible / 候选池名次 / 桶（输出 tmp/t21-deep.json）
node tmp/t21-deep.mjs
# 3) 候选面与排序实验（baseline / walk limit / 卡片排序）
node tmp/t21-sweep.mjs
node tmp/t21-limit.mjs
# 4) 逐条改前/改后（同一库两次跑，第二次把 walk.mjs 回退 hitTokenText）
node tmp/t21-items.mjs tmp/t21-items-after.json
# 5) 测试
node --test test/walk.test.mjs
```

**关键数**：快照 55/118 = 46.61%；当前库重放 52 → 55（+3，0 掉分）；失分 63 = C 57 + A 6；C 里 23 条"卡上有该局 claim 但不达标"；A 的名次 5–15；机械上界 61/118 = 51.7%（未找到低风险实现）。

## 附录 · 63 条失分逐条（改后口径）

> 列：itemId · 类型/信号源 · 桶（C=文本不重合 / A=排序）· expected claim 数 · eligible 数 · 候选池名次（A 桶）· 卡上是否已有该局 claim · 信号前 44 字。

| itemId | kind/source | 桶 | exp | elig | rank | 卡上有该局claim | 信号 |
|---|---|---|---|---|---|---|---|
| self:ep-c0a5847a | self/root | C | 170 | 0 | — | 有 | E:/Documents/dsh-go/HANDOFF.md 读这个交接文件，然后写方案 |
| self:ep-543cf0b2 | self/shortRoot | C | 26 | 0 | — | 有 | 处理一下 |
| self:ep-bc4ab3cb | self/root | C | 15 | 0 | — | 有 | https://opc.fiime.cn/zh-cn/download 这个网页我登录了 |
| self:ep-9becea64 | self/root | C | 19 | 0 | — | 无 | 扫一下我的github仓库，做一下脱敏，尤其是最小上传的一些 |
| self:ep-1e976ca9 | self/root | C | 11 | 0 | — | 无 | session-<REDACTED-UUID>继续这个会话的任务 |
| self:ep-00b50089 | self/root | C | 57 | 0 | — | 无 | 然后加个定时任务，每小时唤醒一次，可以调整goal，持续推进项目 |
| self:ep-aa52f421 | self/root | C | 13 | 0 | — | 有 | 怎么号全崩了？是被封号了吗？ |
| self:ep-0eba65b1 | self/root | C | 8 | 0 | — | 有 | 账号还是重新登录状态，欠费就行了，为什么要重新登录？ |
| self:ep-bde12afa | self/root | A | 133 | 1 | 15 | 有 | 看下DSH的0.2.2-rc.1版本更新了什么，有没有必要更新 |
| self:ep-03bc3e53 | self/root | C | 4 | 0 | — | 无 | "E:\AStudio\AStudio.exe"看一下有没有具体的模型请求目录，我在软件 |
| self:ep-e415e0f1 | self/root | C | 9 | 0 | — | 有 | 你的readme没脱敏？，直接脱敏然后覆盖1.0.0版本 |
| self:ep-9d375d75 | self/root | C | 5 | 0 | — | 无 | 找一下DSH插件tag里面有没有提示词优化的插件 |
| self:ep-a1aab8ef | self/root | C | 10 | 0 | — | 无 | 为什么我老是弹这个确认？dsh的会话调用这个可以不弹吗？ |
| self:ep-7bba753b | self/root | C | 6 | 0 | — | 有 | 本工作区上一个会话因为i上下文中有大量图片，反复透传导致智力低下，你不允许有任何图片进入 |
| self:ep-25d39e67 | self/root | C | 29 | 0 | — | 有 | 修复一下magpie网关失效的问题 |
| self:ep-3a3fb03c | self/root | C | 21 | 0 | — | 无 | 为什么每次灵犀的上下文中的图片都要重新过一遍识图？？？那不是消耗爆炸吗？ |
| self:ep-252091a4 | self/root | C | 11 | 0 | — | 无 | 修一下，怎么回事，是不是灵犀上游开始扣费了？ |
| self:ep-fdbfa78c | self/root | C | 23 | 0 | — | 有 | 为什么是圆的？magpie的框是圆角方框 |
| self:ep-8a787c9f | self/root | C | 1 | 0 | — | 无 | 帮我去magpie里面找一下我们这个ai ysiscode的消费情况，帮我估算一下一个月 |
| self:ep-16d5a1e2 | self/root | C | 4 | 0 | — | 有 | 找出503的根因，然后看一下我是不是有三个号其实是一个凭证 |
| self:ep-135c7f7d | self/root | C | 10 | 0 | — | 无 | 去找一下成熟项目的github仓库维护标准是怎样的，我感觉我的magpie脚手架仓库的维 |
| self:ep-9c2cbede | self/root | C | 8 | 0 | — | 无 | magpie的更新下载速度又变慢了，之前修过一次，你找到根因，然后给修复方案。我看过你再 |
| self:ep-dcc6efd2 | self/root | C | 27 | 0 | — | 无 | 找一些这些里面有没有每日额度或者每月额度，不充钱就能用的，或者免费额度的。上次找过一次。 |
| self:ep-08da81e8 | self/root | C | 7 | 0 | — | 有 | 你的系统提示词里面关于时间和token是怎么说的？ |
| self:ep-191da5ac | self/root | C | 14 | 0 | — | 无 | 之前说要把宿主和dsh-TUI直接兼容的成果在哪里？ |
| self:ep-5e4ee30c | self/root | C | 14 | 0 | — | 无 | 整理一下我现在magpie里面真实在用的插件，把里面的通用代码提取出来，然后择优（如有相 |
| self:ep-5cf57bb4 | self/root | A | 25 | 5 | 5 | 有 | "E:\Alysis Code\Alysis Code.exe"把这个软件的不充钱账号可 |
| self:ep-2955fa30 | self/root | C | 6 | 0 | — | 有 | "F:\Steamcommunity_302\Steamcommunity_302.ex |
| self:ep-e5eb8531 | self/root | C | 2 | 0 | — | 有 | 为什么一个ego消耗这么多cpu算例？ |
| self:ep-4188510d | self/shortRoot | C | 10 | 0 | — | 有 | 处理一下pr |
| self:ep-c460d468 | self/shortRoot | C | 14 | 0 | — | 无 | 把这个发仓库并公开吧 |
| self:ep-41514e25 | self/root | C | 15 | 0 | — | 无 | 这两个口碑很好吗？是不是可以下载下来，把系统提示词扒出来学一下 |
| self:ep-b5586316 | self/root | C | 24 | 0 | — | 有 | 处理一下我的收件箱，完成的就勾选完成，剩余未完成的告诉我内容 |
| self:ep-f46d6330 | self/root | A | 26 | 1 | 14 | 无 | 看一下"E:\codar-desktop\Codar科搭.exe"这个软件的v4.1f模 |
| self:ep-75e7347e | self/root | C | 13 | 0 | — | 有 | 安装失败 @tencent-connect/dsh-qqbot@latest 帮我装一下 |
| self:ep-147f0bf4 | self/shortRoot | C | 9 | 0 | — | 有 | 看下是不是这个修复方案 |
| self:ep-22d3bd16 | self/root | C | 4 | 0 | — | 无 | 查一下是那个应用或者可能是DSH里面的会话，为什么一个灯光控件要这么大内存？ |
| self:ep-d52b6ca5 | self/root | C | 10 | 0 | — | 无 | 去找一下当前magpie里面没有，但是有每日免费额度、积分这种不充钱就能用deepsee |
| self:ep-e23a6a05 | self/root | C | 3 | 0 | — | 有 | 这是什么意思？去找一下相关信息 |
| self:ep-1710f716 | self/firstUser | A | 4 | 1 | 5 | 无 | 为什么我打开DSH的配置文件会报错呢？ |
| self:ep-b718aab2 | self/root | C | 8 | 0 | — | 无 | 你是fork出来的会话，我还是想知道这个词整个网关崩溃的根因是什么？为什么一个magic |
| self:ep-f4e6c960 | self/root | C | 5 | 0 | — | 无 | 把这三个插件的图标弄一下，去找官方的，给我看预览效果就行了 |
| self:ep-8a27caaa | self/root | C | 7 | 0 | — | 无 | 处理一下啊这个bug，我们现在magpie中在用的我自己做的插件，全部检测一遍，UA全部 |
| self:ep-1f814ed5 | self/root | C | 5 | 0 | — | 有 | 我有个想法，你写个方案，然后在方案方向上向我拷问，一次一句。 想法如下：做一个各种模型一 |
| self:ep-b4664e8f | self/shortRoot | C | 5 | 0 | — | 无 | 修一下codar的报错 |
| self:ep-2209a95a | self/shortRoot | C | 5 | 0 | — | 有 | 处理一下 |
| self:ep-0ef39d3a | self/shortRoot | C | 9 | 0 | — | 无 | 修一下是哪个插件的问题 |
| self:ep-3618a34d | self/firstUser | C | 2 | 0 | — | 无 | 去品鉴一下这个up主的产品，，他控诉deepseek的superagent插件是对他的抄 |
| self:ep-c7f6b6d9 | self/root | C | 1 | 0 | — | 无 | 去看一下现在的magpie版本签到还会不会阻塞网关了，不会的话再看一下我的magicre |
| self:ep-c650bcea | self/root | A | 4 | 2 | 6 | 无 | billion-context 把这个项目的DSH版本和我们先做的产品做一个功能上的全面 |
| self:ep-62b1cd78 | self/root | C | 8 | 0 | — | 无 | 为什么我的邮箱全是这种信息？这个为什么一直报错，不管哪个仓库 |
| self:ep-d512e747 | self/root | C | 6 | 0 | — | 无 | https://github.com/411304344/opencode-cnb-ac |
| self:ep-294c4c1d | self/root | A | 1 | 1 | 12 | 无 | https://github.com/awesome-dsh-plugin/awesom |
| self:ep-28168c77 | self/root | C | 2 | 0 | — | 无 | 之前我们在aipy里面能伪造浏览器请求头的ua，那是不是可以通过这个办法在安卓端中伪造u |
| self:ep-bdd26050 | self/shortRoot | C | 5 | 0 | — | 有 | 处理一下 |
| self:ep-685dfadb | self/shortRoot | C | 3 | 0 | — | 无 | 这是什么情况？ |
| self:ep-3f03c71c | self/root | C | 7 | 0 | — | 有 | 把这两个仓库再脱敏一下，没问题就公开吧 |
| self:ep-5e91a1bc | self/root | C | 2 | 0 | — | 无 | "F:\Steamcommunity_302\AGENTS.md"根据这个修复一下git |
| self:ep-6294ad9f | self/shortRoot | C | 2 | 0 | — | 无 | 修一下 |
| self:ep-25af318d | self/shortRoot | C | 3 | 0 | — | 无 | CNB模型报错 |
| self:ep-a0c54630 | self/root | C | 1 | 0 | — | 无 | https://dshtui.com/plugins/ 我们基本实现了GO宿主使用TUI |
| self:ep-411a2729 | self/firstUser | C | 1 | 0 | — | 无 | E:\Downloads\sub2api_poc运行这个文件夹内的工具 https:// |
| self:ep-e5a98b06 | self/root | C | 1 | 0 | — | 有 | 你觉得用java写反代供应商的magpie插件方便还是用go方便？ |

> 说明：`expected` = `support` 含 expected episode 的全部 claim 数（ground truth 全集，机械从库里取）；`eligible` = 若渲染就能过 strict 文本门槛的条数；`rank` = 在完整候选池（walk limit=1000/budget=1e6）里的最好名次（0 起）。
