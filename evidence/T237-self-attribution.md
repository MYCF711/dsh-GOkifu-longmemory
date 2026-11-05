# T237 · self/root 69 条为什么只有 13.04% 召回（逐条归因）

> `[本] 2026-11-05 15:20 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 脚本：`scripts/a2b-attribution.mjs`（只读）· 复用 `scripts/a2b-holdout.mjs` 的考卷（self/root 69 条）
> 口径：严格命中 = related（claim.support 含该局）**且** claim 文本与任务原话 ≥2 判别词重合（与 T236a 同一套）

## 0 · 一句话结论

**60 条未命中里，27 条是 C（该局任务在库里本就没有可召回的 claim，不算系统的错）；真正"该召回却没召回"的是 33 条，其中 28 条卡在 E 类（walk 命中了该局、候选也在，但被 top-5 排序刷掉）**，4 条 D（该局从未被 walk 命中），1 条 B（只有路径级重合），A 类 0 条（self/root 考卷本身要求信号 ≥12 字，泛信号不会进这一档）。

关键证据（E 类）：`ep-c0a5847a` 的任务有 13 个判别词，walk 的 5 条 hit **tokOverlap 全是 0**（`fs-read-before-write` / `old_string` / `timeout` 这类通用错误），而期望里最重合的 `c-604d5e01` **tokOverlap = 5** 却没进 top-5 ⇒ **排序不看"与任务原话的词面重合"**。

## 1 · 复算

```
$ node scripts/a2b-attribution.mjs
T237 · self/root 归因 · n=69 · 严格命中 9（13.04%）· 未命中 60
其中"该召回却没召回"（A/C 之外）= 33 条

| 类 | 条数 | 占未命中 | 含义 |
|---|---|---|---|
| **B** | 1 | 1.67% | 信号错位（只有实体级重合） |
| **C** | 27 | 45.00% | 目标不存在（无任何重合，不算系统的错） |
| **D** | 4 | 6.67% | 主题没抽到（walk 没命中该局） |
| **E** | 28 | 46.67% | walk 漏掉（命中该局但 claim 没进卡） |
```

判据（写死在 `classifySelfFailure`，互斥、按优先级）：
1. 命中 ⇒ `hit`；
2. 任务原话 < 12 字 ⇒ **A**（泛信号；self/root 考卷按 ≥12 字构造，故本档 0 条）；
3. 词面（ASCII 词 ≥4 + 中文二元组）重合 ≥1 且**该局被 walk 命中** ⇒ **E**；
4. 词面重合 ≥1 但**该局从未被 walk 命中** ⇒ **D**；
5. 词面重合 0，但有实体级重合（路径/包名/命令片段）⇒ **B**；
6. 两者都 0 ⇒ **C**（无目标）。

## 2 · 每类 3 个例子

### A（0 条）
self/root 考卷的构造条件是「任务原话 ≥12 字」，所以泛信号（「处理一下」「继续」）都落在 `self/shortRoot`（11 条，T236a 已单列），**不在本 69 条里**。

### B（1 条）
| episode | 任务原话（前 40 字） | 期望/渲染/walk | 判别词/实体 | 回溯 claimId |
|---|---|---|---|---|
| `ep-2955fa30` | `"F:\Steamcommunity_302\Steamcommunity_30` | 6/4/5 | 0 / 2 | `c-0fb2cc10`, `c-17000ba9` |

只有路径级重合（`Steamcommunity_302`），claim 文本里没有对应的 4+ 字符词 ⇒ **中文/路径分词口径**问题，不是检索没跑。

### C（27 条，不算系统的错）
| episode | 任务原话 | 期望/渲染/walk | 判别词/实体 | 回溯 claimId |
|---|---|---|---|---|
| `ep-9becea64` | 「扫一下我的github仓库，做一下脱敏，尤其是最小上传的一些」 | 19/5/5 | 0 / 0 | `c-00d76725`, `c-03d3fd8d` |
| `ep-aa52f421` | 「怎么号全崩了？是被封号了吗？」 | 12/4/5 | 0 / 0 | `c-01b1ecf1`, `c-13d0c05b` |
| `ep-bde12afa` | 「看下DSH的0.2.2-rc.1版本更新了什么，有没有必要更新」 | 59/5/5 | 0 / 0 | `c-0278a298`, `c-0b46e1f3` |

这三局的 claim（如 `class:timeout · if err := json.Unmarshal…`）与任务原话**零重合**——该局的任务本来就没有可召回的教训。

### D（4 条，该局从未被 walk 命中）
| episode | 任务原话 | 期望/渲染/walk | 判别词/实体 | 回溯 claimId |
|---|---|---|---|---|
| `ep-7520721a` | 「这个b插件的设置怎么老是自动恢复默认呢？我调成了只在侧边栏显示…」 | 2/5/5 | **17 / 17** | `c-26baaecf`, `c-e8a371ee` |
| `ep-1f6c629b` | 「是不是别的软件都能重写解决内存占用问题，只有浏览器必须要用webview？」 | 1/4/5 | **28 / 28** | `c-4f3726e0` |
| `ep-3f03c71c` | 「把这两个仓库再脱敏一下，没问题就公开吧」 | 7/4/4 | 1 / 1 | `c-7b3fb03e`, `c-84e98a55` |

**判别词重合 17/28** 说明 claim 与任务高度相关，但 walk 从没把这一局当命中 —— 主题（`episode.topics`）里没有任务提到的实体 ⇒ **检索入口就不存在**。

### E（28 条，被 top-5 排序刷掉）
| episode | 任务原话 | 期望/渲染/walk | 判别词/实体 | 回溯 claimId |
|---|---|---|---|---|
| `ep-c0a5847a` | 「E:/Documents/dsh-go/HANDOFF.md 读这个交接文件，然」 | 169/5/5 | 5 / 4 | `c-00248579`, `c-0080133b` |
| `ep-bc4ab3cb` | 「https://opc.fiime.cn/zh-cn/download 这个网页」 | 15/3/3 | 2 / 2 | `c-00a2178a`, `c-03a237c3` |
| `ep-00b50089` | 「然后加个定时任务，每小时唤醒一次，可以调整goal，持续推进项目」 | 55/5/5 | 1 / 1 | `c-0153220d`, `c-01c643fc` |

## 3 · 关键证据：E 类的"分数 vs 阈值"差

```
$ 对 ep-c0a5847a 逐条打分（判别词数 13）
  hit c-5175f1dc tokOverlap=0 depth=1 :: class:fs-read-before-write · Error: cannot mod
  hit c-2d4fdcf7 tokOverlap=0 depth=1 :: Error: old_string was not found in "/d/DeepSee
  hit c-13f0ea15 tokOverlap=0 depth=1 :: class:tool-unavailable · sed: -e expression #1
  hit c-55e541da tokOverlap=0 depth=1 :: Error: this destroys the runtime DSH would nee
  hit c-c2e22bf0 tokOverlap=0 depth=1 :: class:timeout · if err := json.Unmarshal(raw,
  期望里最重合的 c-604d5e01 tokOverlap= 5 （没进 top-5）
```
⇒ **top-5 全被 `tokOverlap=0` 的"同局通用错误"占满**，而 `tokOverlap=5` 的 task 相关 claim 排在后面。差 5 个判别词 = 5 个 token 的排序权重。

## 4 · 修哪一类收益最大

| 类 | 条数 | 可修性 | 收益排序 |
|---|---|---|---|
| **E** | 28 | **高**：只改 claim 候选的**排序键**（把"信号判别词在 claim 文本里的出现次数"提到首位） | **①** |
| **C** | 27 | 不可修（没有目标） | — |
| **D** | 4 | 中：需要给 episode 补主题/实体（`topic.mjs` 的 `extractTopics` 对中文长句的抽取） | ② |
| **B** | 1 | 低：分词口径（中文二元组/路径） | ③ |
| A | 0 | — | — |

**修 E 类（28 条）收益最大**：它同时影响"该局任务相关"和大量 repeat 场景（通用错误抢走 top-5 是系统性偏差）。

## 5 · 最小改法（只报告，未改代码）

| # | 文件 · 符号 | 改法 | 预期 |
|---|---|---|---|
| **F1** | `src/rooms/walk.mjs` · `walkFromSignals` 里 `const targetClaims = claims.map(...)` 之后的**候选排序**（`pickClaim` 的 score 计算处） | 把"信号判别词在 claim 文本里出现的次数"作为**第一排序键**（现在是按 support/episode 深度 + `claimHitClass`），深度只作 tie-break | E 类 28 条里，tokOverlap≥1 的会进 top-5 |
| **F2** | `src/rooms/walk.mjs` · `pickMergeMember` | 同上：成员打分已用 overlap，但只在合并组内；`walkFromSignals` 的**全局**候选没有这一项 | 合并组与普通 claim 用同一套排序 |
| **F3**（可选） | `scripts/a2b-attribution.mjs` · `contentOverlap` | 中文二元组目前只在归因侧，如果 F1 落地，应把同一套判别词搬进 `walk`（否则口径不一致） | 归因与检索同口径 |

**验证方式**：改完后重跑 `node scripts/a2b-attribution.mjs`，E 类应显著下降；同时跑 `node scripts/a2b-holdout.mjs` 确认 repeat 题型的 89.47% 不回落（F1 的排序改动可能影响它，必须一起看）。

## 6 · 复现

```bash
node scripts/a2b-attribution.mjs                    # 人读：五类计数 + 每类 3 例
node scripts/a2b-attribution.mjs --json             # 机器读（69 条逐条）
node scripts/a2b-attribution.mjs --episode ep-c0a5847a   # 单局
node scripts/a2b-holdout.mjs                        # 对照：总体 n=108 / 严格 25.93%
```

每条考卷的 `expectedClaimIds` 都能 `store.get('claims', id)` 取回，且 `support[]` 里带 `(episode, seq)`；归因里的 `walkHits`/`bestToken`/`bestEntity` 都是同一次 walk 的运行时读数，可逐条复核。
