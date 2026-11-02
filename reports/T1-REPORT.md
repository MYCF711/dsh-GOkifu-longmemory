# T1 报告 · R01 `logread` + R00 `episode`

> 任务：团队任务板 `task-1`（多帧 zstd 逐帧解 + 会话→棋谱）。
> 契约：`docs/数据契约.md` §1/§2（M1 冻结，2026-11-02）＋ `AGENTS.md` §4.1/§11 ＋ `方案.md` §4.1/§4.9。
> 全部数字 `[本]`，时点见每节；测法写在 §9，任何人可复算。

---

## 0 · 一页速览

| 项 | 值 |
|---|---|
| 房间 | R01 `logread`（多帧 zstd + 事件包裹层）、R00 `episode`（会话→棋谱） |
| 交付文件 | `src/rooms/logread.mjs`（295 行）、`src/rooms/episode.mjs`（174 行）、`test/logread.test.mjs`（336 行）、`test/episode.test.mjs`（274 行）、本报告 |
| 验收命令 | `DSH_HOME="D:\DeepSeek Harness\home" node --test test/logread.test.mjs test/episode.test.mjs` |
| 验收结果 | **31 / 31 pass，0 fail**（R01 16 条、R00 15 条）；无 `DSH_HOME` 时 27 pass + 4 skip（真实语料断言可跳过，合成夹具照跑） |
| 真实语料 | **90 / 90 份日志解析成功（100%）**、38,053 帧、70,357 事件、193.2 MB 明文 |
| 整库耗时 | **1.38–2.09 s**（5 次连测，中位 1.66 s）；单文件 p50 **9 ms**、p95 **57 ms**、最大 **228 ms** |
| 核心难点 | 已解决：按 RFC 8878 逐帧扫边界 → 逐帧 `zstdDecompressSync`；整文件解压实测只出 1 行（首帧 header） |
| 与任务书的偏离 | 5 处，均为**遵从冻结契约**（§7 逐条）：`readFrames` 返回 `{frames, truncated}`（契约 §1.1）而非裸 `Buffer[]`，另补 `readFrameBuffers()` 给裸数组形状。见 §7 |
| 未做（不属本房间） | `l0/l1`（M2）、`signals` 计数（R03）、落盘（R15）、CLI（R14）、版本号/CHANGELOG（Lead） |

---

## 1 · 两个房间的对外契约（实现即此）

### R01 `logread`（允许依赖：`node:zlib`；禁止：写盘/联网/依赖其它房间）

| 导出 | 形状 | 语义 |
|---|---|---|
| `scanFrames(buf)` | `{frames:[{start,end}], tornStart?}` | 只扫边界，不解压；用于统计/校验/报告中定位坏帧 |
| `readFrames(buf)` | `{frames:Buffer[], truncated, tornStart?, frameCount, decodedCount, byteLength}` | 契约 §1.1 形状；`frames` 数组另挂非枚举 `truncated` 等，故"只取数组"的调用方也能读到 |
| `readFrameBuffers(buf)` | `Buffer[]` | 上面的便捷入口（任务书里写的 `Buffer[]` 形状） |
| `parseEvents(decoded)` | `{header, events, version, truncated, tornStart?, badLines, badLineNumbers, droppedPartialLine, eventsWithoutTime, lineCount}` | 契约 §1.3；接受 `{frames,...}` 或裸 `Buffer[]` |
| `LogReadError` | `Error`，带 `code` | `logread/corrupt`｜`logread/unsupported-version`｜`logread/missing-header`｜`logread/input` |
| 常量 | `ZSTD_MAGIC=0xfd2fb528`、`SUPPORTED_VERSIONS=[4]`、`HEADER_TYPE='session'` | 冻结值 |

**错误语义（三条线，不混）**

| 情况 | 行为 | 理由 |
|---|---|---|
| 坏尾 / 截断帧（EOF 落在末帧内，或末帧解压/校验失败） | 返回已解前缀 + `truncated:true`，**不抛** | 日志可能正被写入；契约 §1.1 |
| 坏行（JSON 断 / 非对象 / 缺 `type` / 缺数值 `seq`） | 跳过 + 计数 `badLines`（附 `badLineNumbers`），**不抛** | 契约 §1.3 |
| 帧级结构损坏（魔数不对 / 保留位 / 保留块类型 / **非末帧**解压失败） | **抛** `logread/corrupt` | 坏行 ≠ 坏帧；帧级损坏是真丢数据，静默降级会把"少了一截"读成"本来就这么少" |
| `header.version ≠ 4` | 抛 `logread: unsupported version <v>` | fail-closed（AGENTS §2.3） |

### R00 `episode`（零依赖、纯函数、不读盘）

`buildEpisode({header, events, graphPath?, logPath?, now?})` → 契约 §2 的 episode 对象。

- `id = ep-<sid8>`（`sid8` = 去掉 `session-` 前缀后的前 8 位，小写）；
- `scopeKey = w:<规范化 cwd>`：反斜杠→`/`、盘符小写、去尾斜杠、**不补根斜杠**（`E:` 与 `E:/` 是两种路径）；
- `startedAt = header.createdAt`；`endedAt` = 最后事件 `time`（无带 `time` 事件时 = `startedAt`）；
- `firstEventAt/lastEventAt` = 事件 `time` 的 min/max；
- `timeSource ∈ {'event','inferred'}`（冻结枚举）：只要有一条事件缺 `time` 或全缺 ⇒ `inferred`；缺的条数另存 `eventsWithoutTime`；
- `recordedAt` = 参数 `now`（入馆时钟）；**M1 只读不入馆 ⇒ 不传就是 `null`**，不拿 `Date.now()` 冒充；
- `closure = {logPath, graphPath, seqFrom, seqTo, nodeIds:[], edgeIds:[]}` + 附加 `eventCount`；
- 附加字段（冻结后允许新增）：`scopeSource`、`eventsWithoutTime`、`parentSessionId`、`origin`、`closure.eventCount`。

---

## 2 · 多帧 zstd：难在哪、怎么解的

### 2.1 反证：整文件解压确实只出首帧

```js
zstdDecompressSync(整个 7.08 MB 文件)  // → 只返回 1 行（header JSON）
```
实测 `[本]` 2026-11-02 02:46：对最大日志整文件解压，得到 `1` 行（就是 header）；逐帧解则得 4,607 帧 / 8,748 条事件。**这就是"读历史只能看见空会话"的根因。**

### 2.2 帧格式要点（RFC 8878 §3，实现依据）

```
magic 28 B5 2F FD                       ← 4 B，LE 读作 0xFD2FB528
Frame_Header_Descriptor                  ← 1 B：FCS_flag(2b) | Single_Segment | Unused | Reserved | Checksum | DictID_flag(2b)
[Window_Descriptor]                      ← Single_Segment=0 时 1 B
[Dictionary_ID]                          ← flag 0/1/2/3 → 0/1/2/4 B
[Frame_Content_Size]                     ← flag 0→(Single_Segment?1:0) B；1→2 B；2→4 B；3→8 B
Block*                                   ← 3 B 头：last(1b) | type(2b) | size(21b)
                                            type 0=Raw(内容 size 字节) / 1=RLE(内容恒 1 B) / 2=Compressed(内容 size 字节) / 3=保留(非法)
[Content_Checksum]                       ← Checksum_flag=1 时 4 B
```

三个容易踩的点，本实现都覆盖了：

1. **FCS 是变长的，且 `flag=0` 时取决于 `Single_Segment`**（1 B 或 0 B）——写死 1 B 会让边界错位；
2. **RLE 块的 `Block_Size` 是"解压后长度"，块内容恒 1 字节**——按 `size` 跳过会读飞；
3. **校验和 4 B 在最后一个块之后**——漏掉就把下一帧的 magic 读成校验和。

### 2.3 算法

```
offset = 0
while offset < len:
  if 剩余 < 4 → tornStart = offset，停
  读 magic；不匹配 → 抛 corrupt
  读 FHD → 算 dict/窗口/FCS 长度 → offset 前移（越界即 tornStart）
  循环块头：读 3 B → 取 last/type/size → offset += (type==1 ? 1 : size)（越界即 tornStart）→ last 则跳出
  Checksum_flag → offset += 4（越界即 tornStart）
  frames.push({start, end: offset})
```

得到区间后**逐帧** `zstdDecompressSync(buf.subarray(start, end))`，再 `Buffer.concat` 成 JSONL 文本按行解析。

### 2.4 与 DSH 的关系

DSH 在 `app.asar` 内有一个等价扫描器（`dsh-session-persistence-jsonl/zstd` 的 `scanZstdFrames`），语义与上面一致（magic 校验、`(descriptor & 0x18)` 保留位、dict/FCS 长度表、block 链、checksum、`tornStart`）。本实现**独立写成**（只保留格式语义与错误线，不复制大段源码），并多做三件事：

- 在返回数组上挂 `truncated` 等非枚举元数据（契约对象与裸数组两种取法等价）；
- 末帧"结构完整但解压失败"也按坏尾处理（撕裂写常以校验和失败收场，DSH 那里会抛）；
- 坏行计数 `badLines` / `badLineNumbers`（契约 §1.3 要求不抛，但必须可审计）。

---

## 3 · 验收

```bash
$ DSH_HOME="D:\DeepSeek Harness\home" node --test test/logread.test.mjs test/episode.test.mjs
ℹ tests 31   ℹ pass 31   ℹ fail 0   ℹ skipped 0   ℹ duration_ms 797
```

| 房间 | 用例数 | 覆盖 |
|---|---|---|
| R01 | 16 | 导出面（墓碑）｜4 帧容器定位（区间无缝铺满）｜单帧容器｜末帧截断不抛｜末帧校验和损坏不抛｜半个 frame header｜尾部半行 JSON｜坏行计数不抛｜坏魔数抛 corrupt｜保留块类型抛｜未知版本抛｜缺 header 抛｜输入校验｜**真实最大日志**（7.08 MB / 4,607 帧 / 8,748 事件）｜**真实第二大日志**｜**真实日志截断到中间帧**（模拟写盘） |
| R00 | 15 | 导出面（墓碑）｜契约 §2 字段形状｜`recordedAt` 默认 null＋别名｜无 `time` ⇒ inferred｜部分缺 `time` ⇒ inferred｜无事件退化｜时钟偏移原值照留｜`seq` 取 min/max｜`scopeKey` 规范化（含 `E:` vs `E:/`、缺 cwd）｜`sid8`｜子代理 `parentSession`/`origin` 带出｜缺路径 ⇒ null｜三条错误语义｜纯函数不改输入+幂等｜**真实最大日志建谱**（时间窗/闭包/作用域与事件逐项对齐） |

退化运行（脱离 DSH 也能测）：

```bash
$ env -u DSH_HOME node --test test/logread.test.mjs test/episode.test.mjs
ℹ tests 31   ℹ pass 27   ℹ fail 0   ℹ skipped 4     # 4 条真实语料断言 skip
```

### 3.1 跨房间集成（R14 `cli` 已在用我的两个房间）

`src/rooms/cli.mjs`（R14，另一成员）已按冻结契约调用：`readFrames` 取 `{frames,truncated}`（也兼容裸数组）、
`parseEvents(frames)`、`buildEpisode({..., now:null})`。实跑最大日志：

```
{"source":"R01 logread","events":8832,"truncated":false,"badLines":0}
{"id":"<ep>","scope":"w:<WORKSPACE>","seqFrom":0,"seqTo":8831,
 "timeSource":"event","recordedAt":null,"endedAt":1793558885899,"last":1793558885899,"state":"archived"}
fallback vs R00 字段差异: 无
```

⇒ 契约形状与下游实现一致，R14 的 `fallbackEpisode` 与 R00 在共享字段上**零差异**（不会因走哪条路而产生两种棋谱）。

---

## 4 · 全量普查（90 份真实日志）

**口径**：树 = 工作树 `D:\DeepSeek Harness\default-workspace\长期记忆系统`（未提交，见 §10）；语料 = `$DSH_HOME/sessions/**/*.jsonl.zstd`；**分母 = 90**（目录里全部日志文件，不筛 depth、不筛大小）；时点 `2026-11-02 02:46:28 (+08:00)`；每份文件独立读一次（不并发）。

### 4.1 总量

| 指标 | 值 |
|---|---|
| 日志文件 | **90** |
| 解析成功 / 失败 | **90 / 0 → 成功率 100.00%** |
| 压缩字节 | 60,579,796 B（57.8 MB） |
| zstd 帧 | **38,053** |
| 事件（JSONL 记录，不含 header） | **70,357** |
| 明文字节 | 202,567,791 B（193.2 MB） |
| 膨胀比 | 3.34× |
| 平均每文件 | 0.64 MB / 423 帧 / 782 事件 |

### 4.2 正确性（机械校验，不是"看起来对"）

| 校验 | 结果 |
|---|---|
| `seq` 严格单调违例 | **0** 份日志 |
| `seq` 缺号 / 重复 | **0** / **0** |
| `time` 缺失事件 | **0** |
| `time` 倒退事件 | **0** |
| `firstEventAt <= lastEventAt` 违例 | **0** |
| 被截断判定的日志 | **0**（本次采样恰好都收在帧边界上；活跃写入时的行为见下注与 §3 构造测试） |
| 尾部半行 JSON 丢弃 | **0** 份 |
| 注 | 「0 截断」只对这次采样成立，不能当不变量：最大那份就是当前会话的日志，重复采样会偶发 `truncated:true`。⇒ R14 必须把 `truncated` 计数显示出来，否则「读少了」是静默的 |
| `scopeKey` 解析成 `unknown` | **0** 份 |
| `ep-<sid8>` 唯一性 | **90 / 90 唯一** |
| 日志版本 | **v4 × 90**（无 v1–v3 旧格式） |
| `timeSource` | `event` × 90（无推断回退） |

### 4.3 语料分布（对 M1 规划有用）

| 维度 | 分布 |
|---|---|
| `delegationDepth` | `dd=1` **66** ｜ `dd=0` **24** |
| `origin` | `subagent` **66** ｜ 缺省 **24** |
| 子代理父链 | 66 份的 `parentSession` **全部指向存在的父局**（悬空 0、depth 反向 0） |
| `agentPreset` | `standard` 79 ｜ 缺失 10 ｜ `gokifu` 1 |
| 作用域 | `w:<WORKSPACE>` 81 ｜ `w:d:/DeepSeek Harness/default-workspace/长期记忆系统` 7 ｜ `w:d:/DeepSeek Harness/default-workspace` 1 ｜ `w:d:/tmp/hstest` 1 |
| 时间跨度 | `dd=0`：2026-11-01 06:15 → 17:00 UTC；`dd=1`：2026-11-01 07:48 → 18:40 UTC |

⇒ **M1 可独立成谱的会话只有 24 局**（其余 66 局是子代理，按 AGENTS §4.1 归并到父局）。这是 M1 验收面的真实分母，别拿 90 当"棋谱数"。

### 4.4 性能（同一次运行）

| 阶段 | 合计 | 说明 |
|---|---|---|
| 帧边界扫描 | 11 ms | 纯字节走查，38,053 帧 |
| 逐帧解压 | 960 ms | **瓶颈**（`zstdDecompressSync` 每帧一次，帧头开销为主） |
| JSONL 解析 | 563 ms | 70,357 次 `JSON.parse` |
| 合计 | **1,655 ms** | ≈ 34.9 MB/s（按压缩字节） |

| 分位 | 值 |
|---|---|
| p50 | 9 ms |
| p95 | 57 ms |
| max（最大日志 7,075,906 B / 4,607 帧 / 8,748 事件 / 12.5 小时跨度） | 228 ms |
| 峰值 RSS（整库跑完） | 195.5 MB |

**5 次连测**（同一语料、连续）：`1377 / 1445 / 1655 / 1681 / 2090 ms`，中位 1655 ms。差异来自机器负载与**最大那份日志本身还在增长**（它是当前活动会话，每轮多 2–10 帧）。

---

## 5 · 确定性

同一份字节（最大日志）读两遍，事件/header/episode 的 `sha256` 完全一致：

```
run1 {"events":"e721db80f3dbe4db","header":"c6a58520ab4f6257","episode":"537712a5a7e2f66c","frames":4609,"events_n":8751}
run2 {"events":"e721db80f3dbe4db","header":"c6a58520ab4f6257","episode":"537712a5a7e2f66c","frames":4609,"events_n":8751}
identical: true
```

（此处 4,609 帧 / 8,751 事件比 §4 的 4,607 / 8,748 多两帧——同一份日志仍在增长，不是不一致。两次运行**读的是同一份字节快照**，所以 sha 相同。）

`buildEpisode` 亦不改写输入对象（单测断言 `header`/`events` 深比较不变）。

---

## 6 · 与 AGENTS §7 快照的差异（旧数字已不再准确，建议 Lead 更新）

| 项 | AGENTS §7 快照（2026-11-02 更早） | 本报告实测（02:46） |
|---|---|---|
| 日志数 | 86 | **90**（新增的是本轮团队会话/子代理会话） |
| 最大日志 | 6,821,808 B / 4,459 帧 | **7,075,906 B / 4,607 帧**（同一份文件，仍在增长） |
| 事件总数 | 未记 | **70,357** |

> 建议：这类数字写"截至某时点的量级"，别写精确值；活动日志会持续增长。

---

## 7 · 偏离任务书的地方（都为了遵从冻结契约，逐条报备）

| # | 任务书写法 | 实现 | 依据 |
|---|---|---|---|
| 1 | `readFrames(buf) -> Buffer[]` | `readFrames(buf) -> {frames, truncated}`，另导出 `readFrameBuffers(buf) -> Buffer[]` | `docs/数据契约.md` §1.1 **冻结**为对象形状；两者都提供，下游零摩擦 |
| 2 | `parseEvents` 对坏行"不抛"未细化 | 坏行计数进 `badLines`，**帧级**损坏仍抛 | 契约 §1.3 只管"坏行"；帧级损坏必须 fail-closed（AGENTS §2.3） |
| 3 | `buildEpisode(..., recordedAt)` | 契约参数名是 `now`，同时接受 `recordedAt` 别名；**默认 `null`**（M1 不入馆） | 契约 §2「入馆时间（M1 只读，不入馆 → 可为 null）」 |
| 4 | `timeSource` 任务书出现第三态 | 冻结枚举只有 `event|inferred`；部分缺 `time` 记 `inferred`，缺的条数进附加字段 `eventsWithoutTime` | 冻结枚举不许扩；新增字段允许 |
| 5 | `endedAt` 未定义边界 | 严格 `= 最后事件 time`（无事件 = `startedAt`），**不做 `Math.max` 修正** | 契约 §2 原文；时钟偏移是事实，交给闸门判，R00 不掩盖 |

**新增（冻结后允许的加字段）**：`scopeSource`、`eventsWithoutTime`、`parentSessionId`、`origin`、`closure.eventCount`、`badLineNumbers`。
`closure.eventCount` 的消费者：本报告统计 + R07 `index.md` 每局计数行（契约 §5 要求 `fail=<n>`、`topics=<n>`，需要"这局有多少事件"）。

---

## 8 · 剩余风险

| # | 风险 | 触发条件 | 现状 / 缓解 |
|---|---|---|---|
| 1 | **正在写入的日志读到半帧** | 采集时该会话仍活跃（本机 90 份里最大那份就是） | 已构造测试：返回前缀 + `truncated:true`，不抛；调用方（R14）应把 `truncated` 记账，别当成"日志就这么短" |
| 2 | **旧格式日志**（v1–v3） | 出现 `session.v1/v2/v3.jsonl.zstd` | 本机 0 例；遇到即抛 `unsupported version`（fail-closed）。若将来要读旧格式，按契约开新版本+迁移，不许静默降级 |
| 3 | **Node 版本门槛被低估** | `package.json` 写 `engines.node >= 22`；但 `node:zlib` 的 zstd API 是 **Node 22 后期才加入**的，不是 22 全系都有 | 本机 v24.20.0 实测 `zlib.zstdDecompressSync` 为 `function`；换机前用一行验：`node -e "console.log(typeof require('node:zlib').zstdDecompressSync)"`（应为 function）。**建议 Lead 把 `engines` 与 README 提到该 API 存在的最低版本**（`package.json` 不在我的写权限内；具体起始版本号请以 Node 官方 changelog 为准，我不在此引用未核实数字） |
| 4 | 帧级损坏无真实样本 | 语料里没有坏帧 | 仅合成夹具覆盖；一旦真出现，会抛 `logread/corrupt` 并带 `byte` 偏移，可定位 |
| 5 | 内存 | 单文件明文 23.9 MB + 拼接字符串，峰值 RSS ≈196 MB | 一次一文件即可；**不要对 90 份并发解析**（`Promise.all` 会把 RSS 推到数 GB） |
| 6 | zstd 字典 | 上游若改用带字典的帧 | 边界扫描已按字典长度表处理（能定位），但解压会失败 → 末帧按截断、非末帧抛。目前上游未用字典 |
| 7 | `time` 语义漂移 | 上游把 `time` 改成字符串/秒 | 不会崩：全部落 `inferred` + `eventsWithoutTime` 计数；但时间窗会退化。建议 R14 把 `eventsWithoutTime>0` 的局计入 `timestampCoverage` 异常 |
| 8 | 90 份语料"太干净" | 真实坏行/坏尾/旧版本 0 例 | 用真实数据证不了容错路径，只能靠合成夹具；**这是当前覆盖缺口，不是"没问题"** |

---

## 9 · 复现

```bash
# 1) 验收（31 用例）
DSH_HOME="D:\DeepSeek Harness\home" node --test test/logread.test.mjs test/episode.test.mjs

# 2) 全量普查（本报告 §4 的数字；可直接粘进 node --input-type=module -e）
node --input-type=module -e '
import { readdirSync, readFileSync } from "node:fs"; import { join } from "node:path";
import { readFrames, parseEvents } from "./src/rooms/logread.mjs";
import { buildEpisode } from "./src/rooms/episode.mjs";
const root = join(process.env.DSH_HOME, "sessions"); const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : e.name.endsWith(".jsonl.zstd") && files.push(p); } };
walk(root);
let frames = 0, events = 0, ok = 0; const t0 = Date.now();
for (const f of files) { const d = readFrames(readFileSync(f)); const p = parseEvents(d); const ep = buildEpisode({ header: p.header, events: p.events, logPath: f, now: null }); frames += d.frameCount; events += p.events.length; if (ep.state === "archived") ok += 1; }
console.log({ logs: files.length, ok, frames, events, ms: Date.now() - t0 });
'
```

工作脚本（不进 git，`tmp/` 已忽略）：`tmp/t1/survey.mjs`（普查）、`tmp/t1/depth.mjs`（depth 分布/父链）、`tmp/t1/determinism.mjs`（确定性）。

---

## 10 · 提交与交接

- **未提交**：按 Lead 的团队约定（共用工作树、禁止各自切分支），交付物以未跟踪文件形式放在工作树，由 Lead 统一按文件范围提交。
- 本房间不碰：`package.json`、`CHANGELOG.md`、`MAINTENANCE.md`、`scripts/`、其它房间。需要版本号/CHANGELOG/`engines` 的改动见 §8 风险 3，请 Lead 处理。
- 交接给下游：
  - **R02 `graphread`** 直接复用 `parseEvents` 的思路（坏尾不抛 + 前缀），与我无耦合；
  - **R03 `extract`** 吃 `parseEvents().events`（已按其 `{events:[...]}` 归一约定兼容）；
  - **R14 `cli`** 请把 `truncated` / `badLines` / `eventsWithoutTime` 三个计数显示出来，否则"读少了"会静默。
- 交接时的工作树状态（如实记录，与本房间无关）：裸 `node --test` 当前跑 **74 条 → 68 pass / 6 fail**；红的都在 **R04 `topic`**（另一成员在写），本房间两个文件独立跑是 **31/31 绿**。发布门禁要注意：裸 `node --test` 会把全仓所有房间（含在写中的）一起算，建议 CI 显式给路径或按房间分组。
