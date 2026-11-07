# T4 · 可解释的拒绝（abstain 说出拒的是哪道门）

> `[本] 2026-11-07` · `src/plugin.mjs` 的 `classifyAbstainReason` · 测试 `test/abstain.test.mjs`

## 1 · 问题

`abstain` 触发时 `reason` 永远是同一个字符串 `'no-relevant-claim'`。这**分不清三种完全不同的处境**：

| 真实处境 | 该做的事 | 修前的 reason |
|---|---|---|
| 库里根本没有相关记忆 | 放弃，换别的办法 | `no-relevant-claim` |
| 库里有，但只有**一局**支撑，拿不准 | 去核实那一局 | `no-relevant-claim` |
| 库里有，但全被**作用域/时效**挡了 | 去**别的项目**查 | `no-relevant-claim` |

模型和事后审计看到的是同一个字符串 ⇒ **拒绝不可解释**。

## 2 · 做法

新增 `classifyAbstainReason({ card, walkResult })`，**只在 `abstain` 已触发时**细化 `reason`。

**判据全机械**（AGENTS §2.3：计数不是打分，禁止模型评分），按**从具体到泛化**排序：

| # | reason | 判据 |
|---|---|---|
| ① | `cross-scope` | walk 的 `crossScope + unknownScope + crossScopeWalk > 0` —— 命中过，但全被作用域挡掉 |
| ② | `stale` | 卡上**每一行**的 `decay < 0.5` —— 全部超过半衰期（30 天）没被调用 |
| ③ | `low-confidence` | 卡上**每一行**都是 `state === 'observed'` —— 只有 1 局支撑 |
| ④ | `no-relevant-claim` | 兜底：卡上有行，但与信号没有可判别的重合 |

**注意 ②③ 用的是 `every` 不是 `some`** —— 混合状态（一行 observed + 一行 semantic）不算低置信，
落回兜底。测试里钉了这条（不然会把「有强证据也有弱证据」误报成「拿不准」）。

## 3 · 为什么不改默认行为（验收 ③）

```js
return { decision, action: 'abstain', reason, card, gates, digest };
```

`action` 仍是 `'abstain'` —— **不注入、不改变任何决策**。所有按 `action === 'abstain'` 计数的口径
（`live-stats.jsonl` 的心跳）**一字不动**；变的只是 `reason` 这个诊断字符串。

## 4 · 验收

| 项 | 结果 |
|---|---|
| ① `reason` 按判据分类（不是单一 `no-relevant-claim`） | ✅ 四类 |
| ② 拒绝时可解释（说明"拒的是哪道门"） | ✅ 四类各自对应一个该做的动作（见 §1 表） |
| ③ 不改默认行为（向后兼容） | ✅ `action` 不变；空输入也返回合法分类 |
| ④ `node --test test/abstain.test.mjs` | ✅ **17 条 / 17 pass / 0 fail** |

测试覆盖了 6 个断言组：四类各一条 + 空输入 + `every`/`some` 的反例。

## 5 · 未验 / 边界

- **`stale` 这一类在真库上还没跑过**：`entryFromClaim` 会把 `state === 'stale'` 的 claim
  **直接返回 null**（不渲染），所以「全卡皆 stale」在线上可能**结构上不可达**；
  这里的 `stale` 判据用的是**衰减权重**（`decay < 0.5`），不是 `state`，与渲染层的过滤**不冲突**。
  真实分布要等 T6（线上验证）才能给数 —— **本刀不声称它在线上出现过**。
- 四类的**实际占比**也没测：需要真实宿主流量（T6）。
