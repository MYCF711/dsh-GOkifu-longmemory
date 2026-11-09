# T58 · 自证污染核查把「卡引用 claim」判成了红线：退出码 1 是假的

> 2026-11-09 · 触发：跑 `node scripts/self-contamination-audit.mjs` 拿到 **exit 1**（红线），
> 但证据链里每一条的 `direction` 都写着 `card-from-claim`。

## 一、症状

```
node scripts/self-contamination-audit.mjs ; echo EXIT=$?
in-ledger=1 · 远偏移命中=1887 · self-contaminated=60（refs 1.39% / claims 1%，24 条 claim）
EXIT=1                      ← 判成红线实例

--samples 100 的 details：direction 分布 = {"card-from-claim": 60}   ← 60/60 全是反向
```

而脚本**自己的契约**（文件头 §维度 B）写着：

> 反向也要排除：若卡的渲染时间**晚于** claim 的 `recordedAt`，说明是**卡引用了 claim**，
> 不是 claim 引用了卡 ⇒ `direction='card-from-claim'`（**不算"卡→claim"的 F5 实例**，
> 但说明 claim 的 quote 本身是**改写**而非原文 —— 那是 P2 问题）。

契约说"不算"，结算却算进去了。

## 二、根因（两处不一致）

1. **方向只算抽样**：`direction` 在 `details` 循环里算，而 `details` 默认只取 5 条（`detailLimit`）。
2. **结算用未区分方向的总数**：`stats.selfContaminated = contaminated.length`，
   退出码 `return result.stats.selfContaminated > 0 ? 1 : 0`。

于是"60 条全是反向"这件事**在汇总和退出码里根本看不到**，只有翻证据链才发现。

## 三、改法

```js
// 方向在**全量** contaminated 上算（60 条，成本可接受；按 episode 缓存 events）
for (const row of contaminated) directionByRow.set(row, classifyDirection(earliestCardOf(...), row.claimRecordedAt));

stats.claimFromCard    = 卡早于 claim（真 F5 嫌疑）
stats.cardFromClaim    = 卡晚于 claim（反向，属 P2 改写）
stats.directionUnknown = 算不出来 ⇒ fail-closed
stats.realF5           = claimFromCard + directionUnknown

return result.stats.realF5 > 0 ? 1 : 0;      // 只看真 F5
```

`classifyDirection()` 抽成**纯函数**并导出（可单测）；时间戳相同按 `card-from-claim`（严格小于才算"卡早于"）。

## 四、改后读数（本机真库）

```
self-contaminated=60（refs 1.39% / claims 1%，24 条 claim）
方向拆分（T58）：真 F5（卡早于 claim + 方向不明）= **0** · 卡早于 claim=0 · 卡引用 claim=60 · 方向不明=0
EXIT=0
```

这与 T245 当时的结论（提交信息里写的「真 F5 = 0」）**一致** —— 也就是说这次不是新出现污染，
是**判据一直把反向案例算成了红线**，只是没人跑这个脚本去发现。

## 五、验收

```
node --test test/self-contamination-audit.test.mjs → 5/5
  ① 卡早于 claim ⇒ claim-from-card        ② 卡晚于 claim ⇒ card-from-claim
  ③ 时间相同 ⇒ card-from-claim            ④ 算不出来 ⇒ unknown（fail-closed）
  ⑤ 源码契约：退出码只看 realF5、方向必须在全量上算（改回去即红）

node scripts/self-contamination-audit.mjs ; echo EXIT=$?   → EXIT=0
node --test "test/*.test.mjs" → 1246 条 / 1240 pass / 0 fail / 6 skip
node scripts/check.mjs        → PASS
```

## 六、边界

- **那 60 条不是"没问题"**：它们是 `quote-not-substring`（引文不是原文子串）——P2 指针精度问题，
  该由 `scripts/provenance-p2.mjs` 那条线管，不该塞进红线计数里。本轮**没有**去修那 60 条，
  只是把它们归到正确的账上。
- **`direction='unknown'` 仍算真 F5**（fail-closed）：读不到事件时不许当作"没事"，
  这是刻意选择，宁可假红也不放假绿。
- 这只是让**判据**对上契约；`self-contaminated` 这个总数仍保留（便于横向对比），
  但**不再**参与退出码。
