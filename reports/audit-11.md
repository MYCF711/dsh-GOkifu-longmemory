# audit-11 · A5 补闸独立复核（0.117.0 线上，重启后）

> 审计员：precision-auditor（独立复核，**不采信** Lead 证据里的结论当依据，所有数字自己复算）
> 时点：`2026-11-04 08:00 +08:00` 前后（`[本]`）· 只读；未改源码/evidence/MAINTENANCE；未跑 `node --test`；无 git 操作。
> 对象版本：仓库与已安装副本都是 **0.118.0**；`src/rooms/inject.mjs` 与
> `D:/DeepSeek Harness/home/profiles/desktop/node_modules/dsh-gokifu-longmemory/src/rooms/inject.mjs`
> **sha256 相同**（`f0696a10…`），所以下文审查的代码就是线上跑的那份（至少 `entryFromClaim` 逐字相同）。
> 数据：`D:/DeepSeek Harness/home/memory-context/card-samples.jsonl`（**24 行，文件 mtime 07:55**，即本轮审计时的全部样本）、`live-stats.jsonl`、各 episode 的会话原件（`readSession` 逐帧解）。

---

## 0 · 结论

**有条件通过。**

| 层 | 判据 | 读数（重启后 10 张卡 / 44 条引用） | 判定 |
|---|---|---|---|
| **A5 引用作用域** | 引用 `(ep, seq)` 的 episode 属于卡片 scope | **44 / 44 同域，跨作用域 0** | **通过**（补闸确实生效，且在渲染路径上） |
| **A6 引文可核（实质）** | 卡上的文字是否就是所引 `(ep, seq)` 那条事件说的 | **28 / 44 对得上；15 / 44 只在本局别处；1 / 44 本局根本没有这段文字** | **不通过**（现有"可回溯 100%"只证明 ep 存在 + seq 在闭包内） |
| **日期可核** | 卡上的日期 = 所引事件时间 | **10 / 44 一致；34 / 44 不一致**（日期取 `claim.occurredAt`，可能是另一局的时间） | **不通过** |

**一句话**：0.117.0 把「引用的作用域」关死了（`crossScopeRefs` 归 0 那条判据是真的），但**没有关掉"别处的失败原文进本卡"**——
因为渲染的文字取 `claim.text`（该 claim 的单条 exemplar），坐标取 `src`（被作用域过滤后挑中的那条 support），
二者**不保证是同一条事件**。反例坐标（唯一一条"本局根本没有这段文字"）：

```
卡片：2026-11-04 07:48:03 +08:00 · scope=w:d:/DeepSeek Harness/default-workspace/DSH-GO · digest=1dabfc6a…
行  ：[antipattern] Error: cannot read "/d/DeepSeek Harness/default-workspace/projects/dsh/plugins/ptc-domain-presets/AGENTS.md": not found
引用：ep-226dbf4f@783
事实：ep-226dbf4f 全量 **14167** 个事件里 "ptc-domain-presets" 出现 **0** 次（AGENTS.md 变体也没有）；
      该文字的真身是 ep-fdd814b1@546（scope=w:d:/DeepSeek Harness/default-workspace，父工程）。
```

这条不是"跨域引用"（`default-workspace` 对 `…/DSH-GO` 是**祖先域**，按 `isScopeVisible` 本来就可见），
所以它**不在** `crossScopeRefs` 里；但它是"别项目的失败原文挂在一条核不上的坐标上"，正是主人原话描述的现象。

**结论三档取"有条件通过"的条件（4 条，按优先级）**：

1. **P0** `entryFromClaim` 渲染时，`text` 必须来自 `src.quote`（或校验 `claim.text` 与 `src.quote` 一致，否则不渲染/降级指针行）。
2. **P0** `entryFromClaim` 的 `occurredAt` 改为优先 `src.occurredAt`（现在优先 `claim.occurredAt`）。
3. **P1** `scripts/audit-card-samples.mjs` 的"可回溯"必须升级为"文字在该 `seq` ±N 事件内出现"，否则这个数是假绿。
4. **P1** 三处 scope 判据统一（`entryFromClaim` 严格相等 / `filterHitsByScope`·闸 1 用 `isScopeVisible` / 审计脚本严格相等）——口径不一致会让"归 0"随实现漂移。

条件 1、2 不落地时，**不建议**对外写"A5/A6 闭环""别项目原文不再进卡"。

---

## 1 · 我复算的数字

### 1.1 全量（我自己跑 `node scripts/audit-card-samples.mjs`）

```
样本 24 张 · 引用 108 条 · 可回溯 108（100.0%）· 同作用域 106 · 跨作用域 2
```

| 指标 | 我的读数 | Lead 证据（07:51） | 差异原因 |
|---|---|---|---|
| 卡片数 | **24** | 22 | 07:55:22 又写了两张（`digest=167e2c8e503a`，长期记忆系统，同 digest 连写两次）；我审计时文件已不再增长（mtime 07:55，08:03 复核仍 24 行） |
| 引用条数 | **108** | 98 | 同上（+10） |
| 可回溯（ep 存在 + seq ∈ 闭包） | **108 / 108** | 98 / 98 | 同口径 |
| 同作用域 | **106** | 96 | 同上 |
| 跨作用域 | **2** | 2 | 一致：`2026-11-04 06:57:35` 与 `07:37:34` 两张 DSH-GO 卡，**同一条 `ep-1cf2b33f@783`** |

重启边界我自己从 `live-stats.jsonl` 按 pid 切分，与 Lead 给的 epoch 对得上：

| pid | 首行 | 末行 | 行数 | `action=inject` |
|---|---|---|---|---|
| 36056（旧） | 2026-11-03T19:38:31.721Z | **2026-11-03T23:37:34.308Z** | 3632 | 54 |
| **38972（新）** | **2026-11-03T23:44:05.009Z**（= `1793749445009`） | 2026-11-04T00:00:33.577Z | 50 | **10** |

### 1.2 重启后逐卡（`at ≥ 1793749445009`，共 10 张 / 44 条引用）

| # | at（+08:00） | scope（简化） | digest | refs | 同域 | 文字在所指步 ±20 | 文字在同局别处 | 文字不在该局 |
|---|---|---|---|---|---|---|---|---|
| 1 | 07:45:14 | default-workspace/DSH-GO | 09496e2972a4 | 5 | 5 | 3 | 2 | 0 |
| 2 | 07:45:17 | default-workspace/DSH-GO | 09496e2972a4 | 5 | 5 | 3 | 2 | 0 |
| 3 | 07:45:18 | GOkifu上下文压缩 | 7f7087776abe | 3 | 3 | **3** | 0 | 0 |
| 4 | 07:45:20 | default-workspace/DSH-GO | 09496e2972a4 | 5 | 5 | 3 | 2 | 0 |
| 5 | 07:45:27 | 长期记忆系统 | c29f0864dc21 | 1 | 1 | **1** | 0 | 0 |
| 6 | 07:48:03 | default-workspace/DSH-GO | 1dabfc6a4c13 | 5 | 5 | 3 | 1 | **1** |
| 7 | 07:48:48 | default-workspace/DSH-GO | c697be2a587f | 5 | 5 | 3 | 2 | 0 |
| 8 | 07:48:54 | default-workspace/DSH-GO | fd7494cf4aa4 | 5 | 5 | 3 | 2 | 0 |
| 9 | 07:55:22 | 长期记忆系统 | 167e2c8e503a | 5 | 5 | 3 | 2 | 0 |
| 10 | 07:55:22 | 长期记忆系统 | 167e2c8e503a | 5 | 5 | 3 | 2 | 0 |
| **合计** | | | | **44** | **44** | **28** | **15** | **1** |

> 判法：把卡上那一行的文字（去掉 `class:<名> · ` 前缀与尾部 `…`）归一化后，在该 episode 的**全部**原始事件文本里搜；
> 命中事件与被引 `seq` 相差 ≤20 记"所指步"，否则记"同局别处"，全无命中记"不在该局"。
> 这是比 `audit-card-samples.mjs`（只查 ep 存在 + seq ∈ 闭包）严一档的检查。

### 1.3 三层校验总表（重启后 44 条）

| 层 | 通过 | 不通过 | 说明 |
|---|---|---|---|
| 引用作用域 | **44 / 44** | 0 | 本次补闸关掉的正是这一层 |
| 引文 = 所引事件原文 | **28 / 44（63.6%）** | 16 / 44（36.4%） | 15 条同局别处 + 1 条本局没有 |
| 日期 = 所引事件日期 | **10 / 44（22.7%）** | **34 / 44（77.3%）** | 例：`ep-226dbf4f@486` 卡上 `2026-11-01`，该步实际 `2026-11-03T07:07:02Z` |

重启前 14 张 / 64 条：2 条跨域（`ep-1cf2b33f@783`），**且这 2 条的文字当时也不在 `ep-1cf2b33f` 里**
（该局 `ptc-domain-presets` 出现 0 次）——说明"文字与坐标脱钩"在补闸**之前就存在**，补闸只是把坐标换到了同域的一条同类事件上。

---

## 2 · 三张卡的逐条比对（对会话原件）

### 2.1 卡 1（07:45:14 · DSH-GO · digest `09496e2972a4`）

| # | 卡上的文字（截断） | 引用 | 该 seq 的事件 | 文字实际在哪 | 判定 |
|---|---|---|---|---|---|
| 1 | `sed: -e expression #1, char 1: unknown command` | `ep-226dbf4f@3466` | assistant/message（step 41，2026-11-03T09:56:51Z） | 同局 @3470（±20 内） | **属实**（seq 是"步"，文字在 4 个事件后） |
| 2 | `Error: old_string was not found … DSH-GO/modules/exec/bash/bash_test.go` | `ep-62bcb7d2@1141` | assistant/message（2026-11-03T08:26:21Z） | 同局 **@6135**（差 4994） | **坐标错**，内容属实（本局真发生过） |
| 3 | `Error: tool call aborted` | `ep-226dbf4f@11385` | assistant/message（2026-11-03T21:50:24Z） | 同局 @11389 | **属实** |
| 4 | `Error: cannot modify "…/_inbox/magpie-wps-lingxi-image-text-fix/REPORT.md": file has not been read …` | `ep-226dbf4f@486` | assistant/message（2026-11-03T07:07:02Z） | 同局 **@11029**（差 10543） | **坐标错**，内容属实（WPS 目录确实在本局会话里被写过） |
| 5 | `Error: DeepSeek returned no web_search_tool_result blocks …` | `ep-62bcb7d2@4570` | assistant/message（2026-11-03T17:45:08Z） | 同局 @4575 | **属实** |

- **泛相关（②）**：第 4 行给的教训是 `_inbox/magpie-wps-lingxi-image-text-fix/REPORT.md` —— 另一个项目的收件箱文件。
  它**在 DSH-GO 的会话里真的发生过**（@11029），所以不是编造；但把它当"Dsh-go 的失败教训"属于**泛相关**，不是本 scope 正在做的事。
- **把别项目说成本项目（③）**：卡面上没有"本项目"字样，但 `(ep-62bcb7d2, 2026-11-02, seq 1141)` 这种写法等价于"这条发生在这一局"。
  第 2、4 行指向的步里并没有这段文字 → **归属是错的**（内容对、坐标错）。

### 2.2 卡 3（07:45:18 · GOkifu上下文压缩 · digest `7f7087776abe`）——干净对照

| # | 卡上的文字（截断） | 引用 | 原件 | 判定 |
|---|---|---|---|---|
| 1 | `不能走脚本压缩，质量很差，我需要用上下文压缩里面选择的默认模型压缩…` | `ep-8a73e06b@33963` | 该 seq 就是用户的这条消息（`user/message`，2026-11-03T13:52:07Z） | **属实**（±20 内 @33955） |
| 2 | `所以需要的不是会话自己去压，而是归档的日志需要去调用默认模型压缩一次…` | `ep-8a73e06b@31916` | 同局用户消息（12:00:22Z） | **属实** |
| 3 | `你去看下日志，没问题的话就是确实有效…进入思考死循环就触发一次压缩` | `ep-8a73e06b@24076` | 同局用户消息（04:57:35Z） | **属实** |

- 这张卡 3/3 都能核上，且内容全是本项目（上下文压缩）自己的决策原话 → **说明补闸链路在"claim 引文恰好就是 exemplar"时完全正常**。
- 这也反证：出问题的不是 scope 过滤本身，而是 `class:` 前缀那类**跨局聚合 claim**（exemplar 与 support 分离）。

### 2.3 卡 9（07:55:22 · 长期记忆系统 · digest `167e2c8e503a`）——就是本轮注入我 prompt 的那张

| # | 卡上的文字（截断） | 引用 | 该 seq 的事件 | 文字实际在哪 | 日期 | 判定 |
|---|---|---|---|---|---|---|
| 1 | `Error: this destroys the runtime DSH would need in order to undo it…` | `ep-8cc34e32@16741` | assistant/message（step 8，2026-11-03T05:24:28Z） | 同局 @16743 | 卡上 `2026-11-02` ≠ 该步 `2026-11-03` | 文字属实、**日期错** |
| 2 | `Error: tool call aborted` | `ep-8cc34e32@2560` | assistant/message（2026-11-01T19:34:12Z） | 同局 **@4744**（2026-11-02T03:14） | 卡上 `2026-11-01` = 该步时间，但**不是文字那条** | **坐标错** |
| 3 | `SyntaxError: Invalid or unexpected token at checkSyntax …` | `ep-8cc34e32@16082` | assistant/message（2026-11-02T23:04:11Z） | 同局 @16086 | 卡上 `2026-11-01` ≠ `2026-11-02` | 文字属实、**日期错** |
| 4 | `Error: cannot modify "…/_inbox/magpie-wps-lingxi-image-text-fix/REPORT.md"…` | `ep-8cc34e32@17371` | assistant/message（tool-call write，2026-11-03T08:14:58Z） | 同局 **@21414** | 卡上 `2026-11-01` ≠ `2026-11-03` | **坐标错**（内容属实） |
| 5 | `Error: DeepSeek returned no web_search_tool_result blocks …` | `ep-8cc34e32@7124` | assistant/message（2026-11-02T08:27:35Z） | 同局 @7130 | 卡上 `2026-11-01` ≠ `2026-11-02` | 文字属实、**日期错** |

- 这张卡我**亲眼在 prompt 里收到**（本轮系统注入的 `<memory-ledger>` 与它逐字一致），说明审计对象不是"历史样本"，而是**真的进模型的文本**。
- 5 行全部同域、全部内容属实（都能在本局找到），但 2 行坐标错、4 行日期错。**对模型来说，跟着 `(ep, seq)` 去核会核到别的事件。**

### 2.4 比对汇总

| 判定 | 条数 | 说明 |
|---|---|---|
| 文字与所指步一致（±20 事件） | 28 | 卡的 seq 记的是"这一步"，失败文本在其后的工具结果里（系统性 2–7 个事件）——这是可接受的设计 |
| 文字在本局、但不在所指步 | 15 | 6 个不同坐标：`ep-62bcb7d2@1141`→@6135（4 次）、`ep-226dbf4f@486`→@11029（5 次）、`ep-c0a5847a@37854`→@42554、`ep-c0a5847a@322`→@40751、`ep-8cc34e32@2560`→@4744（2 次）、`ep-8cc34e32@17371`→@21414（2 次） |
| 文字不在该局 | **1** | `ep-226dbf4f@783`（DSH-GO）—— 文字真身 `ep-fdd814b1@546`（父工程 `default-workspace`） |

---

## 3 · 闸的代码路径审查

### 3.1 渲染只有一条路径，闸就在这条路径上

| 环节 | 文件 · 符号 | 作用 |
|---|---|---|
| 宿主注入入口 | `src/plugin.mjs` · `decidePreStep` | 取 scope、算 signal、调 walk → `filterHitsByScope` → `deps.buildMemoryCard` → `deps.runGates` |
| 命中级作用域过滤 | `src/rooms/inject.mjs` · `filterHitsByScope` | 用 `isScopeVisible`（**祖先可见 + `u:` 层可见**）；无 scopeKey 的 hit 直接丢（`droppedUnknown`） |
| 卡片组装 | `src/rooms/inject.mjs` · `buildMemoryCard` → `collectEntries` | 逐 hit 造行 |
| **补闸所在** | `src/rooms/inject.mjs` · `entryFromClaim` | 选 support、决定 `(ep, seq)` 与 `text` |

`entryFromClaim` 是 `buildMemoryCard` 里**唯一**的 claim 行生产者（`collectEntries` 只调它或 `entryFromEpisode`），
宿主也只有一个调用点（`src/plugin.mjs` 的 `deps.buildMemoryCard`）。**不存在"闸挂在另一条路径上"的情况。**

### 3.2 "全在别的作用域 ⇒ 整条不渲染"——已实现

`entryFromClaim` 的逻辑（逐字）：

```js
const support = scope && byId && !crossAllowed
  ? all.filter((sup) => { const rec = byId.get(sup.episode); if (!rec || typeof rec.scopeKey !== 'string') return true; return rec.scopeKey === scope; })
  : all;
if (!support.length && all.length) return null;   // 有 support 但全属别的作用域 ⇒ 不渲染
```

- 满足"全都别域 ⇒ 不渲染"。
- `crossAllowed` 是 Q18 开关（默认关）：只有 claim 文本以 `class:` 开头、且 hit 带 `class:cross-scope`（walk 仅在 `allowCrossScopeClass` 打开时打）才放行，并加 `[跨项目] ` 前缀。**线上默认关**，我核查的 44 条里没有 `[跨项目]` 行。

### 3.3 宽容语义会不会被跨域 support 利用？

宽容分支是这一行：`if (!rec || typeof rec.scopeKey !== 'string') return true;`（查不到 episode ⇒ 保留，防误杀）。

| 情形 | 结果 | 能不能被利用 |
|---|---|---|
| episode 记录缺失（库未加载/被裁） | 该 support 保留；若它是唯一剩下的，就按它渲染 `(ep, seq)` | **能被利用，但会被审计发现**：`audit-card-samples.mjs` 对 `ep` 查不到记 `exists:false`、`sameScope:false` ⇒ 计入 `crossScopeRefs`。今天的 0 是因为真的没有这种行，不是被掩盖 |
| episode 记录存在但 `scopeKey` 是空串/非字符串 | 同上（保留） | 同上，审计会记 scope 不匹配 |
| **`scope` 或 `episodesById` 没传进来** | `scope && byId` 为假 ⇒ **整段过滤被跳过，`support = all`（回到补闸前行为）** | **这是真正的静默回退面**：将来若有第二个调用方（测试夹具、新的注入入口、别的脚本直接调 `buildMemoryCard`）忘了传 scope，闸静默失效且**没有任何计数**。建议 fail-closed + `dropped.noScope` 计数 |

结论：宽容语义本身**不会**让跨域 support 绕过审计（审计会把"查不到"当跨域），
但"缺 scope 就整段不过滤"是一个**未来可被踩中的静默洞**。

### 3.4 三处 scope 判据不一致（口径漂移风险）

| 位置 | 判据 | 祖先域（`default-workspace` → `…/DSH-GO`） | `u:` 层 |
|---|---|---|---|
| `src/rooms/inject.mjs` · `filterHitsByScope`（命中级，线上首道） | `isScopeVisible` | **可见** | 可见 |
| `src/rooms/inject.mjs` · `entryFromClaim`（support 级，补闸） | `rec.scopeKey === scope`（严格相等） | **丢弃** | 丢弃（除 Q18 开关） |
| `src/rooms/gates.mjs` · 闸 1（`isScopeVisible` 由 `inject.mjs` 导入） | `isScopeVisible` | 可见 | 可见 |
| `scripts/audit-card-samples.mjs` | `ep.scopeKey === row.scope`（严格相等） | **记成跨域** | 记成跨域 |

后果：同一份数据在"命中级"和"support 级"走两套口径 —— **祖先域的命中能进卡片候选，但它的 support 被 support 级过滤丢掉**，
于是渲染器退而挑一条**同域但不同事件**的 support ⇒ **这就是"文字与坐标脱钩"的机器原因**（`ep-fdd814b1@546` 是祖先域，
被 support 级过滤掉，于是挑了 `ep-226dbf4f@783`，而那条事件里根本没有这段文字）。
另外，若将来把 support 级也改成 `isScopeVisible`，`audit-card-samples.mjs` 会把祖先域引用**误报成跨域**（它用严格相等）。

### 3.5 根因：文字、日期、坐标来自三个不同字段

`entryFromClaim` 里：

```js
let src = support.find(s => Number(s.seq) === Number(hit.seq)) ?? support.find(s => s.episode === hit.episode) ?? support[0];
...
const occurredAt = Number.isFinite(claim.occurredAt) ? claim.occurredAt : (src?.occurredAt ?? hit?.occurredAt);
return buildEntry({ episode, seq, occurredAt, text: claim.text, ... });
```

- `episode` / `seq` ← `src`（补闸后 = 同域那条 support）
- `text` ← **`claim.text`**（该 claim 的 exemplar，来自"最早支撑局"，可能是另一条 support、另一个作用域）
- `occurredAt` ← **`claim.occurredAt`**（同上，是 claim 级时间，不是 `src` 事件时间）

三者可任意组合 ⇒ "同域的坐标 + 别处的文字 + 第三处的时间"。
本库的结构性事实：**1053 条 claim 中 `u:` 层 46 条，46/46 的 support 都跨 >1 个作用域**（这是 `u:` 层的定义使然），
所以任何 `class:` 行被渲染到"非 exemplar 所属作用域"时，必然发生这种脱钩。

---

## 4 · 遗留风险与最小建议（不落地，仅建议）

| # | 优先级 | 位置（文件 · 符号） | 建议 | 预期影响 |
|---|---|---|---|---|
| R1 | **P0** | `src/rooms/inject.mjs` · `entryFromClaim` | 渲染文本改为 `src.quote`；或加校验：`clipLine(claim.text)` 与 `src.quote` 不互相包含 ⇒ `return null`（降级为指针行） | 消灭"文字不在该局"1 例 + "文字在同局别处"15 例；代价：部分 `class:` 行降级/消失（`m5` 的 A2b 可能再掉一点，需重测并如实记账） |
| R2 | **P0** | 同上 · `occurredAt` | 改为优先 `src.occurredAt`（缺失才用 `claim.occurredAt`） | 34/44 日期不一致归零；卡片头"日期=occurredAt(UTC)"才名副其实 |
| R3 | **P1** | `scripts/audit-card-samples.mjs` | "可回溯"升级为"文字在该 `seq` ±N 事件内出现"；输出 `near / elsewhere / absent` 三列 | 现在的 `traceableRate=100%` 是弱判据（只证 ep 存在 + seq 在闭包内），会掩盖 R1/R2 类问题 |
| R4 | **P1** | `entryFromClaim` / `filterHitsByScope` / `gates.mjs` 闸 1 / 审计脚本 | 统一为 `isScopeVisible`（或统一为严格相等），四处同源 | 消除"祖先域命中进候选但 support 被丢"的错位链；避免审计脚本把祖先域误报成跨域 |
| R5 | **P2** | `entryFromClaim` | 缺 `scope`/`byId` 时 **fail-closed**（class claim 不渲染）并计数 `dropped.noScope` | 让"闸没生效"可观测，避免第二个调用方静默回到旧行为 |
| R6 | **P2** | `src/rooms/claim.mjs`（class claim 落账） | 在 claim 上记 `exemplarSupportKey`（哪条 support 产生了 text）；渲染时优先同域 exemplar，没有就降级指针行 | 从数据侧消除"text 与 support 无关"的可能，R1 的兜底会更稳 |

**不建议**的做法：
- ❌ 只把审计脚本的 `sameScope` 放宽（例如按 `isScopeVisible` 算同域）来让"跨域=0"更好看 —— 那是改口径，不是改行为；
- ❌ 靠"关掉 `class:` 行"来止血 —— `class:` 行是本项目"不重复踩坑"的主载体，应修坐标而不是删行。

## 5 · 复现（全部只读）

```bash
cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"

# 1) 官方抽查（文本 + JSON）
node scripts/audit-card-samples.mjs
node scripts/audit-card-samples.mjs --json

# 2) 按重启边界切子集（epoch = 新宿主首行 at）
node -e 'const fs=require("fs");const RC=1793749445009;
const rows=fs.readFileSync("D:/DeepSeek Harness/home/memory-context/card-samples.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);
const post=rows.filter(r=>r.at>=RC);console.log("全量",rows.length,"重启后",post.length);'

# 3) 逐行核"文字 vs 原件"（本审计用的判法：全文归一 + ±20 事件窗口）
#    实现要点：readSession(path.join(DSH_HOME, episode.closure.logPath)) 取 events；
#    对每个事件递归收集所有字符串字段（text/arguments/content…）拼成 blob；
#    卡上文字去掉 ^class:<名> ·  前缀与尾部 … 后归一化，作为 needle 在 blob 里搜。

# 4) 反例坐标
node -e 'const fs=require("fs");const rows=fs.readFileSync("D:/DeepSeek Harness/home/memory-context/card-samples.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);
for(const r of rows) if(String(r.section).includes("ptc-domain-presets")) console.log(new Date(r.at).toISOString(),r.scope,r.digest);'

# 5) 代码快照
sha256sum src/rooms/inject.mjs "D:/DeepSeek Harness/home/profiles/desktop/node_modules/dsh-gokifu-longmemory/src/rooms/inject.mjs"
# 两处均为 f0696a1053205dde892cf0f5d1ef1347c5a9c0f2fea4dcb7ec489fbcc2fbbeef（0.118.0）
```
