# T288 · A6 `notFound` 从 1 涨到 6：新坏引用还是旧数据被翻出？

> `[本] 2026-11-06 05:30 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 宿主：pid 19252，**启动时间 2026-11-05 21:12:32** · 本次审计样本 **441 条引用**（T270 时是 101 条）

## 0 · 一句话结论

**6 条 notFound 全部是旧数据，没有一条是本次宿主新产生的**：它们只对应 **2 个 distinct claim**（`c-39b8ac53` 5 次、`c-3104fb0e` 1 次），两者的 `recordedAt` 都是 **2026-11-03T12:09:33Z**，比宿主启动（2026-11-05 21:12:32）**早两天**。
**数量从 1 涨到 6，是"抽样样本变大"造成的**（引用 101 → 441 条，同一条旧 claim 出现在更多被抽到的卡里），**不是新坏引用**。
**⇒ 不紧急**。归因：`c-39b8ac53` = **C（200 字截断 + `…`）+ D（`[stderr]` 被吞）**；`c-3104fb0e` = **D（改写/压平，引用不是逐字原文）**。

## 1 · 6 条逐条（`--current --json` 原样）

```
总引用: 441 | notFound: 6
{"claimId":"c-39b8ac53","episode":"ep-226dbf4f","seq":3670,"cardAt":1793888688803,"quote":"ok github.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-ui/cmd/app"}
{"claimId":"c-39b8ac53","episode":"ep-226dbf4f","seq":3670,"cardAt":1793906569464,"quote":"ok github.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-ui/cmd/app"}
{"claimId":"c-3104fb0e","episode":"ep-c0a5847a","seq":24149,"cardAt":1793906991443,"quote":"播报加好 modules/tool/subagentfork/subagentfork.go:99:46: string literal not termina"}
{"claimId":"c-39b8ac53","episode":"ep-226dbf4f","seq":3670,"cardAt":1793909363772,"quote":"ok github.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-ui/cmd/app"}
{"claimId":"c-39b8ac53","episode":"ep-226dbf4f","seq":3670,"cardAt":1793910789680,"quote":"ok github.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-ui/cmd/app"}
{"claimId":"c-39b8ac53","episode":"ep-226dbf4f","seq":3670,"cardAt":1793912171805,"quote":"ok github.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-ui/cmd/app"}
```

| # | claimId | episode | seq | 出现次数 | 引文前 80 字 |
|---|---|---|---|---|---|
| 1–5 | `c-39b8ac53` | `ep-226dbf4f` | 3670 | **5** | `ok github.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-ui/cmd/app` |
| 6 | `c-3104fb0e` | `ep-c0a5847a` | 24149 | **1** | `播报加好 modules/tool/subagentfork/subagentfork.go:99:46: string literal n…` |

**去重后只有 2 条独立的坏引用**；`cardAt` 不同只是"同一 claim 出现在不同卡上"。

## 2 · 新旧判定（对照宿主启动时间）

```
c-39b8ac53 ep=ep-226dbf4f seq=3670
  recordedAt=2026-11-03T12:09:33.006Z · occurredAt=2026-11-03T10:07:03.007Z · 该 seq 事件: assistant/message @ 2026-11-03T10:07:03.006Z
  quote 尾 "The proces…" · 长 200 · 剥省略号后子串命中 seq: []
  quote 头: "ok github.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-"
c-3104fb0e ep=ep-c0a5847a seq=24149
  recordedAt=2026-11-03T12:09:33.006Z · occurredAt=2026-11-03T02:57:33.729Z · 该 seq 事件: assistant/message @ 2026-11-03T02:57:33.728Z
  quote 尾 "t terminated" · 长 83 · 剥省略号后子串命中 seq: []
  quote 头: "播报加好 modules/tool/subagentfork/subagentfork.go:99:46: string literal n"
```

```
宿主启动时间 = 2026-11-05 21:12:32
```

| claimId | recordedAt | 早于宿主启动？ | 判定 |
|---|---|---|---|
| `c-39b8ac53` | 2026-11-03T12:09:33Z | **早 2 天** | **旧数据** |
| `c-3104fb0e` | 2026-11-03T12:09:33Z | **早 2 天** | **旧数据** |

**没有一条的 `recordedAt` 晚于宿主启动** ⇒ **本次宿主没有制造新的坏引用**。

## 3 · 为什么数量从 1 涨到 6

| 时点 | 采样引用数 | notFound | 说明 |
|---|---|---|---|
| 22:53 / 23:32（T270） | **101** | 1 | 只抽到 `c-39b8ac53` 一次 |
| 04:23 | ~300 | 4 | 样本变大 |
| 04:56（本刀） | **441** | **6** | 同 2 条旧 claim 出现在更多卡里 |

**同一个 claim 在不同卡上被反复抽到** ⇒ notFound 计数随样本线性增长，**分母也在涨**（6/441 = 1.36%，T270 是 1/101 = 0.99%，同一量级）。

## 4 · 四类归因

| claimId | A 真编造 | B 跨事件 | C 截断 | D 改写 | 最终 |
|---|---|---|---|---|---|
| `c-39b8ac53` | ✗（原文存在） | ✗（单事件） | **✓**（200 字 + `…`） | **✓**（`[stderr]` 被吞） | **C + D**（与 T270 一致） |
| `c-3104fb0e` | ✗ | ✗ | ✗（83 字，无省略号） | **✓**（剥后 60 字在任一 seq 都不命中） | **D（改写/压平）** |

两条的共同点：**`support.seq` 指向 `assistant/message`，而 quote 是 `tool/result` 输出的归一化副本**（T273/T274 的取时/取 seq 同源问题）。

## 5 · 要不要紧急处理（判据落地）

| 判据 | 阈值 | 实测 | 结论 |
|---|---|---|---|
| 有 `recordedAt` > 宿主启动的条目 | **>0 ⇒ 紧急** | **0** | **未触发** |
| notFound 占引用比 | >5% | 6/441 = **1.36%** | 未触发 |
| 独立 claim 数 | >10 | **2** | 未触发 |
| 五类归因里是否有 A（真编造） | 有 ⇒ 紧急 | **无** | 未触发 |

**⇒ 不紧急**：全是 2026-11-03 的旧数据，属历史遗留（T270 已诊断过第一条，本刀新增的 `c-3104fb0e` 是同一类抽取器归一化）。

## 6 · 建议（未动手）

1. **不要为 notFound 单独改库**：两条都是"引文不是逐字原文"，`episode/seq/occurredAt` 都在。
2. **根因**：`extract.mjs` 取 `tool/result` 的 snippet 时做了归一化（吞 `[stderr]`、折行、截断 200 字），且 `seq` 记成了 `assistant/message`。**与 T273/T274 的 `edge.ts` 问题同源**，应在**同一次归档修复**里一起处理。
3. **监控口径**：notFound **应看比例（当前 1.36%）和 distinct claim 数（2）**，不要看绝对条数 —— 样本增大就会涨。

## 7 · 复现

```bash
node scripts/audit-card-samples.mjs --current --json > tmp/t288-audit.json
node -e 'const j=require("./tmp/t288-audit.json");const all=[];for(const d of j.details||[])for(const v of d.verdicts||[])all.push(v);console.log(all.filter(v=>(v.textTrace?.verdict??v.verdict)==="notFound").map(v=>[v.claimId,v.episode,v.seq]))'
powershell -NoProfile -Command "(Get-Process -Id 19252).StartTime"
```
