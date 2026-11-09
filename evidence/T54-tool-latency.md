# T54 · 记忆工具在真库上一次调用要 10–20 秒：全量解析 + 白付的 walk cache

> 2026-11-09 · 触发：查「测试套件偶发卡死」时看最慢的一条（`T213 真库只读` 103.7 秒），
> 于是直接量了五个 `kifu_*` 工具在**真库**上的单次耗时。

## 一、改前（真库 1654 局 / 2410 claim / 11083 条 link）

```
kifu_stats            20298ms
kifu_search            8957ms
kifu_card             11026ms
kifu_recent_failures  10014ms
```

这些是**模型直接调用**的工具 —— 一次调用十几秒，等于每次查记忆都卡住。

## 二、时间花在哪（逐项量出来，不猜）

**① 计数走了全量解析**：`sdk.stats()` 对 7 个 kind 各调一次 `listSafe()`（`store.list()` = 逐个文件读 + JSON.parse），
而它要的只是"有多少条"。

```
store.list(kind) 实测：
episodes   747ms  n=1654      links    5127ms  n=11083   ← 一个 kind 就占一半
claims     868ms  n=2410      threads   625ms  n=748
topics    2072ms  n=4417      joseki     13ms  n=34
```

`store.ids(kind)`（只 readdir、不解析）在 links 上是 **4ms** —— 同一件事，差三个数量级。

**② walk cache 在 `ensure()` 里**：`createWalkCache(store)` 一次性把 topics/episodes/links/claims
全读进来（≈9 秒），但只有 `walk`/`card` 需要它；`stats`/`get`/`recent_failures` 白付这笔钱。

## 三、改法（两处，都不改读数语义）

1. `sdk.stats()` 的计数改走 `store.counts()`（文件名层）。
   唯一语义差异：**文件名坏掉的条目**，`list()` 会算成一个 `error` 条目、`ids()` 跳过 —— 那种文件不该计入。
2. `createWalkCache` 改成**惰性**（`walkCache()` 首次用到才建）。

## 四、改后

```
kifu_stats            20298ms → 1698ms   （11.9×）
kifu_recent_failures  10014ms → 1136ms   （ 8.8×）
kifu_get                 ~9s →    2ms    （惰性缓存不再拖累纯读）
kifu_search            8957ms → 9216ms   （未变：它真的要 walk，见下）
kifu_card             11026ms → 10716ms  （未变：同上）
```

## 五、验收

```
node --test --test-name-pattern "T54" test/sdk.test.mjs → 2/2
  ✔ T54 ① stats().counts 与逐 kind 全量解析的条数**逐项相等**（换数法不改读数）
  ✔ T54 ② 只调 stats/get 不构建 walk cache（行为判据：两者结果仍正确）

node --test "test/*.test.mjs" → 1237 条 / 1231 pass / 0 fail / 6 skip（114–116 秒）
node scripts/check.mjs        → PASS
```

## 六、没做的（明写，别当已完成）

- **`kifu_search` / `kifu_card` 仍是 ~9–10 秒**：它们本来就要走图，而这 9 秒是每次调用重建一次
  walk cache（`buildMemoryTools()` 每次 `execute` 都会新建一个 SDK 实例）。
  真正要解决它得把 walk cache **跨实例共享**（模块级 + 目录签名失效）——那是另一刀，
  本轮没做，因为它会引入"缓存何时失效"的正确性问题，不能在赶进度时顺手塞进去。
- **没做端到端的宿主内实测**：上面是进程内直接调 `tool.execute()`。宿主里同样走这条链，
  但"模型视角的真实等待"还包含宿主自身的开销，未测。
- **没碰 `store.list()` 本身**（它仍每次全量读）：换缓存要在"sidecar 只增不改"的语义下做失效判定，
  属于独立设计题。
