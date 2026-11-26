# 厂商官方记忆与上下文工程（Anthropic / OpenAI / Google / 本机 DSH）

> 采集 2026-11-26。每条标 **[文档级]**（官方文档原文）或 **[代码级]**（真实源码/常量）。
> `docs.anthropic.com`、`ai.google.dev`、`platform.openai.com` 在本机均被跨域重定向或 Cloudflare 拦截；Anthropic 原文统一取自官方全量文档 `https://platform.claude.com/llms-full.txt`（56 MB / 965 页，索引 `https://platform.claude.com/llms.txt`）。

## 0 · 八行速览

1. Anthropic prompt cache 是**前缀哈希**：**只在 breakpoint 写入**，读取只能回看**前 20 个 block 内曾经的写入点**，不是"找稳定内容"。
2. **追加内容**（尾部加）天然命中原缓存；**改早前内容**（tools / system / 早期 messages）让该层及其后全部失效。
3. 层级固定 `tools → system → messages`：改 tools 全废；改 system 废 system+messages；只改 messages 尾部只废尾部。
4. breakpoint 放**静态前缀最后一块**；放在"每请求都变的块"上 ⇒ 每次写缓存、永不读缓存（官方点名此坑）。
5. Anthropic 把长上下文手段分成四件：**压缩 / 结构化笔记（外部记忆文件）/ 子代理隔离 / JIT 检索**，各给了适用场景（§2.1）。
6. Claude Code 的 `CLAUDE.md` **不是系统提示词**，而是"系统提示词之后的一条 user message"；项目根 CLAUDE.md 在 `/compact` 后从磁盘重读重注。
7. OpenAI ChatGPT 记忆分两层：**显式 saved memories**（独立存储，删聊天不删它）与 **reference chat history**（派生、会变、关掉后 30 天内删除）；Responses 用 `previous_response_id` + `store`，`truncation` 默认 `disabled`（超窗 400）。
8. Google cache 与内容绑定且**只能改 TTL/过期时间、不能改内容**；ADK `MemoryService` 三层（内存关键词 / Memory Bank 语义抽取 / RAG 向量）。

## 1 · Anthropic prompt caching：什么改动会让缓存失效 **[文档级]**

来源：`https://platform.claude.com/docs/en/build-with-claude/prompt-caching`（小节 `What invalidates the cache`）

**1.1 总规则（原文）**
> "the cache follows the hierarchy: `tools` → `system` → `messages`. Changes at each level invalidate that level and all subsequent levels."
> "Prompt caching covers the full prefix: `tools`, `system`, and `messages` (in that order), up to and including the block designated with `cache_control`."

**1.2 失效对照表（逐字转录；层级列按 tools/system/messages 顺序，✘=失效 ✓=保留）**

| 改动 | tools/system/messages | 原文 Impact |
|---|---|---|
| Tool definitions | ✘/✘/✘ | "Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache" |
| Web search toggle | ✓/✘/✘ | "Enabling/disabling web search modifies the system prompt" |
| Citations toggle | ✓/✘/✘ | "Enabling/disabling citations modifies the system prompt" |
| Speed setting | ✓/✘/✘ | "Switching between `speed: \"fast\"` and standard speed invalidates system and message caches" |
| Tool choice | ✓/✓/✘ | "Changes to the `tool_choice` parameter only affect message blocks" |
| Images | ✓/✓/✘ | "Adding/removing images anywhere in the prompt affects message blocks" |
| Thinking parameters | 模型相关/模型相关/✘ | "rendered into the prompt, so changing it always invalidates message blocks" |
| Effort setting | 模型相关/模型相关/✘ | "Setting effort explicitly to the model's default is equivalent to omitting it and does not invalidate" |
| 非工具结果 + thinking | ✓/✓/模型相关 | 新一代模型 thinking 默认保留⇒✓；旧模型剥掉 thinking 及其后消息⇒✘ |
| Dropped thinking blocks | ✓/✓/✘ | "the cached prefix changes from that block's position onward on that request" |

**1.3 三条机制（原文，决定"追加 vs 修改"的后果）**
> "1. **Cache writes occur only at your breakpoint.** … Because the hash is cumulative, covering everything up to and including the breakpoint, changing any block at or before the breakpoint produces a different hash on the next request."
> "2. **Cache reads look backward for entries that prior requests wrote.** … It is looking for prior writes, not for stable content."
> "3. **The lookback window is 20 blocks.** The system checks at most 20 positions for each breakpoint, counting the breakpoint itself as the first."

**1.4 breakpoint 该放哪（最实用一句）**
> "**Key takeaway:** Place `cache_control` on the last block whose prefix is identical across the requests you want to share a cache. … For a prompt with a varying suffix (timestamps, per-request context, the incoming message), place the breakpoint at the end of the static prefix, not on the varying block."

官方反例：静态块 1–5 + 每请求变的第 6 块，breakpoint 放第 6 块 ⇒ "You pay for a fresh cache write on every request and never get a read."
多 breakpoint：最多 **4 个**；"If a growing conversation pushes your breakpoint 20 or more blocks past the last write, the lookback window misses it."

**1.5 成本面（原文）**
> "Cache write tokens with a 5-minute TTL are 1.25 times the base input tokens price." / "…1-hour TTL are 2 times…" / "**Cache breakpoints themselves don't add any cost.**"

**1.6 官方排障**：`https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics` —— "reports where the prompt prefix changed, to explain cache misses."

## 2 · Anthropic：何时压缩 / 外部记忆 / 子代理 **[文档级]**

主源：`https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents`

**2.1 四件套的官方分工（原文）**
> "The choice between these approaches depends on task characteristics. For example:
> - Compaction maintains conversational flow for tasks requiring extensive back-and-forth;
> - Note-taking excels for iterative development with clear milestones;
> - Multi-agent architectures handle complex research and analysis where parallel exploration pays dividends."

- **压缩**："taking a conversation nearing the context window limit, summarizing its contents, and reinitiating a new context window with the summary"，官方称"第一根杠杆"；Claude Code 实现保留"最近访问的 5 个文件"；最轻形式是清工具结果。
- **结构化笔记/agentic memory**："the agent regularly writes notes persisted to memory outside the context window. These notes get pulled back into the context window at later times."（`NOTES.md`、todo）
- **子代理**："specialized sub-agents can handle focused tasks with clean context windows… returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)"
- **JIT 检索**："maintain lightweight identifiers (file paths, stored queries, web links)… load data into context at runtime using tools"，官方称这是 Claude Code 的做法。

**2.2 context editing（服务端自动清）** `https://platform.claude.com/docs/en/build-with-claude/context-editing`，beta `context-management-2025-06-27`：
`clear_tool_uses_20250919`（配 `trigger`/`keep`/`clear_at_least`，`clear_tool_inputs=true` 连 tool_use 参数一起清，结果替换为占位文本）、`clear_thinking_20251015`（`keep` 控制保留量）。
> 与缓存的关系（原文）："Tool result clearing: Invalidates cached prompt prefixes when content is cleared. To account for this, clear enough tokens to make the cache invalidation worthwhile. Use the `clear_at_least` parameter…"
> "Thinking block clearing: When thinking blocks are **kept**… the prompt cache is preserved… When thinking blocks are **cleared**, the cache is invalidated at the point where clearing occurs."

**2.3 memory tool（外部记忆文件）** `https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool`
> "store and retrieve information across conversations in a directory of memory files… building up knowledge over time without keeping everything in the context window."
> "Memory supports just-in-time context retrieval. Rather than loading all relevant information up front, an agent records what it learns in memory files and reads them back on demand."
> "Because the memory tool is client-side, Claude only requests memory operations… The `/memories` path is a prefix that your handler maps onto real storage."

**2.4 threshold compaction（服务端自动压缩）** `https://platform.claude.com/docs/en/build-with-claude/compaction-threshold`
> "1. Detects when input tokens reach your specified trigger threshold. 2. Generates a summary… 3. Creates a `compaction` block containing the summary."
> "On subsequent requests… The API automatically drops all content blocks prior to the `compaction` block, continuing the conversation from the summary."
默认摘要提示词要求包 `<summary></summary>`，"to provide continuity so you can continue to make progress… in a future context"。

## 3 · Anthropic 明确写出的反模式 **[文档级]**

源：`https://www.anthropic.com/engineering/building-effective-agents`、`…/effective-context-engineering-for-ai-agents`

- 一上来就上复杂框架/多智能体："finding the simplest solution possible, and only increasing complexity when needed. This might mean not building agentic systems at all."
- 框架抽象遮住 prompt："extra layers of abstraction that can obscure the underlying prompts and responses, making them harder to debug… tempting to add complexity when a simpler setup would suffice."
- 对底层机制的错误假设："Incorrect assumptions about what's under the hood are a common source of customer error."
- 工具集臃肿："bloated tool sets that cover too much functionality or lead to ambiguous decision points about which tool to use."
- 用穷举边界情况当 few-shot："teams will often stuff a laundry list of edge cases into a prompt… We do not recommend this."
- 提示词里硬编码脆逻辑："hardcoding complex, brittle logic in their prompts… creates fragility and increases maintenance complexity over time."
- 含糊的高层指引："vague, high-level guidance that fails to give the LLM concrete signals… or falsely assumes shared context."
- 只等大窗口："Waiting for larger context windows might seem like an obvious tactic. But… context windows of all sizes will be subject to context pollution…"
- 过度压缩："overly aggressive compaction can result in the loss of subtle but critical context whose importance only becomes apparent later."
- 把上下文当免费："Context… must be treated as a finite resource with diminishing marginal returns."

## 4 · Claude Code：CLAUDE.md 分层与 auto memory **[文档级]**

源：`https://code.claude.com/docs/en/memory`

- 加载顺序（宽→窄）：**Managed policy**（`/Library/Application Support/ClaudeCode/CLAUDE.md`、`/etc/claude-code/CLAUDE.md`、`C:\Program Files\ClaudeCode\CLAUDE.md`）→ **User**（`~/.claude/CLAUDE.md`）→ **Project**（`./CLAUDE.md` 或 `./.claude/CLAUDE.md`）→ **Local**（`./CLAUDE.local.md`，入 .gitignore）。
- "All discovered files are concatenated into context rather than overriding each other."；子目录 CLAUDE.md 惰性加载（读到该目录文件时才加载）。
- **注入位置真相（对棋院最关键）**："CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself."
- **压缩后存活**："Project-root CLAUDE.md survives compaction: after `/compact`, Claude re-reads it from disk and re-injects it into the session."；嵌套 CLAUDE.md 与 `paths:` 规则按需重载。
- 体量红线：单文件建议 "under 200 lines"；> 4 MiB 直接跳过；按需加载子目录文件超限只喂前段（200K 窗口 40,000 字符；1M 窗口 200,000 / 150,000 字符）。
- **auto memory**（机器写的第二层）：`~/.claude/projects/<project>/memory/`，`MEMORY.md` 作索引，**只加载前 200 行或 25KB**，topic 文件按需读；类型固定 `user / feedback / project / reference`。
- "Claude skips anything it can derive from the codebase… It also skips anything your CLAUDE.md files already say."

## 5 · OpenAI **[文档级] + [代码级]**

**5.1 ChatGPT memory 的两层** `https://help.openai.com/en/articles/8590148-memory-in-chatgpt`
- **Saved memories**："details that you explicitly ask ChatGPT to remember… stored separately from chat history. Deleting the original chat does not automatically delete a separate saved memory."
- **Reference chat history**："Unlike an explicit saved memory, information derived from chat history can change as ChatGPT updates what is most useful to remember."；关闭后 "scheduled for deletion from OpenAI systems within 30 days"；关闭 saved memories 会连带关闭它。
- 第三形态 **improved memory**：持续更新的宽摘要（`Memory summary` 是其视图，官方说摘要 "does not necessarily include every detail or source"）。
- 边界（原文）："Memory does not retain every detail from every conversation."；"ChatGPT looks for relevant context when it is likely to improve a response."（**非每轮检索**）

**5.2 Responses API 的 conversation state / truncation [代码级]**
`https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_create_params.py`
- `store`："Defaults to true when omitted. If set to true, response data will be stored for at least 30 days"。
- `previous_response_id`："Use this to create multi-turn conversations… Cannot be used in conjunction with `conversation`."（服务端保管状态，客户端只发增量）
- `instructions` 交互："When using along with `previous_response_id`, the instructions from a previous response will not be carried over to the next response."（系统指令不进服务端历史，可换）
- `truncation`：`auto` ="the model will truncate… **dropping items from the beginning of the conversation**"；`disabled`（**默认**）="the request will fail with a 400 error"。附注："On some models, trimming can begin earlier because the API subtracts the model's maximum output allowance from its input limit, even if you set a lower `max_output_tokens`."
- `prompt_cache_key`（取代旧 `user`）："Used to boost cache hit rates by better bucketing similar requests"。

## 6 · Google：Gemini context caching + ADK memory **[文档级] + [代码级]**

**6.1 Gemini caching** —— `https://github.com/google-gemini/cookbook/blob/main/quickstarts/Caching.ipynb`（指向 `https://ai.google.dev/gemini-api/docs/caching`）+ `https://github.com/googleapis/python-genai/blob/main/google/genai/caches.py`
- **内容不可改**：SDK 只有 `caches.update(name, config=UpdateCachedContentConfig)`，可写字段仅 `ttl` / `expire_time`（源码 130–134 行），没有任何改 prompt/tools 的字段 ⇒ 内容一变只能删了重建。
- **模型绑定**："caches are model specific. You cannot use a cache made with a different model as their tokenization might be slightly different."
- **过期即失效**："by default it is only saved for an hour."，`ttl` 可调；不用了 "it is good practice to delete it proactively"。
- **显式 vs 隐式**："Explicit caching… is supported on Gemini 3 and Gemini 2.5 models. Gemini 4 models… use automatic **implicit caching** (delivering a 95% discount on repeated input prefixes of 4,096 tokens or more) and do not support explicit cache creation."（隐式=按前缀匹配，门槛 4,096 tokens）
- 计量："cached prompt tokens are included in `prompt_token_count`, but excluded from `total_token_count`."

**6.2 ADK MemoryService 分层** —— 文档 `https://github.com/google/adk-docs/blob/main/docs/sessions/memory.md`（渲染页 `https://adk.dev/sessions/memory/`），基类 `https://github.com/google/adk-python/blob/main/src/google/adk/memory/base_memory_service.py`

| 实现 | 持久化 | 记忆抽取 | 检索 |
|---|---|---|---|
| `InMemoryMemoryService` | 重启即丢 | "Stores full conversation" | "Basic keyword matching" |
| `VertexAiMemoryBankService` | 有 | "Extracts meaningful information… and consolidates it with existing memories powered by LLM" | "Advanced semantic search" |
| `VertexAiRagMemoryService` | 有 | "Stores full conversation, indexed by Knowledge Engine" | "Vector similarity search" |

- 接口只有 `add_session_to_memory(session)` 与 `search_memory(...) -> SearchMemoryResponse(memories: list[MemoryEntry])`；另有 `add_events_to_memory(events=…)`，注释明确 "treat `events` as an incremental update (delta) and must not assume it represents the full session."
- 仓库另有 `_sqlite_memory_service.py`；关键词版按词交集打分，`_MAX_SEARCH_RESULTS = 10`，中日文按单字切（`in_memory_memory_service.py`）。

## 7 · 本机 DSH 宿主：压缩接缝的真实常量 **[代码级]**

来自 `D:\DeepSeek Harness\Desktop-0.2.2-rc.2\resources\app.asar` 内 `/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/src/{config,region,summarizer}.ts`（解析 asar 后只读提取，未改动任何文件）

**7.1 阈值常量（`config.ts`）**
- `DEFAULT_THRESHOLD_RATIO = 0.8`（窗口 80% 触发）、`DEFAULT_RETAIN_RATIO = 0.16`（尾部保留 16%）、`headroomTokens ?? 65_536`、`compactionRetries ?? 1`、`maxOverflowRetries ?? 1`、`auto ?? true`。
- `thresholdTokens = floor(min(contextWindow * thresholdRatio, pressureBudgetTokens))`，`pressureBudgetTokens = contextWindow - reservedCompletionTokens - headroomTokens`；`retainTokens = floor(messageBudgetTokens * retainRatio)`。
- 加载期校验：`retainRatio < thresholdRatio`、`retainTokens < thresholdTokens`，否则报错。

**7.2 区间怎么切（`region.ts` → `selectCompactableRange`）**
- 从尾部反向累加至 `retainTokens` 确定 `keepFromIdx`（"retaining a priced recent tail"）。
- **system head 永不进区间**："A `system/message` at surface node 0 is never inside the range."
- **绝不切开 tool_use/tool_result 对**：`toolPairingBalancedBefore(...)` 不成立就继续前移。
- 事务化：只读校验 → 同步相邻写 `compaction/start` → 摘要 → `compaction/end`；"Every later failure makes exactly one `compaction/end` attempt; a failed close deliberately leaves the unmatched start detectable."
- **重放**：surface 由"日志 + 压缩括号"推导，被压内容不删除，只被 checkpoint 节点遮蔽（`shadowedSeqs` / `shadowedTokenCount`）。

**7.3 摘要调用如何不破坏上游缓存（`summarizer.ts`）——最值得抄的一条**
> "The summarization directive, delivered as the FINAL user message after the replayed conversation rather than as a distinct summarizer system prompt. **Keeping the conversation's own system prompt, tools, and message prefix in front of it makes the auxiliary call a genuine prefix of the last routed request, so the provider's KV cache is reused instead of invalidated.**"

- 摘要包 `<compacted-summary> … </compacted-summary>`；替换用 user message 前置 `CHECKPOINT_PREAMBLE`（"Treat the captured context as established background… without acknowledging this checkpoint."）。
- 结构固定 8 段：Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context。
- 多次压缩合并（原文）："If the conversation already contains a `<compacted-summary>` block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary."

**7.4 本机 Anthropic 适配器的 breakpoint 摆放**（`@earendil-works/pi-ai/dist/api/anthropic-messages.js`）
- `getCacheControl` → `{ type: "ephemeral", ...(ttl && { ttl }) }`，`ttl` 仅在 `retention === "long"` 且模型支持长缓存时为 `"1h"`。
- 三处打点：**最后一个 system text block**、**工具列表最后一条**（`index === tools.length - 1`）、**最后一条 user/system 消息的最后一个块**（"Add cache_control to the last user or system message to cache conversation history"）。
- 工具变更不破前缀："The list never changes afterwards: later tools are defined by value in `tool_addition` blocks and withdrawn by `tool_removal`, so the cached prefix survives every tool change."

## 8 · 对棋院可落地的三条

1. **注入位置决定缓存成本**：Claude Code 官方把 CLAUDE.md 放在"系统提示词之后的一条 user message"，并在压缩后重读重注 —— 与本机 `agent/pre-step` 替换入步消息的接缝同构。注入落在**历史尾部追加**只损失尾部；落在**改动早期消息或 system** 会让该层及其后全部失效。
2. **breakpoint 固定在静态前缀末尾**（system + 不变量），不要落在每轮变化的注入块上，否则"每次都写缓存、永不读缓存"；单轮新增 block 可能超 20 时按官方建议加第二个 breakpoint。
3. **压缩/记忆写入必须承认缓存代价**：官方 context editing 明说清理会失效前缀、要用 `clear_at_least` 让一次失效"值回票价"；本机 DSH 更进一步——摘要调用复用上游同一前缀，只在末尾追加指令，使辅助调用自身命中 KV 缓存。

## 9 · 未验项

- Anthropic cache **读取**单价未取到原文（只有写入 1.25×/2×），故不写数字。
- Gemini 显式缓存**最低 token 门槛**在 cookbook 正文中无数值（只有隐式缓存 ≥4,096 tokens 的原文）。
- OpenAI Responses 各参数文档页被 Cloudflare 拦截，5.2 全部取自官方 SDK 的类型定义 docstring（代码级），未逐条对照渲染页。