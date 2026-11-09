# 交接文件（HANDOFF）· 2026-11-09 11:30

> 写给**下一个接手的会话**。读这份 + 下列指针文件即可无缝接手。
> **当前版本 v0.8.101 · 仓库 `MYCF711/dsh-GOkifu-longmemory` · 宿主 pid 8040（2026-11-08 17:52Z 启动，**本次会话全程未重启**）。**

---

## 一、这个项目是什么（一句话）

DSH 的长期记忆插件（棋院 / Kifu-in）：每局会话结束后把「**踩过的坑 + 当时怎么修好的**」记下来，下次遇到类似任务递给模型——**只给事实，不给指令**，模型自己避开。不做压缩/工具/系统提示词/用户画像。

## 二、当前真实状态

- **宿主没重启**（pid 8040，2026-11-08T17:52:55Z 启动）。本次会话改的代码都在仓库里，**要重启才进进程**。
- 本会话改了 **30 个版本（0.8.88 → 0.8.117）**，全部走 分支→PR→required rules→squash→release（**未发 npm**）。
- **全量测试 1282 条 / 1276 pass / 0 fail / 6 skip**；`check.mjs` / `tag-audit` / `ledger-check --full` / `patrol` 全 PASS（2026-11-09 20:07 复核）。
- **`post-restart-verify` = 6/7**（FAIL=1 · NO-SAMPLE=0）。那条 FAIL 是**真红**：`29ec9d7`（T49）晚于宿主首心跳 ⇒ 新代码确实没加载。

### 四项复测：**4/4 已 PASS**（不再待样本）

| 项 | 状态 | 依据 |
|---|---|---|
| T12 abstain 误杀 | ✅ PASS | `no-relevant-claim=2`，不再全塌 cross-scope |
| T10 signalPreview 完整 | ✅ PASS | 近 30 条里 >160 字符 83.3%（门槛 30%） |
| T25 oncePerSession | ✅ PASS | scope 代理口径 24.2% < T24 基线 36.2%；真库回放 5.51%–8.82% 会被拦 |
| T28/T31 恢复事实上卡 | ✅ PASS | 取样换成「带恢复事实的 claim 正文」后出真尾注（T28b） |

**一键复测**：`node scripts/post-restart-verify.mjs`（七项 + 证据）。**样本不足就 NO-SAMPLE，不许硬算过。**

## 三、本次会话交付了什么（13 刀，都能复跑）

| 切片 | 一句话 | 证据 |
|---|---|---|
| **T49** | 同一张卡每轮重投：`oncePerSession` 是**内存态**，宿主动不动重新 `apply` 就归零 ⇒ 改成**无状态去重**（卡正文已在 `payload.messages` 就不投） | `evidence/T49-already-in-context.md` |
| **T49b** | 真库回放：7 天 1632 次注入里 **144 次（8.82%，上界）/ 90 次（5.51%，下界）**会被拦；原始病例 `aa0b0da9` 手工 8 次 = 回放 8 次 | `evidence/T49-replay-live.md` |
| **T49c** | 根因定位：`session/end-seed` ⇒ 下一轮 agent 重建 ⇒ 重新 `apply` ⇒ 去重集合归零（**10/10** 相关系数） | CHANGELOG「更正 · 2026-11-09」 |
| **T50** | `post-restart-verify` ① 判据：从「发版时点」改成「最近一次改**运行时代码**的提交」（docs-only 发版不再假红） | `evidence/T50-post-restart-code-time.md` |
| **T28b** | ⑤ 的**取样**写死 ⇒ 永远 NO-SAMPLE；改成挑「带恢复事实、同作用域」的 claim 当信号 | CHANGELOG 0.8.91 |
| **T52** | 「被 oncePerSession 拦下」在心跳台账里留墓碑行（每会话一条）—— 静默和死机本来是同一个样子 | `evidence/T52-once-per-session-tombstone.md` |
| **T53** | `A1.redundant` 的窗口跟着**当前在跑的那份代码**走（宿主首心跳），并保留跨版本参考值 | `evidence/T53-a1-window.md` |
| **T54** | 工具真库单次 10–20 秒：`stats` 计数走文件名层 + walk cache 惰性 ⇒ `kifu_stats` **20.3s→1.7s** | `evidence/T54-tool-latency.md` |
| **T55** | walk cache 跨 SDK 实例共享（目录签名 + 30s TTL）⇒ `kifu_search` **9.2s→34ms** | `evidence/T55-shared-walk-cache.md` |
| **T56 / T59** | 并发跑全量会卡死：有界超时（240s）+ 拿不到计数就**串行重跑一次** | `evidence/T56-bounded-release-tests.md`、`evidence/T59-serial-retry.md` |
| **T57** | 新写的 skip 原因（`already-in-context` / `once-per-session`）**只写不读** ⇒ 接到巡检台 | `evidence/T57-skip-reason-consumer.md` |
| **T58** | 自证污染核查把「卡引用 claim」判成红线（60 条全是反向）⇒ 方向改全量算，退出码 1→0 | `evidence/T58-self-contamination-direction.md` |
| **T61** | 三处**无界增长**清零（插件 walk cache 按世代累积 / 会话键 Map / 探针缓存）+ 空闲自灭 ⇒ 空闲堆 38.8MB→**6.9MB**（基线 6.4） | `evidence/T61-memory-idle-release.md` |
| **T62** | `store.list()` 走单文件 bundle ⇒ links **3393ms→35ms**、查询 6284ms→161ms | `evidence/T62-walk-bundle.md` |
| **T63** | `warm-bundles` 把冷路径搬后台 ⇒ 归档后首次查询 **214ms** | `evidence/T63-warm-bundles.md` |
| **T64** | 探针缓存每 60 秒堆一代 ⇒ 只保留当前时间桶 | `evidence/T64` · CHANGELOG 0.8.105 |
| **T65** | 一次建卡重复解析同一份 bundle ⇒ 5 秒 memo，建卡 **180→109ms** | CHANGELOG 0.8.106 |
| **T66–T70** | `quote-not-substring` 分桶 → 修截断加 `…`(400 条) → 分来源（图 89.3%/信号 1.4%）→ 修 `edgeSeq` 取错头 → 校空白口径 | `evidence/T67-clip-quote.md`、`T70-p2-whitespace.md` |
| **T69 / T72** | **根因**：`edgeSeq` 取 `evidence.start` 而引文在 `evidence.end`；**端到端证明** 命中率 **0%→88–100%** | `evidence/T69-edge-seq.md`、`T72-edge-seq-proven.md` |
| **T74 / T365** | 454 条「本局没有」定因为**上游 `errorSnippet` 是摘要**（源头文字不存在）⇒ 判定三态，单列 `unverifiable-source` | `evidence/T365-unverifiable-source.md` |

## 四、下次开工第一件事

1. **重启宿主**（只有人能点；本机铁律 1/6）。
2. 重启后跑：
   ```bash
   node scripts/post-restart-verify.mjs     # 期待 7/7（FAIL=0）
   node scripts/patrol.mjs --full           # A3 那行应出现 dedupe=… / 限流静默=…（T57 的消费者）
   ```
3. 若 `A1.redundant` 的**判据窗口**（不含参考窗口）样本够了仍 >1%，说明 T49 没生效，先查 `dedupe` 计数是否为 0（T57 就是为这个加的）。

## 四之补 · 性能与内存（2026-11-09 主人指令这一段）

主人要求「最好的产品/效果/性能 + 不要再出现无意义的内存占用」。**总账在 `evidence/perf-memory-2026-11-09.md`**，摘要：

| 项 | 之前 | 现在 |
|---|---|---|
| `kifu_stats` 一次 | 20 298 ms | **1 698 ms** |
| `search` / 建卡 | 9–11 s | **48 ms / 109 ms** |
| 归档后首次查询 | 6 284 ms | **214 ms**（`warm-bundles` 预热） |
| 空闲堆占用 | 38.8 MB 常驻 | **6.9 MB**（基线 6.4） |
| 无界增长 | 3 处（walk cache 世代 / 探针时间桶 / 会话 Map） | **全部有界** |

`store.list()` 现在走单文件 bundle（`.cache/<kind>.bundle.json`，纯派生、`rm -rf` 安全）；
归档管线写完后调一次 `node scripts/warm-bundles.mjs`，用户侧就永远看不到冷路径。

## 五、已知未解（别当成已修）

1. **全量测试并发跑偶发卡死**（5 次）：日志停住、某个隔离子进程**内核态 CPU 持续增长**、父进程无输出；紧接重跑几乎总过；`--test-concurrency=1` 单次实测 252.9 秒**未复现**。
   **未定位到具体文件**（隔离子进程 argv 不带文件名、日志是完成序）。已缓解（T56 超时 + T59 串行重试），**根因未修**。
2. **`store.list()` 仍每次全量读**（真库 11083 条 link = 5.1s）：进程内第一次工具调用仍 ~9 秒。要改得引入磁盘索引/二进制格式，是独立设计题。
3. **一次查询的峰值堆约 42 MB**（episodes 占 27.6 MB）：数据本身的成本，不是泄漏；再降一个量级要按需索引。
4. **`support.quote` 的账已清**（2026-11-09）：`ok 750 · 位置偏 3111 · 不可核验(源头不存在) 454`。位置偏是 `edgeSeq` 取错头（**T69 已修，只对新归档生效**）；454 条是上游 `graph.json` 的 `errorSnippet` 本身是摘要，**我们这侧改不了**（T74 定因）。历史不回填（只增不改）。
5. **A2b 认顶 46.6%**（holdout n=118）—— 不是 bug，是当前能力上限。

## 六、工程纪律（照做，别重新设计）

- 分支 → PR → required check `rules` → squash 合并 → `node scripts/release.mjs --require-ci`（**不发 npm**）；版本一律 **patch**（`v0.9.0` 被旧线占用）。
- 发版前：`node scripts/ledger-sync.mjs` + `ledger-check --full`；`check.mjs` 必过。
- **切片编号先查 `计划表.md`**：本表已有 49 个重复 T 号（历史遗留），新刀请取 `最大号+1`（当前 T364 → 新刀用 T365 起）。
- 一刀一个 commit，首行 = 切片 id；**禁止 `git add -A`**；PR 分支永不强推。
- **样本不足就 NO-SAMPLE，不许硬算过**；指标必须**先有消费者**再谈加减。
- **禁止重启 / 关闭 DSH、禁止 `taskkill`、禁止关 magpie**（本机铁律）。

## 七、指针

| 想知道 | 看 |
|---|---|
| 版本 / 测试数 / 六轴 / 下一步 | `MAINTENANCE.md` |
| 逐条任务状态 | `计划表.md`（唯一权威） |
| 每次改了什么 | `CHANGELOG.md`（**顶部有「更正 · 2026-11-09」段**，T49 根因补正） |
| 实测证据 | `evidence/`（T49 – T365；性能与内存总账见 `evidence/perf-memory-2026-11-09.md`） |
| 方向与边界 | `方案.md` / `docs/记忆的职责边界.md` / `docs/拷问记录.md` |
