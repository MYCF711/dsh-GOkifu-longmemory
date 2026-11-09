# T72 · 端到端证明：T69 把失败边的引文命中率从 **0%** 拉到 **88–100%**

> 2026-11-09 · T69 只改了 `edgeSeq()` 的取值口径，单元测试只能证明"取哪一头"，
> 证明不了"真数据上到底对不对"。这一刀补的就是这个证明。

## 一、做法

直接拿**真棋谱**（`chess-context/sessions/<sid>/graph.json`）+ **真会话日志**比对：
对每条 `result === 'failure'` 且带引文（`errorSnippet` / `verify.summary`）的边，看引文是否**真的**在

- 旧口径 `edge.evidence.start`（动作事件）那一条里；
- 新口径 `edgeSeq(edge)`（T69）那一条里。

## 二、读数

```
session-c0a5847a-…     失败边 171 条 · 旧命中   0（  0%）· 新命中 151（ 88.3%）
session-6626f1f9-e5d…  失败边  35 条 · 旧命中   0（  0%）· 新命中  35（100.0%）
```

**旧口径 0%** 不是巧合：那批边的引文全部取自结果侧（`errorSnippet`），而 `evidence.start` 是动作事件，
两边天然对不上。改后命中的是同一批数据，只换了取哪一头。

剩下那 20 条（11.7%）是 **T71 / T157 那一族**（引文由抬头+正文拼成，原文里不连续）。

## 三、验收

```
node --test test/t72-edge-seq-audit.test.mjs → 4/4
  ✔ ① 旧口径指错、新口径指对（否则这条测试没意义）
  ✔ ② 只统计 result=failure 且带引文的边
  ✔ ③ 没有 evidence.end 时退回 start（不因新口径丢样本）
  ✔ ④ 空输入 ⇒ 比率 null（不是 0，避免造假读数）

node --test "test/*.test.mjs" → 1282 条 / 1276 pass / 0 fail / 6 skip
node scripts/check.mjs        → PASS
```

复跑：`node scripts/edge-seq-audit.mjs --sessions 12`

## 四、一个踩过的坑（写下来省下一次）

第一版在 `chess-context/sessions/<sid>/` 里找会话日志 —— 那里只有 `graph.json`，
日志在 `<home>/sessions/<bucket>/session-<sid>/session.v4.jsonl.zstd`。
所以第一次跑出来是"0 条样本"的假绿。现在：先查 episode 的 `closure.logPath`，
查不到再按目录名扫一遍，两头都没有才跳过（并如实显示 0）。

**教训**：诊断脚本的"0"必须能被区分成"没有坏样本"还是"根本没读到样本"。
