# 台账自证 `scripts/ledger-check.mjs`（2026-11-02）

## 为什么
audit-01 与 audit-02 **两轮都栽在同一件事**：`MAINTENANCE.md`/`CHANGELOG.md` 里写的数字与被测代码不一致
（A2/claim/卷数过期、`validFrom` 未落地、26 条 null 的解释是编的）。靠"我记得更新"不可靠，把它机械化。

## 做什么
解析台账里的四类数字并与实测比对，不一致退出 1：
| 项 | 台账来源 | 实测来源 |
|---|---|---|
| 版本 | `main = X.Y.Z` | `package.json` |
| 测试 | `**N 条**（P pass / F fail / S skip）` | `node --test` 的 `ℹ tests/pass/fail/skipped` |
| claim | `claim N` | `cli audit --json` |
| 卷 | `**N 卷**` | `cli audit --json` |

另外校验：`AGENTS.md` §7 仍是指针且不含"条测试"；`CHANGELOG.md` 有当前版本段。
没有 store 时跳过语料项并**显式标注**（不当成通过）。

## 接进发布流程
`scripts/release.mjs` 在打 tag 前调用 **`ledger-check --full`**；不一致直接中止。
（0.61.0 起：旧的跳过测试口径与逃生门都已删除，`--full` 是唯一口径。）
这样"台账写错"会挡住发版，而不是等审计发现。

## 实测
```
ledger-check：台账 0.59.0 · 测试 389/385/0/4 · claim 322 · 卷 143
实测：版本 0.59.0 · 测试 389/385/0/4 · claim 322 · 卷 143
ledger-check: PASS
```

## 测试
4 条单测：解析、完全一致、四项任一不一致都要报、缺字段不误报。
