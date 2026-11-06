# T311 · 抽取时机械抓"恢复条件"（F3）

> `[本] 2026-11-06T06:20:04.042Z` · **只读**（不写库）· 未跑全量测试、未重启 DSH。
> 判据：只在**同一局的后续事件**里找"错误消失"的证据；抓不到 ⇒ `unverified`（不编）。

## 0 · 一句话

**187 / 4699 条失败能机械地找到恢复条件（3.98%），其余 4512 条标 `unverified`。**

## 1 · 汇总

```
扫描 80 局 · 失败 4699 条 · 抓到 187 · unverified 4512
```

## 2 · 逐字对照（3 条）

### 1. `ep-00b50089` seq 561 → 恢复 @2282（same-subject-exit-0）

失败原文：
```
Error: cannot modify "/d/主工作区/repos/dsh-GOkifu-compact/src/engine.mjs": file has not been read — read the file, then retry
```
恢复事件：
```
bash-ab69f743907d421b
session-00b50089-b7a1-4a5a-8d3f-c5775a7329a0
bash
grep -c "measureFoldQuality" "/d/主工作区/tmp/dsh-gokifu-compact/modules/src/engine.mjs" 2>/dev/null; ls -la --time-style=+%H:%M:%S 
```

### 2. `ep-00b50089` seq 563 → 恢复 @2282（same-subject-exit-0）

失败原文：
```
Error: cannot modify "/d/主工作区/repos/dsh-GOkifu-compact/src/engine.mjs": file has not been read — read the file, then retry
```
恢复事件：
```
bash-ab69f743907d421b
session-00b50089-b7a1-4a5a-8d3f-c5775a7329a0
bash
grep -c "measureFoldQuality" "/d/主工作区/tmp/dsh-gokifu-compact/modules/src/engine.mjs" 2>/dev/null; ls -la --time-style=+%H:%M:%S 
```

### 3. `ep-00b50089` seq 855 → 恢复 @7893（same-subject-exit-0）

失败原文：
```
Error: cannot modify "/d/主工作区/repos/dsh-GOkifu-compact/test/engine-harness.test.mjs": file has not been read — read the file, then retry
```
恢复事件：
```
tool
tool
call_e9477549b4764bc79ab375ae
call_e9477549b4764bc79ab375ae
text
CHANGELOG ok
HANDOFF ok
contract row 14 added
evidence README ok
✅ 未索引文档 0 个
    at tests.P2-2-4 doctor：显示最近 5 次 fold；旧图缺
```

## 3 · unverified 长什么样

- `ep-00b50089` seq 180："Error: DeepSeek returned no web_search_tool_result blocks; the request may not h"
- `ep-00b50089` seq 1087："Error: cannot modify \"/d/主工作区/repos/dsh-GOkifu-compact/test/ledger-boundary.test"
- `ep-00b50089` seq 1225："ReferenceError: oneLine is not defined"


## 5 · T311b 修订（行级定位 + 同主体恢复）

| 项 | T311（旧） | T311b（新） |
|---|---|---|
| 失败识别 | `classifyFailureText(整条事件文本)` | **行级**：只认行首 `Error:`/`XxxError:`/`Exception:` 或独占一行的非零 `[exit code: N]` |
| 恢复判据 | 后续 40 条内任意 `exit 0`/测试通过/构建成功 | **必须含同一路径/同一命令主体 + `exit 0`**；无主体 ⇒ 一律 `unverified` |
| 覆盖率 | 93.71%（虚高） | **3.98%（187 / 4699）** |

§2 的逐字对照已换成真失败 → 真恢复（`Error: cannot modify "…/engine.mjs"` → 同文件 `grep` 且 `exit code: 0`）。

**降下来的 89.73 个百分点就是原来的水分。**
