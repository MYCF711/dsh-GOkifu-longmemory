# T22 · T1 文档口径同步 + 知识库第 92 篇（MemUse 使用点评测）

> 日期：2026-11-08 · 任务：t14（队长派单）
> 可写面：`evidence/T1-label-expansion.md`、`docs/调研/92-*.md`、`docs/调研/00-索引与机制对照.md`、本文件。
> **没有改** `src/**`、`test/**`、`package.json`、`CHANGELOG.md`、`MAINTENANCE.md`、版本号、台账。

## 0 · 验收（逐条对）

| 验收项 | 要求 | 实测 | 结论 |
|---|---|---|---|
| ① T1 文档口径与 `label-set.json` 一致 | 一致 | 新增 §九「口径更正」并在标题区加指向；**§9.3 的 `stats` JSON 块与 `label-set.json` 的 `stats` 深度相等 = `true`**（§3-A 命令）；旧数字全部保留并标「改前」 | ✅ |
| ② 知识库第 92 篇 | 2025–2026 新论文/实践、真实来源、可执行建议 | `docs/调研/92-MemUse-交付不等于使用-使用点评测-2026-11-08.md`：来源 [arXiv:2611.01718](https://arxiv.org/abs/2611.01718)（v1 2026-11-01，作者 Changran Xu / Zeju Li / Qiang Xu，CUHK CSE；[HTML 全文](https://arxiv.org/html/2611.01718) 已读 §1–§5 + 附录 A.1–A.5/A.6 部分）；文末 §九 给 **4 条**对本项目的可执行建议 | ✅ |
| ③ 调研清单补一行 | `00-索引与机制对照.md` | 已加 **第 92 行**（系统表）+ **1 条机制汇总行**（交付—使用—效果三段）+ 表头覆盖范围 `41–92` | ✅ |

## 1 · ① T1 文档口径同步（保留历史，追加更正）

### 1.1 改了什么（只增不改）

| 位置 | 动作 |
|---|---|
| 标题区 blockquote | **新增**一行「口径更正（2026-11-08 追加，T22）」指向文末 §九 —— 不改原句 |
| 文末（原 §八 之后） | **新增 §九**「口径更正（2026-11-08 · T22）：T15 定点修后的当前口径」：§9.1 改前→改后逐项表、§9.2 polarity 快照口径、§9.3 当前 `stats` 快照、§9.4 受影响的旧结论、§9.5 复算命令 |
| 正文已有段落（§一/§三/§五/§六/§八） | **一字未改**（旧数字全部保留，由 §九 标注为「改前」） |

### 1.2 改前 → 改后（§9.1 的摘要，供快速核对）

| 项 | 改前（原文保留） | 改后（当前 `label-set.json`） |
|---|---|---|
| 难负例 | 49 条 | **50 条**（`#4` 进入 `hard`）。**遗留**：`evidence/label-hard-negatives.json` 仍是 49 条（不在可写面）⇒ 待同步 49 → 50 |
| `irrelevant` 占比 | 63/135 = 46.7% | **64/135 = 47.4%** |
| `polarityReport.usableForDecision` | `true` | **`false`**（T1 快照口径；HEAD 判据 19.26% < 30% ⇒ 不可用于决策） |
| `same` 层 | 19 条 / 机械可判 19（100%） | **17 条 / 定义符合率 17/17（100%）**；**改前真实符合率 17/19（89.5%）** |
| `rel` 层 | 24 条 | **25 条**（`#14` 移入） |
| `hard` 层 | 49 条 | **50 条**（`#4` 移入） |
| 「误判清单」 | 12 条 | **13 条**（原 12 + `#4`；固定 id `4,64,65,66,67,68,69,76,77,78,80,81,82`） |
| §四「去掉 same/dir 两层」 | 101 对 / 13 可判 / 12.9% | **103 对 / 15 可判 / 14.6%** |
| §四「12 条退回 unclear」 | 33/135 = 24.4% | **32/135 = 23.7%**（快照口径算术说明） |
| §六 难负例分布 | `2:7·3:17·4:13·5:10·6:2` | **`2:7·3:18·4:13·5:10·6:2`**（多一条 `3` = `#4`） |

**`#4` / `#14` 处置（已写进 §9.1 末尾）**：`#4` `verdict: relevant → irrelevant` 且 `stratum: same → hard`（claim 与信号跨局、跨 scope、只共享「内存/显存」泛词、LCS 仅 3 字）；`#14` 仅 `stratum: same → rel`（同局同对象、`verdict: relevant` 不动）。两条 `why` 均保留原判依据（`#4` 追加改判理由）。

### 1.3 与 `label-set.json` 的一致性证据

§9.3 直接粘贴了当前 `stats` 快照（不是手写近似）——§3-A 的脚本把它解析回来与 `label-set.json` 深度比较，结果为 `true`；§9.5 还给了任何人可复算的两条命令。

## 2 · ② 知识库第 92 篇：MemUse（交付 ≠ 使用）

### 2.1 来源核验（先核后写）

| 项 | 值 |
|---|---|
| 论文 | **Delivered, Not Used: Evaluating Agent Memory at Its Point of Use** |
| arXiv | [2611.01718](https://arxiv.org/abs/2611.01718)（v1，**2026-11-01 09:09:43 UTC**；无 v2） |
| 作者/机构 | Changran Xu / Zeju Li / Qiang Xu —— The Chinese University of Hong Kong, Department of Computer Science and Engineering |
| 读过的部分 | 正文 §1–§5；附录 A.1–A.5、A.6 的部分小节（HTML 版 [arxiv.org/html/2611.01718](https://arxiv.org/html/2611.01718)），访问 2026-11-08 |
| 未确认 | **未找到代码/数据 release 链接**；作者自陈 **"Agreement with human judgments has not been measured in this evaluation."**（裁判与人类一致率未测）；裁判能看到 gold patch；只测 SWE-bench Verified 一个基准；论文无单列 Limitations 章节 |
| 为什么是它（不是重复） | 00–91 已有 Mem0/Letta/Zep/Cognee/AWS/Memobase 等系统篇与判据篇；本篇是**第一篇"交付—使用—效果"三段式**评测（#42 只拆到 `candidates → surfaced → used`，本篇补 `used → effect（有益/有害）` 并给 8,000 局实测量级） |

### 2.2 对棋院最有用的 3 条机制（文章 §七/§九 展开）

1. **四段计数 `delivered → actedOn → beneficial → harmful`**：T9 ablation 不能只看 A/B 结果差——论文实测 resolve 差 ≤0.40pp（95% CI 全含 0），但投递条目的相关性/使用率差十倍；"结果平"不等于"记忆没用"。
2. **相关性 = 共享机制 / 适用程序**（原文："Sharing a topic, file, or function is insufficient; information drawn from another situation must state a shared mechanism or an applicable procedure."）：这是 T12 的「坑类/工具族」桥的外部依据，同时警告**只共享文件名/工具名不够**——桥必须落在机制上，否则就是 T1 的 hard 负例。
3. **`redundant` 是独立于 `relevant` 的轴**：论文实测 TencentDB 88.4%、Mem0 78.2% 的投递是重述，Mem0「仍在上下文中的条目的副本」占投递 token **68.1%**。给 `abstain.reason` 加第 5 类 `redundant`（静默丢弃、不计误杀）可以直接省预算，也把"误杀率"从"相关/不相关"升级成"有用/无用"两档。

### 2.3 索引改动

- `docs/调研/00-索引与机制对照.md`：表头覆盖范围 `41–91` → **`41–92`**；
- 「一、按机制汇总」新增一行 **交付—使用—效果三段（MemUse(92)）**，决定写「**采纳骨架、拒绝裁判**」；
- 「二、按系统逐篇」新增第 **92** 行（含关键数字与「可借/不借」）。

## 3 · 验证（可复现）

### A · T1 文档与 `label-set.json` 一致

```bash
node -e '
const fs=require("fs");
const md=fs.readFileSync("evidence/T1-label-expansion.md","utf8");
const j=JSON.parse(fs.readFileSync("evidence/label-set.json","utf8"));
const m=md.match(/### 9\.3[^\n]*\n[\s\S]*?```json\n([\s\S]*?)```/);
const block=JSON.parse(m[1]);
console.log("9.3 block == label-set.stats:", JSON.stringify(block)===JSON.stringify(j.stats));
'
# 实测输出：9.3 block == label-set.stats: true
```

### B · 关键数字在文中（防手滑）

```bash
grep -c "17 条 / 定义符合率 17/17" evidence/T1-label-expansion.md   # 1
grep -c "13 条" evidence/T1-label-expansion.md                     # 4（§9.1/§9.4/§9.5）
grep -c "47.4%" evidence/T1-label-expansion.md                     # 1
grep -c "50 条" evidence/T1-label-expansion.md                     # 3（§9.1/§9.4/§六更正）
```

### C · 92 篇与索引

```bash
ls docs/调研/92-MemUse-交付不等于使用-使用点评测-2026-11-08.md
grep -n "^| 92 |" docs/调研/00-索引与机制对照.md      # 112 行
grep -n "交付—使用—效果三段" docs/调研/00-索引与机制对照.md  # 23 行（机制汇总）
```

### D · 92 篇的行数/结构

```bash
wc -l docs/调研/92-MemUse-交付不等于使用-使用点评测-2026-11-08.md   # 115 行
grep -n "^## " docs/调研/92-MemUse-交付不等于使用-使用点评测-2026-11-08.md
# 一、它问的问题 … 九、对本项目的可执行建议（9 节）
```

## 4 · 未动面 / 工作树说明

| 路径 | 本任务是否改 | 说明 |
|---|---|---|
| `evidence/T1-label-expansion.md` | ✅ 改（可写面） | 标题区加 1 行指向 + 文末新增 §九；正文旧句未改 |
| `docs/调研/92-MemUse-…-2026-11-08.md` | ✅ 新建（可写面） | 第 92 篇 |
| `docs/调研/00-索引与机制对照.md` | ✅ 改（可写面） | 表头 + 机制行 + 第 92 行 |
| `evidence/T22-followup-and-research.md` | ✅ 新建（可写面） | 本文件 |
| `src/**` / `test/**` / `package.json` / `CHANGELOG.md` / `MAINTENANCE.md` / 版本号 | ❌ 未改 | 任务禁止 |
| `scripts/ablation-sandbox.mjs`、`test/ablation-sandbox.test.mjs` | ❌ 未改 | **不是本任务**：并行任务（T9）在本次期间改的；本任务只写上面四个可写面 |
| `install-superagent.cmd`（未跟踪） | ❌ 未改 | 开工前已存在 |

## 5 · 备注

1. **采集方式**：本机 `web_search` / `web_fetch` 插件的搜索/抓取端点不可用（magpie 只服务 chat，不服务 `/v1/search`、`/v1/fetch`），所以改用 **HTTPS 直读 arXiv**（`https://arxiv.org/abs/2611.01718` 与 `/html/2611.01718`，均 200）；本文件与 92 篇里的 URL 都是**实际取到页面**的链接，不是凭记忆写的。
2. **来源可信度**：arXiv 预印本，**未查到同行评审/会议接收信息**（v1、无 comments 字段）；因此 92 篇里所有数字都标 `[外]`，定位是"外部证据/机制来源"，不是"已验证的结论"。
3. **未把 arXiv 摘要当全文**：92 篇引用的方法细节（五信号表、triage 优先级、8,000 局、各百分比）都来自 HTML 正文/附录；只读到摘要级的部分（如 A.6 的逐配置表）在文中明确标了"未逐格核对"。
4. **索引第 92 行的链接**用的是文件名 `docs/调研/92-MemUse-*`（通配）；若以后重命名文件，需要同步改索引这一行。
5. **遗留一处（不在本任务可写面，未改）**：`evidence/label-hard-negatives.json` 仍是 **49 条**（`n=49`、`pairs` 49），而 `label-set.json` 现在有 **50 条**符合「`hard` 层 + `bigramRaw≥2` + `irrelevant`」的对（缺 `#4`）。
   - 建议修法：把 `label-set.json` 的 `#4` 整条搬进该文件的 `pairs`、`n` 49→50（`bigramRange` 仍 `[2,6]`）；这是 T1 时的人工产物，**不要**跑 `scripts/build-hard-negatives.mjs`——它写的是 **T1 之前的旧格式**（`confirmed`/`candidates`），会覆盖掉现有的 `version/supersedes/definition/pairs` 结构。
   - 影响面：无测试/脚本读它的条数（`grep` 过 `*.mjs`/`*.md`），只是数据卫生问题；已在 `evidence/T1-label-expansion.md` §9.1 标注「待同步」。
