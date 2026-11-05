# T267 · 合法信号扩展：最近 N 条消息的硬实体

> 对象：`src/plugin.mjs`（+ `test/plugin.test.mjs`）· 只读；未提交
> 判据：知识库 58 的 A1 —— `availableAtSeq ≤ injectionSeq`（消息面天然满足）

## 1 · 改了什么

`src/plugin.mjs` 新增：

| 符号 | 作用 |
|---|---|
| `MESSAGE_ENTITY_PATTERNS` | 硬实体正则（文件路径 / 错误码 / 包名 / 命令），与 `scripts/a2b-holdout.mjs` 的 `HARD_ENTITY_PATTERNS` **同一套**（避免"考的/用的"两套口径） |
| `messageEntities(text)` | 从一段文本抽实体（小写、去重、≥3 字符；路径保留 basename） |
| `signalFromMessages(messages, { lastN = 12 })` | 取**最近 N 条**消息（含 `assistant` / `tool` 角色）抽实体；返回 `{ text, entities }` |

接线（`decidePreStep`）：
```js
const text = lastUserText(payload?.messages);            // 旧行为：只取最后一条 user 消息（golden 不变）
const messageSignal = signalFromMessages(payload?.messages, { lastN: config.messageSignalLastN ?? 12 });
const signal = signalFromText(text, { at });
if (messageSignal.entities.length) { /* 追加到 signal.entities（去重，不改 base 词） */ }
```
**只追加实体，不塞整段对话**（避免噪声）。

## 2 · 合规性（为什么不是 T264 那种作弊）

| 项 | 来源 | 时点 | 合法 |
|---|---|---|---|
| T264 作弊路径 | `episodeEntitySignal` ← 该局**棋谱主题** | 整局结束后统计 | ❌ 含未来信息 |
| 本刀 | `payload.messages` 里**已经出现**的字面量 | `pre-step` 这一刻 | ✅ `availableAtSeq ≤ injectionSeq` |

## 3 · 测试（原样）

```
$ node --test "test/plugin.test.mjs"
ℹ tests 40
ℹ pass 40
ℹ fail 0
```
新增 3 条：`T267 ①` 最近消息里的 `ENOENT` / `src/rooms/…` 被抽中（含 assistant 与 tool 角色）·`②` 只有一条 user 消息时 `text` 与 `lastUserText` 逐字节一致（golden），无实体消息不制造噪声 ·`③` `lastN` 生效（`lastN=1` 看不到更早消息里的实体；`lastN=3` 能看到）。

## 4 · 严格命中对照：**这一项我没能测出来，如实说**

**现有考卷无法回答这个问题**：`evidence/a2b-holdout.json` 的 108 条 item 只有
```
itemId, kind, signalSource, episode, scopeKey, signal, expectedClaimIds, rendered, related, strict, pending, unrelated, hitStrict, hitRelated, rows
```
—— 只有**根用户原话**（`signal`），**没有 `messages`**。而本刀的信号来源正是 `payload.messages` 的最近 N 条。
⇒ 在现有语料上跑 A/B，B 的增量恒为 0 **不是因为没收益，而是因为语料里没有这个信号**。把它写成"34.21% → 34.21%"会是一句**误导性**的结论，我不写。

**下一步（一条命令就能闭环）**：
1. 在 `decidePreStep` 里落一份 `evidence/T267-messages.jsonl`（每行 `{episode, messages:[...]}`，含角色与文本，仅本机）；
2. 用 `signalFromMessages` 对每行重算实体，复用 `scripts/a2b-holdout.mjs` 的合法判定（≥2 判别词 || ≥1 硬实体），得 B 口径；
3. 同时跑 `negativeControl`（同批负样本）确认误判率不升。

在拿到那份语料之前，**"合法口径能抬到多少"没有可信数字**。

## 5 · 结论

**注入时刻最能帮上忙的信号 = `payload.messages` 最近 N 条里的硬实体（文件路径/错误码/包名/命令）**——它在注入点之前就已存在于上下文，是唯一"不作弊"的增量来源；但**它到底能把 34.21% 抬到多少，现在测不了**（考卷不含 messages），需要先落一份真实消息语料再复算。
