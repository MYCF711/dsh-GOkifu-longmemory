# 棋院自查：我们的坑 vs 上游已经踩过的坑（代码级）

> 2026-11-26 · 本文件只写「我们仓库里的代码位置 + 本会话实测数字」，用于和 `mem-*.md` 五份上游研究对照。

## A. 全量重建（上游都不这么做）

**我们**：`src/rooms/persist.mjs` 的 `deriveStore` / `replaceDerived`
—— 每轮归档把 episodes 全量投影成 topics/links/threads，`putMany` 逐条比对后**重写变化的全部记录**，
再 `ids(kind)` 全扫 + 删除多余文件。实测（本会话）：
- 真库 links 一度 35,122 条，单轮 `putMany=177s`、`scanDelete=43s`；
- 归档总耗时随「本轮变更量」线性变化：63s（1,073 条）/ 317s（11,067 条）/ 692s（791 新局）。

**上游**：Mem0 当前主路径是 `ADDITIVE_EXTRACTION_PROMPT`（`mem0/configs/prompts.py`，"Your sole operation is ADD"）
——**放弃 UPDATE/DELETE/NOOP 的破坏性判定，改成只追加**；Graphiti 按 **episode 增量**构图，
新边只 append `episodes` 溯源并做 `invalid_at/expired_at` 标记（`edge_operations.py` 的 `_apply_temporal_invalidation`）。

⇒ 我们是唯一还在「全量派生 + 全量替换」的。

## B. 重复注入（上游有阈值/去重，我们的去重键会归零）

**我们**：`src/plugin.mjs` 的注入去重依赖内存态 `injectedIds`；
`session/end-seed` 之后重新 `apply` ⇒ 该集合归零。实测：会话 `aa0b0da9` 的 10 次注入之间都夹着 ≥1 个 end-seed，
即 **10/10 次重复注入**。A1.redundant 长期「未通电」，本质是没有跨重启/跨 apply 的持久去重键。

**上游**：Letta 有 `memory_warning_threshold` 之类的显式阈值与 `rethink` 流程；
上游普遍用**持久化 id + 版本/时间戳**作为去重键，不依赖进程内集合。

⇒ 我们的判重键生命周期短于注入生命周期，这是设计缺陷，不是 bug。

## C. 团边爆炸（N² 物化）

**我们**：`src/rooms/link.mjs` 的 `buildLinks` 对 episode 两两比对，
N 局共享同一文件/报错 ⇒ N² 条边。实测：636 个局、合计度数 251,158、**中位每局 330 条**、
`same-error 54,655 / shared-topic 40,370 / same-file 30,554`，并已导致
`src/rooms/view.mjs` 的 `buildNeighborhood` 用 `push(...163,528 条)` **打爆调用栈**（T404 修）。

**上游**：Graphiti 的 `_same_pair_edges` / `find_exact_duplicate_edge`
—— **只在「同一对端点」的候选集内去重与判重**，不为每对局都造一条边；边由 LLM 抽取实体关系产出，天然稀疏。
另有 saga 摘要的显式上界常量（`SAGA_SUMMARY_MAX_EPISODE_CHARS=100_000`、`MAX_SAGA_EPISODES_FOR_SUMMARY=20`）。

⇒ 我们把「关系」物化成了「集合交集的笛卡尔积」，上游物化的是「被抽取出来的关系」。

## D. 失效语义（我们只有 stale，没有 expired）

**我们**：`staleMarkedBy` + `state:'stale'`（`test/archive-stale.test.mjs` 守卫生效），
但**没有**「何时自动失效」的机械规则 —— 靠 `scripts/mark-stale.mjs` 人工/定期跑。

**上游**：Graphiti 的边自带 `valid_at / invalid_at / expired_at`，
新事实与旧事实冲突时自动 `invalid_at = 候选.valid_at; expired_at = now`（代码见上），
**时间是一等字段，失效是自动的**。

⇒ 我们的 `occurredAt` 有了，但缺「失效时刻」与「自动失效规则」。

## E. 阈值常量散落（上游都有 DEFAULT_* 常量表）

**我们**：注入条数、摘录长度、walk 深度、刷新间隔等阈值散落在多个模块的魔法数字里；
本会话甚至出现过「A4 阈值 50ms 在 `metrics-guard.mjs` 与 `ledger-check.mjs` **各写一份**」，
导致 D7 只改一半（两次发版被同一个门槛拦）。

**上游**：`graphiti_core/graphiti.py` 顶部集中 `SAGA_SUMMARY_*`、`MAX_*` 常量，
`llama_index` 的 `ChatMemoryBuffer` 用 `token_limit` 单一入口。

⇒ 我们缺一份「记忆参数常量表」作为唯一权威。

## F. 「缓存失效」我们从未量化

**我们**：注入发生在 `agent/pre-step`（`src/plugin.mjs`），以替换入步消息的方式带上卡片；
**替换会让该位置之后的内容全部缓存失效**，但仓库里没有一条指标在测这件事。

**上游**：Anthropic 的 prompt caching 文档把「新增在前 / 修改早前内容」的后果写得很明确（详见 mem-vendors.md）。

⇒ 我们只测了 A4 时延，没测「缓存命中率 / 每轮未命中 token」。
