# N8 被否决：给"错类别 claim"补 episode 行，救不了可读性（2026-11-03）

## 现象（先于实验确认）
对签名 `error: url hostname "raw.githubusercontent.com" resolves to a non-public ip address`：
卡片给的是 **file has not been read** 与 **web_search 无结果** 两条教训——都是同一先例局里的**别的错误**。
虽然 `hit=19/19`（先例局被找到了），但**卡片没讲这对**这条失败。

## 实验一：类别不同就替换成 episode 条目
- 结果：hit 19/19 不变；**claimHits 19→12**、严格 **17→7（36.8%）** —— 大倒退。
- 原因：很多命中 claim 的类别与信号类别只是**命名/归并口径不同**，一律替换会误伤。

## 实验二：仅"判别词重合 <2"时**追加** episode 条目（保留 claim）
- 结果：hit/claimHits/严格/可读全部与基线一致（19/19/17/19/17/19）。
- 原因（关键）：`entryFromEpisode(hit)` 取的是 **hit.text**，而 claim 命中时它就是 claim 文本 ——
  追加出来的行**和 claim 一模一样**，只是多烧 token（实测卡片多出两条重复行）。

## 根因（比"补行"更深）
walk 的命中是**按类别**召回的；它拿不到"该先例局里那条具体的失败原文"。
要真正修好，必须让信号匹配按**签名**去找该局的失败边（而不是按类别去拿 claim）。
那是检索层的设计改动（N9），不是注入层补一行能解决的。

## 处置
- 两版代码**都已回滚**（`src/rooms/inject.mjs` 回 HEAD，29 条 inject 单测全绿）；
- 保留新增的**可读性口径** `recallReadable`（卡片正文是否含签名 ≥2 判别词）= 17/19，作为未来 N9 的对照基线；
- 负结果入账：以后不再尝试"在注入层补行"这条路。
