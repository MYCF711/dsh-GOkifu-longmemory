# T19 · abstain 线上复验（T12 后误杀率闭环）

> 日期：2026-11-08 · 数据源：`<DSH_HOME>/memory-context/live-stats.jsonl`（**快照 19944 行，末行 10:11:59**）+ 会话日志逐帧解 + 生产链路离线重放（新旧判据并排）
> **结论先说：线上跑的仍是 pre-T12（0.8.49）代码 —— T12 未生效，没有"T12 后的线上误杀率"可报。**
> 线上 25 次 `abstain` **全部 `cross-scope`**；12 条能逐字节重建的拒绝，用旧判据重放 12/12 得 `cross-scope`（与线上一致），用 T12 后判据重放 **0/12** 得 `cross-scope`（其中 **4/12 根本不再拒**）⇒ 行为对不上 T12。

| 口径 | 数字 |
|---|---|
| 线上 `abstain` 总数 | **25 次**（07:09:53 – 10:10:07，全 `pid=25256`；任务书提到 T16 交付时 16 次 —— 09:38:24（T16 合入时点）回算是 22 次，16 次应为更早的统计时点） |
| 四类 `reason` 分布 | `cross-scope` **25** · `stale` 0 · `low-confidence` 0 · `no-relevant-claim` 0 |
| 抽最近拒绝 | **16 次**（09:00:48 – 10:10:07），其中 **12 次可逐字节重建**卡与信号 |
| **线上误杀率（旧代码口径）** | **4 / 12 = 33.3%**（按不同卡：1 / 4 = 25%）——**这是 pre-T12 的对照值，不是 T12 的** |
| T12 判据是否在线 | **否（线上未生效）** |

---

## 一、怎么证明"线上跑的是不是 T12 判据"（四条独立证据）

### 证据 1：进程启动时间 < T12 合入时间（时间线）

| 事件 | 时间 |
|---|---|
| 宿主进程 `pid=25256` 启动 | **2026-11-08 06:47:34** |
| 该进程首次写 `live-stats` 心跳 | 06:53:09 |
| **T12/T10 等合入 commit `e977859`（#492）** | **2026-11-08 08:21:27** |
| 全部 25 次 `abstain` | 07:09:53 – 10:10:07（**都在 `pid=25256` 内**） |
| 最新一次 `abstain` | 10:10:07（仍在 `pid=25256`） |

- `e977859^` = `47e03a9`（0.8.49，00:17:55），`git diff 47e03a9 e977859^ -- src/rooms/abstain.mjs src/plugin.mjs src/rooms/inject.mjs` **为空** ⇒ 宿主 06:47 启动时加载的是 0.8.49 的这三个文件。
- `packages/kifu-loader/index.mjs`（61 行）**没有 `watch` / `reload` / 热重载逻辑** ⇒ 不重启不会换代码。
- 08:00 之后写 `live-stats` 的 `pid` 只有 `25256` 一个 ⇒ 没有"新进程接棒"。

### 证据 2：结构判据 —— **新判据下 `abstain` + `cross-scope` 不可能同时成立**

T12 后的 `classifyAbstainReason`（`src/plugin.mjs`）：

```js
const droppedByScope = Number(walkResult?.crossScope ?? 0) + Number(walkResult?.unknownScope ?? 0);
const noInScopeHit = Array.isArray(walkResult?.hits) ? walkResult.hits.length === 0 : true;
if (droppedByScope > 0 && noInScopeHit) return 'cross-scope';
```

而 `abstain` 的触发条件（`decidePreStep`）里有 `card?.section` 非空这一项：

```js
if (config.abstainIrrelevant === true && hasReliableHandle(text) && card?.section && !hasRelevantClaim(card, text))
```

`card.section` 非空 ⇒ `buildMemoryCard` 的 `chosen.length > 0` ⇒ `hits` 里至少渲染出一条 ⇒ `walkResult.hits.length > 0` ⇒ `noInScopeHit === false` ⇒ **永远不会走 `cross-scope` 分支**。

⇒ 新代码下 `abstain` 的 reason 只可能是 `stale` / `low-confidence` / `no-relevant-claim`。
**线上 25/25 全是 `abstain/cross-scope`** ⇒ 只可能来自旧判据。

### 证据 3：重放判据 —— 同一条信号 + 同一张卡，新旧判据结论相反

从最近 16 次拒绝里重建出 **12 次**（卡 `digest` 逐字节一致），分别用**T12 前**（`git show e977859^:src/rooms/abstain.mjs`，即 0.8.49）与**当前 HEAD** 的 `hasRelevantClaim` + `classifyAbstainReason` 重放：

| 对照项 | 旧判据（0.8.49） | 新判据（T12 后） |
|---|---|---|
| 12 条的 `reason` 为 `cross-scope` | **12 / 12**（与线上心跳 12/12 一致） | **0 / 12** |
| 12 条里"会拒"（wouldAbstain） | **12 / 12** | **8 / 12**（4 条被 T12 判为相关，不再拒） |
| `reason` 取值 | 全 `cross-scope` | `low-confidence` 11 · `no-relevant-claim` 1 |

**如果线上是 T12，至少这 4 条不该出现拒绝；它们出现在 09:10–10:10 的线上心跳里 ⇒ 线上不是 T12。**

### 证据 4（旁证）：同一批 #492 里的 T10 也没生效

T10 把 `signalPreview` 从 160 上限改成 4096（自称"真实语料 495 条：>160 比例 0%→70.7%，p50 1106"）。
实测 `card-samples.jsonl` 在 **08:21:27 之后**的 19 条新样本：

| 指标 | 实测（应 ≈ T10 口径） |
|---|---|
| `signalPreview` 长度 min / p50 / p90 / max | **160 / 160 / 160 / 160** |
| `>160` 比例 | **0 / 19**（T10 口径应为 ~70.7%） |

⇒ 同一进程的 T10 与 T12 一起没生效，互相印证：**宿主没重启**。

---

## 二、`live-stats.jsonl` 读数（快照 10:11:59，19944 行）

| `action`/`reason` | 行数 |
|---|---|
| `skip`/`no-signal` | 18087 |
| `inject`/`null` | 1276 |
| `skip`/`no-hit` | 547 |
| `skip`/`gates-failed` | 9 |
| **`abstain`/`cross-scope`** | **25** |

**四类分布**：`cross-scope` 25 · `stale` 0 · `low-confidence` 0 · `no-relevant-claim` 0 —— **仍然全塌成 `cross-scope`**，与 T11 报告 §六 描述的老判据行为完全一致。

- 5 次在 07:09–07:11（T11 已核过的旧批次）；
- **19 次在 08:00 之后**（08:22:48 / 08:33:29 / 08:46:38 / 09:00:48 / 09:02:11 / 09:10:31 / 09:12:38 / 09:13:28 / 09:13:30 / 09:13:31 / 09:19:31 / 09:19:33 / 09:20:41 / 09:20:55 / 09:25:26 / 09:26:15 / 10:00:34 / 10:01:39 / 10:10:07）；
- 全部 `pid=25256`。

---

## 三、逐条核：最近 16 次拒绝（12 次可逐字节重建）

判定标准沿用 `evidence/T11-abstain-live.md` §五（强误杀 / 弱误杀 / 正确拒绝 / 无害拒绝）。本批 16 条信号**全部是用户侧消息**（任务分配、captain 协调、定时提醒），**没有无害拒绝**。

| # | 时间 | digest | tokens | 信号（会话日志原文摘要） | 卡上内容 | 判定 |
|---|---|---|---|---|---|---|
| 1 | 09:00:48 | `a2c5c427` | 114 | captain → annotator-b：按 `任务书-金标质量` 执行 index 4/5/6，只写 annotation 目录 | `fatal: '\主工作区\repos\dsh-GOkifu-k30-panel:task/k30-panel-guard' is not a valid branch name`（pointer，1 行） | **正确** |
| 2 | 09:02:11 | `43275e54` | 161 | 账本：annotator-a 任务（12 样本/92 原子事实/规则三审/时点检查） | `class:module-missing · Cannot find module './tmp/v1-validate.json'` | **正确** |
| 3 | 09:10:31 | `c15e36f9` | 147 | `[SCHEDULE REMINDER BATCH]` 每小时推进「棋院 / dsh-GOkifu-longmemory」第二阶段任务表（T9–T14） | `error: failed to push some refs to '…/dsh-GOkifu-longmemory.git' …/releases/tag/v0.2.41` | **误杀（弱）**：T14 就是 release 幂等 |
| 4 | 09:12:38 | `c15e36f9` | 147 | 同上（01:00Z 那一次） | 同上 | **误杀（弱）** |
| 5 | 09:13:28 | `a2c5c427` | 114 | captain → task t7：定时复核 T6、sample8 范围硬规则 | 同 #1 | **正确** |
| 6 | 09:13:30 | `a2c5c427` | 114 | 同上 | 同 #1 | **正确** |
| 7 | 09:13:31 | `a2c5c427` | 114 | 同上 | 同 #1 | **正确** |
| 8 | 09:19:31 | `a2c5c427` | 114 | captain → task t13：只登记 T6 发现与修订 DAG | 同 #1 | **正确** |
| 9 | 09:19:33 | `a2c5c427` | 114 | captain → task t10：t13 已完成，t10 可领取 | 同 #1 | **正确** |
| 10 | 09:20:41 | `d468371d` | 168 | **未能重建**（库刷新后 digest 漂移） | — | **无法判** |
| 11 | 09:20:55 | `6c5bc432` | 133 | **未能重建** | — | **无法判** |
| 12 | 09:25:26 | `463c91ec` | 132 | **未能重建**（同一时点在 09:25 的重放曾匹配 `7f4afd4d#1057`：annotator-d 汇报 t12 完成；现已漂移） | 曾重建：`git branch name` 错误 + `rm: … Device or resource busy` | **无法判**（若按当时重建稿：**正确**） |
| 13 | 09:26:15 | `a2c5c427` | 114 | captain → task t10（同上） | 同 #1 | **正确** |
| 14 | 10:00:34 | `c15e36f9` | 147 | 任务分配：`plugin-dev` / T10（团队目标含「release 幂等」） | `failed to push some refs …/releases/tag/v0.2.41` | **误杀（弱）** |
| 15 | 10:01:39 | `c15e36f9` | 147 | `[SCHEDULE REMINDER BATCH]`（02:00Z） | 同上 | **误杀（弱）** |
| 16 | 10:10:07 | `c15e36f9` | 147 | **未能重建**（同卡 `c15e36f9`，按同卡归并） | 同上 | **误杀（弱）**（按同卡判，标注为归并） |

**判定汇总（可核 12 条）**：误杀 4（全部为 `c15e36f9` 的 release/push 弱误杀）· 正确拒绝 8（`a2c5c427` 7 条 + `43275e54` 1 条）· 无法判 4（3 条重建失败 + 1 条同卡归并）。

> 为什么 `c15e36f9` 算"弱误杀"而不是"正确"：信号里明写「T14 = release 幂等」/团队目标含 `release`，而卡上正是 `failed to push some refs …/releases/tag/v0.2.41` —— 同一件事（release 失败），模型看到有实际用处。T12 的工具族桥也把它判为相关（`newRelevant=true`），与 T11 的判定标准一致。

---

## 四、线上误杀率（**旧代码口径**，不是 T12 的）

| 口径 | 计算 | 结果 |
|---|---|---|
| **按拒绝事件（可核 12 条）** | 4 / 12 | **33.3%** |
| 按不同卡（4 张卡：`a2c5c427`×7 / `43275e54`×1 / `c15e36f9`×4 / `463c91ec`×1 未判） | 1 / 3 可判 | **33.3%（1/3）** |
| 含"无法判"的保守上界 | (4+0) / 12 | 33.3%（无法判的 4 条不计入分子） |

**这不是 T12 的误杀率，不能拿去闭环 T12。** 它是"**pre-T12 代码在 08:22–10:10 这段真实流量上的误杀率**"。
与 T11 的 77.3% 不同口径也不可直接比：T11 是"33 条重放（覆盖 3 个团队 11 个会话）"，本批是"线上实际发生的 16 次（集中在 2 个 scope、4 张卡）"。

---

## 五、T12 生效后的预期（离线预测，**非实测**）

用当前 HEAD（T12 后）判据重放同一批 12 条：

| 项 | 旧（线上） | 新（T12 后） |
|---|---|---|
| 会拒 | 12 | **8** |
| `cross-scope` | 12 | **0** |
| `low-confidence` | 0 | 11 |
| `no-relevant-claim` | 0 | 1 |
| 误杀（按 T11 标准） | 4 | **0** |

> 注：`reason` 那四行是对 **12 条全算**的分布（含 4 条已不再拒的 `c15e36f9`，它们的新 reason 也记为 `low-confidence`）；"会拒"只统计 `wouldAbstain=true`。所以 `低置信 11 = a2c5c427 7 条 + c15e36f9 4 条`，其中只有 a2c5 的 7 条 + `43275e54` 的 1 条（`no-relevant-claim`）= **8 条仍会拒**。

⇒ **T12 若真正生效，本批 12 条会从"12 拒 / 4 误杀（33.3%）"变成"8 拒 / 0 误杀"**：4 条 `c15e36f9`（release 弱误杀）被工具族桥救回；剩下 8 条仍拒但 reason 变为 `low-confidence`（7）/ `no-relevant-claim`（1），不再全塌 `cross-scope`。

> 这只是离线预测，**不是线上验证**。要闭环 T12，必须重启宿主后再复测一次。

---

## 六、限制

1. **线上未生效**：本报告的"线上误杀率"只能作为 pre-T12 对照，不能用于 T12 的闭环。
2. **重建漂移**：记忆库每 30 分钟 autoArchive 刷新，`buildMemoryCard` 取的 claim 集合/decay 会变 ⇒ 同一信号在不同时刻重放可能得到不同 `digest`/`section`。16 条中 4 条因此无法重建（09:20:41 / 09:20:55 / 09:25:26 的重建稿在 30 分钟后漂移；10:10:07 按同卡归并）。
3. **信号重建是"同卡 + 旧判据会触发"的候选**：`digest` 逐字节一致 + 旧 `hasRelevantClaim=false` 才采信，但仍不能 100% 断言"这就是当次 pre-step 的 lastUserText"（同一张卡可由多条信号命中）。
4. **单人判**：误杀/正确按 T11 §五 标准由 live-analyst 单人判定，未做双人复核。
5. **只读**：所有脚本在 `tmp/`，`createStore` / `createWalkCache` 只读，未写 sidecar、未改任何代码。
6. **代码基线**：旧判据取自 `git show e977859^:src/rooms/abstain.mjs`（= `47e03a9`，0.8.49，与 `e977859^` 逐字节相同、`git diff` 为空）；新判据取自当前 HEAD `e977859` 的 `src/rooms/abstain.mjs` 与 `src/plugin.mjs` 的 `classifyAbstainReason`。重放时工作区 `src/plugin.mjs` 还有一段**未提交的 T20 改动**（消息语料上限），`git diff` 里 `classifyAbstainReason` / `hasRelevantClaim` 命中数为 **0**，不影响本报告判据。

---

## 七、结论与建议

**结论**：
1. T12 的判据**没有在生产运行**（宿主 06:47:34 启动，T12 08:21:27 合入，未重启；25/25 `abstain` 全是 `cross-scope`，而新判据结构上不可能产出 `abstain+cross-scope`）。
2. 线上 abstain **25 次，四类分布 25/0/0/0**（任务书提 T16 时 16 次；09:38:24 T16 合入时点回算 22 次；快照 25 次）。
3. 最近 16 次中可核 12 次：**误杀 4 / 12 = 33.3%（全为 release/push 弱误杀）**，其余 8 条正确拒绝 —— 这是 **pre-T12 的线上对照值**。
4. 若 T12 生效，本批预测 **12 拒 → 8 拒、误杀 4 → 0**。

**建议（T12 闭环需要做的唯一动作）**：
- **重启宿主**（用户侧操作；按本机 AGENTS 铁律 1，agent 不得自行重启 DSH）。
- 重启后的复验判据（三条一起看）：
  1. `live-stats.jsonl` 新增 `abstain` 的 `reason` **出现非 `cross-scope` 值**（`low-confidence` / `no-relevant-claim` / `stale`）；
  2. `card-samples.jsonl` 新样本 `signalPreview` **>160 的比例显著上升**（T10 生效的旁证）；
  3. 同一批卡（`a2c5c427` / `c15e36f9`）在新进程里重放，`wouldAbstain` 与线上心跳一致。

---

## 八、复现

```bash
# 0) 只读脚本（tmp/，不入 git）
node tmp/t19-best.mjs tmp/t19-targets.json          # 为每条 abstain 找最近同卡信号
node tmp/t19-old-new.mjs tmp/t19-targets.json       # 同信号+同卡：旧(0.8.49) vs 新(T12后) 判据并排
git show e977859^:src/rooms/abstain.mjs > tmp/abstain-pre-t12.mjs   # 旧判据来源（已导出）

# 1) 进程时间线
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | Select ProcessId,ParentProcessId"
git log -1 --format='%ci %s' e977859        # T12 合入 2026-11-08 08:21:27

# 2) 线上分布
node -e "统计 live-stats 的 action/reason 分布（见 §二 表）"
```

**关键数（复核请对这四个数）**：
- 线上 `abstain` = **25**，四类分布 **25 / 0 / 0 / 0**；
- 最近 16 次中可重建 **12** 条；
- 线上误杀率（旧代码口径）= **4 / 12 = 33.3%**；
- 新旧对照 = **旧 12/12 `cross-scope` vs 新 0/12 `cross-scope`、且新判据下 4/12 不再拒**。
