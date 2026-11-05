# T244 · 自证污染核查（注入的 `<memory-ledger>` 有没有被当成语料再抽取）

> 脚本：`scripts/self-contamination-audit.mjs`（只读）· 判据复用 `scripts/provenance-p2.mjs` 的 P2 三态
> 库：`D:\DeepSeek Harness\home\memory-context`（1465 claim / 730 episode）· 语料：`$DSH_HOME/sessions`（880 日志 / 733 MB）
> 时点 `[本] 2026-11-05 16:2x (+08:00)` · **未写库、未改代码、未跑全量测试、未重启 DSH**（唯一写入口 `--evidence`）

---

## 0 · 一句话

**虚惊：不是"注入卡被当语料"（真 F5 = 0 条）。**

45 条引用（14 条 claim）的引文**在本局唯一来源是注入卡**，但它们的方向**全部**是 `card-from-claim`
（卡在 claim 创建后 **53 分钟 – 2.4 天** 才渲染，卡上还带着 `(ep-…, date, seq N)` 回指）—— 是**卡引用了 claim**，不是 claim 引用了卡。
抽取侧本来就有闸：`extract.mjs#isUserMessage` 只认 `data.source.kind === 'user'`，而注入卡的 kind 是 `dsh-gokifu-longmemory`
⇒ **628 个 `user/message` 卡事件里 `source.kind = user` 的有 0 个**，全部被这道闸挡下（单条实测 `userMessages=0`、`constraints=0`）。

**但这不是"没问题"**——它暴露了同一根因的另一条红线（§5 的 P2 84.89%）：**claim 的 `support[].quote` 是"改写"不是原文**
（换行被压平、可能截断）。45 条"只在卡里能找到"正是压平的极端表现：**卡是唯一把它渲染成一行的地方**。

---

## 1 · 污染路径：`<memory-ledger>` 出现在哪些事件类型里

```console
$ node scripts/self-contamination-audit.mjs --scan-logs --limit 0
卡事件类型分布（scanned-logs=880 · 含卡日志=428 · 卡事件=897 · 总事件=843858）:
   623  user/message | source.kind=dsh-gokifu-longmemory | role=user      ← 注入本身
   114  tool/result | source.kind=(undefined) | role=-                     ← 卡被复制进工具结果
    67  assistant/message | source.kind=(undefined) | role=-              ← 模型回显
    42  tool/call | source.kind=(undefined) | role=-                      ← 工具参数里带了卡
    20  job/registered | source.kind=(undefined) | role=-
    20  job/settled | source.kind=(undefined) | role=-
     4  agent/inbox/spliced | source.kind=(undefined) | role=-
     3  user/message | source.kind=agent-message | role=user             ← 团队消息（正文里引用了标记）
     1  compaction/summary | source.kind=(undefined) | role=-
     1  user/message | source.kind=compact-checkpoint | role=user
     1  team/task | source.kind=(undefined) | role=-
     1  user/message | source.kind=subagent-settled | role=user
```

读法（三条，都是机械事实）：

1. **卡首先、也主要是"注入本身"**：623 条 `user/message`，`source.kind = dsh-gokifu-longmemory`。
2. **卡会扩散到非 user 事件**：`tool/result` 114、`assistant/message` 67、`tool/call` 42 —— 分别是"工具把会话原样读出来 / 模型复述 / 工具参数里带卡"。
3. **`source.kind = user` 的卡事件 = 0**（628 个 user/message 卡中，623 是 gokifu、3 是 agent-message、1 是 compact-checkpoint、1 是 subagent-settled）。
   ⇒ 这就是"抽取为什么没被污染"的全部原因（见 §4）。

> 语料在写入中（当前会话每轮都在长），数字随时点漂移；这一组是同一分钟内的快照。

---

## 2 · 5 条疑似自证污染 claim 的完整证据链

判据（`auditSelfContamination`）：把该局每个事件的原文按 `<memory-ledger>…</memory-ledger>` 剥离，
`selfContaminated = 本局原文里找得到 quote、但去卡文本里找不到`（= 全部出现位置都在卡内）；
再用 `claim.recordedAt` 与卡的最早渲染时间比方向。

### 2.1 `c-9a77de3c`（`ep-c0a5847a`, seq 12852）

```
kind=antipattern · state=observed · verdict=quote-not-substring · self-contaminated=true
direction=card-from-claim
claim.recordedAt = 2026-11-02T19:42:53.368Z
卡最早渲染       = 2026-11-03T22:59:59.724Z        ← 晚 27 小时
引用 seq 12852 的类型 = assistant/message             ← 不是卡，也不含这句
引文：error: pathspec 'bash' did not match any file(s) known to git error: pathspec '会话有自己的' did not match any file(s) known to git error: pathspec 'cwd，否则模型两边困惑'
卡内出现：seq 42051（user/message|role=user）
卡上那一行（逐字）：
- [antipattern] error: pathspec 'bash' did not match any file(s) known to git error: pathspec '会话有自己的' did not match any file(s) known to git error: pathspec 'cwd，否则模型两边困惑 (ep-c0a5847a, 2026-11-02, seq 12852)
```

### 2.2 `c-2e17ebe4`（`ep-543cf0b2`, seq 20）

```
kind=antipattern · state=standard · verdict=quote-not-substring · self-contaminated=true
direction=card-from-claim
claim.recordedAt = 2026-11-04T11:57:35.940Z
卡最早渲染       = 2026-11-04T12:50:28.668Z        ← 晚 53 分钟
引用 seq 20 的类型 = assistant/message
引文：fatal: not a git repository (or any of the parent directories): .git fatal: not a git repository (or any of the parent directories): .git [exit code: 128]
卡内出现：seq 1273, 1451, 1545（均 user/message|role=user）
卡上那一行：
- [antipattern] fatal: not a git repository (or any of the parent directories): .git fatal: not a git repository (or any of the parent directories): .git [exit code: 128] (ep-543cf0b2, 2026-11-04, seq 20)
```

### 2.3 `c-bb49dbeb`（`ep-543cf0b2`, seq 20）—— 与 2.2 同文同源，另一条 claim

```
kind=antipattern · state=candidate · verdict=quote-not-substring · self-contaminated=true
direction=card-from-claim · claim.recordedAt = 2026-11-04T11:57:35.940Z · 卡最早渲染 = 2026-11-04T12:50:28.668Z
引文与 2.2 完全相同（两条 claim 共用同一段引文）
```

### 2.4 `c-4531a6d0`（`ep-8a73e06b`, seq 33333）

```
kind=antipattern · state=candidate · verdict=quote-not-substring · self-contaminated=true
direction=card-from-claim
claim.recordedAt = 2026-11-02T19:42:53.368Z
卡最早渲染       = 2026-11-05T05:52:36.666Z        ← 晚 2 天 10 小时
引用 seq 33333 的类型 = assistant/message
引文：Error: Cannot find module '<USER_HOME>\AppData\Local\Temp\engine-nomethod.mjs' at node:internal/modules/cjs/loader:1564:15
卡内出现：seq 48959（user/message|role=user）
卡上那一行：
- [antipattern] class:module-missing · Error: Cannot find module '<USER_HOME>\AppData\Local\Temp\engine-nomethod.mjs' at node:internal/modules/cjs/loader:1564:15 (ep-8a73e06b, 2026-11-03, seq 33333)
```

### 2.5 `c-4a7e6c4b`（`ep-8a73e06b`, seq 37006）

```
kind=antipattern · state=observed · verdict=quote-not-substring · self-contaminated=true
direction=card-from-claim
claim.recordedAt = 2026-11-03T23:50:22.243Z
卡最早渲染       = 2026-11-04T18:10:32.713Z        ← 晚 18 小时
引用 seq 37006 的类型 = assistant/message
引文：TypeError: Cannot read properties of undefined (reading 'slice') at [eval]:7:45 at runScriptInThisContext (node:internal/vm:219:10)
卡内出现：seq 45994（user/message|role=user）
卡上那一行：
- [antipattern] TypeError: Cannot read properties of undefined (reading 'slice') at [eval]:7:45 at runScriptInThisContext (node:internal/vm:219:10) (ep-8a73e06b, 2026-11-03, seq 37006)
```

### 2.6 五条共同的形状（这才是真结论）

| 观察 | 5/5 一致 | 含义 |
|---|---|---|
| 引用的 seq 是 `assistant/message`，且**不含**引文 | ✓ | **指针指错**（P2 类） |
| 引文只在卡里逐字出现 | ✓ | 引文是**改写**：多行工具输出被压成一行（原文换行 → 空格） |
| 卡上带 `(ep-…, date, seq N)` 且 N = 该 claim 的 seq | ✓ | 卡是**从 claim 渲染**的（provenance 回指 claim 自己） |
| 卡渲染时间 > `claim.recordedAt` | ✓ | 方向 = `card-from-claim`，**不是** F5 |

**所以**：`quote` 的"唯一来源是卡"是**卡渲染造成的假象**——卡把它压平了，原文里没有这个压平形态。
真正的缺陷在**上一跳**：`claim.text` 本来就是改写（T241 已记：`offset 矛盾根因=尺子不同（claim.text 是改写不是原文）`）。

---

## 3 · 量化（全库）

```console
$ node scripts/self-contamination-audit.mjs --json --samples 45 --scan-logs
claims 1465 · refs 2468 · ok 373 · not-substring 2095 · unreadable 0
in-ledger=0 · 远偏移命中=996 · self-contaminated=45（refs 1.82% / claims 0.96%，14 条 claim）
events-scanned=421176
```

| 指标 | 值 | 说明 |
|---|---|---|
| claim 总数 | **1465** | 全部有 support 引用 |
| support 引用总数 | **2468** | |
| `ok`（quote 是 (ep,seq) 原文逐字子串） | **373（15.11%）** | |
| `quote-not-substring`（原文读到了但不是子串） | **2095（84.89%）** | **这是主问题** |
| `seq-unreadable` | **0** | 指针格式全对（P1 绿） |
| 其中"引文在本局**别处**能找到" | **996** | 指针偏移 |
| **`selfContaminated`（引文唯一来源是卡）** | **45 条引用 / 14 条 claim（1.82% / 0.96%）** | |
| ├ 方向 `claim-from-card`（**真 F5**） | **0** | |
| └ 方向 `card-from-claim`（卡引用了 claim） | **45** | 见 §2 |
| 卡内命中的事件类型 | `user/message` 75 处 · `tool/result` 4 处 | 45 条引文的全部出现位置 |

**分母/时点**：claim 1465 条（`claims/*.json` 全量，无 --limit）；episode 730 局；时点 2026-11-05 16:2x。

---

## 4 · 定位排除点（文件 + 符号名）

| 位置 | 有没有 `<memory-ledger>` 过滤 | 结论 |
|---|---|---|
| `src/rooms/logread.mjs` 的 `parseEvents` | **没有**（`grep -n ledger src/rooms/logread.mjs` 无输出） | **正确**：R01 是忠实读取器，隐藏数据会让"读到什么"不可复算 |
| `src/rooms/episode.mjs` 的 `buildEpisode` | **没有** | 它只做时间窗/闭包，不读文本，无风险 |
| `src/rooms/extract.mjs` 的 `isUserMessage` | **有（但不是按卡标记，是按来源）** | 只认 `data.source.kind === 'user'`（`USER_SOURCE_KIND`）；注入卡 kind=`dsh-gokifu-longmemory` ⇒ 被挡 |
| `src/rooms/extract.mjs` 的 `extractSignals` §2 约束段 | **没有**（直接 `messageText(...)` → `extractConstraints`） | 靠上一行的 `isUserMessage` 兜着；**单点依赖** |
| `src/rooms/topic.mjs` 的 `collectRootUserTexts` | **没有** | `.filter((e) => e && e.type === 'user/message')` —— **没有 source.kind 判断** |
| `scripts/archive.mjs` | **没有** | 原始 `events` 直接透传给 `extractSignals` 与棋谱 |

### 4.1 机制验证（把真卡喂给三个消费者，看谁咬钩）

```console
# ① extractSignals：user/message 卡 → 0 条约束（被 isUserMessage 挡住）
$ node tmp/t244-umsg.cjs
scanned: {"edges":0,"events":1,"userMessages":0,"toolCalls":0}
counts:  {"failures":0,"successes":0,"commandSuccesses":0,"unsettled":0,"constraints":0,"tools":0,"byResult":{}}

# ② extractConstraints（纯函数，直接喂卡原文）→ 4 条！卡里的行"长得很像用户约束"
$ node tmp/t244-card.cjs
条数: 4
  · "[{\"id\":\"m1\",\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"MEMORY: …"
  · "(ep-8cc34e32, 2026-11-02, seq 6975)\n- [observed] 开启superagent模式，做好定时任务，写好goal，把任务清单列出来，写好AGENTS，记住最小交付房间理论，不要粉色大象。"
  · "(ep-8cc34e32, 2026-11-01, seq 1613)\n- [observed] 产品目标是记忆系统，涵盖长期记忆，长期知识库，而且一定要解决过拟合问题。"
  · "(ep-8cc34e32, 2026-11-01, seq 8)\n- [candidate] 只把压缩本职工作做到最好，形成可执行改进项并落地验证。"
# ⇒ 卡里含「目标 / 一定要 / 不要 / 记住」⇒ 命中 CONSTRAINT_HARD_RE；**唯一的闸就是 isUserMessage**

# ③ collectRootUserTexts：全库 730 局
$ node tmp/t244-root.cjs
{"episodes": 730, "episodesWithCardAsRootUser": 0, "samples": []}

# ④ 棋谱（上游 kifu 模型）：670 graph / 87245 node / 113614 edge
$ node tmp/t244-graph.cjs
{"graphs":670,"withCard":2,"nodes":87245,"nodesWithCard":0,"edges":113614,"edgesWithCard":5,"samples":[]}
# 5 条边的 action 都是「工具参数里出现了这个字面量」（写本审计脚本 / 写文档），不是卡内容
```

**结论**：当前库**没有**"卡→claim"的实例；但这道闸是**单点**的（`isUserMessage` 一个函数），
而 `extractConstraints` 对卡文本**是会咬钩的**（4 条）。只要哪一天卡以 `source.kind = 'user'` 落地（例如子代理 inbox / 团队消息转发），立刻污染。

---

## 5 · 真正该修的那条红线（P2：quote 不是原文）

| 量 | 值 |
|---|---|
| `ok` | 373 / 2468 = **15.11%** |
| `quote-not-substring` | **2095 / 2468 = 84.89%** |
| 其中"本局别处能找到"（指针偏移） | 996 |
| 「唯一来源是卡」（改写被压平的极端） | 45 |

AGENTS §2.3：「**禁止从摘要再抽取**：抽取输入只能是原始事件/棋谱边……任何模型生成摘要一律不可作源」。
`claim.text` 是改写 ⇒ `support[].quote` 不是原文 ⇒ **P2 不可重算**。
这条和 F5 是**同一条红线的两个面**：F5 是"卡 → 抽取"，P2 是"改写 → 卡"。
当前 F5 = 0，但 **P2 已经破了 84.89%**。

---

## 6 · 最小改法（**未执行**，只给方案）

按"改一行、可回滚、不动契约"排序：

1. **`src/rooms/topic.mjs#collectRootUserTexts`**（唯一没有 source 判断的读取点）
   ```js
   // 现在
   .filter((e) => e && e.type === 'user/message')
   // 改成（与 R03 的 USER_SOURCE_KIND 同口径）
   .filter((e) => e && e.type === 'user/message' && (e.data?.source?.kind ?? 'user') === 'user')
   ```
   —— 现在靠"卡不在首位"侥幸（730/730），这条把它变成**机械保证**。

2. **`src/rooms/extract.mjs` 新增共享纯函数** `stripMemoryLedger(text)`（与 `scripts/self-contamination-audit.mjs#stripLedgerBlocks` 同实现：
   `<memory-ledger>` … `</memory-ledger>` 连标记一起剥，未闭合剥到末尾），在 `extractSignals` §2 约束段
   `const text = messageText(...)` 之后先 `stripMemoryLedger(text)` 再 `extractConstraints`。
   —— 把"卡不是用户原话"从"靠 source.kind"变成"**靠内容**"，双保险。

3. **`scripts/archive.mjs`**：在把 `events` 交给 `extractSignals` 之前统一 `events.map(e => stripLedgerFromEvent(e))`。
   —— 一处收口，未来新增消费者不用各自记得。

**不建议**在 `logread.mjs#parseEvents` / `episode.mjs#buildEpisode` 里剥：那是"忠实读取器"，
剥了之后"读到什么"就不能复算（R01 的契约就是"原文"）。过滤属于**消费者**，不属于读取器。

**风险**：改 1/2 会让"卡里的行"不再进 constraints —— 需先确认**没有 claim 靠这些行成立**：
本审计的 14 条受影响 claim 全是 `card-from-claim`（卡是下游），改完不受影响；§3 的 996 条"别处能找到"也不受影响（它们本来就是指针问题）。

---

## 7 · 复现

```bash
# 全量判定 + 5 条证据链（约 6 分钟，只读）
node scripts/self-contamination-audit.mjs --samples 5

# 只要数字
node scripts/self-contamination-audit.mjs --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).stats,null,1)))"

# 只要污染路径（事件类型分布）
node scripts/self-contamination-audit.mjs --scan-logs --limit 0

# 写证据文件（唯一写入口）
node scripts/self-contamination-audit.mjs --scan-logs --evidence evidence/T244-self-contamination.md
```

退出码：`0` 无自证污染；`1` 存在 `selfContaminated`；`2` 读库失败。
（本次全量跑为 `1`——因为 45 条 `card-from-claim` 也被计入 `selfContaminated`；**这是脚本口径的保守面**：
它只判"唯一来源是卡"，方向要读 `details[].direction` 才分得清 F5 与 P2。见 §2.6。）

**未解 / 待人工**：无技术卡点。唯一需要 Lead 拍板的是：§5 的 P2（84.89% 引文不是原文）要不要**单开一刀**修 —— 它比 F5 更急，且和 F5 同源。
