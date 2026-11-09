# T55 · walk cache 跨 SDK 实例共享：`kifu_search` / `kifu_card` 从 9–10 秒降到 34ms–2 秒

> 2026-11-09 · 接 T54。T54 把 `stats`/`get`/`recent_failures` 拉快了，但 `search`/`card` 仍稳定在 9–10 秒。

## 一、病根

每个 `kifu_*` 工具调用都**新建一个 SDK 实例**（`src/tools.mjs` 的 `run()` 里 `createSdk()`），
而 `createWalkCache()` 是**每实例一份** ⇒ 每次调用重建一次：

```
topics 2.1s + links 5.1s + episodes 0.75s + claims 0.87s ≈ 9 秒   （真库 11083 条 link）
```

T54 只是把它变**惰性**（`stats`/`get` 不付），走图的两个工具照付。

## 二、改法：按 storeRoot 共享 + 两道失效判据

```js
const SHARED_WALK_CACHE = new Map();          // storeRoot -> { sig, at, cache }
export const WALK_CACHE_TTL_MS = 30_000;
```

| 判据 | 抓什么 | 成本 |
|---|---|---|
| ① 目录签名（四个 kind 的**条目数** + 目录 mtime） | 新增/删除条目 | readdir 级：links 11083 个也只要 **4ms** |
| ② TTL 30 秒 | **原地改写**（计数器这类不改条目数的变更） | 0 |

任一不满足就重建。共享按 `storeRoot` 隔离（不同库互不污染），进程退出即丢，不落盘。

**为什么需要 TTL**：`claims` 的 `counters.injections` / `lastInjectedAt` 是**原地改写**，
条目数和目录 mtime 都不变 —— 只有时间能兜住。代价是最多 30 秒的陈旧读数，
对只读查询工具可接受，而且**有上界**（不是"永远陈旧"）。

## 三、改后（真库实测）

```
kifu_search（第一次）   8855ms   ← 建一次 cache
kifu_card  （第二次）   1782ms
kifu_search（第三次）     34ms
kifu_card  （第四次）   2129ms
```

对比 T54 之后：`kifu_search` 9216ms、`kifu_card` 10716ms ⇒ **第二次起快 5–300 倍**，
只有进程内第一次调用仍付那 ~9 秒。

## 四、验收

```
node --test --test-name-pattern "T55" test/sdk.test.mjs → 3/3
  ✔ ① 两个 SDK 实例共用同一份 cache（真库上那 9 秒只付一次）
  ✔ ② 库里新增条目 ⇒ 签名变了 ⇒ 必须重建（不许拿旧图当新图）
  ✔ ③ 签名没变也要过 TTL（原地改写改不了条目数，靠时间兜住）

node --test "test/*.test.mjs" → 1240 条 / 1234 pass / 0 fail / 6 skip（114 秒）
node scripts/check.mjs        → PASS
```

tombstone：把 `walkCache` 改回"每实例自建"（不看 `SHARED_WALK_CACHE`）⇒ T55 ① 变红（build 计数 2）。

## 五、边界

- **进程内第一次调用仍要 ~9 秒**（必须真读一次 sidecar）。要再压下去只能改 `store.list` 本身
  （增量索引 / 二进制格式），那是另一个量级的工程。
- **陈旧上界 = 30 秒**。工具是只读查询；但如果有调用方要求"刚写进去的必须立刻读到"，
  它得绕开这条缓存（目前没有这样的调用方）。
- **没做宿主内端到端实测**：读数是进程内直接 `tool.execute()`；宿主里同一条链，但未在真宿主里计时。
