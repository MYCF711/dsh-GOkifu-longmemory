# T49 · 同一张卡在每个 turn 重投：`oncePerSession` 是**内存态**，重新 apply 就归零

> 2026-11-09 · 触发：`node scripts/patrol.mjs` 红 —— `A1.redundant` 冗余浪费 **10.53%**（闸 1%）。
> 结论：机制修好（无状态去重），**线上效果要等下一次宿主重启**（插件靠软链加载，改源码不影响已运行进程）。

## 一、读数（本机真库，24h 窗口）

```
node scripts/patrol.mjs
  A1.redundant 冗余浪费 0.1052581822307096 > 0.01（会话级同卡再投、期间无压缩；窗口 291 次注入）

node tmp/a1-redundant-detail.mjs        # 逐对明细（只读）
  fixAt       = 2026-11-08T05:25:37.000Z
  windowStart = 2026-11-08T05:25:37.000Z (0.59 天)
  injections  = 291   tokens = 52889   distinctSessions = 116
  sessionsWithDuplicates = 20   sessionsWithWaste = 19
  wastePairs  = 36    wasteTokens = 5567   wasteRate = 10.53%
  necessaryPairs = 26 necessaryTokens = 4333  necessaryRate = 8.19%
  powered = true（100 次注入 / 20000 token 的门槛都过）
```

最长的一条：会话 `aa0b0da9-…` 里 digest `c15e36f9227c0464` **投了 8 次**（06:01 → 16:44，跨 10 小时）。

## 二、根因（两条事实叠加，都不是"偶发"）

### 事实 A：同一张卡在每个 `turn/start` 被**重建并重投**

会话 `aa0b0da9-…` 的会话日志（`session.v4.jsonl.zstd`）里，11 次注入全部落在 `turn/start → step/start(step 1)`：

```
1141 agent/inbox/spliced   ← agent-teams 每轮重投一次任务书
1142 turn/start            {"turn":4}
1144 step/start            {"turn":4,"step":1}
1145 user/message          source=agent-teams   ← 信号源（每轮都一样）
1146 user/message          source=dsh-gokifu-longmemory   ← 又投一张卡
1147 user/message          source=time-context
```

`card-samples.jsonl` 的 `signalPreview` 证实信号就是那份 agent-teams 任务书（`"AgentTeams automatic task
assignment from the shared task list. … You are executing as configured member "ablation-runner"."`）：
**信号每轮重复 ⇒ 同一张卡被重新构建 ⇒ 同一个 digest**。所以这不是"卡变了"，是"同一张卡被投了 N 次"。

### 事实 B：`oncePerSession` 的状态活不过一次 `apply`

`src/plugin.mjs` 的 `injectedIds` 是 `apply()` 内的 `Set`。只要宿主重新 `apply`（新 agent 作用域 /
插件重载 / 会话再 seed），它就是空的。

本机凭据：`tools-registered.json` **只由 `apply()` 写**（`src/plugin.mjs` 的 `recordToolRegistration`；
`src/tools-plugin.mjs` 写的是 `via: "tools-plugin"`，而这份是 `via: "none"` ⇒ 走的是 `plugin.mjs` 那条）。

```
stat -c '%y' D:/DeepSeek Harness/home/memory-context/tools-registered.json
  2026-11-09 03:22:06        ← apply 又跑了一次
宿主 pid 8040 首心跳
  2026-11-08T17:52:55.455Z   ← 01:52:55 启动
```

启动 1.5 小时后 `apply` 又跑了一次（`via: "none"`）⇒ **同一进程里 apply 不止一次**。
于是"每轮重投"和"一次都没拦住"同时成立：`injectedIds` 每次都是新的空集。

> 为什么 `session.id` 不是嫌疑：`card-samples.jsonl` 的 `scopeFrom` 分布 = `{session-log: 1191,
> episode-fallback: 364, session-cwd: 2}`，1557 条里只有 2 条解不到 `session.id` ⇒ 会话键一直是好的。

## 三、修法（无状态去重，不依赖任何内存状态）

判据换成**上下文事实**：卡正文（`cardText(card)`，也就是注入那条 user 消息的正文）已经逐字出现在
`payload.messages` 里 ⇒ 再投一次是确定的浪费。

```js
// src/plugin.mjs
export function cardAlreadyInContext(messages, card) { … }   // 正文逐字相等才算

// 主路径
let result = await decidePreStep({ … });
if (result.action === 'inject' && cardAlreadyInContext(payload?.messages, result.card)) {
  // 注意：必须返回**官方入参那个 decision**，`result.decision` 已经带上了卡（踩过：4≠3）
  result = { ...result, action: 'skip', reason: 'already-in-context', decision };
}
// D5 补卡路径同样吃这条闸
if (inner?.action === 'inject' && !cardAlreadyInContext(payload?.messages, inner.card)) { … }
```

为什么这样切：

| 情形 | 旧行为 | 新行为 | 对不对 |
|---|---|---|---|
| 卡还在上下文里（本轮重复） | 再投一张 | `skip / already-in-context` | ✅ 这是浪费（A1.redundant 的 waste 档） |
| 压缩把卡压掉了 | 再投一张 | 再投一张（正文不在 ⇒ 不拦） | ✅ 这是"必要重注"（necessary 档），不误伤 |
| 进程重启 / 插件重载 | 再投一张 | 卡还在就拦 | ✅ 内存态丢了也不影响 |

**不是**把 `oncePerSession` 删掉：它仍是同一实例内的快速短路，只是不再承担正确性。

## 四、验收

```
node --test --test-name-pattern "T49" test/plugin.test.mjs
  ✔ T49 ① 宿主重新 apply（内存状态清空）后，同一张卡不会在同一会话再投一次   （关掉闸 ⇒ 4≠3 红）
  ✔ T49 ② 卡被压缩掉（正文不在 messages 里）⇒ 恢复注入（"必要重注"那一档）
  ✔ T49 ③ cardAlreadyInContext 的边界（空卡 / 非数组 / 普通消息不算）
  3/3 pass

npm test        → tests 1219 · pass 1213 · fail 0 · skip 6
node scripts/check.mjs → PASS
```

**tombstone**：把去重条件改成 `false` ⇒ T49 ① 红（`4 !== 3`）；T25 ①②③④ 全绿（旧行为没被改坏）。

## 五、没验的（别当成已验）

- **线上效果要等下一次宿主重启**：插件是软链加载，改源码不影响已运行的 pid 8040。
  重启后看 `node scripts/patrol.mjs` 的 `A1.redundant` 是否从 10.53% 掉到 1% 以下（窗口 24h，样本量门槛 100 次注入）。
- **`apply` 为什么会重复跑**只证到"跑了不止一次"（凭据见 §二），没定位到 DSH 侧的具体触发点
  （新 agent 作用域 / 插件重载 / 会话再 seed 三选一未定）。本修法**不依赖**这个结论成立。
- **D5 补卡路径**只加了同一条闸 + 单测覆盖到主路径；D5 自身的触发面（`repeatHintMax=1`，也是内存态）
  没单独测"重新 apply 后会不会再补一张"——它的上限是 1，量级小，留作观察。
