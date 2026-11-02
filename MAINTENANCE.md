# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页；干完活必须回来更新「当前状态」与「下一步」。
> 仓库维护准则继承 `MYCF711/magpie-plugin-scaffold`：**禁止直推 main**；功能分支 → PR → 必需检查全绿 → 合并 → `node scripts/release.mjs` 从与 `origin/main` 一致的提交发版。

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `MYCF711/dsh-kifuin`（私有） |
| 包名 | `dsh-kifuin`（**不发 npm**） |
| 当前版本 | `0.10.0` |
| 定位 | DSH 长期记忆系统（棋院 / Kifu-in）：棋谱入馆、相关边成网、定式可更新；只在相关时顺藤摸瓜 |
| 当前负责人 | Lead（superagent 会话） |

## 二、当前状态（2026-11-02 10:45 · 巡检）

```
分支         main = 0.12.0（M5 收口 + A2 收紧）；功能分支 → PR → 合并 → release
里程碑       M5 收口（0.11.0）：宿主入口默认关；六轴可复算；A1 空转、A3 仿真、定式 0（Q17 待裁定）
代码         R00–R15 + R16 plugin 全部在位；340 条测试全绿
```

| 资产 | 数量 |
|---|---|
| 方案 | `方案.md` v0.9 |
| 必读文档 | AGENTS / 边界 / 拷问记录 / 对标 |
| 房间 | R00–R15 全部在位 + R16 `src/plugin.mjs`（宿主入口，默认关） |
| 测试 | 341 条（`node --test` 全绿） |
| 延迟 | 热 p50 1.1–2.0ms / p90 4.7–20ms（判据 ≤50ms 达标）；p95 5.6–70ms 波动；冷 410ms 在插件加载 |
| 语料 | 92 日志 / 24 局 / 19 棋谱 / 780 主题 / 199 边 / 83 卷 / 125 claim `[本] 2026-11-02 03:40` |
| 真注入预演 | 假 session + 真语料跑 20 条信号：注入 **1/20**（297 tokens）、沉默 19、warn 0 `[本] 2026-11-02 04:20` → `reports/T9-REPORT.md` §5 |
| 闸门实测 | 存量 125 claim：闸 2 违规 **0**、闸 5 违规 **0**；20 张真实卡接上 records+scope 后 **2 过 / 18 红（全为 gate1/scope-mismatch）** `[本] 2026-11-02 03:50` → `evidence/T8b-gates-real.md` |
| 影子实测 | 20 条信号：闸门 20/20 通过、零注入 1/20、token 中位 253 / 最坏 292（预算 500）`[本] 2026-11-02 03:26` → `evidence/T7b-shadow.md` |
| 建边阈值 | `df≥2 && df<N && df≤max(2,⌈10%N⌉)`（S8；回退改 `linkEligible()` 一行） |

## 三、下一步

**主人已选「两个都做」（2026-11-02 10:45）：先装影子 + 裁定 Q17。**

1. **安装 = 主人动作**（按 `docs/安装指南.md` §1–2）：设置 → 插件 → 本地路径 → 选本仓库；配置 `enabled:false, shadow:true, storeRoot:null, shadowDir:null`。**先建库**：`node scripts/archive.mjs`。装完看 `evidence/shadow/shadow.jsonl` 是否出现。
2. **Hindsight 处置**：影子期**不关**（影子不注入、不耗 token，留作对照）；等真注入前只关 `autoInject`（改 `recall`→`off`），**不卸载、不清 bank**，以便随时回切。
3. **Q17 裁定（Lead 自裁 C，待主人可否决）**：命令签名泛化到 `tool + 操作类`，但**只生成 candidate 参考层**（不进 V1、必须 ≥3 局独立支撑 + 带 preconditions），实现排在下一刀。
4. **两边同点共存验证**：真注入开启后，核对一次真实会话的 `decision.messages` 顺序（两条记忆行相邻、互不覆盖）。
4. **注入台账**：真注入后把"注入了哪条卡"也记进 `evidence/shadow/*.jsonl`（现在影子模式已经记；真注入路径建议同记一份，便于事后复盘）。

**M4 收尾（按顺序）**：

5. ~~T8b 合并与发版~~ **已完成**（0.5.0）。
6. ~~R11 walk 按作用域过滤~~ **已完成**（path-walker 在 R11 落 `resolveScope`/`allowRecord`；R12 也传 `scope` 并留兜底 `filterHitsByScope`）。真数据 20 张卡从 2/20 过闸 → **20/20**，卡内越界行 0。
7. ~~CLI 把 `store/scope` 传给 runGates~~ **已完成**：`runGates({card, walkResult, store, scope})`；闸 1/2/4/5 在 CLI 路径上真核（`checks.*Checked` 有数）。
8. **闸 3 的核验供给方**：validity（file/commit/version）与 preconditions 需要 fs/git 探针，喂 `validityChecks`/`preconditionChecks`；建议新增只读 `scripts/gates-check.mjs`。在那之前 `gate3/*-unchecked` 一律记 unverified（不假绿，但也还没真核）。
9. **L4 人纠错落账**：`adjudicate({level:'L4-human-correction', votes:[{member:'human:owner', human:true, …}]})` 已能出 `decision:'correct'`；落账（写 correction + counter、不改原文）交聚合器。
10. **精度评审（开闸前必做）**：拿 `evidence/shadow/*.jsonl` 抽样，让人/独立成员判"这条该不该注入"，先算 precision 与 F8（关联过泛）比例；不达标就不开真注入。
11. 验收口径不变：不命中零注入；预算 ≤500；provenance/时间戳 100%；影子模式写盘只在 `evidence/shadow/`。

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
