# audit-13 · 独立审计（对象 0.173.0，2026-11-05）

> 审计员：precision-auditor（独立复核；**不采信** Lead/teammate 的结论，所有数字自己复算）
> `[本] 2026-11-05 12:30 +08:00` · 对象：0.173.0（距 audit-12 的 0.162.0 过了 11 个版本，其中 6 刀未经独立复核）
> 只读：未改源码/测试/文档/配置/记忆库；未跑全量 `node --test`；未重启 DSH。

## 0 · 一句话结论

**0.173.0 还不能算"可交付"：六处里 ⑤（T211 ④c 换口径）不通过 —— 合流写真库之后，`merge-acceptance` 的默认 `--source` 就是影库本身，④a/④b 变成"拿影库对比它自己"（必然全过），④c 的"有证据 86.7%"把 1 换 1 冒泡也算成收益（同一份 JSON 里 `savedTotal` 只有 7 行、真省行的组只有 4/25）。** 其余五处：① 有条件通过、② 有条件通过（索引无消费者）、③ 通过、④ 通过、⑥ 有条件通过。
**好消息**：audit-12 的最严重项（闸 4 的 `mergedInto` 自证豁免）已被 **T198 修好**，实测复现确认。

**最严重的一条**：④ 的四条验收在默认参数下**失去了对照组** —— `--store` 与 `--source` 指向同一份数据时，④a `worse=[]`、④b `losses=[]`、`saved=0` 是**恒真**，不是"没发现问题"。
**如果只能修一条**：让 `merge-acceptance` 在 `sourceRoot === shadowRoot`（或两库 claim 集合相同）时**直接拒绝运行**（exit 2），强制 `--source` 指向合流前快照；否则这套验收的所有读数都不成立。

## 1 · 对象一致性

```
$ node -e 'console.log(require("./package.json").version)'          → 0.173.0
$ node -e 'console.log(require("…/dsh-gokifu-longmemory/package.json").version)' → 0.173.0
```
`src/rooms/*.mjs` 19 个文件逐一比对 **19/19 SAME**：

```
adjudicate 5896db26 · claim 35e68564 · cli 6ef3ca4d · consolidate 00c9f5d1 · episode 07f4cee6
extract 92404b2c · gates ff4e8b89 · graphread 99ae5c20 · index f6a3c2ae · inject ee337322
joseki 0cdcd822 · link d0474247 · logread e6c597ab · persist 25a4bab0 · sigindex 5aa00dd9
thread c7a7b6c7 · topic c37d94fc · view 39f224d9 · walk 82c48e9e
```
关键 scripts 也一致：`eval.mjs 3284b95f` · `merge-acceptance.mjs 49df3bbd` · `kifu-profile-stage.mjs d7ba8f5f` · `metrics-guard.mjs 02c606a5` · `a1-stale-audit.mjs c7d8913d`。

数据：真库 `claims=1379 · mergeNodes=39`；影库 `tmp/shadow-all2` 同为 `1379 · 39`，两库 claim id 集合 **只在源 0 / 只在影 0**（同一批数据）。

## 2 · 六处逐项判定

### ① T207 触发面 P(≥2)→P(≥1) —— **有条件通过**

**"1 换 1 冒泡真的不增行"成立**（用"整库无合并节点"的反事实对照，39 组逐组建卡）：

```
{ "groups": 39, "rowsMerged": 87, "rowsNoMerge": 88, "savedByCollapse": 1,
  "sameGroups": 38, "fewerInMerged": 1, "moreRowsInMerged": 0 }
```
- 0 组因为折叠而多行；38/39 行数不变；只有 1 组真的少 1 行。**39 组总共省 1 行。**

**但冒泡要花 token**（`代表 N 条 · 详见 c-xxx · ` 前缀）：

```
{ "groups": 39, "tokMerged": 7683, "tokStripped": 7660, "tokenWorse": 16 }
```
16/39 张卡 token 上升（合计 +23）；生产预算 500 下复测 `groupsWithRowDiff: 2 / groupsWithOmittedDiff: 0`（两处差异都是多成员组真的少一行，不是预算挤掉的）。

**`mergeStats` 四个计数**：

```
membersHit == collapsed：39/39 一致
bubbled 只在 1 成员组出现（22 组）
candidatesHit：39/39 全为 0  ← 结构性死值
```
`candidatesHit` 数的是"命中的 claim 是合并节点"，但 T191 起 walk 已把合并节点替换成成员 ⇒ 该计数在现网**恒为 0**，作为实验信号没有信息量。

### ② T208 反向索引 —— **有条件通过**

时序：`readDirSafe` 内部 `.sort()`（`src/rooms/persist.mjs`）⇒ `claims` 顺序按 id 固定 ⇒ "先到先得"**可复现**（同输入同索引）。
A5 守卫在代码里成立（成员必须同 scopeKey 才建索引，跨域计入 `dropped.mergeCrossScopeMembers`），但**真数据没有锻炼到它**：

```
成员总数: 96 | 跨域成员: 0 | 记录不存在: 0
```
**问题：这个索引没有消费者。** `grep -rn mergeRepresentativeOf src/ scripts/ test/` 只命中 `walk.mjs` 自身与 `test/walk.test.mjs` —— 生产链路里没有任何地方用它。也就是说"反向索引 192× 快于全表扫"是为一条**不存在的快速路径**付的构建成本：每次 `walkFromSignals` 都多扫一遍全部 claim 的 merge 字段（本机 1379 条）。功能无害，但收益声明不成立。
**判定**：守卫与确定性通过；"消费价值"无法核实（缺消费者）。

### ③ T209 A1 谓词 —— **通过**

同一次运行里同时算新旧两种谓词：

```
runH1(新谓词): {"postGateInjected":98,"postGateStale":0,"postGateStaleRate":0,"postGateUnverified":2,"staleInjected":6,"unverifiedInjected":2,"staleTransferRate":0.057}
复刻(旧谓词 ok===false): {"injected":98,"stale":2,"byCategory":{"probe-gap":82,"legit":14,"probe-unverified":2}}
分母一致? true
```
- **分母没动**（98 = 98）✓
- **unverified 只计数**：`postGateUnverified=2`，不在分子（分子 2→0）✓
- 语义提醒：A1=0 的正确读法是"**没有可判定的 stale**"，不是"没有未知条目"——那 2 条 unverified 仍然到达模型、仍然不可知。

### ④ T210 探针候选面 —— **通过**

用"屏蔽 `<ws>/<name>/package.json` 这一面"的探针重算同一批 claim，得到口径差异 9 条：

```
{id: c-175d29e9, magpie-chatbox-ai@0.1.0,  old=version-file-unreadable, now=version-mismatch}
{id: c-8263d203, magpie-workbuddy@0.0.0-stage, old=unreadable, now=version-mismatch}
{id: c-87b3c5e8 / c-97fc2150 / c-9c5b7c51 / c-b3210317 / c-b5ae27cc / c-e3e72236, …→version-mismatch}
{id: c-df13d467, magpie-alysis-auth@0.1.12, old=unreadable, now=version-package-not-found}
```
- **8 条从"读不到"变成"真 stale"**（磁盘上确实版本变了，例：`反代/magpie-chatbox-ai/package.json` name 匹配、version 0.1.3 ≠ 声明 0.1.0）
- **ok↔不ok 翻转 0 条** ⇒ 没有把"真 fresh"变成"stale"
- 1 条只是 unreadable→package-not-found（同属 unverified，不影响闸 3）
- 候选顺序仍是 `node_modules` > 兄弟仓库 > 仓库自身 > profile ⇒ 装了依赖的以安装版为准，不会被兄弟仓库抢答。

### ⑤ T211 ④c 换口径 —— **不通过**

**问题 A（致命）：默认参数下没有对照组。**
```
源 claims 1379 · 影 claims 1379 · 只在源 0 · 只在影 0     ← 两库是同一批 claim
源库卡片自己也在折叠：3/8 组 collapse、3/8 组 bubbled     ← source 也含合并节点
```
`merge-acceptance` 的默认 `--source` 是 `<DSH_HOME>/memory-context`；合流写真库之后，它就是影库本身。于是：
```
$ node scripts/merge-acceptance.mjs --store tmp/shadow-all2 --sample 40 --json
ok: true | ④a worse=[] | ④b losses=[] lostRows=0 | ④c savedTotal=0 savedPositive=0 foldable=0 → "有证据（Wilson 86.7%）"
```
**`savedTotal=0` 与 `有证据` 出现在同一份 JSON 里** —— ④c 数的是"折叠动作发生过"，不是"省了行"。

**问题 B：冒泡被记成收益。**
```
④c: hitGroups 25 · collapsedGroups 25 · bubbledGroups 22 · collapsedRows 58 · bubbledRows 28 · ratio 1
```
25 个"折叠成功"的组里 **22 个是 1 换 1 冒泡**（净省 0 行）。换成真正的合流前快照（`memory-context.pre-T201`，1340 条、0 合并节点）再跑：

```
④c: hitGroups 25 · collapsedGroups 25 · ratio 1 · Wilson 下界 86.7% → "有证据"
     但 savedTotal=7 · savedPositive=4 · foldable=4     ← 真正省行的只有 4/25 组（16%）
④b: pass, groups 35, lostRows 0                          ← 这一条在真对照下仍然通过
```
即：**④c 的"86.7% 有证据"对应"16% 的组真省行"**。

**问题 C（可操纵性）**：把成员全砍掉时 `hitGroups=0` ⇒ 走 `证据不足` 分支（不是假绿，但也不红）。可接受，但和"通过"在仪表盘上混在一起。

**判定**：不通过 —— 口径把"触发"当"收益"，且默认参数失去了对照组。

### ⑥ T219 CLI fail-closed —— **有条件通过**

退出码矩阵（真 home 有 `yaml@2.9.1`；假 home 无引擎）：

```
A 真 home + 好文件   → 校验 OK（引擎 yaml@2.9.1 · 条目 18 个 · yaml 模块 可用）  exit=0
B 假 home           → 校验失败：✗ 没有 YAML 引擎…拒绝在没有真校验的情况下修改 patch  exit=6
C 假 home + --allow-structural → 校验 OK（引擎 fallback-structural · 条目 18 个 · yaml 模块 可用）  exit=0
```
- **fail-closed 成立** ✓：无引擎 ⇒ 退出 6，apply 脚本 `exit "$RC"` 透传，目标不动
- **文案对不上**：C 里 engine 明明是 `fallback-structural`，却仍打印「yaml 模块 **可用**」；而且 `--verify` 分支**不打印**那条 `⚠ 结构校验，不是 YAML 校验` 的 warning（`formatReport` 才打）
- **降级入口不唯一**：生成脚本里还有 `KIFU_ALLOW_STRUCTURAL=1` 环境变量（命令行上看不见的第二入口）
- **结构校验有缺口**：`- id: [unclosed`（条目级 flow 序列）**判 ok**，只有 `config: {a: 1` 这类键级未闭合才被抓到
- **F2 防线未武装**：实际 `tmp/apply-kifu-profile.sh` 里 `BASE_SHA="${KIFU_BASE_SHA:-}"` 为空 ⇒ "目标已被别人改过"分支**永远跳过**

## 3 · 横切：这 11 版里有没有"可被数据绕过"的闸/指标

| 项 | 结论 |
|---|---|
| **④a/④b/④c（merge-acceptance）** | **是** —— 默认 source==shadow ⇒ 三条全变恒真；见 ⑤ |
| 闸 4 `mergedInto` 自证豁免（audit-12 最严重项） | **已修**（T198）：节点不存在 ⇒ 不再豁免。实测 `基线 1 条错误 → 带 ghost 指针仍是 1 条错误`（修前是 0） |
| A1 分子 | 已对齐（unverified 出分子），但 0% 只代表"没有可判定的 stale" |
| 探针 version 候选面 | 加面无副作用（0 条 ok 翻转） |
| profile 校验 | 有引擎时真校验 ✓；无引擎 fail-closed ✓；但 `--allow-structural`/env 下只剩结构检查，且有缺口 |

## 4 · 未解决项清单

| # | 项 | 严重度 | 现状 |
|---|---|---|---|
| 1 | `merge-acceptance` 默认 `--source` 与 `--store` 同源 ⇒ ④a/④b 恒真 | **高** | 已发生（真库已含 39 合并节点） |
| 2 | ④c 把 1 换 1 冒泡计入"折叠收益"（25/25 vs 真收益 4/25） | **高** | 同上 |
| 3 | `candidatesHit` 恒 0（结构性死值） | 低 | 数据依赖 walk 行为 |
| 4 | `mergeRepresentativeOf` 无生产消费者（"192×"收益声明不成立） | 中 | 死值 + 每次 walk 建索引成本 |
| 5 | `--verify --allow-structural` 打印「yaml 模块 可用」且不打 warning | 中 | 文案误导 |
| 6 | `KIFU_ALLOW_STRUCTURAL` 是第二降级入口 | 低 | 隐式 |
| 7 | 结构校验漏 `- id: [unclosed` | 中 | 缺口 |
| 8 | `tmp/apply-kifu-profile.sh` 的 `BASE_SHA` 为空 ⇒ F2 防覆盖未生效 | **中高** | 需重新 stage 或者手工 `KIFU_BASE_SHA=…` |
| 9 | A1=0 的语义要在报告里写清（不是"没有未知条目"） | 低 | 文案 |

## 5 · 复算命令

```bash
# 一致性
for f in src/rooms/*.mjs; do sha256sum "$f"; sha256sum "<DSH_HOME>/profiles/desktop/node_modules/dsh-gokifu-longmemory/$f"; done
# ① 折叠行数/ token：用"无合并节点"的反事实 cache 对比（见脚本片段）
# ③ A1 新旧谓词：runH1 + a1-stale-audit 同跑
node -e '…runH1(...) 与 auditA1(...) 对比 postGateInjected…'
# ④ T210：屏蔽 <ws>/<name>/package.json 的探针重算 68 条 version claim
# ⑤ ④c：默认参数 vs 合流前快照
node scripts/merge-acceptance.mjs --store tmp/shadow-all2 --sample 40 --json
node scripts/merge-acceptance.mjs --store "$DSH_HOME/memory-context" --source "$DSH_HOME/memory-context.pre-T201" --sample 40 --json
# ⑥ fail-closed 矩阵
DSH_HOME=D:/nonexistent-t221-home node scripts/kifu-profile-stage.mjs --verify tmp/cordis.patch.staged.yml; echo $?
```
