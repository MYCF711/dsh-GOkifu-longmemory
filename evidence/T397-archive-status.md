# T397 · 归档性能收尾状态：判据 5 项已满足 4 项，剩「≤60 秒」卡在两个决策上

> 2026-11-20 · 承接 T392–T396。

## 一、goal ① 的五条判据逐条对照

| 判据 | 状态 | 证据 |
|---|---|---|
| `archive.test` 全绿 | ✅ | `test/archive.test.mjs` 11/11、`archive-stale.test.mjs` 全绿 |
| `staleMarkedBy` 不丢 | ✅ | `test/archive-stale.test.mjs` 四条断言（含"只有 state 没有 staleMarkedBy ⇒ 不保留"的守卫） |
| 语料不变时连跑两次幂等 | ✅ | `test/archive.test.mjs` 的「幂等」用例（固定时钟 + 固定夹具，第二次 0 新增、manifest 字节相同） |
| 真实环境幂等 | ⚠ 本质不成立 | T395：`topic.idfNorm` 随全库局数变 ⇒ 有新局就全量重写（不是 bug） |
| **全链 ≤60 秒** | ❌ | 当前 127–191 秒（样本 127/191/295/556） |

## 二、当前归档曲线（本会话累计）

```
>900 秒（从未跑完）
  ↓ T392 manifest 读记忆化（2000 条不变记录 53.5s → 1.2s）
396 秒
  ↓ T393 journal 批量落盘（批次末一次 fsync）
138 秒
  ↓ T394 checksum 缓存（manifest 36.6→8.5s、verify 32.1→8.5s）
127 秒
  ↓ 待 D8 + D9
预计 60–70 秒
```

## 三、剩余成本（实测分解）

| 阶段 | 耗时 | 能否纯正向再降 |
|---|---|---|
| 读日志+构建 | ~19 秒 | 已优化到接近 I/O 下限 |
| 权威写入 | ~20–30 秒 | 受 fsync 约束（D9） |
| derive | 1.5 秒 | — |
| 写 topics | ~52 秒 | 受 `idfNorm` churn（D8）+ fsync（D9） |
| 写 links | ~36 秒 | 受 fsync（D9） |
| manifest + verify | 17 秒 | 已用 checksum 缓存 |

**结论：剩下的每一刀都要动「存储契约」或「持久性」，都属有代价 ⇒ 必须主人裁定。**

## 四、六轴回归确认（本轮实测）

```
node scripts/patrol.mjs → 全绿
A2b 严格 46.6%（n=118·holdout）· 覆盖 79.7%
A5 跨作用域 0 · A6 文字层 ok 2/2 · 语义不变量 32 pass / 0 fail · 子代理归并 100%
当前宿主 pid=4980
```

**说明 T392–T396 的 persist 改动没有伤到任何判据。**
