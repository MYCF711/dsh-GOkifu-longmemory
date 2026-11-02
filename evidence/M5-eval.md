# M5 机械评测：LOO repeatFailureRate（2026-11-02）

> 生成：`node scripts/eval.mjs --root $DSH_HOME --store tmp/memory-context --evidence evidence/M5-eval.md`
> 运行时刻：2026-11-01T20:18:48.177Z（UTC；epoch ms 1793564328177）· 零模型调用 · 只读 · 耗时 3028 ms

## 1 · 口径（分子 / 分母 / 时点 / 树）

| 项 | 定义 |
|---|---|
| 失败签名 | 规范化失败原文（去绝对路径/行号列号/时间戳/十六进制；压空白；小写） |
| memory(E) | 其它 root 局中 startedAt 严格更早者（不用未来信息；同一时刻互不可见） |
| repeat(E) | E 的签名 ∈ memory 的条数（按"每局每签名一次"计） |
| novel(E) | E 的签名 ∉ memory 的条数 |
| **repeatFailureRate** | **Σrepeat ÷ (Σrepeat + Σnovel)；分母 0 ⇒ null** |
| 无记忆基线 | 0（没有 memory 时每条签名都是 novel） |
| coverage | 有 ≥1 条失败签名的 root 局数 ÷ 全部 root 局数 |
| 时点 | startedAt（会话 header.createdAt，epoch ms） |

**分子** = Σrepeat（逐局把"签名已在更早的局里出现过"的条数相加，同一局同一签名只算一次）。
**分母** = Σrepeat + Σnovel = 有失败签名的局里"每局去重后签名"的总条数。分母为 0 时输出 `null`，不写 0。
**树 / 语料**：工作树 `tmp/memory-context`（入档产物）+ 只读原件 `$DSH_HOME/sessions`、`$DSH_HOME/chess-context`。

## 2 · 三口径对照（同一批 root 局，失败来源不同）

| 口径 | root 局 | 有签名 | coverage | repeat | novel | repeatFailureRate |
|---|---|---|---|---|---|---|
| `both` | 24 | 19 | 79.2% | 12 | 86 | **12.2%** |
| `edge` | 24 | 7 | 29.2% | 8 | 41 | **16.3%** |
| `event` | 24 | 19 | 79.2% | 15 | 102 | **12.8%** |

- `edge` = R03 `extractSignals` 的失败边（方案 §8.2 的原始口径）；真实语料只有部分局有棋谱 ⇒ coverage 低。
- `event` = 事件侧兜底（`tool/result` 以 `[exit code: N≠0]` 结尾，DSH 自己的标记）；覆盖没有棋谱的局。
- `both`（本文件主口径）= 逐局**优先 edge**，该局没有失败边时回退 event（不重复计入）。

## 3 · 主口径结果（`both`）

- root 局 **24** · 有失败签名 **19**（coverage **79.2%**）
- 签名总数 **98** · 去重后 **86** · 出现重复的局 **9**
- **repeat 12 / novel 86 ⇒ repeatFailureRate = 12.2%**（无记忆基线 0）

### 3.1 逐局表

| # | 日期(UTC) | episode | 失败来源 | 局内签名 | repeat | novel | 逐局率 | memorySize | scope |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-11-01 | `<ep>` | event | 3 | 0 | 3 | 0.0% | 0 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 2 | 2026-11-01 | `<ep>` | edge | 10 | 0 | 10 | 0.0% | 3 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 3 | 2026-11-01 | `<ep>` | event | 3 | 0 | 3 | 0.0% | 13 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 4 | 2026-11-01 | `<ep>` | event | 4 | 1 | 3 | 25.0% | 16 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 5 | 2026-11-01 | `<ep>` | event | 1 | 0 | 1 | 0.0% | 19 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 6 | 2026-11-01 | `<ep>` | none | 0 | 0 | 0 | n/a | 20 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 7 | 2026-11-01 | `<ep>` | none | 0 | 0 | 0 | n/a | 20 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 8 | 2026-11-01 | `<ep>` | event | 8 | 0 | 8 | 0.0% | 20 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 9 | 2026-11-01 | `<ep>` | event | 8 | 0 | 8 | 0.0% | 28 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 10 | 2026-11-01 | `<ep>` | event | 1 | 0 | 1 | 0.0% | 36 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 11 | 2026-11-01 | `<ep>` | event | 4 | 1 | 3 | 25.0% | 37 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 12 | 2026-11-01 | `<ep>` | event | 4 | 0 | 4 | 0.0% | 40 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 13 | 2026-11-01 | `<ep>` | event | 5 | 1 | 4 | 20.0% | 44 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 14 | 2026-11-01 | `<ep>` | none | 0 | 0 | 0 | n/a | 48 | `w:d:/tmp/hstest` |
| 15 | 2026-11-01 | `<ep>` | edge | 8 | 1 | 7 | 12.5% | 48 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 16 | 2026-11-01 | `<ep>` | edge | 6 | 2 | 4 | 33.3% | 55 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 17 | 2026-11-01 | `<ep>` | edge | 5 | 2 | 3 | 40.0% | 59 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 18 | 2026-11-01 | `<ep>` | edge | 12 | 2 | 10 | 16.7% | 62 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 19 | 2026-11-01 | `<ep>` | event | 1 | 0 | 1 | 0.0% | 72 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 20 | 2026-11-01 | `<ep>` | event | 7 | 1 | 6 | 14.3% | 73 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 21 | 2026-11-01 | `<ep>` | none | 0 | 0 | 0 | n/a | 79 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 22 | 2026-11-01 | `<ep>` | edge | 1 | 0 | 1 | 0.0% | 79 | `w:e:/Documents/deepseek-harness/default-workspace` |
| 23 | 2026-11-01 | `<ep>` | none | 0 | 0 | 0 | n/a | 80 | `w:d:/DeepSeek Harness/default-workspace` |
| 24 | 2026-11-01 | `<ep>` | edge | 7 | 1 | 6 | 14.3% | 80 | `w:d:/DeepSeek Harness/default-workspace/长期记忆系统` |

### 3.2 按 scope 分层

| scope | 局 | 有签名 | repeat | novel | rate |
|---|---|---|---|---|---|
| `w:e:/Documents/deepseek-harness/default-workspace` | 21 | 18 | 11 | 80 | 12.1% |
| `w:d:/DeepSeek Harness/default-workspace/长期记忆系统` | 1 | 1 | 1 | 6 | 14.3% |
| `w:d:/DeepSeek Harness/default-workspace` | 1 | 0 | 0 | 0 | n/a |
| `w:d:/tmp/hstest` | 1 | 0 | 0 | 0 | n/a |

### 3.3 坑榜（同一签名出现在 ≥2 局；共 10 条）

| 局数 | 签名（规范化后，截 110 字） |
|---|---|
| 3 | `error: cannot modify "<path>": file has not been read — read the file, then retry` |
| 3 | `error: deepseek returned no web_search_tool_result blocks; the request may not have triggered native web searc` |
| 2 | `drwxr-xr-x 1 weicong 197121 0 nov 1 17:<line> ..` |
| 2 | `error: cannot write "<path>": file changed since it was read — re-read the file, then retry` |
| 2 | `error: team member limit 8 reached` |
| 2 | `error: the pwsh tool is hidden on this host by the dsh-gitbash-shell settings (pwsh tool switch, off by defaul` |
| 2 | `failed to run git: fatal: not a git repository (or any of the parent directories): .git` |
| 2 | `parsererror:` |
| 2 | `syntaxerror: invalid or unexpected token at checksyntax (node:internal/main/check_syntax:<line>)` |
| 2 | `{"message":"invalid request.\n\nfor 'links/0/schema', nil is not an object.","documentation_url":"https://docs` |

## 4 · 复现命令

```bash
cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context            # 文本表
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --json     # 机器可读
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --source edge  # 只算 R03 边失败
node scripts/eval.mjs --root "$DSH_HOME" --store tmp/memory-context --evidence evidence/M5-eval.md
node --test test/eval.test.mjs
```

## 5 · 口径风险（读数字前先看）

1. **这是"机械代理指标"，不是收益本身**。它只回答"失败原文是否在更早的局里出现过"，
   不回答"模型是否因此真的少走弯路"——后者要 M5 的配对重放（有模型调用）。
2. **`both` 混了两个来源**：edge（棋谱失败边）证据质量高但覆盖低；event（退出码）覆盖高但只取错误行。
   两个分口径的数字都在 §2，引用时必须带口径名。
3. **签名是文本匹配**：同一错误的不同措辞算 novel（**低估** repeat）；同一模板不同参数算 repeat（可能**高估**）。
   规范化只去路径/行号/时间戳/十六进制，不做语义合并（禁止模型判断）。
4. **time 用的是会话 startedAt**：一局内"先犯后犯"同一坑算一次 repeat；跨局严格按开始时间。
5. **无记忆基线 = 0 是定义**，不是实测：没有 memory 时没有"已结算失败"可比。
