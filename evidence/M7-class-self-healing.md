# M7 · 类级章节自愈 + 只读审计（2026-11-02）

## 问题
`claim.mjs` 的类表历史上只有 5 类，`topic.mjs` 有 8 类 ⇒ 部分错误类**卷里能成主卷、claim 里没有章节**
（`class:module-missing` 5 局、`class:policy-human-turn` 2 局都缺章节）。旧 claim 只增不改，光对齐类表不会回溯。

## 两个改动（都不删旧条目）
1. `claim.mjs` 新增 `ensureClassClaims()`：对「有 ≥2 局支撑、却缺类级 claim」的类，补一条
   `class:<name> · <代表错误>`，support = 各单条 claim 支撑的去重并集，id 由「类名 + 作用域」决定 ⇒ **幂等**。
2. `scripts/class-audit.mjs`：只读审计（每类单条数 / 覆盖局数 / 是否已有类级章节）。

## 实测（本机 116 局 store）
| 指标 | 改前 | 改后 |
|---|---|---|
| 有类级章节的错误类 | 4 / 6 | **6 / 6** |
| 缺章节的类 | module-missing、policy-human-turn | 0 |
| claim 总数 | 291 | 293（只增，未删旧条目） |

六轴不受影响：A1 0.00% / A5 0.00% / A6 100% / A4 p50 1.94ms；A2b 严格仍 70.59%（这 2 类不在切分后的测试集里）。

## 说明
- 旧库的逐条 claim 仍然保留（只增不改），所以会出现「类级章节 + 若干单条」并存——这是设计，不是重复扣分。
- 审计脚本的 `claimsThatWouldFold` 只在**缺章节**的类上非零，用于判断"是否值得做一次受控重算"。
