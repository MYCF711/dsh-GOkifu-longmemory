# T33 · trial 记录（注入之后，失败教训到底复发没）

> 日期：2026-11-08 · 改动：`src/rooms/persist.mjs`（`trials.jsonl` 读写）、`src/rooms/inject.mjs`（判据 + 结算）、`src/plugin.mjs`（注入时接线）、`test/plugin.test.mjs`
> 依据：知识库 93（Zep Agent Skills）第 3 条——**成熟度 + 信任 = 95% Wilson 下界 + trial（检索 ≠ 使用）**。本刀只做 **trial 记录**，**不改可见性、不退役**。

## 0 · 一句话结论

每条被**真正注入**过的 antipattern claim，在下一次注入时把「上一次注入到现在」这段观察窗的结果写进 `<store>/trials.jsonl`（append-only）：

| outcome | 机械判据 | 证据 |
|---|---|---|
| `recurred` | claim 的 `support` 里有 `occurredAt` 落在 `(injectedAt, at]` 的（**同一错误签名在后续局里再次出现**） | 最早那条 support 的 `episode + seq` |
| `avoided` | T30 恢复事实（**同一主体后来成功**）的 `at` 落在 `(injectedAt, at]` | 恢复事实的 `episode + seq` |
| `unknown` | 观察窗里两种证据都没有（**不猜**） | null |

记录形状：`{claimId, injectedAt, outcome, evidenceEpisode, evidenceSeq, at}`；`injectedAt` = **上一次**注入时间（trial 起点），`at` = 本次观察时间。**首次注入只开 trial、不写记录**（没有"上一次"可结算）；`(claimId, injectedAt)` 去重 ⇒ 重放幂等。

## 1 · 三种 outcome 的样本（fixture，`test/plugin.test.mjs` T33 ①）

```jsonc
// recurred：上一次注入（T0）之后，同一错误签名又出现（ep-b, seq 9）
{ "claimId": "c-t33-1", "injectedAt": 1790000000000, "outcome": "recurred", "evidenceEpisode": "ep-b", "evidenceSeq": 9, "at": 1790000060000 }

// avoided：没有新 support，但 T30 恢复事实（同一文件后来写成功，seq 7）落在观察窗内
{ "claimId": "c-t33-1", "injectedAt": 1790000000000, "outcome": "avoided", "evidenceEpisode": "ep-a", "evidenceSeq": 7, "at": 1790000180000 }

// unknown：两种证据都没有
{ "claimId": "c-t33-1", "injectedAt": 1790000000000, "outcome": "unknown", "evidenceEpisode": null, "evidenceSeq": null, "at": 1790000060000 }
```

**观察窗**（`until = at`）是硬约束：早于注入的证据不算（`at <= injectedAt` 不算），**晚于本次观察时间的证据也不算**（写这份记录时它还"没发生"）。T33 ① 有一条专门钉"恢复事实早于注入 ⇒ 不算"。

## 2 · 为什么用 support 当"复发"、用恢复事实当"避免"

- **复发**：claim 的 `support` 就是「同一错误原文在哪些局被看到」——`promoteClaim` 合并的是**同一错误签名**（错误行文本/文件路径），所以 `support` 里出现晚于注入时间的一条，就是"这个坑又踩了一次"。这是**已有的权威字段**，不需要再解日志。
- **避免**：复用 T28/T30 的恢复事实（同一命令/同一文件后来成功），`at` 晚于注入时间 ⇒ 注入之后同类主体成功过。
- 两者都只读 sidecar（claims + `recovery-index.json`），**热路径不解会话日志**。

## 3 · 接线（`src/plugin.mjs`）

在 `decidePreStep` 真正 `action: 'inject'` 的返回点之前：

```js
try {
  const antipatterns = (Array.isArray(card?.claims) ? card.claims : []).filter((c) => c && c.kind === 'antipattern');
  if (antipatterns.length) recordInjectionTrials({ storeRoot, claims: antipatterns, at });
} catch (error) { warn(ctx, `trial 记录失败（已忽略）：…`); }
```

- **只对真正注入的行记录**（shadow / abstain / skip / 闸挡下 都不记录——那些没有"被模型看到"）。
- 失败静默：记 trial 不许影响本轮注入。
- 一次注入最多写"上一次注入的结算"若干条，**不会**给当前这次注入写真伪未知的 outcome。

## 4 · 纪律

| 纪律 | 做法 |
|---|---|
| **只增不改** | `appendTrials` 只追加 JSONL，从不重写历史；文件不存在 ⇒ 不创建（没有可结算的 trial）。 |
| **幂等** | 同一 `(claimId, injectedAt)` 只写一条（`readTrials` → 去重 → 追加）；T33 ② 实测重放 `appended 0`。 |
| **不重写历史 / 不回填** | 存量 claim 一条都不补：真库 1560 条 antipattern 里 `counters.lastInjectedAt > 0` 的 **0 条**（当前影子模式没有真注入）⇒ `trials.jsonl` 现在**不存在**（tombstone：行为与现状一致）。 |
| **不改可见性 / 不退役** | 本刀只写文件；walk / 卡片 / 闸门都不读 trials。 |
| **坏行不炸** | `readTrials` 丢弃坏行并计数（`badLines`），不抛。 |

## 5 · 测试（`test/plugin.test.mjs`，4 条全绿）

| # | 断言 |
|---|---|
| T33 ① | 三种 outcome 的机械判据：recurred（新 support 在窗内）/ avoided（恢复事实在窗内）/ unknown；**早于注入的恢复事实不算** |
| T33 ② | 首次注入写一条（`injectedAt` = 上一次注入时间），重放 `appended 0`（幂等） |
| **T33 ③（tombstone）** | 没有历史（首次注入且 `counters.lastInjectedAt` 缺失）⇒ `appended 0` 且**不创建** `trials.jsonl` |
| T33 ④ | 恢复事实来自 T30 索引：第一次注入（早于恢复）⇒ `unknown`；第二次注入（晚于恢复）⇒ `avoided` + 证据 seq |

修过的一个真实坑：`Number(null) === 0` 是合法数字，早期把"从未注入"误当成"注入时间 = 0"⇒ 会凭空写出 `recurred`。修法：只有**正数**才算注入时间（null / 0 / 缺失 = 从未注入），T33 ③ 钉住。

## 6 · 限制 / 后续（Wilson 下界方向）

1. **现在没有数据**：真库 0 条真注入 ⇒ `trials.jsonl` 还不存在。要等**真注入**（`enabled: true` + 非 shadow）跑起来，一周后才有"哪些 claim 的 recurred 率高"。
2. **口径是代理**：`recurred` 用 claim 的 support 判"同一错误签名再现"，`avoided` 用恢复事实判"同一主体后来成功"——都是**事实**，但都不等于"模型因为这张卡避开了坑"（那是 ablation 的口径）。两个口径互补：ablation 证明"卡有用"，trial 记录"这条记忆后来有没有被现实打脸"。
3. **观察窗**取"相邻两次注入之间"：注入很频繁的 claim 窗口短，可能频繁落 `unknown`（宁缺勿编，不拿更远的证据凑）。
4. **退役判据还没写**：本刀只记录。下一刀（Zep 方向）用 `recurred` 率 + Wilson 95% 下界决定"退役/降权"，需要先攒 ≥N 条 trial，并且要另立证据（改可见性属于方向问题）。
5. **shadow 模式不记录**：当前环境默认影子，`trials.jsonl` 不会增长；这是有意的（影子没被模型看到，记 trial 会是假数）。

## 7 · 复现

```bash
node --test --test-name-pattern "T33" test/plugin.test.mjs
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- 三种 outcome：recurred（新 support 在窗内）/ avoided（T30 恢复事实在窗内）/ unknown（无证据）；
- 幂等：同一 `(claimId, injectedAt)` 只一条，重放 `appended 0`；
- tombstone：没有历史 ⇒ **不创建** `trials.jsonl`（T33 ③）；真库 `trials.jsonl` 目前不存在；
- 不改可见性：walk/卡片/闸门均不读 trials（只写 sidecar）。