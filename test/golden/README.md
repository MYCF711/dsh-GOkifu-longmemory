# test/golden —— 三张对外面的**形状快照**（重构 D 期 / M3 契约先行）

这三个文件是**生成的**，不是手写的。它们把三张对外面的字段形状固化成可比对的文本：

| 文件 | 面 | 权威代码 | 读侧入口 / 错误码 |
|---|---|---|---|
| `memory-graph.json` | `graph.json`（memoryGraph） | `src/rooms/graphread.mjs` | `loadGraphAt` · 未知 `schemaVersion` ⇒ 抛 `graphread: unsupported schemaVersion <v>` |
| `inject-slot-ledger.json` | `inject-slots.json`（注入槽位账本） | `src/rooms/inject-slot.mjs` | `readSlotLedger` · 未知 `version` ⇒ 抛 `SlotLedgerError`（`code: 'slot/unsupported-version'`） |
| `manifest.json` | `manifest.json`（sidecar 清单） | `src/rooms/persist.mjs` | `ensureCompatible` ⇒ 抛 `store/unsupported-schema-version`；`verify` ⇒ `manifest/unsupported-schema-version` |

## 生成 / 校验

```bash
node scripts/dump-contracts.mjs            # 重新生成三个 golden（临时目录里跑真实模块，用完即删）
node scripts/dump-contracts.mjs --check    # 只比对：不一致 ⇒ 打印首个漂移行并退出 1
node --test test/contract-snapshot.test.mjs
```

`test/contract-snapshot.test.mjs` 每次跑都会**重新生成现形状再逐字节比对**，所以：

- 字段**增删 / 改名 / 改类型** ⇒ 测试红（这就是它的唯一目的）；
- 三个面各自的「未知版本 ⇒ 抛」与「老文件缺版本字段 ⇒ 按 legacy 接受」也在同一个测试文件里钉住。

## 契约变更的正确流程

1. 改代码（新字段 / 改类型）；
2. 跑 `node scripts/dump-contracts.mjs` 重生成 golden；
3. golden 的 diff 进评审 —— 它是这次契约变更的**证据**，不是噪声；
4. `CHANGELOG.md` 标「**破坏性**」，并按 semver 规则升位。

形状口径：每条一行 `<路径>: <类型>`，类型 ∈ `string | integer | number | boolean | null | array | object`；
动态键（节点 id / 边 id / 派生索引 / 槽键 / checksums 文件名）归一成 `*`，只固定"一个条目长什么样"；
版本类字面量（`version` / `schemaVersion` / `schema` / `user` / `pathPolicy`）进 `invariants`，其余只记类型。