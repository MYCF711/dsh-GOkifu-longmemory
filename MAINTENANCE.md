# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页；干完活必须回来更新「当前状态」与「下一步」。
> 仓库维护准则继承 `MYCF711/magpie-plugin-scaffold`：**禁止直推 main**；功能分支 → PR → 必需检查全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-gokifu-longmemory`（私有） |
| 包名 | `dsh-gokifu-longmemory`（**不发 npm**） |
| 当前版本 | `0.30.0` |
| 定位 | DSH 长期记忆系统（棋院 / Kifu-in）：棋谱入馆、相关边成网、定式可更新；只在相关时顺藤摸瓜 |
| 当前负责人 | Lead（superagent 会话） |

## 二、当前状态（2026-11-02 17:45 · 整点巡检）

```
分支         main = 0.30.0；功能分支 → PR → CI → 合并 → release（--require-ci）
里程碑       M6 记忆质量收口：D1/D2/D3/D5/N10 已发布；A1/A5 回归已修；类级主卷 + volumes/audit 已上线
插件         仓库已改名 dsh-gokifu-longmemory；包名小写；`link:` 安装；当前被临时禁用（等主人重启后跑 scripts/re-enable.mjs）
```

| 资产 | 数值 |
|---|---|
| 测试 | **360 条**（356 pass / 0 fail / 4 skip） |
| 六轴 | A1 **0.00%**（≤5%）· A2 **24.32%** · A3 not-live · A4 p50 **2.30ms** · A5 **0.00%** · A6 **100%** |
| 语料 | 116 局 / 1124 主题 / 138 卷（类级主卷 4）/ claim 250+ `[本] 2026-11-02 17:10` |
| 当天覆盖 | 18/18（D1 全量重建后实测） |
| 已发布 | 0.15.1 改名脱敏 → 0.16 配置 schema → 0.17 设置页 → 0.18 D2/D3 → 0.19 D1 → 0.19.1 D4 否决 → 0.20 A1/A5 修复 → 0.21 D5 → 0.22 类级主题 → 0.23 类级信号 → 0.24 类表 8 类 → 0.25 设置页库状态 → 0.26 类级主卷 → 0.27 cli volumes → 0.28 cli audit → 0.29 N10 人纠错回填 → 0.30 A2 holdout 口径 |
| 证据 | `M6-acceptance.md`、`M6-D5.md`、`M7-class-topics.md`、`M6-D4-rejected.md`、`M7-N10-adjudications.md`、`M7-N2-deferred.md` |
| 知识库 | `docs/调研/04`（A-MEM/Zep/Mem0）、`05-Sleep-time-Compute`、`06-MemOS`、`07-Letta`、`08-SimpleMem`、`09-Cognee`、`10-MemGPT`、`11-MemoryBank` |

## 三、下一步（2026-11-02 17:40 修订）

1. **N2 BM25：暂缓（有明确理由）**。`walk` 的契约是**零依赖**（文件头写明「不 import 任何模块」），
   接入 BM25 需要么内联 ~40 行、要么放弃零依赖；两条都要先有精度抽样作前提。
   做法顺序（与 `evidence/M7-N2-rejected.md` 一致）：独立倒排索引 → ≥20 条精度抽样 → 可回退融合权重。
   **在拿到 ≥20 条人工判定前不动 `walk`。**
2. **N1 双时态边**：claimEdge 加 `validFrom/validTo`（Zep/Graphiti），服务「当时有效/现已失效」的时间线查询；
   结构改动，不需要模型。
3. **N9 建库期骨架卡**：归档期为类级主卷生成「卷首卡」（标题/局数/代表错误/指针），首轮命中直接取用。
4. **D5 线上观察**：真注入后统计二次命中触发次数与误报（应只在同类失败 ≥2 次时出现）。
5. **主人动作**：退出 DSH → `node scripts/re-enable.mjs` → 重启；设置里应出现「长期记忆（棋院）」与库状态行。
6. **已知取舍**：`u:` 层 claim 必须有同域证据棋谱才进卡片（换 A5=0）。

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
