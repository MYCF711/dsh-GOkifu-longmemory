# T47 · 知识库第 96 篇（结构化 / 证据归属检索方向）+ 索引与台账同步

> 日期：2026-11-08 · 任务：t39（队长派单）
> 可写面：`docs/调研/96-*.md`（新建）、`docs/调研/00-索引与机制对照.md`、`MAINTENANCE.md`（仅知识库清单一处）、本文件。
> **没有改** `src/**`、`test/**`、`package.json`、`CHANGELOG.md`、版本号。

## 0 · 验收（逐条对）

| 验收项 | 要求 | 实测 | 结论 |
|---|---|---|---|
| ① 真实来源链接 | 2025–2026 新论文/实践，先核来源 | [arXiv:2610.23313](https://arxiv.org/abs/2610.23313)（MemCompile，v1 2026-10-16，USTC 五人）abs/html **均 200**；作者给的代码仓库 [MINE-USTC/MemCompile](https://github.com/MINE-USTC/MemCompile) **HTTP 200**（存在，未逐行核对） | ✅ |
| ② 对本项目的可执行建议 | 不是泛泛综述 | 96 篇 §九 三条逐条对应「相关性=共享机制不是主题相似 / 证据归属 / A2b 提升难」 | ✅ |
| ③ 索引 + 台账 | `00-索引与机制对照.md` + `MAINTENANCE.md` 清单 | 索引：表头 `41–95 → 41–96`、机制表 +「记忆定位 vs 证据呈现」一行（第 27 行）、系统表 +第 **96** 行（第 120 行）；`MAINTENANCE.md` 知识库清单 + `` `96-记忆定位与证据呈现-MemCompile` `` | ✅ |
| ④ 仓库自检 | `node scripts/check.mjs` | **`check: PASS`**，`调研清单 96 篇` | ✅ |

## 1 · 来源核验（先核后写）

| 项 | 值 |
|---|---|
| 论文 | **From Memory Hits to Answerable Evidence: Query-Conditioned Memory Compilation for Long-Term Agent Memory** |
| arXiv | [2610.23313](https://arxiv.org/abs/2610.23313)（**v1 2026-10-16**） |
| 作者/机构 | Shangze Li / Yanyu Yao / Derong Xu / Zhi Zheng / Tong Xu —— **中国科学技术大学**（State Key Laboratory of Cognitive Intelligence） |
| 代码 | [github.com/MINE-USTC/MemCompile](https://github.com/MINE-USTC/MemCompile)（HTTP 200；**未逐行核对实现**） |
| 读过的部分 | 正文 §1–§5、Limitations、附录 A/B 部分；Table 1/2/4 与 RQ3/RQ4 的正文数字 |
| 未确认 | 附录 C/D/E/F 未逐节核对；**没有人类评审一致性**（F1/BLEU/LLM Judge）；调度器/reranker 是 LLM；v1 预印本无会议信息 |
| 不重复 | #92 量「被用上没」；#93 管「过程怎么编译/准入」；#94/#95 管「表示/组织/负迁移」；本篇管 **定位（address）与呈现（evidence）分离**——正对 T43（embedding 负结果）/T44（锚定饱和）/T45（重排 0 收益） |

## 2 · 三条机制 → 三个痛点

1. **相关性 = 共享机制/同一来源，不是主题相似**：MemCompile 的 Address Plane 用**来源链接描述符**（每条 claim 归属到原始轮）做地址，而不是拿 claim 当证据；dense cosine Top-10 的 Judge 只有 **70.91**，编译管线 **80.52**——与 T43（embedding hit@5 0.33/0.57 vs walk 0.67、AUC 0.839 vs 0.850）同向。⇒ 地址应用**来源/实体键**（support episode、repo、错误签名、任务链），不用语义向量。
2. **证据归属**：**来源归一**——`ρ(x)=packet`、同包合并、包分取 max；「多个命中 ⇒ 一个证据候选」。实测 **Top-20 只有 14.60 个不同来源、同源命中吃掉 27.02% 预算**（影响 97.27% 题）；归一 +3.35pp、调度 +28.93pp。⇒ 我们的卡按 **claim 行**分预算，同局多 claim 会重复占位；应**先解析到 `(episode, seq)` 再计数/计预算**。
3. **A2b 提升难**：**固定来源召回 85.50%** 下，换读侧视图 Judge **57.01（单条代表 claim）→ 75.32（原始来源）→ 80.52（完整 claim 包）**（+23.5）。⇒ A2b 的杠杆在**渲染**，不在排序（T45 重排 0 收益、T44 abstain 闸动不了 A2b，与此一致）；先做「渲染实验」，再谈排序。

## 3 · 落盘内容

| 文件 | 动作 | 规模 |
|---|---|---|
| `docs/调研/96-记忆定位与证据呈现-MemCompile-2026-11-08.md` | 新建 | 86 行、9 节 |
| `docs/调研/00-索引与机制对照.md` | 表头 `41–95 → 41–96`；机制表 +1 行；系统表 +第 96 行 | +2 行、改 1 行 |
| `MAINTENANCE.md` | 知识库清单追加 `` `96-记忆定位与证据呈现-MemCompile` ``（**仅此一处**） | 1 行内追加 |

## 4 · 验证（可复现）

```bash
# ① 来源可访问（实测 200/200/200）
curl.exe -sSL -o /dev/null -w "%{http_code}\n" https://arxiv.org/abs/2610.23313
curl.exe -sSL -o /dev/null -w "%{http_code}\n" https://arxiv.org/html/2610.23313
curl.exe -sSL -o /dev/null -w "%{http_code}\n" https://github.com/MINE-USTC/MemCompile

# ② 索引两行都在
grep -n "^| 96 |" docs/调研/00-索引与机制对照.md            # 120
grep -n "记忆定位 vs 证据呈现" docs/调研/00-索引与机制对照.md  # 27

# ③ 台账清单已含 96
grep -o "96-记忆定位与证据呈现-MemCompile" MAINTENANCE.md

# ④ 仓库自检
node scripts/check.mjs            # 实测：check: PASS；调研清单 96 篇
```

实测输出：链接 200/200/200；索引第 96 行在第 120 行、机制行在第 27 行；`check: PASS`（`调研清单 96 篇`）；96 篇正文 86 行、9 节。

## 5 · 未动面 / 工作树说明

| 路径 | 本任务是否改 | 说明 |
|---|---|---|
| `docs/调研/96-记忆定位与证据呈现-MemCompile-2026-11-08.md` | ✅ 新建 | 可写面 |
| `docs/调研/00-索引与机制对照.md` | ✅ 改 | 表头 + 机制行 + 第 96 行 |
| `evidence/T47-research-96.md` | ✅ 新建 | 本文件 |
| `MAINTENANCE.md` | ✅ 只补知识库清单一行 | 未动版本号、状态、下一步 |
| `src/**` / `test/**` / `package.json` / `CHANGELOG.md` | ❌ 未改 | 任务禁止 |
| `src/rooms/walk.mjs`（M）、`test/walk.test.mjs`（M）、`install-superagent.cmd`（未跟踪） | ❌ 未改 | 开工前已在工作树（并行任务/前序产物） |

## 6 · 备注

1. **采集方式**：本机 `web_search` / `web_fetch` 插件端点不可用（magpie 只服务 chat）；arXiv 搜索页一度返回 400，改用 **arXiv API**（`export.arxiv.org/api/query`）+ 直读 `abs/html` 页面（均 200）；96 篇里的 URL 都是实际取到页面的链接。
2. **来源定位**：arXiv 预印本（未查到会议/期刊接收信息）；所有外部数字在文中都标 `[外]`，只作机制与量级参考，不外推。
3. **与 T43/T44/T45 的关系**：T43 = 语义向量负结果；T44 = 精确锚定（集合饱和）；T45 = walk 重排 0 收益；本篇给出**下一步该往哪走**——把「定位/呈现」拆开，先改渲染（同 recall 换视图），再谈排序；并把预算从按 claim 改成按来源。
4. **对下一刀的输入**（不属于本任务，未改 src）：①卡渲染加「来源块」（episode+seq+日期+引文）；②预算按 `episode` 分组；③A2b 三视图 A/B（单 claim / claim+来源块 / 同源 claim 包）。
