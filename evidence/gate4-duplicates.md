# 闸 4 两次生产打回的还原与统计（T151）

> 产出：本文件（唯一可写）。全程**只读**：不改记忆库、不改源码、不提交。
> 时点：`[本] 2026-11-05 00:14–00:35`（工作树，`<DSH_HOME>/memory-context` 自 2026-11-04 22:01:50 起无写入）
> 脱敏：不出现本机用户名与 home 目录；claim 正文里的绝对路径压成 `<repo>`；**作用域键保留原样**（它是桶的标识 —— 压成 `w:…/最后两段` 会让 `w:d:` 与 `w:e:` 两个 workspace 显示成同一个标签，而"两个 workspace 互不可见"正是本报告第 3 步的论据）。

## 0 · 一句话结论

**这两次打回不是"两条同文 claim"造成的，而是"同一条 claim 在同一张卡里被渲染了两次"** —— 闸 4 的判据比的是「同 kind + 同 scope + 同文」，同一条记录的两次出现必然判等，于是整张卡被拒。
⇒ **合流（S2）消不掉这两次丢失**；要消掉得在 R12 的渲染去重键里补 `claimId`（或让闸 4 先按 id 去重再判同文）。详见 §5。

## 1 · 两条真实案例

### 1.1 日志原文（心跳台账 `live-stats.jsonl`，逐字）

| # | 时刻（本地） | pid | scope | digest | tokens | gateIds | gateCodes |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-04 22:25:47.758 | 4532 | `w:d:/DeepSeek Harness/default-workspace` | `d37ffd730d3859f6` | 247 | `["4"]` | `["gate4/unsuperseded-duplicate"]` |
| 2 | 2026-11-05 00:00:44.953 | 4532 | 同上 | `a57b5395b673c078` | 194 | `["4"]` | `["gate4/unsuperseded-duplicate"]` |

两次都是 `action=skip` / `reason=gates-failed` / `shadow=false`：卡片装配完成、**被闸 4 整张拒掉**，本轮零注入。

### 1.2 为什么还原不出"哪张卡"

- `card-samples.jsonl` 只在**注入成功**时写（224 条样本里没有这两个 digest：`grep -c` = 0）。打回的那一次没有落样本，**卡内容没有落盘**。
- 卡片指纹不可反推：`src/plugin.mjs` 的 `digestOf(scopeKey, text)` = `sha256(scopeKey + "\0" + cardText).slice(0,16)`，其中 `cardText` 由 `src/plugin.mjs` 的 `cardText(card)` 拼成 = 索引行 + 章节；而章节里的**出处**（`ep-…, seq N`）由 `src/rooms/inject.mjs` 的 `entryFromClaim` → `pickSourceBySignal` 按**本次会话信号词**挑选。
  实测反证：拿 14:25:48 那张成功样本（digest `3998e5dbdc65ab12`、193 tokens）按同一批 claim 重建，**token 数一字不差（193 = 193）**，但 digest 不同（`42ac31b78fe4291e`）—— 差的正是"选了哪条 support"。会话信号未落盘 ⇒ **逐字还原不可能**。
- 因此下面不做"猜卡"，改为**用代码判据把触发机制证死**（§3），再给全库可复算的统计（§4）。

## 2 · 闸 4 判据摘要（读代码得出，引用「文件 + 符号名」）

- **`src/rooms/gates.mjs` · `runGates`，闸 4 段**：取 `card.claims` 里每个条目的 `claimId` → `resolver.get(recordKindOf(claimId), claimId)` 拿**库里的记录**，然后
  `key = kind + "\0" + normalizeScope(record.scopeKey) + "\0" + record.text.replace(/\s+/g," ").trim()`
  同 key ≥2 条 ⇒ 若这些 id 之间**没有任何 `supersedes`/`supersededBy` 互指** ⇒ push `gate4/unsuperseded-duplicate`（detail 带 `ids`/`indexes`）。
- 即：闸 4 判的是**逐字相同**（同 kind + 同作用域 + 归一化空白后同文），**不是**相似度；它与合流契约里的 A/B/C 三口径是两套判据。
- 相关的三处（决定了"什么能进卡"）：
  - `src/rooms/inject.mjs` · `collectEntries`：条目去重键 = `episode + "\0" + seq + "\0" + rawText` —— **不含 claimId**，所以同一条 claim 换个出处就能进两次。
  - `src/rooms/inject.mjs` · `entryFromClaim`：support 若全属别的作用域 ⇒ 该条目**不渲染**（返回 null）。
  - `src/rooms/inject.mjs` · `isScopeVisible`：只允许「同域 / 祖先域 / `u:` 层」，**子域与别的工作区都不可见**。

## 3 · 机制定位（三步证据链，全部可复算）

**第 1 步：这张卡的可见 claim 里，不存在"两条不同 claim 同文"。**
以失败 scope 为当前域，按 `isScopeVisible` 取可见 claim = **139 条**（该域 84 + `u:owner` 55），按闸 4 的 key 分组 ⇒ **exact-duplicate 组 = 0 组**。

**第 2 步：全库唯一的 3 组"两条不同 claim 同文"都进不了这张卡。**
3 组（6 条）全在 `w:e:/Documents/deepseek-harness/default-workspace` 作用域；该域对失败 scope **不可见**（`isScopeVisible` = false），且这 6 条 claim 的 support 全在该域 ⇒ `entryFromClaim` 直接返回 null。实测：把这两条当命中喂给 `buildMemoryCard`，章节为空、卡片只剩索引行（**34 tokens**）。⇒ **它们不是这两次打回的原因。**

**第 3 步：剩下唯一的形态就是"同一条 claim 两条条目" —— 已复现。**
用内存夹具（不落盘）让同一条 `claimId` 出现两条条目，`runGates` 当场给出：

```json
{ "gate": "4", "code": "gate4/unsuperseded-duplicate",
  "detail": { "ids": ["c-demo0001", "c-demo0001"], "indexes": [0, 1] } }
```

**同一个 id 出现两次** —— 这就是线上打回的签名（心跳只记了 `gateIds/gateCodes`，没记 detail，所以日志里看不出是同一个 id）。
触发条件也是机械的：同一条 claim 的 support 里有 **≥2 个不同的 `(episode, seq)`**，两个命中各锚一个出处 ⇒ `collectEntries` 的键不同 ⇒ 两条条目都进卡 ⇒ 闸 4 判"未标 supersedes 的重复"。

## 4 · 全库触发统计（按 scope 排序）

### 4.1 闸 4 的"两条不同 claim 同文"（exact-duplicate）

| scope | claim 总数 | 同文组 | 涉及 claim | 组内 kind | 覆盖链 |
|---|---|---|---|---|---|
| `w:e:/Documents/deepseek-harness/default-workspace` | 305 | **3** | 6（2.0%） | 全 `antipattern` | 全部**无** `supersedes` ⇒ 会打回 |
| 其余 33 个 scope | 927 | 0 | 0 | — | — |

即：**这一种重复只集中在 1 个作用域**（`w:e:` 那 305 条里 3 组，占 1.0%）。失败 scope（`w:d:/DeepSeek Harness/default-workspace`，84 条）本身是 **0 组**。

### 4.2 闸 4 的"同记录双渲染"暴露面（本次真正的成因）

| scope | 有 ≥2 个不同出处的 claim |
|---|---|
| `u:owner` | 55 |
| `w:d:/DeepSeek Harness/default-workspace/DSH-GO` | 33 |
| `w:e:/Documents/deepseek-harness/default-workspace` | 31 |
| `w:d:/DeepSeek Harness/反代` | 9 |
| `w:d:/DeepSeek Harness/default-workspace/GOkifu上下文压缩` | 6 |
| `w:d:/DeepSeek Harness/反代/wps` | 4 |
| 其余 | 8 |
| **合计** | **146 / 1232（11.9%）** |

- 失败 scope 的可见集里，这类 claim 有 **58 条**；其中 **16 条**真的能渲染成"两条同 claim 条目"（其余被 `entryFromClaim` 的跨域过滤挡掉），对应卡片 token 落在 117–171 区间。
- 两次打回的 token 是 **247 / 194**：`247` 在"两条目"里**不存在**（9591 个可见 claim 对里没有一个等于 247）⇒ 那两张卡应是 **3 条目**（两条同 claim + 一条别的）。3 条目组合里恰好等于 194 的有 11 种、等于 247 的 0 种；**组合不唯一，故具体是哪一条 claim 无法定案**（如实记：「无法逐条还原」，但成因类别已证死）。

## 5 · 真实存在的 3 组同文（合流契约档位判定）

> 虽然它们不是这两次打回的原因，但它们是**库里仅有的**真同文对，合流 S2 应当先把这 3 组合掉。

| # | claim A | claim B | 前 60 字 | A 的 support | B 的 support | 档位 |
|---|---|---|---|---|---|---|
| 1 | `c-05ab0ff2` | `c-7718d732` | `Error: DeepSeek returned no web_search_tool_result blocks; the` | 6 条（含 `ep-1286ce28`, seq 2759） | 3 条（是 A 的子集） | **Tier 0**（同证据写重，A 的 support 覆盖 B） |
| 2 | `c-598c1003` | `c-ee907c78` | `Error: this goal operation requires a direct human turn on a` | 5 条（`ep-1e82afca` 11517/11760/11765/12504、`ep-d70b7c2f` 7094） | **完全相同**的 5 条 | **Tier 0**（两次入档写重：03:44 与 07:59 UTC） |
| 3 | `c-c6ddadd5` | `c-d3c38fdd` | `class:module-missing · Error: Cannot find module './_measure-B-b` | 8 条 | **同 8 条**（顺序不同） | **Tier 0**（同证据；A 的 `_store.createdAt` 是 `1970-01-01` 脏值） |

三组都满足 Tier 0 的前置：同 `kind`、同 `scopeKey`、`validity` 相等（`{"type":"none"}`）、`preconditions` 相等（同一条 `scope` 检查）、`counter` 全空。⇒ **合并零信息损失，是 S2 的第一批活。**

## 6 · 合流能不能消掉这两次丢失

**不能 —— 至少这两次打回不是合流能消的形态。**

- 合流合的是「**多条不同 claim** 指向同一个事实」；这两次是「**同一条 claim** 在卡里出现两次」，合并之后这条 claim 还在、support 还在，**换个信号仍会两条条目**。
- 直接因果：`collectEntries` 的去重键 `episode\0seq\0rawText` 不含 `claimId`，所以"同一条 claim 的两个出处"永远能同时进卡；闸 4 又按"同文"判等 ⇒ **打卡是必然的，与库里有没有重复无关**。全库只剩 1 条 claim 时也会打。
- 能消掉的是另一类：**两条不同 claim 同文**（§5 的 3 组，全在 `w:e:` 域）。如果 `w:e:` 域的卡片被渲染，闸 4 会打回那张卡 —— 这类合流能消。

**→ 根因修复（两处，任选其一即可止血，建议都做）**：
1. `src/rooms/inject.mjs` · `collectEntries` 的 `seen` 键补 `claimId`（同一条 claim 只进一次，出处取信号最贴近的那条）—— 治本；
2. `src/rooms/gates.mjs` · 闸 4 的 `byBody` 分组后先按 `record.id` 去重，`ids` 唯一时**不判**重复（只记 `checks`）—— 兜底，且能让心跳 detail 里出现的 id 不再重复。

## 7 · 口径与时点

- `[本] 2026-11-05 00:14–00:35`，工作树；记忆库自 2026-11-04 22:01:50 起无写入（journal 最后一条 `at=1793800910299`），因此"现在算出的组"= 两次打回时的组。
- 统计口径：**分子** = 按闸 4 的 key（`kind` + `normalizeScope(scopeKey)` + 归一化空白后的全文）判等的组数 / **分母** = 该 scope 的 claim 总数（1232 全库）。
- `exact-duplicate` 与合流契约的 A/B/C 三口径**不是同一套判据**：前者逐字相同，后者是相似度 + 前缀。本文件的"3 组"只对前者成立。
- 卡片 token 口径 = `src/rooms/inject.mjs` 的 `estimateTokens`（CJK/1.5 + 其它/4），与心跳里的 `tokens` 同源。
