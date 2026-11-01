# CHANGELOG

> 每次功能实现都发版本并写在这里。**不发 npm**（私有自用），只发 GitHub Release + tag。

## 0.1.1（2026-11-02）

- 修复 `scripts/release.mjs` 在 Windows/sh 下的进程替换兼容问题：改用临时文件传 release notes。
- 发布口径明确：只发 annotated tag + GitHub Release，不发 npm。

## 0.1.0（2026-11-02）

首个版本：方案冻结 + 仓库骨架。

- 方案 v0.9 冻结：目标（第一验收面=不重复踩坑）、结构（棋谱+主题+相关边→线索→棋书馆+定式库）、边界（唯一入口=棋谱）、时间（双时钟）、裁决（多成员独立解析，人只纠错）、可搬迁内核。
- 仓库骨架：`src/rooms/`（按最小交付房间切）、`scripts/check.mjs`、`scripts/release.mjs`、`test/`。
- 维护台账：`MAINTENANCE.md`。
- 不发 npm；版本发布 = annotated tag + GitHub Release。
