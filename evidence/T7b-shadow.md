# T7b 影子模式实测（R12 inject + R13 gates 起步）

> `[本] 2026-11-02 03:30` · 工作树（未提交）· 语料 = `tmp/memory-context`（T6a 从本机真实会话入档的库）
> 口径写清：**这里是影子模式**，卡片不注入任何模型上下文，只追加进 `tmp/shadow-sweep/shadow.jsonl`。

## 1 · 命令（可复现）

```bash
# 1) 端到端 CLI（单条信号，写影子记录到指定目录，不写 <DSH_HOME>）
node scripts/cli.mjs inject --shadow \
  --signal "yaml 装不上 Cannot find module yaml，工作区 D:/work/demo" \
  --root <root> --store <root>/memory-context --shadow-dir <tmp>/shadow --json

# 2) 批量影子跑（20 条信号：取主题库 df 最高的 20 个 key，逐条 walk → card → gates → shadow）
#    探针脚本是临时产物（tmp/，不进 git）；核心 4 行见下，任何人可照抄复现
node tmp/sweep-final.mjs tmp/memory-context tmp/shadow-sweep
```

`sweep-final.mjs` 的核心（与 R12/R11/R13 的公开导出一一对应，无私有入口）：

```js
const store = createStore({ root: 'tmp/memory-context' });
const signal = signalFromText(`${topic.key} 相关的问题`, { at: Date.now() });
const walk = walkFromSignals({ signal, store, depth: 2, limit: 5, budgetTokens: 500 });
const card = buildMemoryCard({ signal, walkResult: walk, store, scope: 'w:d:/probe', now: Date.now() });
const gates = runGates({ card, walkResult: walk });
writeShadow({ dir: 'tmp/shadow-sweep', card, signal, at: Date.now() });
```

## 2 · 语料

| 项 | 数量 |
|---|---|
| 棋谱（episodes） | 92 |
| 主题（topics） | 780 |
| 相关边（links） | 199 |
| 卷（threads） | 83 |
| claim | 125 |

## 3 · 20 条信号的实测

| 指标 | 值 | 口径 |
|---|---|---|
| 闸门通过 | **20 / 20** | `runGates({card, walkResult}).ok`（闸 0 / 6 / 6b / 边界全绿） |
| 零注入 | **1 / 20** | `card.section === null`（主题 `127.0.0.1`：walk 命中主题但生产不出 hit） |
| 有内容可给 | 19 / 20 | `card.claims.length > 0` |
| 触到 5 条上限 | 17 / 20 | 命中 hits=5 且 claims=5（未发生丢弃，`omittedCount=0`） |
| 渲染条数上限 | 5 | `ENTRY_LIMIT` |
| token：min / 中位 / p90 / max | **35 / 253 / 275 / 292** | 口径 = `estimateTokens(indexLine + section)`（CJK 1.5 字/token、ASCII 4 字/token） |
| token 预算 | 500 | 全程未触顶（最坏 292 = 上限的 58%） |
| 首轮那行的 token | 35（中位） | 只陈述 `MEMORY: <index 路径>（scope=…, N 局, 未列出≠不存在）` |
| 渲染行构成 | 42 条 claim 行 + 51 条指针行 | claim 行 = 逐字 claim 原文；指针行 = `fail=N · topics=…` |
| 降表示触发 | 0 / 20（全在 160 字级） | 阶梯 160 → 60 → 去 markers → 丢尾部条目 |
| shadow 记录 | 20 行，全部 `injected:false` | 追加写，JSONL |
| 端到端耗时 | 3.6 – 4.7 s / 20 条 ≈ **180–235 ms/条**（两次跑） | walk + card + gates + 一次追加写 |

## 4 · 预算阶梯实测（同一条信号，只改 `budgetTokens`）

| 预算 | 渲染条数 | 省略 | tokens | 现象 |
|---|---|---|---|---|
| 500 | 4 | 0 | 190 | 完整表示（160 字级） |
| 200 | 4 | 0 | 190 | 仍然完整表示 |
| 120 | 2 | 2 | 113 | 降到 60 字级 + 去掉 markers 说明行，**日期与 provenance 一字不丢** |
| 60 | 0 | 4 | 35 | 只留首轮那一行；省略计数如实写进 `omittedCount`（不许静默丢） |

## 5 · 结论与已知风险

1. **闸门在本机真实语料上没有假红**：20/20 通过，说明闸 0（日期 + provenance）、闸 6（预算/省略/覆盖率）、闸 6b（why/深度/零注入）、边界闸（8 个指令式片段 + 3 条工具治理痕迹）与真实数据兼容。
2. **预算不会失控**：最坏 292 tokens，是 500 上限的 58%；触发预算时先缩文本（160→60）、去说明行，再丢尾部条目，`omitted` 行始终带计数与 `index.md` 指针。
3. **风险 1（精度，不是本房间能解决的）**：`echo`/`grep`/`bash`/`git` 这类泛工具主题会命中 5 条棋谱，卡片里就有 3 条 claim + 2 条指针。是否"够相关"要靠 M4 闸 6b 的弱边策略与留出集会评测（F8 关联过泛）；本轮只保证**每条都有出处、都可回溯**。
4. **风险 2（claim 与 hit 的对齐）**：R12 只在两种情况下把 claim 原文写进卡：(a) walk 直接给了 `claim` id；(b) 该局 claims 里存在与该 hit **同一 seq** 的 support。**不随手抓一条该局别的 claim**（那正是"顺藤摸错枝"）。其余命中退化成指针行（51/93 行）。
5. **风险 3（指针行的语义粒度）**：指针行的 `occurredAt` 取棋谱 `startedAt`，`seq` 取 `closure.seqFrom`，二者是"这一局的起点"，不是某次具体失败的时点；要落到事件级必须由 R11 给出 claim/mention 级 hit。
