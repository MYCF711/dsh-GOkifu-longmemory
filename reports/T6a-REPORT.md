# T6a 报告 · R15 persist（sidecar 存储）+ archive 入档管线 + verify/rebuild（2026-11-02）

> 任务 id：**task-4**（`T6a: R15 persist + archive 管线 + verify/rebuild`）
> 分支：**main（未提交）** —— 按 Lead 指令「团队共用工作树，禁止 checkout/switch/commit，文件保持未提交，由 Lead 提交」。
> commit sha：**无（未提交）**。建议 Lead 按「一刀一个 commit」拆两条：
> `R15 persist: sidecar 原子写 + manifest/checksums + journal + verify/rebuild`、
> `R15 archive: 会话日志/棋谱 → 记忆库（只读上游、幂等、dry-run、sourceStatus）`。
> 版本（`package.json` / `CHANGELOG.md`）由 Lead 升，本任务未动。

## 0 · 交付物

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/rooms/persist.mjs` | 1,211 | R15：`createStore`（put/get/list/ids/counts/replaceDerived/writeIndex/writeManifest）、`verify`、`rebuild`、journal、`deriveStore`（R04/R05/R07/R06 派生重算）、路径工具（`encodeId`/`validateRelPath`/`relativizeSource`/`sourceStatusOf`/`findPathViolations`） |
| `scripts/archive.mjs` | 647 | 入档管线：`runArchive`（只读上游 → episodes/joseki/claims → 派生 → manifest）、`--dry-run`/`--store`/`--json`/`--session`、`formatSummary` |
| `test/persist.test.mjs` | 466 | 15 条：结构/manifest/幂等/原子写/篡改/崩溃恢复/路径纪律/版本闸/原件缺失 |
| `test/archive.test.mjs` | 388 | 7 条：只读上游/入库结构/字节级幂等/dry-run/原件缺失/崩溃恢复/CLI 真子进程 |
| `reports/T6a-REPORT.md` | 本文件 | 契约 + 数字 + 风险 |

可复现实物（`tmp/`，**不进 git**）：

- `tmp/frozen-store/` —— 真实语料**冻结副本**跑两次的库（第二跑与第一跑 `diff -r` 逐字节相同）。
- `tmp/memory-context/` —— 直接指向**活语料**（`$DSH_HOME`）的库，用来测"语料在动时不假装幂等"。

## 1 · 验收

```
$ node --test test/persist.test.mjs test/archive.test.mjs
ℹ tests 22   ℹ pass 22   ℹ fail 0   ℹ skipped 0   duration_ms 1761.6

$ node --test                 # 全仓（含 T6b 的 thread/joseki/claim）
ℹ tests 149  ℹ pass 149  ℹ fail 0   ℹ skipped 0   duration_ms 2284.5

$ node scripts/check.mjs
ok  private:true / version=0.2.0 / changelog / 六大文档 / 房间齐 / branch=main
check: PASS
```

测试**只用** `os.tmpdir()` 下的临时目录；`$DSH_HOME/memory-context/` 至今不存在（`ls` 确认），全程只读 `$DSH_HOME`。

## 2 · R15 契约

### 2.1 目录布局（`root = <DSH_HOME>/memory-context/`，测试用临时目录）

```
manifest.json          # 自描述 + 整目录 checksums（135,004 B @ 真实语料）
index.md               # 派生索引（R07 渲染，UTC、无生成时间 ⇒ 可复算）
episodes/ topics/ links/ threads/ joseki/ claims/ adjudications/   # 一条目一个 JSON 文件
journal/archive.jsonl  # append-only 审计（不进 checksums）
```

权威 / 派生（方案 §4.11 规则 5）：

| 类 | 目录 | 谁能写 | rebuild |
|---|---|---|---|
| 权威 | `episodes/ joseki/ claims/ adjudications/` | 只有入档方（从原件） | **不重算**；发现漂移就**拒绝**（见 5.3） |
| 派生 | `topics/ links/ threads/ index.md` | 入档方 + `rebuild()` | 从权威重算，可丢、可补 |

### 2.2 入口与返回值

| 入口 | 输入 → 输出 |
|---|---|
| `createStore({root, user='owner', now?})` | store 对象（`root/user/version/dirs/**Path` + 下列方法） |
| `store.put(kind, record, {at})` | `{changed, id, path, sha256}`；内容相同 ⇒ `changed:false`（不写盘/不动 journal/不动 manifest） |
| `store.putMany(kind, records)` | `{kind, total, written, unchanged, results}`（按 id 排序，写入顺序稳定） |
| `store.replaceDerived(kind, records)` | 只对 `topics/links/threads`；写新的 + 删掉本类不再需要的文件；权威类抛 `persist/authoritative-kind` |
| `store.get / list / ids / counts` | 条目读写；`list` 对损坏文件不抛（带 `error` 字段），`ids` 只读文件名 |
| `store.writeManifest({at})` | `{changed, manifest}`；**无变更不重写**（`updatedAt` 不漂） |
| `store.verify()` | `{ok, errors[], warnings[], checked{files,bytes,dirs,journalRecords}, counts, manifest}` |
| `store.rebuild({derive?, at?})` | `{derived{topics,links,threads,index}, manifest, episodes, skipped[], elapsedMs}`；权威漂移 ⇒ `{refused:true, reason:'authoritative-drift', errors[]}` |
| `store.readJournal()` | `{records, parsed, missing, dropped{partialTail, badLines}}`；**坏尾不抛** |
| `deriveStore({episodes, derive?, at?})` | 派生重算（archive 与 rebuild 共用 ⇒ 两边产物逐字节相同） |

### 2.3 错误语义（不许静默降级）

| code | 触发 | 处置 |
|---|---|---|
| `persist/absolute-path` | 条目里 `logPath/graphPath/filePath/sourcePath` 是绝对路径 | 拒绝入馆（搬库后会断，宁可不写） |
| `persist/missing-id` / `persist/invalid-id` | 条目无 id / id 无法编码成文件名 | 拒绝入馆（无 id 不入馆） |
| `persist/corrupt-record` | 现有条目 JSON 坏了 | 拒绝覆盖（只增不改的底线） |
| `persist/authoritative-kind` | 对权威目录调 `replaceDerived` | 拒绝（权威只增不改） |
| `store/unsupported-version` | 已有 manifest 版本 ≠ 1 | 写入侧直接抛（不静默降级） |
| `manifest/unsupported-version` · `manifest/missing` · `manifest/invalid` | verify 侧 | 返回 `{ok:false}` + `hint`（"跑 rebuild"） |
| `checksum/mismatch` · `file/missing` · `file/unlisted` · `counts/mismatch` · `path/absolute` · `dir/missing` | verify 侧 | 同上；权威类错误会让 rebuild 拒绝 |
| `journal/partial-tail` · `journal/bad-lines` · `file/tmp` | verify 告警 | 只提示，不失败（journal 与 .tmp 不是权威） |

### 2.4 允许依赖

核心存储：**零依赖**（`node:fs` / `node:path` / `node:crypto`）。派生重算按需动态 `import` R04/R05/R07/R06，缺失时进 `skipped` 并保留旧文件（不假装成功）。

## 3 · 可搬迁内核（方案 §4.11 九条逐条落实）

| # | 规则 | 本实现的落点 |
|---|---|---|
| 1 | 整个库 = 一个目录 | `root` 即 `memory-context/`；无数据库/服务/注册表 |
| 2 | 库内路径相对化 | 条目文件名 = `encodeId(id)`；来源路径一律相对 `DSH_HOME`（`sessions/<scope>/<sid>/session.v4.jsonl.zstd`），另存 `sourceRoot:"DSH_HOME"`；`findPathViolations` 在写入与校验两侧都查绝对路径 |
| 3 | `manifest.json` 自描述 | `{version:1, schema, user, createdAt, updatedAt, pathPolicy:"relative", counts, files, bytes, checksums:{rel:sha256}}` |
| 4 | `verify` / `rebuild` | 见 2.2；verify 校版本/checksums/必需目录/计数/路径纪律；rebuild 从权威重算派生 |
| 5 | 权威 vs 派生 | 见 2.1；`rebuild` 只替换派生目录 |
| 6 | 原件缺失不失效 | `sourceStatus:"present"|"missing"`；`missing` 不改 `state`、不删条目、照常 verify 通过；`archive` 每次巡检旧条目的原件（搬走→missing，搬回→present） |
| 7 | epoch ms + 本地时区显示 | `startedAt/lastEventAt/occurredAt/recordedAt/_store.*` 全是 epoch ms；`index.md` 用 **UTC** 渲染（跨机器 checksums 不漂） |
| 8 | user 来自配置 | `createStore({user})` 默认 `"owner"`，不用机器名/哈希 |
| 9 | 无外部依赖 | 只用 `node:` 内置模块；不联网、不调外部服务 |

## 4 · 入档管线（`scripts/archive.mjs`）

- **只读上游**：`listSessionLogs` + `listGraphs`（复用 R14 的枚举）→ R01 逐帧解 → R00 棋谱 → R02 基线+delta 回放 → R03 信号 → R04 主题 → R08/R09（定式/claim）→ R04/R05/R07/R06 派生 → 写库。测试用 `hashTree` 证明入档前后 `sessions/` 与 `chess-context/` 的 sha256 完全不变。
- **子代理归并**：`delegationDepth>0` 且父局在语料里 ⇒ `state:"folded-into:ep-<父局>"`、`topics:[]`、不参与建网（AGENTS §4.1「只收 depth=0」、陷阱 10）；父局缺席时保留 `archived` 并告警（不丢数据）。
- **幂等**：条目内容比对忽略存储簿记 `_store` 与流程时间戳 `updatedAt`；`recordedAt/createdAt` 这类"首次出现"时钟取旧值；无变更 ⇒ 不写文件、不追加 journal、不重写 manifest。
- **dry-run**：完整跑读/算/派生，只做**只读**预估（连目录都不 `mkdir`），输出 `plan.<kind>.{added,changed,unchanged}` 与 `wouldWrite`。
- **来源巡检**：本轮没重新入档的旧条目，按本机现状刷新 `sourceStatus`（原件搬走/搬回是一次真实变更，不当作"新记忆"）。

## 5 · 真实数字（`[本] 2026-11-02 03:03–03:06`）

### 5.1 全库 dry-run（`--root $DSH_HOME --dry-run`，零写入）

```
会话日志：92 个 · 参与入档 92 局 · header 92 · 事件 74,177 条 · 坏尾 0 · 坏行 0
棋谱：19 个 · 读入 19 · 失败 0 · 节点 1,473 · 边 1,707 · delta 帧 229
棋子（episodes）：92 条 = 独立成谱 24 + 子代理归并 68 · 未入馆 0
派生：主题 779 · 相关边 202 · 线索 83 · mention 3,143 · index.md 3,289 B
权威：定式 0 · claim 125
预估写入 1,281 条（episodes 92 / claims 125 / topics 779 / links 202 / threads 83）
耗时 2,767 ms
```

> dry-run 后 `$DSH_HOME/memory-context/` 仍不存在 ⇒ 零写入已实证。

### 5.2 冻结真实语料连跑两次（`tmp/corpus-freeze` 副本 → `tmp/frozen-store`，**字节级幂等**）

| 指标 | 第 1 跑 | 第 2 跑 |
|---|---|---|
| 写入条目 | **1,281** | **0**（episodes 92/92 未变 · claims 125/125 · topics 780/780 · links 199/199 · threads 83/83） |
| manifest | `changed:true` · 1,280 文件 · 1,947,088 B | `changed:false`（`updatedAt` 不漂） |
| journal | 1,280 行 | 1,280 行（无追加） |
| verify | OK | OK |
| 耗时 | 13,032 ms | 3,442 ms |
| 全库比对 | — | `diff -r tmp/frozen-store.before tmp/frozen-store` ⇒ **无差异**（逐字节相同） |

### 5.3 库规模、耗时与 verify/rebuild（`tmp/frozen-store`）

```
库体积（磁盘）4.0 MiB；manifest 覆盖 1,280 个文件 / 1,947,088 B（1.86 MiB）
manifest.json   135,004 B      index.md        3,289 B      journal 316,063 B（1,280 行）
episodes        92 文件 / 1,412,939 B（最大 ep-1e82afca.json 120,513 B）
claims         125 文件 /   157,209 B
topics         780 文件 /   245,959 B
links          199 文件 /    88,587 B
threads         83 文件 /    39,105 B
joseki / adjudications  0 / 0（真实语料尚未产生定式候选）

verify  ：OK，1,280 文件 / 1.86 MiB，201 ms，告警 0
rebuild ：92 局 → 派生重算 **0 变更**（topics/links/threads 全 unchanged、index 未重写），914 ms，skipped 0
```

> "首跑 13 s / 复跑 3.4 s"的差 = 首跑 1,281 个文件各一次 `write + fsync + rename` + 1,280 行 journal 各一次 fsync；复跑无写。
> 同一份语料在**活目录**（会话仍在追加）上重跑不是 0 变更：实测第 3 跑 `9 条`（5 局因追加事件而 `lastEventAt/closure/signals` 变化 + 2 主题 + 3 边），这是"输入变了"，不是幂等失效。

### 5.4 篡改 / 崩溃 / 缺原件的实测（测试里固化）

- 改一个派生条目 ⇒ `verify` 报 `checksum/mismatch` ⇒ `rebuild` 重算 ⇒ `verify` 复绿。
- 改一个**权威**条目 ⇒ `verify` 报错，`rebuild` 返回 `refused:true / authoritative-drift`，且**不**把篡改后的 sha256 盖进 manifest、不静默回滚内容。
- 截断 journal 尾行 ⇒ `readJournal` 丢尾行 + `dropped.partialTail:1`，`verify` 只告警，`rebuild` 照跑。
- 删一局的会话日志 ⇒ 再入档后该局 `sourceStatus:"missing"`，`state:"archived"` 不变，`verify` 仍 OK；日志放回后自动回 `present`。

## 6 · 已知缺口与风险

1. **R08/R09/R06 的调用是"防御式适配"**：用 `asRecordList(res, ['threads'|'joseki'|'claims'])` 兼容"数组 / `{xxx:[…]}`"两种返回形状，参数按 `{episodes, signals, signalList, topics, now}` 传超集。T6b 若改签名，`archive` 只会把该房间记进 `skipped` 而**不崩**；合并后建议 Lead 再跑一次 `--dry-run` 对账（当前实测 claims 125 / threads 83 已通）。
2. **定式 0 条**：真实语料没产出 `joseki`（R08 的 ≥2 局同签名 success 序列 + 反例判据）。这不是 R15 的问题，但意味着 `joseki/` 目录当前为空、manifest 里 `counts.joseki:0`。
3. **首跑 13 s ≈ fsync 开销**：1,281 文件 × (write+fsync+rename) + 1,280 行 journal fsync。若要提速可做"journal 按批 fsync"（把 1,280 次降到 1 次），属后续优化，不在本刀里改（先保崩溃安全）。
4. **`mentions` 不单独落盘**：mention 证据跟着 `episodes/<id>.json` 的 `topics[].occurrences` 走（每 (局, 主题) 截 ≤6 条），`links/` 只存棋谱↔棋谱边。`rebuild` 从 episodes 重算 mention，实测与 archive 产物完全一致（5.2 的 `diff -r` 就是证据）；但**若以后要独立检索 mention，需要新目录 + 契约**。
5. **`sourceStatus` 只跟会话日志**：`closure.graphPath` 可能为 `null`（该局无棋谱），棋谱侧缺失不单独标记。
6. **R14 的 `verify`/`rebuild` 子命令未接**：`src/rooms/cli.mjs` 不在本任务写作用域。store API 已就绪（`createStore({root}).verify()` / `.rebuild()`），Lead 在 R14 加两个子命令即可，无需改 R15。
7. **`package.json` 的 `exports` 缺 `"./persist"`**；`scripts/check.mjs` 的房间清单是硬编码（不含 `persist.mjs`）。两处都由 Lead 在升版本那一刀里改（本任务按硬规则未动）。
8. **文件名编码**：`t:repo:deadbeef` 这类 id 用 `%XX` 编码成 `t%3Arepo%3Adeadbeef.json`（Windows 非法字符 `:` 不能进文件名）。人读不直观，但可逆、跨机稳定；`decodeId` 可还原。
9. **journal 不进 checksums**（设计如此）：它是 append-only 审计/恢复线索，不是权威数据；代价是"journal 被截断"只能靠告警发现，不能靠 checksum。
10. **活语料上重跑必有变更**：幂等的前提是输入冻结。JSON 的 `recordedAt` 是"入馆时刻"（第二时钟），跨两次"首次入档"必然不同 —— 这是契约要求，不是漂移。

## 7 · 复现命令

```bash
cd "/d/DeepSeek Harness/default-workspace/长期记忆系统"

# 验收
node --test test/persist.test.mjs test/archive.test.mjs      # 22/22
node --test                                                  # 149/149

# 全库只读预估（不写任何东西）
node scripts/archive.mjs --root "$DSH_HOME" --dry-run

# 真入档到临时库（不写 $DSH_HOME）
node scripts/archive.mjs --root "$DSH_HOME" --store tmp/memory-context

# 冻结副本双跑（字节级幂等）
mkdir -p tmp/corpus-freeze && cp -r "$DSH_HOME/sessions" "$DSH_HOME/chess-context" tmp/corpus-freeze/
node scripts/archive.mjs --root tmp/corpus-freeze --store tmp/frozen-store
cp -r tmp/frozen-store tmp/frozen-store.before
node scripts/archive.mjs --root tmp/corpus-freeze --store tmp/frozen-store   # added: 0
diff -r tmp/frozen-store.before tmp/frozen-store                              # 无差异
```

## 8 · 给 Lead 的合并清单（本任务**没**动的东西）

1. `package.json`：`exports` 加 `"./persist": "./src/rooms/persist.mjs"`（并升版本）。
2. `scripts/check.mjs`：房间清单加 `src/rooms/persist.mjs`（以及 T6b 的 thread/joseki/claim）。
3. `src/rooms/cli.mjs`（R14）：加 `verify` / `rebuild` 两个子命令 → `createStore({root}).verify()` / `.rebuild()`。
4. `CHANGELOG.md` / `MAINTENANCE.md` / `计划表.md`：按本报告数字更新（92 日志 / 24+68 局 / 780 主题 / 199 边 / 83 线索 / 125 claim；库 1.86 MiB / 1,280 文件）。
5. 建议 commit 拆分：`R15 persist: …` + `R15 archive: …`（结构 + 行为分开）。
