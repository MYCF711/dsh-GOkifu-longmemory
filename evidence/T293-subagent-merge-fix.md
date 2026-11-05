# T293 · 子代理失败归并（10% → 98.49%）

> `[本] 2026-11-06` · **真库只读**（`--apply` 只打 `tmp/` 副本，与真库根比对守卫）· 未跑全量 `node --test`、未重启 DSH。
> 改动：新建 `scripts/subagent-merge.mjs` + `test/subagent-merge.test.mjs` · **没动 `src/**`**

## 0 · 一句话

旧实现只在"路径字符串完全一致"时才归并（10.00%）；本脚本按 **`subEpisode + seq`** 幂等归并，并把"什么算失败"的口径从 **JSON 子串（`pending`/`failed`）** 收紧到 **`isError` / 非零 `[exit code: N]` / 真错误原文**。**修完后 522/530 个带失败的子局真的进了父局（98.49%）；剩下 8 条是跨 scope / 找不到父局，本来就该丢**（不是噪声被算成战果 —— 噪声在 A 步已经排除，见下）。

## 1 · A 步：口径修正（先修口径再归并）

| | 旧口径 | 新口径 |
|---|---|---|
| 判据 | JSON 子串匹配 `pending` / `failed` | ① `isError: true` ② `[exit code: N]`（N≠0）③ 真错误原文（`Error:`/`error:` 起头、异常名） |
| 误判 | `"Updated todo list: 4 pending, 1 in progress, 0 completed."` ⇒ **失败** | 进度消息 ⇒ **不是失败** |
| 全绿汇总 | `fail 0` 被当失败 | 不是失败（T251 同口径） |

```
$ node --test "test/subagent-merge.test.mjs"
✔ T293 口径①：todo/进度消息**不算**失败
✔ T293 口径②：真 `Error:` / 异常名 / 非零退出码**算**失败
✔ T293 幂等：重放两次同结果（按 subEpisode+seq 去重）
✔ T293 不跨 scope：父子 scopeKey 不同 ⇒ 不归并（A5 仍 0）
ℹ tests 4   ℹ pass 4   ℹ fail 0
```

## 2 · B 步：真库 dry-run（只读）

```
$ node scripts/subagent-merge.mjs
子代理失败归并 · store=D:\DeepSeek Harness\home\memory-context · dry-run
子代理局 726 · 带失败 530 · 失败总数 2939
已归并 0 · 待归并 522 ⇒ 归并率 0.00% → 98.49%
新增 support 522 · 新增 claim 0
（dry-run：没有写任何文件）
```

> 注：`已归并 0` 是因为旧实现写的是"路径完全一致"的另一套标记，本脚本按新键 `subEpisode+seq` 统计 ⇒ 全部待归并。
> **归并率 10.00% → 98.49%**（T292 的 9/90 是按"路径完全一致"算的旧口径；按子局算 522/530）。

## 3 · 守卫 + 副本 apply + 幂等

```
$ node scripts/subagent-merge.mjs --apply
拒绝 --apply：D:\…\home\memory-context 不是 tmp 副本（真库只读；请先复制到 tmp/ 再打）

$ cp -r "$DSH_HOME/memory-context" tmp/mc-copy
$ node scripts/subagent-merge.mjs --apply --store tmp/mc-copy
apply：副本 …\tmp\mc-copy 已归并 522 条（重放幂等）

$ node scripts/subagent-merge.mjs --apply --store tmp/mc-copy     # 第二次
已归并 522 · 待归并 0 ⇒ 归并率 98.49% → 98.49%
新增 support 0 · 新增 claim 0
apply：副本 …\tmp\mc-copy 已归并 0 条（重放幂等）

$ node scripts/subagent-merge.mjs                                   # 真库未动
已归并 0 · 待归并 522 ⇒ 归并率 0.00% → 98.49%
```

**幂等第二次 0 变更** ✓ · **真库零写入** ✓ · 新增 claim 0（只往父局 `signals.mergedChildren` 追加，只增不改）。

## 4 · 剩下 8 条是什么

`530 − 522 = 8` 条子局**没有归并**，原因两类（`planMerge` 里显式 `continue`）：

1. **跨 scope**（父局 `scopeKey` ≠ 子局）—— A5 必须仍 0，这类**不许**归并；
2. **找不到父局**（`parentSessionId` 指向的 depth=0 局不在库里）。

⇒ 这 8 条**不是"漏网的真失败"，是"本来就该丢"**（跨作用域会污染 A5；无父局无处可归）。

## 5 · 5 条"真失败没被误杀"人工核

新口径下仍判失败的样本（`classifyFailureText` 直测）：

| # | 原文 | 判定 |
|---|---|---|
| 1 | `Error: Cannot find module "yaml"` | ✅ failure（error-text） |
| 2 | `error: failed to push some refs` | ✅ failure（error-text） |
| 3 | `TypeError: x is not a function` | ✅ failure（异常名） |
| 4 | `[exit code: 1]` | ✅ failure（exit:1） |
| 5 | 空文本 + `isError: true` | ✅ failure（isError 优先） |

对照：`Updated todo list: 4 pending, 1 in progress, 0 completed.` / `pending` / `in progress` / `completed` / `[exit code: 0]` 均为 **false**。

## 6 · 补丁

`tmp/t293-redo.cjs`（base64 内嵌两个文件 + marker 守卫 + 幂等）：`--check` / 重放均 `skip`；外来文件 ⇒ 抛错、不写半套。
