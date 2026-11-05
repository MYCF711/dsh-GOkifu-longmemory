# T278 · t267-replay 性能定位与优化

## 1 · 瓶颈定位（实测）
| 版本 | 范围 | 耗时 | 结论 |
|---|---|---|---|
| 优化前 | 全量 1233 条 | **>600s（exit 124 超时被杀）** | 不可用 |
| 优化后 | 前 50 条 | **20.6s** | ~0.41s/条 |
| 优化后 | 全量 1233 条 | **27.2s**（`elapsedSec: 27.2`） | ≤60s 目标达成（记忆化让重复信号只算一次） |

**瓶颈 = 每行重跑 `walkFromSignals` + `buildMemoryCard`（大量 `store.get/list` 文件读）**，不是 zstd 解压（本脚本根本不读会话日志）。

## 2 · 优化手段
1. **记忆化**：键 = `scopeKey | 最后一条 user 文本 | 实体集`（`signalKey`）—— 语料里同信号大量重复，1233 条只算一次不同信号；
2. **`--sample N`**：只取前 N 条，输出里写明"抽了多少 + 不保证无偏（按写入时间取最早一批）"；
3. **单行超时** `--row-timeout`（默认 5000ms）⇒ 记 `unverified` 并跳过，**不进分子分母**，绝不卡死。

## 3 · 测试（原样）
```
$ node --test "test/t267-replay.test.mjs"
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

## 4 · 收益读数（原样）
```
n = 1233 · unverified = 0
A（只用最后一条 user 消息）严格 0/1233 · 宽松 0/1233 · Wilson [0, 0.31%]
B（+ 最近 N 条消息硬实体） 严格 0/1233 · 宽松 0/1233 · Wilson [0, 0.31%]
delta 严格 0 · 宽松 0
negativeControl：1233 条 A 无重合样本上 B 判 related = 0（0%）
```

## 5 · 这个 0 不能当"没收益"（关键诊断）
抽前 60 行做诊断：
```
{"rows":60,"nonEmptyCards":0,"avgTokens":2}
```
**每一行的卡都是空的**（`nonEmptyCards = 0`），信号判别词平均只有 2 个 —— 语料全部来自**本会话/本仓 scope**，
而库里的 claim 讲的是别的项目。**A 路无货可召 ⇒ 没有提升空间 ⇒ delta=0 是语料造成的，不是 T267 的结论。**

## 6 · 下一步（一条命令）
让语料覆盖**有记忆命中的历史局**（如 `w:d:/DeepSeek Harness/default-workspace/DSH-GO`、`w:d:/DeepSeek Harness/反代` 等 scope），
再跑 `node scripts/t267-replay.mjs`；判据：**A 路严格命中 > 0 之后，delta 才有意义**。
