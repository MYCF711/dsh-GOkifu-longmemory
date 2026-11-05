# T270 · A6 `notFound 1` 归因（ep-226dbf4f / seq 3670 / claim c-39b8ac53）

> `[本] 2026-11-05 23:00 +08:00` · **只读**：不写库、不改任何 claim；未跑全量测试、未重启 DSH
> 宿主：pid 19252（`--current` 口径）· 样本 49 张 / 引用 101 条

## 0 · 一句话结论

这 1 条属于 **D 类（已被改写）**，并叠加 **C 类（200 字截断 + `…`）**：
quote 是棋谱 `errorSnippet` 的**归一化副本**——原文是 `ok\r\n[stderr]\ngithub.com/…`，引文被压成 `ok github.com/…`（**`[stderr]` 标记被吞**）。所以**即使剥掉省略号也命不中**（`剥掉省略号后是否 3674 的子串? false`）。
**它不是新产生的**：claim 记录于 **2026-11-03T12:09:33Z**，且 **T230 已经诊断过同一条**（`evidence/T230-a6-missing.md` 里就是 `c-39b8ac53 / ep-226dbf4f / 3670`）。新宿主只是**又渲染了同一条旧 claim** ⇒ **不需要紧急处理**。

## 1 · 定位（A6 原始输出）

```
$ node scripts/audit-card-samples.mjs --current
样本 49 张 · 引用 101 条 · A6 分母 101（= 引用 − unreadable 0）
  ok 85 · offset 15（近 15 / 远 0，占比 14.9%，中位距离 8）· unreadable 0 · notFound 1（真找不到，占比 1.0%）· unresolved 0 · 日期一致 101/101
```

`--json` 展开后唯一一条 `notFound`：

```json
{
  "at": 1793888688803, "scope": "w:d:/DeepSeek Harness/default-workspace/DSH-GO", "tokens": 298,
  "episode": "ep-226dbf4f", "seq": 3670, "date": "2026-11-03",
  "verdict": "notFound", "nearestSeq": null, "distance": null,
  "claimId": "c-39b8ac53",
  "quote": "ok github.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-ui/cmd/app: copying C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\go-build1711324841\\b001\\exe\\a.out.exe: open tmp/app-real.exe: The proces…",
  "dateVerdict": "ok", "eventDate": "2026-11-03"
}
```

- **(episode, seq)**：`ep-226dbf4f` / **3670**
- **claimId**：`c-39b8ac53`
- **引文前 80 字**：`ok github.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-ui/cmd/app: copying <USER_HOME>…`
- 日期对得上（2026-11-03），所以不是"日期错"。

## 2 · P2 复核（`scripts/provenance-p2.mjs`）

```
$ node scripts/provenance-p2.mjs --ep ep-226dbf4f --seq 3670
focus: c-39b8ac53 (ep-226dbf4f, seq 3670) ⇒ quote-not-substring
  引文: "ok github.com/MYCF711/dsh-ui/cmd/app: go build … open tmp/app-real.exe: The proces…"
  原文: "assistant\nreasoning\n还是 busy=false 且没有"已发送"。…"
  第一个不同处 @0: 原文 "a" vs 引文 "o"
```

P2 的口径是"quote 必须是 (ep, seq) 原文的**逐字**子串"——seq 3670 是 `assistant/message`（reasoning），本来就不含这段工具输出 ⇒ **必然 not-substring**。

## 3 · 引文到底在哪（逐 seq 搜索）

```
--- seq 3674 原文（前 200）---
"ok\r\n[stderr]\ngithub.com/MYCF711/dsh-ui/cmd/app: go build github.com/MYCF711/dsh-ui/cmd/app: copying C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\go-build1711324841\\b001\\exe\\a.out.exe: open tmp/app-real.exe: T"

--- 剥掉省略号后是否 3674 的子串? --- false
quote 去省略号: "ok github.com/MYCF711/dsh-ui/cmd/app: go build …"
原文对应片段:   "ok\n[stderr]\ngithub.com/MYCF711/dsh-ui/cmd/app: go build …"

引文头 20 字出现在 seq: [2725, 2730, 2733] | 尾 20 字: [3674]
```

- 引文**完整地**存在于 **seq 3674**（`tool/result`）——不是跨事件拼接（头 20 字虽然也在 2725/2730/2733 出现，但那只是 `ok github.com/…` 这类片段在别处的重复）。
- 差异只在**中间**：原文 `ok\r\n[stderr]\ngithub.com`，引文 `ok github.com` ⇒ **`[stderr]` 被吞、换行被折成空格**。

## 4 · 四类归因

| 类 | 判定 | 证据 |
|---|---|---|
| **A · 真编造** | **不成立** | 引文在 seq 3674 有原文（只是被归一化），不是凭空造 |
| **B · 跨事件** | **不成立** | 整段在**单个事件**（3674）里；头尾不在不同事件 |
| **C · 压平/截断** | **成立（叠加）** | quote 长度 **200**、以 `…` 结尾（`以省略号结尾? true`） |
| **D · 已被改写** | **成立（主因）** | 剥掉 `…` 后仍不是子串（`false`）；原文的 `[stderr]` 在引文里消失 |

**结论：D（主因）+ C（叠加）。**

## 5 · 是不是新产生的

```
claim c-39b8ac53 | 记录时间: 2026-11-03T12:09:33.006Z | 事件时间: 2026-11-03T10:07:03.007Z
```

- claim 在 **2026-11-03** 就入馆了，比这次宿主重启（2026-11-05）早两天。
- **T230 已经诊断过同一条**：`evidence/T230-a6-missing.md` 的结论就是"棋谱 `errorSnippet` 把 `ok\r\n[stderr]\n` 归一成 `ok\n`，本项目忠实复制"。
- 卡样本里这条引用从 **2026-11-04T16:22Z** 起就反复出现（T230 记录：同一张卡 14 次）。

⇒ **不是新问题**，是新宿主**重新渲染了同一条旧 claim**。A6 的 `notFound` 计数在 0/1 之间抖动，取决于这次采样有没有抽到这张卡。

## 6 · 处置建议（未动手）

| # | 建议 | 影响面 | 备注 |
|---|---|---|---|
| **P1** | **不改库**：这是"引文归一化"而非数据损坏，`support.episode/seq/occurredAt` 都对 | — | 与"只增不改"一致 |
| **P2** | `scripts/audit-card-samples.mjs` 的 `normalizeCardText` 增加一条：**把 `[stderr]`/`[stdout]`/`[exit code: N]` 这类标记视为可忽略**（或按标记切段后做前缀匹配） | A6 读数更诚实 | 这是**判据**修正，不是放水：它只处理"原文里确实有的标记被抽取器吞掉" |
| **P3** | 根因在**上游棋谱**：`errorSnippet` 生成时丢了 `[stderr]`。本项目只能"忠实复制"，要根治需上游修 | 影响所有 agent/tool 类 claim | 与 T230 的 F2 同一条 |
| **P4** | 若一定要"逐字可核"，只能给受影响 claim 加 `supersedes` 新记录（重抽取），**不能改写原件** | 需批量重跑 | 不建议现在做 |

## 7 · 影响面（为什么 A6 只报 1 条）

- P2 全库口径：`refs 2686 · ok 452 · not-substring 2234` —— 绝大多数 claim 的 quote 都不是**逐字**子串（因为抽取器普遍做归一化/截断）。
- A6 的口径更宽（±4 事件 + NBSP/CRLF 归一 + `joined` 兜底），所以 101 条里只剩 **1 条** 真找不到。
- 换句话说：**A6 的 1 条 notFound 是"归一化 + 截断"这一类的极端样本**，不是 1 条孤立的数据损坏。

## 8 · 复现

```bash
node scripts/audit-card-samples.mjs --current            # 看汇总（notFound 1）
node scripts/audit-card-samples.mjs --current --json     # 展开到 claimId
node scripts/provenance-p2.mjs --ep ep-226dbf4f --seq 3670   # P2 逐字对照
# 定位引文真实位置（seq 3674）+ 剥省略号后仍不命中：见 §3 的命令
```
