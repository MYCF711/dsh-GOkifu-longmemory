# T159 · 真 stale claim 的降级标记（归档侧）

> 生成：`node scripts/mark-stale.mjs --store <store> --evidence evidence/T159-stale-marking.md`
> 运行时刻：2026-11-04T17:46:37.174Z（UTC；epoch ms 1793814397174）· 模式 **dry-run** · 探针 `shim` · 耗时 646 ms

## 1 · 口径

| 项 | 定义 |
|---|---|
| 真 stale | validity 核验失败**且**失败原因是"确实不再成立"（`version-mismatch` / `file-appeared` 等），不是"核不了" |
| 标记 | `state:'stale'` + `staleSince`（首次发现时刻）+ `staleReason` + `staleProbe`（证据）+ `staleFrom`（原状态）+ `staleMarkedBy` |
| 不动 | 正文 / `supersedes` / `support` / `occurredAt` / `validity` 一律不改（只增不改） |
| 不标 | `unverified`（读不到包）、`posix-ambiguous`（`/tmp/x` 老路径）、`already-inactive`（invalidated/superseded） |
| 可逆 | `--revert --apply`：按 `staleFrom` 还原 `state` 并删掉本脚本加的字段 |

## 2 · 结果

- 记忆库：`D:\DeepSeek Harness\home\memory-context`
- claims **1312** · 待标 **15** · 已标 0 · 跳过 1297
- 待标原因：`version-mismatch` 9 · `file-appeared` 6
- 跳过原因：`no-validity` 1174 · `unverified` 58 · `fresh` 63 · `posix-ambiguous` 2
- **dry-run：没有写任何字节**

### 2.1 逐条

| # | action | claimId | reason | 原 state | validity | expected → actual | 正文前 40 字 |
|---|---|---|---|---|---|---|---|
| 1 | mark | `c-072e17c0` | `version-mismatch` | observed | `0.3.73` | 0.3.73 → 1.0.0 | version='0.3.73 |
| 2 | mark | `c-0a7e7ac0` | `version-mismatch` | observed | `dsh-gokifu-compact@1.16.0` | 1.16.0 → 1.17.6 | dsh-gokifu-compact@1.16.0 |
| 3 | mark | `c-3d4243e0` | `version-mismatch` | observed | `dsh-session-superagent@0.8.11` | 0.8.11 → 0.9.179 | dsh-session-superagent@0.8.11 |
| 4 | mark | `c-4225b416` | `version-mismatch` | observed | `dsh-session-superagent@0.8.12` | 0.8.12 → 0.9.179 | dsh-session-superagent@0.8.12 |
| 5 | mark | `c-5ccb0794` | `file-appeared` | observed | `d:/主工作区/tmp/qq-bot-research/_cfg_check2.` | missing → present | FileNotFoundError: [Errno 2] No such fil |
| 6 | mark | `c-64a3be12` | `file-appeared` | observed | `/c/Users/Administrator/.config/magpie/pl` | missing → present | FileNotFoundError: [Errno 2] No such fil |
| 7 | mark | `c-7171c15e` | `file-appeared` | observed | `d:/DeepSeek Harness/default-workspace/ds` | missing → present | FileNotFoundError: [Errno 2] No such fil |
| 8 | mark | `c-8a22fe45` | `file-appeared` | observed | `/d/主工作区/repos/dsh-GOkifu-compact/evidenc` | missing → present | FileNotFoundError: [Errno 2] No such fil |
| 9 | mark | `c-96e12366` | `version-mismatch` | observed | `dsh-gokifu-compact@1.17.1` | 1.17.1 → 1.17.6 | dsh-gokifu-compact@1.17.1 |
| 10 | mark | `c-a74a2e16` | `version-mismatch` | observed | `dsh-session-superagent@0.9.167` | 0.9.167 → 0.9.179 | dsh-session-superagent@0.9.167 |
| 11 | mark | `c-bb8fe6f9` | `version-mismatch` | observed | `dsh-session-superagent@0.8.14` | 0.8.14 → 0.9.179 | dsh-session-superagent@0.8.14 |
| 12 | mark | `c-bb990458` | `version-mismatch` | observed | `dsh-gokifu-compact@1.17.2` | 1.17.2 → 1.17.6 | dsh-gokifu-compact@1.17.2 |
| 13 | mark | `c-c4e308bf` | `file-appeared` | observed | `/d/DeepSeek Harness/反代/work buddy/magpie` | missing → present | FileNotFoundError: [Errno 2] No such fil |
| 14 | mark | `c-cc5b8f0a` | `version-mismatch` | observed | `dsh-gokifu-compact@1.17.3` | 1.17.3 → 1.17.6 | dsh-gokifu-compact@1.17.3 |
| 15 | mark | `c-d65a25b1` | `file-appeared` | observed | `e:/Documents/deepseek-harness/default-wo` | missing → present | Error: ENOENT: no such file or directory |

### 2.2 POSIX 路径（暂不标）

| claimId | validity.value | 为什么不标 |
|---|---|---|
| `c-15fdd9cd` | `` | 老 writer 原样写入 POSIX 路径；读侧 resolveValidityPath 会解析到盘根，命中同名但无关的文件 |
| `c-f37a512f` | `` | 老 writer 原样写入 POSIX 路径；读侧 resolveValidityPath 会解析到盘根，命中同名但无关的文件 |

## 3 · 复现

```bash
cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"
node scripts/mark-stale.mjs                                   # dry-run（默认，不写）
node scripts/mark-stale.mjs --json                            # 机器可读
node scripts/mark-stale.mjs --apply                           # 真写（确认 dry-run 后再跑）
node scripts/mark-stale.mjs --revert --apply                  # 回退本脚本加的标记
node --test test/stale-marking.test.mjs
```

## 4 · 写侧路径归一（T159 A）

`src/rooms/claim.mjs` 新增 `classifyPathFlavor` / `normalizeEvidencePath`，ENOENT 派生的 fact 现在写：

| 证据原文 | 写入的 `validity.value` | `pathFlavor` |
|---|---|---|
| `/tmp/x.json`（Git Bash 临时目录） | `<本机 TEMP>/x.json`（绝对 Windows 路径） | `msys-tmp` |
| `/d/work/x`（Git Bash 盘符挂载） | `d:/work/x` | `msys-drive` |
| `C:/work/x`（反斜杠写法同） | `c:/work/x` | `windows` |
| `/主工作区/x`（无法还原） | 原值保留 | `posix`（读侧据此判"核不了"，不再解析到盘根） |

同时给 ENOENT 派生条目加方向位 `expect='missing'`（T158 的 `file` 语义）：文件**出现**才 stale。
**只影响新写入**：库里已有的老记录不动。

本次快照里仍带老 POSIX 路径的 claim：**39** 条（`c-00eb81f4`、`c-05436e7b`、`c-1201ac84`、`c-13d0c05b`、`c-15fdd9cd`、`c-2bc369e5`、`c-2caa6d03`、`c-32870086`、`c-37938a7f`、`c-383b2271`、`c-386a8833`、`c-5d48ff82`、`c-5e6c4583`、`c-64a3be12`、`c-66ddf00e`、`c-6ff84dcb`、`c-72298d0b`、`c-76a0ea07`、`c-81f0893e`、`c-82e1bf1f`、`c-8a22fe45`、`c-953203e2`、`c-9cf49c3b`、`c-a42b20ac`、`c-ac8cd9cc`、`c-ace52463`、`c-b6ebadd4`、`c-bded74c5`、`c-c238fc3b`、`c-c2d6aa4a`、`c-c43a84e8`、`c-c4e308bf`、`c-c6f3ec3e`、`c-cb186bfd`、`c-de00a9c9`、`c-dfc44a96`、`c-efb2e77b`、`c-f37a512f`、`c-fb821807`）。
它们要么是那 2 条假阳性的来源（`/tmp/...` 命中盘根同名文件），要么核验结果不可信；重新归档（写侧归一后）会把同一 id 的 `validity.value` 换成归一值。

## 5 · 验证：标记后闸 3 不再判红（用 T158 的 gates 模拟）

取 `c-072e17c0`（version-mismatch）做成一张最小卡片，同一份 validity 核验结果（`ok:false`）跑两次 `runGates`：

| 卡片里这条的 state | 渲染 kind | 闸 3 结果 |
|---|---|---|
| `observed` | `pointer` | ❌ `gate3/stale-not-marked` |
| `stale`（本脚本标记后） | `pointer` | ✅ 无 gate3 错误 |

结论：**标记本身就能让闸 3 放行**（渲染侧对 stale 条目本来就只给指针，`kind = 'pointer'`）。
注意：这只解决**本次 15 条**；库里其余"被旧探针误判"的条目要等探针修复（0.146.0，fix/gate3-probe）合入才不再判红。

## 6 · 已知限制

1. **下一次 archive 之后要重跑**：archive 每次从棋谱重算 claim（`state` 由 R09 重给，`stabilizeExisting` 只保留时钟），本脚本加的 `state:'stale'` 会被覆盖 —— 归档后 `--dry-run` 会重新显示待标条目。
2. **写侧归一只影响新写入**：库里已有的 POSIX 路径 claim 不会被改写（只增不改），要等重新归档把同一 id 的 `validity.value` 换成归一值。
3. **标记不等于"证明它错过"**：`staleReason` 只记录探针给出的机械原因与证据（expected/actual/path）。
