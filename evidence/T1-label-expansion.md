# T1 · 扩标注集：135 条人工标注（难负例 49 / 不相关 46.7% / 可判率 3.7% → 33.3%）

> 日期：2026-11-07 · 只做 T1（数据准备）。**没有改** `src/**`、`test/**`、`package.json`、`CHANGELOG.md`、`MAINTENANCE.md`。
> 产出：`evidence/label-set.json`（135 对，逐条 `verdict` + `why`）、`evidence/label-hard-negatives.json`（49 条难负例）、本文件。
> **口径更正（2026-11-08 追加，T22）**：本文 §一/§三/§五/§六/§八 的「same 19 条 / 机械可判 19（100%）」「12 条误判」「49 条难负例 / 46.7%」是 **T15 定点修之前（改前）** 的口径；当前口径见文末 **§九**（`label-set.json` 已按 T15 更新，唯一权威是它的 `stats` / `polaritySnapshot`）。

## 一、结论（逐条对验收）

| 验收项 | 要求 | 实测 | 结论 |
|---|---|---|---|
| ① 人工标注数 | ≥100 条，每条带 `verdict` + `why` | **135 条**，字段齐全（脚本校验 0 处缺失，why 均 ≥8 字） | ✅ |
| ② 难负例 | ≥30 条（`bigramRaw ≥ 2` 且人工判 `irrelevant`） | **49 条**（bigramRaw 2–6） | ✅ |
| ③ 不再正例富集 | `irrelevant` 占比 ≥40% | **63/135 = 46.7%** | ✅ |
| ④ 可判率 | `polarityReport(counts)` 的 `decidable/total` ≥30% | **45/135 = 33.3%**（`polarityReport.usableForDecision = true`） | ✅（口径见 §4，**不能外推**） |

`polarityReport` 原样输出（存在 `label-set.json` 的 `polarityReport` 字段）：

```
反向记忆率 14.8%（20/135）· 可判率 33.3%（45/135）· 可用于决策
```

## 二、数据来源与口径（可复现）

| 项 | 取值 |
|---|---|
| claim 文本 | 真库 `claims/`（**2020 条**，`D:/DeepSeek Harness/home/memory-context/claims/*.json` 的 `text` 字段原文，未改一字） |
| 信号文本 | 考卷 `evidence/a2b-holdout.json` 的 118 条 `signal`：99 条「根用户消息原文 + 原话内硬实体」题 + 19 条 `repeat` 错误签名题；本集用到 50 道（49 段不同信号文本）。**没有一条是我编的** |
| `bigramRaw` | `scripts/a2b-holdout.mjs` 的 `bigramOverlapCount(signal, claimText)`（与考卷同口径、无 df 过滤）。逐条用该函数复算过，与文件里的值一致 |
| `overlap` | 同文件的 `overlapCount`（判别词重合数） |
| `polarity` | `src/rooms/abstain.mjs` 的 `detectPolarity(signal, claimText)`（**只做记录，不参与我的判断**） |
| 人工判断 | 只看 `signalText` 与 `claimText` 两段文本。**没有看 claim 的 `support`**（那是答案泄漏）；`itemId` 里的 episode 也不参与判断，只作追溯 |

复现（只读，不会写库）：

```bash
node -e "const s=require('./evidence/label-set.json');console.log(s.n, s.stats.decidability, s.stats.irrelevantRatio, s.stats.hardNegatives)"
# 135 0.3333 0.4667 49
```

## 三、分层设计（6 层，layer 值写在每条的 `stratum` 字段）

| 层 | 条数 | 机械可判 | 选取规则 | 判据 |
|---|---|---|---|---|
| `same` | 19 | 19（100%） | claim 正文就是信号里那句话（整句包含） | **relevant**：同一句话不可能不相关 |
| `dir` | 15 | 13（87%） | 信号含否定/收缩词 × claim 含方向词，且主题同域 | 逐条判「内容是否同一件事 + 结论是否反向」，写进 `polarityHuman` |
| `rel` | 24 | 0 | 内容同一对象/同一任务链，但机械判不出方向 | **relevant** |
| `hard` | 49 | 12（24%） | `bigramRaw ≥ 2`（有表面字面重合）但内容是另一件事 | **irrelevant**（难负例） |
| `random` | 14 | 0 | 跨 scope 随机配，`bigramRaw = 0` | **irrelevant**（随机负例，**不计入难负例**） |
| `unc` | 14 | 1 | 信号只有「处理一下」「修一下」「这是什么情况」 | **uncertain**（信号信息不足，判不了） |

**判「相关」的口径（写死，避免拍脑袋）**：claim 与信号指向**同一个对象/同一条任务链/同一个错误签名** ⇒ relevant；只共享词面（同一个泛词、同一句式、同一个工具名）而指向**另一个对象** ⇒ irrelevant；信号本身不足以定位对象 ⇒ uncertain。

## 四、可判率的前后对照（**口径必须一起看**）

| 口径 | 对数 | 可判（same+opposite） | 可判率 |
|---|---|---|---|
| v1 标注集（`label-set.json` v1：卡上行抽样、正例富集） | 190 | 7 | **3.7%** |
| 真库**自然候选空间**（118 条信号 × 2020 条 claim，取 `bigramRaw ≥ 2`） | 14116 | 322 | **2.28%** |
| **T1 新标注集（分层，n=135）** | 135 | 45 | **33.3%** |
| 新标注集去掉两个**刻意富集**层（`same` / `dir`） | 101 | 13 | 12.9% |
| 新标注集，但把 12 条**误判**难负例按正确判据退回 `unclear` | 135 | 33 | **24.4%** |

**这张表读法很重要，T2 不要读错**：

- v1 的 3.7% 与自然候选空间的 2.28% 是同一量级 ⇒ **线上自然可判率就在 2–4%**，这是 `detectPolarity` 的真实覆盖率；
- 新标注集的 33.3% **不是**"判据变好了"，而是**我把 `same` / `dir` 两层刻意放进来了** —— 没有这种富集，一个标注集里根本凑不出 30 条能测方向的对；
- 所以 ④ 满足的是**"本集能同时测「相关/不相关 × 方向」"**，**不是**"线上可判率到了 30%"。T2 若要在本集上宣称提升，必须**同时报 precision**（见 §5）。

## 五、关键发现：机械判成 `opposite` 的 20 条里，真正「相关且反向」只有 4 条

`detectPolarity` 的 `opposite` 规则是「信号含 18 个否定词之一 + claim 含 14 个促进词之一 ⇒ 反向」。在本集里机械判成 `opposite` 的 20 条，逐条人工核过：

| 人工结论 | 条数 | 例子 |
|---|---|---|
| **真反向**（同一议题、结论相反） | **4** | 邮箱通知：`能不能让通知链条更频繁一点` × 本局 `被我自己的信息刷爆邮箱，能不能关掉` |
| **同向被误判**（同一议题，结论其实一致） | 8 | 502 路由：`应该换供应商，而不是换账号` × 本局 `502 应该路由到别的路由组` |
| 相邻补充（同一处的另一面，不同向也不同向） | 1 | 502 错误码：`余额为 0 应该换别的错误代码` |
| 内容无关（词面误触发，实为难负例） | 7 | 吃鸡玩法信号 × `应该把第三方 go 插件打包成独立 go.exe` |

**⇒ `opposite` 的精确率约 20%（4/20）**。误触发的词面来源是**否定词表里的高频歧义字**：

- `别` → `别的/别人/别家/特别/区别/识别/类别/别路由组`：本集用到的 49 条信号里含「别」的共 6 条，**6 条全都不是否定祈使**（已逐条核对上下文）
- `不要`：集内含「不要」的 4 条信号里，1 条是「我们要不要做成每个部分都是插件？」这种**疑问句式**（不是「别做」）⇒ 误触发
- `去掉`：集内唯一一条出现在**粘贴的 JSON 片段**里（`去掉尾斜杠与 /v1`），不是用户指令 ⇒ 误触发
- claim 侧 `应该` 是最强势的促进词：本集 claim 里出现 **25 次**，占全部促进词命中（40 次）的 62.5%（其余 `最好`5 / `打开`4 / `增加`2 …），它本身不携带任何方向，却足以把任意一条「建议型」claim 拉成 `opposite`

**给 T2/T7 的三条建议**（本集已经把这些行标出来，可直接当回归用例）：

1. **T2 报可判率必须配套报 `precision`**：`polarityHuman` 字段给了人工方向（`opposite`=4、`same`=8、`none`=1，`irrelevant` 的 7 条没标方向）。只报 33.3% 而不报精确率，等于把误判当成绩。
2. **`opposite` 的词表要先修歧义再扩**：`别` 必须加左/右边界（`别的`/`别人`/`区别`/`识别`/`类别`/`告别`/`特别`），`应该` 单独不足以作为「促进」证据。
3. **T7 的「相关但反向」轴**直接用 `stratum === 'dir'` 且 `polarityHuman === 'opposite'` 的 4 条做正例、`polarityHuman === 'same'` 的 8 条做反例（判据判成 opposite 就是误判）。

## 六、难负例（49 条，`evidence/label-hard-negatives.json`）

定义与 `docs/调研/81-难负例` 对齐：**有表面字面重合（`bigramRaw ≥ 2`）、但内容是另一件事**。这是判据误判率的**真实来源**（随机负例太容易，误判率必然为 0，没有信息量）。

`bigramRaw` 分布：`2: 7`、`3: 17`、`4: 13`、`5: 10`、`6: 2`。

三个代表（都能在同一份 JSON 里查到原文）：

| 信号 | claim | bigramRaw | 为什么算难负例 |
|---|---|---|---|
| `为什么这个报错要一直推送到我的邮箱，能不能关掉？` | `1.我关掉了分支保护，你看下能不能直接删` | 3 | 共享「关掉」→ 判据判 `same`；讲的是分支保护与删分支，与邮箱无关 |
| `海绵宝宝大闹蟹皇堡的手机apk破解版帮我找一个` | `我记得好像有个手机版本的DSH是用GO写的，你看看参照一下` | 2 | 共享「手机版/看一下」→ 判据判相关；一个是找 apk 破解版，一个是 DSH 手机端实现 |
| `我有个想法…做一个各种模型一起参与的吃鸡` | `如果一个功能有明确收益…应该默认打开，且不提供开关` | 3 | 共享「想法/规则/应该」等字面 → 判据判 `opposite`；一个是游戏玩法设计，一个是插件开关策略，毫无关系 |

**其中 12 条同时被机械判成了 `same`/`opposite`**（`label-set.json` 里 `verdict=irrelevant` 但 `polarity != 'unclear'`）：它们既是难负例，也是 §5 说的**误判清单**。T2 改判据后，这 12 条应当**从"可判"退回"unclear"**，而 4 条真反向必须**保持可判** —— 这就是 T2 的回归集会红的地方。

## 七、如实记录的局限

1. **不是自然分布**：本集是分层样本（`same`/`dir` 刻意富集），**任何"率"都不能外推**到线上。要自然分布的率，看上面 §4 第二行（2.28%）。
2. **单人标注**：135 条全部由我一人判（`docs/调研/80` 里记录的 teammate 失败背景仍在）。**没有双人独立复核**，`why` 是我给复核者的唯一依据；有争议的行建议按 `stratum` 抽样 20 条复核。
3. **claim 复用**：135 对来自 **117 条不同 claim、50 道不同的题（49 段不同信号文本）**；同一条 claim 配不同信号出现是刻意的（考卷本来就是每局一张卡，同一条记忆会出现在多张卡上）。
4. **边界口径**：`rel` 层里「同一仓库但不同文件/不同错误」我判 relevant（同一任务链），`hard` 层里「同一个工具但不同故障」我判 irrelevant（不同对象）。这是判断而非事实，已在每条 `why` 里写明依据，可被推翻并记录。
5. **`bigramRaw` 是 substring 语义**（`hay.includes(bg)`），不是集合交 —— 与考卷同口径，但用别的实现复算会有 1–2 的差异（我先用『集合交』复算，14116 对里差了 20 对，才改回 substring 口径）。

## 八、T2 可以直接用的东西

```js
const s = require('./evidence/label-set.json');
s.stats              // 分层计数、irrelevantRatio、decidability、hardNegatives
s.polarityBaseline   // v1 / 自然候选空间 / 新集 三个基线（含"不可外推"的说明）
s.polarityReport     // polarityReport(counts) 的原样输出
s.pairs.filter(p => p.stratum === 'dir' && p.polarityHuman === 'opposite')  // 4 条真反向正例
s.pairs.filter(p => p.stratum === 'dir' && p.polarityHuman === 'same')      // 8 条"不得判成 opposite"的反例
s.pairs.filter(p => p.verdict === 'irrelevant' && p.polarity !== 'unclear') // 12 条应退回 unclear 的误判
```

建议 T2 的验收口径（写进 `evidence/T2-decidability.md`）：

- 可判率：`polarityReport` 口径 ≥30%（本集基线 33.3%）；
- **精确率**：8 条「同向被误判」的行必须**不再被判成 `opposite`**、7 条 `opposite` 难负例必须**退回 `unclear`** ⇒ 改判后 `opposite` 只剩 4 条真反向（precision 100%），且这 4 条**一条都不许丢**（对齐 T2 验收②「误杀率 = 0」的反向）；
- **改判后怎么还能 ≥30%**：把 12 条误判退回 `unclear` 后，本集只有 33/135 = **24.4%**（见 §4 最后一行）—— 要回到 30% 只有一条正路：在 `rel` 层那 24 条**相关但对判据透明**的对上正确判出方向（多判出 ≥8 条即可，它们多数其实是**同向**）。用误判撑到 33.3% 不算达标，这一点必须写进 T2 的报告。

## 九、口径更正（2026-11-08 · T22）：T15 定点修后的当前口径

> **性质**：**追加的更正段，不改写上文已发布内容**。上文 §一/§三/§五/§六/§八 的数字是 **2026-11-07 T1 首次发布时（改前）** 的口径；2026-11-08 T15 对 `#4`/`#14` 做了定点修、并给 `polarity` 加了快照标注（`evidence/T15-label-followup.md`）。本节给出**改前 → 改后**对照。**改后的唯一权威是 `evidence/label-set.json` 的 `stats` / `polaritySnapshot` 字段**；本节所有数字都由它复算（§9.5）。

### 9.1 改前 → 改后（逐项，旧数字保留）

| 位置 | 改前（原文保留） | 改后（当前 `label-set.json`） | 说明 |
|---|---|---|---|
| 标题 / §一② / §六 | 难负例 **49 条** | **50 条** | `#4` 改判 `irrelevant` 且 `stratum=hard`（`bigramRaw=3 ≥ 2`）⇒ 计入难负例。**注意**：`evidence/label-hard-negatives.json` 目前仍是 **49 条**（该文件不在 T15/T22 的可写面）⇒ **待同步 49 → 50**（补 `#4`，`n`/`pairs` 一起改） |
| §一③ | `irrelevant` 占比 **63/135 = 46.7%** | **64/135 = 47.4%** | `#4` `relevant → irrelevant` |
| §一④ | `polarityReport.usableForDecision = true` | **`false`**（§9.2） | 该字段现在是 **T1 旧判据快照**的如实标注；HEAD 判据重算可判率 19.26% < 30% ⇒ 不可用于决策 |
| §三 `same` 层 | **19 条 / 机械可判 19（100%）** | **17 条 / 定义符合率 17/17（100%）** | `#4`、`#14` 移出。**改前的真实定义符合率是 17/19（89.5%）**：`#4`/`#14` 的 claim 都不在信号里（LCS 仅 3 字「问题，」、`overlap=0`）——T13 复核发现、T15 定点修 |
| §三 `rel` 层 | 24 条 | **25 条** | `#14` 从 `same` 移入（`verdict` 仍是 `relevant`） |
| §三 `hard` 层 | 49 条 | **50 条** | `#4` 从 `same` 移入 |
| §五 / §六 / §八 | 「**12 条**误判」 | **13 条**（原 12 条 + `#4`） | `#4` 的快照 `polarity` 仍是 `same`，按同一过滤式会计入；HEAD 判据对 `#4` 是 `unclear`。T2 回归用例已改为**固定 13 个 pairId**（`test/abstain.test.mjs` 的 `MUST_BE_UNCLEAR_PAIR_IDS`），不再依赖该过滤式 |
| §八 代码片段 | `s.pairs.filter(p => p.verdict === 'irrelevant' && p.polarity !== 'unclear') // 12 条` | 同一行现在返回 **13 条** | 过滤式本身没变，条数变了；**新代码请用固定 id 清单**，别再用过滤式 |

**`#4` / `#14` 处置（一句话）**：**`#4` `verdict: relevant → irrelevant` 且 `stratum: same → hard`**（claim 与信号跨局、跨 scope、只共享「内存/显存」泛词、LCS 仅 3 字）；**`#14` 仅 `stratum: same → rel`**（同局同对象，`verdict: relevant` 不动）。两条的 `why` 均保留原判依据（`#4` 追加改判理由），不删旧记录。

### 9.2 polarity 口径（T15 起必须这样读）

- `polarity` / `polarityCounts` / `polarityReport` 是 **T1 旧判据（commit `55ec9ef` 的 `detectPolarity`）快照**：与当时 **135/135 逐条一致**；与 **HEAD 判据差 27/135**（HEAD：`same 24 / opposite 2 / unclear 109` ⇒ 可判率 **19.26%** < 30% 下限 ⇒ **不可用于决策**）。
- `label-set.json` 已有 `polaritySnapshot: {commit:"55ec9ef", module:"src/rooms/abstain.mjs@T1", note, headRecount}` 标明这一点；任何"当前判据"的数字请用 `polarityScorecard(pairs)` **现场重算**，不要读文件里的 `polarity`。
- 因此：**§一④ 的「33.3% / 可用于决策」只属于 T1 快照**；当前 HEAD 判据下是 **19.3% / 不可用于决策**（`evidence/T2-decidability.md`、`evidence/T7-a1-opposite.md` 已按 19.3% 写）。

### 9.3 改后 `stats` 快照（`label-set.json` 原样）

```json
{
 "n": 135,
 "byVerdict": { "relevant": 57, "irrelevant": 64, "uncertain": 14 },
 "byStratum": { "same": 17, "dir": 15, "rel": 25, "hard": 50, "random": 14, "unc": 14 },
 "irrelevantRatio": 0.4741,
 "hardNegatives": 50,
 "randomNegatives": 14,
 "decidable": 45,
 "decidability": 0.3333,
 "decidableRelevant": 31,
 "mechanicalDecidableIrrelevant": 13,
 "semanticDecidabilityOnNonStratified": 0.1456,
 "decidabilityOnRelevant": 0.5439,
 "decidableIrrelevant": 13,
 "maxBigramAmongHardNeg": 6,
 "hardNegBigramMin": 2
}
```

### 9.4 受影响的旧结论（保留原文，但请按改后读）

- **§四「可判率前后对照」**：`33.3%` 行仍是**快照口径**，不是"当前判据"的覆盖率；"新标注集去掉两个刻意富集层（`same`/`dir`）"一行改后是 **103 对 / 15 可判 / 14.6%**（改前 101 / 13 / 12.9%）。
- **§四最后一行 / §八「12 条退回 unclear 后 33/135 = 24.4%」**：改后是 **13 条**；按同一算式为 **32/135 = 23.7%**（只是快照口径的算术说明，不改变 T2 的 19.3% 实测结论）。
- **§六「难负例 49 条，分布 `2:7·3:17·4:13·5:10·6:2`」**：改后 **50 条**，分布多一条 `3`（`#4`）。
- **§七.2「单人标注」**：2026-11-08 T13 已按 stratum 抽 20 条复核（改判 1 条、`same` 层定义 2/19 不符），见 `evidence/T13-label-review.md`；不再是"零复核"。

### 9.5 复算命令（只读）

```bash
node -e "const s=require('./evidence/label-set.json');console.log(s.stats);console.log(s.polaritySnapshot)"
node -e "const s=require('./evidence/label-set.json');const p=s.pairs.filter(x=>x.verdict==='irrelevant'&&x.polarity!=='unclear');console.log(p.length,p.map(x=>x.pairId).join(','))"
# 期望：stats 与 §9.3 一致；误判清单 13 条 = 4,64,65,66,67,68,69,76,77,78,80,81,82
```
