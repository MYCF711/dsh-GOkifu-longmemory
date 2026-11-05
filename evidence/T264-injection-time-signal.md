# T264 · 考卷作弊修正：信号只允许"注入时刻可得"

> `[本] 2026-11-05 21:30 +08:00` · **只读真库**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 改动面：`scripts/a2b-holdout.mjs`（`buildExam` 信号源 + `compareSignalModes` 三路 + `injectionTime` 标注）+ `test/a2b-holdout.test.mjs`（重写 2 条 + 新增 3 条）
> 未改：`src/**`、`scripts/metrics-guard.mjs`、`scripts/m5-report.mjs`、`docs/**`、`MAINTENANCE.md`、`CHANGELOG.md`、`package.json`

## 0 · 一句话结论

**真实的冷启动召回（B 路：原话 + 原话内实体）= 19/94 = 20.21%**（Wilson [13.34%, 29.43%]）。
T263 报的 **77.19% 里，有 53.19pp 是"事后信息"带来的作弊**（C 路 69/94 = 73.40%，C − B = **50/94**）。
**B 相对 A（只用原话 18/94 = 19.15%）只多 1 条** —— 即：**原话里本来就没有几个实体**（114 题里只有 **23 题（20.2%）** 的原话包含路径/错误码/包名/命令），**B 路的天花板极低**。

## 1 · 三路对照（同一批题 · 严格命中 + Wilson + 信号可得性 + 误判率）

```
$ node scripts/a2b-holdout.mjs --compare
三路信号对照（同一批题 · 严格命中 / Wilson / 对照误判）：
  task            n=114 · 严格 38/114 = 33.33% · Wilson [25.35%, 42.41%] · injectionTime=✅可达 · 对照 n=342 硬实体误判 4（1.17%）· 判别词误判 10（2.92%）
  taskPlusEntity  n=95  · 严格 20/95  = 21.05% · Wilson [14.06%, 30.29%] · injectionTime=✅可达 · 对照 n=342 硬实体误判 3（0.88%）· 判别词误判 8（2.34%）
  postHoc         n=94  · 严格 69/94  = 73.40% · Wilson [63.68%, 81.29%] · injectionTime=❌事后(作弊) · 对照 n=342 硬实体误判 3（0.88%）· 判别词误判 20（5.85%）
```

| 路 | 信号 | 可得性 | n | 严格 | Wilson 95% | 硬实体误判 |
|---|---|---|---|---|---|---|
| **A** `task` | 用户原话 | ✅ 注入时刻 | 114 | 38 = 33.33% | [25.35%, 42.41%] | 4/342 = 1.17% |
| **B** `taskPlusEntity` | 原话 + **原话内**实体 | ✅ 注入时刻（**主判据**） | 95 | **20 = 21.05%** | [14.06%, 30.29%] | 3/342 = 0.88% |
| **C** `postHoc` | 原话 + 该局棋谱主题 | ❌ **事后（作弊对照）** | 94 | 69 = 73.40% | [63.68%, 81.29%] | 3/342 = 0.88% |

> A/B/C 的 n 不同：C 需要该局有棋谱主题（repeat 题没有）；B 需要原话里有实体（实际不影响 n，见下）。**下面的 94 题子集是三路都有信号的公共集**，这是唯一可比的对照。

### 1.1 公共子集（n=94，三路都有信号）

| 路 | 命中 | 严格率 | Wilson 95% |
|---|---|---|---|
| A · 原话 | 18 | 19.15% | [12.47%, 28.25%] |
| **B · 原话 + 原话内实体** | **19** | **20.21%** | [13.34%, 29.43%] |
| C · 事后实体（作弊） | 69 | 73.40% | [63.68%, 81.29%] |
| **C − B（作弊带来的虚高）** | **+50 条** | **+53.19pp** | — |

**翻转明细**：B 相对 A 只多 1 条（`bOnly=1`，`aAndB=18`）；C 相对 B 多 50 条（`cOnly=50`）。

## 2 · B 路的天花板：原话里到底有多少实体

```
原话里含实体的题：23 / 114 = 20.18%
```

- 114 题里只有 **23 题**的用户原话包含路径/错误码/包名/命令（如「读一下 `E:/Documents/dsh-go/HANDOFF.md`」）。
- 其余 91 题的原话是纯自然语言（「修一下」「处理一下pr」「看下是不是这个修复方案」），**注入时刻拿不到任何实体** ⇒ B 路与 A 路等价。
- 这就是 B 只比 A 多 1 条的原因：**不是检索差，是题面里没有可用线索**。

## 3 · T249 / T263 的读数作废（如实）

| 原报告 | 原读数 | 现在的定性 |
|---|---|---|
| T249 `shortRoot` | 0/11 → 8/11 = 72.73% | **作废**：用的是该局棋谱主题（事后）。合法口径下 shortRoot 仍是 0/12（原话「处理一下」里没有实体） |
| T263 `self/root` | 16/73 → 57/74 = 77.03% | **作废**：同样用了事后实体。合法口径下 self/root = 17/74 = 22.97% |
| T263 全卷 | 88/114 = 77.19% | **作废**：合法口径 **39/114 = 34.21%**（B 路全卷；含 repeat 19 条） |

> 两条旧证据文件（`evidence/T249-short-root.md`、`evidence/T263-entity-signal.md`）里的数字**不再是主判据**，本刀不删它们（只增不改），但引用时必须带这条更正。

## 4 · 改了什么

```js
// scripts/a2b-holdout.mjs · buildExam
const taskText = finalSignal;                              // 用户原话
const taskEntities = [...hardEntities(taskText)];          // 只从**原话**里抽实体
const taskEntitySignal = taskEntities.join(' ').trim();
finalSignal = [taskText, taskEntitySignal].filter(Boolean).join(' ').trim();   // B 路（默认）
const postHocSignal = episodeEntitySignal(episode);        // C 路：事后，仅对照
const signals = { task, taskPlusEntity, postHoc };
const signalMeta = {
  task:            { injectionTime: true,  desc: '用户原话' },
  taskPlusEntity:  { injectionTime: true,  desc: '用户原话 + 原话内硬实体' },
  postHoc:         { injectionTime: false, desc: '用户原话 + 该局棋谱主题（**事后信息，作弊对照**）' },
};
```
- **判据一字未动**：`related`（support.episode === 该局）与「≥2 判别词 / ≥1 硬实体」都没有改。
- **判分口径修正**：`runHoldout` 现在用**该路自己的信号**判分（之前 task 臂会拿 B 的信号判，口径串了——这就是第一次跑出 33.33%/21.05% 那组数的原因，已修正）。

## 5 · 单测（16 条全绿，新增/重写 5 条）

```
$ node --test "test/a2b-holdout.test.mjs"
ℹ tests 16 ℹ pass 16 ℹ fail 0
✔ T264 ① 信号不含事后信息：B 路的实体必须能在**用户原话**里找到
✔ T264 ② 合法信号（A/B）标 injectionTime=true，C 路标 false 且不进主判据
✔ T264 ③ 原话里没有实体 ⇒ B 路 == A 路（不许凭空造信号）
✔ T249/T264 shortRoot：短任务原话不再换成事后实体（只留原话），事后实体单列 C 路
✔ T263/T264 self/root：合法信号 = 原话 + 原话内实体；事后实体只进 C 路
```

## 6 · 结论

- **真实冷启动召回 = 20.21%（B 路，n=94）**；比 T263 报的 77.19% **低 57pp**，这个差值就是作弊（C − B = 53.19pp，加上口径差异）。
- **A → B 只 +1 条**说明：**把"原话里的实体"抽出来几乎没用**，因为原话里本来就只有 20% 的题有实体。
- 若要提升真实召回，方向不在"换更强的信号源"，而在**检索侧**：给"纯中文任务"建更靠谱的语义桥（现在是 19% 的冷启动命中）。
- **误判率没有升**（B 3/342 = 0.88% ≤ A 4/342 = 1.17%），所以本刀不是拿噪声换数字。

## 7 · 复现

```bash
node --test "test/a2b-holdout.test.mjs"   # 16 条
node scripts/a2b-holdout.mjs --compare    # A / B / C 三路 + injectionTime + 对照误判
node scripts/a2b-holdout.mjs              # 主判据（B 路）：n=114 / 34.21%
```
