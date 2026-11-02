# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页；干完活必须回来更新「当前状态」与「下一步」。
> 仓库维护准则继承 `MYCF711/magpie-plugin-scaffold`：**禁止直推 main**；功能分支 → PR → 必需检查全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-gokifu-longmemory`（私有） |
| 包名 | `dsh-gokifu-longmemory`（**不发 npm**） |
| 当前版本 | `0.23.0` |
| 定位 | DSH 长期记忆系统（棋院 / Kifu-in）：棋谱入馆、相关边成网、定式可更新；只在相关时顺藤摸瓜 |
| 当前负责人 | Lead（superagent 会话） |

## 二、当前状态（2026-11-02 16:40 · 整点巡检）

```
分支         main = 0.23.0；功能分支 → PR → CI → 合并 → release（--require-ci）
里程碑       M6 记忆质量收口：D1/D2/D3/D5 已发布；A1/A5 回归已修；类级主题已上线
插件         仓库已改名 dsh-gokifu-longmemory；包名小写；`link:` 安装；当前被临时禁用（等主人重启后跑 scripts/re-enable.mjs）
```

| 资产 | 数值 |
|---|---|
| 测试 | **356 条**（352 pass / 0 fail / 4 skip） |
| 六轴 | A1 **0.00%**（≤5%）· A2 **23.61%** · A3 not-live · A4 p50 **1.78ms** · A5 **0.00%** · A6 **100%** |
| 语料 | 116 局（store manifest）/ 1067+ 主题 / claim 250+ `[本] 2026-11-02 16:30` |
| 当天覆盖 | 18/18（D1 全量重建后实测） |
| 已发布 | 0.15.1 改名脱敏 → 0.16 配置 schema → 0.17 设置页 → 0.18 D2/D3 → 0.19 D1 → 0.19.1 D4 否决 → 0.20 A1/A5 修复 → 0.21 D5 → 0.22 类级主题 → 0.23 类级信号 |
| 证据 | `evidence/M6-acceptance.md`、`M6-D5.md`、`M7-class-topics.md`、`M6-D4-rejected.md` |
| 知识库 | `docs/调研/04`（A-MEM/Zep/Mem0）、`05-Sleep-time-Compute`、`06-MemOS` |

## 三、下一步（按 ROI）

1. **N5 睡眠期卡片预计算**（`05` 论文借鉴）：归档后为「高热主题 × 作用域」预生成卡片骨架 + digest；首轮命中直接用，冷门仍走现场 walk。验收：A4 p95 不升、A1/A2 不变。
2. **N6 可预测性代理**：首条消息主题的 df 分布 → 只对高 df 主题预计算（纯机械量）。
3. **N1 双时态边**：claimEdge 加 `validFrom/validTo`（Zep/Graphiti），支持"当时有效、现已失效"的时间线查询。
4. **N2 BM25 关键词通道**（Mem0 多信号检索；非向量，边界内）：与主题通道融合后看 A2 是否再涨。
5. **主人动作**：退出 DSH → `node scripts/re-enable.mjs` → 重启；确认设置里出现「长期记忆（棋院）」且可填库地址。
6. **D5 观察**：真注入后统计"二次命中"触发次数与误报（应只在同类失败 ≥2 次时出现）。
7. **已知取舍**：`u:` 层 claim 必须有同域证据棋谱才进卡片（换 A5=0）；若将来要跨域展示，需要独立的"用户层"渲染口径与指标。

## 四、硬约束

- **禁止直推 `main`**：功能分支 → PR → 必需检查 → 合并 → release。
  - 说明：GitHub 免费私有仓库不支持分支保护（2026-11-02 实测 403），改用**本地 pre-push hook + CI 检查**兜底；hook 在 `.git/hooks/pre-push`，clone 后需重装（见 `scripts/install-hooks.sh`）。
- 发布前必跑：`node scripts/check.mjs`（退出 0）、`node --test`、`node scripts/release.mjs --dry-run`。
- **不发 npm**：版本发布只做 annotated tag + GitHub Release；`package.json` 保持 `private: true`。
- 每次功能实现都要版本号 + `CHANGELOG.md` 一段（写清更新内容）。
- 改 `AGENTS.md` 的硬规则前先在本文件记一条「决策」，说明依据。
- 不发密钥；不复制 `<KEYS>\`。

## 五、相关棋谱

本仓的 `kifu/` 暂无；M1 跑通后把本会话棋谱软链/复制进来。

## 六、给接手者的最短路径

1. 读本文件 → 2. `git status` + `git log --oneline -5` → 3. 读 `AGENTS.md` §10/§11 → 4. 干活 → 5. `node scripts/check.mjs` + `node --test` → 6. 更新本文件 → 7. 分支/PR/合并/release。
