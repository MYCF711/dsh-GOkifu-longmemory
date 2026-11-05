# T201 · 写库执行包（一页执行单）

> `[本] 2026-11-05 10:20 +08:00` · 产物：`scripts/apply-store-changes.mjs` + `tmp/apply-store.sh|ps1` + `tmp/t201-redo.cjs`
> **没有写真库**（只在副本 `tmp/t201-copy` 上跑过）。dry-run 是默认行为。

## 1 · 主人要复制粘贴的那一条

```bash
bash "D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/apply-store.sh" --apply
```

（PowerShell 等价：`pwsh -File "D:\DeepSeek Harness\default-workspace\长期记忆系统\tmp\apply-store.ps1" -Apply`）

脚本自己会：**预检（库可读 / manifest 校验 / 磁盘余量 ≥ 库大小×3）→ 备份并校验 → 标记 → 合流 → 验收 → 打印摘要与回滚命令**。
失败即停、退出码非 0；**不重启 DSH、不 taskkill**。

## 2 · 预期输出（副本上实跑的原文）

```
库：...\tmp\t201-copy
模式：apply
备份：...\tmp\t201-backup2 · 校验 OK · 38.22 MiB / 11902 文件
合流：OK · 新增合并节点 39 · 镜像一致 是
verify：OK · 11934 条记录
耗时 141243 ms · 退出码 0
```

四条闸门（`merge-acceptance`，源=换库前的快照，影=换后的库）：

```
| ① | 同文重复行（逐组配对） | 反例 0 张卡 | 逐组配对反例 = 0 |
| ② | 合并契约（成员可解析 + 闸 4） | 不可解析成员 0 / 96 个（39 组）· 闸 4 错误 0 | 两者都必须 0 |
| ③ | 跨作用域 | 0 张卡非零 | 必须 0 |
| ④a | 不许变差 | 反增 0 组 / 6 组 · 载荷缩水 0 行 | 必须 0 |
| ④b | 不许丢内容（按 claimId 对齐） | 丢行 0 行 / 0 组 | lostRows = 0 |
| ④c | 参考 | 可折 1 · 省行 1/1 · Wilson [20.7%, 100.0%] | 只展示（证据不足） |
结论：通过（① ok · ② ok · ③ ok · ④a ok · ④b ok）
```

## 3 · ⚠ 与任务书不一致的一处（必须知道）

任务书的前提是"**29 条真 stale**"。在副本上用当前实现跑出来是 **0 条**：

```
stale：扫描 1340 条 · 已是 stale 0 · 真 stale 0（）：写入 0
```

原因：T166 那 29 条是在 `stale-pass` 的**副本 dataRoot** 语境下算出来的（`file-appeared` / `version-mismatch` 取决于 `workspace` 指向哪棵树）。
我按 `scopeKey` 推出每个 claim 自己的 workspace 复算，仍是 0 条 —— 说明这 29 条**依赖 stale-pass 的副本语义**，不是当前库的静态属性。
**处置：不猜、不硬凑。** 脚本提供 `--workspace <dir>` 与 `--expect <n>` 两个闸口：
写库时若 `--expect 29` 而实际不是 29 条，**直接拒绝写入并退出 1**（fail-closed）。
要不要改成"用 stale-pass 的 dataRoot 语义重算"，请主人/Lead 拍板。

## 4 · 回滚（一条）

脚本输出里会打印本次备份目录；回滚就是：

```bash
node scripts/consolidate-backup.mjs --restore "<备份目录>" --target "<你的库目录>"
```

## 5 · 失败时会发生什么（"库不会被部分修改"的判据）

- **备份失败或备份校验不通过** ⇒ 立即退出，**一个字节都不写**（测试 T201 ② 覆盖：库哈希逐字节不变）。
- **标记/合流/自检任一步抛错** ⇒ 立即停，打印回滚命令，退出码 1（测试 T201 ④ 覆盖）。
- **合流**走 `consolidate-apply --all` 写**影子库** → 影子库 `verify` 通过后才 `rename` 换库（旧库保留为 `<库>.pre-T201`）；换库后 `verify` 失败同样打印回滚。
- **dry-run（默认）**：只读预览，测试 T201 ① 断言"库哈希不变"。
- **幂等**：连跑两次，第二次 `真 stale 0 / 写入 0`，库哈希不变（测试 T201 ③）。

## 6 · 可重放补丁

`node tmp/t201-redo.cjs` —— 把今晚改动的 9 个文件按内容哈希重放；已是目标状态则 `changed=0`（幂等），
写入后校验锚点，**锚点不匹配直接抛错**。`--check` 只报告不写。
