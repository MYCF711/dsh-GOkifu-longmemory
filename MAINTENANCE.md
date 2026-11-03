
> 接手前先读这一页；干完活必须回来更新「当前状态」与「下一步」。
> 仓库维护准则继承 `MYCF711/magpie-plugin-scaffold`：**禁止直推 main**；功能分支 → PR → 必需检查全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-gokifu-longmemory`（**公开**；main 由 ruleset 保护：必须经 PR + required check `rules`，禁 force push/删除；单机单人，不强制审批） |
| 包名 | `dsh-gokifu-longmemory`（**不发 npm**） |
| 当前版本 | `0.110.0` |
| 定位 | DSH 长期记忆系统（棋院 / Kifu-in）：棋谱入馆、相关边成网、定式可更新；只在相关时顺藤摸瓜 |
| 当前负责人 | Lead（superagent 会话） |

## 二、当前状态（2026-11-02 20:40 · 整点巡检）

```
分支         main = 0.110.0；功能分支 → PR → CI → 合并 → release（--require-ci）
里程碑       M6 记忆质量收口：D1/D2/D3/D5/N10 已发布；A1/A5 回归已修；类级主卷 + volumes/audit 已上线
插件         `cordis.patch.yml` 里两条 `disabled: true`；新版 `scripts/re-enable.mjs` 先 `--dry-run` 看「摘除 3 条」，再退出 DSH 执行，重开后 `install-doctor` 应显示「未见 disabled」（该行需重启才能实测；未重启时可先看 `re-enable --dry-run` 的「摘除 3 条」）
```

| 资产 | 数值 |
|---|---|
| 测试 | **414 条**（410 pass / 0 fail / 4 skip）[本] 2026-11-04 02:55 |
| 六轴 | A1 **1.75%** · A2 **23.00%** · A3 live-idle · A4 p50 **6.99ms（3 次中位数，单次抖动 ±2ms）** · A5 **0.00%** · A6 **100.00%** `[本] 2026-11-04 02:55 · node scripts/m5-report.mjs` |
| 语料 | 305 局 / **341 卷** / **claim 852**（有效期已止 92；26 条为 0.58 前历史记录，无 `validFrom` 但都有 `occurredAt`，归档不回溯改写）`[本] 2026-11-04 02:55 · node scripts/cli.mjs audit + store` |
| 当天覆盖 | 18/18（一次性指标，见 `evidence/M6-D1.md`；不在本表维护） |
| 已发布 | **0.15.0 → 0.110.0 的 CHANGELOG 段齐全**；tag/Release 现状以 `git tag -l 'v*' --sort=v:refname` 与 `gh release list` 为准。**已知历史缺口（不回填）**：0.77.3 / 0.78.0 / 0.86.0 / 0.88.0 / 0.97.0 / 0.107.0 有 CHANGELOG 段但无 annotated tag（audit-09 实测；本行不再声称"全部有 tag"）。 |
| 证据 | `M6-acceptance.md`、`M6-D5.md`、`M7-class-topics.md`、`M6-D4-rejected.md`、`M7-N10-adjudications.md`、`M7-N2-deferred.md` |
| 知识库 | `docs/调研/04`（A-MEM/Zep/Mem0）、`05-Sleep-time-Compute`、`06-MemOS`、`07-Letta`、`08-SimpleMem`、`09-Cognee`、`10-MemGPT`、`11-MemoryBank`、`12-LangMem`、`13-MIRIX`、`14-Generative-Agents`、`15-Graphiti`、`16-Mem0 论文`、`17-Hindsight 机制`、`18-CoALA`、`19-HippoRAG`、`20-RAPTOR`、`21-CRAG`、`22-LongMemEval`、`23-Self-RAG`、`24-MemoRAG`、`25-LLM-Agent-记忆综述`、`26-Reflexion`、`27-Zep-时序知识图`、`28-Mem0`、`29-MemGPT`、`30-GenerativeAgents`、`31-GraphRAG`、`00-索引与机制对照` |

## 三、下一步（2026-11-02 23:40 修订）

> **当前唯二未决项**：① 安装三步（`docs/安装指南.md` §1）→ 装完出 `first-live`/`repeat-report`；A3 现有 `replay-live` 离线证据（12 局全注入（跨作用域读数请看 m5 的 A5，不引本文件））；
> ② Q18（A 维持同域 / B 类级章节跨项目，预演 0%→41.7%）。审计侧已收敛：六轮独立审计 → 活文档 10/10（`reports/audit-06.md`）。

1. **N2 BM25：暂缓（有明确理由）**。`walk` 的契约是**零依赖**（文件头写明「不 import 任何模块」），
   接入 BM25 需要么内联 ~40 行、要么放弃零依赖；两条都要先有精度抽样作前提。
   做法顺序（与 `evidence/M7-N2-rejected.md` 一致）：独立倒排索引 → ≥20 条精度抽样 → 可回退融合权重。
   **在拿到 ≥20 条人工判定前不动 `walk`。**
2. **`node scripts/metrics-guard.mjs` 是回归闸**（0.36.0）：每轮先跑，不达标先修再谈优化。
3. ~~N1 双时态~~ **已完成**（0.37.0）：claim 侧 validFrom/validTo；claimEdge 待边落盘后再镜像。
3. **Q18 待裁定**：`class:*` 主卷是否允许跨工作区展示。**开关已实现但默认关**（0.49.0）：`crossScopeClass=true` 才放开，卡片标 `[跨项目]`，A5 分桶统计；选 A 则永久关闭。
4. ~~N9 卷首摘要~~ **已完成**（0.41.0）：`headline` 机械拼接、`cli volumes` 展示；进注入前需 A2b 对照。
5. **D5 线上观察**：遥测已就位（0.45.0）——真注入后跑 `node scripts/repeat-report.mjs`，看触发率/类别/token，并人工抽 10 条看误报。
6. **主人动作**：按 `docs/安装指南.md` §1 三步启用；装完跑 `node scripts/first-live.mjs` 生成首份上线复盘（当前 `liveReady=false`）。
7. **claim 类表对齐**（0.34.0）：历史 claim 只增不改，旧库不回溯合并，只对后续归档生效。
8. **已知取舍**：`u:` 层 claim 必须有同域证据棋谱才进卡片（换 A5=0）。

## 四、硬约束

- **禁止直推 `main`**：功能分支 → PR → 必需检查 → 合并 → release。
  - 说明：仓库为**公开**，`main` 由 **ruleset** 保护（`pull_request` + required check `rules` strict + 禁删除/强推）；本地 `pre-push` hook 仍保留作双保险。
- 发布前必跑：`node scripts/check.mjs`（退出 0）、`node --test`、`node scripts/release.mjs --dry-run`。
- **不发 npm**：版本发布只做 annotated tag + GitHub Release；`package.json` 保持 `private: true`。
- 每次功能实现都要版本号 + `CHANGELOG.md` 一段（写清更新内容）。
- 改 `AGENTS.md` 的硬规则前先在本文件记一条「决策」，说明依据。
- 文档/PR 引用代码用「文件 + 符号名」，不写裸行号（`reports/引用漂移说明.md`）。
- 不发密钥；不复制 `<KEYS>\`。

## 五、相关棋谱

本仓的 `kifu/` 暂无；M1 跑通后把本会话棋谱软链/复制进来。

## 六、给接手者的最短路径

1. 读本文件 → 2. `git status` + `git log --oneline -5` → 3. 读 `AGENTS.md` §10/§11 → 4. 干活 → 5. `node scripts/check.mjs` + `node --test` → 6. 更新本文件 → 7. 分支/PR/合并/release。
