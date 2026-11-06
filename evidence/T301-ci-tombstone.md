# T301 · 把 tombstone-check 接进 CI

> `[本] 2026-11-06 12:32 +08:00` · 只改 CI 配置；未改任何脚本。
> 产物：`.github/workflows/check.yml`、`tmp/t301-redo.cjs`

## 1 · 现状（改动前）

`.github/workflows/` 下**只有一个** workflow：

```yaml
name: check
on: { pull_request: , push: { branches: [main] } }
jobs:
  rules:                       # ← required check `rules` 就是这个 job
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4  (node 22)
      - run: node --test "test/*.test.mjs"
      - run: node scripts/check.mjs
```

## 2 · 改动（在 `node --test` **之前**插入一步）

```yaml
      # T301：先证明"删掉实现必红"（tombstone 有效），再谈测试通过 —— 顺序不能反。
      # 失败即红（exit ≠ 0）；120s 超时，不许卡死。
      - name: tombstone-check（删掉实现必红）
        run: timeout 120 node scripts/tombstone-check.mjs
      - run: node --test "test/*.test.mjs"
      - run: node scripts/check.mjs
```

结构校验：`steps: 5` · `tombstone 出现在 node --test 之前: true`。

## 3 · 本地按 CI 命令实跑

```
$ timeout 120 node scripts/tombstone-check.mjs
| src/rooms/walk.mjs → test/walk.test.mjs | 有效 | exit 1 |
| src/rooms/claim.mjs → test/claim.test.mjs | 有效 | exit 1 |
| src/rooms/persist.mjs → test/persist.test.mjs | 有效 | exit 1 |
结论：全部有效
exit=0
```

## 4 · tombstone：故意让"测试失效" ⇒ 命令红

造一个**不覆盖 walk 房间**的假测试，用它当该房间的测试：

```
$ node scripts/tombstone-check.mjs --pair "src/rooms/walk.mjs::tmp/t301-fake.test.mjs"
| src/rooms/walk.mjs → tmp/t301-fake.test.mjs | **无效（测试没覆盖）** | exit 0 · still-green |
结论：存在无效 tombstone
exit=1
```

⇒ CI 里这一步会**红**（`exit 1` ⇒ 步骤失败 ⇒ job `rules` 失败 ⇒ PR 不能合）。

## 5 · CI 侧验证：**未完成（如实）**

- 最近的 CI 运行（`gh run list`）：`42162349385`（main，success）、`42162133917` / `42162090721`（PR `feat/tombstone-check`）；
- 拉日志确认：**这些运行里没有 tombstone 步骤** ——
  ```
  $ gh run view 42162349385 --log | grep -i tombstone
  （只有 node --test 的输出，无 tombstone）
  ```
  因为它们跑的是 T300 提交（`f609f51`），**我的 workflow 改动还没提交/推送**（`git status` 显示 `M .github/workflows/check.yml`）。
- 我是子代理，团队工作树禁止 commit/push（由 Lead 提交）。⇒ **"CI 里真的跑起来"这一环我没有验证**，不能假装接上。

## 6 · 一句话

**接线完成（本地按 CI 命令跑通、失效会红），但 CI 实跑未验证** —— 需要 Lead 提交 `.github/workflows/check.yml` 后，下一次 PR 的 `rules` 日志里应看到 `tombstone-check（删掉实现必红）` 这一段。
