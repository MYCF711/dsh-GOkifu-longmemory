# Letta(MemGPT) + Mem0 记忆层拆解：分层、装配、增量、公开承认的坑

> 证据分级，逐条标注：**[代码级]** = 官方仓库源码（文件+符号，blob 链接直达）；**[文档级]** = 官方文档原文（Mintlify/Fern 的 `.md` 版本）；**[论文级]** = arXiv HTML 原文。
> 读取日 2026-11-26。只读研究，未改本仓任何文件。代码级证据取自 `letta-ai/letta` 的 `archive` 分支（MemGPT V1 服务端，现行 `main` 已只剩 README 指向 `letta-code`，见 https://raw.githubusercontent.com/letta-ai/letta/main/README.md ）与 `mem0ai/mem0` 的 `main` / `v1.0.11`（论文对应版本）。

## 0. 谁在写记忆（最重要的一问，先给结论）

| 系统 | 写入者 | 判据 |
|---|---|---|
| MemGPT / Letta | **模型自编辑**：LLM 自己决定何时调 `core_memory_append` / `core_memory_replace` / `memory_insert` / `memory_replace` / `memory_rethink` / `archival_memory_insert`；框架只给工具、字符上限、只读位 | [论文级] “Memory edits and retrieval are entirely self-directed” https://arxiv.org/html/2310.08560v2 ；[代码级] 工具集 https://github.com/letta-ai/letta/blob/archive/letta/functions/function_sets/base.py#L246 |
| Mem0 | **规则管线 + LLM 抽取**：模型无权决定“要不要记”，是应用显式调 `add()`，由固定 8 阶段流水线抽事实入库；抽取内容由 LLM 产出，写入动作由代码执行 | [代码级] `Memory._add_to_vector_store` https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py#L881 ；[文档级] https://docs.mem0.ai/core-concepts/memory-operations/add.md |

一句话：**Letta 把记忆管理交给模型的判断力；Mem0 把它收回到确定性的流水线里**。两家 2025 年后的演进方向恰好相反。

## a) 分几层，每层由谁写

**MemGPT 原版三层**（[论文级] https://arxiv.org/html/2310.08560v2 ）
- **主上下文 = prompt tokens**：① 系统指令（只读、静态）② working context（定长可写文本块，只能通过函数调用写）③ FIFO 队列（滚动消息；队列首位是“被驱逐消息的递归摘要”）→ 全部由模型经函数写入或由 Queue Manager 规则驱逐。
- **recall storage**：消息数据库，**规则写**（Queue Manager 在收到/生成消息时自动落盘），模型只能经 `conversation_search` 读回。
- **archival storage**：任意长文本 + 向量检索，**模型写**（`archival_memory_insert`）、模型读（`archival_memory_search`，分页）。

**Letta 现行四层**（[文档级] https://docs.letta.com/v1-sdk/memory/context-hierarchy.md ）
- **Memory Blocks（即 core memory）**：在上下文中、可编辑，工具 `memory_rethink` / `memory_replace` / `memory_insert`；官方建议 **<50k 字符/块、<20 块/agent**。
- **Files**：只读、可 open/close、`semantic_search` / `grep`，5MB/文件、建议 <100 个。
- **Archival Memory**：不在上下文，`archival_memory_insert` / `archival_memory_search`；**单条建议 300 tokens**、条数无限。
- **External RAG**：自定义工具/MCP，无限。
- 再往上一层是 **MemFS**：记忆是 agent 自己的 git 仓库，按路径寻址，根目录文件每轮进 system prompt、带 `MEMORY.md` 索引的子目录按需读（[文档级] https://docs.letta.com/concepts/memfs/index.md ）。

**Mem0 的层**（[代码级] + [文档级] https://docs.mem0.ai/migration/oss-v2-to-v3.md ）
- 主库：向量库，payload 含 `data` / `hash`(md5) / `created_at` / `updated_at` / `text_lemmatized`（BM25 用）→ 见 https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py#L1030 。
- 实体库：并行的 `{collection}_entities` collection，做第三路检索信号（同文件 #L1100 ）。
- 历史库：SQLite `history` 表，每次 ADD 都落一条（同文件 #L1079 ）。
- 会话消息库：`db.save_messages` 保存原始消息，供下一轮“自动带入上文”（#L1207 + [文档级] add.md 的 “Automatic conversation context”）。
- 图记忆：论文版 Mem0^g 用 Neo4j（[论文级] https://arxiv.org/html/2504.19413v1 ），**OSS 已在 v3 移除（约 4000 行），只剩 Platform 内置**（[文档级] https://docs.mem0.ai/migration/oss-v2-to-v3.md ）。

## b) 上下文怎么装配

**MemGPT**：[论文级] 系统指令只读、working context 定长、FIFO 队列；超 “warning token count”（约窗 70%）插一条系统消息提醒模型“快被驱逐了，赶紧存”，超 “flush token count” 就驱逐约 50% 并重算递归摘要 https://arxiv.org/html/2310.08560v2 。

**Letta（代码级，装配函数）**：`compile_system_message` 把 `{CORE_MEMORY}` 变量替换成「渲染后的 memory blocks + memory metadata 块」，metadata 里带 last-edit 时间、agent id、conversation id、前序消息数、archival 条数、timezone → https://github.com/letta-ai/letta/blob/archive/letta/services/helpers/agent_manager_helper.py#L251 。块渲染格式固定为 `<label><description/><metadata>chars_current/chars_limit/read_only</metadata><value/></label>` → https://github.com/letta-ai/letta/blob/archive/letta/schemas/memory.py#L143 （文档里给了同样的样例 https://docs.letta.com/v1-sdk/memory/memory-blocks.md ）。
**顺序策略是明文写下的**：把“经常被改的记忆放在 system prompt 末尾以减少 KV cache 失效”，并禁止跨块冗余 → [文档级] Context Constitution 的 Efficiency 节 https://github.com/letta-ai/context-constitution/blob/main/constitution/CONSTITUTION.md 。
**渐进披露**：根文件常驻、子目录只给 `MEMORY.md` 索引、skill 只给 name/description，用到才读全文（同上 Progressive Disclosure 节 + https://docs.letta.com/concepts/memfs/index.md ）。

**Mem0**：**它不装配，装配是应用的责任**。官方 README 的示例是应用自己 `search()` 后把结果拼成 `User Memories:` 塞进 system prompt → https://raw.githubusercontent.com/mem0ai/mem0/main/README.md 。
真正被 Mem0 装配的是 **add 侧的抽取提示**：`Summary` + `Last k Messages` + `Recently Extracted Memories` + `Existing Memories` + `New Messages` + `Observation Date` + `Current Date`（[代码级] `generate_additive_extraction_prompt` https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py#L1016 ）。
**注意一个真实缺口**：OSS 主路径调用时只传了 `existing_memories` / `new_messages` / `last_k_messages` / `custom_instructions`，`summary` 与 `recently_extracted_memories` 未传 → 提示词里 “Summary” 与 “Recently Extracted Memories”（自称“primary deduplication reference”）实际为空（[代码级] https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py#L950 ）。

## c) 增量更新怎么做，为什么不全量重建

**MemGPT**：块就地编辑，历史消息只驱逐不重写；驱逐时只重算一条递归摘要，而不是重算全部历史；召回时把命中消息**追加到队列尾部**重新进入上下文（[论文级] 2.2 节）。
**Letta 的防抖是代码级的**：`rebuild_system_prompt` 先算“当前 memory 串”，**只有它变了才重建**系统消息；重建是 `update_message_by_id` **原地替换同一条 system message**，不新增（[代码级] https://github.com/letta-ai/letta/blob/archive/letta/services/agent_manager.py#L1445 ）。
**结构不变量：整段上下文里只有一条 system message**。`initialize_message_sequence` 产出的序列是 `[{"role":"system", content: compile_system_message(...)}, 登录事件, 启动 boot messages...]`，之后每步只往后追加 user/assistant/tool，**系统消息永远在 index 0 且只有一条**（[代码级] https://github.com/letta-ai/letta/blob/archive/letta/services/helpers/agent_manager_helper.py#L336 ）。这样一来“记忆更新”在结构上不可能表现为“再注入一遍”。
**Mem0 的人工入口与模型路径是分开的**：`update(memory_id, text=...)` / `delete(memory_id)` 是**应用**调的 API，不是 LLM 能触发的动作；且 `user_id/agent_id/run_id/actor_id` 在创建后不可改（[代码级] https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py#L1829 ）。
**Letta 的并发写法**：每次记忆编辑都 commit 到 agent 自己的 git 仓库，记忆子代理（dreaming / memory doctor）用 **git worktree** 并发改记忆而不阻塞主 agent（[文档级] https://docs.letta.com/concepts/memfs/index.md ）；dreaming 按 `step-count`（示例 25 步）或 `compaction-event` 触发后台子代理整理（[文档级] https://docs.letta.com/agent-sdk/memory/index.md ）。
**Mem0**：单次 `add` 只做「检索 top-10 相似 → 一次 LLM 抽取 → 批量 embed → md5 去重 → 批量 insert → 实体链接」，**不重建整库、不重算旧记忆向量**（[代码级] main.py #L918 起的 Phase 0–8；[文档级] oss-v2-to-v3 的流水线图）。
图记忆的更新是**软删除**：把失效关系标为 invalid 而不是物理删除，以保留时序推理能力（[代码级] https://github.com/mem0ai/mem0/blob/v1.0.11/mem0/memory/graph_memory.py#L420 ；[论文级] 2.2 节 “marking them as invalid rather than physically removing them”）。

## d) 他们公开承认的失败模式与坑

1. **重复注入会淹没 recall storage**（Letta 自己写在代码注释里）：`rebuild_system_prompt` docstring — “Updates to the memory header should *not* trigger a rebuild, since that will simply flood recall storage with excess messages” [代码级] https://github.com/letta-ai/letta/blob/archive/letta/services/agent_manager.py#L1445 。配套还有 `if curr_memory_str in curr_system_message_openai["content"] and not force: return`（同函数）——**先比内容再决定是否重写**。
2. **重复条目 / 去重不彻底**（Mem0）：v3 只有 md5 精确去重，且**只跟本轮检索到的 top-10 比对**（`existing_hashes` 来自 `existing_results`）→ 换句说法、或相似记忆没进 top-10，就会重复入库 [代码级] https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py#L1009 、#L1022 ；官方文档也提醒 `infer=False` 与 `infer=True` 混用“同一事实会被存两次” [文档级] https://docs.mem0.ai/core-concepts/memory-operations/add.md 。
3. **ADD/UPDATE/NOOP 判定不可靠 → 官方直接废掉这套判定**：v1 用一次 LLM 调用产出 `{"memory":[{"id","text","event"}]}`，event ∈ ADD/UPDATE/DELETE/NONE [代码级] https://github.com/mem0ai/mem0/blob/v1.0.11/mem0/memory/main.py#L591 + 提示词 https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py#L176 ；v3 迁移文档的原话是“新算法把两次 LLM 调用压成一次只做 ADD 的调用，**模型把能力花在理解输入上，而不是和既有状态做 diff**” [文档级] https://docs.mem0.ai/migration/oss-v2-to-v3.md 。这是最硬的“官方承认”证据。
4. **模型会编 ID，代码只好做整数映射兜底**：v1 `temp_uuid_mapping` 注释 “mapping UUIDs with integers for handling UUID hallucinations”，命中不了映射时该条动作被 `except` 吞掉只留日志 [代码级] https://github.com/mem0ai/mem0/blob/v1.0.11/mem0/memory/main.py#L584 。
5. **编辑冲突：后写覆盖先写**：官方明说 `blocks.update(value=...)` “**完全替换**而不是追加”，“若多个进程并发修改同一块，**last write wins，覆盖所有更早的改动**” [文档级] https://docs.letta.com/v1-sdk/memory/memory-blocks.md ；只读块是唯一护栏（`read_only=true`）。
6. **精确匹配失败会把编辑变成报错循环**：`core_memory_replace` 是 `if old_content not in current_value: raise ValueError(...)`，另一路 `memory_replace` 还带行号前缀（`1→ `），模型很容易把行号一起写进去 → 匹配失败 → 报错回灌 → 重试 [代码级] https://github.com/letta-ai/letta/blob/archive/letta/schemas/memory.py#L834 与常量 `CORE_MEMORY_LINE_NUMBER_WARNING` https://github.com/letta-ai/letta/blob/archive/letta/constants.py#L246 。
7. **时序错乱：靠“两个事实都留”+ 检索排序兜**：v3 明确“用户从纽约搬到旧金山时两条事实都保留并带时间上下文”，“若应用以前靠 UPDATE/DELETE 控制条数，现在改由检索排序处理”，并提示“记忆条数会增长而不是平台期” [文档级] https://docs.mem0.ai/migration/platform-v2-to-v3.md 。
8. **漏抽（false negative）被官方列成 FAQ**：定义性问题、纯概念解释、无个人上下文的陈述不会生成记忆，官方给出“加时间标记/加个人上下文”这种提示词级缓解 [文档级] https://docs.mem0.ai/platform/faqs.md 。
9. **LLM 失败曾经静默吞掉**：v1 抽取/更新调用异常时 `response = ""` → 一条记忆都不写，只打日志 [代码级] https://github.com/mem0ai/mem0/blob/v1.0.11/mem0/memory/main.py#L602 ；v3 改成抛 `LLMError`，代码注释写明原因：旧行为让调用方无法区分“LLM 挂了”和“没抽到事实” [代码级] https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py#L965 。
10. **检索会提前放弃**：论文自述 “we observe that MemGPT will often stop paging through retriever results before exhausting the retriever database”，并且 GPT-3.5 因函数调用能力弱导致文档问答显著退化、嵌套 KV 在 2 层后掉分 [论文级] https://arxiv.org/html/2310.08560v2 （3.2.1 / 3.2.2）。
11. **评测覆盖有意留缺口**：LOCOMO 的 adversarial 类（考“该不该拒答/该不该记”）被排除，理由是缺 ground truth [论文级] https://arxiv.org/html/2504.19413v1 （3.1）。
12. **压缩失败是致命错误而非降级**：`max_summarizer_retries=3`，代码注释“若到上限，说明摘要器再也压不下去，抛致命错误” [代码级] https://github.com/letta-ai/letta/blob/archive/letta/settings.py#L96 。
13. **记忆会膨胀/漂移，官方配了审计工具**：`/doctor` 用来审计“placement、duplication、system-prompt token usage”，并承认“memory hierarchy 可能 drift 或长得太大” [文档级] https://docs.letta.com/configuration/memory/index.md 。
14. **官方列的“不理想上下文”四条失败模式**（逐字可引）：忘记把持久经验写回 system prompt/外部记忆；把过期 skill、检索文档、原始对话历史囤到超期；把很少用的指令塞进 system prompt 而不是放进 skills；加载与当前任务无关的 skill [文档级] https://github.com/letta-ai/context-constitution/blob/main/constitution/CONSTITUTION.md 。

## 常量与阈值（代码级，逐个列出）

**Letta**（`letta/constants.py` https://github.com/letta-ai/letta/blob/archive/letta/constants.py ）
- `SUMMARIZATION_TRIGGER_MULTIPLIER = 0.9`（压缩在 90% 上下文触发，注释：用 0.9 而非 1.0 以避免 “too many tokens in prompt” 回退）
- `CORE_MEMORY_BLOCK_CHAR_LIMIT = 100000`；`CORE_MEMORY_PERSONA_CHAR_LIMIT = 20000`；`CORE_MEMORY_HUMAN_CHAR_LIMIT = 20000`
- `FUNCTION_RETURN_CHAR_LIMIT = 50000`；`TOOL_RETURN_TRUNCATION_CHARS = 5000`；`MAX_ERROR_MESSAGE_CHAR_LIMIT = 1000`
- `MAX_PAUSE_HEARTBEATS = 360`（分钟）；`DEFAULT_CORE_MEMORY_SOURCE_CHAR_LIMIT = 50000`；`MAX_FILES_OPEN_LIMIT = 1000`
**Letta**（`letta/settings.py` #L79-100 ）：`message_buffer_limit=60`、`message_buffer_min=15`、`max_summarization_retries=3`、`partial_evict_summarizer_percentage=0.30`、`memory_warning_threshold=0.75`（该组注释标为“旧摘要器遗留，应废弃或迁移”）。
**Letta 摘要器行为**：`if len(all_in_context_messages) <= self.message_buffer_limit and not force: return`（不足 60 条且非强制 → 不摘要）；驱逐后保留 `retain_count = message_buffer_min`（15 条）https://github.com/letta-ai/letta/blob/archive/letta/services/summarizer/summarizer.py#L277 。
**Letta 文档给的产品级上限**：memory block <50k 字符 / <20 块，files 5MB / <100 个，archival 单条 300 tokens / 无限条 → 表格见 https://docs.letta.com/v1-sdk/memory/context-hierarchy.md ；Cloud 存储 5MiB(Free)/50MiB(Pro) 每仓库 → https://docs.letta.com/configuration/memory/index.md 。
**Mem0 代码级**：抽取前相似检索 `top_k=10`（main.py #L931 ）；去重键 = `hashlib.md5(text)`（#L1022）；实体合并的语义阈值 `score >= 0.95`（#L1166）；上一轮消息 `get_last_messages(limit=10)`（#L922）；`PAST_MESSAGE_TRUNCATION_LIMIT = 300` 字符（prompts.py #L965 ）；v1 每个新事实的复核检索 `limit=5`（v1 main.py #L572 ）；图记忆相似阈值默认 `0.7`（graph_memory.py #L74 ）。
**Mem0 文档级默认**：`search` 的 `top_k` 默认 20（旧版 100）、`threshold` 默认 0.1（旧版无过滤）、`rerank` 默认 False（旧版 True）→ https://docs.mem0.ai/migration/oss-v2-to-v3.md ；官方宣称 LoCoMo 92.5 / LongMemEval 94.4、“单次检索、无 agentic loop、top_200 预算、6.8–7.0K tokens/query” https://raw.githubusercontent.com/mem0ai/mem0/main/README.md 。

## 四问一屏对照

| 维度 | MemGPT / Letta | Mem0 |
|---|---|---|
| 分层 | 主上下文（system+core blocks+FIFO）/ recall / archival；现行再加 MemFS(git) + skills | 向量库 + `{collection}_entities` 实体库 + SQLite history + 会话消息库；图记忆仅 Platform |
| 写入者 | **模型自编辑**（工具调用），框架给上限/只读位/审计 | **规则管线的固定 8 阶段**，事实文本由 LLM 抽，写入由代码执行；v3 只有 ADD |
| 装配 | 框架内嵌进**唯一一条 system message**（blocks + metadata 块），其余按需检索 | 框架**不装配**，应用自取自作主；add 侧装配抽取提示（summary+last k+existing+new） |
| 增量 | 块就地改写（replace/rethink）+ 队列驱逐+递归摘要；system message 原地替换，内容未变则跳过 | 单条 add：检索 top-10 → 一次抽取 → 批量 embed → md5 去重 → 批量 insert；不重建整库 |
| 去重/冲突 | 模型判断 + 精确子串匹配（失败抛错）+ last-write-wins + 只读块 + `/doctor` | md5 精确去重（只对 top-10）+ 实体语义 0.95 合并 + 官方劝你别混用 `infer` |
| 时序 | 块内改写，旧值被覆盖（历史靠 recall 原始消息） | 新旧两条都留，检索时排序，Observation Date 锚定相对时间；图关系软删除 |

## 对我们（全量重建 + 重复注入设计）的直接含义

1. **重复注入的代价被 Letta 写成了注释级事故**：他们的系统消息是“原地替换同一条”，并且重建前先比内容串；我们如果每轮 append 一段记忆，等于把他们刻意避免的 “flood recall storage” 重新引入（来源同上第 1 条）。
2. **去重必须是“内容身份”级，不是“本轮 top-k 命中”级**：Mem0 的 md5 只挡逐字重复，LLM 复述一遍就绕过；我们已有的 `supersededBy`/`occurredAt` 是更强的基础，但需要显式“同源键”（episode+seq/节点 id）才能挡复述级重复（来源第 2 条 + main.py #L1009 ）。
3. **模型判定“该不该写”不可信，两家都栽过**：Mem0 直接删掉 UPDATE/DELETE，Letta 把判断权交给模型但配上只读位、字符上限、`/doctor` 审计和 git 历史。我们的“规则抽取 + 人纠错”路线与 Mem0 的方向一致，但少了 Mem0 的“检索时排序”兜底（来源第 3、13 条）。
4. **时序必须显式建模，不能靠覆盖**：Mem0 的答案是“两条都留 + 检索时排序 + Observation Date 锚定相对时间”，Letta 的答案是“块里就地改写”。我们选了前者路线（`occurredAt` 一等字段），要补的是“相对时间在写入时就地解析成绝对日期”（prompts.py 的 Observation Date 段）。
5. **“上下文里只放索引、全文按需取”是两家今天共同的解**：Letta 的 `MEMORY.md` 索引/渐进披露、Mem0 的 “只放检索命中的 memory 不放开 transcript”。我们的 `INDEX 一行 + 命中展开` 与之同构，可以引为同级证据（来源 b) 节的 MemFS/Constitution）。

## 未读到 / 未验证（诚实边界）

- Mem0 论文 §4.4–§5（延迟/开销细节、结论）在 HTML 抓取时被截断，未逐字读取；本文引用的 Mem0 论文内容仅限摘要、§1、§2、§3.1。
- Letta 现代 `letta-code` 仓库的上下文装配实现未读（仅读 `letta` 的 `archive` 分支代码 + 现代文档）；两者系统提示构建方式可能已不同。
- Mem0 的 `memory-evaluation` 页与 Platform 专属算法（92.5 分那套）无源码可读，只有官方数字，未独立复现。