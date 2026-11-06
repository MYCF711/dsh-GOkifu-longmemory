# 评审：`scripts/ablation-live.mjs`（不重复踩坑干预实验）

> `[本] 2026-11-06 21:30 +08:00` · 只读审查 · 未运行实验、未改任何代码

## 0 · 结论（三句）

1. **开关是假的**：`GOKIFU_INJECT` **在全仓 `src/` 里一次都没出现**，插件从不读它 ⇒ **设它不会关掉注入**。真实开关是插件配置键 **`enabled`**（`src/plugin.mjs` 的 `DEFAULT_CONFIG.enabled` 与 `applyPreStep` 里的 `if (!config.enabled) return { action: 'skip', reason: 'disabled' }`）。
2. **判据本身是机械的，但"踩坑"的定义没有落地**：脚本只出题（`listCandidates`）+ 记分（`score`），**"是否复发"由人/模型判定后手填** `--recurred 0/1`，没有机械判据。
3. **有 3 处设计漏洞**（见 §2），其中"B 臂其实没关"是致命的 —— 按现状跑，两臂都是"有注入"，实验会得出"无差别"，从而**错误地证伪记忆的价值**。

## 1 · 开关核实（代码证据）

| 检查 | 结果 |
|---|---|
| `grep -rn "GOKIFU_INJECT" src/ scripts/ docs/` | **只命中 `scripts/ablation-live.mjs`（注释）与 `docs/拷问记录.md`**，`src/` 零命中 |
| `src/plugin.mjs` 的 `DEFAULT_CONFIG` | `enabled: true`、`shadow: false` |
| `src/plugin.mjs` 的 `applyPreStep`（注入主路径） | `if (!config.enabled && !config.shadow) return { action: 'skip', reason: 'disabled' }`；`if (config.shadow) { …; return { action: 'shadow' } }`；`if (!config.enabled) return { action: 'skip', reason: 'disabled' }` |

**⇒ 唯一能真正关掉注入的是 `enabled: false`**（走设置 UI / profile 配置，不走环境变量）。`shadow: true` 也不注入（返回 `action:'shadow'`），但它会**继续建卡并写 `evidence/shadow/`**，不是干净的无记忆臂。

## 2 · 设计漏洞（3 处）

### 漏洞 1（致命）：对照组不是"无记忆"
脚本注释与前一次证据都写 `GOKIFU_INJECT=off`，**该变量不存在** ⇒ B 臂实际仍是默认配置（`enabled: true`）⇒ **A/B 两臂等价**，跑出来的"无差别"是假象，会**误判"记忆没用"**。

**修法**：B 臂改成 `enabled: false`（配置层），或用一个真实存在的环境变量在 `src/plugin.mjs` 的 `resolveConfig` 里接线（需改 `src/`，属于你负责的范围）。

### 漏洞 2：判据不机械
`record({recurred})` 由人/模型填 0/1 —— 这不是机械判据，和 `AGENTS §2.3「计数不是打分」`冲突。
**修法**：把"复发"定义成**可机械检测的事件**（如：B 臂会话日志里再次出现同一失败签名，按 `scripts/ablation-recurrence.mjs` 的 `failureSignature` 归一化后比对），由脚本自动判，不填 0/1。

### 漏洞 3：泄漏（考卷在注入时已知）
`listCandidates()` 从**库里已有的 claim** 出题 ⇒ 题目本身就是"记忆里的事实"。A 臂注入的卡**必然包含该题**（同一条 claim），这违反 C2 的"去掉它结果变差"的干净对照（做题时会看到答案）。
**修法**：出题用**另一份库快照**（如 fc 前），或出题时**排除该 claim 自身**（注入卡里剔除它），否则实验测的是"抄答案"不是"少踩坑"。

**补充**：候选去重只按 `episode+seq`，但 `listCandidates` 在 `out.length >= n` 时就 `break`，**不是均匀抽样**（按 claim id 顺序取前 N），会系统性偏向 `c-0xxx` 开头的早期 claim。

## 3 · 可以保留的部分

- `score()` 的**配对 + McNemar**（`mcnemarExact`）与 `wilson()` 正确，**判据口径是对的**（`onlyB > onlyA` 且 p<0.05 才算有用）；
- `record()` 的**幂等**（同 `taskId+variant` 覆盖）正确；
- 出题字段（`episode/seq/claimId/错误原文`）够用，便于逐条核。

## 4 · 复用建议

修漏洞前**不要跑**正式实验：跑出来的"无差别"无法区分"记忆没用"与"两臂都没关/都关了"。修完后按 `docs/ablation-运行指南.md` 执行。
