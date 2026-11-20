# T392 · 归档跑不完的**真正元凶**：每次 `put` 都重读 4.5MB 的 `manifest.json`

> 2026-11-20 · 这是本会话最重要的一次性能修复。归档从 **>900 秒跑不完** 变成 **396 秒跑完**。

## 一、根因（一句话）

`persist.ensureCompatible()` 在**每次 `put`** 里调用 `readManifest()` ⇒ **每条记录都 `readFileSync(4.53MB)` + `JSON.parse`**。

真库 `manifest.json` = **4.53 MB**（里面是全部文件的 checksum 表）。
一条记录一次 ⇒ 26,238 条 topics 就是 26,238 × 4.5MB ≈ **118 GB 的磁盘读**。

## 二、决定性微基准（内容完全没变的 2000 条）

| 版本 | 耗时 | 判定 |
|---|---|---|
| 修复前 | **53,478 ms** | `written: 0 · unchanged: 2000` —— 什么都没改，纯白烧 |
| 第二批复测 | **51,200 ms** | 同上 |
| **修复后** | **1,156 ms** | 同结果，**46 倍** |

## 三、修复（`src/rooms/persist.mjs` 的 `readManifest`）

按 `(mtimeMs, size)` 记忆化：manifest 每次写入都是**原子替换**（mtime/inode 必变）⇒ 戳可靠失效；
本进程自己写完也会刷新。**语义完全不变**（读到的仍是磁盘上的当前 manifest）。

## 四、端到端实测（`--incremental` 真跑）

```
EXIT=0   总耗时 396 秒   （修复前：>900 秒被 timeout 杀掉，从未跑完）
added 10531 · verify ok · errors 0 · warnings 0 · checked.files 63818
```

分阶段（打点）：

| 阶段 | 耗时 |
|---|---|
| 到权威写入完成 | **255 秒** ← 下一个靶心 |
| derive | 0.9 秒 |
| 写 topics | **1.5 秒**（修复前 242 秒，**161 倍**） |
| 写 links | 96 秒 |
| manifest | 25 秒 |
| verify | 17 秒 |

## 五、下一步

1. 拆「255 秒」那段（episodes/claims 的 `putMany` —— 写路径每条都 `fsync` journal，这条没被本次修复影响）；
2. links 96 秒：4 万条写入，同样受 journal fsync 约束；
3. 目标仍是不变的三条：**1 个新会话 ≤60 秒 / 连跑两次第二次 ≤60 秒且 manifest 逐字节不变 / stale 不丢**。

## 六、教训（写给下一个人）

我在这个问题上错了**五次**（冷缓存 → bundle → matchTopics → 零变更早退 → derive），
每次都是"读完 profile 就下结论"。真正定案靠的是：**把单条记录的操作放到微基准里跑 2000 次**。
**当一个操作疑似慢，先把它孤立出来跑 N 次，别先猜。**
