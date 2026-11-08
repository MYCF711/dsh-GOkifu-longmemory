# T11 · abstain 重启后误杀复测（只读证据）

> 日期：2026-11-08 · 数据源：`<DSH_HOME>/memory-context/live-stats.jsonl`（**快照 19295 行，末行 07:31:25**；活文件，`no-signal`/`inject` 会继续涨）+ 会话日志逐帧解 + 生产链路离线重放
> 结论：**abstain 重启后确实生效**，但**线上只拒了 5 次（3 张不同的卡）**，够不上任务书的「≥20 次」；把样本用生产链路扩到 **33 条真实拒绝**后逐条核，**误杀 17 条 / 可核 22 条 = 77.3%**。另外发现**四类 `reason` 退化成单一 `cross-scope`**（线上 5/5、重放 33/33），该分布**不可用于归因**。

| 口径 | 数字 |
|---|---|
| 线上真实 `abstain` | **5 次** / 3 张卡（全部 `cross-scope`） |
| 四类 reason 分布（线上） | `cross-scope` 5 · `stale` 0 · `low-confidence` 0 · `no-relevant-claim` 0 |
| 重放扩样（真实信号，冻结 07:13:00） | 79 个判定点 → **33 条会拒** |
| 误杀率（可核 22 条） | **77.3%（17/22）** —— 强误杀 5/22 = 22.7%，弱误杀 12/22 |
| 误杀率（含 11 条"非用户请求信号"在分母） | 51.5%（17/33） |
| 无害拒绝（信号本身不是用户请求） | 11/33 |
| 正确拒绝 | 5/22 |

---

## 一、数据与口径（先说清，否则数字不可比）

1. **线上口径**：`live-stats.jsonl` 里 `action === 'abstain'` 的行。这是"线上真发生过几次拒绝"的唯一账本。
2. **重放口径**：把团队子会话的**每条真实 user 消息**当信号，用**与生产同源的链路**判一次：
   `signalFromText → walkFromSignals → filterHitsByScope → buildMemoryCard → hasReliableHandle / hasRelevantClaim → classifyAbstainReason`。
   入库对象只读（`createStore` / `createWalkCache`），不写 sidecar、不改记忆库。
3. **冻结时点**：`at ≤ 1794093180000`（**2026-11-08 07:13:00**）。`live-stats.jsonl` 是活文件，不冻结数字会随会话漂移。
4. **判据同源已验证（逐字节复现）**：3 张被拒卡里 **2 张能逐字节复现**——重放算出的 `digestOf(scope, cardText)` 与线上心跳记录**完全相同**：

| 线上 digest | 重放 digest | 复现条件 | 次数 |
|---|---|---|---|
| `02b968122fb7d864` | 一致 | `indexLine` 的"1506 局"（重放时已是 1517 局，故只差这一处） | 3 |
| `76ee99a97804af0b` | 一致 | 同上（1506 局） | 1 |
| `891542a9a2313395` | **未复现** | 重放候选给 263 / 338 tokens，线上 302 | 1 |

   第 3 张未复现的原因：记忆库在 07:11 之后又被 autoArchive 刷新，`buildMemoryCard` 取的 claim 集合变了。⇒ 该条的核判**按"两种可能信号"分别给**（见 §三）。

5. **`inject` 的口径**：`oncePerSession` 命中后 `decidePreStep` 根本不再跑，也就不写心跳（`src/plugin.mjs` 的 `apply` 里 `if (config.oncePerSession && session && injected.has(session)) return decision;` 在 `decidePreStep` **之前**）。
   而 `abstain` **不进** `injected` 集合 ⇒ **abstain 会每步重复发生**，`inject` 只发生一次。
   ⇒ 线上"拒绝次数"与"注入次数"**不同分母**，不能直接相除算拒绝率。

---

## 二、`live-stats.jsonl` 读数（快照 07:31:25，共 19295 行）

| `action`/`reason` | 行数 |
|---|---|
| `skip`/`no-signal` | 17494 |
| `inject`/`null` | 1240 |
| `skip`/`no-hit` | 547 |
| `skip`/`gates-failed` | 9 |
| **`abstain`/`cross-scope`** | **5** |

**重启点与生效点**：
- 重启后新进程 `pid=25256` 首次心跳 **06:53:09**（前一轮 `pid=36100` 最后心跳 05:54:44）。
- `abstain` **首次出现在文件第 19012 行 / 07:09:53** —— 在这之前的 **19011 行心跳里 `abstain` = 0**。
  ⇒ 这是"重启后 abstain 真的走到了生产路径"的直接证据（不是配置里写着默认开而已）。
- 5 次全部落在 `pid=25256`，时间 07:09:53 / 07:09:54 / 07:09:55 / 07:11:20 / 07:11:41。

| # | 本地时间 | pid | scope | digest | tokens |
|---|---|---|---|---|---|
| 1 | 07:09:53 | 25256 | `w:d:/…/长期记忆系统` | `02b968122fb7d864` | 202 |
| 2 | 07:09:54 | 25256 | 同上 | `02b968122fb7d864` | 202 |
| 3 | 07:09:55 | 25256 | 同上 | `02b968122fb7d864` | 202 |
| 4 | 07:11:20 | 25256 | `w:d:/DeepSeek Harness/default-workspace` | `891542a9a2313395` | 302 |
| 5 | 07:11:41 | 25256 | `w:d:/…/DSH-GO` | `76ee99a97804af0b` | 144 |

> 注：第 1–3 次是**同一个卡、同一会话**（`live-analyst` 的首三步）——`abstain` 不消耗 `oncePerSession` 额度，所以每一步都拒一次。

---

## 三、线上 5 次拒绝 —— 逐条核（3 张卡）

| 卡 | 信号（会话日志原文，非 card-sample 截断版） | 卡上内容 | 判定 |
|---|---|---|---|
| **A** `02b968…`（×3，tokens 202） | `AgentTeams automatic task assignment … member "live-analyst" … Task: t3 [T11] … 只写 evidence/T11-abstain-live.md，不改代码` | ①`error: failed to push some refs to '…/dsh-GOkifu-longmemory.git' …/releases/tag/v0.2.41`<br>②`class:fs-read-before-write · cannot edit "…/长期记忆系统/evidence/T352-ablation-harness.md": file changed since it was…` | **误杀（弱）**：②与"要写 `evidence/*.md`"**同目录、同坑类**（写 evidence 文件前不重读会被拒写）；①与 T11 无关 |
| **B** `76ee99…`（×1，tokens 144） | `… member "evidence" … Task: t1 [T00] — 只写 tmp/GO2-TEAM/T00 … 记录 HEAD/status/hash … 产出 RESULT.md、baseline.json` | ①`class:fs-read-before-write · cannot edit "…/DSH-GO/docs/go1-lead-execution-task-table-2026-11-07.md": file changed…` | **误杀（弱）**：同 repo、同坑类（要写 `RESULT.md`/`baseline.json` 前会撞同一错误） |
| **C** `891542…`（×1，tokens 302，**未能逐字节复现**） | 两种可能：(a) `AgentTeams message from captain: 基线提醒：本项目无 test 脚本，pnpm test 空跑不算通过。测试门禁用 pnpm verify…`；(b) 宿主 `Time sampled while preparing turn 1, step 1…` | 重放 (a) 得 5 行（`rg: …/rollback-test` IO 错误、`rg: …/node_modules`、`bash: -c: line 1: syntax error near unexpected token '{'`）；重放 (b) 得 5 行（sandbox / old_string 2 times / screenshot / destroys runtime / web-search-empty） | (a) ⇒ **正确拒绝**（与"跑 pnpm verify"无可用联系）；(b) ⇒ **无害拒绝**（信号不是用户请求）。**两种情况都不算误杀** |

**线上口径的误杀率**：能逐字节复现的 **4 次全部判为误杀（弱）= 100%（4/4）**；含 C 则 **4/5 = 80%**。
> "弱"的定义见 §五：教训与当前任务**同坑类/同目录/同仓库**，模型看到有实际用处，但不是同一条错误的同一实例。

---

## 四、扩样：33 条真实拒绝（79 个判定点，冻结 07:13:00）

覆盖 **11 个团队子会话 / 3 个团队**（kifu 5 人、`default-workspace` 5 人、`DSH-GO` 1 人），口径见 §一。分类与判定：

| 信号来源（按信号首行前缀机械分类） | 判定点数 | 会拒 | 拒的构成 |
|---|---|---|---|
| `AgentTeams automatic task assignment`（任务分配原文） | 10 | 4 | 误杀弱 4（#1 / #8 / #11 / #30） |
| `<chess-ledger> ROOT USER (verbatim)`（压缩插件账本） | 11 | 11 | **强误杀 5**（#5 / #18 / #24 / #28 / #33）· 弱 2（#13 / #15）· 正确 4（#3 / #7 / #10 / #21） |
| `<system-reminder>`（插件 `AGENTS.md` 附加指令） | 27 | 5 | 误杀弱 5（#16 / #19 / #22 / #25 / #29） |
| 宿主 `Time sampled…` 提示 | 11 | 11 | **无害**（不是用户请求） |
| `AgentTeams message from captain`（协调消息） | 3 | 1 | 正确 1（#26） |
| `Current runtime context` | 11 | 1 | 误杀弱 1（#31） |
| 其它（`MEMORY: …index.md` —— 上轮注入卡回流成信号，自指） | 6 | 0 | — |
| **合计** | **79** | **33** | 强 5 · 弱 12 · 正确 5 · 无害 11 |

**逐条（33 条，编号即重放序号）**：

| # | 团队/成员#seq | 信号摘要 | 卡上内容（节选） | 判定 |
|---|---|---|---|---|
| 1 | kifu/live-analyst#10 | T11 任务：写 `evidence/T11-abstain-live.md` | push failed；`fs-read-before-write`@`evidence/T352-…md` | 误杀弱 |
| 2 | kifu/(host-note)#14 | 宿主时间提示 | destroys-runtime；policy-human-turn；web-search-empty | 无害 |
| 3 | kifu/live-analyst#28 | 账本：claim task and read requirements | `MISS "const DANGER = /(…taskkill…)/"` | 正确 |
| 4 | kifu/(host-note)#15 | 宿主时间提示 | 同 #2 | 无害 |
| 5 | kifu/release-dev#29 | 账本：release 任务（T14） | `failed to push some refs …/releases/tag/v0.2.41` | **误杀强** |
| 6 | kifu/(host-note)#15 | 宿主时间提示 | 同 #2 | 无害 |
| 7 | kifu/ablation-runner#30 | 账本：ablation 任务 | `MISS "const DANGER…"` | 正确 |
| 8 | kifu/plugin-dev#10 | T10 任务：改 `src/plugin.mjs` + `test/plugin.test.mjs` | push failed；`fs-read-before-write`@`evidence/T352-…md` | 误杀弱 |
| 9 | kifu/(host-note)#14 | 宿主时间提示 | 同 #2 | 无害 |
| 10 | kifu/plugin-dev#25 | 账本：claim task first | `371:test('N1: promoteClaim 输出 validFrom…`（代码行片段） | 正确 |
| 11 | kifu/label-reviewer#10 | T13 任务：写 `evidence/T13-label-review.md` | 同 #1 | 误杀弱 |
| 12 | kifu/(host-note)#14 | 宿主时间提示 | 同 #2 | 无害 |
| 13 | kifu/label-reviewer#24 | 账本：claim then read T13 | `fs-read-before-write · cannot write "…/scripts/re-enable.mjs": file no longer exists` | 误杀弱 |
| 14 | ws/(host-note)#16 | 宿主时间提示 | sandbox 不可用；`old_string matched 2 times`；screenshot；destroys-runtime；web-search-empty | 无害 |
| 15 | ws/config#30 | 账本：claim 后看三个目标文件 | pkcs7 ImportError；DSH is still running；No web contents；`fs-read-before-write`@`_inbox/…/REPORT.md` | 误杀弱 |
| 16 | ws/(system-reminder)#53 | 插件 `dsh-agent-teams-preset/AGENTS.md` 指令 | `FileNotFoundError cordis.patch.yml.bak-…`；`cannot read "…/ptc-domain-presets/AGENTS.md": not found`；同 fact | 误杀弱 |
| 17 | ws/(host-note)#16 | 宿主时间提示 | 同 #14 | 无害 |
| 18 | ws/model-defaults#26 | 账本：AgentTeams 任务分配 | `invalid arguments: missing required property "plan.members"; … "plan.tasks"`；sparse-checkout；pkcs7；destroys-runtime | **误杀强** |
| 19 | ws/(system-reminder)#49 | 同 #16 | 同 #16 | 误杀弱 |
| 20 | ws/(host-note)#15 | 宿主时间提示 | 同 #14 | 无害 |
| 21 | ws/账本#25 | 账本：captain 基线提醒（`pnpm verify` 门禁） | `rg: …/rollback-test` IO；`rg: …/node_modules` IO；`bash: -c: line 1: syntax error near unexpected token '{'` | 正确 |
| 22 | ws/(system-reminder)#52 | 同 #16 | 同 #16 | 误杀弱 |
| 23 | ws/(host-note)#16 | 宿主时间提示 | 同 #14 | 无害 |
| 24 | ws/implementer#27 | 账本：AgentTeams 任务分配 | 同 #18 | **误杀强** |
| 25 | ws/(system-reminder)#60 | 同 #16 | 同 #16 | 误杀弱 |
| 26 | ws/captain→t2#121 | captain：`0.2.1-rc.2 startActivation 接受 agentPreset；改 spawnMember(src/members.ts:1039-1059)` | `rg: …/node_modules` IO；`rg: …/plugin-inventory-v2.md` IO | 正确 |
| 27 | ws/(host-note)#16 | 宿主时间提示 | 同 #14 | 无害 |
| 28 | ws/baseline#27 | 账本：AgentTeams 任务分配 | 同 #18 | **误杀强** |
| 29 | ws/(system-reminder)#50 | 同 #16 | 同 #16 | 误杀弱 |
| 30 | go/evidence#10 | T00 任务：只写 `tmp/GO2-TEAM/T00`，产出 `RESULT.md`/`baseline.json` | `fs-read-before-write · cannot edit "…/DSH-GO/docs/go1-lead-execution-task-table-2026-11-07.md"` | 误杀弱 |
| 31 | go/runtime-ctx#12 | `Current runtime context`（cwd=DSH-GO，danger-full-access） | `rg: DSH-GO/tmp/real-chain-…/state/jobs` IO；`fs-read-before-write · cannot edit "…/dsh-ui/internal/apiclient/approval.go"` | 误杀弱 |
| 32 | go/(host-note)#14 | 宿主时间提示 | `writing under …csc.exe would destroy the running runtime`；destroys-runtime；web-search-empty | 无害 |
| 33 | go/evidence#29 | 账本：claim then check repo state | `fatal: Could not read from remote repository`；`fs-read-before-write · cannot modify "…/dsgoal/goal.go"` | **误杀强** |

---

## 五、误杀率（三种分母，逐个给）

判据（先定死，再算数）：

- **误杀**：卡上至少一行，其**坑类**或**对象**与信号所谈的事直接对应，模型看到会有用。
  - **强**：同一工具族 / 同一动作（AgentTeams 的 plan 契约、release 的 push/tag、git 远端读写）。
  - **弱**：同坑类、同目录、同仓库，但**不是同一条错误的同一实例**（典型：`fs-read-before-write` 换了文件名）。
- **正确拒绝**：卡上内容与信号谈的对象/工具/文件/错误**没有可用联系**。
- **无害拒绝**（单列，**不计入误杀分母**）：信号本身不是用户请求（宿主 `Time sampled…` 提示、`stale chess-ledger elided` 占位）——拒与不拒对用户等价。

| 分母 | 计算 | 结果 |
|---|---|---|
| **可核拒绝**（去掉 11 条无害） | 17 / 22 | **77.3%** |
| 全部重放拒绝 | 17 / 33 | 51.5% |
| 强误杀（可核） | 5 / 22 | 22.7% |
| 线上可逐字节复现的 4 次 | 4 / 4 | 100%（全部为"弱"） |

> 与 `evidence/T366e-abstain-zero-misfire.md`（"误杀率 = 0"）**不矛盾但不可互推**：T366e 的分母是**考卷 n=118 中判据可靠的 59 题**（离线构造的相关/不相关对）；本报告的分母是**真实 AgentTeams 团队会话的首步信号**。考卷里"中文任务 vs 英文报错"这一族已被跨语言映射救回，但**"同坑类不同实例"与"同工具族"这两族在考卷里没有对应题型**，于是线上照样误杀。

---

## 六、缺陷：四类 `reason` 退化成单一 `cross-scope`（T12 必须先知道这条）

`src/plugin.mjs` 的 `classifyAbstainReason` 用三个量判 `cross-scope`：

```js
const cross = walkResult.crossScope + walkResult.unknownScope + walkResult.crossScopeWalk;
if (cross > 0) return 'cross-scope';
```

其中 `crossScopeWalk` 来自 `walk.mjs` 的 `dropped.crossScope + dropped.scopeMissing` —— 它是**整库遍历中**因作用域被挡掉的命中总数，**不是"本次拒绝是否因跨域而起"**。

实测：33 条被拒里 `crossScope`（`filterHitsByScope` 丢的）= **0**、`unknownScope` = **0**，而 `crossScopeWalk` 在 **200–1000** 之间（库 1506 局、本 scope 只占少数）。⇒ `cross > 0` 恒真。

后果与验证：

| 口径 | `cross-scope` | `stale` | `low-confidence` | `no-relevant-claim` |
|---|---|---|---|---|
| 线上 5 次 | **5** | 0 | 0 | 0 |
| 重放 33 次（现行判据） | **33** | 0 | 0 | 0 |
| 重放 33 次（把 `crossScopeWalk` 当 0，只留真正的跨域丢弃） | 0 | 0 | **6** | **27** |

⇒ **"四类 reason 分布"当前不可用于归因**：它把所有拒绝都写成"库里有、只是不属于本项目"，而真实原因大多是"卡上有行但与信号不相关"。

**附带发现（可核的第二个缺陷）**：`stale` 这条判据**是死码**。
`classifyAbstainReason` 判 `stale` 用 `Number(c?.decay ?? 1) < 0.5`，但 `buildMemoryCard` 给出的 `card.claims` 元素**没有 `decay` 字段**
（`src/rooms/inject.mjs` 里 claims 的投影只有 `kind/marker/state/occurredAt/date/source/line/claimId/delivery`；`decay` 只存在于内部 `buildEntry` 的 entry 上）。
⇒ 恒取缺省 1 ⇒ 恒不 < 0.5 ⇒ **`stale` 永远不会被返回**。
实测 33 条被拒卡的 95 行 claim，`decay` 字段**全部缺失（null）**。
⇒ 四类里实际只有三类可能被返回，而 `cross-scope` 又抢先，最终线上只剩一类。

---

## 七、给 T12 的误杀清单（按坑类分桶，供你定"改 abstain 还是改 walk"）

| 桶 | 条数 | 强度 | 内容 | 为什么现有判据必然漏 |
|---|---|---|---|---|
| **A. AgentTeams 工具契约** | 3（#18/#24/#28） | **强** | `invalid arguments: missing required property "plan.members"/"plan.tasks"` | 信号是 AgentTeams 任务分配、claim 是 AgentTeams `workflow` 的 plan 契约；**共享英文判别词 < 2、无共享硬实体、无共享中文 bigram** ⇒ 判"不相关" |
| **B. release / git 远端** | 2（#5、#33 首行） | **强** | `failed to push some refs …/releases/tag/v0.2.41`、`fatal: Could not read from remote repository` | release-dev 的活儿**就是 release**；claim 里 `github.com/…/releases/tag/…` 与信号无字面重合 ⇒ 判"不相关" |
| **C. 写文件前先读（`fs-read-before-write`）** | 7（#1/#8/#11/#13/#15/#30/#31） | 弱 | 全是 `cannot edit/write/modify "<别的文件>": file changed / not read` | 相关面是**坑类**不是**文件**；判据只认"同一硬实体（完整路径）" |
| **D. 插件目录 AGENTS.md / 备份路径不存在** | 5（#16/#19/#22/#25/#29） | 弱 | `cannot read "…/ptc-domain-presets/AGENTS.md": not found`、`FileNotFoundError cordis.patch.yml.bak-…` | 信号正是"按 `dsh-agent-teams-preset/AGENTS.md` 的指令干活"；两边的 `AGENTS.md` 是**不同插件目录**，判据不认"同尾名 + 同目录形状" |

对应的**正确拒绝 5 条**（#3/#7/#10/#21/#26）也一并列给 T12 作负样本：`MISS "const DANGER…"` 正则教训 vs "claim task"；代码行片段 vs "claim task"；`rg …node_modules` IO 错误 vs captain 的 `pnpm verify` 门禁。这三类**确实不该给**——说明 abstain 不是全错，需要的是**收窄到"字面可判"的拒绝**，而不是关掉。

**统一观察**（一句话给 T12）：线上拒绝里，**相关性发生在"坑类/工具族"层面，判据只看"字面"**。A、B 两桶连字面都没有，C、D 两桶字面差一个文件名/目录名。

---

## 八、限制（不许当结论用）

1. **重放 ≠ 线上**：线上按 step 判、且 `oncePerSession` 命中后不再判；重放按"每条 user 消息"判。两者分母不同，**33 条不是"线上会拒 33 次"**。
2. **第 3 张卡未能逐字节复现**（§一.4），它的判定按两种候选信号分别给，两条都不算误杀。
3. 本报告的"误杀/正确"是**单人判**（live-analyst），未做双人复核；判据已写死在 §五，可被复核推翻。
4. 11 条 `(host-note)`：判据 `hasReliableHandle` 把宿主英文元信息当成"可靠输入"（`time/sampled/browser/zone/…` ≥2 英文 token）。结果无害，但**口径上不该让宿主提示进入 abstain 判定面**——这是给后续任务的观察，本刀不改代码。
5. `signalPreview` 的 160 字符截断（T10 未修）**不影响本报告**：本报告的信号取自会话日志原文（逐帧 zstd 解），不用 `card-samples.jsonl`。

---

## 九、复现

```bash
# 0) 只读脚本（都在 tmp/，不入 git）
node tmp/t11-sweep.mjs tmp/t11-sessions.json 1794093180000   # 79 判定点 → 33 拒，产出 tmp/t11-sweep.json
node tmp/t11-detail.mjs "<会话>.zstd" 10                      # 单会话单条 user 消息的卡全文 + 判定
node tmp/t11-find-digest.mjs '[{"digest":"02b968122fb7d864"}]' "<会话>.zstd"   # 反查哪条信号复现该 digest

# 1) digest 逐字节复现（把 indexLine 的局数换回 1506）
node -e "…sha256(scope+'\\u0000'+indexLine+'\\n'+section).slice(0,16)"   # 见 §一.4 表
```

**关键数（复核请对这三个数）**：
- 线上 `abstain` = **5**，四类分布 `5/0/0/0`；
- 重放冻结口径 **79 判定点 / 33 拒**；
- 逐条核 **误杀 17 / 可核 22 = 77.3%**（强 5、弱 12；正确 5；无害 11）。

---

## 十、一句话

**abstain 重启后是真生效了，但它拒的东西和"该不该给"几乎没关系**——线上 4/4 可复核的拒绝都是误杀（弱），重放 77.3% 误杀；同时四类 `reason` 全部塌成 `cross-scope`，**归因层面的信息量为零**。T12 若要提 A2b 严格率，改点应该落在"相关性判据认不认坑类/工具族"上，而不是"要不要开 abstain"。