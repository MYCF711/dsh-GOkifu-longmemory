# T195 · 工具面接线与"配置说禁用、运行时在注入"的真相

> `[本] 2026-11-05 09:40 +08:00` · 只读诊断 + 只写 staging（`tmp/`），**未写任何 profile、未重启 DSH**。
> 复现：`node scripts/kifu-profile-doctor.mjs` / `node scripts/kifu-profile-stage.mjs [--apply]`

## 1 · 结论（一句话）

**下次重启后记忆插件会加载** —— 它走的是 `kifu-loader`（`dsh.profile.bundles` 里含它）的 bundle patch 插入的
`id: kifu-memory`；profile patch 里那两条 `disabled: true` 命中的是 `kifu-longmemory` / `dsh-gokifu-longmemory`
（`dsh-gokifu-longmemory` **不在** bundles 里，所以它自己的 bundle patch 根本没参与拼树）⇒ **空靶**。

证据链（`node scripts/kifu-profile-doctor.mjs` 的读数）：

| 证据 | 值 |
|---|---|
| profile patch 里的棋院条目 | `L360 id=kifu-longmemory name=dsh-gokifu-longmemory disabled=true` · `L363 id=dsh-gokifu-longmemory name=dsh-gokifu-longmemory disabled=true` |
| 重复 id / 同名矛盾 | 无（两条 id 不同、都是 disabled ⇒ 互相"一致"地打空靶） |
| profile `dsh.profile.bundles` 里的棋院包 | `dsh-gokifu-compact` · **`kifu-loader`**（`dsh-gokifu-longmemory` 不在） |
| `dsh-gokifu-longmemory` 的 bundle patch | 插入 `id: kifu-longmemory`（**未参与**，因为不在 bundles） |
| `kifu-loader` 的 bundle patch | 插入 `id: kifu-memory`（参与） |
| `kifu-loader/index.mjs` | `export * from '../../src/plugin.mjs'` → 解析到 `长期记忆系统/src/plugin.mjs`（存在） |
| 运行时心跳 | `pid=10096 at=2026-11-05T01:18:11.580Z action=inject` |
| 宿主启动 | `2026-11-05T02:30:35+08:00`（**晚于** patch mtime 02:28 ⇒ 当前配置已生效过） |
| 工具面 | `tools-registered.json`：`via=none`、`count=0` ⇒ **没挂上**（patch 里没有 `kifu-tools`） |

⇒ 矛盾的解释：不是"配置和运行时打架"，而是**那两条 disabled 从一开始就没打中任何节点**。
运行时能注入，是因为另一个包（kifu-loader）用另一个 id 把同一个插件挂进了树。

## 2 · staging 产出（`node scripts/kifu-profile-stage.mjs --apply`）

`tmp/cordis.patch.staged.yml`（410 → 411 行，-4 / +5）：

| # | 改动 |
|---|---|
| 1 | 删 `- id: kifu-longmemory / name: dsh-gokifu-longmemory / disabled: true`（原 L360-362） |
| 2 | 删 `- id: dsh-gokifu-longmemory / ... / disabled: true`（原 L363-365） |
| 3 | 在原位置写回**一条启用**：`- id: dsh-gokifu-longmemory` + `  name: dsh-gokifu-longmemory` |
| 4 | 末尾追加 `kifu-tools`（**原样搬** `scripts/print-tools-plugin-entry.mjs` 的输出，含它那两行注释） |

幂等：已存在 `- id: kifu-tools` ⇒ 跳过；已无 `disabled: true` 的棋院条目 ⇒ 不再改那一段。跑两遍逐字节相同
（`test/kifu-profile-stage.test.mjs` 的 T195 ③ 覆盖）。

校验：`verifyPatch` = 结构校验（顶层数组 / 不许 TAB / 不许未闭合引号 / 缩进行必须有归属）；
项目**没有** `yaml` 依赖，运行时有 `yaml` 才会额外解析一次（当前"不可用 ⇒ 已用结构校验替代"），未引入新依赖。

一键脚本：`tmp/apply-kifu-profile.sh` + `tmp/apply-kifu-profile.ps1` —— 备份（`profiles/desktop/backup/`）→ 校验
（`kifu-profile-stage.mjs --verify`，失败则**不替换**、退出 3）→ 同目录临时文件 + rename 原子替换 → 打印回滚命令。
**它们不重启 DSH**；重启由用户在桌面点。

## 3 · ⚠ 上线前的已知副作用（本次不改，先如实记）

staging 把 `dsh-gokifu-longmemory` 那条**启用**之后，如果 `kifu-loader`（`id: kifu-memory`）仍在 bundles 里，
**同一个插件会被挂两次**（两个 id、两份 `agent/pre-step` 钩子）⇒ 可能双注入。
两条出路（都需要人拍板，本刀不动）：

1. 从 `dsh.profile.bundles` 里去掉 `kifu-loader`，只留启用后的 `dsh-gokifu-longmemory`；
2. 或者反过来：保留 `kifu-loader`，staging 里那条**不加**（只加 `kifu-tools`）。

## 4 · 用户要跑的命令（一条）

```bash
bash "D:/DeepSeek Harness/default-workspace/长期记忆系统/tmp/apply-kifu-profile.sh"
```

PowerShell 等价：`pwsh -File "…\tmp\apply-kifu-profile.ps1"`。执行后**在桌面点「重启」**让配置生效
（脚本不重启；按 `$DSH_HOME/AGENTS.md` 铁律 1，重启只能由用户触发）。
重启后自查：`cat "$DSH_HOME/memory-context/tools-registered.json"` —— 期望 `"via": "tools-plugin"`、`"count": 5`。
