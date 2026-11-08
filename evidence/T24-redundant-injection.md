# T24 · redundant 重复注入轴测量（MemUse 应用）

> 日期：2026-11-08 · 数据源：`<DSH_HOME>/memory-context/live-stats.jsonl`（**冻结快照 20593 行 / 末行 13:04:47**）+ 会话日志逐帧解（943 个会话，`source.kind=dsh-gokifu-longmemory` 的注入消息）
> 依据：知识库 92（arXiv:2611.01718《MemUse》）· `Novelty = 相对 B_d（先前上下文）`，`redundant = 重复既有信息`；Mem0「仍在 agent 上下文中的条目的副本」占投递 token **68.1%**。

| 口径 | 重复次数率 | 冗余 token 率 |
|---|---|---|
| **A. scope 级**（`live-stats.digest`：同 scope 同卡再次投递） | **36.23%**（471 / 1300） | **31.84%**（82 323 / 258 541） |
| **B. 会话级**（MemUse redundant：同 session 内同卡再次投递） | **5.76%**（76 / 1319） | **4.18%**（10 961 / 262 386） |
| B₁ 其中「**确定浪费**」（两次注入之间无任何压缩事件） | 52 / 1319 = **3.94%** | **2.80%**（7 348 / 262 386） |
| B₂ 其中「压缩后必要重注」 | 24 / 1319 = 1.82% | 1.38%（3 613） |

> **一句话**：live-stats 的 digest 重复率看着接近 MemUse 的量级（31.8% token），但**它不是 MemUse 的 redundant**——它的主体是"同一 scope 的多个会话各自第一次拿到同一张卡"（有益）。真正的 **context 内冗余只有 4.18% token，其中确定浪费 2.80%**。根因是一个 bug：`oncePerSession` 用 `WeakSet<session 对象>` 判身份，同进程内每步 session 对象变了 ⇒ 同一会话被反复注入（详见 §五）。

---

## 一、口径与数据源（先把两把尺子分开）

1. **`digest` 的含义**：`digestOf(scope, cardText(card)) = sha256(scope + '\0' + indexLine + '\n' + section)`。**同一 scope + 同一卡正文 ⇒ 同 digest**。
   ⚠ 它含 `indexLine` 里的「N 局」——库每次 autoArchive 刷新都会改这个数 ⇒ **同一张"概念上的卡"在刷新前后 digest 不同**。实测 `card-samples`：**79 个 section 对应多个 digest**（unique section 651 vs unique digest 805）⇒ **digest 口径会低估重复率，本报告的 36.23% / 31.84% 是下界**。
2. **只算真实插件**：`src=index.js`（生产）。剔除 `sim-inject.mjs` 3 条、`probe-new-host.mjs` 2 条（测试/探针写入）。
   - `index.js` 的 `inject` = **1300 次 / 258 541 tokens**（13:04:47 前）。
3. **会话级口径**：从会话日志里找 `user/message` 且 `data.source.kind === 'dsh-gokifu-longmemory'` 的注入消息 —— **`source.digest` + `session.id` 都在日志里**，这是唯一能区分"同会话重复"与"跨会话重复"的源。
   - 943 个会话，**1319 次注入 / 830 个 (scope,digest) 键 / 262 386 tokens**。
   - 比 `live-stats` 的 1300 多 **19 次**：最可能是 `repeatHint`（D5）的补卡 —— 它走 `decidePreStep` 但**不写 `live-stats`**（`src/plugin.mjs` 的 D5 分支在写心跳之前 `return inner.decision`）。
4. **压缩事件**：`compaction/start` 与 `compaction/prune`（每会话可多次）。用于 §五 的"必要 vs 浪费"判定。

---

## 二、① scope 级重复（`live-stats` 的 digest 口径）

| 指标 | 数值 |
|---|---|
| `inject` 次数 | **1300** |
| 不同 `(scope,digest)` 组 | **829** |
| 其中重复组（同组 ≥2 次） | **165**（占组数 19.9%） |
| 重复组的注入次数 | 636 |
| **多余注入次数**（每组 `count-1` 求和） | **471** |
| **重复占比（次数）** | **471 / 1300 = 36.23%** |
| 总注入 tokens | **258 541** |
| **冗余 tokens**（每组 `(count-1) × tokens`） | **82 323** |
| **冗余占比（token）** | **82 323 / 258 541 = 31.84%** |

**每组次数分布**（次数:组数）：1×664 · 2×95 · 3×29 · 4×8 · 5×9 · 6×5 · 7×4 · 8×2 · 9×4 · 12×1 · 13×1 · 14×2 · 15×1 · 16×1 · 17×1 · 23×1 · **48×1**。

**Top 8 重复组**（同一 scope + 同一 digest）：

| 次数 | tokens | digest | scope | 时间跨度 |
|---|---|---|---|---|
| **48** | 149 | `b8ee299540233c9f` | GOkifu上下文压缩 | 11-05 02:57 ~ 13:47 |
| **23** | 114 | `08840121f2c29be4` | 长期记忆系统 | 11-05 06:21 ~ 13:06 |
| 17 | 140 | `34ff49377ee1b232` | default-workspace | 11-05 21:33 ~ 11-06 03:46 |
| 16 | 192 | `8bf6aaab1214fc5f` | default-workspace | 11-05 02:57 ~ 13:01 |
| 15 | 149 | `e846acb4ccf91e2c` | GOkifu上下文压缩 | 11-05 21:21 ~ 11-06 11:37 |
| 14 | 146 | `06562df1eb5196e0` | 长期记忆系统 | 11-05 04:51 ~ 13:06 |
| 14 | 114 | `bb495c04d5f3d4f9` | 长期记忆系统 | 11-05 22:09 ~ 11-06 11:48 |
| 13 | 163 | `5f3ebaf3db1590af` | GOkifu上下文压缩 | 11-07 20:45 ~ 11-08 00:40 |

> **关键**：这些"48 次 / 23 次"里，**同一 session 只占很小一部分**（见 §五）——绝大部分是同一 scope 下**多个不同会话**各注入一次。

---

## 三、② 按 scope / 按天：哪些最严重

### 按 scope（按冗余 token 排序）

| scope | 组数 | 重复组 | inject | 多余次数 | 重复率(次) | 总 tokens | 冗余 tokens | 冗余率(token) |
|---|---|---|---|---|---|---|---|---|
| `default-workspace/DSH-GO` | 378 | 71 | 512 | 134 | 26.2% | 115 072 | 29 546 | 25.7% |
| `default-workspace/GOkifu上下文压缩` | 66 | 23 | **203** | 137 | **67.5%** | 33 510 | 21 251 | **63.4%** |
| `default-workspace/长期记忆系统` | 85 | 32 | 200 | 115 | **57.5%** | 29 144 | 15 782 | **54.2%** |
| `e:/Documents/deepseek-harness/default-workspace` | 71 | 17 | 129 | 58 | 45.0% | 23 936 | 9 710 | 40.6% |
| `default-workspace`（根） | 146 | 14 | 162 | 16 | 9.9% | 35 216 | 3 441 | 9.8% |
| `反代/wps` | 26 | 2 | 31 | 5 | 16.1% | 7 501 | 1 373 | 18.3% |
| `反代`（根） | 36 | 5 | 41 | 5 | 12.2% | 8 796 | 927 | 10.5% |
| 其余 4 个反代子域 | 21 | 1 | 22 | 1 | 4.5% | 5 366 | 293 | 5.5% |

**最严重 3 个**：`GOkifu上下文压缩`（63.4% token）、`长期记忆系统`（54.2%）、`e:/Documents/...`（40.6%）。
共同点：**都有"长期项目主会话"**（同一 session 跨多天、多轮），而 `default-workspace` 根 / 反代多为一次性任务会话（≈10%）。

### 按天（每组按首次注入日归属）

| 日期 | 组数 | 重复组 | inject | 多余次数 | 冗余率(token) |
|---|---|---|---|---|---|
| 11-04 | 195 | 38 | 268 | 73 | 28.6%（17 217 / 60 253） |
| **11-05** | 273 | 79 | **580** | **307** | **47.3%**（48 257 / 102 107） |
| 11-06 | 139 | 21 | 168 | 29 | 16.1%（6 083 / 37 707） |
| 11-07 | 109 | 11 | 143 | 34 | 19.7%（5 849 / 29 703） |
| 11-08 | 113 | 16 | 141 | 28 | 17.1%（4 917 / 28 771） |

**11-05 是峰值日**（47.3% token）——当天正好是几个长期主会话（`634616f8` / `8ef298d6` / `8fe881d1` / `ae858f87`）跑得最密的时段。

---

## 四、③ 冗余 token 估算（两个口径 + MemUse 对照）

| 口径 | 冗余 token | 分母 | 冗余率 |
|---|---|---|---|
| **A. scope 级**（同 scope 同卡再投） | 82 323 | 258 541 | **31.84%** |
| **B. 会话级**（同 session 同卡再投 = MemUse `redundant`） | 10 961 | 262 386 | **4.18%** |
| B₁ 确定浪费（无压缩） | 7 348 | 262 386 | **2.80%** |
| B₂ 压缩后必要重注 | 3 613 | 262 386 | 1.38% |

**与 Mem0 的 68.1% 对照**：我们的 **restatement share（会话级）= 4.18%**，**只有 Mem0 的约 1/16**。
但**scope 级 31.84% 不能拿去比** —— MemUse 的 `Novelty` 参照系是 `B_d`（agent 当时能看到的上下文），不是"同 scope 的其他会话"。把 31.84% 当 redundant 会**高估 7.6 倍**。

---

## 五、④ 有益 vs 浪费：判据、结果、根因

### 判据（机械、可复算）

| 判定 | 判据 | 含义 |
|---|---|---|
| **有益（跨会话）** | 同一 `(scope,digest)` 出现在 **≥2 个不同 session id** | 每个会话的上下文是独立的一份，第一次拿到这张卡是必要的 |
| **浪费（同会话，确定）** | 同一 `session id` 内同 digest 再投，且两次注入之间**没有** `compaction/start` / `compaction/prune` | 卡必然还在该会话的上下文里 ⇒ 纯重复 |
| **必要重注（同会话，压缩后）** | 同一 session 内再投，但期间**有**压缩事件 | 压缩可能把卡挤掉 ⇒ 重注是必要的（**上界**，因为压缩不一定恰好压掉这张卡） |

### 结果

| 类别 | 次数 | tokens | 占会话级总 token |
|---|---|---|---|
| **跨会话**（有益）：172 张卡 / 651 次注入 | 多余 **479** 次 | — | — |
| **同会话**（redundant）：76 次 | 76 | 10 961 | 4.18% |
| ├ 无压缩（**确定浪费**） | **52** | **7 348** | **2.80%** |
| └ 压缩后（必要重注，上界） | 24 | 3 613 | 1.38% |

**按 scope 看同会话重复**：

| scope | inject | 同会话重复 | 占该 scope | 其中无压缩（浪费） |
|---|---|---|---|---|
| **长期记忆系统** | 200 | **69** | **34.5%** | 46 次 / 5 932 tokens |
| GOkifu上下文压缩 | 203 | 1 | 0.5% | 0 |
| default-workspace | 162 | 1 | 0.6% | 1 |
| DSH-GO | 532 | 2 | 0.4% | 2 |
| e:/Documents/... | 128 | 1 | 0.8% | 1 |
| 反代/wps | 31 | 2 | 6.5% | 2 |

### 根因：`oncePerSession` 的 `WeakSet` 用**对象身份**，同进程内拦不住

`src/plugin.mjs`：

```js
const injected = new WeakSet(); // 每会话只注入一次（对象身份；WeakSet 不留引用）
...
const session = payload?.agent?.session ?? payload?.session ?? null;
...
if (config.oncePerSession && session && injected.has(session)) return decision;
...
if (session) injected.add(session);
```

`DEFAULT_CONFIG.oncePerSession = true`，desktop profile 的 `cordis.patch.yml` 没有覆盖它。
**如果 session 对象在每一步都是同一引用，同一会话最多注入一次**；但实测：

- 长期记忆系统的 **69 次同会话重复，按 `(digest, at±2s)` 匹配 `live-stats` 的 pid —— 69/69 全部是同一个 pid、0 次跨进程**。
- 也就是说：**同一宿主进程内、同一 `session.id`、同一张卡，被反复注入**（如 `634616f8` 注入 35 次 / 19 个不同卡，`08840121f2c29be4` 一张卡在同一会话内投 9 次，跨 6 小时）。
- 唯一的解释：**`payload.agent.session` 每步是新对象**（或包装对象），`WeakSet.has()` 永远 false ⇒ `oncePerSession` 实际失效。

> 这也解释了任务里那句「oncePerSession 命中后 decidePreStep 不再跑，所以重复主要发生在哪」：
> **设计上**应该只剩"跨会话"（不同会话各一次）；**实测**因为 WeakSet 失效，还多出"同会话"这一档 —— 5.76% 次数 / 4.18% token，其中确定浪费 2.80% token。

> ⚠ 一条反向可能（已排除）：这些长会话是否跨宿主重启（重启后 `WeakSet` 清空是合理重注）？—— 不是：69/69 次重复都落在**同一 pid** 内，重启会换 pid。

---

## 六、⑤ 是否值得加 `A1.redundant` 轴进 metrics-guard

### 建议：**加，但必须按"会话级"口径，并且先修 `oncePerSession` 的 WeakSet**

**为什么加**（有消费者、有动作）：
- 知识库 92 §九.3 已把 `redundant` 列为可执行建议；它和 `A1.stale` / `A1.opposite` 是**正交**的三根轴（衰减/方向/重复），现有 metrics-guard 缺这一根。
- 实测 **4.18% token 是 context 内冗余、2.80% 是确定浪费**（全部来自长期记忆系统的长会话）—— 绝对值不大，但**这是 bug 的直接度量**：修好 `oncePerSession` 后它会掉到接近 0；如果修了不掉，说明还有别的重复源（比如 D5 补卡与主路径撞车）。这正是"指标先有消费者"要的形状：**指标 → 发现 bug → 修 → 指标归零**。
- 具体消费者与动作：
  1. `scripts/patrol.mjs` / 六轴巡检：加一行 `A1.redundant = 同会话同卡重复 token / 同会话总投递 token`，**分两个子指标** `redundantWaste`（无压缩）/ `redundantNecessary`（压缩后）；
  2. 阈值：`redundantWaste > 1%` ⇒ 红灯，**直接指向 `oncePerSession` 的回归测试**（用 `session.id` 而不是对象身份）；
  3. T12 的 `abstain.reason` 第 5 类 `redundant`（知识库 92 §九.2）：本报告的"会话级同卡"判据可直接复用（行级指纹 + `session.id` + 已注入集合）。

**为什么不能按 scope 级加**：
- scope 级 31.84% 的**主体是跨会话**（479 / 489 次多余都是跨会话）——这是设计使然（每个会话独立上下文），**没有任何消费者能把它改下去**；挂上去只会变成第二个"恒亮红灯、无人能修"的假指标（T11 报告 §六 的 `crossScopeWalk` 恒真就是前车之鉴）。
- 若非要报，只能作为**参考列**并明确标注"含跨会话，非 redundant 口径"。

**最小落地（不改代码也能先做）**：
- 本报告 §五 的三条机械判据已经能算；建议先在 `patrol.mjs` 里按"会话日志 + `source.digest`"出**只读**读数（零生产改动），观察 3 天；确认稳定后再进 metrics-guard 的硬阈值。

---

## 七、限制（不许当结论用）

1. **digest 覆盖 100%，但语义会漂移**：`index.js` 的 1300 条 `inject` **全部带 `digest`**（1300/1300）。但 `indexLine` 的「N 局」随时变 ⇒ 同卡不同 digest（实测 79 个 section 对多 digest）⇒ **36.23% / 31.84% 是下界**；会话日志口径也用 digest，同样低估（但会话内同卡的识别主要靠同一次会话内的稳定 digest，影响更小）。
2. **会话日志 1319 vs live-stats 1300 差 19**：D5 `repeatHint` 的补卡不写 `live-stats`（代码路径在写心跳之前 return）⇒ 两口径分母略有差。
3. **压缩判据是代理**：区间内有 `compaction/start|prune` ≠ 该卡一定被压掉；所以"必要重注 24 次 / 3 613 tokens"是**上界**、"确定浪费 52 次 / 7 348 tokens"是**下界**。
4. **`live-stats` 没有 session id**：`pid` 不是会话标识（一个宿主进程承载多会话）⇒ 同会话判定必须走会话日志；`live-stats` 只能用来给 tokens / pid 交叉核对。
5. **只读**：本报告不修改任何代码/配置/记忆库；脚本都在 `tmp/`。
6. **样本窗口**：`index.js` 的 `inject` 从 **11-04 05:24** 起才有（更早的心跳全是 `skip`，没有 `digest` 可算）⇒ 本报告窗口 = 11-04 05:24 ~ 11-08 13:04。

---

## 八、复现

```bash
# 0) 只读脚本（tmp/，不入 git）
node -e "const fs=require('fs');const r=fs.readFileSync('D:/DeepSeek Harness/home/memory-context/live-stats.jsonl','utf8').split(String.fromCharCode(10)).filter(Boolean).map(JSON.parse).filter(x=>x.src==='index.js'&&x.action==='inject');const g={};for(const x of r){const k=x.scope+'|'+x.digest;(g[k]=g[k]||[]).push(x)}let e=0,et=0,t=0;for(const v of Object.values(g)){const tk=v[0].tokens||0;t+=tk*v.length;if(v.length>1){e+=v.length-1;et+=tk*(v.length-1)}}console.log(r.length,Object.keys(g).length,e,(e/r.length*100).toFixed(2)+'%',et,(et/t*100).toFixed(2)+'%')"   # §二 / §三 数字
node tmp/t24-scan-inject.mjs "<会话目录>"                 # 从会话日志抽 source.kind=dsh-gokifu-longmemory 的注入
node tmp/t24-session-dup.mjs                             # 会话级重复 + token（需先跑各目录 scan 存 json）
node tmp/t24-pid-match.mjs                               # 同会话重复 → live-stats pid（证明 69/69 同 pid）
node tmp/t24-compaction.mjs                              # 重复对之间是否有 compaction 事件 → 浪费/必要

# 1) 关键复核点
#    - live-stats 里 src=index.js 且 action=inject：1300 条
#    - 会话日志 source.digest 去重后按 session 分组：同 session 内 count>1 的额外次数 = 76
#    - 长期记忆系统 scope 的 69 次同会话重复：pids 全部相同
```

**关键数（复核请对这四个）**：
- **scope 级**：1300 inject / 829 组 / 165 重复组 / 多余 **471** = **36.23%**；冗余 token **82 323 / 258 541 = 31.84%**
- **会话级**：1319 inject / 同会话重复 **76** = **5.76%**；冗余 token **10 961 / 262 386 = 4.18%**
- **确定浪费**：**52 次 / 7 348 tokens = 2.80% token**（上界 76 / 10 961 = 4.18%）
- **根因**：`oncePerSession` 的 `WeakSet<session 对象>` 失效 —— 长期记忆系统 69/69 次同会话重复全在同一 pid

---

## 九、一句话

**我们的 `redundant`（上下文内重复）只有 4.18% token、确定浪费 2.80%，远低于 Mem0 的 68.1%；真正让数字看起来吓人的 31.84% 是"同 scope 多会话各拿一次同一张卡"（有益，不是 redundant）。但这 4.18% 里藏着一个真 bug：`oncePerSession` 用对象身份判会话，同进程内根本没拦住 —— 所以 `A1.redundant` 值得加，前提是它按会话级算、并且加它的第一个动作就是逼出这个 bug 的修复。**
