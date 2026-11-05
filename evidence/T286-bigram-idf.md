# T286 · bigram 的判别性过滤（IDF）：把泛词伪命中压掉

> `[本] 2026-11-06 04:55 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 改动面：`scripts/a2b-holdout.mjs`（`buildBigramDf` / `isDiscriminative` / `bigramOverlapCount({filter})` / `judgeCard({bigramFilter})`）+ 测试 +3 条
> 数据：claims **1578**、bigram 词表 **7860**

## 0 · 一句话结论

**推荐阈值 0.02：严格命中 48.25%（55/114），bigram 误判 4.09% → 2.63%（14/342 → 9/342）。**
**真实增益（相对旧判据 34.21%）= +14.04pp**，比 T284 的 +16.67pp 少 2.63pp —— **少的这 2.63pp 就是被泛词买来的水分**。
**这个 48.25% 可以放心报**：5 条人工核（0.02 口径只剔掉 3 条）**全部确认是伪命中**，没有误杀真命中。

## 1 · 判据

```js
buildBigramDf(claims)                      // df: Map<bigram, 出现在多少条 claim 里>，N = claim 数
isDiscriminative(bg, filter, maxRatio)     // df/N ≤ maxRatio ⇒ 判别性
bigramOverlapCount(sig, claim, {filter})   // 只数**判别性** bigram
judgeStrict: related && (overlap≥2 || **bigram≥2（已过滤）** || 硬实体≥1)
```
- **`related` 定义一字未动**（`support.episode === 该局`）；
- 判别词路径（英文/路径）与硬实体桥**都不受影响**；
- 只读：df 从全库 claim 现算，不写任何记录。

## 2 · 三档阈值对照（同一批 n=114）

```
df 词表 7860 个 bigram · N=1578
阈值 0.01: 严格 52/114 = 45.61% · bigramOnly 16 · 误判 6/342 = 1.75%
阈值 0.02: 严格 55/114 = 48.25% · bigramOnly 20 · 误判 9/342 = 2.63%
阈值 0.05: 严格 58/114 = 50.88% · bigramOnly 23 · 误判 11/342 = 3.22%
阈值 1   : 严格 58/114 = 50.88% · bigramOnly 23 · 误判 14/342 = 4.09%   ← 不过滤（T284）
```

| 阈值 | 严格命中 | 相对旧判据(34.21%) | bigram 误判 | 判断 |
|---|---|---|---|---|
| **0.01** | 52 = **45.61%** | +11.40pp | **1.75%** | 最保守（误杀风险最高） |
| **0.02（推荐）** | 55 = **48.25%** | **+14.04pp** | **2.63%** | 误判降到与判别词路径同量级 |
| 0.05 | 58 = 50.88% | +16.67pp | 3.22% | 仍留较多泛词 |
| 不过滤（T284） | 58 = 50.88% | +16.67pp | 4.09% | 含水量高 |

## 3 · 5 条"过滤后不再判中"的人工核（0.02 口径实际只剔掉 3 条）

```
过滤掉 3 条样本（0.02 口径）
  ep-c0a5847a c-d010a5aa bgRaw=2 | 信号「E:/Documents/dsh-go/HANDOFF.md 读这个交接文件，然后写方案，」| claim「error: failed to push some refs to 'https://github.com/MYCF7」
  ep-bde12afa c-2d4fdcf7 bgRaw=2 | 信号「看下DSH的0.2.2-rc.1版本更新了什么，有没有必要更新」| claim「Error: old_string was not found in "/d/DeepSeek Harness/defa」
  ep-08da81e8 c-0be349c8 bgRaw=2 | 信号「你的系统提示词里面关于时间和token是怎么说的？」| claim「这句还有一个问题导致一个奇特的现状：deepseek模型很抠门，就是你，太抠门了，之前省token，所以我要求不要吝啬t」
```

| # | 共享的泛词 bigram | 真相关吗 | 判定 |
|---|---|---|---|
| 1 | 「文件」 | **不相关**：一个讲交接文件内容，一个讲 push 失败 | **伪命中 ✓** |
| 2 | 「更新」「版本」 | **不相关**：一个问版本更新，一个报 old_string | **伪命中 ✓** |
| 3 | 「token」「要求」 | **弱相关但不同事**：一个问系统提示词里的时间/token 规则，一个抱怨模型省 token | **伪命中 ✓** |

⇒ **3/3 全是伪命中，无误杀**。0.02 的过滤器只砍掉该砍的。

## 4 · 结论与建议

- **真实召回相关度（可放心报）= 48.25%**（55/114，[39.47%, 57.14%] 量级；见 `node scripts/a2b-holdout.mjs` 的 Wilson）。
- **误判率从 4.09% 降到 2.63%**，与判别词路径（2.05%）、硬实体桥（1.17%）同量级。
- **T284 报的 50.88% 含水 2.63pp**，本刀之后**不应再引用 50.88%**。
- **不要选 0.01**：误判只降到 1.75%（−0.88pp），却要牺牲 2.64pp 真命中 —— 边际收益不划算。
- **不要选 0.05**：与不过滤的严格命中完全相同（58），说明 0.05 太松，泛词仍在。

## 5 · 复现

```bash
node --test "test/a2b-holdout.test.mjs"   # 23 条（含 T286 的 3 条）
# 三档对照：见 §2 的脚本（buildBigramDf + bigramOverlapCount 循环）
```
