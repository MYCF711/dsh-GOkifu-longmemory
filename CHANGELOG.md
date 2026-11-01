# CHANGELOG

> 每次功能实现都发版本并写在这里。**不发 npm**（私有自用），只发 GitHub Release + tag。

## 0.2.0（2026-11-02）

M1 只读考古完成：从 90 份真实会话日志与 15 张棋谱建出第一张关系网，**零注入、零写入**。

### 新增房间
- **R01 logread**：按 RFC 8878 逐帧扫边界 + 逐帧解压；坏尾返回前缀（`truncated`），坏行计数，帧级损坏与未知版本 fail-closed。实测 90/90 日志解析成功（38,388 帧 / 70,966 事件 / 194.9 MB 明文，中位 1.66 s）。
- **R00 episode**：会话 → 棋谱（双时钟、闭包、子代理父链）；24 局独立成谱，66 局子代理归并到父局。
- **R02 graphread**：`graph.json` + `graph.json.delta.jsonl` 逐帧回放；坏尾截断、版本拒绝。实测 15 张全部读出（1,230 节点 / 1,397 边 / 198 delta 帧）。
- **R03 extract**：失败/成功/未结算/约束/工具机械抽取，每条带 seq + quote（≤200 字），只认 `source.kind==="user"`（不抽模型摘要）。
- **R04 topic**：repo/file/domain/error/tool/term/goal 主题抽取；CJK 2-gram + 停用词 + IDF；753 主题（df≥2：162）。
- **R05 link**：多粒度相关边（棋谱↔主题、棋谱↔棋谱、节点↔节点），每条带 `why` 与权重；194 条边（shared-topic 61 / same-error 67 / same-file 66）。
- **R07 index**：`index.md` 树（派生、可重算）。
- **R14 cli**：`stats` / `dump` / `walk`，全程只读（实测写入 0 字节）。

### 修复
- `scripts/release.mjs` 在 Windows/sh 下的进程替换兼容问题：改用临时文件传 release notes。
- `engines` 改为 `>=23.8`（`node:zlib` 的 zstd API 不保证 22 全系都有）。

### 测试
- 98 条测试全绿（R00–R05、R07、R14）；真实语料断言 + 合成坏尾/坏行夹具。

## 0.1.0（2026-11-02）

首个版本：方案冻结 + 仓库骨架。

- 方案 v0.9 冻结：目标（第一验收面=不重复踩坑）、结构（棋谱+主题+相关边→线索→棋书馆+定式库）、边界（唯一入口=棋谱）、时间（双时钟）、裁决（多成员独立解析，人只纠错）、可搬迁内核。
- 仓库骨架：`src/rooms/`（按最小交付房间切）、`scripts/check.mjs`、`scripts/release.mjs`、`test/`。
- 维护台账：`MAINTENANCE.md`。
- 不发 npm；版本发布 = annotated tag + GitHub Release。
