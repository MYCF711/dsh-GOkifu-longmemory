# T182 · A2b 严格口径的域分析（2026-11-05）

> `[本] 2026-11-05 07:40:29 +08:00` · 只读：不写记忆库、不改 `src/**` / `scripts/metrics-guard.mjs` / `scripts/m5-report.mjs`；未跑全量测试、未重启 DSH。
> 数据：`<DSH_HOME>/memory-context`（真库）+ `evidence/a2b-set.json`（19 条冻结评估集）。
> 入口：`scripts/a2b-domain-audit.mjs`（只读脚本）· 单测：`test/a2b-domain-audit.test.mjs`。

## 0 · 结论（先给答案）

**当前 A2b 严格的唯一失分（1/19）属于 `cross-domain`，不是"该召回没召回"。**

- 该样本的 ground truth 是 `ep-8cc34e32`（域：`w:d:/DeepSeek Harness/default-workspace/长期记忆系统`），
  而样本自身的 scope 是 `w:e:/Documents/deepseek-harness/default-workspace`（**另一个工作区**），
  `evidence/a2b-set.json` 里这条的 `sameScope` 本来就是 `false`。
- 库里**没有任何一条**落在样本自己 scope 的 claim 覆盖这条 ground truth（`coveringClaims=0` in-scope）；
  69 条覆盖 claim 全部在 `长期记忆系统`（47）与 `u:owner`（22）—— 要召回它必须**跨工作区**。
- 严格判据（bestOverlap ≥2 个判别性 token）下 bestOverlap=1（只共享 `error`），
  但即便放宽到 ≥1 也仍属跨域召回，不是"多跳没走到"。

**三分类：`in-domain-miss 0 · cross-domain 1 · absent 0`**；按域校正（把 cross-domain 从分母去掉）后 **18/18 = 100.00%**。
**建议**：严格口径**不改**（0 条 in-domain-miss ⇒ 没有"该召回没召回"的证据）；若要动，只应把 `sameScope=false` 的 10 条样本单列一列（Q18 的 `crossScopeStrict/crossScopeSampled` 已经在做），**不要**直接把跨域样本从主分母里删掉——那会让 A2b 失去"跨项目记忆有没有用"这个唯一观测面。口径归 lead 裁。

## 1 · 汇总（`node scripts/a2b-domain-audit.mjs` 原样）

```
A2b 严格 = 18/19（94.74%）· in-domain-miss 0 · cross-domain 1 · absent 0 · 域校正后 = 18/18（100.00%）
```

对照 `measureA2b` 自己的口径：`n=19 · hits=19 · specificHits=18 · recallSpecific=0.9474 · missBy={covered:1, notRetrieved:0}`；
分桶：`multiHop 15/15`（全中）、`openDomain 3/4`（**唯一失分在这里**）。

## 2 · 判据（机械，无模型参与）

1. **命中**：完全复用 `scripts/m5-report.mjs` 的 `measureA2b`（同一份 `evidence/a2b-set.json` 冻结集、同一套 overlap 判据）——本脚本不重写命中口径，只读它返回的 `sampled[]`。
2. **域**：一律 `scopeKey` **严格相等**（与 `measureA2b` 的 `sameScope` 同口径）；样本当前域取冻结项的 `scopeKey`，ground truth 域取 `prior` 各局 `episode.scopeKey`。
3. **覆盖**：库里有哪条 claim 的 `support[].episode` 命中 ground truth 的 prior 局（`claimsCoveringPrior`）。
4. **三分类**（`classifyMiss`）：
   - 覆盖 claim 为空 ⇒ `absent`（未入库，不是召回问题）；
   - 覆盖 claim 全部落在别的域 ⇒ `cross-domain`（严格口径不该算）；
   - 覆盖 claim 里有落在当前域 ⇒ `in-domain-miss`（真失分）。
5. **域校正只展示**：`correctedStrict = strictHits / (n - crossDomain)`，不改 `metrics-guard` 的口径。

## 3 · 19 条样本逐条（严格口径）

| # | 严格命中 | bestOverlap | 桶 | 当前 scope | 命中 claim | claim scope | 分类 |
|---|---|---|---|---|---|---|---|
| 1 | 命中 | 8 | multiHop | `<ws-e>/default-workspace` | c-5175f1dc | `u:owner` | hit |
| 2 | 命中 | 8 | multiHop | `<ws-e>/default-workspace` | c-5175f1dc | `u:owner` | hit |
| 3 | 命中 | 10 | multiHop | `<ws-e>/default-workspace` | c-5175f1dc | `u:owner` | hit |
| 4 | 命中 | 10 | multiHop | `<ws-e>/default-workspace` | c-5175f1dc | `u:owner` | hit |
| 5 | 命中 | 10 | multiHop | `<ws-e>/default-workspace` | c-5175f1dc | `u:owner` | hit |
| 6 | 命中 | 9 | multiHop | `<ws-e>/default-workspace` | c-5175f1dc | `u:owner` | hit |
| 7 | 命中 | 19 | multiHop | `<ws-e>/default-workspace` | c-fbe74d18 | `u:owner` | hit |
| 8 | 命中 | 19 | multiHop | `<ws-e>/default-workspace` | c-fbe74d18 | `u:owner` | hit |
| 9 | 命中 | 19 | multiHop | `<ws-e>/default-workspace` | c-fbe74d18 | `u:owner` | hit |
| 10 | 命中 | 19 | multiHop | `<ws-e>/default-workspace` | c-fbe74d18 | `u:owner` | hit |
| 11 | 命中 | 10 | multiHop | `<ws-e>/default-workspace` | c-1293d2a5 | `<ws-e>/default-workspace` | hit |
| 12 | 命中 | 10 | multiHop | `<ws-e>/default-workspace` | c-1293d2a5 | `<ws-e>/default-workspace` | hit |
| 13 | 命中 | 3 | openDomain | `<ws>/default-workspace/GOkifu上下文压缩` | c-2d4fdcf7 | `u:owner` | hit |
| 14 | 命中 | 2 | multiHop | `<ws>/default-workspace/DSH-GO` | c-fbe74d18 | `u:owner` | hit |
| 15 | **失分** | 1 | openDomain | `<ws-e>/default-workspace` | c-fbe74d18 | `u:owner` | cross-domain |
| 16 | 命中 | 9 | openDomain | `<ws>/default-workspace/DSH-GO` | c-4fca33d1 | `u:owner` | hit |
| 17 | 命中 | 4 | openDomain | `<ws>/default-workspace/GOkifu上下文压缩` | c-13f0ea15 | `u:owner` | hit |
| 18 | 命中 | 10 | multiHop | `<ws>/default-workspace/GOkifu上下文压缩` | c-c58bb072 | `<ws-e>/default-workspace` | hit |
| 19 | 命中 | 11 | multiHop | `<ws>/default-workspace/GOkifu上下文压缩` | c-63644e5a | `<ws-e>/default-workspace` | hit |

> scope 简写：`<ws>/default-workspace` = `w:d:/DeepSeek Harness/default-workspace`；`<ws-e>/default-workspace` = `w:e:/Documents/deepseek-harness/default-workspace`；`u:owner` = 用户层（设计上跨项目可见）。

## 4 · 未命中明细

### #15 · 严格失分

```
sig        error: url hostname "raw.githubusercontent.com" resolves to 
episode    ep-e336b9dd
当前 scope  w:e:/Documents/deepseek-harness/default-workspace
prior      ["ep-8cc34e32"]
prior 域    ["w:d:/DeepSeek Harness/default-workspace/长期记忆系统"]
bestOverlap 1（严格判据要 ≥2 个判别性 token 才算命中）
命中文本    c-fbe74d18 · scope=u:owner
覆盖 claim  69 条 · 覆盖域=["w:d:/DeepSeek Harness/default-workspace/长期记忆系统","u:owner"]
机械分类    cross-domain
```

**判定**：该 claim（`c-fbe74d18`，`u:owner`，`class:web-search-empty`，support 39 局）确实覆盖 ground truth 的那一局，
但它的正文与这条 sig 只共享 `error` 一个 token（bestOverlap=1 < 2）；且它不在样本自己的域里。
⇒ 这是**跨工作区的同一类失败**（web 搜索空结果 / url hostname 非公网 IP），不是 E 盘工作区自己的记忆漏召回。

## 5 · 建议（严格口径要不要改）

- **不改**：`in-domain-miss = 0`，即"该召回、库里也有本域证据、但没召回"的样本一条都没有。94.74%（18/19）已经是"19 条里唯一那条跨域样本"造成的，不存在系统性召回缺陷。
- **如果要让数字更可解释**（不做也行）：把 `sameScope=false` 的 **10 条**样本在报告里单列（`crossScopeStrict / crossScopeSampled` 已有此列），主口径保持 19 条不变——这样既能看到跨项目记忆的价值，也不会因为"跨域算不算"反复漂移。
- **明确反对**：直接改 `metrics-guard` 的分母（把 cross-domain 删掉）会把 A2b 变成"只测同域"，跨项目记忆（本项目的核心卖点之一）就失去唯一观测面 —— 口径归 lead 裁，本条只给证据。

## 6 · 复现

```bash
node --test "test/a2b-domain-audit.test.mjs"     # 7 条纯函数单测
node scripts/a2b-domain-audit.mjs                # 人读表 + 汇总（约 50s：跑 runEval + measureA2b）
node scripts/a2b-domain-audit.mjs --json         # 机器读（含逐条 priorScopes / coveringScopes）
```

## 7 · 已知边界（如实写）

1. **claim 归因靠"120 字文本前缀"**：`measureA2b` 只回 `bestText`（claim 文本前 120 字），本脚本用它反查 claimId。19 条里 **5 条**前缀不唯一（同文不同 id），这 5 条都是**命中**行，不影响唯一失分的归因；唯一失分那条的前缀在库里唯一（`c-fbe74d18`）。
2. **frozen 集是 2026-11-02 冻结的**：19 条里 `sameScope=false` 有 10 条。评估集本身不随语料漂移，但"这 19 条还代不代表当前项目"是另一个问题（不在本任务范围）。
3. **本次只跑了一次真库**（`runEval` 有 9.5s 的语料遍历 + `measureA2b` 的 walk），数字是确定性的；若语料继续增长，18/19 可能变化（分母固定为 19）。
