# T69 · 边的 seq 取错了那一头：89.3% 的图来源引文因此对不上

> 2026-11-09 · 接 T66（分桶）/ T68（按来源分桶）。这一刀修的是**根因**，不是统计口径。

## 一、病灶（一行代码）

```js
function edgeSeq(edge) {
  const ev = edge?.evidence ?? {};
  if (Number.isFinite(ev.start)) return ev.start;   // ← 无条件先取「动作」事件
  if (Number.isFinite(ev.end)) return ev.end;
  return null;
}
```

而 `edgeQuote()` 优先取的是**结果侧**文本：

```js
const snippet = String(edge?.errorSnippet ?? '').trim();          // 结果事件里的报错原文
if (snippet && !isTestPassSummary(snippet)) return snippet;
if (edge?.result === 'failure') { const summary = ...verify.summary...; ... }
```

图边自带 `evidence: {start, end}`：`start` = 动作事件（tool/call），`end` = 结果事件（tool/result）。
**引文取自结果侧，seq 却指向动作侧** ⇒ 天然对不上。

## 二、真库实测（拿一条真边验）

```
graph: sessions/session-c0a5847a-.../graph.json · edge e6793
  evidence   = { start: 50332, end: 50334 }
  errorSnippet = "Error: unknown job bash-49fb11d400eb4696"
  claim support.seq = 50332（旧：取 start）
  日志真身         = seq 50334（tool/result）← 引文在这里

改后 edgeSeq(e6793) = 50334   ✅ 与引文同一条事件
```

这条链解释了 T68 的分桶：**图来源 403 条坏 360（89.3%）· 信号来源 71 条坏 1（1.4%）**。

## 三、改法

`edgeSeq()` 按**引文来源**决定取哪一头：

| 引文来源 | 取哪一头 |
|---|---|
| `errorSnippet`（且不是测试通过汇总） | `evidence.end` |
| `verify.summary` 且 `verify.kind ∈ {exit, host-error}` | `evidence.end` |
| 其余（`action` / `intent`） | `evidence.start` |

取不到对应那头再退另一头；两头都没有 ⇒ `null`（不猜、不编）。判据与 `edgeQuote()` **同一口径**（含 T251 的"测试通过汇总不算失败原文"）。

## 四、验收

```
node --test test/t69-edge-seq.test.mjs → 5/5
  ✔ ① errorSnippet ⇒ end   ② verify.summary(exit/host-error) ⇒ end
  ✔ ③ 只有 action ⇒ start  ④ 测试通过汇总 ⇒ 仍 start（T251 同口径）
  ✔ ⑤ 缺对应那头退另一头；两头都没有 ⇒ null

node --test "test/*.test.mjs" → 1275 条 / 1269 pass / 0 fail / 6 skip
node scripts/check.mjs        → PASS
```

## 五、诚实说明

- **历史数据不变**：已入馆的 claim 不会回填（只增不改）。这条修的是**生成侧**，
  所以 `provenance-p2` 的 `ok` 数这一版**不会跳** —— 效果要等**新归档**的 claim。
- 上游 `graph.json` 没问题（`evidence.end` 本来就对）；错在我们**选错了那一头**。
- 下一步若要让历史也可核，只能出**迁移**（重算并写 `supersedes`），不是本轮该顺手做的事。
