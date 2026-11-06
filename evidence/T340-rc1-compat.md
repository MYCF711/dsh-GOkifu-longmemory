# T340 · DSH 0.2.2-rc.1 / Cordis 4.1 兼容（R14 / #362）—— 真实 rc1 探针双向验证

> `[本] 2026-11-06` · 移植 + 全量测试 + **真实 rc1 Cordis 4.1 探针**（适配后绿 / 未适配红）。
> 交接来源：`AGENTS.md` §2.2.1（升级任务写给当前插件 agent）。

## 0 · 一句话

**把 `apply` 从「返回普通诊断对象」改为「返回函数型 Cordis disposer」后，
真实 rc1（Cordis 4.1.0）加载插件不再 `Invalid effect`，disposer/autoBuild 全部正确；
同一探针在未适配的 main 0.3.3 上复现 `TypeError: Invalid effect`（证明探针有判别力）。**

## 1 · 根因

rc1 / Cordis 4.1 要求插件 `apply` 返回**函数型 disposer**。
旧版 `apply` 在 `ctx.on` 不可用等路径返回普通对象 `{name, hook, registered, config}` ⇒
Cordis 4.1 抛 `TypeError: Invalid effect`，**插件加载即失败**（fiber 无法 ACTIVE）。

## 2 · 移植（自候选 `b7b2578b`，其 base `1257fe8`=0.3.2 与当前 main 在这些文件上零差异）

| 文件 | 兼容行为 |
|---|---|
| `src/plugin.mjs` | `apply` 经 `makeEffect` 返回函数型 disposer（同步置 `disposed`、逆序 off、严格复用同一 `disposePromise`）；autoBuild 共享 `Map<storeRoot,record>+owners`（后 apply 共享 task、最后 owner 取消 queued、running owner 各自 await、失败按身份删以允许重试）；pre-step/D5/turn-stopping 传同一 lifecycle，`isDisposed()` 阻止 stale 调度。 |
| `packages/kifu-loader/index.mjs` | `async apply` 原样返回核心 effect 的 Promise（不混 `coreSpec`）。 |
| `scripts/privacy-scan.mjs` + privacy 测试 | Git 子进程只清理**环境副本**的仓库定位变量（不改父进程 `process.env`）。 |
| `package.json` | `engines.dsh` → `>=0.2.2-rc.1 <0.3.0-0`。 |
| `test/plugin.test.mjs` 等 | +T362/T367–T371/零配置自动建库/D1/loader/privacy 回归。 |

**T339 的 `scripts/extract-recovery.mjs`、`test/extract-recovery.test.mjs` 未被触碰**（diff 为空）。

## 3 · 验收

### 单元/全量
```
node --test "test/*.test.mjs"   →  1013 条 / 1007 pass / 0 fail / 6 skip（+9）
node --test --test-name-pattern "T362|T367|T368|T369|T370|T371|零配置自动建库" test/plugin.test.mjs  →  7 pass / 0 fail
node scripts/check.mjs          →  PASS
```

### 真实 rc1 探针（真实 Cordis 4.1.0 加载，非 mock）
命令：
```
LONGMEMORY_WORKTREE=<本仓> LONGMEMORY_PROBE_HOME=<隔离tmp> ELECTRON_RUN_AS_NODE=1 \
  "D:/DeepSeek Harness/Desktop-0.2.2-rc.1/DeepSeek Harness.exe" \
  ../tmp/dsh-latest-upgrade/longmemory-rc1-probe.mjs
```

**适配后（本刀）—— PASS**：
```json
{"runtimeVersion":"0.2.2-rc.1","cordisVersion":"4.1.0","startupError":null,
 "stateBeforeDispose":2,"stateAfterDispose":4,"coreEffectType":"function",
 "disposersBefore":5,"disposersAfter":0,
 "autoBuildCancelCalls":0,"autoBuildPostDisposeCalls":0,
 "autoBuildSharedCalls":1,"autoBuildSharedFinished":1,
 "disposePromiseShared":true,"autoBuildDisposersAfter":[0,0,0],"cleanShutdown":true}
```

**未适配基线（main 0.3.3，独立 worktree）—— 复现**：
```
AssertionError [ERR_ASSERTION]: TypeError: Invalid effect
```

双向对照证明：① rc1 兼容**必要**（未适配即挂）② 本刀**有效**（适配后通过）③ 探针**有判别力**（非假绿）。

## 4 · 未验项（按 §2.2.1，不冒充）

真实 archive/pack/install、完整 Desktop/GUI/HMR、长期运行 —— 仍需单独验收；
本探针 `cleanShutdown=true` **只限探针 fibers**，不等于完整 Desktop 验收。

## 5 · 版本说明

兼容修复、**功能行为不变**（disposer 是宿主接缝适配，非记忆功能改动）⇒ **patch 0.3.4**
（`version-suggest` 亦建议 0.3.4）。临时 worktree 与探针隔离 home 已清理。
