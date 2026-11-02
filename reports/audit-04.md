# 独立审计报告（audit-04）：随机 10 条陈述实测

> 审计员：独立审计会话（第四次，只查「文档陈述能否当场复现」这一件事）
> 基线：`main` = `3cba0c0`（与 `origin/main` 一致）· `package.json` 0.61.0 · 仓库 `MYCF711/dsh-GOkifu-longmemory`
> 时间：2026-11-02 22:20–22:30（Asia/Shanghai）
> 边界：全程只读；唯一写入本文件。未做任何 git 变更操作；未跑 `archive.mjs`；`metrics-guard` 跑完已 `git checkout -- evidence/metrics-guard.json`（`git status` 收尾为空）。

---

## 抽样过程（文件:行 → 陈述）

### 一、候选池怎么来的（先定池，再随机，不看内容挑）

候选来源限定为任务书指定的 9 份文件，并按行号区间切：

| 文件 | 行区间 | 说明 |
|---|---|---|
| `MAINTENANCE.md` | 1–66 | 全文件 |
| `CHANGELOG.md` | 1–76 | 近 5 个版本段（0.61.0 / 0.60.0 / 0.59.0 / 0.58.0 / 0.57.0，第 77 行起为 0.56.0，故截到 76） |
| `AGENTS.md` | 1–342 | 全文件 |
| `docs/安装指南.md` | 1–89 | 全文件 |
| `docs/数据契约.md` | 1–197 | 全文件 |
| `方案.md` | 1–868 | 任务书写作 `docs/方案`；仓库里 `docs/` 下无「方案」目录/文件，实际为根目录 `方案.md`，按此落地（记录在案） |
| `reports/audit-01.md` | 1–187 | 全文件 |
| `reports/audit-02.md` | 1–219 | 全文件 |
| `reports/audit-03.md` | 1–258 | 全文件 |

**机械候选池**（`node -e` 扫行，规则：该行含 `node|npm|pnpm|git|bash` 命令、或「数字+单位（条/局/卷/%/ms/个/次/行/项/导出/off/秒/万/k）」、或三段式版本号、或反引号包裹的文件名——任一命中即入池；跳过空行与表格分隔行）→ **池容量 452 行**。

### 二、随机抽取（记录原始随机值）

抽法：`Math.random()` × 池长取整（去重），`r` 与 `idx` 如实记录。

| 顺位 | r | idx | 文件:行 | 处置 |
|---|---|---|---|---|
| 1 | 0.658406720817 | 297 | `reports/audit-01.md:182` | **剔除**（见下「换条记录」） |
| 2 | 0.001806650705 | 0 | `MAINTENANCE.md:3` | 采纳 → #1 |
| 3 | 0.041728572145 | 18 | `MAINTENANCE.md:46` | 采纳 → #4 |
| 4 | 0.125688215233 | 56 | `AGENTS.md:38` | 采纳 → #5 |
| 5 | 0.939184171580 | 424 | `reports/audit-03.md:179` | **剔除**（见下） |
| 6 | 0.890032792279 | 402 | `reports/audit-03.md:93` | 采纳 → #7 |
| 7 | 0.014277942509 | 6 | `MAINTENANCE.md:29` | 采纳 → #3 |
| 8 | 0.545766046172 | 246 | `reports/audit-01.md:20` | **剔除**（见下） |
| 9 | 0.209652393000 | 94 | `AGENTS.md:307` | 采纳 → #6 |
| 10 | 0.904973667902 | 409 | `reports/audit-03.md:111` | 采纳 → #8 |

### 三、换条记录（3 条剔除 + 全部补抽，含被拒的补抽）

剔除标准（事先声明）：**该行须是「关于当前仓库状态 / 命令行为 / 文档结构的事实声明」，且能用只读命令当场复现**。三类被排除：① 需要改动仓库状态才能验的；② 历史时点快照（audit 当时的读数，现在必然漂移，验它等于验时间）；③ 纯判定句 / 规格表 / 建议条款（不是事实）。

| 被剔除 | r / idx | 原文要点 | 剔除理由 |
|---|---|---|---|
| `reports/audit-01.md:182` | 0.658406720817 / 297 | `node scripts/release.mjs --dry-run  # exit 1（tag v0.57.0 已存在，属预期守卫）` | **不可当场验证**：`release.mjs:19` 有 `run('git fetch origin main')`，会改 `.git` 的 remote refs，越出本轮「不 git 操作」边界；且 `--dry-run` 仍会跑 `check.mjs` 并 `mkdtemp` 写 notes 文件。换条 |
| `reports/audit-03.md:179` | 0.939184171580 / 424 | audit-02 的 F 项复核：「A2 26.55%≠26.67%、A4 2.03≠2.22、局 116≠117」 | **历史快照**：复现需要 audit-03 当时的台账与测量时点；现在验的是新读数，不构成对该行的证伪或证实。换条 |
| `reports/audit-01.md:20` | 0.545766046172 / 246 | 「**判定：不阻断交付，但需先清 P1（5 项）再宣称审计通过**」 | **非事实**：审计结论/判定句，不属「被声明的事实/命令/数字」；机械池误纳。换条 |

**补抽（按抽中顺序，前两条合格者采纳）**

| 补抽轮次 | r / idx | 文件:行 | 内容 | 结果 |
|---|---|---|---|---|
| R1 | 0.584410970914 / 264 | `reports/audit-01.md:81` | AGENTS 过期快照的影响面 | 拒（审计叙述，事实主体是 0.19.1 历史版本号） |
| R2 | 0.336540451374 / 152 | `方案.md:91` | H3 成本边界阈值表（≤500 tokens/步…） | 拒（规格表，非当前状态事实） |
| C1 | 0.385337779945 / 174 | `方案.md:448` | 定式候选准入规格 | 拒（规格） |
| **C2** | **0.029273398211 / 13** | **`MAINTENANCE.md:41`** | metrics-guard 是回归闸（0.36.0） | **采纳 → #2** |
| C3 | 0.568994516715 / 257 | `reports/audit-01.md:59` | 「或把契约 §9/§14…统一改成…」 | 拒（建议条款） |
| C4 | 0.765468637056 / 345 | `reports/audit-02.md:183` | m5-report 输出快照（A2=0.2681564…） | 拒（历史快照） |
| C5 | 0.920106855135 / 415 | `reports/audit-03.md:125` | ledger-check 台账 0.60.0 · 393/389/0/4 | 拒（历史快照） |
| C6 | 0.322165784427 / 145 | `方案.md:38` | 「跨会话沉淀」现状叙述 | 拒（叙述） |
| **C7** | **0.456998205294 / 206** | **`方案.md:716`** | 「当前基线（116 局 store）…holdout 35.56%（16/45）」 | **采纳 → #10** |
| C8 | 0.646226467528 / 292 | `reports/audit-01.md:177` | m5-report 输出快照 | 拒（历史快照） |
| **D1** | **0.970269124493 / 438** | **`reports/audit-03.md:226`** | 调研 17 = 0.55.0、调研 18 = 0.56.0 | **采纳 → #9** |

> 说明：池里三类「不可当场验证」的行占比较高（452 条里大量是审计历史读数与规格表），因此补抽了 11 次才凑满 3 条合格替补。**采纳的 10 条中 7 条来自首轮 10 抽**（2、3、4、6、7、9、10 顺位），3 条来自补抽（C2 / C7 / D1），全部随机值如上，未按难易挑选。

### 四、最终 10 条（文件:行 → 陈述）

| # | 文件:行 | 陈述（原文截取 ≤80 字） |
|---|---|---|
| 1 | `MAINTENANCE.md:3` | 「仓库维护准则继承 `MYCF711/magpie-plugin-scaffold`：**禁止直推 main**；功能分支 → PR → 必需检查全绿 → 合并」 |
| 2 | `MAINTENANCE.md:41`（补抽 C2） | 「**`node scripts/metrics-guard.mjs` 是回归闸**（0.36.0）：每轮先跑，不达标先修再谈优化。」 |
| 3 | `MAINTENANCE.md:29` | 「语料 \| 117 局 / **143 卷** / **claim 322**（有效期已止 25；26 条为 0.58 前历史记录，无 `validFrom`…）」 |
| 4 | `MAINTENANCE.md:46` | 「装完跑 `node scripts/first-live.mjs` 生成首份上线复盘（当前 `liveReady=false`）。」 |
| 5 | `AGENTS.md:38` | 「\| 3 \| `docs/拷问记录.md` \| 已裁定决策 + 自裁清单（技术细项自裁，方向问题才问）\|」 |
| 6 | `AGENTS.md:307` | 「**每个功能实现都升版本**：`CHANGELOG.md` 写清更新内容（用户可读），`package.json` 同步版本。」 |
| 7 | `reports/audit-03.md:93` | 「T33 … **现场实跑 dry-run 输出「摘除 3 条」** … **PASS**」 |
| 8 | `reports/audit-03.md:111` | 「**卷错** `**141 卷**` \| FAIL \| **FAIL(抓住)** `卷：台账 141 vs 实测 143`」 |
| 9 | `reports/audit-03.md:226`（换条 D1） | 「T36 标题写「调研 15–18」，但调研 17 = **0.55.0**、调研 18 = **0.56.0**（`CHANGELOG.md` 段首已证）」 |
| 10 | `方案.md:716`（换条 C7） | 「**当前基线**（116 局 store，`node scripts/m5-report.mjs`）：holdout 35.56%（16/45）；A2b 覆盖 100%（19/19）」 |

---

## 逐条结果表

| # | 陈述 | 命令 | 输出摘要 | 判定 |
|---|---|---|---|---|
| 1 | 公开仓库；禁止直推 main（PR + 必需检查） | `gh api` 等价：GitHub API `GET /repos/MYCF711/dsh-GOkifu-longmemory`、`/rulesets`、`/rulesets/26369698`；`git rev-parse HEAD origin/main` | `private:false` `visibility:"public"` `default_branch:"main"`；ruleset `main-protection` `enforcement:"active"`，`include:["~DEFAULT_BRANCH"]`，规则 = `pull_request` + `required_status_checks{context:"rules", strict:true}` + `deletion` + `non_fast_forward`，`bypass_actors:[]` `current_user_can_bypass:"never"`；`HEAD = origin/main = 3cba0c0` | **PASS** |
| 2 | `metrics-guard.mjs` 是回归闸，0.36.0 引入，不达标退出 1 | `node scripts/metrics-guard.mjs`；`node --test test/metrics-guard.test.mjs`；`sed -n '/^## 0.36.0/,…/p' CHANGELOG.md`；`grep LIMITS scripts/metrics-guard.mjs` | `metrics-guard PASS · A1=0 A5=0 A6=1 A2b严格=0.8421052631578947（n=19） 覆盖=1 p50=2.24ms`，exit 0；单测 `pass 5 / fail 0`；CHANGELOG「## 0.36.0 … ### 指标护栏 `scripts/metrics-guard.mjs` - 一条命令判定 A1/A5/A6/A4/A2b：**不达标退出 1**」；脚本内 `LIMITS = {a1Max:0.05, a5Max:0, a6Min:1, a4p50MaxMs:50, a2bStrictMin:0.55, a2bCoverMin:1}` | **PASS** |
| 3 | 语料 117 局 / 143 卷 / claim 322（有效期已止 25；26 条无 `validFrom` 但都有 `occurredAt`） | `node scripts/cli.mjs audit`；`ls $DSH_HOME/memory-context/{episodes,claims,threads} \| wc -l`；`node -e` 逐条统计 claims；`node scripts/ledger-check.mjs --full` | `claim 322 条 · 状态 observed=286 · candidate=36`；`被遮蔽：过期(validityOk=false) 25 … 有效期已止 25`；`卷 143 个 · 类级主卷 4 个`；目录实数 `episodes 117 / claims 322 / threads 143`；claims 统计 `322 条 · withValidFrom 296 · withoutValidFrom 26 · without occurredAt 0`；`ledger-check：台账 0.61.0 · 测试 394/390/0/4 · claim 322 · 卷 143` = `实测：…`，`PASS` exit 0 | **PASS** |
| 4 | `first-live.mjs` 可跑，当前 `liveReady=false` | `node scripts/first-live.mjs --out $TMP/first-live.md --json`（输出到仓库外临时目录，不动 `evidence/`） | `{"outFile":"…\\Temp\\…\\first-live.md","liveReady":false,"disabled":4,"guardOk":true}`，exit 0；生成文件第 4 行「结论：**尚未上线（见下）**」 | **PASS** |
| 5 | `docs/拷问记录.md` 存在，含「已裁定决策」+「自裁清单」 | `ls -l docs/拷问记录.md`；`grep -n "^## \|自裁清单" docs/拷问记录.md` | 文件存在（23,789 字节）；Q1–Q7、Q13、Q16、Q18 等小节带「✅ 已裁定」；第 196 行 `## 自裁清单（2026-11-02 · 按新规）`，第 191 行给出「技术细项 → 自裁」判据 | **PASS** |
| 6 | 每个功能实现都升版本：CHANGELOG 写清、`package.json` 同步 | `node -e "p=require('./package.json');…"`；`git tag -l`；`node -e` 比对 tags ↔ CHANGELOG 段首 | `version 0.61.0 · private true · name dsh-gokifu-longmemory`；`tags: 65 · changelog sections: 71`；**`tags without CHANGELOG section: none`**；反向 `sections without tag: 1（0.14.0）`；最新三节 `0.61.0 / 0.60.0 / 0.59.0` | **PASS**（注：`0.14.0` 段无 tag，早于「tag + Release」制度，`MAINTENANCE.md` 已发布清单亦从 0.15.0 起） |
| 7 | `re-enable.mjs --dry-run` 输出「摘除 3 条」 | `node scripts/re-enable.mjs --dry-run`；随后 `git status --porcelain` | `禁用条目: 摘除 3 条` / `[dry-run] patch 将改: true · package.json 将改: true`，exit 0；运行后工作树**无变更**（确认 dry-run 不写盘）。profile 侧对应 2 条 `disabled: true`（`kifu-longmemory` + `dsh-gokifu-longmemory`）+ 1 条注释 = 3 条 | **PASS** |
| 8 | audit-03 曾抓出「台账 141 卷 vs 实测 143」 | `node scripts/cli.mjs audit`；`ls $DSH_HOME/memory-context/threads \| wc -l` | `卷 143 个 · 类级主卷 4 个`；`threads/` 实数 143 | **PASS**（可核部分「实测 143」精确复现；「台账 141」是 audit 时点快照，另见「未能当场验证」） |
| 9 | 调研 17 = 0.55.0、调研 18 = 0.56.0 | `grep -n "调研 1[5-9]" CHANGELOG.md`；`sed -n '/^## 0.56.0/,/^### /p'`、`/^## 0.55.0/` | `## 0.56.0（2026-11-02）` → `### 调研 18：CoALA…`；`## 0.55.0（2026-11-02）` → `### 调研 17：Hindsight 的实际机制…`；0.61.0 段已把 T36 收窄为「调研 15–16」、T38 改为「调研 17–18」 | **PASS** |
| 10 | 「当前基线」= 116 局 store；holdout 35.56%（16/45）；A2b 覆盖 100%（19/19） | `node scripts/m5-report.mjs --json`（同日连跑 3 次） | `corpus.episodes = 117`（**≠116**）；`A2.detail.holdout = {testEpisodes:9, repeat:22, novel:43, n:65, rate:0.3384615…}` → **33.85%（22/65）≠35.56%（16/45）**，3 次一致；`injectionRecall.recall = 1` → 覆盖 100%（19/19）✔；`recallSpecific = 0.8421`（16/19）✔ | **FAIL** |

---

## 命中率与结论（10/10 才可称"文档可信任"）

**命中率：9 / 10 = 90%。未达 10/10，按本仓既定标准不构成「文档可信任」，不可宣称「按它安装、照它复现」全绿。**

- 唯一 FAIL：`方案.md:716` §8.2c「**当前基线**（116 局 store…）：holdout 35.56%（16/45）」—— 实测 store 已 117 局，同一条命令给出 **33.85%（22/65）**。该行**没有时点标注**，又用了「当前基线」措辞，读者会当成现在能复现的数；同一行的「A2b 覆盖 100%（19/19）」「A2b 严格 84.2%（16/19）」「门槛 ≥0.55」三项**仍然精确复现**（`LIMITS.a2bStrictMin = 0.55`），属于**部分过期**而非整段失真。
- 9 条 PASS 的分布是健康的：`MAINTENANCE.md` 的语料口径（局/卷/claim/有效期已止/26 条无 `validFrom`）**逐项对得上**，且 `ledger-check --full` 现场 PASS；平台侧事实（public + ruleset + `rules` required check + `bypass_actors: []`）与文档完全一致；两个脚本行为（`re-enable --dry-run` 摘除 3 条且不写盘、`first-live` 给出 `liveReady=false`）实跑复现；`AGENTS.md` 的结构性声明（拷问记录含自裁清单、每版 CHANGELOG + tag 同步）也成立。
- **风险集中在审计/方案类文档的「当前」字样上**：`MAINTENANCE.md` 有 `ledger-check --full` 机械闸（含容差）兜着，`方案.md` / `安装指南.md` **没有任何闸**，而它们恰恰是「按它安装」时最先被读的两份（见附记）。

**判定：有条件不通过（9/10）。** 修掉第 10 条（给 `方案.md` §8.2c 基线补时点，或改跑 `ledger-sync` 生成现值），并处理附记里两处同类过期后，可再请一轮抽验；只修这一条而不加闸，下一轮同类漂移会以同样的方式复现。

---

## 未能当场验证项（如有）

| 陈述 | 为什么不能当场验 | 处理 |
|---|---|---|
| `reports/audit-01.md:182`：`node scripts/release.mjs --dry-run # exit 1（tag v0.57.0 已存在，属预期守卫）` | `release.mjs:19` 执行 `git fetch origin main`（改 `.git` remote refs），且 `--dry-run` 仍会跑 `check.mjs`、`mkdtemp` 写 notes 文件 → 越出本轮「只读 + 不 git 操作」边界。间接佐证（未据此判 PASS）：`git tag -l` 显示 `v0.57.0` 确实存在；`release.mjs:44` 确为 `if (out('git tag -l ' + tag)) { …exit(1) }` 的守卫 | 判「不可当场验证」，按规则换条（→ #9） |
| `reports/audit-03.md:111` 的「台账 141 卷」一半 | 「141」是 audit-03 时点 `MAINTENANCE.md` 里的值，现在文档已改为 143；复现它需要取回 audit-03 时刻的工作树快照 | 只对「实测 143」这一半判定（已复现），历史一半标为不可复现 |
| `reports/audit-03.md:179`（首轮第 5 抽） | 同上：A2 26.55%/26.67%、A4 2.03/2.22、局 116/117 全是 audit 时点读数 | 剔除换条（→ #10） |
| `AGENTS.md:307` 里「历史每个版本的 `package.json` 都同步」 | 现只有当前 `package.json`；逐 tag 校验需要对 65 个 tag 做 `git show`，超出本轮只读范围 | 只验「当前版本三方一致 + 所有 tag 都有 CHANGELOG 段」（已 PASS） |

---

## 附记（不计入命中率，但影响「按它安装」的判断）

1. **`docs/安装指南.md` 首页数字过期**（这份正是「按它安装」要读的那一页）：
   - 第 4 行「当前版本：`0.50.0`」→ 实测 `package.json` = **0.61.0**（差 11 个版本）。
   - 第 10 行「`node --test` 必须全绿（当前 379 条）」→ 实测 **394 / 390 pass / 0 fail / 4 skip**，exit 0。
2. **`方案.md:26`「本机语料 86 个会话日志」** → 实测 `find "$DSH_HOME/sessions" -name '*.zstd' | wc -l` = **134**。
3. **台账 A2 有 0.14pp 的确定性偏差，容差 0.5pp 放过**：`MAINTENANCE.md` 写 A2 **26.63%**，本次连跑 3 次均为 **0.264865…（26.49%）**（A2 是确定性的，3 次完全一致，不是抖动）；差值 0.14pp < `ledger-check` 的 0.5pp 容差，故 `--full` 仍 PASS。建议 A2 改零容差（A4 保留容差，它确在 2.01/2.03/2.13 之间抖）。
4. 本轮所有实跑均未改动仓库：`git status --porcelain` 收尾为空（`evidence/metrics-guard.json` 已按规程 `git checkout --` 复原，diff 为 `at` 时间戳与 `a4.p50 2.17→2.24`，属噪声）。
