# 性能与内存总账（2026-11-09，T54–T65）

> 主人的指令：「**最好的产品最好的效果，最好的性能，不要再出现无意义的内存占用**」。
> 这份文件把这一段的**每一条实测**放在一处，便于复核；单项细节见各自的 `evidence/T*.md`。
> 全部在同一台机器、同一个真库（1654 局 / 4417 主题 / 11083 link / 2410 claim）上测。

## 一、时间：一次查询从 20 秒到几十毫秒

| 阶段 | 动作 | 读数 |
|---|---|---|
| 起点（T54 之前） | `kifu_stats` 一次 | **20 298 ms** |
| T54 | 计数走文件名层（不解析内容）+ walk cache 惰性 | `kifu_stats` **1 698 ms**（11.9×）· `kifu_recent_failures` 10 014 → **1 136 ms** · `kifu_get` ~9 s → **2 ms** |
| T55 | walk cache 跨 SDK 实例共享（目录签名 + 30 s TTL） | 第二次起 `kifu_search` **34 ms**（原 9 216 ms） |
| T62 | 单文件 bundle（`store.list` 不再逐个读 1.5 万文件） | `list('links')` 3 393 → **35 ms**（≈150×）· `kifu_search` 端到端 6 284 → **161 ms** |
| T63 | `warm-bundles`（归档后预热，把冷路径搬到后台） | 归档后首次查询 6 284 → **214 ms** |
| T65 | bundle 不重复解析（5 s memo） | 建卡 180 → **109 ms** · 连续建卡 233 → **83 ms** |

**当前**：`search` ≈ 48 ms · 建卡 ≈ 109 ms · 归档后首次 ≈ 214 ms。

## 二、内存：三处「无界增长」全部清零

| 位置 | 问题（实测） | 处置 |
|---|---|---|
| 插件 `WALK_CACHES` | 把 manifest 的 mtime 拼进 key 却**从不删旧 key** ⇒ 库每更新一次多留一份完整图（≈35 MB 堆），宿主长驻 ⇒ **无界泄漏** | 按 `storeRoot` 只留最新一代 + 闲置 10 分钟自灭（T61） |
| 插件 `PROBE_CACHE` | key 里带 60 秒**时间桶**，旧桶从不删 ⇒ 每 60 秒堆一代 | 只保留当前桶，桶一换整份清（T64） |
| `LAST_SCOPE` / `SESSION_LOG_SCOPE_CACHE` | 以 `session.id` 为键，只增不减 | 上界 2000，按插入序淘汰（T61） |

**空闲释放实测**（sdk 侧同一套机制）：

```
基线                    heapUsed 6.4 MB  · rss  63.6 MB
用完一次（实例已丢弃）      heapUsed 38.8 MB · rss 186.6 MB
空闲 33 秒后（自灭 + gc）   heapUsed  6.9 MB · rss  96.7 MB      ← 堆回到基线
```

RSS 剩下的 ~33 MB 是 V8 已提交但未归还的页 —— 那是运行时行为，不是我们的对象。

## 三、缓存里装的字段：只留走图用得到的

`projectEpisodeForWalk()`（T61）去掉两类走图**完全不用**的字段：

- `l1`（每局最多 4000 字符，只有 `rooms/view.mjs` 在 `l0` 为空时兜底，而那条路读的是 store）；
- `closure.nodeIds/edgeIds`（实测 **17.2 万 / 24.4 万个 id**，3.1 MB）—— `closure` 只用到 `logPath` / `seqFrom`。

建 cache 的堆增量 **+44 MB → +35 MB**；拿不准的字段**一律保留**（只做减法）。

## 四、内存现在长什么样（诚实版）

| 项 | 量级 | 说明 |
|---|---|---|
| 一次查询的**峰值**堆增量 | **≈42 MB**（topics 1.9 · episodes 27.6 · links 8.1 · claims 4.9） | 数据本身的成本，不是泄漏；查询结束 + 空闲释放后归还 |
| episodes 为什么最大 | 1654 条占 27.6 MB（≈17 KB/条） | `l1` 字符串与 `signals/closure` 的对象开销；**不能再砍**，砍了 `kifu_view` 的兜底就没数据了 |
| 常驻（空闲） | 堆回到基线 6.9 MB | T61 的空闲自灭 |
| 磁盘派生物 | `.cache/*.bundle.json` ≈ 21 MB | 纯派生，`rm -rf .cache` 只让下一次变慢 |

## 五、验收与复现

```bash
node scripts/warm-bundles.mjs            # 预热四类（归档后调用）；已新鲜则跳过
node --test test/t62-walk-bundle.test.mjs test/t54-tools.test.mjs   # bundle / 工具面
node --test --test-name-pattern "T61|T64|T65" test/plugin.test.mjs test/sdk.test.mjs
node scripts/patrol.mjs --full
```

## 六、还没做的（明写）

1. **按需索引**：要再降一个量级的峰值，得只读 id + 少量字段；那是数据模型级改动。
2. **宿主内端到端实测**：以上全部是进程内读数（`tool.execute` / `sdk.card`），宿主进程（pid 8040，跑旧代码）里还没测过。
3. **`injectedIds` / `repeatStates` 不设上界**：淘汰会导致重新注入，属「正确性优先于内存」；量级到每会话几十字节。
