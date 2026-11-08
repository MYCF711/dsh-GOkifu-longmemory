# T49 真库回放 · 线上那 144 次「同卡重投」新的去重闸会拦下几次

> 2026-11-09 · `node scripts/t49-replay.mjs`
> 目的：**不重启宿主**也能拿到 T49 的真库读数（单测只证明"实现符合契约"，证明不了"线上那批真的会被拦"）。

## 一、怎么回放的（为什么这算真库）

不需要跑 `decidePreStep`（那要完整 payload 与真实库状态，回放必失真）。T49 的判据本身就是
**"卡正文是否逐字出现在 `payload.messages` 里"**，所以只要：

1. 按日志顺序重放 `user/message` + `assistant/message` 到一份 `messages` 列表；
2. 遇到 `source.kind = dsh-gokifu-longmemory` 的注入行，**先判再入列**（顺序反了会把卡自己算成"已在"）；
3. 判定用的是**同一个** `messageText()`（不是另写近似）。

压缩的两种极端各算一次，真值夹在中间：

| 模型 | 含义 | 对应 m5-report 的档 |
|---|---|---|
| 上界 `wouldBlock` | 完全**不看压缩**（卡投过就一直算"还在") | redundant 总数 |
| 下界 `wouldBlockStrict` | 一遇 `compaction/start|prune` 就清空历史（卡被压掉就不拦） | `necessary`（必要重注） |

## 二、读数（7 天窗口，本机真库）

```
node scripts/t49-replay.mjs
扫 1702 个会话日志（解析成功 1702，跳过 0）· 窗口 7 天
有注入的会话 1060 个 · 注入 1632 次
上界（不看压缩）  会拦下 144 次（8.82%）· 少烧约 19020 token（粗估）
下界（压缩即清空）会拦下  90 次（5.51%）· 少烧约 11480 token（粗估）
真值在两者之间：卡被压缩压掉的次数越少，越靠近上界。
```

按会话（拦下最多）：

```
221a2634  拦 21 / 投 55
634616f8  拦 16 / 投 35
8ef298d6  拦 16 / 投 34
8fe881d1  拦 16 / 投 30
ae858f87  拦 11 / 投 32
8773e79a  拦  8 / 投 29
aa0b0da9  拦  8 / 投 11      ← 与 `evidence/T49-already-in-context.md` 里手工查到的 8 次重投**逐条对上**
```

`aa0b0da9` 是 T49 的原始病例（`A1.redundant` 那条 10 小时跨度的会话）：手工分析 8 次重投、
回放同样是 **8 次**，两套独立路径给出同一个数 —— 回放不是拟合出来的。

## 三、这说明什么 / 不说明什么

**说明**：

- 修复在**真实数据**上生效：1632 次真注入里，有 90–144 次是同一张卡的重复，新的闸会拦下它们。
- 拦下的量级与 `A1.redundant`（24h 窗口 waste 10.53% / necessary 8.19%）同量级，不是"测出来一个好看数"。

**不说明**：

- **8.82% / 5.51% 不是"修好后的 A1.redundant"** —— 那要等宿主重启、新代码真的进进程之后，
  由 `node scripts/patrol.mjs` 从 `live-stats` 重新算（口径是 token 占比，这里粗估的是字符/4）。
- 回放假设"压缩把卡整条压掉"。真实压缩可能保留摘要、也可能只删一部分 ⇒ 真值在区间内偏移，
  所以给的是**区间**而不是一个点。
- 回放只看"卡正文有没有原样出现过"，不判"该不该投"（那是 A2b 的活，已认顶 46.6%）。

## 四、复现

```bash
node scripts/t49-replay.mjs                     # 人类可读（7 天窗口）
node scripts/t49-replay.mjs --json              # 机器可读（含逐次注入明细）
node scripts/t49-replay.mjs --session aa0b0da9  # 只看 T49 的原始病例
node scripts/t49-replay.mjs --days 30           # 换窗口

node --test test/t49-replay.test.mjs            # 5/5（含"先判再入列"的 tombstone）
```
