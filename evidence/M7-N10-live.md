# N10 线上验证：作用域兜底真的生效了（2026-11-04 01:39）

## 重启后的心跳（新 pid）
```
pid 20300（旧 34576）· scope=w:d:/DeepSeek Harness/default-workspace/长期记忆系统
scopeFrom=session-log · action=skip · reason=no-signal
```

- `scopeFrom=session-log`：新会话还没归档，兜底直接读了会话日志第一帧 header 的 `cwd`；
- 兜底值与**本工作区**一致（不再是 `profiles/desktop` 假作用域）；
- 心跳从 4301 → 4889 行，说明新代码在宿主里稳定运行。

## 仍未注入的原因（不是 bug）
当前用户消息是「我重启好了，继续」——不含错误/主题信号，插件按设计沉默（`no-signal`）。

## 判据（首次注入会自动落证据）
后台守望 `scripts/watch-first-inject.mjs` 已重启（30 秒间隔、12 小时窗口）：
一旦出现 `action=inject`，自动写 `evidence/M7-A3-first-inject.md`（含 scope/scopeFrom/digest/tokens）。

## 结论
N10 的假设被线上证实：**作用域兜底把"跑着但不工作"变成了"跑着且工作，只是当前无信号"**。
