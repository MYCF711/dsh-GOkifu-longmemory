# T7a 报告 · R11 walk（顺藤摸瓜：深度 ≤2、失败优先、预算截断）

| 项 | 值 |
|---|---|
| 团队任务 | `task-6`（T7a） |
| 负责人 | path-walker（teammate） |
| 日期 | 2026-11-02（本机时区 Asia/Shanghai） |
| 分支 | `main`（共享工作树；按 Lead 规则**不切分支、不 commit**，文件保持未提交） |
| 测试 | `node --test test/walk.test.mjs` → **17/17 通过**（463 ms）；全仓 `node --test` → **167/167 通过**（基线 150 + 本刀 17） |
| 自检 | `node scripts/check.mjs` → **PASS**（房间齐、private:true、branch=main） |
| 写盘 | 模块侧 **0 字节**（`walk.mjs` 零 import，无 fs 句柄）；真实 store 调用前后 sha256 快照与 journal 行数完全一致 |
| 写 `<DSH_HOME>` | **0 字节**（全程只读；`$DSH_HOME/memory-context` 本机不存在，真实语料用 `tmp/memory-context`） |

---

## 一、交付物（写入范围严格 3 个文件）

| 文件 | 行 | 职责（AGENTS §11 R11） |
|---|---|---|
| `src/rooms/walk.mjs` | 875 | **R11**：`walkFromSignals`（信号→主题→棋谱/claim→一跳）+ `matchTopics` / `normalizeSignal` / `estimateTokens` / `clampDepth` / `WalkError` |
| `test/walk.test.mjs` | 628 | R11 tombstone（17 例：命中/一跳/深度/排序/预算/沉默/只读/口径） |
| `reports/T7a-REPORT.md` | — | 本报告 |

**未改动**：`package.json`、`CHANGELOG.md`、`AGENTS.md`、`src/index.mjs`、`scripts/check.mjs`、其他房间、`<DSH_HOME>`。
（给 Lead 的三件小事：① `package.json` `exports` 若要对外暴露 R11，需补 `./walk`；② `src/index.mjs` 是否 re-export `walkFromSignals`；③ `scripts/check.mjs` 的房间清单可加 `src/rooms/walk.mjs`。按写入范围我没有碰这三处。）

---

## 二、契约映射（docs/数据契约.md §7.1 / §7.2）

| 契约字段 | 实现 |
|---|---|
| `signal = {kind:"root-message"\|"activity"\|"user-explicit", terms:[], entities:[{kind,key}], at}` | `normalizeSignal()`：kind 校验（非法 ⇒ `walk/invalid-signal`）；terms/entities 非数组时宽容为空；entities[].key 允许主题 key 或主题 id（`t:repo:…`） |
| `walk({signal, store, depth=2, limit=5, budgetTokens=500})` | `walkFromSignals(opts)` = `{hits, path, omitted, tokens, …}`；默认值 = `WALK_DEFAULTS` |
| `hits:[{episode, nodeId?, link, why:[topic], weight, occurredAt}]` | 逐字段产出；另加（R12/R13 用）`claim? claimKind? claimState? seq? kind, depth, tokens, text?, scopeKey?` |
| `path:[{from, to, why}]` | 每次跳 `{from,to,why,kind,link?,new?}`：`match`（signal→主题）/`mention`（主题→棋谱）/`link`（棋谱→棋谱）/`claim`（棋谱或主题→claim） |
| `omitted:{count, reason}` | `{count, reason:"limit"\|"budget"\|null, byLimit, byBudget}` |
| 深度 ≤2 | `clampDepth()`：参数 clamp 到 [1,2]；`depth>2` 按 2 走；**hit.depth 与 path 都不产出第 3 跳**；`result.maxDepth`/`result.depth` 回显 |
| 每跳必须有 `why` | 无 why 的边不跳（`dropped.hopNoWhy` 计数）；无 why 的 hop 不入 path；hits 全部 `why.length>0` |
| 排序：失败教训 > 约束/偏好 > 定式候选 | 档位 `failure(0)/constraint(1)/claim(2)` → depth 升 → weight 降 → `occurredAt` 降 → id 升 |
| token ≤500（CJK 1.5 字/token、ASCII 4 字/token） | `estimateTokens()`；每 hit 独立计 tokens，`result.tokens = Σ hit.tokens`；超预算**前缀式截断** |
| 只读 store、不写 | 模块零 import（连 `node:` 都不用）；只用 `store.list()`；源码里没有 `import`/`require`（测试断言） |

## 三、关键设计裁定（自裁，可复核）

1. **depth 语义**：`depth=1` = 信号→主题→棋谱/claim（直接命中）；`depth=2` = 再沿 store 的 `links` 走一跳。**depth=2 的棋谱不再展开**（否则就是第 3 跳）。理由：方案 §4.4「深度 ≤2 跳」= 命中主题 + 一跳；这样 `depth>2` 的入参一定被夹住，测试可直接断言 ep4（第 3 跳）永不出现。
2. **分类只看机械量**：棋谱 `signals.failures>0 ⇒ failure`，否则 `signals.constraints>0 ⇒ constraint`，否则 `claim`（参考面/定式候选）；claim 条目 `antipattern ⇒ failure`、`preference ⇒ constraint`、其余 `claim`。权重 = 主题 `idfNorm`（缺失回落 0.5）或 `link.weight`，多路取 max。**无模型评分进入排序。**
3. **预算前缀式**：按排序结果依次收，碰到 `limit` 或 `budget` 就停，尾部全部计入 `omitted`。同输入 + 同预算 ⇒ 同前缀（可复现、可单测）；不做"跳过大条目塞小条目"，避免注入内容随预算抖动。
4. **claim 的两条机械通路**：① 依附——`claim.support[].episode` 已在命中里（深度沿用该棋谱）；② 文本——claim 文本里出现命中的主题 key。都没有 ⇒ `dropped.unconnected`（不入 hits）。
5. **入网纪律沿用 R00/R15**：`state:"folded-into:*"` 的子代理局不入（AGENTS §4.1/陷阱 10）；任何 hit 缺 `occurredAt` 一律不入（"无时不入"，AGENTS 陷阱 13）；`state:"invalidated"` 的 claim 不入（不改写、不删除，只是不注入）。
6. **零依赖**：AGENTS §11 给 R11 的允许依赖是 R05/R07，但 links/topics/index 都已由 store 提供成品，本房间**一个 import 都不需要** ⇒ 没有 fs 句柄，"不写盘"是结构保证而不是自觉。
7. **主题匹配最小长度闸**：词面包含匹配要求短边 ≥2 CJK 字 / ≥3 ASCII 字（`ls`、`sh` 这类不参与）；**完全相等不受闸限制**（主题 key 就叫 `ls` 时精确命中仍成立）。

---

## 四、验收

```bash
node --test test/walk.test.mjs          # 17/17 pass（463 ms）
node --test                             # 167/167 pass（2581 ms；基线 150 + 17）
node scripts/check.mjs                  # PASS
```

### 测试覆盖（17 例，全部对应验收项）

| # | 断言 | 对应用户要求 |
|---|---|---|
| 1 | 信号 `dsh-kifuin` ⇒ 命中 ep1/ep2（含 `why=[repo key]`、`occurredAt=lastEventAt`、`kind=failure`、`text=l0`） | 命中 ep1/ep2 |
| 2 | `path` 里有 `ep-0002→ep-0003`（`why=[node --test]`、`link=link-0002`、`new=true`）；`ep-0001→ep-0002` 的 why（`new=false`）且不出现镜像方向 | ep1→ep2 一跳带 why |
| 3 | `depth=99` 与 `depth=2` 等价、ep-0004（第 3 跳）永不出现；`depth=1` 无 depth2；`clampDepth(0)=1` | depth>2 不越界 |
| 4 | folded-into 局不入（dropped.folded=1）、无时间戳局不入（dropped.noTime=2）、invalidated claim 不入 | 入网纪律 |
| 5 | 档位单调不减、首条是 failure、antipattern/preference/棋谱各自归档、无关 claim 不出现 | 失败教训排最前 |
| 6 | `limit=2` ⇒ 2 hits / omitted 5(limit)；`limit=0` ⇒ 0/7；默认 limit=5 ⇒ 5 hits / omitted 2 | limit 生效 |
| 7 | `budget=首条 tokens` ⇒ 1 hit / omitted 6(budget)；`budget=0` ⇒ 0 hits / 7(budget)；`tokens=Σ hit.tokens` | budget 生效 |
| 8 | 无命中 ⇒ `hits=[]`、`path=[]`、`tokens=0`、`omitted.count=0` | 无命中空数组 |
| 9 | 空 store（连目录都没有）⇒ 空结果、不建目录、不抛 | 不写盘 |
| 10 | 走之前/之后 store 的 sha256 快照 + counts + bytes + journal 行数**完全一致**（6 类 kind、1280 文件级） | 不写盘 |
| 11 | 源码无 `import`/`require`；只给 `{list}` 的 wrapper 也能跑通 | 只读 store |
| 12 | 同输入两次调用 `deepEqual` | 可复现 |
| 13 | 主题匹配：精确/包含/大小写/实体 kind 过滤/主题 id/CJK 2 字闸/ASCII 3 字闸/稀有度排序 | 机械匹配 |
| 14 | `maxTopics` 截断 + `matched.truncated` | 预算/条数上限 |
| 15 | 坏 signal / 坏 store 抛 `WalkError`（`walk/invalid-signal`、`walk/invalid-store`）；宽容字段不抛 | 错误语义 |
| 16 | token 口径：`棋院=2`、`记忆系统=3`、`abcd=1`、空串=0、null=0 | token 估法 |
| 17 | 中文信号 `顺藤摸瓜` ⇒ ep4 直接命中 + ep3 一跳（why=example.com）+ claim 文本命中主题 key + 无时间戳 claim 不入 | CJK 主题 / claim 通路 |

---

## 五、真实语料实测（`[本] 2026-11-02 19:20`）

语料：仓库内**真实入档产物** `tmp/memory-context`（T5 archive 产出，只读打开）——
**92 局 / 780 主题 / 199 相关边 / 125 claim**（manifest v1，1280 文件，1,946,560 B）。探针脚本 `tmp/walk-probe*.mjs`（临时产物，不进 git）。

| 信号 | 命中主题 | hits | kinds | depth2 | tokens | omitted | path | 耗时 |
|---|---|---|---|---|---|---|---|---|
| `dsh-kifuin` | 3（`repo:mycf711/dsh-kifuin`、`term:kifu`、`term:dsh`） | 5 | failure×5（1 棋谱 + 4 claim） | 0 | 241 | 140 (limit) | 6 | ~331 ms |
| `记忆` | 1（`file:docs/记忆的职责边界.md`） | 5 | failure×5 | 0 | 218 | 93 (limit) | — | — |
| `棋谱` | 1（`file:…/20-棋谱与上下文压缩.md`） | 5 | failure×5 | **5** | 161 | 88 (limit) | — | — |
| `压缩` | 4 | 3 | failure×3 | 0 | 380 | 138 (**budget**) | — | ~375 ms |
| `entities:[{kind:"tool",key:"node"}]` | 1（`tool:node`） | 5 | failure×5 | 0 | 413 | 140 (limit) | 8 | ~314 ms |
| `系统` / `时间戳` / `entities:[{kind:"file",key:"src/rooms/walk.mjs"}]` / `zzz-不存在的主题` | 0 | **0** | — | 0 | **0** | 0 (null) | 0 | 157–220 ms |

关键证据：

- **只读**：6 组信号 + 2 次 limit/budget 压测全部跑完后，`store.snapshot()` 的 1280 个文件 sha256、counts、bytes、journal 行数**完全一致**（`tmp/walk-probe.mjs` 输出 `只读校验… true`）。
- **深度确有效但被夹住**：`棋谱` 信号 depth=1 ⇒ 1 hit，depth=2 ⇒ 5 hits（一跳多找回 4 条），`depth=99` 与 `depth=2` 结果 `JSON.stringify` 完全相同。
- **默认预算下真实产出**：`dsh-kifuin` 默认 limit=5/budget=500 ⇒ 5 条指针共 **241 tokens**（单条 17–70），140 条按 limit 省略；`path` 6 跳，样例：
  `signal → t:repo:28dd57a0 (why=mycf711/dsh-kifuin) → ep-8cc34e32 → c-90c164ef`。
- **R12/R13 需要的字段在真实数据上齐了**：`seq`（1742/2146/2132…）、`claim=c-90c164ef`、`claimKind=antipattern`、`claimState=observed`、`result.depth=2`。
- **沉默是默认**：4 组无主题/无命中的信号 ⇒ `hits=[]`、`tokens=0`、`omitted.count=0`，不猜、不给一行废话。

## 六、合成夹具数字（测试内，固定时间 T0=1760000000000）

夹具：6 局（ep1 失败 2 次 / ep2 无失败无约束 / ep3 只经一跳可达 / ep4 第 3 跳 / ep5 `folded-into:ep-0001` / ep6 全时间戳为 null）+ 5 主题 + 3 相关边 + 8 claim。

| 场景 | 数字 |
|---|---|
| 默认 limit=5 / budget=500 | 候选 7，命中 **5**，omitted **2 (limit)** |
| limit=2 / limit=0 | 2 / omitted 5(limit)；0 / omitted 7(limit) |
| budget=首条 tokens / budget=0 | 1 / omitted 6(budget)；0 / omitted 7(budget) |
| depth=1 / depth=2 / depth=99 | 5 hits（全 depth1）/ 7 hits（2 条 depth2）/ 与 depth2 逐字节相同 |
| dropped | folded=1、noTime=2（ep-0006 + 无时间戳 claim）、invalidated=1、unconnected≥1 |

> 合成数字来自测试断言本身（断言的是**精确值**，不是范围）；真实数字来自上面 `tmp/memory-context` 探针，两组**分开标**，不混算。

## 七、风险与遗留

| 风险 | 影响 | 缓解 |
|---|---|---|
| 全表扫描：每次 walk 读 topics/episodes/links/claims 全量（92 局时 157–375 ms） | M3 影子模式每步调用会累计 | 影子模式按轮次采样；语料上千局时给 `store.list` 加 byKind 缓存或按 topic 反查索引（R11 内部不缓存，避免陈旧） |
| 中文召回依赖 R04 主题表：真实语料里 `系统`/`时间戳` 根本没有主题 key（term 是 2-gram 且每局有上限） | 部分中文信号 ⇒ 零命中（沉默而非错命中） | 属 R04 的抽取上限问题，不在 R11 补"模型猜相关"；可在 R12 影子数据里统计"零命中率"作为 R04 的输入 |
| 双向包含匹配（`term ⊂ key` 与 `key ⊂ term` 都算命中） | `dsh-kifuin` 会带出 `term:kifu`/`term:dsh`，命中面偏宽 | `maxTopics=8` + 稀有度排序约束；若影子数据显示噪声，只需收紧 `overlaps()` 一行（阈值/方向） |
| `claim` 文本命中主题 key 是机械词面匹配 | 可能误连"文本里顺带提到"的 claim | 该通路只在 claim 依附不到任何命中棋谱时启用（二选一），且 why 只记命中的主题 key，可审计 |
| 未接入 `package.json` exports / `src/index.mjs` / `check.mjs` 房间清单 / CHANGELOG | R11 目前只能按路径 import | 按 Lead 的写入范围留给统一提交；一行改动即可 |
| `omitted.reason` 只有 `limit`/`budget`（前缀式截断只会触发其一） | 调用方若想区分"总候选数"需读 `omitted.count + hits.length` | 契约如此；`matched.truncated` 另行给出主题截断数 |

## 八、给 R12/R13 的接口确认（card-smith 的需求）

已按其消息**加法式**落地（不破坏 §7.2 契约字段）：

- `hit.seq`（数字，可缺省）：claim 取 `support.seq`；棋谱取该主题在棋谱里的首个 `mention.seq`（真实数据上 ep-8cc34e32 给出 1742/2146/2132…）。
- `hit.claim` = claim id 字符串；`hit.claimKind`（`antipattern`/`preference`/`fact`…）、`hit.claimState`（`observed`/`candidate`/`stale`…）同时给出；`hit.text` = claim 原文或棋谱 `l0` —— 逐字渲染不需要再回溯查 `claims/*.json`。
- `result.depth` = `result.maxDepth` 的别名（恒 ≤2），R13 闸 6b 可直接读。
- `hits[].why` 恒非空；`hits[].occurredAt` 恒为有限 epoch ms；这两条有专门的测试断言（第 1/3/10 例的 `assertInvariants`）。

## 九、复现

```bash
# 本刀
node --test test/walk.test.mjs
# 全仓（应为 167/167；Lead 合并其他人的测试后数字会继续涨）
node --test
node scripts/check.mjs

# 真实语料只读探针（临时脚本，tmp/ 不进 git）
node tmp/walk-probe.mjs            # 6 组信号 + 只读快照对比
node tmp/walk-probe2.mjs           # 真实 hit/path 样例 + depth 对比
```

---

**结论**：R11 按 §7.1/§7.2 落地，17 条 tombstone 全绿、全仓 167 条不红；真实语料只读实测 6 组信号（含 4 组沉默）数字如上，写盘 0 字节。
