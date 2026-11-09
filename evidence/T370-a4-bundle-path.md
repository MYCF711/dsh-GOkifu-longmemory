# T370 · A4 量的是**生产不走的那条慢路**（并且它会撞 50ms 门槛）

> 2026-11-09 · 起因：发版被 `ledger-check --full` 拦下 —— `A4 p50 实测 53.16ms > 门槛 50ms`。

## 一、现场

- 今天早些时候台账里 A4 p50 是 **27.8 / 29.8ms**；到晚上实测变成 **43–56ms**（三次：43.55 / 46.40 / 55.94）。
- 门槛是硬的 50ms（`ledger-check.A4_GATE_MS`，与 `metrics-guard.a4p50MaxMs` 同源）—— 已经开始假红。

## 二、根因：评测用的 store 与生产的 store **不是同一条路径**

| 谁 | store 怎么建 |
|---|---|
| 生产（`sdk` / `plugin`） | `createStore({ root, bundle: true })` —— T62 的单文件 bundle 快路径 |
| `scripts/m5-report.mjs`（A4/A5/A6 的来源） | `createStore({ root })` —— 默认**逐文件读** |

而 A4 的 caveat 自称「与插件热路径同一条链」——**链是同一条，store 不是**。
于是 A4 量的是生产根本不走的那条慢路，并且随语料增长（1654→1908 局、11083→14320 link）越来越慢。

## 三、改法

`runPipeline()` 里换成生产同款 store（**只在能拿到 `root` 时**，测试给的假 store 没有 root ⇒ 原样用）：

```js
const ioStore = (typeof store?.root === 'string' && store.root)
  ? createStore({ root: store.root, bundle: true })
  : store;
```

顺带修正两处**口径谎言**：

1. `ledger-sync` 写的「3 次中位数，单次抖动 **±2ms**」—— 实测跨批 **33–56ms**，抖动远大于 ±2ms ⇒ 改成实测区间；
2. 测试里的 `hashTree()` 现在跳过顶层 `.cache/`：那是**派生物**（`rm -rf .cache` 只让下次变慢），
   "只读"要保的是权威数据一个字节不变 —— 冷读产生一次 `.cache` 写入不等于"写了 store"。

## 四、读数

```
A4 p50（同一条链，真库 1908 局）：
  bundle 关（旧口径） : 43.55 / 46.40 / 55.94 ms   ← 撞 50ms 门槛
  bundle 开（生产口径）: 33.24 / 33.24 / 37.38 / 34.45 / 41.30 ms
台账记录（3 次中位数）: 38.76ms
```

其余轴不变：A2b 严格 **46.6%**、覆盖 79.7%、A5 **0**、A6 **1**、A1 0。

## 五、还有一笔账没还（下一刀）

同一条链上按阶段拆：**walk 31.1ms / card 0.9ms / gates 0.1ms**（中位，共 33.1ms）。
⇒ A4 的 94% 是 `walkFromSignals` 本身。它每次要扫全库（1908 局 + 14320 link），
要再降一个量级得给 walk 建**主题倒排索引**（不是再调 store）。这是独立设计题，本刀不碰。

## 六、验收

```
node --test test/m5-report.test.mjs → 17/17（含"只读"与"缓存减少磁盘读"两片）
node --test "test/*.test.mjs"       → 1292 条 / 1286 pass / 0 fail / 6 skip
node scripts/metrics-guard.mjs      → PASS（A4 p50 33–41ms，不再撞门槛）
```
