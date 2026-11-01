# T8a 报告 —— 影子精度抽样（hopPrecision，35 条信号，只产出证据与建议）

> 任务板 `task-8` · 负责人 precision-auditor · `[本] 2026-11-02 04:01 +08:00`（工作树未提交）
> 判据来源：`方案.md` §8.2（`hopPrecision ≥70%`、`jumpCount/step ≤5`、`injectTokens/step ≤500`）· `docs/数据契约.md` §7.2/§7.3 · `AGENTS.md` §10
> 实测证据：`evidence/M4-precision.md`（35 行样本表 + 逐行三档判定 + 反事实 + 复现命令 + 代码哈希）
> 采样脚本：`tmp/t8-precision.mjs`、`tmp/t8-probe-sentences.mjs`（**tmp/，不进 git**）

## 0 · 一句话

**按当前工作树（R11 scope 过滤已落地）hopPrecision = 67/133 = 50.38%，未达 70%；拆开看，真实任务句 66.67%（离门槛 3.3pp），被 df 最高的泛工具主题拖到 46.79%。根因是"哪个主题有资格起跳"：tool 类种子 68 行只有 12 行有用（17.65%），非 tool 类种子 41 行有 39 行有用（95.1%）。单点收紧（tool 主题不进起跳池）模拟 87.38%，只给建议、未落地。**

## 1 · 交付物

| 文件 | 性质 | 说明 |
|---|---|---|
| `evidence/M4-precision.md` | 新增 | 口径（35 条样本、三档判据、公式、两个快照的哈希与时点）、样本表、scope 分层、噪声 top5、反事实、复现命令 |
| `reports/T8a-REPORT.md` | 新增 | 本文件：结论 + 数字 + 最小可逆收紧方案（不落地）+ 复算待办 |
| `tmp/t8-precision.mjs` | 临时 | 主抽样：`signalFromText → walkFromSignals → buildMemoryCard → runGates` + 逐行三档判定 + 4 组反事实 |
| `tmp/t8-probe-sentences.mjs` | 临时 | 真实任务句选取（只读 `DSH_HOME` 会话日志） |
| `tmp/t8-precision-postfix.json` / `-prefix.json` | 临时 | 133 / 148 条渲染行 × 三档判定明细 + 35 条样本元数据 |

**没有改任何房间代码、没有改 store、没有写 `<DSH_HOME>`、没有 git 操作。**

## 2 · 方法

1. 样本：**30 个 df 最高的主题 key**（`df` 降序、同 df 按 key 升序、去重、key ≥2 字）+ **5 条真实任务句**（`DSH_HOME` 会话日志首条 root user 消息，长度 ≥20、剔除含口令样本、按 episode id 升序取前 5）。
2. 每条：`signalFromText(text) → walkFromSignals({depth:2, limit:5, budgetTokens:500, scope}) → buildMemoryCard({scope}) → runGates({card, walkResult, store, scope})`。
3. **rendered = `card.claims`**（真正进 `section` 的条目行，不含 indexLine / markers / omitted），共 133 行（69 claim + 64 指针）。
4. 每条行映射回依附的 `hit`（claim 行按 `claimId`，指针行按该棋谱首个非 claim hit），取 `hit.why` 作行内主题集，机械打分：
   - **useful**：行内主题 ∩ 信号匹配主题 ≠ ∅ 且含**非 tool 类**主题；或同一文件/域名/错误码实体；
   - **neutral**：无共同主题但棋谱 scope = 信号 scope；
   - **noise**：交集**全是** tool 类（仅泛工具）／全无交集且不同 scope。
5. 稳健性：另算 **S1**（只认 `score=1` 精确匹配）与 **S2**（claim 原文必须逐字含该主题）。

## 3 · 数字（两个快照：scope 修复在采样期间落地）

| 快照 | 时点 | 代码哈希 | 渲染行 | U / N / Z | **hopPrecision** | S1 | S2 | noiseRate | zeroInjection | tokens p50 / p90 | 闸 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **P1 修复后（当前）** | 04:01 | walk `d76bdd5b` · inject `c5757c33` · gates `1bea808e` | 133 | 67 / 6 / 60 | **50.38%** | 31.58% | 17.29% | 45.11% | 14.29% | 233 / 268 | **35/35** |
| P0 修复前（as shipped） | 03:55 | walk `1d133ad7` · inject `90666afa` · gates `1bea808e` | 148 | 63 / 4 / 81 | 42.57% | 32.43% | 18.24% | 54.73% | 11.43% | 246 / 276 | 16/35 |

> 复算一致性：04:0x 用后来的版本（walk `f7f7039e` · inject `4574ce5f`）复跑，P1 的 6 个指标**完全相同**（50.38% / 133 行 / 67 useful / zero 14.29% / 闸 35-35）→ 该读数对这几版实现不敏感，可当"修复后基线"引用。

### 3.1 scope 分层（P0，Lead 口径）

| 分层 | 渲染行 | 占比 | useful | noise | **hopPrecision** | noiseRate |
|---|---|---|---|---|---|---|
| **in-scope（同工作区 + `u:`）** | 88 | 59.46% | 52 | 32 | **59.09%** | 36.36% |
| **cross-scope（bug，不计入）** | 60 | 40.54% | 11 | 49 | 18.33% | 81.67% |

**cross-scope 行当时是 bug**：R11 `walkFromSignals` 不接收 scope，40.54% 的渲染行来自别的工作区（闸 1 抓出 `gate1/scope-mismatch` × 60，与这 60 行一一对应）。**最终 hopPrecision 不计 cross-scope。** 修复已在采样期间落地：P1 用新契约 `walkFromSignals({..., scope})` 重跑，133 行**全部 in-scope**（cross = 0），闸 1 归零、整体 35/35 全绿。

> 注意 `59.09%` **不是**修复后的真值：删掉跨域候选后，卡片用排名更靠后的 in-scope 命中补位（`ENTRY_LIMIT=5` 未满），且 `dsh-gokifu` 转零注入，真值是 **50.38%**。

### 3.2 分层根因

| 分组 | P1 渲染行 | useful | hopPrecision | P0 对照 |
|---|---|---|---|---|
| 种子 `tool`（19 条样本） | 68 | 12 | **17.65%** | 5.19% |
| 种子 `dependency`/`error`/`domain`/`scaffold`（11 条） | 41 | 39 | **95.12%** | 97.83% |
| 任务句（5 条） | 24 | 16 | **66.67%** | 56.00% |
| claim 行 / 指针行 | 69 / 64 | 38 / 29 | 55.07% / 45.31% | 45.33% / 39.73% |
| 一跳 / 二跳 | 125 / 8 | 67 / 0 | 53.60% / 0% | 45.00% / 0% |

**问题不在"跳太深"（二跳仅 8 行、0 有用，样本太小）也不在"指针行"（45.31% 与 claim 行 55.07% 同档），而在"哪个主题有资格起跳"。** 30 个 df 最高 key 里 19 个是 `kind=tool`——主题库把每个 shell 动词记成高频主题，df 排序天然把噪声顶到最前。

### 3.3 token / 零注入（照旧，带时点）

| 指标 | P1 | P0 |
|---|---|---|
| tokens min / p50 / p90 / max | 35 / **233** / **268** / 285 | 45 / 246 / 276 / 302 |
| zeroInjectionRate | **5/35 = 14.29%** | 4/35 = 11.43% |
| 零注入样本 | `ls` `cd` `wc` `127.0.0.1` `dsh-gokifu` | `ls` `cd` `wc` `127.0.0.1` |

预算是 500，全程未触顶（最坏 57%）→ **本轮不是 token 问题**。零注入里前三个是 2 字符 ASCII 键（正确沉默），`127.0.0.1` 是真实主题（df=13）却抽不出词（`signalFromText` 的 ASCII 正则要求首字母），`dsh-gokifu` 是被 scope 过滤掉的跨域命中（修复的预期效果）。

### 3.4 噪声 top 5

**按种子 key（P1 / P0 in-scope）**——十个位置全是 tool 主题：

| # | P1 | P0 in-scope |
|---|---|---|
| 1 | `cat` (df 18) 5/5 | `curl` (df 12) 5/5 |
| 2 | `curl` (df 12) 5/5 | `job_output` (df 9) 4/4 |
| 3 | `grep` (df 20) 5/5 | `bash` (df 19) 2/2 |
| 4 | `head` (df 19) 5/5 | `cat` (df 18) 2/2 |
| 5 | `mkdir` (df 9) 5/5 | `echo` (df 20) 2/2 |

**按行内连接 key（一行可计多个 key，不互斥）**：

| # | P1 | P0 in-scope |
|---|---|---|
| 1 | `no such file or directory` 34 | `@deepseek-ai/schemastery` 16 |
| 2 | `syntaxerror: invalid or unexpected token` 34 | `d:/deepseek harness/home/sessions` 16 |
| 3 | `@deepseek-ai/schemastery` 29 | `js-yaml` 16 |
| 4 | `d:/deepseek harness/home/sessions` 29 | `no such file or directory` 16 |
| 5 | `js-yaml` 29 | `syntaxerror: invalid or unexpected token` 16 |

噪声原因（P1）：`generic-tool-overlap-only` 58 行 + `generic-tool-only` 2 行；`unattributed` 0。连接 key 榜没有"毒王"（并列多、分布平）→ 噪声是结构性的：`link.why` 把整条边共享的 6–15 个主题都塞进 `why`（133 行里 130 行 `why` ≥2 key），一行同时挂 `package.json`/`js-yaml`/`SyntaxError…`，与信号的共同主题被稀释成一个泛工具词。

## 4 · 最小可逆收紧方案（只给建议，不落地）

### A（首选）泛工具主题不参与"起跳"

- **改动点（一行）**：`src/rooms/walk.mjs:442`
  ```js
  const picked = matches.slice(0, maxTopics);                                        // 现在
  const picked = matches.filter((m) => m.topic.kind !== 'tool').slice(0, maxTopics); // 建议
  ```
- **预期影响（P1 模拟：把 `kind==='tool'` 的主题整块从匹配池拿掉）**：hopPrecision **50.38% → 87.38%**，noiseRate 45.11% → **1.94%**，zeroInjection 14.29% → **34.29%**，tokens p50 233 → 222。与 `limit=3` 叠加 → 89.86%。
- **为什么是上界**：模拟连二跳 `why` 一起拿掉；真改动只挡一跳起跳，tool 主题仍可作 `why` 与 claim 文本匹配 → 真实值应落在 **70%–87%**，必须复测。
- **成分警示**：87% 里有一部分是"工具词吸附到含该词的文件路径/错误主题"（`echo ⊂ …/echo.yml`）；**真实任务句在 A 下是 68%（17/25）**，不要把 87% 当承诺值。
- **代价与可逆性**：沉默样本 5 → 12 条（符合"不相关时沉默"，但要在 M5 留出集确认 recall 不掉）；回滚 = 删掉 `.filter(...)`。
- **不丢信息**：同一 key 双 kind 在本库有 5 处（`bash`/`npm`/`github` 是 term+tool，`@deepseek-ai/cordis` 是 dependency+scaffold，`dsh-design-studio` 是 dependency+term），压制 tool 类不会让该名字彻底失配。

### B（补充）包含匹配加词边界约束

- **改动点**：`src/rooms/walk.mjs:145-151` `overlaps()` —— 仅在 term 于 key 中出现处**前/后都不是 `[a-z0-9]`** 时才算命中（保留双向包含语义）。
- **预期影响**：110 次包含匹配里 **38 次是词内片段伪命中**（`bash ⊂ gitbash-shell`、`cat ⊂ msedge.exe`、`sed ⊂ composed.yml`），干掉这 38 个即净收益；72 次边界对齐的匹配（`node ⊂ node_modules`）保留。
- **不要整刀去掉双向包含**：多词主题（`exit code 1`、`No such file or directory`）只能靠包含匹配命中，去掉后 error 类 usefulness 从 100% 直接归零（实测 S1 口径 error = 0%）。

### C（预算杠杆，不是精度杠杆）`ENTRY_LIMIT 5 → 3`

- **改动点**：`src/rooms/inject.mjs:23` `export const ENTRY_LIMIT = 5;`
- **预期影响**：hopPrecision 50.38% → **48.89%**（**−1.5pp**，方向相反），tokens p50 233 → 184、p90 268 → 217。只适合当"开闸时先降 token"的旋钮，不能当精度方案（删掉的是排名靠后的行，噪声比例没变）。

### D（已证伪，不建议）抑制指针行

- claim 行 55.07% vs 指针行 45.31%：砍掉 64 行指针行后整体只到 **55.07%（+4.7pp）**，总量砍掉一半；而闸 5 已把指针行归为"不主张断言的合规类"。噪声来自主题选择，不来自行类型。

### 不做清单

- ❌ 把 tool 主题从**主题库**删掉（会动 links/threads/claims 的 `why` 与 df，不可逆，且违反"只增不改"）——只在匹配起点过滤。
- ❌ 用模型/相似度判"够不够相关"（撞 `方案.md` §10 第 2 条）。
- ❌ 为达标把分母改成"只算 claim 行"（口径造假；实测指针行并不更差，且 scope 修复后两者已接近）。

## 5 · 待办（复算口径）

1. **R11 scope 修复已落地**（P1）→ 请以 P1 的 50.38% 为当前基线；`tmp/t8-precision.mjs` 已按新契约传 `scope`，随时可复算。
2. **若采纳 A**：先单独成一刀（只改 `picked` 一行，结构不变、行为可变、可单独回滚），再复算本抽样 + `node --test` + `scripts/check.mjs`；预期 hopPrecision 过 70%，同时零注入升到 ~34%，需要 Lead 拍"沉默变多"是否可接受。
3. **闸门**：P1 下 35/35 全绿（`gates.mjs 1bea808e`）；开闸决策要求"闸集合冻结 + 同一哈希下的卡片 + 本抽样"三者同快照，否则数字不可比（T7b 的 20/20、P0 的 16/35、P1 的 35/35 是三个时点）。
4. **信号抽取的独立缺口**（不属于 hopPrecision，但占一半零注入）：`127.0.0.1` 这类数字/IP 主题抽不出实体；建议 M4 把"实体抽取"与"主题匹配"分开记。

## 6 · 未做 / 风险

| # | 项 | 归属 | 说明 |
|---|---|---|---|
| 1 | 改代码 | Lead（本轮只给建议） | A/B/C 各写了具体改点，未落地、未跑测试 |
| 2 | 留出集 / LOO | M5 | 本轮是单时点影子抽样，不含配对重放与行为观测 |
| 3 | 二跳独立定罪 | R11 | 二跳仅 8 行；需"只开一跳"的 A-B 对照 |
| 4 | `u:` 层单列 | R11/M4 | 语料只有 1 条 `u:owner` claim，本轮并入 in-scope |
| 5 | 跨时点可比性 | 全体 | 采样期间 `walk/inject/gates` 均被并发修改；数字只绑定 §3 表里的哈希 |
| 6 | 判据的宽窄 | 审计口径 | S0 最宽（整局级重叠）、S2 最严（原文含 key）；两端都 <70%，但"真值"落在两者之间，未标定 |

## 7 · 给接手者的最短路径

```bash
# 复算（只读 store，不写 <DSH_HOME>；脚本在 tmp/）
node tmp/t8-precision.mjs tmp/memory-context tmp/t8-precision.json
node -e 'const j=require("./tmp/t8-precision.json");const a=j.aggregate;
console.log("hopPrecision",a.hopPrecision,"S1",a.hopPrecisionS1,"S2",a.hopPrecisionS2,
            "| noise",a.noiseRate,"| zero",a.zeroInjectionRate,
            "| tok p50/p90",a.tokens.p50,a.tokens.p90,"| gates",a.gatesOk+"/"+a.samples)'

# 逐行核对某条样本
node -e 'const j=require("./tmp/t8-precision.json");const s=j.samples.find(x=>x.id==="k02");
for(const l of s.lines) console.log(l.s0.verdict, l.s0.reason, JSON.stringify(l.keys), l.text.slice(0,60))'

# 代码快照对齐
sha256sum src/rooms/walk.mjs src/rooms/inject.mjs src/rooms/gates.mjs src/rooms/persist.mjs
```
