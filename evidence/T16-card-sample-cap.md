# T16 · 卡样本上限：8MB → 64MB（且撞上限不再静默）

> 2026-11-08 · 依据 T10 交付时指出的遗留（`signalPreview` 变完整后，8MB 上限会约 2 倍速撞到，
> 之后 `appendCardSample` **静默 return**，抽样在无人察觉中停掉）。
> 改动：`src/plugin.mjs`（`CARD_SAMPLE_CAP_BYTES` / `appendCardSample` 返回值 / `traceCardSampleCap` / apply 接线）、
> `test/plugin.test.mjs`（T16 ①–③ + M4 改成认新上限）。

## 1 · 结论（选了什么）

**选「抬上限到 64 MB」，不选「按大小轮转」。**

| 方案 | 旧文件可读性 | 读者改动 | 磁盘 |
|---|---|---|---|
| 抬上限 64MB（**选中**） | 原样可读（同一个路径、append-only） | **0 个** | 有界但更大（64MB 封顶） |
| 轮转 `.1`/`.2` | 需要跨段读，旧路径语义静默改变 | **至少 2 个脚本** | 恒定为 N×段大小 |

**不选轮转的理由（可核）**：`card-samples.jsonl` 在本仓有**两个独立读者**，各自直接 `readFileSync` 规范路径：

- `scripts/audit-card-samples.mjs` 的 `main()`（`const file = path.join(storeRoot, 'card-samples.jsonl')`）
- `scripts/offset-attribution.mjs` 的 `main()`（`const cardFile = path.join(storeRoot, 'card-samples.jsonl')`；
  本任务的可写范围不含它）

轮转会让「`card-samples.jsonl` = 全部样本」这个含义**静默**变成「= 最新一段」：
第二个脚本会**无声**少读历史，且没有任何信号提示它少读了 —— 这正是本任务要消灭的那类"静默失效"。
抬上限不动任何读侧，旧文件一字不改，`audit-card-samples` 行为逐字节不变（见 §5）。

## 2 · 撞上限不再静默（②）

三处配合，都落在 `src/plugin.mjs`：

1. `appendCardSample(storeRoot, row, { capBytes })` 的返回值从 `undefined` 改成状态对象
   `{ status, fileBytes }`，`status ∈ written | capped | absent | failed`
   —— 「到上限」从此是一个**可被调用方看见的事实**，不再靠"文件没长"去反推。
2. `traceCardSampleCap({ ctx, storeRoot, sample, notified })`：撞线时
   - `ctx.logger.warn('卡样本已到上限 …')` —— 落到宿主日志，能 grep；
   - 往 `<store>/live-stats.jsonl` 追加**一条** `{ kind:'card-samples-cap', reason:'card-samples-cap', capBytes, fileBytes }`
     —— 用现成的 `node scripts/live-stats.mjs` 就能看到（它按 `action`/`reason` 聚合：会出现 `reason：… card-samples-cap=1`）。
3. 「一次性」由 `apply()` 闭包里的 `Set` 保证（每个插件实例、每个 storeRoot 只报一次）：
   撞线后**每一次注入**都会走到留样这一步，不设闸就会每步刷一行垃圾。dispose 时清掉。

## 3 · 新估算：多少条后会撞线

口径（全部本机实测，2026-11-08）：

| 量 | 值 | 来源 |
|---|---|---|
| 现有样本文件 | 1223 行 / 1,078,786 B ⇒ **882 B/行**（T10 之前的老行，`signalPreview` ≤160 字） | `<DSH_HOME>/memory-context/card-samples.jsonl` |
| 注入速率 | 1223 行跨 6 天；完整自然日 11-04→11-07 共 **1183 行 / 4 天 = 296 行/天**（按 6 天摊则 244 行/天） | 同上，按 `at` 分日 |
| 真实信号宽度（T10 后） | n=537，p50 **1674 B** / p90 **4349 B** / mean 1731 B | `<DSH_HOME>/memory-context/corpus/messages.jsonl` 的最后一条 user 消息（脱敏后文本，自身封顶 4000 字符） |
| 新行宽（估算） | p50 **2479 B** / p90 **3925 B** / **mean 2410 B** | 取现有行（无 signal 的那批）替换 `signalPreview` 为上面的真实信号后逐行 `JSON.stringify` 量字节，n=300 |

⇒ **撞线估算**：

| 上限 | 能装多少行 | 按 296 行/天 | 按 244 行/天 |
|---|---|---|---|
| 8MB（旧） | **≈ 3,480 行** | **≈ 12 天** | ≈ 14 天 |
| 32MB | ≈ 13,900 行 | ≈ 47 天 | ≈ 57 天 |
| **64MB（新）** | **≈ 27,800 行** | **≈ 94 天** | ≈ 114 天 |

**换句话说：T10 之后若仍是 8MB，两周多一点就会静默停采**（这就是本任务的动机）；
换 64MB 后是 **3 个月上下**，且真到那天会先有一条 warn + 一条 live-stats 记录。

> 估算的不确定性（如实标注）：① 语料信号已脱敏/封顶 4000 字符，真实行宽只会**更大**，所以行数是**上界**；
> ② 注入速率取决于主人当天开多少会话（11-04/11-05 是高峰 388/485 行，11-06 只有 129 行）；
> ③ `section` 宽度随命中条数变化，已含在"现有行"基线里。三者都只会让"撞线天数"变短，不会变长。

## 4 · 向后兼容（③）

- **同一个文件名、同一行格式、append-only**：`appendCardSample` 只多返回一个状态对象，写盘语句一字未改；
  旧文件不迁移、不改写、不重命名。撞线时新行不写，旧行一字不动（T16 ① 断言文件字节逐个相等）。
- **两个读者零改动**：`scripts/audit-card-samples.mjs` 与 `scripts/offset-attribution.mjs` 仍是
  `readFileSync(join(storeRoot,'card-samples.jsonl'))`，读到的还是**全部**样本；`signalPreviewTruncated` 等新字段对它们是纯增量。
- **库不存在**时仍返回 `absent` 且不创建文件（不把"无库"变成"有库"，M4 旧断言保留）。
- `capBytes` 参数**只给测试注入小上限**；生产调用点不传，永远走 `CARD_SAMPLE_CAP_BYTES`。

## 5 · 验证（可复跑）

```bash
node --test test/plugin.test.mjs                                  # 63/63 pass
node --test --test-name-pattern "T16|M4" test/plugin.test.mjs      # 8/8 pass
node scripts/audit-card-samples.mjs --store "<DSH_HOME>/memory-context" --no-text   # exit 0
node scripts/live-stats.mjs --store "<DSH_HOME>/memory-context" --tail 2            # 正常
node scripts/boundary-audit.mjs                                    # PASS 0 处
```

真库只读跑（2026-11-08 09:18）：`样本 1223 张 · 引用 2715 条 · 可回溯 2715（100.0%）· 同作用域 2713 · 跨作用域 2`
—— 与改动前同口径、exit 0；`live-stats` 19749 行读得通（动作 `skip=18467 / inject=1261 / abstain=16`）。

**tombstone 实证**（改坏 → 红 → 复原 → sha256 一致 `11d6db13…`）：

| 删除的东西 | 结果 |
|---|---|
| `appendCardSample` 里的 `if (stat && stat.size >= cap) return { status:'capped' … }` | T16 ① **红**（会继续写）+ T16 ③ **红**（没有 cap 痕迹） |
| `apply` 里的 `traceCardSampleCap(...)` 调用 | T16 ③ **红**（撞线后 live-stats 没有 `card-samples-cap`） |

## 6 · 复现（估算部分）

```bash
# 现有行宽 + 速率
node -e 'const fs=require("fs");const f=process.env.DSH_HOME+"/memory-context/card-samples.jsonl";
const ls=fs.readFileSync(f,"utf8").trim().split("\n");console.log(ls.length, fs.statSync(f).size)'
# 新行宽：拿 corpus 的最后一条 user 消息当 signalPreview，量 JSON 行字节（见 §3 表）
```

## 7 · 剩余风险（本任务没动）

1. **`live-stats.jsonl` 自身无上限**（今天 19,749 行）；它每步一行，比卡样本长得快得多。
   卡样本 8MB→64MB 只解决了"审计留样"这一处，心跳台账仍会一直长（另开一刀：按 `at` 分月或加同样的 cap+trace 形状）。
2. **撞线后不会自动恢复**：文件到 64MB 就停写，需要人归档（把旧段挪走/清空）才会继续。
   这是**有意的**（自动删历史会毁掉审计证据），warn 文案已写明"归档或抬高上限后恢复"。
3. 若将来真要轮转，正确做法是先把"读全部段"收口成 `audit-card-samples.mjs` 的一个导出函数，
   让 `offset-attribution.mjs` 也改用它 —— 两个读者同一份口径之后，轮转才是安全的。