# T166 · 重归档 → 标 stale → 再归档验证（副本演练）

> 生成：`node scripts/stale-pass.mjs --store <srcStore> --work <copyDir> --evidence evidence/T166-stale-pass.md`
> 运行时刻：2026-11-04T18:33:24.178Z（UTC；epoch ms 1793817204178）· 版本 stale-pass v1 · 总耗时 378.0 s

## 1 · 口径

| 项 | 定义 |
|---|---|
| 副本 | `--work` 下的源库**拷贝**；源库全程只读（除 `--apply --yes`） |
| 三步 | ① `archive` 重归档 → ② `mark-stale --apply` 标真 stale → ③ 再 `archive` |
| 标记数 | 第 ② 步实际写入的降级标记（`staleMarkedBy` 非空）条数 |
| 存活数 | 第 ③ 步归档之后，库里仍带 `staleMarkedBy` 且 `state === 'stale'` 的条数 |
| 存活率 | 存活数 ÷ 标记数（标记数为 0 ⇒ `null`，不写 0） |

## 2 · 结果

| 库 | claims | 标记数 | 存活数 | 存活率 | 耗时 |
|---|---|---|---|---|---|
| 副本 | 1340 | 29 | 29 | **100.00%** | 362.3 s |
| 源库 | - | - | - | - | 未执行（缺 `--yes` 或未 `--apply`） |

- 复制：11838 个文件 / 36.87 MiB / 15.7 s
- 副本三步：归档 204.3 s（episodes 595 / claims 1339）· 标记 13.3 s（29 条：`version-mismatch` 9 · `file-appeared` 20）· 再归档 144.3 s
- verify：归档① OK · 标记 OK · 归档② OK
- 存活：**29 / 29**（100.00%）

## 3 · 复现

```bash
cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"
node scripts/stale-pass.mjs --store "$DSH_HOME/memory-context" --work tmp/t166-copy          # 只读演练
node scripts/stale-pass.mjs --store "$DSH_HOME/memory-context" --work tmp/t166-copy --apply # 打印将写内容，需 --yes
node --test test/stale-pass.test.mjs
```

## 4 · 风险与边界

1. **默认不碰源库**：只有 `--apply --yes` 才写；`--apply` 单独跑会在打印"将写 claims N 条 + 重写 manifest"后以退出码 2 结束，零写入。
2. **副本安全**：`--work` 必须是绝对路径、不能是盘根/家目录、不能等于或位于源库内；已存在的副本必须"看起来像库"（manifest.json 或 episodes/）才允许清空。
3. **活语料下"再归档写入数"不会是 0**：两次归档之间会话仍在追加事件，claim 的 support/counters 会被重算——这是设计如此；**存活率**才是本脚本的判据（冻结语料下归档两次 0 重写由 `test/archive-stale.test.mjs` 证明）。
4. **耗时**主要在两遍归档（真实语料每遍约 2–3 分钟）；副本复制 15 MiB 级库约 1 秒。
5. 本脚本**只做编排**，不改 `archive.mjs` / `mark-stale.mjs` 的行为；标记的语义与回退方式见 `scripts/mark-stale.mjs` 的 `--revert --apply`。
