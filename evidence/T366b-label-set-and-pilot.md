# T366b · 判据校准的**第一步**：标注集已建（196 对）+ 自标 6 对的可行性验证

> 日期：2026-11-07
> 依据：`docs/调研/80-判据校准`（先建标注集 → 逐阈值算误杀率/误判率 → 按目标误杀率反推阈值）。

## 一、标注集已建

`evidence/label-set.json`：**196 对** `(signal, claimText)`，从考卷 `evidence/a2b-holdout.json` 抽取
（每题取卡上 `bigramRaw ≥ 1` 或 `overlap ≥ 1` 的前 2 行，claim 原文从库里读出）。

**字段**：`pairId / itemId / claimId / signal / claimText / bigramRaw / overlap`。

## 二、两个独立标注成员**都失败了**（如实记录）

派 `precision-auditor`（成员 A）与 `store-keeper`（成员 B）各标前 100 对，
**两个都在交付前失败**（无 closing message，无产出文件）。

**这是本会话连续第 6 次派单失败**（此前 precision-auditor ×3、card-smith ×1、本次 ×2）。
⇒ **teammate 目前基本不可用**，"并行推进"这条线实际跑不动。**校准由 Lead 自己小批量验证。**

## 三、自标 6 对（方法可行性验证）

| pair | 信号 | claim 摘要 | 判定 |
|---|---|---|---|
| 1 | dsh-go 的 HANDOFF | `failed to push to dsh-go.git` | **relevant** |
| 2 | 同上 | `../dsh-ui/AGENTS.md is outside repository at DSH-GO` | **relevant** |
| 3 | "处理一下" | headless-auto PR 的处置说明 | **uncertain**（信号无内容） |
| 4 | "处理一下" | watch_ack 的使用说明 | **uncertain**（同上） |
| 5 | 看 token 额度 | `Error: glob search failed: rg: /d/.../ai-coding-free` | **irrelevant** |
| 6 | 看 token 额度 | `magicrew的账号凭证…直接刷新登录` | **relevant** |

## 四、对照 `bigramRaw ≥ 2` 这个判据（**剔除 2 条 uncertain**）

```
真相关 3 条（pair 1/2/6）→ 全部被判相关 ⇒ **误杀率 = 0**
真不相关 1 条（pair 5）→ 被判相关 ⇒ **误判**（词重合但内容无关）
```

**含义**：
- **误杀率 = 0**（在这 3 条上）—— 判据**没有把真相关的拒掉**；
- **但会放进噪声**（pair 5 那种"词重合但内容无关"的被判为相关）。

**样本太小（4 条可判定），不能下结论** —— 这里只证明**方法可行**。

## 五、发现的标注集缺陷（要修）

`处理一下` 这种**无内容信号**的对**不该进标注集**：
- 信号里没有任何可判别的东西 ⇒ 只能判 `uncertain` ⇒ **浪费标注**；
- 而且这类题**本来就不该用"内容相关"去拒**（`abstain.mjs` 里已有"判据不可用时保守"）。

**过滤判据**：信号里**没有任何硬实体、判别词或中文 bigram** 的对，**不进标注集**
（它们对应 `hasAnySignalHandle(signal) === false`，本就不在 abstain 的作用面上）。

## 六、下一步（**未实施**）

1. **过滤标注集**：剔除"信号无内容"的对（约 20–30%）；
2. **扩到 ≥100 对有效标注**（当前只有 6 对，且 2 对 uncertain）；
3. **逐阈值算两个率**：`bigramRaw ≥ 1 / ≥2 / ≥3` 各自的误杀率与误判率；
4. **若存在"误杀率 = 0"的阈值** ⇒ 写进 `abstain.mjs` 并**注明校准来源**；
   **若不存在** ⇒ **abstain 永久默认关**。

## 七、一句话

**标注集建好了、方法跑通了，但"误杀率 = 0"还差 100 个有效标注 —— 而 teammate 现在标不了。**

---

## 追加（第二轮）：**标注集的选择偏差**与负例

### 自标 13 对（前 6 + 第 7–13）**全部 relevant**
```
pair 1/2/6/9/10/11/12/13/14/15  →  relevant
pair 5                          →  irrelevant（噪声）
pair 3/4                        →  uncertain（短指令，已过滤）
```

**几乎全是 relevant** —— 因为标注集是从"**卡上的行**"抽的，
而那些行**已经被检索判为相关**了 ⇒ **正例富集（selection bias）**。

⇒ **误判率测不出来**：没有"真不相关"的样本可判。

**这正是知识库 80 的硬前提**："真相关与真不相关**都要有足够样本**"。

### 补了 20 对**负例**（`evidence/label-negatives.json`）
从**另一个 scope** 取 claim 配成负例（不同项目 ⇒ 大概率无关）：
- 库里有 **14 个不同 scope**，为前 20 对各配一条**别的 scope** 的 claim；
- 字段 `isNegative: true`，并注明"**用于测误判率**"。

**注意**："来自别的 scope"只是**近似负例** —— 跨项目也可能相关，
**标注时仍要按"内容是否指向同一件事"判**，不能因为"跨 scope"就直接标 irrelevant。

### 下一步（仍未完成）
- 负例只有 20 对，**还不够**；需要扩到与正例可比的数量级；
- **阈值曲线仍未画出**（有效标注只有 13 对，且几乎全是正例）。
