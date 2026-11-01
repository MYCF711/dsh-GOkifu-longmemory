# M4 影子精度抽样（T8a · hopPrecision）

> `[本] 2026-11-02 04:01 +08:00`（`generatedAt = 2026-11-01T20:01:03Z`）· 工作树（未提交）
> 语料：`tmp/memory-context`（92 棋谱 / 780 主题 / 199 边 / 83 卷 / 125 claim；`manifest.updatedAt = 1793559897619`）
> 判据来源：`方案.md` §8.2（`hopPrecision` ≥70%）· `docs/数据契约.md` §7.2/§7.3
> 脚本：`tmp/t8-precision.mjs`（不进 git）· 明细：`tmp/t8-precision-postfix.json`（修复后）/ `tmp/t8-precision-prefix.json`（修复前）

**两个快照，因为 R11 的 scope 过滤在本轮采样期间落地**（Lead 口径：cross-scope 行是 bug、不计入最终 hopPrecision）：

| 快照 | 时点 | 代码哈希（sha256 前 16 位） | 说明 |
|---|---|---|---|
| **P0 修复前** | 03:55 | walk `1d133ad7` · inject `90666afa` · gates `1bea808e` · persist `25a4bab0` | walk 不按 scope 过滤 ⇒ 40.5% 渲染行来自别的工作区（闸 1 抓出 60 条） |
| **P1 修复后** | 04:01 | walk `d76bdd5b` · inject `c5757c33` · gates `1bea808e` · persist `25a4bab0` | walk 按 scope 过滤（`same-scope+user-layer`）⇒ 渲染行 100% in-scope |

## 1 · 结论

1. **未达 70%**。修复后（P1，当前工作树）**hopPrecision = 67 ÷ 133 = 50.38%**，`noiseRate = 45.11%`；修复前（P0，as shipped）42.57%。两档更严读数：精确匹配口径 **31.58%**、claim 原文级 **17.29%**。**三个读数都低于 70%，结论稳健。**
2. **分层看，差距集中在"主题 key 分层"而不是"真实任务句"**：P1 下任务句 24 行 → **66.67%**（噪声只剩 2 行），df 最高 key 分层 109 行 → **46.79%**。原因：30 个 df 最高 key 里有 **19 个是 `kind=tool`**（echo/grep/bash/ls/git…），tool 种子 68 行只有 12 行有用（**17.65%**），非 tool 种子（dependency/error/domain/scaffold）41 行有 39 行有用（**95.1%**）。
3. **cross-scope 行（P0）= bug，已按 Lead 口径单列并从结论里剔除**：in-scope 88 行 → **59.09%**，cross-scope 60 行 → **18.33%**（noise 81.67%）。修好之后（P1）整体降到 50.38%——因为跨域候选被删后，卡片用排名更靠后的 in-scope 命中补位（`ENTRY_LIMIT=5` 未满），平均相关性下降，且 `dsh-gokifu` 这条样本转为零注入。**"59.09%" 不是修复后的真值，真值是 50.38%。**
4. **最小可逆收紧（只算不落地）**：把泛工具主题从"起跳池"里过滤掉，P1 下 hopPrecision **50.38% → 87.38%**，noiseRate → 1.94%，代价是零注入 14.29% → **34.29%**。这是唯一能把指标稳定推过 70% 的单点改动；`limit 5→3` 只有 −1.5pp（48.89%），不足以解决问题。

## 2 · 口径

### 2.1 样本（35 条）

| 分位 | 条数 | 抽样规则 | 信号文本 |
|---|---|---|---|
| key | 30 | 主题库按 `df` 降序（同 df 按 key 升序）、去重、key ≥2 字，取前 30 | 键原文（`signalFromText(<key>)`，不经包装短语） |
| 真实任务句 | 5 | `DSH_HOME` 全部会话日志 → `collectRootUserTexts` 取首条 root user 消息；长度 ≥20 字符、不含口令标记；按 episode id 升序取前 5 | 用户逐字原话（仅空白归一） |

- key 样本 scope 取该主题的 **modal scope**（含该主题的棋谱里出现最多的 `scopeKey`）；句样本取该 episode 的 `scopeKey`。
- 5 条任务句（逐字；含口令的样本已剔除）：`ep-00b50089` 定时任务/goal、`ep-08e54b9c` sub2api_poc.zip、`ep-1a49c80a` 找回 GOkifu 记录、`ep-4d31fc71` 两插件上传 github、`ep-7520721a` 侧边栏设置回滚。

### 2.2 渲染行与三档判据

**rendered = `card.claims`**（真正进 `section` 的条目行；不含 `indexLine`、markers 说明行、`omitted` 行）。P1：133 行 = 69 claim 行 + 64 指针行。

每条渲染行先映射回它依附的 `hit`（claim 行按 `claimId`，指针行按该棋谱的首个非 claim hit），取 `hit.why` 作"行内主题集"。

| 档 | useful | neutral | noise |
|---|---|---|---|
| **S0**（任务书字面，最宽） | `hit.why` ∩ 信号匹配主题 ≠ ∅，且交集含**非 tool 类**主题；或同一文件/域名/错误码实体（规范化后相等或 ≥8 字互相包含） | 无交集但棋谱 scope = 信号 scope | 交集**全是** tool 类（"仅泛工具"）；或全无交集且不同 scope（"与信号无共同主题"） |
| **S1**（只认精确匹配） | 交集里必须有一个来自 `score=1` 的匹配（排除"信号词 ⊂ 主题 key"的包含匹配伪命中） | 同上 | 同上 |
| **S2**（claim 原文级） | S1 之上，claim 行原文必须**逐字含**该主题 key（指针行文本由 `why` 生成，按 S1 记） | 同上 | 同上 |

> S1 是**下界不是目标**：多词主题（`exit code 1`、`No such file or directory`）从自然语言里只能靠包含匹配命中，S1 会把整类判 0（见 §3.3 error 行）。S2 回答"有用的那行，内容本身是否真在讲这个主题"。

### 2.3 公式

```
hopPrecision      = useful ÷ rendered                 （方案 §8.2 判据 ≥70%）
noiseRate         = noise  ÷ rendered
neutralRate       = neutral ÷ rendered
zeroInjectionRate = (card.section === null 的样本数) ÷ 样本数
tokens            = card.tokens（= indexLine + section，与 T7b 同口径）
```

### 2.4 时点纪律

- 采样期间 `walk.mjs` / `inject.mjs` / `gates.mjs` 都在被并发修改（R11 scope 过滤 + M4 十道闸）。**所有数字绑定 §0 表的哈希**，复算前先 `sha256sum src/rooms/*.mjs` 对齐。
- 闸门数字跨时点不可比：T7b 的「20/20 全绿」是在闸 0/6/6b/边界时测的；P0 是 16/35（`gate1/scope-mismatch` × 60）；P1 是 **35/35**（见 §3.7）。

## 3 · 数字

### 3.1 主表（两个快照）

| 快照 | 渲染行 | useful | neutral | noise | **hopPrecision** | S1 | S2 | noiseRate | neutralRate |
|---|---|---|---|---|---|---|---|---|---|
| **P1 修复后（当前）** | 133 | 67 | 6 | 60 | **50.38%** | 31.58% | 17.29% | 45.11% | 4.51% |
| P0 修复前（as shipped） | 148 | 63 | 4 | 81 | **42.57%** | 32.43% | 18.24% | 54.73% | 2.70% |

### 3.2 scope 分层（P0，Lead 口径：同工作区 + `u:` 层 = in-scope）

| 分层 | 渲染行 | 占比 | useful | neutral | noise | **hopPrecision** | noiseRate | 定性 |
|---|---|---|---|---|---|---|---|---|
| **in-scope** | 88 | 59.46% | 52 | 4 | 32 | **59.09%** | 36.36% | 可计入（仍 <70%） |
| **cross-scope** | 60 | 40.54% | 11 | 0 | 49 | **18.33%** | 81.67% | **bug，不计入**（R11 未过滤） |

- cross-scope 行的典型形态：信号 scope 是 `w:e:/Documents/...default-workspace`，行却来自 `w:d:/DeepSeek Harness/default-workspace/长期记忆系统`（本会话所在工作区），文本是 `Error: only an in-progress task can complete` / `reports: T1-REPORT.md …`。
- 闸 1 抓出的 60 条 `gate1/scope-mismatch` 与这 60 行**一一对应**（零误报、零漏报）。
- **P1 里这个分层退化为单层**：walk 过滤后 133 行全部 in-scope（cross-scope = 0），所以 P1 的 50.38% 就是"最终口径"的当前值。

### 3.3 分层明细（P1 为主，P0 对照）

| 分组 | P1 渲染行 | P1 useful | P1 hopPrecision | P0 hopPrecision（对照） |
|---|---|---|---|---|
| 种子 `tool`（19 条样本） | 68 | 12 | **17.65%** | 5.19% |
| 种子 `dependency`（6 条） | 27 | 27 | **100%** | 100% |
| 种子 `error`（2 条） | 9 | 9 | **100%**（S1/S2 = 0%） | 100% |
| 种子 `domain`（2 条） | 5 | 3 | 60.00% | 80.00% |
| 种子 `scaffold`（1 条） | 0 | 0 | —（该样本转零注入） | 100% |
| 任务句（5 条） | 24 | 16 | **66.67%** | 56.00% |
| claim 行 | 69 | 38 | 55.07%（S1 34.78% / S2 7.25%） | 45.33% |
| 指针行 | 64 | 29 | 45.31%（S1 28.13% / S2 28.13%） | 39.73% |
| 一跳（`hit.depth=1`） | 125 | 67 | 53.60% | 45.00% |
| 二跳（`hit.depth=2`） | 8 | 0 | 0%（6 neutral / 2 noise） | 0% |

> 二跳只有 8 行，不能单独定罪；且 `hit.depth` 取合并后的最小深度，**二跳参与的证据体现在 `why` 并集里**：P1 的 133 行中 **130 行 `why` ≥2 个 key**（`link.why` 一次塞进 6–15 个 key，把行与信号的共同主题稀释）。error 种子 S1=0 是"多词 key 只能包含匹配"的结构性结果。

### 3.4 token 与零注入

| 指标 | P1 | P0 | 口径 |
|---|---|---|---|
| tokens min / p50 / p90 / max | **35 / 233 / 268 / 285** | 45 / 246 / 276 / 302 | `card.tokens`（indexLine + section），预算 500，最坏占 57% |
| zeroInjectionRate | **5 / 35 = 14.29%** | 4 / 35 = 11.43% | `section === null` |
| 零注入样本 | `ls` `cd` `wc` `127.0.0.1` `dsh-gokifu` | `ls` `cd` `wc` `127.0.0.1` | — |

- 前四个的 `matched = 0`：`ls`/`cd`/`wc` 是 2 字符 ASCII 键被 `minComparableLength` 挡掉（正确行为）；`127.0.0.1` 是**真实主题（df=13）却抽不出词**（`signalFromText` 的 ASCII 正则要求首字符是字母）。
- `dsh-gokifu` 在 P1 转零注入：它的命中全部来自另一个工作区，被 scope 过滤掉了 —— **这正是修复的预期效果**（宁缺勿错域）。
- token 全程未触顶：**本轮问题不是"跳太多烧 token"，而是"该不该跳"。**

### 3.5 噪声 top 5

**按种子 key**（决定"哪类信号不该起跳"）：

| 排序 | P1（当前口径） | P0 in-scope 口径 |
|---|---|---|
| 1 | `cat` (tool, df 18)：5/5 行 | `curl` (tool, df 12)：5/5 |
| 2 | `curl` (tool, df 12)：5/5 | `job_output` (tool, df 9)：4/4 |
| 3 | `grep` (tool, df 20)：5/5 | `bash` (tool, df 19)：2/2 |
| 4 | `head` (tool, df 19)：5/5 | `cat` (tool, df 18)：2/2 |
| 5 | `mkdir` (tool, df 9)：5/5 | `echo` (tool, df 20)：2/2 |

**按行内连接 key**（一行可计多个 key，计数不互斥）：

| 排序 | P1 | P0 in-scope |
|---|---|---|
| 1 | `no such file or directory` 34 行 | `@deepseek-ai/schemastery` 16 |
| 2 | `syntaxerror: invalid or unexpected token` 34 | `d:/deepseek harness/home/sessions` 16 |
| 3 | `@deepseek-ai/schemastery` 29 | `js-yaml` 16 |
| 4 | `d:/deepseek harness/home/sessions` 29 | `no such file or directory` 16 |
| 5 | `js-yaml` 29 | `syntaxerror: invalid or unexpected token` 16 |

噪声原因分布（P1）：`generic-tool-overlap-only` **58 行**、`generic-tool-only` **2 行**；`unattributed` 0。（P0：77 / 4。）

> 连接 key 榜里没有"毒王"（并列多、分布平），说明噪声是**结构性的**：`link.why` 把整条边共享的 6–15 个主题都塞进 `why`，一条行同时挂 `package.json`/`js-yaml`/`SyntaxError…`，与信号的共同主题被稀释成一个泛工具词。

### 3.6 匹配质量（包含匹配的伪命中）

| 项 | 计数（P1，与 P0 相同） |
|---|---|
| 匹配方式 | 精确（score=1）**54** · 包含（score=0.6）**110** |
| 包含匹配"词边界对齐" | 72 |
| 包含匹配"词内片段"（伪命中） | **38** |

实例：`bash ⊂ mycf711/dsh-gitbash-shell`、`bash ⊂ d:/…/dsh-gitbash-shell-fork/tools/patch-installed-freeze.mjs`、`cat ⊂ /Microsoft/Edge/Application/msedge.exe`、`cat ⊂ …/Chrome/Application/chrome.exe`、`sed ⊂ composed.yml`。

### 3.7 闸门（时点限定）

| 快照 | `runGates({card, walkResult, store, scope}).ok` | 错误码分布 |
|---|---|---|
| **P1** | **35 / 35** | 无 |
| P0 | 16 / 35（19 红） | `gate1/scope-mismatch` × 60（唯一错误码，= cross-scope 60 行） |

闸 1 在 P0 精确抓出 60 条跨域行、在 P1 归零 → **闸 1 判据与 walk 的 scope 过滤同口径**，可作为"scope 修复有效"的正面证据。上一时点（`gates.mjs 7b1b00d`）同一批卡片是 4/35 + 73 条 `gate5/missing-quote`（= 73 条指针行），后续版本已按"指针行不主张断言"豁免 —— **闸门数字跨版本不可比**。

## 4 · 反事实（只算不改，基于 P1 代码）

做法：不动任何房间代码，用 store 门面（`list('topics')` 过滤 `kind==='tool'`）与 `limit` 参数重跑同一批 35 条信号，再按同一判据复判。

| 方案 | 渲染行 | useful | hopPrecision S0 | S1 | S2 | noiseRate | zeroInjection | tokens p50 / p90 |
|---|---|---|---|---|---|---|---|---|
| baseline（P1 现状） | 133 | 67 | 50.38% | 31.58% | 17.29% | 45.11% | 14.29% | 233 / 268 |
| **A. 泛工具主题不参与起跳**（模拟） | 103 | 90 | **87.38%** | 40.78% | 22.33% | 1.94% | **34.29%** | 222 / 295 |
| B. `limit 5→3` | 90 | 44 | 48.89% | 30.00% | 20.00% | 48.89% | 14.29% | 184 / 217 |
| **A+B** | 69 | 62 | **89.86%** | 42.03% | 28.99% | 2.90% | 34.29% | 183 / 227 |

- A 的模拟是**上界**（tool 类主题整块从匹配池拿掉，二跳 `why` 里也拿掉）；真改动只在 `matchTopics` 一跳过滤，tool 主题仍可作二跳 `why` 与 claim 文本匹配 → 真实效果应落在 **70%–87%**，必须复测。
- A 的收益里有**成分要注意**：CF 里 tool 种子仍渲染 39 行、34 行有用（87.18%），那是"工具词吸附到含该词的文件路径/错误主题"（`echo ⊂ …/echo.yml`）——真用户句很少是一个裸工具词，所以这部分收益对应的真实场景有限；**真实任务句在 A 下是 68%（17/25）**。
- A 的代价明确：零注入 14.29% → 34.29%（沉默样本 5 → 12 条），符合"不相关时沉默"，但要在 M5 留出集确认 recall 不掉。

## 5 · 逐行样本表（P1，35 条）

`U/N/Z` = useful/neutral/noise（S0）；`闸` = 该样本 `runGates(...).ok`（P1 全绿）。

| # | 分位 | 种子 | 种类/df | 匹配 | hits | 渲染 | U | N | Z | tokens | 闸 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| k01 | key | echo | tool/20 | 1 | 4 | 4 | 0 | 0 | 4 | 204 | ok |
| k02 | key | grep | tool/20 | 1 | 5 | 5 | 0 | 0 | 5 | 233 | ok |
| k03 | key | bash | tool/19 | 8 | 4 | 4 | 0 | 0 | 4 | 204 | ok |
| k04 | key | head | tool/19 | 1 | 5 | 5 | 0 | 0 | 5 | 233 | ok |
| k05 | key | ls | tool/19 | 0 | 0 | 0 | 0 | 0 | 0 | 45 | ok |
| k06 | key | cat | tool/18 | 6 | 5 | 5 | 0 | 0 | 5 | 234 | ok |
| k07 | key | cd | tool/18 | 0 | 0 | 0 | 0 | 0 | 0 | 45 | ok |
| k08 | key | exit code 1 | error/15 | 8 | 5 | 5 | 5 | 0 | 0 | 285 | ok |
| k09 | key | sed | tool/15 | 5 | 4 | 4 | 2 | 0 | 2 | 212 | ok |
| k10 | key | find | tool/14 | 4 | 5 | 5 | 1 | 0 | 4 | 250 | ok |
| k11 | key | git | tool/14 | 8 | 5 | 5 | 1 | 0 | 4 | 239 | ok |
| k12 | key | node | tool/14 | 8 | 4 | 4 | 2 | 0 | 2 | 218 | ok |
| k13 | key | read | tool/14 | 8 | 3 | 3 | 3 | 0 | 0 | 227 | ok |
| k14 | key | 127.0.0.1 | domain/13 | 0 | 0 | 0 | 0 | 0 | 0 | 45 | ok |
| k15 | key | tail | tool/13 | 1 | 4 | 4 | 0 | 0 | 4 | 218 | ok |
| k16 | key | curl | tool/12 | 1 | 5 | 5 | 0 | 0 | 5 | 233 | ok |
| k17 | key | dsh-better-sidebar | dependency/11 | 2 | 5 | 5 | 5 | 0 | 0 | 245 | ok |
| k18 | key | dsh-gitbash-shell | dependency/11 | 8 | 4 | 4 | 4 | 0 | 0 | 213 | ok |
| k19 | key | github.com | domain/11 | 7 | 5 | 5 | 3 | 0 | 2 | 214 | ok |
| k20 | key | python | tool/11 | 3 | 3 | 3 | 0 | 0 | 3 | 226 | ok |
| k21 | key | dsh-gokifu | scaffold/10 | 8 | 0 | 0 | 0 | 0 | 0 | 35 | ok |
| k22 | key | dsh-gokifu-compact | dependency/10 | 8 | 5 | 5 | 5 | 0 | 0 | 245 | ok |
| k23 | key | dsh-sovereign | dependency/10 | 5 | 5 | 5 | 5 | 0 | 0 | 242 | ok |
| k24 | key | edit | tool/10 | 3 | 3 | 3 | 3 | 0 | 0 | 205 | ok |
| k25 | key | wc | tool/10 | 0 | 0 | 0 | 0 | 0 | 0 | 45 | ok |
| k26 | key | No such file or directory | error/9 | 8 | 4 | 4 | 4 | 0 | 0 | 259 | ok |
| k27 | key | dsh-chat-link-actions | dependency/9 | 2 | 4 | 4 | 4 | 0 | 0 | 235 | ok |
| k28 | key | dsh-session-superagent | dependency/9 | 8 | 4 | 4 | 4 | 0 | 0 | 222 | ok |
| k29 | key | job_output | tool/9 | 1 | 4 | 4 | 0 | 0 | 4 | 246 | ok |
| k30 | key | mkdir | tool/9 | 1 | 5 | 5 | 0 | 0 | 5 | 285 | ok |
| s1 | 句 | ep-00b50089 · 定时任务/goal | sentence | 8 | 4 | 4 | 4 | 0 | 0 | 268 | ok |
| s2 | 句 | ep-08e54b9c · sub2api_poc.zip | sentence | 8 | 5 | 5 | 0 | 3 | 2 | 205 | ok |
| s3 | 句 | ep-1a49c80a · 找 GOkifu 记录 | sentence | 8 | 5 | 5 | 2 | 3 | 0 | 234 | ok |
| s4 | 句 | ep-4d31fc71 · 两插件传 github | sentence | 8 | 5 | 5 | 5 | 0 | 0 | 279 | ok |
| s5 | 句 | ep-7520721a · 侧边栏设置回滚 | sentence | 8 | 5 | 5 | 5 | 0 | 0 | 255 | ok |

合计：渲染 133 = 67 U + 6 N + 60 Z；claim 69 / 指针 64；闸 35/35。
（P0 的 35 行表见 `tmp/t8-precision-prefix.json` 与 `reports/T8a-REPORT.md` §3.2 摘要：148 行 = 63 U + 4 N + 81 Z，in-scope 88 / cross 60。）

## 6 · 三类例子（P1 逐条）

**有用，且 claim 原文也含该主题（S2 硬判据通过）**：

```
[useful] seed="dsh-better-sidebar" ep=ep-7520721a scope=w:e:/Documents/deepseek-harness/default-workspace
    keys=["dsh-better-sidebar","dsh-pet","package.json"]
    text=fail=1 · topics=dsh-better-sidebar, dsh-pet, package.json
```

**有用但仅 S0 过（claim 原文没提该主题 —— "整局级重叠"会把弱关联算成有用，S2 口径就是扣掉这些）**：

```
[useful] seed="exit code 1" ep=ep-1e82afca
    keys=["@codemirror/commands","@codemirror/lang-cpp","No such file or directory"]
    text=Error: Team member limit 8 reached
```

**噪声（仅靠泛工具主题搭上）**：

```
[noise] seed="echo" ep=ep-7520721a
    keys=["echo","dsh-pet","uniq"]
    text=63015=401 56006=000 [exit code: 7]
```

**P0 里的 cross-scope（bug；P1 已消失）**：

```
[noise] seed="echo" ep=ep-8cc34e32 scope=w:d:/DeepSeek Harness/default-workspace/长期记忆系统
    keys=["echo","send_message","spawn_teammate"]
    text=Error: only an in-progress task can complete
```

## 7 · 复现

```bash
# 0) 建库（已存在则跳过；绝不写 <DSH_HOME>）
ls tmp/memory-context || node scripts/archive.mjs --store tmp/memory-context

# 1) 全量抽样 + 反事实（只读 store；脚本与 JSON 都在 tmp/，不进 git）
node tmp/t8-precision.mjs tmp/memory-context tmp/t8-precision.json

# 2) 摘要
node -e 'const j=require("./tmp/t8-precision.json");const a=j.aggregate;
console.log("hopPrecision",a.hopPrecision,"| S1",a.hopPrecisionS1,"| S2",a.hopPrecisionS2,
            "| noise",a.noiseRate,"| zero",a.zeroInjectionRate,
            "| tok p50/p90",a.tokens.p50,a.tokens.p90,"| gates",a.gatesOk+"/"+a.samples)'

# 3) 真实任务句来源（只读 DSH_HOME 会话日志）
node tmp/t8-probe-sentences.mjs

# 4) 单条人工核对（看每行的 keys 与判定）
node -e 'const j=require("./tmp/t8-precision.json");const s=j.samples.find(x=>x.id==="k01");
for(const l of s.lines) console.log(l.s0.verdict, l.s0.reason, JSON.stringify(l.keys), l.text.slice(0,60))'

# 5) 代码快照对齐（数字只在这组哈希下有效）
sha256sum src/rooms/walk.mjs src/rooms/inject.mjs src/rooms/gates.mjs src/rooms/persist.mjs
# P1: walk d76bdd5b · inject c5757c33 · gates 1bea808e · persist 25a4bab0
# P0: walk 1d133ad7 · inject 90666afa · gates 1bea808e · persist 25a4bab0
#
# 复算一致性（本轮实测）：04:0x 复跑时 walk/inject 又各改一版（walk f7f7039e · inject 4574ce5f），
# 指标完全相同 —— hopPrecision 50.38% / 133 行 / 67 useful / zero 14.29% / 闸 35-35。
# 说明该读数对这几版实现不敏感，可以作为"修复后基线"引用。
```

## 8 · 局限与未做

1. **未跑留出集**：单时点影子精度抽样，不是 LOO 基准；不含"注入后行为改变"的观测（`posTransferRate` / `memoryHitRate` 不在本轮判据内）。
2. **判据是机械近似**："共享主题"取 `hit.why` 与信号匹配主题的交集（整局级），比"这一行内容是否真在讲同一件事"宽；S2 是它的下界。两端都低于 70%。
3. **key 分层的代表性**：30 条按 df 排序的 key 里 19 条是 tool —— 这个比例本身就是发现（主题库把工具动词当高频主题），但也意味着 key 分层不能代表真实用户句（后者 P1 = 66.67%）。
4. **二跳只有 8 行**，且 `hit.depth` 取合并后最小深度；要单独定罪二跳，需要"只开一跳"的 A-B 对照。
5. **反事实 A 的成分**：`toolBlacklist` 的 87.38% 里有相当一部分来自"工具词吸附到含该词的文件路径/错误主题"；真实任务句在 A 下是 68%，**不要用 87% 当承诺值**。
6. **未做**：改代码（本轮只产出证据与建议）、`u:` 层单列（语料只有 1 条 `u:owner` claim）、`jumpCount/step` 分位（`rendered ≤5` 恒成立，无分布）。

---

## 8 · S9 落地后的复算（Lead，2026-11-02 04:09）

> 代码：`walk.mjs` 过滤 `kind=tool` 种子（保留显式 `entity.kind==="tool"` 起跳）。命令：`node tmp/t8-precision.mjs`。

| 指标 | S9 前（P1） | **S9 后** |
|---|---|---|
| hopPrecision（S0） | 50.38% | **87.38%** |
| noiseRate | 45.11% | **1.94%** |
| zeroInjection | 14.29% | **34.29%**（12/35） |
| rendered | 133 | 103 |
| tokens p50 / p90 / max | 233 / 268 / — | **224 / 295 / 323** |
| 闸门 | 35/35 | **35/35** |

分层：key 层 **93.59%**（78 行），任务句层 **66.67%**（25 行）——任务句仍低于 70%，S9 的收益主要来自高 df 键层。
更严口径仍低：S1（精确匹配，排除包含匹配）**40.78%**、S2（claim 原文级）**22.33%**。
**结论**：按 `方案.md` §8.2 定义的 S0 口径已达标（87.38% ≥ 70%）；S1/S2 是"相关性强不强的量尺"，不是开闸门槛，但开真注入后必须用影子→线上 A/B 复测。
