# T30 · 归档层恢复索引（读时 1.22% → 2.37%，T28 的正解）

> 日期：2026-11-08 · 只读派生 + sidecar 写入（`memory-context/recovery-index.json`）· 改动：`scripts/archive.mjs`、`src/rooms/extract.mjs`、`src/rooms/inject.mjs`、`src/rooms/persist.mjs`、`test/inject.test.mjs`、`test/extract.test.mjs`
> 前置：`evidence/T28-recovery-fact-on-card.md`（读时派生 + 8 MB 上限 ⇒ 19/1560 = 1.22%）

## 0 · 一句话结论

恢复事实从"每次读卡解会话日志"改成**归档层预计算 + 读时查索引**：`<store>/recovery-index.json`（`claimId` 兜底键 + `(episode, supportSeq)` 精确键）。真库覆盖从 **19/1560 = 1.22%（读时派生）** 提到 **37/1560 = 2.37%（索引）**，接近 T28 全量口径的 38/1560 = 2.44%。索引**只增不改**、无时钟字段 ⇒ **重放两次 sha256 相同**（`47dd3402…`）；读时**索引优先、查不到再回退读时派生**；索引缺失时行为与 T28 逐字节一致（tombstone）。

## 1 · 为什么需要它（T28 的遗留）

- T28 的读时派生只对 `closure.logPath` **≤ 8 MB** 的局生效（大日志解一局 1–2 s，20 张卡就能把 m5-report 拖慢一倍）⇒ 真库只覆盖 **19/1560 = 1.22%**，长会话（8 个局 >8 MB，占 472 MB 的 56%）里的 19 条恢复拿不到。
- 归档层**本来就要读每一局的会话日志**（`extractSignals({graph, events})`），在那里顺手算恢复事实**边际成本≈0**；读时只查一个小 JSON。

## 2 · 索引形状与纪律

```json
{
  "version": 1,
  "entries":  { "c-xxx": { "kind": "same-file-write-ok", "seq": 382, "at": 1793590901821,
                            "failureSeq": 360, "episode": "ep-9becea64", "prefix": "Error: cannot edit …" } },
  "supports": { "ep-9becea64:360": { "claimId": "c-xxx", "kind": …, "seq": …, "at": …, "failureSeq": …, "prefix": … } },
  "counts":   { "entries": 37, "supports": 455 }
}
```

| 纪律 | 做法 |
|---|---|
| **只增不改** | `mergeRecoveryIndex`：已有键保留原值；同一键不同值只计 `conflicts`，**不覆盖**。 |
| **幂等** | 没有 `generatedAt` 一类时钟；`stableText` 深排序 ⇒ 同一 store+日志两次写完**字节相同**（实测 sha256 一致）。 |
| **原子写** | 同目录 `.tmp-*` → fsync → rename；崩溃不留半截 JSON。 |
| **不写上游** | 只读 `sessions/`、`chess-context/`；只写 `<store>/recovery-index.json`。 |
| **不进 manifest checksums** | 它是派生物；重算索引不改"记忆内容"，`store.verify()` 在写索引**之前**跑（不把 sidecar 算进库内容）。 |
| **看不懂就回退** | 版本非 1 / JSON 坏 / 形状不对 ⇒ `readRecoveryIndex` 返回 `null` ⇒ 读时回退到 T28 派生（不抛、不猜）。 |

**键的选择**（任务 ③）：`(episode, supportSeq)` 是**卡上出处的精确坐标**（`entryFromClaim` 的 `src.episode/src.seq`），首选；`claimId` 是兜底（旧索引 / 渲染的 support 没进 supports 时用，另加 episode + 引文前缀校验）。

## 3 · 归档层怎么产出

| 路径 | 位置 | 说明 |
|---|---|---|
| **增量**（每次归档） | `runArchive` 循环内 | 日志已经读进 `events`；`collectRecoveryFacts({events, episode})` 产出该局所有"失败→后来同一主体成功"的事实；claims 定案后按 support 引文对齐 → 合并写索引。summary 里报 `recoveryIndex: {computed, entries, added, kept, conflicts}`。 |
| **存量回填**（一次性/按需） | `node scripts/archive.mjs --recovery-index` | 只读 **claim 引用到的局**（真库 115 局 / 475 MB / **15.5 s**），算事实、写索引；不跑入档。 |

**对齐规则**（修过一次的真实 bug）：同一段错误在一局里可能出现多次（别的工具结果也贴过它）。最初只按引文前缀取**第一条**，结果把 `CHANGELOG.md` 那条（失败 seq 44262）错配到 seq 586 的恢复上（**恢复比失败还早**）。修正：取 `|failureSeq − support.seq|` **最近**的事实，且距离 > `RECOVERY_SUPPORT_MAX_DISTANCE = 100` 一律不挂（`support.seq` = 边的 `evidence.start`，失败结果通常就在其后 0–3 条）。修正后同一条 claim 的尾注变成 `后于 2026-11-06 …（seq 48687）`（正确）。

## 4 · 读时怎么用（`src/rooms/inject.mjs`）

```
indexedRecoveryFact(claim, src, storeRoot):
  ① supports["<src.episode>:<src.seq>"] 且 claimId 匹配 ⇒ 直接用（精确坐标，不需要前缀校验）
  ② entries[claim.id] + episode 匹配 + 引文前缀兼容 ⇒ 用（兜底）
  ③ 都不中 ⇒ 回退 T28 读时派生（≤8 MB 日志）
  ④ 都没有 ⇒ 该行逐字节不变
```

- 索引读取按 `size+mtime` 缓存（进程内），热路径只有一次 `stat`；索引更新自动失效。
- `recoveryOnCard:false` 仍然一键关掉（A/B / 紧急回退）。

## 5 · 覆盖率前后对照（真库 1560 条 antipattern claim）

| 口径 | 有效 | 覆盖率 | 说明 |
|---|---|---|---|
| **读时派生（T28，8 MB 上限）** | 19 / 1560 | **1.22%** | `evidence/T28…` 实测 |
| **归档索引（本刀）** | **37 / 1560** | **2.37%** | `supports` 命中 36 + `claimId` 兜底 1 |
| T28 全量口径（不设上限，参照） | 38 / 1560 | 2.44% | 本刀 37 与之基本持平（差的 1 条是 claim 的 support 引文对不上任何失败事实） |

索引里 `entries` 37 / `supports` **455**（一条 claim 有多条 support，各自记一条）。按种类：`same-file-write-ok` **24**、`same-command-no-failure` **13**、`same-command-exit-0` 0（与 T28 一致：人们不会把长命令逐字重跑）。

## 6 · 幂等与只增不改（实测）

```text
第一次（删掉后重建）：facts 524（按 support 计）· entries 37 · supports 455 · 15.5 s
第二次（重放）：       added 0 · kept 1048 · conflicts 7 · 同 sha256
sha256(before) = 47dd3402d9b3ae0f8ceeb909c3893c00fc456753f928707ba7a7f533f31157f9
sha256(after)  = 47dd3402d9b3ae0f8ceeb909c3893c00fc456753f928707ba7a7f533f31157f9
```

- `conflicts 7` = 同一个 `(episode, supportSeq)` 被两条 claim 引用（类级章节与成员 claim 共用同一条失败）⇒ 保留先写入者；读时还要求 `claimId` 匹配，所以第二条会走 `claimId` 兜底或读时派生，不会串用。
- 重放**不删**任何旧条目（`added 0` 而不是"重写整个文件"）。

**首次重建的处理**：修好"前缀-only 错配"后，把当时那份**刚生成、尚无人使用**的索引删掉重建了一次（派生文件，非记忆内容；不是"回填历史 claim"）。

## 7 · 卡行样例（同一批输入）

```text
（T28 时，读时上限拿不到 —— 该局日志 38.8 MB）
- [antipattern] Error: cannot edit "…/CHANGELOG.md": binary file (ep-8cc34e32, 2026-11-06, seq 44262)

（T30，索引命中 —— 不需要解那 38.8 MB 日志）
- [antipattern] Error: cannot edit "…/CHANGELOG.md": binary file (ep-8cc34e32, 2026-11-06, seq 44262) · 恢复：后于 2026-11-06 同一文件写入成功（seq 48687）
```

其它定点（`tmp/t28-real-demo.mjs`，每张卡 tokens +15…+41）：`c-6d74f391`（+1 行，seq 382）、`c-a3b4e7f1`（+3 行，seq 1775）、`c-bafead79`（+2 行）。**没有恢复事实的行逐字节不变**。

## 8 · 成本

| 项 | 实测 |
|---|---|
| 存量回填 `--recovery-index` | **475 MB / 115 局 / 15.5 s**（一次性；之后归档增量维护） |
| 归档增量 | ≈0（日志本来就要读；每局只是多一次 O(events) 扫描，几百毫秒级） |
| 读时 | 一次 `stat` + 命中缓存后 0；**不再解日志**（大日志 claim 也能出尾注） |
| m5-report（20 张卡） | **56.9 s**（T28 设 8 MB 上限后是 56.6 s ⇒ 索引几乎不增加耗时；大日志 claim 反而免解析） |
| 索引体积 | 37+455 条 ≈ 90 KB JSON |

## 9 · 测试（`test/extract.test.mjs` T30 ①–③、`test/inject.test.mjs` T30 ④–⑧，全绿）

| # | 断言 |
|---|---|
| T30 ① | `collectRecoveryFacts` 为有恢复的失败产出 `{episode, failureSeq, kind, seq, at, prefix}` |
| T30 ② | 没有恢复 ⇒ 空数组（不编） |
| T30 ③ | 纯函数：同输入两次 `deepEqual`；不给 episode 不编 |
| **T30 ④** | **索引优先**：日志删掉也能从索引拿到尾注；索引里没有条目的 claim 行与关掉恢复事实**逐字节相同** |
| T30 ⑤ | 索引条目的 episode/前缀对不上 ⇒ 不用（不猜、不串用别的 support） |
| **T30 ⑥（tombstone）** | **索引缺失 ⇒ 回退读时派生**（日志在 ⇒ T28 行为不变；日志也没了 ⇒ 与关掉恢复事实逐字节相同） |
| **T30 ⑦** | `buildRecoveryIndex` 重放幂等：两次文件字节相同、第二次 `added 0 / kept 4` |
| T30 ⑧ | 只增不改：同键冲突只计数不覆盖；同一 claim 的多条 support 正常加入（不误记冲突） |

## 10 · 限制 / 风险

1. **索引是派生数据**：可从 store+日志重算；不进 manifest checksums，`verify` 不校验它。丢了/坏了 ⇒ 读时自动回退 T28（不会炸，只是覆盖回落）。
2. **回填要跑一次**：真库这次已跑（37 条）。之后靠归档增量维护；新机器/新库要先跑一次 `--recovery-index`（或等一次全量 archive）。
3. **`supports` 冲突 7 例**（同一失败被两条 claim 引用）：索引保留先写入者；读时按 `claimId` 匹配，不会串用。
4. **覆盖率 2.37% 仍是"事实稀缺"**（T28 §4：86.73% 的失败没有文件主体、命令级 exit 0 = 0）；本刀只是把"读时拿不到的长会话事实"补回来，不是把 2.44% 变成 50%。
5. **指针档**：默认指针行不带恢复事实（与 F3 同纪律）——**索引提高的是"内容行"的命中率，不改变指针档曝光**（T28 §5 的限制仍在）。
6. **读时另一条路仍在**：≤8 MB 日志的 claim 若索引没覆盖（新增 claim、索引还没重建），回退派生照常工作；两条路的结果口径同一套判据。

## 11 · 复现

```bash
# 1) 存量回填（只读日志、写 sidecar；~15 s）
node scripts/archive.mjs --recovery-index --root "$DSH_HOME" --json

# 2) 再跑一次 ⇒ added 0 / kept 1048 / 同 sha256（幂等）
node scripts/archive.mjs --recovery-index --root "$DSH_HOME" --json
sha256sum "$DSH_HOME/memory-context/recovery-index.json"

# 3) 覆盖率对照（读时 19 vs 索引 37）
node tmp/t30-coverage.mjs

# 4) 卡行定点（含大日志 claim）
node tmp/t28-real-demo.mjs c-b8725e63 c-6d74f391 c-a3b4e7f1

# 5) 测试
node --test --test-name-pattern "T30" test/inject.test.mjs test/extract.test.mjs
node --test "test/*.test.mjs"
node scripts/check.mjs
```

**关键数（复核请对这四个）**：
- 覆盖率：读时 **19/1560 = 1.22%** → 索引 **37/1560 = 2.37%**（supports 命中 36 / claimId 兜底 1）；
- 索引：`entries 37` + `supports 455`；回填 475 MB / 15.5 s；
- 幂等：两次 **同 sha256**、第二次 `added 0`；
- tombstone：索引缺失 ⇒ 回退 T28，逐字节一致（T30 ⑥）。

## 12 · 下一步

1. **T29 的卡形态**现在**线上可用了**：大日志会话的恢复事实也能上卡（不再受 8 MB 读时上限）。
2. **让归档记得自动重建索引**：本刀已让 `runArchive` 每次增量合并；若某次归档只跑子集（`--session`），存量回填仍需手动一次。
3. **曝光**：若要让默认卡也带恢复事实，需重审指针档（`observed` 且 1 局支撑是否只给指针）——T28 §5 已记，属方向问题。
4. **判据扩展**：`tests-pass` / `build-success` / `git-clean` 在 T338 实测新增 0，暂不接。