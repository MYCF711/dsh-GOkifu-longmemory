# T230 · A6 第一条 missing 的归因（`ep-62bcb7d2` seq 5736 及其他）

> `[本] 2026-11-05 14:20 +08:00` · **只读**：未写库、未改任何 claim；未跑全量测试、未重启 DSH
> 探针：`tmp/t230-probe.mjs`（只读）· 数据：`<DSH_HOME>/memory-context`（1379 claims）+ 会话日志 + 棋谱
> 对照快照：`<DSH_HOME>/memory-context.pre-T201`（合流前，1340 claims / 0 合并节点）

## 0 · 一句话结论

**不是合流改写 support。** 你指的那条（`ep-62bcb7d2` seq 5736）**目前是 at-seq**（距离 5746 恰好 10 = 窗口边界），它**不是**这次 missing 的元凶；真 missing 是同一张卡上的**另一条**引用 `ep-226dbf4f` seq **3670**（claim `c-39b8ac53`）。
归因：**`extraction-bug`（上游棋谱的 `errorSnippet` 不是逐字原文）** —— 棋谱里 `e529.errorSnippet` 是 `ok\ngithub.com/…`，而原始会话事件是 `ok\r\n[stderr]\ngithub.com/…`（`[stderr]` 被归一化掉了）。本项目只是忠实复制了棋谱的片段，所以拿到日志里逐字比对必然 `missing`。
附带一条：失败边的 `seq` 取的是 `edge.evidence.start`（3670），而片段实际在 `evidence.end`（3674）—— 这一条**是我们的抽取口径**，但距离 4 ≤ 窗口 10，不是主因。

## 1 · 先证伪"合流改写 support"

```
$ node --input-type=module -e '…对比 memory-context 与 memory-context.pre-T201 的同一条 claim…'
c-39b8ac53 | 合流前存在: true | support 相同? true | 记录相同? false
   差异字段: ["_store"] | 前 updatedAt: 1793707773006 后: 1793844149465
c-9de6864b | 合流前存在: true | support 相同? true | 记录相同? false
   差异字段: ["_store"] | 前 updatedAt: 1793741179101 后: 1793844152993
```

- 两条 claim 的 **`support[]` 逐字节相同**（合流前后），`state` 都是 `observed`；
- 唯一变化是 `_store.updatedAt`（09:42:29 / 09:42:32，**早于** 09:56 的合流写库）—— 属"重写记录"的 touch，不是 support 重指；
- 两条都**不是合并节点、也不是任何合并组的成员**（`merge.members` 里没有它们）：
  ```
  它是合并节点: 0 | 它是成员（被谁代表）: []
  ```
⇒ **"合流把 support 重指/合并"这个假设不成立**（至少在 A6 这两条上）。

## 2 · 你指的那条：`ep-62bcb7d2` seq 5736（claim `c-9de6864b`）

**原始事件**：

```
seq 5736: type = assistant/message
raw = {"type":"assistant/message","seq":5736,"time":1793736603255,
       "data":{"turn":44,"step":1,"message":{"role":"assistant",
       "content":[{"type":"reasoning","text":"Scheduled04:08. Should review latest, no goal operations. …"}]}}}
```

**逐字对照**：

| | 内容 |
|---|---|
| 卡片/claim 引文 | `UI_TEST=1 VET=1 BUILD=0 ok github.com/MYCF711/dsh-ui/internal/uiplugins (cached) ? github.com/MYCF711/dsh-ui/pluginapi [no test files]` |
| seq 5736 原文 | `assistant/message`（reasoning，讲 04:08 定时复核）→ **不含引文** |
| 引文实际所在 | **seq 5746**（`tool/result`，`bash_330_bf104016`） |
| 距离 | **10** = `DEFAULT_WINDOW` 边界 ⇒ 审计判 `at-seq`（不是 missing） |

复算：

```
ep-62bcb7d2 seq 5736 → at-seq nearest=5746 dist=10 :: UI_TEST=1 VET=1 BUILD=0 ok github.com/MYCF711/dsh-ui/interna
```

⇒ **这条不是 missing**。你看到的 `--current` 那行 `at-seq=1 … missing=1` 里，`at-seq=1` 就是它。

## 3 · 真 missing：`ep-226dbf4f` seq 3670（claim `c-39b8ac53`）

**claim**：

```json
{ "id": "c-39b8ac53", "kind": "antipattern", "state": "observed",
  "support": [{ "edgeId": "e529", "episode": "ep-226dbf4f", "nodeId": "n473",
    "occurredAt": 1793700423007, "seq": 3670,
    "quote": "ok github.com/MYCF711/dsh-ui/cmd/app: go build … a.out.exe: open tmp/app-real.exe: The proces…" }] }
```

**原始事件**：

```
seq 3670: type = assistant/message（reasoning：「还是 busy=false 且没有"已发送"…」）→ 不含引文
seq 3674: type = tool/result，原文开头：
  "ok\r\n[stderr]\ngithub.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-ui/cmd/app: copying
   C:\\Users\\<user>\\AppData\\Local\\Temp\\go-build1711324841\\b001\\exe\\a.out.exe: open tmp/app-real.exe:
   The process cannot access the file because it is being used b…"
```

**逐字对照（差异点）**：

| | 文本 |
|---|---|
| 卡上引文（= claim.support.quote） | `ok github.com/…`（`ok` 与 `github.com` 之间**一个空格**） |
| 原始事件 3674 | `ok\r\n[stderr]\ngithub.com/…`（`ok` 与 `github.com` 之间是 **`[stderr]` 标记**） |
| 归一化后 | 事件变 `ok [stderr] github.com/…`，引文是 `ok github.com/…` ⇒ **`[stderr]` 被吞** ⇒ 永不命中 |

**证据链**（这条最关键）：

```
$ 棋谱 e529.errorSnippet
"ok\ngithub.com/MYCF711/dsh-ui/cmd/app: go build … a.out.exe: open tmp/app-real.exe: The process cannot access the file because it is being used by another process."
   ↑ 棋谱里就已经是 `ok\ngithub.com`（`[stderr]` 已被上游归一化掉）
$ 原始日志 seq 3674
"ok\r\n[stderr]\ngithub.com/…"     ← 有 [stderr]
```

而 `src/rooms/topic.mjs` 的失败边分支是**忠实复制** `edge.errorSnippet`：

```js
if (edge.result === 'failure') {
  const err = extractErrorKey(edge.errorSnippet) ?? null;
  if (err) add('error', err, { seq, occurredAt: ts, edgeId: execId, quote: clip(edge.errorSnippet, lim.quoteChars), … });
}
```

⇒ **引文不是逐字原文，是棋谱侧归一化后的片段**。审计拿它去日志里逐字搜，必然 missing。

## 4 · 四类归因判定

| 类 | 判定 | 证据 |
|---|---|---|
| `seq-off-by-n` | **部分成立（非主因）** | 失败边 `seq` 取 `edge.evidence.start`（3670 / 5736），片段实际在 `evidence.end`（3674 / 5746）。`src/rooms/topic.mjs`：`const seq = Number.isFinite(edge.seq) ? edge.seq : (Number.isFinite(edge.evidence?.start) ? edge.evidence.start : null);` |
| `wrong-episode` | **不成立** | 片段确实在 `ep-226dbf4f` 的日志里（seq 3674），episode 没记错 |
| `render-drift` | **不成立** | 卡片文本与 `claim.support.quote` **逐字节相同**（`两者相同? true`），渲染没取错字段 |
| `extraction-bug` | **成立（主因）** | 棋谱 `errorSnippet` 已把 `ok\r\n[stderr]\n` 归一成 `ok\n`，本项目忠实复制 ⇒ 与原始日志不再逐字对应 |

## 5 · 影响面

**A. 失败边 seq 的取值**（全库）：

```
带 (episode, edgeId) 的 support 引用: 2136 | 涉及 episode: 80
{ supportRefsOnFailureEdges: 2027, edgesWithSeqWindow: 2027,
  claimsPointingAtStart: 2027, claimsPointingAtEnd: 0 }
```
⇒ **2027 条**失败边引用**全部**指向 `evidence.start`，没有一条指向 `end`。

**B. 被截断的引文**：

```
support.quote 含省略号（被截断）的引用数: 231   （前 5 条 tail 均以 … 结尾，长度 200）
```

**C. 全样本（515 张卡 / 1089 条引用）重算**：

```
STAT {"at-seq":968,"elsewhere":97,"missing":24}
```
24 条 missing 分三类：
1. 引文被棋谱归一化（`class:… · Error: …` 里的事件原文有 `[stderr]`/换行）；
2. 合成文本（如 `fail=1 · topics=版本`、`fail=6 · topics=src/schannel.mjs`）—— 根本不是日志片段；
3. 真的 elsewhere 太远（如 `ep-8a73e06b@2403` cross-origin redirect）。

## 6 · 是否回归

- **不是今天就有的**：这条 claim 从 **2026-11-04T16:22Z** 起就在卡样本里渲染（同一张卡共 14 次），引用一直是 `(ep-62bcb7d2, 2026-11-03, seq 5736)`。
- 你看到的 `295/295` 绿是**更早的样本集**（不含这些 ref）——A6 的分子分母随样本集变化，跨时点不可比（AGENTS §2.4）。
- 今天 `--current` 的 `missing=1` 只是**样本里第一次出现**这类引用，不是新产生的数据问题。

## 7 · 修法（只报告，未改代码）

| # | 位置 | 改法 | 影响面 |
|---|---|---|---|
| **F1** | `src/rooms/topic.mjs` 失败边分支 | `seq` 改用 `edge.evidence.end`（片段所在事件），`start` 只作 fallback | 2027 条引用会从"start"变"end"；`at-seq` 从"距离 10 边界"变成"距离 0"，A6 更稳 |
| **F2** | 同上 · `quote` | 用**原始事件文本**而不是 `edge.errorSnippet`（或至少保留 `[stderr]` 等标记）；需要读取会话日志 | 成本高（要回放日志），可只对"含 `[stderr]`/多行"的片段生效 |
| **F3** | `scripts/audit-card-samples.mjs` · `classifyTextByEvents` | 比对前把 `[stderr]`/`[stdout]` 等标记视为可忽略（或把 needle 按 `\n[stderr]\n` 切段后做前缀匹配） | 24 条 missing 中至少 1/3 会转成 at-seq/joined；**但这只是让读数更诚实，不解决 F1/F2 的根因** |
| **F4** | 数据 | 若要"引文必须逐字"，需要重抽取受影响 claim（231 条截断 + 未知数量的归一化） | 违反"只增不改"⇒ 只能加 `supersedes` 新记录 |

## 8 · 复现

```bash
# 1) 你指的那条：seq 5736 是 assistant/message（不含引文），引文在 5746
node tmp/t230-probe.mjs                      # 默认 ep-62bcb7d2 / seq 5736
#   → type = assistant/message（reasoning，讲 04:08 定时复核）

# 2) 真 missing 那条：ep-226dbf4f seq 3674 是 tool/result，原文带 [stderr]
node tmp/t230-probe.mjs --episode ep-226dbf4f --seq 3674
#   → "ok
[stderr]
github.com/MYCF711/dsh-ui/cmd/app: go build … [exit code: 1]"

# 3) 合流前后 support 对比（两条 claim 都相同）
node --input-type=module -e '…memory-context vs memory-context.pre-T201…'
#   → support 相同? true；差异字段 ["_store"]（updatedAt 09:42，早于合流 09:56）

# 4) 全样本重算
#   STAT {"at-seq":968,"elsewhere":97,"missing":24}（515 张卡 / 1089 条引用）
```
