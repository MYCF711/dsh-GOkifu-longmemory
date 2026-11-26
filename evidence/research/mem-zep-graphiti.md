# Zep / Graphiti / Cognee 一手调研（含源码级证据）

> 取材：arXiv 2501.13956 v1 + Graphiti 源码 `main` @ `b8ea9c5`（pyproject `0.32.1`，浅克隆后本地 grep）+ 官方文档 + Cognee `main` 源码。
> 标记：**[代码]** = 读源码/符号名得到；**[文档]** = 官方文档；**[论文]** = arXiv；**[issue]** = 仓库 issue 承认的问题。
> 代码 URL 用 blob 链接，引用符号名而非行号（行号会漂移）。

## 0. 结论速览（8 行）

1. 双时态不是花活：`valid_at/invalid_at`（世界时间）与 `created_at/expired_at`（事务时间）分开，解决"旧事实失效但必须留史"的坑。
2. 失效是**打时间戳而不是删边**：新事实与旧事实时间重叠且有矛盾时，旧边 `invalid_at = 新边 valid_at`、`expired_at = now`。[代码]
3. 增量靠"局部候选集"：边去重只在**同一对端点**的历史边里搜，失效候选另走一路更宽检索，再交 LLM 判矛盾。[代码]
4. 图规模**没有度数/边数上限**——这是硬缺口；所有上限都是"候选数/批大小"上限（10、15、30、2×limit）。[代码]
5. 混合检索 = cosine + BM25 + BFS 三路各自取 `2×limit` 候选，再 RRF/MMR/cross-encoder/节点距离/提及次数重排。[代码]
6. 论文数据：DMR 94.8% vs MemGPT 93.4%；LongMemEval 71.2% vs 全上下文 60.2%（+18.5%），时延 2.58s vs 28.9s（≈90%↓），上下文 1.6k vs 115k token。[论文]
7. 他们承认的失败面：社区动态扩展会漂移必须周期性全量刷新；弱模型读不懂时间字段；批量摄入会漏判矛盾。[论文][issue]
8. Cognee 走的是另一条路：`add → cognify` 任务链 + `incremental_loading` 只处理未处理项 + 冲突用 `conflict_*` 标记和 `STATUS_PRECEDENCE` 表达，靠 uuid5 内容寻址做幂等。[代码]

## 1. 图模型：episode → entity → edge → community

- 三层子图：episode（原文，非有损）/ semantic entity（实体+关系边）/ community（聚类摘要）；episode↔entity 之间有双向索引，可前向取证据、后向取上下文。[论文] https://arxiv.org/html/2501.13956v1
- 构图落点是"结构化 Cypher + 预定义 schema"，明确不用 LLM 生成数据库查询，以减少幻觉。[论文] 同上
- 实体抽取时喂"当前消息 + 最近 n 条"，论文 n=4（两个完整回合）；源码里窗口常量是 `EPISODE_WINDOW_LEN = 3`（取最近 3 个 episode）。[论文] 同上 · [代码] `graphiti_core/utils/maintenance/graph_data_operations.py::EPISODE_WINDOW_LEN` https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/graph_data_operations.py
- 每类对象都带 `group_id` 做租户/图隔离，检索一律带 `group_ids` 过滤。[代码] `graphiti_core/search/search_utils.py::fulltext_query` https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_utils.py

## 2. 双时态：具体解决什么坑

**坑**：只会 upsert 的图，遇到"用户改主意/设备换型号/接口改名"时，要么旧事实被覆盖（丢史），要么新旧并列（矛盾）。纯时间戳（只有 created_at）也无法区分"这件事什么时候为真"和"我什么时候知道"。

- 四个时间字段：`created_at`（边创建）、`valid_at`（推断事实开始为真）、`invalid_at`（推断事实不再为真）、`expired_at`（系统判定失效的时刻）。[文档] https://help.getzep.com/facts
- 例（官方原例）：Kendra 先说爱穿 Adidas，后来说鞋坏了、改喜欢 Puma ⇒ 系统把"Kendra loves Adidas"失效，并新增两条事实"鞋坏了""喜欢 Puma"。[文档] 同上
- 代码级怎么写：`_apply_temporal_invalidation()` 发现候选边 `valid_at` 晚于当前边 ⇒ 当前边 `invalid_at = 候选 valid_at`、`expired_at = utc_now()`；`resolve_edge_contradictions()` 只在**时间区间重叠**时才判矛盾（一边已失效于另一边生效之前就跳过）。[代码] `edge_operations.py::_apply_temporal_invalidation` https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/edge_operations.py
- 新事实优先：冲突裁决偏向事务时间更新的一方（论文：Graphiti consistently prioritizes new information）。[论文] 同上
- 检索侧不删也不隐藏：上下文模板输出 `FACT (Date range: from - to)`，把有效区间一并给模型；默认检索**不**自动排除已失效边（`SearchFilters.valid_at/invalid_at/created_at/expired_at` 是可选过滤谓词）。[论文][代码] `search_filters.py::SearchFilters` https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_filters.py
- 官方明确打预防针：`valid_at/invalid_at` 只表示"从源内容推出的时间边界"，**不证明事实为真**。[文档] https://help.getzep.com/facts

## 3. 增量更新：一次 `add_episode` 到底动了什么

**[代码] 顺序**（`graphiti_core/graphiti.py::Graphiti.add_episode`，L1630–1945）https://github.com/getzep/graphiti/blob/main/graphiti_core/graphiti.py

1. 取 `previous_episodes`（窗口 `EPISODE_WINDOW_LEN`）作为上下文，落一条 EpisodicNode（含 `valid_at = reference_time`）。
2. `extract_nodes()` 抽实体（含 reflexion 二次抽取、实体摘要）。
3. 有 `identity_properties` 时先只抽这些节点属性（用于按 email 等强标识精确匹配）。
4. `resolve_extracted_nodes()` 消歧/去重：先取候选（identity 属性查、精确同名查、向量近邻查），再 LLM 判定 `duplicate_candidate_id`。
5. `_extract_and_resolve_edges()` 抽边 → 去重 → 抽取时间戳 → 判矛盾，返回 `(resolved_edges, invalidated_edges, new_edges)`。
6. `entity_edges = resolved_edges + invalidated_edges`（失效边同样要落盘，只是带了 `invalid_at/expired_at`）。
7. `extract_attributes_from_nodes(..., edges=new_edges)`：**只用新边**更新实体摘要，避免把已存在的事实重复塞进摘要（源码注释明写此意图）。
8. `_process_episode_data()` → `add_nodes_and_edges_bulk()`：按记录 bulk upsert（episode / node / episodic edge / entity edge），提交式写入，不做整图重算。
9. 可选 `update_community()`：每个新节点各自做一次"挂到邻居多数社区 + 摘要重写"。

**不重算的部分**（这就是"不会全量重建"的原因）：

- 不重扫历史 episode；每条 episode 只查与自身抽取结果相关的候选（见 §5 的候选上限）。[代码] 同上
- 边去重搜索被硬性限制在**同一对端点**：`_pair_search_filter()` 生成 `edge_source_node_uuid/edge_target_node_uuid` 过滤，`_same_pair_edges()` 再剔自环 ⇒ 搜索空间 ≈ 该端点对的历史边数，不随全图增长。[代码] `edge_operations.py::_pair_search_filter / _same_pair_edges` 同上 URL
- 边去重还有一条免 LLM 快路径：端点 + 归一化 fact 文本完全相同 ⇒ 直接复用旧边（`find_exact_duplicate_edge()`）。[代码] 同上
- 社区不做全量重算：`determine_entity_community()` 先看节点是否已有社区，没有才取"邻居所在社区的多数票"挂靠；`update_community()` 只把 `(entity.summary, community.summary)` 做一次 pairwise 摘要重写。[代码] `community_operations.py::determine_entity_community / update_community` https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/community_operations.py
- 全量社区重建只发生在显式调用 `Graphiti.build_communities()`：先 `remove_communities()` 再 `build_communities()`（label propagation），且 `add_episode` 默认**不**触发它。[代码] `graphiti.py::build_communities` 同上 URL
- 论文承认这种"单步递归扩展"只是启发式，社区会逐渐偏离全量 label propagation 的结果，所以仍需周期性刷新——这是他们主动写下的代价。[论文] 同上

## 4. 混合检索：三路各自的角色与配比

- [论文] 三路：cosine 语义（`φcos`）、Okapi BM25 全文（`φbm25`）、BFS 图遍历（`φbfs`）。角色分别是"词面相似 / 语义相似 / 上下文相邻"。BFS 特别用于把"最近 episode 提到的实体"辐射出去。
- [代码] 每路各取 `2 * limit` 候选，并发执行后合并 → RRF 等重排再截断：`edge_search()`/`node_search()` 里三处 `2 * limit` 与 `rrf(..., min_score=reranker_min_score)`。[代码] `graphiti_core/search/search.py::edge_search` https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search.py
- [代码] 可用方法枚举：`EdgeSearchMethod/NodeSearchMethod = {cosine_similarity, bm25, bfs}`；`EpisodeSearchMethod` 只有 `bm25`；`CommunitySearchMethod` 只有 cosine+bm25（社区不走向量之外的结构检索）。[代码] `search_config.py` https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_config.py
- [代码] 重排器：`rrf`（默认）/ `mmr` / `node_distance`（离焦点节点距离）/ `episode_mentions`（被多少个 episode 提到）/ `cross_encoder`（最贵，先 RRF 截 `2*limit` 再逐条打分）。RRF 实现是 `score += 1/(rank+1)` 累加。[代码] `search_utils.py::rrf / maximal_marginal_relevance / node_distance_reranker / episode_mentions_reranker` 同上 URL
- [代码] 现成配方：`COMBINED_HYBRID_SEARCH_RRF`（bm25+cosine，四类对象全查）、`COMBINED_HYBRID_SEARCH_CROSS_ENCODER`（含 bfs）、`EDGE_HYBRID_SEARCH_NODE_DISTANCE` 等。[代码] `search_config_recipes.py` https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_config_recipes.py
- [文档] 默认 `graphiti.search(query)` 就是"语义+BM25，RRF 重排"；`search(query, focal_node_uuid)` 追加节点距离重排。文档同时强调"无 LLM 在回路里的重排"（cross-encoder 除外）。https://help.getzep.com/graphiti/working-with-data/searching

## 5. 图规模控制：有没有度数上限？（关键否决项）

**结论：没有。** 全仓 `max_degree|degree_limit|max_edges|edge_limit|fan_?out` grep 零命中（Graphiti `main`，`graphiti_core/**/*.py`）。也就是说：**没有任何机制阻止一个实体被反复连边**，稠密团（N 个实体两两发生关系）会自然产生 O(N²) 条边，只能靠"抽取质量 + 去重"间接抑制。[代码] 检索式：https://github.com/getzep/graphiti

实际存在的约束**全是"候选/批次"级**，不是"存量级"：

| 常量 | 值 | 作用点 | 效果 |
|---|---|---|---|
| `RELEVANT_SCHEMA_LIMIT` | 10 | 各 `*_search` 的默认 limit | 每次检索每路最多 10 条候选 |
| `2 * limit` | 20 | `edge_search`/`node_search` 各路候选 | 多路合并前的放大倍数 |
| `MAX_SEARCH_DEPTH` | 3 | BFS 深度上限 | 图遍历最多 3 跳 |
| `DEFAULT_SEARCH_LIMIT` | 10 | `SearchConfig.limit` | 最终返回条数默认 10 |
| `DEFAULT_MIN_SCORE` | 0.6 | cosine 下限 | 低于 0.6 不进候选 |
| `NODE_DEDUP_CANDIDATE_LIMIT` | 15 | 节点消歧候选（`nodes.py`） | 每个待消歧节点最多 15 个候选 |
| `MAX_NODES` | 30 | 批量实体摘要分片（`node_operations.py`） | 每次 LLM 摘要最多 30 个节点 |
| `NODE_DEDUP_COSINE_MIN_SCORE` | 0.6 | 节点语义候选门槛 | 同上 |
| `MAX_COMMUNITY_BUILD_CONCURRENCY` | 10 | 社区构建并发 | 只影响时延 |
| `DEFAULT_SEMAPHORE_LIMIT` / `DEFAULT_PAGE_LIMIT` | 20 / 20 | LLM 并发 / 分页 | 只影响吞吐 |
| `CHUNK_SIZE` | 10 | bulk 写盘分片（`bulk_utils.py`） | 只影响写批次 |
| `MAX_SUMMARY_CHARS` / `DEFAULT_ATTRIBUTE_MAX_LENGTH` | 1000 / 250 | 摘要与属性截断 | 控制文本膨胀，不控边数 |
| `DEFAULT_MAX_TOKENS` | 16384 | 抽取 LLM 输出上限 | 间接限制单次抽取的边数 |
| `MAX_COMBINATIONS_TO_EVALUATE` | 1000 | `content_chunking.py` | 分块组合评估上限 |

来源：`search_utils.py`（前 5 项）、`nodes.py`（`NODE_DEDUP_CANDIDATE_LIMIT`）、`node_operations.py`（`MAX_NODES`、`NODE_DEDUP_COSINE_MIN_SCORE`）、`community_operations.py`、`helpers.py`、`bulk_utils.py`、`text_utils.py`、`attribute_utils.py`、`llm_client/config.py`、`content_chunking.py`，均 `https://github.com/getzep/graphiti/blob/main/graphiti_core/…`。

**唯一算"按重要性裁剪"的东西**：重排器（`episode_mentions` 按被提及次数、`node_distance` 按离焦点节点距离、MMR 按与已选结果的最大相似度做去冗）。这是**读时裁剪**，不删不改存量图。[代码] `search_utils.py` 同上 · [论文] 论文把这三者列为"提升 precision"的手段。

## 6. 他们承认的失败模式

- **实体消歧/错误合并**：节点消歧最终依赖一次 LLM 判定（`_resolve_with_llm` 的 `duplicate_candidate_id`），候选限 15 个；LLM 可能返回缺失/越界 id，代码只能"打 warn + 当作没重复"兜底 ⇒ 漏合并=重复节点，错合并=事实挂错实体。[代码] `node_operations.py::_resolve_with_llm` 同上 URL
- **边的跨列表引用会丢**：issue #1672 "range guard discards a correctly-cited cross-list duplicate, leaking duplicate edges" 直接承认重复边泄漏。[issue] https://github.com/getzep/graphiti/issues/1672
- **批量摄入漏判矛盾**：#2210 "episodes in one batch miss each other's contradictions, and copies of one stored edge overwrite each other"、#1872 "[BUG] add_episode_bulk saves duplicate edges for identical facts across episodes in one batch"。[issue] https://github.com/getzep/graphiti/issues/2210 · https://github.com/getzep/graphiti/issues/1872
- **社区漂移**：动态挂靠不保证与全量 label propagation 一致，必须周期性重建（论文自述）。[论文] 同上
- **弱模型读不懂时间**：LongMemEval 分类回归——gpt-4o-mini 在 `single-session-assistant` 上 Zep 75.0% vs 全上下文 81.8%（−9.06%），`knowledge-update` 74.4% vs 76.9%（−3.36%）；gpt-4o 的 `single-session-assistant` 也从 94.6% 掉到 80.4%（−17.7%）。[论文] 同上
- **时延归因**：论文自述测试是家用笔记本连 AWS us-west-2，含网络时延，基线无此开销（对 Zep 不利的保守口径）。[论文] 同上
- **真值免责**：`valid_at/invalid_at` 不证明事实为真，只是推断。[文档] https://help.getzep.com/facts

## 7. Cognee：ECL / 增量 / 污染处理

- [文档] 摄入 = `remember()`（无 session）→ Add + Cognify 任务链：加载→分块→抽实体关系→向量索引→关系库记 provenance；任务名 `extract_chunks_from_documents → extract_graph_from_data → add_data_points`。https://docs.cognee.ai/core-concepts/data-flows.md
- [文档] 三种存储分工：关系库（文档/块/provenance）、向量库（块与 DataPoint 语义指纹）、图库（实体关系）。https://docs.cognee.ai/core-concepts/architecture.md
- [代码] 增量开关：`cognify(..., incremental_loading: bool = True)`（默认开）https://github.com/topoteretes/cognee/blob/main/cognee/api/v1/cognify/cognify.py
- [代码] 只处理"还没处理过的"：`indexing_items(tasks, items, dataset_id, incremental)` 选出仍需处理的项，空则整段跳过并打印 "already processed, or not a document"。https://github.com/topoteretes/cognee/blob/main/cognee/modules/cognify/memory_pipelines.py
- [代码] `add()` **只创建不更新**：同源但内容不同的文件会抛 `DocumentUpdateRequiredError`，必须显式 `update(data_id=...)`；重复内容则返回已有 id。这是把"改一份旧文档"和"新增一份文档"在语义上分开，防静默覆盖。https://github.com/topoteretes/cognee/blob/main/cognee/api/v1/add/add.py
- [代码] 幂等边：边主键 `uuid5(tenant+user+dataset+source+edge_text+dest)`，写库 `on_conflict_do_nothing`，`UPSERT_BATCH_SIZE=1000` ⇒ 重跑 cognify 不产生重复边。https://github.com/topoteretes/cognee/blob/main/cognee/modules/graph/methods/upsert_edges.py
- [代码] 污染/冲突表达：`conflict_about / conflict_value / conflict_cites` 三类前缀边 + 边上的 `conflict_marks`；状态优先级 `STATUS_PRECEDENCE = ("conflicting","superseded","current")`，**用户裁定压过一切**（`is_user_selected_fact` 直接返回 "accepted by user"）；渲染成 `[conflicting; as of 2026-…]` 这样的标签喂给 LLM。https://github.com/topoteretes/cognee/blob/main/cognee/modules/graph/utils/fact_conflicts.py
- [代码] 实体重要性用 IDF（`compute_idf_from_counts` / `weighted_jaccard`），用途是"分桶/摘要的分组权重"，**不是**删边或剪枝。https://github.com/topoteretes/cognee/blob/main/cognee/modules/graph/utils/entity_scoring.py
- [文档] 默认检索 `HYBRID_COMPLETION`（doc chunks + summaries + 实体邻域一次 LLM 调用），路由是 5 条正则规则、非 LLM；显式可选 `GRAPH_COMPLETION`、`TEMPORAL`、`SUMMARIES`、`CHUNKS`、`CYPHER` 等。https://docs.cognee.ai/core-concepts/main-operations/recall.md
- [代码] 检索侧上限（同样是"候选"而非度数）：`top_k=5`、`wide_search_top_k=100`、`neighborhood_seed_top_k=10`。https://github.com/topoteretes/cognee/blob/main/cognee/modules/retrieval/utils/brute_force_triplet_search.py
- [文档] 自评口径谨慎：BEAM 100K 0.79 / 10M 0.67，且明确"两组用了不同会话、不同抽取模型与检索选择流程，比较前先读方法论"。https://github.com/topoteretes/cognee （README benchmarks 段）

## 8. 对我们的直接含义（承接"团边爆炸 N²"）

1. **别指望他们的度数上限**：Graphiti / Cognee 都没有节点度数上限，N² 团边在他们的模型里是"合法长出来的"。我们要控边，得自己加**存量级**约束（如每节点每 kind 的入边上限、按权重淘汰到 `superseded`），他们无先例可抄。
2. **可抄的是"局部候选集"**：去掉重候选时必须按"端点对/一跳邻域"限定，而不是全图相似度扫描——这是他们敢做在线增量的关键。
3. **可抄的是"失效不删 + 打区间"**：`invalid_at = 新事实 valid_at`、`expired_at = 判定时刻`，与我们"只增不改 + supersededBy"同构，可以直接对齐字段语义。
4. **可抄的是"摘要只用新边更新"**：`extract_attributes_from_nodes(edges=new_edges)` 防止旧事实重复进摘要——对应我们"禁止从摘要再抽取"的自证污染红线。
5. **不要抄"LLM 判矛盾"当唯一闸门**：他们自己承认批量摄入会漏判（#2210/#1872），我们要保留机械判据（时间区间重叠 + 显式 supersedes）。