# T310 · antipattern 的失效条件（M4 / F3）

> `[本] 2026-11-06 14:0x +08:00` · 只读（真库未写；`--apply` 只写 `tmp/t310-copy` 副本）
> 真库：`<DSH_HOME>/memory-context`（claims **1578**）· 复现：
> `node scripts/antipattern-falsifiable.mjs --store "$DSH_HOME/memory-context" --sample 5 --json`

## 0 · 判据（知识库 69）

**值得记的失败** = F1 付过代价 · F2 可复现 · **F3 可反驳**（写得出"什么情况算我错"）。**缺 F3 = 口号。**

本报告只回答：**我们的 antipattern 里，有多少条真的能回答"什么情况下这条不再成立"？**

## 1 · 测量（真库实跑）

```json
{"total":1105,"literal":1105,"substantive":0,"unverified":1105,"scopeOnly":1105,
 "byReason":{"scope-only-precondition（作用域不是失效条件）":1105}}
```

| 指标 | 值 | 说明 |
|---|---|---|
| antipattern 总数 | **1105** | 其中 `class:` 类级章节 10 条 |
| **字面**带失效条件（`preconditions` / `validity` / `validUntil`） | **1105 / 1105 = 100.0%** | ⚠️ 全部是 `preconditions:[{check:'scope'}]` —— **作用域是"在哪适用"，不是"何时失效"** |
| **实质**带失效条件（非 `scope` 的 precondition / validity / 显式条件子句） | **0 / 1105 = 0.0%** | 这是 M4 的真实覆盖率 |
| 只有 `scope` 前置条件的 | 1105 | 100% |
| 带 `validity.type != none` | 0 | 全部 `none` |
| 带 `validUntil` / `validTo` | 0 | — |
| 带 `counter`（反例） | 0 | — |
| 正文含**子句开头**的显式条件（`除非`/`只有在`/`仅当`/`一旦`） | **0** | 宽松匹配只有 2 条，且都是命令输出里的「gh 登录失效」（误报） |

**结论（测量）**：M4 的**实质覆盖率 = 0.0%**。1105 条 antipattern **没有一条**写得出"什么情况下这条不再成立"——按知识库 69 的判据，它们**全部不可反驳**。

## 2 · 抽样 5 条（逐字）

按 id 排序等距抽（`--sample 5`，确定性）：

### ① `c-00248579` · observed · `w:d:/…/DSH-GO`

```text
Error: unknown job bash-49fb11d400eb4696
```
- 形态：`hasErrorSignature: true` · 49 字
- 派生：`unverified`（`no-recorded-condition`）
- **判断**：F1 付过代价 ✅、F2 可复现 ✅（job id 失效）、**F3 缺** ❌ —— 是"发生了什么"，不是"何时不再成立"。**半成品。**

### ② `c-39b0e9b5` · observed · `w:d:/…/反代`

```text
ReferenceError: rate is not defined at entryOf (file:///D:/DeepSeek%20Harness/%E5%8F%8D%E4%BB%A3/magpie-chatbox-ai/src/context.mjs:149:9) at Module.staticModels (file:///D:/DeepSeek%20…
```
- 形态：`hasErrorSignature: true` · 200 字（截断到 200 上限）
- 派生：`unverified`
- **判断**：具体错误 + 栈帧（F2 强），但**没有失效条件**（F3 缺）。**半成品。**

### ③ `c-79ccc1c3` · observed · `w:d:/…/GOkifu上下文压缩`

```text
SyntaxError: Identifier 'FOLD_RETRY_BASE_SEQ' has already been declared at checkSyntax (node:internal/main/check_syntax:72:5)
```
- 形态：`hasErrorSignature: true` · 125 字
- 派生：`unverified`
- **判断**：同上——可复现的具体语法错误，但"什么情况算我错"没写。**半成品。**

### ④ `c-be4e7525` · observed · `w:d:/…/default-workspace`

```text
=== 当前 IME === com.iflytek.inputmethod.oppo/.FlyIME === 可用 IME ===
```
- 形态：`hasErrorSignature: false` · 66 字
- 派生：`unverified`
- **判断**：**连错误都不是**（`adb`/`ime` 命令输出），F1/F2/F3 全不成立。**噪声——它根本不该是 antipattern。**

### ⑤ `c-ffda8d00` · observed · `w:d:/…/DSH-GO`

```text
=== 方案 1：端口检查命令 === 0 === 方案 9：seq<=0 不进水位的代码 ===
```
- 形态：`hasErrorSignature: false` · 49 字
- 派生：`unverified`
- **判断**：**不是错误**，是方案标题/分隔行。**噪声。**

**抽样汇总**：5 条里 **3 条是可复现的具体错误**（F1+F2 成立、F3 缺）、**2 条连错误都不是**（噪声）；**0 条可反驳**。

## 3 · 全库形态分布（机械代理）

| 形态 | 条数 | 占比 |
|---|---|---|
| 有错误签名（`Error:` / `fatal:` / `exit code` / `ENOENT` …） | **556** | 50.3% |
| **无错误签名**（命令输出 / 分隔行 / 方案标题） | **549** | **49.7%** |
| 祈使句开头（`要`/`不要`/`必须`…） | 0 | 0.0% |
| `class:` 类级章节 | 10 | 0.9% |

也就是说：**一半的 antipattern 连"失败"都不是**（是命令输出被 R09 抽成了 claim），另一半是可复现的错误但**没有失效条件**。

## 4 · 修法（只在副本）

**没有编造任何一条**：`falsifiableWhen` 只允许从**记录里的结构化字段**或**正文逐字子句**派生：

| 规则 | 条件 | 产出 | 来源 |
|---|---|---|---|
| **R1** | 非 `scope` 的 `preconditions`（`file-exists` / `cmd` / `tool` / `step-range`） | `当「<check> = <value>」不再成立时` | `preconditions[i]` |
| **R2** | `validity.type !== 'none'` | `当 <type>=<value> 不再成立时` | `validity` |
| **R3** | 正文里**以子句开头**的 `除非…` / `只有在…` / `仅当…` / `一旦…` | **逐字切片**（测试断言 `text.includes(clause)`） | `text@<offset>` |
| — | 只有 `scope` 前置条件 / 什么都没有 | **`falsifiableWhen: null` + `falsificationStatus: 'unverified'`** | — |

**反误报守卫**：`gh 登录失效` 这种**句中**出现"失效"的不算条件子句（正则要求子句开头）；已用测试钉死。

**副本实跑**：
```
$ node scripts/antipattern-falsifiable.mjs --store "$DSH_HOME/memory-context" --apply --out tmp/t310-copy
副本：…\tmp\t310-copy · 复制 1578 条 · derived 0 · unverified 1105 · skipped 0
```
副本校验：1105 条 antipattern **全部**带 `falsifiableWhen` 字段（值 `null`）+ `falsificationStatus: 'unverified'`；**derived = 0**。真库未写（副本守卫：`--out` 必须在仓库 `tmp/` 下，且不许与源库互相包含）。

## 5 · 结论（一句话）

> **可反驳的真教训 = 0 条（0.0%）；有错误签名但没失效条件的"半成品" = 556 条；连错误都不是的噪声 = 549 条（49.7%）。补完后 1105 条仍然全部只能标 `unverified`** —— 这是诚实的数字，没有为了覆盖率编一条失效条件。

**这意味着**：M4 不是"补字段"能解决的——**现有抽取规则（R09）产出的 antipattern 根本不携带 F3 信息**。要真正补上，必须在抽取时（R09）从**原始事件的失败上下文**里机械抓"恢复条件"（例如错误消失的下一次成功命令、`git` 报错后的 `git status` 输出），而不是在 claim 层回填。

## 6 · 边界

- **只读**：真库全程只 `store.list()`；`--apply` 只写 `tmp/t310-copy`（守卫见 `assertCopyTarget`）。
- **不可测**：`scope` 前置条件按"作用域"处理，不计入实质覆盖率（否则 100% 是假数）。
- **未做**：没有改 R09 抽取规则（那是另一刀）；没有把 549 条噪声标 `invalidated`（属归档侧，需人拍板）。
