# T362 · 考卷分层现状：**231/298 有名额，67 局因无失败签名被排除**

> 2026-11-19 · 用 `node scripts/eval.mjs --root $DSH_HOME --store … --json` 实测（29.6 秒）。

## 一、实测（全量口径，`primary`）

```
episodes        298
evaluated       231        ← 真正进 A2b 分母的
signatures      3702
repeat          815   → rate            22.02%
novel          2887
rateErrorOnly  (只算"有错误码"的签名)   27.93%
episodesWithRepeat 192
```

## 二、关键结构事实

**`signatures = 0` 的局有 67 个（67/298 = 22.5%），它们根本不在 A2b 分母里。**

也就是说「有货可召 / 无货可召」这条分层**已经存在于 evaluator 里**：
没有失败签名的局进不了重复率统计。T362 原本担心的「48.2% 是被无货题拉低」这件事，
在**全量口径**下不成立——分母已经把无签名局剔掉了。

## 三、那为什么两套数字不一样？

| 口径 | 分母 | rate |
|---|---|---|
| `eval.mjs`（全量 / 时间切分） | **231** | 22.02%（只要 error 27.93%） |
| `metrics-guard` 的 A2b | **118**（holdout 抽样） | 严格 46.6% / 覆盖 79.7% |

两者**分母不同源**（一个按签名、一个按 holdout 抽样窗口），跨口径**不可比**——
这正是 T362 真正要解决的问题：**把"两套 A2b"的口径差写成一句话**，而不是继续改判据。

## 四、下一步（T362 的收尾动作）

1. 在 `metrics-guard` 的输出里把 A2b 的分母构成打出来（holdout / 有签名 / 有重复机会）；
2. 在 `MAINTENANCE.md` 里写明**这两个数字不可比**及各自用途（一个看趋势、一个作门禁）；
3. 不做判据改动——先把口径讲清楚，再看要不要动。

## 五、复现

```bash
node scripts/eval.mjs --root "$DSH_HOME" --store "$DSH_HOME/memory-context" --json
```
