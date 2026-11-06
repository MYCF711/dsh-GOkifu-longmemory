# T323 · 抽取加 A1 门（只有"真失败"才进 antipattern）

> `[本] 2026-11-06T08:34:59.079Z` · **只读**（不写库）· 未跑全量测试、未重启 DSH。
> 判据 = T311b 的行级定位（**同一套**，`scripts/extract-recovery.mjs` 的 `failureLineOf`，不复制第二份）。

## 0 · 一句话

**加 A1 门后排除 594 / 1105 条（53.76%）**；剩下的 511 条里还有 少量需要人工看（见 §3）。

## 1 · 前后对照

```
加门前：antipattern 1105 条，其中"连错误都不是"49.70%（T310 实测）
加门后：过门 511 条（46.24%）· 排除 594 条（53.76%）
```

## 2 · 被排除的样本（前 10）

- `c-008c3e04` "[notice] A new release of pip is available: 26.2.1 -> 26.2.2 [notice] To update,"
- `c-00f68083` "✗ C172 「2 分钟总览」必须与 CHANGELOG / HANDOFF / live-folds.json 同步（此前无人守） ✗ C305 进度页现状摘"
- `c-0153220d` "11: * 1. `worldstate.touch(paths)` 收到的是**单个路径字符串**（engine 的 `st.touchPath`）， 30:"
- `c-019a52a3` "ok verify: OK · 文件 1281 · 字节 1950576 · 错误 0 · 告警 0 rebuild: FAIL · 派生变更 0 · 未变 0"
- `c-01f27abe` "/usr/bin/bash: line 1: cd: /d/DeepSeek Harness/Desktop/resources/app.asar/dsh: N"
- `c-01f39877` "src/ui.mjs === 价格常量 === [exit code: 1]"
- `c-021f74a1` "OK docs/WORKER.md OK docs/cold-start.md OK docs/execution-review.md"
- `c-024b2bda` "5:// ① **按账号隔离**：同一个站点可以登多个账号（magpie 里就是 `magicrew` / 13:// · 两槽都空时从 magpie 存的凭据"
- `c-026275cd` "文档一致性通过：MAINTENANCE / AGENTS / CHANGELOG 的版本与测试条数一致。 自测通过：故意不一致时检查器会报错。 ✖ 对齐场景 e"
- `c-0297c19b` "--- FAIL: TestDshSpeedAcceptsAndSkipsWithoutBilling (0.25s) dsh_speed_ingest_tes"

## 3 · 过门的样本（前 10）

- `c-00248579`（error-line）"Error: unknown job bash-49fb11d400eb4696"
- `c-00a2178a`（error-line）"Error: writing under C:/Windows/Fonts/msyh.ttc would destroy the running runtime"
- `c-01b1ecf1`（error-line）"Error: ENOENT: no such file or directory, open 'D:\\tmp\\magpie-plugins-after-waf."
- `c-01c643fc`（error-line）"SyntaxError: Illegal return statement at checkSyntax (node:internal/main/check_s"
- `c-0278a298`（error-line）"Error: glob search failed (exit 2): rg: /d/DeepSeek Harness/default-workspace/tm"
- `c-03a237c3`（error-line）"TypeError: cs.slice is not a function at Socket.<anonymous> ([eval]:1:137) at So"
- `c-03b8df2a`（error-line）"Error: EISDIR: illegal operation on a directory, read at Object.readSync (node:f"
- `c-03d6ac4c`（error-line）"SyntaxError: invalid syntax. Perhaps you forgot a comma? [exit code: 1]"
- `c-03fba890`（error-line）"FileNotFoundError: [Errno 2] No such file or directory: '/c/Users/Administrator/"
- `c-0402805c`（error-line）"SyntaxError: Unexpected end of input at checkSyntax (node:internal/main/check_sy"

