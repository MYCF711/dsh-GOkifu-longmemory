# 独立审计报告（audit-06）：活文档随机 10 条实测

> 审计员：独立审计（第六次）· 2026-11-02 22:58–23:05 +08:00
> 仓库 `D:\DeepSeek Harness\default-workspace\长期记忆系统` · `main = 19f0be2` · 版本 `0.63.0` · Node `v24.20.0` · `DSH_HOME=D:\DeepSeek Harness\home`
> 口径：本轮只抽**活文档**（排除 `reports/**` 与 `docs/调研/**`）；判定只认**实跑命令输出**。
> 只读合规：审计前后 `git status --porcelain` 均为 0 行；未做任何写操作/分支/提交；未跑 `archive.mjs`；未跑 `metrics-guard` 全流程（故 `evidence/metrics-guard.json` 未被触碰，无需回滚）。唯一落盘为本报告。

---

## 抽样过程（池大小、10 次原始随机数、剔除记录）

### 池构建（机械，无人工挑选）

1. **文件级**：`MAINTENANCE.md`、`AGENTS.md`、`方案.md`、`docs/安装指南.md`、`docs/数据契约.md`、`docs/记忆的职责边界.md`、`docs/拷问记录.md`、`docs/对标-Hindsight.md` 全量逐行扫描；`CHANGELOG.md` 只取 `## 0.63.0`–`## 0.60.0` 之间（行 **5–48**，即 0.61.0/0.62.0/0.63.0 三段）；`scripts/*.mjs`（23 个）只取**前 15 行内的注释行**。
2. **文件级排除**：`reports/**`、`docs/调研/**` 不进池。（池内有 6 行**文本里提到** `reports/…` 作引用，属正文引用，不是来源，保留。）
3. **行级保留判据**（任一命中即入池，8 类正则；提取阶段**零剔除**）：

```js
/\bnode\s+scripts?\/\S+/            // 命令
/\bnode\s+--test\b/                 // 测试命令
/\bgit\s+(status|log|checkout|show|grep|diff)\b/
/\bnpm\s+\S+/   /\bpnpm\s+\S+/   /\bcurl\b/
/\d+(\.\d+)?\s*(ms|s|秒|分钟|条|个|局|卷|次|行|%|MB|KB|字)/   // 数字+单位
/\bv?\d+\.\d+\.\d+\b/               // 版本号
/`[^`]*\.(mjs|js|json|md|yml|yaml|txt|jsonl)`/   // 反引号文件名
```

4. **池大小 = 350 条**：`方案.md` 101 · `AGENTS.md` 62 · `docs/对标-Hindsight.md` 32 · `MAINTENANCE.md` 26 · `docs/拷问记录.md` 25 · `docs/记忆的职责边界.md` 22 · `CHANGELOG.md`（0.61–0.63）21 · `docs/安装指南.md` 19 · `docs/数据契约.md` 9 · `scripts/*.mjs` 33。
5. **抽样**：`idx = Math.floor(Math.random() * 350)`，重复即重抽（本次 10 次**无重复**）。

### 10 次原始随机数（按抽取顺序，原样记录）

| # | 原始随机数 | idx | 命中来源 |
|---|---|---|---|
| 1 | 0.9242654122 | 323 | `scripts/cli.mjs:5` |
| 2 | 0.5191874081 | 181 | `方案.md:846` |
| 3 | 0.5990811517 | 209 | `docs/数据契约.md:51` |
| 4 | 0.2022395350 | 70 | `AGENTS.md:313` |
| 5 | 0.9470733818 | 331 | `scripts/ledger-check.mjs:7` |
| 6 | 0.8382202495 | 293 | `docs/对标-Hindsight.md:137` |
| 7 | 0.9663108380 | 338 | `scripts/metrics-guard.mjs:8` |
| 8 | 0.7239813323 | 253 | `docs/拷问记录.md:208` |
| 9 | 0.0107243417 | 3 | `MAINTENANCE.md:22` |
| 10 | 0.8922793118 | 312 | `CHANGELOG.md:39` |

### 剔除 / 换条记录（全部如实记账）

| 事项 | 记录 | 处置 |
|---|---|---|
| 重复样本 | 10 次抽取无重复，无重抽 | — |
| 不可当场验证 | 第 2 条 `方案.md:846`（「21 条可引用数字」）一度找不到上游文件：`default-workspace/repos/` 不存在、`default-workspace/GOkifu上下文压缩/` 为**空目录** | 先按规则预抽替条：随机数 **0.1957693627** → idx **68** = `AGENTS.md:310`；随后在 `D:\主工作区\repos\dsh-GOkifu-compact` 找到上游仓，**原条目可当场验证 → 替条作废、不采用**（原 10 条仍为最终样本，未发生实际换条） |
| 仪表缺陷（自报） | 首版池脚本过滤注释行时丢了非注释首行，导致 `scripts/*.mjs` 行号统一 **−1**（曾记录为 `cli.mjs:4`/`ledger-check.mjs:6`/`metrics-guard.mjs:7`） | 修正为保留真实行号后重跑：池仍是 350 条、候选顺序不变；逐条比对 10 条文本**完全一致**，仅行号纠正为 `:5`/`:7`/`:8`。本报告用修正后行号 |

---

## 逐条结果表

| # | 原文（≤80 字） | 文件:行 | 验证命令 | 输出摘要 | 判定 |
|---|---|---|---|---|---|
| 1 | `node scripts/cli.mjs dump <sid> [--root <dir>]` | `scripts/cli.mjs:5` | `node scripts/cli.mjs dump session-<uuid> --root "$DSH_HOME"` | exit **0**；输出 162,824 字节 episode JSON（`id=ep-00b50089`、`seqFrom/seqTo=0/24477`、`closure.logPath/graphPath` 齐全）；`ep-00b50089` 当 sid 传入则报「未找到会话」——注释写的就是 `<sid>`，一致 | **PASS** |
| 2 | \| `06-可引用数字表.md` \| 21 条可引用数字（[外]/[本] 分标） \| | `方案.md:846` | `grep -cE '^\|\s*[0-9]+\s*\|' "D:/主工作区/repos/dsh-GOkifu-compact/docs/research/06-可引用数字表.md"` | **21**（#1–#21 连续，分 5 段无跳号）；`[外]` 11 行、`[本]` 14 行（4 条两者兼有）；文件实存，非空 | **PASS** |
| 3 | `graph.json.delta.jsonl`：每行一个 delta 帧；按行回放；坏尾 → 前缀 + `truncated:true` | `docs/数据契约.md:51` | 系统临时目录造「1 个好帧 + 1 个半写坏帧」，调 `loadGraphAt({basePath, deltaPath})` | `{"frames":1,"truncated":true,"reason":"checksum","probe":true,"nodesBefore":2467,"nodesAfter":2468}`：好帧已回放（2467→2468）、坏尾就地截断并 `truncated:true` | **PASS** |
| 4 | 出问题先看 `MAINTENANCE.md` 的「给接手者的最短路径」，不要猜。 | `AGENTS.md:313` | `grep -n '给接手者的最短路径' MAINTENANCE.md` | `65:## 六、给接手者的最短路径`，下含 7 步（读本文件→git status→AGENTS §10/§11→干活→check+test→更新台账→PR） | **PASS** |
| 5 | 测试：`**N 条**（P pass / F fail / S skip）` 必须等于 `node --test` 实测 | `scripts/ledger-check.mjs:7` | `node scripts/ledger-check.mjs` | `台账 0.63.0 · 测试 394/390/0/4 · claim 322 · 卷 143` / `实测：版本 0.63.0 · 测试 394/390/0/4 · claim 322 · 卷 143` / `ledger-check: PASS`，exit **0**；四元组逐项相等 | **PASS** |
| 6 | 「更强」= 六轴全过：A2 收益为主判据（必须不劣于 Hindsight），A1 负迁移 ≤5% 为硬上限，A3/A5/A6 为硬门槛，A4 为硬指标。 | `docs/对标-Hindsight.md:137` | 交叉核对同文件 §2 六轴表 + `方案.md §2.4`（行 106/113/117）+ `scripts/metrics-guard.mjs` 的 `LIMITS` | 三处同口径：A1 ≤5% 硬上限（只否决）、A2 主判据（不劣于 Hindsight）、A3/A5/A6 硬门槛、A4 ≤50ms 硬指标；代码 `LIMITS={a1Max:.05,a5Max:0,a6Min:1,a4p50MaxMs:50}` | **PASS** |
| 7 | `A1 负迁移 ≤ 5%（硬上限）` | `scripts/metrics-guard.mjs:8` | 直接 import `judge`，喂三点边界：A1=0.04 / 0.05 / 0.06 | `0.04 -> true []`；`0.05 -> true []`；`0.06 -> false ["A1 负迁移 0.06 > 0.05"]`；常量 `a1Max: 0.05` | **PASS** |
| 8 | 命令泛化成 `tool+操作类`，≥3 局 + 带 preconditions + 不进 V1；真实语料出 2 个候选（github path 8 局 / contents 5 局） | `docs/拷问记录.md:208` | `evidence/M5-joseki.md` §3 表 + `src/rooms/joseki.mjs` 的 `promoteReferenceJoseki` 默认参数 + 库内 `joseki/j-ref-*.json` | M5 表恰 2 行：`tool:github path` **8**、`tool:github contents` **5**；`minEpisodes = 3`、`layer:'reference'`、`entersV1:false`、`preconditions` 各 1 条。**附漂移**：现库（117 局）重算得 4 个候选（11/5/3/3） | **PASS**（附漂移） |
| 9 | `cordis.patch.yml` 里两条 `disabled: true`；`re-enable.mjs` 先 `--dry-run` 看「摘除 3 条」…重开后 `install-doctor` 应显示「未见 disabled」 | `MAINTENANCE.md:22` | `grep -n 'disabled: true' "$DSH_HOME/profiles/desktop/cordis.patch.yml"` + `node scripts/re-enable.mjs --dry-run` | 本插件条目恰 **2 条**（`kifu-longmemory`、`dsh-gokifu-longmemory`，各带 `disabled: true`，另有 1 行「临时禁用」注释 = 3）；dry-run 输出 `禁用条目: 摘除 3 条`（未带「仍启用」后缀 ⇒ 摘完 disabled=0）、`[dry-run] patch 将改: true`，exit **0** | **PASS**（末句见「未能当场验证项」①） |
| 10 | `release.mjs` 发版闸改为 `ledger-check --full`，**去掉 `--no-ledger` 逃生门** | `CHANGELOG.md:39`（0.61.0 段，行 32–48） | `grep -n 'ledger-check\|no-ledger' scripts/release.mjs` + `grep -rn 'no-ledger' --include=*.mjs --include=*.md .` | `release.mjs` 打 tag 前执行 `out('node scripts/ledger-check.mjs --full')`，失败即 `exit(1)`；`scripts/ src/ test/` 全仓 **0 处** `--no-ledger`（仅 CHANGELOG 0.60.0 段与 `evidence/M7-ledger-check.md` 作为**历史叙述**提到） | **PASS** |

补充实测（第 10 条的配套，非新抽样）：`node scripts/check.mjs` → `check: PASS`（exit 0），其内部断言 `CHANGELOG.md` 必须含 `## ${pkg.version}`（`## 0.63.0`），与 `package.json` 的 `0.63.0` 一致。

---

## 命中率与结论（10/10 才可称「活文档可信任」）

**命中率 = 10/10（100%）。**

- **判定分布**：PASS 10 · FAIL 0 · 存疑 0；其中「附漂移」1 条（第 8 条，历史记录型，数字与其引用的 M5 证据逐字相符）。
- **验证方式分布**：实跑/边界实验 5 条（第 1、3、5、7、9）；文档↔代码↔证据交叉核对 5 条（第 2、4、6、8、10）。**没有一条是靠"读起来像对的"放过的**。
- **结论**：按本轮口径，10 条活文档陈述全部经实跑复现，**可以称「活文档可信任」**。这与 `audit-04`/`audit-05` 的 9/10（失分都在文档卫生）形成对照：0.61.0 起的 `ledger-check` 台账自证、`check.mjs` 的 CHANGELOG 段断言、以及「引用不写裸行号」的规范，确实把上一轮那类失分点机械化了。
- **限定（不夸大这 10/10）**：
  1. 池只含 8 份活文档 + 3 段 CHANGELOG + 脚本头注释；**不含 `evidence/**`、`计划表.md`、`reports/**`**。本轮 10 条里没有一条覆盖 `计划表.md`。
  2. 3 条落在 `scripts/*.mjs` 头注释上——这些注释与代码同文件，天然同步，属池里最容易过的一类；10/10 的说服力主要来自另外 7 条文档陈述。
  3. 第 8 条暴露一个**结构性风险**：带日期、但写成现在时的语料数字（"真实语料出 2 个候选"）会随语料增长而失效，而库内没有任何断言守着它（`ledger-check` 只守「测试/六轴/语料」四行，不守拷问记录里的历史观测数字）。
- **建议（下一刀，非本轮失分）**：
  - `docs/拷问记录.md` S13 行补时间限定语（"**M5 25 局语料时**"），或把「2 个候选」改成「≥2 个候选（M5 时 2 个：8/5）」；
  - `evidence/M7-ledger-check.md` 的「确需跳过用 `--no-ledger`」已被 0.61.0 删除，属陈旧句，建议标注作废；
  - 上游仓实际路径（`D:\主工作区\repos\dsh-GOkifu-compact`）与工作区内 `default-workspace/repos/` 缺失、`GOkifu上下文压缩/` 为空目录并存，接手者按 `<WORKSPACE>\repos\dsh-GOkifu-compact` 找不到文件——建议在 `AGENTS.md` §1 第 7 行给一条可执行的定位命令。

---

## 未能当场验证项

| # | 未验证的子句/项 | 为什么不能当场验证 | 已验到什么 |
|---|---|---|---|
| ① | `MAINTENANCE.md:22` 末句「重开后 `install-doctor` 应显示「未见 disabled」」 | 需**退出并重开 DSH** 才能走到「重开后」这个状态；本机铁律禁止重启，本轮未重启 | 代码侧已验：`scripts/install-doctor.mjs` 在 `disabled === 0` 时输出 `· 未见 disabled`；且 dry-run 后 `disabledLeft = 0`（输出无「仍启用」后缀），逻辑上必然落到该分支 |
| ② | `docs/拷问记录.md:208` 的「2 个候选（8 局 / 5 局）」作为**现值** | 需以「当前 117 局语料」重跑归档才能重算候选数，而 `archive.mjs` 被明令禁止运行 | 已验：与其引用的 `evidence/M5-joseki.md` §3（2026-11-02 11:05 实测，25 局语料）**逐字相符**；并直接读库内既有 `j-ref-*.json` 得出现值 4 个（11/5/3/3）作为漂移证据 |
| ③ | 第 2 条上游文件的**归属路径** | `方案.md` 附录 A 只写文件名，不写仓根；工作区内 `repos/` 不存在、`GOkifu上下文压缩/` 为空目录，按 `AGENTS.md` 的 `<WORKSPACE>\repos\dsh-GOkifu-compact` 猜会落空 | 已在 `D:\主工作区\repos\dsh-GOkifu-compact\docs\research\06-可引用数字表.md` 用实路径验证通过（21 条） |
| ④ | `metrics-guard` 的**全流程**（会写 `evidence/metrics-guard.json`） | 本轮只读，不跑会产生写盘的脚本；故未触发 `git checkout -- evidence/metrics-guard.json` 的补救 | 已验到判据内核：直接 import `judge()` 喂三点边界，阈值语义（`≤5%` 含等号）与失败文案完全复现 |
| ⑤ | 六轴实时值（A1/A2/A3/A4/A5/A6 的今日读数） | 不在本轮抽样口径（抽的是**陈述**，不是六轴快照）；且需跑 `m5-report`/`metrics-guard` 全流程 | 只做了一致性核对（文档阈值 ↔ 代码 `LIMITS` ↔ `方案.md §2.4`），未复算数值 |

> 未跑 `archive.mjs`（明令禁止）、未做任何 git 写操作、未安装/重启 DSH、未改 profile 配置。`git status --porcelain` 审计结束时为 0 行（本报告自身在提交前不显示为改动，如需入库请按正常流程另行提交）。
