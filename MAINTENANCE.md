# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页；干完活必须回来更新「当前状态」与「下一步」。
> 仓库维护准则继承 `MYCF711/magpie-plugin-scaffold`：**禁止直推 main**；功能分支 → PR → 必需检查全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-kifuin`（私有） |
| 包名 | `dsh-kifuin`（**不发 npm**） |
| 当前版本 | `0.4.0` |
| 定位 | DSH 长期记忆系统（棋院 / Kifu-in）：棋谱入馆、相关边成网、定式可更新；只在相关时顺藤摸瓜 |
| 当前负责人 | Lead（superagent 会话） |

## 二、当前状态（2026-11-02 03:30）

```
分支         main（M1/M2 已合并）；M3 的 R11/R12/R13 在**工作树**里，等 Lead 走 分支 → PR → 合并
里程碑       M2 建网成线完成（0.3.0）；M3 顺藤摸瓜注入（影子模式）功能已落地、未发版
代码         R00–R11 + R12 inject(shadow) + R13 gates 起步 已落地；216 条测试全绿
```

| 资产 | 数量 |
|---|---|
| 方案 | `方案.md` v0.9 |
| 必读文档 | AGENTS / 边界 / 拷问记录 / 对标 |
| 房间 | R00/R01/R02/R03/R04/R05/R06/R07/R08/R09/R10(未)/R11/R12/R13/R14/R15 |
| 测试 | 216 条（`node --test` 全绿；150 基线 + T7a 17 + T7b 49） |
| 语料 | 92 日志 / 24 局 / 19 棋谱 / 784 主题 / 212 边 / 84 卷 / 128 claim；影子 20 信号 20/20 过闸 `[本] 2026-11-02 03:30` |
| 影子实测 | 20 条信号：闸门 20/20 通过、零注入 1/20、token 中位 253 / 最坏 292（预算 500）`[本] 2026-11-02 03:26` → `evidence/T7b-shadow.md` |
| 建边阈值 | `df≥2 && df<N && df≤max(2,⌈10%N⌉)`（S8；回退改 `linkEligible()` 一行） |

## 三、下一步

**M3 收尾（按顺序）**：

1. **合并与发版**：T7a（R11 walk）+ T7b（R12 inject / R13 gates）走 分支 → PR → `node scripts/check.mjs`/`node --test` 全绿 → 合并 → `0.4.0` + `CHANGELOG.md` 一段。
2. **`check.mjs` 房间清单**补 `walk/inject/gates` 三行（让 `--strict-rooms` 对 M3 有意义）。
3. **R13 余下七道闸**（1 作用域 / 2 证据门槛 / 2b 裁决独立性 / 3 有效性+适用条件 / 4 只增不改 / 5 来源纪律 / 7 事后降级）——见 `src/rooms/gates.mjs` 的 `PENDING_GATES` 与 `GATE_DOCS`。
4. **精度评审（开闸前必做）**：拿 `evidence/shadow/*.jsonl` 抽样，让人/独立成员判"这条该不该注入"，先算 precision 与 F8（关联过泛）比例；不达标就不开真注入。
5. **真注入那一刀（单独 PR）**：`agent/pre-step` 注入点 + 与压缩热清单并列互不代管 + 开关默认关；沿用 R13 全闸门 + 成本对照（首轮 ~35 tokens、命中 ≤292 实测）。
6. 验收口径不变：不命中零注入；预算 ≤500；provenance/时间戳 100%；影子模式写盘只在 `evidence/shadow/`。

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
