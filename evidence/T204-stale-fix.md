# T204 · `findStaleTargets` 字段名缺陷修复

> `[本] 2026-11-05 10:30 +08:00` · 只读真库（dry-run），`--apply` 只打在 `tmp/t201-copy` 副本上。

## 1 · 根因（一行）

`scripts/apply-store-changes.mjs` 的 `findStaleTargets` 用 `verdict.ok !== false` 过滤，
而 `classifyClaim` 返回的是 `{ action, reason, detail, why }` —— **没有 `ok` 字段**
⇒ `verdict.ok` 恒 `undefined` ⇒ `undefined !== false` 恒真 ⇒ **每条都 `continue`** ⇒ 恒返回 0 条。

## 2 · 改动

| 文件 | 改了什么 |
|---|---|
| `scripts/apply-store-changes.mjs` | `findStaleTargets` 的判据：`verdict.ok !== false` → **`verdict.action !== 'mark'`**（注释里写明字段来源，防再猜）；删掉重复猜 `record.state === 'invalidated' / 'superseded'` 的预过滤（作废态由 `classifyClaim` 的 `INACTIVE_STATES` 统一判）；`findStaleTargets` 增加顶层 `workspace` 参数（原来只能塞在 `deps` 里，直接调用会静默回落到 cwd） |
| `test/apply-store-changes.test.mjs` | **删掉 `fakeFindStale` 桩**，换成真 `classifyClaim` + 真 shim 探针的端到端（三条 claim：`version-mismatch` / `file-appeared` / `fresh`），并新增回归断言"不许再恒返回 0 条" |

`REAL_STALE_REASONS` 常量保留为**口径说明**（29 = 9 + 20），不再参与过滤 —— 判据只有一个：`action === 'mark'`。

## 3 · 验收读数

### 真库 dry-run（一个字节都没写）
```
$ node scripts/apply-store-changes.mjs --stale --expect 29
库：D:\DeepSeek Harness\home\memory-context
模式：dry-run（不写任何文件）
stale：扫描 1379 条 · 已是 stale 0 · 真 stale 29（version-mismatch 9 · file-appeared 20）· 写入 0
verify：OK · 11934 条记录
耗时 4607 ms · 退出码 0
```
⇒ `--expect 29` **通过预检**（29 === 29），与 T203 的 A 口径、B1 口径完全同集合。

### 副本 `--apply`（第一次）
```
备份：...\tmp\t204-backup · 校验 OK · 19.80 MiB / 11937 文件
stale：扫描 1379 条 · 已是 stale 0 · 真 stale 29（version-mismatch 9 · file-appeared 20）· 写入 29
verify：OK · 11934 条记录 · 退出码 0
```

### 副本 `--apply`（第二次 · 幂等）
```
备份：...\tmp\t204-backup2 · 校验 OK · 19.81 MiB / 11937 文件
stale：扫描 1379 条 · 已是 stale 29 · 真 stale 0（）· 写入 0
verify：OK · 11934 条记录 · 退出码 0
```

### 测试
```
$ node --test "test/apply-store-changes.test.mjs"
ℹ tests 6   ℹ pass 6   ℹ fail 0   ℹ duration_ms 624.1
```

## 4 · 回滚

真库/副本若要退：
```bash
node scripts/consolidate-backup.mjs --restore "<备份目录>" --target "<库目录>"
```

## 5 · 可重放补丁

```bash
node tmp/t204-redo.cjs          # 幂等；anchor 不匹配抛错
node tmp/t204-redo.cjs --check  # 只报告
```
