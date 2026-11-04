# Letta MemFS：把"记忆块"换成 git 仓库（memory blocks → MemFS + dreaming）（2026-11-04 采集）

- 来源：厂商文档三页（均已读原文，访问日期 **2026-11-04**）：
  [MemFS](https://docs.letta.com/concepts/memfs)、
  [Memory & dreaming](https://docs.letta.com/configuration/memory)、
  [Shared memory](https://docs.letta.com/concepts/shared-memory)。
- [外] **一句话形态**：Letta 的长期记忆不再是"塞在上下文里的记忆块"，而是 **MemFS —— 一个属于 agent 的
  git 仓库**："The memory itself is part of the agent's state, held in a git repository that belongs to the
  agent"；MemFS 把该仓库**投影**成 agent 所在机器上的真实 checkout，agent 用**普通文件工具**读写；
  **改动在 commit + push 之前只在本地**，推送后才"become the agent's memory everywhere"。
- [外] **地址即语义**：记忆按**路径**寻址——标签 `persona` 就投影成 `persona.md`；
  原文："Choosing a label is choosing where the memory lives and whether it stays in context"。
- [外] **两级上下文（关键的分层机制）**：记忆根目录下的文件**每轮都进系统提示词**（身份、用户偏好、持久的
  项目事实、关键工作流规则）；而"**带自己的 `MEMORY.md` 索引的子目录默认不进上下文**，需要时才读"——
  原文："Directories with their own `MEMORY.md` index stay out of context until they are needed… directory and
  file names act as signposts the agent follows to read the right file"（[MemFS](https://docs.letta.com/concepts/memfs)，访问 2026-11-04）。
  目录结构示例（文档原样）：根 `MEMORY.md` + `persona.md` + `human.md` + `reference/`（含自己的 `MEMORY.md`）+
  `skills/<name>/SKILL.md`。
- [外] **默认没有语义/向量索引**："MemFS does not include a semantic or vector index by default. Agents find
  memory in its Markdown files with normal file-search and read tools."；需要关键词/可选语义检索时装
  `@letta-ai/memfs-search` 这个 mod（关键词无需额外依赖；语义/混合模式需要外部 QMD 工具并对其索引）。
  会话历史检索是另一套：Cloud 上 `letta messages search` 支持全文/向量/混合，本地后端目前只有全文。
- [外] **版本与并发**：每次记忆编辑都 commit 进 git —— 提供"版本历史、冲突解决、以及'已保存'与'未提交'
  之间的清晰边界"；**dreaming / memory doctor 这类记忆子代理用 git worktree**，从而并发改记忆而不阻塞主 agent
  （[MemFS](https://docs.letta.com/concepts/memfs)，访问 2026-11-04）。
- [外] **dreaming = sleep-time compute 的落地形态**（[Memory & dreaming](https://docs.letta.com/configuration/memory)，
  访问 2026-11-04）：它用**后台子代理**回顾最近的会话、**合并有用的教训**、更新记忆，不打断进行中的工作；
  触发时机可在 CLI 的 `/sleeptime` 或 app 的 Dream 设置里选：**"完成 N 个 agent step 之后"或"上下文窗口被压缩时"**；
  另有 "**Agent reviews before applying**" 选项——由第二个后台会话先审阅/修订拟议的记忆改动，
  官方明说"uses more model tokens and **does not ask you for approval**"。
- [外] **维护操作是显式命令**：`/init` 初始化或刷新记忆（会检索仓库、必要时问工作风格、并可让子代理回顾
  过去的编码会话）；`/remember <一句话>` 显式教它一条（agent 自己决定放在哪并提交）；
  `/memory` 或直接看 `$MEMORY_DIR` 复核；`/doctor` **审计"放置位置、重复、系统提示词 token 占用"**。
- [外] **合并/重构是"先备份再动"**：文档原文——memory workflow "backs up the current repository **before**
  splitting large files, merging duplicates, or restructuring the hierarchy"。
- [外] **容量口径**（同一页）：Cloud 免费档 **5 MiB / 记忆仓库**，Pro **50 MiB / 记忆仓库**；
  计的是**每个分支/标签最新快照里的文件**，**不是 git 历史**；额度按仓库分别计算，含 shared memory。
- [外] **"记忆块"已被标记为旧形态**（[Shared memory](https://docs.letta.com/concepts/shared-memory)，访问 2026-11-04）：
  旧 API 的 **shared memory blocks**（一个 in-context 记忆块挂到多个 agent）"still supports this pattern, but
  users should migrate to **shared memory repositories** instead"。新形态是**组织拥有的 git 仓库**，
  按 agent 挂载；agent 的系统提示词里只列**仓库路径与顶层文件**；Letta Code 把它 clone 在
  `$MEMORY_DIR/../<repository-name>/`，agent 用普通文件与 git 工具读写，并自己 commit/push；
  其它 agent 再 pull 那些 commit。仓库还可通过 `skills/<skill-name>/SKILL.md` 提供技能。
  **shared memory 仅限 cloud 托管的 agent**，本地 agent 用自己的 MemFS。
- [外] **归属划分**（同页表格）：MemFS 归**单个 agent**（身份、技能、长期记忆）；shared memory 仓库归**组织**
  （团队约定、产品知识、研究、计划、多人维护的文档）。

**没读到 / 不能确认的部分（如实标注）**：① 三页都是**厂商文档**，没有发布日期，只能记抓取日期 2026-11-04；
② 旧 **memory blocks** 的字段结构（label/value/limit 之类）这次**没有**读其文档正文——只有导航里看到
`/v1-sdk/memory/memory-blocks/` 这个路径与 shared memory 页里"MIGRATE"的说法；
③ "dreaming" 的具体提示词、`/sleeptime` 的默认 N 值、`memory doctor` 的判定规则**均未读到**；
④ GitHub 在本机 DNS 解析到非公网地址，`memfs-search` / QMD 的代码与实现未核对，只按文档描述记录；
⑤ 无任何性能/准确率数字可引——这两页没有给。

## 对照本仓（棋院）

Letta 这次转向值得单独写，因为它把"记忆"从**提示词内容**改成了**仓库状态**：这和我们"棋谱入馆 + 派生视图"
是同一个大方向，但两侧的**写面**截然相反。

| Letta MemFS / dreaming | 棋院 | 判断 |
|---|---|---|
| 记忆是**可写的状态**：agent 用文件工具随时改、commit、push | 记忆是**只读的档案**：会话结束才归档，SDK 只读面 | ⛔ 方向相反，且我们是**有意**的（见"不借"） |
| 入口宽松：随时 `/remember`，无"入馆"门槛 | **无棋谱不入馆**：一切内容必须来自某一局会话 | ⛔ 不借（会让外部文档/模型臆测混进记忆） |
| 根目录文件每轮进系统提示词（身份/偏好/规则） | 注入只给**事实**、每步 ≤K 条，且禁祈使句 | ⛔ 不借：他们把"怎么做事"写进上下文，属提示词/上下文工程 |
| 子目录靠 `MEMORY.md` 索引做**路标**，正文按需读 | `index.md` + walk（深度 ≤2）就是同一招 | ✅ 同构；可借"**每层一个索引文件**"的分层写法 |
| 默认**无向量索引**，靠文件搜索/读工具 | 零向量、零 embedding，机械匹配 + 十道闸 | ✅ 同向，且我们更彻底（连文件系统都不用） |
| git 版本历史 + worktree 并发 | append-only journal + 帧校验 + 幂等；归档单进程 | ✅ 都在解决"可回溯 + 并发安全"，机制不同 |
| `/doctor` 审计**放置、重复、系统提示词 token 占用** | 十道闸 + 索引/注入预算 | ✅ 可借：把"重复"也做成机械审计项 |
| 合并/重构**先备份仓库**再拆文件/并重复/调结构 | 我们不合并：冲突只加 `supersededBy`，原件不动 | ✅ 精神一致（先保原件再改视图） |
| dreaming：后台合并教训，"审阅后再应用"可选、**不需人批准** | 归档是**机械重建**，不调模型、不需要批准 | ⛔ 不借模型审阅（要调模型，且"自动应用"会破坏可核） |
| 容量按**最新快照**算（不含 git 历史） | 容量上限只设在**注入**，不设在库 | ✅ 可借这个**口径**：算体积时明确"算快照还是算历史" |

**能借的两点（都可机械实现）**：

1. **分层索引 = 路标，正文惰性加载**：他们的"子目录带 `MEMORY.md` 就不进上下文"和我们 `index.md` 只放
   一行一局、正文靠 walk 取，是同一策略。差别只在**层级**：他们按目录分层，我们按 scope 分节。
   若要扩，可做"每个 scope/卷一个子索引"，规则仍是"索引只有指针，正文按需读"。
2. **把"重复"纳入机械审计**：`/doctor` 明确审计 duplication；我们的十道闸目前查事实性/来源/预算，
   可以加一条纯机械检查——同一 scope 内 `text` 归一后哈希相同的 claim 计数 > 1 就报"重复"（只报不改）。
   这与"只增不改"完全兼容（我们只**报**，不合并）。

**明确不借的四点（附理由）**：

1. **agent 直接写记忆（文件工具 + commit）**：一旦写面开放，就需要"谁能写、写错了怎么撤、多人并发怎么合"
   一整套治理；Letta 现在正为旧形态写迁移说明（"should migrate to shared memory repositories"），
   说明**写面开放后回退成本很高**。本仓 SDK 保持只读面，是在避免这笔债。
2. **每轮把记忆根文件塞进系统提示词**：那是提示词/上下文工程，不是记忆；而且它必然携带祈使句
   （"always use pnpm"），与本仓"注入只给事实"的红线直接冲突。
3. **dreaming 的"模型审阅后自动应用"**：审阅者仍是模型，等价于"模型改记忆"，会破坏可回溯；
   我们宁可把巩固做成**机械重建**（同一输入必得同一输出）。
4. **shared memory 的跨 agent 共享**：它靠"组织拥有仓库 + 显式 attach"来管边界，
   而本仓的 A5 目标是**跨作用域 0**——共享是特性，不是我们的目标；我们宁可各 scope 独立。

## 两条可复用结论

1. **"记忆进上下文"和"记忆在磁盘上"是两种产品**：Letta 把记忆变成文件系统（可读可写、按路径寻址、
   git 版本化），换来的是**agent 自管理**；本仓把记忆变成档案（只读、可溯源、只增不改），换来的是
   **可核与可回放**。两者都在做"长期"，但一个面向**行为延续**，一个面向**经验复用**。
2. **分层索引是省 token 的通用招，不依赖模型**：他们用目录 + `MEMORY.md`，我们用 scope + `index.md`，
   核心都是"名字当路标、正文按需读"。这条可以继续往细里做，而**不需要**引入向量或模型摘要。

## 结论

无新机制可整体照搬（写面相反）；可借鉴两点**都能做成机械规则**：分层索引的"路标"写法、
把"重复"纳入机械审计（只报不改）。
最有价值的其实是**反向证据**：Letta 因为开放写面，正在付"迁移旧记忆块"的成本；这支持本仓继续维持
**只读 SDK + 只增不改 + 机械巩固**的组合——代价是记忆不会自动变聪明，收益是每一条都能追到原始会话。