# audit-08 · 第二轮复核（只核 audit-07 的 5 条，不扩展）

- 审计时间：2026-11-04 02:03–02:24（Asia/Shanghai）
- 仓库：`D:\DeepSeek Harness\default-workspace\长期记忆系统`
- 口径锚点：`HEAD = c862efd「R00 fix: audit-07 修复（0.108.0）(#184)」`，`git status --porcelain` 为空（工作树干净，无并发改动）；`package.json` = `0.108.0`，`v0.108.0` tag 指向同一提交。
- 写入：仅本文件。源码、配置、证据、台账一字未改（唯一临时产物在系统临时目录，见 §4，不在仓库内）。

## 结论

**有条件通过。**

5 条里 **4 条成立、1 条部分成立（第 3 条）**。四条成立项都不是"文档声称已改"，而是我当场跑出来的：`ledger-check --full` 真 PASS 且 `exit 0`；`m5` 状态列不再有 `undefined`；`preflight-bundle` 的动态导入段在**模拟复制安装**下确实 FAIL（退出 1）；`M7-replay-live.md` 的口径纠正已落地且指向一个可复算的读数。

条件（不阻塞交付，见 §5）：已发布列表并未真"补全到 0.108"（缺 8 个已发 tag），CHANGELOG 的对应表述与事实不符。

## 一、五条逐条判定

| # | 复核项 | 判定 | 一句话理由 |
|---|---|---|---|
| 1 | ledger 容差改按比例 2%（下限 12） | **成立** | `--full` PASS、`exit 0`；边界实测：+18 过、+19 FAIL、×2/×10 全 FAIL |
| 2 | `STATUS_LABEL` 补 live / live-idle | **成立** | 5 种状态全在表内，实跑 A3 打印 `live-idle（线上在跑但无注入）`，无 `undefined` |
| 3 | 「已发布」补到 0.108 | **部分成立** | 抽查三项在列，但 0.80.0–0.87.0 共 8 个已发 tag 整段缺失，且 0.78/0.79 段重复 |
| 4 | preflight 动态导入段能捕获 re-export 断裂 | **成立** | 模拟"只复制 index.mjs"→ `FAIL`、`exit 1`、报错直指缺失的 `src/plugin.mjs` |
| 5 | `M7-replay-live.md` 补跨作用域口径纠正 | **成立** | 第 22–24 行明写"请引 m5 A5 读数"，本次 `A5 = 0.00%（n=28）`可复算；瑕疵：台账侧未跟（见 §5-R3） |

## 二、逐条细节

### 1 · ledger-check：容差与边界行为

命令：

```
node scripts/ledger-check.mjs --full
```

输出（完整）：

```
ledger-check：台账 0.108.0 · 测试 414/410/0/4 · claim 852 · 卷 341
实测：版本 0.108.0 · 测试 414/410/0/4 · claim 852 · 卷 341
ledger-check: PASS
EXIT=0
```

代码核对（`scripts/ledger-check.mjs` 的 `LIVE_DRIFT` 与 `compare`）：

- `LIVE_DRIFT = { claim: 12, threads: 12, episodes: 12 }`（只用**下限**）。
- `scale(v, base) = live ? Math.max(base, Math.ceil(v * 0.02)) : 0`，其中 `v` 传的是**实测值**。
- `live` 判据：`<DSH_HOME>/memory-context/live-stats.jsonl` 的 `mtime` 在 15 分钟内。本次该文件 02:03 仍在写 ⇒ `live = true`。
- 差值与容差比较用 `>`（等于容差仍算通过），方向不分正负（掉数也会 FAIL）。

我用 `compare()` 直接做边界实验（不写文件，纯函数调用）：

| 台账 claim | 实测 claim | live | 结果 |
|---|---|---|---|
| 852 | 852（一致） | true | PASS |
| 852 | 862（+10 正常增长） | true | PASS |
| 852 | 868（+16，正是 audit-07 那次） | true | PASS ← 原误报已消 |
| 852 | 870（+18 = 2% 边界） | true | PASS |
| 852 | 871（+19，超一格） | true | **FAIL**（容差 18） |
| 852 | 1852（×2） | true | **FAIL**（容差 38） |
| 852 | 8520（×10） | true | **FAIL**（容差 171） |
| 852 | 426（掉一半） | true | **FAIL** |
| 852 | 868（+16，宿主停机 15 min 后） | false | **FAIL**（容差 0） |

判断：**「正常增长不误报、量级错误仍 FAIL」成立。** 比例容差随实测值缩放，量级错（×2 差 1000 ≫ 容差 38）挡得住；2% 以内的真实归档漂移不再误报。

两点必须记清：

- 本轮 PASS **不依赖容差**：台账 852/341/305 与实测逐项相等（我另跑 `cli audit --json` = `claims 852 / threads 341`，`createStore().list('episodes')` = `305`），所以即使 `live=false`（容差 0）也会 PASS。
- `live=false` 时容差为 0，任何漂移都 FAIL。逻辑上自洽（宿主没跑，计数也就冻住），但若 `live-stats.jsonl` 缺失（换机、清缓存、`DSH_HOME` 指向别处），台账只要涨了 1 条就红。

**附带核实 CHANGELOG 的"误读"说明**：`git blame` 显示 `process.exit(out.ok ? 0 : 1)` 自 `ce9a204`（0.60.0）起就存在，0.108.0 未改这一行。**audit-07 记的"FAIL 仍 exit 0"确属管道取尾部（`| tail`）造成的测量假象，不是造假、也不是本轮修的**。这条说明属实。

### 2 · m5 状态标签

命令与关键输出：

```
node scripts/m5-report.mjs      # 270758 ms（与另一个 m5 并发，见 §5-R2）
A3  可靠性（注入失败率）               n/a       5617   live-idle（线上在跑但无注入）
```

六行状态依次为 `measured / measured / live-idle / measured / measured / measured`，**无一处 `undefined`**。

代码：`STATUS_LABEL` 现为 5 项（`measured` / `not-live` / `not-consumed` / `live` / `live-idle`），`AXIS_STATUSES` 也是同样 5 项且 `axis()` 对非法值抛错 ⇒ 任何能通过构造的 status 都必在标签表内，`undefined` 在结构上已被堵死。

瑕疵（不影响判定）：`scripts/m5-report.mjs` 的**文件头注释**第 7 行与 markdown 状态说明（`renderM5Markdown` 末尾那句）仍只列 `measured|not-live|not-consumed` 三态，没同步到 5 态。纯注释滞后。

### 3 · MAINTENANCE「已发布」列表

抽查：`0.89.0`（kifu-loader 别名包）、`0.104.0`（索引缓存+漂移容差）、`0.108.0`（audit-07 修复）**三项均在列** ✔。

但"补到 0.108"这个说法不成立。把列表与 `git tag` 对了一遍：

| 对比项 | 事实 |
|---|---|
| tag 有、列表无 | `v0.80.0` `v0.81.0` `v0.81.1` `v0.82.0` `v0.83.0` `v0.84.0` `v0.85.0` `v0.87.0`（8 个），列表从 `0.79.0` 直接跳到 `0.89.0` |
| 列表有、tag 无 | `0.97.0`、`0.107.0`（`git tag --list` 里 `v0.106.0` 之后直接是 `v0.108.0`） |
| 重复段 | `0.79 A3 心跳… → 0.78 一键开启… → 0.77.2 → 0.77.3` 之后又接一段 `\|→ 0.78 一键开启… → 0.79.0 A3 心跳…`，中间还留着一个裸 `\|` |

即：**抽查过关，覆盖不全**。CHANGELOG 0.108.0 写的"已发布列表补全 0.78 → 0.108"与事实不符（0.80–0.88 整段没补）。

### 4 · preflight 动态导入段

真跑：

```
node scripts/preflight-bundle.mjs
…
- 插入：id=kifu-memory name=kifu-loader（来自 kifu-loader）
- 动态导入：kifu-loader 可解析，apply 可用（插件名核对通过）
PASS：所有 bundle 的 patch 都已声明，插入 id 未被禁用
EXIT=0
```

代码（`scripts/preflight-bundle.mjs` 尾部，紧跟 `KIFU` 判禁用之后）：

1. 定位 `<profile>/node_modules/kifu-loader/index.mjs`，用**绝对 file:// URL** `import()`；
2. 取 `apply`（或 `default`），没有就 `problems.push('导入成功但没有导出 apply')`；
3. 用假上下文探一次：`apply({ on: () => {} }, { enabled: false })`，核 `probe.name === 'dsh-gokifu-longmemory'`；
4. 整段包在 `try/catch`，**任何导入异常都进 `problems`**，而脚本末尾 `process.exit(problems.length ? 1 : 0)`。

这条路径能不能抓到"复制安装导致 re-export 断裂"？我做了实证，不只读代码：在系统临时目录造了一个假 `DSH_HOME`（`profiles/desktop/package.json` 声明 bundle `kifu-loader`，`node_modules/kifu-loader/` 里有 `package.json` + `cordis.patch.yml` + 只有一行 `export * from '../../src/plugin.mjs';` 的 `index.mjs`，**不复制 `src/`**），然后：

```
node scripts/preflight-bundle.mjs --home <临时假 home>
FAIL
  - kifu-loader 导入失败（软链/打包不完整？）：Cannot find module '…\fakehome\profiles\desktop\src\plugin.mjs' imported from …
EXIT=1
```

**判定：能捕获。** 而且报错信息直接点名缺失的 `src/plugin.mjs`，正是 audit-07 指出的那个断点。

瑕疵（不影响判定）：`scripts/preflight-bundle.mjs` 里有一个**裸 NUL 字节**（文件偏移 3814，位于 `` `${item.id}\u0000${item.name}` `` 的模板串内，是去重键的分隔符）。后果只在工具层：`node --check` 正常、运行正常、`git grep` 正常（命中 7 次），但 `grep -I` 命中 0 次（判为二进制跳过），审计侧 `read` 工具直接拒绝打开该文件，我被迫绕道 `node` 读。建议换成 `'\u0000'` 转义写法（行为完全一致，文件恢复为纯文本）。全仓 `scripts/*.mjs` 只有这一个文件含 NUL。

### 5 · `evidence/M7-replay-live.md` 的口径纠正

文件末尾（第 22–24 行）确有补记：

> ## 作用域闸的机械核对（2026-11-04 补记，回应 audit-07）
> 本文件当时只记了 12 局注入表，没记 `crossScopeRefs` 行。今天可复算的口径是 `m5` 的 **A5 = 0.00%**（见 `evidence/M5-six-axis.md`），而不是"本表里的 0"。以后凡是引用"跨作用域 0"，请引 m5 A5 读数；本表只作"注入是否发生"的证据。

核对口径是否对得上：`m5` 的 A5 轴就是 `crossScopeLeakRate`，本次实跑 `A5 作用域隔离 0.00% n=28`（`卡片 20 张 / 渲染行 28；walk 拒掉跨域 3556 条、缺域 0 条；卡内跨域计数 0；独立复核越界行 0`），`evidence/M5-six-axis.md` 第 14 行也是同一条（n=6 的早先快照）。**纠正落到了真实、可复算的读数上，不是换个说法。** 判定成立。

瑕疵：纠正只写在 evidence 文件里，台账没跟上 —— `MAINTENANCE.md:37` 仍写「A3 现有 `replay-live` 离线证据（12 局全注入、跨作用域 0）」，把"跨作用域 0"继续挂在 replay-live 名下，与刚补的口径直接冲突（见 §5-R3）。

## 三、本次跑过的命令

| 命令 | 结果 |
|---|---|
| `node scripts/ledger-check.mjs --full` | `ledger-check: PASS` · `EXIT=0` |
| `node scripts/m5-report.mjs` | 六轴全出标签（A3 `live-idle`）· 耗时 270758 ms · `EXIT=0` |
| `node scripts/cli.mjs audit --json` | `claims 852` · `threads 341` |
| `node --input-type=module -e '…createStore…list("episodes")'` | `305` |
| `node scripts/preflight-bundle.mjs` | `PASS` · `EXIT=0` · 含「动态导入：kifu-loader 可解析，apply 可用」 |
| `node scripts/preflight-bundle.mjs --home <临时假 home，只复制 index.mjs>` | `FAIL` · `EXIT=1` · `Cannot find module …\profiles\desktop\src\plugin.mjs` |
| `node --input-type=module -e '…compare() 边界表…'` | 见 §2-1 表格（+18 过 / +19 红 / ×2 ×10 红） |
| `git blame -L 155,166 -- scripts/ledger-check.mjs` | `process.exit(out.ok ? 0 : 1)` 属 `ce9a204`（0.60.0） |
| `git tag --list` × `sed -n '31p' MAINTENANCE.md` | 缺 8 个 tag；多 2 个未发 tag 的版本号 |
| `git status --porcelain` | 空（审计期间仓库无并发改动） |

## 四、审计边界声明

- 仓库内只写了本文件。假 `DSH_HOME` 夹具建在 `%TEMP%` 下（`/tmp/tmp.PxT2o5EMlo/fakehome`），用完未清理，与仓库无关。
- 没跑 `node --test`（`--full` 内部已经跑过并解析出 `414/410/0/4`，与台账一致）。
- 没重启、没改配置、没碰 `cordis.patch.yml`。

## 五、残留问题（3 条，按严重度）

**R1（中）· 「已发布」列表没真补全，CHANGELOG 的"补全"表述不实。**
`0.80.0/0.81.0/0.81.1/0.82.0/0.83.0/0.84.0/0.85.0/0.87.0` 有 tag 但不在列；`0.97.0/0.107.0` 在列但无 tag（`v0.107.0` 从未打过，0.107.0 的内容实际随 0.108.0 一起发）。另有 0.78/0.79 段重复和一个裸 `|`。这正是本仓历史上反复出问题的形态（文档说了不实的话），但属记载层，不影响运行。

**R2（中）· `ledger-check --full` 的 A4 容差比实测抖动小，新"硬门"会假红。**
`compare` 对 A4 p50 用固定 3ms 容差，注释写"单次抖动 ±2ms"。实测同一台机器 12 分钟内：台账 `7.24ms`（01:56）→ 本次 `14.58ms`（含并发负载），差 **7.34ms ≫ 3ms**。本轮 `--full` 之所以 PASS，是它内部那次 `m5` 恰好跑回 ~7ms 区间，属侥幸。负载高时（CI、与本审计同机的并发 m5 让单次 m5 从 123.8s 拖到 270.8s）会假 FAIL。计数项（claim/卷/局）不受影响。

**R3（低）· 跨作用域口径的纠正没穿透到台账。**
`evidence/M7-replay-live.md` 已改成"引 m5 A5"，但 `MAINTENANCE.md:37` 仍把「12 局全注入、跨作用域 0」当作 replay-live 的证据。账与证口径不一致，下一位接手者按台账读仍会引错源。

## 六、是否阻塞交付

**不阻塞。** 5 条修复中 4 条经实测成立，第 3 条是文档覆盖不全；R1/R3 是记载问题（改几行字即可），R2 会让发版门在高负载下假红、但不会放行错误产物。按当前状态可直接交付；建议把 R1/R3 的改字与 R2 的容差（例如改成"取 N 次运行的中位数再比"或放宽到 8ms 并在台账注明取样时点）作为下一刀。
