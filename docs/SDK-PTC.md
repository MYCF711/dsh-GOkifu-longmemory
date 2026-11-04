# 棋院 SDK（PTC 运行时调用面）

> **一句话**：把记忆的读操作做成**可在 PTC / `run_code` 代码块里被反复调用**的 SDK —— 一个代码块里循环、过滤、聚合几十次，而不是一次工具调用只做一件事。
>
> 本文件是**契约**。改导出面 = 改契约 = 必须同时改本文与 `test/sdk.test.mjs`（删掉 `src/sdk.mjs`，那个文件必须整片红）。

---

## 1 · 为什么要有这一层

现状的调用面有两个：**会话钩子**（`agent/pre-step` 自动注入，模型看不见调用方式）与 **CLI**（`scripts/cli.mjs dump|stats|walk|…`，一次一个进程）。
两者都不适合"在一个代码块里把记忆当数据结构用"——那需要**可导入、可循环、返回结构体、毫秒级**的东西。

SDK 就是这第三种面：**进程内、只读、零模型、JSON 安全、结果有界**。

## 2 · 边界（不许越）

- **只读**。SDK **没有**写入/入馆接口：入馆只走会话钩子（「无棋谱不入馆」）。想加写接口 = 改边界成文法，先写 `docs/拷问记录.md`。
- **零模型、零网络**。任何在 SDK 里调模型的实现都作废。
- **有界**。`limit` 上限 50、`budgetTokens` 上限 2000；超限**夹紧**并在结果里如实标 `clamped: true`，不静默改语义。
- **不假装有数据**。每个读接口都带 `status`：`measured`（真有内容）/ `empty`（库在、但没这条）/ `missing`（**库根本不存在**，例如新机器还没入过馆）。
  `missing` **不抛异常**——PTC 代码块不该因为"还没记忆"就崩；但"库在却读不动"（权限/损坏）仍然抛 `store-unreadable`，不吞。
- **不泄漏内部对象**。返回值必须 `JSON.stringify` 可还原：无 `Map`/`Set`/类实例/函数/`undefined`。

## 3 · 导出面

```js
import { createMemorySdk, SdkError, SDK_VERSION } from '<repo>/src/sdk.mjs';

const sdk = createMemorySdk({ dshHome, scope, now });   // 全同步构造，无 I/O 副作用
```

`createMemorySdk({ dshHome?, scope?, now? })`：

| 参数 | 默认 | 说明 |
|---|---|---|
| `dshHome` | `process.env.DSH_HOME` → 常见默认路径 | 记忆库根 = `<dshHome>/memory-context` |
| `scope` | `null`（不限域） | 工作区作用域键（`w:…`），传了就只返回该域可见内容（A5 同语义） |
| `now` | `Date.now` | 只用于渲染日期/新鲜度，不写盘 |

返回对象（全部只读、全部 JSON 安全）：

| 方法 | 入参 | 返回 | 语义 |
|---|---|---|---|
| `describe()` | — | `{version, storePath, scope, kinds, limits}` | 自描述（代码块可先读它再决定怎么查） |
| `stats()` | — | `{ok, counts:{episodes,claims,topics,links,threads,joseki,adjudications}, latest:{episodeAt, claimAt}, n}` | 库有多大、多新 |
| `get(kind, id)` | `kind` ∈ `describe().kinds` | `{ok, record}` / `{ok:false, reason:'not-found'}` | 按 id 取一条 |
| `search(text, opts)` | `{limit?, scope?}` | `{ok, n, hits:[{episode, seq, kind, weight, why}], status}` | 文本→信号→walk 的**轻量**命中列表 |
| `walk(text, opts)` | `{limit?, depth?, budgetTokens?, scope?}` | `{ok, n, hits, omitted:{count, byLimit, byBudget, crossScope}, status}` | 完整的顺藤摸瓜（带 `why` 证据路径） |
| `card(text, opts)` | `{limit?, budgetTokens?, scope?, gates?}` | `{ok, section, claims:[{claimId, marker, text}], tokens, omitted, gates:{ok, errors}, status}` | **与线上注入同一份**卡片（默认跑十道闸） |
| `recentFailures(opts)` | `{limit?, scope?}` | `{ok, n, total, items:[{episode, seq, quote, occurredAt, scopeKey}], status}` | 最近的失败原文（不经模型、按 `occurredAt` 倒序） |

**错误语义**（抛 `SdkError`，`error.code` 可判）：

| code | 触发 |
|---|---|
| `bad-argument` | `text` 不是非空字符串 / `limit` 非正 / `kind` 非法 |
| `unsupported-kind` | `get` 的 kind 不在 `kinds` 里 |
| `store-unreadable` | 库存在但读不动（权限/损坏）——**不吞**，带上底层 message |

> 「库不存在」**不是**错误：见 §2 的 `status: 'missing'`。早期草案把它当 `store-missing` 抛，已在实现时改掉
> （理由：一个 PTC 代码块要能在"还没记忆"的机器上照常跑完，而不是被 try/catch 包起来）。

## 4 · PTC / `run_code` 用法（这是本页存在的理由）

```js
// 一个代码块里做完：找出最近 20 次失败，按作用域分组，挑出与本仓相关的几条原文
import { createMemorySdk } from '<repo>/src/sdk.mjs';
const sdk = createMemorySdk({ scope: 'w:d:/DeepSeek Harness/default-workspace/长期记忆系统' });
const { items } = sdk.recentFailures({ limit: 20 });
const byScope = {};
for (const it of items) (byScope[it.scopeKey] ??= []).push(it);
for (const [scope, list] of Object.entries(byScope)) {
  console.log(scope, list.length, list[0]?.quote?.slice(0, 80));
}
```

要点：

- **循环在代码里，不在工具调用里** —— 20 次查询只是一次 `run_code`，没有 20 次往返。
- **结果自带边界**：`n` / `omitted` 告诉你"是不是还有"，需要更多就**传更大的 limit**，而不是猜。
- **卡片与线上一致**：`card()` 跑的是同一份 `buildMemoryCard` + 十道闸，所以在代码块里看到的就等于模型会看到的。

## 5 · 反例（明确不做）

- 不做写入/晋升/裁决接口（那是 L2/L4 与钩子的事）。
- 不做向量检索/模糊匹配的"更聪明"接口（边界成文法：不做 RAG）。
- 不做"帮我总结这些记忆"（那是模型的事，且会引入未溯源文本）。