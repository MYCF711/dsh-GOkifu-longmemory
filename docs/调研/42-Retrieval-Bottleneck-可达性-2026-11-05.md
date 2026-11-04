# 为什么"存了却取不到"：3×3 诊断把失效钉在检索阶段（2026-11-05 采集）

- 来源：[arXiv:2603.02473](https://arxiv.org/abs/2603.02473)（Boqin Yuan / Yue Su / Kun Yao；v1 2026-03-02，v2 2026-04-12；
  ICLR 2026 **MemAgents Workshop** 接收；正文 [HTML](https://arxiv.org/html/2603.02473v2) 已读，访问日期 **2026-11-05**）。
- **范围声明**：00–41 已覆盖 Mem0 / Letta / Cognee / AWS AgentCore / Memobase / Zep 等系统与页面；
  本篇是**首次出现的一篇"诊断型"论文**（不提出新记忆系统，只做失效归因），不重复任何已写页面。
- [外] **它问的问题**：记忆增强 agent 的性能差异，到底来自**怎么写**，还是**怎么取**？
  现有基准只测端到端准确率，"making it hard to tell whether errors stem from what was stored, how it was
  retrieved, or how the LLM used the context"。
- [外] **实验是 3×3 因子设计**：三种**写策略** × 三种**检索方法**。
  写：**Basic RAG**（原始 3 轮对话块，**零 LLM 调用**）、**Extracted Facts**（Mem0 式事实抽取 + 冲突消解
  ADD/UPDATE/NOOP）、**Summarized Episodes**（MemGPT 式会话摘要）；
  取：**余弦相似度**、**BM25**、**Hybrid+Rerank**（余弦 ∪ BM25 取 top-2k 候选，再用 LLM 裁判重排到 top-k）。
  数据 LoCoMo：**10 段多会话对话（每段约 600 轮）**、约 200 题/段、评测 **1,540 道非对抗题**；
  基座 GPT-5-mini、嵌入 text-embedding-3-small(1536-d)、检索预算 **k = 5**。
- [外] **结论一：检索方法主导**。准确率：**Hybrid 77.2% / 余弦 73.4% / BM25 57.1%**（平均），
  跨度约 **20 分**；而写策略在任一检索列内只差 **3–8 分**（正文另称检索方法带来 14–23 分差异）。
- [外] **结论二：最便宜的写策略最好**。Basic RAG（零 LLM 调用）在余弦下 **77.9%**、Hybrid 下 **81.1%**，
  "matching or exceeding both Extracted Facts and Summarized Episodes across all retrieval methods"；
  唯一例外是 BM25 上 Summary 62.7% > Basic RAG 59.2%（"likely because keyword retrieval benefits from the
  denser vocabulary of compressed summaries"）。作者的判词：**"lossy compression discards conversational
  details that the backbone LLM can otherwise leverage directly."**
- [外] **结论三：失效几乎都在检索阶段**。三探针（Probe 1 检索精度@k / Probe 2 利用率 / Probe 3 失败归类）里，
  **检索失败占全部问题的 11–46%**（BM25+Extracted Facts 高达 **46.3%**），而**利用率失败稳定在 4–8%**、
  **幻觉 0.4–1.4%**；Hybrid 把检索失败**砍半**（Basic RAG 从 **35.3% → 11.4%**）。
  "beneficial"率在 Basic RAG+Hybrid 下达 **79.0%**——"the model improves its answer four out of five times
  when given good retrievals"。
- [外] **它把"检索失败"定义成两个子类（本仓最该抄的一句）**："**Retrieval failure** covers cases where the
  system did not surface sufficient information to answer the question at inference time. This includes
  **(i) cases where relevant information was not retrieved despite being present in the memory store**, and
  (ii) cases where the stored memories did not contain sufficient detail to support the answer."
  两者都归检索阶段，因为"the breakdown manifests at the **retrieval-to-generation boundary**"。
- [外] **检索精度与端到端几乎完全相关**：precision@5 与准确率 **r = 0.98**（九个配置）；
  反例是 **token F1 对 20 分准确率差距几乎不敏感（0.221 vs 0.168）**——"underscoring the importance of
  LLM-judge evaluation over surface-level overlap metrics"。
- [外] **作者对设计优先级的重排**："progress may depend more on **retrieval precision, reranking, and query
  understanding** than on increasingly complex write pipelines."
- [外] **局限（作者自陈）**：单一基座（GPT-5-mini）、单一基准（LoCoMo）、固定 k=5；写策略是**提示词级重实现**
  而非学习式系统；且"**The advantage of raw chunking may also diminish under tighter context budgets where
  compression is required to fit within model input limits.**"；答案正确性与失败归类都依赖 LLM 裁判。

**没读到 / 不能确认的部分（如实标注）**：① 论文正文**已读到 §1–§4 与附录 A–C 的提示词**，但 **附录 D（人评与
LLM 裁判校验）只看到标题**；② 表 3 的**每配置成本（LLM 调用次数/美元）未读到**，只有"None / 1+/session /
1/session / 1/query"的调用次数口径；③ LoCoMo 的**四类问题分桶分数**（single-hop 等）**未读到**；
④ 代码仓库（`github.com/boqiny/memory-probe`）在本机 DNS 解析到非公网地址，**未核对实现**；
⑤ 没有一篇"记忆系统专门讲可达性"的理论文献被本篇引用（它把可达性问题操作化成三探针，而非提出新定义）。

## 对照本仓（棋院）

本仓刚量到的失效是：**合并节点命中了（被 walk 带进候选），但它代表的 5 组成员一条都没进卡**
（`merge-acceptance` ④c 仅 50%）。用这篇论文的分类，这**不是"没检索到节点"，而是它的 retrieval failure 子类 (i)**：
"relevant information was **not retrieved despite being present in the memory store**"——
合并节点在库里、成员边也在库里，只是没被"带出来"。

| 论文 | 棋院 | 判断 |
|---|---|---|
| 失效分三档：检索 / 利用 / 幻觉 | 我们的 ④c 只有"命中/未命中"一档 | ✅ **可借**：④c 要按"**检索到了没**（成员有没有进候选）→ **进卡了没**（预算/闸有没有砍掉）→ **用上了没**"三段拆开，否则 50% 说不清是哪一段 |
| retrieval failure 含"存了但没被带出" | 合并节点命中但成员未出 = 同一子类 | ✅ 直接对应；修法应落在**遍历/展开**（walk 深度、边类型、成员展开），不是改写侧 |
| 检索精度与端到端 **r = 0.98** | 我们若只改排序/权重，收益上限有限 | ✅ **优先级证据**：先把"成员带出率"做对，再谈排序 |
| **原始 chunk（零 LLM 调用）≥ 抽取式** | 我们保留成员原文、读侧折叠（不压缩存储） | ✅ **同向**：写侧压缩会丢细节，且下游补不回来——支持"存储保留成员"这条设计 |
| BM25 上摘要反而更好（62.7 > 59.2） | 我们相关性靠**词面 + 类别 + 作用域** | ⚠ 提醒：词面检索偏好**词汇密集**的文本，折叠后的合并行可能"词更密"，要防它挤掉成员行 |
| token F1 对 20 分差距不敏感 | 我们用 `fail=`/命中数等计数口径 | ✅ 同向：**别拿表面重叠当效果**，要按"事实验证"计分 |
| LLM 裁判算精度/利用率 | 本仓禁止模型评分参与排序与存留 | ⛔ **不借评分**；但可把"利用率"机械化成**代理量**（该卡是否被消费、命中条数、是否被闸砍掉） |
| 检索预算 k=5 固定 | 我们是"≤K 条 + token 预算" | ✅ 同向；论文也承认**更紧预算下原始 chunk 的优势会削弱**——我们的预算是硬约束，所以"成员带出"必须**省着花**（先带 1 条代表 + 其余按需展开） |

**能借的三点（都能做成机械规则）**：

1. **把 ④c 拆成三段可核计数**：`candidates`（成员是否进了 walk 候选）→ `surfaced`（是否通过闸与预算进卡）
   → `used`（卡里是否被引用/命中）。三段各自算百分比，**不用模型判断**——论文的 Probe 1/3 就是这个形状。
2. **"存了但没带出"必须单独计数**：把"节点命中、成员未出"作为一类**独立失败**记进验收（现在它混在"未命中"里）。
3. **预算下的展开顺序**：合并节点命中时，先带**代表+1 条成员**，其余成员以指针挂在同一行（省预算且可追），
   这是论文"更紧预算下压缩优势削弱"给我们的直接约束。

**明确不借的三点（附理由）**：

1. **向量检索/嵌入**：本仓不做向量；"检索方法主导"的结论对我们等价于"**词面 + 类别 + 作用域**的精度主导"，
   不需要引入 embedding。
2. **LLM 裁判打分**：利用率与相关性都靠 LLM 判——违反"计数不是打分"，且不可复算；
   我们只用可机械统计的量（命中数、进卡数、被引用数）。
3. **用摘要替代原文**（MemGPT 式 Summarized Episodes）：论文自己的数据显示它不优，且与本仓"原件永不删"冲突。

## 两条可复用结论

1. **"可达性"是检索-生成边界上的性质，不是存储属性**：论文把 11–46% 的错钉在 retrieval、4–8% 钉在 utilization，
   并把"存了没带出"和"存得不够细"都算检索失败。这条划分让"存了但取不到"从抱怨变成**可测的三段**。
2. **写侧越花哨，越可能是在替检索背锅**：零 LLM 调用的原始块不输抽取式，还赢在可追；
   对本仓的含义是——**把预算花在"带出成员"上，不要花在"重新表述存储"上**。

## 结论

无需改架构（存储保留 + 读侧折叠方向正确）；可落地的是**把 ④c 拆成 candidates / surfaced / used 三段计数**，
并把"节点命中、成员未出"单列成一类失败。
它同时解释了为什么这条 bug 值得优先修：**检索精度与端到端准确率的相关性 r = 0.98**，
而写侧策略只值 3–8 分——修可达性的性价比最高。