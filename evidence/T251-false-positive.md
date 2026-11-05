# T251 · 假阳性："测试全绿"被当成失败教训

> `[本] 2026-11-05` · **只读真库**（`--apply` 只打在 `tmp/` 副本上）· 未跑全量 `node --test`、未重启 DSH。
> 改动：`src/rooms/extract.mjs`（抽取侧）· 新增 `scripts/mark-false-positive.mjs`（存量处置 dry-run）· `test/extract.test.mjs`（+4 条）

## 0 · 一句话

这类假阳性是**抽取侧 `errorSnippet` 抓错行**进来的：`node --test … | grep -E "^ℹ (tests|pass|fail)"` 的命令真失败在别处（`exit 1` 来自后半段），`errorSnippet` 却抓到了 grep 出来的**绿字汇总**，于是 `[antipattern] ℹ tests 69 ℹ pass 69 ℹ fail 0` 被当成"坑"入库。**标记后 A2b 主判据不变**（`a2b-holdout` 的 `buildExam` 不过滤 `state`）。

## 1 · 机制（哪条路径）

真实边（`ep-8cc34e32` · `e4311`）：

```json
{"result":"failure","verify":{"kind":"exit","summary":"exit 1"},
 "snippet":"ℹ tests 69\nℹ pass 69\nℹ fail 0",
 "action":"bash(command=cd \"…\" && git status --short | head -5 && node --test test/gates.test.mjs 2>&1 | grep -E \"^ℹ (tests|pass|fail)\" && git checkout -b …)"}
```

- 边确实是 `failure`（`exit 1` 来自链尾的 `git checkout`），但 `errorSnippet` 取的是链中间的 **grep 输出**；
- `extract.mjs` 旧逻辑 `if (snippet) return snippet` 无条件采信 ⇒ `promoteClaim` 用这句绿字建 `[antipattern]`。

## 2 · 修改（4 处，只动 `src/rooms/extract.mjs`）

1. 新增 `PASS_SUMMARY_RES`（**列全**的通过汇总形态）：`ℹ tests N … ℹ pass N … ℹ fail 0`（单行/换行）、`# tests N`、`# pass N`、`# fail 0`、`N passing`、`0 failing`、整行 `ok N`；
2. 新增 `FAILURE_MARK_RES`（失败标记，命中即不许当绿汇总）：`ℹ fail [1-9]`、`# fail [1-9]`、`not ok N`、`✖/✗`、`FAIL(ED|URE)`、`failing tests:`、`N failing (N≥1)`、`Error`；
3. `export function isTestPassSummary(text)` = 命中任一 PASS 形态 **且** 无失败标记；`TEST_PASS_SUMMARY_FORMS` 把形态清单外露（审计可引用）；
4. `edgeQuote()`：`errorSnippet` 若是绿汇总 ⇒ 跳过、退到 `verify.summary`；
   边循环：失败边拿到绿汇总（看**原始 snippet**）⇒ `dropped.falsePositive += 1`、**不建 claim**。

## 3 · 验收（命令 + 原始输出）

```
$ node --test "test/extract.test.mjs"
✔ T251 假阳性：`ℹ tests N ℹ pass N ℹ fail 0` 不是失败信号（记 falsePositive，不建 claim）
✔ T251 假阳性：等价形态（# pass / # fail 0 / 0 failing / ok N / N passing）都不是失败信号
✔ T251 反例：真失败必须仍被判失败（fail 1 / ✖ / not ok / failing tests: / Error）
✔ T251 回归：绿汇总与真失败混在一起 ⇒ 仍判失败（不误伤）
ℹ tests 25   ℹ pass 23   ℹ fail 0   ℹ skipped 2
```

真日志重放（`ep-8cc34e32`，改前 88 failures / 改后）：

```
$ node --input-type=module -e '… extractSignals({graph, events}) …'
failures: 83 · 绿残留: 0 · falsePositive: 6
```

判据自检：

```
单行: true | 多行: true | fail 1: false | 0 failing: true | ✖: false
```

## 4 · 存量处置（dry-run，真库只读）

```
$ node scripts/mark-false-positive.mjs
假阳性（测试通过汇总）诊断 · store=D:\DeepSeek Harness\home\memory-context · dry-run
扫描 claim 1516 条 · 命中 7 条 · 已失效跳过 0 条
 1. c-1128a88d · antipattern/observed · "ℹ tests 69 ℹ pass 69 ℹ fail 0" · ep-8cc34e32#33143
 2. c-18954e39 · antipattern/observed · "ℹ tests 699 ℹ pass 694 ℹ fail 0" · ep-8cc34e32#33092
 3. c-788777eb · antipattern/observed · "ℹ tests 340 ℹ pass 340 ℹ fail 0" · ep-8cc34e32#4060
 4. c-a9e665ff · antipattern/observed · "ℹ tests 304 ℹ pass 304 ℹ fail 0" · ep-1e82afca#42168
 5. c-b6fcb615 · antipattern/observed · "ℹ tests 55 ℹ pass 55 ℹ fail 0" · ep-8cc34e32#32781
 6. c-b81fc5da · antipattern/observed · "ℹ tests 60 ℹ pass 60 ℹ fail 0" · ep-8cc34e32#35123
 7. c-b82a67ce · antipattern/observed · "ℹ tests 298 ℹ pass 298 ℹ fail 0" · ep-8cc34e32#2886
（dry-run：没有写任何文件。真库处置等口令；--apply 只许打在 tmp/ 副本上）
```

真库拒绝写 + 副本可写（实测）：

```
$ node scripts/mark-false-positive.mjs --apply
拒绝 --apply：D:\…\home\memory-context 不是 tmp 副本（真库只读；请先复制到 tmp/ 再打）   (exit 1)

$ cp -r "$DSH_HOME/memory-context" tmp/mc-copy
$ node scripts/mark-false-positive.mjs --apply --store tmp/mc-copy
apply：已标记 7 条（state=invalidated · reason=false-positive:test-pass-summary · supersededBy=null）

$ node scripts/mark-false-positive.mjs --store tmp/mc-copy
扫描 claim 1516 条 · 命中 0 条 · 已失效跳过 7 条
```

只增不改：只加 `state` / `invalidatedReason` / `supersededBy` 三个键，原字段一个不动，**不删任何文件**。

## 5 · 标记后 A2b 主判据会变吗

**不会。** `scripts/a2b-holdout.mjs` 的 `buildExam` 取 `store.list('claims').map(e => e.record).filter(Boolean)`，**全文没有 `state` 过滤**（`grep -n "state" scripts/a2b-holdout.mjs` 无命中）。当前实测：

```
$ node scripts/a2b-holdout.mjs --json
{"claims":1516,"episodesWithClaims":93,"self":93,"repeat":19,"skipped":0,"frozen":true}
```

⇒ 那 7 条标成 `invalidated` 后，A2b 仍会考它们，**分数不变**。要让"失效条目退出考卷"，得在 `a2b-holdout` 里加 `claim.state !== 'invalidated'` 过滤（不在本任务可写范围，需另开一刀）。

## 6 · 补丁

`tmp/t251-redo.cjs`（4 处 anchor 断言 + 幂等）：

```
$ node tmp/t251-redo.cjs --check
skip：T251 已应用（检测到 isTestPassSummary），幂等退出
$ node tmp/t251-redo.cjs
skip：T251 已应用（检测到 isTestPassSummary），幂等退出
```

删掉/还原 `extract.mjs` 后重放即可重建这 4 处；anchor 不是恰好 1 处 ⇒ 抛错、不写半套。
