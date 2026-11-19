# T370 · 归档为什么跑不完：**每次都把 338 万个事件从头解一遍**

> 2026-11-19 · 由 T159 收尾时 `timeout 900 node scripts/archive.mjs` 被超时杀掉（exit 124）引出。

## 一、实测

| 跑法 | 耗时 | 说明 |
|---|---|---|
| `archive.mjs --dry-run --json` | **206 秒** | 只读 + 算，**不写盘** |
| `archive.mjs`（全量，含写盘） | **> 900 秒**（被超时杀掉） | 写盘阶段另加 700 秒以上 |

dry-run 的阶段读数：

```
logs.total      4586 个会话日志
logs.events     3,388,938 条事件
logs.truncated  0 · badLines 0 · unreadable 0
elapsedMs       206005
```

## 二、根因（结构性，不是某段代码慢）

`archive.mjs` **每次运行都把全部历史重新走一遍**：

1. 逐个打开 4586 个**多帧 zstd** 日志；
2. 逐帧解压、解析出 **338 万条事件**；
3. 重新抽取信号/主题、重算 claims、重算索引；
4. 再与库里现有记录 diff、写盘。

会话只会变多 ⇒ **成本随历史线性增长，且每次都从零开始**。这正是"跑不完"的形状。

## 三、正确的优化方向：**增量归档**

不是微优化，是换算法：

| 现状 | 目标 |
|---|---|
| 每次全量 4586 个日志 | 只处理**新增/变更**的会话（按 `sessions/` 的 mtime + 已入档水位） |
| 每次都重算全部 claims | 只对变更会话重算，其余沿用 |
| 无进度输出 | 分段计时 + 进度日志（便于下次定位） |

判据（下轮实现后用同一命令复跑）：

- `archive.mjs --dry-run` **≤ 10 秒**（当前 206 秒）；
- 全量归档 **≤ 60 秒**（当前 > 900 秒）；
- **幂等**：连跑两次，第二次 `wouldWrite=0`、manifest 逐字节不变；
- 归档后 `staleMarkedBy` 仍保留（T159b 不回归）。

## 四、附带发现（要更正一条旧结论）

`archive.mjs` 的用法里写着 **`--include-subagents 子代理会话独立成谱（默认归并进父局，标 folded-into）`** ——
说明**子代理局的归并在 episode 层是实现了的**（折成父局）。

我之前在 T360 evidence 里写「子代理归并只写在文档、代码未实现」**说过头了**：
准确说法是「**episode 层的 folded-into 有实现；claim 层没有把子代理的失败并进父局**」。
那不影响当时的结论（归并的覆盖率收益实测为 0），但结论的措辞要更正。

---

## 五、增量归档已实现（`--incremental`）——实测 216 秒 → **14.7 秒**

### 实现

1. `src/rooms/cli.mjs`：`listSessionLogs` / `listGraphs` 增加 `mtimeMs`（只比 bytes 不够：重写可能等长）。
2. `scripts/archive.mjs`：新增 `--incremental`（**默认关**，行为不变）：
   - 水位文件 `<storeRoot>/archive-watermark.json`，记录每个会话的「log mtime+bytes / graph mtime+bytes」；
   - 跳过条件：**四项指纹全等** 且 **库里已有该局的 episode**；
   - 任何一项对不上（或无 episode）⇒ 照常重算（宁可慢，不漏档）；
   - 只在非 dry-run 时写水位。

### 实测（同一命令对比）

| 跑法 | 事件数 | 耗时 |
|---|---|---|
| `runArchive({dryRun:true})`（全量） | 3,440,859 | **216,591 ms** |
| `runArchive({dryRun:true, incremental:true})` | **149,904**（−95.6%） | **14,774 ms**（−93.2%） |

处理会话数：4601 → **119**（跳过 4482）。

### 踩到的坑（值得记）

第一版把 `store` 用在它自己的声明之前（TDZ）⇒ 访问抛 `ReferenceError` 被 `catch` 吞掉 ⇒
`archived` 恒为空 ⇒ **一条都跳不掉，看起来"跑了增量"其实全量重算了 4601 局**。
教训：**catch 里的静默失败会让"优化没生效"伪装成"优化生效了"**。已改为在筛选块内单独 `createStore`，并把这个坑写进代码注释。

### 门禁

```
node --test test/archive.test.mjs  → 11/11（含新增的 --incremental 解析断言）
node --test "test/*.test.mjs"      → 1304 / 1298 通过 / 0 失败 / 6 跳过
```

### 还没做的（下一步）

- 全量归档（含写盘）仍会慢：本次只优化了**读+算**这段；写盘段（15750 条 diff）未动。
- 默认关：等 `--incremental` 再跑几次确认不漏档，再考虑翻默认。

---

## 六、真跑实测（重要更正）：增量只省了读，**写盘+派生仍占 90% 以上**

| 跑法 | 处理会话 | 耗时 |
|---|---|---|
| `--incremental --dry-run`（只读+算） | 119 | **14.7 秒** |
| `--incremental`（真跑，有变更） | 125 | **760 秒** |
| `--incremental`（真跑，**零变更**） | 0（skip 4481） | **> 900 秒（超时）** |

**结论**：即使**一个会话都不用处理**，归档仍跑不完 900 秒 ⇒ 瓶颈**不在读日志**，而在：

1. `deriveStore()` 被调用 **两次**（`scripts/archive.mjs` 的 line 742 与 line 842：一次算出要写的派生记录，一次写完后再算一遍做校验）；
2. 每次都基于**全部 4489 个 episode** 重建 topics / links / threads / index；
3. 再逐条 diff + 写盘 + verify。

所以我上一版 CHANGELOG 里「读+算 216→14.7 秒」是**只对 dry-run 成立**的说法，真跑并没有变快。
这条必须更正 —— 否则下一个人会以为归档已经修好了。

## 七、下一步（真正能修好的那一刀）

**零变更早退**：`incremental` 且所有 kind 的 `plannedDiff` 都是 `added=0 / changed=0` ⇒
**跳过 deriveStore + 写盘 + verify**，直接返回 `wouldWrite=0`。

判据：连跑两次，第二次 **≤ 5 秒**；第三次再跑仍 ≤5 秒且 manifest 逐字节不变。
再进一步：把两次 `deriveStore` 合并成一次（若第二次只是校验，可换成抽样校验）。

