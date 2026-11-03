# 线上流水线已经走到“闸”这一步（2026-11-04 03:17:55）

## 心跳原文
```json
{"at":1793731075555,"src":"index.js","pid":20300,"kind":"pre-step",
 "scope":"w:d:/DeepSeek Harness/default-workspace","scopeFrom":"session-log",
 "action":"skip","reason":"gates-failed","digest":"628193df4e28aa1b","tokens":239,"shadow":false}
```

## 它证明了什么（N10 之后的真实链路）
1. `scopeFrom=session-log`：作用域兜底生效（否则这里是 profile 假作用域、必然 no-hit）；
2. 出现 `gates-failed` 而不是 `no-hit` ⇒ **walk 命中了**、**卡也建出来了**（`tokens=239`）；
3. 闸按设计把它拦下了（`action=skip`）——**这是产品在做正确的事**，不是故障。

## 已知不足与已修
心跳当时只记 `reason=gates-failed`，**没记是哪几道闸**。0.111.0 起心跳增加 `gateIds`（只写闸 id、不写卡内容），
下次重启后即可直接从心跳定位是闸 1（作用域）还是闸 6/7/8（祈使句/长度/来源）等。

## 口径
- 本文**不声称**"注入可靠性已验证"：到目前为止 `inject=0`；
- 它只证明"链路已经从‘跑着但没命中’推进到‘命中→建卡→过闸判定’"。
