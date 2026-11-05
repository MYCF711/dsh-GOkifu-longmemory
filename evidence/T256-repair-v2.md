# T256 · 用新判据（`support.quote`）重测存量 seq 修复

> `[本] 2026-11-05 19:20 +08:00` · 真库**只读 dry-run**（`--apply` 现在会**拒绝真库路径**，只许 `tmp/` 副本）。
> 产物：`scripts/repair-support-seq.mjs`、`test/repair-support-seq.test.mjs`、`tmp/t256-redo.cjs`

## 1 · 判据换成了什么

| | T238（旧尺子） | T256（新尺子） |
|---|---|---|
| 拿什么追原文 | `normalizeText(quote)`（provenance-p2 口径） | **`normalizeCardText(support.quote)`**（`audit-card-samples.mjs` 的 A6 同口径：`singleLine` + 去 `[跨项目]`/`class:…` + 剥尾部 `…`） |
| 比什么 | 事件 `data` 全部字符串拼成的文本 | 事件 `collectStrings` → `singleLine` → 换行拼接的 `blob`（外加空格拼接的 `blobJoined`） |
| 命中多处 | 直接 ambiguous | 同样 ambiguous，但**只有唯一命中**才可修 |
| 可修距离 | 无上限 | **≤20**（`NEAR_WINDOW=4` 记 near-neighbor，5–20 记 shifted，>20 记 too-far 不修） |
| 内存 | 全局缓存每局事件索引 | **按 episode 流式处理**（一局解析完即丢；全缓存实测 OOM 崩溃） |

## 2 · 新旧读数对照（注意：两次跑的不是同一时点的库，真库在长）

| 桶 | T238（1465 claims / 2468 refs） | T256（1516 claims / 2579 refs） | 变化 |
|---|---|---|---|
| ok | 381 | 391 | +10 |
| **可修** | **6** | **8** | +2 |
| **ambiguous** | **522** | **915** | **+393** |
| **unrepaired** | **1054** | **52** | **−1002** |

差异归因（一句话）：**旧尺子把"其实找得到、只是不止一处"的引用记成了"找不到"**——换成 `support.quote` + 归一后，`unrepaired` 从 1054 塌到 52；但这些多出来的命中**大多不唯一**，于是全部落进 `ambiguous`（522 → 915）。

## 3 · 真库 dry-run（原样）

```
$ node --max-old-space-size=4096 scripts/repair-support-seq.mjs --limit 8
扫描 claim 1516 条 · support 引用 2579 条
  ok（seq 已正确）      391
  可修（唯一命中）      8
  ambiguous（多命中）   915
  unrepaired（找不到）  52
  skipped（quote 为空） 0
  —— 头部 5 条 from → to ——
  c-00248579 @ ep-c0a5847a: 50332 → 50334（tool/result，距离 2）
  c-043b8588 @ ep-c0a5847a: 14360 → 14364（tool/result，距离 4）
  c-05ff9fe8 @ ep-c0a5847a: 46341 → 46344（tool/result，距离 3）
  c-08b59027 @ ep-c0a5847a: 42734 → 42737（tool/result，距离 3）
  c-0a7172ab @ ep-c0a5847a: 27893 → 27897（tool/result，距离 4）
耗时 5m29s
```

## 4 · 点名样本 `c-39b8ac53`（ep-226dbf4f, seq 3670）

```
ref: ep-226dbf4f seq 3670 quoteLen 200 tail "pp-real.exe: The proces…"
events 17686
locate: {"status":"unrepaired","from":3670,"to":null,"n":0,"reason":"quote-not-found"}
```

**新口径下仍不可修**，但原因更精确了：它的 quote 是 **200 字符截断**，剥掉 `…` 后仍**跨两个事件**（`go build …` 与 `open tmp/app-real.exe` 分属不同步），任何"单事件包含"的判据都命中不了。它属于 `unrepaired 52` 这一类（真·跨事件/截断），不是 T238 那 1054 条的"假找不到"。

## 5 · 测试

```
$ node --test "test/repair-support-seq.test.mjs"
ℹ tests 7   ℹ pass 7   ℹ fail 0
```
覆盖：近邻唯一命中 / 已正确 / 多命中不修 / 找不到不修 / 太远(>20)不修 / **截断 quote 也能命中** / 幂等 + 只改 `seq` + 追加 `provenanceRepair{at,from,to,distance}`。

## 6 · 结论（给 Lead）

**存量仍然不能一次修干净，但"修不干净"的原因换了**：不是"追不到原文"（那只剩 52 条），而是 **915 条 quote 在同一局里能命中多处**（assistant 回显 + tool 结果 + 重复输出），而唯一命中且距离 ≤20 的只有 **8 条**。

T238 得出"修不干净"的归因：**它用的尺子（拿 `normalizeText(quote)` 对事件原始拼接文本）把大量"多处可命中"的引用算成了"找不到"**——量出来的形状（1054 找不到）是假的，真形状是"找得到但不唯一"。

下一步若要继续，需要给 `ambiguous` 加**消歧规则**（例如：优先 `tool/result`；同类型多命中取距 `seq` 最近且 ≤4；仍并列则放弃），这已超出"换判据"的范围，需要拍板。
