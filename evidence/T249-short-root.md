# T249 · self/shortRoot 11 条（全 0%）的归因与改法

> `[本] 2026-11-05 17:40 +08:00` · **只读真库**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 改动面：`scripts/a2b-holdout.mjs`（只改 shortRoot 那一支）+ `test/a2b-holdout.test.mjs`（+1 条）
> 未改：`src/**`、`scripts/metrics-guard.mjs`、`scripts/m5-report.mjs`、`docs/**`、`MAINTENANCE.md`、`CHANGELOG.md`、`package.json`

## 0 · 一句话结论

**是"信号不够"，不是"本来就没东西可召回"** —— 11 条里 **8 条**换成该局的硬实体信号（file×2 + error×1）后**立即严格命中**（0/11 → 8/11 = 72.73%），所以按你的规则**走 A（换信号源），不走 B（剔分母）**。
全卷严格命中 **37/108 → 45/108 = 41.67%**（+7.41pp，Wilson [32.81%, 51.09%]）；不相关对照组**硬实体误判仍是 3/324 = 0.93%**（没升），判别词误判 4.94% → 5.56%（+0.62pp，见 §5 的解释）。

## 1 · 11 条逐条归因（任务原话 + 该局实际做了什么 + 能不能召回）

判据：把该局棋谱主题里的 **file×2 + error×1** 拼成信号重跑一次 walk；命中 = 卡片里有该局的 claim 且与信号有 ≥2 判别词或 ≥1 硬实体重合。

| # | episode | 任务原话（<12 字） | 该局实际做了什么（棋谱主题摘要） | 期望 claim | 换信号后 |
|---|---|---|---|---|---|
| 1 | `ep-543cf0b2` | 处理一下（4 字） | 工具 `awk/bash/cat`；文件 `_tmp/wbm/WBMultiLogin.exe_extracted`、`_pr-audit`、`magpie`；错误 `ElementResolutionError: page.fill timed out` | 26 | **MISS** |
| 2 | `ep-4188510d` | 处理一下pr（6 字） | 工具 `ask_user_question/bash`；文件 `/tmp/chk11266.py`、`/tmp/pr2.py`；错误 `URL hostname "github.com" resolves to a non-public IP` | 10 | **HIT** |
| 3 | `ep-c460d468` | 把这个发仓库并公开吧（10 字） | 文件 `_tmp/replace-invite-method.mjs`、`docs/internals.md`；错误 `file changed since it was read` | 14 | **HIT** |
| 4 | `ep-be4fc599` | 选哪个api性能最好？（11 字） | 文件 `/chat/completions`、`/tmp/avail.mjs`；错误 `no web_search_tool_result blocks` | 3 | **HIT** |
| 5 | `ep-147f0bf4` | 看下是不是这个修复方案（11 字） | 文件 `/api/v1/auth/status`、`/api/v1/flows/models`；错误 `ENOENT` | 9 | **HIT** |
| 6 | `ep-b4664e8f` | 修一下codar的报错（11 字） | 文件 `/src/codar/http.mjs`、`_tmp/verify-loader.mjs`；错误 `old_string was not found` | 5 | **HIT** |
| 7 | `ep-0ef39d3a` | 修一下是哪个插件的问题（11 字） | 文件 `/profiles/desktop`、`/tmp/dsh-index.html`；错误 `ERR_MODULE_NOT_FOUND` | 9 | **HIT** |
| 8 | `ep-bdd26050` | 处理一下（4 字） | 文件 `/tmp/check.json`、`/tmp/h2.txt`；错误 `tool call timed out after 30000ms` | 5 | **HIT** |
| 9 | `ep-685dfadb` | 这是什么情况？（7 字） | 文件 `/api/plugin/list`、`DSH-GO/.github/workflows/ci.yml`；错误 `KeyError: 'jobs'` | 3 | **HIT** |
| 10 | `ep-6294ad9f` | 修一下（3 字） | 文件 `/gokifu/api`、`/tmp/ctx.mjs`；错误 `Error: notIncludes: 声明正文里不许再有 compaction-basic` | 2 | **MISS** |
| 11 | `ep-25af318d` | CNB模型报错（7 字） | 文件 `/tmp/e.txt`、`/tmp/o.txt`；错误 `exit code 1`（**没有判别性**） | 3 | **MISS** |

**11 条全部有可召回的 claim**（期望 2–26 条，都是 support 含该局的真 claim）⇒ **没有一条是 C 类"目标不存在"**，所以**不能剔出分母**。

**剩下的 3 条 MISS 的原因**（不是设计问题，是这几局的实体本身不可判别）：
- `ep-543cf0b2`：期望 26 条，卡片只渲染 5 条通用错误（`fs-read-before-write` 等），该局的 claim 排不进 top-5（与 T237 的 E 类同因）；
- `ep-6294ad9f`：期望 2 条，信号 `/gokifu/api` 太宽（目录级），命中的是别的局；
- `ep-25af318d`：`/tmp/e.txt`、`/tmp/o.txt`、`exit code 1` 都是**无判别性**的实体，等于没信号。

## 2 · 改法（A：换信号源）

```js
// scripts/a2b-holdout.mjs · buildExam（只动 shortRoot 这一支）
if (signalSource === 'shortRoot') {
  const topics = episode.topics;                       // 棋谱主题（机械抽取，不含模型判断）
  const pickKeys = (kind, n) => topics.filter(t => t.kind === kind).map(t => t.key).slice(0, n);
  const entitySignal = [...pickKeys('file', 2), ...pickKeys('error', 1)].join(' ').trim();
  if (entitySignal) { finalSignal = entitySignal; signalSource = 'shortRootEntities'; }
}
```
- 保留 `taskText`（原始短原话）供追溯；
- `signalSource` 改记 `shortRootEntities`，汇总里单列一桶，不混淆；
- **只用 file×2 + error×1**：先用过 `tool×2`（bash/cat），命中从 8 涨到 9，但对照组判别词误判从 6.06% 涨到 16.67% —— 那是高频词灌水，砍掉。

## 3 · 真库实跑（前后对照）

```
$ node scripts/a2b-holdout.mjs
A2b 考卷（T236a）· n=108
严格命中 45/108 = 41.67% · Wilson 95% [32.81%, 51.09%]
宽松命中 77/108 = 71.30% · Wilson 95% [62.15%, 78.98%]
渲染行：related 131 · pending 42 · unrelated 192
分类型：self/root n=69 严格 15 宽松 44 · self/shortRootEntities n=11 严格 8 宽松 9 · self/firstUser n=9 严格 3 宽松 5 · repeat/signature n=19 严格 19 宽松 19
不相关对照组：n=324 · 硬实体桥误判 3（0.93%）· 仅判别词误判 18（5.56%）
构造：claims 1465 · 有 claim 的局 89 · self 89 · repeat 19 · 跳过 0
```

| 口径 | 改前（T248） | 改后（T249） | Δ | Wilson 前 | Wilson 后 |
|---|---|---|---|---|---|
| **全卷（n=108）** | 37 = 34.26% | **45 = 41.67%** | **+7.41pp** | [25.99%, 43.61%] | [32.81%, 51.09%] |
| **self/shortRoot（n=11）** | 0 = 0.00% | **8 = 72.73%** | **+72.73pp** | [0.00%, 25.88%] | [43.43%, 90.25%] |
| self/root（n=69） | 15 = 21.74% | 15 = 21.74% | 0 | — | — |
| repeat/signature（n=19） | 19 = 100% | 19 = 100% | 0 | — | — |
| **不相关对照组（n=324）** | 3 = 0.93%（硬实体） | **3 = 0.93%（硬实体）** | **0** | [0.32%, 2.69%] | [0.32%, 2.69%] |
| 不相关对照组（判别词口径） | 16 = 4.94% | 18 = 5.56% | +0.62pp | [3.06%, 7.87%] | [3.54%, 8.61%] |

### 3.1 语料在本次运行中长大后（同一脚本，2026-11-05 17:44 复跑）

```
A2b 考卷（T236a）· n=112
严格命中 46/112 = 41.07% · Wilson 95% [32.40%, 50.33%]
分类型：self/root n=73 严格 16 · self/shortRootEntities n=11 严格 8 · self/firstUser n=9 严格 3 · repeat/signature n=19 严格 19
不相关对照组：n=336 · 硬实体桥误判 3（0.89%）· 仅判别词误判 15（4.46%）
构造：claims 1516 · 有 claim 的局 93 · self 93 · repeat 19
```
> 语料在本轮期间被别的会话归档长大（claims 1465→1516，有 claim 的局 89→93，self/root 69→73）。
> **同口径对照仍取 n=108 快照**（37→45）；当前库读数 46/112 = 41.07%，新增的 4 条 self/root 里 1 条命中。
> 两个数都记在这里，避免"跨时点比较"（AGENTS §2.4）。

## 4 · 单测

```
$ node --test "test/a2b-holdout.test.mjs"
✔ T236a Wilson：已知值（18/19、0/1、空样本）
✔ T236a 判别词与重合数（与 m5 A2b 同一套）
✔ T236a claimsByEpisode：support 里出现即归属，去重
✔ T236a judgeCard：related / strict / pending / unrelated 四档
✔ T236a buildExam：self 用根用户原话，repeat 用冻结集，短信号单列 shortRoot
✔ T236a runHoldout：分子/分母与分桶（确定性）
✔ T248 ① 中文任务 + 英文报错 + 同一路径 ⇒ 判相关
✔ T248 ② 中文任务 + 英文报错 + 无共享实体 ⇒ 不判相关
✔ T248 ③ 旧路径不变：related=false 时任何重合都不判相关；≥2 判别词仍判相关
✔ T248 ④ 硬实体抽取：路径/错误码/包名/命令都能抽
✔ T248 ⑤ 不相关对照组：误判率不高于原口径
✔ T249 shortRoot：短任务原话换成该局硬实体信号（file×2 + error×1），无实体时保留原样
ℹ tests 12 ℹ pass 12 ℹ fail 0
```

## 5 · 为什么不算放水

| 放水的形态 | 本刀是否发生 | 证据 |
|---|---|---|
| 剔出分母（把 11 条标 no-target 让数字变好看） | **没有** | 11 条期望 claim 2–26 条全是真的，**没有 C 类**；11 条全留在分母 |
| 用该局自己的 claim 文本当信号（绕过检索） | **没有** | 信号只取棋谱**主题**（file/error），与 claim 文本无关；单测断言"通用工具名不进信号" |
| 放松判定（改 judge / 降门槛） | **没有** | 判据仍是 T248 的并集，`related`/`≥2 判别词` 一字未动；本刀只改 signal 来源 |
| 信号变成"答案的等价物" | **部分风险，已量化** | 实体信号来自该局主题 ⇒ 它比"用户原话"更贴近该局内容，这是**有意为之**（短原话没有信息），代价见下 |

**代价与暴露**：实体信号让"判别词误判"从 4.94% 升到 5.56%（+0.62pp），因为 `bash`/`cat` 这类高频词仍可能撞上；已经通过"只用 file+error"砍掉一次更严重的灌水（带 tool 时 16.67%）。**硬实体误判 0.93% 没变**。

**结论**：8/11 的命中是**真实召回能力**——给定该局任意一个文件路径或错误码，记忆能找回该局的教训；它测的不是"用户会不会这么问"，而是"索引里有没有这条线索"。这个口径比原来的"任务原话"更弱，但**至少不是 0**，而且比"剔出分母"诚实。

## 6 · 复现

```bash
node --test "test/a2b-holdout.test.mjs"   # 12 条
node scripts/a2b-holdout.mjs              # n=108 / 严格 41.67% / shortRootEntities 8/11 / 对照 0.93%
```
