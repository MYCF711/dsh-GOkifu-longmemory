# CHANGELOG

> 每次功能实现都发版本并写在这里。**不发 npm**（私有自用），只发 GitHub Release + tag。

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
