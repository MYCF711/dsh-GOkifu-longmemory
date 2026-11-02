# 更正：本插件没有"设置页 UI"（2026-11-03）

## 怎么发现的
给"装完之后看什么"做核对时，`docs/安装指南.md` 写着「设置页「当前库」行有局数与更新时间」，
以及 `MAINTENANCE.md` 历史里记着 0.17.0「设置页」。于是去代码里找 UI 注册：

```
grep -n "settings\|client" src/plugin.mjs   → 无匹配
ls src/                                      → index.mjs / plugin.mjs / rooms/
```

**结论：本包没有 client 入口，也没有注册任何设置分区。**

## 实际提供的能力
- `handleConfigRoute`（HTTP 路由）：GET 返回 config + stats，POST 校验并写配置；
- 命令行：`cli stats|dump|verify|rebuild`、`install-doctor`、`live-stats`、`status-digest`。

## 为什么会有这个误会
0.17.x 时代确实改过"设置页"相关的注入，后续把 client 注入清空（防止 pending 卡住 web boot），
但安装指南与台账没同步更新——**文档漂移**，和本项目此前抓过的"调研清单漏登记"是同类问题。

## 处置
1. `docs/安装指南.md` 的验证第 2 条改为「`live-stats` 有心跳 / `cli stats` 有局数」；
2. 保留 `MAINTENANCE.md` 的历史记录（历史不改写），以本文件为准；
3. 装完之后"插件是否真的在跑"的判据收敛为一条：**`live-stats.jsonl` 有没有行**。
