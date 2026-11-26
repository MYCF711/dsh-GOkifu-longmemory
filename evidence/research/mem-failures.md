# 记忆系统的系统性失败模式：基准判定代码 + 项目公开复盘

> 采集日期 2026-11-26。证据分级：**[代码级]** = 我读了仓库源码并抄录关键行；**[论文级]** = 论文正文/表格；**[issue级]** = 项目 issue/PR 原文；**[本仓]** = 本仓库实测证据文件。
> 代码一律标 `仓库/文件#符号`，并注明读取的 ref（`main` 或 tag `0.16.8`）；裸行号会漂移，不作唯一依据。
> 本文只做只读研究：不改源码、不跑测试、不 git 操作。

## 0 · 8 行摘要

1. 三个基准测的不是同一件事：LoCoMo 测「超长对话里的单跳/多跳/时序/开放域/对抗」，LongMemEval 测「抽取、跨会话推理、知识更新、时序、弃答」五能力，MemBench 加测「反思记忆 + 观察者视角 + 容量/效率」。
2. 三份基准的判定器都很脆：LoCoMo 对抗题只认 `no information available` / `not mentioned` 子串（**[代码级]**），LongMemEval 的更新题判定明确容忍"旧值和新值一起出现"（**[代码级]**）。
3. 最有杀伤力的数字来自 MemBench 的容量曲线：全量注入（FullMemory）从 10k→100k token，参与式准确率 0.647→0.489，反思题 0.733→0.533，观察式反思题 0.883→0.333（**[论文级]**）。
4. LoCoMo 给出同类结论的另一个侧面：长上下文与 RAG 能涨 22–66%，但仍比人低 56%，时序推理低 73%；长上下文模型在对抗题上比基座低 83%，且"爱把对话/事件安到错的说话人头上"。
5. Mem0 已经把「LLM 判 ADD/UPDATE/DELETE/NOOP」整段删掉，现行 `main` 是纯 ADD（`ADDITIVE_EXTRACTION_PROMPT`，事件只有 `"event": "ADD"`）；被删掉的那条 NOOP 分支留下的 bug 记录在 issue #3780。
6. 删掉更新判定的代价写在 prompt 里："**When in doubt, extract.** A slightly redundant memory is far less costly than a missing one"（**[代码级]**），于是判重全压给下游——而下游只有"同文本 md5 + 只看 top-10 既有记忆"。
7. 这个窗口盲区有公开实录：mem0 #7123 记录「1 小时内对同一事实产出 8 条近重复记忆」，根因就是 `topK=10` 且无相似度阈值（**[issue级]**）。
8. Letta 的压缩是「按条数、整段替换、只降不升」：`_partial_evict_buffer_summarization` 只在 `force=True` 时动手，超窗时直接 `forcefully clearing message history`；公开 issue #3270 是「sliding_window 忽略比例、整段清空」（**[代码级]+[issue级]**）。

## 1 · 各基准测什么，判定代码实际判什么

### 1.1 LoCoMo（arXiv 2402.17753，SNAP）

- 测什么：50 段平均 300 轮 / 9K token / 最多 35 会话的长对话；三任务 QA、事件图摘要、多模态对话生成。QA 五类：多跳(1)、单跳(2)、时序(3)、开放域(4)、对抗(5)（类别号取自判定代码的分支）。
- 报告的系统性错误：长上下文与 RAG 提升 22–66%，仍低于人类 56%，**时序推理低 73%**；长上下文模型对抗题比基座低 83%，"especially prone to misassigning dialogs or events to the wrong speaker"，事件图摘要比基座低 14%；结论是"抓到了事实碎片，但没理解上下文"。数据侧证据：标注者为修长期不一致，改了近 **15%** 的对话轮、替换约 19% 的图片（**[论文级]**）。
- 判定代码 `snap-research/locomo#task_eval/evaluation.py`（`eval_question_answering`，**[代码级]**）：category 3 先 `answer.split(';')[0]`；category 2/3/4 用 `f1_score`（Porter 词干 + 去冠词/标点/小写）；category 1 用部分 F1（`f1()` 对子答案取均值）；category 5 只有一句
  `if 'no information available' in output.lower() or 'not mentioned' in output.lower(): all_ems.append(1) else: all_ems.append(0)`。
  → 换句话说：**换个措辞的正确拒答会被判 0**；时序题只比对第一个分号前的答案。
- 召回另算：`if eval_key+'_context'` 时按 evidence 是否落在注入的 session/turn 里求 `recall_acc`。

### 1.2 LongMemEval（arXiv 2410.10813，ICLR 2025）

- 测什么：500 题，五能力七题型（单会话-用户/助手/偏好、多会话推理、知识更新、时序推理、弃答）；历史可自由扩展（S≈115k，M≈1.5M token）。
- 报告的系统性错误：商业系统与长上下文模型掉 ~30%；人工评测里 **"ChatGPT tended to overwrite crucial information as the chat continues"**，**"Coze often failed to record indirectly provided user information"**；读了完美召回后仍不会用——加 Chain-of-Note + 结构化格式能涨 10 个绝对点；事实级压缩"整体变差（信息损失）但多会话推理变好"；时间无关的索引在时序题上很差（**[论文级]**）。
- 判定代码 `xiaowu0162/LongMemEval#src/evaluation/evaluate_qa.py`（`get_anscheck_prompt`，**[代码级]**）：按题型换 prompt，关键两处——
  - 时序题显式放过差一天："do not penalize off-by-one errors for the number of days"；
  - 更新题显式容忍旧值共存："If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer"。
  → **判定器无法发现"新旧事实同时存在于记忆里"**，这正好是最常见的更新失败形态。
  - 弃答题用独立 prompt："answer yes if the model correctly identifies the question as unanswerable"。
- 召回代码 `src/retrieval/eval_utils.py#evaluate_retrieval`：同时报 `recall_any`（任一证据进 top-k）与 `recall_all`（全部证据都进 top-k）+ `ndcg@10`。多证据题看 `recall_all`，这才是"够不够用"的判据。

### 1.3 MemBench（arXiv 2506.21605，ACL 2025 findings）

- 测什么：事实记忆 + 反思记忆两级；参与式/观察式两场景；四个指标 **accuracy / recall / capacity / efficiency**（读、写耗时）。
- 关键量化（Table 3/4，**[论文级]**，Qwen2.5-7B + e5-small）：
  - FullMemory 参与式 10k→100k：0.647→0.489；观察式 0.786→0.631；
  - 反思题：参与式 0.733→0.533；观察式 0.883→0.333；
  - 效率反例：MemGPT 读 4.5s/轮、MemoryBank 写 8–18s/轮；RetrievalMemory 读写 0.02–0.06s。
  - 定义里写了"capacity = 到某点后准确率骤降的阈值"，这本身就是一条机械判据。

## 2 · 失败模式表（12 行；"【必然】"= 在「全量重建 + 每轮注入 + 无增量」设计下**必然发生**）

| # | 失败模式 | 典型症状 | 机械可测的判据（可写成断言） | 预防手段（落到函数/不变量） |
|---|---|---|---|---|
| 1 | **【必然】容量塌陷（全量注入无裁剪）** | 会话越长越差，早期事实被淹；成本线性涨 | 单轮注入 token 数与会话轮数线性相关（回归斜率 > 0）；或同一回归下 accuracy 随注入 token 单调不增（MemBench FullMemory 10k→100k 掉 0.158） | 注入层强制预算：`buildMemoryCard` 输出前按 token 上限裁剪并保证"预算内条数 ≤N"；裁剪策略必须可复算（稳定排序），不按模型感觉 |
| 2 | **【必然】同一记忆同会话重复注入** | 同一段历史每轮重贴一遍，模型重复引用、token 浪费 | 同一 `memoryId` 在同一 session 的注入次数 ≥ 2；或"注入去重率 = 1 − 去重后条数/原始条数" 长期为 0 | 注入账本 + once-per-session 门（[本仓 `evidence/T24-redundant-injection.md`、`evidence/T25-once-per-session.md`]）：`sessionId⊕memoryId` 已注入即跳过；tombstone test 断言第二次注入返回空 |
| 3 | **【必然】重复存储（判重窗口/文本哈希）** | 同一事实多条近重复；条数比事实数增长快 | 同一 `(scopeKey, 规范化文本)` 计数 > 1；或同一 `(实体, 属性)` 在无 `supersedes` 时计数 > 1；或"新增条数/去重后条数" > 1 | 写入前置唯一键 + 幂等重放（mem0 现行 `_add_to_vector_store` 只做 `hashlib.md5(text)` 精确去重、既有记忆只看 `top_k=10`，见 #7123）；判重键要用规范形而非原文本 |
| 4 | **【必然】更新丢失 / 新旧并存** | 旧值（如旧端口、旧约定）与新值同时被注入，模型随机取一个 | 同一 `(实体, 属性)` 存在 ≥2 条互斥值且都没有 `supersededBy`；或"读侧返回的 claim 里存在 occurredAt 更早但未标 superseded 的互斥项"计数 > 0 | 只增不改 + 显式 `supersedes`/`supersededBy` 链 + 读侧按 `occurredAt` 取最新（LongMemEval 的判定器**抓不到**这类错误，见 §1.2，必须自己加断言） |
| 5 | **【必然】事实漂移 / 自证污染** | 从摘要再抽取，句式越来越像模型腔，细节逐轮丢失 | 抽取输入中含 LLM 生成摘要（`<compacted-summary>`/`<chess-fold>`/任何模型生成字段）的条数 > 0；或 claim 的 `support` 无法回指到原始 `seq` 的比例 > 0 | 抽取源白名单化：只吃原始事件/棋谱边；`provenance` 缺失即拒收（LoCoMo 靠人工修掉 15% 轮次的不一致，就是漂移的外部证据） |
| 6 | **【必然】时序错（把入档时间当发生时间）** | "上次说 X" 变成"最近 X"；覆盖判断按写盘顺序而非事件顺序 | `occurredAt` 与来源帧 `time/ts` 不一致的条数 > 0；或注入项按 `recordedAt` 排序的比例 > 0；或时序题答案与 `occurredAt` 排序矛盾数 > 0 | `occurredAt`/`recordedAt` 双时钟 + 读侧排序只按 `occurredAt`；渲染必带日期（LongMemEval 的时序题就是靠时间戳元数据判分，时间无关设计在那里系统性掉分） |
| 7 | **【必然】无关召回 / 不会沉默** | 任何输入都往外掏记忆，噪声盖过信号 | 无关查询（金标负例）下注入条数 > 0 记为误触发；"沉默率 = 空注入次数/负例数"，与"命中率"分开报；LoCoMo 对抗题的判定口径（子串匹配）不可直接借用 | 负例集 + 阈值/门（不相关时返回空）；把"空注入"当一等成功状态统计，而不是当失败 |
| 8 | **【必然】判定器失效（考卷本身判错）** | 改了实现分数反而升；正确但换措辞被判 0 | 对拍集：正确但改述的答案被 judge 判 0 的比例；判据与实现同源（judge 复用被测系统的输出格式）的题数 > 0 | 判据与实现分离 + 双判官 + 金标对拍；LoCoMo 的对抗题、LongMemEval 的更新题都是"判定比实现更宽松/更脆"的现成反例 |
| 9 | 检索窗口盲区（top-k + 无阈值） | 多会话题的第二个证据根本没进上下文 | `recall_all@k` 与 `recall_any@k` 的差（LongMemEval 两个都报）；"必需证据 ∩ 注入 = ∅" 的题占比 | 多证据题按"证据覆盖"而非"相似度最高"选；硬保证 `recall_all` 或显式报缺（mem0 #7123 的 `topK=10` 无阈值就是反例） |
| 10 | 切碎再拼（chunk 断章） | 片段缺主语/时间，模型张冠李戴；同一事实被切成两半 | 注入片段中"指代无先行词/缺主语/缺时间"的比例；同一证据被切到 ≥2 个片段的题数；注入项与其 `why`/`quote` 不对齐的条数 | 最小单位取"轮"或"会话"而非任意字符窗；注入时带上下文前缀（Anthropic Contextual Retrieval：失败检索率降 35%/49%/67%，前提正是"传统 RAG 会毁掉上下文"） |
| 11 | 实体消歧失败（同名合并 / 同实体分裂） | 两个同名不同人的事实互相污染；或同一实体十条节点、边乱连 | 规范化名相同但 `entityId` 不同的节点数 > 1；同一节点被 ≥2 个互斥实体共享的边数 > 0；合并/分裂操作无 `mergeLog` 的条数 > 0 | 稳定实体键 + 写时唯一约束 + 合并留 alias（Graphiti `node_operations.py#_collapse_exact_duplicate_extracted_nodes` 自己承认"intentionally narrow"，只合"同消息内同规范名"，其余交给 LLM dedupe prompt，而 prompt 只给 1 条正向 + 2 条"NEVER"负向规则） |
| 12 | 上下文抖动（反复重压缩 / 整段清空） | 同一批消息被反复总结；压缩后细节不可追、且无原件可回滚 | 单位会话压缩次数 > 1；压缩后再次进入上下文的"已压缩消息"条数 > 0；压缩产物覆盖率 = 已被摘要覆盖的原始消息数/总消息数 达到 1 而原件不可读 | 压缩幂等 + 水位单一真相 + 永不重压已压内容 + 原件永不删（Letta `summarizer.py#_partial_evict_buffer_summarization` 按**条数**而非 token 触发、只在 `force=True` 时动手，超窗时 `letta_agent.py` 直接 `forcefully clearing message history`；公开 issue #3270 是"忽略比例、整段清空"） |

> 配套：并发/静默丢写（mem0 #6515 hash 去重 TOCTOU、#7440 `close()` 与在途写竞争导致历史行静默缺失）不属"全量重建"设计必然，但值得单列一条写入不变量：**"写入返回成功但读回缺失条数必须为 0"**。

## 3 · 为什么「全量重建 + 每轮注入 + 无增量」必然踩坑

这一节把表里标【必然】的 8 条串成因果链，每条都给外部证据：

1. **注入量随会话单调增，且没有任何裁剪职责** → 表 1。MemBench 的 FullMemory 就是这条设计的对照组：唯一"机制"是把全部记忆塞进上下文，准确率随 token 单调下滑（参与式 0.647→0.489，观察式反思 0.883→0.333）；LongMemEval 也记了长上下文的"lost-in-the-middle"效应。
2. **没有"已注入"账本，所以每轮重建必然重复贴同一批记忆** → 表 2。这是"每轮注入"与"全量重建"的合成后果：重建是无状态的，账本却必须在会话维度有状态。
3. **重建从原文重抽，又没有幂等键，所以同一事实必然被反复入库** → 表 3。Mem0 用 prompt 明确把冗余推给下游（"When in doubt, extract"），下游只有 md5 文本哈希 + top-10 窗口，于是 #7123 在一小时内攒出 8 条近重复。
4. **全量重建没有"删除/覆盖传播"的通道，旧值必然继续在场** → 表 4。LongMemEval 的判定器甚至默认宽容"旧值和新值一起出现"，所以这条错误在基准上是隐形的，只能靠自己加断言（互斥 claim 计数）。
5. **无增量 ⇒ 无法区分"原始事件"与"上一次重建的产物"**，重建的输入里混入模型输出，漂移随轮次累积 → 表 5。LoCoMo 需要人工改掉 15% 的轮次才把长期不一致修平，说明这类漂移不是偶发。
6. **全量重建按"当前全量"排序/裁剪时，最省事的键是入档顺序或相似度，不是发生时间** → 表 6。LongMemEval 的时序题专打这一点，时间无关设计系统性掉分。
7. **全量注入没有相关性筛，所以"不相关时沉默"在设计上不存在** → 表 7、表 9。MemBench 的容量指标和 LongMemEval 的弃答题分别从"越多越差"和"该沉默时说话"两侧夹击。
8. **重建成本随语料线性增长**，MemBench 的 efficiency 列已经量出来：全量/近全量机制的写耗时比检索式高两个数量级（MemoryBank 8–18s/轮 vs 0.02–0.06s/轮）。

条件性（**不**必然，但一旦实现方式不对就必踩）：实体消歧（表 11，取决于是否有稳定实体键）、切碎再拼（表 10，取决于最小单位是"轮/会话"还是字符窗）、上下文抖动（表 12，取决于压缩是否幂等）。

## 4 · 可直接抄成断言的判据清单

```
A1  inject_tokens(session) 与会话轮数回归斜率 <= 0（或注入有硬上限且裁剪可复算）
A2  count(memoryId, sessionId) <= 1                       # 同会话不重复注入
A3  count(scopeKey, normalize(text)) <= 1                 # 同规范文本只有一条
A4  count(entity, attribute, 未 superseded 的互斥值) <= 1   # 新旧不并存
A5  count(claim.support 无法回指原始 seq) == 0             # 溯源可核
A6  count(occurredAt != 来源 ts) == 0 且排序键 == occurredAt
A7  负例集上 空注入次数 / 负例数 == 1（沉默率），且与命中率分开报
A8  judge(正确但改述的答案) 判 0 的比例 <= 阈值             # 判定器自检
A9  recall_all@k < recall_any@k 的题数 == 0（或显式报缺）
A10 count(片段缺主语/缺时间) == 0                          # 不切碎
A11 count(同规范名 不同 entityId) <= 1                     # 实体唯一
A12 count(压缩次数 > 1) == 0；压缩后原件仍可读
A13 写入返回成功但读回缺失条数 == 0
```

## 5 · 来源

**基准论文与仓库（代码级）**
- LoCoMo 论文 <https://arxiv.org/abs/2402.17753>；仓库 <https://github.com/snap-research/locomo>；判定 `task_eval/evaluation.py#eval_question_answering`（读于 main）。
- LongMemEval 论文 <https://arxiv.org/abs/2410.10813>；仓库 <https://github.com/xiaowu0162/LongMemEval>；判定 `src/evaluation/evaluate_qa.py#get_anscheck_prompt`、召回 `src/retrieval/eval_utils.py#evaluate_retrieval`（读于 main）。
- MemBench 论文 <https://arxiv.org/abs/2506.21605>；仓库 <https://github.com/import-myself/Membench>（容量/效率口径见论文 Table 3/4）。

**项目公开复盘与源码（代码级 / issue 级）**
- Mem0 论文 <https://arxiv.org/abs/2504.19413>；源码 `mem0ai/mem0#mem0/memory/main.py#_add_to_vector_store`（现行 main 为 ADD-only：`ADDITIVE_EXTRACTION_PROMPT`、`"event": "ADD"`；md5 文本哈希去重；既有记忆 `top_k=10`）、`mem0/configs/prompts.py#ADDITIVE_EXTRACTION_PROMPT`（"When in doubt, extract"）。
- Mem0 issue：#7123 <https://github.com/mem0ai/mem0/issues/7123>（top-10 无阈值 → 1 小时 8 条近重复）、#6515 <https://github.com/mem0ai/mem0/issues/6515>（hash 去重 TOCTOU）、#7440 <https://github.com/mem0ai/mem0/issues/7440>（close 竞争 → 历史行静默缺失）、#3780 <https://github.com/mem0ai/mem0/issues/3780>（旧 NOOP 分支 `vector_store.update(vector=None)` 触发 PointStruct 校验失败）。
- Letta 源码（tag 0.16.8）：`letta/services/summarizer/summarizer.py#_partial_evict_buffer_summarization`、`letta/agents/letta_agent.py`（超窗 `forcefully clearing message history`）；issue #3270 <https://github.com/letta-ai/letta/issues/3270>（sliding_window 忽略比例、整段清空）、#3279 <https://github.com/letta-ai/letta/issues/3279>（压缩模型被上限卡住导致超窗上下文无法压缩）。
- Zep / Graphiti 源码：`getzep/graphiti#graphiti_core/utils/maintenance/node_operations.py#_collapse_exact_duplicate_extracted_nodes`（"intentionally narrow"）、`#resolve_extracted_nodes`（语义召回候选 → 确定性规则 → LLM dedupe）、`graphiti_core/prompts/dedupe_nodes.py#node`（只给 1 条正向 + 2 条 "NEVER" 规则）、`graphiti_core/utils/maintenance/edge_operations.py#_apply_temporal_invalidation` 与 `#resolve_edge_contradictions`（时间戳缺失时 `continue`，矛盾不失效）。
- RAG 侧外部证据：Anthropic《Contextual Retrieval》<https://www.anthropic.com/research/contextual-retrieval>（"传统 RAG 常毁掉上下文"；失败检索率 −35%/−49%/−67%）；RAG 七类失败点 <https://arxiv.org/abs/2401.05856>。

**本仓交叉引用（[本仓]）**
- `evidence/T24-redundant-injection.md`、`evidence/T25-once-per-session.md`（重复注入与 once-per-session 门）。
- `docs/调研/22-LongMemEval-五能力基准-2026-11-02.md`、`33-MemoryAgentBench-四能力记忆基准-2026-11-04.md`、`50-判据总表-50篇收敛-2026-11-05.md`（本文与之保持一致：判据只允许机械计数）。

## 6 · 复现（只读命令，2026-11-26 实测通过）

```bash
# 判定器：LoCoMo 对抗题子串口径 + LongMemEval 更新题容忍旧值
gh api "repos/snap-research/locomo/contents/task_eval/evaluation.py?ref=main" --jq .content | base64 -d | grep -n -A4 -F "in [5]"
gh api "repos/xiaowu0162/LongMemEval/contents/src/evaluation/evaluate_qa.py?ref=main" --jq .content | base64 -d | grep -n "previous information"
# Mem0：现行 ADD-only + md5 去重 + top_k=10
gh api "repos/mem0ai/mem0/contents/mem0/memory/main.py?ref=main" --jq .content | base64 -d | grep -n "ADDITIVE_EXTRACTION_PROMPT\|top_k=10\|hashlib.md5"
# Graphiti：只合"同消息内同规范名"的窄 dedupe + 边矛盾失效
gh api "repos/getzep/graphiti/contents/graphiti_core/utils/maintenance/node_operations.py?ref=main" --jq .content | base64 -d | grep -n -A3 "intentionally narrow"
# Letta：按条数整段替换（main 根目录无源码树，须用 tag）
gh api "repos/letta-ai/letta/contents/letta/services/summarizer/summarizer.py?ref=0.16.8" --jq .content | base64 -d | grep -n -A3 "message count instead of token count"
```

## 7 · 未验与边界

- 未跑任何基准（只读源码与论文）；MemBench 数字取自论文表格，未复现。
- 未核 LoCoMo/LongMemEval 的训练/评测脚本全链路（只读了判定与召回函数）；`evaluate_qa.py` 在 LoCoMo 里只是驱动，真正的打分在 `evaluation.py`。
- Letta 源码读的是 tag 0.16.8（`main` 分支根目录已不含源码树，直接读 main 会 404）。
- Mem0 issue 编号对应的版本跨度较大（#3780 属旧版 NOOP 时代、#7123 属 v3.0.7），引用时已分别标注，不能混为同一版本的行为。