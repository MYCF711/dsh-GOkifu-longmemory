# T268 · 真实消息语料采集 + T267 收益复算

> 改动：`src/plugin.mjs`（采集）、`scripts/t267-replay.mjs`（只读复算）· 未提交

## 1 · 采集（只写盘，不参与判定）

- 配置键 `collectMessages`（默认 `true`；`false` 时完全不写）；
- 落盘 `evidence/T268-messages.jsonl`（本机、不进 git），行 = `{episode, scopeKey, at, messages:[{role,text,truncated?}]}`；
- 单条 `text` 截断到 4000 字符（`truncated: true`）；落盘前走 `redactForCorpus`（与 privacy-scan 同族规则）；
- **写失败静默降级**：`appendMessageCorpus` 返回 `false`，调用处 `warn` 一行，**不抛**。

## 2 · 测试（原样）

```
$ node --test "test/plugin.test.mjs"
ℹ tests 43
ℹ pass 43
ℹ fail 0
```
新增 3 条：① `collectMessages=false` ⇒ 不写文件；② 写失败只返回 false 不抛；③ 行形状 + 4000 截断 + 脱敏。

## 3 · 复算（`node scripts/t267-replay.mjs`，原样输出要点）

```
n = 207（语料行数；插件已在本机开始写入）
A（只用最后一条 user 消息）严格 0/207 · 宽松 0/207 · Wilson [0, 1.82%]
B（+ 最近 N 条消息硬实体） 严格 0/207 · 宽松 0/207 · Wilson [0, 1.82%]
delta 严格 0 · 宽松 0
negativeControl：207 条 A 无重合样本上 B 判 related = 0（0%）
```

## 4 · 结论（如实）

**A 路本身是 0** ⇒ 这份语料**不具备区分力**，因此"B 比 A 多召回多少"**测不出来**（0 与 0 相比没有意义，不是"没有收益"的证据）。
原因（可核）：语料目前只覆盖**本会话**（`scopeKey` = 长期记忆系统自身），这些步骤的消息与库里既有 claim 几乎无重合，卡面多为空/极短 ⇒ 两条路都一样命中 0。

**要让这个数字有意义，需要**：语料覆盖**多个历史会话**（尤其带失败签名的局），且 A 路严格命中 > 0（否则没有提升空间）。当前实现已就绪，采集会随宿主运行持续累积；等语料覆盖到 ≥20 个历史局后重跑同一命令即可。
