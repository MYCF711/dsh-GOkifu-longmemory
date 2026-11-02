# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页；干完活必须回来更新「当前状态」与「下一步」。
> 仓库维护准则继承 `MYCF711/magpie-plugin-scaffold`：**禁止直推 main**；功能分支 → PR → 必需检查全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-gokifu-longmemory`（私有） |
| 包名 | `dsh-gokifu-longmemory`（**不发 npm**） |
| 当前版本 | `0.49.0` |
| 定位 | DSH 长期记忆系统（棋院 / Kifu-in）：棋谱入馆、相关边成网、定式可更新；只在相关时顺藤摸瓜 |
| 当前负责人 | Lead（superagent 会话） |

## 二、当前状态（2026-11-02 17:45 · 整点巡检）

```
分支         main = 0.49.0；功能分支 → PR → CI → 合并 → release（--require-ci）
里程碑       M6 记忆质量收口：D1/D2/D3/D5/N10 已发布；A1/A5 回归已修；类级主卷 + volumes/audit 已上线
插件         `cordis.patch.yml` 里两条 `disabled: true`；新版 `scripts/re-enable.mjs` 先 `--dry-run` 看「摘除 3 条」，再退出 DSH 执行，重开后 `install-doctor` 应显示「未见 disabled」
```

| 资产 | 数值 |
|---|---|
| 测试 | **379 条**（375 pass / 0 fail / 4 skip） |
| 六轴 | A1 **0.00%**（≤5%）· A2 **24.32%** · A3 not-live · A4 p50 **2.30ms** · A5 **0.00%** · A6 **100%** |
| 语料 | 116 局 / 141 卷 / claim 295（有效期已止 22）`[本] 2026-11-02 18:45` |
| 当天覆盖 | 18/18（D1 全量重建后实测） |
| 已发布 | 0.15.1 改名脱敏 → 0.16 配置 schema → 0.17 设置页 → 0.18 D2/D3 → 0.19 D1 → 0.19.1 D4 否决 → 0.20 A1/A5 修复 → 0.21 D5 → 0.22 类级主题 → 0.23 类级信号 → 0.24 类表 8 类 → 0.25 设置页库状态 → 0.26 类级主卷 → 0.27 cli volumes → 0.28 cli audit → 0.29 N10 人纠错回填 → 0.30 A2 holdout → 0.31 A2b → 0.32 A2b 两口径 → 0.33 A2b 严格 70.59% → 0.34 claim 类表对齐 → 0.35 类级章节自愈 → 0.36 指标护栏 → 0.37 N1 双时态 → 0.38 宿主仿真 → 0.39 install-doctor → 0.40 方案 §8.2c/8.2d → 0.41 N9 卷首摘要 → 0.42 re-enable 精准摘除 → 0.43 A2b 冻结评估集 → 0.44 A2b 严格判据修正 → 0.45 D5 遥测 → 0.46 调研 15 Graphiti → 0.47 cli facts --at → 0.48 A2b 跨项目分桶 → 0.49 Q18 预留开关（默认关） |
| 证据 | `M6-acceptance.md`、`M6-D5.md`、`M7-class-topics.md`、`M6-D4-rejected.md`、`M7-N10-adjudications.md`、`M7-N2-deferred.md` |
| 知识库 | `docs/调研/04`（A-MEM/Zep/Mem0）、`05-Sleep-time-Compute`、`06-MemOS`、`07-Letta`、`08-SimpleMem`、`09-Cognee`、`10-MemGPT`、`11-MemoryBank`、`12-LangMem`、`13-MIRIX`、`14-Generative-Agents`、`15-Graphiti` |

## 三、下一步（2026-11-02 17:40 修订）

1. **N2 BM25：暂缓（有明确理由）**。`walk` 的契约是**零依赖**（文件头写明「不 import 任何模块」），
   接入 BM25 需要么内联 ~40 行、要么放弃零依赖；两条都要先有精度抽样作前提。
   做法顺序（与 `evidence/M7-N2-rejected.md` 一致）：独立倒排索引 → ≥20 条精度抽样 → 可回退融合权重。
   **在拿到 ≥20 条人工判定前不动 `walk`。**
2. **`node scripts/metrics-guard.mjs` 是回归闸**（0.36.0）：每轮先跑，不达标先修再谈优化。
3. ~~N1 双时态~~ **已完成**（0.37.0）：claim 侧 validFrom/validTo；claimEdge 待边落盘后再镜像。
3. **Q18 待裁定**：`class:*` 主卷是否允许跨工作区展示。**开关已实现但默认关**（0.49.0）：`crossScopeClass=true` 才放开，卡片标 `[跨项目]`，A5 分桶统计；选 A 则永久关闭。
4. ~~N9 卷首摘要~~ **已完成**（0.41.0）：`headline` 机械拼接、`cli volumes` 展示；进注入前需 A2b 对照。
5. **D5 线上观察**：遥测已就位（0.45.0）——真注入后跑 `node scripts/repeat-report.mjs`，看触发率/类别/token，并人工抽 10 条看误报。
6. **主人动作**：退出 DSH → `node scripts/re-enable.mjs` → 重启；设置里应出现「长期记忆（棋院）」与库状态行。
7. **claim 类表对齐**（0.34.0）：历史 claim 只增不改，旧库不回溯合并，只对后续归档生效。
8. **已知取舍**：`u:` 层 claim 必须有同域证据棋谱才进卡片（换 A5=0）。

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
