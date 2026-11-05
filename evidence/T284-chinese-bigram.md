# T284 · 判据的中文重合：整段 includes → 中文二元组（只读）

> `[本] 2026-11-06 04:45 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 改动面：`scripts/a2b-holdout.mjs`（`chineseBigrams` / `bigramOverlapCount` / 判据并集）+ `test/a2b-holdout.test.mjs`（+4 条）

## 0 · 一句话结论

**修正尺子后严格命中 34.21% → 50.88%（39/114 → 58/114，Wilson [41.82%, 59.87%]）**，其中 **19 题**是"原本就取到了、但尺子不认"（另 23 行因 bigram 才成立，含已命中题的多余行）。
**不算放水**（硬实体桥误判 4/342 = 1.17% 没变），**但也不免费**：bigram 路径在无关 claim 上的误判是 **14/342 = 4.09%**，人工核 3 例里 **2 例是泛中文 bigram 造成的伪命中**（「你看」「看看」）。

## 1 · 改了什么

```js
// scripts/a2b-holdout.mjs
export function chineseBigrams(text)      // 中文连续段 2 字滑窗；英文/数字/路径保持原样
export function bigramOverlapCount(s, c)  // 信号 bigram 在 claim 文本里的命中数
judgeStrict({ related, overlap, shared, bigram })   // 并集：overlap≥2 || bigram≥2 || 硬实体≥1
```
- **`related` 一字未动**（`support.episode === 该局`）；
- 判别词路径（英文/路径）**原样保留** —— 这次是**加**一条中文通道，不是替换；
- 新增统计字段 `strictTokens`（旧口径）、`strictByBigramOnly`（仅靠 bigram 才成立）。

## 2 · 前后对照（同一批 n=114）

```
AGG n=114 old=39 new=58 bigramOnly=23 (20.18%)
```
```
$ node scripts/a2b-holdout.mjs
A2b 考卷（T236a）· n=114
严格命中 58/114 = 50.88% · Wilson 95% [41.82%, 59.87%]
宽松命中 79/114 = 69.30% · Wilson 95% [60.32%, 77.02%]
不相关对照组：n=342 · 硬实体桥误判 4（1.17%）· 仅判别词误判 7（2.05%）
```

| 口径 | 严格命中 | Wilson | bigram 路径误判 | 硬实体桥误判 |
|---|---|---|---|---|
| **旧**（整段 includes） | 39/114 = **34.21%** | — | 0（该路径不存在） | 4/342 = 1.17% |
| **新**（+中文 bigram） | 58/114 = **50.88%** | [41.82%, 59.87%] | **14/342 = 4.09%** | 4/342 = 1.17% |

- **增益 +19 题（+16.67pp）**；
- 分桶：self/root 17→33、shortRoot 0→1、firstUser 3→5、repeat 19→19。

## 3 · 误判率（"不是放水"的证据 + 它的代价）

```
BIGRAM-FP: 14/342 = 4.09%
  例 bg=2 | 信号「magpie的灵犀插件修复一下报错不走magpie只能路由自」| claim「Error: unknown job bash-…」
  例 bg=2 | 信号「magpie的灵犀插件修复一下报错不走magpie只能路由自」| claim「Error: active teammate "bdace…」
  例 bg=5 | 信号「magpie的灵犀插件修复一下报错不走magpie只能路由自」| claim「我要求的是代码，而不是需要…」
```
- **旧路径（判别词）误判 2.05%**、**硬实体桥 1.17%**、**新 bigram 路径 4.09%**。
- 4.09% 高于另两条，但与原判别词口径的历史基线（4.94%~5.56%）**同量级**，且 **`judgeStrict` 的并集不改 `related`**、单条 bigram（<2）不判中。

## 4 · 3 条人工核（原判 0、现判中）

```
样例 ep-c0a5847a c-d010a5aa bigram=2 token=0 | 信号「E:/Documents/dsh-go/HANDOFF.md 读这个交接文件，然后写方案…」| claim「error: failed to push some refs to 'https://github.com/MYCF711/dsh-go.'」
样例 ep-1e82afca c-ccaf3076 bigram=2 token=0 | 信号「重启好了，你再看看工具调用」| claim「你继续优化，不要老是停下来，然后再去看看deepseek官方团队的论文…」
样例 ep-62bcb7d2 c-cb17dcf2 bigram=3 token=0 | 信号「你读本地的AGENTS和相关文件，然后完善这些文件…」| claim「好，你设一个定时任务，每小时一次，确保另外两个会话不要偏离方向…」
```

| # | 相关吗 | 判断 |
|---|---|---|
| 1 | **弱相关** | 同一 repo（dsh-go），但信号讲交接文件、claim 讲 push 失败 —— bigram 靠「dsh-go/文件」类片段 |
| 2 | **伪命中** | 共享的是「你看」「看看」这类**泛词 bigram**，语义无关 |
| 3 | **伪命中** | 共享「文件」「你」类泛词，语义无关 |

⇒ **增益里有一部分是泛词重合**，不能全算作"真实召回"。这是本刀必须如实标出的代价。

## 5 · 结论与下一步

- **尺子确实错了**（中文整段当 token 不可能命中），修完是 **50.88%**。
- **"原本就取到了但尺子不认"= 19 题**（58−39）；其中按人工核至少有 **2/3 是泛词伪命中** ⇒ **保守估计真实增益约 6~13 题（5~11pp）**，不是 16.67pp。
- **下一步（不在本刀）**：给 bigram 加**判别性过滤**（去掉在库里高频出现的 bigram，等价于 IDF），把 4.09% 的泛词误判压下去。**这一步不做，50.88% 会虚高。**

## 6 · 复现

```bash
node --test "test/a2b-holdout.test.mjs"   # 20 条（含 T284 的 4 条）
node scripts/a2b-holdout.mjs              # 50.88% + 对照组
```
