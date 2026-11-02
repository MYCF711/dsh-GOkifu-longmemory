# Letta（MemGPT）：记忆块与状态化 agent（2026-11-02 采集）

- 来源：[github.com/letta-ai/letta](https://github.com/letta-ai/letta)（README，2026-11-02）；
  文档导航：[docs.letta.com](https://docs.letta.com/)（memory-blocks 页抓取到的是导航骨架，正文未取到）。
- [外] README 原文要点（就这两句可核实）：
  1. 「Build stateful agents with **memory that can learn and improve over time**」——记忆是 agent 状态的一部分。
  2. 代码已迁至 `letta-ai/letta-code`；本仓 `archive` 分支是退役的 V1 API server。
- [外] 文档导航暴露的概念结构（只当目录，不当机制细节）：
  - **Memory blocks（core memory）**：可读写的记忆块；
  - **Archival memory**：长期存档 + 检索；
  - **Shared memory**：跨 agent 共享；
  - **Context hierarchy**：上下文分层；
  - **Compaction**：消息压缩（与我们的上游压缩插件同生态位）。

## 与我们对照

| Letta 概念 | 我们 | 判断 |
|---|---|---|
| memory blocks（agent 自己改写） | 我们**禁止**模型直接写记忆（只有聚合器落账） | 不采用：会引入模型评分/自证污染 |
| archival memory + 检索 | `claims/episodes + walk`（顺藤摸瓜） | 已有，但我们是**图式**而非向量检索 |
| shared memory（跨 agent） | `u:` 用户层 + 作用域可见性 | 已有雏形；当前取舍是「必须有同域证据才进卡」 |
| context hierarchy | `<memory-ledger>` 一行索引 + 命中展开 | 同构 |
| compaction | 上游 `dsh-GOkifu-compact`（不在本仓） | 明确边界外 |

## 结论

Letta 的可借鉴点已被我们以**更严格的形式**吸收（状态化记忆、分层上下文），
唯一值得单独记的是「shared memory」这一层：我们的 `u:` 层目前为了 A5=0 牺牲了跨域展示，
若将来要恢复，需要先设计「用户层渲染口径 + 独立指标」，而不是简单放开作用域闸。

## 采集受限

本页正文未取到（JS 渲染页面），因此只引用 README 两句原文 + 导航结构，不编造机制细节。
