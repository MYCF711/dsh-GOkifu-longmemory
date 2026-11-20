# T388 · 真跑时跳过第一次全量派生（省 ~14 秒），但归档仍 >900 秒

## 一、代码事实（读代码确认，不是猜）

`archive.mjs` 里 `deriveStore` 被调用两次：

| 位置 | 输入 | 用途 |
|---|---|---|
| `:742`（第一次） | **内存里本次构建的** episodes | 只用于 ① `skipped` 提示 ② summary 数字 ③ **dry-run** 的 `wouldWrite` 预估 |
| `:842`（第二次） | **从 store 回读的** episodes | **真正的写入源**（`replaceDerived` topics/links/threads + index.md + manifest） |

⇒ 非 dry-run 时第一次派生的结果是**白算**的（改写不了任何东西）。

## 二、改动

```js
const derived = dryRun ? await deriveStore({ episodes, ... }) : null;
if (derived) for (const note of derived.skipped) skipped.push(note);
```

`summary.derived` 在真跑时改为从 `derivedFromStore` 回填（与写入同一份结果，数字不会跑偏）。
`dry-run` 路径**完全不变**。

## 三、实测

| 项 | 结果 |
|---|---|
| `test/archive.test.mjs` | **11/11** |
| `archive --incremental --json` 全链 | **仍 >900 秒（超时）** |

**所以这 14 秒省下来了，但不够。** 归档的主成本在**写盘阶段**：
`derivedFromStore` 产出 **215,410 条 link**，而库里实际只存 29,293 条 ⇒ 大量条目录入后被 `replaceDerived` 丢弃。

## 四、结论与下一步

1. 本次改动**保留**（纯正向、语义等价、测试通过、节省 14 秒）；
2. **归档仍跑不完**，主因是"派生 21.5 万 → 只留 2.9 万"的写盘/替换路径；
3. 下一步应量 `replaceDerived` 的耗时构成（序列化 / 目录扫描 / 删除 / manifest），
   再决定是**减少派生量**还是**优化替换算法**；
4. 在这些完成之前，**不要再声称"归档已优化"** —— 它仍然跑不完。
