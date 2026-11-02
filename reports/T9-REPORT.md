# T9 报告 —— 宿主插件入口（`agent/pre-step`，默认关）

> 任务板 `task-10` · 负责人 card-smith · `[本] 2026-11-02 04:2x`（工作树未提交）
> **本轮只做代码与单测：不安装、不重启、不改 `profiles/*/cordis.patch.yml`。**
> 契约：`方案.md` §7、`docs/记忆的职责边界.md` §2/§5、`AGENTS.md` §2.2/§2.3、上游压缩仓 `src/engine.mjs` 的 `agent/pre-step` 段（只读核实）

## 0 · 一句话

**做到了**：`src/plugin.mjs` 把 R11→R12→R13 串成宿主一步注入，**默认关**（`enabled:false`）、默认走影子（`shadow:true`）、**每会话只注入一次**、**任何异常都原样返回下游 decision**；真语料预演里 20 条信号只注入 1 条（297 tokens），其余 19 条安静沉默、0 条 warn —— 也就是"该沉默时真的沉默"。

## 1 · 交付物

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/plugin.mjs` | 新增（约 430 行） | `name` / `apply(ctx, config)` + 纯函数 `sanitizeConfig` / `messageText` / `lastUserText` / `digestOf` / `insertAfterClaimed` / `cardText` |
| `test/plugin.test.mjs` | 新增（20 条） | 任务书 6 场景 + 边界（默认关、非 enter、不写会话事件、插入位置、无宿主包、纯函数） |
| `reports/T9-REPORT.md` | 新增 | 本文件 |
| `package.json` | 追加 1 行（**在写作用域外，但安装必需**） | `exports["./plugin"] = "./src/plugin.mjs"`（宿主按包名 + 子路径解析入口） |

**没有**：没装插件、没重启、没碰 `profiles/`、没写 `<DSH_HOME>`、没加依赖（只用 `node:crypto`/`node:fs`/`node:path`/`node:url` 与本仓既有房间）。

## 2 · 宿主接缝（从上游只读核实）

上游压缩仓 `src/engine.mjs` 的写法（`grep "agent/pre-step"`，行号会漂，引用时先 `git status`）：

```js
ctx.on("agent/pre-step", async (payload, next) => {
  const decision = await next();                       // waterfall：先取下游默认
  if (decision.kind !== "enter") return decision;      // 非 enter 一个字都不动
  try {
    … 造 message；return result.decision;               // 只有返回新 decision 才算替换
  } catch (error) {
    ctx.logger?.warn?.(…);                             // 双保险：绝不阻塞对话
    return decision;
  }
});
```

注入位置（上游 `src/rooms/hot-inject.mjs` 的原句，逐字对齐）：

```js
const lastClaimed = decision.messages.findLastIndex((m) => payloadMessages.includes(m));
const entered = decision.messages.toSpliced(Math.max(lastClaimed, 0) + 1, 0, message);
```

**两个替换互不代管**：`claimed` 用 `payload.messages` 的**引用**判定，所以压缩插件插进来的那条不会被当成 claimed；两边都插在"最后一条真实输入消息"之后，彼此相邻而不覆盖。

消息形状（`@deepseek-ai/dsh-llm` 的 `createUserMessage`）：

```js
createUserMessage({
  content: [{ type: "text", text }],
  source: { kind: "dsh-gokifu-longmemory", form: "memory-card", digest, pluginVersion: 1 },
})
```

**动态 import**：`await import("@deepseek-ai/dsh-llm")`；解析不到（比如测试环境）⇒ 记录 warn、本轮不注入、返回原 decision。`config.createUserMessage` / `config.deps.createUserMessage` 可注入替身。

## 3 · 行为（逐条对应任务书）

| 要求 | 实现 | 测试 |
|---|---|---|
| `enabled` 才真注入 | `enabled && !shadow` 才可能改 decision | 「默认配置什么都不做」「enabled:true 注入」 |
| `shadow` 只写记录、返回原 decision | `writeShadow` → `{dir}/shadow.jsonl`（`injected:false`），decision 引用不变 | 「shadow:true ⇒ 不注入、写 shadow、原 decision」 |
| 闸不过不注入 | `gates.ok === false` ⇒ warn + 原 decision | 「gates.ok === false ⇒ 不注入」 |
| 每会话一次 | `WeakSet<session>`，注入成功/影子写成才标记 | 「同一会话第二次不再注入」「oncePerSession:false 可关」 |
| 非 `enter` 不动 | `decision.kind !== "enter"` 直接返回 | 「kind !== enter」 |
| 零命中不注入 | `card.section === null` ⇒ skip（无消息） | 「没有命中 ⇒ 原 decision」 |
| 任何异常不阻塞 | 外层 `try/catch` → `ctx.logger?.warn` + 原 decision | 「buildMemoryCard 抛错 ⇒ 原 decision + warn」 |
| 不写 session 事件、不 append 日志 | 代码里**没有任何** `session.*` 调用；测试用会抛错的 `session.append` 反证 | 「session.append 一次都没被调用」 |
| 不写 `<DSH_HOME>` | 唯一的写盘面是 shadow，且默认目录在仓库 `evidence/shadow/`，`$DSH_HOME` 内会被 `assertSafeShadowDir` 硬拒 | 「shadow 写不进去 ⇒ 不注入、不抛、warn」 |
| 只陈述事实 | 文案由 R12 生成、R13 边界闸把关（祈使句一律打回） | R13 的 44 条测试 + 本文件注入文本断言 |

### 配置

```js
{
  enabled: false,          // 总开关；默认关
  shadow: true,            // 影子模式：只落 evidence/shadow/，永不改 decision
  storeRoot: null,         // 默认 <DSH_HOME>/memory-context
  shadowDir: null,         // 默认 <repo>/evidence/shadow
  budgetTokens: 500,
  limit: 5,
  oncePerSession: true,
  now: null,               // 固定时钟（测试/回放）
  createUserMessage: null, // 消息构造替身（测试）
  deps: null,              // 依赖替身（测试：createStore/walk/buildMemoryCard/runGates/writeShadow）
}
```

`sanitizeConfig` 只认已知键、类型不对退回默认（`'true'` 这类字符串会被正名，垃圾值不会进运行时）。

## 4 · 测试

```
$ node --test test/plugin.test.mjs
ℹ tests 20   ℹ pass 20   ℹ fail 0

$ node --test           # 全仓
ℹ tests 288  ℹ pass 288  ℹ fail 0     （268 基线 + T9 20）

$ node scripts/check.mjs → check: PASS
```

> 注：跑全仓时若工作树里还有**别人的 WIP**（本轮实测有未跟踪的 `test/eval.test.mjs`，10 条里 1 红），那不是 T9 的账；T9 相关面 = 288/288 全绿（268 基线 + 20）。

20 条覆盖：任务书 6 场景（无库/有卡/二次/抛错/闸不过/影子）+ 默认关 + `oncePerSession:false` + 非 enter + 无信号 + 插入位置 + 不写会话事件 + 宿主包缺失 + 6 组纯函数（`messageText`/`lastUserText`/`digestOf`/`insertAfterClaimed`/`cardText`/`sanitizeConfig`）+ 常量。

## 5 · 安装前预演（真实语料，不安装）

`node tmp/plugin-sweep.mjs`：假 session（`cwd` = 本仓工作区）+ 真 `tmp/memory-context`，配置 `enabled:true, shadow:false`，20 条信号：

| 指标 | 值 |
|---|---|
| 注入 | **1 / 20**（`github.com`） |
| 沉默 | 19 / 20（`gates` 通过但 `card.section === null` ⇒ 零注入） |
| warn | **0** |
| 注入体量 | 1,108 字符 / **297 tokens**（预算 500） |
| 插入位置 | `index 1`（唯一一条 claimed 消息之后），`total 2` |
| `source` | `{kind:"dsh-gokifu-longmemory", form:"memory-card", digest:"e3a300d1e0f9509b", pluginVersion:1}` |

注入正文（节选，就是模型会读到的东西）：

```
MEMORY: …/memory-context/index.md（scope=w:d:/…长期记忆系统, 92 局, 未列出≠不存在）
<memory-ledger>
# markers: [semantic]=≥3 局且无反例 · …
- [antipattern] Error: only an in-progress task can complete (<ep>, 2026-11-01, seq 2146)
- [observed] fail=5 · topics=github.com (<ep>, 2026-11-01, seq 0)
</memory-ledger>
```

**怎么读这个 1/20**：本机语料是 T6a 从**另一个工作区**（`w:<WORKSPACE>/…`）入档的；当前工作区只有 11 条 claim / 11 张棋谱，而主题匹配又偏向泛词 —— 所以安装后**典型信号会是沉默**。这不是坏，正是 F8「不相关时不打扰」；但必须让观察者知道"沉默 ≠ 坏了"，判断依据是 `evidence/shadow/shadow.jsonl` 有没有记录、以及 `node scripts/cli.mjs inject --signal …` 的输出。

## 6 · 安装前置条件（给下一步的人）

1. **代码面**：`node scripts/check.mjs` PASS、`node --test` 288 全绿（本轮已满足）。
2. **记忆库**：`<DSH_HOME>/memory-context` 必须存在（先 `node scripts/archive.mjs --store <dir>`）；不存在时插件只 warn 不抛。
3. **宿主包**：`@deepseek-ai/dsh-llm` 必须可解析（宿主自带；本仓测试用替身，所以测试环境缺它也能过）。
4. **配置声明**：插件要在 profile/preset 里声明，config 建议**先只开影子**：
   ```yaml
   dsh-gokifu-longmemory:
     enabled: false
     shadow: true          # 先跑 1–2 天，攒 evidence/shadow/*.jsonl
     budgetTokens: 500
   ```
   观察够了再 `enabled: true, shadow: false`（真注入）。
5. **改配置的方式**：走设置 UI 或 staging 文件 + 一键脚本由主人执行；**运行中不改 `profiles/*/cordis.patch.yml`**（会整树热重载，有 `exit(1)` 实机事故）。
6. **重启**：按本机铁律，只能由主人在"当条消息里明确要求重启"时执行；本轮不做。

## 7 · 风险与已知边界

| # | 风险 | 影响 | 处置 |
|---|---|---|---|
| 1 | **与压缩插件同点注入**：两边都在"最后一条 claimed 之后"插入，顺序取决于 hook 注册顺序 | 两条记忆行相邻出现；理论上不会互相覆盖 | 装的时候**先只开一边**观察；两边都开时用一次真实会话核对 `messages` 顺序（本仓测试只覆盖单插件） |
| 2 | **每会话只注入一次**：会话被压缩后卡片可能被折掉，本实现不会补 | 长会话后期看不到记忆卡 | 上游压缩插件有"被 fold 则补回"的逻辑；我们这版不做（任务书写明"每会话一次"），列为后续改进 |
| 3 | `session.cwd` 缺失时退回 `process.cwd()` | 作用域可能算错 ⇒ 闸 1 挡掉或误开 | 闸 1 在 CLI 路径上真核（0.5.0 已接），算错时表现为"沉默"而不是"注入错的" |
| 4 | 注入消息**不进会话日志**（这是设计：不写 session 事件） | 事后从日志回放看不到注入了什么 | 影子记录 `evidence/shadow/*.jsonl` 才是注入台账；真注入后建议加一条 `card` 落盘（下一刀） |
| 5 | 宿主包 `createUserMessage` 签名若变 | 造消息失败 | 已在 try/catch 内 ⇒ warn + 原 decision；测试用替身，签名变化时先改替身 |
| 6 | 真语的"沉默率"很高（预演 95%） | 装了像没装 | 见 §5：先攒影子记录，用 `翻盖率/精度` 判断值不值得开；别用"有没有效果"这种主观口径 |

## 8 · 最短路径

```bash
# 单测
node --test test/plugin.test.mjs

# 不安装，先看它会注入什么（假 session + 真语料）
node tmp/plugin-sweep.mjs

# 影子模式预演（写 evidence/shadow，不改 decision）
node -e '
const { apply } = await import("./src/plugin.mjs");
' # 见 tmp/plugin-sweep.mjs 的写法
```
