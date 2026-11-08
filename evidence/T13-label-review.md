# T13 · T1 标注复核（20 条）：维持 19 / 改判 1 ⇒ 改判率 **5.0%**，不触发整集返工

> 日期：2026-11-08 · 任务：`docs/任务书.md` §九 **T13 · T1 标注复核**
> 可写面：**本文件**。没有改 `evidence/label-set.json`（sha256 复核前后同为 `bbe36dd6f7bd429899620d81f7fc67ff7eebb17cadf8dabb74babc4fff79567e`）、`src/**`、`test/**`、`scripts/**`、`package.json`、`CHANGELOG.md`、`MAINTENANCE.md`。
> 复核对象：`evidence/label-set.json`（v2，`n=135`，blob `55ec9ef` = PR #484）· 复核时 HEAD `bbfc1cd`（分支 `task/T9-safety`；工作树另有 T9/T10/T14 的并行改动，与本次复核面无关）。
> 判据来源：T1 自己写死的判据（`evidence/T1-label-expansion.md` §三「判『相关』的口径」）+ 两个可复算函数（`scripts/a2b-holdout.mjs` 的 `bigramOverlapCount` / `overlapCount`，`src/rooms/abstain.mjs` 的 `detectPolarity`）。**我没有引入自己的新判据。**

## 0 · 结论（逐条对验收）

| 验收项 | 要求 | 实测 | 结论 |
|---|---|---|---|
| ① 按 stratum 抽 20 条 | 6 层覆盖 | `same 3 / dir 2 / rel 4 / hard 7 / random 2 / unc 2` = **20**（比例配额 + 层内中点系统抽样，见 §2） | ✅ |
| ② 逐条「维持 / 改判 + 理由」 | 20 条 | §4 全表，每条附 `bigramRaw` / `overlap` / 是否跨局跨 scope | ✅ |
| ③ 改判率 | 给数 | **5.0%（1/20）**：`#4` `relevant → irrelevant` | ✅ |
| ④ 改判 >10% ⇒ 标 T1 需返工 | — | 5.0% ≤ 10% ⇒ **T1 不整集返工**；但 `same` 层 **2/19** 不符其自写定义（样本内 `#4`、样本外 `#14`）⇒ 需**定点修正 2 条** | ✅ |

**一句话**：20 条里 19 条成立；唯一改判的 `#4` 是把「同一句话不可能不相关」的**同句捷径**套在了一条**跨局、跨 scope、最长公共子串只有 3 个字**的配上。数据本身是干净的（`claimText` / `signalText` **135/135 逐字**与真库、考卷一致；`bigramRaw` / `overlap` **135/135 可复算**）；问题集中在**分层定义的措辞与判据文本的歧义**，不在标注内容。

## 1 · 复核了谁、在哪个树上（可追溯）

| 项 | 取值 |
|---|---|
| 标注集 | `evidence/label-set.json` @ blob `55ec9ef`（内容 sha256 `bbe36dd6…79567e`），`version:2`，`n:135` |
| 复核代码树 | HEAD `bbfc1cd`（`task/T9-safety`）；`src/rooms/abstain.mjs` 含 T2 `2be4dc5` 之后的判据 |
| T1 当时的判据树 | `git show 55ec9ef:src/rooms/abstain.mjs`（取到 `/tmp` 后只读引用，用于证明 `polarity` 字段的来源） |
| 真库 claim | `$DSH_HOME/memory-context/claims/`（复核时 **2277** 条；T1 写作时 2020 条，135 条被引 claim 全部仍在且逐字一致） |
| 考卷信号 | `evidence/a2b-holdout.json` 的 `results[*].signal`（118 项，本集用到 50 项 / 49 段不同信号） |
| 参考文档 | `evidence/T1-label-expansion.md`（分层定义、判据、局限声明）· `evidence/T2-decidability.md`（19.3% 口径） |

## 2 · 抽样协议（可复现，不是挑的）

- **配额**：按层大小做**最大余数法**（20 / 135 比例）：`hard 7.259→7`、`rel 3.556→4`、`same 2.815→3`、`dir 2.222→2`、`random 2.074→2`、`unc 2.074→2`（floor 合计 18，余数最大的 `same .815` / `rel .556` 各 +1）⇒ **3/2/4/7/2/2 = 20**。
- **层内**：按 `pairId` 升序、**中点系统抽样** `idx = floor((i+0.5)·n/k)`（i=0..k-1）——避开「总抽到层头层尾」。
- **抽中（升序）**：`4, 10, 16 | 23, 31 | 38, 44, 50, 56 | 62, 69, 76, 83, 90, 97, 104 | 111, 118 | 125, 132`。
- 规则、配额、公式全部写死，任何人用 §9 的命令能抽到同一批；**没有按「可疑」或「好判」换过号**。

## 3 · 复核判据（照抄 T1，只补两条解释）

T1 §三原文（我按它判）：

> claim 与信号指向**同一个对象 / 同一条任务链 / 同一个错误签名** ⇒ `relevant`；只共享词面（同一个泛词、同一句式、同一个工具名）而指向**另一个对象** ⇒ `irrelevant`；信号本身不足以定位对象 ⇒ `uncertain`。

我补的两条解释（不改判据，只消歧义，**这就是 §7-F4 要修的地方**）：

- **E1（"对象"取「任务对象」= 对象 + 目的）**：T1 §七.4 同时写着「`rel` 层『同一仓库但不同文件/不同错误』判 relevant（同一任务链）」与「`hard` 层『同一个工具但不同故障』判 irrelevant（不同对象）」。要让两条并存，只能把「同一个对象」读成**对象 + 要做的事**；本条只影响「同仓库、不同任务」的判（样本内 `#62`）。
- **E2（改判的定义）**：`改判` = 按上述文本**明显**不成立；「换一种读法也说得通」的记 `维持（附注）`（样本内 `#97`、`#132`），否则 20 条里会混进大量口径噪声、改判率失去信息量。

## 4 · 20 条逐条（维持 19 / 改判 1）

> `bg` = `bigramRaw`（与考卷同口径、无 df 过滤）；`ov` = `overlap`。**这两列我都用 HEAD 代码复算过，20/20 与文件一致**（全量 135 也一致，见 §6-A）。
> `原判` = 文件里的 `verdict`；`pol` = 文件里的机械 `polarity`（T1 快照）/ `human` = `polarityHuman`。
> `局/域`：`同` = claim 与信号同局同 scope；`跨` = 至少一项不同（由 claim 的 `support[0].episode` 与考卷项的 `episode`/`scopeKey` 比对得出）。

| # | stratum | bg/ov | pol / human | 局/域 | 原判 | 复核 | 理由（关键证据） |
|---|---|---|---|---|---|---|---|
| 4 | same | 3/0 | same / — | **跨局跨域** | relevant | **改判 → irrelevant** | claim 不在信号里：**最长公共子串只有 3 字「问题，」**；claim 出自 `ep-2ddf0a19`（magpie 本地翻译引擎，同局有「首次翻译（会拉起本地引擎）」「显存: 194 MiB」），信号出自 `ep-1f6c629b`（浏览器/webview 内存），scope 还分属 `w:e:/…` 与 `w:d:/…` ⇒ 只共享「内存/显存」泛词。`why` 自述「**同域**」，未达「同一对象/任务链」 |
| 10 | same | 14/1 | same / — | 同 | relevant | 维持 | claim「我们要不要做成每个部分都是插件？」是信号内**整句**（LCS 16 字 = 全长） |
| 16 | same | 65/6 | same / — | 同 | relevant | 维持 | claim 与信号**逐字相同**（87 字全同，LCS 87） |
| 23 | dir | 3/0 | opposite / **same** | 跨 | relevant | 维持 | 同为 502「换供应商、不换账号」，同向；机械判 `opposite` 是「**别**路由组」的「别」误触发（T1 §5 已记录）。human=same 正确 |
| 31 | dir | 5/0 | unclear / **opposite** | 跨 | relevant | 维持 | 同一对象（改动后是否要重启）、结论相反（「刷新就好不用重启」×「必须提示要重启」）。human=opposite 正确。**注意**：HEAD 判据把这条降成 `unclear`（只收窄不扩表，见 §6-C） |
| 38 | rel | 2/0 | unclear / — | 跨 | relevant | 维持 | 同一对象（自动压缩的开关与阈值），跨局但同议题 |
| 44 | rel | 8/0 | unclear / — | 跨 | relevant | 维持 | 同一条硬要求「按 magpie 脚手架仓库的规则做」，只是两次会话各说一次 |
| 50 | rel | 4/0 | unclear / — | 跨 | relevant | 维持 | 同一对象（magpie 自身下载慢/怎么处理），同一任务链（定位→修/提 upstream issue） |
| 56 | rel | 6/0 | unclear / — | 跨 | relevant | 维持 | 同一任务链（先写 AGENTS、再一次一问拷问），claim 正是该流程的一步 |
| 62 | hard | 5/0 | unclear / — | 跨 | irrelevant | 维持（附注 E1） | 共享的是**同一个仓库**（`magpie 脚手架仓库`，共享 bigram `magpie/脚手/手架/架仓/仓库`），但任务是「改进仓库维护标准」×「按标准做自动登录插件」⇒ 按 E1（对象+目的）不同任务对象 |
| 69 | hard | 4/0 | opposite / — | 跨 | irrelevant | 维持 | 「吃鸡」玩法设计 × 第三方 go 插件打包成 go.exe；共享 `一个/自己/有自/己的` 全是泛词（T1 §6 的代表例） |
| 76 | hard | 6/0 | same / — | 跨 | irrelevant | 维持 | 邮箱推送怎么关 × TUI 光标/关掉了多少默认配置；只共享「关掉/自己」 |
| 83 | hard | 4/0 | unclear / — | 跨 | irrelevant | 维持 | 读/完善本地 AGENTS × 会话级 superagent 插件打 tag、发 GitHub |
| 90 | hard | 5/0 | unclear / — | 跨 | irrelevant | 维持 | 逆向 monkey code × 记忆召回相关度/压缩职责边界 |
| 97 | hard | 4/0 | unclear / — | 跨 | irrelevant | 维持（附注 E2） | claim 侧**对象无名**（「那就别管了，在组织里面自己 fork…」），共享 `仓库/库里/里面/自己` 全是泛词；按 E2 记维持，但这是 §7-F4 的口径缺口 |
| 104 | hard | 3/2 | unclear / — | 跨 | irrelevant | 维持 | 「DeepSeek Harness Creator 是什么」× 绝对路径迁移报错；只共享产品名 |
| 111 | random | 0/0 | unclear / — | 跨 | irrelevant | 维持 | 灵犀图片反复识图 × 「界面失败/日志找不到就查这个文件」；跨项目随机配，`bg=0` |
| 118 | random | 0/0 | unclear / — | 跨 | irrelevant | 维持 | 「Creator 是什么」× 「任务完成之后是最好的观测状态吧？」；`bg=0` |
| 125 | unc | 1/0 | unclear / — | 跨 | uncertain | 维持 | 信号「CNB模型报错」无错误签名，判不出是不是 claim 的「磁盘满会直接报错」 |
| 132 | unc | 1/0 | unclear / — | 跨 | uncertain | 维持（附注 E2） | 信号「怎么号全崩了？是被封号了吗？」指账号，claim 指「提 issue 兼容新版本」；严格读法可判 `irrelevant`，因「号」指代不明记维持 |

### 4.1 需要单独说明的三条

- **`#4`（唯一改判）**：T1 的 `same` 层设计成「claim 就是信号那句话 ⇒ 同一句话不可能不相关」，所以这一层是**免复核的捷径层**。`#4` 的 `claimText` 恰恰**不是**信号里的句子（LCS=3，`overlap=0`），而它又来自「magpie 翻译引擎显存」这一完全另一件事的局；判 `relevant` 等于把捷径用在了它不成立的前提上。`irrelevant` 是**按 T1 判据**的结论（不是我的新判据）。
- **`#14`（样本外，全量机械审计发现，同一条捷径）**：`same` 层 19 条里，`#4` 与 `#14` 的 claim 都**不在**信号文本内（`#14` 的 LCS 也只有 3 字「问题，」，`bg=3/ov=0`）。`#14` 的 claim 出自**同一局**（`ep-d62a520c`，「截图被当 user 文字进模型」×「提示看图能力有问题、关闭原生看图走回退」是同一对象）⇒ **verdict `relevant` 维持**，只需把 `stratum` 改 `rel`。**不改 verdict、只改层**。
- **`#23` / `#31` 的机械方向**：这两条的 `polarity` 字段与 HEAD 判据不一致（`#23` opposite→same、`#31` unclear→same），不是标注错，是 §6-C 说的**快照**。

## 5 · 改判率与结论

| 口径 | 分子/分母 | 率 | 触发什么 |
|---|---|---|---|
| **verdict 改判**（验收口径） | 1 / 20（`#4`） | **5.0%** | ≤ 10% ⇒ **T1 不整集返工** |
| verdict + stratum 全改 | 1 / 20 | 5.0% | 同上 |
| 样本外追加：`same` 层定义不符 | 2 / 19（`#4`、`#14`） | 10.5%（**只看这一层**） | 不返工，**定点修 2 条**（`#4` 改判、`#14` 改层） |
| 全量集层面（若两条都改） | 2 / 135 | 1.5% | 同上 |

**结论**：T1 的 135 条**不需要整集返工**。需要做的是**三条定点动作**（只在现存文件上改字段/改措辞，**不重标、不改判据**）：

1. `#4`：`verdict: relevant → irrelevant`，且 `stratum: same → hard`（`bg=3 ≥ 2`，改判后正好符合难负例定义）。连带：`byVerdict` 变 **57 / 64 / 14**、`irrelevantRatio` 46.7% → **47.4%**、`hardNegatives` 49 → **50**（`evidence/label-hard-negatives.json` 的 `n` 与 `pairs` 同步补 `#4`）；按 `polarity` 快照取的「12 条误判」清单变 **13 条**（`#4` 补进去；HEAD 判据对 `#4` 恰为 `unclear`，T2 用例的 `>= 12` 仍过）。
2. `#14`：`stratum: same → rel`（`verdict` 不动——它确是同局同对象，只是 claim 不是信号那句）。
3. 1+2 都改完后：`same` 层 = **17 条、定义符合率 17/17 = 100%**（现在是 17/19）。同步改 `evidence/T1-label-expansion.md` §三的「`same` 19 条 / 机械可判 19（100%）」，并把 §五「12 条误判」这类**依赖 `polarity` 快照**的数字标注来源（见 §7-F3）。

> 改不改文件本身不归我（T13 只写证据）。我给的是一条条可直接执行的补丁说明。

## 6 · 样本之外的全量机械审计（零模型、可复算）

### A · 可复算字段：**0 处不符**

| 检查 | 方法 | 结果 |
|---|---|---|
| `bigramRaw` | HEAD `bigramOverlapCount(signal, claim)`（默认 `filter=null`） | **135/135 相等** |
| `overlap` | HEAD `overlapCount(signal, claim)` | **135/135 相等** |
| `claimText` / `claimKind` / `claimScope` | 与真库 `claims/*.json` 逐条比对 | **135/135 逐字相等** |
| `signalText` | 与考卷 `a2b-holdout.json` `results[].signal` 比对 | **135/135 逐字相等** |
| 重复对 | `(itemId, claimId)` 去重 | **0 条重复**；117 条 claim（104 用 1 次 / 9 用 2 次 / 3 用 3 次 / 1 用 4 次）× 50 道题 × 49 段信号 |
| 结构计数 | `byVerdict` / `byStratum` / `hardNegatives` / `randomNegatives` | 58/63/14 · 19/15/24/49/14/14 · 49 · 14 —— 与 `stats` 及 T1 文档一致 |
| 层内定义（机械项） | `hard` 全部 `bg≥2`（分布 `2:7·3:17·4:13·5:10·6:2`）；`random` 全部 `bg=0`；`hard` 文件 49 条 = `hard` 层 | 全部符合 |
| 「12 条误判」清单 | `verdict=irrelevant && polarity!=unclear` | 正好 `64,65,66,67,68,69,76,77,78,80,81,82` = **12**（与 T1 §六一致） |

### B · `same` 层的定义符合率：**17/19，不是 19/19**

按 T1 自写定义「claim 正文就是信号里那句话（整句包含）」机械核：`#1–#19` 中 **`#4`、`#14` 不满足**（去空白后互不包含；LCS 均为 3 字「问题，」）。

### C · `polarity` 是 **T1 快照**（不是脏数据，但会被误读）

| 比对对象 | 一致条数 |
|---|---|
| 文件里的 `polarity` × `git show 55ec9ef:src/rooms/abstain.mjs` 的 `detectPolarity` | **135/135 一致**（`same 25 / opposite 20 / unclear 90`） |
| 文件里的 `polarity` × HEAD 的 `detectPolarity` | **27/135 不一致**（HEAD：`same 24 / opposite 2 / unclear 109`，可判率 **19.26%**） |
| 样本 20 条内不一致 | 5 条：`#4 #23 #31 #69 #76` |

⇒ 27 条差异**全部由 T2 的「只收窄不扩表」造成**（`2be4dc5`），字段本身没错，只是**没标快照版本**；而文件头部 `polarityReport` 仍写着「**可用于决策**」，在 HEAD 判据下应为 **false**（19.3% < 30% 下限，T2 的记分卡用例已断言 `usableForDecision === false`）。**这是当前最容易被误读的一处**。

### D · T2 回归用例**依赖**这份快照（改了会假红）

`test/abstain.test.mjs` 的「T2 回归」用例用 `p.verdict === 'irrelevant' && p.polarity !== 'unclear'` 取「12 条误判」清单。两种改法结果不同，别混：

- **只改 `verdict`**（按 §5 给 `#4` 改判、**保留快照 `polarity`**）⇒ 清单变 **13 条**，`>= 12` 仍过（`#4` 在 HEAD 下确实是 `unclear`）。
- **把 `polarity` 按 HEAD 重算** ⇒ 过滤式变成 **0 条**，`assert.ok(mustBeUnclear.length >= 12)` 直接红 —— **红的不是行为回归，是清单来源被换掉了**。

建议把这条用例改成固定 `pairId` 清单（`64,65,66,67,68,69,76,77,78,80,81,82`），或在文件里加 `polaritySnapshot: {commit:"55ec9ef", module:"src/rooms/abstain.mjs"}` 让两件事解耦。

### E · 跨 scope 分布（对 T12 有用）

| stratum | 样本数 | claim 与信号**同 scope** | 跨 scope |
|---|---|---|---|
| `same` | 19 | 18 | 1 |
| `dir` | 15 | 6 | 9 |
| `rel` | 24 | 11 | 13 |
| `hard` | 49 | 7 | 42 |
| `random` | 14 | 0 | 14 |
| `unc` | 14 | 0 | 14 |
| **合计** | **135** | **42** | **93（68.9%）** |

**读法**：`hard` / `random` / `unc` 三层**几乎全是跨 scope 对**（91%）。运行期 `src/plugin.mjs` 的 `classifyAbstainReason` 把 `cross-scope` 排在最前（`if (cross > 0) return 'cross-scope'`），所以这三层判对**测不到** `no-relevant-claim` / `low-confidence` 两条通道（→ 这是 T12「误杀」归因时要注意的口径，不是标注错）。

### F · `why` 的措辞漂移：12 条用「同一议题/同域」当理由

`relevant` 共 58 条，其中 **12 条**的 `why` 写的是「同一议题 / 同域」（`#4 #14 #20 #26 #31 #32 #33 #34 #38 #40 #49 #58`）。我逐条看过这 12 条的原文：**11 条其实满足「同一对象/同一任务链」**（只是措辞松），**只有 `#4` 不满足**（已在 §4 改判）。⇒ 判据的**结果**漂移很小，但**措辞**会误导后来人按「同域」去扩面，建议把判据写成「同一任务对象」并补一条反例（就是 `#4`）。

## 7 · 发现清单（带严重度、建议动作、归谁）

| id | 严重度 | 问题 | 建议动作 | 归属 |
|---|---|---|---|---|
| **F1** | medium | `same` 层把「同句⇒必然相关」当免检捷径，但 19 条里 **2 条**（`#4`、`#14`）claim 并不在信号内（LCS=3）⇒ `#4` 的 `relevant` 是错的 | `#4` 改判 `irrelevant`；`#14` 改层 `rel` | T1 返工（可 5 分钟做完，不需重标） |
| **F2** | medium | `evidence/T1-label-expansion.md` §三写「`same` 19 条 / 机械可判 19（100%）」，与数据不符（17/19） | 改数或改定义措辞 | T1 文档 |
| **F3** | **high（可复现误导）** | `polarity` / `polarityCounts` / `polarityReport` 是 **T1 快照**（与 `55ec9ef` 一致、与 HEAD 差 27 条），且 `usableForDecision: true` 与现状相反 | 加 `polaritySnapshot:{commit,module}`；`polarityReport` 标注「T1 快照，HEAD 重算 19.3% ⇒ 不可用于决策」 | T1 文件（或 T2 接管时一并处理） |
| **F4** | medium | 判据文本 `同一个对象 / 同一条任务链` **未写 OR/AND**；`rel` 层「同仓库不同文件⇒relevant」与 `hard` 层「同工具不同故障⇒irrelevant」并存，靠读者自己补语义 | 写死「**任务对象 = 对象 + 目的**」，并补「claim 侧对象无名 ⇒ 至少 `uncertain`」一档（`#97` 就是这档） | T1 判据 / T2 判据文档 |
| **F5** | low | `unc` 层定义写「信号只有『处理一下』『修一下』『这是什么情况』」，实际只 6/14 是这种纯泛化；另 8 条是「信号指了对象但指不到具体事件」（如「CNB模型报错」） | 把措辞扩成「信号指不到**具体**对象/事件」，否则后来人会拿这 6 条当定义、把另 8 条误判成 `irrelevant` | T1 文档 |
| **F6** | low（不属本任务面） | `detectPolarity` 的「包含式守卫」（`nc.includes(ns)` 即可判 `same`）在 3 字信号上会误判：`#129`（信号「修一下」、claim「修一下，不要走静态表…」）机械判 `same`，把可判数虚抬 1 | 守卫加最小长度（如两侧都 ≥8 字才免判） | T2/T12 面（我只记录，不改代码） |

## 8 · 局限（如实写）

1. **只复核 20 条**（验收要求），不是 135 条全量人工重判；除样本外，我只做了**机械项**（可复算字段、层定义、快照一致性），**没有**对其余 115 条重判 `verdict`。所以本文件只能支撑「T1 不需要整集返工」，不能宣称「135 条全对」。
2. **复核人与原标注人同属一个模型族**（T1 是上一轮单人判、本轮我单人复核）——**不是双人独立**的统计学复核；两轮同源错误的概率不为 0，只是本次 20 条里判据可复用的部分（同句、跨局、共享词）占多数，误判空间有限。
3. **判 `relevant` 时我看的是文本，不看 `claim.support`**（与 T1 同口径）。为了定位「跨局/跨 scope」这类**结构事实**，我在**判完之后**才用 `support[0].episode` 与考卷的 `episode`/`scopeKey` 做核对（只在 §4/§6 里作证据，不参与判定）——这一点与 T1「itemId 里的 episode 不参与判断」不冲突。
4. **E1/E2 是我补的读法**，T1 原文没写；若主人/Lead 采用别的读法，`#62`（E1）与 `#97`/`#132`（E2）的结论可能翻转。这三条我都标了「附注」，改判率不把它们算进分子。
5. 19.3% / 33.3% 这类**率**都不能外推到线上（T1 §4、T2 已反复声明）；本文件所有率都标了分子/分母/树。

## 9 · 复现命令（只读，不会写库）

```bash
# ① 结构 + 计数（与 T1 §二 的复现同口径）
node -e "const s=require('./evidence/label-set.json');console.log(s.n,s.stats.byVerdict,s.stats.byStratum,s.stats.irrelevantRatio,s.stats.decidability)"

# ② 抽样（分层配额 = 最大余数法；层内中点系统抽样；应输出 4,10,16,23,31,38,44,50,56,62,69,76,83,90,97,104,111,118,125,132）
node -e "
const j=require('./evidence/label-set.json');const P=j.pairs.slice().sort((a,b)=>a.pairId-b.pairId);
const alloc={same:3,dir:2,rel:4,hard:7,random:2,unc:2};const out=[];
for(const [s,k] of Object.entries(alloc)){const L=P.filter(p=>p.stratum===s),n=L.length;
for(let i=0;i<k;i++)out.push(L[Math.floor((i+0.5)*n/k)].pairId);}
console.log(out.sort((a,b)=>a-b).join(','));"

# ③ 可复算字段零不符（bigramRaw / overlap）
node --input-type=module -e "
import fs from 'node:fs';import {bigramOverlapCount as b,overlapCount as o} from './scripts/a2b-holdout.mjs';
const P=JSON.parse(fs.readFileSync('./evidence/label-set.json','utf8')).pairs;
console.log('bad',P.filter(p=>b(p.signalText,p.claimText)!==p.bigramRaw||o(p.signalText,p.claimText)!==p.overlap).length);"

# ④ polarity 快照：与 T1 树一致(0 差) / 与 HEAD 不一致(27 条)
git show 55ec9ef:src/rooms/abstain.mjs > /tmp/abstain-t1.mjs
node --input-type=module -e "
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const old = await import(pathToFileURL(process.argv[1]).href);
const { detectPolarity: now } = await import('./src/rooms/abstain.mjs');
const P = JSON.parse(fs.readFileSync('./evidence/label-set.json','utf8')).pairs;
const c = { same: 0, opposite: 0, unclear: 0 };
for (const p of P) c[now(p.signalText, p.claimText)]++;
console.log('vs T1-tree diff:', P.filter(p => old.detectPolarity(p.signalText,p.claimText) !== p.polarity).length);
console.log('vs HEAD  diff:', P.filter(p => now(p.signalText,p.claimText) !== p.polarity).length, '| HEAD counts:', JSON.stringify(c));
" "$(cygpath -w /tmp/abstain-t1.mjs)"   # 期望：vs T1-tree 0 · vs HEAD 27 · HEAD counts 24/2/109
```

## 10 · 给下游（T11 / T12 / T2）可直接用的东西

- **20 条的固定样本**（`4,10,16,23,31,38,44,50,56,62,69,76,83,90,97,104,111,118,125,132`）：下一轮要复核时直接用这批，**可比**。
- **`hard` / `random` / `unc` 有 91% 跨 scope**（42/49 + 14/14 + 14/14 = 70/77）⇒ 用它们测「内容不相关」会被 `cross-scope` 先拦；要测 `no-relevant-claim` / `low-confidence` 通道，得先用 42 条**同 scope** 对（`same 18 / dir 6 / rel 11 / hard 7`）。
- **`dir` 的 5 条人工 `opposite`**（`20 21 22 25 31`）里 HEAD 只保留 2 条（`21 22`）——T7 的 A1.opposite 轴若想报「召回」，分母应是这 5 条，不是 2 条；报「精确率」时分母才是「判成 opposite 的条数」。
- **`#4` / `#14`** 是「同句捷径」失效的两个实例，**可直接当回归用例**（`#4` 必须不得判 `relevant`；`#14` 必须仍 `relevant`、但层是 `rel`）。