# T343 · F3「可反驳」的文本派生 —— 恢复证据不行（2.61%），错误文本行（43.35%）

> `[本] 2026-11-06` · 两条死路已量化排除，正路已实现并配 tombstone。
> 复算：`node tmp/f3-feasible3.mjs`（恢复证据）、`node tmp/f3-rules2.mjs`（文本派生）。

## 0 · 一句话

**给 antipattern 补 F3（"什么情况算我错"），从「会话里有没有恢复证据」推只有 2.61%；
改从「错误文本本身」机械派生，同一真库到 43.35%（561/1294）。**

## 1 · 三条路的实测（同一真库）

| 来源 | 覆盖率 | 为什么 |
|---|---|---|
| **字段派生**（T310，`antipattern-falsifiable.mjs`） | **0%**（0/1105） | 只有 `scope` 前置（"在哪适用"），没有实质失效条件；字段里本就没这个信息，回填 = 拿现在的库编过去 |
| **会话恢复证据**（T311/T339 的 `findRecovery`/`findCommandRecovery`） | **2.61%（4/153）** | 只见 `support[0]` 时 0.77%（1/130）；查全部 support 也只 2.61%。**根因是结构性的**：antipattern 恰恰是「当场没修好」的错误类，恢复证据天然不存在 |
| **错误文本派生**（本刀） | **43.35%（561/1294）** | 错误文本自己就写着"什么情况算对"（"Cannot find module X" ⇒ 当 X 可加载时；`exit code: 1` ⇒ 当返回 0 时），机械可判 |

> 副产物结论：**「恢复过」与「值得记」在此语料里是负相关的** —— 一次就修好的错误通常不进 antipattern；
> 进 antipattern 的多是没修好的。所以拿恢复当 F3 的来源，方向本身就错。

## 2 · 规则表（`src/rooms/extract.mjs` 的 `FALSIFIABLE_RULES`，20 条，可审计）

| 规则 id | 触发 | 派生的「算我错」条件 |
|---|---|---|
| `missing-module` | `Cannot find module X` | 当模块 X 可被加载时不再成立 |
| `enoent` / `no-such-file` | `ENOENT ... X` / `no such file or directory` | 当路径/文件 X 存在时不再成立 |
| `cmd-not-found` | `command not found` / `Executable not found in $PATH` | 当该命令在 PATH 中可执行时不再成立 |
| `permission` | `permission denied` / `EACCES` / `EPERM` | 当所需权限可用时不再成立 |
| `econnrefused` / `eaddrinuse` / `timeout` | 对应错误码 | 当服务在监听 / 端口空闲 / 在时限内完成时 |
| `syntax-error` / `type-error` / `not-a-function` / `undefined-prop` | 对应错误 | 当源码合法 / 类型满足 / 是函数 / 对象非空时 |
| `http-404` / `http-auth` | `HTTP 404`、`status: 404`、`E404`、`Unauthorized`… | 当资源可访问（2xx）/ 授权有效时 |
| `json-parse` / `already-exists` / `git-fatal` | 对应错误 | 当输入合法 JSON / 目标不存在 / git 前置状态满足时 |
| `tests-fail` | `failing tests:` / `ℹ fail N` / `✖ N test` | 当同一测试通过时不再成立 |
| `exit-nonzero` | `[exit code: N]`（N≠0） | 当同一命令返回 0（而非 N）时不再成立 |
| `generic-not-found` | `not found`（泛化） | 当该对象/资源存在时不再成立 |

**顺序敏感**：更具体的规则排在更泛的之前（`http-404` 先于 `generic-not-found`），防止把强条件降级成弱条件。

## 3 · 契约与边界

- 产出形如 `{kind:'text-pattern', rule, when, quote}`，**`kind` 明确标注「由文本派生」**，
  **不冒充「观测到恢复」**（后者是 T339 的 `same-command-success`，两者不可混为一谈）。
- **判不出 ⇒ `null`，claim 不挂该字段**（不编）；不带该字段的 claim 输出**与旧版逐字节一致**。
- **只增不改**：已有 claim 不回填、不改写；只对**新归档**生效。
- 只作用于**失败边**（antipattern 来源）；成功边与 unsettled 不挂。

## 4 · 测试（`test/f3-text-derivation.test.mjs`，7 条）

| # | 断言 |
|---|---|
| ① | 9 类错误文本 → 正确规则 id + `kind:'text-pattern'` + quote 是原文子串 |
| ② | 噪声（`=== 方案 1 ===`、目录转储、空值）⇒ `null`（**不编**；删规则表则 ①② 红） |
| ③ | 顺序敏感：`HTTP 404` 走 `http-404`、泛化 `not found` 走 `generic-not-found`；规则 id 唯一 |
| ④ | `extractSignals`：失败边带 `falsifiableWhen`，成功边不带（删接线则红） |
| ⑤ | `promoteClaim`：F3 随失败支撑带到 antipattern claim |
| ⑥ | 派生不出条件的失败 ⇒ claim **不带**该字段（不编） |
| ⑦ | 只补空不覆盖：先无 F3、后有 F3 ⇒ 补上；已有 ⇒ 不改写 |

全量：**1024 条 / 1018 pass / 0 fail**；`node scripts/check.mjs` PASS。

## 5 · 未做（如实）

- **渲染未接**：注入卡片暂不展示 `when`（字段已入库，下一刀决定是否上卡、如何过边界五问）。
- **历史 1294 条不回填**（只增不改），其 F3 覆盖率仍按旧口径计。
- 剩余 56.65% 未覆盖多为噪声（pip 通知、目录转储、非错误正文），属**正确的不覆盖**。
