# 独立审计报告（audit-03）

- **审计对象**：`D:\DeepSeek Harness\default-workspace\长期记忆系统`，`main = f196474`（`R00 docs: 计划表补记 T22–T38 (#118)`），版本 `0.60.0`。
- **审计范围**：**只查一类**——「文档陈述 ↔ 命令实测」是否一一对应。产品行为、架构、性能不在本轮范围（audit-01/02 已覆盖）。
- **审计时间**：2026-11-02 21:48–21:56 +08:00（所有实测值以该窗口为准；窗口外的数字已注明）。
- **审计员**：独立子代理（只读，未参与实现）。
- **只读声明**：除本文件外未写任何仓库文件；未做提交/分支/推拉等写操作类 git 命令（仅 `git status`、`git checkout -- evidence/metrics-guard.json` 还原 `metrics-guard` 自身副作用，还原后 `git status` 为空）；未运行 `archive.mjs`；`release.mjs` 未执行，只读代码论证。
- **一次性验证脚本**：全部写在系统临时目录（`%TEMP%`），不进仓库，只 `import` 仓库已有导出或逐字复制被测判据。

---

## 结论

**有条件通过（文档诚实性仍未过关）。**

产品面无回归：`node --test` 393 条（389 pass / 0 fail / 4 skip，exit 0）、`check.mjs` PASS、`metrics-guard` PASS、`cli audit` 与 `m5-report` 均可复现。`ledger-check.mjs` 在四种「数字错」上都**真能抓住**（见 §4），ruleset 保护也**真实存在**（见 §6）——这两条是本轮最实质的进步。

但「台账数字 = 实测」这一条仍然只对了一半：

1. **六轴与语料里有 3 个数字当场对不上**：`A2 26.55%`（实测 **26.67%**）、`A4 p50 2.03ms`（实测 **2.22ms / 2.16ms**）、`语料 116 局`（实测 **117**）。
2. **时点是编造或占位**：A1–A6 与语料那两行标 `[本] 2026-11-02 21:2x`（不是时点）；测试行标 `21:50`，但 `MAINTENANCE.md` 最后写入时间是 **21:43:42**（commit `ce9a204` 为 **21:43:36**）——**台账标注的实测时刻比文件自己的落盘时刻还晚 7 分钟**。
3. **「发布前强制」名不副实**：`release.mjs` 调的是 `ledger-check --no-tests`，**测试四分量在发版闸里根本不核对**；且 `compare()` 在解析失败或实测缺失时**静默跳过**（fail-open，其自带单测 `ledger-check: 缺字段时不误报` 就是这条）。
4. audit-02 的 **P1-4 没清完**：`MAINTENANCE.md:54` 仍写「GitHub 免费**私有**仓库不支持分支保护（2026-11-02 实测 403）……改用本地 pre-push hook + CI 兜底」，与「仓库 public + ruleset 已 active」直接矛盾；`计划表.md` T38 却已写「P1 全修」。

> 判定：**不阻断交付**（无 P0、无数据损坏、无越界），但**不能宣称「台账已自证」**。这已经是第三轮栽在同一句话上：数字不是查不出来，是写的时候没有跑。

---

## 逐项结果表

### ① `MAINTENANCE.md` 里的所有数字（逐项对照四条命令）

| # | 台账陈述 | 台账值 | 实测命令与结果 | 判定 |
|---|---|---|---|---|
| 1.1 | 当前版本 | `0.60.0` | `package.json` → `"version": "0.60.0"` | **PASS** |
| 1.2 | 测试四分量 | `393 条（389 pass / 0 fail / 4 skip）` | `node --test` → `ℹ tests 393 / pass 389 / fail 0 / skipped 4`（exit 0，3307ms） | **PASS**（值对） |
| 1.3 | 测试时点 | `[本] 2026-11-02 21:50` | 文件 mtime `2026-11-02 21:43:42`；`git log -1 -- MAINTENANCE.md` → `ce9a204 2026-11-02 21:43:36` | **FAIL**：标注时点晚于文件落盘 6–7 分钟，不可能由该文件自身的写入产生 |
| 1.4 | A1 | `0.00%（空转：validity 覆盖 0/26）` | `m5-report --json` → `A1.value=0, status=measured, detail.vacuous=true, validityCoverage{withValidity:26, rendered:0, ratio:0}` | **PASS** |
| 1.5 | A2 | `26.55%` | 实测 `A2.value=0.26666666666666666` → **26.67%**（`repeat=48 / novel=132 / n=180`；26.55% 对应 47/177，语料又长了 1 局） | **FAIL** |
| 1.6 | A3 | `not-live` | `A3.status="not-live"`（value 0, n=26） | **PASS** |
| 1.7 | A4 | `p50 2.03ms` | `m5-report` → `A4.value=2.22`（unit=ms，n=50）；`metrics-guard --json` 同时刻 → `p50:2.16` | **FAIL** |
| 1.8 | A5 | `0.00%` | `A5.value=0`（n=29） | **PASS** |
| 1.9 | A6 | `100%` | `A6.value=1`（n=29） | **PASS** |
| 1.10 | 六轴时点 | `[本] 2026-11-02 21:2x` | 不是时点（`2x` 为占位符）；A2/A4 已漂移（见 1.5/1.7） | **FAIL**（按本轮口径：时刻相关值无时点即 FAIL） |
| 1.11 | 语料·局 | `116 局` | `m5-report → corpus.episodes = 117`；`ls <HOME>/memory-context/episodes \| wc -l` → **117** | **FAIL** |
| 1.12 | 语料·卷 | `143 卷` | `cli audit --json` → `threads.total = 143` | **PASS** |
| 1.13 | 语料·claim | `claim 322` | `cli audit --json` → `claims.total = 322` | **PASS** |
| 1.14 | 有效期已止 | `25` | `cli audit --json` → `claims.stale = 25`、`claims.expired = 25`；文本档「有效期已止 25」 | **PASS** |
| 1.15 | `26 条为 0.58 前历史记录，无 validFrom 但都有 occurredAt` | 26 / 0 | 只读扫描 `memory-context/claims/*.json`：`{total:322, vfNotNull:296, occNotNull:322, nullNoOcc:0, nullWithOcc:26, vfNeOcc:0}` | **PASS** |
| 1.16 | 当天覆盖 | `18/18（一次性指标，见 evidence/M6-D1.md；不在本表维护）` | 已自我声明不维护，且给了证据文件（存在） | **PASS**（口径已降级，不再作硬数字） |
| 1.17 | 已发布清单·末项 | `0.60 台账自证 ledger-check（发布前强制）` | `CHANGELOG.md` 首段 `## 0.60.0`，内容即 ledger-check；`gh api .../releases` → `v0.60.0`，`published_at 2026-11-02T13:45:16Z` | **PASS**（末项值对；「发布前强制」的强度问题见 P1-2） |
| 1.18 | 已发布清单·完整性 | 47 项（0.15.1 → 0.60） | 解析该行得 47 项，都能在 CHANGELOG 找到对应段；但 CHANGELOG/Release 里还有 **0.15.0、0.15.2、0.17.1、0.17.2、0.17.3** 未列入 | **P2**（不完整，未说谎） |
| 1.19 | 证据文件名（6 个） | `M6-acceptance.md` 等 | 6/6 全部存在 | **PASS** |
| 1.20 | 知识库 `docs/调研/04–19` | 16 项 | 目录实有 04–19 共 16 个文件，一一对应 | **PASS** |
| 1.21 | 插件状态 `两条 disabled: true` / re-enable「摘除 3 条」 | 2 / 3 | `node scripts/re-enable.mjs --dry-run` → `禁用条目: 摘除 3 条`、`patch 将改: true`（dry-run 提前 `exit(0)`，无写盘） | **PASS** |

> 小计：20 项判定中 **PASS 14 / FAIL 4 / P2 1**（另有 1 项因降级口径按 PASS 处理）。**四个 FAIL 全部集中在「时刻相关值 + 语料局数」这一族**——正是 ledger-check 唯一不覆盖的那一族。

### ② `CHANGELOG.md` 0.60.0 / 0.59.0 / 0.58.0 的可验证断言（抽 13 条）

| # | 出处 | 断言 | 核对方式与结果 | 判定 |
|---|---|---|---|---|
| 2.1 | 0.60 | 核对「版本 / 测试四分量 / claim / 卷」四类，任一不一致退出 1 | 读码 `scripts/ledger-check.mjs:39-50` + 假数据实跑：版本错、total/pass/fail/skip 错、claim 错、卷错 **8 种全被抓住**（见 §4） | **PASS** |
| 2.2 | 0.60 | 「无 store 时跳过语料项并显式标注」 | 读码 `:73` 捕获异常 → `actual.claim=null`；`:82` `skippedCorpus: actual.claim === null`；文本档 `:85` 打印「（无 store，跳过语料核对）」 | **PASS** |
| 2.3 | 0.60 | 「同时校验 AGENTS §7 仍是指针、CHANGELOG 有当前版本段」 | 读码 `:74-80`；用逐字复制的判据做正反模拟：删指针 → FAIL(抓住)；写回「393 条测试」→ FAIL(抓住)（见 §4.5） | **PASS**（但有绕过口，见 P2-4） |
| 2.4 | 0.60 | 「`release.mjs` 打 tag 前先跑 `ledger-check --no-tests`，不一致中止」 | 读码 `scripts/release.mjs:46-54`：确实在 tag 前调用，`execSync` 非零即 `process.exit(1)` | **PASS（字面）**；但 `--no-tests` 使测试四分量不参与发版闸（P1-2） |
| 2.5 | 0.60 | 「393 条测试（389 pass / 0 fail / 4 skip）」 | `node --test` 实测完全一致 | **PASS** |
| 2.6 | 0.60 | 「`ledger-check PASS`」 | 实跑 `node scripts/ledger-check.mjs` → `ledger-check: PASS`，exit 0 | **PASS** |
| 2.7 | 0.60 | 「证据 `evidence/M7-ledger-check.md`」 | 文件存在，且其 §测试 写「4 条单测」；`test/ledger-check.test.mjs` 实有 4 个 `test(` | **PASS** |
| 2.8 | 0.59 | P1-3「`\s` 退化成 `s` 的死断言 → 改成区间扫描（§7 出现「条测试」即失败）」 | `scripts/check.mjs:22-28` 已是 `indexOf('## 7 ·')/('## 8 ·')` 切片 + `sec7.includes('条测试')`，无正则转义；模拟写回「v0.60.0 / 393 条测试」→ 被抓 | **PASS** |
| 2.9 | 0.59 | P1-4「新增 ruleset（pull_request + required_status_checks `rules` strict + 禁删除/强推）」 | `gh api .../rulesets/26369698` → `main-protection, active, target=branch`，rules = `pull_request` / `required_status_checks{contexts:["rules"], strict:true}` / `deletion` / `non_fast_forward` —— **4 条与描述逐字对应** | **PASS** |
| 2.10 | 0.59 | 「26 条 `validFrom=null` 的 claim **都有 `occurredAt`**」 | 上面 1.15 的扫描：`nullWithOcc=26, nullNoOcc=0` | **PASS** |
| 2.11 | 0.59 | 「删除 claim 测试里恒真的正则断言」 | `grep "class:\[a-z-\]+ · )?" test/claim.test.mjs` → 无匹配；现行 `test/claim.test.mjs:84` 是带条件的真断言 | **PASS** |
| 2.12 | 0.58 | 「322 条 claim 中 296 条有 `validFrom`，26 条……都有 `occurredAt`」 | 扫描结果 `vfNotNull=296 / total=322 / nullNoOcc=0` | **PASS** |
| 2.13 | 0.58 | 「`representativeTextFor()` 建组与『更早支撑』共用」 | `grep -rn representativeTextFor` → 定义 `src/rooms/claim.mjs:498`，调用 `:598`（建组）与 `:612`（更早支撑重置），**两路径都在** | **PASS** |

> 小计：13 条抽检 **13 PASS**（其中 2.4 字面为真但强度不足，另列 P1-2）。
> 未核：0.57/0.58/0.59 的历史测试条数（385/388/389，需检出历史提交复跑，本轮不做 git 操作）；0.59 调研 19 的文献数字（见「未能核实项」）。

### ③ `计划表.md` T22–T38 每行 vs `CHANGELOG.md` 对应版本（抽 13 行）

| 行 | 计划表写的 | CHANGELOG 实际 | 判定 |
|---|---|---|---|
| **T22** | 类级主题 + 类级信号 + 8 类错误表（0.22–0.24）；**「claim 类表对齐 topic（0.22–0.24）」** | 0.22 类级错误主题 ✔ / 0.23 类级错误信号 ✔ / 0.24 「5 → 8 类」✔；**但「claim 类表对齐」是 `## 0.34.0`「修：claim 的类表与 topic 的类表不一致」** | **FAIL（归属错）**：把 0.34.0 的活记在 0.22–0.24 |
| **T23** | 类级主卷 + cli volumes / cli audit（0.26–0.28） | 0.26 类级错误成卷 ✔ / 0.27 `cli volumes` ✔ / 0.28 `cli audit` ✔ | **PASS** |
| **T24** | N10 人纠错回填（L4）（0.29） | 0.29「N10 · 人纠错（L4）机械回填」✔，细节（只认 L4+correct、幂等、只增不改）一致 | **PASS** |
| **T25** | A2 holdout + A2b 两口径 + 严格口径 70.59%（当时）（0.30–0.33） | 0.33「A2b 严格口径 47.06% → 70.59%」✔，且「（当时）」限定词正确（现值 84.2%） | **PASS** |
| **T26** | 类级章节自愈 + class-audit（0.34–0.35）；4/6→6/6 | 0.35「类级章节自愈」+「本机效果：4/6 → 6/6」+「新增 `scripts/class-audit.mjs`」（文件实存） | **PASS** |
| **T27** | 指标护栏 metrics-guard（0.36）；不达标 exit 1 | 0.36「一条命令判定 A1/A5/A6/A4/A2b：不达标退出 1」✔；实跑 exit 0 | **PASS** |
| **T28** | N1 双时态（0.37）；audit 报有效期已止 | 0.37 ✔；`cli audit` 实报「有效期已止 25」 | **PASS** |
| **T29** | 宿主仿真（真实 store）+ 调研 13（0.38）；注入 24/40、failed 0、p95 5.5–6.0ms | 0.38「injected 24/40、failed 0、warn 0、p50 3.3–3.7ms、p95 5.5–6.0ms」✔；调研 13 = `docs/调研/13-MIRIX`（存在） | **PASS** |
| **T32** | N9 卷首摘要（0.41） | 0.41「thread 新增 `headline`；`cli volumes` 展示 headline」✔ | **PASS** |
| **T33** | re-enable 精准摘除；dry-run 摘除 3 条（0.42） | 0.42「将摘除 3 条（1 条注释 + 2 条 disabled 条目）」✔；**现场实跑 dry-run 输出「摘除 3 条」** | **PASS** |
| **T34** | 19 条固定考卷；判据修正 63.2%→84.2%（0.43–0.44） | 0.43「19 条，同域 9」+ 严格 0.6316 ✔；0.44「63.2% → 84.2%（16/19）」✔；现值 A2b 严格 0.8421 一致 | **PASS** |
| **T36** | 调研 15–18 + 数据契约补齐 + cli facts --at（**0.46–0.53**） | 调研 15 = 0.46 ✔、16 = 0.52 ✔、**17 = 0.55、18 = 0.56**；数据契约 §9–§14 = 0.53 ✔ | **FAIL（版本区间错）**：17/18 落在 0.55/0.56，不在 0.46–0.53 |
| **T38** | 独立审计 audit-01/02 与修复 + 调研 19 + 台账自证；**「P1 全修」**（0.55–0.60） | 0.58 audit-01 修复 ✔ / 0.59 audit-02 修复 + 调研 19 ✔ / 0.60 台账自证 ✔；**但 audit-02 的 P1-4「界面口径」未清完**（`MAINTENANCE.md:54` 仍写私有仓库/不支持分支保护） | **FAIL（「P1 全修」为假）** |

> 小计：13 行抽检 **10 PASS / 3 FAIL**。三条 FAIL 都属于「把没做完/做在别的版本的事写成本版本已完成」，与本题设的要害（有没有把没做的事写成已完成）正面命中：T22 与 T36 是**归属错**，T38 是**完成度虚报**。

### ④ `scripts/ledger-check.mjs` 是否真能抓住不一致

**方式**：临时脚本（`%TEMP%/ledger-test.mjs`，不进仓库）直接 `import` 仓库导出的 `parseLedger` / `compare`，喂假台账文本 + 真实实测值，不改任何仓库文件。

| 台架场景 | 期望 | 结果 |
|---|---|---|
| 基线（真实台账文本） | 过 | PASS（放过）✔ 正确 |
| **版本错** `main = 0.59.9` | FAIL | **FAIL(抓住)** `版本：台账 0.59.9 vs package 0.60.0` |
| **测试数错** `**392 条**` | FAIL | **FAIL(抓住)** `测试 total：台账 392 vs 实测 393` |
| **测试数错** `388 pass` / `3 skip` / `1 fail` | FAIL | **FAIL(抓住)** 三分量各自报错 |
| **claim 错** `claim 300` | FAIL | **FAIL(抓住)** `claim：台账 300 vs 实测 322` |
| **卷错** `**141 卷**` | FAIL | **FAIL(抓住)** `卷：台账 141 vs 实测 143` |
| **AGENTS 写回数字**（§7 插「v0.60.0 / 393 条测试」） | FAIL | **FAIL(抓住)**（逐字复制 `:75-77` 判据模拟，因该判据未导出） |
| 局数错 `999 局` | — | **PASS(放过)**：ledger-check 根本不解析局数（= 1.11 FAIL 不被拦的原因） |
| 六轴整行删掉 | — | **PASS(放过)**：不解析六轴 |
| 去掉 `**` 包裹（`393 条（…）`） | — | **PASS(放过)**：`tests` 解析成 `null` → `compare` 跳过 |
| 中文口径（`389 通过 / 0 失败 / 4 跳过`） | — | **PASS(放过)**：同上，静默跳过 |
| 去掉 `claim` 字样 | — | **PASS(放过)**：`claim=null` → 跳过 |
| **发版真实路径**：`--no-tests` + 台账写 `1 条（0/0/0）` | — | **PASS(放过)**：`actual.tests=null` → 测试项整段不核对 |
| 无 store 时 claim/卷写错 | — | **PASS(放过)**（但有 `skippedCorpus` 显式标注，属已知设计） |

**真实实跑**（要求 4 的后半）：

```
$ node scripts/ledger-check.mjs
ledger-check：台账 0.60.0 · 测试 393/389/0/4 · claim 322 · 卷 143
实测：版本 0.60.0 · 测试 393/389/0/4 · claim 322 · 卷 143
ledger-check: PASS
EXIT=0
```

**判定**：**PASS（可用的闸）**——题目点名的五种（版本/测试数/claim/卷/AGENTS 写回）**全部能 FAIL**。但它只覆盖这五项，且是 **fail-open**：解析不到就跳过（`test/ledger-check.test.mjs:35` 的「缺字段时不误报」正是这条设计），所以 1.5/1.7/1.11 三个错数字**它一个都抓不到**，而台账却因此获得了「已自证」的外观。→ 记 P1-2。

### ⑤ `release.mjs` 的台账闸是否真会在不一致时中止（读代码论证）

读 `scripts/release.mjs:46-54`：

```js
if (!process.argv.includes('--no-ledger')) {
  try {
    out('node scripts/ledger-check.mjs --no-tests');
  } catch (error) {
    console.error('release: ledger-check 失败（台账与实测不一致），先修台账再发版；确需跳过用 --no-ledger');
    process.exit(1);
  }
}
```

- `out()` = `execSync(cmd, {encoding:'utf8'}).trim()` —— 子进程**非零退出会抛异常**，被 `catch` 接住后 `process.exit(1)`。**在 tag 创建（`:73`）之前执行**，所以确实能挡住发版。
- 位置正确：在 `check.mjs`（`:23`）、CI 结论（`:26-43`）、tag 重复检查（`:44`）之后，`git tag -a`（`:73`）之前。
- **三个真实缺口**：
  1. **`--no-tests`**：发版闸内 `actual.tests=null`，`compare()` 直接跳过测试四分量（见 §4 最后一组台架）。即「测试数写错」在发版时**不会中止**。
  2. **`--no-ledger` 逃生门**：存在且无二次确认（CHANGELOG 已明示，属诚实披露，但闸可被绕过）。
  3. **fail-open**：`parseLedger` 解析失败即 `null` → 跳过；`cli audit` 无 store 时 `claim/threads=null` → 跳过（有标注，但仍是跳过）。

**判定**：**PASS（真会中止）**，但只对「版本 / claim / 卷 / AGENTS 指针 / CHANGELOG 段」五项生效，**不含测试数**。未真跑 `release.mjs`（按硬要求不发版）。

### ⑥ 仓库可见性与保护口径

| 检查 | 命令 | 结果 | 判定 |
|---|---|---|---|
| 可见性 | `gh api repos/MYCF711/dsh-GOkifu-longmemory --jq '{private,visibility}'` | `{"private":false,"visibility":"public"}` | **PASS** |
| ruleset 存在 | `gh api .../rulesets --jq '.[] \| {id,name,target,enforcement}'` | `main-protection, id=26369698, target=branch, enforcement=active` | **PASS** |
| ruleset 规则 | `gh api .../rulesets/26369698 --jq '.rules[].type'` | `pull_request` / `required_status_checks`（contexts `["rules"]`, strict `true`, required_approving_review_count `0`）/ `deletion` / `non_fast_forward` | **PASS**：**「必须经 PR」现在是真的**（上一轮是假的） |
| 「私有仓库」残留 | `grep -rn 私有` | `MAINTENANCE.md:54`：「GitHub 免费**私有**仓库不支持分支保护（2026-11-02 实测 403），改用本地 pre-push hook + CI 检查兜底」 | **FAIL**：仓库 public、服务端 protection 已 active，两句都假，且与同文件 `:12`「（**公开**；main 由 ruleset 保护）」自相矛盾 |
| 「需 PR」四处口径 | `grep -rn 需 PR` | `AGENTS.md:24`、`MAINTENANCE.md:12`、`CHANGELOG.md:27/40`、`evidence/M7-audit-01-fixes.md:44` —— 全部写 ruleset，与实测一致 | **PASS**（上轮的假陈述已消除） |
| 其余「私有」 | `package.json:5`「私有自用，不发 npm」；`计划表.md:68`「私有自用」 | 指**不发 npm**，非仓库可见性；不构成假陈述 | 可接受（P2 建议改词以免歧义） |

**判定**：**部分通过**。visibility 与 ruleset 两个硬口径都对；但 `MAINTENANCE.md:54` 这个 audit-02 点名的位置**原样留着**（P1-3）。

### ⑦ audit-01 / audit-02 被标 FAIL 的项，现在能否被命令证明已修（抽 3+ 条）

| 来自 | 原 FAIL 项 | 现在的证明命令与结果 | 判定 |
|---|---|---|---|
| audit-01 **P1-1** | `validFrom` 是空壳（303 条里只有 1 条非空），契约与 CHANGELOG 说谎 | 只读扫描：`{total:322, vfNotNull:296, nullNoOcc:0, vfNeOcc:0}`；`representativeTextFor` 两路径均在 | **已修（PASS）** |
| audit-01 **F/P1-4** | GitHub 实际 public，台账写「私有」 | `gh api` → `public`；`MAINTENANCE.md:12` 已改「（**公开**…）」 | **已修（PASS）**——但 `:54` 是漏网的同一错误（见 ⑥），故整体不作「全修」 |
| audit-02 **P1-3** | `check.mjs` 的 `\s` 退化成 `s`，写回数字不会红 | 读码 `check.mjs:22-28` 已是区间扫描；模拟「写回 393 条测试」→ 被抓、删指针 → 被抓 | **已修（PASS）** |
| audit-02 **P1-4** | 「需 PR」为假（`rulesets:[]`）+ `MAINTENANCE:54` 仍「私有仓库」 | ruleset 已 active 含 `pull_request` ✔；**但 `MAINTENANCE.md:54` 原文未改** | **部分修（FAIL）** |
| audit-02 **P2-1** | 「26 条历史条目**无 `occurredAt`**」是与库相反的假陈述 | `nullNoOcc=0 / nullWithOcc=26`；CHANGELOG 0.58/0.59 已改成「都有 occurredAt」 | **已修（PASS）** |
| audit-02 **F（台账诚实性）** | A2/A4 无时点且数字过期；claim/卷过期 | claim 322 ✔ / 卷 143 ✔ 已跟上；但 **A2 26.55%≠26.67%、A4 2.03≠2.22、局 116≠117，A1–A6 时点仍是 `21:2x` 占位** | **未修（FAIL）**——本条正是 audit-01 就点过的同一项 |

> 小计：6 条中 **4 项已修 / 2 项未修或部分**。整体不能说「audit-01/02 的 P1 全修」（与 ③ T38 的判定一致）。

---

## 发现的问题（P0/P1/P2）

### P0
无。（无数据损坏、无越界注入、无产品行为回归；`node --test` 393/389/0/4 exit 0。）

### P1

**P1-1｜`MAINTENANCE.md` 三个数字与实测不符，且「时刻相关值」的时点是占位符/未来时刻**
- 证据：
  - `A2 26.55%` vs `m5-report --json` → `26.67%`（48/180；26.55% = 47/177，语料已长一局）。
  - `A4 p50 2.03ms` vs `m5-report` → `2.22ms`（n=50）；同一时刻 `metrics-guard` → `2.16ms`。
  - `语料 116 局` vs `m5-report corpus.episodes` / `episodes/` 目录 → **117**。
  - 六轴与语料两行标 `[本] 2026-11-02 21:2x`（占位符，不是时点）；测试行标 `21:50`，而文件 mtime **21:43:42**、commit `ce9a204` **21:43:36**。
- 影响：A2/A4 是**时刻相关值**，没有可信时点就无法判断「当时是对的」还是「写错了」；`21:2x` 等于放弃了这一判据。局数则是纯错。
- 建议：把 `21:2x` 改成跑命令时的真实时刻；对 A2/A4/局数，改由 `ledger-check` 一并核对（加 `episodes`、`A2`、`A4` 三项，允许 A4 用 ≤ 容差或改记「n=50 的 p50 区间」），或者干脆在台账里只写「A2/A4 见 `m5-report --json`，不抄数值」。

**P1-2｜「台账自证 / 发布前强制」强于事实：发版闸不核对测试四分量，且解析失败即静默跳过（fail-open）**
- 证据：
  - `release.mjs:49` 调用的是 `ledger-check.mjs --no-tests` → `actual.tests = null` → `compare()` 的 `if (ledger.tests && actual.tests)` 整段跳过。台架实测：台账写 `1 条（0 pass / 0 fail / 0 skip）` + `actual.tests=null` → **PASS(放过)**。
  - `parseLedger` 依赖两个精确格式（`**N 条**（P pass / F fail / S skip）`、`**N 卷**`、`claim N`）；格式一变即 `null` → 跳过。台架实测去掉 `**`、改成中文「通过/失败/跳过」、去掉 `claim` 字样 → 全部 **PASS(放过)**。
  - `test/ledger-check.test.mjs:35` 单测标题就是「缺字段时不误报」——fail-open 是有意设计。
  - 而 `计划表.md:80` 写「台账数字由 `node scripts/ledger-check.mjs` 机械核对；`release.mjs` 打 tag 前强制跑（不一致中止）」，`MAINTENANCE.md:32` 写「0.60 台账自证 ledger-check（**发布前强制**）」。
- 影响：给人「台账全部数字都被闸住了」的错觉；实际只闸版本/claim/卷（+AGENTS/CHANGELOG 段），**A1–A6、局数、有效期已止 完全无闸**——P1-1 的三个错数正是从这些缺口漏过去的。
- 建议：① `release.mjs` 去掉 `--no-tests`（或改成 `--tests` 必跑，发版本来就要求 `node --test` 全绿，边际成本≈0）；② `parseLedger` 解析失败要**显式 FAIL**（「台账格式无法解析」）而不是返回 null；③ 台账里凡是抄了数值的地方，要么纳入闸，要么改成指针（照 `AGENTS.md` §7 的做法）。

**P1-3｜audit-02 的 P1-4 未清完：`MAINTENANCE.md:54` 仍写「私有仓库 / 不支持分支保护（实测 403）」**
- 证据：`gh api ... --jq '{private,visibility}'` → `{"private":false,"visibility":"public"}`；`gh api .../rulesets/26369698` → `active`，含 `pull_request` + `required_status_checks(rules, strict)` + `deletion` + `non_fast_forward`。同文件 `:12` 已写「（**公开**；main 由 ruleset 保护）」。
- 影响：同一份台账里 `:12` 与 `:54` 互相打脸；`:54` 两句（「免费**私有**仓库不支持分支保护」「改用本地 pre-push hook + CI 兜底」）在实测下都是假的。这正是第二轮的 FAIL 项，被原样留到第三轮。
- 建议：把 `:54` 改成「公开仓库；`main` 由 ruleset `main-protection` 保护（需 PR + required check `rules`，禁强推/删除）；本地 pre-push hook 仅作额外兜底」。

**P1-4｜`计划表.md` T38 写「P1 全修」为假**
- 证据：T38 原文「P1 全修；ruleset；ledger-check 发布前强制（0.55–0.60）」。实测：audit-02 P1-4 仅部分修（P1-3 本条）；且「发布前强制」的强度见 P1-2。
- 影响：把没做完的事写成已完成——正是本题设点名要抓的形态。
- 建议：改成「P1 修 4/5（P1-4 剩 `MAINTENANCE:54` 口径）」，或先修完 P1-3 再回填。

### P2

**P2-1｜`计划表.md` T22 把 0.34.0 的活记在 0.22–0.24**
`T22` 末尾写「claim 类表对齐 topic（0.22–0.24）」，而 `CHANGELOG.md` 的「修：claim 的类表与 topic 的类表不一致」是 **`## 0.34.0`**。建议删掉该短语或改成「(0.34)」。

**P2-2｜`计划表.md` T36 的版本区间 `0.46–0.53` 覆盖不到调研 17/18**
T36 标题写「调研 15–18」，但调研 17 = **0.55.0**、调研 18 = **0.56.0**（`CHANGELOG.md` 段首已证）。建议改成 `(0.46–0.56)`，或把 17/18 划给 T38 并同步改 T38 描述。

**P2-3｜`MAINTENANCE.md` 的「已发布」清单不完整**
47 项都能在 CHANGELOG 找到段，但 CHANGELOG 与 GitHub Release 里另有 `0.15.0 / 0.15.2 / 0.17.1 / 0.17.2 / 0.17.3` 未列入（`gh api .../releases` 实测 62 个 tag）。不构成假陈述，但「已发布」这个词暗示穷举。建议加「（0.15.1 起列举主要版本）」限定语。

**P2-4｜AGENTS §7 的兜底是单一子串 `条测试`，可绕过**
台架实测（逐字复制 `ledger-check.mjs:77` 与 `check.mjs:27` 的判据）：
- 写回「v0.60.0 / **393 条测试**」→ 抓住 ✔
- 写回「**测试条数**：393」→ **放过**
- 写回「**393 tests**」→ **放过**
- 写回「测试 **393 条**」→ **放过**
建议改成「§7 内出现任意 3 位数 + `测试|条` 的组合即失败」，或改成正向白名单（§7 只允许指针表里的固定措辞）。

**P2-5｜`CHANGELOG 0.58` 的「N1 空壳测试改成真断言」仍留半边空转**
`test/claim.test.mjs` 的 N1 用例里 `promoteClaim({episodes: []})` ⇒ `out.claims` 为空 ⇒ `if (sample)` 分支**永不进入**（audit-02 P2-2 指出过，0.59 只删了另一处恒真正则）。陈述本身不算假（确实新增了真断言），但「改成」暗示替换完成。建议删掉 `if (sample)` 包壳，或补一个非空 fixture 让它真的跑。

---

## 未能核实项

1. **历史版本的测试条数**：`0.57 → 385`、`0.58 → 388`、`0.59 → 389`、`0.60 → 393`。当前树上只能复现 393；要复现前三个需检出历史提交跑 `node --test`，本轮硬要求「不 git 操作」，故**未核实**（只核了内部一致性：389 + 4 条新增 ledger-check 单测 = 393 ✔）。
2. **`release.mjs` 的闸是否真的中止过**：只做读代码论证（`execSync` 抛错 → `exit 1`，且在 `git tag -a` 之前）。未实际制造不一致去跑 `release.mjs`（硬要求：不改版本、不发版）。
3. **调研 19（HippoRAG）的文献数字**：「多跳 QA 自报 +20%」「比 IRCoT 便宜 10–30×、快 6–13×」是论文自报值，本轮未读原文，**未核实**（且本仓 `AGENTS.md` §2.4 已要求 `[外]` 标注）。
4. **A2 / A4 的「真值」**：两者都是时刻相关量。本报告给出的 26.67% 与 2.22ms/2.16ms 只对**2026-11-02 21:49–21:52 这个窗口**成立；无法判断台账写作时刻（约 21:43）的真实值是多少——只能判定「现在对不上，且台账没给出可校验的时点」。
5. **`evidence/M6-D1.md` 的「当天覆盖 18/18」**：台账已自行降级为「一次性指标，不在本表维护」，本轮未复算（不属「文档陈述 ↔ 当前命令」的可复现族）。
6. **GitHub 分支保护的 legacy `protection` 接口**：本轮只按题目指定的三条 `gh api` 命令核对（`repos` / `rulesets` / `rulesets/<id>`），未再调 `branches/main/protection`（audit-02 已核过，且 ruleset 是现行生效面）。
7. **`re-enable.mjs --dry-run` 的「摘除 3 条」**：已实跑复现（`禁用条目: 摘除 3 条`，随后 `[dry-run] … process.exit(0)`，无写盘）。但这是**本机 profile 的当前状态**，不保证与 0.42.0 发布当时一致——按「可复现」判 PASS，按「历史一致」不可证。

---

**审计员签名**：独立子代理（只读）
**本轮唯一写入**：`reports/audit-03.md`
**副作用还原**：`evidence/metrics-guard.json` 已 `git checkout --` 还原，`git status --porcelain` 为空。
