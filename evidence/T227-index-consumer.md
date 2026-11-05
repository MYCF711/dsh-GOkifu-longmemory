# T227 · `mergeRepresentativeOf` 没有消费者 ⇒ 移除（方案 B）

- 日期：2026-11-05
- 作者：path-walker（R11）
- 结论：**选 B（移除）**。walk 侧的反向索引与 R12 自己的 `mergeIndexByMember(view)` 重复，
  生产代码零消费者，每次 walk 白扫一遍 claim ⇒ 删掉，行为 golden 不变。
- 可重放补丁：`tmp/t227-redo.cjs`（幂等、anchor 不匹配抛错、原子写）

---

## 1 · 消费者证据（audit-13 §② 复核）

```
$ grep -rn "mergeRepresentativeOf" --include=*.mjs src/ scripts/ | grep -v "src/rooms/walk.mjs"
(无输出)
```

T208 建的 `result.mergeRepresentativeOf`（`Map<memberId, representativeId>`，构建 0.016 ms / 查询 192× 快于全表扫）
**只在 `walk.mjs` 自己和 `test/walk.test.mjs` 里出现**。

而且 R12 侧**不需要**它：`src/rooms/inject.mjs` 的 `collapseMergeNodes()` 里有自己的反向索引

```
inject.mjs:722  function mergeIndexByMember(view)   // 成员 id → 合并节点 claim，每张卡构建一次
inject.mjs:795  const byMember = mergeIndexByMember(view);
inject.mjs:796  if (!byMember.size) return { entries: list, stats };  // 没有合并节点：零成本直通
```

且 `src/rooms/inject.mjs` 里**没有任何** `merge.members.includes(...)` 形态的全表扫。
=> walk 侧索引既无消费者、也不被任何"成员 → 代表"的快速路径需要。

判词：**"192×" 是为一条不存在的快速路径付的构建成本**（未消费的索引是纯成本，
`AGENTS.md` §2.4「指标先有消费者」的同族）。

## 2 · 移除内容

`src/rooms/walk.mjs`（相对 T208 之后的版本，`git diff --numstat`）：

```
7	69	src/rooms/walk.mjs
9	44	test/walk.test.mjs
```

- 删 `buildMergeRepresentativeIndex()`（含文档注释）；
- 删结果字段 `mergeRepresentativeOf`（`emptyResult` 与最终 `return` 各一处）；
- 删 `dropped.mergeCrossScopeMembers`（它只服务这个索引；真数据里跨域成员本来就是 0 个，
  A5 守卫从未被锻炼 —— 与 audit-13 一致）；
- `claims` / `claimById` 从 `emptyResult` 之前**挪回** claim 段（撤销 T208 的提前读）；
- 头注释 / JSDoc 恢复 T208 之前的写法。

**验证**：删除后的 `src/rooms/walk.mjs` 与 `git show ce9f2ab^:src/rooms/walk.mjs`（T208 之前）
**逐字节相同**：

```
$ diff -q tmp/pre-t208-walk.mjs src/rooms/walk.mjs
IDENTICAL
```

## 3 · walk 耗时变化（真库、同一批信号、交替采样 N=40、取中位数）

```
A（T208 带索引） 中位数 46.116 ms · min 40.121 ms
B（T227 移除后）  中位数 45.965 ms · min 38.629 ms
差值（B−A）      -0.151 ms（N=40，交替采样）
A 结果字段: Map(96) · B 结果字段: (无)
```

- 噪声地板：同一模块 A/B 自比（`t227-before-walk.mjs` vs 自己）时差值是 **+0.455 ms**，
  所以 **−0.151 ms 在噪声内**；
- 可确证的收益是"不再构建"：T208 实测**单次构建 0.0163 ms**（39 节点 / 96 成员，1000 次平均，
  脚本 `tmp/t208-bench2.mjs`），加上一次 1379 条 claim 的 map 遍历；
- 如实写：**walk 端到端耗时变化 ≈ −0.15 ms（在噪声内，不是"变快 192×"那种量级）**。

## 4 · 测试与回归

```
$ node --test "test/walk.test.mjs"
ℹ tests 31
ℹ pass 31
ℹ fail 0
```

- 删掉 3 条索引用例（成员→代表 / 跨域不建索引 / 无 merge 的库），换成 1 条
  「walk 结果**不再**带未消费的反向索引 + 行为 golden」：断言 `mergeRepresentativeOf` 不存在、
  `dropped.mergeCrossScopeMembers` 不存在、命中集合仍是 `['c-mem-02','c-mem-01']`（occurredAt 降序）、
  合并节点不冒充 claim 行、跨域成员不带。
- 合流验收（源库用合流前快照）：

```
$ node scripts/merge-acceptance.mjs --store tmp/t170-shadow --source "$DSH_HOME/memory-context.pre-T201" --sample 10
| ① | 同文重复行（逐组配对） | 反例 0 张卡 · 合计 1 → 1（降 0.00%，10 张卡） |
| ② | 合并契约 | 不可解析成员 0 / 96 个（39 组）· 闸 4 错误 0 |
| ③ | 跨作用域 | 0 张卡非零（共 10 张） |
| ④a | 不许变差 | 反增 0 组 / 共 39 组 |
| ④b | 不许丢内容 | 丢行 0 行 / 0 组 |
| ④c | 参考 | 命中 25 / 39 组 · 折叠 25 组 · 100.0% · collapsed 58 行 · bubbled 28 行 |
```
（注：`--source "$DSH_HOME/memory-context"` 现在与影库 claim 集相同（1379 条），
验收脚本按前置闸直接 `exit 2`；对照组必须指向合流前快照 `memory-context.pre-T201`。）

## 5 · 如果将来真出现"成员 → 代表"的消费者

不要重新在 walk 里建索引，直接用 R12 已有的 `mergeIndexByMember(view)`（每卡一次，O(总成员数)）；
若确实需要跨卡复用，就从 `walkFromSignals` **返回值**里带（那时再加），并同时满足：

- 成员与代表**同 scopeKey**（A5，逐字节）；
- 跨域成员**不建索引**，跳过数计入 `dropped`；
- 结构用 `Map` + 非枚举 `toJSON`（可序列化）；
- 有**真实消费者**（`grep` 在生产代码里能查到调用点）才允许合入 —— 否则按本单处置。

T208 版实现（含 `buildMergeRepresentativeIndex`、`toJSON`、A5 守卫）保留在
`git show ce9f2ab:src/rooms/walk.mjs`，需要时可原样取回；`ce9f2ab` 的测试在
`git show ce9f2ab:test/walk.test.mjs` 末尾三条。
