# rc1 验收指南（DSH 0.2.2-rc.1 / Cordis 4.1）

> `[本] 2026-11-06 · 仓库 0.3.4 · rc1 = 0.2.2-rc.1 · Cordis 4.1.0`
> 本指南配 `scripts/rc1-desktop-acceptance.mjs`（一键）与 `scripts/rc1-buildstore-verify.mjs`（建库验收）。

---

## 0 · 一句话

**在隔离 home 里把「归档 → 打包 → 安装 → rc1 真实加载 → 建库」跑通，再用人眼在 GUI 里确认一次「没有 Invalid effect、记忆卡可见」。**
真实 `DSH_HOME`、当前运行的 Desktop、magpie 全程不碰。

---

## 1 · 为什么要这一步

rc1 换了 Cordis 4.1，插件的 `apply` 必须返回**函数型 disposer**。返回普通诊断对象会报
`TypeError: Invalid effect` —— 这类失败**只有真实加载才能暴露**，单测和注入 `buildStore` 的探针都盖不住。

所以验收分两层：

| 层 | 验什么 | 谁跑 |
|---|---|---|
| **自动化**（本指南 §2） | 真实 Cordis 加载、fiber 生命周期、真实建库、cleanShutdown | 脚本（你跑一条命令） |
| **人工**（§3） | GUI 里卡片可见、不崩、HMR/长期运行 | 你本人 |

---

## 2 · 怎么跑（复制粘贴即可）

### 2.1 dry-run（先看计划，不执行）

```bash
cd "D:/DeepSeek Harness/default-workspace/长期记忆系统"
node scripts/rc1-desktop-acceptance.mjs
```

输出会打印：rc1 可执行文件是否存在、`app.asar` 是否存在、仓库版本与 `engines`、
**隔离 home 路径**（默认 `tmp/rc1-acceptance-home`，与真实 home 不同）、7 个步骤、回滚命令。

### 2.2 真跑（隔离 home）

```bash
node scripts/rc1-desktop-acceptance.mjs --execute
```

它做三件事（每件都会打印 ✅/❌ 与耗时）：

1. `archive.mjs --root <真实 DSH_HOME> --store <隔离home>/memory-context --dry-run`（**只统计不写盘**）；
2. `npm pack` → `tmp/rc1-acceptance-pack/dsh-gokifu-longmemory-<version>.tgz`；
3. 用 rc1 的 Electron 以 `ELECTRON_RUN_AS_NODE=1` 跑 `scripts/rc1-buildstore-verify.mjs`：
   真实 `Context` + 真实 loader + `enabled=true` + `autoBuild=true`，**不注入 buildStore**。

**判定标准**：三行全 ✅、末行 `结论：PASS`、退出码 0。

### 2.3 单独跑建库验收（只想看这一层）

```bash
ELECTRON_RUN_AS_NODE=1 \
LONGMEMORY_PROBE_HOME="D:/DeepSeek Harness/default-workspace/tmp/dsh-latest-upgrade/rc1-buildstore-home" \
"D:/DeepSeek Harness/Desktop-0.2.2-rc.1/DeepSeek Harness.exe" \
  scripts/rc1-buildstore-verify.mjs
```

看 JSON 里的 `checks`：

| 键 | 期望 | 含义 |
|---|---|---|
| `startupError` | `true` | 加载没抛错（**不是 Invalid effect**） |
| `fiberActive` | `true` | fiber 到 ACTIVE |
| `coreEffectIsFunction` | `true` | 核心 disposer 是**函数**（rc1 硬要求） |
| `disposersBefore` | `5` | 核心 effect + pre-step + turn-stopping 等都被 owns |
| `preStepThrew` | `true` | 真实 pre-step waterfall 没炸 |
| `storeRootCreated` / `manifestCreated` | `true` | **真实建库**：`memory-context/` 与 `manifest.json` 落盘 |
| `fiberDisposed` / `disposersCleared` | `true` | dispose 干净 |
| `cleanShutdown` | `true` | 探针 fibers 全部回收 |

---

## 3 · GUI 人工检查清单（脚本不替你做）

在隔离 home 下启动 rc1 Desktop（**用你方便的方式**，不要用脚本代启）：

```bash
# 示例：把隔离 home 指给 rc1（路径按你机器调整）
DSH_HOME="D:/DeepSeek Harness/default-workspace/tmp/rc1-acceptance-home" \
  "D:/DeepSeek Harness/Desktop-0.2.2-rc.1/DeepSeek Harness.exe"
```

逐条打勾：

- [ ] 启动无 `Invalid effect` 报错（控制台/日志里搜 `Invalid effect` 应为 0 条）；
- [ ] 插件出现在已加载列表里（`kifu-loader` / `dsh-gokifu-longmemory`）；
- [ ] 新建一个会话，发一条消息 → **能自动建库**（`<隔离home>/memory-context/` 出现 entries 与 `manifest.json`）；
- [ ] 第二轮消息时，**记忆卡/索引**在 GUI 里可见（有 provenance 与日期）；
- [ ] 关闭应用后进程干净退出（任务管理器里无残留 `DeepSeek Harness.exe`）；
- [ ] 重启一次应用，记忆仍在（持久化生效）。

> 任一条 ❌ ⇒ 把日志片段贴给 Lead，并**保留隔离 home**（别删），方便取证。

---

## 4 · 回滚

**所有写入都在隔离 home 内**，删掉即完全回滚：

```bash
rm -rf "D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/rc1-acceptance-home"
rm -rf "D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/rc1-acceptance-pack"
```

真实 `DSH_HOME`（`D:/DeepSeek Harness/home`）全程未被写；当前运行的 Desktop 与 magpie 未被触碰。

---

## 5 · 已知限制（别当验收通过）

- **`cleanShutdown=true` 只限探针 fibers**，不等于完整 Desktop 验收；
- 自动化层**不启动 GUI**，卡片可见性、HMR、长期运行必须 §3 人眼确认；
- `archive` 步骤是 **`--dry-run`**（只统计）；真实入档由 GUI 跑起来后自动发生；
- 本机无 rc1 的 GUI 自动化手段，**任何"GUI 已通过"的说法都必须有 §3 的截图或日志**。
