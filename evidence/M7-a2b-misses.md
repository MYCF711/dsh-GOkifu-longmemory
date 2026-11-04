# M7 · A2b 严格口径的三条失分：卡在哪一层（2026-11-04 巡检）

> 背景：A2b 严格 = **16/19（84.21%）**，是六轴里的主判据。三条失分不能只记一个数就放过 ——
> 本档把每条样本拆到三层量一遍：**claim.text（卡片叙事的来源字段）/ 同域 support.quote / 卡片正文实际重叠**。
> 工具：`tmp/a2b-probe.mjs`（只读探针，不进 git；复现命令见文末）。

## 1 · 三条失分（冻结考卷 `evidence/a2b-set.json`，n=19）

| 签名（截断） | 分桶 | 同域 | 覆盖? | 严格? | claim.text 最大重叠 | 卡片正文重叠 |
|---|---|---|---|---|---|---|
| `error: url hostname "raw.githubusercontent.com" resolves to …` | openDomain | 否 | 是 | **否** | 1（`class:sandbox-limit`） | — |
| `json.decoder.jsondecodeerror: expecting value: line <line> column 1 …` | openDomain | 否 | 是 | **否** | 1（`class:tool-unavailable`） | 1/9 |
| `syntaxerror: invalid or unexpected token at checksyntax (node:internal …` | multiHop | 否 | 是 | **否** | 0 | 2/11 |

三条**都"覆盖"了**（命中的 claim 的支撑局确实包含当年那条签名所在的棋谱）——所以问题不在"没召回"。

## 2 · 机制：类级 claim 的"代表原文"决定了卡片能不能点名

三条失分命中的 claim 全是**类级**：

```
class:sandbox-limit · Error: tool call aborted
class:web-search-empty · Error: DeepSeek returned no web_search_tool_result blocks…
class:tool-unavailable · sed: -e expression #1, char 1: unknown command: `,' [exit code: 1]
class:fs-read-before-write · Error: cannot modify "/d/…": file has changed since it was read
```

一个类级 claim 把**同一类的多条错误**收在一条上，而 `claim.text` 只存**一个代表原文**。
于是当本次签名是"同类的另一条错"时：

- 严格口径按 `claim.text` 的判别词重叠算 ⇒ 重叠 0–1，判失分；
- 卡片正文（0.118.0 起取自 `src.quote`）同样没把这条错的词带出来 ⇒ 重叠 1/9、2/11。

**也就是说：这不是指标口径问题，是真实短板** —— 卡片会把 `class:sandbox-limit（工具被掐）` 这类"工具箱坏了"的
泛教训端上来，却不点名这次到底是哪条错。这正是项目一直在防的**泛相关风险**。

> 反面对照（不要误改）：曾考虑把严格口径放宽成"claim.text ∪ 同域 support.quote 的重叠"，
> 因为 0.118.0 起卡片正文就取 `src.quote`。但实测**卡片正文本身重叠只有 1/9、2/11** ——
> 放宽只会给"卡片里根本没出现的证据"记分，属于发明得分，**否决**。

## 3 · 本轮落地的东西（工具，不改行为）

- `scripts/m5-report.mjs` 的 `measureA2b` 新增 **失分归因** `missBy`：
  `covered`（覆盖了当年的局，但 claim 文本与签名的判别词重叠 <2 ⇒ 文本/选源问题）
  / `notRetrieved`（一条覆盖该签名的 claim 都没进卡 ⇒ 检索/排序问题）。
- 六轴报告的 A2 行会打出 `；**失分归因** 覆盖但文本不匹配 X / 未检索到 Y`，
  下一轮巡检直接知道该修哪一层，不用再写探针。
- 单测：空库场景下必须归因成 `notRetrieved`（不许把检索失败说成文本问题）。
- 本机实测归因：**覆盖但文本不匹配 3 / 未检索到 0** ⇒ 短板在"类级 claim 的展示原文选择"，不在检索。

## 4 · 下一刀（T111，未做）

让类级 claim 的**展示原文按当前信号选**：优先取"同域 support 里与信号判别词重叠最高"的那条 quote，
而不是固定取 `hit.seq` 那条。预期把"覆盖但文本不匹配"往下压，且**必须给 A2b 严格前后对照**（掉分要能解释）。

## 5 · 复现

```bash
node tmp/a2b-probe.mjs        # 分层探针（需要 tmp/ 下的脚本；命令与本文档同源）
node scripts/m5-report.mjs    # A2 行现在自带"失分归因"
node scripts/metrics-guard.mjs
```

---

## 6 · T111 落地后的复测（0.122.0）

改法：`entryFromClaim` 在同域 support 里挑**与本次信号判别词重叠最多**的那条 quote 作为展示原文
（`signalTokensOf`，判别词口径与 m5 同源）；**只有明显更好（≥2 且优于原选）才替换**，否则保持原行为。

| 读数 | 改前 | 改后 |
|---|---|---|
| A2b 覆盖 | 19/19 | 19/19 |
| A2b 严格（`claim.text` 口径） | 16/19 | **16/19（不动，符合预期）** |
| **A2b 卡片可读性（卡片正文口径）** | 17/19 | **18/19** |
| A5 跨作用域 | 0 | **0** |
| A6 结构口径 | 100% | **100%** |
| A4 tokens p50 | 304 | **301**（没膨胀） |

**为什么"严格"不动是预期**：严格口径量的是 `claim.text`（claim 的措辞），而本次改的是卡片**渲染**用的原文。
两者本就不同层 —— 这也是为什么本档 §2 里"把严格放宽到 support.quote"被否决、而"改渲染"被采纳。

**剩下那一条 `json.decoder.JSONDecodeError…`**：卡片正文重叠 1/8，5 条渲染行里没有一条是关于 JSON 解码的
⇒ 覆盖该签名的 claim 根本没进 top-5（**排序**问题），不在 T111 的范围，另记一刀。

复现：`node tmp/readable-probe.mjs`（逐条打印卡片正文与信号的判别词重叠，找可读性失分）。

---

## 7 · T115 落地后的复测（0.124.0）—— 严格回到 89.5%

改法（`src/rooms/inject.mjs` 的 `pickClaim`）：**同一局里往往不止一条教训**，而 walk 命中的那个 seq（或它自带的 claim）可能锚定着
与本次失败无关的类级泛教训。实测 `syntaxerror … checkSyntax` 那条考卷：5 个 hit 全落在同一局 `ep-8a73e06b`，
各自只带一条"工具坏了"的泛教训（文本重叠 0），而真正对得上的那条在同一局的另一个 seq（`c-0402805c`，重叠 8）。
规则：在该局的 claim 里挑与**本次信号判别词**重叠最高的那条，要求 ≥2 且**严格优于原选**，否则保持原行为。

| 读数 | T111 后（0.122.0） | T115 后（0.124.0） |
|---|---|---|
| A2b 覆盖 | 19/19 | 19/19 |
| **A2b 严格（claim.text）** | 16/19（84.2%） | **17/19（89.47%）** |
| A2b 卡片可读性 | 18/19（94.7%） | 18/19（94.7%） |
| 分桶（严格） | multiHop 14/15 · openDomain 2/4 | **multiHop 15/15** · openDomain 2/4 |
| A5 跨作用域 | 0 | **0** |
| A6 结构口径 | 100% | **100%** |

**剩下的 2 条都是 openDomain（跨工作区）**：它们的 claim 支撑局全部在别的工作区，按 A5 被正确挡掉 ——
这正是 `docs/对标-Hindsight.md` §4.5 说的「A2b 的天花板由 A5 决定」，也是 Q18 裁定 A（维持关闸）的代价。
要再往上就只有开 Q18，而 0.119.0 的 A/B 对照显示开闸净负（严格 75%→66.7%），所以停在这里是自觉的选择。

### 连带发现：A1 的口径必须跟着改（S16）

T115 让"闸前的 stale 候选"从 0 张变成 20 张（因为会从同局里挑更贴近的教训，可能挑到已过期的），
于是 A1 的**闸前** `staleTransferRate` 从 0% 跳到 **22.09%（19/86）** —— 但**闸后是 0.00%（0/56 到达模型）**：
闸 3 把这些全部拦掉了，模型看到的东西一个字没变。

结论：A1 的主值应当是**闸门后**的 stale 率（负迁移 = 错误记忆真的进了上下文），闸前的数是"候选暴露度"，照旧打印。
这不是为了让指标好看 —— 而是闸前那个 0% 本来是**偶然**（此前从来没有 stale 候选被渲染，指标对闸根本没锻炼过）。
