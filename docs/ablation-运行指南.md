# 不重复踩坑 · 干预实验（ablation）一键运行指南

> `[本] 2026-11-06 更新`（对应 0.5.2：T341 开关 + T344 防泄漏/机械判分）
> 历史评审（三个漏洞的发现过程）见 `evidence/ablation-设计评审.md` —— 那是**当时的判断**，本文是**现在的做法**。

## 0 · 实验在回答什么

**同一批任务，注入记忆 vs 不注入，哪一组更多地重复同一个错误？**
- 有记忆组**显著更少**复发 ⇒ 记忆有用；
- 无差别 ⇒ 记忆没起作用（那时该查"卡上写了什么"，不是"要不要插件"）。

## 1 · 怎么跑（三件套已就绪）

### 1.1 准备隔离环境

```bash
export DSH_HOME_ABL="D:/DeepSeek Harness/home-ablation"     # 独立 home，绝不污染主库
mkdir -p "$DSH_HOME_ABL"
```

> A 臂要有货，先把主库**只读副本**放进去：
> `cp -r "D:/DeepSeek Harness/home/memory-context" "$DSH_HOME_ABL/"`（别反向写回主库）

### 1.2 出题（默认已防泄漏）

```bash
node scripts/ablation-live.mjs --n 20 --json > tmp/ablation-tasks.json
```

每条形如 `{taskId, taskPrompt, signature, promptSafe, errorText, ...}`，**用法严格分开**：

| 字段 | 给谁 | 说明 |
|---|---|---|
| `taskPrompt` | **发给模型** | 只含**动作**（当时在跑什么，如 `bash node scripts/check.mjs`），不含错误原文 |
| `signature` | **只给判分** | 归一化错误签名（路径已归一）；**严禁出现在提示里**，否则 A 臂直接抄答案 |
| `errorText` | 只给人看 | 追溯用；**不进提示** |
| `promptSafe` | 守门 | `false` 的题**不得用于判「记忆有用」**（默认已不出；`--allow-unsafe` 才放行） |

### 1.3 A 臂（有记忆）

1. 新开一个 DSH 会话（工作区选实验目录），插件保持 `enabled: true`；
2. 逐条把 **`taskPrompt`** 发给模型（不要带 `signature`/`errorText`）；
3. 记下该会话的日志路径（`<DSH_HOME_ABL>/sessions/<sid>/…zstd`），判分要用。

### 1.4 B 臂（无记忆）—— 两种关法，任选其一

| 关法 | 怎么做 | 备注 |
|---|---|---|
| **环境变量**（推荐，v0.4.1 起生效） | 启动该会话前设 `GOKIFU_INJECT=off` | 进程级、不碰宿主配置、不触发热重载 |
| 设置 UI | 关掉"启用记忆注入"（`enabled:false`） | 跑完**立刻改回 true**，否则后续会话全无记忆 |

**开场先自检**：会话里应看不到任何记忆卡注入；看不到才开跑。

### 1.5 判分（机械，不再手工填 0/1）

```bash
# A 臂跑完
node scripts/ablation-live.mjs --judge --tasks tmp/ablation-tasks.json --log <A臂日志> --variant A --record

# B 臂跑完
node scripts/ablation-live.mjs --judge --tasks tmp/ablation-tasks.json --log <B臂日志> --variant B --record
```

判据（纯机械）：把日志里**所有失败行**归一成签名（`errorKeyOf`：路径 → `<path>`、错误类归一），
与任务的 `signature` 求交 —— 命中即 `recurred=true`。**不读 claim、不看提示、零模型判断。**

### 1.6 记分

```bash
node scripts/ablation-live.mjs --score
```

输出 `onlyA / onlyB / mcnemarP / verdict`。

## 2 · 三个漏洞的修复状态

| 漏洞 | 状态 | 落在哪 |
|---|---|---|
| ① `GOKIFU_INJECT=off` 是**虚构开关**（src 根本不读）⇒ 两臂等价 | **已修**（0.4.1，T341） | `src/plugin.mjs` 的 `sanitizeConfig`：显式 `off/false/0` ⇒ `enabled=false` 且 `shadow=false`；不设则为配置键 |
| ② 复发靠**手工填 0/1** | **已修**（0.5.2，T344） | `--judge` + `judgeRecurrence`（归一签名比对） |
| ③ 考卷**泄漏**（题目就是库里那条错误原文） | **已修**（0.5.2，T344） | `taskPrompt` 只取动作；取不到动作或提示含错误原文 ⇒ `promptSafe:false` 默认不出 |

## 3 · 怎么读结果（跑之前定死）

| 结果 | 判定 |
|---|---|
| `onlyB > onlyA` **且** `mcnemarP < 0.05` | **记忆有用** |
| `onlyA ≈ onlyB`（p ≥ 0.05） | **无差别 ⇒ 记忆没起作用** |
| `onlyA > onlyB` | **方向相反** ⇒ 先查是不是卡在诱导错误 |
| 配对数 < 6 | **样本不足**（0 vs 6 才 p=0.031） |

**样本量**：N=20 里至少要有 **6 对不一致**，否则只能报方向、不能报显著。

## 4 · 常见失败

- **两臂结果完全一样** ⇒ 先验证 B 臂真的关了（§1.4 自检），多半是开关没生效；
- **A 臂 100% 命中** ⇒ 检查有没有人把 `signature`/`errorText` 塞进了提示（§1.2 表）；
- **B 臂也 100% 命中** ⇒ 任务本身没用到记忆（动作提示太强），换更开放的动作；
- **`--judge` 读到 0 条失败** ⇒ 日志路径不是那个会话的，或该会话没有失败。

## 5 · 红线

- 不重启 DSH、不碰 magpie；
- 不写真实 `<DSH_HOME>/memory-context`（实验只用隔离 home 或只读副本）；
- 不把 `signature` / `errorText` 发给模型。
