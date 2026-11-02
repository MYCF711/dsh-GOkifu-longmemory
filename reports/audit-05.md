# 独立审计报告（audit-05）：第二轮随机 10 条实测

> 审计员：独立审计会话（第五次，只查「文档陈述能否当场复现」这一件事）
> 基线：`main` = `512df67`（= `origin/main`）· `package.json` 0.62.0 · 仓库 `MYCF711/dsh-GOkifu-longmemory`
> 时间：2026-11-02 22:45–23:05（Asia/Shanghai）
> 边界：全程只读；**唯一写入本文件**。未做写操作类 git 命令（只用了 `git status` 与任务明确要求的 `git checkout -- evidence/metrics-guard.json`）；未跑 `archive.mjs`；`docs/调研/**` 全程未读未动。
> 与上一轮的关系：**重新建池、重新随机**，候选池容量与构成都与 audit-04 不同（646 vs 452），10 条采纳项与 audit-04 的 10 条**零重叠**；未因 audit-04 在 `方案.md` 上 FAIL 而回避同类（`方案.md` 本身不在本轮任务书指定的池内，见 §抽样过程·一）。

---

## 抽样过程（随机数与行号）

### 一、候选池（先定池、再随机，不看内容挑）

按任务书指定的文件与区间切行：

| 文件 | 行区间 | 池内行数 | 说明 |
|---|---|---|---|
| `MAINTENANCE.md` | 1–66 | 28 | 全文件 |
| `CHANGELOG.md` | 5–80 | 29 | 0.62.0–0.58.0 段（0.58.0 起于 65 行，0.57.0 起于 81 行，故截到 80） |
| `AGENTS.md` | 1–342 | 91 | 全文件 |
| `docs/安装指南.md` | 1–90 | 22 | 全文件 |
| `docs/数据契约.md` | 1–197 | 45 | 全文件 |
| `docs/记忆的职责边界.md` | 1–169 | 39 | 全文件 |
| `reports/audit-01.md` | 1–187 | 77 | 全文件 |
| `reports/audit-02.md` | 1–219 | 83 | 全文件 |
| `reports/audit-03.md` | 1–258 | 125 | 全文件 |
| `reports/audit-04.md` | 1–139 | 71 | 全文件（本轮新增进池） |
| `scripts/*.mjs` 顶部注释块 | 见下 | 27 | 23 个脚本的**首部连续注释块**（跳过 shebang）；只有 5 个脚本的注释行命中机械规则 |
| **合计** | | **646** | |

脚本注释块取法（机械）：每个 `scripts/*.mjs` 从文件头起，取第一段连续 `//`、`/*`、`*` 行（上限 60 行内定位）。命中入池的 5 个：`archive.mjs:2-23`、`eval.mjs:2-29`、`gates-check.mjs:2-20`、`ledger-check.mjs:2-13`、`m5-report.mjs:2-22`。

**入池规则**（与 audit-04 同口径，脚本一次性扫描）：该行命中任一即入池 —— ①含 `` `…` `` 包裹片段；②含 `node|npm|pnpm|git|gh|bash`；③含「数字+单位（条/局/卷/%/ms/个/次/行/项/导出/off/秒/万/k/字/pp/天/小时）」；④含三段式版本号。跳过空行、表格分隔行（`|---|---|`）、代码围栏行（` ``` `）。

> **池的构成偏差（本轮先声明）**：646 行里 **356 行（55.1%）来自 `reports/audit-0*.md`**。审计报告天然全是「当时的读数」，所以机械随机有约一半概率抽到不可复现的历史快照 —— 这解释了本轮补抽 18 次才凑满 10 条，不是挑难的，是池子结构如此（见 §附记 3）。

### 二、随机抽取（原始随机数与下标，28 抽全部记录）

抽法：`Math.random()`（Node v 默认实现）→ `idx = Math.floor(r × 646)`，按下标去重；池内顺序 = 上表文件顺序 + 行号升序。采纳项**严格按抽取顺序取前 10 条合格者**。

#### 第一批（10 抽）

| 顺位 | r | idx | 文件:行 | 处置 |
|---|---|---|---|---|
| 1 | 0.492794686978 | 318 | `reports/audit-01.md:141` | 剔除（①建议动作） |
| 2 | 0.851378450269 | 549 | `reports/audit-04.md:26` | 剔除（④抽样过程元数据） |
| 3 | 0.919918930470 | 594 | `reports/audit-04.md:104` | **采纳 → #1** |
| 4 | 0.933313472374 | 602 | `reports/audit-04.md:127` | 剔除（④抽样过程元数据） |
| 5 | 0.424103547354 | 273 | `reports/audit-01.md:54` | 剔除（③历史时点读数） |
| 6 | 0.064157077147 | 41 | `CHANGELOG.md:40` | **采纳 → #2** |
| 7 | 0.689557051505 | 445 | `reports/audit-03.md:64` | **采纳 → #3** |
| 8 | 0.167312090400 | 108 | `AGENTS.md:253` | **采纳 → #4** |
| 9 | 0.182683313539 | 118 | `AGENTS.md:285` | **采纳 → #5** |
| 10 | 0.125379817575 | 80 | `AGENTS.md:73` | 剔除（②规格条款） |

#### 第二批（补抽 8 抽）

| 顺位 | r | idx | 文件:行 | 处置 |
|---|---|---|---|---|
| R1 | 0.515929537908 | 333 | `reports/audit-02.md:7` | 剔除（③历史行为声明） |
| R2 | 0.524133729444 | 338 | `reports/audit-02.md:20` | 剔除（③历史时点读数） |
| R3 | 0.500560105827 | 323 | `reports/audit-01.md:152` | 剔除（③历史时点状态） |
| R4 | 0.371315951439 | 239 | `docs/记忆的职责边界.md:107` | 剔除（②边界规格） |
| R5 | 0.149675169729 | 96 | `AGENTS.md:225` | **采纳 → #6** |
| R6 | 0.962120275400 | 621 | `scripts/eval.mjs:7` | **采纳 → #7** |
| R7 | 0.719334636181 | 464 | `reports/audit-03.md:96` | 剔除（③历史判定） |
| R8 | 0.708123443263 | 457 | `reports/audit-03.md:80` | 剔除（④过程元数据/标题） |

#### 第三批（补抽 10 抽，凑满最后 3 条）

| 顺位 | r | idx | 文件:行 | 处置 |
|---|---|---|---|---|
| C1 | 0.841791856868 | 543 | `reports/audit-04.md:20` | 剔除（④抽样过程元数据） |
| C2 | 0.299077547731 | 193 | `docs/数据契约.md:116` | **采纳 → #8** |
| C3 | 0.624173523928 | 403 | `reports/audit-02.md:201` | **采纳 → #9** |
| C4 | 0.457680660510 | 295 | `reports/audit-01.md:91` | 剔除（③历史缺陷记录） |
| C5 | 0.448886346089 | 289 | `reports/audit-01.md:82` | 剔除（①建议动作） |
| C6 | 0.071871648380 | 46 | `CHANGELOG.md:59` | **采纳 → #10** |
| C7 | 0.300959846717 | 194 | `docs/数据契约.md:123` | 合格但**超额未采纳**（第 11 条，按「取前 10 条合格者」规则让位） |
| C8 | 0.123832613635 | 79 | `AGENTS.md:72` | 剔除（②禁止项条款） |
| C9 | 0.455566066388 | 294 | `reports/audit-01.md:89` | 剔除（①建议动作） |
| C10 | 0.944123101709 | 609 | `reports/audit-04.md:139` | 剔除（③历史行为声明） |

### 三、换条记录（剔除理由，事先定标准再判）

剔除标准（先声明、后执行，且**在核对真值之前**就判定）——该行必须是「关于当前仓库状态 / 命令行为 / 文档内容的事实断言」，且能用只读命令当场复现。四类排除：

- **①** 建议动作 / 判定结论（不是事实，是意见）；
- **②** 规格条款、边界禁止项（写的是「应当/必须/禁止」，不是「现在是什么」）；
- **③** 历史时点读数 / 历史行为声明（审计当时的测量值，现在必然漂移，验它等于验时间）；
- **④** 抽样过程元数据（「本次怎么抽的」「为什么剔除某条」这类讲方法自身的表格行）。

| 被剔除 | 原文要点（≤40 字） | 剔除理由 |
|---|---|---|
| `audit-01.md:141` | 「建议动作：对 kind=preference 的逐字引文给显式白名单策略…」 | ①建议 |
| `audit-04.md:26` | 「\| reports/audit-03.md \| 1–258 \| 全文件 \|」 | ④audit-04 自己的抽样范围表 |
| `audit-04.md:127` | 「audit-03:179（首轮第 5 抽）… 剔除换条」 | ④过程记录 |
| `audit-01.md:54` | 「实测统计（读 sidecar）：{claims:303, hasValidFrom:302…}」 | ③0.19 期读数（现 store 322），无法复现当时值 |
| `AGENTS.md:73` | 「时间戳是一等字段：每条记忆带 occurredAt…」 | ②规则条款 |
| `audit-02.md:7` | 「只读声明：除本文件外未写任何仓库文件…」 | ③过去的行为声明，不可事后复核 |
| `audit-02.md:20` | 「node --test 388 条（384 pass…）、cli audit 322 claim / 143 卷」 | ③测试数已 394，属当时快照 |
| `audit-01.md:152` | 「任何有 push 权限的会话/机器可直推 main…」 | ③当时平台状态（ruleset 尚未开），今已变 |
| `职责边界.md:107` | 「宿主 agent/pre-step：注入点…不抢压缩的替换点」 | ②边界规格 |
| `audit-03.md:96` | 「「P1 全修」为假：MAINTENANCE.md:54 仍写私有仓库…」 | ③历史判定（0.61.0 已修） |
| `audit-03.md:80` | 「### ③ 计划表.md T22–T38 每行 vs CHANGELOG（抽 13 行）」 | ④方法标题，无断言可验 |
| `audit-04.md:20` | 「\| AGENTS.md \| 1–342 \| 全文件 \|」 | ④抽样范围表 |
| `audit-01.md:91` | 「P1-5 A1 是空转的 0%，但 metrics-guard 仍按硬上限判 PASS」 | ③历史缺陷记录 |
| `audit-01.md:82` | 「建议动作：把 §7 改成不写数字的指针…」 | ①建议 |
| `audit-01.md:89` | 「建议动作：先决定可见性并统一三处口径…」 | ①建议 |
| `AGENTS.md:72` | 「禁止从摘要再抽取：抽取输入只能是原始事件/棋谱边」 | ②禁止项 |
| `audit-04.md:139` | 「本轮所有实跑均未改动仓库…」 | ③过去行为声明 |

> `docs/数据契约.md:123` 判为合格但超额（第 11 条），已在 C7 记录原始随机值，未纳入命中率。

### 四、最终 10 条（原文 ≤80 字）

| # | 文件:行 | 陈述（原文截取） |
|---|---|---|
| 1 | `reports/audit-04.md:104` | 「调研 17 = **0.55.0**、调研 18 = **0.56.0**…0.61.0 段已把 T36 收窄为「调研 15–16」、T38 改为「调研 17–18」」 |
| 2 | `CHANGELOG.md:40` | 「同时校验 `AGENTS.md` §7 仍是指针、`CHANGELOG.md` 有当前版本段。」 |
| 3 | `reports/audit-03.md:64` | 「读码 `:73` 捕获异常 → `actual.claim=null`；`:82` `skippedCorpus: actual.claim === null`；文本档 `:85` 打印「（无 store，跳过语料核对）」」 |
| 4 | `AGENTS.md:253` | 「\| 方案与方向 \| `方案.md` \|」 |
| 5 | `AGENTS.md:285` | 「\| 实测证据 \| `evidence/`（最近的文件带日期）\|」 |
| 6 | `AGENTS.md:225` | 「版本：`memoryGraph.version`；`fromJSON` 对未知版本必须抛错。」 |
| 7 | `scripts/eval.mjs:7` | 「入口：`runEval({dataRoot, storeRoot, source}) -> report`；纯函数 `evaluateLoo(records)` 可单独测。」 |
| 8 | `docs/数据契约.md:116` | 「任何 sidecar 读取先校验 manifest；缺 manifest → 拒绝并提示 `rebuild`。」 |
| 9 | `reports/audit-02.md:201` | 「「`metrics-guard` 增 `a1Vacuous/a1Coverage`，摘要行标空转」\| ✔ 实跑可见」 |
| 10 | `CHANGELOG.md:59` | 「26 条 `validFrom=null` 的 claim **都有 `occurredAt`**…已改 CHANGELOG/契约/台账」 |

---

## 逐条结果表

| # | 陈述 | 验证命令 | 输出摘要 | 判定 |
|---|---|---|---|---|
| 1 | 调研 17 = 0.55.0、调研 18 = 0.56.0；0.61.0 段收窄 T36 / 改 T38 | `grep -n "调研 1[5-9]" CHANGELOG.md`；`grep -n "^## 0\." CHANGELOG.md` | `93:### 调研 18：CoALA…`（0.56.0 段 = 91–100 行）、`103:### 调研 17：Hindsight 的实际机制…`（0.55.0 段 = 101–111 行）、`51:### 调研 19：HippoRAG`（0.59.0 段 = 49–64）；0.61.0 段（19–35 行）第 28–29 行：「T36 区间收窄为调研 15–16；T38 改为「调研 17–18 + 三轮审计 + 台账自证」」 | **PASS** |
| 2 | `ledger-check` 校验 AGENTS §7 是指针 + CHANGELOG 有当前版本段 | `node scripts/ledger-check.mjs --full`；`awk 'NR>=129&&NR<=145' scripts/ledger-check.mjs` | 实跑：`ledger-check：台账 0.62.0 · 测试 394/390/0/4 · claim 322 · 卷 143` / `实测：0.62.0 · 394/390/0/4 · 322 · 143` / `ledger-check: PASS` exit 0。代码：`:131` 截 §7 文本、`:132` `agentsOk = agents.includes('本节的旧快照会过期') && !sec7.includes('条测试')`、`:136` 不满足即 `bad.push`、`:137` `if (!read('CHANGELOG.md').includes('## '+actual.version)) bad.push(...)` | **PASS** |
| 3 | `ledger-check.mjs` 的 `:73` 捕获异常→`claim=null`、`:82` `skippedCorpus`、`:85` 打印「（无 store，跳过语料核对）」 | `awk 'NR>=70&&NR<=90' scripts/ledger-check.mjs`；`grep -n "skippedCorpus\|无 store，跳过语料核对\|claim" scripts/ledger-check.mjs` | **三处行号全部对不上**：`73: const t = Date.parse(...)`（在 `fullCheck` 里）、`82: const invoked = ...`、`85: const full = process.argv.includes('--full')`。行为仍在但已移位：`105–110` try/catch 语料读取（catch 后 `actual.claim` 保持初值 `null`）、`139` `skippedCorpus: actual.claim === null`、`142` 打印 `（无 store，跳过语料核对）`。旁证：同一表 2.1 行引用的 `:39-50` 现为 `46-63`（`compare()` 的当前位置） | **FAIL** |
| 4 | AGENTS 记账表：方案与方向 → `方案.md` | `ls -l 方案.md`；`awk 'NR>=250&&NR<=256' AGENTS.md` | `-rw-r--r-- 69929 Nov 2 22:39 方案.md`；第 253 行正是 `\| 方案与方向 \| 方案.md \|`（§6 记账路径表内） | **PASS** |
| 5 | 实测证据 → `evidence/`，最近的文件带日期 | `ls -t evidence/ \| head -4`；对最近 4 个文件 `grep -n "2026-11-0"` | `evidence/` 实存（`total 254`，20+ 文件）；最新 4 个：`metrics-guard.json` → `"at": "2026-11-02T13:40:55.076Z"`；`M7-ledger-check.md:1` → `（2026-11-02）`；`M7-audit-01-fixes.md:1` → `（2026-11-02）`、`:39` `（2026-11-02 21:35）`；`M7-metrics-guard.md:1` → `（metrics-guard，2026-11-02）` | **PASS**（日期在**内容**里，文件名不含日期） |
| 6 | `fromJSON` 对未知版本必须抛错 | `node -e "import('./src/rooms/graphread.mjs').then(m=>console.log(Object.keys(m).sort().join(', ')))"`；`grep -rn "fromJSON" src/ scripts/ test/`；`node --test test/graphread.test.mjs` | 导出面：`DELTA_SCALARS, DELTA_VERSION, GRAPH_VERSION, applyDelta, baseHashOf, checksum31, decodeDeltaFrames, loadGraphAt, rebuildStateIndex` —— **无 `fromJSON`**；`grep fromJSON src/ scripts/ test/` → 无匹配（只在 `AGENTS.md:225`、`数据契约.md:115`、`docs/调研/**` 出现）。等价守卫实跑：`✔ 版本未知：基线 version=2 → 抛 graphread: unsupported version（fail-closed）`、`✔ 版本未知：delta 帧 v=2 → 抛 graphread: unsupported delta version`；`tests 16 / pass 14 / fail 0 / skipped 2` | **PASS**（按**行为**判定；命名另有问题，见附记 2） |
| 7 | `runEval({dataRoot,storeRoot,source})->report`；`evaluateLoo` 纯函数可单测 | `awk 'NR>=464&&NR<=480' scripts/eval.mjs`；`grep -n "evaluateLoo" test/eval.test.mjs`；`awk 'NR>=261&&NR<=407' scripts/eval.mjs \| grep "fs\.\|Date.now\|Math.random\|process\."` | `runEval` 从 `opts.dataRoot / opts.storeRoot / opts.source` 取值（`:466-468`），`const report = {...}`（`:592`）、`return report`（`:637`）；`test/eval.test.mjs:107/134/146/155` 直接以数组调用 `evaluateLoo([...])`；该函数体 147 行内**无** `fs.` / `Date.now` / `Math.random` / `process.`（grep 无输出） | **PASS** |
| 8 | sidecar 读取先校验 manifest；缺 manifest → 拒绝并提示 `rebuild` | `mkdir -p /tmp/nostore05 && node scripts/cli.mjs verify --store /tmp/nostore05 --json` | `{"ok": false, "errors":[{"code":"manifest/missing","path":"manifest.json","message":"memoryRoot 里没有 manifest.json：不是已入馆的记忆库","hint":"在这个目录跑一次 rebuild（或重新入档）"}, …]}`，`manifest: null`，`checked.files=0`，exit 1 | **PASS**（在 `verify` 闸上复现；见「未能当场验证项」关于「任何读取」全称的部分） |
| 9 | `metrics-guard` 增 `a1Vacuous/a1Coverage`，摘要行标空转 | `node scripts/metrics-guard.mjs`；`grep -o "a1Vacuous\|a1Coverage\|空转" evidence/metrics-guard.json`；随后 `git checkout -- evidence/metrics-guard.json` | stdout：`metrics-guard PASS · A1=0（空转：validity 覆盖 0） A5=0 A6=1 A2b严格=0.8421052631578947（n=19） 覆盖=1 p50=2.19ms` exit 0；产物字段计数 `1 a1Coverage / 1 a1Vacuous`（两个字段都在 JSON 里）；摘要行含「空转」 | **PASS** |
| 10 | 26 条 `validFrom=null` 的 claim 都有 `occurredAt` | `node -e`：遍历 `$DSH_HOME/memory-context/claims/*.json`，统计 `validFrom` 空 / `occurredAt` 缺 | `claim 文件数 = 322`；`validFrom 为空 = 26`；`其中 occurredAt 也缺 = 0`；`occurredAt 缺总数 = 0` | **PASS** |

---

## 命中率与结论

**命中率：9 / 10 = 90%（与上一轮同分，但失分点换了一族）。**

| 判定 | 条数 | 条目 |
|---|---|---|
| PASS | 9 | #1 #2 #4 #5 #6 #7 #8 #9 #10 |
| FAIL | 1 | #3（`reports/audit-03.md:64` 的三处裸行号引用） |
| 存疑 | 0 | — |

### 唯一 FAIL 的定性

`reports/audit-03.md:64` 断言的不是「某行为存在」，而是「**某行为在第 73/82/85 行**」。这三处行号在 0.61.0 给 `ledger-check` 加 `--full` / 容差 / 安装指南守卫后整体下移：现在 `:73` 是 `fullCheck` 里的 `Date.parse`、`:82` 是 `const invoked`、`:85` 是 `const full`。**行为本身完好**（`:105-110` 捕获异常并使 `actual.claim` 保持 `null`、`:139` `skippedCorpus`、`:142` 打印「（无 store，跳过语料核对）」三项逐一存在），所以这是一条**引用失效**而非事实失真 —— 但它照样使「照文档当场复现」落空：读者跳到 `:73` 看到的是一行日期解析，无法据此复核 audit-03 当时那条 PASS。

同一现象在同一张表里出现了第二次：2.1 行引用 `scripts/ledger-check.mjs:39-50`，`compare()` 现在位于 `46-63`。**这是审计报告文体层面的系统缺陷**：用裸行号当锚，每次改代码都会烂一批引用，且烂得没有任何闸会红（`check.mjs` / `ledger-check` 都不校验报告里的行号）。

建议修法（一条即可覆盖全部）：报告里一律用「文件 + 函数名/导出名 + 大致区间」，或写成「`skippedCorpus`（现位于 `:139`）」。`AGENTS.md` §2.5 已经对上游立了这条规矩（「引用它的行号前先 `git status`…只引用文件 + 函数名 + 大致位置」），**同一条规矩没有用到自己的报告上**。另外可以在 `check.mjs` 加一条廉价守卫：报告内若出现 `` `scripts/*.mjs:NN` ``，要求该行附近 3 行内出现被引用的标识符（或干脆禁止裸行号）。

### 其余 9 条为什么成立（分布健康度）

- **跨轮复核成功**：#1 把 audit-04 自己的 PASS 结论又验了一遍（调研 18 在 0.56.0 段 `:93`、调研 17 在 0.55.0 段 `:103`、T36/T38 的收窄写在 0.61.0 段 `:28-29`），结论仍成立 —— 说明上一轮那条 PASS 不是自说自话。
- **闸的自证链是活的**：#2 不只是「代码里有这两个检查」，而是 `--full` 现场 PASS 且台账三方（版本/测试四分量/claim/卷）逐项对齐；`:137` 那条 CHANGELOG 段存在性检查确实在 `bad` 里，不是死代码。
- **数据面口径精确**：#10 的「26 条无 `validFrom`」与「这些都有 `occurredAt`」**同时**成立（`occurredAt` 缺总数 = 0，不只是这 26 条），这是本轮数字最硬的一条。
- **两条结构声明为真但偏弱**：#4（路径映射）、#5（证据目录）属表格索引行，能证伪的空间很小 —— 本轮随机确实抽到了两条「低成本 PASS」，如实计入，不做加权。

### 判定

**9/10，按本仓「10/10 才叫文档可信任」的既定标准，本轮仍不构成「文档可信任」。** 但两轮的失分点性质不同：audit-04 失在**数值过期**（`方案.md` 的「当前基线」），本轮失在**引用过期**（审计报告的行号锚）。前者已经由 0.62.0 的「不写死数字」修掉，后者还没有任何机制管 —— 建议把它作为下一刀：报告引用改用函数名 + `check.mjs` 加一条「裸行号必须能在附近找到标识符」的守卫。

---

## 未能当场验证项

| 项 | 为什么不能当场验 | 处理 |
|---|---|---|
| `docs/数据契约.md:116` 里的「**任何** sidecar 读取先校验 manifest」的**全称**部分 | 我能验的是 `verify` 闸（缺 manifest → `manifest/missing` + hint `rebuild` + exit 1）。要证「任何读取路径都校验」，得对 `stats` / `dump` / `inject` / 设置页各自的读路径逐一构造坏 store；其中 `stats`/`dump` **不接受 `--store`**（`scripts/rooms/cli.mjs:42`：`--store` 只给 `verify/rebuild/inject` 用），无法在不改仓库的前提下指向空 store | 只对可复现的后果（拒绝 + 提示 `rebuild`）判 PASS；全称量词部分未证，此处标为未验证 |
| `CHANGELOG.md:40` 的**负路**（故意把 §7 写回数字 / 删掉 CHANGELOG 当前段，看它是否真的红） | 需要改 `AGENTS.md` / `CHANGELOG.md`，越出「只读、唯一写入 `reports/audit-05.md`」边界 | 只做正路：读码确认 `:132` `:136` `:137` 三处 `bad.push` 分支 + 实跑 PASS。audit-03 当时做过正反模拟（其 §2.3/§4.5），本轮不重复 |
| `reports/audit-03.md:64` 的行号在 **0.60.0 当时**是否正确 | 要确认「当时对、现在漂」，需 `git show v0.60.0:scripts/ledger-check.mjs`（只读但不属本轮授权的 git 操作面） | 不下这个结论，只断言「现在对不上」；漂移成因按 0.61.0 的 CHANGELOG（新增 `--full`/容差/指南守卫）作**推断**，未计入判定 |
| `AGENTS.md:225` 的 `fromJSON` / `memoryGraph` 是否曾在本仓实现过 | 同上（需 `git log -S fromJSON`） | 只断言「现在 `src/ scripts/ test/` 全无此符号」；是否曾存在标为未证 |
| 并发进程对 `docs/调研/**` 的写入 | 任务书要求排除，未读未验 | 审计期间该目录新增 `20-RAPTOR-递归树-2026-11-02.md`（`22:45:30`，`git status` 显示为未跟踪），印证排除的必要性；本报告全程未触碰该目录 |

---

## 附记（不计入命中率）

1. **裸行号引用是当前唯一会「系统性烂掉」的文档形态**：本轮 1 条 FAIL 全部落在这里，且 audit-03 同表至少还有一处（`:39-50` → `46-63`）。数值面已被 0.62.0 的「不写死数字」+ `ledger-check` 兜住，**引用面还没有任何闸**。
2. **命名漂移（低危，未计 FAIL）**：`AGENTS.md:225` 与 `docs/数据契约.md:115` 都写 `memoryGraph.version` / `fromJSON`，但仓内 `src/ scripts/ test/` 无同名符号，实际是 `GRAPH_VERSION`(1) + `loadGraphAt()` 抛 `graphread: unsupported version`，`persist` 侧是 `ensureCompatible()` 抛 `store/unsupported-version`。行为一致、拒绝语义一致（含「不许静默降级」），所以按**行为**判 PASS；但读者 grep `fromJSON` 会落空，建议把契约里的入口名改成实现里的真名。
3. **池的构成导致补抽偏多（方法学问题，不是选样问题）**：646 行里 55.1% 是 `reports/audit-0*.md` 的行，且审计报告的绝大部分行是「当时的读数/当时的判定」，按本报告的剔除标准（①–④）天然不合格。本轮 28 抽里 **17 抽按 ①–④ 剔除**（①3 条、②3 条、③7 条、④4 条），另 1 抽（C7）合格但超额未采纳；采纳的 10 条中 5 条来自首轮 10 抽、5 条来自 18 次补抽。**下一轮建议把池分两层**：A 层「体系文档」（`MAINTENANCE` / `CHANGELOG` / `AGENTS` / `docs/*` / `scripts` 头部），B 层「审计报告」，各抽 5 条并分别报命中率 —— 否则命中率会被 A/B 两层的比例波动带偏。
4. **本轮实跑未留下任何仓库变更**：`git status --porcelain` 收尾只有一条**并发进程**新增的 `?? docs/调研/20-RAPTOR-递归树-2026-11-02.md`（`22:45:30`，非本会话写入；本会话未读写该目录）。`evidence/metrics-guard.json` 在 `metrics-guard` 后已按规程 `git checkout --` 复原（复原后 `git status` 里 `evidence/` 干净，diff 为 `at` 与 `p50 2.19` 之类的噪声）。本文件是本次唯一写入。
5. **对「按它安装」判断的相关读数**（顺带记录，不计入 10 条）：`docs/安装指南.md` 在 0.62.0 后已不写死版本与测试条数，`ledger-check:126-127` 有对应守卫（出现 `\d+\.\d+\.\d+` 或 `\d+\s*条` 即 `bad.push`）；本轮 `--full` 实跑抓到的台账与实测完全一致（`394/390/0/4`、`322 claim`、`143 卷`），安装指南这条风险面暂时是闭合的。
