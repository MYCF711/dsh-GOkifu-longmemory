# T18 · 心跳台账 `live-stats.jsonl` 上限：无上限 → 64MB（撞线不再静默）

> 2026-11-08 · 依据 T16 交付时指出的遗留：`live-stats.jsonl` 自身无上限（每步一行，行数比卡样本多 6 倍）。
> 改动：`src/plugin.mjs`（`LIVE_STATS_CAP_BYTES` / `appendLiveStats` 返回值与上限 / `traceLiveStatsCap` / apply 接线）、
> `test/plugin.test.mjs`（T18 ①–④）。**读侧零改动**（原因见 §2）。

## 1 · 结论

**选「抬上限到 64 MB」，不选「按月分段 / 轮转」。** 与 T16 同一条硬约束：任何让读者静默少读的方案都不行。

## 2 · 读者清单（先查再决定 —— 共 8 个生产读者）

| # | 读者 | 读法 | 若按月分段/轮转的后果 |
|---|---|---|---|
| 1 | `scripts/live-stats.mjs` | **整文件** `readFileSync` + 逐行 JSON.parse | 只看到最新一段 ⇒ 动作/原因/tokens 分布**静默缺历史** |
| 2 | `scripts/arena-report.mjs`（`summarizeOurs`） | **整文件** `readJsonl` | 我方侧注入/失败数**静默变小** |
| 3 | `scripts/audit-card-samples.mjs`（`--current`） | **整文件**，挑最后一条心跳的 pid | `--current` 可能挑错 pid / 挑不到 ⇒ 审计样本**静默缺失** |
| 4 | `scripts/m5-report.mjs`（A3 心跳） | **整文件** | 六轴报告里的 A3 分布**静默缺历史** |
| 5 | `scripts/watch-first-inject.mjs` | **整文件 + 轮询** | 若首 inject 落在旧段 ⇒ **永远等不到** |
| 6 | `scripts/patrol.mjs` / `scripts/status-digest.mjs` | 经 `live-stats.mjs`（整文件） | 巡检读数**静默变小** |
| 7 | `scripts/kifu-profile-doctor.mjs` | `tailJsonl`（只读尾部） | 尾部为空 ⇒ 心跳**误报"没有"** |
| 8 | `scripts/ledger-check.mjs`（`--full`） | 只 `statSync` 判 mtime 新鲜 | 轮转瞬间 mtime 归零 ⇒ 可能误判"线上没跑" |

> 注：任务书里提到的 `scripts/first-live.mjs` 实际**不读** live-stats（它读 install-doctor / metrics-guard / shadow / repeat），已核实。
> 也就是说，**6 个整文件读者 + 1 个 tail 读者 + 1 个 mtime 读者** —— 任何分段方案都要同时改 8 处，
> 漏一个就是"静默少读"，且没有测试能兜住（这正是 T16 拒绝轮转的同一理由）。

## 3 · 撞上限不再静默（T16 同形状，但痕迹写在**台账自己**里）

`live-stats.jsonl` 就是被设上限的文件 —— 痕迹不能"再写进一个满文件"，也不能写进没人读的新文件。做法：

1. `appendLiveStats(storeRoot, row, { capBytes, allowOverCap })` 返回值从 `undefined` 改成
   `{ status, fileBytes }`，`status ∈ written | capped | absent | failed`；到上限返回 `capped`（旧实现是无上限一直写）。
2. **墓碑行**：`traceLiveStatsCap` 在撞线时
   - `ctx.logger.warn('live-stats 已到上限 …')`（宿主日志，grep 可见）；
   - 往 `live-stats.jsonl` 追加**一条** `{ kind:'live-stats-cap', action:'skip', reason:'live-stats-cap', capBytes, fileBytes }`；
     这一行用 `allowOverCap: true` 越过上限（**唯一允许越界的一行**）—— 这样 8 个读者全都能看见它：
     `node scripts/live-stats.mjs` 的 `原因：` 行会出现 `live-stats-cap=1`。
3. **一次性**：`apply()` 闭包里的 `Set`（每插件实例、每 storeRoot 一次）—— 撞线后每一步都会走到心跳，
   不设闸就会每步一行。dispose 时清空。
4. 附带：T16 的 `card-samples-cap` 痕迹也改成 `allowOverCap` —— live-stats 自己满时，
   "卡样本也满了"这条记录仍落得下来（每进程最多一条）。

## 4 · 按当前速率，多少天撞线

口径（本机实测，2026-11-08 10:05）：

| 量 | 值 |
|---|---|
| 现有文件 | 19,915 行 / **4,545,862 B** ⇒ **228.3 B/行** |
| 宿主行速率（完整日 11-04→11-07） | 7,676 行 / 4 天 = **1,919 行/天** ⇒ **≈ 438 KB/天** |
| 当前占用 | 4.5MB / 64MB = **6.8%** |
| **64MB 撞线** | 67,108,864 B ÷ 438,037 B/天 ≈ **153 天（≈5 个月）** |
| 若按最高单日（11-07：3,825 行） | ≈ **77 天** |
| 若按最低单日（11-06：406 行） | ≈ 724 天 |

> 不确定性如实标注：速率取决于当天开多少会话/多少步（11-06 只有 406 行，11-07 有 3,825 行，相差 9 倍）。
> 给出的是**均值 153 天、区间 77–724 天**；撞线时会先有 warn + 一条 `live-stats-cap` 行，不会无声停写。

## 5 · 向后兼容

- **同一文件名、同一行格式、append-only**：`appendLiveStats` 的写盘语句一字未改；旧行不迁移、不改写。
- **读侧零改动**（§2 的 8 个读者全部照旧）：它们看到的仍是**全部**历史行 + 末行的墓碑行。
- `allowOverCap` 默认 `false`，只有墓碑行显式传 `true`；`capBytes` 只给测试注入小上限，生产永远走 `LIVE_STATS_CAP_BYTES`。
- 库不存在仍返回 `absent` 且不创建文件（旧行为）。
- 旧测试 `A3 心跳: liveStats 默认写 live-stats.jsonl，关掉则不写` 保留通过。

## 6 · 验证

```bash
node --test test/plugin.test.mjs                                     # 67/67 pass
node --test --test-name-pattern "T18|A3 心跳" test/plugin.test.mjs     # 5/5 pass
node scripts/live-stats.mjs --store "<DSH_HOME>/memory-context"        # 19915 行读得通，exit 0
node scripts/audit-card-samples.mjs --store "<DSH_HOME>/memory-context" --current --no-text  # exit 0
node scripts/status-digest.mjs                                        # exit 0（经 live-stats.mjs）
node scripts/check.mjs                                                # PASS
node scripts/boundary-audit.mjs                                       # PASS 0 处
```

真库只读读数（10:05）：`动作：skip=18618 · inject=1268 · abstain=24`；`原因：no-signal=18062 · no-hit=547 · gates-failed=9 · cross-scope=24`；
`--current` 审计：样本 48 张 · 引用 118 条 · 可回溯 100.0%（宿主 pid=25256，心跳 913 条）。全程只读主人库。

**tombstone 实证**（改坏 → 红 → 复原 → sha256 一致 `a0f96f9a…`）：

| 删除的东西 | 结果 |
|---|---|
| `appendLiveStats` 里的 `if (!allowOverCap && stat && stat.size >= cap) return { status:'capped' … }` | T18 ① **红** + T18 ③ **红** |
| `apply` 里的 `traceLiveStatsCap(...)` 调用 | T18 ③ **红**（撞线后没有墓碑行） |

## 7 · 剩余风险 / 下一步候选

1. `corpus/messages.jsonl`（T268 消息语料）同样**无上限**（今天 892KB，增长取决于会话量），是下一个同形状候选。
2. `evidence/…` 各种 jsonl 由脚本按需生成，不属常驻 sidecar，本任务不碰。
3. 撞线后**不会自动恢复**（有意：自动删历史会毁证据），需要人归档；warn 文案写明"归档或抬高上限后恢复"。
4. 若将来真要分段：正确做法是先把"读全部段"收口到 `scripts/live-stats.mjs` 的一个导出函数，
   让 §2 的其余 7 个读者全部改用它 —— 8 个读者同一份口径之后，分段才安全。
