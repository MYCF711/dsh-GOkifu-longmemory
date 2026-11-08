# T52 · 「被 oncePerSession 拦下」在心跳台账里是空的 —— 静默和死机长得一模一样

> 2026-11-09 · 触发：本轮查 `live-stats.jsonl` 时发现**当前宿主连续 128 分钟零心跳**，
> 而期间会话一直在跑（有多个 turn）。查不出是"被限流"还是"插件根本没被调用"。

## 一、实测的盲区

```
node -e "…读 live-stats.jsonl…"
末行 2026-11-08T20:32:27.722Z   距今 127.9 分钟
pid 8040: 注入 33 · 跳过 20 · 总行 55
reason 分布: {"no-signal":18, "no-hit":1, "gates-failed":1}
```

`pid 8040` 从 17:52 起一直在写心跳，最后一次写是 20:32（一次 `inject`），**之后 128 分钟一行都没有**。

三种解释在台账上**完全同形**：

| 真实原因 | 台账里长什么样 |
|---|---|
| 被 `oncePerSession` 拦下（本会话已经投过卡） | **一行都没有** |
| 插件没被宿主调用（作用域没挂上 / 宿主换了 pid） | **一行都没有** |
| 插件挂了 / 被 dispose | **一行都没有** |

## 二、根因（代码位置）

```js
// 旧实现（src/plugin.mjs，pre-step 入口）
if (config.oncePerSession && session) {
  if (sessionId ? injectedIds.has(sessionId) : …) return decision;   // ← 早退在写心跳**之前**
}
…
appendLiveStats(storeRoot, { kind: 'pre-step', action: result.action, reason: result.reason, … });
```

心跳是"决策之后"才写的；`oncePerSession` 的短路发生在决策之前 ⇒ 被它拦下的每一步都不留痕。
这不是"少记一条日志"，是**让 T25/T49 这条闸无法被审计**（`post-restart-verify` 的 ④⑤ 一度只能 NO-SAMPLE，
就有这层原因）。

## 三、修法

被 `oncePerSession` 拦下时**留一条墓碑行**（`reason: 'once-per-session'`），并且**每会话只记一次**
（`oncePerSessionNotified: Set<sessionId>`）—— 不能每个 step 灌一条：本机约 2000 步/天，
每步一条会把 64MB 上限（T16）当早餐吃掉。

```js
if (blockedBySession) {
  if (!oncePerSessionNotified.has(key)) {
    oncePerSessionNotified.add(key);
    appendLiveStats(resolveStoreRoot(config), {
      kind: 'pre-step', action: 'skip', reason: 'once-per-session', digest: null, tokens: null,
      scope: lastResolvedScope(session?.id)?.scope ?? null, shadow: config.shadow === true,
    });
  }
  return decision;
}
```

为什么"每会话一次"够用：这条行要回答的是**"这个会话被限流了吗"**（是/否），不是"限流了几次"。
后一个数用注入行本身就能算（同 session 同 digest 的相邻差），不需要每步一条。

## 四、验收

```
node --test --test-name-pattern "T52" test/plugin.test.mjs
  ✔ T52: 被 oncePerSession 拦下时留一条墓碑行（否则"被限流静默"与"插件死了"分不清）
      三次调用 ⇒ 注入 1 次 + 墓碑恰好 1 条（第三次不许再灌）

node --test "test/*.test.mjs"  → 1229 条 / 1223 pass / 0 fail / 6 skip
node scripts/check.mjs         → PASS
```

tombstone：把墓碑那段删掉 ⇒ 断言 `tombstones.length === 1` 变 `0`，T52 红。

## 五、没验的 / 边界

- **线上还看不到这条行**：当前宿主（pid 8040）跑的是旧代码，要等重启。重启后 `live-stats` 里应出现
  `reason: "once-per-session"`，届时"静默 vs 死机"才真正可分。
- **它不解释 128 分钟零心跳到底是哪一种**（限流 / 未调用 / 挂掉）。这条修法是让**下一次**能分辨，
  不是给这次定性 —— 现有的证据不足以归因，不编造。
- 墓碑行不写 `digest`/`tokens`（限流时刻没有"投的是哪张卡"这件事），下游统计按 `action === 'inject'`
  过滤的口径不受影响。
