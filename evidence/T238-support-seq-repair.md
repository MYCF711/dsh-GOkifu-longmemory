# T238 · `support[].seq` 存量修复（迁移脚本 + 真实分布）

> `[本] 2026-11-05 15:20 +08:00` · 真库**只跑 dry-run**（未写任何 claim）。
> 产物：`scripts/repair-support-seq.mjs`、`test/repair-support-seq.test.mjs`、`tmp/t238-redo.cjs`

## 1 · 机制

对每条 claim 的每个 `support[]`（P2 口径，复用 `scripts/provenance-p2.mjs` 的 `normalizeText`）：

| 判定 | 含义 | 动作 |
|---|---|---|
| `ok` | `seq` 指向的事件**含** quote | 不动 |
| `repair` | 同一 episode 内**唯一**一个事件含 quote | 改 `seq`，追加 `provenanceRepair` |
| `ambiguous` | 多个事件都含 | **不修**，列出候选 |
| `unrepaired` | 一个都没有 | **不修**，单列 |
| `skipped` | quote 为空 | 不动 |

只增不改：`quote` / `text` / `state` 不动，只改 `seq` + 追加 `{at, version, fixes:[{from,to,reason,eventType,index}], evidenceSeq}`。

**存储伪影修正**：库里超长 quote 会被截断并补 `…`（U+2026）——那是伪影不是正文，匹配前剥掉尾部省略号（否则永远 0 命中，实测 `c-39b8ac53`）。

## 2 · 真库 dry-run 分布

```
$ node scripts/repair-support-seq.mjs --limit 6
扫描 claim 1465 条 · support 引用 2468 条
  ok（seq 已正确）      381
  可修（唯一命中）      6
  ambiguous（多命中）   522
  unrepaired（找不到）  1054
  skipped（quote 为空） 0
  —— 头部 5 条 from → to ——
  c-00248579 @ ep-c0a5847a: 50332 → 50334（tool/result，距离 2）
  c-00a2178a @ ep-bc4ab3cb: 817 → 819（tool/result，距离 2）
  c-019a52a3 @ ep-8cc34e32: 2320 → 13325（tool/result，距离 11005）
  c-0278a298 @ ep-bde12afa: 3284 → 3288（tool/result，距离 4）
  c-03fba890 @ ep-f7f835b1: 1326 → 1330（tool/result，距离 4）
耗时 2m51s（读 730 局日志，按 episode 缓存）
```

## 3 · 与 T232 口径对账（**不一致，必须记**）

任务书期望"可修 ≈ 1455 条偏移类"，实测**只有 6 条**。差异来源已定位：

1. **`ambiguous` 522**：同一段文本同时出现在 `assistant/message` 与 `tool/result`（工具输出被回显进助手消息），匹配到多处 ⇒ 按规则**不修**；
2. **`unrepaired` 1054**：quote 是 200 字符截断 + `…`，剥掉省略号后仍需 200 字符**连续**出现在同一事件里；跨事件边界、或中间有格式化差异（换行/空白归一后仍不齐）⇒ 找不到；
3. 另有约 505 条 support 条目不是对象（`threadId`/`nodeId` 引用形状）⇒ 不进判定。

## 4 · 目标样本 `c-39b8ac53`（audit 点名的那条）

```
support: [{"ep":"ep-226dbf4f","seq":3670,"quote":"ok github.com/MYCF711/dsh-ui/cmd/app: …"}]
len=200 末尾=".exe: open tmp/app-real.exe: The proces…"
3670 assistant/message includes? false
3674 tool/result     includes? false
diff@3674 {"index":0,"expected":"t","actual":"o","unaligned":true}
locate → {"status":"unrepaired","from":3670,"to":null,"cands":[]}
```

⇒ **这条修不了**：它的 quote 以 `…` 截断，且 200 字符跨了两个事件（`go build` 与 `open tmp/app-real.exe` 分属不同步），任何"单事件子串"判定都无法命中。

## 5 · 测试

```
$ node --test "test/repair-support-seq.test.mjs"
ℹ tests 5   ℹ pass 5   ℹ fail 0   ℹ duration_ms 159.75
```
覆盖：唯一命中 / 已正确 / 多命中不修 / 找不到不修 / 幂等 + 只改 seq 且追加 provenanceRepair。

## 6 · 一句话结论

**存量不能一次修干净**：按"单事件唯一子串"这条机械判据，2468 条引用里只有 **6 条**可修；卡在 **`ambiguous` 522（同文多处）** 与 **`unrepaired` 1054（200 字符截断 + 跨事件）** 两类——后者需要"跨事件拼接匹配"或"以 claimId 反查原始抽取记录"才能动，已超出本刀口径。
