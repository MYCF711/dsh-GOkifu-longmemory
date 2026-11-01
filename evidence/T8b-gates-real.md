# T8b 实测 —— R10/R13 闸门在真实语料上的表现

> `[本] 2026-11-02 03:5x` · 工作树（未提交）· 语料 = `tmp/memory-context`（T6a 从本机真实会话入档）
> 口径：**只读**跑一遍，不写 `<DSH_HOME>`、不改 store。

## 1 · 复现命令

```bash
# 闸 2 / 闸 5 对存量 125 条 claim 的误伤检查
node tmp/gates-real.mjs tmp/memory-context

# 作用域可见性矩阵
node tmp/scope-matrix.mjs "D:/DeepSeek Harness/default-workspace/长期记忆系统"
node tmp/scope-matrix.mjs "w:e:/Documents/deepseek-harness/default-workspace"

# 把 records/scope 真正喂给 runGates，跑 20 张真实影子卡
node tmp/gate-real-cards.mjs      # 汇总：2 过 / 18 红
node tmp/gate-real-detail.mjs     # 明细：93 行里 52 行越界
```

## 2 · 存量 claim（125 条）

| 指标 | 值 |
|---|---|
| state 分布 | `observed` 120 · `candidate` 5 |
| support 局数分布 | 1 局 117 · 2 局 3 · 3 局 4 · 6 局 1 |
| 闸 2（state 与计数匹配）违规 | **0** |
| 闸 5（每条有 quote、非摘要）违规 | **0** |
| 作用域分布 | `w:e:/Documents/deepseek-harness/default-workspace` 113 · `w:d:/DeepSeek Harness/default-workspace/长期记忆系统` 11 · `u:owner` 1 |

**结论**：闸 2 / 闸 5 的口径与 M2 入档的真实数据自洽，不会一开就红一片。

## 3 · 闸 1 作用域矩阵

| 当前作用域 | 可见 | 不可见 |
|---|---|---|
| `w:d:/…/长期记忆系统` | 12（11 同域 + 1 用户层） | 113 |
| `w:e:/…/default-workspace` | 114（113 同域 + 1 用户层） | 11 |

`u:owner` 在两种工作区下都可见 —— 用户层跨项目生效（方案 §4.10）。

## 4 · 20 张真实影子卡（records + scope 都喂满）

| 指标 | 值 |
|---|---|
| 卡片 | 20 |
| 通过 | 2 |
| 失败 | 18（**全部** `gate1/scope-mismatch`） |
| 渲染行 | 93 = 同域 41 + **越界 52** |
| 卡片形态 | 6 张全越界 · 12 张混合 · 2 张干净 |
| 其它闸 | 闸 2/4/5/7 报错 0；`gate3/validity-unchecked` 记 unverified |

**结论**：R11 walk 只按主题走、不按作用域过滤，真实数据里 52/93 行来自另一个工作区。闸 1 一开就把这条 F2（作用域越界）抓出来 —— 这是本轮最有价值的一条实测。

## 5 · 接上 CLI 路径之后（R12 过滤 + 闸门吃 store/scope）

```bash
node tmp/cli-sweep.mjs      # 20 条信号走 runInject（CLI 同一条路径）
```

| 指标 | 值 |
|---|---|
| 闸门通过 | **20 / 20**（接上之前是 2/20，18 张红在 `gate1/scope-mismatch`） |
| 零注入 | 7 / 20 |
| 有内容 | 13 / 20 |
| 跨域被挡（`card.crossScopeWalk`） | 19/20 张卡发生过；合计 361 条 |
| 卡内越界行 | **0** |
| token 最坏 | 300（预算 500） |
| 真核到的闸 | 1 / 2 / 4 / 5（`checks.*Checked` 有数）；`gate3/validity-unchecked` 仍是 unverified |
