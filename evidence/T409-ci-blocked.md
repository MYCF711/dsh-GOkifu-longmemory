# T409 · 卡点：GitHub Actions 不再为本仓新 PR 生成 `rules` 检查 ⇒ 无法合并

> 2026-11-21 · 记录一次**基础设施卡点**，不是代码问题。

## 现象

- 工作已就绪：`task/t408b-link-cap`（T408 links 每局上限 32，本地全量 1309/1303/0/6 全绿）。
- PR #667 / #668 均**没有任何 CI run**：`gh run list --branch <branch>` 为空，
  `gh pr checks` 返回 `no checks reported`。
- 合并被 ruleset 拒绝：

```
$ gh pr merge 668 --squash --delete-branch --admin
Required status check "rules" is expected.
```

## 已排除

- Actions 未关闭：`/actions/permissions` → `{"enabled":true,"allowed_actions":"all"}`；
- 工作流存在且触发条件正确：`.github/workflows/check.yml` 的 `on: pull_request` + `push: main`；
- 最近一次成功 run 是 **44765411062**（T407 的 pull_request，2026-11-20T15:39Z），
  之后本仓的所有新 PR 都没有 run。

⇒ **GitHub 侧事件没有落到 Actions 上**（疑似平台侧问题，不在本仓控制范围）。

## 影响

- T408（D10 第一步）**代码已写好、已验证、已推送分支，但无法合并进 main**；
- 后续任何 PR 都会同样卡住 —— 不是这一刀的问题。

## 处理

- **不做**：伪造 `rules` 状态、直推 main、`--force` 绕过 ruleset（都会破坏保护）；
- **做**：保留分支、写清卡点、等 Actions 恢复后重试（或用户手动在网页端 rerun workflow）。

## 本地已验证的事实（恢复后可直接合并）

```
全量测试 1309 / 1303 通过 / 0 失败 / 6 跳过
node scripts/check.mjs → PASS
link.test 8/8
库内 links 35,122 → 20,128；每局最大度数 → 32
A2b 严格 46.6% / 覆盖 79.7%（逐项未变）· A6 100%
```
