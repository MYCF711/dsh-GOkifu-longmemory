# T303 · 归档幂等性审计（`recordedAt` 是否参与内容比较）

> `[本] 2026-11-06 13:05 +08:00` · 真库只读；所有写只发生在 `tmp/t303-copy` 副本。
> 产物：`scripts/idempotency-audit.mjs`、`tmp/t303-redo.cjs`

## 1 · 静态定位（代码级，先回答问题 1）

| 关注点 | 事实 | 位置（符号） |
|---|---|---|
| `readdirSync` 是否排序 | **已排序**：`return fs.readdirSync(dir).sort();` | `src/rooms/persist.mjs` 的 `listNames` |
| `recordedAt` 参与 sha256 吗 | **参与**：它是记录 JSON 的一部分，文件内容变 ⇒ checksum 变 | `persist.mjs` 的 `put`（`stableText(next)` → `sha256(text)`） |
| 但重放会不会漂移 | **不会**：`put` 在写入前把 `recordedAt`/`createdAt` 换成**旧值**；且 `sameExceptClocks(candidate, previous)` 为真时**直接短路**（不写盘、不追加 journal） | `persist.mjs` 的 `put` |
| 归档侧是否稳住时钟 | **稳住了**：`PRESERVED_CLOCKS = ['createdAt','recordedAt','generatedAt']`，`stabilizeExisting()` 重放时取旧值 | `scripts/archive.mjs` |
| `generatedAt` 是否进 checksum | **不进**：`renderIndex({ generatedAt: null })` —— 注释写明"不嵌时钟：同输入同输出" | `src/rooms/persist.mjs` 的 `deriveStore` |
| 其余时钟 | `updatedAt` 只在**真的变了**的时候写（`sameExceptClocks` 短路之后） | `persist.mjs` 的 `put` |

**结论（静态）**：`recordedAt` 参与 checksum，但流程有三重保护（重放取旧值 / 同内容短路 / 归档侧 `PRESERVED_CLOCKS`），设计上是幂等的。

## 2 · 实测（逐字节比 manifest sha256 全表）

脚本 `scripts/idempotency-audit.mjs` 做的事：
1. `fs.cpSync(真库 → tmp/t303-copy)`；
2. 在副本上跑 `archive.mjs --root <DSH_HOME> --store tmp/t303-copy` **两次**；
3. 每次跑完读 `manifest.json.checksums`（相对路径 → sha256），**逐键比较**；
4. 不同的文件再**逐字节**定位第一个差异偏移，并从上下文猜字段（`recordedAt`/`generatedAt`/…）。

**运行中**：两次全量归档（848 局）耗时较长，本轮先交付静态结论；实测结果以脚本输出为准 —— 若两次 `checksums` 全表一致 ⇒ `ok: true`，否则列出差异文件与字段。

## 3 · 一句话（静态结论，待实测确认）

**设计上是幂等的**：`recordedAt` 虽然进 checksum，但重放时被强制取旧值（`put` + `archive.stabilizeExisting`），`generatedAt` 压根不渲染（`generatedAt: null`），目录遍历 `readdirSync().sort()` 已排序 —— 三条都在源码里可核。实测结果见 §2 的运行输出。
