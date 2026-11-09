# T376 · H1 的 store 也要走生产那条路径：32.5s → 11.9s，**读数逐项不变**

> 2026-11-10 · 同一类病灶的第三个受害者（前两个：m5-report 的 A4（T370）、walk 的索引（T371））。

## 一、病灶

`scripts/eval.mjs` 的 `runH1()`：

```js
const store = createStore({ root: storeRoot });   // ← 默认：逐文件读
```

而生产（`sdk` / `plugin`，以及 T370 之后的 m5-report）都是 `createStore({ root, bundle: true })`。
H1 要跑几十条信号 × 每条一次 walk→card→gates，于是"读得慢"被放大几百倍 ——
没人愿意跑，A1/A2 这些轴就没人看（「指标先有消费者」的另一面：**消费者得跑得动**）。

## 二、改法

```js
const store = createStore({ root: storeRoot, bundle: opts.bundle !== false });
```

默认走 bundle（生产同款），**显式 `bundle: false` 才回退旧路径** —— 给对拍和排查留一条路。

## 三、读数（真库 1917 局，signals=12）

```
bundle 关  32483ms   {"injected":306,"stale":0,"unverified":8}
bundle 开  11902ms   {"injected":306,"stale":0,"unverified":8}
读数一致?  true
```

**2.7 倍**提速，且 `postGateInjected / postGateStale / postGateUnverified` **一位没动**。

## 四、验收

```
node --test test/t376-h1-bundle.test.mjs → 2/2
  ✔ ① bundle 开/关，H1 读数逐项相同（含 zeroInjection / gateFailures）
  ✔ ② 默认等于 bundle:true（不传就走生产路径）
node --test "test/*.test.mjs" → 1299 条 / 1293 pass / 0 fail / 6 skip
node scripts/check.mjs        → PASS
```

## 五、为什么这样做是安全的

`bundle` 只换"怎么读"，不改任何一条记录的内容 —— 这是 T62/T65 建立时的判据（结果逐条一致），
本刀又用真库对拍复验了一次。

## 六、下一步（T169 剩下的那一半）

`runH1` 的 walk 缓存已经跨信号复用（`resolveWalkCache`：`claims`/`topics` 直接喂进去，不再重读）。
本刀之后，H1 的单次成本主要落在 **walk 本身**（T371 后已 12.4ms/次）与 **gates 的探针**上。
`T169` 里"结构性债"的部分（`runH1` 接受外部 cache、不传=逐字节不变）此前已完成，这次是**读路径**的收尾。
