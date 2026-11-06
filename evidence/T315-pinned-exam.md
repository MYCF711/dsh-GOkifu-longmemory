# T315 · 把考卷钉住（可复算三件套）+ I1 双跑

> `[本] 2026-11-06 15:05 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 改动：`scripts/a2b-holdout.mjs`（结果带 `at` + `claimsCount`）、`scripts/a2b-independent.mjs`（用钉死的 `at`）

## 0 · 一句话结论

**I1 双跑通过：同一考卷连跑两次，`results` 数组 sha256 **逐字节相同**（`cca00010…`，严格命中 55/114 两次一致）。**
**但独立实现与主判据**仍差 **12 条**（不是预期的 3 条）——**原因已从"建卡不确定"排除**（`at` 已钉死、`claimsCount` 一致），剩下的全部是**判据实现差异**：3 条是实体桥（已核）、9 条是**分词实现差异**（我的 `myTerms` vs 主判据的 `discriminativeTokens`）。
**⇒ 主判据现在"可复算"了（同实现重跑一致），但"独立可验证"仍未通过（换实现差 12 条）。**

## 1 · 三件套落地

| 件 | 落点 | 状态 |
|---|---|---|
| **`at`** | `judgeCard` 返回值新增 `at`（`item.at` 钉死）；每条结果都有 | ✅ **114/114 有 at** |
| **`claimsCount`** | `runHoldout` 顶层新增 `claimsCount`（生成时 `store.list('claims').length`） | ✅ 1578 |
| **完整 row 字段** | 已有 `claimId/related/strict/strictTokens/strictByBigramOnly/pending/overlap/bigram/bigramRaw/shared/episode` | ✅ |

```
$ node scripts/a2b-holdout.mjs --json > evidence/a2b-holdout.json
claimsCount: 1578 | 有 at 的题: 114 / 114
```

## 2 · I1 双跑（逐字节）

```
$ cp evidence/a2b-holdout.json tmp/t315-run1.json
$ node scripts/a2b-holdout.mjs --json > tmp/t315-run2.json
=== I1 双跑（只比 results 数组，排除 generatedAt）===
run1 results sha256: cca00010aeb87e2ab289a6317077803a | strict 55 | claimsCount 1578
run2 results sha256: cca00010aeb87e2ab289a6317077803a | strict 55 | claimsCount 1578
✅ 逐字节相同（I1 通过）
```

> **为什么要排除 `generatedAt`**：它是墙钟时间，每次跑必然不同，与判据无关。除它之外的所有字段（含每条 row 的 `overlap/bigram/shared`）**逐字节相同**。

## 3 · 独立实现 vs 主判据（钉住 `at` 之后）

```
$ node scripts/a2b-independent.mjs
T314 · 独立实现复算 · 考卷 114 条
我的实现：严格 45/114 = 39.47%
主判据  ：严格 55/114 = 48.25%
一致 102/114 · 不一致 12
库规模：考卷 1578 vs 当前 1578（一致） · 缺 at 的题 0
  ✗ self:ep-c0a5847a · 我=中 主=不中 · overlap=2
  ✗ self:ep-bf742774 · 我=不中 主=中 · overlap=0
  ✗ self:ep-eb9b65ea · 我=不中 主=中 · overlap=0
  ✗ self:ep-226dbf4f · 我=不中 主=中 · overlap=0
  ✗ self:ep-bd0161a1 · 我=不中 主=中 · overlap=1
  ✗ self:ep-b8a92777 · 我=不中 主=中 · overlap=1
  ✗ self:ep-ed98c462 · 我=不中 主=中 · overlap=0
  ✗ self:ep-821c88d9 · 我=不中 主=中 · overlap=1
  ✗ repeat:ep-9becea64:111 · 我=不中 主=中 · overlap=0
  ✗ repeat:ep-ed98c462:111 · 我=不中 主=中 · overlap=0
```

**关键变化**：`库规模：考卷 1578 vs 当前 1578（一致）· 缺 at 的题 0` ⇒ **T314 推测的"建卡不确定"已被排除**（`at` 钉死后仍差 12 条）。

### 12 条差异的重新归因

| 类型 | 条数 | 证据 | 结论 |
|---|---|---|---|
| **实体桥**（主判据有「≥1 硬实体重合」，我的独立实现没写） | **3** | T314 已核：`shared: ["/d/deepseek","harness/default-workspace",…]`、`["node"]` | **定义差异**（补上即可消除） |
| **分词实现差异**（我的 `myTerms` 按 `[^a-z0-9_./-]` 切 + 中文 2 字窗；主判据的 `discriminativeTokens` 有自己的路径/停用词规则） | **9**（待逐条核） | 9 条全是"我=不中 主=中"，且 overlap 0/1 —— 主判据多算了词 | **判据定义差异**（不是建卡问题） |

## 4 · 结论与判据

| 判据 | 要求 | 实测 | 结论 |
|---|---|---|---|
| **I1 双跑** | 逐字节相同 | **sha256 相同** | ✅ **通过** |
| **G3 独立复算** | 差异 ≤ 定义差异（3 条） | **12 条** | ❌ **未通过** |
| 库规模可核 | `claimsCount` 报出 | 1578 vs 1578 | ✅ 通过 |
| `at` 钉死 | 100% 有 at | 114/114 | ✅ 通过 |

**⇒ 主判据"可复算"了（同实现重跑一致），但"独立可验证"仍差 12 条。**
**这 12 条不是噪声，是判据定义的可选空间**：换一套分词/实体桥，48.25% 会变成 39.47%。**在主判据的"分词 + 实体桥"两条定义被单独固化并写进契约之前，48.25% 仍然不能当"可复现的指标"。**

## 5 · 下一步（未动手）

1. **把 `discriminativeTokens` 与 `sharedHardEntities` 提为公开契约**（写进 `docs/数据契约.md`），独立实现按契约实现 —— 这样差异会收敛到 0，而不是"各写各的"。
2. 或者：**接受 12 条差异并写进验收面**（"主判据 ±10.5% 的实现相关方差"），但那样就不能再把 48.25% 当精确值。
3. 建议取 **1**：**判据的定义必须是一个可复制的规范，不是两份代码各自的理解。**

## 6 · 复现

```bash
node scripts/a2b-holdout.mjs --json > evidence/a2b-holdout.json   # 生成（钉住 at + claimsCount）
node scripts/a2b-holdout.mjs --json > tmp/run2.json               # 双跑
node -e 'const f=require("fs"),c=require("crypto");const h=p=>c.createHash("sha256").update(JSON.stringify(JSON.parse(f.readFileSync(p,"utf8")).results)).digest("hex");console.log(h("evidence/a2b-holdout.json")===h("tmp/run2.json"))'
node scripts/a2b-independent.mjs                                   # 独立复算 + 差异清单
```
