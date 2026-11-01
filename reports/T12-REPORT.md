# T12 报告 —— 闸 3 真核验（validity probes）+ H1 机械代理

> 任务板 `task-12` · 负责人 card-smith · `[本] 2026-11-02 04:4x`（工作树未提交）
> 契约：`方案.md` §5.3（validity 三类）、`docs/数据契约.md` §4.8、`docs/对标-Hindsight.md` §2（H1 负迁移）、`AGENTS.md` §2.4「指标先有消费者」
> 只读纪律：**不写 `<DSH_HOME>`、不写 store、不加依赖、不 git checkout/commit**；唯一写盘是显式 `--evidence`。

## 0 · 一句话

**闸 3 不再"永远 unverified"**：`probeValidity` 能真核 `file / version / commit`，单条失败只记 reason 不抛；`runGates({validityResults})` 用真结果，核不过就必须 stale + 只给指针。H1 机械代理 `staleTransferRate` 跑通了，**本机真值 = 0.00%（0 / 9）**，但**覆盖率 = 0/8** —— 这个 0 现在不代表"没风险"，只代表"还没锻炼到"，报告里写清了原因与补救。

## 1 · 交付物

| 文件 | 性质 | 说明 |
|---|---|---|
| `scripts/gates-check.mjs` | 新增（约 210 行） | 只读核验 CLI：`runGatesCheck` / `loadValidityRecords` / `formatReport` / `runCli`；`--store --workspace --now --json`；退出码 0=跑完、2=库不存在 |
| `src/rooms/gates.mjs` | 增补（闸 3 面） | `VALIDITY_TYPES` / `validityKeyOf` / `resolveValidityPath` / `workspaceOf` / `parsePackageAtVersion` / `REAL_PROBE` / `probeValidity` / `runValidityCheck`；`runGates` 新增 `validityResults` 参数 |
| `scripts/eval.mjs` | 增补（H1） | `runH1` / `formatH1Report` / `renderH1Markdown` + `--h1 --workspace --signals --no-write` |
| `src/plugin.mjs` | 接线 | 闸 3 真核验接进注入路径（只核本卡条目，`probeValidity:false` 可关） |
| `test/gates-check.test.mjs` | 新增（20 条） | 见 §4 |
| `test/gates.test.mjs` | 增补（+3 条） | `validityResults` 正负例 + 真探针端到端 |
| `test/eval.test.mjs` | 增补（+5 条） | H1 口径、null 语义、markdown、CLI |
| `test/plugin.test.mjs` | 增补（+1 条） | validity 核不过 ⇒ 闸不过 ⇒ 不注入 |
| `evidence/M5-h1.md` | 生成 | H1 真值（口径/样本/时点/复现命令/逐信号明细） |
| `reports/T12-REPORT.md` | 新增 | 本文件 |

## 2 · 闸 3 真核验（怎么核）

### 2.1 三类 validity 的判据

| type | 判据 | 失败 reason |
|---|---|---|
| `file` | 路径存在（绝对路径直接用；Git Bash 的 `/d/a/b` 会还原成 `d:/a/b`；相对路径按**记录自己的** scopeKey 解析）+ 可选 `validity.sha256` 逐字节比对 + 可选 `validity.mtimeMs`（容差 2ms） | `file-missing` / `file-hash-changed` / `file-mtime-changed` / `file-needs-workspace` |
| `version` | `package.json.version` 等于期望值。支持两种存法：裸版本 `1.16.0`（核 workspace 的 package.json 或 `validity.file`）；带包名 `pkg@1.16.0`（先找 `<ws>/node_modules/<pkg>/package.json`，再回落 workspace 的，且**包名必须对得上**） | `version-mismatch` / `version-file-unreadable` / `version-package-not-found` |
| `commit` | `git cat-file -e <sha>^{commit}`（在记录的 workspace 内跑，5s 超时，只读命令） | `commit-not-found` / `commit-bad-sha` / `commit-needs-workspace` |
| `none` | 不核（跳过计数） | — |

### 2.2 三条纪律

1. **每条按自己的 `scopeKey` 解析工作区**（`workspaceOf`）——不拿 A 工作区的基准去核 B 工作区的记忆；`--workspace` 只是没有 scopeKey 时的兜底。
2. **单条失败只记 reason，绝不抛**：坏路径（含 NUL）、读不了的 package.json、git 不在、sha 不是 sha —— 都落成 `{ok:false, reason}`。
3. **`runGates` 仍然不读盘**：核验结果由调用方传进 `validityResults`；没传就照旧记 `gate3/validity-unchecked`（**不假绿**）。

### 2.3 `validityResults` 的键

```js
{ "claims:c-0a7e7ac0": { ok:false, reason:"version-package-not-found", checkedAt:… },
  "joseki:j-0001":     { ok:true,  reason:null } }
```
`runGates` 三种都认：`claims:<id>`（标准）、`<id>`（扁平，兼容手搓）、`validityChecks[id]`（M4 旧参数）。

### 2.4 本机真值（`node scripts/gates-check.mjs --store tmp/memory-context`）

| 指标 | 值 |
|---|---|
| 带 validity 的记录 | **8**（version 5 · file 3）· 跳过 `none` 117 |
| 通过 / 不过 | **0 / 8** |
| 失败原因分布 | `version-package-not-found` 3 · `version-file-unreadable` 2 · `file-missing` 3 |

**这 8 条全过不了**，不是因为探针坏了，而是它们指向的机器状态已经变了：
- `version: "dsh-gokifu-compact@1.16.0"` —— 该工作区的 node_modules 里没有这个包；
- `file: "/d/主工作区/projects/dsh-github-bridge/package.json"` —— 路径已不存在（Git Bash 写法被正确还原成 `d:\主工作区\…` 之后仍是 missing）。

这正是闸 3 应该说的：**这 8 条记忆在当前机器上已经过期**。

## 3 · H1 机械代理（staleTransferRate）

### 3.1 口径（写死，跨时点不可比）

| 项 | 定义 |
|---|---|
| 注入条目 | 一组信号跑 `walk → buildMemoryCard`，卡片里**带 `claimId`** 的渲染行；**按 claimId 去重**（同一断言被多条信号命中只算一次） |
| stale | 这些条目里 `validity` 核验 `ok:false` 的条数 |
| **staleTransferRate** | **stale ÷ 注入条目**；分母 0 ⇒ `null`（不把"没样本"写成 0） |
| 闸门后 | 只算 `gates.ok` 的卡片 ⇒ `postGateStaleRate`（闸 3 兜住时应为 0） |
| 信号集 | 话题集（主题库 df 降序前 20）+ **针对性集**（每条带 validity 的记录用自己的文本当信号，避免"过期条目永远问不到"） |

### 3.2 本机真值

```
$ node scripts/eval.mjs --h1 --store tmp/memory-context --workspace . --evidence evidence/M5-h1.md

信号：28 条（话题 20 + 针对性 8）· 有内容卡片 9 · 零注入 19 · 闸不过 0
validity 面：带 validity 8 条（通过 0 · 不过 8）
注入条目：9 · 其中 stale：0
staleTransferRate = 0.00%（0 / 9）
闸门后：注入 9 · stale 0 · postGateStaleRate = 0.00%
覆盖率：带 validity 的条目 8 条，被本次信号集渲染过 0 条
```

### 3.3 **怎么读这个 0%（重要，别自欺）**

- 9 条注入条目里没有一条带 validity ⇒ **分子结构上必然是 0**。
- **覆盖率 0/8**：那 8 条过期记忆一条都没被渲染过（它们属于**另一个工作区** `w:e:/…`，而本机 28 条信号走的是当前工作区；换了 `--workspace e:/…` 重跑，13 张卡有内容、35 行注入，stale 仍是 0 —— 因为 R11 顺藤摸瓜根本走不到那 8 条 claim）。
- 按 `AGENTS.md` §2.4「指标先有消费者」：**这个指标现在还没有消费者**。它算得对，但还没被真实语料锻炼到。两条补救路：
  1. **R11 让 claim 可被信号直接命中**（现在 claim 只能经由 support 的 episode / topic 到达，文本相似不构成路径）；
  2. **给当前工作区的 claim 补 validity**（本机 D: 工作区的 11 条 claim 全是 `type:"none"`），或用桩语料在测试里覆盖（已有单测：核不过 ⇒ 100%，核过 ⇒ 0%）。

## 4 · 测试

```
$ node --test test/gates-check.test.mjs test/gates.test.mjs test/eval.test.mjs
ℹ tests 82   ℹ pass 82   ℹ fail 0        （gates-check 20 + gates 47 + eval 15）

$ node --test            # 全仓
ℹ tests 327  ℹ pass 327  ℹ fail 0        （298 基线 + T12 29）

$ node scripts/check.mjs → check: PASS
```

新增覆盖面：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/gates-check.test.mjs` | 20 | file 存在/缺失/hash/mtime、version 匹配/不匹配/`pkg@ver`/包不存在、commit 真仓库 HEAD/假 sha/坏 sha/缺 workspace、坏路径含 NUL 不抛、unknown 类型不静默通过、`none` 跳过、summary 计数、结果键 `claims:<id>`、**每条按自己 scope 解析**、`runGatesCheck` 缺库不抛、CLI `--json` 结构、`parseArgs` |
| `test/gates.test.mjs` | +3 | `validityResults` 三键形态；核不过 ⇒ `gate3/stale-not-marked`；降级 stale 指针 ⇒ 过；stale 仍渲染正文 ⇒ `gate3/stale-rendered`；**真探针端到端**（hash 变化 ⇒ 核不过 ⇒ 必须 stale） |
| `test/eval.test.mjs` | +5 | 核不过 ⇒ 1.0（1/1）；核过 ⇒ 0.0；**无注入 ⇒ null**；markdown 含口径/样本/时点/复现命令；CLI `--h1 --json` + `--evidence` 写 tmp + `--no-write` |
| `test/plugin.test.mjs` | +1 | 注入路径接上真核验：核不过 ⇒ 闸不过 ⇒ 不注入；`probeValidity:false` ⇒ 退回 unverified 且照常注入 |

## 5 · 风险与交接

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| 1 | **H1 覆盖率 0/8** | `0%` 会被误读成"没风险" | 先补 R11 的 claim 直达路径，或给当前工作区 claim 补 validity，再拿这个数当门 |
| 2 | **真语料的 8 条 validity 全部过期** | 一旦它们进入注入路径，闸 3 会把整张卡打回（表现为"沉默"） | 这正是闸 3 的作用；但要有人把它们标 `stale`（R09 的降级路径），否则卡会一直沉默 |
| 3 | `version` 的 `pkg@x.y.z` 语义是我按真实数据**自裁**的（契约 §4.8 只写了 `{type, value}`） | 若 R09 未来换成 `{package, version}` 结构，解析要跟着改 | 建议把 `pkg@ver` 写进 `docs/数据契约.md` §4.8 的注释（下一刀） |
| 4 | `commit` 在无 git 的机器上恒 `commit-not-found` | 会把"环境没有 git"误判成"记忆过期" | 已在 reason 上区分不了；建议后续加 `git-unavailable`（用 `git --version` 探测一次并缓存） |
| 5 | plugin 每步只核本卡条目（≤ limit 条） | 成本可控（3 次 fs + 最多 1 次 git），但仍是每步 IO | `probeValidity:false` 可关；真机观察后再决定是否加缓存（按 claimId + mtime） |
| 6 | H1 跑一次 ~17s（28 信号 × walk+gates） | 不适合放进每次 CI 的热路径 | 放在 `evidence/` 手动/日报跑；要进 CI 得先给 walk 加缓存 |
