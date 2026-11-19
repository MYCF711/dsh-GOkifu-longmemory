# T159 · 真 stale 的 claim 已按裁定标掉（101 条），并在一次归档后仍在

> 2026-11-19 · 主人裁定「按你推荐」⇒ 执行 `mark-stale.mjs --apply`。

## 一、执行结果

```
写入：mark 101 · revert 0 · 实际写 101 · 未变 0 · manifest 已更新
verify：OK
耗时：25682 ms
```

写入后的字段（抽样）：

```json
{ "id": "c-04607d4c", "state": "stale", "from": "observed",
  "reason": "version-mismatch", "by": "mark-stale/v1" }
```

## 二、归档后仍在（T159b 的验收点）

```
claims 3977 · 仍标 stale 101
```

即 `carryStaleMarking` 生效：`state` 与 `stale*` 六个字段被原样保留，没有被重算冲掉。

## 三、⚠ 本轮发现的新问题：**`archive.mjs` 跑不完**

```
timeout 900 node scripts/archive.mjs → exit 124（被 900 秒超时杀掉）
```

归档在 15 分钟内没有结束。当前库规模：`episodes 4377 / links 26346 / claims 3977`。

这条**不是本轮改动引入的**（本轮只写 101 个字段），但它是个真实问题：
归档慢于 15 分钟意味着任何依赖归档的流程（stale 保留、bundle 刷新、覆盖率复算）都跑不完整。
已单独记一行待查（见 `计划表.md`）。

## 四、结论

- T159 **完成**：101 条真 stale 已标、归档后仍在。
- T159b **验收通过**：字段保留生效。
- 新增待查项：归档耗时 > 15 分钟（规模 4377 局）。
