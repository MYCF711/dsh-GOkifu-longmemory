# T285 · 主题入口诊断（T281 拆出的 B2 · 27 条）

> `[本] 2026-11-06 04:40 +08:00` · **只读**（不写库、不改 claim、不改 `src/**`、零模型调用）
> 脚本：`scripts/topic-entry-diagnose.mjs`（新建）· 测试：`test/topic-entry-diagnose.test.mjs`
> 口径：判据固定在 **T281 的 HEAD 版**（`judgeStrict = 判别词≥2 或 硬实体≥1`），**不跟随 T284 的 bigram 并集**
> （`scripts/a2b-holdout.mjs` 正被 T284 修改，跟着漂会让 B2 集不稳定）

## 0 · 一句话结论

**E1 = 0 · E2 = 0 · E3 = 27（E3a 完全无词面重合 0 · E3b 只有中文 bigram 重合 18 · E3c 判别词就重合 9）。**
但更重要的发现是：**27/27 的该局都"有入口"** —— walk 的主题匹配能连到这一局（`entryReachable = 27`）。
T281 的"该局从未被 walk 命中"是 **top-5 hits 口径**的读数，**不等于没有入口**；
B2 的真正瓶颈与 B1 同族：**入口通着，claim 没进 top-5**（排序 / 判据），不是 R04 抽取漏了。

## 1 · 真库实跑

```
$ node scripts/topic-entry-diagnose.mjs
T285 · 主题入口诊断 · 考卷 n=114 · 基线 {"A":39,"B":56,"C":0,"D":19} · B2 n=27

| 类 | 含义 | 条数 | 占比 |
|---|---|---|---|
| **E1** | 该局没抽到 topic（R04 抽取漏了） | 0 | 0.0% |
| **E2** | 有 topic 但全部 df=1（天生连不出去） | 0 | 0.0% |
| **E3** | 有 df>1 的 topic，但任务原话与它们词面不重合（表达差异） | 27 | 100.0% |

E3 子标签：**E3a 完全无词面重合** 0 · **E3b 只有中文 bigram** 18 · **E3c 判别词就重合** 9
**入口可达性（修正 T281 的 top-5 口径）**：该局能被 walk 的主题匹配连到 **27 条** · 真无入口 0 条
该局 topic 的最大 df 分布：{"df>=5":27}
topicRoot 边（T192）：仓库里**没有这个符号**（grep 0 命中）⇒ 本批 0 条

原型（中文二元组）：**25 / 27 条获得入口** · 触发 topic 396 个 · 假入口 222 个（误判率 56.1%）
```

三问逐条：

| 问题 | 读数 | 说明 |
|---|---|---|
| ① 该局有哪些 topic | **每局 71–128 个** | `topics/` 里 `episodes` 含该局的记录 |
| ② 这些 topic 的 df 是不是 1 | **不是** | 27 条的**最大 df 全部 ≥5**（`{"df>=5":27}`）；df=1 的 topic 只占少数 |
| ③ 任务原话能否撞上这些词 | **能** | 入口可达 **27/27**：`matchTopics(signal)` 命中的 topic 里，至少一个的 `episodes` 含该局 |
| 该局 claim 有没有 `topicRoot` 边 | **仓库里没有这个符号** | `grep -rn "topicRoot" src/ scripts/` = 0 命中（T192 未落地或已改名） |

## 2 · 三条逐字对照（该局 topic ↔ 任务原话）

**① `ep-bc4ab3cb` · E3c（判别词就重合）**
- 任务原话：`https://opc.fiime.cn/zh-cn/download 这个网页我登…`
- 该局 topic（81 个，节选）：`domain:sqlite(df=5)` · `domain:github.com(df=50)` · `domain:opc.fiime.cn(df=4)` · `domain:127.0.0.1(df=71)` · `domain:op(df=1)`
- 词面重合：**判别词 1 · 中文 bigram 5** ⇒ 入口通（`domain:opc.fiime.cn` 直接由实体命中）
- 该局 claim 15 条，walk top-5 里没有一条支撑该局 ⇒ **卡在排序/判据，不在入口**

**② `ep-9becea64` · E3b（只有中文 bigram）**
- 任务原话：`扫一下我的github仓库，做一下脱敏，尤其是最小上传的一些`
- 该局 topic（71 个，节选）：`domain:github.com(df=50)` · `error:Error: cannot edit "<path>": file changed since it was read(df=22)` · `error:exit code 1(df=65)` · `error:ERR_ASSERTION]: Expected values to be strictly equal:(df=7)`
- 词面重合：**判别词 0 · 中文 bigram 6**（`做一` / `脱敏` 这类 2 字词）
- 该局 claim 19 条 ⇒ 入口通，但**判别词口径（≥4 字）收不到中文短词**，卡在判据

**③ `ep-00b50089` · E3b（只有中文 bigram）**
- 任务原话：`然后加个定时任务，每小时唤醒一次，可以调整goal，持续推进项目`
- 该局 topic（96 个，节选）：`dependency:dsh-better-sidebar(df=22)` · `dependency:dsh-gokifu-longmemory(df=9)` · `dependency:@vectorize-io/hindsight-coding-agents(df=17)` · `dependency:dsh-pause-resume(df=18)`
- 词面重合：**判别词 0 · 中文 bigram 5**（`定时` / `后加` / `持续`）
- 该局 claim 55 条 ⇒ 同上

## 3 · 原型：中文二元组能救多少

- 方法：任务原话切 **2 字中文 bigram**，只要出现在某个 topic.key 里即算"能触发该 topic"；若该 topic 的 `episodes` 含本局 ⇒ **获得入口**。
- 结果：**25 / 27 条获得入口**（另 2 条本来就有入口，不靠 bigram 也通）。
- **误判率（假入口）**：触发 396 个 topic 里 **222 个不含该局**（56.1%）—— 纯 bigram 会满图乱连，
  说明**不能只靠 bigram 建边**，必须与现有"硬实体 / 判别词"并用（T284 的并集方向是对的）。

## 4 · 结论与下一步

| 层 | 读数 | 说明 |
|---|---|---|
| R04 主题抽取 | **0 条**（E1） | 每局都抽到了 topic，且 df 充足 |
| 天生连不出去 | **0 条**（E2） | 27 条的最大 df 全部 ≥5 |
| 表达差异 | **27 条**（E3a 0 / E3b 18 / E3c 9） | 其中 18 条**只有中文 bigram**重合、9 条判别词就重合 |
| 入口可达性 | **27 / 27 可达** | ⇒ "该局从未被命中"是 **top-5 hits 口径**的误读 |

**一句话**：这 27 条**不是**"R04 抽取漏了"（E1=0）、**也不是**"天生连不出去"（E2=0），
而是**入口通着、claim 没进 top-5**；其中 18 条的关键在**中文短词（2 字）进不了判别词口径**、
9 条连判别词都重合 —— 两者都指向 **T284 正在做的"判据口径（bigram 并集）"**，而不是"补一条主题边"。

> 建议：**不要再往 walk 加主题入口**；先把 T284 的中文 bigram 并集接进判据（能覆盖 18 条），
> 再单独看"入口通但 claim 排不进 top-5"的 9 条（属 T240 的排序键问题）。
> 误判率 56.1% 是硬警告：bigram 只能作**判据**（判"是否相关"），**不能作边**（会满图乱连）。
