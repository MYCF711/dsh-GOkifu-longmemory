# M5 六轴报告（一条命令可复算 · 零模型调用）

> 生成：`node scripts/m5-report.mjs --store tmp/memory-context --workspace . --root $DSH_HOME --evidence evidence/M5-six-axis.md`
> 运行时刻：2026-11-01T20:57:09.614Z（UTC；epoch ms 1793566629614）· 版本 m5-report v1 · 耗时 27286 ms · 零模型调用 · 只读

## 1 · 六轴总表

| 轴 | 判据 | 指标 | 值 | 单位 | 样本 n | 状态 |
|---|---|---|---|---|---|---|
| **A1** | 负迁移受控 | `staleTransferRate` | **0.00%** | rate | 9 | `measured` |
| **A2** | 收益（主判据） | `repeatFailureRate（LOO）` | **13.33%** | rate | 105 | `measured` |
| **A3** | 可靠性 | `injectFailureRate` | **0.00%** | rate | 21 | `not-live` |
| **A4** | 延迟/成本 | `walk→card→gates p50` | **4.11** | ms | 50 | `measured` |
| **A5** | 作用域隔离 | `crossScopeLeakRate` | **0.00%** | rate | 6 | `measured` |
| **A6** | 可回溯 | `provenanceCoverage` | **100.00%** | rate | 6 | `measured` |

状态含义：`measured` = 有真实样本；`not-live` = 能力在但没在宿主里真跑过；`not-consumed` = **没有数据，值记 null（不写 0）**。

## 2 · 逐轴口径与读法

### A1 · 负迁移 —— `staleTransferRate` = 0.00%

- 状态：`measured`（样本 n=9）
- 口径与限制：**0% 是空转的**（带 validity 的条目一条也没被渲染过）；带 validity 的 8 条一次都没被渲染到 ⇒ 覆盖率为 0，0% 不代表没风险；validityCoverage=0.00%（0/8）；crossScopeLeakRate=0.00%（见 A5）
- 明细：

```json
{
  "vacuous": true,
  "staleTransferRate": 0,
  "staleInjected": 0,
  "injected": 9,
  "postGateStaleRate": 0,
  "validityCoverage": {
    "withValidity": 8,
    "rendered": 0,
    "ratio": 0
  },
  "crossScopeLeakRate": 0,
  "signals": 44,
  "cardsWithContent": 11,
  "zeroInjection": 33
}
```

### A2 · 收益（不重复踩坑） —— `repeatFailureRate（LOO）` = 13.33%

- 状态：`measured`（样本 n=105）
- 口径与限制：LOO（both 口径）repeat=14 novel=91；1σ=±3.32%；coverage=79.17%（19/24 局）
- 明细：

```json
{
  "repeat": 14,
  "novel": 91,
  "sigma": 0.033174223435207956,
  "rootEpisodes": 24,
  "evaluatedEpisodes": 19,
  "distinctSignatures": 91,
  "variants": {
    "both": {
      "episodes": 24,
      "evaluated": 19,
      "signatures": 105,
      "repeat": 14,
      "novel": 91,
      "rate": 0.13333333333333333,
      "coverage": 0.7916666666666666
    },
    "edge": {
      "episodes": 24,
      "evaluated": 7,
      "signatures": 56,
      "repeat": 10,
      "novel": 46,
      "rate": 0.17857142857142858,
      "coverage": 0.2916666666666667
    },
    "event": {
      "episodes": 24,
      "evaluated": 19,
      "signatures": 120,
      "repeat": 16,
      "novel": 104,
      "rate": 0.13333333333333333,
      "coverage": 0.7916666666666666
    }
  }
}
```

### A3 · 可靠性（注入失败率） —— `injectFailureRate` = 0.00%

- 状态：`not-live`（样本 n=21）
- 口径与限制：真注入默认关（enabled=false，shadow=true）；0 失败率来自 21 条单测覆盖，不是线上样本；本机从未在宿主里真跑过一次注入（liveAttempts=0）⇒ 不能当可靠性证据
- 明细：

```json
{
  "pluginPresent": true,
  "pluginFile": "src/plugin.mjs",
  "hook": "agent/pre-step",
  "enabledDefault": false,
  "shadowDefault": true,
  "unitTests": 21,
  "testFile": "test/plugin.test.mjs",
  "liveAttempts": 0
}
```

### A4 · 延迟与成本 —— `walk→card→gates p50` = 4.11

- 状态：`measured`（样本 n=50）
- 口径与限制：墙钟＝walk→card→gates（不含宿主导入）；p90=11.9ms · p95=45.71ms · max=106.14ms；tokens p50=46（预算 500）；冷缓存 532.49ms（一次性）；p95 受 GC 影响
- 明细：

```json
{
  "p50": 4.11,
  "p90": 11.9,
  "p95": 45.71,
  "max": 106.14,
  "tokensP50": 46,
  "tokensP90": 296,
  "coldCacheMs": 532.49,
  "budgetTokens": 500,
  "gatesFailed": 0,
  "zeroInjection": 42,
  "scope": "w:d:/DeepSeek Harness/default-workspace/长期记忆系统"
}
```

### A5 · 作用域隔离 —— `crossScopeLeakRate` = 0.00%

- 状态：`measured`（样本 n=6）
- 口径与限制：卡片 20 张 / 渲染行 6；walk 拒掉跨域 655 条、缺域 0 条；卡内跨域计数 0；独立复核越界行 0（应为 0）
- 明细：

```json
{
  "cards": 20,
  "renderedLines": 6,
  "leakLines": 0,
  "walkDroppedCrossScope": 655,
  "walkScopeMissing": 0,
  "cardCrossScope": 0,
  "sampledLeaks": []
}
```

### A6 · 可回溯（provenance） —— `provenanceCoverage` = 100.00%

- 状态：`measured`（样本 n=6）
- 口径与限制：卡片 20 张 / 渲染行 6；带 ep-…+日期+seq 的 6 行（目标 100%）
- 明细：

```json
{
  "cards": 20,
  "renderedLines": 6,
  "provenanced": 6,
  "missing": []
}
```

## 3 · 语料与运行

- 记忆库（只读）：`D:\DeepSeek Harness\default-workspace\长期记忆系统\tmp\memory-context`
- 数据根（只读）：`D:\DeepSeek Harness\home`
- 工作区：`D:\DeepSeek Harness\default-workspace\长期记忆系统`（scope=`w:d:/DeepSeek Harness/default-workspace/长期记忆系统`）
- 棋谱 92 · 主题 780 · claim 125
- 热路径 50 次（A4）· 抽样卡片 20 张（A5/A6）· 信号文本 50 条
- 冷缓存 532.49 ms（一次性）· 闸不过 0 · 零注入 42 · walk 拒跨域 655

## 4 · 复现命令

```bash
cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"
node scripts/m5-report.mjs --store tmp/memory-context --workspace .                       # 文本表
node scripts/m5-report.mjs --store tmp/memory-context --workspace . --root "$DSH_HOME" --json
node scripts/m5-report.mjs --store tmp/memory-context --workspace . --root "$DSH_HOME" --evidence evidence/M5-six-axis.md
node --test test/m5-report.test.mjs
```

## 5 · 读这张表前必须知道的（风险与口径）

1. **六轴不是同一时点同一语料**：A1/A2 读 store + 原件（2026-11-01 入档的 24 root 局），A4/A5/A6 跑当前工作区作用域的卡片；A3 读的是单测事实，没有线上样本。跨时点不可比。
2. **A2 是机械代理**（失败原文是否在更早的局里出现过），不是"模型少走弯路"的净收益；后者要配对重放。
3. **A1 的 0% 不等于没风险**：`validityCoverage` 为 0 时分子恒为 0（没有任何到期条目被渲染过）。
4. **A3 的 0 是"没跑过"，不是"跑得很好"**：插件默认 `enabled=false`，0 失败率来自单测覆盖。
5. **A4 口径**＝walk→card→gates 的墙钟（不含宿主导入与 GC 抖动）；p95/max 受 GC 影响会跳。
6. **A5 是三重计数**：walk 自拒 + 卡内计数 + 独立反查渲染行的 ep scope；三者任一非 0 都要当缺陷查。
7. **A6 是文字判据**：`PROVENANCE_LINE_RE` 要求 `- [kind] text (ep-…, YYYY-MM-DD, seq N)` 整行匹配；日期或 seq 一丢就不算。
