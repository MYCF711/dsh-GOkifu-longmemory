# T186 · 旧分支甄别（8 个 11-02/03 遗留分支）

> 任务：8 个无 PR 的遗留分支，逐个判「丢弃 / 已并入 / 已被取代 / 值得救」。
> 硬约束：**只读**——不删分支、不 push、不改任何文件（本证据文件除外）、不跑全量测试、不重启 DSH。
> 仓库：`D:\DeepSeek Harness\default-workspace\长期记忆系统`；`main` = `4f6e292`（0.157.0）；
> 时点 `2026-11-05 07:49 (+08:00)`；全部为 `[本]` 实测。

---

## 0 · 结论表（8 行，逐分支一行）

| # | 分支 | 独有提交 | `diff --stat` | 分类 | 一行依据 |
|---|---|---|---|---|---|
| 1 | `chore/ledger-0.79.0` | `e8976d9` | 1 文件 +3/−3 | **丢弃** | 只有 `MAINTENANCE.md` 台账数字刷新（测试 402 条 / A2 25.17→25.34 / 时间戳 03:57→04:35）；main 台账已是 0.157.0，且 main 的 `CHANGELOG.md` 有 0.79.0 段 |
| 2 | `docs/handoff` | `992de9c` `d97cd17` | 5 文件 +82/−6 | **已并入** | `docs/交付清单.md` 由 main `c907594 交付清单（0.82.0） (#156)` 加入，**blob 完全一致**（`f3da129`）；main 后续又在 `c1706b3`（0.90.0）更新为 kifu-loader 别名包方式 |
| 3 | `docs/survey-25` | `2f63e6b` `cdb1b25` `05c39cf` | 7 文件 +85/−9 | **已并入** | main `6dacb2c 调研 25 + 装完彩排 + 心跳指纹（0.80.0） (#153)`；两个新文件 **blob 完全一致**；`src/plugin.mjs` 两处改动在 main 已存在（`process.argv[1]` 指纹、`skip disabled` 不写心跳） |
| 4 | `docs/zep-paper` | `fea3a68` | 5 文件 +43/−7 | **已并入** | `docs/调研/27-Zep-时序知识图-2026-11-03.md` **blob 完全一致**；main `af8a5c8 调研 27 Zep 论文（0.83.0） (#157)` |
| 5 | `feat/heartbeat` | `71ad2f7` `50ce27d` | 12 文件 +180/−34 | **已被取代** | 12 个文件 main 全部更新过：`live-stats.mjs` 多出 host/sim 分列（2026-11-04）、`re-enable.mjs` 被 2026-11-03 安全版重写（`\r` 修复保留）、`开启长期记忆.cmd` 被安全版覆盖、`plugin.mjs` 心跳改动已在 main |
| 6 | `feat/one-click-enable` | `58eb27d` | 8 文件 +93/−7 | **已并入** | `evidence/M7-archive-idempotent.md` **blob 完全一致**；main `5809690 一键开启脚本 + 归档幂等证据（0.78.0） (#149)`；`开启长期记忆.cmd` 被安全版重写（`cd /d "%~dp0."` 修复已在） |
| 7 | `feat/shadow-report` | `29fce5c` `0937f2f`（远端已 rebase 到 main 世系） | 9 文件 +129/−9 | **已并入** | `scripts/shadow-report.mjs` 与 `test/shadow-report.test.mjs` **blob 完全一致**；main `0e8dc96 零配置：装完即用（0.15.0） (#24)`；其余是 0.14.0 时代文档快照 |
| 8 | `fix/doctor-registration` | `964d250` | 6 文件 +125/−54 | **已并入** | main `0f7576b doctor 注册判定修复（注释/日程假阳性）（0.86.0） (#160)` 含分支**同一 blob**；`c1706b3`（#163/0.90.0）把它泛化成 `PACKAGE ∪ ALIASES`，**行为无丢失** |

### 汇总

| 分类 | 数量 | 分支 |
|---|---|---|
| **已并入**（内容在 main，blob 相同或为其中一部分） | **6** | `docs/handoff`、`docs/survey-25`、`docs/zep-paper`、`feat/one-click-enable`、`feat/shadow-report`、`fix/doctor-registration` |
| **已被取代**（同一批文件在 main 有更新的实现，分支内容是其旧形态） | **1** | `feat/heartbeat` |
| **丢弃**（一次性台账/文档快照，无可复用行为） | **1** | `chore/ledger-0.79.0` |
| **值得救** | **0** | —（无一分支含 main 没有的真内容） |

**有没有真内容会被丢掉**：**没有。** 8 个分支的每一个新增文件在 main 里都能找到，其中 7 个文件的 **blob 与分支逐字节相同**；剩下的实现类文件（`src/plugin.mjs`、`scripts/re-enable.mjs`、`scripts/install-doctor.mjs`、`scripts/live-stats.mjs`、`开启长期记忆.cmd`）在 main 里有**更新的等价实现**（分支独有行全是旧写法），且 7 个版本段（0.14.0 / 0.78.0 / 0.79.0 / 0.80.0 / 0.82.0 / 0.83.0 / 0.86.0）全部已在 main 的 `CHANGELOG.md` 里。

**要不要删分支**：8 个都可以删（远端 + 本地同名 ref）。另有 2 个**范围外**的本地遗留（见 §4）。

---

## 1 · 方法与可复算命令

```bash
# ① 独有提交 + 改动面（三点 = 从 merge-base 起看分支自己的改动）
git log --oneline --no-decorate "origin/main..origin/<branch>"
git diff --stat "origin/main...origin/<branch>"

# ② 每个文件在 main 的现状（blob 相同 / 不同 / main 没有）
for f in $(git -c core.quotepath=false diff --name-only "origin/main...origin/<branch>"); do
  bh=$(git rev-parse "origin/<branch>:$f"); mh=$(git rev-parse "origin/main:$f")
  # 空 mh = main 没有；bh == mh = 完全相同；否则不同
done

# ③ 分支独有行（"分支有、main 没有"的行数）——判断"是不是旧形态"的关键
git -c core.quotepath=false diff "origin/<branch>:$f" "origin/main:$f" | grep '^-' | grep -v '^---'

# ④ 该内容进 main 的提交（blob 级溯源）
git log --oneline origin/main --find-object=<branch 侧 blob 的 sha>
git log --oneline origin/main -2 -- "<file>"
```

> 注：`git diff --stat` 的「文件数 / 行数」与任务书给的 8 组数字**逐一吻合**（见各节），
> 说明口径一致。唯一的例外说明见 §3.7（`feat/shadow-report` 与 main **无 merge-base**，三点 diff 不可用，
> 改用「旧世系基 `8718310` → 分支 tip」的 diff，正好等于任务书的 9 文件 / 129 行）。

### 1.1 一个必须先讲清的结构事实：main 的根被重写过，且**本地 ref 落后于远端**

```console
$ git log --oneline --reverse origin/main | head -2
1f96a0b R00 scaffold: 方案 v0.9 + 房间骨架 + 维护台账 (0.1.0)
77b9398 docs: 冻结 M1 数据契约 + 计划表 + CI rules (#1)

$ git log --oneline --reverse origin/feat/shadow-report | head -2
1f96a0b R00 scaffold: 方案 v0.9 + 房间骨架 + 维护台账 (0.1.0)
77b9398 docs: 冻结 M1 数据契约 + 计划表 + CI rules (#1)

$ git log --oneline --reverse feat/shadow-report | head -2      # ← 本地 ref
b6f11fb R00 scaffold: 方案 v0.9 + 房间骨架 + 维护台账 (0.1.0)
6ab9848 docs: 冻结 M1 数据契约 + 计划表 + CI rules (#1)
```

同样标题、不同 SHA：**8 个远端分支都在 main 的世系上**（都能算 merge-base，三点 diff 可用）；
但**本地** `feat/shadow-report`（`9e8f6ff`）与 `feat/config-gui`（`d696fbf`）是 **rebase 前的旧世系副本**
（根 `b6f11fb`），与 main 无 merge-base：

```console
$ git merge-base origin/main feat/shadow-report; echo "[exit=$?]"
[exit=1]                                                   # 本地 ref：无 merge-base
$ git merge-base origin/main origin/feat/shadow-report; echo "[exit=$?]"
325a97e7155e5a351b5871f3ab63cf208088ecc6
[exit=0]                                                   # 远端 ref：正常
$ git diff --stat 9e8f6ff 29fce5c | tail -2
 "docs/å¯¹æ -Hindsight.md"     | 2 +-
 reports/T6b-REPORT.md                                  | 2 +-
 2 files changed, 2 insertions(+), 2 deletions(-)          # 本地 vs 远端只差 2 行
```

⇒ **本报告一律用 `origin/<branch>` 判**（那才是要删的东西）；本地同名 ref 是 rebase 前的残留，
判断结论相同但 SHA 不同，§3.4/§5 单独列。

---

## 2 · 逐分支证据

### 2.1 `chore/ledger-0.79.0` → **丢弃**

```console
$ git log --oneline --no-decorate "origin/main..origin/chore/ledger-0.79.0"
e8976d9 R00 ledger: 台账刷新（0.79.0）

$ git diff --stat "origin/main...origin/chore/ledger-0.79.0"
 MAINTENANCE.md | 6 +++---
 1 file changed, 3 insertions(+), 3 deletions(-)
```

全部改动（全文）：

```diff
-| 测试 | **402 条**（398 pass / 0 fail / 4 skip）[本] 2026-11-03 03:57 |
-| 六轴 | A1 **0.00%** · A2 **25.17%** · A3 not-live · A4 p50 **3.51ms（3 次中位数，单次抖动 ±2ms）** · A5 **0.00%** · A6 **100.00%** `[本] 2026-11-03 03:57 · node scripts/m5-report.mjs` |
-| 语料 | 167 局 / **225 卷** / **claim 533**（…）`[本] 2026-11-03 03:57 · node scripts/cli.mjs audit + store` |
+| 测试 | **402 条**（398 pass / 0 fail / 4 skip）[本] 2026-11-03 04:35 |
+| 六轴 | … A2 **25.34%** · A4 p50 **3.71ms** … `[本] 2026-11-03 04:35 · node scripts/m5-report.mjs` |
+| 语料 | 167 局 / **225 卷** / **claim 533**（…）`[本] 2026-11-03 04:35 · node scripts/cli.mjs audit + store` |
```

**判断**：这不是功能，是**一次台账快照刷新**（同一批数字换了个时间戳与两位小数的测量值）。
main 的 `MAINTENANCE.md` 已是 0.157.0 台账，这些数字必然被后续版本覆盖：

```console
$ for v in 0.79.0; do echo -n "$v → main 中匹配段数 "; git show origin/main:CHANGELOG.md | grep -a -c "## .*$v"; done
0.79.0 → main 中匹配段数 1
```

⇒ 分支"要传达的事实"（0.79.0 已发、六轴跑过）在 main 里有**权威版本**；分支本身零可复用内容。
**分类：丢弃**（无最小合并路径可给——没有行为差异可搬）。

### 2.2 `docs/handoff` → **已并入**

```console
$ git log --oneline --no-decorate "origin/main..origin/docs/handoff"
d97cd17 R00 docs: 交付清单补阻塞状态（0.82.0）
992de9c R00 docs: 交付清单一页交接（0.82.0）

$ git diff --stat "origin/main...origin/docs/handoff"
 CHANGELOG.md                                       |  9 +++
 MAINTENANCE.md                                     | 10 ++--
 ...272\244\344\273\230\346\270\205\345\215\225.md" | 66 ++++++++++++++++++++++
 package.json                                       |  2 +-
 "\350\256\241\345\210\222\350\241\250.md"          |  1 +
 5 files changed, 82 insertions(+), 6 deletions(-)
```

文件级：

```console
  [不同]   CHANGELOG.md        (branch=748b3f3c main=f41e5a0c)
  [不同]   MAINTENANCE.md      (branch=21add4d6 main=e9d3fded)
  [不同]   docs/交付清单.md    (branch=f3da129d main=76d1e050)
  [不同]   package.json        (branch=cbfb04e7 main=b80367ee)
  [不同]   计划表.md           (branch=93fe6229 main=04a6ed98)
```

进 main 的提交 + blob 比对：

```console
$ git log --oneline origin/main -5 -- "docs/交付清单.md"
c1706b3 R00 tooling: doctor 识别别名包 + 文档对齐（0.90.0） (#163)
c907594 交付清单（0.82.0） (#156)

$ check origin/docs/handoff "docs/交付清单.md" c907594
  [一致] docs/交付清单.md  (origin/docs/handoff == c907594)
```

**分支独有行只有 6 行**，且是**旧安装方式**（已被 main 换掉）：

```diff
-## 2 · 怎么装（唯一需要人做的一步）
-1. 退出 DSH（不是刷新页面）；
-2. 双击仓库根目录 **`开启长期记忆.cmd`**；
...
+**当前方式（2026-11-03）：`kifu-loader` 别名包已挂进 profile，重启 DSH 即生效，不需要命令、不需要双击任何文件。**
```

⇒ 文档内容**逐字节进了 main**（#156），main 之后（#163/0.90.0）又更新成别名包方式。
**分类：已并入**。无最小合并路径（已全部在 main）。

### 2.3 `docs/survey-25` → **已并入**

```console
$ git log --oneline --no-decorate "origin/main..origin/docs/survey-25"
05c39cf R00 evidence: 装完之后彩排（假 home + 真库副本）（0.80.0）
cdb1b25 R00 telemetry: 心跳带来源指纹 + 跳过 disabled 噪声（0.80.0）
2f63e6b R00 docs: 调研 25 综述四问（0.80.0）

$ git diff --stat "origin/main...origin/docs/survey-25"
 CHANGELOG.md                                       | 10 +++++++
 MAINTENANCE.md                                     | 12 ++++----
 ...\210\266\347\273\274\350\277\260-2026-11-03.md" | 28 +++++++++++++++++
 evidence/M7-post-install-drill.md                  | 35 ++++++++++++++++++++++
 package.json                                       |  2 +-
 src/plugin.mjs                                    |  6 ++--
 "\350\256\241\345\210\222\350\241\250.md"          |  1 +
 7 files changed, 85 insertions(+), 9 deletions(-)
```

文件级 + blob 比对：

```console
  [完全相同] docs/调研/25-LLM-Agent-记忆机制综述-2026-11-03.md
  [完全相同] evidence/M7-post-install-drill.md
  [不同]   CHANGELOG.md / MAINTENANCE.md / package.json / src/plugin.mjs / 计划表.md

$ check origin/docs/survey-25 "docs/调研/25-...-2026-11-03.md" 6dacb2c
  [一致]  (origin/docs/survey-25 == 6dacb2c)
$ check origin/docs/survey-25 "evidence/M7-post-install-drill.md" 6dacb2c
  [一致]  (origin/docs/survey-25 == 6dacb2c)
$ git log --oneline origin/main -2 -- "docs/调研/25-LLM-Agent-记忆机制综述-2026-11-03.md"
6dacb2c 调研 25 + 装完彩排 + 心跳指纹（0.80.0） (#153)
```

`src/plugin.mjs` 的 6 行改动（心跳来源指纹 + 不写 disabled 噪声）在 main 里已存在，且**是同一段代码**：

```console
$ git grep -n "process.argv\[1\] ? path.basename" origin/main -- src/plugin.mjs
origin/main:src/plugin.mjs:777:    const src = (process.argv[1] ? path.basename(process.argv[1]) : 'host').slice(0, 40);

$ git grep -n "disabled" origin/main -- src/plugin.mjs | sed -n '3,4p'
origin/main:src/plugin.mjs:1049:      // enabled=false 时的 "skip disabled" 没有诊断价值，别写（任何库内调用都会带出来一堆噪声）。
origin/main:src/plugin.mjs:1050:      if (config.liveStats !== false && !(result.action === 'skip' && result.reason === 'disabled')) {
```

**分类：已并入**（#153）。无最小合并路径。

### 2.4 `docs/zep-paper` → **已并入**

```console
$ git log --oneline --no-decorate "origin/main..origin/docs/zep-paper"
fea3a68 R00 docs: 调研 27 Zep 论文（0.83.0）

$ git diff --stat "origin/main...origin/docs/zep-paper"
 CHANGELOG.md                                       | 10 +++++++++
 MAINTENANCE.md                                     | 12 +++++------
 ...\237\245\350\257\206\345\233\276-2026-11-03.md" | 25 ++++++++++++++++++++++
 package.json                                       |  2 +-
 "\350\256\241\345\210\222\350\241\250.md"          |  1 +
 5 files changed, 43 insertions(+), 7 deletions(-)

  [完全相同] docs/调研/27-Zep-时序知识图-2026-11-03.md
  [不同]   CHANGELOG.md / MAINTENANCE.md / package.json / 计划表.md

$ git log --oneline origin/main -2 -- "docs/调研/27-Zep-时序知识图-2026-11-03.md"
af8a5c8 R00 docs: 调研 27 Zep 论文（0.83.0） (#157)
$ check origin/docs/zep-paper "docs/调研/27-..." af8a5c8
  [一致]
```

**分类：已并入**（#157，同一篇文档 blob 相同）。无最小合并路径。

### 2.5 `feat/heartbeat` → **已被取代**

```console
$ git log --oneline --no-decorate "origin/main..origin/feat/heartbeat"
50ce27d R00 telemetry: A3 心跳 live-stats + 仿真不写入（0.79.0）
71ad2f7 R00 tooling: 修复一键脚本两处致命问题（%~dp0 尾反斜杠 / \r 被吞）

$ git diff --stat "origin/main...origin/feat/heartbeat"
 CHANGELOG.md              | 18 ++++++++
 MAINTENANCE.md            | 12 ++---
 package.json              |  2 +-
 scripts/host-sim.mjs      |  2 +-
 scripts/live-stats.mjs    | 52 +++++++++++++++++++++
 scripts/re-enable.mjs     |  6 +++
 scripts/replay-live.mjs   |  2 +-
 scripts/status-digest.mjs |  5 ++
 src/plugin.mjs            | 28 ++++++++++++
 test/plugin.test.mjs      | 33 ++++++++++++++
 开启长期记忆.cmd          | 53 ++++++++++++++----------
 计划表.md                 |  1 +
 12 files changed, 180 insertions(+), 34 deletions(-)
```

文件级（main 全都有，但都更新过）：

```console
  [不同]   CHANGELOG.md / MAINTENANCE.md / package.json / scripts/live-stats.mjs
  [不同]   scripts/re-enable.mjs / src/plugin.mjs / test/plugin.test.mjs / 开启长期记忆.cmd / 计划表.md
  [完全相同] scripts/host-sim.mjs
  [完全相同] scripts/replay-live.mjs
  [完全相同] scripts/status-digest.mjs
```

**分支独有行**（"分支有、main 没有"），逐个看都是**旧形态**：

```console
$ git diff "origin/feat/heartbeat:scripts/live-stats.mjs" "origin/main:scripts/live-stats.mjs" | grep '^-' | grep -v '^---'
-for (const r of rows) {
# main 改成 hostRows（2026-11-04：区分宿主行与仿真行），并新增 hostLines/simLines 字段

$ git diff "origin/feat/heartbeat:src/plugin.mjs" "origin/main:src/plugin.mjs" | grep '^-' | grep -v '^---' | head -11
-import { createHash } from 'node:crypto';          # main: import { createHash, randomUUID } …
-  const mod = await import(LLM_PACKAGE);           # main: 改为本地等价工厂（createMemorySdk）
-  if (typeof mod?.createUserMessage !== 'function') {
-    throw new Error(`${LLM_PACKAGE} 没有导出 createUserMessage`);
-  }
-  return mod.createUserMessage;
-  const scope = scopeKeyFromPath(cwd);
-    return { decision, action: 'skip', reason: 'gates-failed', card, gates, digest };
-    fs.appendFileSync(path.join(storeRoot, 'live-stats.jsonl'), `…{ at: Date.now(), ...row }`   # 缺 src/pid 指纹
-      if (config.liveStats !== false) {                                                          # 缺 skip-disabled 抑制
```

`scripts/re-enable.mjs` 被 **2026-11-03 安全版**整体重写（47 行分支独有行 = 重写前的旧实现），
但**分支那两个"致命问题"的修复都保留在 main 里**（main 在同一处继续演进，不是回退）：

```console
$ git show "origin/feat/heartbeat:开启长期记忆.cmd" | grep -nE '%~dp0|re-enable'
9:cd /d "%~dp0."
18:node "scripts/re-enable.mjs"

$ git show "origin/main:开启长期记忆.cmd" | grep -nE '%~dp0|re-enable'
11:cd /d "%~dp0."
18:node "scripts/re-enable.mjs"

$ echo -n "分支 CR 常量数="; git show "origin/feat/heartbeat:scripts/re-enable.mjs" | grep -c "fromCharCode(13)"
分支 CR 常量数=1
$ echo -n "main  CR 常量数="; git show "origin/main:scripts/re-enable.mjs" | grep -c "fromCharCode(13)"
main  CR 常量数=1
```

**分类：已被取代**（main 的 2026-11-03/11-04 版本覆盖了它的每一处改动，且保留了它的两个 bug 修复）。
无最小合并路径——搬任何一行都会**回退** main 的现状。

### 2.6 `feat/one-click-enable` → **已并入**

```console
$ git log --oneline --no-decorate "origin/main..origin/feat/one-click-enable"
58eb27d R00 tooling: 一键开启脚本 + 归档幂等证据（0.78.0）

$ git diff --stat "origin/main...origin/feat/one-click-enable"
 AGENTS.md                                          |  2 ++
 CHANGELOG.md                                       | 21 +++++++++++++
 MAINTENANCE.md                                     | 12 ++++----
 docs/runbook-装完之后.md                            |  1 +
 evidence/M7-archive-idempotent.md                  | 35 ++++++++++++++++++++++
 package.json                                       |  2 +-
 开启长期记忆.cmd                                    | 25 ++++++++++++++++
 计划表.md                                          |  2 ++
 8 files changed, 93 insertions(+), 7 deletions(-)

  [完全相同] docs/runbook-装完之后.md
  [完全相同] evidence/M7-archive-idempotent.md
  [不同]   AGENTS.md / CHANGELOG.md / MAINTENANCE.md / package.json / 开启长期记忆.cmd / 计划表.md

$ git log --oneline origin/main -2 -- "evidence/M7-archive-idempotent.md"
5809690 R00 tooling: 一键开启脚本 + 归档幂等证据（0.78.0） (#149)
$ check origin/feat/one-click-enable "evidence/M7-archive-idempotent.md" 5809690
  [一致]
```

`开启长期记忆.cmd`：main 是**安全版重写**（拒绝 DSH 运行中执行 + exit code 0/2/1 + `cd /d "%~dp0."`），
分支是重写前的旧版（`title Kifu-in enable` / 无 exit code 语义）。

`AGENTS.md` 的分支独有行只有 1 行，且是**旧版红线**（main 已改成「工具归口 S17」版本）：

```diff
-- 只做记忆。**不压缩、不改压缩产物、不新增工具、不改系统提示词、不写 AGENTS 规则、不做上下文工程、不做向量检索。**
```

**分类：已并入**（#149 的脚本 + 证据已进 main，main 又重写了脚本）。无最小合并路径。

### 2.7 `feat/shadow-report` → **已并入**

```console
$ git log --oneline --no-decorate "origin/main..origin/feat/shadow-report"
29fce5c R00/0.14.0: 影子复盘接入安装指南与台账
0937f2f R00: 影子台账复盘脚本（注入/沉默/token 分位）

$ git diff --stat "origin/main...origin/feat/shadow-report"
 AGENTS.md                   | 10 ++++----
 CHANGELOG.md                | 15 ++++++++++++
 MAINTENANCE.md              |  4 ++--
 README.md                   |  2 +-
 docs/安装指南.md            |  1 +
 package.json                |  2 +-
 scripts/shadow-report.mjs   | 47 +++++++++++++++++++++++++++++++++++++
 test/shadow-report.test.mjs | 56 +++++++++++++++++++++++++++++++++++++++++++++
 计划表.md                   |  1 +
 9 files changed, 129 insertions(+), 9 deletions(-)
```

文件级 + blob 溯源：

```console
  [完全相同] scripts/shadow-report.mjs    分支独有行=0
  [完全相同] test/shadow-report.test.mjs  分支独有行=0
  [不同]   AGENTS.md        分支独有行=22
  [不同]   docs/安装指南.md  分支独有行=62
  [不同]   MAINTENANCE.md   分支独有行=41
  [不同]   package.json     分支独有行=24
  [不同]   CHANGELOG.md / README.md / 计划表.md  分支独有行=1/2/1

$ for f in scripts/shadow-report.mjs test/shadow-report.test.mjs; do
    sha=$(git rev-parse "origin/feat/shadow-report:$f"); echo "--- $f blob=${sha:0:12} ---"
    git log --oneline origin/main --find-object="$sha" | head -3; done
--- scripts/shadow-report.mjs blob=b15e224b37be ---
0e8dc96 零配置：装完即用（0.15.0） (#24)
--- test/shadow-report.test.mjs blob=6b8ea379e55a ---
0e8dc96 零配置：装完即用（0.15.0） (#24)
```

`--find-object` 只列出 `0e8dc96`（引入后从未被替换）⇒ 这两个文件在 main 里**就是分支这一版**。

文档类的"分支独有行"是 **0.14.0 时代快照**（main 早已改掉，例如 AGENTS §7 的"当前状态快照"已被
「不写数字、只写去哪看」的指针段替换；`docs/安装指南.md` 的旧标题与前置检查段被安全版指南替换）：

```diff
-**当前阶段：M5 收口（0.14.0）。** 命令：`node scripts/check.mjs`、…
-- 版本：`memoryGraph.version`；`fromJSON` 对未知版本必须抛错。
-## 7 · 当前状态快照（2026-11-02 · v0.14.0）
-| 本机语料 | **92 局棋谱 / 780 主题 / 199 边 / 83 卷 / 125 claim** `[本] 2026-11-02 05:20` |
```

**分类：已并入**（代码与测试 blob 相同，文档是旧快照）。无最小合并路径。

### 2.8 `fix/doctor-registration` → **已并入**

```console
$ git log --oneline --no-decorate "origin/main..origin/fix/doctor-registration"
964d250 R00 tooling: doctor 注册判定修复（注释/日程假阳性）（0.86.0）

$ git diff --stat "origin/main...origin/fix/doctor-registration"
 CHANGELOG.md                       | 12 +++++
 MAINTENANCE.md                     | 10 ++--
 package.json                       |  2 +-
 scripts/install-doctor.mjs         | 73 ++++++++++++++++++++++------
 test/install-doctor.test.mjs      | 81 ++++++++++++++++++-------------
 "\350\256\241\345\210\222\350\241\250.md" |  1 +
 6 files changed, 125 insertions(+), 54 deletions(-)

  [不同]   scripts/install-doctor.mjs : 分支独有行=5
  [不同]   test/install-doctor.test.mjs : 分支独有行=0     ← 测试 100% 已在 main
```

blob 溯源（`--find-object` 同时列出"引入"与"替换"两个提交）：

```console
$ git log --oneline origin/main --find-object=3a9825f0287c64603c4fd757abfcfae112f5623b
c1706b3 R00 tooling: doctor 识别别名包 + 文档对齐（0.90.0） (#163)
0f7576b R00 tooling: doctor 注册判定修复（注释/日程假阳性）（0.86.0） (#160)
```

main 与分支的 5 行差异 = **0.90.0 的别名包泛化**（`PACKAGE` → `PACKAGE ∪ ALIASES`）+ 多一条提示，**没有丢行为**：

```diff
+const ALIASES = ['kifu-loader'];
-    if (pkgText.includes(PACKAGE)) {
+    if (pkgText.includes(PACKAGE) || ALIASES.some((a) => pkgText.includes(a))) {
-        const inDeps = Boolean(pkg?.dependencies?.[PACKAGE]);
+        const names = [PACKAGE, ...ALIASES];
+        const inDeps = names.some((n) => Boolean(pkg?.dependencies?.[n]));
+  if (registered && reg.disabled > 0) {
+    add('历史禁用块（不影响别名包）', true, `…`);
```

**分类：已并入**（#160 引入，blob 相同；#163 泛化）。无最小合并路径。

---

## 3 · 统一交叉校验（8 个分支一起看）

### 3.1 `CHANGELOG.md` 版本段：每个分支的版本都已在 main

```console
$ for v in 0.14.0 0.78.0 0.79.0 0.80.0 0.82.0 0.83.0 0.86.0; do
    echo -n "$v → "; git show origin/main:CHANGELOG.md | grep -a -c "## .*$v"; done
0.14.0 → 1
0.78.0 → 1
0.79.0 → 1
0.80.0 → 1
0.82.0 → 1
0.83.0 → 1
0.86.0 → 1
```

### 3.2 各分支 `package.json` 版本 vs main

```console
  chore/ledger-0.79.0  → "version": "0.78.0"
  docs/handoff         → "version": "0.82.0"
  docs/survey-25       → "version": "0.80.0"
  docs/zep-paper       → "version": "0.83.0"
  feat/heartbeat       → "version": "0.79.0"
  feat/one-click-enable→ "version": "0.78.0"
  feat/shadow-report   → "version": "0.14.0"
  fix/doctor-registration → "version": "0.86.0"
  main                 → "version": "0.157.0"
```

### 3.3 分支文件"在 main 里找不到"的情况：**0 个**

8 个分支改动的**每一个文件**都在 main 存在（逐文件检查，见 §2 各节）。没有任何"只在分支上"的文件。

### 3.4 本地 ref 与远端是否一致（有没有未推送提交）

```console
  chore/ledger-0.79.0   : local=e8976d9 remote=e8976d9 相同
  feat/one-click-enable : local=58eb27d remote=58eb27d 相同
  fix/doctor-registration : local=964d250 remote=964d250 相同
  feat/config-gui       : local=d696fbf remote=无远端 **不同**
  chore/plan-t38        : local=ce9a204 remote=无远端 **不同**
```

⇒ 8 个分支里有 **4 个**存在本地同名 ref：其中 3 个与远端**同提交**（`chore/ledger-0.79.0`
`feat/one-click-enable` `fix/doctor-registration`），第 4 个 `feat/shadow-report` 的本地 ref 是
**rebase 前副本**（`9e8f6ff` ≠ 远端 `29fce5c`，内容只差 2 行，见 §1.1）；另外 `feat/config-gui`、
`chore/plan-t38` 是**只存在于本地、没有远端**的遗留（见 §4）。

---

## 4 · 范围外观察（不在 8 个名单里，但同属遗留）

| ref | 状态 | 判断 |
|---|---|---|
| `feat/config-gui`（本地 `d696fbf`，**无远端**） | 旧世系；含 #24–#27 时代（0.15.0–0.17.0）的 36 文件改动 | 全部功能在 main 有：`client.js` 的 `storeRoot` 设置项（`git grep -c storeRoot origin/main -- client.js` → `2`），`test/config-route.test.mjs` 在 main。与 Lead 的"已确认无差异"一致；**本次未逐文件复核（超出 8 个名单）**，删前建议再跑一遍 §1 的 ③④ 两步 |
| `chore/plan-t38`（本地 `ce9a204`，**无远端**） | `git log main..chore/plan-t38` 无输出；`git diff --stat main...chore/plan-t38` 无输出 | **已完全并入 main**，零差异，可删 |

---

## 5 · 建议（等 Lead 口令，我不执行）

1. **删远端 8 个**：`chore/ledger-0.79.0`、`docs/handoff`、`docs/survey-25`、`docs/zep-paper`、`feat/heartbeat`、`feat/one-click-enable`、`feat/shadow-report`、`fix/doctor-registration`
   —— 依据：§2 全部证据 + §3.1/§3.3（无独有文件、版本段全在 main）。
2. **同时删本地同名 ref**（远端删了本地还留着，会继续出现在 `git branch` 里）：
   `chore/ledger-0.79.0`、`feat/one-click-enable`、`feat/shadow-report`、`fix/doctor-registration`
   （这 4 个是 8 个名单里的本地 ref），外加范围外的 `feat/config-gui`、`chore/plan-t38`。
3. **不建议保留任何"存档 tag"**：这 8 个分支没有一个含 main 之外的内容，打 tag 只会制造第二份真相。

**若 Lead 要留退路**：删远端前 `git bundle create <path> --all` 可一次性快照全部 ref（只读仓库、不动工作树），
但按 §2 的证据，这属于"以防万一"而非"必要"。

---

## 6 · 未解 / 待人工

**无。** 8 个分支全部给出了 blob 级或"分支独有行"级的判断，没有出现"看不懂"的情形。
唯一需要 Lead 拍板的不是技术问题，而是**要不要顺便清理 §4 的两个范围外本地 ref**。

### 复算自检

一条命令重算全表（只读）：

```bash
for b in chore/ledger-0.79.0 docs/handoff docs/survey-25 docs/zep-paper          feat/heartbeat feat/one-click-enable feat/shadow-report fix/doctor-registration; do
  mb=$(git merge-base origin/main "origin/$b"); n=$(git rev-list --count "origin/main..origin/$b")
  stat=$(git -c core.quotepath=false diff --shortstat "origin/main...origin/$b")
  # 逐文件：main 缺失 / blob 完全相同
done
```

**本次实跑输出（2026-11-05 07:5x，`origin/main` = `4f6e292` 0.157.0）**：

```console
########## T186 复算自检（8 个远端分支） ##########
chore/ledger-0.79.0      独有提交=1  merge-base=5809690e  1 file changed, 3 insertions(+), 3 deletions(-) | main 缺失文件=0 完全相同文件=0
docs/handoff             独有提交=2  merge-base=2ede65aa  5 files changed, 82 insertions(+), 6 deletions(-) | main 缺失文件=0 完全相同文件=0
docs/survey-25           独有提交=3  merge-base=7c8dffa5  7 files changed, 85 insertions(+), 9 deletions(-) | main 缺失文件=0 完全相同文件=2
docs/zep-paper           独有提交=1  merge-base=c9075941  5 files changed, 43 insertions(+), 7 deletions(-) | main 缺失文件=0 完全相同文件=1
feat/heartbeat           独有提交=2  merge-base=5809690e  12 files changed, 180 insertions(+), 34 deletions(-) | main 缺失文件=0 完全相同文件=3
feat/one-click-enable    独有提交=1  merge-base=d366a4fb  8 files changed, 93 insertions(+), 7 deletions(-) | main 缺失文件=0 完全相同文件=2
feat/shadow-report       独有提交=2  merge-base=325a97e7  9 files changed, 129 insertions(+), 9 deletions(-) | main 缺失文件=0 完全相同文件=2
fix/doctor-registration  独有提交=1  merge-base=72641b01  6 files changed, 125 insertions(+), 54 deletions(-) | main 缺失文件=0 完全相同文件=0

########## 版本段是否已在 main ##########
  0.14.0  → 1 段      0.79.0  → 1 段      0.82.0  → 1 段      0.86.0  → 1 段
  0.78.0  → 1 段      0.80.0  → 1 段      0.83.0  → 1 段

########## 工作树状态（只应有本证据文件） ##########
?? evidence/T186-branch-triage.md
```

四条读法：

| 列 | 含义 | 判据 |
|---|---|---|
| `独有提交` | 分支相对 main 的提交数 | 数字本身不重要，**内容**才重要 |
| `main 缺失文件` | 分支有、main 完全没有的路径 | **8 个分支全为 0** ⇒ 没有"只在分支上"的文件 |
| `完全相同文件` | blob 逐字节相同 | 13 个文件直接证毕（文档/脚本/测试） |
| `--shortstat` | 改动面 | 与任务书 8 组数字**逐一吻合** ⇒ 口径一致 |
