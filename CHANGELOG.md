# CHANGELOG

> 每次功能实现都发版本并写在这里。**不发 npm**（私有自用），只发 GitHub Release + tag。

## 0.102.1（2026-11-03）

### N10 端到端演示（真实会话，无需重启即可验证）
- 真实 session id `1b9837d6-…`：`episode-fallback` 解析到 `w:d:/DeepSeek Harness/default-workspace`；
- 同一信号在该作用域下 **命中 5 条、渲染出真实卡片（tokens 276）**；
- 结论：宿主里只差一次重启加载新代码，注入就会发生。

### 验证
412 条测试（408 pass / 0 fail / 4 skip）；`check PASS`。

## 0.102.0（2026-11-03）

### N10：会话作用域兜底（修「插件在跑但永远 no-hit」）
- 根因：`session.cwd` 可能落在 `$DSH_HOME/profiles/...`，`scopeKeyFromPath` 得到没有棋谱的假作用域，walk 全被作用域闸挡掉。
- 两级兜底：① 本会话历史 episode 的 scopeKey；② 新会话读 `session.v4.jsonl.zstd` 第一帧 header 的真实 cwd。
- 心跳新增 `scope` / `scopeFrom` 字段，便于线上核对；兜底失败保持原样（不乱猜）。
- 实测：真实 session id → `episode-fallback` 命中 `w:d:/…/长期记忆系统`；同一信号在该作用域下命中 4–5 条、在 profile 作用域下 0 条。
- 4 条单测；证据 `evidence/M7-N10-scope-fallback.md`。

### 验证
412 条测试（408 pass / 0 fail / 4 skip）；`check PASS`。

## 0.101.0（2026-11-03）

### A3 状态：not-live → live-idle（插件已在宿主里跑）
- `memory-context/live-stats.jsonl` 出现并持续增长：1484 行（20:09–20:40），src=index.js（宿主加载器）。
- 动作全是 skip（no-signal 1428 · no-hit 56）：**还没有一次真正的注入尝试**。
- 存储完整性：`cli verify` OK（5485 文件 / 0 错误）；store 267 局 / 761 claim（宿主内 autoArchive 已归档）。
- `m5` 的 A3 改为消费心跳：有心跳 → `live-idle`（value=null）；出现 inject/failed 才 `live` 并计算失败率。
- 证据 `evidence/M7-A3-live.md`。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.100.0（2026-11-03）

### 对标文档刷新到今天的实测
- `docs/对标-Hindsight.md` §4.5 重写：A1 0%（覆盖 26/26）、A2 LOO 25.3% / holdout 24.2% / A2b 严格 89.5%（分桶 multiHop 15/15、openDomain 2/4）、
  A4 真实注入 p50 22.4ms / p95 32.9ms（Hindsight 4,715ms）、A5 越界 0、A6 100%、**A3 not-live**。
- 两条边界写死：① A2b 天花板由 A5 决定（N9 已验证作用域对齐时能取到真实失败原文，Q18 是开关）；
  ② A1 的 0% 是"被闸拦下"的 0%（26 条候选全部过闸判定），不是"没有负面候选"。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.99.0（2026-11-03）

### 知识库：调研 29 MemGPT
- [外] virtual context management：主上下文 + 外部存储分层、中断控制流、模型可编辑自身记忆。
- 对照：分层与我们"日志永不删 + 少量注入"同构；**模型自编辑记忆被本仓边界禁止**；
  中断点我们只使用宿主给的 `agent/pre-step`，不自造控制流。
- 两条可复用：分层省 token（token p50 ~248）；中断点必须来自宿主。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.98.1（2026-11-03）

### 装前预检 `scripts/preflight-bundle.mjs`（只读）
- 按 DSH 真实规则核对：bundles 每个包**声明了**哪些 patch、会插入哪些 id、这些 id 是否被 profile 的 patch 禁用。
- 真实 home 实测：`id=kifu-memory name=kifu-loader` 被正确插入，`PASS`。
- 只对本项目相关 bundle 判失败（其他插件被禁用是主人的选择，仅展示）。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.98.0（2026-11-03）

### 安装真相：bundle 必须自己声明 `dsh.bundle.patch`（否则宿主不读它的 patch）
- 从 DSH 实现里确认：`dsh.profile.bundles` 的每一项，宿主只读它在 package.json 里**声明**的 patch
  （`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`），不是"包里有文件就会读"。
- 因此 0.89 的别名包只进 bundles 没有声明 → 宿主什么都没插；profile 里两块 disabled 依旧生效。
- 修：`packages/kifu-loader` ① 自带 `cordis.patch.yml`（insert id `kifu-memory`、name `kifu-loader`）；
  ② package.json 声明 `dsh.bundle.patch`；③ 导出 `./cordis.patch.yml`。
- 生效判据不变：重启后 `live-stats.jsonl` 出现行。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.97.0（2026-11-03）

### N9 接线：按签名追回历史失败原文（只追加、受 A5 约束）
- `buildMemoryCard` 命中签名时追加索引条目（原文 + episode/seq/occurredAt），每信号 ≤2 条，不替换既有 claim。
- 归档成功后自动重建签名索引（失败只记一行，不影响归档）。
- 作用域对齐时实测：卡片第一行就是那条真实失败（`ep-8cc34e32, seq 7148`）。
- 现行 A5 下六轴不变：hit 19/19 · 严格 17/19 · 可读 17/19 · A1=0 · A5=0 · A4 4.5ms。
- **结论：A2b 89.5% 的天花板来自 A5（同作用域）而非检索**；Q18=B 才会看到提升。
- 证据 `evidence/M7-N9-verified.md`。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.96.0（2026-11-03）

### N9 第一步：签名索引（历史失败原文可检索）
- 新增 `src/rooms/sigindex.mjs`（读写索引、按时间倒序 lookup）+ `scripts/build-sigindex.mjs`（从棋谱边重建）。
- 真实库实测：**93 局 / 28,135 边 / 628 条失败原文 / 172 个签名**，索引落在 `<store>/signature-index.json`（派生、可重建）。
- 设计文档 `docs/N9-签名索引-设计.md`：注入侧下一步改为"按签名追加原文条目"，不替换现有 claim（N8 教训）。
- 3 条单测（写读/版本不符/lookup 排序与 limit）。

### 验证
409 条测试（405 pass / 0 fail / 4 skip）；`check PASS`。

## 0.95.0（2026-11-03）

### N8 否决（两版）+ 新增"卡片可读性"口径
- 实验一（类别不同就换 episode 条目）：严格 17→7（36.8%），大倒退，否决。
- 实验二（判别词 <2 时追加 episode 行）：指标全同基线，但追加的行与 claim 文本完全重复，只多烧 token，否决。
- 根因：walk 按**类别**召回，拿不到"该先例局里那条具体失败原文"；真修需检索层按**签名**匹配（记作 N9）。
- 代码已全部回滚；新增 `recallReadable`（卡片正文含签名 ≥2 判别词）= **17/19**，作为 N9 对照基线。
- 证据 `evidence/M7-N8-rejected.md`。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；inject 29 条全绿；`check PASS`。

## 0.94.0（2026-11-03）

### N7 否决：类级 claim 补"变体行" 对 A2b 严格 0 增益
- 用全量新建库（245 局 / 667 claim）对照：严格仍 **17/19**、hit 19/19、分桶不变（multiHop 15/15、openDomain 2/4）。
- 原因：两条失分的覆盖 claim 来自**别的类别**，同组变体救不到；要改的是严格口径的判定对象，不是产品。
- 代码已回滚；负结果入账 `evidence/M7-N7-rejected.md`，后续不再尝试这条路。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；18 条 claim 单测全绿；`check PASS`。

## 0.93.0（2026-11-03）

### A2b 诊断字段 + 两条失分归因（度量假象，不是召回失败）
- m5 的 A2b 采样新增 `hitByClaim / bestOverlap / bestText`，分桶也带 `hitByClaim`。
- 19 条冻结卷：hit 19/19、hitByClaim 19/19、严格 17/19。两条失分的覆盖 claim 文本来自**同局另一类错误的代表行**，
  判别词重合 1 和 0 —— 是"类级代表性文本"的度量假象。
- 结论：**不要**为这两条改排序、也不该指望 Q18=B 来救；真修需要扩展 claim 变体文本 + 重建归档，列入待评估不做。
- 证据 `evidence/M7-a2b-strict-artifact.md`。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；`check PASS`。

## 0.92.0（2026-11-03）

### A2b 分桶：失分全部在 openDomain（跨工作区）
- 按 LOCOMO 四类做机械分桶（temporal > multiHop > openDomain > singleHop），复算 19 条冻结卷：
  **multiHop 15/15 严格**、**openDomain 2/4 严格**（hit 4/4）；singleHop/temporal 本卷无样本。
- 结论：89.5% 的失分不是"普遍召回差"，而是跨工作区先例的**判别词没带出来**；Q18 若开 B，受益的正是这 2 条。
- 不改行为；证据 `evidence/M7-a2b-buckets.md`；m5 报告里新增「分桶（严格）」一行。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；`check PASS`。

## 0.91.0（2026-11-03）

### 知识库：调研 28 Mem0（生产级长期记忆）
- [外] 抽取→整合→检索；LOCOMO 四类问题（single-hop/temporal/multi-hop/open-domain）；相对 OpenAI 记忆 LLM-as-a-Judge +26%，图记忆再 +2%；对比全上下文 p95 延迟 −91%、token −90%。
- 对照：他们允许 ADD/UPDATE/DELETE，我们只增不改 + `supersededBy`（同样问题的两种解法，差异来自边界）；图记忆与我们 link 同构。
- 可复用：①"整合"是价值核心；②评测按 LOCOMO 四类分桶重算 A2b（已有冻结卷可扩展）。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；`check PASS`。

## 0.90.0（2026-11-03）

### doctor 识别别名包 + 文档对齐
- `install-doctor` 现在把 `kifu-loader` 别名视为启用；并在检测到历史 `disabled:true` 时补一条说明「不影响别名包，可忽略」。
- 新增单测：别名在依赖里 ⇒ 计为启用。
- `docs/安装指南.md` 顶部写明**当前安装方式 = kifu-loader，重启一次即生效**；`docs/交付清单.md` §2 同步改写（含回滚路径）。

### 验证
406 条测试（402 pass / 0 fail / 4 skip）；`check PASS`。

## 0.89.0（2026-11-03）

### 安装：别名包 `kifu-loader`（不改热重载开关就能启用）
- 历史遗留的两个 `disabled: true` 块会压过 bundle 列表，导致同名包永不加载；改 patch 又必须 DSH 关闭。
- 新增 `packages/kifu-loader`：只是把 `src/plugin.mjs` 原样再导出一次，profile 注册的是 `kifu-loader`（不在任何禁用名单里）。
- profile 侧：依赖 + bundles 增加 `kifu-loader`，移除原来的 `dsh-gokifu-longmemory` bundle（依赖保留），`pnpm install` 完成。
- 预检：导入成功、`apply` 注册 `agent/pre-step` + `agent/turn-stopping`、真实库无报错。

### 对比方案
- 直接改 patch：需 DSH 全程关闭 + 有热重载风险（本机事故历史）；
- 别名包：只改 profile 的 `package.json`（非热重载开关），重启一次即生效，失败可整包移除回滚。

### 验证
405 条测试（401 pass / 0 fail / 4 skip）；`check PASS`。

## 0.88.0（2026-11-03）

### 安全版 re-enable：失败也炸不了 DSH
- **运行中拒绝**：检测到 `DeepSeek Harness.exe` 在跑就退出（exit 2），一个字节都不写——这是唯一会炸 DSH 的路径。
- **先算后写**：JSON 解析、patch 结构校验（块数按条目计、无残留禁用块、结尾换行）全部在写盘前完成；不过就中止。
- **原子写 + 备份**：临时文件 + rename；写前备份 `*.bak-reenable-<ts>`。
- **写后读回校验**；**pnpm 失败自动回滚**（patch 与 package.json 恢复原样），并打印"已回滚，DSH 不受影响"。
- 依赖已就绪则跳过 pnpm（关掉到重开只需数秒）。
- `开启长期记忆.cmd` 改为按退出码显示三态：成功 / DSH 仍在运行（未改动）/ 失败已回滚。

### 实测（假 home）
| 场景 | 结果 |
|---|---|
| DSH 运行中（真实 home） | 拒绝，未写任何文件 |
| 正常（假 home，--force） | 摘除 2 块 + 1 注释，其它块原样，依赖/bundle 补上 |
| package.json 坏 JSON | 写前中止，patch md5 不变 |
| pnpm 强制失败 | 回滚成功：patch 恢复 6 条禁用、依赖回到未装 |

### 验证
405 条测试（401 pass / 0 fail / 4 skip）；`check PASS`。

## 0.87.0（2026-11-03）

### 零命令行启用：关掉 DSH 就自动装好
- 新增 `scripts/enable-on-exit.mjs`：后台常驻，轮询 `DeepSeek Harness.exe`；连续两轮不存在（DSH 已退出）后自动跑 `re-enable`，
  写完配置再跑一次 `install-doctor` 并记日志（`evidence/enable-on-exit.log`）。
- `re-enable` 增"依赖已就绪则跳过 pnpm install"：预置依赖后，关掉到重开的窗口从 ~30s 压到**几秒**。
- 用户侧零命令：预置依赖 → 关掉 DSH → 等 5–10 秒 → 重新打开。

### 验证
`re-enable --dry-run`：`bundle: 已有 · 摘除 3 条 · package.json 将改: false`；404 条测试全绿。

## 0.86.0（2026-11-03）

### 修正：`install-doctor` 的"已注册"是假阳性（你看到 `ok 插件注册` 但插件其实没启用）
- 两个根因：① 把 `storages/schedule.json` 也算注册（定时任务提示词里恰好含包名）；② patch 按块解析时把**注释行**吞进上一个块，
  注释里提到包名 → 被算成"启用 1 处"。
- 现在只看 profile 的 `cordis.patch.yml` / `cordis.yml` / `package.json`；注释作为块边界；只有**非 disabled 块或依赖/bundles**才算启用。
- 当前真实输出：`FAIL 插件注册（启用，而非仅出现） · 启用 0 处 · 禁用 2 处（只有禁用块 ⇒ 还没跑 re-enable）`。
- 新增 4 条单测（只剩禁用块 / 注释不算 / 依赖算 / 没有注册）。

### 验证
404 条测试（400 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.85.0（2026-11-03）

### D5 真实触发率测量：低频安全网，不是主收益
- 在 19 个"含同类错误文本"的会话、114 步上回放：**D5 触发 0 次**（按生产触发条件：行需 `Error:` 开头或含 exit code，且归入 8 类）。
- 口径限制写清：只用了**用户消息**，真实宿主 payload 含 tool 结果，因此本测量**低估**；不能说 D5 无用，也不能说有效。
- 正确姿态：D5 是低频安全网；装到宿主后先用 `repeat-report` 看真实触发率再调参。
- 证据 `evidence/M7-D5-real-rate.md`。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.84.0（2026-11-03）

### 容量观察：注入延迟随语料近似线性（117→167 局）
- 02:15：117 局/322 claim，注入 p50 15.1ms / p95 20.1ms（39 局回放）。
- 12:23：167 局/533 claim，注入 p50 **22.4ms** / p95 **32.9ms**（12 局回放）。
- claim ×1.65 ⇒ p50 ×1.48、p95 ×1.64，**近似线性**；仍远低于 A4 门槛（p95 ≤50ms）与 Hindsight（p50 4,715ms）。
- 外推：p95 触到 50ms 约在 800–1,000 claim；触发条件写明（连续两次 p95>40ms 再考虑索引）。
- 证据 `evidence/M7-latency-vs-corpus.md`。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.83.0（2026-11-03）

### 知识库：调研 27 Zep（时序知识图）
- [外] Graphiti 双时态知识图；DMR 94.8% vs MemGPT 93.4%；LongMemEval 准确率 +18.5%、延迟 −90%。
- 对照：双时态与我们 `validFrom/validTo` 同构（且我们有 validityOk 探针）；他们用 LLM 抽实体、我们机械抽取；单一来源是本项目刻意收窄。
- 结论：无新机制，但提供了外部证据——**时序是一等属性**，与"只增不改"的方向一致。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.82.0（2026-11-03）

### 交付清单 `docs/交付清单.md`（一页交接）
- 装法（一条命令 + 回滚）、六轴现状（含真实/合成两个口径）、关键证据索引、还差什么、常用命令。
- 目的：接手者在 1 分钟内知道"拿到了什么、怎么验、还差哪一步"。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.81.1（2026-11-03）

### 发版重试：GitHub API 间歇故障下的自愈
- 今天 API 多次 502/503，`gh release create` 失败会中断发版流程、且错误输出被吞成半截 JSON。
- `release.mjs` 现在对创建 Release **重试 5 次**（15s×n 退避），每次都打印可读错误；
  全失败时明确说"tag 已推、Release 未建"并给出可复制的补救命令，而不是抛栈。
- 发版链路其余部分（check → ledger → tag → push）保持原样。

### 验证
403 条测试（399 pass / 0 fail / 4 skip）。

## 0.81.0（2026-11-03）

### 知识库：调研 26 Reflexion
- [外] 言语反思进情景缓冲、下次决策读取；HumanEval pass@1 91%（当时 GPT-4 80%）。
- 对照结论：结构同构（失败教训→claim→注入），但**反思来源相反**——我们用机械抽取（可回放），它用模型生成（可能总结错）。
- 可复用的一条：**反思必须回到下一次决策**；我们的对应物是 D5（0.68.0 已收口，有闸内单测）。

### 文档更正：本插件没有"设置页 UI"
- 核对代码：`src/` 无 client 入口、`plugin.mjs` 无 settings 注册 ⇒ **只有 HTTP 配置路由 + 命令行**。
- 修正 `docs/安装指南.md` 验证第 2 条（改为 `live-stats` 心跳 / `cli stats` 局数）；证据 `evidence/M7-settings-ui-truth.md`。
- 装没装的唯一判据收敛为：**`live-stats.jsonl` 有没有行**。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.80.0（2026-11-03）

### 知识库：调研 25（LLM Agent 记忆机制综述）
- 综述给出了"来源 / 形式 / 操作 / 评估"四问骨架；逐条对照：我们四问**闭合**，且评估比综述的"主观/任务级"更硬（六轴 + 冻结卷 + 安慰剂）。
- 两处**刻意偏离**并写明依据：① 不用时间衰减/容量淘汰（红线：原件永不删，改用有效期 + stale 遮蔽）；② 不做多模态（纯文本工作区）。
- 结论：无新机制，可当检查清单用。

### 验证
403 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.79.1（2026-11-03）

### 台账时点窗口 20 分钟 → 6 小时（发版流程自锁的修复）
- 20 分钟窗口在"PR → required check → 合并"这段排队里必然过期，导致刚一合并就发不出版（今天实测卡住 0.79.0 两次）。
- 真正的护栏是**数字一致性**（`compare` 逐项比对局数/A2/A4/测试数），时点只负责抓"改完大事忘了 sync"；6 小时足够，且不会被流程本身卡死。
- 单测改用 10 小时前的时点断言"过旧"，2 小时前视为新鲜。

### 验证
6 条 ledger-check 单测全绿。

## 0.79.0（2026-11-03）

### A3 心跳：`live-stats.jsonl`（插件真的在宿主里跑过的证据）
- 每走完一次 pre-step 决策，向 `<sidecar>/live-stats.jsonl` 追加一行：`{at, action, reason, digest, tokens, shadow}`。
- 用途：**装了之后不用猜**——文件里有行 = 插件在真宿主里跑过；没有行 = 没加载或 `liveStats:false`。
- 默认开（`liveStats: true`），库不存在时不创建目录、不写心跳；仿真脚本（host-sim / replay-live）显式 `liveStats:false`，避免污染证据。
- 新增 `scripts/live-stats.mjs` 汇总（动作分布/原因/tokens p50·p95/最近 N 行）；`status-digest` 增加「A3 心跳」一行。
- 新增单测：默认写、关掉不写。

### 验证
403 条测试（399 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.78.0（2026-11-03）

### 一键开启脚本 `开启长期记忆.cmd`
- 双击即用：先提示「把 DSH 完全关掉」，再执行 `node scripts/re-enable.mjs`（自动备份 patch/package.json）。
- 解决的真实问题：主人重启 DSH ≠ 启用插件——**只重启不会加载它**，必须先跑 re-enable。
- **实测过两个致命 bug 并修掉**：① `cd /d "%~dp0"` 尾反斜杠把引号转义 → 改为 `"%~dp0."`；
  ② GBK 写入时 `scripts
e-enable.mjs` 里的 `
` 被当成回车 → 全改成正斜杠。
- 假 home 实测：摘除 3 条禁用、依赖补齐、`dsh-gokifu-longmemory` 在 patch 中归零。
- `re-enable` 增 **no-op 路径**：已是启用状态时不再重写 patch/package.json（避免重复备份噪音）。
- `docs/runbook-装完之后.md` §1 增加懒人路径。

### 验证
脚本已随仓库提交；`re-enable --dry-run` 仍报「摘除 3 条 · patch 将改 true」。

## 0.77.3（2026-11-03）

### 归档幂等性实测（真实库，连续三次）
- 第 1 次：`claims 322→533`、`episodes 117→167`——不是失真，而是**补齐了"当时没有 header"的会话**（审计子代理写完才有 header）。
- 第 2 次：+24（两次运行之间新产生的会话）、8 个活跃 episode 变大。
- 第 3 次：**0 新增**，仅 3 个活跃 episode 变大；claims/topics/links/threads/joseki 全同。
- 判据写进 `AGENTS.md` §5 陷阱 15 + `evidence/M7-archive-idempotent.md`：已封存数据重跑零变化，活跃会话会继续长。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`（语料已按新库刷新）。

## 0.77.2（2026-11-03）

### Runbook：装完之后按这个顺序跑（`docs/runbook-装完之后.md`）
- 六节：① 安装三步（人做）② 验收（doctor 的期望输出）③ 出第一份线上证据（m5/first-live/repeat/digest）
  ④ 日常巡检 ⑤ **回滚**（用 re-enable 的备份，不手改 patch）⑥ 已知正常现象（warn=5、exists:false、A3 not-live 等）。
- 每步都带**期望输出**，避免"装完不知道对不对"。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.77.1（2026-11-03）

### 冷启动演练 + 两处误报修正
- `status-digest`：无 store 时把 `ledger`/`guard` 标为 **N/A（无 store）**（此前误报 FAIL）。
- `install-doctor`：热路径抽测在"库不存在"时注明 `warn 为预期（插件沉默）`（此前 warn=5 看起来像故障）。
- 演练：空 home 上跑 digest/doctor **不崩**、不误报；"插件注册/记忆库内容"两项 FAIL 属于安装前的正常状态。
- 证据 `evidence/M7-cold-start.md`。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.77.0（2026-11-03）

### 一页状态摘要 `scripts/status-digest.mjs`
- 一条命令汇总：版本/git → **三道质量门**（check / ledger-check / metrics-guard）→ 六轴 → 安装状态（install-doctor）
  → **真实会话回放**（注入/沉默/跨作用域/p50·p95）→ 待决问题。
- `--write <path>` 可直接落盘（如 `evidence/status-digest.md`）；`--json` 供脚本消费。
- 工具会**复原 metrics-guard 的副作用**（`git checkout -- evidence/metrics-guard.json`），不污染工作树。
- 用途：以后巡检不用手工拼状态；也方便主人一眼看到"现在到底怎么样"。

### 验证
`node scripts/status-digest.mjs` 实跑：check/ledger/guard 全 PASS、六轴在、回放 12 局注入 12、跨作用域 0；
402 条测试全绿；`ledger-check --full PASS`。

## 0.76.1（2026-11-03）

### 调研索引 `docs/调研/00-索引与机制对照.md`
- 一页打通 01–24：按**机制**汇总（谁提出 → 我们的决定 → 依据文件），按**系统**逐篇列出取舍。
- 三条被反复验证的结论：评估必须在链路里、多层抽象要么模型要么机械拼、1 条样本差异不是证据。
- 用途：接手 agent 先读这一页，避免重复调研已否决的机制。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.76.0（2026-11-03）

### 冻结考噪声底：三次「看起来能涨」的实验全被安慰剂打掉
- N6 查询扩展（+1/+1）→ 随机主题词也 +1；
- N3 命中重排（不变）→ 随机重排也不变；
- **D2 细化三条类规则（+1/+1）→ 把同类信号映射到无关类，结果一模一样**。
- 结论：19 条样本 **±1 条 = ±5.3pp 的噪声底**；只有「真实改动 > 安慰剂最好一次」才算证据，1 条差异一律记噪声。
- 产品代码零变化（类规则已回退）；证据 `evidence/M7-noise-floor.md`，实验脚本 `exp-n3.mjs`/`exp-n6.mjs` 保留可复现。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.75.2（2026-11-03）

### N3-lite 否决：重排命中不是杠杆
- 新增 `scripts/exp-n3.mjs`：把 `walk.hits` 按 claim 支撑局数重排，再交给卡片；安慰剂 = 随机重排（8 种子）。
- 两卷结果**完全不变**（84.2% / 75.0%，tokens 一致）——卡片按 marker 优先级与时间选条目，命中顺序不影响入选集合。
- 判定 **reject**；证据 `evidence/M7-N3-rejected.md`。要动排序就得动排序函数本身，需单独对照。

### 候选池
N2 暂缓 · **N3 否决** · **N4 否决** · N5 未试 · **N6 否决**。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.75.1（2026-11-03）

### N4 否决：卷级降级没有消费者
- 39 局真实会话回放：**零注入 0/39**（注入 39、跨作用域 0、p50 15.1ms/p95 20.1ms、溯源引用 158）。
- 既然"空卡"在真实语料里不出现，N4 的降级路径永远走不到 ⇒ 按"指标先有消费者"否决；重开判据：零注入率 > 5%。
- 附带观察：2/39 首刀被 `gate4/unsuperseded-duplicate` 拒绝（闸按设计工作），说明"重复 claim 未标 supersede"是真实形态。
- 证据 `evidence/M7-N4-rejected.md`；`replay-live` 增 `warnSamples`（以后能看到闸拒绝原因）。

### 验证
402 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.75.0（2026-11-03）

### A2b 回归线（防"慢慢烂掉"）
- `metrics-guard` 除绝对下限 `0.55` 外，新增**相对冻结基线**的回归线：`strict < 0.8421 − 10pp` 即 FAIL，理由写明掉点。
- 依据：19 条样本 1 条 = 5.3pp，10pp ≈ 2 条，低于此算波动。
- 新增单测：持平 PASS、−8pp PASS、−14pp FAIL；证据 `evidence/M7-a2b-regression-guard.md`。

### 验证
402 条测试（398 pass / 0 fail / 4 skip）；`check PASS`；`metrics-guard PASS`；`ledger-check --full PASS`。

## 0.74.2（2026-11-03）

### 发版工具健壮性：`gh release create` 失败时的可诊断兜底
- 0.74.1 首次发版时 `gh release create` 失败（tag 已推、Release 未建），错误被吞成半截输出。
- `release.mjs` 现在：① 捕获 stderr 并打印；② 用 `--notes` 内联正文**重试一次**。
- 0.74.1 的 Release 已手动补建（`gh release create v0.74.1 --notes-file …`）。

### 验证
`check PASS`；401 条测试全绿；本版发布用于验证兜底路径。

## 0.74.1（2026-11-03）

### 调研清单漂移修复 + 守卫
- `MAINTENANCE.md` 知识库清单只列到 `19-HippoRAG`，实际已有 **24 篇**（20-RAPTOR/21-CRAG/22-LongMemEval/23-Self-RAG/24-MemoRAG 漏列）。
- `check.mjs` 新增守卫：**docs/调研 下每个编号都必须在 MAINTENANCE 或 AGENTS 里被提到**，缺一个就红（防止"写了调研却没进台账"）。

### 验证
检查器输出 `调研清单 24 篇`；401 条测试全绿；`ledger-check --full PASS`。

## 0.74.0（2026-11-03）

### N6 否决：机械查询扩展赢不过安慰剂
- 新增 `scripts/exp-n6.mjs`：只改信号扩展词，其余不变，跑 A2b 主考卷/跨卷，并自带 `--shuffle` 安慰剂。
- 结果：主考卷严格 84.2%→89.5%（+1）、跨卷 75.0%→83.3%（+1）、tokens 基本不变——**但随机扩展词也能涨 1 条**（3 次里 1 次）。
- 判定 **reject**：涨的那条是 `sed` 报错，strict 取决于"哪条覆盖 claim 恰好进卡"，可被任何扰动翻转。
- 证据 `evidence/M7-N6-rejected.md`；方法论：**先跑赢安慰剂，再谈优化**。

### 验证
401 条测试（397 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.73.1（2026-11-03）

### 知识库
- `docs/调研/24-MemoRAG`：全局记忆 + 草稿线索 + KV 压缩记忆 + RLGF 反馈；对照结论——
  `index.md` 只做存在性提示、**未参与 walk 起跳**，是结构上可对照的差距；记候选 **N6（机械版查询扩展）**，需 A2b 对照。
- 明确不做的部分：KV 压缩（压缩插件本职）、模型训练/RLGF。

### 验证
401 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.73.0（2026-11-03）

### Q19-B 预置：`preferenceHardOnly` 开关（默认关）
- `buildMemoryCard` 增 `preferenceHardOnly`：true 时丢弃 `soft` 偏好（理由句/闲聊），保留 `hard` 约束；默认 false ⇒ 行为不变。
- 插件配置同名键 + 归一化 + 透传；Q19 裁定为 B 时把默认值翻成 true 即可。
- **顺手修一个真 bug**：`storeView` 投影 claim 时丢掉了 `level` 字段，导致 hard/soft 分流永远拿不到值（写测试时发现）。

### 实测
- 401 条测试（397 pass / 0 fail / 4 skip）；新增「flag 开/关」对照用例。
- 12 局真实会话首条消息：开与不开**结果一致**（没命中 soft 偏好）⇒ 暂无可观测差异，如实记录在 `evidence/M7-preference-hard-flag.md`。

## 0.72.0（2026-11-03）

### 偏好类注入的噪声测量（不夹带改动）
- 本机库 322 条 claim 中 `preference` 110 条，其中 **40 条（36.4%）含祈使/指令词**；
  `antipattern` 仅 4/186、`fact` 0/26。
- 真实卡片里可见"理由句 / 闲聊 / 文档加粗语法"被当成偏好抽进来；且同一批偏好被反复复述。
- 证据 `evidence/M7-preference-noise.md`：给三个选项（维持 / 收紧到 hard / 降级为指针），**默认建议 B**。
- **本轮不改代码**：偏好语义属产品方向，需主人裁定（Q19）。

### 验证
400 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.71.0（2026-11-03）

### A4 的真实口径：注入路径 p50 18.3ms / p95 36.8ms（12 局真实会话）
- `replay-live` 新增 `injectionLatencyMs`：只统计每局第一刀（真正走 walk→card→gates），
  不再被 `oncePerSession` 短路稀释。
- 对照：bench-inject 合成 ≈2ms；Hindsight 本机 p50 **4,715ms** / p90 8,329ms ⇒ 我们仍快 ≈258×。
- 证据 `evidence/M7-latency-real.md`。

### 一次被证否的优化（已回退）
- 曾给 `persist` 加 mtime 解析缓存、给插件加 5s store 缓存；A/B 显示注入路径 p50 16.5→15.6ms（噪声内）、
  p95 31.2→51.8ms（更差）。真实注入是按 key 定点查，不是全量 list ⇒ **两处缓存全部回退，代码净变化为零**。

### 验证
400 条测试（396 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.70.0（2026-11-03）

### 新增 `scripts/replay-live.mjs`：真实会话回放（A3 的「准线上」证据）
- 取**最近 N 局真实会话**的日志（逐帧解），把首条用户消息按真实 `session.cwd` 喂给**真实插件入口**，
  走真实 store 的 walk/card/gates——不是合成信号。
- 统计：注入/沉默、延迟、**溯源引用数**、**跨作用域引用率**。
- 实测（12 局）：**注入 12 / 沉默 0 / warn 0**；p50 9.2ms、p95 18.9ms；溯源引用 54 条、**跨作用域 0 条（0.00%）**。
- 证据 `evidence/M7-replay-live.md`；单测覆盖 `cwdFromScope`（scopeKey→盘符路径）。

### 说明
A3 仍是 `not-live`（插件未被真实加载过）；本次是"真实语料 + 真实代码"的最强离线证据，
它的价值是：**跨作用域 0** 这次是在真会话上测出来的，不只是合成样本。

### 验证
400 条测试（396 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.69.1（2026-11-03）

### 知识库
- `docs/调研/23-Self-RAG`：按需检索 + 反思 token（ISREL/ISSUP/ISUSE）；对照结论——我们的「十道闸 + 不命中零注入」
  就是**不训练版的反思机制**，且多了可单测与可复核。
- 可引用结论：「检索系统的质量上限，取决于它怎么处理"不该检索"和"检索错了"」。

### 验证
399 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.69.0（2026-11-03）

### A1 不再空转：把「被闸拦下」也算锻炼（口径修正）
- 根因：`walk` 在生成卡片前就丢弃 `validityOk=false` 的 claim，而 H1 只把"渲染出来的"算覆盖 ⇒ 防护越早，覆盖越像 0。
- `runH1` 增 `exercised`（渲染 + 被闸拦下）；`validityCoverage.ratio = exercised / withValidity`；
  `m5` 的 `vacuous` 改为 `exercised === 0`，caveat 区分「没考 / 全被闸拦 / 部分渲染」三态。
- 实测：A1 仍 0%，但 **vacuous=false、覆盖 26/26、0% 被解释为"闸有效"**；注入行为未改。
- 证据 `evidence/M7-A1-exercised.md`；单测新增「闸拦也算锻炼」一例。

### 验证
399 条测试（395 pass / 0 fail / 4 skip；新增断言并入既有用例）；`check PASS`；`ledger-check --full PASS`。

## 0.68.0（2026-11-02）

### D5 收口（目标 ④：同类失败 ≥2 次补一次事实卡）
- 新增单测「**D5: 闸不通过 ⇒ 不补卡**」：证明 D5 走的是与首轮同一套十道闸，不会强塞。
- 证据汇总 `evidence/M7-D5-complete.md`：触发机械性、真注入、闸拦截、无祈使句、遥测四件套、对六轴无影响。

### 验证
399 条测试（395 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.67.0（2026-11-02）

### 安装彩排：在假 home 上跑通 re-enable 全链路
- 复制真实 profile 到 `tmp/rehearse-home/`，跑 `re-enable`（dry-run + 实跑）与 `install-doctor`：
  摘除 3 条禁用、补 `link:` 依赖、补 bundle、生成两份备份；复制体 patch 不再含本包。
- `install-doctor`：`ok 插件注册（未见 disabled）`、`ok 设置接口 GET status=200`（无 store 时 `exists:false`，符合零配置预期）。
- **真实 home 全程未被改动**（patch 4 处包名 / 6 条 disabled / 无依赖，三项逐条核对）。
- 证据：`evidence/M7-reenable-rehearsal.md`。

### 验证
398 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.66.0（2026-11-02）

### 知识库
- `docs/调研/22-LongMemEval`：五种长期记忆能力（抽取/多会话推理/时序/知识更新/**拒答**）与三阶段（索引/检索/阅读）。
- 对照结论：我们五种能力都在（知识更新半覆盖：`supersedes` 尚无生产者）；**"拒答=不命中就沉默"与基准口径一致**。
- 新增候选 **N5 事实增强键扩展**（需先用冻结集做离线对照，0.44 的关键词摘要实验已证明"直接改文本"无效）。

### 台账
- `MAINTENANCE.md` 下一步补「安装闸」状态：六轮审计收敛到活文档 10/10，安装三步与 Q18 是唯二未决项。

### 验证
398 条测试全绿；`check PASS`；`ledger-check --full PASS`。

## 0.65.1（2026-11-02）

### 测试口径修正 + 知识库
- `test/extract.test.mjs`、`test/graphread.test.mjs` 里 4 条"真实样本"测试改名为「**固定样本（未入库则跳过）**」，
  skip 时带原因（不再让人误以为"真实语料回归已跑过"）。这是 audit P2-5 的低成本处理；是否固化样本另议。
- `docs/调研/21-CRAG`：检索评估器 + 置信度降级 + decompose/recompose；对照结论——我们的「十道闸」就是机械版评估器，
  **不引入模型打分、不联网兜底**。

### 验证
398 条测试（394 pass / 0 fail / 4 skip，skip 原因已显式化）；`check PASS`。

## 0.65.0（2026-11-02）

### 新增 `scripts/boundary-audit.mjs`（边界静态审计，补 P2-8）
- 只扫**模型可见面**（`inject.mjs` 渲染 + `plugin.mjs` 消息构造）的字符串/模板字面量；
  剥注释、排除检测清单自身；命中即 exit 1。
- **接进 `check.mjs`**：PR 阶段就拦"往模板里写指令句"。
- 与运行时闸（`gates.mjs`）分工：静态管源码字面量，运行时管动态拼接与数据。

### 验证
398 条测试（394 pass / 0 fail / 4 skip）；`check PASS`（含 boundary-audit 0 处）；证据 `evidence/M7-boundary-audit.md`。

## 0.64.0（2026-11-02）

### audit-06：活文档随机 10 条 **10/10**（口径：排除 reports/** 与 docs/调研/**）
- 10 条陈述全部实跑复现：`cli dump`、delta 坏尾处理、`ledger-check` 条数一致、六轴判据三处同口径、
  A1 边界（0.04/0.05 通过、0.06 失败）、S13 候选数、`re-enable` 摘除 3 条、发版闸 `--full`。
- 三条卫生提示已修：S13 补时点与现值（4 候选 11/5/3/3）、`evidence/M7-ledger-check.md` 去掉已删选项、
  `MAINTENANCE.md` 补「该行需重启才能实测」。

### 安装闸证据
- 新增 `evidence/M7-install-gate.md`：六轮审计收敛记录 + 当前可交付状态 + **仍未验证项**（A3 not-live、Q18 未裁定、3 条 P2 候选）。

### 验证
394 条测试（390 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.63.0（2026-11-02）

### audit-05（第二轮随机 10 条实测，9/10）与其修复
- 唯一 FAIL 是**引用失效**而非事实失真：`reports/audit-03.md` 用裸行号引用 `ledger-check.mjs`，0.61.0 加 `--full` 后整片下移。
- 新增引用规范（`AGENTS.md` §2.4）：**文档/PR 引用代码一律「文件 + 符号名」，不写裸行号**；`reports/引用漂移说明.md` 记录本次漂移，历史审计报告不改。
- 纠正命名漂移：`AGENTS.md` §4.9 的 `fromJSON` 在仓内不存在，改为实际符号 `loadGraphAt`（对未知版本抛 `unsupported version`）。

### 知识库
- `docs/调研/20-RAPTOR`（递归摘要树）：我们只有**机械两层**（claim/棋谱 → 卷 headline），明确拒绝模型摘要与 embedding；「卷级降级」记为 N4 候选（需 A2b + token 对照）。

### 验证
394 条测试（390 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.62.0（2026-11-02）

### audit-04（随机 10 条陈述实测，9/10）修复
- `方案.md` §8.2c「当前基线」改为**以命令为准**并写明实测时点：holdout **33.85%（22/65）**、117 局（原写 35.56%/16/45/116 局）。
- `方案.md` 三处「86 个会话日志」改为「数量以 `cli stats` 为准」（实测已 134）。
- `docs/安装指南.md` 不再写死版本与测试条数（原写 0.50.0 / 379 条），改为指向 `MAINTENANCE.md`。
- `ledger-check` 新增守卫：**安装指南里出现版本号或「N 条」即 FAIL**（这正是「按它安装」最先读到的文件）。

### 诚实说明
- A2 曾在审计中被判「确定性」，实测在 26.5–26.8% 间随 pipeline 时间窗微动，故台账核对保留 **0.5pp 容差**并在代码注释写明；A4 保留 3ms 容差（单次抖动 ±2ms）。

### 验证
394 条测试（390 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`；审计报告 `reports/audit-04.md` 入库。

## 0.61.0（2026-11-02）

### audit-03 复核修复：让「台账自证」真正闭环
- 新增 `scripts/ledger-sync.mjs`：用现场实测**生成**台账的「测试 / 六轴 / 语料」三行（研究值 + 真实时点），
  不再人工抄写（漂移之源）。
- `ledger-check` 加严：纳入**局数 / A2 / A4**（容差 0.5pp / 0.5ms）、`--full` 缺测点/时点>20 分钟/
  解析失败一律 FAIL（fail-closed）；测试计数从失败进程的 stdout 解析，不再当 n/a。
- `release.mjs` 发版闸改为 `ledger-check --full`，**去掉 `--no-ledger` 逃生门**。
- 修 `MAINTENANCE.md` §四仍写「私有仓库/不支持分支保护(403)」的陈旧段（与 public+ruleset 矛盾）。
- 计划表修正：T22 不再把 0.34 的「claim 类表对齐」记在 0.22–0.24；T36 区间收窄为调研 15–16；
  T38 改为「调研 17–18 + 三轮审计 + 台账自证」。已发布清单补 0.15.0/0.15.2/0.17.0–0.17.3。
- `AGENTS.md` §7 兜底加严：任何「数字+条」或版本号写回都会红（此前只挡「条测试」子串）。
- 删除 claim 测试里残留的 `if (sample)` 空转块。

### 验证
394 条测试（390 pass / 0 fail / 4 skip）；`check PASS`；`ledger-check --full PASS`。

## 0.60.0（2026-11-02）

### 台账自证 `scripts/ledger-check.mjs`
- 把台账数字机械化核对：版本 / 测试（四个分量）/ claim / 卷，任一不一致退出 1；无 store 时跳过语料项并显式标注。
- 同时校验 `AGENTS.md` §7 仍是指针、`CHANGELOG.md` 有当前版本段。
- **接进发布流程**：`release.mjs` 打 tag 前先跑 `ledger-check --no-tests`，不一致中止（`--no-ledger` 可跳过）。

### 为什么现在做
audit-01 与 audit-02 两轮都因"文档写了不实数字"被判有条件通过。机械闸比"我记得更新"可靠。

### 验证
393 条测试（389 pass / 0 fail / 4 skip）；`ledger-check PASS`；证据 `evidence/M7-ledger-check.md`。

## 0.59.0（2026-11-02）

### 调研 19：HippoRAG（海马索引 + PPR）
- 知识图 + Personalized PageRank 模拟海马索引；多跳 QA 自报 +20%、单步检索比 IRCoT 便宜 10–30×、快 6–13×。
- 对照：我们的 topics/links/threads + walk 与之同构，**缺 PPR 全局扩散**；列为 **N3 候选**，
  前提是能用 A2b 严格 + hopPrecision 证明收益（当前 A2b 84.2%，无证据前不动排序）。

### audit-02 复核的修复
- **P1-3 死断言**：`check.mjs` 的 `\s` 在模板字符串里退化成 `s`，写回数字不会红。改成区间扫描（§7 出现「条测试」即失败），并做正反模拟验证。
- **P1-4 保护补强**：legacy protection 的 `required_pull_request_reviews=null` 不足以"需 PR"。新增 **ruleset**（pull_request + required_status_checks `rules` strict + 禁删除/强推），口径四处统一。
- **口径纠正**：26 条 `validFrom=null` 的 claim **都有 `occurredAt`**（旧代码未写该字段），此前写成"无 occurredAt"是错的；已改 CHANGELOG/契约/台账，并**披露归档会重写派生 claim 记录**。
- **测试补强**：删除 claim 测试里恒真的正则断言；给 `metrics-guard` 的 `a1Vacuous` 补单测（空转 vs 已覆盖）。

### 验证
389 条测试（385 pass / 0 fail / 4 skip）；`check PASS`；`metrics-guard PASS`。

## 0.58.0（2026-11-02）

### 独立审计 audit-01 的修复（有条件通过 → 处理 P1 全部 5 项）
- **P1-1** `validFrom` 真正落地（= `occurredAt`）；N1 空壳测试改成真断言。本机 322 条 claim 中 296 条有 `validFrom`，26 条 0.58 之前写入的历史条目（都有 `occurredAt`，旧代码未写该字段）不回溯改写。
- **P1-2** 新增 `representativeTextFor()`：建组与"更早支撑"共用，`class:` 前缀不再随输入顺序丢失；新增乱序一致性测试。
- **P1-3** `AGENTS.md` §7 的状态快照删除，改为「去哪看」指针；`check.mjs` 断言指针存在。
- **P1-4** 仓库口径统一为**公开**，并实际开启 `main` 保护：**ruleset**（pull_request + required check `rules` + 禁删除/强推；不做强制审批——单机单人无法自审）。
- **P1-5** `metrics-guard` 增 `a1Vacuous/a1Coverage`：A1=0 但 validity 覆盖 0 时显式标「空转」。

### P2 顺手修
- 巩固只吃 `kind=antipattern`；契约 §9 标注 `repeat` 派生、`threadIds`/`supersedes` 保留；台账数字带时间戳；
  门槛证据同步 0.55；删除 `DEFAULT_CONFIG` 重复键。

### 验证
388 条测试（384 pass / 0 fail / 4 skip）；`check: PASS`；`metrics-guard PASS`；审计报告入库 `reports/audit-01.md`。

## 0.57.0（2026-11-02）

### D5 影子遥测（开注入前就能观察）
- `shadow:true` 时 D5 也检测「同类失败 ≥2 次」，但**不注入**，只写 `repeat-hint.jsonl`（`shadow:true`）；
- 影子模式保证不改变 `messages`（单测断言）；遥测字段与正式一致。
- 用途：安装后先开影子跑一天，用 `repeat-report` 看"本来会补几次、哪些类"，再决定是否开真注入。

### 验证
385 条测试（381 pass / 0 fail / 4 skip）；`metrics-guard PASS`；证据 `evidence/M7-d5-shadow-telemetry.md`。

## 0.56.0（2026-11-02）

### 调研 18：CoALA（认知架构）+ 动作空间成文法
- `docs/调研/18-CoALA`：模块化记忆 / 结构化动作空间 / 决策过程；明确**工作记忆不归本仓**（属压缩插件）。
- `docs/记忆的职责边界.md` 新增「本仓的动作空间」表：检索、归档、纠错各做什么，以及
  **工作记忆管理 / 外部工具动作明确不做**——没有行 = 不归它。

### 验证
384 条测试全绿；`metrics-guard PASS`；只改文档。

## 0.55.0（2026-11-02）

### 调研 17：Hindsight 的实际机制（本机 skill 文档，非论文）
- 写出它的真实形态：每仓库一个 bank / commit seed + 代码库 survey + 对话摄入 / 首轮 LLM reflect /
  5 张固定知识页 / observations 作用域 / 失败降级链 / `Correction:` 纠错。
- `docs/对标-Hindsight.md` 增「机制级对照」附表：明确我们强在**逐个可回溯、零模型成本、毫秒延迟**，
  它强在**自动摄入代码与提交历史**（我们刻意不做）。

### 验证
384 条测试全绿；`metrics-guard PASS`；只改文档。

## 0.54.0（2026-11-02）

### Q18 预演：第二份冻结考卷 + 展示命中口径
- 新增 `evidence/a2b-set-cross.json`（12 条「跨项目唯先例」样本，`--cross` 冻结）。
- `measureA2b` 增加 `displayedHits / recallDisplayed`：**卡片行里真的出现当年那一局**才算展示命中。
- 新增 `scripts/q18-preview.mjs`：同时跑 A（关）/ B（开）两种口径并写 `evidence/q18-preview.md`。

### 实测（只读，无行为改动）
| 考卷 / 口径 | n | 覆盖 | 严格 | 展示命中 |
|---|---|---|---|---|
| 主考卷（现状） | 19 | 100.0% | 84.2% | 36.8% |
| 跨项目 · Q18=A | 12 | 100.0% | 75.0% | **0.0%** |
| 跨项目 · Q18=B | 12 | 100.0% | 75.0% | **41.7%** |

⇒ Q18=B 的可见收益是 **5/12**（A 恒为 0）；严格口径不变（文本命中与出处域无关）。

### 验证
384 条测试（380 pass / 0 fail / 4 skip）；`metrics-guard PASS`。

## 0.53.0（2026-11-02）

### 数据契约补齐（只改文档）
- 新增 §9 claim（含 `validFrom/validTo/validityOk/repeat` + 四条不变量）、§10 adjudication、
  §11 thread（`headline`）、§12 巩固（consolidation）、§13 配置（13 键默认值）、§14 版本与迁移纪律。
- 明确：新字段缺失按 null 处理，旧库不迁移、不重写历史文件。

### 验证
383 条测试全绿；`metrics-guard PASS`；证据 `evidence/M7-contract-sync.md`。

## 0.52.0（2026-11-02）

### 知识库
- `docs/调研/16-Mem0`（论文 abs 级）：抽取/巩固/检索三件套 + 图记忆变体；LoCoMo 上相对 OpenAI judge +26%、
  图记忆再 +2%、p95 延迟 -91%、token -90%+。
- 对照结论：我们的归档/合并/walk 与之同构，且**本来就是图**；唯一可做的是把「巩固」写成契约一节（只改文档）。

### 验证
383 条测试全绿；`metrics-guard PASS`。

## 0.51.0（2026-11-02）

### 新增 `scripts/first-live.mjs`（首次上线复盘）
- 一条命令把「注册状态 / 热路径抽测 / 六轴门槛 / 影子本来会注入什么 / D5 触发几次」合成
  `evidence/first-live.md`，并给出 `liveReady` 判定（注册无禁用 + 门槛通过）。
- 缺影子或遥测时明确写「不存在/没有遥测」，不编数字。
- 本机当前输出：`liveReady=false（disabled=4，guard=PASS）` —— 如实反映"还没执行 re-enable"。

### 验证
383 条测试（379 pass / 0 fail / 4 skip）；`metrics-guard PASS`。

## 0.50.0（2026-11-02）

### 安装指南改成单页版
- 重写 `docs/安装指南.md`：三步启用（dry-run → 退出 DSH 执行 re-enable → 重开后 install-doctor/metrics-guard）、
  零配置默认值表、三项验证、四种回滚、已知限制与排障表。
- 纠正过时内容：默认已不是 `enabled:false/shadow:true`（0.15 起为零配置）；`install-doctor`、`cli audit`、
  `cli facts --at`、`repeat-report` 全部纳入指南。

### 验证
379 条测试全绿；`metrics-guard PASS`。

## 0.49.0（2026-11-02）

### Q18 预留实现：`crossScopeClass` 开关（**默认关，行为不变**）
- 打开后仅 `class:*` 类级章节可用跨工作区先例；卡片行尾标 `[跨项目]`；
- A5 统计把 `[跨项目]` 行单列（`crossMarkedLines`），不进主 A5 分子/分母；
- 默认关闭：A5 仍 0.00%（29 行）、跨标记行 0，与 0.48.0 行为一致。

### 待裁定
- Q18=A 则永久关闭；Q18=B 则开启并新建第二份冻结考卷（不改原 19 条）。

### 验证
379 条测试（375 pass / 0 fail / 4 skip）；证据 `evidence/M7-q18-cross-scope-flag.md`。

## 0.48.0（2026-11-02）

### A2b 增加「跨项目唯先例」分桶（为 Q18 量化上限）
- 冻结集 19 条里，`sameScope=false` 的样本 10 条；其中 claim 文本可对上 **7** 条。
- **明确标注**：这 7 条不是现状收益（A5 要求同域证据，展示行仍是同域的那局），只是 Q18 放开后的**上限估计**。

### 验证
378 条测试全绿；`metrics-guard PASS`（A2b 严格 16/19）；证据 `evidence/M7-a2b-cross-bucket.md`。

## 0.47.0（2026-11-02）

### 新增 `cli facts --at`（双时态查询）
- 回答「某时点上哪些 claim 为真」：`validFrom ≤ at` 且（无 `validTo` 或 `validTo > at`），invalidated 永不返回。
- 起始时间回退链：`validFrom → occurredAt → support 最早时间`；`--at` 非法退出码 2。
- 本机：`at=2026-11-02` 有效 184 / 303；`at=2020-01-01` 有效 0（时间轴单调）。

### 验证
378 条测试（374 pass / 0 fail / 4 skip）；证据 `evidence/M7-cli-facts-at.md`。

## 0.46.0（2026-11-02）

### 知识库
- `docs/调研/15-Graphiti`（时序上下文图谱工程实现）：事实有效期 / invalidate 不删除 / episode 溯源 /
  增量构图 / 混合检索（语义+BM25+图）。
- 对照结论：我们除「BM25 混合检索」外的机制都已具备；新增候选 **`cli facts --at <date>`**（"某时点为真"的只读查询面）。

### 验证
377 条测试全绿；`metrics-guard PASS`。

## 0.45.0（2026-11-02）

### D5 遥测（为真注入后的观察做准备）
- D5 补卡成功后向影子目录写 `repeat-hint.jsonl`：`{at, cls, count, tokens, digest}`，**只放机械量**；
  写失败只 warn，不影响注入。
- 新增 `scripts/repeat-report.mjs`：总次数 / 涉及会话 / 类别分布 / token 均值；无台账退出码 2。

### 验收口径
触发率 = 触发次数 ÷ 有失败的新会话数；预期只在「同类失败 ≥2 次」的会话出现；人工抽 10 条看误报。

### 验证
377 条测试（373 pass / 0 fail / 4 skip）；证据 `evidence/M7-d5-telemetry.md`。

## 0.44.0（2026-11-02）

### A2b 严格口径判据修正（不是产品改动）
- 旧实现「第一条覆盖 claim 就 break」会把"卡里同时有类级章节"的情况误判为失分；
  改为「任一覆盖 claim 文本与签名 ≥2 判别词重合即算命中」。
- 冻结集 19 条：严格 **63.2% → 84.2%（16/19）**；覆盖仍 100%；A1/A5/A6 不变。
- 剩余 3 条为一次性具体错误（old_string / DNS / sed），不在 8 类表内。

### 尝试并回退
- 给类级 claim 文本追加「关键词摘要（词: …）」：A2b 严格**无变化**，已回退（不给代码加无用复杂度）。

### 验证
375 条测试全绿；证据 `evidence/M7-a2b-strict-semantics.md`。

## 0.43.0（2026-11-02）

### A2b 冻结评估集（`evidence/a2b-set.json`）
- `scripts/a2b-set.mjs --freeze` 固化「切点后 + 有当年先例」的失败签名（当前 19 条，同域 9）；
  `m5-report` 与 `metrics-guard` 自动使用快照，**分母不再随语料漂移**。
- 纪律：不得为了让数字好看而重冻；重冻须在 PR 写明理由，两套都报。

### 验证
375 条测试（371 pass / 0 fail / 4 skip）；`metrics-guard PASS`（A2b 严格 0.6316，n=19 固定）。

## 0.42.0（2026-11-02）

### `scripts/re-enable.mjs` 加固：精准摘除
- 旧版会「从标记注释截到文件末尾」（可能删掉后续配置），且只处理一条禁用条目。
- 新版 `stripDisableBlock()`：只删含包名且 `disabled: true` 的条目块 + 相关注释，其余原样保留；
  本机 dry-run 显示将摘除 **3 条**（1 条注释 + 2 条 disabled 条目）。

### 验收路径
退出 DSH → `node scripts/re-enable.mjs` → 重开 → `node scripts/install-doctor.mjs`（应显示「未见 disabled」）→ `metrics-guard`。

### 验证
373 条测试（369 pass / 0 fail / 4 skip）；证据 `evidence/M7-re-enable-hardening.md`。

## 0.41.0（2026-11-02）

### N9 · 卷首摘要（机械拼接）
- thread 新增 `headline`：`<类名> · N 局 · 最近 YYYY-MM-DD · 代表：<l0≤60>`；不调模型、不生成新文本。
- `cli volumes` 直接展示 headline；`docs/数据契约.md` §4.4 已补字段。
- **不进注入路径**（A1/A5/A6 不受影响）。

### 验证
370 条测试（366 pass / 0 fail / 4 skip）；`metrics-guard PASS`（A2b 严格 0.6316，n=19）。

## 0.40.0（2026-11-02）

### 方案 §8 口径收口（文档）
- 新增 **§8.2c**：holdout / A2b 覆盖 / A2b 严格三口径；明确「A2 只作背景值，声称收益必须给 A2b 严格 + n」。
- 新增 **§8.2d**：A3 的 `simulated` 与 `live` 分界与验收命令；未达 live 前不得写成「线上 0 失败」。

### Q18 的 A/B 实现草案（`docs/拷问记录.md`）
- A：现状（同域证据，A5=0）。
- B（推荐）：只对 `class:*` 类级章节放开跨域证据，卡片标 `[跨项目]`，A5 口径拆出 A5-class；预估 3 处改动，等主人拍板。

### 知识库
- `docs/调研/14-Generative-Agents`（记忆流/反思/动态检索；只借鉴"卷首摘要"，不做模型反思）。

### 验证
369 条测试全绿；`metrics-guard PASS`。

## 0.39.0（2026-11-02）

### 新增 `scripts/install-doctor.mjs`（安装后自检）
- 五项只读检查：注册（含 `disabled:true` 识别）/ 设置接口 / 库 verify / 证据目录 / host-sim 抽测（failed 必须 0）。
- 本机实跑 PASS；**发现插件在 `cordis.patch.yml` 里注册了两条且都 `disabled: true`**（历史改名残留）。

### 验证
369 条测试（365 pass / 0 fail / 4 skip）；证据 `evidence/M7-install-doctor.md`。

## 0.38.0（2026-11-02）

### 真实 store 下的宿主仿真（A3 simulated 证据刷新）
- `host-sim --store $DSH_HOME/memory-context`：40 首轮 × 2 次 ⇒ injected 24/40、failed 0、warn 0、
  session.append 0、p50 3.3–3.7ms、p95 5.5–6.0ms、tokens p50 248。

### 知识库
- `docs/调研/13-MIRIX`（六类记忆对照；确立 Procedural/Semantic 区分与我们一致）。

### 说明
- 仍是 simulated，不是线上；真机安装待主人执行 `scripts/re-enable.mjs`。

## 0.37.0（2026-11-02）

### N1 · 双时态字段 validFrom / validTo
- claim 出生带 `validFrom = occurredAt`；**人纠错**（L4 correct）与**核验失败**（validityOk=false）写 `validTo`。
- 只加字段，不改原文、不删条目；`cli audit` 新增「有效期已止」计数（本机 22 条）。

### 指标护栏口径修正
- `metrics-guard`：A2b 严格门槛 0.60 → **0.55**，并把样本量 n 打进输出。
  依据：同一 store 重复测量观察到 0.611–0.667 的跳动（样本仅 18 条，1 条 = 5.6pp）。

### 验证
366 条测试（362 pass / 0 fail / 4 skip）；`metrics-guard PASS`；证据 `evidence/M7-N1-bitemporal.md`。

## 0.36.0（2026-11-02）

### 指标护栏 `scripts/metrics-guard.mjs`
- 一条命令判定 A1/A5/A6/A4/A2b：不达标退出 1，并写 `evidence/metrics-guard.json`。
- 门槛：A1 ≤5% · A5 =0 · A6 =100% · A4 p50 ≤50ms · **A2b 严格 ≥0.60** · A2b 覆盖 =1.00。
- 缺值视为不达标；`judge()` 纯函数进单测（CI 可跑逻辑，数据判定在本地）。

### 说明
- A2b 严格本轮 12/18 = 66.7%（分母随类级章节自愈 +1），不是回归；门槛按样本量定 0.60。

### 验证
365 条测试（361 pass / 0 fail / 4 skip）；`metrics-guard PASS`。

## 0.35.0（2026-11-02）

### 类级章节自愈
- `claim.mjs`：`ensureClassClaims()` —— 有 ≥2 局支撑却缺类级 claim 的错误类，补一条 `class:<name> · <代表错误>`；
  support 取各单条支撑的并集，id 由「类名 + 作用域」决定 ⇒ 幂等；**不删、不改写旧条目**。
- 本机效果：有类级章节的类 **4/6 → 6/6**（补 module-missing、policy-human-turn）；claim 291 → 293。

### 新增 `scripts/class-audit.mjs`（只读）
- 每类：单条 claim 数 / 覆盖局数 / 是否已有类级章节 / 若受控重算可折叠多少条。

### 验证
361 条测试（357 pass / 0 fail / 4 skip）；A1/A5/A6 不变；证据 `evidence/M7-class-self-healing.md`。

## 0.34.0（2026-11-02）

### 修：claim 的类表与 topic 的类表不一致
- `claim.mjs` 的 `ERROR_CLASSES` 只有 5 类，而 `topic.mjs` 有 8 类 ⇒ `module-missing` / `permission-denied` /
  `timeout` 在**卷**里能成主卷，却从不合并成类级 claim（实测 `class:module-missing` 有 7 局，但无对应 claim）。
- 现已对齐到 8 类。注意：历史 claim 是只增不改的，旧库里的逐条 claim 不会回溯合并，**只对后续归档生效**。

### 尝试并回退
- 为 5 条不可召回样本试加 `path-not-found` / `edit-anchor-missing` / `network-blocked` 三类：
  A2b 严格 **无变化（12/17）**，已回退，不进代码。

### 验证
360 条测试全绿；A2b 严格仍 70.59%；知识库新增 `docs/调研/12-LangMem`。

## 0.33.0（2026-11-02）

### A2b 严格口径 47.06% → 70.59%
- **度量保真**：A2b 的信号补上「类级错误实体」，与插件热路径同口径（8/17 → 10/17）。
- **产品改动**：类级 claim 文本改为 `class:<name> · <代表错误>`，跨写法可命中（10/17 → **12/17**）。
- 覆盖口径保持 17/17；A1/A5/A6 不变（0.00% / 0.00% / 100%），A4 p50 1.88ms。

### 剩余
- 5 条未命中：ENOENT 类不在 8 类表内、或为一次性具体错误；扩类需先做严格口径对照。

### 验证
360 条测试全绿；证据 `evidence/M7-A2b-strict-7059.md`。

## 0.32.0（2026-11-02）

### A2b 两口径：覆盖 vs 严格
- 覆盖：卡片里的 claim 的 support 包含「切点前出现过该签名的棋谱」 ⇒ **100%（17/17）**。
- 严格：覆盖 + claim 文本与该签名 **≥2 个判别词重合** ⇒ **47.06%（8/17）**。
- `walk`：claim 有多局支撑时，**优先用与当前作用域相同的那局**做证据载体（卡片日期/棋谱对得上项目）。
- 纪律：声称收益必须给「A2b 严格」，覆盖只作上限参考。

### 验证
360 条测试全绿；证据 `evidence/M7-A2b-injection-recall.md`。

## 0.31.0（2026-11-02）

### A2b 注入召回（新指标）
- 对切点后「以前出现过的失败签名」，用签名建信号跑 walk+card，检查卡片 provenance 是否命中当年棋录。
- 基线：**29.41%（5/17）**；同域可达子集 **62.5%（5/8）**；10/17 只有跨工作区先例（当前策略不可达）。
- A2 从此只作背景值，**声称收益必须给 A2b**。

### 待裁定
- **Q18**：是否允许 `class:*` 类级主卷跨工作区展示（会把 A5 从 0 变成非 0）。已写入 `docs/拷问记录.md`。

### 验证
360 条测试全绿；证据 `evidence/M7-A2b-injection-recall.md`。

## 0.30.0（2026-11-02）

### A2 口径修正：时间切分 holdout
- `runEval({splitAt})`：memory = 切点之前的局，test = 之后的局；`m5-report` 固定切点 `2026-11-02T00:00Z`。
- 当前：全量 LOO 24.67%（会随语料增长）/ **holdout 35.56%**（16/45，test 9 局）。
- **不追认历史 A2 增量**：旧 CHANGELOG 里的 23.40/23.61/23.97/24.32 受语料增长影响，跨时点不可比。

### 验证
360 条测试全绿；`node scripts/m5-report.mjs` 同时输出两个口径；证据 `evidence/M7-A2-holdout.md`。

## 0.29.0（2026-11-02）

### N10 · 人纠错（L4）机械回填
- 归档时读取 `adjudications/`：只认 `L4-human-correction + decision=correct`。
- 给目标 claim 追加 counter（episode=`human:owner`、quote=纠错原文）、state 标 `disputed`；
  **原文/support/条目都不改不删**，幂等重放不重复计数。
- L2 裁决与 `hold-disputed` 不动 claim。

### 说明
本机当前 0 条 adjudication ⇒ 没有线上可回填样本；本轮 A2 显示 24.67% 属语料刷新，不计入 N10 收益。

### 验证
360 条测试（356 pass / 0 fail / 4 skip）；证据 `evidence/M7-N10-adjudications.md`。

## 0.28.0（2026-11-02）

### 新增 `cli audit`（只读健康检查）
- 统计 claim 总数/状态、**被遮蔽**（过期 validityOk=false / invalidated / 无支撑）、卷数与类级主卷 Top5。
- 存在无支撑 claim ⇒ 退出码 1（可接 CI）。
- 本机：282 claim（过期 22、无支撑 0）、138 卷、4 个类级主卷。

### 验证
359 条测试（355 pass / 0 fail / 4 skip）；证据 `evidence/M7-audit-cli.md`。

## 0.27.0（2026-11-02）

### 新增 `cli volumes`（棋书视图）
```bash
node scripts/cli.mjs volumes [--limit n] [--json]
```
- 类级主卷（`class:*`）排最前，其余按局数降序；输出总卷数/主卷数/每卷局数。
- 本机：138 卷 · 4 个主卷（module-missing 7 局、fs 读改写 6 局、web-search 4、sandbox 3）。

### 验证
358 条测试（354 pass / 0 fail / 4 skip）；证据 `evidence/M7-volumes-cli.md`。

## 0.26.0（2026-11-02）

### 类级错误成卷（棋书主卷）
- `thread.mjs`：`class:*` / `t:error:*` 主题只要求 `df ≥ minKifus`，不再套「df ≤ 10%N」上界。
- 效果：卷数 127 → **138**，类级主卷 **0 → 4**（fs 读改写 7 局、web-search-empty 4 局等）。
- 卷是视图（多对多、删卷不删谱），不影响 A1/A2/A5；357 条测试全绿。

## 0.25.0（2026-11-02）

### 设置页显示库状态
- `GET /kifu-longmemory/config` 返回 `stats {exists, episodes, claims, updatedAt}`。
- 卡片显示「当前库：N 局 · M 条教训 · 更新于 …」；库不存在时提示会自动建库。

### 说明
- 本轮试过的两处扩大召回（额外 3 个错误类、首条消息路径实体）实测 A2 **0 变化**，已回退，不进 CHANGELOG 当收益。

### 验证
357 条测试（353 pass / 0 fail / 4 skip）；证据 `evidence/M7-settings-stats.md`。

## 0.24.0（2026-11-02）

### 错误类表 5 → 8 类
新增 `module-missing`（Cannot find module / ERR_MODULE_NOT_FOUND）、`permission-denied`（EACCES/EPERM）、`timeout`（timed out/ETIMEDOUT）。

### 修：class 主题不再冒充 same-error
`class:*` 主题只建 shared-topic 边；否则同一对棋谱会出现两条 same-error（R05 实测 2 !== 1）。

### 回退：N2 多词兜底
该分支从未执行（S10 单条词兜底先命中），已删；A2 当时的 +0.36pp 属语料刷新噪声，见 `evidence/M7-N2-rejected.md`。

### 实测
A2 **23.61% → 24.32%**（+0.71pp，n=148）；A1 0.00%；A4 p50 2.30ms；A5 0.00%；A6 100%。

## 0.23.0（2026-11-02）

### 首条消息的类级错误信号（D2 类主题的消费方）
- 首条消息里出现已知报错原文（五类）⇒ 追加实体 `class:<name>`，exact 命中类主题。
- 效果：A2 收益 **23.40% → 23.61%**（+0.21pp）；A1 0.00%、A4 p50 1.78ms。
- 证据：`evidence/M7-class-signal.md`；356 条测试全绿。

## 0.22.0（2026-11-02）

### 类级错误主题（跨会话连接）
- 错误事件/失败边除原文主题外，再挂 `class:<name>` 主题（`fs-read-before-write` 等五类，与 D2 同口径）。
- 只连已知协议类；语法/模块类保持原文。
- 实测：A2 收益 **21.97% → 23.40%**（+1.43pp）；A1 0.00%、A4 p50 1.78ms、A5 0.00%、A6 100%。
- 证据：`evidence/M7-class-topics.md`；355 条测试全绿。

## 0.21.0（2026-11-02）

D5：会话内二次命中（主人批准，按推荐实现）。

### 规则
- 只看新增消息里的错误行（`Error:` / `[exit code: N≠0]`），按 D2 的类归一。
- 同会话同类失败累计 ≥2 次 ⇒ 补一次事实卡；每会话最多 1 次。
- 仍走 `decidePreStep → 十道闸`：事实、带 provenance、无祈使句。

### 配置
`repeatHint`（true）、`repeatHintAfter`（2）、`repeatHintMax`（1），设置页可见。

### 验证
单测覆盖触发/上限/首次不触发；354 条测试全绿。

## 0.20.0（2026-11-02）

### 修 R1 · 作用域越界（A5 34.62% → 0.00%）
- claim 必须用**同作用域**的棋谱承载证据；`scope=null`（只放用户层）时不做该检查。
- 效果：独立复核越界行 9 → 0，A2 收益不降。

### 修 R2 · 过期 claim 仍被注入（A1 8.33% → 0.00%）
- 归档时跑一次 `runValidityCheck`，把 `validityOk` 写进 claim（本机 20 条过期 / 1 条有效）。
- walk 跳过 `validityOk=false`：过期条目不注入，原文与 support 仍保留（只遮蔽可见性）。

### 六轴（116 局 store）
A1 0.00% · A2 21.97% · A3 not-live · A4 p50 1.89ms · A5 0.00% · A6 100%

## 0.19.1（2026-11-02）

D4（失败→修复配对）试做后**否决并回退**。

- 全量 248 条 claim 只出 2 条 fix，且两条都是错误配对（路径/因果无关）。
- 精度约 0%，会把无关成功当成“上次这样修好的”，比不做更糟。
- 已回退实现，证据留档：`evidence/M6-D4-rejected.md`；重做前置条件写在该文件。

## 0.19.0（2026-11-02）

D1：近实时增量入馆——记忆库不再只靠手动/首次建库。

### 新增
- `agent/turn-stopping`：轮次收尾时若 `manifest.updatedAt` 超过 `autoArchiveMinutes`（默认 30），后台跑一次归档（单飞锁，不阻塞会话）。
- 配置新增 `autoArchive`（默认 true）、`autoArchiveMinutes`（默认 30），设置页可见可改。

### 实测
- 全量重建：store 102 → **116 局**；当天覆盖 **7/19 → 18/18（100%）**。
- 归档 16.9s 在后台完成，不占对话步骤。

## 0.18.0（2026-11-02）

按当天真实样本（22 局 / 164 失败边 / 12 条跨局重复）落地 D2 + D3。

### D2 · 同类协议错误合并
- `errorKeyOf` 增加类映射：`fs-read-before-write` / `tool-unavailable` / `sandbox-limit` / `policy-human-turn` / `web-search-empty`。
- 只合并环境/协议类；`SyntaxError`、`Cannot find module` 等保留具体原文。
- 实测：读-改协议 10 条散 claim → **1 条 15 局支撑**；team limit → 9 局；goal-human-turn → 5 局。

### D3 · 跨局重复优先
- `compareHits` 顺序改为：档位 → depth → **repeat 降序** → weight → 时间。
- 失败命中与 claim 用「路径归一后的错误原文」互相包含匹配，把 claim.support 的局数带到 hit 上。
- 公开 hit 增加 `repeat` 字段（>1 = 反复踩过的坑）。

### 验证
- 352 条测试全绿（含 D2/D3 新测试）；`check PASS`。
- 证据：`evidence/M6-D2D3.md`。

## 0.17.3（2026-11-02）

新增 `scripts/re-enable.mjs`：一条命令恢复被临时禁用的插件。

```bash
# 先完全退出 DSH
node scripts/re-enable.mjs          # 加 --dry-run 只看会改什么
# 再打开 DSH
```

它做三件事（改前都备份）：删 `cordis.patch.yml` 末尾的临时禁用块、把 `link:` 依赖与 bundle 条目加回 profile、跑一次 `pnpm install`。

## 0.17.2（2026-11-02）

**修启动卡死**：web boot 卡在 `dsh-gokifu-longmemory: pending`，等 `@deepseek-ai/dsh-client-ui-settings`。

### 根因
- 浏览器半侧声明了 `inject: ['@deepseek-ai/dsh-client-ui-settings']`，该客户端模组在本机模块图里不会被解析 ⇒ 宿主永远 pending，界面打不开。
- 我们没有真的需要它：卡片只用宿主自带的 `slots` 服务。

### 修复
- `inject` 改为空；`apply` 先检查 `ctx.slots.inject/register` 是否存在，缺失就安静返回（绝不阻塞启动）。
- `dsh.client` 只留 `{ platform: 'web' }`。

### 复现与验证
- 实机：启动卡 pending（另一会话定位）；本版移除注入依赖后不再等待。
- 350 条测试全绿；`check PASS`。

## 0.17.1（2026-11-02）

设置卡片改用 `document.baseURI` 解析接口地址（与 dshmarket 一致）：反向代理前缀 / 桌面 `dsh-app://` 页面下也能读到配置。

## 0.17.0（2026-11-02）

**设置里可以选记忆库地址了（GUI）。**

### 新增
- **浏览器半侧 `client.js`**：注册「设置 → 长期记忆（棋院）」分区 —— 一个地址输入框 + 保存按钮，保存后显示当前生效路径。
- **宿主接口** `GET/POST /kifu-longmemory/config`：读写 `<DSH_HOME>/kifu-longmemory.json`；`profile` 配置优先于该文件。
- 用户配置优先级：**profile 配置 > kifu-longmemory.json > 默认值**；文件损坏只按空处理，不影响会话。

### 校验
- 地址必须是绝对路径或留空（相对路径 400）；布尔/数字字段类型校验；写入用临时文件 + rename 原子替换。
- 新增 3 条接口单测；350 条测试全绿。

## 0.16.0（2026-11-02）

**设置页可见：记忆库地址（storeRoot）等配置有 GUI 字段了。**

### 新增
- `src/plugin.mjs` 导出 `Config`（设置表单 schema）：`enabled` / `shadow` / **`storeRoot`（记忆库地址）** / `autoBuild` / `budgetTokens` / `limit` / `oncePerSession`。
- `storeRoot` 留空 = `<DSH_HOME>/memory-context`；填路径即生效（校验时自动去空白、空串回落默认）。
- 设置 → 插件 → **dsh-gokifu-longmemory** 里即可看到并修改这些字段，不用手改 JSON。

### 验证
- 新增单测：schema 必须暴露 storeRoot、validate 归一化；347 条测试全绿。

## 0.15.2（2026-11-02）

**可安装性修复：之前"设置里找不到插件"是因为包缺 bundle 清单。**

### 修复
- 新增 `cordis.patch.yml`（`insert: kifu-longmemory`），`package.json` 增加 `main` / `exports` / `dsh.bundle.patch` / `engines.dsh` / `files`。
- 宿主按 `dsh.bundle.patch` 把插件插入 profile 插件树；缺这个字段时包能装但不会出现在插件列表。

### 安装（三选一）
- 设置 → 插件 → 从本地目录安装：选本仓库根目录；
- 或 `cd <DSH_HOME>/profiles/desktop && pnpm add link:<本仓库路径>`，再把 `dsh-gokifu-longmemory` 加进 `package.json` 的 `dsh.profile.bundles`。

## 0.15.1（2026-11-02）

改名 **dsh-gokifu-longmemory** + 公开仓库脱敏。

### 改名
- `package.json` / 插件 name / 注入消息 `source.kind` / 裁决 schema → `dsh-gokifu-longmemory`。
- 仓库 `MYCF711/dsh-gokifu-longmemory`（旧地址自动重定向）。

### 脱敏（公开仓库前）
- 清掉：内网 IP、本机密钥目录名、本机用户目录、真实会话 UUID、本机绝对路径。
- 数据类证据只保留结构（`<ep>` / `<session-id>` / `<workspace>` 占位），测试夹具改用合成 id。
- **`scripts/privacy-scan.mjs`**：公开仓库的脱敏守卫（内网 IP / 用户目录 / 密钥 / 真实 UUID / 私钥）；接入 `scripts/check.mjs`，CI 会拦。

## 0.15.0（2026-11-02）

**改名 + 零配置 + 开源**：从 `dsh-kifuin` 改为 **`dsh-kifu`**；仓库转公开。

### 改名
- `package.json`：`name: dsh-kifu`；仓库 `MYCF711/dsh-kifu`（旧地址自动重定向）。
- 文档里的安装名、命令示例同步。

### 零配置（装完即用）
- **默认 `enabled: true`、`shadow: false`、`autoBuild: true`**（此前默认关）。
- 库不存在时：本次**沉默**（不注入），后台自动跑一次归档建库（`autoBuild`），下一轮生效；失败只 warn、不重试风暴。
- 用户最多只需填一个保存地址（`storeRoot`，缺省 `<DSH_HOME>/memory-context`）。
- `autoBuild: false` 可关自动建库；`enabled:false` 可完全停用。

### 实测
- 346 条测试全绿（含新增自动建库用例）。
- 安全：库不存在/构建失败/闸门不过 ⇒ 一律原 decision，不阻塞会话。

## 0.14.0（2026-11-02）

影子台账复盘工具：装完就能一眼看出"本来会注入多少、多长、哪些信号命中"。

### 新增
- **`scripts/shadow-report.mjs`**：读 `evidence/shadow/shadow.jsonl`（只读），输出：
  - `wouldInject` / `silent` / `silentRate`
  - `tokens`（会注入卡的 p50/p90/max）与 `tokensAll`、`silentIndexOnlyTokens`
  - `topSignals`（按信号词频）、`claimsPerCard`
- 台账不存在 ⇒ 退出码 **2**，不伪造 0。
- **`test/shadow-report.test.mjs`**：2 条（正常统计 / 缺台账）。

### 说明
- 影子卡没有命中时 `section:null`、`tokens` 只有 INDEX 行（约 16），报告把两类分开统计，避免把"沉默"算成"注入"。

## 0.13.0（2026-11-02）

Q17 裁定 C 落地：定式长出「参考层」（只作 candidate，不进 V1）。

### 新增（R08）
- **`generalizeCommand`**：命令 → `tool + 操作类`（`node --test` → `cmd:node test`；github 参数 JSON → `tool:github commits`）。
- **`promoteReferenceJoseki`**：泛化签名 **≥3 局独立支撑**才出候选；`layer:'reference'`、`entersV1:false`、`state:'candidate'`、必须带 `preconditions`（原文命令）。
- **archive**：参考层与精确层并列写入 store（`j-ref-*`）。

### 真实语料（100 局）
- 参考层候选 **2 个**：`tool:github path`（8 局）、`tool:github contents`（5 局）
- 精确层仍 **0**（真实命令参数高度 episode 特异）
- 343 条测试全绿

> 这一层的定位写死：**只回答“历史上这类操作成功过”，不进第一验收面（V1）**，避免把一次偶然成功当通用招法。

## 0.12.0（2026-11-02）

A2 口径收紧：只把"像错误"的签名算进 repeat/novel。

### 变化
- **`scripts/eval.mjs`**：新增 `ERROR_ONLY_RE` 与 `signaturesErrorOnly / repeatError / novelError / rateErrorOnly`；全量口径保留。
- **`scripts/m5-report.mjs`**：A2 主值改用 error-only 口径，caveat 同时给全量对照。

### 实测（2026-11-02 05:40）
- **A2 = 19.18%（14/73，1σ±4.61%）**；全量口径 13.89%（15/108，含非错误文本）
- A4 p50 1.23ms；A5 0%（6）；A6 100%（6）；A1 0/9 空转；340 条测试全绿

> 说明：审核指出原口径 35% 的"repeat"不是错误文本；收紧后数字更高（19% vs 14%），因为分母也变小了——**两个口径都保留**，不再只报一个。

## 0.11.0（2026-11-02）

独立审核（T18）后的必修项全部落地：CI 转绿、安装指南可照做、口径更正。

### 修复（审核阻断项）
- **F1 CI 红**：`test/plugin.test.mjs` 不再依赖 `$DSH_HOME` 环境变量（显式注入 + 还原）；`env -u DSH_HOME node --test` 现在退出 0。
- **F2 安装指南**：补「怎么注册插件」（设置 → 插件 → 本地路径 / tarball）、`storeRoot: null` 推荐写法、卸载与回滚步骤；插件新增 `<DSH_HOME>` / `$DSH_HOME` 占位符展开（无 home 时按"未配置"处理，不再解析成相对路径）。

### 更正（口径）
- **F3 redteam 计数**：control 组单独统计 —— **坏样本 10/10 拦住、0 泄漏；控制组 1/1 未被误杀**（此前"11 个坏样本"是错的）。
- **F4 A4 门槛**：方案 §8.2 判据是 **p50 / p90 ≤50ms**；实测 p50 1.1–2.0ms、p90 4.7–20ms 达标；**p95 在 5.6–70ms 间波动**（GC），不再声称"p95 达标"。
- **F5 台账**：语料统一为 store manifest 实测 **92 局 / 780 主题 / 199 边 / 83 卷 / 125 claim**；MAINTENANCE 的 0.7.0/327/待发 0.6.0 全部更新。
- **release.mjs**：发布前查询该提交的 CI 结论（`--require-ci` 时不一致即中止）。

## 0.10.0（2026-11-02）

负迁移防线演练：11 个坏记忆样本全部被闸门拦住（A1 的"闸门有牙"证据）。

### 新增
- **`scripts/redteam.mjs`**：把坏记忆逐条喂 R12/R13，断言被对应闸门拦住；退出码 0 = 全拦。
- **`evidence/M5-redteam.md`**：11 案例表（时间戳/日期/跨域/支撑/过期/覆盖/quote/摘要源/祈使句/预算）。
- **`test/redteam.test.mjs`**：子进程跑演练，断言 total 11 / leaked 0。

### 结果
- **11/11 拦住，0 泄漏**；340 条测试全绿。
- 这是"机制有牙"的证据，不是线上负迁移率；A1 线上值仍受 validity 覆盖率限制（0/8）。

## 0.9.0（2026-11-02）

宿主仿真：A3 从 `not-live` 升级为 `simulated`；修掉闸 3 的逐次 fs/git 开销。

### 新增
- **`scripts/host-sim.mjs`**：用真实插件入口 + 真实 store 跑 N 个"新会话首轮"；假 session 的 `append` 一旦调用即抛错；输出注入率/失败率/延迟/tokens。
- **`evidence/M5-host-sim.md`**：40 会话 × 2 轮 + 20 会话带间隔的实测。

### 修复
- **R12 `PROBE_CACHE`**：闸 3 validity 核验按 `validity key + workspace + 60s 桶` 缓存 ⇒ host-sim p95 从 62–115ms 降到 **40–47ms**。

### 实测（仿真，非线上）
- attempts 40 · injected 16（40%）· empty 24（60%）· **failed 0** · warn 0 · **session.append 0**
- p50 2.9–4.0ms · p95 **40.2–47.4ms** · max 56.8–113.5ms（GC）· tokens p50 **300**

> A3 仍是 `simulated`，不是线上；`m5-report` 里仍记 `not-live`，两者同时保留。

## 0.8.1（2026-11-02）

延迟收口：A4 p50 1.14ms / p95 5.55ms，**p95 门槛达标**。

### 变化
- **R12**：`storeView` 按 cache 对象缓存（WeakMap）——每次卡片不再重建 claims/episodes 映射。
- 六轴 A4 重算：**p50 1.14 ms / p90 3.48 / p95 5.55 / max 103.1**（50 次；max 是单次 GC 尖峰）。
- `evidence/M5-latency.md` 更新为三轮修复对照。

### 六轴复算（2026-11-02 05:02）
A2 13.33%（105）· A4 p50 1.14ms（50）· A5 0%（6）· A6 100%（6）· A1 0/9 空转 · A3 not-live；339 条测试全绿。

## 0.8.0（2026-11-02）

M5 收口：六轴一条命令可复算 + 安装指南。

### 新增
- **`scripts/m5-report.mjs`**：一条命令算 A1–A6（`--store --workspace --json --evidence`）；每轴 `{value,unit,n,status}`；缺数据记 `not-consumed`（**不写 0**）；零模型调用。
- **`docs/安装指南.md`**：前置检查 → 影子模式 → 看数据 → 真注入 → 回滚 → 已知限制（明确"安装由主人执行"）。
- **`test/m5-report.test.mjs`**：六轴结构、A6 100%、A1 无 validity 时 not-consumed。

### 六轴真实值（2026-11-02 04:57，零模型调用）
| 轴 | 值 | 状态 |
|---|---|---|
| A1 `staleTransferRate` | 0.00%（9 条；**覆盖率 0/8，空转**） | measured（vacuous） |
| A2 `repeatFailureRate（LOO）` | **13.33%**（14/105；1σ±3.32%；coverage 79.2%） | measured |
| A3 `injectFailureRate` | 0.00% | **not-live**（未上线） |
| A4 p50 | **4.11 ms**（n=50） | measured |
| A5 `crossScopeLeakRate` | 0.00%（n=6 卡） | measured |
| A6 `provenanceCoverage` | **100%**（n=6 卡） | measured |

> 纪律：A2 是机械代理、不是收益；A1 的 0% 是空转；A3 未上线。三条都写进报告，不许对外省略。

## 0.7.1（2026-11-02）

定式 0 的根因查清：补了"命令成功"语义，仍不足以长出定式。

### 新增
- **R03 `commandSuccesses`**：`tool/result` 以 `[exit code: 0]` 结尾 ⇒ 可验证成功（独立字段，不破坏边桶闭合）；带命令原文、seq、time。
- **R08** 消费 `commandSuccesses`（与边成功合并后再提定式）。
- **R11 S10**：claim 文本直接含信号判别性词也可命中（此前只能经 support 棋谱或主题 key）。

### 真实数字（2026-11-02 04:55，25 局 root）
- 有成功信号 **12/25**；成功条数 **105**（S11 前 54）
- 跨 ≥2 局重复的成功签名 **1 条**（`{"path":"user"}` 噪声）
- 定式候选仍 **0** ⇒ 不是"没算命令成功"，是真实命令高度 episode 特异
- 328 条测试全绿

> 定式要不要泛化签名（`bash:测试` / `edit:配置`）是**方向问题**，记 Q17 待裁定；按防过拟合默认**不泛化**（S12）。

## 0.7.0（2026-11-02）

M5 第二阶段：闸 3 从 unverified 变真核验 + H1 机械代理基线。

### 新增
- **`scripts/gates-check.mjs`**：只读核验 CLI（`--store --workspace --now --json`）；`file`（存在 + 可选 sha256/mtimeMs）、`version`（裸版本 / `pkg@x.y.z`）、`commit`（`git cat-file -e`，5s 超时）；单条失败只记 reason 不抛。
- **R13 `probeValidity` / `runValidityCheck`**：`runGates({validityResults})` 认三种键；无结果仍记 `gate3/validity-unchecked`（**不假绿**）。
- **R12 plugin**：注入路径只核本卡条目；`probeValidity:false` 可关。
- **`scripts/eval.mjs --h1`**：`staleTransferRate` = 注入条目中 validity 核不过 ÷ 注入条目；分母 0 记 `null`。

### 真实数字（2026-11-02 04:39）
- gates-check：带 validity **8 条** → **0 过 / 8 不过**（`version-package-not-found` 3、`version-file-unreadable` 2、`file-missing` 3）
- H1：28 信号 → 注入 9（去重）· stale 0 → **staleTransferRate 0.00%（0/9）**
- **覆盖率 0/8**：带 validity 的过期记忆属于另一个工作区，R11 走不到 ⇒ 0% **不等于没风险**
- 327 条测试全绿

## 0.6.2（2026-11-02）

注入延迟第二次收紧：主题精确索引 + 闸门记录查找走缓存。

- **R11**：`createWalkCache` 增 `topicsByKey`（精确匹配快路径）与 `get(kind,id)`；`matchTopics` 先查索引，未命中才扫描。
- **R13**：`runGates` / `buildResolver` 接受 `cache`，记录查找不再逐个 `store.get` 读盘。
- **plugin**：把 cache 传给闸门。
- **基准**：`scripts/bench-inject.mjs` 扩到 50 次采样，输出 p50/p90/p95/max。

### 实测（2026-11-02 04:45）
- 热 **p50 3.9–5.3 ms**；p90 20.9–56.4；p95 46.3–107.2（GC 波动）；max 110–123
- 冷缓存 355–667 ms（插件加载时预热）
- 298 条测试全绿

> 结论：p50 达标；p95 未稳定达标（GC 尖峰），不承诺 p95。

## 0.6.1（2026-11-02）

注入延迟修复：把 1,281 次文件读挪出 pre-step 热路径。

### 变化
- **R11 `createWalkCache`**：一次读出 episodes/topics/links/claims，`walkFromSignals({cache})` 走内存。
- **R12 `buildMemoryCard({cache})`**：claims/episodes/topics 从缓存读，不再每次 `store.list`。
- **plugin 预热**：`apply()` 时构建缓存（一次性），首轮注入走热路径；失败只 warn，不影响会话。
- **`scripts/bench-inject.mjs`**：冷/热 + p50/p90/p95 基准。

### 实测（2026-11-02 04:40，10 信号 × 5 轮）
- 冷缓存 **548 ms**（移到插件加载）
- 热 **p50 5.1 ms** / p90 50.8 / p95 62.7 / max 118.9（偶发 GC 尖峰）
- 298 条测试全绿

> 口径：`方案.md` §8.2 目标 ≤50ms/步；p50 达标，p95 在阈值附近，尖峰待压。

## 0.6.0（2026-11-02）

M5 起步：真注入的宿主入口（默认关）+ 留一局（LOO）机械评测。

### 新增
- **R12 宿主入口 `src/plugin.mjs`**：`apply(ctx, config)` 挂 `agent/pre-step`；接缝照抄压缩仓（`await next()` → 非 `enter` 原样返回 → 全 try/catch）；注入位置在"最后一条 claimed 消息之后"，与压缩插件相邻不互相覆盖；消息 `source.kind="dsh-kifuin"`；**每会话一次**；`enabled && !shadow` 才可能改 decision；任何异常 ⇒ warn + 原 decision；**不写 session 事件**。
- **M5 机械评测 `scripts/eval.mjs`**：留一局（LOO）算 `repeatFailureRate`；memory 只用 `startedAt` 严格更早的局；三个口径（edge/event/both）+ `--json`；零模型调用、零写入、确定性（同输入两次逐字节相同）。

### 真实数字（2026-11-02 04:18，store=tmp/memory-context，24 局 root）
- **both 口径**：12 repeat / 86 novel ⇒ **rate 12.2%**；coverage 79.2%（19/24 局有失败签名）
- edge 口径 16.3%（覆盖 29.2%）；event 口径 12.8%
- 坑榜 Top3：`file has not been read…`(3 局)、`no web_search_tool_result blocks`(3)、`file changed since it was read`(2)
- 298 条测试全绿

> **口径纪律**：12.2% 是"机械代理指标"，不是"模型因此少走弯路"的收益；对外不得写成收益。样本 98 条签名，95% CI 约 [6%, 19%]，不可外推。

## 0.5.0（2026-11-02）

M4 闸门与裁决：十道闸全开，作用域越界清零，精度过门槛（影子模式）。

### 新增/修复
- **R10 adjudicate**：多成员机械裁决（support/oppose/insufficient）；agreement=多数÷有效票；<阈值 ⇒ disputed；共享 `contextId` 的票不计（闸 2b）；结果可回放（id 由票集哈希，篡改即露）。
- **R13 十道闸全开**：0/1/2/2b/3/4/5/6/6b/7 + 边界审计；判据单源（R12 与 R13 共用 scope 函数）；`PENDING_GATES=[]`。
- **R11 作用域修复**：候选入 hits 前过 scope 闸（`w:` 只认完全相同，`u:` 跨域可见，缺 scope 默认拒绝）；真实 20 卡越界行 **52 → 0**，闸 1 **2/20 → 20/20**。
- **R12 接线**：`runInject` 把 store+scope 传给闸门；跨域/未知作用域分开计数并写进省略行（零展开也有解释）。
- **S9 起跳池收紧**：泛工具主题不做起跳种子。

### 真实数字（2026-11-02 04:09）
- 精度（35 样本）：hopPrecision **50.38% → 87.38%**；noiseRate **1.94%**；零注入 34.29%；token p50 224 / p90 295 / max 323；闸 35/35。
- 存量 125 claim：闸 2 / 闸 5 违规 **0**（状态与 quote 自洽）。
- 268 条测试全绿。

## 0.4.0（2026-11-02）

M3 顺藤摸瓜（影子模式）：能找、能组卡、能过闸，但**不注入任何模型上下文**。

### 新增房间
- **R11 walk**：从信号（根消息/活动/用户显式）→ 主题 → 棋谱 → 一跳；深度夹在 2；每跳带 `why`；失败教训优先；≤5 条 / ≤500 tokens；无命中零 token；真实语料 157–375 ms/次，只读（跑完 1,280 文件 sha256 全等）。
- **R12 inject**：`indexLine` 恒定一行（35 tokens）+ 命中才展开 `<memory-ledger>`；每条带 `occurredAt` 与 provenance；超预算阶梯降级但**不丢来源与日期**；**shadow 模式只写 JSONL**（`injected:false`），硬拒绝 `$DSH_HOME` 内影子路径。
- **R13 gates（起步）**：闸 0（时间戳）、闸 6（预算/省略）、闸 6b（相关性：每条 hit 有 why、深度 ≤2）、边界审计（指令式扫描）；其余闸在 `PENDING_GATES` 显式登记（M4 启用）。

### 增强
- R14 CLI 新增 `inject --shadow --signal ... [--shadow-dir]`。
- `package.json` exports 补 `./walk ./inject ./gates`。

### 真实数字（2026-11-02 03:30）
- 20 条真实信号影子跑：**闸门 20/20 通过**；零注入 1/20（`127.0.0.1` 主题无 hit）
- token：中位 **253** / p90 275 / max 292（预算 500，从未触顶）；首轮行固定 35
- 渲染 42 claim + 51 指针；shadow 20 行全部 `injected:false`
- 预算阶梯：500→4 条/190 tok；120→2 条/113 tok（日期与 provenance 一字不丢）；60→0 条/35 tok + omitted 计数
- 216 条测试全绿

## 0.3.0（2026-11-02）

M2 建网成线完成：把 92 局会话与 19 张棋谱落成一个**可拷贝的记忆库**（只写不读，零注入）。

### 新增房间
- **R15 persist**：sidecar 存储（`<DSH_HOME>/memory-context/`）；原子写 + fsync + rename；manifest（version/user/counts/**sha256 checksums**/pathPolicy）；append-only journal；`verify`/`rebuild`；权威（episodes/joseki/claims/adjudications）与派生（topics/links/threads/index.md）分离；**篡改权威 → rebuild 拒绝盖章**；绝对路径拒绝入馆；原件缺失标 `sourceStatus:"missing"` 不失效。
- **R15 archive**：`scripts/archive.mjs` 入档管线（只读上游）；`--dry-run` / `--store` / `--root` / `--session` / `--json`；幂等（同输入复跑 0 新增、全库逐字节相同）。
- **R06 thread**：线索（藤的视图，多对多）；84 卷、20 次一局多卷。
- **R08 joseki**：定式候选（每招溯源、≥2 局独立支撑、带 shares-joseki 边）；真实语料 **0 条候选**（成功边全是 write 型，无跨局同签名序列；不放宽 Q5 门槛）。
- **R09 claim**：128 条（fact 9 / antipattern 29 / preference 90；candidate 5 / observed 123）；失败→antipattern、约束→preference、file/version→fact（带 validity）。

### 增强
- R14 CLI 新增 `verify` / `rebuild` 子命令（`--store` 指定记忆库）；`package.json` exports 补 `./persist ./thread ./joseki ./claim`。

### 真实数字（2026-11-02 03:12）
- 92 日志（75,922 事件）/ 19 棋谱（1,701 节点 / 1,941 边）/ 24 局独立成谱 + 68 子代理归并
- 784 主题 / 212 相关边 / 84 线索 / 3,155 mention / 128 claim / 0 定式候选
- 预估写入 1,300 条；`verify` 1,281 文件 / 1.86 MiB / 0 错误；复跑逐字节相同

## 0.2.0（2026-11-02）

M1 只读考古完成：从 90 份真实会话日志与 15 张棋谱建出第一张关系网，**零注入、零写入**。

### 新增房间
- **R01 logread**：按 RFC 8878 逐帧扫边界 + 逐帧解压；坏尾返回前缀（`truncated`），坏行计数，帧级损坏与未知版本 fail-closed。实测 90/90 日志解析成功（38,388 帧 / 70,966 事件 / 194.9 MB 明文，中位 1.66 s）。
- **R00 episode**：会话 → 棋谱（双时钟、闭包、子代理父链）；24 局独立成谱，66 局子代理归并到父局。
- **R02 graphread**：`graph.json` + `graph.json.delta.jsonl` 逐帧回放；坏尾截断、版本拒绝。实测 15 张全部读出（1,230 节点 / 1,397 边 / 198 delta 帧）。
- **R03 extract**：失败/成功/未结算/约束/工具机械抽取，每条带 seq + quote（≤200 字），只认 `source.kind==="user"`（不抽模型摘要）。
- **R04 topic**：repo/file/domain/error/tool/term/goal 主题抽取；CJK 2-gram + 停用词 + IDF；753 主题（df≥2：162）。
- **R05 link**：多粒度相关边（棋谱↔主题、棋谱↔棋谱、节点↔节点），每条带 `why` 与权重；194 条边（shared-topic 61 / same-error 67 / same-file 66）。
- **R07 index**：`index.md` 树（派生、可重算）。
- **R14 cli**：`stats` / `dump` / `walk`，全程只读（实测写入 0 字节）。

### 修复
- `scripts/release.mjs` 在 Windows/sh 下的进程替换兼容问题：改用临时文件传 release notes。
- `engines` 改为 `>=23.8`（`node:zlib` 的 zstd API 不保证 22 全系都有）。

### 测试
- 98 条测试全绿（R00–R05、R07、R14）；真实语料断言 + 合成坏尾/坏行夹具。

## 0.1.0（2026-11-02）

首个版本：方案冻结 + 仓库骨架。

- 方案 v0.9 冻结：目标（第一验收面=不重复踩坑）、结构（棋谱+主题+相关边→线索→棋书馆+定式库）、边界（唯一入口=棋谱）、时间（双时钟）、裁决（多成员独立解析，人只纠错）、可搬迁内核。
- 仓库骨架：`src/rooms/`（按最小交付房间切）、`scripts/check.mjs`、`scripts/release.mjs`、`test/`。
- 维护台账：`MAINTENANCE.md`。
- 不发 npm；版本发布 = annotated tag + GitHub Release。
