# 独立复核报告（audit-02）

- **复核对象**：`D:\DeepSeek Harness\default-workspace\长期记忆系统`，`HEAD = 9ed8e63`（`R00: 台账 0.58.0 + 计划表 T36 (#114)`），版本 `0.58.0`，分支 `main`。
- **复核范围**：`reports/audit-01.md` 的 5 项 P1 是否真的修好 + 修复本身是否引入新问题；不重审 audit-01 已判 PASS 的产品面。
- **复核时间**：2026-11-02T21:21–21:38 +08:00（所有命令输出以该时段为准）。
- **复核员**：独立子代理（只读；未参与实现）。
- **只读声明**：除本文件外未写任何仓库文件；未做写操作类 git 命令，只用了 `git log/show/status/diff/rev-parse` 与任务明确要求的 `git checkout -- evidence/metrics-guard.json`（还原 `metrics-guard` 自身副作用；还原后 `git status` 中 `evidence/` 干净）。
- **并发说明**：复核期间另一会话把 `package.json`/`CHANGELOG.md` 改成 **0.59.0（未提交）** 并新增了一份调研文档；`git diff --stat` 只有这两个文件，`src/`、`test/`、`scripts/` 无未提交改动。因此下文 `check.mjs` 的输出是 `version=0.59.0`，其余结论均对 `9ed8e63`（0.58.0）成立。

---

## 结论（通过 / 有条件通过 / 不通过）

**有条件通过。**

- **修好的 3 项**：P1-2（`class:` 前缀与顺序无关，真修复、测试有判别力）、P1-5（`metrics-guard` 会打印「空转」）、P1-1 的**代码与库内数据**（`validFrom = occurredAt` 真的落盘，322 条中 296 条非空）。
- **没修好的 2 项**：
  - **P1-3 不通过**：§7 指针做了，但新增的 `check.mjs` 断言是**死代码**（模板字符串里 `\s` 被吞成 `s`），把版本号与测试数写回 §7 **不会红**——而 `AGENTS.md:288` 明写「有人把数字写回这里就会红」。
  - **P1-4 部分通过**：可见性已改公开、分支保护已开（`strict` + `rules`），但**没有要求 PR**（`required_pull_request_reviews: null`、`rulesets: []`），而 `AGENTS.md:24`、`MAINTENANCE.md:12`、`CHANGELOG.md:21`、`evidence/M7-audit-01-fixes.md:12` 四处都写「需 PR」；`MAINTENANCE.md:54` 仍写「私有仓库」并拿「私有仓库不支持分支保护（403）」作说明。
- **产品行为无回归**：`node --test` 388 条（384 pass / 0 fail / 4 skip，exit 0）、`check: PASS`、`metrics-guard PASS`（exit 0）、`cli audit` 322 claim / 143 卷。
- **另发现 2 个新 P1**（见「新发现」）：`需 PR` 假陈述、`check.mjs` 死断言；以及 5 个 P2（其中「26 条历史条目无 `occurredAt`」是可一条命令证伪的假陈述）。

> 判定：**不阻断产品交付**（无 P0、无数据损坏、无越界注入），但**不能宣称「audit-01 的 P1 全部修好」**。建议按「新发现」的 P1 两项 + P2-1 做一轮小修后再复核。

---

## P1 逐项复核表（项 / 结论 / 证据）

| 项 | 结论 | 证据 |
|---|---|---|
| **P1-1 `validFrom`** | **部分通过**（代码/库 PASS；台账解释 FAIL） | 代码：`src/rooms/claim.mjs:1062` `validFrom: Number.isFinite(occurredAt) ? occurredAt : null`，`occurredAt` 由支撑证据最早时间派生（`:1022`）。单测：新 N1 真断言在 `test/claim.test.mjs:311-329`（fixture 非空、逐条断言 `validFrom === occurredAt`），`node --test test/claim.test.mjs` = **19 tests / 19 pass / 0 fail，exit 0**。生产库（只读）：322 条 claim，**296 条 `validFrom` 非空**，26 条为 `null`；**26/26 都有 `occurredAt`**（`nullNoOccurredAt = 0`），无一条 `validFrom !== occurredAt`。**但**「26 条历史条目（无 `occurredAt`）」是假陈述（见新发现 P2-1），且旧空壳 N1 仍留在 `:367-381`、`:83` 是恒真正则。 |
| **P1-2 class 前缀/顺序** | **通过** | `representativeTextFor()` 存在于 `src/rooms/claim.mjs:498-502`，被**建组**（`:598`）与**更早支撑重置**（`:612`）两条路径同时使用。乱序测试在 `test/claim.test.mjs:332-346`，随 `node --test test/claim.test.mjs` 通过。判别力已用 0.57.0 旧模块（`git show 89a8058:src/rooms/claim.mjs` 经 data-URL 在内存 import）实测：旧代码 `asc = "Error: Cannot find module 'yaml'"`（无前缀）/ `desc = "class:module-missing · …"`（有前缀），**旧代码本身就通不过该测试**；新代码两序一致且均带前缀。 |
| **P1-3 AGENTS §7 + check 断言** | **不通过** | §7 已改成指针表（`AGENTS.md:275-288`），`check.mjs` 的「指针存在」断言有效（把「本节的旧快照会过期」删掉 → FAIL）。**但**数字断言失效：`scripts/check.mjs:22` 的 `` `…\s*条测试` `` 在模板字符串里 `\s` 被解析成 `s`，实际正则为 `v?0.58.0s*条测试`（实测 `.source`），只匹配「版本号紧邻『条测试』」。内存模拟四种写回（含 audit-01 那版 `v0.19.1 / 353 条测试`、当前版本 + 388 条）**全部 PASS，无一变红**。 |
| **P1-4 仓库口径与保护** | **部分通过** | 可见性：`gh api repos/MYCF711/dsh-GOkifu-longmemory --jq '{private,visibility}'` → `{"private":false,"visibility":"public"}` ✔。保护：`branches/main/protection` 返回 200，`strict:true`、`contexts:["rules"]`、`allow_force_pushes:false`、`allow_deletions:false` ✔。**但** `required_pull_request_reviews: null`、`rulesets: []` ⇒ 直推 `main` 仍被允许（只需 `rules` 检查通过），「需 PR」为假；`MAINTENANCE.md:54` 仍是「GitHub 免费**私有**仓库不支持分支保护（实测 403）…本地 pre-push hook 兜底」，与现状（公开 + 服务端保护已开）矛盾。 |
| **P1-5 A1 空转** | **通过（附 P2 脆弱性）** | `scripts/metrics-guard.mjs:31-32` 产出 `a1Vacuous/a1Coverage`，`:48` 放入 `values`，`:75` 摘要行按 `a1Vacuous` 追加「（空转：validity 覆盖 0）」。实跑：`metrics-guard PASS · A1=0（空转：validity 覆盖 0） A5=0 A6=1 A2b严格=0.8421052631578947（n=19） 覆盖=1 p50=1.99ms`，exit 0；`--json` 中 `a1Vacuous:true`、`a1Coverage:{withValidity:26,rendered:0,ratio:0}`。结论：确实避免了「摘要行只写 A1=0」，护栏仍不判 fail（与 audit-01 建议一致）。脆弱点见新发现 P2-4。 |

---

## 逐项展开

### P1-1 `validFrom`：字段真的落地了，但台账对「剩下的 26 条」的解释是错的

**代码（PASS）**：`validFrom` 不再写死 `null`（`src/rooms/claim.mjs:1062`）；`occurredAt` 取支撑证据最早时间，缺则回退棋谱时间、再回退 `representativeAt`（`:1022`）。因此除极端情况外新 claim 一律 `validFrom === occurredAt`。

**测试（部分）**：新增的 N1（`test/claim.test.mjs:311-329`）是真断言：`fixture()` 产出非空 claims（`:316` 先断言 `out.claims.length > 0`），再逐条比对 `validFrom === occurredAt`，并验证 L4 纠错写 `validTo`。`node --test test/claim.test.mjs` 实跑 **19/19 pass，exit 0**。
但 audit-01 指出的空壳**没有删掉**：`:367-381` 仍是老版本（`promoteClaim({episodes: []})` + `if (sample)`），与新增的 N1 同名不同文、永真通过；`:83` 的 `assert.match(c.text, /^(class:[a-z-]+ · )?/)` 因前缀可选而恒真（这两点列入新发现 P2-2/P2-3）。

**生产库（数字 PASS，解释 FAIL）**：只读统计 `<DSH_HOME>/memory-context/claims`：

```json
{"total":322,"vfNotNull":296,"occNotNull":322,"both":296,"nullNoOcc":0,"nullWithOcc":26}
```

即 **26 条 `validFrom` 为 `null` 的 claim，全部都带有限的 `occurredAt`**，没有一条是「无 `occurredAt`」。文件时间也证明它们是历史条目：null 组 mtime 为 `2026-11-02T03:45:00Z–10:25:39Z`，valid 组为 `10:44:36Z–13:13:01Z`。

**为什么会有 296 条（此前只有 1 条）**：`journal/archive.jsonl` 在 **`2026-11-02T13:12:51.995Z`** 记录了一次全量重放——`put:claims = 295`（另有 episodes 6 / topics 54 / links 24 / threads 6 与对应 delete）。`persist` 的「首见时钟不因重放漂移」（`src/rooms/persist.mjs:624-626`）解释了为何这些文件 `recordedAt` 仍是 03:44/07:59 等旧值而 mtime 是 13:12。也就是说：**296 这个数字来自一次未在 CHANGELOG/证据里披露的归档重放**，26 条则是这次重放**没有重新产出**的历史 claim（不是「无 occurredAt」）。

**结论**：字段本身真修好了（不是台账造假）；但「26 条历史条目（无 `occurredAt`）按只增不改保留」这句话与库相反，且与契约「历史 claim 不做回溯改写 / 不重写历史文件」自相矛盾（见新发现 P2-1）。

### P1-2 class 前缀/顺序：真修复

- `representativeTextFor(kind, key, rawQuote, maxQuote)`（`src/rooms/claim.mjs:498-502`）统一产出 `class:<name> · <错误行>`；建组路径 `:598`、更早支撑重置路径 `:612` 都改走它。
- 乱序测试 `test/claim.test.mjs:332-346` 会正序/倒序各跑一遍并断言文本一致、且带 `class:` 前缀。
- **判别力实证**（不只「测试通过」）：把 0.57.0 的 `claim.mjs` 原样在内存里 import，喂同一 fixture：

  ```
  OLD 0.57.0 | asc: ["Error: Cannot find module 'yaml'"] | desc: ["class:module-missing · Error: Cannot find module 'yaml'"] | equal: false | ascHasPrefix: false
  NEW 0.58.0 | asc: ["class:module-missing · Error: Cannot find module 'yaml'"] | desc: [同左] | equal: true | ascHasPrefix: true
  ```

  ⇒ 该测试在旧代码上必红，是真回归测试，不是空壳。

### P1-3 AGENTS §7：指针做了，断言是死的

- `AGENTS.md:275-288` 已无版本号/测试数，只有「想知道 → 看哪」的指针表；把「本节的旧快照会过期」删掉后 `check.mjs` 会 FAIL（内存字符串验证），说明**指针存在性断言有效**。
- 但 `scripts/check.mjs:22`：

  ```js
  else if (new RegExp(`v?${pkg.version.replace(/\./g, '\.')}\s*条测试`).test(agents)) fail.push(...)
  ```

  模板字符串里 `\s` 不是合法转义 ⇒ 变成字面 `s`；`'\.'` 也退化成 `'.'`。实测 `re.source === "v?0.58.0s*条测试"`，因此只有写成 `0.58.0条测试`（无空格无分隔）才会命中。
- 内存模拟（不落盘）：

  | 场景 | 期望 | 实测 |
  |---|---|---|
  | 现状 `AGENTS.md` | PASS | PASS |
  | 写回 audit-01 那版（`v0.19.1 / 353 条测试`） | FAIL | **PASS** |
  | 写回当前版本 + 388 条 | FAIL | **PASS** |
  | 写回别家版本 + 条测试 | FAIL | **PASS** |
  | 删掉指针段 | FAIL | FAIL |

  且即使把 `\s` 修好，该正则也只匹配「`pkg.version` 紧邻『条测试』」，仍抓不到 `v0.19.1 / 353 条测试` 这类漂移——与 `AGENTS.md:288`「有人把数字写回这里就会红」不符。

### P1-4 可见性与保护：公开 + 保护已开，但「需 PR」不成立

```text
$ gh api repos/MYCF711/dsh-GOkifu-longmemory --jq '{private,visibility}'
{"private":false,"visibility":"public"}

$ gh api repos/MYCF711/dsh-GOkifu-longmemory/branches/main/protection
required_status_checks: {strict:true, contexts:["rules"]}
required_pull_request_reviews: null          ← 没有要求 PR
enforce_admins: false
allow_force_pushes: false / allow_deletions: false

$ gh api repos/MYCF711/dsh-GOkifu-longmemory/rulesets     → []
$ gh api repos/MYCF711/dsh-GOkifu-longmemory/rules/branches/main → []
```

- `.github/workflows/check.yml` 的 job 名确为 `rules`，所以必需检查上下文有效；`v0.58.0` 也已发布（`2026-11-02T13:19:18Z`，target `main`）。
- **但 PR 要求为空**：直推 `main` 仍可成功（只要 `rules` 通过），audit-01 P1-4/P2-9 要求的「require PR」只做了 `strict` + status check 一半，而四处文档（`AGENTS.md:24`、`MAINTENANCE.md:12`、`CHANGELOG.md:21`、`evidence/M7-audit-01-fixes.md:12`）都写成已做。
- `MAINTENANCE.md:54` 仍是「GitHub 免费**私有**仓库不支持分支保护（2026-11-02 实测 403），改用本地 pre-push hook + CI 兜底」——既残留「私有」，也与「保护已开」自相矛盾。

### P1-5 A1 空转：确实打出来了

实跑（`node scripts/metrics-guard.mjs`）：

```text
metrics-guard PASS · A1=0（空转：validity 覆盖 0） A5=0 A6=1 A2b严格=0.8421052631578947（n=19） 覆盖=1 p50=1.99ms
EXIT=0
```

`--json` 同时给出 `a1Vacuous:true` 与 `a1Coverage:{withValidity:26,rendered:0,ratio:0}`；入库证据 `evidence/metrics-guard.json`（`at 13:14:51Z`）也含这两个字段。判断：**达到 audit-01 的建议**（不判 fail，但摘要行与台账都必须标「空转」），台账 `MAINTENANCE.md:29` 已改写。仍不构成硬闸（JSON 消费者若只看 `values.a1` 仍会看到 0），属可接受的设计取舍。

---

## 新发现（P0/P1/P2）

### P0

**无。** 未发现数据损坏、越界注入、发布形态错误或行为回归（388 测试全绿、check/metrics-guard 均 exit 0）。

### P1

**P1-N1 「main 需 PR」是不成立的陈述，且是本次修复新写入的。**
- 证据：`required_pull_request_reviews: null`、`rulesets: []`；`allow_force_pushes:false` 仅表示不能强推，不代表必须走 PR。
- 位置：`AGENTS.md:24`、`MAINTENANCE.md:12`、`CHANGELOG.md:21`（0.58.0）、`evidence/M7-audit-01-fixes.md:12`。
- 影响：服务端仍允许直推 `main`；下一个接手者会以为有 PR 闸。修复成本极低（`gh api -X PUT …/protection` 增 `required_pull_request_reviews`，或改用 ruleset）。

**P1-N2 `check.mjs` 的 AGENTS 数字断言永不触发，但被当成功效写进 AGENTS/CHANGELOG/证据。**
- 证据：`scripts/check.mjs:22` 的 `\s` 转义失效 → 实际正则 `v?0.58.0s*条测试`；四种写回模拟全部 PASS；`AGENTS.md:288` 却写「有人把数字写回这里就会红」，`CHANGELOG.md:22` 与 `evidence/M7-audit-01-fixes.md:12` 称「写回数字会红」。
- 影响：audit-01 P1-3 的根因（状态节漂移）在文档层面已解决，但**声称的自动护栏不存在**；一旦有人把数字写回 §7，CI 不会红。

### P2

**P2-1 「26 条历史条目（无 `occurredAt`）」是可一条命令证伪的假陈述；且那次 295 条的重放未披露、与「不回溯改写」措辞冲突。**
- 实测：26 条 null 全部有有限 `occurredAt`（`nullNoOcc = 0`，`nullWithOcc = 26`）。
- 真实原因：`journal/archive.jsonl` 在 `2026-11-02T13:12:51.995Z` 有一次全量重放（`put:claims = 295`），把可重算的历史 claim 补上了 `validFrom`；剩下 26 条是这次重放没重新产出的旧条目。
- 冲突面：`docs/数据契约.md:141`（同一句假话 + 「均已补」）、`:196`「不重写历史文件」、`docs/数据契约.md:146`「历史 claim 不做回溯改写」；`evidence/M7-audit-01-fixes.md:9` 同句。
- 建议：改成「26 条为 0.58 前落盘、本次重放未重新产出的历史条目（均有 `occurredAt`，按只增不改保留）」，并披露「0.58 落地时重放过一次归档」。

**P2-2 0.58 的测试改动留下重复块与旧空壳。**
- `test/claim.test.mjs` 里 `ensureClassClaims` 测试出现两次（`:293-309` 与 `:349-365`，逐字相同），N1 出现两次（新真断言 `:311-329` + 旧空壳 `:367-381`）。`node --test` 因此把这两个用例各跑两遍；388 条中 **2 条是冗余**（+3 条新增里 1 条纯重复）。
- 影响：不红，但「空壳测试改成真断言」的表述不准确（是**新增**，不是**替换**）；重复块会让以后改一处忘另一处。

**P2-3 `test/claim.test.mjs:83` 是恒真断言。**
- `assert.match(c.text, /^(class:[a-z-]+ · )?/)` —— 前缀组可选，空串即可匹配，永远通过。本想验证「错误类命中时必有前缀」，实际什么也没验。建议改成 `assert.match(c.text, /^class:module-missing · /)`（与本 fixture 的 `errorKeyOf` 结果一致）。

**P2-4 `a1Vacuous` 的数值分支是死代码，实际靠中文字符串兜底，且无单测。**
- `axes.A1.detail.validityCoverage` 是对象 `{withValidity,rendered,ratio}`，`Number.isFinite(对象)` 恒 false，所以 `a1Vacuous` 实际由 `String(caveat).includes('空转')` 决定（`scripts/metrics-guard.mjs:31-32`）。
- 后果：`m5-report` 的 caveat 措辞一改，`a1Vacuous` 会静默变 false、摘要行退回只写 `A1=0`，且没有测试会红。建议显式取 `detail.validityCoverage.ratio`，并补一条 judge() 单测（coverage 0 / 非 0 两例）。

**P2-5 台账数字仍不可精确复现，且与自家证据冲突。**
- `MAINTENANCE.md:29` 写「validity 覆盖 **0/23**」，而本次修复入库的 `evidence/metrics-guard.json` 就是 `withValidity: 26`（`m5-report` 实跑同样是 0/26）——台账抄的是 audit-01 的旧数，没有重采。
- 同格 `A2 26.55%`、`A4 p50 2.03ms` 复跑为 **26.82%（0.2681564）**、**2.36ms**；时点只写「`[本] 2026-11-02 21:2x`」，不是可复核的精确时间。属 audit-01 P2-3 的残留。

**P2-6（口径）「P2 修 5 留 4」在仓内没有出处。**
- `evidence/M7-audit-01-fixes.md` 列的是：已修 5（P2-1/2/3/4/6）、未修 3（P2-5/7/8）、P2-9 标为「已实际开启、不再是缺项」；`CHANGELOG.md` 0.58 段只列「P2 顺手修」不计数。
- 若对外称「留 4」，多算一项；若因缺 PR 要求把 P2-9 计入未修，则与证据原文冲突。建议统一为「修 5 / 留 3（P2-5/7/8），P2-9 因「需 PR」未落实仍需补」或按实际重列。

---

## 回归实测（本次真实运行的命令与结果）

| 命令 | 结果 |
|---|---|
| `node --test test/claim.test.mjs` | `tests 19 / pass 19 / fail 0 / skipped 0`，**exit 0** |
| `node --test` | `tests 388 / pass 384 / fail 0 / skipped 4`，**exit 0**（含重复块） |
| `node scripts/check.mjs` | `check: PASS`，**exit 0**；`ok AGENTS §7 指针`、`privacy-scan 0 处`（审计中并发改版，输出 `version=0.59.0`） |
| `node scripts/metrics-guard.mjs` | `PASS · A1=0（空转：validity 覆盖 0） A5=0 A6=1 A2b严格=0.8421(n=19) 覆盖=1 p50=1.99ms`，**exit 0**；跑后已 `git checkout -- evidence/metrics-guard.json` 还原 |
| `node scripts/cli.mjs audit` | `claim 322 · observed=286 · candidate=36 · 过期 25 · 卷 143 · 类级主卷 4`，**exit 0** |
| `node scripts/m5-report.mjs --json` | `A1=0 (vacuous, 0/26)`、`A2=0.2681564`、`A3=not-live`、`A4 p50=2.36ms`、`A5=0`、`A6=1` |
| `node scripts/class-audit.mjs` | `6 类 · 已有类级 6 · 缺 0 · 可折叠 0` |
| `gh api …/branches/main/protection` | 200：`strict:true`、`contexts:["rules"]`、`pr_reviews:null`、`force_push:false`、`deletions:false`、`enforce_admins:false` |
| `gh api …/rulesets` / `…/rules/branches/main` | `[]` / `[]` |
| `gh api …/releases?per_page=3` | `v0.58.0` @ `2026-11-02T13:19:18Z`、`v0.57.0`、`v0.56.0` |

**CHANGELOG 0.58.0 逐句可复现性**：

| 句子 | 判定 |
|---|---|
| 「`validFrom` 真正落地（= `occurredAt`）」 | ✔ 代码 + 单测 + 库内 296 条 |
| 「N1 空壳测试改成真断言」 | ⚠ 新增了真断言（执行、非空），但**旧空壳仍在**（P2-2） |
| 「322 条中 296 条有 `validFrom`」 | ✔ 只读统计逐条一致 |
| 「26 条历史条目（无 `occurredAt`）」 | ✘ 26 条**都有** `occurredAt`（P2-1） |
| 「新增 `representativeTextFor()`，两条路径共用」 | ✔ `:498/:598/:612` |
| 「新增乱序一致性测试」 | ✔ 且经旧模块验证有判别力 |
| 「§7 改指针；`check.mjs` 断言指针存在」 | ✔（但数字断言是死的，P1-N2） |
| 「口径统一为公开，并实际开启 main 分支保护（require PR + `rules`）」 | ⚠ 公开 ✔、保护 ✔、**require PR ✘**（P1-N1） |
| 「`metrics-guard` 增 `a1Vacuous/a1Coverage`，摘要行标空转」 | ✔ 实跑可见 |
| 「巩固只吃 `kind=antipattern`」 | ✔ `src/rooms/claim.mjs:1212` |
| 「契约 §9 标注 `repeat` 派生、`threadIds`/`supersedes` 保留」 | ✔ 与代码一致（`walk.mjs:902/976/1047` 派生；`claim.mjs:1044/1252` 恒 `[]`；`:1078/1262` 恒 `null`，无生产者） |
| 「台账数字带时间戳」 | ⚠ 有「21:2x」但不可精确复核，且 0/23 与证据 0/26 冲突（P2-5） |
| 「门槛证据同步 0.55」 | ✔ `evidence/M7-metrics-guard.md:13,30` |
| 「删除 `DEFAULT_CONFIG` 重复键」 | ✔ `Object.keys(DEFAULT_CONFIG).length = 18`，`autoBuild=true` |
| 「388 条测试（384/0/4）」 | ✔ |

**`docs/数据契约.md` §9/§12 与代码一致性**：`repeat` 确由 `walk` 读时派生（`supportEpisodeCount`，`src/rooms/walk.mjs:902/976/1047`；`:707` 只在持久化里已有该字段时才透传，库里 0 条）；`supersedes`/`threadIds` 确无生产者（`claim.mjs:1044/1078/1252/1262` 恒空，`gates.mjs:841` 只做悬空校验）；§12「只吃 `kind=antipattern`」与 `claim.mjs:1212` 相符。**唯一不一致**是 §9 的字段生产状态注释里那句「26 条无 `occurredAt`」（P2-1）。

---

## 未能核实项

1. **0.59.0 并发改动**：复核期间工作树被另一会话改成 `0.59.0`（`CHANGELOG.md`/`package.json` 未提交 + 新增 `docs/调研/19-…md`）。本报告按 `HEAD 9ed8e63` 判定；`src/test/scripts` 无未提交改动，故测试/闸门结果可代表 0.58.0，但 `check.mjs` 打印的是 0.59.0。
2. **13:12:51Z 那次 295 条重放由哪条命令触发**：`journal` 只记录 put/delete 不记命令名，`archive.mjs` 也没有 `--all/--replay` 之类可见开关；无法确认是人工重跑归档还是一次性脚本。只读层面能确证的是「发生过、写了 295 条 claim、`recordedAt` 被保留」。
3. **26 条 null claim 的源棋谱是否仍存在**：未逐条回溯其 `support.episode` 是否还在 `episodes/`；只确证它们不是「缺 `occurredAt`」，且其中 12 条 id 仍可由当前 `errorKeyOf` 复算（即不是算法变更导致的孤儿 id）。
4. **GitHub Actions 上 `rules` 检查最近的运行结论**：未查 Actions 运行记录，只确认 job 名与必需上下文匹配。
5. **0.58.0 之前的 `validFrom` 行为**：未 checkout 旧提交重跑；P1-2 的旧行为是用 `89a8058` 的 `claim.mjs` 在内存里复现的（不是完整旧测）。
