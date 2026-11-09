# T62 · 单文件 bundle：`list()` 从 3.4–5.1 秒降到 27–35ms（也救回了 T61 的空闲代价）

> 2026-11-09 · 用户要求「最好的性能」+「不要无意义的内存占用」。T61 把内存还回去了，
> 但**代价是闲置后第一轮要重建 cache（6.3 秒）** —— 这一刀把重建本身变便宜，两者才都不亏。

## 一、问题

`store.list(kind)` 每次都逐个文件 `readFileSync + JSON.parse`：

```
真库实测：episodes 747ms(1654) · claims 868ms(2410) · topics 2072ms(4417) · links 5127ms(11083)
合计 ≈ 9.4 秒；建 walk cache（四类全读）实测 6.3–6.9 秒
```

后果两条：① 进程内第一次查记忆要等这么久；② T61 的空闲释放让"闲置 10 分钟后的第一轮"付这 6.3 秒。

## 二、做法（纯派生、可随时删）

慢路径读完一个 kind 之后，把整份记录写成 `<root>/.cache/<kind>.bundle.json`（原子 `rename`）；
下次先看 bundle 是否新鲜，命中就一次 `readFileSync + JSON.parse`。

**失效判据（便宜且机械）**：

```
stamp = v1 | manifest.json 的 mtime + 字节数 | <kind>: 该目录的条目数
```

- store 每次真变更都会重写 `manifest.json` ⇒ mtime/size 变；
- 绕过 store 直接往目录里丢/删文件 ⇒ 条目数变。

任一不一致 ⇒ 返回 null，走慢路径并重写。**没有 manifest 的 store（测试夹具）一律不启用**。

**纪律**：纯派生（删掉 `.cache/` 只会让下一次变慢，读数一字不变）；写盘失败一律吞掉；
版本不符当作没有（不静默降级）。只有调用方显式 `createStore({ bundle: true })` 才启用 ——
生产三处（`sdk` / `plugin` / `inject`）打开，测试默认关。

## 三、读数

```
store.list('links')
  冷（无 bundle） 3393ms   →   热（读 bundle） 35ms / 27ms        ≈150×

kifu_search（端到端）
  冷（无 bundle，四类全读） 6284ms
  热（读 bundle）            161ms
  空闲释放后重建             180ms      ← T61 的"闲置代价"从 6300ms 降到 180ms
```

## 四、验收

```
node --test test/t62-walk-bundle.test.mjs → 5/5
  ✔ ① 有 manifest 才启用；stamp 变了/版本不对/文件坏了 一律 null
  ✔ ② 条目数变了也失效（绕过 store 塞文件）
  ✔ ③ 坏文件 / 错版本 ⇒ null（不许把坏缓存当数据）
  ✔ ④ list({bundle:true}) 与慢路径**逐条一致**（冷/热都比）
  ✔ ⑤ 纯派生：删掉 bundle 读数一字不变

node --test "test/*.test.mjs" → 1255 条 / 1249 pass / 0 fail / 6 skip
node scripts/check.mjs        → PASS
```

tombstone：删掉 `src/rooms/walkbundle.mjs` ⇒ 本测试文件整片红。

## 五、边界（别当免费）

- **内存峰值不降反略升**：热路径一次 `JSON.parse` 19MB bundle，峰值与逐文件读同量级（~35MB 堆），
  只是**快**。T61 的空闲释放仍然负责把内存还回去。
- **`.cache/` 是新的 sidecar 目录**：纯派生、`rm -rf` 安全；但 `verify`/`rebuild` 目前**不感知**它
  （不需要——它不在 manifest 的 checksums 里）。如果将来有人把 `.cache` 当成权威数据，那就错了。
- **bundle 写盘发生在读路径上**（第一次读会多花一点时间写 19MB）；写失败只是下次还慢。
- 仍是"整库进内存"的思路：真要更省，得改成**按需索引**（只读 id + 少量字段），那是下一个量级的设计题。
