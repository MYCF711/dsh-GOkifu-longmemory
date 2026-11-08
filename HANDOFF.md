# 交接文件（HANDOFF）· 2026-11-09 03:00

> 写给**下一个接手的会话**。本会话因长度过长归档。读这份 + 下列指针文件即可无缝接手。
> **当前版本 v0.8.86 · 仓库 `MYCF711/dsh-GOkifu-longmemory` · 宿主已于 2026-11-09 01:52 重启，新代码已上线。**

---

## 一、这个项目是什么（一句话）

DSH 的长期记忆插件（棋院 / Kifu-in）：每局会话结束后把「**踩过的坑 + 当时怎么修好的**」记下来，下次遇到类似任务递给模型——**只给事实，不给指令**，模型自己避开。不做压缩/工具/系统提示词/用户画像。

## 二、当前真实状态（重启后）

- **宿主已重启**（2026-11-09 01:52，pid 22228），**新代码已上线**（软链指向本工作区，版本 ≥0.8.83）。
- **改了 38 个版本（0.8.49 → 0.8.86），T1–T48 全部交付**，全部经 分支→PR→required rules→squash→release（**未发 npm**）。
- **全量测试 1216 条 / 1210 pass / 0 fail / 6 skip**，`check.mjs` PASS。

### ⚠️ 四项验证**待样本**（重启后真实数据还在攒）

重启验证脚本已跑过一次（3/7 PASS，4 NO-SAMPLE，无 FAIL）。以下四项**还没有足够样本**，需正常使用一段时间后复测：

| 项 | 期待 | 怎么验 |
|---|---|---|
| T12 abstain 误杀修复 | abstain 的 reason **不再全塌 cross-scope** | `node scripts/live-stats.mjs` |
| T10 signalPreview 完整信号 | 新卡样本 `signalPreview >160` 比例明显上升 | `card-samples.jsonl` 近 30 条 |
| T25 oncePerSession | 同一张卡**不再在同一会话反复注入** | `live-stats` 同 scope 同 digest |
| T28/T31 恢复事实上卡 | 卡上出现 ` · 恢复：后于 …` 尾注 | `node scripts/cli.mjs inject --shadow` |

**一键复测**：`node scripts/post-restart-verify.mjs`（T42，七项各出 PASS/FAIL/NO-SAMPLE + 证据）。**样本不足就 NO-SAMPLE，不许硬算过。**

## 三、核心结论（都已实测，别重新发现）

### ✅ 第一验收面「不重复踩坑」——**机制已证**（合成坑 ablation，同坑同题面同判分）

| 卡形态 | A 踩坑 | B 踩坑 | p |
|---|---|---|---|
| 指令式（T23） | 8.3% | 91.7% | 0.001953 |
| 事实型（T26） | 25.0% | 58.3% | 0.125 |
| 事实型+恢复事实（T29） | 8.3% | 66.7% | 0.015625 |
| **事实型+洞见层恢复事实（T39）** | **0.0%** | 66.7% | 0.0078125 |

**关键**：失败教训要连「**当时怎么修好的**」（恢复事实）一起给，模型自己会推出做法（A 提到 T23_TOKEN 12/12、读出并避开 11 条）。
**边界**：合成坑只证机制，**不等于真实历史坑复发率**，**不能当第一验收面已证**。恢复事实真库覆盖率 7.05%（T34，宁缺勿编）。

### ⛔ A2b 严格率 **认顶 46.6%**（118 题）/ 47.95%（146 题冻结考卷）

**四次尝试全 0**：T21（放宽 limit）/ T45（重排）/ T46（加检索通路）/ T48（换视图）。**机械判据到顶**，再往上必须换判分口径（模型判官或人工标注）。**别再走这四条路。**

### ⛔ 语义联想检索 **不接**（T43 负结果）

MiniLM embedding AUC 0.8386 vs 机械 0.8503（打平略输），related 标签 AUC ≈随机；冷加载 12s + 1GB RAM 进不了热路径。**失败点是口径错位（相关性 = 共享机制/同一实体，不是主题相似），不是模型容量。**

### ⚠️ 洞见层泛化 **未支持**（T40 负结果）

洞见层在**原坑**有效（T39 A 0%），但**跨坑变体不比 raw 好**（19.4% vs 11.1%，p=0.514）。**它的价值是「把原坑答案写得更易读」，不是「一张卡治一类坑」。** 别吹泛化。

### 其他已完成的硬修复

- **T12** abstain 误杀 77.3% → 0%（重放集），5 条正确拒绝全保留。
- **T25** oncePerSession 从 WeakSet（对象身份）改 session.id，同会话重复 −88.6%。
- **T35** file-exists 失效（**反向语义 expect:missing，路径出现才失效**）⇒ 不注入，消除负迁移 1.49%。
- **T16/T18/T20** 三个 sidecar 上限 64MB + 撞线留痕（**抬上限不轮转**——多个读者整文件读，轮转会静默少读）。
- **T33** trial 记录（recurred/avoided/unknown，只记录不退役，Zep 方向）。
- **T30** 归档层恢复索引（读时 1.22% → 2.37%）。
- **T34** 恢复事实分档 exact/same-file/same-tool（same-tool 是弱证据，单列）。
- **T37/T38** 洞见层坑类陈述 + 扩类 8→19 类（**扩类默认关**，不破坏 R09/D2 契约）。

## 四、下一步（按优先级）

1. **复测重启后四项**（见 §二）——等真实样本攒够，跑 `post-restart-verify.mjs`，把结果记进 `evidence/`。
2. **T8 冷却/衰减开启**：⛔ **条件阻塞**——库时间跨度需 **≥30 天** 且 `decay<0.5` 样本 **≥50 条**（现在库只有几天，开了等于没开）。**别硬开。**
3. **A2b 若要再抬**：只能换判分口径（模型判官/人工标注复核），机械路线已认顶。
4. **知识库继续**（现在 96 篇）：方向 = 记忆退役（T33 trial 攒数据）、负迁移测量、呈现视图（MemCompile）。

## 五、工程纪律（必须遵守，都是踩过的坑）

- **禁止重启/关闭 DSH、禁止 taskkill、禁止关 magpie**（铁律；重启只能用户做）。**改动靠软链生效，用户重启后跑 `post-restart-verify.mjs` 验证。**
- **分支→PR→required rules→squash→release（node scripts/release.mjs）**；**禁止直推 main、PR 分支永不强推**（BEHIND 用 `git merge origin/main` 追加 commit 或 cherry-pick 重建新分支）。
- **并行任务各自 worktree，禁止 `git add -A`**（会把别人半成品扫进主线——本会话踩过）。
- **成员的 in-progress 改动**：发版前 `git stash push -- <那些文件>`，发完 `stash pop`；pop 失败用 `git checkout stash@{0} -- <files>` 恢复。
- **ablation**：**跨环境回放真实失败不可判别**（T9/T17 两批 B 臂 0 复发）⇒ 用**合成坑**（T23 起）；合成坑必须**足够自然**（B 臂不踩就作废）；**判分只扫 tool/result**（卡正文不算复发）。
- **台账**：发版前 `node scripts/ledger-sync.mjs`（<6 小时）+ `ledger-check.mjs --full`；`check.mjs` 必过（含脱敏闸：本机路径不能进 git）。
- **版本**：`v0.9.0` 被旧版本线占用 ⇒ 一律 **patch**（`node scripts/version-suggest.mjs` 建议 minor 时也落 patch，理由写 CHANGELOG 段首）。

## 六、定时任务与 goal

- **定时任务** `schedule-2e33d1e9-70a1-4e41-af04-f6a1162efa32`（**每小时一次**，target = 本会话）：推进 `docs/任务书.md`。**归档后可删掉或改指到新会话**（`schedule_edit`）。
- **goal** `goal-54918632-971e-45d7-8c93-0d02ba8f497d`（active）：持续迭代。**归档后新会话自建 goal 续上。**
- **teams** `kifu-phase2`：6 名成员（deepseek `group/deepseek-v4.1-flash-1017` / reasoning=max），48 任务全部 completed。**建团队/派任务一律 `approval="automatic"`**；成员硬上限 8。

## 七、关键文件指针

| 想知道 | 看 |
|---|---|
| 当前状态/版本/六轴 | `MAINTENANCE.md` |
| 逐条任务 | `计划表.md`、`docs/任务书.md` |
| 改了什么 | `CHANGELOG.md` |
| 实测证据 | `evidence/`（带日期） |
| 项目手册 | `AGENTS.md` |
| 给新用户的说明 | `README.md` |
| 重启后怎么验 | `docs/重启验证清单.md` + `node scripts/post-restart-verify.mjs` |
| 第一验收面机制 | `evidence/T29-recovery-card-ablation.md`、`T39-insight-ablation.md` |
| A2b 为什么认顶 | `evidence/T21-a2b-attribution.md`、`T45-walk-anchor.md`、`T46-anchor-retrieval.md`、`T48-presentation-views.md` |
| 语义为什么不接 | `evidence/T43-semantic-retrieval.md` |
| 洞见层泛化为什么没证 | `evidence/T40-generalization.md` |
| 知识库（96 篇） | `docs/调研/` |

---

**一句话交接**：机制已证（恢复事实让模型避坑）、代码已上线（重启确认）、四项验证待样本。**下一步就是复测那四项，别重新发明轮子。**
