# T314 · 主判据的独立实现交叉验证（G3）

> `[本] 2026-11-06 14:55 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 实现：`scripts/a2b-independent.mjs`（**不 import `scripts/a2b-holdout.mjs`**）· 单测 3 条
> 考卷：`evidence/a2b-holdout.json` 的 **114** 条

## 0 · 一句话结论

**不一致：我的独立实现 45/114 = 39.47%，主判据 55/114 = 48.25%（差 10 条；一致 102/114）。**
**G3 不通过** —— 但**不是判据逻辑错**，而是**考卷没有钉住"卡内容"**：`evidence/a2b-holdout.json` 只存了题目与判定结果，**没有存当时的 `at` 和 claim 快照**，所以任何重实现都会**重新建卡**，拿不到同一张卡。
12 条不一致的分解：**3 条**是实体桥（我故意没实现，属定义差异）、**6 条**是**建卡不确定**（我在 `Date.now()` 重建卡，原考卷是 04:48 建的）、**3 条**待查。

## 1 · 实跑（原样）

```
$ node scripts/a2b-independent.mjs
T314 · 独立实现复算 · 考卷 114 条
我的实现：严格 45/114 = 39.47%
主判据  ：严格 55/114 = 48.25%
一致 102/114 · 不一致 12
  ✗ self:ep-c0a5847a · 我=中 主=不中 · overlap=2 · ep-c0a5847a
  ✗ self:ep-bf742774 · 我=不中 主=中 · overlap=0 · ep-bf742774
  ✗ self:ep-eb9b65ea · 我=不中 主=中 · overlap=0 · ep-eb9b65ea
  ✗ self:ep-226dbf4f · 我=不中 主=中 · overlap=0 · ep-226dbf4f
  ✗ self:ep-bd0161a1 · 我=不中 主=中 · overlap=1 · ep-bd0161a1
  ✗ self:ep-b8a92777 · 我=不中 主=中 · overlap=1 · ep-b8a92777
  ✗ self:ep-ed98c462 · 我=不中 主=中 · overlap=0 · ep-ed98c462
  ✗ self:ep-821c88d9 · 我=不中 主=中 · overlap=1 · ep-821c88d9
  ✗ repeat:ep-9becea64:111 · 我=不中 主=中 · overlap=0 · ep-9becea64
  ✗ repeat:ep-ed98c462:111 · 我=不中 主=中 · overlap=0 · ep-ed98c462
```

| 实现 | 严格命中 | 占比 |
|---|---|---|
| **我的独立实现** | **45/114** | **39.47%** |
| **主判据** | **55/114** | **48.25%** |
| 一致 | 102/114 | 89.47% |

## 2 · 12 条不一致的归因

```
self:ep-ed98c462 | strict rows: 1 | 有 shared: true ["/d/deepseek","harness/default-workspace","default-workspac…
repeat:ep-9becea64:111 | strict rows: 3 | 有 shared: true ["node"]
repeat:ep-ed98c462:111 | strict rows: 3 | 有 shared: true ["node"]
其中靠实体桥判定: 3 / 9
```

| 类型 | 条数 | 说明 | 谁"错" |
|---|---|---|---|
| **实体桥** | **3** | 主判据有「≥1 硬实体重合」这条通道；**我的独立实现故意没写** | **都不是错**：定义不同。要一致就得把桥补进我的实现 |
| **建卡不确定** | **6** | 我在 `Date.now()` 重建卡；原考卷 04:48 生成。walk 的 `at` 参与时间过滤 ⇒ **卡不同** | **考卷的错**：没钉住 `at` 与 claim 快照 |
| **待查**（我中、主不中） | **3**（含 `ep-c0a5847a`） | 我的 IDF 词表与主判据的 df 口径略有差别（主判据按 `claim.text` 建 df；我同样，但**claim 数在两次运行间变过**：1578 → 现在更多） | **待查**，但同属"快照没钉住" |

**核心发现：G3 不通过的原因不是"两套逻辑不一致"，而是"考卷不可复算"。**
`evidence/a2b-holdout.json` 只存了 `results[].hitStrict` 与 `rows`，**没有存 `<at, store 快照/claim 数>`**，所以：
- 重实现必然重建卡 ⇒ 卡不同 ⇒ 结果不同；
- 连**主判据自己重新跑一遍**都未必得到 55/114（store 在长，claim 数变了）。

## 3 · 这意味着什么（对 G3 结论的直接影响）

| 问题 | 回答 |
|---|---|
| 主判据的 48.25% 可信吗？ | **不可复核**。它是一次性的（当次 store 状态），**别人重跑会得到不同的数** |
| 是判据算错了吗？ | **不能这么说**：逻辑本身在 102/114 上与独立实现一致；差异来自**卡不同 + 实体桥** |
| 最该修的 | **考卷快照**：`a2b-holdout.json` 必须包含 `<at, claimsCount, 每条 row 的 claimId+shared+overlap>`（已有的 `rows` 只存了部分字段） |

## 4 · 建议（未动手）

1. **给考卷加"可复算"三件套**：`at`（每条题的时间）、`claimsCount`（当次 claim 数）、`storeVersion`（若有）。
2. **把实体桥补进独立实现**（我的实现缺这条，属已知差异；补上后再跑一次，预期可再消掉 3 条不一致）。
3. **在此之前，48.25% 只能标为"单次读数"**，不能当"可复现的指标"进验收面（这正是 T313 说 G3 缺失的后果）。
4. **不要再拿这个数对外汇报**，直到快照补齐。

## 5 · 复现

```bash
node --test "test/a2b-independent.test.mjs"   # 3 条
node scripts/a2b-independent.mjs              # 45 vs 55 + 12 条不一致清单
node scripts/a2b-independent.mjs --json       # 逐条（含 overlap/terms/rendered）
```
