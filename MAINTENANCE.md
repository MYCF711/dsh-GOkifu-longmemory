# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页；干完活必须回来更新「当前状态」与「下一步」。
> 仓库维护准则继承 `MYCF711/magpie-plugin-scaffold`：**禁止直推 main**；功能分支 → PR → 必需检查全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-kifuin`（私有） |
| 包名 | `dsh-kifuin`（**不发 npm**） |
| 当前版本 | `0.1.0` |
| 定位 | DSH 长期记忆系统（棋院 / Kifu-in）：棋谱入馆、相关边成网、定式可更新；只在相关时顺藤摸瓜 |
| 当前负责人 | Lead（superagent 会话） |

## 二、当前状态（2026-11-02 02:40）

```
分支         main（初始提交）
里程碑       M0 完成（方案 v0.9），M1 未开始
代码         仅骨架：package.json / scripts / 目录
```

| 资产 | 数量 |
|---|---|
| 方案 | `方案.md` v0.9 |
| 必读文档 | AGENTS / 边界 / 拷问记录 / 对标 |
| 房间 | 见 AGENTS §11（R00–R15，M1 最小集） |
| 测试 | 0 条（M1 起） |

## 三、下一步

**M1 只读考古（零注入）**：

1. `R01 logread`：多帧 zstd 逐帧解码 + 事件包裹层解析（`time`/`seq`/`type`）；单测用小样本。
2. `R00 episode`：会话 → 棋谱（闭包、时间窗、信号计数）。
3. `R02 graphread`：`graph.json` + `graph.json.delta.jsonl` 回放。
4. `R03 extract`：失败边/成功边/约束/工具集合的机械抽取。
5. `R04 topic` + `R05 link`：主题抽取与多粒度相关边（带 `why`）。
6. `R07 index`：`index.md` 树。
7. `R14 cli`：`dump` / `stats` / `walk`。
8. 验收：86 日志 + 11 棋谱全解析；可复算；零注入；0 写入会话日志。

## 四、硬约束

- **禁止直推 `main`**：功能分支 → PR → 必需检查 → 合并 → release。
- 发布前必跑：`node scripts/check.mjs`（退出 0）、`node --test`、`node scripts/release.mjs --dry-run`。
- **不发 npm**：版本发布只做 annotated tag + GitHub Release；`package.json` 保持 `private: true`。
- 每次功能实现都要版本号 + `CHANGELOG.md` 一段（写清更新内容）。
- 改 `AGENTS.md` 的硬规则前先在本文件记一条「决策」，说明依据。
- 不发密钥；不复制 `D:\MyKey\`。

## 五、相关棋谱

本仓的 `kifu/` 暂无；M1 跑通后把本会话棋谱软链/复制进来。

## 六、给接手者的最短路径

1. 读本文件 → 2. `git status` + `git log --oneline -5` → 3. 读 `AGENTS.md` §10/§11 → 4. 干活 → 5. `node scripts/check.mjs` + `node --test` → 6. 更新本文件 → 7. 分支/PR/合并/release。
