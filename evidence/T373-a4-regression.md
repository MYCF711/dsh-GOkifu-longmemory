# T373 · A4 p50 真的退化了：15–22ms → **50–56ms**（不是抖动）

> 2026-11-19 · 由「发版被 A4 门槛拦住」引出。**这是真实回归，不是冷缓存抖动。**

## 一、实测（同一个库、同一台机器、连续采样）

| 时点 | A4 p50 | 备注 |
|---|---|---|
| 本会话早段（T366 之后） | **22.80ms** | 通过 |
| 归档跑过一次后 | 43.90ms | 仍通过 |
| 归档再跑、`mark-stale` 写入后 | **50.05 → 53.03 → 55.73 → 56.03 → 50.39ms** | **连续 5 次全部越线**（门槛 50ms） |

连续 5 次都 50–56ms ⇒ **不是抖动**。我上一轮把它记成 T372「冷缓存假红」是**判断错了**，这里更正。

## 二、单工具冷态实测

```
kifu_stats           312.3ms
kifu_search          269.4ms
kifu_consolidate     201.7ms
kifu_recent_failures   6.1ms   ← 暖态
```

## 三、冒烟的枪：`episodes.bundle.json` **51 MB**

```
memory-context 总计 300MB
.cache/claims.bundle.json     10.4 MB
.cache/episodes.bundle.json   51.0 MB   ← 热路径要读它
episodes/ 82MB · links/ 38MB · claims/ 28MB · topics/ 17MB
```

热路径按 `KIND_MEMO_MS = 5000` 记忆化；缓存一过就整份解析 51MB JSON ⇒ 数百毫秒。
A4 取中位，所以表现为 50ms 上下（一半样本落在缓存有效期内）。

**这与用户要求直接冲突**：「不要再出现无意义的内存占用」。51MB 的 bundle 每次解析既慢又占内存。

## 四、修法（下轮做，纯正向）

1. **别再整份读**：`kifu_recent_failures` / `kifu_stats` 这类只需要少量字段的查询，改读**精简索引**
   （例如 `episodes` 只取 `id/occurredAt/signals.failures`），不解析 51MB；
2. 或者把 bundle 拆成「热字段 / 冷字段」两个文件，热路径只读前者；
3. 判据：A4 p50 **回到 ≤25ms**、`episodes.bundle.json` 显著变小、A2b/A6 不回退。

## 五、当前发版状态（诚实）

`0.8.149` 的代码已合并进 main，但 **`release.mjs` 被 A4 门槛拦住（55.73ms > 50ms）**，
所以 **v0.8.149 的 tag 与 Release 尚未发出**。等 T373 修好、A4 回落再发。

**不会去调高那个门槛** —— 门槛在反映真实问题，绕过它等于把问题藏起来。
