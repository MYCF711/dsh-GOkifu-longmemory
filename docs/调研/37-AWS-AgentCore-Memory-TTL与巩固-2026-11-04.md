# AWS AgentCore Memory：TTL 到期删除与后台巩固（"遗忘"的工程形态）（2026-11-04 采集）

- 来源：厂商文档四页（均已读原文，访问日期 **2026-11-04**）：
  [Add memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html)、
  [Memory types](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-types.html)、
  [Set a time-to-live for long-term memory records](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-record-ttl.html)、
  [Configure built-in strategies](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-configuring-built-in-strategies.html)。
- [外] **两层记忆**：**短期**存原始交互——每次交互是一条 **event**，按 `sessionId` 归会话，
  可带**键值 event metadata** 供 `ListEvents` 过滤（文档明确：event metadata "is not meant to store sensitive
  content, as it is not encrypted with customer managed key"）；**长期**存从交互里抽出的结构化记录
  （摘要、事实、用户偏好）。长期记忆的生成是**异步后台过程**：`CreateEvent` 写入原始交互或 `IngestData`
  提交后，后台做两件事——"**Extraction**（从原始交互抽取）"与"**Consolidation**（把新抽出来的信息与
  AgentCore Memory 里已有信息合并）"（[Memory types](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-types.html)，访问 2026-11-04）。
- [外] **四个内置策略**（[Configure built-in strategies](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-configuring-built-in-strategies.html)，访问 2026-11-04）：
  **User preferences**（抽取偏好/选择/风格，建持久用户画像）、**Semantic**（抽取事实与上下文知识）、
  **Session summaries**（会话内滚动摘要）、**Episodic**——原文："captures interactions as structured episodes
  consisting of **scenarios, intents, thoughts, actions taken, outcomes, and artifacts**"，并且
  "**reflections are also made across episodes** to extract broader insights, letting an agent learn and apply
  successful patterns from prior interactions to new interactions"。
- [外] **TTL 的默认与开关**："By default, long-term memory records **do not expire**."；
  可选 `recordExpirySpecification`，两种给法：**策略级**（`CreateMemory` / `UpdateMemory` 上，作用于该策略生成的记录）
  与**请求级**（`BatchCreateMemoryRecords` / `BatchUpdateMemoryRecords` 上，作用于该批全部记录）。
- [外] **TTL 的参数**：两个互斥字段——`recordExpiryDurationDays`（**最短 31 天**）与 `action: "REMOVE"`
  （清掉既有 TTL，使**之后**生成的记录不再过期）；支持**过期**的语义理由是三条：满足数据保留合规、
  控制存储增长、"ensure that **stale insights age out** of a memory"。
- [外] **TTL 不可追溯**：过期时间在**记录生成时**应用；"Changing or removing a TTL affects **only records that
  are created after the change**. Previously stored records keep their original expiration, and **expired
  records cannot be recovered**."（[TTL 页](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/long-term-record-ttl.html)，访问 2026-11-04）
- [外] **同库内的一致性约束**：同一 memory 里配多个策略时，`recordExpiryDurationDays` 必须**按组一致**——
  **semantic 与 user preference** 必须相同；**summary 与 episodic** 必须相同。
  自管策略（self-managed）不适用策略级 TTL，只能在批请求上按请求给。
- [外] **删除是后台近似，不是到点即不可读**（同页原文）："Deletion of an expired long-term memory record can
  typically take **a few days** to complete after its time-to-live elapses. The service removes expired records
  as a **background process** rather than at the exact expiration moment. During that window, an expired record
  **can still be returned by read operations** such as `RetrieveMemoryRecords`, `GetMemoryRecord`, and
  `ListMemoryRecords`. If you need a record removed immediately, delete it explicitly with `DeleteMemoryRecord`
  or `BatchDeleteMemoryRecords` instead of relying on a TTL."
- [外] **配置 TTL 需要独立权限**：任何设置/清除 `recordExpirySpecification` 的请求，除基础动作外还要求
  `bedrock-agentcore:UpdateMemoryRecordExpirySpecification`。文档给的理由很直白：只设 TTL 是一种**延迟删除**，
  所以"任何能调 `CreateMemory`/`UpdateMemory`/批接口的主体，本来都能靠设一个很短的 TTL 删掉记录，
  即便它没有删除权限"；反过来"能清除 TTL 的主体也可能让本该过期的数据留下来"。
- [外] **批接口的 TTL 优先级**：请求带 `recordExpirySpecification` ⇒ 直接生效（覆盖已有值）；
  请求不带但记录**已有** TTL ⇒ 按"最后一次生效的时长"**重置**；请求不带且记录**没有** ⇒ 不过期；
  且"**服务从不会**对批写记录使用其策略上的 TTL"——批写只认请求上的配置。
- [外] **检索是语义的**：`RetrieveMemoryRecords` 做**语义搜索**取最相关记录
  （[Memory types](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-types.html)，访问 2026-11-04）；
  另有 `GetMemoryRecord` / `ListMemoryRecords` 直取，以及 CLI 的 `agentcore memory event|record` 一族查看命令。

**没读到 / 不能确认的部分（如实标注）**：① 四页都是**厂商文档**，**无发布日期**，只能记抓取日期 2026-11-04；
② 没有任何准确率/成本/延迟数字可引——这几页没给；③ "a few days"是文档措辞、不是 SLA 承诺；
④ `Consolidation` 的**具体算法与提示词未读到**（只知是异步抽取后与既有信息合并）；
⑤ episodic 的 `reflection` 字段结构只看到配置示例（`namespaceTemplates`），具体产出格式未读；
⑥ 未核对任何 SDK 代码（GitHub 在本机 DNS 解析到非公网地址）。

## 对照本仓（棋院）

这是本仓最缺的那块对照：**别人怎么"忘"**。结论先说：他们把"遗忘"做成了**TTL + 后台巩固**两件事，
**没有**做重要性打分式衰减——这跟我们"只增不改 + 遮蔽"的差距，比想象的小。

| AgentCore Memory | 棋院 | 判断 |
|---|---|---|
| 长期记录**默认不过期**，TTL 按需开 | 原件永不删：库不设过期，上限只在注入侧 | ✅ 默认口径一致（都不"自动忘"） |
| TTL **只影响之后生成的记录**，旧记录保留原到期时间，过期不可恢复 | 只增不改：冲突只加 `supersededBy`，不追溯改写 | ✅ **同构**：都禁止"事后改历史的可见性" |
| 到期删除是**后台近似**，窗口期内读接口**仍会返回**过期记录 | 遮蔽发生在**渲染/注入**时，不依赖后台删除 | ✅ 这正是 note 34 的结论：可见性必须在读侧判 |
| 配置 TTL 需**独立权限**（延迟删除 = 删除能力） | `kifu_*` 只读工具面：根本没有"写/删"入口 | ✅ 他们把风险关在 IAM 里，我们把风险从接口上消掉 |
| 异步 **Extract + Consolidate**（模型抽取 + 与既有信息合并） | 归档期**机械重建**，不调模型、不合并旧条 | ⛔ 不借模型抽取与合并 |
| **Episodic**：scenarios / intents / thoughts / actions / outcomes / artifacts + **跨 episode 的 reflections** | 棋谱（actions/outcomes）+ 定式（支撑局/反例计数） | ✅ **形态高度同构**；差别是他们用模型反思，我们用机械计数 |
| `namespaceTemplates` 按 actor/session 分域 | `scopeKey` + 十道闸（跨作用域 0） | ✅ 同向；我们强制拦截而非靠命名约定 |
| `RetrieveMemoryRecords` 语义检索 | 词面 + 类别 + 作用域 + 十道闸 | ⛔ 不做向量 |
| 只有**按需检索**一条路（agent 主动 `RetrieveMemoryRecords`） | **自动注入 + 按需工具并存**：首轮索引/命中自动进卡，另有 `kifu_*` 只读工具按需查 | ⚠ 我们有两条进上下文的路径，**两条都必须过同一套闸**（可见性/预算/来源），否则会留下绕闸的旁路 |
| 返回的是模型抽取后的**记录文本**（偏好/事实/摘要混在一起） | 注入只给**事实**，且有祈使句过滤（禁"下一步/建议/请"） | ⛔ 不借：把模型写的总结性判断直接当上下文（越界到提示词工程） |
| 记录是抽取产物，**没有逐字原文指针**；原文在短期 events，过期或删除后不可恢复 | 每条注入带 `ep + seq + quote`，原文（会话日志/棋谱）永不删 | ⚠ 能力差别：他们换来干净的存储，我们换来**可回放**（这正是我们付的存储与体积代价） |
| event metadata 不加密（不能放敏感内容） | 记忆只存指针与去敏文本，原文留在日志 | ✅ 同一警觉：元数据不是保险箱 |

**能借的三点（都能落成机械规则/契约措辞）**：

1. **"过期只影响未来的记录"写成契约**：若将来给 claim 加 `validTo` 遮蔽，必须明确"改有效期**不追溯**
   已有条目的可见性"——这句可以直接借他们的措辞，避免我们自己在实现里滑向"回写历史"。
2. **"可见性在读侧判"作为硬约束**：他们承认后台删除有数天窗口、期间读仍能拿到过期记录。
   推论：**渲染/注入前必须按 `occurredAt` + `validTo` 自行过滤**，不能假设"过期了自然就看不到"。
3. **"会改变可见性的接口要单独授权"**：他们把 TTL 配置从普通写动作里拆出来。
   我们现在靠只读工具面从根上消掉；将来若加归档侧的"遮蔽/重算"命令，应当**单独列权限与审计**，
   而不是挂在普通写路径下。

**明确不借的四点（附理由）**：

1. **自动删除（到期即消失、不可恢复）**：与"原件永不删"和可回溯直接冲突；
   我们宁可库永远变大，也不放弃"每一条都能追回原始 `ep + seq`"。
2. **模型抽取 + 合并（Consolidation）**：合并意味着改写既有记录，且要靠模型判断"哪条该并进哪条"，
   与本仓"机械抽取、可复算"冲突。
3. **语义检索（`RetrieveMemoryRecords`）**：不做向量是本仓明写的边界。
4. **重要性打分式衰减**（文档里本就没有）：我们要记的是"失败教训"，不是"常被提起的话"；
   计数（支撑局数/注入次数）够用，打分只会引入不可复算的排序。

## 两条可复用结论

1. **"遗忘"在工程上被拆成 TTL（删除）、衰减（打分）、巩固（合并）三件事**；成熟云服务只做**TTL + 巩固**，
   不做打分衰减——这支持我们把"遮蔽 + 有效期"做成唯一机制，而不是加一套评分。
2. **任何"自动消失"都必须被读侧再判一次**：到期删除有窗口、合并会改写、缓存会滞后，
   所以**可见性是读侧的性质**，不是写侧的承诺。我们的十道闸与渲染过滤，就是把这个性质放在对的位置。

## 结论

无可照搬的机制；但给了三样东西：**TTL 不可追溯**的契约措辞、**可见性在读侧**的外部佐证、
以及**"改可见性 = 独立权限"**的治理范例。
最有价值的一句是：他们把"过期删除"当**后台尽力而为**，把"读到什么"交给读侧自己筛——
这恰好证明本仓把遮蔽放在注入前是对的，而不是多此一举。