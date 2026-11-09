# T61 · 把"无意义的内存占用"清掉：一份 cache 从**永驻**改成**空闲即还**

> 2026-11-09 · 用户要求：「最好的产品 / 最好的效果 / 最好的性能 / **不要再出现无意义的内存占用**」。
> 这一刀只做内存，性能不降（T54/T55 的收益全部保留）。

## 一、实测：问题有多大

```
node --expose-gc 测 sdk 建一次 walk cache
  基线          heapUsed 6.4MB  · rss  63.6MB
  用完一次（实例已丢弃）  heapUsed 38.8MB · rss 186.6MB     ← +32MB 堆 / +123MB RSS
```

真库规模：episodes 1654 · topics 4417 · links 11083 · claims 2410（序列化合计 ≈19MB）。

## 二、三个"无意义占用"的来源

### ① 宿主插件里 **按 manifest 世代累积**、永不删除（最严重）

```js
// 旧实现
const key = `${storeRoot}::${stamp}`;      // stamp = manifest.json 的 mtime
if (WALK_CACHES.has(key)) return WALK_CACHES.get(key);
WALK_CACHES.set(key, cache);               // ← 只增不删
```

库每更新一次（manifest mtime 变）就**多留一份完整图**（≈35MB 堆），旧世代永不释放。
这是一个**无界泄漏**，而宿主进程是长驻的。

**改**：按 `storeRoot` 只留最新一代（换世代 = `set` 覆盖，旧的立刻失去引用），
并加**空闲自灭**：`WALK_CACHE_IDLE_MS = 10 分钟`，每次命中把倒计时推后，闲置到点就从 Map 里摘掉（`unref()`，不拖住进程退出）。

### ② 缓存里装着走图**用不到**的字段

`l1`（每局最多 4000 字符）走图一个都不用（只有 `rooms/view.mjs` 在 `l0` 为空时兜底，而那条路读的是 store、不是 cache）；
`closure.nodeIds/edgeIds` 实测 **17.2 万 / 24.4 万个 id**（3.1MB），而 `closure` 只用到 `logPath` / `seqFrom`。

**改**：`projectEpisodeForWalk()` 只做减法（`l1` 与 `closure` 的两个大数组）。**拿不准的字段一律保留。**

效果：建 cache 的堆增量 **+44MB → +35MB**。

### ③ 会话键的 Map 无上界

`LAST_SCOPE` / `SESSION_LOG_SCOPE_CACHE` 以 `session.id` 为键，长驻进程里只增不减。
每个值很小，但没有上界就是无意义增长。**改**：`SESSION_MAP_MAX = 2000`，按插入序淘汰最老的
（这些值都能重算，丢了最多多算一次）。

## 三、改后读数（同一台机器、同一个库）

```
基线                    heapUsed 6.4MB  · rss  63.6MB
用完一次（实例已丢弃）      heapUsed 38.8MB · rss 186.6MB
空闲 33 秒后（自灭 + gc）   heapUsed  6.9MB · rss  96.7MB   ← 堆回到基线
```

- **堆：38.8MB → 6.9MB**（基线 6.4MB，即基本全部还回去）。
- **RSS：186.6MB → 96.7MB**（剩下 ~33MB 是 V8 保留的已提交页，属运行时行为，不是我们的对象）。

## 四、性能没退

| 工具 | T54/T55 之后 | T61 之后 |
|---|---|---|
| `kifu_stats` | 1.70s | 1.70s（同时改动） |
| `kifu_search`（第二次起） | 34ms | 34ms |
| `kifu_card`（第二次起） | ~1.8s | ~1.8s |

缓存**只在使用中保留**，闲置 10 分钟（插件）/ 30 秒（sdk）后释放；下一次使用重建一次（真库 ≈6.3 秒，
只发生在"很久没用过记忆工具"的第一下）。

## 五、验收

```
node --test --test-name-pattern "T61" test/plugin.test.mjs test/sdk.test.mjs → 3/3
  ✔ T61 ① 同一记忆库只保留**一份** walk cache（换 manifest 是替换，不是累积）
  ✔ T61 ② 空闲会自灭（WALK_CACHE_IDLE_MS 有值；walkCacheEntries 能清空）
  ✔ T61 ③ dropWalkCache 之后必须重建（空闲释放不是"假的"）

node --test "test/*.test.mjs" → 1250 条 / 1244 pass / 0 fail / 6 skip（109 秒）
node scripts/check.mjs        → PASS
```

tombstone：把 `walkCacheFor` 改回"键里拼 stamp、只增不删" ⇒ T61 ① 变红（size 2 ≠ 1）。

## 六、还没动（明写）

- **`store.list()` 仍每次全量读**：这是"第一次调用 ~6–9 秒"的根，要改成磁盘索引/二进制格式，
  属独立设计题（会牵动 sidecar 契约）。
- **V8 保留的 ~33MB RSS** 不是我们的对象，没法从应用层还回去。
- 只治了"**会一直留着**"的占用；查询期间的峰值（~35MB 堆）是这份功能的固有成本。
