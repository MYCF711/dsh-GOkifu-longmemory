# T374 · 重启后的线上读数（2026-11-10 02:00）

> 宿主重启到 **`Desktop-0.2.2-rc.1`**（pid 23364，启动于 01:55:53）。这是本次目标里唯一需要人做的一步。

## 一、`post-restart-verify`：**6/7 · FAIL=0 · exit 0**

```
PASS      T12：abstain 的 reason 不再全塌 cross-scope（no-relevant-claim=3）
PASS      T10：signalPreview 完整度 90.0%（门槛 >30%）
NO-SAMPLE T25：当前宿主只有 10 条注入（<20）⇒ 样本不足（**不是失败**）
PASS      T28/T31：卡上出「 · 恢复」尾注
PASS      T16/T18/T20：三个 sidecar 上限都是 64MB
PASS      T27：metrics-guard 输出含「A1 三轴」
汇总：6/7 项通过 · FAIL=0 · NO-SAMPLE=1 ⇒ exit 0
```

**关键变化**：重启前那条 FAIL（「新代码未加载」，发版时间晚于宿主首心跳）**已经消失** ——
新代码确实进进程了。T25 那条是**样本不足**，等宿主再跑一段会话就会自动有样本（`NO-SAMPLE` 不许硬算过）。

## 二、`patrol`：三项体检 + 主判据 + 语义不变量全绿

| 项 | 读数 | 说明 |
|---|---|---|
| A2b | 严格 46.6%（n=118 holdout）· 覆盖 79.7% | 与改前一致 |
| **A3 心跳** | inject=1766 · skip=33044 · gates-failed=23 · **限流静默=36** · dedupe=? | **T57 的消费者第一次有数**（改前恒为 `?`） |
| A5 跨作用域 | 0 | — |
| A6 文字层 | ok 12/22 · offset 0 · notFound 0 · 日期 22/22 | 样本刚起（12 张） |
| 语义不变量 | pass 32 · fail 0 | — |
| 子代理归并 | mergeRate 100% · orphan 0 | — |

`dedupe=?` 仍是 `?`：`already-in-context`（T49 的无状态去重）**一次都没触发**。
查 live-stats 最近 400 行：`once-per-session` 出现 **39 次**（全部来自同一个会话），`already-in-context` 0 次。
⇒ 限流先一步把重复挡住了，去重闸无事可做（两道闸是纵深，不是二选一）。

## 三、`metrics-guard`

```
A2b 严格 46.6% · 覆盖 79.7%      A4 p50 = 17.36ms（T370/T371 后：38.8 → 17.4）
A5 0 · A6 1 · A1 0
A1.redundant = 浪费 0.0% · 必要重注 0.0%（n=13，**未通电**·窗口样本不足）
```

A1.redundant 要等新宿主积累到足够会话才有判据力（T53 的窗口口径）——现在 n=13，**不许当结论**。

## 四、⚠️ 一个新的红灯：工具面**没注册上**

```
home/memory-context/tools-registered.json   （01:55，当前宿主 pid 23364 写入）
  via: tools-plugin-none · ctxHasRegister: **false** · count: **0** · names: []
```

对照：更早一次用 `home-0.2.2-rc.1` 的启动（21:35）写的是
`via: direct · ctxHasRegister: true · count: 6`（六个 `kifu_*` 全在）。

两个 home 的 `profiles/desktop/cordis.patch.yml` 都挂了 `kifu-tools`（各 2 处匹配），**配置不是差异点**。
当前宿主是 rc1 构建（`Desktop-0.2.2-rc.1\DeepSeek Harness.exe`，pid 23364/19600/44720/30016/24248）。

⇒ **本会话里 `kifu_*` 工具不可用**，且这是重启后才被这条凭据暴露出来的。

**下一步（下一刀）**：宿主自己的官方插件用的是
`ctx.inject(['tools'], (c) => c.tools.register(...))` 这种**延迟获取**写法
（见 `@deepseek-ai/dsh-agent-tool-presentation` 的 `apply`）。
我们的 `tools-plugin.mjs` 是「apply 时直接读 `ctx.tools.register`」。改成"先直接读、读不到再走 `ctx.inject` 延迟注册"，
既能修好当前宿主，又不会让已经能用的宿主变差（失败即回退旧路径）。

## 五、结论

- **目标里的重启验收项达成**：`post-restart-verify` **FAIL=0**（改前 FAIL=1）。
- **T57 的消费者第一次有真实读数**（限流静默=36）。
- **A1.redundant 还不能判**（n=13）。
- **新发现**：工具面未注册（`ctxHasRegister=false`），已记为下一刀。
