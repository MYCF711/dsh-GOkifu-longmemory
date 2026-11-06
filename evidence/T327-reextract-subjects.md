# T327 · 重跑抽取：E1 主体 / E3 命令写进 quote（知识库 75）

> `[本] 2026-11-06T09:08:38.425Z` · **只读**（不写库）· 未跑全量测试、未重启 DSH。
> 结论口径：**原件里有就补上；原件里没有的还是 observed（不编）**。

## 0 · 一句话

**X3 覆盖率 54.60% → 58.90%**：232 条 observed 里 **22 条原件确实有目标字段（真修复）**，**210 条原件里也没有（永久损失，不硬补）**。

## 1 · 汇总

```
antipattern 1105 · 过 A1 门 511 · observed 232
可修（原件有 E1 主体）22 · 永久损失 210
X3 54.60% → 58.90%
```

## 2 · 可修样本（前 10，带 E1/E3）

- `c-179b17ac`（ep-1e82afca seq 45978）→ **file**: `/preflight.mjs`
- `c-1cffde92`（ep-bde12afa seq 3659）→ **file**: `/model-switch-ledger-v2-results.js`
- `c-224f4c25`（ep-dcc6efd2 seq 489）→ **file**: `/tmp/ai-coding-free-20261105/batch-a.md`
- `c-2c640ecc`（ep-bde12afa seq 3506）→ **file**: `/dsh-upgrade-0.2.2-rc.1/final-review.md`
- `c-2caad58a`（ep-dcc6efd2 seq 489）→ **file**: `/tmp/ai-coding-free-20261105/batch-a.md`
- `c-2d4fdcf7`（ep-1cf2b33f seq 994）→ **file**: `/gateway/reasoning_uncounted_test.go`
- `c-33c32461`（ep-1e82afca seq 47065）→ **file**: `/kb/repo-permissions.md`
- `c-46e1ab79`（ep-dcc6efd2 seq 489）→ **file**: `/tmp/ai-coding-free-20261105/batch-a.md`
- `c-4df0df59`（ep-c0a5847a seq 27531）→ **file**: `/real-home-e2e.py`
- `c-6650f925`（ep-dcc6efd2 seq 489）→ **file**: `/tmp/ai-coding-free-20261105/batch-a.md`

## 3 · 永久损失样本（前 10，原件里也没有）

- `c-00248579`（ep-c0a5847a seq 50332）"Error: unknown job bash-49fb11d400eb4696"
- `c-00a2178a`（ep-bc4ab3cb seq 819）"Error: writing under C:/Windows/Fonts/msyh.ttc would destroy the running runtime or this p"
- `c-01c643fc`（ep-00b50089 seq 9006）"SyntaxError: Illegal return statement at checkSyntax (node:internal/main/check_syntax:72:5"
- `c-0278a298`（ep-bde12afa seq 3284）"Error: glob search failed (exit 2): rg: /d/DeepSeek Harness/default-workspace/tmp/dsh-upgr"
- `c-03a237c3`（ep-bc4ab3cb seq 635）"TypeError: cs.slice is not a function at Socket.<anonymous> ([eval]:1:137) at Socket.emit "
- `c-03d6ac4c`（ep-8a73e06b seq 12822）"SyntaxError: invalid syntax. Perhaps you forgot a comma? [exit code: 1]"
- `c-0402805c`（ep-00b50089 seq 8914）"SyntaxError: Unexpected end of input at checkSyntax (node:internal/main/check_syntax:72:5)"
- `c-04ac6d5a`（ep-1e82afca seq 9464）"Error: Cannot find module 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\pkg-check"
- `c-06f1474c`（ep-1e82afca seq 13397）"SyntaxError: unterminated string literal (detected at line 4); perhaps you escaped the end"
- `c-0793fd5e`（ep-8cc34e32 seq 25112）"AssertionError: scanPrivacy 头部没找到"

