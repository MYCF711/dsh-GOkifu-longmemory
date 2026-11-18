# T390 · 一开插件 DSH 就卡死：`apply()` 里同步预热，冷启动阻塞主线程 **14 秒**

> 2026-11-19 · 用户在 UI 里打开插件 ⇒ 整个 DSH 卡死、切会话一直"加载中"、只能重启。

## 一、复现（真 Cordis + 真库，清空 `.cache` = "首次开启"那一刻）

```
apply 完成 14179 ms
{"观察秒":45,"最长阻塞ms":14080,"发生在ms":14180}
```

**主线程被阻塞 14.08 秒** —— 宿主在这段时间里什么都做不了：任何会话都动不了、切会话只能转圈。
库越大越久；会话 / 子代理 / 废弃会话越多越久。

## 二、根因

`src/plugin.mjs` 的 `apply()` 里有这么一段（原注释写"~0.7s"）：

```js
if (config.enabled || config.shadow) {
  const root = resolveStoreRoot(config);
  if (root && fs.existsSync(root)) {
    walkCacheFor(root, createStore({ root, bundle: true }), { createWalkCache });  // ← 同步、全量
  }
}
```

`createWalkCache` 会把 episodes / links / claims / topics **一次性读进内存**。真库当前规模：

```
episodes 4377 · links 26346 · claims 3921 · topics 6593   （≈ 41k 个文件）
```

冷缓存 ⇒ 没有 bundle ⇒ 4 万多个文件逐个读 + 解析 ⇒ **14 秒**，全程主线程同步。
"0.7s" 那个数字是 1908 局时代的，数据翻了一倍多之后彻底失效。

## 三、修复（T390）

**不在 `apply()` 里同步做，也不无条件做**：

```js
const timer = setTimeout(scheduleWarmUp, 0);   // 推迟到 apply 之后
timer.unref?.();
```

`scheduleWarmUp` 先读 `manifest.json` 的 `counts` 做**规模闸**：

```js
const tooBig = episodes > WARMUP_MAX_EPISODES || links > WARMUP_MAX_LINKS;   // 1200 / 8000
if (tooBig) { warn(...); return; }     // 大库直接跳过预热：宁可首轮冷一次，也不卡住宿主
```

## 四、读数（同一台机器、同一个真库、同样清空 `.cache`）

| 指标 | 修前 | 修后 |
|---|---|---|
| `apply()` | **14179 ms** | **5 ms** |
| 事件循环最长阻塞（45 秒观察） | **14080 ms** | **20 ms** |

**"开完插件 DSH 卡死"这一条已经消失。**

## 五、诚实边界（这一刀没解决完的部分）

修后第一次**真正命中主题**的那一步，仍然要付一次全量装载（冷缓存实测 ~15.5s；bundle 落盘后 ~1–2s）。

我尝试把它也做成惰性（`episodes`/`links` 首次访问才读），但打红了
`test/walk.test.mjs` 的 **T317 稳定排序**（缓存对象的键序影响候选顺序），
**当场回滚、没有硬塞**。下一步的正确做法是：

1. 让 `createWalkCache` 惰性化**同时保持键序不变**（先建同序的占位属性，再用 getter 覆盖）；
2. 或者在归档结束时就把 bundle 写好（`scripts/warm-bundles.mjs` 已有），让插件永远拿到热缓存。

## 六、为什么 Hindsight 不会这样

对照 `docs/对标-Hindsight.md` 的机制表：它按 **repo 分 bank**、**增量索引**，
会话开始时只读该仓库那一小片；我们是单 store 全量扫描 ⇒ 数据一涨，启动成本线性涨。
这一刀把"启动期全量"改成"按需 + 规模闸"，方向就是往增量靠；**剩下那一半（首次命中仍全量）是下一步**。

## 七、验收

```
node --test "test/*.test.mjs" → 1302 条 / 1296 通过 / 0 失败 / 6 跳过
node scripts/check.mjs        → PASS
```
