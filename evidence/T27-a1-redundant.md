# T27 · A1.redundant 轴进 metrics-guard（**会话级**口径）

> 日期：2026-11-08 14:2x · 只读采集（会话日志 + store），只改 `scripts/m5-report.mjs` / `scripts/metrics-guard.mjs`
> 依据：`evidence/T24-redundant-injection.md`（会话级 4.18% / 确定浪费 2.80%；scope 级 36% **不是** redundant）
> 前置：`evidence/T25-once-per-session.md`（oncePerSession 的 WeakSet→`session.id` 修复，2026-11-08 13:25:37 合入 `f65aace`）

## 0 · 一句话结论

metrics-guard 现在打印 **A1 三轴**（stale | opposite | **redundant**），`A1.redundant` 按**会话级**口径给出两个子指标：**`redundantWaste`**（两次注入间无压缩＝确定浪费，**唯一卡口**）与 **`redundantNecessary`**（压缩后必要重注，只报不卡）。当前窗口（`max(T25 修复上线时点, now−24h)` = 13:25:37 起）读数：**14 次注入 / 2247 tokens / 2 对浪费（265 tokens = 11.8%）/ 0 对必要重注 ⇒ 未通电**（注入数 < 100 或 tokens < 20k）⇒ **不参与 exit code**（不硬造数）；guard 整体 PASS。**scope 级重复（同 scope 多会话各拿一次同一张卡）明确不计入**——那是每个会话的独立上下文第一次拿到它，有益。

## 1 · 口径（先把两把尺子分开）

| | **A · scope 级**（本轴**不用**） | **B · 会话级**（本轴用的） |
|---|---|---|
| 判据 | 同 `scope` + 同 `digest` 再次注入 | 同 **`session.id`** + 同 `source.digest` 再次注入 |
| T24 实测 | 36.23% 次数 / **31.84% token** | 5.76% 次数 / **4.18% token** |
| 是否 redundant | **否**：主体是"同一 scope 的多个会话各自第一次拿到同一张卡"（T24：479/489 次多余都是跨会话） | **是**：同一会话的上下文里已经有这张卡 |
| 为什么不能用 | 没有任何消费者能把它改下去 ⇒ 恒亮红灯的假指标（T24 §六 明确反对） | 消费者明确：`oncePerSession` 的 `session.id` 判据回归/部署 |

**两个子指标**（分开报，判据机械）：

| 子指标 | 判据 | 含义 / 用途 |
|---|---|---|
| `redundantWaste` | 同会话同 digest 相邻两次注入之间 **没有** `compaction/start|prune` | 卡必然还在上下文里 ⇒ 确定浪费（**下界**）。**卡口：> 1% ⇒ 红**，指向 `oncePerSession` 回归 |
| `redundantNecessary` | 期间 **有** compaction | 压缩可能把卡挤掉 ⇒ 必要重注（**上界**）。**只报不卡**（产品行为，不是回归） |

**窗口**：`max(T27 的窗口下界, now − 24h)`；窗口下界 = **T25 修复上线时点**（2026-11-08 13:25:37 +08:00，commit `f65aace`）。
为什么钉时点：修复前那份同会话重复是**已知已修 bug**，算进卡口会让红线永远亮着（等于没信号）。**更新约定**：以后每次修"重复注入源"（同类 `oncePerSession` 回归、D5 补卡撞车…），把 `A1_REDUNDANT_FIX_AT` 推到新上线时点并写进同一条证据/CHANGELOG；也可用 `KIFU_A1_REDUNDANT_SINCE`（epoch ms）覆盖（运维/测试用）。

**通电条件**（样本不足 ⇒ 不参与 exit code，与 A1.opposite 的"未通电"同形状）：
`窗口内注入数 ≥ 100` **且** `窗口内 tokens ≥ 20,000`。取值的理由：卡口是 1%，一条 117-token 的卡在 20k tokens 里只占 0.585% ⇒ **单次偶发不足以把闸打红**；反过来 20k 以下分母太小，一次重复就能"凑出"红灯。

## 2 · 实现（改了什么）

| 文件 | 改动 | 说明 |
|---|---|---|
| `scripts/m5-report.mjs` | 新增 `A1_REDUNDANT_AXIS_ID` / `A1_REDUNDANT_WASTE_MAX` / `A1_REDUNDANT_WINDOW_MS` / `A1_REDUNDANT_MIN_INJECTIONS` / `A1_REDUNDANT_MIN_TOKENS` / `A1_REDUNDANT_FIX_AT`；`A1_AXIS_IDS` 加第三项 | 常量与口径集中一处 |
| 同上 | 新增 `listSessionLogFiles` / `scanSessionInjections` / `summarizeRedundant` / `measureA1Redundant` | 采集=**会话日志**（`source.kind=dsh-gokifu-longmemory` 的 `user/message`：`session.id` 取目录名、`source.digest`、`at`、`estimateTokens(正文)`；`compaction/start|prune` 时点）；`summarizeRedundant` 是**纯函数**（无 IO，可复核）；mtime 预筛（窗口开始前没写过的会话不可能有窗口内事件） |
| 同上 | `runM5Body` 装配 `['A1.redundant']`；`a1Axes` 现在列出三条轴；文本表 + markdown §2b 各加一行/一段 | 渲染时**并列**展示，三轴各自一行 |
| `scripts/metrics-guard.mjs` | 新增限值 `a1RedundantWasteMax: 0.01`；读 `axes['A1.redundant']`；**缺轴 ⇒ 红**（tombstone）；**只在 `detail.powered` 为真时**用 `value > 1%` 卡；`necessary` 不卡 | 与 A1.stale / A1.opposite 并列，**它们的取值路径一字未改** |
| 同上 | `values` 新增 `a1Redundant` / `a1RedundantNecessary` / `a1RedundantPowered` / `a1RedundantN`；输出加一行 | 供 patrol / evidence/metrics-guard.json 消费 |

**数据源为什么必须是会话日志**：`live-stats.jsonl` **没有 session id**（`pid` ≠ 会话：一个宿主进程承载多会话）⇒ 判不了"同会话"；只有会话日志的 `session.id`（目录名）+ `source.digest` 能判。本轴零模型调用、不写库、不写 `live-stats`。

## 3 · 当前读数（2026-11-08 14:2x，窗口 13:25:37 起 ≈ 57 分钟；**快照，随线上注入增长**）

```text
A1.redundant=浪费 6.0% · 必要重注 0.0%（会话级同卡再投；n=12，未通电·不参与 exit code（窗口样本不足））
```

| 读数 | 值 |
|---|---|
| 窗口 | 2026-11-08T05:25:37Z ~ now（≈0.04 天；后续滚动 24h） |
| 注入 / tokens | **14 次 / 2247 tokens** |
| 有注入的会话 | 7 个（其中 2 个出现同会话重复） |
| `redundantWaste` | **11.8%**（**2 对** / 265 tokens） |
| `redundantNecessary` | 0.0%（0 对 / 0 tokens） |
| 合计 redundant | 11.8%（2 对；`dupRate` 2/14 = 14.3%） |
| **是否通电** | **否**（14 < 100 次、2247 < 20k tokens）⇒ 不参与 exit code |
| 扫描 | 20 个会话日志（mtime 预筛），坏文件 0 |

> 同一窗口在 6 分钟内的两次快照：`12 次 / 1951 tokens / 1 对 / 6.0%` → `14 次 / 2247 tokens / 2 对 / 11.8%` —— 分母还在长，读数会动；**未通电**时它只打印、不卡（这正是设计形状）。

**那 2 对浪费是什么（不等于"指标又坏了"，是部署事实）**——两对都是 `form=memory-card`（主路径，不是 D5 补卡）、期间 **0 次 compaction**：

| 会话 | digest | 两次注入（Z） | 间隔 | tokens |
|---|---|---|---|---|
| `221a2634…`（DSH-GO scope） | `e4b5f01bfe…` | 06:18:40 → 06:20:42 | **2.0 分钟** | 148 |
| `b14fcac5…`（GOkifu 压缩 scope） | `a2c5c427a7…` | 05:52:42 → 06:14:22 | 21.7 分钟 | 117 |

两对的事件形状与**T25 修复前**的失效形态一致（同 session 同 digest、主路径 `memory-card`、无压缩、短间隔重复）⇒ **运行中的插件仍是修复前的构建**：插件在宿主启动时加载，T25 是 13:25 才合入的，而本仓禁止重启宿主 ⇒ 新构建尚未生效。这与 T25 §6.1「`injectedIds` 是进程内 Set」一致。

⇒ 这是本轴**预期的消费路径**：修复部署后 waste 应趋 0；在部署前它如实报"旧构建还在重复"。**若通电（≥100 次）后仍 > 1%**，就按消费者动作查 `oncePerSession`（是不是又退回对象身份 / D5 补卡撞车）。今天未通电 ⇒ 不红。

## 4 · 与 A1.stale / A1.opposite 并列（不改它们的值）

- 三轴在 guard 输出里并排打印（实测）：
  ```text
  约束条件 · A1=0 A5=0 A6=1 A4.p50=20.90ms
  A1 三轴 · A1.stale=0.0% A1.opposite=0.0%（可判率 20.9%，n=993，未通电·不参与 exit code（0 次触发 ≠ 无反向记忆））
      A1.redundant=浪费 6.0% · 必要重注 0.0%（会话级同卡再投；n=12，未通电·不参与 exit code（窗口样本不足））
  ```
- `A1`（stale）与 `A1.opposite` 的**取值路径**（`measureA1` / `measureA1Opposite`）与门槛（≤5%）未动；guard 只**新增**了第三条轴的读取与卡口。guard 的 `values` 里 `a1` / `a1Opposite` / `a1OppositeN` / `a1OppositeDecidability` / `a1OppositeDecisionGrade` 键值照旧。

## 5 · 卡口形状（合成报告，逐例实测）

| # | 形状 | 结果 | 说明 |
|---|---|---|---|
| a | 已通电 + `redundantWaste=2%`（>1%） | **FAIL** | `A1.redundant 冗余浪费 0.02 > 0.01（会话级同卡再投、期间无压缩；窗口 500 次注入）⇒ 查 oncePerSession 的 session.id 判据是否回归` |
| b | 已通电 + `redundantWaste=0.5%`（<1%） | PASS | 阈值生效 |
| c | **未通电** + `redundantWaste=50%` | **PASS** | 样本不足**不参与 exit code**（不硬造数，本条最关键） |
| d | 已通电 + `waste=0` + `necessary=30%` | PASS | necessary **不卡**（压缩后必要重注是设计行为） |
| e | 缺 `A1.redundant` 轴（`a1Axes` 仍声明） | **FAIL** | `A1.redundant 冗余注入轴缺失（tombstone：轴统计被删）` |
| f | 旧报告（无 `a1Axes` 标记） | PASS | 新契约不卡旧报告（向后兼容） |

### tombstone 实测（删轴统计 ⇒ guard 红）

把 `runM5Body` 里的 `[A1_REDUNDANT_AXIS_ID]: measureA1Redundant({ dataRoot, now })` 临时删掉（其余不动），跑 `node scripts/metrics-guard.mjs`：

```text
metrics-guard FAIL
  A1 三轴 · … A1.redundant=浪费 n/a · 必要重注 n/a（… n=null，未通电…）
ERR A1.redundant 冗余注入轴缺失（tombstone：轴统计被删）
exit=1
```

复原后 `node --check` 通过、guard 回到 PASS。⇒ **删掉该轴的统计，本闸必红**。

## 6 · 历史基线（T24，修复前全窗口）

| 口径 | 次数率 | token 率 | 备注 |
|---|---|---|---|
| scope 级（**不用**） | 36.23% | 31.84% | 98% 是跨会话（有益），**不是 redundant** |
| 会话级合计 | 5.76% | 4.18% | MemUse `redundant` 口径 |
| ├ 无压缩（浪费） | 3.94% | **2.80%** | 本轴卡口量的就是它（修复前） |
| └ 压缩后（必要） | 1.82% | 1.38% | 上界 |

本次另用**本轴实现**重算了一遍全窗口（窗口下界=0，只作对照）：`1333 次注入 / 282,305 tokens`，浪费 **54 对 / 8,330 tokens = 2.95%**、必要 25 对 / 4,061 tokens = 1.44%。
与 T24 的 2.80% / 1.38% 的差异来自 token 口径：本轴用**注入消息正文**按 R11 的估法（CJK 1.5 字/token、ASCII 4 字/token）计价，T24 用 `live-stats` 的 `tokens` 字段（卡片 tokens）。同一份数据、两种计价，**不影响"修复前 ~2.8–3.0%"的量级**，也不影响卡口（卡口只看窗口内比率）。

## 7 · 成本

| 项 | 实测 |
|---|---|
| `node scripts/m5-report.mjs --root $DSH_HOME --json` | **~44–50 s**（与改动前的量级相同；本轴不是主要开销） |
| 本轴本次扫描 | 20 个会话文件（≈0.4 s；mtime 预筛把窗口外的会话全部跳过） |
| 稳态（24h 窗口） | ≈270 个会话文件 ≈ 5 s（全库 1657 个文件全扫是 ≈30 s，预筛后不会到那一步） |
| 写入 | **0**（只读；m5 的唯一写入口仍是 `--evidence`） |

## 8 · 限制（不许当结论用）

1. **token 用消息正文估算**（与 `live-stats` 的卡片 tokens 差约 5–9%）——口径写清在 §6；比率不受系统性偏差影响，绝对值别与 T24 混用。
2. **compaction 判据是代理**：区间内有 `compaction/*` ≠ 那张卡一定被压掉 ⇒ `waste` 是**下界**、`necessary` 是**上界**（T24 §七.3 同款）。
3. **修复部署窗口**：宿主重启后 24h 内，窗口里可能还留着重启前的旧构建样本 ⇒ 通电后可能出现短暂红灯（≤24h）。这是"滚动窗口"的代价，不是新回归。
4. **D5 `repeatHint` 不受 `oncePerSession` 限制**（T25 §6.3）：若它的补卡与主路径同 digest，会计入 waste。今天这 1 对的 `form` 是 `memory-card`（主路径），不是 D5。
5. **digest 会漂移**：`indexLine` 的"局数"随 autoArchive 变化 ⇒ 同一张"概念卡"前后 digest 不同 ⇒ 本轴**低估**重复（T24 §一.1）。
6. **轴值语义**：`A1.redundant.value` = **`redundantWaste`**（卡口指标）；合计 redundant 与 `necessary` 在 `detail` 与 caveat 里单列。别看 value=6% 就以为"必要重注也算进去了"。
7. **未上线验证**：本轴的"修复后趋 0"只能在宿主加载新构建后观察（本仓禁止重启）；当前窗口数字是**旧构建**的读数。

## 9 · 消费者与动作（这轴是给谁看的、看了改什么）

1. **`oncePerSession` 回归**：`redundantWaste > 1%` 且通电 ⇒ 查 `src/plugin.mjs` 的会话判定是不是又退回**对象身份**（T25 修的就是 `WeakSet<session 对象>`），或有没有别的注入路径绕过 `injectedIds`（D5 补卡撞车）。修好/部署后 waste 应趋 0 —— **指标 → 发现 → 修 → 归零**，这就是"指标先有消费者"要的形状。
2. **发版/巡检**：`scripts/metrics-guard.mjs` 的 A1 三轴线（`evidence/metrics-guard.json` 的 `values.a1Redundant*`）；patrol 直接读 guard 的 JSON，无需新口径。
3. **将来 `abstain.reason` 的第 5 类 `redundant`**（知识库 92 §九.2）：行级判据可直接复用本轴的"`session.id` + digest + compaction 区间"三件套（本刀**不实现**，只留口径）。

## 10 · 复现

```bash
# 1) 六轴 + A1.redundant（只读；~45s）
node scripts/m5-report.mjs --root "$DSH_HOME" --json | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(JSON.stringify(j.axes['A1.redundant'],null,1))"

# 2) 护栏（打印 A1 三轴；缺轴/超阈值才红）
node scripts/metrics-guard.mjs

# 3) 卡口形状（合成报告，不跑语料）
node tmp/t27-judge.mjs            # a–f 六例

# 4) 会话级冗余原型（全窗口对照 / 逐对明细）
node tmp/t27-scan.mjs 0           # 全窗口（≈30s）
node tmp/t27-pairs.mjs 1794115537000   # 修复后窗口内的重复对明细

# 5) 测试
node --test test/m5-report.test.mjs test/metrics-guard.test.mjs
```

**关键数（复核请对这四个）**：
- 当前窗口（14:2x 快照）**14 次注入 / 2247 tokens / 2 对 waste（11.8%）/ 0 对 necessary ⇒ 未通电**；
- 通电下限 **100 次注入 & 20k tokens**；卡口 **waste > 1%**；`necessary` 不卡；
- 历史基线 **scope 级 31.84% ≠ redundant**；会话级 4.18%、waste 2.80%（T24）；
- 删轴 ⇒ `ERR A1.redundant 冗余注入轴缺失（tombstone：轴统计被删）`，exit=1。