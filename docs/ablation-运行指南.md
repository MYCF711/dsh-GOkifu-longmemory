# 不重复踩坑 · 干预实验（ablation）一键运行指南

> `[本] 2026-11-06` · 适用于 `scripts/ablation-live.mjs`
> ⚠ **先读 `evidence/ablation-设计评审.md`**：当前脚本的 `GOKIFU_INJECT=off` **不存在**，按原样跑 B 臂仍是"有注入"。下面两套流程：**§1 修好前的最小可用版**（手工切配置）、**§2 修好后的标准版**。

## 0 · 实验在回答什么

**同一批任务，注入记忆 vs 不注入，哪一组更多地重复同一个错误？**
- 有记忆组**显著更少**复发 ⇒ 记忆有用；
- 无差别 ⇒ 记忆没起作用（那时该查"卡上写了什么"，不是"要不要插件"）。

## 1 · 最小可用版（不改代码，用配置开关）

### 1.1 准备隔离环境

```bash
export DSH_HOME_ABL="D:/DeepSeek Harness/home-ablation"     # 独立 home，避免污染主库
mkdir -p "$DSH_HOME_ABL"
```

> 隔离 home 里**没有记忆库** ⇒ 第一次跑会 `archive` 建库。若要让 A 臂有货，需先把主库复制过去：
> `cp -r "D:/DeepSeek Harness/home/memory-context" "$DSH_HOME_ABL/"`（只读副本，别反向写）。

### 1.2 出题（两臂共用）

```bash
node scripts/ablation-live.mjs --n 20 --json > tmp/ablation-tasks.json
```

### 1.3 A 臂（有记忆）

1. 新开一个 DSH 会话，**工作区选实验目录**，插件配置保持 `enabled: true`（设置 UI 默认）；
2. 逐条跑 `tmp/ablation-tasks.json` 里的任务（每条 = 一个"重放该错误"的提示）；
3. 每条跑完记录：

```bash
node scripts/ablation-live.mjs --record --task <taskId> --variant A --recurred 0   # 没再犯
node scripts/ablation-live.mjs --record --task <taskId> --variant A --recurred 1   # 又犯了
```

### 1.4 B 臂（无记忆）—— **必须改配置，不是环境变量**

1. 新开会话前，把插件配置改成 **`enabled: false`**（设置 UI → 记忆插件 → 关闭"启用记忆注入"）；
2. **确认真的关了**：会话里应看不到任何 `<chess>` / 记忆卡注入；
3. 跑**同一批** 20 条任务，记录：

```bash
node scripts/ablation-live.mjs --record --task <taskId> --variant B --recurred 0/1
```

4. 跑完**立刻把 `enabled` 改回 `true`**（别忘，否则后续会话全无记忆）。

### 1.5 记分

```bash
node scripts/ablation-live.mjs --score
```

输出 `onlyA / onlyB / mcnemarP / verdict`。

## 2 · 标准版（修完评审的 3 个漏洞后）

| 漏洞 | 修法 | 归属 |
|---|---|---|
| `GOKIFU_INJECT` 不存在 | 二选一：① 用 `enabled:false`（配置）；② 在 `src/plugin.mjs` 的 `resolveConfig` 接 `process.env.GOKIFU_INJECT === 'off'` | ②由你负责 |
| "复发"靠手填 | 脚本自动判：用 `failureSignature` 归一化，比对 B 臂日志里是否再现同一签名 | `scripts/` |
| 考卷泄漏（题目就是库里的事实） | 出题时**排除该 claim 自身**，或用快照前的库 | `scripts/` |

## 3 · 怎么读结果（机械标准，跑之前定死）

| 结果 | 判定 |
|---|---|
| `onlyB > onlyA` **且** `mcnemarP < 0.05` | **记忆有用** |
| `onlyA ≈ onlyB`（p ≥ 0.05） | **无差别 ⇒ 记忆没起作用** |
| `onlyA > onlyB` | **方向相反** ⇒ 先查是不是卡在诱导错误 |
| 配对数 < 6 | **样本不足**（0 vs 6 才 p=0.031） |

**样本量**：N=20 里至少要有 **6 对不一致**，否则只能报方向、不能报显著。

## 4 · 常见失败

- **两臂结果完全一样** ⇒ 先验证 B 臂真的关了（§1.4 第 2 步），多半是开关没生效；
- **A 臂 100% 命中** ⇒ 可能考卷泄漏（题目就是库里那条 claim），见评审 §2 漏洞 3；
- **B 臂也 100% 命中** ⇒ 任务本身没用到记忆（错误复现提示太强），换更"开放"的提示。

## 5 · 红线

- 不重启 DSH、不碰 magpie；
- 不写 `<DSH_HOME>/memory-context`（实验只用隔离 home 或只读副本）；
- 不改 `src/`（除非你负责那一刀）。
