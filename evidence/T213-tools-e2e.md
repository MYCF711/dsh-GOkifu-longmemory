# T213 · 工具面端到端：6 个 `kifu_*` 工具**真的跑得动**

> `[本] 2026-11-05 11:35 +08:00` · 只读真库（`$DSH_HOME/memory-context`），未写任何 claim。
> 复现：`node --test "test/tools-plugin.e2e.test.mjs"`

## 0 · 先纠一处前提

任务书写"5 个 `kifu_*` 工具"，实际 `src/tools.mjs` 的 `buildMemoryTools()` 返回 **6 个**：

| # | 工具 | 作用 |
|---|---|---|
| 1 | `kifu_stats` | 记忆库概览（条数 + 最新时间） |
| 2 | `kifu_search` | 按文本找相关记忆（轻量命中列表） |
| 3 | `kifu_card` | 生成与线上注入同一份记忆卡（跑十道闸） |
| 4 | `kifu_recent_failures` | 最近的失败原文（带 ep+seq 出处） |
| 5 | `kifu_view` | 以某节点为中心的邻域视图 |
| 6 | `kifu_get` | 按 id 取一条记录 |

测试按**真实导出一一对应**断言（数量取 `buildMemoryTools().length`，不写死），所以这个偏差不会再回来。

## 1 · 真实返回片段（各截断到 200 字符）

```
### kifu_stats (213B)
{"ok":true,"n":11934,"counts":{"episodes":602,"topics":3004,"claims":1379,"links":6402,"threads":523,"joseki":24,"adjudications":0},"status":"measured","latest":{"episodeAt":1793817627875,"claimAt":17

### kifu_search (324B)
{"ok":true,"n":1,"hits":[{"episode":"ep-8cc34e32","seq":21961,"kind":"failure","weight":0.5,"why":["stale"]}],"scope":"w:d:/DeepSeek Harness/default-workspace/长期记忆系统","clamped":{"limit":false,"depth":false,"budgetTokens":false},"omitted":{"count":0,"reason":nu

### kifu_card (886B)
{"ok":true,"section":"<memory-ledger>\n# markers: [semantic]=≥3 局且无反例 · [candidate]=2 局 · [observed]=1 局 · [disputed]=存在反例 · [stale]=条件已变只给指针 · [antipattern]=失败教训 · 日期=occurredAt(UTC)\n- [antipattern] Error: stale goal ref \"goal-b46a56ac-0922-4dc3-9875-562170

### kifu_recent_failures (896B)
{"ok":true,"n":3,"total":1807,"clamped":false,"scope":null,"status":"measured","items":[{"claimId":"c-8455290a","episode":"ep-bde12afa","seq":4133,"occurredAt":1793817366883,"scopeKey":"w:d:/DeepSeek 

### kifu_view (238924B)
{"ok":true,"center":{"kind":"episode","id":"ep-00b50089"},"nodes":[{"kind":"episode","id":"ep-00b50089","label":"棋谱 ep-00b50089 · 2026-11-03 · fail=46","occurredAt":1793685893725,"weight":1},{"kind":"

### kifu_get (851B)
{"ok":true,"kind":"claims","id":"c-00248579","record":{"_store":{"createdAt":1793793455940,"updatedAt":1793844147271},"counter":[],"counters":{"counter":0,"injections":0,"lastInjectedAt":null,"support
```

（`kifu_search` / `kifu_card` 必须**带 scope** 才有命中：不带 scope 时它们返回 `status:"empty"` 且 `omitted.crossScope:2` —— 这是 A5 同语义的作用域闸，不是 bug。）

## 2 · 注册契约（读 `src/tools-plugin.mjs`，不猜）

- 插件导出 `inject = ['tools']`（服务缺失时**只有它不加载**，记忆注入不受影响）
- `apply(ctx)` → `registerMemoryTools(ctx, {createSdk, warn})` → `ctx.tools.register(tool)`
- `tool = { name, description, parameters, output, execute(args) → Promise<object>, isConcurrencySafe }`
- `execute` **不抛**：SDK 的 `SdkError` 翻成 `{ ok:false, error:{ code, message } }`
- 注册完成后写凭据 `<storeRoot>/tools-registered.json`（`via: 'tools-plugin' | 'tools-plugin-none'`）

## 3 · 测试覆盖

| 用例 | 断言 |
|---|---|
| 插件契约 | `inject === ['tools']`；`apply` 注册数与 `buildMemoryTools()` **一一对应**；每个工具 `kifu_` 前缀 + 非空 description + `parameters.type === 'object'` + `properties` 存在 + 可 JSON 序列化；凭据写到 **tmp**（`count/via/ctxHasRegister`） |
| 真库只读 | 6 个工具各真调一次（用真 `episodeId` / `claimId` / `scope`），断言非空、`ok !== false`、无 `error` |
| 优雅失败 | 把 `dshHome` 指到不存在的目录：**不抛未捕获异常**，返回对象（结构化错误或 `status:'missing'` 的空结果） |
| 无工具服务 | `registerMemoryTools({})` 返回 `[]` 且不抛；单个 `register` 抛错也不影响其它 |

## 4 · 重启后应该看到什么

T195 的一键脚本把 `kifu-tools` 加进 profile patch、主人重启后：

```json
{ "at": <ts>, "names": ["kifu_stats","kifu_search","kifu_card","kifu_recent_failures","kifu_view","kifu_get"], "count": 6, "host": "dsh", "via": "tools-plugin", "ctxHasRegister": true }
```

- `via: "tools-plugin"` ⇒ 宿主把 `ctx.tools` 交给了插件；
- `via: "tools-plugin-none"` ⇒ 宿主**没给**服务（看 `ctxHasRegister: false`）；
- 当前真库仍是 `{"count":0,"via":"none","ctxHasRegister":false}` —— 因为 patch 还没生效（等重启）。

## 5 · 一句话结论

**6 个工具全部"能用"**：真库上逐个真调用返回结构正确的非空结果，缺库时优雅降级，注册契约与 `buildMemoryTools()` 完全一致；**没有发现坏的工具，因此没有改 `src/**` 任何一行**。唯一偏差是"5 个"这个前提（实际 6 个），已在测试里用"取真实导出数量"钉死。

## 6 · 可重放补丁

```bash
node tmp/t213-redo.cjs          # 幂等；anchor 不匹配抛错
node tmp/t213-redo.cjs --check  # 只报告
```
