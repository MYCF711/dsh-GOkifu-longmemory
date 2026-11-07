# T3 · 三级交付（content / pointers / abstain）

> 切片：**T3 三级交付的「指针这一级」**。可写路径：`src/rooms/inject.mjs`、`test/inject.test.mjs`、本文件。
> 依据：`docs/任务书.md` §T3、`docs/记忆的职责边界.md` §4/§5、`docs/调研/88-对比-dsh-memory-bank-2026-11-07.md`（三级交付）。
> 读数时点：2026-11-07（宿主在跑，`card-samples.jsonl` 在增长 —— 口径写清见 §5.1）。
> 代码引用一律「文件 + 符号名」，不写裸行号。

---

## 0 · 结论（先给可核的数）

| 项 | 结果 |
|---|---|
| 三级 | `content`（有把握给全文）/ `pointers`（没把握只给指针）/ `abstain`（无关不给） |
| 「没把握」判据 | **机械两条同时成立**：`state === 'observed'` **且** `claim.support.length <= POINTER_SUPPORT_LIMIT`（=1） |
| 指针三件套 | `episode + seq + occurredAt`（`occurredAt` 渲染成 UTC 绝对日期）——缺一不可 |
| 默认 | **关**（`pointerTier` 默认 `false` ⇒ 与 0.8.46 **逐字节一致**）；`true` 才降级 |
| 实测（1066 张真实卡 / 2321 行） | 1176 行降为指针（占可反查 **50.8%**）· 总 token **168 936 → 136 708（−19.1%）** |
| 端到端（真库 + 真实根消息 11 条） | token **2955 → 2222（−24.8%）** · 8/11 张卡出现指针行 |
| 测试 | `node --test test/inject.test.mjs`：**74 pass / 0 fail / 1 skip**（skip 是既有 T298① known-limitation） |
| 全量 | `node --test`：**1068 pass / 0 fail / 6 skip**（1074 条） |
| 闸 | `node scripts/check.mjs` → **PASS**（privacy-scan 0 处 · boundary-audit 0 处） |
| tombstone | 删掉「给指针」这一级 ⇒ `test/inject.test.mjs` **5 条红**（T3 ①④⑤⑥⑧） |

---

## 1 · 缺口：为什么需要第三级

此前注入面只有两级：

- **有把握 ⇒ 给全文**：卡片渲染该条 claim 的**逐字原文**（`src.quote`）+ 坐标 + 日期；
- **无关 ⇒ 不给**：零展开（`section === null`）。

中间缺一级。真库实测（2026-11-07，2020 条 claim）：

| 状态 | 条数 | 占比 |
|---|---|---|
| `observed`（= 1 局支撑） | 1896 | 93.9% |
| 其中 **support 恰好 1 条** | **1732** | **85.7%** |
| `candidate`（= 2 局） | 115 | 5.7% |
| `standard`（≥3 局） | 9 | 0.4% |

也就是说：**绝大多数记忆只有一局支撑**。给全文的代价是**它冒充断言**（模型会当这条已经被反复验证），
不给的代价是**线索丢了**。第三级只给 `episode + seq + occurredAt`：

- **更省 token**（正文不渲染）；
- **不误导**（卡上没有一句我们不敢担保的话）；
- **可自查**（模型拿着 `(ep, seq)` 自己去查，查不查是它的事 —— 本卡不安排）。

---

## 2 · 判据（机械，可核）

`src/rooms/inject.mjs` 的 `isPointerCandidate(claim)`：

```js
state === 'observed' && 1 <= claim.support.length <= POINTER_SUPPORT_LIMIT   // POINTER_SUPPORT_LIMIT = 1
```

**为什么是「状态 + 计数」两条同时成立**（AGENTS §2.3「计数不是打分」）：

| `state` | `support.length` | 判定 | 理由 |
|---|---|---|---|
| `observed` | 1 | **pointer** | 本仓 marker 语义里 `observed` 就是「1 局」；没有第二种证据 |
| `observed` | 2 / 3 / … | content | **计数是硬事实**：标错了以计数为准，照常给全文（宁可多给） |
| `candidate` | 1 | content | 状态自相矛盾 ⇒ **按最保守的「不降级」走**（不许把有把握的降成指针） |
| `semantic` / `standard` | 1 | content | 同上 |
| `disputed` | 1 | content | 有反例不是「没把握」，它走自己的标记（`[disputed]`） |
| `stale` | 1 | 两条都不走 | 读侧硬过滤（`entryFromClaim` 里先返回 `null`） |
| 无 `support` | 0 | content | 无源不入 —— 根本进不了卡 |

- **不用模型评分**、不看时间、不看信号：判据是**纯函数**，同一条 claim 永远同一结论。
- 计数口径 = `claim.support.length`（**不按作用域过滤**）：跨项目的支撑也是支撑，「1 局」的语义不能因为过滤而变。
- 封顶用常量 `POINTER_SUPPORT_LIMIT`（=1）：将来要放宽/收紧只改一处，测试钉住这个值。

**红线自检**（`docs/记忆的职责边界.md` §4/§5）：

| 问 | 答 |
|---|---|
| 注入的是事实吗？ | 是。指针行正文 = `1 局支撑 · 原文未给`（计数 + 「卡上没给原文」这一卡片事实），**不含该条记忆的断言** |
| 有祈使句 / 「下一步」吗？ | 没有。`auditImperatives(pointerBodyOf(...))` 长度为 0（T3 ⑨ 钉住）；boundary-audit 0 处 |
| 有 provenance 吗？ | 有：行形态仍是 `- [marker] 正文 (ep-…, YYYY-MM-DD, seq N)`，`PROVENANCE_LINE_RE` 可解析（T3 ① 钉住） |
| 有日期吗？ | 有：取所引事件的 `occurredAt`（UTC 绝对日期），**不是入卡时间** |
| 教模型「何时查记忆」吗？ | 不。指针只说「哪一局、哪个 seq、哪一天」 |

---

## 3 · 契约（新字段叫什么、什么时候出现、旧消费方会不会炸）

### 3.1 入口

| 入口 | 变化 |
|---|---|
| `buildMemoryCard({ pointerTier })` | 新增布尔参数，**默认 `false`**（= 0.8.46 行为逐字节一致） |
| `runInject({ flags })` | 新增 `--pointer-tier`（同一开关的 CLI 出口，用于 A/B 对照） |
| `collectEntries` / `entryFromClaim`（内部） | 透传 `pointerTier`；`entryFromClaim` 里一处收口（`const pointer = ...`） |

### 3.2 新增导出（纯函数，无副作用）

| 符号 | 作用 |
|---|---|
| `POINTER_SUPPORT_LIMIT` | 「没把握」的支撑局数上限（=1） |
| `isPointerCandidate(claim)` | 判据本体（§2） |
| `pointerBodyOf(claim)` | 指针行正文（`N 局支撑 · 原文未给`） |
| `tierOf(card)` | 卡片级三级判定：`content` / `pointers` / `abstain` |

### 3.3 卡片字段

| 字段 | 何时出现 | 语义 |
|---|---|---|
| `card.tier` | **恒有** | `'content'`（≥1 行全文）/ `'pointers'`（有展开段但**每行都是指针**）/ `'abstain'`（零展开） |
| `card.pointerCount` | **恒有** | 指针行数（十道闸之外唯一新增的计数；`formatInjectText` 与 shadow 记录消费） |
| `entry.delivery`（= `card.claims[].delivery`） | **只在指针行** | `'pointer'`；content 行**没有**这个字段（旧消费方不必判空） |
| `entry.claimText` | **只在指针行**（渲染内部字段） | 该条记忆的正文。**只用于相关性判定**，不进 `rawText`、不进 `section` |

### 3.4 旧消费方逐条（「会不会炸」）

| 消费方 | 受影响吗 | 说明 |
|---|---|---|
| 注入文本（`cardText` = `indexLine + section`） | **是（仅指针行）** | 指针行渲染成 `- [marker] 1 局支撑 · 原文未给 (ep-…, 日期, seq N)`；content 行一字不变 |
| 闸 0（provenance 前置） | 否 | 行形态不变，`claims.length === 行数` 不变（T3 ⑦ 钉住） |
| 闸 3 / 4 / 7 | 否（更宽松） | 它们本来就把 `kind === 'pointer'` 的行当「不主张断言」；本次不改 `kind`（仍用 claim 自己的 kind） |
| 闸 5（来源纪律） | 否 | 指针行仍带 `claimId` + `(ep, seq)`，`support` 里能查到该出处 |
| 闸 6（预算/省略） | 否 | `tokens` 口径不变（`indexLine + section`）；`omittedCount` 口径不变 |
| `abstain.hasRelevantClaim` | **否（关键）** | 它读 `claims[].text` —— 指针行的 `text` 仍是**那条记忆的正文**，所以「相关命中」不会被误判成「不相关」（T3 ⑦ 钉住）。若把 `text` 改成指针正文，打开这一级会把**大部分卡**判成 abstain（真库 85.7% 的 claim 是 observed/1 局）—— 那是误杀，不是省 token |
| A2b 判分（`scripts/a2b-holdout.mjs` 的 `judgeCard`） | 否 | 它按 `claimId` 回 store 取 `record.text`，不读 `claims[].text` |
| `src/sdk.mjs` 的 `measure` | 部分 | 返回的 `claims[].text` 是指针行的**正文**（未渲染），`section` 才是实际交付文本；字段语义见 §3.3 |
| `scripts/audit-card-samples.mjs`（A6 文字层） | **是（已知遗留，见 §7）** | 它按 `section` 的正文回查该局事件原文；指针行没有正文可查 ⇒ 会记成 `notFound` |

---

## 4 · 前后对照：同一批输入，两级 vs 三级

### 4.1 行级重放（真库 `card-samples.jsonl`，**最贴近线上**）

口径：读真库里 **1066 张卡片留样**（`$DSH_HOME/memory-context/card-samples.jsonl`，宿主在跑 ⇒ 读数时点见文件头）；
对每一行 `- [marker] 正文 (ep, 日期, seq)` 用 `(ep, seq)` 回查 claim（优先取「引文与卡上正文一致」的那条），
再按 §2 判定它在三级下是否降级；**content 行逐字节保留**（只替换指针行）。

| 指标 | 两级（现状） | 三级（`pointerTier`） | 差 |
|---|---|---|---|
| 条目行 | 2321 | 2321 | 0（指针不是省略） |
| 可反查到 claim | 2315 | 2315 | 0 |
| 其中指针行 | 0 | **1176（50.8%）** | +1176 |
| 总 token | **168 936** | **136 708** | **−32 228（−19.1%）** |
| 单卡 token 均值 | 158.5 | 128.2 | −30.3 |
| 单卡 token 中位 | 154 | 112 | −42 |
| 卡片级 `tier` | content 1066 | content **564** / pointers **502** | 854 张卡文本变化 |

> 未反查到 claim 的 6 行按原文保留（计入分母、不计入指针），不掩盖。

### 4.2 逐行样例（真实卡片，直接可核）

```
两级： - [antipattern] From https://github.com/MYCF711/magpie * branch main -> FETCH_HEAD (ep-1cf2b33f, 2026-11-03, seq 1510)
  tokens=30 · claim.state=observed · support=1 · kind=antipattern
三级： - [antipattern] 1 局支撑 · 原文未给 (ep-1cf2b33f, 2026-11-03, seq 1510)
  tokens=19  差=11

两级： - [antipattern] [magpie-wps-lingxi] filterTools 丢弃 1 个非 function 工具 ✔ credentials … (ep-601f0764, 2026-11-03, seq 1516)
  tokens=56 · claim.state=observed · support=1 · kind=antipattern
三级： - [antipattern] 1 局支撑 · 原文未给 (ep-601f0764, 2026-11-03, seq 1516)
  tokens=19  差=37

两级： - [antipattern] TypeError: i.signInHeaders is not a function at … (ep-601f0764, 2026-11-03, seq 961)
  tokens=53 · claim.state=observed · support=1 · kind=antipattern
三级： - [antipattern] 1 局支撑 · 原文未给 (ep-601f0764, 2026-11-03, seq 961)
  tokens=19  差=34
```

**marker 不变**（`[antipattern]` / `[observed]` 仍是那条记忆的状态事实），只把正文换成计数与坐标。

### 4.3 端到端重放（真库 + 真实根消息）

口径：真库（2020 条 claim）+ `corpus/messages.jsonl` 里真实的根消息（去重、≥10 字符，取前 12 条）
→ `walkFromSignals` → `buildMemoryCard` **各跑两遍**（`pointerTier` 关 / 开），作用域取库里出现最多的 scope。

| 指标 | 两级 | 三级 | 差 |
|---|---|---|---|
| 有命中的根消息 | 11 | 11 | 0 |
| walk 命中 | 47 | 47 | 0 |
| token | **2955** | **2222** | **−733（−24.8%）** |
| 指针行 | 0 | 22 | +22 |
| 出现指针的卡片 | 0 | 8/11 | — |
| 卡片文本变化 | — | 8/11 | — |

**实跑（`scripts/cli.mjs inject`，最直观的一组）** —— 真库 + 真实 scope（`w:d:/DeepSeek Harness/default-workspace/DSH-GO`），
信号 = 真实用户原话「Bubble Tea 为基础，能不能写的比TUI更好看？」：

```text
两级：inject · 命中 5 · 渲染 5 · tokens 226/500 · gates OK
三级：inject · 命中 5 · 渲染 5 · tokens 184/500 · gates OK · 交付 pointers（指针 5/5）
        - [observed] 1 局支撑 · 原文未给 (ep-62bcb7d2, 2026-11-07, seq 45652)
        - [observed] 1 局支撑 · 原文未给 (ep-62bcb7d2, 2026-11-07, seq 45616)
        - [observed] 1 局支撑 · 原文未给 (ep-62bcb7d2, 2026-11-06, seq 45353)
        - [observed] 1 局支撑 · 原文未给 (ep-c0a5847a, 2026-11-03, seq 35079)
        - [observed] 1 局支撑 · 原文未给 (ep-c0a5847a, 2026-11-03, seq 34982)
```

同一批命中、同一张卡：**226 → 184 tokens（−18.6%）**，`gates OK`（十道闸 + 边界 0 错），
`tier = pointers`（这一张卡里 5 行全是指针）。坐标与日期一个不少 —— 模型拿 `(ep, seq)` 自己去查。

### 4.4 库级判据统计（真库 2020 条 claim）

| 项 | 数 | 占比 |
|---|---|---|
| 「没把握」（observed 且 support=1） | 1732 | 85.7% |
| 其中 `kind === 'antipattern'`（失败教训） | 1163 | 67.1% |

> 这一行是**默认关**的理由之一：打开它会把 2/3 的「没把握」失败教训降成坐标。
> 失败教训是第一验收面（「先取已付过代价的失败」），降级前必须先有**线上误杀率**证据（T6）。

### 4.5 向前兼容（「不给指针的场景逐字节不变」）

| 场景 | 证据 |
|---|---|
| 默认（不传 `pointerTier`）与显式 `false` | `section` / `tokens` / `tier` / `pointerCount` 全等（T3 ②） |
| 有把握的条目（`candidate` / `observed`+2 局） | 开不开开关 `section` 逐字节相同（T3 ③） |
| 单条 `candidate` 的卡 | 与改动前的快照 `MERGE_FREE_GOLDEN` 逐字节相同（T3 ③） |
| content 行的结构 | 没有 `delivery` / `claimText` 字段（T3 ②） |

---

## 5 · 验证（命令 + 数字 + tombstone）

### 5.1 命令

```bash
node --test test/inject.test.mjs     # 75 条：74 pass / 0 fail / 1 skip（既有 T298① known-limitation）
node --test                          # 1074 条：1068 pass / 0 fail / 6 skip
node scripts/check.mjs               # PASS（privacy-scan 0 处 · boundary-audit 0 处 · 房间齐 · 调研清单 91 篇）
node scripts/cli.mjs inject --signal "<文本>" --store "<store>"            # 两级
node scripts/cli.mjs inject --signal "<文本>" --store "<store>" --pointer-tier   # 三级（A/B 对照）
```

### 5.2 新增测试（`test/inject.test.mjs`，T3 ①②③④⑤⑥⑦⑧⑨）

| # | 钉住什么 |
|---|---|
| ① | 指针行形态 + **三件套**（`episode` / `seq` / `occurredAt` 渲染日期）+ 正文不进卡 + `delivery` 字段 |
| ② | **默认关逐字节一致**（默认 vs 显式 `false`；content 行没有新字段） |
| ③ | **有把握逐字节不变**（含 golden 快照） |
| ④ | **判据边界表**（state × support 十种组合）+ 端到端只有 1 局的那条降级 |
| ⑤ | 三级判定 `tierOf`（pointers / content / abstain + 旧卡兜底） |
| ⑥ | **省 token**（同一批输入两级 vs 三级）+ 行数/坐标/日期都不省 |
| ⑦ | 指针卡**过十道闸** + `hasRelevantClaim` 不被误杀（abstain 兼容） |
| ⑧ | 限额/省略口径不变 + 同输入同输出（确定性） |
| ⑨ | `pointerBodyOf` 只写计数、无指令式片段 |

### 5.3 tombstone（删掉实现必须红）

把 `entryFromClaim` 里的 `const pointer = ...` 换成 `const pointer = false`（= 删掉「给指针」这一级），重跑：

```
✖ T3 ① ✖ T3 ④ ✖ T3 ⑤ ✖ T3 ⑥ ✖ T3 ⑧     ⇒ 5 条红（69 pass / 5 fail）
```

②③⑦⑨ 保持绿是**设计如此**：它们是「向前兼容 / 判据纯函数 / 闸与 abstain 兼容」的守卫，不依赖降级分支。

### 5.4 夹具注记（踩到的坑，写下来省下一个人）

既有测试 `T298 ②/③`、`T333 ①②` 在 `finally` 里 `rmSync(fixture().root)` —— 它们**删掉了共享夹具的根目录**，
之后再用 `fixture()` 得到的是空库（`store.list` 抛错被吞 ⇒ 卡片退化成 episode 指针行）。
T3 段因此**自带夹具**（`makeTierFixture` + `withTierFixture`）：判定不该被别人的清理副作用牵连。

---

## 6 · 三级判定（一句话回顾）

```
content  —— 展开段里至少一行给了全文（有把握）
pointers —— 有展开段，但每一行都只是指针（没把握；坐标 + 日期都在）
abstain  —— 没有展开段（无关 / 无源 / 预算放不下；省略如实记数）
```

`card.tier` 由 `tierOf(card)` 一处判定（消费方不各写一份）。

---

## 7 · 遗留 / 没做到（如实）

1. **默认关，不是默认开。**
   打开它会改变注入文本（真库 50.8% 的行、47% 的卡），而**别的测试文件**把 `observed` + 1 局支撑的 claim
   当"给全文"的夹具用。实测（把默认值临时改成 `true` 跑全量）：**11 条红** ——
   `test/f3-on-card.test.mjs` **3 条**（T345 ①③、T347 ①，**该文件不在本切片可写路径**）、
   `test/inject.test.mjs` **8 条**（A6 ②条、R12 ③条、T115 ①条、T3 ②⑥）。
   后 8 条里 T3 ②⑥ 正是"有把握场景逐字节不变"的守卫，改成"有把握夹具"就等于把守卫删掉；
   所以**默认开 = 必须先动别人的测试文件**，属 Lead 集成范围（`src/plugin.mjs` 的 `decidePreStep`
   传 `pointerTier: config.pointerTier === true`）。
   **重开条件**：拿到 T6 的线上误杀率证据（被降级的行里「其实模型需要全文」的比例），
   并把上面那些夹具改成"有把握"的形态（`candidate` / 2 局支撑）。
2. **A6 文字层审计会把指针行判成 `notFound`。**
   `scripts/audit-card-samples.mjs` 拿 `section` 的正文回查该局事件原文；指针行**故意**没有正文。
   需要在那里加一条「`delivery: 'pointer'` / 固定正文 `原文未给` 的行不参与文字层核对」的豁免 —— 该文件不在本切片可写路径，**未改**。
   影响面：只要 `pointerTier` 保持默认关，A6 就还是 0 处；打开前必须先补这条豁免。
3. **`src/plugin.mjs` 未改**（不在可写路径）：生产链路目前**走不到**三级，`runInject` 的 `--pointer-tier` 是唯一入口。
4. **线上真机验证未做**（无真实流量基线的部分属 T6）：本文件所有数字都是**读真库的离线重放**，
   不是"打开后线上跑了两周"的效果。三个未验项：真实注入后的模型行为（拿到指针会不会去查）、
   与压缩插件同点注入时的叠加、`card.tokens` 预算阶梯在指针行下的实际分布。
5. **`claims[].text` 与 `line` 在指针行上不再相等**（`text` = 记忆正文，`line` = 指针行）。
   这是**故意的**（§3.4：abstain 的相关性判定读 `text`），但读卡的人要知道：**实际交付文本只有 `section`**。
