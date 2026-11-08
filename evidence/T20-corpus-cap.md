# T20 · 消息语料 `corpus/messages.jsonl` 上限：无上限 → 64MB（撞线不再静默）

> 2026-11-08 · 依据 T18 交付时指出的遗留：T268 消息语料同样无上限（今天 ~1.1MB，1,985 B/行）。
> 改动：`src/plugin.mjs`（`MESSAGE_CORPUS_CAP_BYTES` / `appendMessageCorpus` 返回值与上限 / `traceMessageCorpusCap` / decidePreStep 接线）、
> `test/plugin.test.mjs`（T20 ①–③ + T268②/T282③ 改认状态对象）。**读侧零改动**。

## 1 · 读者清单（先查后定 —— 全仓只有 1 个读者）

| # | 读者 | 读法 | 备注 |
|---|---|---|---|
| 1 | `scripts/t267-replay.mjs`（`CORPUS` / `--corpus`） | **整文件** `fs.readFileSync(corpus)` + 逐行重放（`loadRows`） | 不在本任务可写范围 |

grep 全仓（`*.mjs` / `*.js`，排除 docs/evidence/reports/tmp）确认没有第二个读者；`evidence/T268-messages.jsonl` 是 T282 之前的旧路径，
现在写读都走 `<storeRoot>/corpus/messages.jsonl`（T282 已收口）。`scripts/t267-corpus-from-logs.mjs` 是**造**语料，不读这个文件。

⇒ 与 T16/T18 同一条硬约束：**任何让读者静默少读的方案（按月分段/轮转）都不行**；抬上限 = 零读者改动、旧行一字不动。

## 2 · 撞上限不再静默（T16/T18 同形状）

1. `appendMessageCorpus(rootDir, row, { fsImpl, capBytes })` 返回值从 `boolean` 改成
   `{ status, fileBytes }`，`status ∈ written | capped | failed`；到上限返回 `capped`（旧实现是无上限一直写）。
2. `traceMessageCorpusCap` 撞线时：
   - `ctx.logger.warn('消息语料已到上限 …')`（宿主日志，grep 可见）；
   - 往 **`live-stats.jsonl`** 追加一条 `{ kind:'messages-corpus-cap', action:'skip', reason:'messages-corpus-cap', capBytes, fileBytes }` ——
     用 `allowOverCap: true`（T18 的机制：live-stats 自己满时这条痕迹仍落得下，每进程最多一条）；
     这样现有 8 个 live-stats 读者都能看到它（`node scripts/live-stats.mjs` 的 `原因：` 行会出现 `messages-corpus-cap=1`）。
3. **一次性**：`apply()` 的 `lifecycle.corpusCapNotified`（每插件实例、每 storeRoot 一次），dispose 时清空；
   撞线后每一步都会尝试采集，不设闸就会每步一条。

## 3 · 按当前速率，多少天撞线

口径（本机实测，2026-11-08 10:10）：

| 量 | 值 |
|---|---|
| 现有文件 | 555 行 / **1,101,581 B** ⇒ **1,984.8 B/行**（p50 1,967 / p90 4,582 / max 12,089） |
| 时间跨度 | 2026-11-06T12:56:56Z → 2026-11-08T02:10:06Z = **1.55 天**，554 条有效行 ⇒ **357 行/天** |
| 字节速率 | 357 × 1,984.8 ≈ **709 KB/天** |
| 当前占用 | 1.1MB / 64MB = **1.6%** |
| **64MB 撞线** | 67,108,864 ÷ 709,046 ≈ **95 天（≈3 个月）** |
| 保守口径（按 11-06/11-07 两个自然日 510 行/2 天 = 255 行/天） | ≈ **133 天** |

> 不确定性：样本窗口只有 1.55 天，且这几天是第二阶段多成员并行的高活动期；实际可能是 95–133 天。
> 撞线时会先有 warn + 一条 `messages-corpus-cap` 行，不会无声停采。

## 4 · 向后兼容

- **同一路径、同一行格式、append-only**：写盘语句未改；旧行不迁移、不改写；T20 ① 断言撞上限后文件字节**逐字相等**。
- **唯一的读者零改动**：`scripts/t267-replay.mjs` 仍 `readFileSync` 整文件，读到的还是全部历史行（只多不少量）。
- 返回值类型变化只影响本仓两个测试（T268 ②、T282 ③ 已同步改成 `.status === 'failed'`）；调用点 `decidePreStep` 改为
  `status === 'failed'` 才 warn（`capped` 走自己的痕迹），行为等价。
- 库不存在/写失败仍静默降级、不抛（采集永远不许拖垮注入）。

## 5 · 验证

```bash
node --test test/plugin.test.mjs                                  # 70/70 pass
node --test --test-name-pattern "T20|T268|T282" test/plugin.test.mjs  # 10/10 pass
node scripts/check.mjs                                            # PASS
node scripts/boundary-audit.mjs                                   # PASS 0 处
```

真库只读验证：语料文件 555 行仍可整体解析（唯一读者 `t267-replay` 的 `loadRows` 口径：`split(NL).filter(Boolean)` + `JSON.parse`），
`messageCorpusPath()` 解析出的路径与现有文件一致（`<storeRoot>/corpus/messages.jsonl`）。本次不改读侧，无需改脚本。

**tombstone 实证**（改坏 → 红 → 复原 → sha256 一致 `c4221646…`）：

| 删除的东西 | 结果 |
|---|---|
| `appendMessageCorpus` 里的 `if (stat && stat.size >= cap) return { status:'capped' … }` | T20 ① **红** + T20 ③ **红** |
| `decidePreStep` 里的 `traceMessageCorpusCap(...)` 调用 | T20 ③ **红**（撞线后没有 messages-corpus-cap 行） |

## 6 · 观察到但**没动**的两件事

1. 现网语料里有一条 `at: null` 的行（`{"episode":"ep-t282-proof","scopeKey":"w:d:/x","at":null,...}`）——
   是某次 T282 验证写进真库的；`messageCorpusRow` 在 `at` 非数字时写 `null`（字段允许），但 `t267-replay` 用它做时间口径时会退化成 `Date.now()`。
   建议以后把验证行写隔离 store，或 `at` 缺失也拒绝落盘。**本任务不改**（超出范围）。
2. `evidence/T268-messages.jsonl` 旧路径已无人写读（T282 收口到 sidecar），可择机清掉；**本任务不改**。
