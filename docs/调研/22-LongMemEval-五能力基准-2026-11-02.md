# LongMemEval：长期记忆的五种能力基准（2026-11-02 采集）

- 来源：[arXiv:2410.10813](https://arxiv.org/abs/2410.10813)（ICLR 2025，v2 2025-03-04）。
- [外] 提出**五种长期记忆能力**的评测：
  1. **信息抽取**（information extraction）
  2. **多会话推理**（multi-session reasoning）
  3. **时序推理**（temporal reasoning）
  4. **知识更新**（knowledge updates）
  5. **拒答**（abstention）
- [外] 500 道题嵌在可自由扩展的聊天历史里；商业助手与长上下文模型在持续交互下**准确率掉约 30%**。
- [外] 把长期记忆设计拆成三阶段：**索引（indexing）→ 检索（retrieval）→ 阅读（reading）**；
  并给出三条优化：**会话分解**（value granularity）、**事实增强的键扩展**（fact-augmented key expansion）、
  **时间感知的查询扩展**（time-aware query expansion）。

## 与我们逐条对照

| LongMemEval 能力 | 我们 | 判断 |
|---|---|---|
| 信息抽取 | 归档期机械抽取 episode/claim/topic/link | ✅ |
| 多会话推理 | `threads`/`links` + `walk` ≤2 跳 | ✅ |
| 时序推理 | `occurredAt` + `validFrom/validTo` + `cli facts --at` | ✅（比多数系统更显式） |
| 知识更新 | `validTo`/`supersedes`/disputed（`supersedes` 尚无生产者） | ⚠ 半覆盖 |
| **拒答** | **不命中就零注入**（沉默是默认）；闸不过整卡不注入 | ✅ 设计上就是"拒答优先" |

| LongMemEval 阶段/优化 | 我们 |
|---|---|
| 索引 | `index.md` + topics/links（机械） |
| 检索 | `walk`（跳数上限 + 机械权重） |
| 阅读 | 卡片预算（≤500 tokens、≤5 条）+ 十道闸 |
| 会话分解 | 一局 = 一个 episode（天然分解） |
| 事实增强键扩展 | **没有**：我们的键来自 episode 的主题，不从 claim 文本扩键 |
| 时间感知查询扩展 | **没有**（我们只按时间排序/过滤，不扩查询词） |

## 候选（N5，需证据）
**事实增强键扩展**：给 claim 建"判别词 → claim"的反向索引，让"同类但措辞不同"的失败能命中。
- 与 A2b 严格口径直接相关（这正是 84.2% 里失分的机制之一）；
- 但 0.44.0 试过给 claim 文本追加关键词摘要（无收益、已回退），所以这次要先做**离线对照**：同一冻结集上，
  只加索引不加卡片文本，看严格口径与 token 变化；
- 当前不做：无证据前不改检索层（N2 BM25 暂缓也是同一理由）。

## 结论
LongMemEval 最有价值的不是分数，而是**把"拒答"列为能力之一**——这与我们"不命中就沉默"的设计正好一致；
它给的三条优化里，会话分解我们已经天然具备，另外两条需要证据才能动。
