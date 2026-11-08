# T12 · abstain 误杀修复 + 两个结构性 bug（precision 前后对照）

> 日期：2026-11-08 · 输入：`evidence/T11-abstain-live.md` 的**79 判定点重放集**（11 个团队子会话 / 3 个团队，冻结 `at ≤ 1794093180000`）+ 生产链路离线重放 + `tmp` 冻结快照
> **结论**：重放集上 **误杀 17 / 可核 22（77.3%）→ 0 / 5（0.0%）**；17 条误杀**全部救回**，**5 条正确拒绝（#3/#7/#10/#21/#26）一条没丢**；11 条"无害拒绝"按 T11 口径原样保留（不计入误杀分母，见 §六）。两个结构性 bug 各有 tombstone：`cross-scope` 不再恒真（33/33 → 0），`stale` 从死码变活。

| 口径 | 改动前 | 改动后 |
|---|---|---|
| 重放判定点 | 79 | 79（同一份信号/卡片，逐字节零漂移） |
| 会拒绝 | **33** | **16** |
| 误杀（可核） | **17 / 22 = 77.3%**（强 5 · 弱 12） | **0 / 5 = 0.0%** |
| 正确拒绝（负样本） | 5 / 22 | **5 / 5 全保留** |
| 无害拒绝（不计分母） | 11 / 33 | 11 / 16（口径不变） |
| `reason` 分布 | `cross-scope` 33 · 其余 0 | `no-relevant-claim` 11 · `low-confidence` 5 · `cross-scope` 0 · `stale` 0 |
| 被救回卡片的注入成本 | — | 平均 **184 tokens** / 卡（合计 3135，单卡 144–204） |

---

## 一、口径与数据（先说清，否则数字不可比）

1. **重放链路与生产同源**：`signalFromText → walkFromSignals → filterHitsByScope → buildMemoryCard → hasReliableHandle / hasRelevantClaim → classifyAbstainReason`。
   入库对象只读（`createStore` / `createWalkCache`），不写 sidecar、不改记忆库。
2. **冻结时点**：`at ≤ 1794093180000`（2026-11-08 07:13:00）。会话日志是已完成会话的 `session.v4.jsonl.zstd`（逐帧解），文件不再增长。
3. **前后对照用同一份数据**：改动**前**先把 79 判定点重放成**全量快照**（完整信号原文 + 完整卡行 + 命中计数 + 卡文本），再在快照上重算新判据；改动后**又跑了一次生产链路**复核。两次运行的输入漂移：
   - 信号原文不同 **0 / 79**；claim 投影（除新增 `decay` 字段）不同 **0 / 79**；卡文本 `section` 不同 **0 / 79**。
   ⇒ 前后差异只可能来自判据，不来自记忆库刷新。
4. **33 条的判定标签沿用 T11 §五**（强 5 / 弱 12 / 正确 5 / 无害 11，按重放序号一一对应），本轮**未重判**；判据见 T11 §五（可被复核推翻）。
5. **判定点 ≠ 线上拒绝次数**：线上 `abstain` 按 step 判，`inject` 命中 `oncePerSession` 后不再判；33 不是"线上会拒 33 次"（T11 §八.1）。

---

## 二、改了什么（3 个源码文件 + 1 个测试文件）

| 文件 | 改动 | 作用 |
|---|---|---|
| `src/rooms/abstain.mjs` | 新增 `fileBasenames` / `hasPitClassBridge`（同名文件 / 工具族 / 坑类三条桥），在 `hasRelevantClaim` 的字面判据**之后**兜底 | 把"同坑类 / 同工具族"纳入相关（只增加相关，只减少拒绝） |
| `src/plugin.mjs` | `classifyAbstainReason`：`cross-scope` 只看**本次** `crossScope + unknownScope` 且 `hits` 为空；**不再读** `crossScopeWalk` | 修 bug ①（33/33 塌成 cross-scope） |
| `src/rooms/inject.mjs` | `buildMemoryCard` 的 `card.claims` 投影补 `decay` | 修 bug ②（`stale` 死码） |
| `test/abstain.test.mjs` | +8 条：4 条桥 + 1 条 `fileBasenames` 单元 + 1 条 5 负样本守卫 + 2 条结构 bug tombstone | tombstone（删掉对应修法即红，已实测） |

`test/plugin.test.mjs` **未改**（T10 正在改该文件，避免同文件双写）；`cardSampleSignal` 未碰；版本/台账/CHANGELOG 未碰。

---

## 三、三条桥（机制与归属）

T11 的统一观察是「**相关性发生在坑类 / 工具族层面，判据只看字面**」。三条桥都只做**可复算的字面结构**，不做语义评分（AGENTS §2.3）：

| 桥 | 判据（机械） | 覆盖的 T11 桶 | 救回 |
|---|---|---|---|
| ① **同名文件** | 信号与 claim 共享**同一个文件名**（basename；忽略目录） | D 插件 AGENTS 路径不存在（弱） | 5（#16/#19/#22/#25/#29） |
| ② **工具族** | 信号落在某工具族的**域**内（宽）+ claim 是该族**具体报错实例**（窄） | A AgentTeams 工具契约（强）· B release / git 远端（强） | 5（#18/#24/#28 · #5/#33） |
| ③ **坑类** | claim 带 `class:fs-read-before-write` + 信号是**文件工作类请求**（写/改/产出/任务…） | C 写文件前先读（弱） | 7（#1/#8/#11/#13/#15/#30/#31） |

**宽窄不对称是故意的**：② 的 claim 侧只认报错签名（`failed to push some refs` / `could not read from remote repository` / `plan.members` / `plan.tasks` …），**不认裸关键词**。
T11 的 5 条正确拒绝里，**#3/#7 的 claim 恰好含 `release` 字样**（`gh\s+(pr|release|api)` 这条正则）——如果 claim 侧认裸词，它们会被误救；实测没被救（见 §五）。

逐条命中的桥（重算，17/17 全部落在设计桶内）：

| # | T11 桶 | 命中的桥 |
|---|---|---|
| 5 | B | 工具族 release/git-remote |
| 18 / 24 / 28 | A | 工具族 AgentTeams |
| 1 / 8 / 11 | C | 坑类（另：其信号含 team goal 的"release 幂等"，工具族也命中） |
| 13 / 15 / 30 / 31 | C | 坑类 |
| 16 / 19 / 22 / 25 / 29 | D | 同名文件 `agents.md` |
| 33 | B | 工具族 release/git-remote + 坑类 |

---

## 四、前后对照（33 条逐条）

| # | T11 判定 | 信号（team/member#seq） | 桶 | 改动前 | 改动后 |
|---|---|---|---|---|---|
| 1 | 弱 | live-analyst#10 | C | 拒（cross-scope） | 给 |
| 2 | 无害 | (host-note)#14 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 3 | 正确 | live-analyst#28 | 负样本 | 拒（cross-scope） | **拒**（low-confidence） |
| 4 | 无害 | (host-note)#15 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 5 | 强 | release-dev#29 | B | 拒（cross-scope） | 给 |
| 6 | 无害 | (host-note)#15 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 7 | 正确 | (other)#30 | 负样本 | 拒（cross-scope） | **拒**（low-confidence） |
| 8 | 弱 | plugin-dev#10 | C | 拒（cross-scope） | 给 |
| 9 | 无害 | (host-note)#14 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 10 | 正确 | plugin-dev#25 | 负样本 | 拒（cross-scope） | **拒**（low-confidence） |
| 11 | 弱 | label-reviewer#10 | C | 拒（cross-scope） | 给 |
| 12 | 无害 | (host-note)#14 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 13 | 弱 | label-reviewer#24 | C | 拒（cross-scope） | 给 |
| 14 | 无害 | (host-note)#16 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 15 | 弱 | config#30 | C | 拒（cross-scope） | 给 |
| 16 | 弱 | (system-reminder)#53 | D | 拒（cross-scope） | 给 |
| 17 | 无害 | (host-note)#16 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 18 | 强 | model-defaults#26 | A | 拒（cross-scope） | 给 |
| 19 | 弱 | (system-reminder)#49 | D | 拒（cross-scope） | 给 |
| 20 | 无害 | (host-note)#15 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 21 | 正确 | (other)#25 | 负样本 | 拒（cross-scope） | **拒**（low-confidence） |
| 22 | 弱 | (system-reminder)#52 | D | 拒（cross-scope） | 给 |
| 23 | 无害 | (host-note)#16 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 24 | 强 | implementer#27 | A | 拒（cross-scope） | 给 |
| 25 | 弱 | (system-reminder)#60 | D | 拒（cross-scope） | 给 |
| 26 | 正确 | captain->t2,#121 | 负样本 | 拒（cross-scope） | **拒**（low-confidence） |
| 27 | 无害 | (host-note)#16 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 28 | 强 | baseline#27 | A | 拒（cross-scope） | 给 |
| 29 | 弱 | (system-reminder)#50 | D | 拒（cross-scope） | 给 |
| 30 | 弱 | evidence#10 | C | 拒（cross-scope） | 给 |
| 31 | 弱 | (other)#12 | C | 拒（cross-scope） | 给 |
| 32 | 无害 | (host-note)#14 | — | 拒（cross-scope） | **拒**（no-relevant-claim） |
| 33 | 强 | evidence#29 | B | 拒（cross-scope） | 给 |

> 改动后仍是 `low-confidence` 的 5 条**正是负样本**：它们的卡上每行都是单局 `[observed]`。`reason` 的优先级（cross-scope → stale → low-confidence → 兜底）是 T4 定的，本刀只修"cross 恒真"，不改优先级。

---

## 五、负样本 5 条（正确拒绝，一条不许丢）

| # | 信号 | 卡上内容 | 为什么三条桥都救不到它 |
|---|---|---|---|
| 3 | 账本：claim task and read requirements | `MISS "const DANGER = /(…gh\s+(pr|release|api)…/` 正则教训 | claim 侧无 `plan.members/plan.tasks`、无 release/git 报错签名（只有 `release` 裸词，**不认**）；无同名文件；无 `class:` 坑类标记 |
| 7 | 账本：ablation 任务 | 同上 | 同上 |
| 10 | 账本：claim task first | `371:test('N1: promoteClaim 输出 validFrom…`（代码行片段） | 无工具族签名、无文件名、无坑类标记 |
| 21 | 账本：captain 的 `pnpm verify` 门禁 | `rg: …/rollback-test` IO · `rg: …/node_modules` IO · `bash: -c: line 1: syntax error…{.lnk}` | claim 侧是 `rg` 的 IO 错误（不是 `failed to push`/`plan.*`）；文件名 `.lnk` 与信号无交集 |
| 26 | captain：改 `spawnMember(src/members.ts)` 加 `agentPreset` | `rg: …/node_modules` IO · `rg: …/plugin-inventory-v2.md` IO | 文件名 `plugin-inventory-v2.md` 与信号里的 `index.js/members.ts/harness-compat.ts` 无交集 |

**这 5 条也是新测试的守卫**：`test/abstain.test.mjs` 的 `T12 负样本 5 条…` 用的是**线上原文**（信号 + claim 全文），删掉任一条断言或放宽 claim 侧，它就红。

---

## 六、无害拒绝与成本（不改口径，只说清）

1. **11 条 `(host-note)` 仍被拒**：信号是宿主元信息（`Time sampled while preparing…`），不是用户请求，拒与不拒对用户等价 —— 按 T11 §五**不计入误杀分母**。T11 §八.4 提出「宿主提示不该进 abstain 判定面」是本刀**之外的**口径问题（会改成"不拒 ⇒ 注入"，那是另一个方向），**本轮不改**，留给后续。
2. **成本透明**：被救回的 17 张卡未来会**注入**而不是被拒，平均 **184 tokens/卡**（合计 3135，单卡 144–204）。这是本刀唯一的成本项；相对 T6 的 1084 卡规模，单次 ≤204 tokens。
3. **abstain 是默认开的线上行为**：本刀只**减少**拒绝（= 增加注入），方向与任务约束「拿不准的输入不拒，宁可放过不可误杀」一致；没有任何新增的拒绝条件。

---

## 七、两个结构性 bug（各有 tombstone）

### ① `cross-scope` 恒真（33/33）

- 旧判据：`cross = crossScope + unknownScope + crossScopeWalk`，其中 `crossScopeWalk` 来自 `walk.mjs` 的 `dropped.crossScope + dropped.scopeMissing` —— 是**整库遍历**里被作用域挡掉的命中**总数**（本批实测 200–1000，如 #1 = 649），**不是**"本次拒绝是否因跨域而起"。
- 实测：33 条被拒里 `crossScope`（`filterHitsByScope` 丢的）= 0、`unknownScope` = 0，`crossScopeWalk` 200–1000 ⇒ `cross > 0` 恒真 ⇒ 33/33 全塌成 `cross-scope`。
- 修法：只认**本次**的 `crossScope + unknownScope > 0`，**且**要求 `walkResult.hits` 为空（卡里一条都没活下来 —— 卡上已经有行，"库里有、只是不属于本项目"就不成立）。调用方没给 `hits`（离线脚本 / 老单测）时保持旧语义，避免调用面悄悄变成"永不返回 cross-scope"。
- 实测：本批 `cross-scope` 33 → **0**，`reason` 分布变成 `no-relevant-claim` 11 · `low-confidence` 5（这才和"卡上有行但与信号不相关"的真实原因对得上）。
- tombstone：`T12 tombstone ①`（回退该修法 ⇒ 红，已实测）。

### ② `stale` 死码

- 旧判据：`claims.every((c) => Number(c?.decay ?? 1) < 0.5)`，但 `buildMemoryCard` 的 `card.claims` 投影**不含 `decay`**（只投影 `kind/marker/state/occurredAt/date/source/line/claimId/delivery`）⇒ 恒取缺省 1 ⇒ 永不 < 0.5。T11 实测 33 条被拒卡的 95 行 claim，`decay` **全部缺失**。
- 修法：`src/rooms/inject.mjs` 的 claims 投影补 `decay: Number.isFinite(e.decay) ? e.decay : 1`（值来自 entry 上已有的 `decayWeight`，不改渲染、不改排序）。
- 实测：本批 79 判定点的卡片 `decay` 范围 **0.8625–1.0**（库 `occurredAt` 全在 7 天内，与 T6 的"冷却 0%"同因）⇒ 本批 `stale` **本来就不该触发**（不是"没生效"）。用 **130 天**旧 claim 的夹具证明：投影带 `decay` 后 `classifyAbstainReason` 能返回 `stale`（0.0497 < 0.5）。
- tombstone：`T12 tombstone ②`（删掉投影里的 `decay` ⇒ 红，已实测）。

---

## 八、限制（不许当结论用）

1. **重放 ≠ 线上**（T11 §八.1）：线上按 step 判、且 `oncePerSession` 命中后不再判；本报告只到"重放集"。
2. **本轮改动尚未进入线上**：abstain 回归 live-stats 需要宿主重启（本刀不动宿主）。线上复测面 = `live-stats.jsonl` 的 `action/reason` 分布 + 逐条核（T11 §一的口径可直接复用）。
3. **误杀/正确判定沿用 T11 单人判定**，未双人复核。
4. **三条桥是手工词表 / 正则**：机械可复算，但不是学习出来的。
   - `fs-read-before-write` 的适用面（`WORK_INTENT`）故意宽 ⇒ 任何"文件工作类请求"都会带上这条坑类教训（多给、不误杀，但它确实降低 abstain 的收缩率）；
   - `release-git-remote` 的信号侧宽（出现 git/release/repo 即算域内）、claim 侧窄（只认具体报错签名）——#3/#7 就是靠这个窄边没被误救；
   - 新词表来自 T11 的 33 条真实拒绝，**不是**从全库语料归纳的；扩面需要新的误杀样本，不要凭想象加词。
5. **A2b 严格率不受本刀影响**：全仓只有 `src/plugin.mjs` 的 abstain 分支调用 `hasRelevantClaim`；A2b 的分子/分母是离线考卷上"卡里 render 了哪些 claim"的精度，与"该给时是否被拒"不同量纲。让 A2b 严格率上升要改 walk / link（任务书 T12 原口径），不在本刀范围。

---

## 九、复现

脚本都在 `tmp/`（临时产物，不入 git），与 T11 的 `t11-*.mjs` 同一套读法：

```bash
# 0) 改动前后各重放一次（79 判定点，冻结 07:13:00；只读记忆库）
node tmp/t12-dump.mjs tmp/t11-sessions.json 1794093180000 "D:/DeepSeek Harness/home/memory-context" tmp/t12-cases-before.json
node tmp/t12-dump.mjs tmp/t11-sessions.json 1794093180000 "D:/DeepSeek Harness/home/memory-context" tmp/t12-cases-after.json

# 1) 在冻结快照上重算新判据（离线，不碰记忆库）—— 与生产链路重放的结论必须一致
node tmp/t12-eval.mjs tmp/t12-cases-before.json

# 2) 逐条对照 + 负样本守卫
node --test test/abstain.test.mjs
```

**关键数（复核请对这三个数）**：
- 33 条真实拒绝 → 改动后 **16** 条（11 无害 + 5 正确），17 条误杀全部救回；
- 误杀率 **17/22 = 77.3% → 0/5 = 0.0%**；正确拒绝 **5/5 保留**；
- `reason` 分布 **`cross-scope` 33 → 0**；`stale` 由死码变活（本批 0 次，夹具可复现）。

## 十、一句话

**abstain 不该学"字面像不像"，该学"是不是同一类坑 / 同一族工具"** —— 补上三条**只增相关、不增拒绝**的桥之后，T11 的 77.3% 误杀在本轮重放集上清零，而 5 条"确实该拒"的一条没动；两个让归因信息量为零的结构 bug 也各自钉上了 tombstone。