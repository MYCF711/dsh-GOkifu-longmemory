# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页；干完活必须回来更新「当前状态」与「下一步」。
> 仓库维护准则继承 `MYCF711/magpie-plugin-scaffold`：**禁止直推 main**；功能分支 → PR → 必需检查全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-kifuin`（私有） |
| 包名 | `dsh-kifuin`（**不发 npm**） |
| 当前版本 | `0.2.0` |
| 定位 | DSH 长期记忆系统（棋院 / Kifu-in）：棋谱入馆、相关边成网、定式可更新；只在相关时顺藤摸瓜 |
| 当前负责人 | Lead（superagent 会话） |

## 二、当前状态（2026-11-02 03:10）

```
分支         main（M1 已合并）
里程碑       M1 只读考古完成（0.2.0）；下一步 M2 建网成线
代码         R00/R01/R02/R03/R04/R05/R07/R14 已落地；98 条测试全绿
```

| 资产 | 数量 |
|---|---|
| 方案 | `方案.md` v0.9 |
| 必读文档 | AGENTS / 边界 / 拷问记录 / 对标 |
| 房间 | R00/R01/R02/R03/R04/R05/R07/R14（M1 集） |
| 测试 | 98 条（`node --test` 全绿） |
| 语料 | 90 日志 / 24 局 / 15 棋谱 / 1,234 节点 / 1,403 边 / 753 主题 / 194 相关边 `[本] 2026-11-02` |
| 建边阈值 | `df≥2 && df<N && df≤max(2,⌈10%N⌉)`（S8；回退改 `linkEligible()` 一行） |

## 三、下一步

**M2 建网成线（只写不读）**：

1. `R15 persist`：sidecar（`<DSH_HOME>/memory-context/`）、manifest、checksums、append-only。
2. `R06 thread`：线索（藤的视图，多对多）。
3. `R08 joseki`：定式候选（每招溯源、preconditions）。
4. `R09 claim`：claim + validity/preconditions。
5. 入档管线：episode → 主题/边/线索/定式候选 → 索引。
6. 验收：幂等、崩溃恢复、原件 0 篡改、manifest 可校验。

## 四、硬约束

- **禁止直推 `main`**：功能分支 → PR → 必需检查 → 合并 → release。
  - 说明：GitHub 免费私有仓库不支持分支保护（2026-11-02 实测 403），改用**本地 pre-push hook + CI 检查**兜底；hook 在 `.git/hooks/pre-push`，clone 后需重装（见 `scripts/install-hooks.sh`）。
- 发布前必跑：`node scripts/check.mjs`（退出 0）、`node --test`、`node scripts/release.mjs --dry-run`。
- **不发 npm**：版本发布只做 annotated tag + GitHub Release；`package.json` 保持 `private: true`。
- 每次功能实现都要版本号 + `CHANGELOG.md` 一段（写清更新内容）。
- 改 `AGENTS.md` 的硬规则前先在本文件记一条「决策」，说明依据。
- 不发密钥；不复制 `D:\MyKey\`。

## 五、相关棋谱

本仓的 `kifu/` 暂无；M1 跑通后把本会话棋谱软链/复制进来。

## 六、给接手者的最短路径

1. 读本文件 → 2. `git status` + `git log --oneline -5` → 3. 读 `AGENTS.md` §10/§11 → 4. 干活 → 5. `node scripts/check.mjs` + `node --test` → 6. 更新本文件 → 7. 分支/PR/合并/release。
