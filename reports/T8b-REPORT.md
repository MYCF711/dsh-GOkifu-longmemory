# T8b 报告 —— R10 adjudicate + R13 七闸补齐（M4 闸门全开）

> 任务板 `task-9` · 负责人 card-smith · `[本] 2026-11-02 03:5x`（工作树未提交）
> 契约：`方案.md` §5.1/§5.1b/§5.2/§5.3/§5.4/§6.3、`docs/数据契约.md` §4.7/§4.8、`docs/记忆的职责边界.md` §2/§5、`AGENTS.md` §11 R10/R13
> 基线：0.4.0（`103edea`），本次在 M3 之上补齐 M4 的两块：**裁决房间**与**闸门全开**。

## 0 · 一句话

**做到了**：R10 把"多成员独立解析"做成纯机械聚合（一致度 = 多数 ÷ 有效票，共享 contextId 的票只算一票，记录可回放、篡改一票就露 diff）；R13 从 4 道闸扩到 **10 道闸 + 边界审计**，并在本机真实语料（125 claim）上**零误伤**；同时用真跑发现一条真问题：**R11 walk 不按作用域过滤，52/93 行来自另一个工作区** —— 闸 1 一开就抓到 18/20 张卡。

## 1 · 交付物

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/rooms/adjudicate.mjs` | 新增（403 行） | R10：`adjudicate` / `aggregateVotes` / `replayAdjudication` / `validateAdjudication` / `independenceCheck` / `normalizeEvidence` / `contextKeyOf` + 常量 |
| `src/rooms/gates.mjs` | 改写（843 行） | R13：闸 0/6/6b/边界**原样保留**，新增 1/2/2b/3/4/5/7；`ACTIVE_GATES` 十道全开、`PENDING_GATES` 清空 |
| `test/adjudicate.test.mjs` | 新增（23 条） | 票型/一致度/非独立票被拒/可回放/L4/脏票/纯函数 |
| `test/gates.test.mjs` | 增补（26 → 44 条） | 七闸正负例 + "十道同时喂满"全绿用例 |
| `package.json` | 追加 1 行 | `exports["./adjudicate"]`（与其它房间一致） |
| `scripts/check.mjs` | 追加 1 项 | 房间清单加 `adjudicate.mjs`（`--strict-rooms` 才有意义） |
| `reports/T8b-REPORT.md` | 新增 | 本文件 |

**未动**：`src/rooms/inject.mjs`（R12）、`src/rooms/walk.mjs`（R11）、`src/rooms/cli.mjs`（R14）、任何 `<DSH_HOME>` 路径、任何 git 操作。gates 只**新增** `episode.mjs`（复用 `normalizeWorkspace`）与 `adjudicate.mjs`（闸 2b 复用独立性判据）两个 import。

## 2 · R10 adjudicate（`adjudicate({target, votes, threshold})`）

### 机械聚合

| 概念 | 定义 | 实现 |
|---|---|---|
| 有效票 | 成员非空 + verdict 合法 + 未重复 + 独立 + 主张类票带证据 | `aggregateVotes` |
| `agreement` | **多数票 ÷ 有效票**（`max(support,oppose) / valid`，3 位小数） | 平票 0.5、全 insufficient 0 |
| `promote` | 多数=支持 **且** `agreement ≥ threshold` **且** 支持 > 反对 | |
| `invalidate` | 多数=反对 **且** 过阈值 | 反例优先（§5.2） |
| `hold-disputed` | 平票 / 全 insufficient / 低于阈值 / 没有有效票 | 不找"裁判模型"拍板（§5.4 第 3 条） |
| `dissent` | promote 收反对票；invalidate 收支持票；disputed **两边都列** | "沉默即断言" |
| `correct`（L4） | 有 `human:true` 的票 ⇒ 一致度记 1、决策 correct、原有支持票转异见 | 人纠错=最高优先级证据 |

### 闸 2b 的机械判据（"独立"）

```
contextKey = contextId ?? sessionId ?? member
同一个 contextKey 的第二张票 ⇒ 排除（excludedReason: vote/shared-context）
```
排除不静默：`excluded[]` 留全字段 + `errors[]` 记 `vote/shared-context`（severity=`excluded`）。

### 可回放

- `id = "ad-" + hash8(target + level + Σ(member:verdict:contextKey))` —— 同输入同 id；票序无关。
- `replayAdjudication(record)` 从留档的 `votes ∪ excluded`（按 `originalIndex` 重排）重算，逐字段比对 `id/decision/agreement/n/target/level/counts`。
- 篡改一票 ⇒ `diffs` 有内容（测试里把一张反对票改成支持票、把 decision 改掉，两种情况都抓到）。

## 3 · R13 十道闸

| 闸 | 判据（机械） | 失败码 |
|---|---|---|
| **0 时间戳** | 每条有 `occurredAt` + 绝对日期（UTC）+ `(episode, seq)`；行里的日期/出处必须与 `source` 一致；行数 = claims 数；无游离行 | `gate0/missing-occurred-at`、`gate0/line-not-provenanced`、`gate0/date-mismatch`、`gate0/{episode,seq}-mismatch`、`gate0/section-line-count`、`gate0/stray-section-line` |
| **1 作用域** | 条目 `scopeKey` == 当前 scope，或是其**显式祖先**：`u:` 用户层对任意工作区可见；`w:` 只有"子看父"可见，"父看子"不可见 | `gate1/scope-mismatch`、`gate1/entry-scope-missing`、`gate1/scope-unknown`（strict） |
| **2 支撑门槛** | `support<2` ⇒ 至多 observed；`=2` ⇒ 至多 candidate；`≥3` 或 `2+一次复用` ⇒ 可 semantic/standard；`counter≥1` ⇒ 只能 disputed；`counter≥2` 或强反例 ⇒ 只能 invalidated；定式同表（standard/deprecated/superseded） | `gate2/state-over-claim`、`gate2/unknown-state` |
| **2b 裁决独立性** | 计入票不得共享 contextId；`promote` 必须 `agreement ≥ threshold` 且 `n ≥ 2`；记录必须能回放；形态逐字段合法 | `gate2b/shared-context`、`gate2b/threshold-violation`、`gate2b/single-member-promote`、`gate2b/not-replayable`、`gate2b/invalid-record` |
| **3 有效性/适用条件** | 带 `validity.type≠none` 的条目必须给核验结果；核不过 ⇒ 必须 `state=stale` **且** 只给指针行（`kind=pointer`）；`preconditions` 未满足同理 | `gate3/validity-unchecked`、`gate3/stale-not-marked`、`gate3/stale-rendered`、`gate3/precondition-failed` |
| **4 只增不改** | 被覆盖必须 `supersededBy + supersededAtSeq`；`supersedes` 不许悬挂；被覆盖的条目不许再按正文渲染；同 kind+同 scope+同文本的两条必须有覆盖链 | `gate4/missing-superseded-at`、`gate4/dangling-supersedes`、`gate4/superseded-rendered`、`gate4/unsuperseded-duplicate` |
| **5 来源纪律** | 主张断言的条目必须有 quote：卡片 `source.quote`（若给）必须**逐字包含**在记录的 support 里（防篡改）；support 里查不到该 `(episode, seq)` ⇒ 失败；quote 含 `<compacted-summary>`/`<chess-fold>` 等摘要标记 ⇒ 失败（自证污染） | `gate5/missing-quote`、`gate5/provenance-not-in-support`、`gate5/quote-tampered`、`gate5/summary-source` |
| **6 预算/省略** | 同 M3：≤500 tokens、≤5 条、覆盖率=1、省略显式 | `gate6/*`（未变） |
| **6b 相关** | 同 M3：不命中零注入、每 hit 带 why、深度 ≤2 | `gate6b/*`（未变） |
| **7 事后降级** | 本局否定一次 ⇒ `standard/semantic→disputed`、`candidate→observed`、`disputed→invalidated`；两次 ⇒ `invalidated`；已降级的条目不得再按高状态渲染正文 | `gate7/not-downgraded` |
| **边界** | 8 个指令式片段 + 工具治理痕迹（未变） | `boundary/*`（未变） |

### 两条设计纪律（写进代码注释，避免下一个人踩）

1. **判不了 ≠ 合规**：闸 1/2/3/4/5/7 需要条目记录（`records` 或只读 `store`）。没给 ⇒ 记进 `checks.unverified`（带 gate/code/count/reason）；`strict:true` 时才算失败。这样既不假装核过，也不让 CLI 在没接记录时假红。
2. **同一件事不数两遍**：闸 7 只按**本局新证据**降级；记录里已有的 `counter` 已经体现在它的 `state` 上（那由闸 2 核），再拿来降级就是重复计数。
3. **口径单源**：作用域规范化直接用 R00 的 `normalizeWorkspace`（只小写盘符、不补根斜杠、不动路径大小写）；一致性判据直接用 R10 的 `independenceCheck` / `replayAdjudication`；行格式/正则继续用 R12。**四处规则不复制。**

## 4 · 测试

```
$ node --test test/adjudicate.test.mjs test/gates.test.mjs
ℹ tests 67   ℹ pass 67   ℹ fail 0

$ node --test                 # 全仓
ℹ tests 257  ℹ pass 257  ℹ fail 0     （216 基线 + 23 adjudicate + 18 新闸）

$ node scripts/check.mjs                 → check: PASS
$ node scripts/check.mjs --strict-rooms  → check: PASS（房间清单已含 adjudicate）
```

## 5 · 真实语料实测（`tmp/memory-context`，T6a 入档）

### 5.1 闸 2 / 闸 5 对存量 claim 会不会误伤

| 指标 | 值 |
|---|---|
| claim | 125（joseki 0） |
| state 分布 | `observed` 120 / `candidate` 5 |
| support 分布 | 1 局 117 / 2 局 3 / 3 局 4 / 6 局 1 |
| **闸 2 违规** | **0 / 125**（状态与计数完全自洽） |
| **闸 5 违规** | **0 / 125**（每条 support 都带非空 quote，且无摘要标记） |
| 作用域 | `w:<WORKSPACE>/…default-workspace` 113、`w:d:/…长期记忆系统` 11、`u:owner` 1 |

### 5.2 闸 1 的作用域矩阵

| 当前作用域 | 可见 | 不可见 | 说明 |
|---|---|---|---|
| `w:d:/…/长期记忆系统` | **12** / 125 | 113 | 11 同域 + 1 用户层 |
| `w:<WORKSPACE>` | **114** / 125 | 11 | 113 同域 + 1 用户层 |

### 5.3 把闸接上 store 后跑 20 张真实影子卡（关键发现）

| 指标 | 值 |
|---|---|
| 卡 | 20 |
| 通过 | **2** |
| 失败 | **18**，全部是 `gate1/scope-mismatch` |
| 渲染行 | 93（**52 行来自另一个工作区**，41 行同域） |
| 卡的类型 | 6 张全越界 / 12 张混合 / 2 张干净 |
| 闸 2 / 5 / 4 / 7 报错 | 0 |
| unverified | `gate3/validity-unchecked`（+ `gate1/...` 之外的都没触发） |

**结论**：R11 walk 只按主题走，**不按作用域过滤**，所以当前工作区的卡里会混进另一个工作区的棋谱与 claim。闸 1 一开就把它抓出来 —— 这是 F2（作用域越界）在真数据上的实证，也是开闸前必须修的第一件事（修在 R11/R12，见我给的交接项）。

## 6 · 风险与交接

| # | 事项 | 归属 | 建议动作 |
|---|---|---|---|
| 1 | ~~R11 walk 不按 scopeKey 过滤~~ **已修**（path-walker 在 R11 里落了 `allowRecord`/`resolveScope`；R12 也传 `scope` 并留了兜底过滤）→ 见 §8 | R11 + R12 | 已闭环：20 张真实卡从 2/20 变成 **20/20** |
| 2 | ~~CLI 的 inject 没把 `store/scope` 传给 runGates~~ **已修**：`runGates({card, walkResult, store, scope})` → 见 §8 | R12（inject） | 已闭环：闸 1/2/4/5 在 CLI 路径上真核（`checks.scopeChecked` 等有数） |
| 3 | **闸 3 的核验结果没人供给**：validity 检查（file/commit/version）需要有 fs/git 探针 | M4 后续 | 新增一个只读探针房间（或 CLI `gates-check`），把 `validityChecks`/`preconditionChecks` 喂给 runGates；在那之前闸 3 一律 unverified（不会假绿，但也没真核） |
| 4 | **L4 人纠错还没有落账入口** | R09/R10 接缝 | `adjudicate({level:'L4-human-correction', votes:[{member:'human:owner', human:true, …}]})` 已能出 `decision:'correct'`；落账（写 correction + counter、不改原文）由聚合器做 |
| 5 | **版本未升**：仍 0.4.0、CHANGELOG 未加段 | 发布方（Lead） | 走 分支 → PR → 合并 → `0.5.0` + CHANGELOG（R10 + 十道闸） |
| 6 | `gate6/token-mismatch` 要求 `card.tokens` 与实测完全相等，手工拼卡容易假红 | R13 | 若将来有第二个卡生产者，改成容差（±2）并在 `GATE_DOCS` 注明 |
| 7 | 闸 2b 只校验"记录层面"的独立性；"成员真的在不同会话里独立判"这一点，机械层面只能靠 `contextId` 是否被正确填写 | R10 调用方 | 调用方必须为每个成员填真实 `contextId`（或 `sessionId`）；填假 = 绕过闸 2b，这是已知边界 |

## 7 · 给接手者的最短路径

```bash
# 本房间验收
node --test test/adjudicate.test.mjs test/gates.test.mjs

# 一条裁决（纯函数，不写盘）
node -e '
const { adjudicate, replayAdjudication } = await import("./src/rooms/adjudicate.mjs");
const ev = [{ episode: "ep-1", seq: 10, quote: "Error: x" }];
const rec = adjudicate({ target: "c-aaaa0001", votes: [
  { member: "m-a", verdict: "support", contextId: "ctx-1", evidence: ev },
  { member: "m-b", verdict: "support", contextId: "ctx-2", evidence: ev },
  { member: "m-c", verdict: "oppose",  contextId: "ctx-3", evidence: ev },
]});
console.log(rec.decision, rec.agreement, rec.dissent.map(v => v.member)); // promote 0.667 [ "m-c" ]
console.log(replayAdjudication(rec).ok);                                   // true
'

# 闸门吃真实语料（records/scope 都喂满）
node tmp/gate-real-cards.mjs     # 20 张卡：2 过 / 18 红（gate1/scope-mismatch）
node tmp/scope-matrix.mjs "D:/DeepSeek Harness/default-workspace/长期记忆系统"
node tmp/gates-real.mjs tmp/memory-context   # 125 claim：闸 2/5 零违规
```

> `tmp/` 里的三个探针是临时产物（不进 git），命令与口径已写进本文件与 `evidence/`。

---

## 8 · 补做（Lead 追加：CLI 路径接上闸门 + R12 作用域过滤）

> `[本] 2026-11-02 04:0x` · 工作树（未提交）

### 8.1 改了什么（都在 R12 `src/rooms/inject.mjs` 里）

| # | 改动 | 位置 |
|---|---|---|
| 1 | **`runGates` 收到 `store` + `scope`**：`const gates = runGates({ card, walkResult: walk, store, scope });` | `runInject` |
| 2 | **walk 收到 `scope`**：`walkFn({ signal, store, scope, depth, limit, budgetTokens })`（R11 已支持，见下） | `runInject` |
| 3 | **R12 侧兜底过滤**：`filterHitsByScope(hits, scope)` —— 证明不了在本域可见的命中一律不注入；`u:` 用户层放行；**"作用域未知"与"跨作用域"分开计数** | 新增导出 |
| 4 | **作用域判据单源**：`normalizeScopeKey` / `isScopeVisible` / `isUnknownScope` 落在 R12，**R13 的闸 1 改成从 R12 import**（原来是两份实现） | 新增导出 + gates.mjs |
| 5 | **省略行如实**：`omitted: N items（… · 跨作用域未纳入 X 条 [scope=…] · 作用域未知未纳入 Y 条）`；零展开时也会给一行（"什么都没有"要有解释，不许静默） | `buildMemoryCard` / `renderSection` |
| 6 | **审计字段**：`card.crossScope`（R12 丢的）/ `card.unknownScope` / `card.crossScopeWalk`（R11 在遍历时拒掉的）分开记，不混成一个数 | 卡片返回 |
| 7 | **CLI 文本/JSON**：`walk: … · 命中 N · 同域 M · 跨域已滤 K`；`gates: OK（10 道闸 + 边界：0 错 · unverified N（闸3））`；JSON 多 `hitTotal/crossScope/unknownScope` | `formatInjectText` / `--json` |

### 8.2 R11 已经支持 scope（不是我们"先过滤"了事）

path-walker 在 R11 里落了 `resolveScope()` 与 `allowRecord()`：候选条目在**进 hits 之前**就按作用域判定，被拒的记进 `dropped.crossScope` / `dropped.scopeMissing`，并且 `omitted.crossScope` 可审计。所以现在：

- **主路径**：walk 直接不给跨域命中；
- **兜底**：R12 的 `filterHitsByScope` 仍然在（R11 缺位/被替换/降级 walk 时生效），计数进 `card.crossScope`；
- **R11 的拒掉数**只进审计字段 `crossScopeWalk`，**不算"卡里少了几条"**（那是遍历统计，不是被截断的内容）。

### 8.3 真实语料复测（同一 20 条信号，走 CLI 路径 `runInject`）

| 指标 | 接上之前 | 接上之后 |
|---|---|---|
| 闸门通过 | 2 / 20 | **20 / 20** |
| 闸报错码 | `gate1/scope-mismatch` × 18 | **无** |
| 零注入 | — | 7 / 20（其余 13 张有内容） |
| 跨域被挡 | 52 / 93 行 | 19 / 20 张卡发生过过滤，合计 361 条（进 `crossScopeWalk`），**卡里 0 行越界** |
| token（最坏） | 292 | **300**（预算 500） |
| 闸 1/2/4/5 真核 | 全部 unverified | `scopeChecked/supportChecked/immutabilityChecked/provenanceChecked` 都有数；只剩 `gate3/validity-unchecked` 是 unverified（没人供给核验结果，见 §6 第 3 条） |

### 8.4 测试

```
$ node --test test/inject.test.mjs test/gates.test.mjs test/adjudicate.test.mjs
ℹ tests 95   ℹ pass 95   ℹ fail 0

$ node --test           # 全仓
ℹ tests 268  ℹ pass 268  ℹ fail 0     （216 基线 + T8b 41 + 本次补做 11）

$ node scripts/check.mjs → check: PASS
```

新增的 5 条测试（`test/inject.test.mjs`）：

1. `normalizeScopeKey / isScopeVisible` 与 R00 同口径（盘符小写、反斜杠、`u:` 层、父看不到子）
2. `filterHitsByScope`：同域/`u:` 留下；子作用域从父看不可见；"作用域未知"单独计数
3. 跨作用域丢弃写进省略行（计数 + 原因 + 仍指向 `index.md`）
4. `runInject` 把 `store+scope` 传给闸门 ⇒ 闸 1/2/4/5 真核（不再是 unverified），shadow 仍只写指定目录
5. `runInject` 跨作用域 ⇒ 零注入 + 省略写明（`crossScopeWalk` 可见）
