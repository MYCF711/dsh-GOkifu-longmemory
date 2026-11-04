# Memobase：读侧的"单事实 gist + 预算折叠"（2026-11-05 采集）

- 来源：厂商文档四页（均已读原文，访问日期 **2026-11-05**）：
  [Retrieving the Memory Prompt](https://docs.memobase.io/features/context)、
  [Profile Fundamentals](https://docs.memobase.io/features/profile/profile)、
  [Configuring Profile Slots](https://docs.memobase.io/features/profile/profile_desc)、
  [Searching Events](https://docs.memobase.io/features/event/event_search)。
  页面清单取自 [docs.memobase.io/llms.txt](https://docs.memobase.io/llms.txt)（同批抓取，用于确认这几页在 Features 节下）。
- **范围声明**：本仓 00–40 已覆盖 Mem0 / Letta / Cognee / AWS AgentCore / Zep 等系统与页面；**Memobase 是首次出现的系统**，
  本篇只写它的**读侧上下文组装（context）与事件粒度（event_gist）**，不重复任何已写页面。
- [外] **读侧是一个"组装器"**：`context()` 把两类记忆拼成一段**结构化字符串**直接塞进 prompt——
  `# Memory` 头部 + `## User Background:`（键值形式的 profile 槽位，如 `- basic_info:name: Gus`）+
  `## Latest Events:`（事件摘要，如 `- User mentioned living in California.`）。
  传入 `chats=` 时，"Memobase will perform a **semantic search** to prioritize the most relevant historical events,
  **rather than simply returning the most recent ones**"。
- [外] **读侧预算与配比是一等参数**（`context()` 的入参）：
  `max_tokens`（限制 profile 与 event 内容的总 token）、`profile_event_ratio`（profile 与 event 的配比）、
  `max_subtopic_size`（每个 topic 最多返回几个 sub-topic）、`prefer_topics` / `only_topics`（优先/仅包含某些 topic）、
  `time_range_in_days`（只取某时间窗内的事件）、`customize_context_prompt`（自定义最终模板）。
  文档特别注明：**"`max_tokens` limit applies to the profile and event content, not the final formatted string.
  If you use a large custom prompt template, the final output may still exceed the limit."**
- [外] **读侧粒度：单事实 gist**。原文："we call it `event_gist`. `event_gist` is **a fraction of `user_event`
  that only contains one fact, schedule, or reminder** of user."；`search_event_gist()` 按查询返回**细粒度**片段，
  `search_event()` 返回的是"**packed gists** of user events (happened in a period of time)"（一段时间打包），
  文档明确推荐前者："**We recommend more to use `search_event_gist` to retrieve fine-grained events.**"
- [外] **折叠后的可追溯性只有时间戳**：`search_event_gist` 的示例输出是
  `- user bought a car [mentioned at 2025-01]` / `- user drove to the car dealership [mentioned at 2025-06]` /
  `- user likes BMW [mentioned at 2024-08]`——**只有"提及于某月"，没有 episode / claim / 边指针**。
- [外] **存储侧是"覆盖式"的**（与本仓相反）：profile 由 **topic / sub_topic 槽位**定义
  （如 `work → company / position / department`），槽位可用 `description` 约束抽取格式；
  更新语义默认**就地替换**——文档例子：旧值 `start_date: 2020-01-01`，用户提到 2021 年换工作，
  "**Default Update: The value is replaced with `2021-01-01`**"；
  想保留旧值只能显式配置 `update_description`（例："Always keep the oldest start date. **Do not update if a
  date already exists.**"）。槽位集合用 `additional_user_profiles` 扩展、`overwrite_user_profiles` 整体替换。
- [外] **事件摘要是一等输入**：每个 event 会生成一份 `user interaction` 的**摘要**，文档说它
  "serves as the **primary input for the subsequent extraction of profile updates and event tags**"；
  摘要的取向可用 `config.yaml` 的 `event_theme_requirement` 定制（例："Focus on the user's personal information
  and feelings, not their direct commands or questions."）。
- [外] **事件检索的三种口径**（`search_event` 的说明）：按查询语义返回**被自动打上相关 tag 的事件**、
  或**更新过相关 profile 槽位的事件**——即"标签命中"与"槽位命中"都算相关，而不仅是文本相似。

**没读到 / 不能确认的部分（如实标注）**：① 四页都是**厂商文档**、**无发布日期**，只能记抓取日期 2026-11-05；
② 没有任何去重率/重复率/准确率数字；③ `context()` 的**组装算法细节未读到**（同一 fact 在多条 event 里重复出现时
是否去重、如何排序、`profile_event_ratio` 具体怎么分配预算）——文档只给参数名与示例输出；
④ `event_gist` 的**生成算法**（谁来切"一个事实"、是否模型生成）**未读到**，只知它是 `user_event` 的片段；
⑤ GitHub 在本机 DNS 解析到非公网地址，**未读源码**；⑥ `search_event` 的 tag/槽位命中如何与语义分融合未读到。

## 对照本仓（棋院）

本仓刚做完合流的消费侧三件套：**① `collapseMergeNodes` 合并节点优先、成员不重复成行；② 闸 4 认
`merge.members`（合并节点与其成员同文不算重复）；③ 成员侧反指针 `mergedInto`（同组成员同文不算重复）**。
Memobase 恰好是这套东西的**反面样本**：它把"不重复"做在**写侧**，所以读侧根本不需要折叠与反指针。

| Memobase | 棋院 | 判断 |
|---|---|---|
| **写侧覆盖**：一个槽位只留一个值（默认 `2020-01-01 → 2021-01-01`） | 存储**保留全部成员**，读侧才折叠成一行 | ⛔ 不借覆盖：旧值消失就没有可回放，与"原件永不删 / A6 文字可核"冲突 |
| 想留旧值只能靠 `update_description` 写死一句提示 | 折叠是**机械规则**（同组即折叠），不靠提示词 | ✅ 我们的做法更可复算；它反过来证明"靠配置保历史"是脆的 |
| 读侧 `context()` 有**预算与配比**（`max_tokens` / `profile_event_ratio` / `time_range_in_days` / `max_subtopic_size`） | 注入有**条数上限** + 每步 token 预算 | ✅ 同向；**可借它的口径**：预算只作用于"内容"，不作用于"外壳/模板" |
| 预算只算内容、**明说不含最终模板** | 我们的预算要写清"算哪些字段" | ✅ **可借**：这是一句容易漏写的契约措辞 |
| 读侧粒度 = **单事实 gist**（一个 schedule/reminder 只占一行），并推荐细粒度而非打包 | 折叠后也希望"一行一事实" | ✅ **可借**：把"一行一事实"写成折叠的**行切分判据**（打包行会同时降低精度与可核性） |
| 折叠输出只有 `[mentioned at 2025-01]` | 每行必须带 `ep + seq + quote` | ⛔ 不借：月份粒度的时间戳无法定位到"哪一局哪一步"，等于折叠后不可核 |
| **没有反指针**（因为成员根本不留） | `mergedInto` 反指针让"同组成员同文"不算重复 | ✅ **说明为什么反指针是必需品**：只有"保留成员 + 读侧折叠"的方案才会出现"同一事实两种身份"，才需要反指针去重 |
| 相关性命中 = 语义 ∪ tag ∪ 槽位 | 我们的相关性 = 词面 + 类别 + 作用域 + 十道闸 | ⚠ 口径不同；它的"槽位命中"提示我们：**被某条记忆更新过的槽位**也是一种指针，我们可等价成"该 claim 的 `supersededBy` 链上出现过" |

**能借的三点（都能落成机械规则/契约措辞）**：

1. **预算口径写死"算内容不算外壳"**：`max_tokens` 的注释直接抄它的形状——"只约束被注入的内容，不约束模板/卡壳"，
   避免"预算看起来很宽、实际被模板吃掉"的假象。
2. **"一行一事实"作为折叠的行切分判据**：合并节点成行时，一行只承载一个事实单元（一个 schedule / 一条决定），
   多事实必须拆行——这是 gist 粒度给我们的直接约束（也顺带减少"折叠行过长导致预算爆掉"）。
3. **"槽位命中"当作一种指针**：如果某条新记忆更新过某个槽/claim，那么"该槽被更新过"本身就是相关证据；
   我们可以用 `supersededBy` 链上是否出现过该 claim 来机械判定，不需要引入 tag。

**明确不借的四点（附理由）**：

1. **写侧覆盖（默认替换旧值）**：直接砍掉可回放，且"想保留历史要靠配置一句提示词"——不可复算。
2. **无指针的折叠输出**：只有 `[mentioned at 月]`，无法回答"这是哪一局、哪一步、原话是什么"，
   与 A6 文字可核冲突。
3. **语义检索决定读侧排序**：本仓不做向量；相关性只由词面 + 类别 + 作用域 + 闸决定。
4. **靠事件摘要当抽取主输入**：摘要由模型生成，按 AGENTS 陷阱 11 属"从摘要再抽取"的自证污染路径；
   我们的抽取输入只能是原始事件与棋谱边。

## 两条可复用结论

1. **读侧去重只有两种实现**：**折叠（collapse）** 或 **丢成员（overwrite）**。只有折叠方案会让同一事实
   同时以"组"与"成员"两种身份出现，所以**反指针是折叠方案的必需品**，不是可选优化——Memobase 没有反指针，
   正因为它没有成员可折。
2. **折叠越彻底，越需要显式的可追溯契约**：它把"不重复"做到读侧最小字符串，代价是输出里没有任何指针；
   我们要同时拿到"不重复"与"可核"，就必须在折叠**之外**再带一层反指针（`mergedInto`）与行级来源。

## 结论

无需改结构（存储保留成员 + 读侧折叠 + 反指针，方向正确）；可落地三件小事：
**把预算口径写成"算内容不算外壳"**、**把"一行一事实"写成折叠的行切分判据**、
**把"槽位被更新过"视作一种机械相关性指针**。
它同时提供了这套设计的**外部反证**：一个成熟系统选择了"写侧覆盖"来避免读侧重复，
代价正是我们最不想付的那一项——折叠之后，再也追不回原来那句话。