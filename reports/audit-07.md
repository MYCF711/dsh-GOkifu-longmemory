# audit-07 · 独立审计（版本 / A3 表述 / 安装路径）

- 审计时间：2026-11-04 01:37–01:48（Asia/Shanghai）
- 仓库：`D:\DeepSeek Harness\default-workspace\长期记忆系统`（只读；本次仅写本文件）
- 审计方式：只跑命令与读文件，不做任何源码/配置改动
- **口径警告（审计期间仓库被并发改动）**：01:37 读到的版本是 `0.106.0`；01:39:32 `package.json` / `MAINTENANCE.md` / `CHANGELOG.md` 被另一会话改成 `0.107.0`（`git status` 显示三个文件均为 ` M`，未提交）。本报告数字以 **01:39 之后**的状态为准，前后快照不可混用。

## 结论

**有条件通过。**

三项核对里，版本号 / 测试条数一致，A3 表述如实，安装路径“重启后会加载”不仅成立而且已被当前进程实测。
两条未过项都不是造假，而是台账滞后与展示缺陷：

1. `node scripts/ledger-check.mjs` **FAIL**：claim 台账 836 vs 实测 852，超出脚本自设 ±12 容差；且该脚本 FAIL 时仍 `exit 0`，`check.mjs` 也不做数字交叉核对 ⇒ **`check PASS` 不能当作“台账数字对得上”的证据**。
2. `m5` 报告里 A3 的状态列打印成 `undefined`（`STATUS_LABEL` 缺 `live-idle`），人读表格看不到“live-idle”，虽然 JSON/内部字段是对的。

修掉这两条即可转为通过。

---

## 一、数字一致性

| 核对项 | 命令 | 关键输出 | 判定 |
|---|---|---|---|
| 版本（三处） | `node -e 'console.log(require("./package.json").version)'`；`read MAINTENANCE.md:13`；`read CHANGELOG.md:5` | pkg `0.107.0` · MAINTENANCE `当前版本 0.107.0` · CHANGELOG `## 0.107.0（2026-11-04）` | 一致 |
| 单元测试 | `node --test 2>&1 \| tail -8` | `tests 414 · pass 410 · fail 0 · cancelled 0 · skipped 4 · duration 4727ms` | 与 MAINTENANCE「414（410/0/4）」、CHANGELOG 0.107.0「验证」段一致 |
| 预检 | `node scripts/check.mjs` | 16 项 `ok`（private:true / version=0.107.0 / changelog 有当前版本段 / AGENTS §7 指针 / 调研清单 31 篇 / branch=main …），`check: PASS`，`exit=0` | PASS；但**不含**台账数字核对（见下行） |
| 台账自证 | `node scripts/ledger-check.mjs` | `台账 0.107.0 · 测试 414/410/0/4 · claim 836 · 卷 337` / `实测：版本 0.107.0 · 测试 414/410/0/4 · claim 852 · 卷 341` / `ERR claim：台账 836 vs 实测 852（容差 12，线上归档在涨）` / `ledger-check: FAIL` | **不一致**（+16 > 容差 12）；且失败时 `exit code 0` |
| 六轴 | `node scripts/m5-report.mjs`（123.8 s） | A1 **0.00%**(n=57) · A2 **22.64%**(n=508) · A3 `n/a`(n=4904，状态列 `undefined`) · A4 p50 **5.86ms**(n=50) · A5 **0.00%**(n=28) · A6 **100.00%**(n=28) | A2 对照台账 22.68% 差 **0.04pp**（容差 0.5pp）✔；A4 对照 7.20ms 差 **1.34ms**（容差 3ms）✔；A1/A5/A6 完全一致 |
| 语料 | `node scripts/cli.mjs audit`；`node scripts/install-doctor.mjs` | `claim 852 条`、`卷 341 个`；install-doctor `stats={"episodes":305,"claims":852}` | 台账 304 局 / 337 卷 / claim 836 ⇒ 局数 +1、卷 +4 在容差内，**claim +16 超容差**（同一条 FAIL） |
| 引用可追溯 | `cat evidence/M7-replay-live.md` | 只有「12 局全注入、沉默 0、warn 0」与每局 scope 表，**没有** `crossScopeRefs` 那一行 | MAINTENANCE 的「跨作用域 0」引这份证据不完整；今天可核验的来源是 m5 的 A5=0.00%（20 张卡/28 行，跨域 0） |
| 发布列表 | 读 MAINTENANCE「已发布」行 | 末项 `0.77.3`，之后 0.78–0.106 全缺（当前 0.107.0） | 陈旧（低危，不影响功能结论） |

小结：**版本与测试条数三处一致、可复算**；六轴在脚本自设容差内；唯一硬冲突是 claim 计数超容差，另有两处追溯/陈旧问题（发布列表、跨作用域 0 的证据出处）。

## 二、A3 表述诚实度

| 核对项 | 命令 / 文件 | 关键输出 | 判定 |
|---|---|---|---|
| 心跳现状 | `node scripts/live-stats.mjs` | `共 4882 行 · 2026/11/3 20:09:20 → 2026/11/4 01:37:26 · shadow 0 行`；`动作：skip=4882`；`原因：no-signal=4705 · no-hit=177`；`tokens：p50 35 · p95 35 · max 39` | 全部 skip |
| 逐行动作统计 | `node -e` 解析 `live-stats.jsonl` | 4884 行全部 `action:"skip"`，**inject=0、failed=0**；`src` 全为 `index.js`；pid 共 5 个（34576 / 23072 / 44724 / 3364 / 20300） | 与「0 次注入」一致 |
| 指标实现 | `grep -rn "measureA3" scripts/ src/` → `scripts/m5-report.mjs:449` | `status: injects + failed > 0 ? 'live' : 'live-idle'`；`value: null`；caveat：「还没有一次真正的注入尝试（当前会话信号都未命中）⇒ 注入可靠性仍未受检，**不能把 null 当 0**」 | 口径正确 |
| 证据文件 | `cat evidence/M7-A3-live.md` | 「不是 `not-live` 了…但**还没有一次真正的注入尝试**…不能把 null 当 0，也**不能说“注入可靠性已验证”**」 | 如实 |
| 台账表述 | `MAINTENANCE.md:28` / `:37` | 六轴行写 `A3 live-idle`；未决项写「A3 现有 `replay-live` **离线**证据（12 局全注入、跨作用域 0）」 | 如实（明确标了离线） |

判定：**“A3=live-idle、0 次注入”被如实表达，没有夸大。**
三处（m5 caveat、evidence、MAINTENANCE）都明说“注入可靠性未受检 / 不能把 null 当 0”；`live-idle` 是脚本按 `inject+failed==0` 机械判出来的，不是人手写的美化词。

两条瑕疵（属缺陷，不属夸大）：

- `scripts/m5-report.mjs` 的 `STATUS_LABEL` 只定义 `measured` / `not-live` / `not-consumed`，缺 `live` 与 `live-idle` ⇒ 控制台表格 A3 行打印 `undefined`（实测 `A3  可靠性（注入失败率）  n/a  4904  undefined`）。状态字段本身是 `live-idle`，`--json` 正常，但人读报告失真。文件头注释（`status: measured|not-live|not-consumed`）同样没更新。
- `evidence/M7-A3-live.md` 里「`pid` 稳定」只对该 30 分钟窗口成立；现存 pid 已有 5 个（重启导致，属正常，但作为“硬证据”的措辞需限定时间窗）。

## 三、安装路径（“重启后会加载”）

| 核对项 | 命令 / 文件 | 关键输出 | 判定 |
|---|---|---|---|
| 预检 | `node scripts/preflight-bundle.mjs` | `- kifu-loader: patch ./cordis.patch.yml（7 行）`；`- 插入：id=kifu-memory name=kifu-loader（来自 kifu-loader）`；`PASS：所有 bundle 的 patch 都已声明，插入 id 未被禁用` | PASS |
| 包声明 | `cat packages/kifu-loader/package.json` | `main: index.mjs`；`exports` 含 `.` / `./cordis.patch.yml` / `./package.json`；`dsh.bundle.patch: ./cordis.patch.yml`；`files: ["index.mjs","cordis.patch.yml"]` | 合法声明 |
| patch 内容 | `cat packages/kifu-loader/cordis.patch.yml` | 仅 `- insert: [ { id: kifu-memory, name: kifu-loader } ]` | 只做插入，不改别的条目 |
| 是否被禁用 | `grep -n "kifu" -A4 -B4 home/profiles/desktop/cordis.patch.yml` | 两处 `disabled: true` 的 id 是 `kifu-longmemory` / `dsh-gokifu-longmemory`（原包名），**不含** `kifu-memory` | 未禁用 |
| 宿主能否解析 | `node --input-type=module -e "import('kifu-loader')…"`（cwd=profile） | `name= dsh-gokifu-longmemory \| HOOK= agent/pre-step \| exports= 31 \| enabledDefault= true \| shadow= false` | 可加载，且默认启用、非影子 |
| 链接形态 | `ls -la node_modules/kifu-loader` + `realpathSync` | 符号链接 → `…/长期记忆系统/packages/kifu-loader` | 链接安装 |
| 是否真的在跑（实证） | `live-stats.jsonl` 末行 + `Get-Process -Id 20300` | 末行 `{"at":1793727462171,"pid":20300,…,"scope":"w:d:/DeepSeek Harness/default-workspace/长期记忆系统","scopeFrom":"session-log","action":"skip"…}`；pid 20300 = `DeepSeek Harness`，`StartTime 2026-11-4 1:22:01`（晚于 patch 的 01:12） | **已加载并在跑** |
| 安装医生 | `node scripts/install-doctor.mjs` | `ok 插件注册（启用，而非仅出现）…启用 1 处 · 禁用 2 处`；`ok 历史禁用块（不影响别名包）…当前通过 kifu-loader 别名挂载，可忽略`；`ok 记忆库 verify · files=6872 errors=0`；`install-doctor: PASS` | PASS |

判定：**“重启后会加载”成立**，而且强于命题本身——当前宿主（01:22:01 重启）已经在跑，心跳持续到 01:37，`scopeFrom=session-log` 说明作用域取自会话日志而非 profile 目录。
机制链路完整：`package.json` 依赖 `kifu-loader`（link）→ profile `dsh.profile.bundles` 含 `kifu-loader` → 包内 `dsh.bundle.patch` 声明 → patch 插入 `kifu-memory`（id 未被禁用）→ `index.mjs` re-export 真实插件。

唯一风险（真风险，不是假想）：`packages/kifu-loader/index.mjs` 的 `export * from '../../src/plugin.mjs'` 依赖**符号链接**安装；而包 `files` 只含 `index.mjs` + patch，不含 `src/`。一旦改成复制/打包安装（或仓库挪位置），会在加载期 `ERR_MODULE_NOT_FOUND`，而 `preflight-bundle.mjs` 只查“patch 是否声明 + id 是否被禁用”，**查不出**这种失败。

---

## 建议（3 条）

1. **把台账数字变成硬门**：`ledger-check` 现在 FAIL 也 `exit 0`，且 `check.mjs` 不含数字核对，发版流程容易带着 stale 台账出门。建议 ① FAIL 时 `exit 1` 并接进 `release.mjs`/CI；② MAINTENANCE 语料行更新为实测 `305 局 / 341 卷 / claim 852`（或把 claim 容差按“宿主内归档在涨”调到 ≥16，并在行内注明取样时刻）；③ 补「已发布」列表 0.78–0.107。
2. **修 `m5` 的状态标签**：给 `STATUS_LABEL` 补 `live: 'live'`、`live-idle: 'live-idle（等首次命中）'`，并同步文件头注释的状态枚举；否则 A3 在控制台永远显示 `undefined`，读者会以为指标坏了。
3. **让 kifu-loader 与安装方式解耦**：把被 re-export 的 `src/plugin.mjs` 纳入包（或改成 `exports` 子路径 + 显式依赖），并在 `preflight-bundle.mjs` 增加一条“loader 入口可解析（`import.meta.resolve`/`import()` 试解析）”检查，避免换安装形态后“重启也不加载”却预检全绿。
