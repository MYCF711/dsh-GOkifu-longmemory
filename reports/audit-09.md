# audit-09 · 第三轮终验（只核 audit-08 的三条残留）

- 审计时间：2026-11-04 02:25–02:40（Asia/Shanghai）
- 仓库：`D:\DeepSeek Harness\default-workspace\长期记忆系统`
- 口径锚点：`HEAD = c9ba8d8「R00 fix: audit-08 收尾（0.109.0）(#185)」`（2026-11-04 02:20:44），`package.json = 0.109.0`，`v0.109.0` tag 指向同一提交。
- **工作树在审计期间被动过**：审计开始时 `git status --porcelain` 为空（02:26 前后）；02:28 有并发会话把工作树改到 `0.110.0`（`package.json`、`CHANGELOG.md`、`MAINTENANCE.md`、`计划表.md`，并新增 `docs/调研/31-GraphRAG-社区摘要-2026-11-04.md`）。本报告结论**以 HEAD c9ba8d8（= v0.109.0）为准**；涉及的三行关键文案在 02:31 用工作树复核仍未变，所以判定对两种状态都成立。`ledger-check --full` 在进程启动时读到的是 0.109.0（其输出即证）。
- 写入：仅本文件。源码、配置、证据、台账未改。

## 结论

**不通过。**

三条里 **R2、R3 已关闭且经实测成立；R1 未关闭**：指针化只做了一半，替换句保留了"全部有 annotated tag"这种完整性强断言，与事实不符（声称区间内 6 个版本没有 tag）；CHANGELOG 0.108 段的"补全 0.78→0.108"字样虽然删了，但同一段被改写成另一句不实的话。另有 0.109.0 自身引入的新缺陷：`CHANGELOG.md` 里出现裸 NUL，文本工具拒读。

| # | 复核项 | 判定 |
|---|---|---|
| R1 | 「已发布」改指针 + CHANGELOG 0.108 不实表述改正 + 不再声称逐版本完整 | **未关闭** |
| R2 | `ledger-check` A4 容差改线上自适应（实测值 50%，下限 3ms）+ `--full` PASS | **关闭** |
| R3 | 「跨作用域 0」不再挂 `replay-live`，`M7-replay-live.md` 口径纠正仍在 | **关闭** |

## 一、R1 · 未关闭

### 1.1 「已发布」行确实不再手抄流水，但把"漏抄"换成了"全有"的假声明

`git diff v0.108.0..HEAD -- MAINTENANCE.md` 显示第 31 行由一长串手抄版本流水换成了：

```
| 已发布 | **0.15.0 → 0.108.0 全部有 annotated tag + GitHub Release（逐个见 `git tag -l 'v*' --sort=v:refname` 与 CHANGELOG）**；2026-11-04 起本行不再手抄版本流水（audit-08 R1：手抄必然漏/重）。 |
```

手抄流水是删了（这一点成立），但替换句仍然是一次**逐版本完整性声明**："0.15.0 → 0.108.0 **全部有 annotated tag** + GitHub Release"。这句是假的。

### 1.2 tag 对账：区间内有 6 个版本没有 tag（本地和远端都没有）

命令：

```
git tag -l 'v*' --sort=v:refname | tail -20
```

```
v0.90.0 v0.91.0 v0.92.0 v0.93.0 v0.94.0 v0.95.0 v0.96.0 v0.98.0 v0.98.1
v0.99.0 v0.100.0 v0.101.0 v0.102.0 v0.102.1 v0.103.0 v0.104.0 v0.105.0
v0.106.0 v0.108.0 v0.109.0
```

（`v0.97.0`、`v0.107.0` 的缺位在 `tail -20` 里就能直接看到。）

把 CHANGELOG 的版本段与 tag 集合逐项对账（`## x.y.z` 134 段 vs 127 个 tag，区间取 0.15.0–0.108.0）：

| 版本 | CHANGELOG 有段 | 本地 tag | 远端 tag（`git ls-remote --tags origin`） |
|---|---|---|---|
| 0.77.3 | 有 | 无 | 无 |
| 0.78.0 | 有 | 无 | 无 |
| 0.86.0 | 有 | 无 | 无 |
| 0.88.0 | 有 | 无 | 无 |
| 0.97.0 | 有 | 无 | 无 |
| 0.107.0 | 有 | 无 | 无 |

即：**声称区间内 115 个版本里有 6 个没有 tag**，"全部有 annotated tag"不成立；不是本地没 fetch 的问题，远端同样没有（`git ls-remote` 只返回 `v0.108.0` / `v0.109.0` 这类符合的项）。GitHub Release 依赖 tag 存在，这 6 个也不可能有对应 Release。

### 1.3 同一提交内部自相矛盾

`CHANGELOG.md` 的 0.109.0 段（R1 条）自己写着「含**未打 tag 的 0.97/0.107**」，而 `MAINTENANCE.md:31` 说「0.15.0 → 0.108.0 全部有 annotated tag」。两句话在同一棵树上、同一次提交里并存。

### 1.4 这行在诞生时就少了一个版本

当前版本是 0.109.0（`v0.109.0` 已有 tag，本地/远端都在），而行文写的是「0.15.0 → 0.108.0」。指针改写于 0.109.0，却止于前一版——说明它仍是手工维护的状态断言，不是纯指针。

### 1.5 CHANGELOG 0.108 段：「补全 0.78→0.108」删掉了，但换成了另一句不实的话

`v0.108.0` 的原文（`git show v0.108.0:CHANGELOG.md`）：

```
- **`MAINTENANCE.md` 已发布列表补全 0.78 → 0.108**（此前止于 0.77.3）。
```

HEAD 的同一段（`CHANGELOG.md:22`）：

```
- **`MAINTENANCE.md` 的「已发布」行改为指针**（`git tag -l` + CHANGELOG）：audit-08 证明手抄列表必然漏/重（缺 0.80–0.87，含未打 tag 的 0.97/0.107），不再手抄。
```

问题有两处，都是事实错误：

1. **把 0.109.0 的改动记到 0.108.0 头上。** `git show v0.108.0:MAINTENANCE.md` 第 31 行当时仍是完整手抄流水，还没有指针；指针是 `v0.108.0..HEAD` 的 diff 才引入的。改写后的 0.108.0 段声称"本版把已发布行改为指针"，与 tag 内容不符。
2. **因果倒置。** `v0.108.0` tag 打于 02:03:04，`reports/audit-08.md` 记的审计时段是 02:03–02:24——0.108.0 发版时 audit-08 还不存在，不可能"证明"该版的动作。

结论：R1 要求的两件事，一件（删手抄流水）做了，另一件（去掉不实表述 + 不再声称完整）没有真正做成——假声明从"补全了"变成了"全部有 tag"，并且顺手改写了已发布版本的记录。

### 1.6 没有护栏拦住这类文案

`grep -rn "已发布\|annotated tag" scripts/ test/ src/` 只命中 `release.mjs` 的一句注释。`check.mjs`/`ledger-check`/测试都不校验这行，因此 CI 全绿不能证明这句为真。建议下一个版本加一条机械断言：`MAINTENANCE.md` 的「已发布」行不得出现 `全部有`/`完整` 一类词，只允许指向 `git tag -l`。

## 二、R2 · 关闭

### 2.1 代码：`scripts/ledger-check.mjs` 的 `compare`

```js
// 线上在跑时按「实测值的 50%，下限 3ms」给容差；非线上仍按 3ms（防回归）。
const a4Tol = live ? Math.max(3, (Number.isFinite(actual.a4) ? actual.a4 : 0) * 0.5) : 3;
if (has(ledger.a4) && has(actual.a4) && Math.abs(ledger.a4 - actual.a4) > a4Tol)
  bad.push(`A4 p50：台账 ${ledger.a4}ms vs 实测 ${actual.a4}ms（容差 ${a4Tol.toFixed(1)}ms，线上抖动）`);
```

与要求一致：`live` 时 `max(3, 实测 × 0.5)`，非 `live` 时固定 3ms。`live` 的判据是 `<store>/live-stats.jsonl` 的 mtime 在 15 分钟内（`scripts/ledger-check.mjs` 的 `LIVE_WINDOW_MS`）。审计时该文件 age = 0.0 分钟，走的是自适应分支。

### 2.2 实跑

```
node scripts/ledger-check.mjs --full
```

```
ledger-check：台账 0.109.0 · 测试 414/410/0/4 · claim 852 · 卷 341
实测：版本 0.109.0 · 测试 414/410/0/4 · claim 852 · 卷 341
ledger-check: PASS
[exit 0]
```

台账 A4 p50 记的是 10.40ms（02:18），本轮未触发 A4 报错。按代码，容差 = max(3, 实测×0.5)；audit-08 记的 14.58ms 高负载读数对应的容差约 7.3ms，能吸收它当时观测到的 7.34ms 量级漂移（边界上；超过 2 倍慢仍会红，属预期）。**判定：关闭。**

## 三、R3 · 关闭

`MAINTENANCE.md:37` 现为：

```
> **当前唯二未决项**：① 安装三步（`docs/安装指南.md` §1）→ 装完出 `first-live`/`repeat-report`；A3 现有 `replay-live` 离线证据（12 局全注入（跨作用域读数请看 m5 的 A5，不引本文件））；
```

`grep -n "跨作用域" MAINTENANCE.md` 只此一处，已不再写「跨作用域 0」，并显式把读数指向 m5 的 A5。

`evidence/M7-replay-live.md` 末尾的纠正段仍在（第 22–24 行）：

```
## 作用域闸的机械核对（2026-11-04 补记，回应 audit-07）
本文件当时只记了 12 局注入表，没记 `crossScopeRefs` 行。今天可复算的口径是 `m5` 的 **A5 = 0.00%**（见 `evidence/M5-six-axis.md`），
而不是"本表里的 0"。以后凡是引用"跨作用域 0"，请引 m5 A5 读数；本表只作"注入是否发生"的证据。
```

台账与证据口径一致。**判定：关闭。**

## 四、残留（4 条 + 1 条环境风险）

**A（中，R1 的实质）· 「已发布」行仍声称逐版本完整，且为假。**
`MAINTENANCE.md:31` 的「0.15.0 → 0.108.0 全部有 annotated tag + GitHub Release」与 6 个无 tag 版本冲突，也与同提交 `CHANGELOG.md:8` 的「含未打 tag 的 0.97/0.107」自相矛盾。改法二选一：删掉"全部有 annotated tag + GitHub Release"，只留"逐个见 `git tag -l`"；或改成"以 `git tag -l` 为准；0.77.3 / 0.78.0 / 0.86.0 / 0.88.0 / 0.97.0 / 0.107.0 无 tag（内容随相邻版本发布）"。

**B（中，新回归）· `CHANGELOG.md` 里有裸 NUL，文本工具拒读。**
0.109.0 段第 11 行（字节偏移 478）想把 `preflight-bundle.mjs` 的裸 NUL 改成 `\u0000` 转义，结果把**裸 NUL 写进了 CHANGELOG 自己**。实测后果：

```
read 工具：Error: cannot read ".../CHANGELOG.md": binary file
grep：      Binary file CHANGELOG.md matches
git diff：  Binary files a/CHANGELOG.md and b/CHANGELOG.md differ
```

`node`/`release.mjs` 仍能读（按 utf8），`check.mjs` 也不受影响，所以不阻塞运行；但它把审计侧/评审侧最常用的两个入口（read、grep）废掉了，且与这次修复的初衷（"让文件恢复纯文本"）相反。修法：把该处的裸 NUL 换成字面两个字符 `\` + `u0000`（即文档里显示成 `\u0000`）。`scripts/preflight-bundle.mjs` 本身的 NUL 已清（实测 0 个）。

**C（低）· 已发布的 0.108.0 段被事后改写，且引用了晚于该 tag 的 audit-08。**
见 §1.5。建议把"改为指针"的记录留在新增的 0.109.0 段（那里本来就有），0.108.0 段保留原文或加一行"（0.109.0 复核更正）"，不要覆盖已发布版本的记述——`release.mjs` 的 release notes 就是从这些段落里抽的。

**D（低）· 同一口径还漏在两处下游文档。**
R3 只点了台账，所以不判 R3 失败；但同样的"跨作用域 0 挂在真实会话回放"仍出现在：

- `docs/交付清单.md:27`：「A5 同域 | 0% 越界 | 真实会话回放 39 局跨作用域 0」（该表其余数字也停在旧版本：A3 not-live、A2 25.9%）
- `evidence/status-digest.md:6`：「真实会话回放（12 局）：注入 12 · 沉默 0 · 跨作用域 0」（这是 `scripts/status-digest.mjs` 生成的行；生成器按 `digest.replay.crossScope` 输出，属可复算，但读者仍会把它当 A5 证据）

**E（环境风险，非缺陷）· 审计期间有并发写。**
0.110.0 的改动在 02:28 进入工作树（未提交）。本报告已锚定 HEAD c9ba8d8；若后续以 0.110.0 交付，需重新对账这三条（尤其 R1 那行在 0.110.0 工作树里一字未改）。

## 五、跑了什么（可复现清单）

| 命令 | 结果 |
|---|---|
| `git log -1 --format='%H %ci %s'` | `c9ba8d88… 2026-11-04 02:20:44 +0800 R00 fix: audit-08 收尾（0.109.0） (#185)` |
| `git status --porcelain` | 02:26 空；02:31 出现 0.110.0 未提交改动（见 §0） |
| `git tag -l 'v*' --sort=v:refname \| tail -20` | 见 §1.2；v0.97.0 / v0.107.0 缺位 |
| CHANGELOG 段 × tag 集合对账（node/python） | 区间内 6 个版本无 tag：0.77.3 / 0.78.0 / 0.86.0 / 0.88.0 / 0.97.0 / 0.107.0 |
| `git ls-remote --tags origin \| grep v0.9x` | 远端同样没有上述 tag（不是本地缺 fetch） |
| `git diff v0.108.0..HEAD -- MAINTENANCE.md` | 手抄流水 → 指针句（含"全部有 annotated tag"假声明） |
| `git show v0.108.0:CHANGELOG.md` | 原文为「已发布列表补全 0.78 → 0.108」 |
| `sed -n` 读 `scripts/ledger-check.mjs` 的 `compare` | `a4Tol = live ? max(3, actual.a4*0.5) : 3` |
| `node scripts/ledger-check.mjs --full` | PASS，exit 0（输出见 §2.2） |
| `grep -n "跨作用域" MAINTENANCE.md` | 仅第 37 行，已指向 m5 A5 |
| `cat evidence/M7-replay-live.md` | 末尾纠正段仍在（§3） |
| `read CHANGELOG.md` | 报 `binary file`；字节偏移 478 有 1 个 NUL |
| `node -e` 统计 NUL | `CHANGELOG.md` 1 个；`MAINTENANCE.md`/`README.md`/`preflight-bundle.mjs` 0 个 |
| `node scripts/check.mjs` / `node --test` | 未单独跑；`--full` 内部已跑 `node --test` 并解析出 414/410/0/4，与台账一致 |

未做：没有调用 GitHub API 逐个核对 Release（tag 不存在则 Release 不可能存在，已足够）；没有重跑 `m5`。

## 六、是否阻塞交付

- **运行/产品层面：不阻塞。** 测试 414/410/0/4、`ledger-check --full` PASS、A4 门已按线上自适应。
- **验收层面：阻塞。** 本仓的验收口径里"文档必须为真"是硬条款，而 R1 的假声明仍在 HEAD 和当前工作树里，且新增了 `CHANGELOG.md` 二进制化这个由 0.109.0 自身引入的回归。两处都是小改（一行字 + 一个字节），改完重跑 `node scripts/ledger-check.mjs --full` 即可复审。

按本轮任务定义（只核三条残留），判定为 **不通过**：R1 未关闭。
