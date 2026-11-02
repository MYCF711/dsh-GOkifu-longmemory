# T10 报告 · M5 机械评测（LOO `repeatFailureRate`，零模型调用）（2026-11-02）

> 任务 id：**task-11**（`T10: M5 机械评测（LOO repeatFailureRate）`）
> 分支：**main（未提交）** —— 按 Lead 指令「团队共用工作树，禁止 checkout/switch/commit，文件由 Lead 提交」。
> 本任务只产出 4 个文件，**没动**其他房间 / `package.json` / `CHANGELOG` / `MAINTENANCE` / 计划表。

## 0 · 交付物

| 文件 | 行数 | 作用 |
|---|---|---|
| `scripts/eval.mjs` | 851 | 机械评测：LOO `repeatFailureRate`；三口径（both/edge/event）；`--json`、`--evidence`；纯函数 `evaluateLoo` / `normalizeErrorSignature` |
| `test/eval.test.mjs` | 430 | 10 条：签名规范化 / 退化签名 / 事件侧失败 / LOO 时间顺序 / 同刻不可见 / 空库 / 端到端 / CLI |
| `evidence/M5-eval.md` | 生成物 | 公式 + 分子分母 + 时点 + 三口径对照 + 逐局表 + 按 scope + 坑榜 + 复现命令 |
| `reports/T10-REPORT.md` | 本文件 | 数字 + 风险 |

## 1 · 验收

```
$ node --test test/eval.test.mjs
ℹ tests 10   ℹ pass 10   ℹ fail 0   ℹ duration_ms 1358.8

$ node --test                # 全仓（含并行的 plugin 工作）
ℹ tests 298  ℹ pass 298  ℹ fail 0   ℹ duration_ms 7046.0
```

> Lead 给的基线是「全仓 268 条」；实测现为 **298 条全绿** = 268 + 本任务 10 条 + 另一会话并行的 `test/plugin.test.mjs` 20 条。**没有弄红任何既有测试**。
> `$DSH_HOME/memory-context/` 至今不存在（`ls` 报 no such file）——评测全程只读，**没有一次写入 `$DSH_HOME`**。

## 2 · 口径（分子 / 分母 / 时点 / 树）

| 项 | 定义 |
|---|---|
| 失败签名 | 失败原文规范化：去**绝对路径**（`C:\a\b`、`/a/b`）、**行号列号**（`f.mjs:12:5`、`line 42`）、**时间戳**（ISO / epoch ms）、**十六进制**（`0x…`、≥8 位含数字 / ≥12 位纯 hex）；压空白、转小写 |
| memory(E) | 其它 **root 局**中 `startedAt` **严格更早**者（不用未来信息；同一时刻的局互不可见） |
| repeat(E) | E 的签名 ∈ memory(E) 的条数（同一局同一签名只算一次） |
| novel(E) | E 的签名 ∉ memory(E) 的条数 |
| **`repeatFailureRate`** | **Σrepeat ÷ (Σrepeat + Σnovel)**；分母为 0 时输出 `null`（不写 0） |
| 无记忆基线 | **0**（定义如此：没有 memory 时每条签名都是 novel） |
| coverage | 有 ≥1 条失败签名的 root 局数 ÷ 全部 root 局数 |
| 时点 | 每局的 `startedAt`（会话 header.createdAt，epoch ms） |
| 树 / 语料 | store = 工作树 `tmp/memory-context`（入档产物）；原件 = 只读 `$DSH_HOME/sessions`、`$DSH_HOME/chess-context` |

**失败来源三种（报告里全列，引用时必须带口径名）**：

| 口径 | 取法 | 覆盖（24 局） |
|---|---|---|
| `edge` | R03 `extractSignals({graph})` 的 `failures`（`edge.result==='failure'` + `errorSnippet`）—— 方案 §8.2 原始口径 | **7 局**（真实语料只有 7/24 局有棋谱） |
| `event` | 事件侧兜底：`tool/result` 文本**以 `[exit code: N]`（N≠0）结尾**（DSH 自己的标记），取"最像错误"的一行 | **19 局** |
| `both` | **默认**：逐局优先 `edge`；该局没有失败边时回退 `event`（不重复计入） | **19 局** |

## 3 · 真实数字（`[本] 2026-11-02 04:18`，`tmp/memory-context` = 2026-11-01 入档的 92 局其中 24 root 局）

### 3.1 三口径总账

| 口径 | root 局 | 有签名 | coverage | 签名总数 | repeat | novel | **repeatFailureRate** |
|---|---|---|---|---|---|---|---|
| `both`（主） | 24 | 19 | 79.2% | 98 | **12** | **86** | **12.2%** |
| `edge` | 24 | 7 | 29.2% | 49 | 8 | 41 | **16.3%** |
| `event` | 24 | 19 | 79.2% | 117 | 15 | 102 | **12.8%** |

- 去重后签名 **86**；出现重复的局 **9/19**；memorySize 从 0 长到 **80**（逐局表见 `evidence/M5-eval.md` §3.1）。
- 三口径量级一致（12–16%），说明"重复踩坑"不是某一种抽取方式的伪影。

### 3.2 按 scope 分层（主口径）

| scope | 局 | 有签名 | repeat | novel | rate |
|---|---|---|---|---|---|
| `w:<WORKSPACE>` | 21 | 18 | 11 | 80 | 12.1% |
| `w:d:/…/长期记忆系统` | 1 | 1 | 1 | 6 | 14.3% |
| `w:d:/DeepSeek Harness/default-workspace` | 1 | 0 | — | — | n/a |
| `w:d:/tmp/hstest` | 1 | 0 | — | — | n/a |

### 3.3 坑榜（同一签名出现在 ≥2 局；共 10 条，前 5）

| 局数 | 签名 |
|---|---|
| 3 | `error: cannot modify "<path>": file has not been read — read the file, then retry` |
| 3 | `error: deepseek returned no web_search_tool_result blocks; the request may not have triggered native web search` |
| 2 | `error: cannot write "<path>": file changed since it was read — re-read the file, then retry` |
| 2 | `error: team member limit 8 reached` |
| 2 | `error: the pwsh tool is hidden on this host by the dsh-gitbash-shell settings` |

> 这 5 条都是**同一类坑重复踩**的实例（读前改 / 写前重读 / 团队上限 / 宿主工具开关 / 搜索工具空结果）——正是本项目第一验收面要拦的东西。

### 3.4 成本与可复算

- 全量评测 **3.0 s**（24 局日志解码 + 7 张棋谱回放 + 签名匹配），**0 次模型调用、0 次写入**。
- 确定性：同一 `now` 连跑两次，`primary + perEpisode + variants` 的 JSON **逐字节相同**（已实测）。
- 只读：跑前跑后对 store 与 dataRoot 做 sha256 树指纹，**完全不变**（测试里固化）。

## 4 · 指标本身怎么被验证（AGENTS §2.4「指标要被验证」）

1. **语义夹具**（`test/eval.test.mjs`）：E1(A) / E2(A+B) / E3(B) ⇒ E2 的 A 是 repeat、B 是 novel；E3 的 B 是 repeat；总账 2/2 ⇒ 0.5。
2. **时间顺序**：把同一签名放到更晚的局 ⇒ 更早的局仍是 novel（不用未来信息）。
3. **同一时刻**：两局 `startedAt` 相同 ⇒ 互不可见，两边都 novel（按时间分组，不按排序）。
4. **空库**：`rate = null`、`coverage = null`、不抛、不创建目录（不把"没有数据"写成 0%）。
5. **端到端**：真 store（`createStore` 写入 3 局）+ 真日志（多帧 zstd）+ 真棋谱（version 1）跑 R01/R02/R03，断言逐局 repeat/novel 与 `memorySize`，并证明**只读**。
6. **事件侧兜底**：没有棋谱的局用 `[exit code ≠ 0]` 取失败；引用文件内容里的 `[exit code: 1]`（中间出现、结尾是 0）不算失败。

## 5 · 风险与口径限制（读数字前先看）

1. **这是"机械代理指标"，不是收益本身**。它只回答「失败原文是否在更早的局里出现过」，不回答「模型因此是否真的少走弯路」——后者要 M5 的**有/无记忆配对重放**（带模型调用）。对外引用必须写成"机械代理"。
2. **`both` 混了两个来源**：`edge`（棋谱失败边，质量高、覆盖 7 局）与 `event`（退出码，覆盖 19 局但只取错误行）。两个分口径数字都在报告里，**不允许只挑一个引用**。
3. **签名是文本匹配**：同一错误换了措辞算 novel（**低估** repeat）；同一模板不同参数算 repeat（可能**高估**）。规范化只做格式归一，**不做语义合并**（禁止模型判断，AGENTS §2.3）。
4. **`edge` 口径覆盖低**：24 局里只有 7 局有棋谱（压缩插件 2026-11-01 才装）——这正是 方案 §8.3「缺 1」的量化。等棋谱铺开，`edge` 口径才有统计意义。
5. **`event` 口径只认退出码结尾**：`read`/`write`/`edit` 这类工具失败**没有退出码**，不在内（低估）；反过来，失败的 `ls` 之类可能把输出行当"错误行"（坑榜里那条 `drwxr-xr-x …` 就是），签名质量参差。
6. **样本小**：24 局 / 98 条签名，`p=12.2%` 的 1σ 标准误约 **±3.3pp**（≈95% 区间 [6%, 19%]）。只说明"同机同语料"的量级，**不能外推**，也不能直接拿去和 Hindsight 比（不同语料不可比，方案 §8.2 要求同一批留出会话）。
7. **无记忆基线 = 0 是定义**，不是实测值；有记忆的收益最终要"配对重放"才能算净收益。
8. **一局内重复只算一次**：同一局里同一个坑犯 5 次，分子仍只 +1（口径选择：衡量"跨局重复"而不是"局内手滑"）。
9. **只覆盖 root 局**（24/92），`folded-into` 的 68 个子代理局不参与 LOO（AGENTS §4.1「只收 depth=0」）；store 是 2026-11-01 的入档产物，之后新增的会话还没入档。
10. **`--evidence` 是唯一写入口**：写文件时用 `fs.writeFileSync`（不是原子写）——它是报表产物，迟一步重跑即覆盖；store 的原子写纪律不受影响。

## 6 · 复现命令

```bash
cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"

node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context                    # 文本表
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --json             # 机器可读
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --source edge      # 只算 R03 边失败
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --evidence evidence/M5-eval.md
node --test test/eval.test.mjs
```

## 7 · 下一步（M5 剩余，不属本刀）

1. 棋谱补齐后重跑 `--source edge`，看 `edge` 口径的 rate 是否与 `both` 收敛。
2. **有/无记忆配对重放**（L1 基准，方案 §8.2/§8.3）：同一批留出会话跑两次，才能真正说"收益"。
3. 与 Hindsight 在同一批留出会话上跑同一指标（方案 §8.2「不比 Hindsight 差」的主判据）。
4. `negTransferRate` / `overfitGap` 目前还没有消费者（没有真实注入样本），等影子数据积累后再接。
