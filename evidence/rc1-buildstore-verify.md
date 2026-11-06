# rc1 补充验证：隔离 home 内**真实 Cordis 4.1 加载 + 真实建库**

> `[本] 2026-11-06 21:35 +08:00` · 仓库 0.3.4 · rc1 `0.2.2-rc.1` · Cordis `4.1.0`
> 产物：`scripts/rc1-buildstore-verify.mjs`（本证据的执行体）、`scripts/rc1-desktop-acceptance.mjs`、`docs/rc1-验收指南.md`

## 1 · 为什么这条要单独验

现成探针 `../tmp/dsh-latest-upgrade/longmemory-rc1-probe.mjs` 主要验 `enabled=false` 的生命周期与共享 autoBuild，
且**注入了 `buildStore`**。本验证走另一半：**`enabled=true` + `autoBuild=true` 的真实建库路径**（不注入任何 buildStore），
确认 rc1 下插件能自己 `deriveStore` 写出 `memory-context/` 与 `manifest.json`。

## 2 · 执行命令

```bash
cd "D:/DeepSeek Harness/default-workspace/长期记忆系统"
ELECTRON_RUN_AS_NODE=1 \
LONGMEMORY_PROBE_HOME="D:/DeepSeek Harness/default-workspace/tmp/dsh-latest-upgrade/rc1-buildstore-home" \
"D:/DeepSeek Harness/Desktop-0.2.2-rc.1/DeepSeek Harness.exe" \
  scripts/rc1-buildstore-verify.mjs
```

## 3 · 结果（原样，exit=0）

```json
{
  "rc1": "D:/DeepSeek Harness/Desktop-0.2.2-rc.1",
  "home": "D:\\DeepSeek Harness\\default-workspace\\tmp\\dsh-latest-upgrade\\rc1-buildstore-home",
  "checks": {
    "startupError": true,
    "fiberActive": true,
    "coreEffectIsFunction": true,
    "disposersBefore": 5,
    "preStepThrew": true,
    "storeRootCreated": true,
    "manifestCreated": true,
    "fiberDisposed": true,
    "disposersAfter": 0,
    "disposersCleared": true,
    "cleanShutdown": true
  },
  "ok": true,
  "runtimeVersion": "0.2.2-rc.1",
  "cordisVersion": "4.1.0",
  "manifestKeys": ["bytes", "checksums", "counts", "createdAt", "files", "pathPolicy", "schema", "updatedAt"],
  "entryCount": 1
}
```

## 4 · 逐条判读

| 检查 | 值 | 含义 |
|---|---|---|
| `startupError` | `true` | 加载**没有抛错** ⇒ 不是 `TypeError: Invalid effect` |
| `coreEffectIsFunction` | `true` | 核心 disposer 是**函数**，且名字是 `dsh-gokifu-longmemory`（Cordis 4.1 的硬要求） |
| `disposersBefore` | `5` | 核心 effect + pre-step + turn-stopping 等全部被 fiber owns |
| `preStepThrew` | `true` | 真实 `agent/pre-step` waterfall 跑通（没炸） |
| `storeRootCreated` / `manifestCreated` | `true` | **真实建库**：`memory-context/manifest.json` 落盘 |
| `fiberDisposed` / `disposersCleared` | `true` / `0` | dispose 干净，无残留 effect |
| `cleanShutdown` | `true` | 探针 fibers 全部回收（**仅限探针**） |

## 5 · 一键验收脚本（隔离 home）实跑

```bash
$ node scripts/rc1-desktop-acceptance.mjs --execute
## 执行结果
- ✅ archive(dry-run)（81571ms）
- ✅ pack（1268ms）：...\tmp\rc1-acceptance-pack\dsh-gokifu-longmemory-0.3.4.tgz
- ✅ load-verify(rc1)（767ms）：entryCount: 1
结论：PASS（隔离 home 内全绿）
```

## 6 · 未验项（不冒充）

1. **GUI 层未验**：本机没有 rc1 的 GUI 自动化手段，`docs/rc1-验收指南.md` §3 的清单（卡片可见 / HMR / 长期运行 / 干净退出）**需要用户人眼确认**；
2. **`cleanShutdown=true` 只限探针 fibers**，不等于完整 Desktop 验收；
3. **真实入档未跑**：验收脚本里 archive 用 `--dry-run`（只统计）；真实入档由 GUI 跑起来后自动发生；
4. **安装步骤未落地**：脚本目前只到 `npm pack` 出 tarball + rc1 加载验证，**没有**把 tarball 解进隔离 profile 的 `node_modules`（本机 profile 布局需再确认，见指南 §2.2 第 4 步）。
