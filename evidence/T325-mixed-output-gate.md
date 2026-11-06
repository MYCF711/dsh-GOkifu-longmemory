# T325 · 混合输出判据（R2 段内最终结论 + X3 依赖链）

> `[本] 2026-11-06T08:51:01.782Z` · **只读**（不写库）· 未跑全量测试、未重启 DSH。
> 判据来源：知识库 74（R1/R2/R3）+ GNU make 语义（上游成功不抵消下游失败）。

## 0 · 一句话

**过 A1 门的 511 条里，279 条能补上 X3（可复用），232 条补不出 ⇒ 标 `observed` 不进注入（X3 覆盖率 54.60%）。**

## 1 · 汇总

```
antipattern 1105 · 过 A1 门 511
可复用（有 X3）279 · 只能 observed 232
```

## 2 · 可复用样本（前 10，带依赖链）

- `c-01b1ecf1` → `file:D:\tmp\magpie-plugins-after-waf.js`
- `c-03b8df2a` → `file:C:\Users\Administrator\AppData\Local\Temp\asar-tool\read.js`
- `c-03fba890` → `file:/c<user-home>/.config/magpie/routing/2026-11-02.js`
- `c-058b22f6` → `file:9ab64333-2300-42ff-8d4f-2f356e442060`
- `c-05ab0ff2` → `file:http://127.0.0.1:3425/v1/messages`
- `c-09d1cf52` → `file:ab8c56c4-7b18-49f5-99e0-8796775b1fce`
- `c-0b31b85f` → `file:/tmp/wps_usage.js`
- `c-0d291e62` → `file:0271b3e0-6382-4d9d-8d34-7fd938712c12`
- `c-0f3da0a8` → `file:5d5268ba-0796-4b75-a897-25786239141b`
- `c-102bb41e` → `file:/scheduled-review-2026-11-03-1908.md`

## 3 · 只能 observed 的样本（前 10）

- `c-00248579` "Error: unknown job bash-49fb11d400eb4696"
- `c-00a2178a` "Error: writing under C:/Windows/Fonts/msyh.ttc would destroy the running runtime or this p"
- `c-01c643fc` "SyntaxError: Illegal return statement at checkSyntax (node:internal/main/check_syntax:72:5"
- `c-0278a298` "Error: glob search failed (exit 2): rg: /d/DeepSeek Harness/default-workspace/tmp/dsh-upgr"
- `c-03a237c3` "TypeError: cs.slice is not a function at Socket.<anonymous> ([eval]:1:137) at Socket.emit "
- `c-03d6ac4c` "SyntaxError: invalid syntax. Perhaps you forgot a comma? [exit code: 1]"
- `c-0402805c` "SyntaxError: Unexpected end of input at checkSyntax (node:internal/main/check_syntax:72:5)"
- `c-04ac6d5a` "Error: Cannot find module 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\pkg-check"
- `c-06f1474c` "SyntaxError: unterminated string literal (detected at line 4); perhaps you escaped the end"
- `c-0793fd5e` "AssertionError: scanPrivacy 头部没找到"

## 4 · R2 判定说明

按**行内位置**取最后一个结论标记：`ok verify: OK … rebuild: FAIL` ⇒ 失败；`rebuild: FAIL … ok verify` ⇒ 仍失败（FAIL 不因顺序抵消）。无任何结论标记 ⇒ 不是 A1 门放行的形态。

