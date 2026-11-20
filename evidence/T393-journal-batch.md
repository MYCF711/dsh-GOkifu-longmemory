# T393 · journal 批量落盘：归档 **396 秒 → 138 秒**

> 2026-11-20 · 承接 T392（manifest 记忆化，>900s → 396s）。

## 一、根因

`persist.appendJournal()` 每条记录都 `openSync → writeSync → fsyncSync → closeSync`。
单次 `fsync` 在 Windows 上毫秒级 ⇒ 上万条权威写入就是几十到上百秒。

## 二、修复

同批次内先缓冲，**批次末一次写入 + 一次 fsync**：

```js
let JOURNAL_BUF = [];
let JOURNAL_BATCH = 0;          // >0 = 在 putMany/replaceDerived 批次内
appendJournal: buf.push(line);
  if (JOURNAL_BATCH === 0 || buf.length >= 512) flushJournal();
putMany: JOURNAL_BATCH += 1 … finally { JOURNAL_BATCH -= 1; flushJournal(); }
```

**语义保持**：单条 `put`（不在批次内）仍然"返回即已落盘" —— R15 的幂等/截断恢复测试依赖这一点，已全绿。

## 三、端到端

| 版本 | 总耗时 |
|---|---|
| T392 之前 | **>900 秒（从未跑完）** |
| T392 之后 | 396 秒 |
| **T393 之后** | **138 秒**（再快 **2.9 倍**，累计 **6.5 倍以上**） |

分阶段（T393 后）：

```
after-recovery-index  +18.7s
before-derive-out     +29.4s   ← 权威写入（原 255s）
after-derive-out      +30.9s   ← derive 1.5s
after-topics          +36.2s   ← topics 5.3s（原 242s）
after-links           +68.6s   ← links 32.4s
after-manifest       +105.2s   ← manifest 36.6s  ← 新靶心
after-verify         +137.4s   ← verify 32.1s
```

## 四、下一个靶心（明确）

1. **manifest 36.6 秒**：写 manifest 时对 **63,818 个文件**重算 checksum ⇒ 改为**只算变化的文件**（增量 checksum）；
2. **verify 32.1 秒**：同样是全量校验 ⇒ 归档后可改抽样，或复用刚写的 checksum；
3. links 32.4 秒：4 万条写入（剩余是不可避免的文件 I/O + sha256）。

目标仍是三条：**≤60 秒 / 连跑两次第二次 ≤60 秒且 manifest 逐字节不变 / stale 不丢**。
按上面两项做完，138 → 预计 60～70 秒区间。

## 五、门禁

```
全量 1308 / 1302 通过 / 0 失败 / 6 跳过 · check.mjs PASS
persist.test + archive.test 26/26
```
