# 框架内置记忆拆解：LangMem / LangGraph / LlamaIndex / Memobase / Memary

> 证据分级逐条标注：**[代码级]** = 官方仓库源码（文件 + 符号，blob 链接直达）；**[文档级]** = 官方文档原文（含 Mintlify 的 `.md` 版本）。
> 读取日 2026-11-26。只读研究，未改本仓源码、未跑测试、未做 git 操作。
> 主干版本：`langmem@main`、`langgraph@main`、`langchain@master`（注意 langchain 仓默认分支是 **master**，不是 main）、`llama_index@main`、`memobase docs`。

---

## 0 · 一句话结论（先看这个）

三家框架**都把"记忆"当成一次 LLM 调用**：写入 = 一次抽取调用，读回 = 一次装配调用。它们全部**没有**为"记忆写入"设计独立的确定性管线（对照 Mem0 的 8 阶段规则管线）。所以它们真正值得抄的不是分层名词，而是**预算控制的位置**：LlamaIndex 卡在 `Memory` 对象上（30000 token 总预算 + 0.7 短时占比 + 3000 批量驱逐），LangChain 卡在中间件上（保留 20 条消息 + 摘要输入裁到 4000 token），LangMem 卡在摘要函数上（`max_summary_tokens=256`）。

---

## a) 记忆类型划分：各自由谁写入、写在哪

| 类型 | 谁写 | 写在哪 | 证据 |
|---|---|---|---|
| Semantic（事实/偏好） | `create_memory_manager`（应用或模型工具调用触发，hot path） | LangGraph `BaseStore`：**profile** = 命名空间下单个 JSON 文档，每轮覆盖整份；**collection** = 多条独立记录，逐条 insert/update/delete | [代码级] https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/extraction.py （`MemoryManager.__init__`、`create_memory_manager`）；[文档级] https://langchain-ai.github.io/langmem/concepts/conceptual_guide/ |
| Episodic（成功经验） | 同上，通过自定义 Pydantic `schemas=[Episode]` 强制 observation/thoughts/action/result 四段结构 | `BaseStore` collection；检索出来后当 few-shot 例子塞进 prompt | [文档级] https://langchain-ai.github.io/langmem/concepts/conceptual_guide/ ；https://docs.langchain.com/oss/python/concepts/memory |
| Procedural（行为规则） | `create_prompt_optimizer`（reflection / metaprompt 改写指令） | **不落 store**：直接覆盖 agent 的 system prompt 字符串；LangGraph 文档给的另一路是 store 里存一份 `{"instructions": ...}` 文档再读出 | [代码级] https://github.com/langchain-ai/langmem/blob/main/src/langmem/prompts/optimization.py （`create_prompt_optimizer`，`kind="metaprompt"`，`config={"max_reflection_steps": 3}`）；[文档级] https://docs.langchain.com/oss/python/concepts/memory （Procedural memory 一节给出 `store.put(("agent_instructions",), "agent_a", {...})` 的写法） |

LlamaIndex 不走"三分类"，走**两段式**：

- **Short-term** = SQL 存储里的一个 FIFO 消息队列，由 `Memory.aput/aput_messages` 写入，**每个 LLM 回合重建**。[代码级] https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/memory/memory.py （`Memory` 类文档串明确写 "a FIFO queue of messages"）
- **Long-term** = `MemoryBlock` 列表，**唯一写入源是短时队列溢出**：`_manage_queue` 把最老的消息按 `token_flush_size` 成批弹出后喂给各 block 的 `_aput`。[代码级] 同上（`_manage_queue` 的 docstring："Removed messages are archived and passed to memory blocks"）；[文档级] https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/ （"These objects receive the messages that are flushed from short-term memory"）
- 三种内置 block：`StaticMemoryBlock`（常量，永不写入）、`FactExtractionMemoryBlock`（LLM 抽事实，`max_facts=50`）、`VectorMemoryBlock`（向量库，`similarity_top_k=2`）。[代码级] https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/memory/memory_blocks/fact.py 、 .../vector.py 、 .../static.py

---

## b) hot path vs background：什么时候同步写，为什么

**LangChain/LangGraph 文档自己给的取舍表**（[文档级] https://docs.langchain.com/oss/python/concepts/memory#writing-memories）：

- **hot path**：实时可用的新记忆，用户可见、可提示"已记住"。代价三连：要新增一个 memory 工具（工具选择复杂度↑）；**"the process of reasoning about what to save to memory can impact agent latency"**；agent 要在"干正事"和"记记忆"之间分心，**"potentially affecting the quantity and quality of memories created"**。
- **background**：主链路零延迟、逻辑解耦、"more focused task completion"。代价是**触发时机问题**：**"Determining the frequency of memory writing becomes crucial, as infrequent updates may leave other threads without new context"** —— 写太稀，其他会话就拿着旧上下文；写太密，等于把 hot path 搬到后台而已。文档给的三种触发：定时 + 有新事件就重排、cron、人工/应用触发。

**LangMem 的文档原话**（[文档级] https://langchain-ai.github.io/langmem/concepts/conceptual_guide/ ）：
- "Conscious"/hot path："easy to implement… lets the agent itself choose how to store and update its memory. **However, it adds perceptible latency to user interactions, and it adds one more obstacle to the agent's ability to satisfy the user's needs.**"
- "Subconscious"/background：对话**结束后**（或静默一段时间后）再做反思抽取，"without slowing down the immediate interaction or adding complexity to the agent's tool choice decisions"。

**函数级的实际差别**（这是本节的关键，两者不是同一个函数的两个开关）：

| | hot path | background |
|---|---|---|
| 入口 | `create_manage_memory_tool()` → 模型在一次对话**中途**决策调用 `manage_memory(action=create/update/delete)` | `create_memory_store_manager()` 或 `ReflectionExecutor(...)`（`submit()` 到线程池，立即返回 future） |
| 写入者 | 模型（作为工具调用） | 框架（异步任务里跑同一条抽取链） |
| 存储对象 | 直接写 `BaseStore`（`put`/`delete`） | 先 `store.search(namespace, query=..., limit=query_limit)` 取回相关旧记忆，再合并后回写 |
| 默认检索量 | 工具签名 `limit: int = 10` | `query_limit: int = 5` |
| 证据 | [代码级] https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/tools.py （`create_manage_memory_tool`、`create_search_memory_tool` 的签名注释 `limit: int = 10`） | [代码级] https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/extraction.py （`create_memory_store_manager(..., query_limit: int = 5, namespace=("memories","{langgraph_user_id}"))`）；https://github.com/langchain-ai/langmem/blob/main/src/langmem/reflection.py （`RemoteReflectionExecutor` 用 `ContextThreadPoolExecutor` + `self._executor.submit(task, ...)`） |

**我的判读**：LangMem 把 hot path 的实质代价落在"模型多想一步"，background 的实质代价落在"什么时候算这一轮结束了"。后者天然需要一个**边界信号**（会话结束 / 静默 N 分钟）——这正好是我们的 `agent/turn-stopping` / 会话收尾钩子能直接提供的，比 cron 扫描便宜得多。

---

## c) token 预算与裁剪：**具体默认值表**

### c.1 LlamaIndex `Memory`（长时间记忆 + 短期记忆总预算）—— [代码级]

| 常量 / 参数 | 默认值 | 语义 |
|---|---|---|
| `DEFAULT_TOKEN_LIMIT` | **30000** | `Memory.token_limit`：短期队列 + 全部 memory block 的**总**预算 |
| `DEFAULT_FLUSH_SIZE` | `int(30000 * 0.1)` = **3000** | 一次水位驱逐把多少 token 的消息批量喂给 block |
| `chat_history_token_ratio` | **0.7** | 短期队列预算 = 30000 × 0.7 = **21000**，剩下 9000 留给长期块 |
| `insert_method` | `InsertMethod.SYSTEM` | 块内容注入 system message（不是 user 消息） |
| `image_token_size_estimate` | **256** | 一张图按 256 token 估（没有真 tokenizer 时的保守估法） |

- 冲突修正逻辑：`validate_memory` 里 `token_flush_size < 1` 或 `> token_limit` → 重置为 `int(token_limit * 0.1)`；`from_defaults` 里若 `token_flush_size > token_limit` → 改成 `int(token_limit * 0.7)`。
- **超预算怎么裁**（两条独立机制）：
  1. 写入侧（水位）：`_manage_queue` 里 `token_limit * chat_history_token_ratio`（默认 21000）是拐点，超了就从**最老**开始丢，丢到够为止，**但至少留 1 条消息**，且保持"assistant→tool"配对完整。
  2. 读侧（装配）：`aget` 先把 chat_history + 所有 block 的内容一起算 token，若总和 > 30000，`_truncate_memory_blocks` 按 `priority` **升序**裁——`priority == 0` 的块**永不裁**（`BaseMemoryBlock.priority` 默认就是 0，所以自定义块默认享有保护），其余块先调 `block.atruncate(content, tokens_to_truncate)`，**基类 `atruncate` 直接 `return None` = 整块丢弃**（不是截断字符串），还不够就整块 `pop`。
- 源码：https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/memory/memory.py （`DEFAULT_TOKEN_LIMIT`/`DEFAULT_FLUSH_SIZE`/`Memory.token_limit`/`_manage_queue`/`_truncate_memory_blocks`/`BaseMemoryBlock.atruncate`）

### c.2 LlamaIndex 三个旧版 buffer（仍在用，默认值差得很远）

| 类 | `token_limit` 默认 | 超了怎么办 | 证据 |
|---|---|---|---|
| `ChatMemoryBuffer` | **3000**（`from_defaults` 传了 `context_window` 时改成 `int(context_window * 0.75)`） | 从最老往后丢，直到 ≤ limit；一次超限的单条则**直接返回最后一条**，注释写明"让 LLM 自己报错，而不是静默地少给" | [代码级] https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/memory/chat_memory_buffer.py （`DEFAULT_TOKEN_LIMIT = 3000`、`DEFAULT_TOKEN_LIMIT_RATIO = 0.75`、`get()`） |
| `ChatSummaryMemoryBuffer` | **2000** | 保留最新的**整段**消息直到逼近 limit，**其余全部压成一条 SYSTEM 摘要消息** | [代码级] https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/memory/chat_summary_memory_buffer.py （`DEFAULT_TOKEN_LIMIT = 2000`、`_split_messages_summary_or_full_text`、`_summarize_oldest_chat_history`） |
| `Memory`（新） | **30000** | 见 c.1 | 同上 |

**注意这个数量级差**：只留最近消息 → 3000；摘要旧消息 → 2000；带长期块的分层记忆 → 30000。**层级越多，预算反而放大 10 倍**，因为它们在赌"长期块比原始消息更省 token"。这个赌注正是我们要验的（长期块是否真的比最近 N 条消息更能防重复踩坑）。

### c.3 LangChain `SummarizationMiddleware`（当前主推的短时记忆裁剪器）—— [代码级]

| 常量 | 默认值 | 语义 |
|---|---|---|
| `_DEFAULT_MESSAGES_TO_KEEP` | **20** | `keep=("messages", 20)`：摘要后保留最近 20 条消息原文 |
| `_DEFAULT_TRIM_TOKEN_LIMIT` | **4000** | `trim_tokens_to_summarize`：**喂给摘要模型的输入最多 4000 token**，超了先裁老消息——防止"摘要器自己爆窗" |
| `_DEFAULT_FALLBACK_MESSAGE_COUNT` | **15** | 兜底保留条数 |
| `trigger` | **默认 `None` = 永不触发** | 必须显式给 `("tokens", N)` 或 `("fraction", 0.8)` 或 `{"tokens":4000,"messages":10}`；`{"..."}` 内是 **AND**，列表内是 **OR** |

[代码级] https://github.com/langchain-ai/langchain/blob/master/libs/langchain_v1/langchain/agents/middleware/summarization.py
[文档级] 官方示例用的就是 `trigger=("tokens", 4000), keep=("messages", 20)`：https://docs.langchain.com/oss/python/langchain/short-term-memory.md （"Summarize messages" 一节）

### c.4 LangMem `summarize_messages` / `SummarizationNode` —— [代码级]

| 参数 | 默认值 | 语义 |
|---|---|---|
| `max_tokens` | **必填，无默认** | 摘要后返回的消息列表的总预算，同时兼作"喂给摘要 LLM 的上限" |
| `max_tokens_before_summary` | `None` → **回落成 `max_tokens`** | 累计到多少 token 才开始摘 |
| `max_summary_tokens` | **256** | 摘要本身能占多少预算；`max_summary_tokens >= max_tokens` 直接 `ValueError` |
| 预算算式 | `max_remaining_tokens = max_tokens - max_summary_tokens` | 即默认配 `max_tokens=256` 时，留给原文的只有 0 |
| `token_counter` | `count_tokens_approximately` | 默认**近似**计数（不调真 tokenizer） |

- 行为：从最老往新累计，到 `max_tokens_before_summary` 就把这批（**不含 system message**）摘成一条，返回 `[summary_message] + remaining_messages`；传了 `running_summary` 就只处理没摘过的消息（`summarized_message_ids` 去重），避免每轮重摘。
- 防爆窗：若要摘的消息本身超过 `max_tokens`，**只摘最后 `max_tokens` 那部分**（保护摘要器上下文）。
- 若最后一条被摘的是带 tool_calls 的 AI 消息，**后续对应的 tool 消息必须一起摘**，否则消息序列非法。
- 源码：https://github.com/langchain-ai/langmem/blob/main/src/langmem/short_term/summarization.py （`summarize_messages`、`SummarizationNode.__init__`、`DEFAULT_*_SUMMARY_PROMPT`）
- 文档示例值（与上表一致的小值配置）：`max_tokens=256, max_tokens_before_summary=256, max_summary_tokens=128`，摘要模型另行 `bind(max_tokens=128)` 以保证预算估计准 —— https://langchain-ai.github.io/langmem/guides/summarization/

### c.5 三家口径对照（可直接当我们的默认值起点）

| 系统 | 总预算 | 短时/原文保留 | 摘要预算 | 触发器 | 裁剪动作 |
|---|---|---|---|---|---|
| LlamaIndex `Memory` | 30000 | 21000（0.7） | 无（block 自己管） | 水位 21000 | 整块丢弃（priority=0 保护） |
| LlamaIndex `ChatSummaryMemoryBuffer` | 2000 | 逼近 2000 的最近若干条 | 不受控（LLM 自定） | 超 2000 | 其余全压成 1 条摘要 |
| LangChain `SummarizationMiddleware` | 模型上下文的 fraction 或显式 tokens | **20 条消息** | 摘要输入裁到 4000 token | 显式 trigger（默认不触发） | 摘要 + 保 20 条 |
| LangMem `summarize_messages` | `max_tokens`（必填） | `max_tokens - max_summary_tokens` | **256** | 显式 | 摘要最老一批 |
| Memobase `context()` | `max_token_size` **1000** | profile+event 内容 | — | 每次取上下文 | 按 `profile_event_ratio=0.6` 分配、`time_range_in_days=180` 限窗 |

---

## d) 检索默认返回多少条、每条多长，为什么是这个量级

| 位置 | 默认 k | "每条多长" | 证据 |
|---|---|---|---|
| LangGraph `BaseStore.search` | **limit=10, offset=0**（`list_namespaces` 的 `limit=100`） | 无内建截断：整份 JSON 文档原样返回 | [代码级] https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/langgraph/store/base/__init__.py |
| LangMem `create_search_memory_tool` | **limit=10** | 同上，无截断 | [代码级] https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/tools.py |
| LangMem `create_memory_store_manager` | **query_limit=5** | 写入前取回旧记忆做去重/合并，5 条够判"是不是重复" | [代码级] https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/extraction.py |
| LlamaIndex `VectorMemoryBlock` | **similarity_top_k=2**，`retrieval_context_window=5` | 每个命中不是返回一条消息，而是它**前后各 5 条**的窗口 | [代码级] https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/memory/memory_blocks/vector.py |
| LlamaIndex `FactExtractionMemoryBlock` | `max_facts=**50**` 条 | 每条是一句短事实；超 50 就调 LLM `condense` 合并精简 | [代码级] https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/memory/memory_blocks/fact.py |
| Memobase `get_context` | — | `max_token_size=1000`，`profile_event_ratio=0.6`，`time_range_in_days=180`，`max_subtopic_size` 限制每个 topic 的子项数 | [文档级] https://docs.memobase.io/api-reference/prompt/get_context.md |

**为什么是这个量级**（推断，非文档原文，标注清楚）：
- **5 与 10 是两个不同用途的数字**：`query_limit=5` 是**写入侧找重复**（只需同义候选），`limit=10` 是**读侧给模型看**（人肉浏览一屏的量）。把两者混成一个常量是常见设计错误。
- **top_k=2 + 窗口 5** 的组合说明 LlamaIndex 的哲学是"**少命中、厚展开**"：宁可只找 2 处，也要把上下文补齐成可读的一段，而不是塞 10 条碎片。- **每条约 200-300 token 量级**是这些默认值的隐含假设：21000 / 20 条 ≈ 1000+ token/条（LangChain 的 20 条），3000 / 十几条 ≈ 200-300（LlamaIndex 的 3000 预算）。**条数不是独立参数，它是预算除出来的结果**——先定预算再定条数，不能反过来。

---

## e) 他们自己承认的失败模式

1. **过度抽取 vs 抽取不足，是结构性二选一**：LangMem 文档直接写 "If the system over-extracts, this could lead to reduced precision of memories… If it under-extracts, this could lead to low recall"，并说它们的"memory enrichment"只是在两者间**调**，不是消灭。—— [文档级] https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
2. **collection 的删除/更新是整个设计里最脏的地方**：LangGraph 文档原话 "The model must now *delete* or *update* existing items in the list, which can be tricky. In addition, **some models may default to over-inserting and others may default to over-updating.**"—— [文档级] https://docs.langchain.com/oss/python/concepts/memory
3. **profile 越大越容易写坏**："This can become error-prone as the profile gets larger, and may benefit from splitting a profile into multiple documents or **strict** decoding"。—— 同上
4. **hot path 偷走 agent 的注意力**：LangMem "adds one more obstacle to the agent's ability to satisfy the user's needs"；LangGraph "the agent must multitask between memory creation and its other responsibilities, potentially affecting the quantity and quality of memories created"。—— [文档级] 上面两个 URL
5. **background 的频率是个调不出来的参数**："infrequent updates may leave other threads without new context"。—— [文档级] https://docs.langchain.com/oss/python/concepts/memory
6. **默认裁剪 = 整块消失，不是压缩**：LlamaIndex `BaseMemoryBlock.atruncate` 基类 `return None`，文档也承认 "By default, this just means they are **removed** from memory until there is room again"。—— [代码级] memory.py / `BaseMemoryBlock.atruncate`；[文档级] https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/
7. **token 估算是不准的，且他们是故意的**：`count_tokens_approximately` 是 LangMem 的默认计数器；LlamaIndex 用 `tokenizer_fn` 估 + 图片固定 256。—— [代码级] summarization.py / memory.py。**含义：所有"预算"都是软上限，必须有硬兜底**。
8. **Memobase 的预算只算内容不算模板**：文档明确 Note "The `max_tokens` limit applies to the profile and event content, **not the final formatted string**. If you use a large custom prompt template, the final output may still exceed the limit."。—— [文档级] https://docs.memobase.io/features/context.md
9. **[代码级观察，非官方承认]** LangMem 的 `MemoryManager._prepare_messages` **完全不做 token 裁剪**：它把整段会话 `utils.get_conversation(messages)` 原样拼进一条 user 消息（`<session_{uuid}>…</session_{uuid}>`）就发给模型。长会话会直接顶到模型上限。—— https://github.com/langchain-ai/langmem/blob/main/src/langmem/knowledge/extraction.py （`_prepare_messages`）。**这是我们可以做得比它好的地方。**

---

## f) 它们对"每步重发"这件事有没有显式处理（Lead 点名要的）

- **LangGraph**：**有，且是显式的**——"Short-term memory updates when the graph is invoked or a step is completed, and **the State is read at the start of each step**"。即：整份 state（含 messages）每步都重发给模型，靠 checkpointer 持久化、靠裁剪中间件控制体积。—— [文档级] https://docs.langchain.com/oss/python/concepts/memory
- **LlamaIndex**：**有，在 `aget` 里**——每次取上下文都重新"chat_history + 全部 memory block → 算 token → 截断 → 格式化 → 插入 system message"，也就是**每回合重新装配一遍**，所以预算必须卡在 `Memory` 对象上而不是调用点。—— [代码级] `Memory.aget`（memory.py）
- **LangMem**：**只在摘要函数里处理**——`summarize_messages` 明确说 "`max_tokens`: … This will also be used as the maximum number of tokens to feed to the summarization LLM"，即它管的是"这一轮我要发出去多少"，属于调用点负责，框架不管。—— [代码级] summarization.py
- **结论**：三家都把"每步重发"当成**默认事实**，没有一家试图避免重发，全部靠"重发前裁剪"。我们要不要把整份索引每步重发，应该照这个共识做，而不是发明新机制。

---

## g) 轻量实现：Memary / Memobase

**Memary**（[文档级] https://github.com/kingjulio8238/Memary/blob/master/README.md ）：
- 模块 = **Memory Stream**（记录所有进 KG 的实体及其时间戳，反映"知识面的广度"）+ **Entity Knowledge Store**（KG）；设计受 Microsoft K-LaMP 影响。
- 检索 = **recursive retrieval**：先从 query 认出关键实体，构建这些实体**深度最大 2** 的子图，再用子图拼上下文。
- **这条与我们高度重合**（我们的顺藤摸瓜也是深度 ≤2），可以当外部佐证：深度 2 是"够用且不炸"的经验值，不是拍脑袋。

**Memobase**（[文档级] https://docs.memobase.io/features.md 、https://docs.memobase.io/features/async_insert.md 、https://docs.memobase.io/features/context.md ）：
- **Buffer + Flush**：新数据先落临时 buffer，再（自动或手动）flush 进长期 profile。flush **默认异步**（`user.flush()` 立即返回，`user.flush(sync=True)` 才等），文档理由是"preventing memory operations from blocking the main thread"——这就是 background 写入的产品化形态。
- 上下文 = **profile（结构化 topic/subtopic）+ events（带时间）** 两段拼；`context(max_tokens=...)` 控总量，`profile_event_ratio` 配比，`prefer_topics`/`only_topics` 控主题，`time_range_in_days` 控时间窗。
- **"开场摘要 + 按需展开"的对应物**：它没有"开场摘要"，而是**开场给 profile（压缩过的稳定事实）+ 最近 events（原始事件）**，检索时用**最近消息做语义查询**去捞更相关的历史事件（"Memobase will perform a semantic search to prioritize the most relevant historical events, rather than simply returning the most recent ones"）。**这个"用当前问题去捞历史事件"的读法，比"按时间倒序"更接近我们要的"顺藤摸瓜"。**

---

## h) 最该被吸收的 3 点（给本仓的直接建议）

1. **预算是"一个数 ÷ 出来的条数"，不是"条数"**：LlamaIndex 30000 × 0.7 = 21000 再按 3000 批量驱逐；LangChain 20 条 + 4000 摘要输入。→ 我们的注入应定义**一个总预算常量**（如 `INJECT_TOKEN_BUDGET`），条数/每卡长度都由它除出来，并且**摘要器的输入也要单独设上限**（LangChain 的 `trim_tokens_to_summarize=4000` 是最容易被忽略的一条：摘要器自己也会爆窗）。
2. **裁剪要分级 + 保护位**：LlamaIndex 用 `priority` 升序裁、`priority==0` 永不裁，且默认裁法是**整块丢弃**。→ 我们的记忆卡应显式分级（教训 > 定式 > 索引行），并让"首轮 INDEX 行"落在不可裁的那一级；同时默认动作选"整块丢弃"而不是"截半句"，因为截断会产生**半真半假的记忆**（比没有更危险）。
3. **写入时机挂在"会话边界"，不挂 cron**：LangMem 的 background 明确说频率是难点（写太稀 → 别的会话没新上下文）；Memobase 把它做成 buffer + flush（默认异步、边界触发）。→ 我们有 `agent/turn-stopping` 这个可 await 的边界信号，天然优于定时轮询；**同步写只留"用户显式纠正"一种**（对应 LangChain 的 hot path：只在关键上下文出现时立刻写）。

---

## 附：本次读取过程中踩到的坑（供下一个接手者省时间）

- `langchain-ai/langchain` 默认分支是 **master**，不是 main；`langgraph`、`langmem`、`llama_index` 才是 main。
- `docs.langchain.com/oss/python/langgraph/memory` 已 302 到 `/oss/python/concepts/memory`；**加 `.md` 后缀可拿到纯 markdown**（`https://docs.langchain.com/oss/python/concepts/memory.md`），比抓 HTML 干净得多。
- `developers.llamaindex.ai` 的新文档站导航把正文挤到截断位置，需要先下 HTML 再剥标签；正文里含 `token_limit (default: 30000)` 这类关键默认值，值得剥。
- `web_search` 在本机**不可用**（`api.deepseek.com/v1/tools/search` 返回 401），全程只能靠 `web_fetch` + `curl` 直取源码，路径要靠猜 + 试（`raw.githubusercontent.com` 偶发 `Recv failure: Connection was reset`，加重试即可）。