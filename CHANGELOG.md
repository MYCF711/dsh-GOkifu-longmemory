# CHANGELOG

> 每次功能实现都发版本并写在这里。**不发 npm**（私有自用），只发 GitHub Release + tag。

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
