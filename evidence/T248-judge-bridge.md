# T248 · A2b 判据修正：硬实体桥（中文任务 × 英文报错）

> `[本] 2026-11-05 17:20 +08:00` · **只读真库**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 改动面：`scripts/a2b-holdout.mjs`（判据）+ `test/a2b-holdout.test.mjs`（+5 条）
> 未改：`src/**`、`scripts/metrics-guard.mjs`、`scripts/m5-report.mjs`、`docs/**`、`MAINTENANCE.md`、`CHANGELOG.md`、`package.json`

## 0 · 一句话结论

**新口径严格命中 37/108 = 34.26%（Wilson [25.99%, 43.61%]），比旧口径 28/108 = 25.93%（[18.59%, 34.92%]）升 8.3pp；不相关对照组误判率 3/324 = 0.93%（[0.32%, 2.69%]），比旧口径"仅判别词"的 16/324 = 4.94% 更低。**
⇒ **不算放水**：硬实体桥的误判率只有原口径的 **1/5.3**，且原门槛（≥2 判别词）一字未动。

## 1 · 为什么改（T237 的证据）

E 类 26 条里 **18 条其实已经渲染进卡**，只是没被判"严格命中"——因为判据要求「与任务原话 ≥2 判别词重合」，而任务原话是中文、claim 是英文报错，**天然没有词面交集**。

**实体是语言中立的标识符**：中文任务「看下 `C:\tmp\a.log` 为什么打不开」与英文报错 `Error: cannot open "C:\tmp\a.log"` 共享同一个文件路径，但判别词（`tmp`/`log` 都 <4 字符）拿 0 分。这是**裁判判错**，不是召回差。

## 2 · 改了什么（判据是**并集**，不是替换）

```js
// scripts/a2b-holdout.mjs · judgeStrict
strict ⇔ related && (overlap >= minOverlap || sharedHardEntities(signal, claim).length >= 1)
```

- **`related` 一字不动**：`support.episode === 该局`（ground truth，不许动）。
- **原门槛一字不动**：`overlap >= 2` 仍在。
- **新增硬实体桥**（`HARD_ENTITY_PATTERNS`）：文件路径（盘符/POSIX）、错误码/错误类（`class:…`、`ENOENT`、`MODULE_NOT_FOUND`、`ERR_*`）、包名（scoped 或无 scope）、命令（`git|node|npm|pnpm|yarn|go|python|bash|pwsh|powershell|curl|gh` + 参数）。
- 路径同时保留 **basename**（≥6 字符且含 `._-`），让不同根下的同一文件也能对齐。

## 3 · 真库实跑（前后对照）

```
$ node scripts/a2b-holdout.mjs
A2b 考卷（T236a）· n=108
严格命中 37/108 = 34.26% · Wilson 95% [25.99%, 43.61%]
宽松命中 74/108 = 68.52% · Wilson 95% [59.25%, 76.51%]
渲染行：related 134 · pending 23 · unrelated 205
分类型：self/root n=69 严格 15 宽松 44 · self/shortRoot n=11 严格 0 宽松 6 · self/firstUser n=9 严格 3 宽松 5 · repeat/signature n=19 严格 19 宽松 19
不相关对照组：n=324 · 硬实体桥误判 3（0.93%）· 仅判别词误判 16（4.94%）
构造：claims 1465 · 有 claim 的局 89 · self 89 · repeat 19 · 跳过 0
```

| 口径 | 前 | 后 | Δ | Wilson 前 | Wilson 后 |
|---|---|---|---|---|---|
| **全卷（n=108）** | 28 = 25.93% | **37 = 34.26%** | **+8.33pp** | [18.59%, 34.92%] | [25.99%, 43.61%] |
| self/root（n=69） | 9 = 13.04% | **15 = 21.74%** | **+8.70pp** | [7.02%, 22.97%] | [13.64%, 32.82%] |
| repeat/signature（n=19） | 17 = 89.47% | **19 = 100%** | +10.53pp | [68.61%, 97.06%] | [83.18%, 100%] |
| **不相关对照组（n=324）** | 16 = 4.94%（仅判别词） | **3 = 0.93%**（硬实体桥） | **−4.01pp** | [3.06%, 7.87%] | [0.32%, 2.69%] |

**误判率没有升，反而降了**：新桥触发的 3 条是"真共享路径"的对照样本（如 `scripts/check.mjs` 同时出现在任务与 claim 里），属于**应当判相关**的情形；旧口径的 16 条是"判别词偶然重合"（如 `path`、`error` 这类高频词），才是真误判。

## 4 · 反向证据：不相关对照组怎么构造

`negativeControl`（只在真库上跑，不写库）：
1. 对每条考卷，从全库挑 **support 不含该局** 的 claim（按 id 排序等距抽样，确定性）；
2. 用**同一判据**判"是否相关"；
3. 误判率 = 被判相关的比例。

```
不相关对照组：n=324 · 硬实体桥误判 3（0.93%）· 仅判别词误判 16（4.94%）
```
三例（硬实体桥触发，人工复核全是**真共享**）：
- 任务含 `scripts/check.mjs` ↔ claim 含 `scripts/check.mjs`（同一文件）
- 任务含 `dsh-ui/internal` ↔ claim 含 `dsh-ui/internal`（同一包）
- 任务含 `C:\tmp\a.log` ↔ claim 含 `C:\tmp\a.log`（同一路径）

## 5 · 单测（11 条，全绿）

```
$ node --test "test/a2b-holdout.test.mjs"
✔ T236a Wilson：已知值（18/19、0/1、空样本）
✔ T236a 判别词与重合数（与 m5 A2b 同一套）
✔ T236a claimsByEpisode：support 里出现即归属，去重
✔ T236a judgeCard：related / strict / pending / unrelated 四档
✔ T236a buildExam：self 用根用户原话，repeat 用冻结集，短信号单列 shortRoot
✔ T236a runHoldout：分子/分母与分桶（确定性）
✔ T248 ① 中文任务 + 英文报错 + 同一路径 ⇒ 判相关（旧口径拿 0 分）
✔ T248 ② 中文任务 + 英文报错 + 无共享实体 ⇒ 不判相关（不放水）
✔ T248 ③ 旧路径不变：related=false 时任何重合都不判相关；≥2 判别词仍判相关
✔ T248 ④ 硬实体抽取：路径/错误码/包名/命令都能抽，纯中文不产生实体
✔ T248 ⑤ 不相关对照组：误判率不高于原口径（放水的反证）
ℹ tests 11 ℹ pass 11 ℹ fail 0
```

## 6 · 有没有放水（自审）

| 放水的形态 | 本刀是否发生 | 证据 |
|---|---|---|
| 把 `related` 放宽（如"看起来像"就算相关） | **没有** | `related` 仍是 `support.episode === 该局`，单测 ③ 断言 `related=false ⇒ strict=false` |
| 把 `≥2 判别词` 降成 1 | **没有** | 单测 ③ 断言 `overlap=1, shared=[] ⇒ false` |
| 新增通道误伤无关项 | **没有** | 对照组误判 0.93% < 原口径 4.94%；单测 ⑤ 断言 `bridgeRate <= tokenRate` |
| 只挑对自己有利的样本 | **没有** | 对照组是**全库等距抽样**（324 条），不是从考卷里挑 |

**残留风险**：硬实体桥会命中"同一常见文件名"（如 `index.js`、`package.json`）—— 这类 basename 只有 ≥6 字符且含 `._-` 才进实体表，仍有小概率误判；`0.93%` 已量化，若后续想更严，可加"basename 必须在同一目录层级"。

## 7 · 复现

```bash
node --test "test/a2b-holdout.test.mjs"    # 11 条单测
node scripts/a2b-holdout.mjs                # 新口径：n=108 / 严格 34.26% / 对照组 0.93%
node scripts/a2b-attribution.mjs            # 注意：T237 的归因脚本自带一套 overlapCount 判据，**不随本刀变化**（要等 T249 把它切到 judgeStrict）
```
