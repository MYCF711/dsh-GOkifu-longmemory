# T37 · 恢复事实的洞见层（坑类陈述，raw → insight）

> 日期：2026-11-08 · 改动：`src/rooms/inject.mjs`（洞见层 + 文案）、`test/inject.test.mjs`
> 依据：知识库 94（arXiv:2604.27003）第 3 条——raw（命令+退出码）跨任务会负迁移，**insight（坑类陈述）**翻正。

## 0 · 一句话结论

有恢复事实的卡行，**若这条记忆能机械判出坑类**，就在「恢复」后面加一层坑类标注：

```text
 · 恢复（class:fs-read-before-write）：后于 2026-10-20 同一命令成功（exit 0, seq 4）
 · 恢复（同工具族 · class:fs-read-before-write）：后于 2026-10-20 同工具族后来成功（seq 4）
```

坑类从**数据里机械取**（三步，全都不成 ⇒ 不加，不编）；**没有恢复事实的 claim 一个字都不加**（洞见层只加注，不制造恢复事实、不扩大分母）。真库 114 条有恢复事实的 claim 里，**6 条**能标出坑类（5.26%）。

## 1 · 坑类的机械来源（`recoveryInsightClass`，按优先级）

| 优先 | 来源 | 说明 |
|---|---|---|
| ① | `claim.class` / `claim.errorClass` 字段 | 数据里已有就直接用（当前真库 0 条，留作将来） |
| ② | claim 文本的 `class:<slug>` 前缀 | 类级章节 claim 的既有形态（真库 1560 条 antipattern 里 10 条是这种，其中 3 条有恢复事实） |
| ③ | `claim.mjs` 的 `classifyErrorClass`（**闭集 8 类**） | 对 claim 原文机械判定：`fs-read-before-write` / `tool-unavailable` / `policy-human-turn` / `sandbox-limit` / `web-search-empty` / `module-missing` / `permission-denied` / `timeout`；判不出 ⇒ null |

返回值统一 `class:<slug>`；**取不到就不加**（T37 ④ 断言：无坑类的行与 T28/T34 文案**逐字节一致**）。

## 2 · 卡上文案（事实形式，不写祈使句）

| 档位 | 无坑类（现状） | 有坑类（T37） |
|---|---|---|
| exact（同命令 exit 0） | ` · 恢复：后于 <date> 同一命令成功（exit 0, seq N）` | ` · 恢复（class:x）：后于 <date> 同一命令成功（exit 0, seq N）` |
| exact（重跑无失败） | ` · 恢复：后于 <date> 同一命令重跑（无失败输出, seq N）` | ` · 恢复（class:x）：后于 …` |
| same-file | ` · 恢复：后于 <date> 同一文件写入成功（seq N）` | ` · 恢复（class:x）：后于 …` |
| same-tool | ` · 恢复（同工具族）：后于 <date> 同工具族后来成功（seq N）` | ` · 恢复（同工具族 · class:x）：后于 …` |

- 坑类与**档位**同时出现时用 `（同工具族 · class:x）`，两者不混（T37 ③）。
- 坑类只是括号里的标注，**不改**恢复事实本身的判据/证据。

## 3 · 真库统计（`tmp/t37-stats.mjs`，只读）

| 读数 | 值 |
|---|---|
| 有恢复事实的 claim（索引 entries） | **114** |
| 能标出坑类 | **6**（5.26%） |
| 其中来自 `class:` 文本前缀 | 3 |
| 其中来自分类器判定 | 3 |
| 按坑类分布 | `fs-read-before-write` 4 · `module-missing` 1 · `sandbox-limit` 1 |

样例：

```text
c-26ab9c93  Error: cannot modify "/d/主工作区/…"      ⇒ class:fs-read-before-write（分类器）
c-4531a6d0  class:module-missing · Error: Cannot find module '…' ⇒ class:module-missing（前缀）
c-8d599212  Error: cannot write "/d/主工作区/…"       ⇒ class:fs-read-before-write（分类器）
```

**如实**：其余 **108 条（94.7%）** 的恢复事实**没有坑类**（错误原文不在闭集 8 类里，或与前缀无关）⇒ 卡行保持现状。洞见层今天只对 5.26% 的恢复事实生效。

## 4 · tombstone / 边界

- **没有坑类 ⇒ 逐字节不变**（T37 ④：整行与 T28/T34 的字符串完全相等，且不含 `（class:`）。
- **没有恢复事实 ⇒ 连坑类也不出现**（T37 ⑤）：洞见层只加注已有恢复事实，不制造、不改覆盖率分母（符合任务 ④）。
- `class:` 前缀非法/空 ⇒ 不加（`norm` 正则白名单）。
- 分类器判不出 ⇒ null ⇒ 不加（**不编**）。

## 5 · 测试（`test/inject.test.mjs` T37 ①–⑤）

| # | 断言 |
|---|---|
| T37 ① | claim 文本带 `class:fs-read-before-write ·` 前缀 ⇒ 尾注 ` · 恢复（class:fs-read-before-write）：…` |
| T37 ② | 没有前缀、但分类器认得出（`file changed since it was read`）⇒ 同样标坑类 |
| T37 ③ | same-tool + 坑类 ⇒ ` · 恢复（同工具族 · class:…）：… 同工具族后来成功（seq N）` |
| T37 ④ | 没有坑类 ⇒ 卡行与现状**逐字节一致**（整行字符串相等） |
| T37 ⑤ | 没有恢复事实 ⇒ 不出现 `恢复`、也不单独出现坑类 |

## 6 · 验收

- 全量：`node --test "test/*.test.mjs"` —— **1186 tests / 1180 pass / 0 fail / 6 skipped**（exit 0）。
- `node scripts/check.mjs` PASS。

## 7 · 复现

```bash
node --test --test-name-pattern "T37" test/inject.test.mjs
node tmp/t37-stats.mjs     # 真库：有恢复事实的 claim 里多少能标坑类
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- 坑类来源：`class` 字段 → 文本 `class:` 前缀 → `claim.mjs` 分类器（闭集 8 类），都不成 ⇒ **不加**；
- 真库覆盖：**6 / 114 = 5.26%**（prefix 3 + 分类器 3）；其余 94.7% 无坑类、卡行不变；
- 文案：坑类只在「恢复」后的括号里，**不改**恢复事实判据/证据；
- tombstone：无坑类 ⇒ 逐字节一致（T37 ④）；无恢复事实 ⇒ 不加注（T37 ⑤）。

## 8 · 限制 / 风险

1. **覆盖率天然小**：坑类是**闭集 8 类**（仓库既有分类器），大多数错误原文不在里面 ⇒ 94.7% 的恢复事实没有洞见层。提高覆盖要扩分类器（要另立证据，属于改 claim.mjs 的判据）。
2. **分类器是启发式**：`file changed since it was read` 等文本模式命中即归类；可能把"同类文本但不同根因"的坑归到一起——但卡上写的是"这类坑"，不是"同一根因"。
3. **洞见层不改行为**：可见性/排序/闸门都不读 `recoveryClass`，只是渲染层加注。
4. **与 T34 的分工**：T34 管「恢复事实多强（exact/same-file/same-tool）」，T37 管「这条恢复事实属于哪类坑」；两者在同一行里各标各的，不互相替代。
5. 当前真库 **0 条** claim 带 `class` 字段（分类信息只存在于文本前缀与分类器），所以①号来源暂时空转——它是给将来 writer 留的口子，不是编数据的入口。