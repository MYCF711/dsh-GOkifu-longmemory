# T263 · 把 T249 的硬实体信号推广到 self 题型（复合信号）

> `[本] 2026-11-05 21:05 +08:00` · **只读真库**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 改动面：`scripts/a2b-holdout.mjs`（`buildExam` 的 self 分支 + 三路对照）+ `test/a2b-holdout.test.mjs`（+1 条）
> 未改：`src/**`、`scripts/metrics-guard.mjs`、`scripts/m5-report.mjs`、`docs/**`、`MAINTENANCE.md`、`CHANGELOG.md`、`package.json`、`scripts/repair-support-seq.mjs`、`scripts/repair-side-effects.mjs`、`scripts/semantic-check.mjs`

## 0 · 一句话结论

**复合信号（任务原话 + 该局硬实体）让主判据从 49.12% 升到 77.19%**（同一批 114 题，Wilson [68.68%, 83.93%]），**不算放水**：硬实体桥的对照误判率 **1.17%（4/342）**，与"只用任务原话"的 **1.17%（4/342）完全持平**——加实体没有让无关 claim 变得更容易被判相关。
**但要说清一件事**：这 28pp 的涨幅**全部来自实体那一路**——同一批 self 题里"只用实体"是 69/94 = 73.40%，"原话+实体"是 69/95 = 72.63%，**原话部分贡献 0 次命中**（只是把 1 条无实体题留在分母里）。

## 1 · 三路信号对照（同一批题 · 严格命中 / Wilson / 对照误判）

```
$ node scripts/a2b-holdout.mjs --compare
三路信号对照（同一批题 · 严格命中 / Wilson / 对照误判）：
  task       n=114 · 严格 56/114 = 49.12% · Wilson [40.13%, 58.18%] · 对照 n=342 硬实体误判 4（1.17%）· 判别词误判 10（2.92%）
  entity     n=94  · 严格 69/94  = 73.40% · Wilson [63.68%, 81.29%] · 对照 n=342 硬实体误判 0（0.00%）· 判别词误判 13（3.80%）
  composite  n=114 · 严格 88/114 = 77.19% · Wilson [68.68%, 83.93%] · 对照 n=342 硬实体误判 4（1.17%）· 判别词误判 23（6.73%）
构造：claims 1570 · 有 claim 的局 95 · self 95 · repeat 19 · 跳过 0
```

| 信号 | n | 严格命中 | Wilson 95% | 硬实体误判 | 判别词误判 |
|---|---|---|---|---|---|
| **task**（只用任务原话） | 114 | 56 = 49.12% | [40.13%, 58.18%] | 4/342 = 1.17% | 10/342 = 2.92% |
| **entity**（只用硬实体） | 94 | 69 = 73.40% | [63.68%, 81.29%] | **0/342 = 0.00%** | 13/342 = 3.80% |
| **composite**（原话 + 实体，本刀） | 114 | 88 = 77.19% | [68.68%, 83.93%] | 4/342 = 1.17% | 23/342 = 6.73% |

- `entity` 的 n=94 而不是 114：repeat 题没有该局主题（只有签名），**不进 entity 分母**（如实标注）。
- **composite − task = +32 条命中 = +28.07pp**（56 → 88）。
- **composite 与 entity 在 self 子集上完全相同**（都是 69 条）：多出来的 19 条是 repeat 题，它们本来就在 task 臂里命中。

## 2 · 分桶（composite 口径，全卷 n=114）

```
$ node scripts/a2b-holdout.mjs
A2b 考卷（T236a）· n=114
严格命中 88/114 = 77.19% · Wilson 95% [68.68%, 83.93%]
宽松命中 95/114 = 83.33% · Wilson 95% [75.43%, 89.06%]
渲染行：related 128 · pending 115 · unrelated 67
分类型：self/root n=74 严格 57 宽松 62 · self/shortRootEntities n=12 严格 9 宽松 10 · self/firstUser n=9 严格 3 宽松 4 · repeat/signature n=19 严格 19 宽松 19
不相关对照组：n=342 · 硬实体桥误判 4（1.17%）· 仅判别词误判 23（6.73%）
```

| 桶 | n | 严格 | 严格率 | 改前（task 口径） |
|---|---|---|---|---|
| **self/root** | 74 | **57** | **77.03%** | 16/73 = 21.92% |
| self/shortRootEntities | 12 | 9 | 75.00% | （T249 已换，0% → 75%） |
| self/firstUser | 9 | 3 | 33.33% | 3/9 = 33.33% |
| repeat/signature | 19 | 19 | 100% | 19/19 = 100% |

**主判据最大的桶 self/root：21.92% → 77.03%（+55.11pp）**。

## 3 · 这算不算放水（用误判率回答）

| 口径 | 改前（task） | 改后（composite） | Δ |
|---|---|---|---|
| **硬实体桥误判**（T248 口径，n=342） | 4 = 1.17% | **4 = 1.17%** | **0** |
| 仅判别词误判 | 10 = 2.92% | 23 = 6.73% | +3.81pp |

- **硬实体桥没有多判任何一个无关 claim**（4 → 4）：涨幅不是靠"把无关的判成相关"得来的。
- 判别词误判从 2.92% 升到 6.73%，是因为复合信号里带上了路径片段（如 `src/auth/login.ts` 的 `login`），**这类重合是真实的词面重合**，不是桥的锅；它仍在 T248 定的"不放水"范围内（原口径自带 4.94%）。
- 更严格的一路是 **entity-only：硬实体误判 0/342 = 0.00%**。如果只要"最干净"，应选 entity-only；本刀按你的要求交付 composite（保留原话可追溯），并把这个差异写在这里。

## 4 · 改了什么（只改信号，不动判据）

```js
// scripts/a2b-holdout.mjs · buildExam
const entitySignal = episodeEntitySignal(episode);   // file×2 + error×1（与 T249 同口径）
if ((signalSource === 'root' || signalSource === 'firstUser') && entitySignal) {
  finalSignal = `${finalSignal} ${entitySignal}`.trim();   // 追加，不替换
}
const signals = { task: taskText, entity: entitySignal || null, composite: finalSignal };
```
- `related`（`support.episode === 该局`）与「≥2 判别词 / ≥1 硬实体」**一字未动**；
- 每条考卷现在同时带 `signals.{task,entity,composite}`，三路可复算（`--compare`）；
- repeat 题的 `signals` 是 `{task: 签名, entity: null, composite: 签名}`（没有该局主题）。

## 5 · 单测

```
$ node --test "test/a2b-holdout.test.mjs"
ℹ tests 13 ℹ pass 13 ℹ fail 0
✔ T263 self/root 复合信号：任务原话 + 该局硬实体（file×2 + error×1），只追加不替换
  （断言：signalSource 仍为 root；signal 以 taskText 开头；含文件；不含第 3 个文件；不含通用工具名；
    signals.task = 原话、signals.entity = 硬实体、signals.composite = 默认信号）
```

## 6 · 诚实的边界（别把 77% 当"任务理解能力"）

1. **增益 100% 来自实体**：composite 与 entity-only 在 self 子集上命中数相同（69）。原话那一段**贡献 0 次命中**。
2. **实体的来源是"该局自己的主题"**：它测的是"给一个该局触碰过的文件/错误码，能不能找回该局的教训"——**文件级召回**，不是"给一句中文任务，能不能想到该局"。后者仍是 task 口径的 **49.12%**。
3. 两个数都对：**49.12% 是冷启动能力，77.19% 是文件级召回能力**。报主判据时应当两个都写，不能只写大的那个。

## 7 · 复现

```bash
node --test "test/a2b-holdout.test.mjs"   # 13 条
node scripts/a2b-holdout.mjs              # composite 口径：n=114 / 77.19%
node scripts/a2b-holdout.mjs --compare    # 三路对照（task / entity / composite）
```
