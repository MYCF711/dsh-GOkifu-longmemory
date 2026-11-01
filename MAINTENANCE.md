# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页；干完活必须回来更新「当前状态」与「下一步」。
> 仓库维护准则继承 `MYCF711/magpie-plugin-scaffold`：**禁止直推 main**；功能分支 → PR → 必需检查全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-kifuin`（私有） |
| 包名 | `dsh-kifuin`（**不发 npm**） |
| 当前版本 | `0.5.0` |
| 定位 | DSH 长期记忆系统（棋院 / Kifu-in）：棋谱入馆、相关边成网、定式可更新；只在相关时顺藤摸瓜 |
| 当前负责人 | Lead（superagent 会话） |

## 二、当前状态（2026-11-02 03:55）

```
分支         main = 0.4.0（M3 已合并，#7）；T8b（R10 + 十道闸）在**工作树**里，等 Lead 走 分支 → PR → 合并
里程碑       M3 完成（0.4.0，影子模式）；M4 闸门全开（R10 adjudicate + R13 十道闸）功能已落地、未发版
代码         R00–R15 全部在位（含 R10 adjudicate、R13 十道闸）；257 条测试全绿
```

| 资产 | 数量 |
|---|---|
| 方案 | `方案.md` v0.9 |
| 必读文档 | AGENTS / 边界 / 拷问记录 / 对标 |
| 房间 | R00–R15 全部在位（R10 = `src/rooms/adjudicate.mjs`，R13 = 十道闸 + 边界） |
| 测试 | 257 条（`node --test` 全绿；216 基线 + T8b 41） |
| 语料 | 92 日志 / 24 局 / 19 棋谱 / 780 主题 / 199 边 / 83 卷 / 125 claim `[本] 2026-11-02 03:40` |
| 闸门实测 | 存量 125 claim：闸 2 违规 **0**、闸 5 违规 **0**；20 张真实卡接上 records+scope 后 **2 过 / 18 红（全为 gate1/scope-mismatch）** `[本] 2026-11-02 03:50` → `evidence/T8b-gates-real.md` |
| 影子实测 | 20 条信号：闸门 20/20 通过、零注入 1/20、token 中位 253 / 最坏 292（预算 500）`[本] 2026-11-02 03:26` → `evidence/T7b-shadow.md` |
| 建边阈值 | `df≥2 && df<N && df≤max(2,⌈10%N⌉)`（S8；回退改 `linkEligible()` 一行） |

## 三、下一步

**M4 收尾（按顺序）**：

1. **合并与发版**：T8b（R10 adjudicate + R13 十道闸 + R12 作用域过滤 + CLI 接线）走 分支 → PR → 合并 → `0.5.0` + `CHANGELOG.md` 一段。
2. ~~R11 walk 按作用域过滤~~ **已完成**（path-walker 在 R11 落 `resolveScope`/`allowRecord`；R12 也传 `scope` 并留兜底 `filterHitsByScope`）。真数据 20 张卡从 2/20 过闸 → **20/20**，卡内越界行 0。
3. ~~CLI 把 `store/scope` 传给 runGates~~ **已完成**：`runGates({card, walkResult, store, scope})`；闸 1/2/4/5 在 CLI 路径上真核（`checks.*Checked` 有数）。
4. **闸 3 的核验供给方**：validity（file/commit/version）与 preconditions 需要 fs/git 探针，喂 `validityChecks`/`preconditionChecks`；建议新增只读 `scripts/gates-check.mjs`。在那之前 `gate3/*-unchecked` 一律记 unverified（不假绿，但也还没真核）。
5. **L4 人纠错落账**：`adjudicate({level:'L4-human-correction', votes:[{member:'human:owner', human:true, …}]})` 已能出 `decision:'correct'`；落账（写 correction + counter、不改原文）交聚合器。
6. **精度评审（开闸前必做）**：拿 `evidence/shadow/*.jsonl` 抽样，让人/独立成员判"这条该不该注入"，先算 precision 与 F8（关联过泛）比例；不达标就不开真注入。
7. **真注入那一刀（单独 PR）**：`agent/pre-step` 注入点 + 与压缩热清单并列互不代管 + 开关默认关；沿用 R13 全闸门 + 成本对照（首轮 ~35 tokens、命中 ≤300 实测）。
8. 验收口径不变：不命中零注入；预算 ≤500；provenance/时间戳 100%；影子模式写盘只在 `evidence/shadow/`。

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
