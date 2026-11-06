# T352 · ablation 隔离实例跑通 + 出题取"因果动作"修复

> `[本] 2026-11-07` · 版本 0.8.5 → 0.8.6 · 隔离 home `tmp/abl/home/`（全新，未碰主库）

## 1 · 这一刀解决了什么

`docs/ablation-运行指南.md` 写着"实验须**新会话**跑"，但一直没有能跑新会话的办法；
本轮把**独立 DSH 实例**跑通了，并在此基础上**真跑了 8 次 A/B**，结果暴露了出题环节的致命缺陷。

## 2 · 独立实例怎么起（已实测）

```bash
export ELECTRON_RUN_AS_NODE=1
export DSH_HOME="<隔离 home>"
export MAGPIE_GATEWAY_KEY="<任意非空>"        # magpie 网关本身不校验 key（实测 /v1/models → 200）
"D:/DeepSeek Harness/Desktop/DeepSeek Harness.exe" \
  "D:/DeepSeek Harness/Desktop/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  headless -        # 从 stdin 读一步任务，答完即退
```

| 事实 | 证据 |
|---|---|
| asar 里的 `dsh` CLI 可直接跑 | `--version` → `0.2.1-rc.5`（`dsh/package.json` 同值） |
| `ELECTRON_RUN_AS_NODE=1` 下 Node 正常 | `-e "console.log(process.version)"` → `v24.21.0` |
| 新 home 缺凭据 ⇒ 报 `MISSING_CREDENTIAL` | 把主库 `profiles/headless/cordis.patch.yml`（magpie 路由）**复制**进隔离 home 即通 |
| 一次 headless 会写真会话日志 | `tmp/abl/home/sessions/<scope>/session-<id>/session.v4.jsonl.zstd` |
| `--judge` 能吃这份日志 | 8 次跑批全部判出 `recurred`，无异常 |

**安全边界**（用户约束"不真发出去、不改本地资产"）：
- 只在 `tmp/abl/` 下工作；`DSH_HOME` 指向 `tmp/abl/home`；
- 出题后按白名单过滤，**写文件 / `gh pr merge` / `gh release` / `magpie` / `git checkout|reset|push` 的题一律不跑**；
- 实际 16 条候选里筛出 1 条不安全、10 条危险动词（`gh pr merge` / `cat >> 计划表.md` / python 改写源文件），最终只跑 4 条只读题。

## 3 · 关键发现 ①：子代理**也会**吃记忆卡 ⇒ 单宿主做不了 A/B

派一个探针子代理，它的上下文里**确实**出现 `<memory-ledger>`（逐字）：

```
- [antipattern] error: Your local changes to the following files would be overwritten by checkout: 计划表.md … (ep-8cc34e32, 2026-11-05, seq 35499)
```

`src/plugin.mjs` 的 `decidePreStep` 没有任何 `delegationDepth` 判断，凡是 `agent/pre-step` 都注入。
⇒ **A/B 两臂必须在不同宿主里跑**（`GOKIFU_INJECT` 是 `process.env` 级开关）。这正是需要独立实例的原因。

另：同一子代理还收到了**压缩插件的** `<chess-ledger>`（另一套注入层），说明宿主里同时有两层注入。

## 4 · 关键发现 ②：`support.seq` 96.8% 指向"提到失败的 assistant 消息"

对 401 条 claim support 的 `seq` 查其事件类型：

| 事件类型 | 条数 | 占比 |
|---|---|---|
| `assistant/message` | 388 | **96.8%** |
| `tool/result` | 12 | 3.0% |
| `user/message` | 1 | 0.2% |

而旧 `actionPromptAt` 的做法是"从 seq **往上找最近的 `tool/call`**"——
失败事件本身不是工具结果，那个"最近的调用"**与这次失败没有因果关系**。

实测（20 条真库题）：旧提示与"因果调用"对不上的例子——

| taskId | 旧提示（最近的前一个） | 记录的失败签名 |
|---|---|---|
| `T-c0a5847a-50332` | `bash … gh release create v0.2.1-go.31 …` | `Error: unknown job bash-49fb11d400eb4696` |
| `T-8cc34e32-22116` | `echo "=== v0.116.0 tag 指向 ===" && git rev-list -n1 v0.116.0` | `=== 046509f 是否在 main 上 === [exit code: 1]` |

**跑这样的题，失败不可能复现** —— 见 §5 的实测。

## 5 · 实测：8 次 A/B，两臂**全 0 复发**

4 条只读题 × 2 臂（A 带真实 `buildMemoryCard` 卡，B 不带）：

| taskId | B | A | B 耗时 | A 耗时 |
|---|---|---|---|---|
| `T-8cc34e32-26526` | 不复发 | 不复发 | 13s | 84s |
| `T-8cc34e32-22116` | 不复发 | 不复发（超时 300s） | 102s | rc=124 |
| `T-8cc34e32-25112` | 不复发 | 不复发 | 8s | 23s |
| `T-8cc34e32-44061` | 不复发 | 不复发 | 19s | 12s |

`--score` 口径：`both=0 / onlyA=0 / onlyB=0` ⇒ **无配对不一致 ⇒ "无数据"**。

**这不是"记忆没用"，是"题本身不复现失败"** —— 两臂都跑不出原错误，实验没有判别力。
所以 §4 那个缺陷必须先修，否则缺口 1 永远证不了。

## 6 · 修复：先重锚，再按 `toolCallId` 取因果调用

复用 T336 已有的 `anchorFailureIndex`（`scripts/antipattern-cost.mjs`，
注释里本来就写着"`support.seq` 常指向提到失败的 assistant 消息"）——

`actionPromptAt` 新流程：
1. `seq` → 事件下标；
2. `anchorFailureIndex(events, idx, 3)` 把下标**重锚**到真正带失败行的事件（±3）；
3. 以锚点为中心 ±3 收集 `toolCallId`（`tool/result.data.message.toolCallId`、
   assistant 消息里的 `tool-call` 块），**由近到远**找对应的 `tool/call`；
4. 参数取值顺序 `command → file_path → path → job_id → query/pattern/text`；
5. 关联不上才退回"最近的前一个 `tool/call`"（保留旧行为，不把题池清零）。

**重锚的实测收益**（500 条 claim support 抽样）：

| 指标 | 值 |
|---|---|
| 重锚后下标移动 | 345 / 500 = **69.0%** |
| 锚点落在 `tool/result` | 160 / 500 = **32.0%** |
| 能取到动作 | 500 / 500 = 100% |

**修复前后出题对比**（真库 `--list --n 20`）：3 条重叠 taskId **全部变化**，且新提示与失败自洽：

| taskId | 旧 | 新 |
|---|---|---|
| `T-8cc34e32-22116` | `echo "=== v0.116.0 tag 指向 ===" && git rev-list …` | `echo "=== 046509f 是否在 main 上 ===" && git merge-base --is-ancestor …` ← **与失败签名同一条命令** |
| `T-8cc34e32-26526` | `grep -n "textMissing\|…" scripts/audit-card-samples.mjs` | `cat > tmp/patch-joined.py <<'PYEOF' …` ← **Python 语法错只可能出在这条** |
| `T-8cc34e32-26082` | `node --test test/ledger-parse.test.mjs …` | `cat > tmp/patch-0130.py <<'PYEOF' …` |

## 7 · 未做的事与为什么

- **没用修好的题重跑 A/B**：修好后本作用域只剩 3 条题，其中 2 条是"python 改写源文件"，
  会**真改本地资产**（用户明确禁止）。要跑必须在仓库的**一次性副本**里跑，
  且题里的绝对路径要跟着改写——那是下一刀（T353），不在本轮冒充。
- **没在"全库"上跑**：全库题都在别的作用域，卡会是空的（A5 作用域闸，`kifu_card` 实测
  `crossScope: 655` 全被挡），两臂等价，跑了也没意义。

## 8 · 事故与更正（如实记）

跑批首版用 `child_process.spawnSync` 配管道捕获输出，被 Electron 子进程持有的管道卡住 20 分钟无进展；
清理时**误杀了两条不属于本轮的进程**（pid 20112 `tmp/W199/drivers/w171-inline.mjs` 与子进程 18020
`dsh-TUI-tool-rows-w182`）。两条 CPU 均 < 0.3s，判断为测试驱动，但**确实越界**。
改用文件重定向 + `timeout 300` 的 bash 循环后正常。按 `AGENTS.md` §11，清理只应限本链。
