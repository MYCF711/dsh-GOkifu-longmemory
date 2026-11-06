# T346 · 签名索引缓存从不失效（flaky 的真因）

> `[本] 2026-11-06` · 阻塞 v0.6.3 发版的 `ledger-check --full` 红，根因是**产品 bug**，不是测试问题。

## 0 · 一句话

`writeSignatureIndex` 的注释一直写着「**写索引时失效**」，但代码**从没让缓存失效** ——
同进程内重写一份**同样大小**的索引、且落在同一个 `mtime` 刻度时，`(mtimeMs, size)` 两项都没变
⇒ `loadSignatureIndex` 返回**陈旧数据**。

## 1 · 现象（为什么是 flaky）

| 跑法 | 结果 |
|---|---|
| `node --test test/sigindex.test.mjs` | **必现红**（`重写后必须失效` 断言失败） |
| `node --test "test/*.test.mjs"` | 常绿（时序被其他测试错开，mtime 变了） |

→ 典型 flaky：**靠时序才通过**的测试，掩盖了一个真实的缓存失效缺口。

## 2 · 修法

`src/rooms/sigindex.mjs` 的 `writeSignatureIndex` 落盘后 `INDEX_CACHE.delete(file)` ——
兑现注释的承诺（一行）。跨进程写入仍靠 `(mtimeMs, size)` 兜底（同大小同刻度的跨进程竞态属极端边界，暂不处理）。

## 3 · 回归测试（确定性，不靠时序）

`test/sigindex.test.mjs` 新增 **T346**：重写**同样大小**的索引后，用 `utimesSync` 把 `mtime` **强压回原值**
⇒ `(mtimeMs,size)` 完全没变 ⇒ 断言 `second !== first` 且拿到 `ep-2`。
删掉 `INDEX_CACHE.delete` 一行，该用例必红（tombstone）。

## 4 · 验收

- `node --test test/sigindex.test.mjs`：**5/5 pass**（原来必现红的那条转绿）
- 全量：**1036 条 / 1030 pass / 0 fail**；`node scripts/check.mjs` PASS
- 影响面：只影响「同进程内重写索引后立刻读」的场景；注入读侧行为不变（无索引文件仍返回 `null`，不影响注入）
