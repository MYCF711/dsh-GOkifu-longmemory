# 独立审计报告（audit-01）

- **审计对象**：`D:\DeepSeek Harness\default-workspace\长期记忆系统`（私有仓库 `MYCF711/dsh-GOkifu-longmemory`，版本 `0.57.0`，审计时 HEAD = `89a8058`，分支 `main`，工作树干净）
- **审计时间**：2026-11-02T21:00–21:10 +08:00（命令输出以该时点为准）
- **审计员**：独立子代理（只读审计；未参与实现）
- **审计过程说明**：
  1. 审计期间仓库被并发更新（HEAD 由 `e73e119` → `89a8058`，分支由 `chore/ledger-0570` → `main`；该提交只改 `MAINTENANCE.md`）。本报告全部按最终 HEAD 复核；`check.mjs`/`node --test` 在两次提交上结果一致（源码未变）。
  2. 按任务要求运行 `node scripts/metrics-guard.mjs` 时，该脚本会重写 `evidence/metrics-guard.json`（脚本自身副作用，`scripts/metrics-guard.mjs:67-68`）。已用 `git checkout -- evidence/metrics-guard.json` 还原，现工作树干净（`git status --porcelain` 为空）。除此之外只写了本文件。

---

## 结论摘要（是否可交付：通过 / 有条件通过 / 不通过）

**有条件通过。**

- 产品面（边界、零模型/零向量、质量门、不发 npm、发布形态、冻结集纪律）**实测通过**：`check.mjs` PASS（exit 0）、`node --test` 385 条（381 pass / 0 fail / 4 skip，exit 0）、`metrics-guard` PASS（A1=0 / A5=0 / A6=1 / A2b 严格 0.842（16/19）/ 覆盖 1 / p50 2.23ms）、npm 未发布（404）、`v0.57.0` = annotated tag + GitHub Release。
- 但**文档与数据契约的诚实性不过关**：契约 §9 的 `validFrom` 在生产库 303 条 claim 中只有 1 条非空（301 条为 `null`），而 CHANGELOG 0.37.0 与证据文件明确宣称“出生即 `validFrom = occurredAt`”；`AGENTS.md` 状态快照仍停在 0.19.1/353 条；`MAINTENANCE.md` 的语料与 A2 数字已不可复现；仓库在 GitHub 上实际是 **public**，而台账写“私有”。
- 另有 1 个真实代码缺陷（claim 文本随输入顺序变化、`class:` 前缀可能丢失，生产库已有 17 条受影响）与 1 个指标空转问题（A1 的 0% 来自 0/23 的 validity 覆盖，gate 仍判 PASS）。

**判定：不阻断交付，但需先清 P1（5 项）再宣称“审计通过”。当前最小可交付状态可接受。**

---

## 逐项结果表（A–G）

| 项 | 结果 | 证据 |
|---|---|---|
| **A. 契约与代码一致** | **§9 FAIL（部分字段）；§10 PASS；§12 PASS（有偏差）** | §9：`promoteClaim` 实际产出 `id/kind/text/scopeKey/threadIds/state/support/counter/validity/preconditions/occurredAt/recordedAt/validFrom/validTo/counters/supersedes`（`src/rooms/claim.mjs:1026-1072`）。其中 `validFrom` 恒为 `null`（`:1054`）、`repeat` 根本不产出、`supersedes` 恒 `null`（`:1070`）、`threadIds` 恒 `[]`（`:1036`）。`validityOk` 由归档期核验写入（`scripts/archive.mjs:456-465`），符合“归档时核验结果”的措辞。生产库统计：303 条 claim 中 `validFrom` 非空 **1** 条（即 `ensureClassClaims` 产出的类级 claim，`src/rooms/claim.mjs:1250`）、`repeat` 字段 **0/303**、`supersedes` 非空 **0/303**、`validityOk` 存在 23 条（false 22 / true 1）。§10：`applyAdjudications` 只处理 `decision=correct` 且 `level=L4-human-correction`（`:1150-1152`），同一条重放两次 counter 仍为 1、`validTo` 不变（实测输出 `{"n":1,"state":"disputed","validTo":3000,"ctr":1}` 两次一致），符合“只有 L4+correct 回填、幂等”。§12：`ensureClassClaims` id 由类名+作用域哈希（`:1239`），重放不新增（单测 `test/claim.test.mjs:291-306` 通过）；但**未按契约过滤 `kind=antipattern`**（`:1201-1218`），实测把 `fact` claim 也补成 `kind=antipattern` 的类级 claim。 |
| **B. 边界与安全** | **PASS** | ① 禁项：`grep -rnE "embedding|vector|cosine|openai|fetch\(|https?://|chat/completions" src` 只命中一条注释（`src/rooms/topic.mjs:388`，讲“抽词前先抹掉 URL”）；`src` 的 import 只有 `node:*` 与本地相对模块，唯一外部动态 import 是宿主消息工厂 `@deepseek-ai/dsh-llm`（`src/plugin.mjs:324`，用于造 user 消息，不是模型调用）；无 `session.append`/`session/event` 写入（只有 `src/plugin.mjs:23` 的注释声明“不写”）；无系统提示词/persona 改动。② 注入渲染：`renderEntryLine` 只输出 `- [marker] 文本 (ep-…, YYYY-MM-DD, seq N)`（`src/rooms/inject.mjs:508-511`），`renderSection` 只加 `<memory-ledger>` 与 markers 行（`:514-531`、`:68`）；实机只读渲染（`node scripts/cli.mjs inject --signal "测试 记忆卡 gates 注入"`）为 5 条事实行 + 省略说明，`gates: OK`。③ 祈使句检查：`IMPERATIVE_PATTERNS` 8 条（`src/rooms/inject.mjs:36-45`），闸门扫 `indexLine + section + claims[].text`（`src/rooms/gates.mjs:1030-1046`），命中即 `ok=false` → 不注入（声明见 `src/plugin.mjs:26`，执行见 `:462`）。④ `crossScopeClass` 默认 **false**：`src/plugin.mjs:89`（DEFAULT_CONFIG）与 `:172`（归一化兜底），Q18 在 `docs/拷问记录.md:278` 仍标注“待裁定”，一致。 |
| **C. 质量门** | **PASS** | `node scripts/check.mjs` → 全 `ok`，`check: PASS`，**exit 0**（branch=main、private:true、version=0.57.0、changelog 有当前段、房间齐、privacy-scan 0 处）。`node --test` → `tests 385 / pass 381 / fail 0 / skipped 4 / duration 3273ms`，**exit 0**。`node scripts/metrics-guard.mjs` → `metrics-guard PASS · A1=0 A5=0 A6=1 A2b严格=0.8421052631578947（n=19） 覆盖=1 p50=2.23ms`，**exit 0**。补充：清空 `DSH_HOME` 模拟 CI → `385 / pass 374 / fail 0 / skipped 11`，exit 0（CI 无本机语料，符合预期）。 |
| **D. 不发 npm** | **PASS** | `package.json:4` `"private": true`；全仓 `grep publishConfig package.json` 无命中；`scripts/release.mjs:64-66` 只做 `git tag -a` + `git push origin <tag>` + `gh release create`，末行打印 `released <tag> (no npm publish)`；CI `.github/workflows/check.yml` 只有 `node --test` 与 `node scripts/check.mjs`，无 publish 步骤；`npm view dsh-gokifu-longmemory version` → **E404 Not Found**；GitHub API：`v0.57.0` release 已发布（`2026-11-02T13:00:31Z`，target `main`），本地 `git cat-file -t v0.57.0` = `tag`（annotated，指向 `e73e119`）。 |
| **E. 测试有效性抽查** | **PASS（抽查 3 房间）；另发现 1 条空壳测试** | 抽 **walk / gates / inject** 三个房间：walk 26 条、gates 47 条、inject 28 条，均为真行为测试。例：`test/walk.test.mjs:358-376` 断言 depth 被 clamp 到 2、第 3 跳 `ep-0004` 永不出现、`depth=1` 时 `ep-0003` 不可达；`:495-501` 用 walk 前后 store 的 sha256 与 journal 行数证明“不写盘”。`test/gates.test.mjs:315-330` 对 8 种指令式片段逐个断言 `ok=false` 且 `detail.pattern` 精确匹配。`test/inject.test.mjs:252-266` 断言无源 claim 的文本绝不出现在注入里。三个文件分别单独运行亦 pass（各 1/1）。**反例**：`test/claim.test.mjs:310-318` 的 N1 测试用 `promoteClaim({episodes: []})` 拿到空 claims，`if (sample)` 使核心断言永不执行（实测 `claims.length = 0`），是空壳；同文件 `:91` 反而断言 `validFrom === null`，把错误行为固化成“预期”。 |
| **F. 台账诚实性** | **FAIL（部分）** | 可复现：测试 385（381/0/4）✔；`metrics-guard PASS` ✔；`v0.57.0` 已发布 ✔；语料 116 局 ✔；有效期已止 22 ✔。**不可复现/自相矛盾**：`MAINTENANCE.md:29` 写 `A2 24.32%`、`A4 p50 2.30ms`，当前 `m5-report` 实测 A2 **26.70%**（LOO both，47/176）、A4 p50 **1.95ms**（guard 复跑 2.23ms），且该行**无时点**；`:30` 写 `141 卷 / claim 295`，实测 **143 卷 / 303 claim**（`node scripts/cli.mjs audit`）；`:31` “当天覆盖 18/18” 只存在于 `evidence/M6-D1.md:13`（0.19.0 时代的 102→116 局），当前无命令可复现；`AGENTS.md:99/275-287` 状态仍是 **v0.19.1 / M5 收口 / 353 条测试 / 宿主入口默认关 / 仓库公开**，与现状（0.57.0 / 385 条 / `DEFAULT_CONFIG.enabled=true` / GitHub 实测 public 而 MAINTENANCE 写“私有”）全面冲突。“说了但没做”的最硬一条是 `validFrom`（见 P1-1）。 |
| **G. 过拟合与指标纪律** | **PASS（有记录在案的门槛下调）** | 冻结集 `evidence/a2b-set.json`：`count=19`、`splitAt=2026-11-02T00:00:00Z`、`createdAt=2026-11-02T11:21:02Z`、3 个作用域；`git log --follow` 只有创建提交 `4d811b1`（0.43.0），`git diff 4d811b1..HEAD -- evidence/a2b-set.json` 为空 ⇒ **未被重冻**。严格口径从“第一条覆盖”改为“任一条覆盖”有单独证据与单列记账（`evidence/M7-a2b-strict-semantics.md`，63.2%→84.2%，明确写“判据修正，不是产品改动”）。门槛确有一次下调：`a2bStrictMin 0.60 → 0.55`，发生在 `36d0121`（提交信息只写“N1 双时态”），但 **CHANGELOG 0.37.0 有披露**（`CHANGELOG.md:243`）；`evidence/M7-metrics-guard.md` 的门槛表仍写 ≥0.60（过期证据）。当前实测 0.842 远高于 0.55 与 0.60，未发现“为好看而调门槛”的现时收益。 |

---

## 发现的问题（P0 阻断 / P1 应修 / P2 建议）

### P0 阻断

**无。** 未发现会导致数据损坏、越界注入、发布形态错误或质量门失效的阻断项。

### P1 应修

#### P1-1 `validFrom` 未落地，但契约/CHANGELOG/证据都宣称已落地；对应测试是空壳

- **现象**：`promoteClaim` 产出的 claim `validFrom` 恒为 `null`（`src/rooms/claim.mjs:1054`），归档期也没有补写；生产库 303 条 claim 中只有 1 条 `validFrom` 非空（来自 `ensureClassClaims`，`:1250`）。
- **证据**：
  - `docs/数据契约.md:129`：“`validFrom, // = occurredAt（出生）`”；`:145` 不变量“`validFrom ≤ validTo`”。
  - `CHANGELOG.md:239`（0.37.0）：“claim 出生带 `validFrom = occurredAt`”。
  - `evidence/M7-N1-bitemporal.md:4` 同句；`:15` 称“claim 295 条 · 有效期已止 22 条”。
  - 代码：`src/rooms/claim.mjs:1054` `validFrom: null`；`scripts/archive.mjs:456-465` 只写 `validityOk`/`validTo`，不写 `validFrom`。
  - 实测统计（读 sidecar）：`{claims:303, hasValidFrom:302, validFromNotNull:1}`；样例 `c-00d76725` 的 `validFrom: null`、`validTo: 1793619056646`。
  - 测试空壳：`test/claim.test.mjs:310-318` 用 `promoteClaim({episodes: [] ...})`，`out.claims[0]` 为 `undefined`，核心断言在 `if (sample)` 内跳过；同文件 `:91` 断言 `validFrom === null`，与契约相反。
- **影响**：双时态审计（“某时点该 claim 是否出生”）与 `cli facts --at` 只能靠 `occurredAt` 回退（`src/rooms/cli.mjs:742-746`），契约里“出生时间”这个一等字段在数据中不存在；审计者按 CHANGELOG/契约复核会得到与库相反的事实，属“台账不诚实”。
- **建议动作**（择一，二选一并写进本刀 CHANGELOG）：
  1. 在 `promoteClaim` 落 `validFrom = occurredAt`（无 `occurredAt` 的条目不产出），把 `test/claim.test.mjs:310-318` 改成带 fixture 的真断言；
  2. 或把契约 §9/§14、CHANGELOG 0.37.0、`evidence/M7-N1-bitemporal.md` 统一改成“`validFrom` 读侧派生，不落盘”，并删掉 `test/claim.test.mjs:91` 与 `:317` 的矛盾断言。

#### P1-2 claim 文本随输入顺序变化，`class:` 前缀会丢失；生产库已有 17 条受影响

- **现象**：同一组证据按不同顺序送入 `promoteClaim`，产出的 claim 文本不同：一串带 `class:<name> ·` 前缀，另一串不带。根因是“后到的更早支撑”会重置 `representativeText` 时丢掉前缀。
- **证据**：
  - `src/rooms/claim.mjs:586-598` 建组时按 `key.startsWith('class:')` 拼 `class:<name> · <错误行>`；
  - `:600-606` 一旦出现更早时间戳的支撑就 `g.representativeText = clip(errorLineOf(rawQuote), …)`，**没有重新加前缀**；
  - 实测（in-memory，同一 signals、只换 episodes 顺序）：
    ```
    asc : "class:fs-read-before-write · Error: cannot modify /a.txt: file has not been read yet"
    desc: "Error: cannot modify /a.txt: file has not been read yet"
    same text? false | both class-mapped? true
    ```
  - 生产库：`errorKeyOf(text)` 命中 8 类的 claim 共 24 条，其中 **17 条正文没有 `class:` 前缀**（如 `c-04ac6d5a`、`c-1804dc2b`、`c-6d74f391`），7 条有。
- **影响**：① 0.34/0.35 引入的“类级章节文本带类名、便于跨写法命中”被随机破坏，A2b 严格口径（`方案.md` §8.2c：claim 文本与签名 ≥2 判别词重合）对文本敏感，结果会随归档输入顺序漂移；② 实机卡片里同一错误既有 `class:sandbox-limit · Error: Team member limit 8 reached` 又有 `Error: Team member limit 8 reached`（实测 `cli inject` 输出），重复行挤占 500-token 预算。
- **建议动作**：提取一个 `representativeTextFor(kind, key, rawQuote)` 纯函数，建组与“更早支撑”两条路径都走它；补一条“乱序输入 ⇒ 文本一致”的单测（现有测试只覆盖顺序固定的 fixture）；对存量 17 条不做回溯改写（只增不改），在下次归档后由新产出的类级章节覆盖展示。

#### P1-3 `AGENTS.md` 的“当前状态快照”严重过期，会误导下一个接手者

- **现象**：`AGENTS.md:99` 写“当前阶段：M5 收口（0.19.1）”，`:275-287` 写“2026-11-02 · v0.19.1 / M5 收口 / 宿主入口默认关 / 353 条测试 / A2 19.18% / A4 p50 1.23ms / A3 simulated 0/40”；实际是 0.57.0、385 条、`DEFAULT_CONFIG.enabled=true`（`src/plugin.mjs:75`）、A2 26.70%、A4 ~2ms、A3 not-live。
- **证据**：`AGENTS.md:99`、`:275-287`；`package.json:3`；`src/plugin.mjs:75-89`；本报告 C 项实测。
- **影响**：AGENTS 是“必读清单”第 4 位、且被 `check.mjs` 当作必备文件校验；新 agent 会按 0.19.1 的阶段与命令工作，误判“插件默认关”“353 条基线”。
- **建议动作**：把 §7 改成“不写数字、只写去 MAINTENANCE 看”的一句指针（或每次发版同步）；`check.mjs` 增加一条“AGENTS §7 版本号 == package.json version”的结构检查，防止再漂移。

#### P1-4 仓库可见性口径三方矛盾：GitHub 实测 public，`MAINTENANCE.md` 写“私有”

- **现象**：GitHub API 返回 `"private": false, "visibility": "public"`；`MAINTENANCE.md:12` 写“（私有）”，`:54` 的分支保护说明还基于“GitHub 免费私有仓库不支持分支保护（实测 403）”；`AGENTS.md:281` 写“（公开）”。`main` 当前**没有**分支保护（API 404 `Branch not protected`）。
- **证据**：`GET /repos/MYCF711/dsh-GOkifu-longmemory` → `private:false`；`GET /repos/MYCF711/dsh-GOkifu-longmemory/branches/main/protection` → 404；`MAINTENANCE.md:12,54`；`AGENTS.md:281`。
- **影响**：若团队按“私有”前提继续往仓库写内容，实际是公开可见；同时“禁止直推 main”只剩本地 `pre-push` hook（`.git/hooks/pre-push` 存在）+ CI 事后检查，没有服务端拦截。**若“私有”是交付前提，此项应升级为 P0。**
- **建议动作**：先决定可见性并统一三处口径；若保持公开，删除“私有仓库”措辞并确认 privacy-scan 继续作为闸；若转私有，`gh repo edit --visibility private` 后同步 `AGENTS.md:281`。公开仓库可直接开分支保护（不再有“免费私有仓库不支持”的限制），建议对 `main` 开 require-PR + required check `rules`。

#### P1-5 A1 指标是“空转的 0%”，但 `metrics-guard` 仍按硬上限判 PASS

- **现象**：`m5-report` 的 A1 值为 0，但其 caveat 明确写“**0% 是空转的**（带 validity 的条目一条也没被渲染过）；带 validity 的 23 条一次都没被渲染到 ⇒ 覆盖率为 0，0% 不代表没风险；validityCoverage=0.00%（0/23）”。`metrics-guard` 只取 `axes.A1.value` 并判 `a1 > 0.05` 失败（`scripts/metrics-guard.mjs:25,38`），输出 `A1=0` PASS；`MAINTENANCE.md:29` 写“A1 0.00%（≤5%）”不带 caveat。
- **证据**：`node scripts/m5-report.mjs --json` 的 A1 caveat 原文；`scripts/metrics-guard.mjs:25,38`；`MAINTENANCE.md:29`。
- **影响**：唯一的“负迁移硬上限”目前对任何真实输入都不会变红——它是空转通过，不是测出来的 0；将来一旦渲染到带 validity 的 claim，A1 可能突然非 0，而回归闸不会提前预警。
- **建议动作**：在 `judge()` 里把 `validityCoverage==0` 作为 `vacuous:true` 输出（不判 fail，但禁止摘要行只写 `A1=0`）；台账改写成“A1 未覆盖（0/23，空转）”。

### P2 建议

#### P2-1 §12 巩固与实现有偏差（kind 未过滤；对当前产出基本空转；返回值不含 added）

- **现象**：`ensureClassClaims` 不检查 `claim.kind === 'antipattern'`（`src/rooms/claim.mjs:1201-1218`），实测把 `fact` claim（文本 `Cannot find module 'left-pad'`）补成 `kind:antipattern` 的类级 claim；同时它跳过正文以 `class:` 开头的 claim（`:1204-1205`），而当前 `promoteClaim` 对 8 类错误本就产出 `class:` 前缀正文，所以新库里这一步几乎无事可做（`node scripts/class-audit.mjs`：“6 个类 · 已有类级 claim 6 · 缺 0；可折叠单条 0 条”）。
- **证据**：上述行号；`scripts/class-audit.mjs` 输出；`evidence/M7-class-self-healing.md`（该文记录 0.35.0 时确实补过 2 条，属历史迁移效果）。
- **影响**：契约 §12 写“输入 `kind=antipattern`”，实现允许其他 kind；幂等仍成立，但“每次归档都自愈”的叙述与现状不符。
- **建议动作**：加 `claim.kind === 'antipattern'` 过滤；在契约 §12 注明“对 0.34 之后产出的 class: 正文 claim 不再触发，属迁移工具”；`ensureClassClaims` 直接返回 `[...list, ...added]`，避免调用方漏 push（`scripts/archive.mjs:477-481` 现在手动 push）。

#### P2-2 §9 的 `repeat` / `threadIds` / `supersedes` 无生产者

- **现象**：`repeat` 从不落盘（0/303），由 `walk` 读时用 `supportEpisodeCount(claim)` 临时派生（`src/rooms/walk.mjs:902,976,1047`）；`threadIds` 恒 `[]`（`src/rooms/claim.mjs:1036,1243`）；`supersedes` 恒 `null`，没有任何“冲突覆盖链”的生产者（`grep 'supersedes:' src` 只有字面 null 与 gates 的校验代码）。
- **影响**：契约列了字段但库里没有值；读者会以为可以按 `repeat` 排序或按 `supersedes` 追覆盖链，实际都要自己重算或不存在。
- **建议动作**：契约标注“派生字段（读侧计算）/保留字段（暂无生产者）”，或给 `repeat` 在归档时落盘（需先有消费者口径）。

#### P2-3 台账数字不可复现（A2、claim 数、卷数、当天覆盖、六轴无时点）

- **现象**：`MAINTENANCE.md:29` A2 24.32%（实测 26.70%）、A4 p50 2.30ms（实测 1.95–2.23ms），无时点；`:30` claim 295/卷 141（实测 303/143）；`:31` 当天覆盖 18/18（只有 `evidence/M6-D1.md:13` 这一 0.19.0 出处）。
- **影响**：无法用命令复现，交接时会被当成当前事实。
- **建议动作**：六轴行加 `[本] <时间>`；语料行每次巡检用 `cli audit --json` 重采；“当天覆盖”这类一次性指标移到 evidence，不进台账表格。

#### P2-4 门槛下调混在功能刀里，且旧证据未同步

- **现象**：`a2bStrictMin 0.60 → 0.55` 发生在 `36d0121`（提交信息只写“N1 双时态 validFrom/validTo（0.37.0）”）；`CHANGELOG.md:243` 有披露，但 `evidence/M7-metrics-guard.md` 的门槛表仍写 ≥0.60。
- **影响**：审计者只看 commit/证据会看到两套门槛；当前 0.842 远高于两者，无现时风险。
- **建议动作**：更新 `evidence/M7-metrics-guard.md`；今后指标门槛改动单独一刀（commit 首行写 `metrics:`），不要把门槛下调塞进功能提交。

#### P2-5 4 条“真实样本”测试永久跳过

- **现象**：`test/extract.test.mjs:33` 与 `test/graphread.test.mjs:28` 把 `SAMPLE_A` 固定为 `session-00000003-0000-4000-8000-000000000003`；本机 45 个会话目录里没有该 id，仓库里也没有对应 fixture，`hasSample()` 恒 false ⇒ 4 条断言“真实语料”的测试在本机与 CI 都只走 skip。清空 `DSH_HOME` 模拟 CI 时 skipped 从 4 变 11。
- **影响**：真实语料回归覆盖是名义上的；本次 `--test` 的 381 pass 里不含这 4 条。
- **建议动作**：把该样本的 graph 基线 + 必要 delta 固化进 `evidence/samples/`（脱敏后），或删掉这几条、改用合成夹具并改名，避免“真实样本”字样造成误判。

#### P2-6 `DEFAULT_CONFIG` 有重复键，契约键数与 CHANGELOG 不一致

- **现象**：`autoBuild` 在 `src/plugin.mjs:77` 与 `:86` 各写一次（后者覆盖前者，行为无差但会被 lint 抓）；契约 §13 列 16 个键，`CHANGELOG.md:57-58` 说“13 键默认值”，代码 `Object.keys(DEFAULT_CONFIG).length = 18`（多 `createUserMessage`/`deps` 两个测试钩子）。
- **影响**：文档计数不可复核；重复键是纯噪声。
- **建议动作**：删重复键；契约 §13 注明“16 个产品键 + 2 个测试钩子”，CHANGELOG 的“13 键”改成实际数或删数字。

#### P2-7 注入闸的误伤面：`请`/`建议`/`记得` 等高频词会整卡拦截，且没有“被闸拦”遥测

- **现象**：`IMPERATIVE_PATTERNS = ['你应该','请','下一步','建议','务必','记得','不要忘记','可以试试']`（`src/rooms/inject.mjs:36-45`），闸门对整张卡的 `indexLine + section + claims[].text` 扫描，任一处命中就 `ok=false`（`src/rooms/gates.mjs:1030-1046`），插件据此**整卡不注入**。扫生产库：303 条 claim 中 9 条命中（3.0%），其中 2 条在当前工作区；本次 `cli inject` 的渲染没命中它们，所以未复发。
- **影响**：用户原话偏好里“请/建议/你应该/记得”极常见，一旦被 walk 抽中，整张卡（包括其他合规条目）都不会注入；当前没有 counter 记录“本来会注入但被边界闸拦下”，无法评估沉默率。
- **建议动作**：对 `kind=preference` 的逐字引文给一个显式白名单策略（或改用“引文 + 归属”渲染、把祈使语气包在引用里），并在 shadow 遥测里加 `gatesFail`/`blockedBy` 字段。

#### P2-8 边界静态审计脚本缺位

- **现象**：`docs/记忆的职责边界.md:124` 要求“仿压缩仓 `scripts/boundary-audit.mjs`：只扫模型可见字符串字面量”，`AGENTS.md:265` 的目录约定也列了 `boundary-audit`，但 `scripts/` 下没有该脚本；目前只有运行时卡内扫描（`src/rooms/gates.mjs:1030-1046`）。§5 的“首次机器审计必须在 M3 注入上线前跑通”尚未执行（注入未上线，未触发红线）。
- **影响**：无法在 PR 阶段机械检查“新增注入文本里的越界措辞”，只能靠人读。
- **建议动作**：补 `scripts/boundary-audit.mjs`（扫 `src/rooms/inject.mjs` 的模板 + 渲染函数字面量，剥注释），接入 `check.mjs`；注入上线前必须 0 条。

#### P2-9 `main` 无服务端保护（见 P1-4，单列执行项）

- **现象**：`GET .../branches/main/protection` 404；约束依赖本地 `.git/hooks/pre-push`（存在）+ CI 事后检查。
- **影响**：任何有 push 权限的会话/机器可直推 `main`；`MAINTENANCE.md:53-54` 的“禁止直推”不可机械执行。
- **建议动作**：仓库公开后可直接开启分支保护（require PR + required check `rules`）；或在 `release.mjs` 里加“HEAD 提交必须来自 PR merge”的校验。

---

## 未能核实项

1. **历史版本（0.19.1 / 0.36 / 0.43 等）的测试数与六轴数字**：需要 checkout 旧提交重跑，超出“只读当前树”的审计范围，未核。仅核了当前 HEAD 与 `CHANGELOG` 的 0.57.0 段。
2. **“当天覆盖 18/18”**：只在 `evidence/M6-D1.md:13` 出现，当前没有任何脚本/命令能复现这一口径（`m5-report` 的 A2 coverage 85.29% 是另一回事），未核。
3. **D5 影子遥测的真实运行证据**：`evidence/shadow/repeat-hint.jsonl` 现有 11 行全部是 `shadow:false`（旧路径/仿真/测试产物），没有 `shadow:true` 行；0.57.0 新增的“影子模式也记遥测”只有单测覆盖（`test/repeat-report.test.mjs:9-31`），未在真实宿主里跑过，无法核实线上行为。
4. **A3 `live` 可靠性**：插件在 `profiles/desktop/cordis.patch.yml:320-325` 两条 `disabled: true`，从未真实加载；A3 = not-live 属实，线上失败率无法核实。
5. **`supersedes` 覆盖链的实际行为**：生产库无一条 `supersedes` 非空记录，无样本可核；只能静态读 gates 的校验逻辑（`src/rooms/gates.mjs:835-862`）。
6. **CI 的真实运行环境**（ubuntu、无 `DSH_HOME`）只做了本机模拟（清空 `DSH_HOME` → 374 pass / 11 skip / exit 0）；未从 GitHub Actions 日志逐条对照。
7. **上游压缩仓状态**：不在本次审计范围（未读其工作树，未核版本对齐）。

---

## 附：本次实际运行的只读命令（可复核）

```bash
git log --oneline -15 && git status --short
node scripts/check.mjs                       # PASS, exit 0
node --test                                  # 385 / 381 pass / 0 fail / 4 skip, exit 0
DSH_HOME=$(mktemp -d) node --test            # 385 / 374 pass / 0 fail / 11 skip, exit 0（CI 模拟）
node scripts/metrics-guard.mjs               # PASS · A1=0 A5=0 A6=1 A2b=0.8421(n=19) 覆盖=1 p50=2.23ms, exit 0
node scripts/m5-report.mjs --json            # A1 0(vacuous, 0/23) A2 0.2670 A3 not-live A4 p50 1.95ms A5 0 A6 1
node scripts/cli.mjs stats                   # 117 日志 / 45 棋谱 / 1154 主题 / 482 边
node scripts/cli.mjs audit                   # claim 303 / 卷 143 / 过期 22 / 类级主卷 4
node scripts/cli.mjs inject --signal "测试 记忆卡 gates 注入"   # 5 条事实行 + provenance，gates OK
node scripts/class-audit.mjs                 # 6 类 / 6 已有类级 / 缺 0 / 可折叠 0
node scripts/release.mjs --dry-run           # exit 1（tag v0.57.0 已存在，属预期守卫）
npm view dsh-gokifu-longmemory version       # 404 Not Found（未发布）
gh api repos/MYCF711/dsh-GOkifu-longmemory   # private=false, visibility=public
gh api repos/MYCF711/dsh-GOkifu-longmemory/releases?per_page=3   # v0.57.0 已发布
gh api repos/MYCF711/dsh-GOkifu-longmemory/branches/main/protection  # 404 Branch not protected
```
